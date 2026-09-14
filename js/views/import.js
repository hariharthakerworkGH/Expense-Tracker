import { getAll, put, remove, newId } from '../db.js';
import { extractPdfText, PdfPasswordError, PdfNoTextError } from '../pdf-text.js';
import { detectParser } from '../parsers/registry.js';
import { matchCategoryForDescription, learnFromAssignment } from '../merchant-rules.js';
import { detectTransfers } from '../transfers.js';
import { matchAgainstManualEntries } from '../reconciliation.js';
import { formatCurrency, formatDateNice } from '../format.js';

let state = null; // { rows, meta, parser, categories, existingAccount, unmatchedManual }

export async function render(container) {
  state = null;
  const categories = await getAll('categories');

  container.innerHTML = `
    <p class="import-intro">Pick a bank or credit card statement PDF. It's parsed entirely on this device and never leaves it.</p>
    <div class="field">
      <span>Statement PDF</span>
      <input type="file" id="import-file" accept=".pdf,application/pdf">
    </div>
    <div class="field">
      <span>Password (if the PDF is protected)</span>
      <input type="password" id="import-password" placeholder="Only used to open the file, never saved">
    </div>
    <button type="button" id="import-parse-btn" class="btn-primary">Parse statement</button>
    <p id="import-status" class="status" hidden></p>
    <div id="import-results"></div>
  `;

  container.querySelector('#import-parse-btn').addEventListener('click', () => parseFile(container, categories));

  const resultsEl = container.querySelector('#import-results');
  resultsEl.addEventListener('input', (e) => handleFieldChange(e, resultsEl));
  resultsEl.addEventListener('change', (e) => handleFieldChange(e, resultsEl));
  resultsEl.addEventListener('click', (e) => handleClick(e, resultsEl));
}

async function parseFile(container, categories) {
  const fileInput = container.querySelector('#import-file');
  const passwordInput = container.querySelector('#import-password');
  const status = container.querySelector('#import-status');
  const resultsEl = container.querySelector('#import-results');

  const file = fileInput.files[0];
  if (!file) {
    showStatus(status, 'Choose a PDF first.', true);
    return;
  }

  showStatus(status, 'Reading and parsing…', false);
  resultsEl.innerHTML = '';

  try {
    const password = passwordInput.value || undefined;
    const text = await extractPdfText(file, password);
    // Done with the file bytes and password - drop both references now.
    fileInput.value = '';
    passwordInput.value = '';

    const parser = detectParser(text);
    if (!parser) {
      showStatus(status, "Couldn't recognize this statement's format. Only HDFC Bank (savings + credit card) and ICICI Amazon Pay credit card statements are supported so far.", true);
      return;
    }

    const { rows, meta } = parser.parse(text);
    if (rows.length === 0) {
      showStatus(status, 'Recognized the statement but found no transaction rows in it.', true);
      return;
    }

    for (const row of rows) {
      row.categoryId = await matchCategoryForDescription(row.description);
    }

    const accounts = await getAll('accounts');
    const existingAccount = accounts.find((a) => a.type === parser.accountType && a.issuer === parser.issuerLabel && a.last4 === meta.accountLast4);

    let unmatchedManual = [];
    let duplicateCount = 0;
    let priorImport = null;
    if (existingAccount) {
      const allTxns = await getAll('transactions');
      const dates = rows.map((r) => r.date).sort();
      const rangeStart = meta.periodStart || dates[0];
      const rangeEnd = meta.periodEnd || dates[dates.length - 1];
      // Entries you logged yourself - by hand or from a shared bank alert -
      // are what the statement should confirm rather than duplicate. The window
      // reaches a few days past each end of the period, because a spend alerted
      // on the 24th can post on the 26th, just inside the next statement.
      const loggedInRange = allTxns.filter(
        (t) =>
          t.accountId === existingAccount.id &&
          (t.source === 'manual' || t.source === 'alert') &&
          t.date >= shiftDays(rangeStart, -3) &&
          t.date <= shiftDays(rangeEnd, 3)
      );
      const result = matchAgainstManualEntries(rows, loggedInRange);
      // Only warn about entries that genuinely fall inside this statement's
      // period; one from just outside it simply belongs to a different statement.
      unmatchedManual = result.unmatchedManual.filter((t) => t.date >= rangeStart && t.date <= rangeEnd);

      // Re-importing the same statement would silently double every row, so
      // flag rows already present from a previous import and let them be
      // skipped. Matched against statement-sourced rows only - manual entries
      // are handled by the reconciliation pass above.
      const alreadyImported = allTxns.filter((t) => t.accountId === existingAccount.id && t.source === 'statement');
      const seen = new Set(alreadyImported.map((t) => `${t.date}|${t.amount}|${t.direction}|${t.rawDescription}`));
      for (const row of rows) {
        if (seen.has(`${row.date}|${row.amount}|${row.direction}|${row.description}`)) {
          row._duplicate = true;
          duplicateCount++;
        }
      }

      const batches = await getAll('importBatches');
      priorImport = batches
        .filter((b) => b.accountId === existingAccount.id && b.periodStart <= rangeEnd && b.periodEnd >= rangeStart)
        .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))[0] || null;
    }

    state = { rows, meta, parser, categories, existingAccount, unmatchedManual, duplicateCount, priorImport, skipDuplicates: duplicateCount > 0 };
    showStatus(status, `Parsed ${rows.length} rows.`, false);
    renderResults(resultsEl);
  } catch (err) {
    if (err instanceof PdfPasswordError) {
      showStatus(status, err.kind === 'required' ? 'This PDF needs a password - enter it above and try again.' : 'That password was incorrect - try again.', true);
    } else if (err instanceof PdfNoTextError) {
      showStatus(status, err.message, true);
    } else {
      showStatus(status, `Couldn't parse this file: ${err.message}`, true);
    }
  }
}

function renderResults(resultsEl) {
  const { rows, meta, parser, unmatchedManual } = state;
  const matchedCount = rows.filter((r) => r._matchedManualId).length;

  resultsEl.innerHTML = `
    <div class="totals-card">
      <div class="totals-row"><span>${parser.issuerLabel} - ${parser.accountType}${meta.accountLast4 ? ` ••${meta.accountLast4}` : ''}</span></div>
      ${renderReconciliation(meta)}
      ${matchedCount ? `<div class="totals-row"><span class="in">${matchedCount} row${matchedCount === 1 ? '' : 's'} match entries you already logged ✓</span></div>` : ''}
      <div class="totals-row"><span>Parsed rows</span><span id="import-row-count"></span></div>
    </div>
    ${renderDuplicateWarning(state)}
    ${renderUnmatchedManual(unmatchedManual)}
    <div id="import-row-list" class="import-row-list"></div>
    <button type="button" id="import-commit-btn" class="btn-primary">Commit ${rows.length} rows</button>
    <p id="import-commit-status" class="status" hidden></p>
  `;

  const listEl = resultsEl.querySelector('#import-row-list');
  listEl.innerHTML = rows.map((row, idx) => rowTemplate(row, idx, state.categories)).join('');

  resultsEl.querySelector('#import-commit-btn').addEventListener('click', () => commit(resultsEl));

  const skipBox = resultsEl.querySelector('#skip-duplicates');
  if (skipBox) {
    skipBox.addEventListener('change', () => {
      state.skipDuplicates = skipBox.checked;
      updateTotals(resultsEl);
    });
  }

  updateTotals(resultsEl);
}

function renderDuplicateWarning({ duplicateCount, priorImport }) {
  if (!duplicateCount && !priorImport) return '';
  const priorNote = priorImport
    ? `<div class="muted-note">You already imported ${formatDateNice(priorImport.periodStart)} – ${formatDateNice(priorImport.periodEnd)} for this account on ${formatDateNice(priorImport.importedAt)}.</div>`
    : '';
  if (!duplicateCount) {
    return `<div class="totals-card warn-card"><div class="totals-row"><span>⚠ Overlapping statement</span></div>${priorNote}</div>`;
  }
  return `
    <div class="totals-card warn-card">
      <div class="totals-row"><span>⚠ ${duplicateCount} of these rows look already imported</span></div>
      ${priorNote}
      <label class="checkbox-row">
        <input type="checkbox" id="skip-duplicates" checked>
        <span>Skip the ${duplicateCount} duplicate row${duplicateCount === 1 ? '' : 's'} (recommended)</span>
      </label>
    </div>
  `;
}

function renderUnmatchedManual(unmatchedManual) {
  if (!unmatchedManual || unmatchedManual.length === 0) return '';
  return `
    <div class="totals-card warn-card">
      <div class="totals-row"><span>⚠ ${unmatchedManual.length} entr${unmatchedManual.length === 1 ? 'y' : 'ies'} you logged in this period didn't show up in the statement</span></div>
      <ul class="breakdown-list">
        ${unmatchedManual
          .map(
            (m) => `<li class="breakdown-row"><span>${escapeHtml(m.rawDescription)} (${m.date})</span><span class="${m.direction === 'credit' ? 'in' : 'out'}">${m.direction === 'credit' ? '+' : '-'}${formatCurrency(m.amount)}</span></li>`
          )
          .join('')}
      </ul>
      <p class="muted-note">These stay as-is - double check they're correct, or that the charge didn't get cancelled.</p>
    </div>
  `;
}

function renderReconciliation(meta) {
  if (meta.reconciled === true) {
    return `<div class="totals-row"><span class="in">Reconciles with the statement's own balance ✓</span></div>`;
  }
  if (meta.reconciled === false && meta.statedClosingBalance != null) {
    return `<div class="totals-row"><span class="out">⚠ Computed closing ₹${meta.computedClosingBalance.toFixed(2)} vs statement's ₹${meta.statedClosingBalance.toFixed(2)} - some rows may be off</span></div>`;
  }
  if (meta.reconciled === false && meta.statementPurchasesTotal != null) {
    return `<div class="totals-row"><span class="out">⚠ Parsed debit total ${formatCurrency(meta.parsedDebitTotal)} vs statement's purchase total ${formatCurrency(meta.statementPurchasesTotal)}</span></div>`;
  }
  if (meta.reconciled === true && meta.statementPurchasesTotal != null) {
    return `<div class="totals-row"><span class="in">Matches statement's purchase total ✓</span></div>`;
  }
  return '';
}

function rowTemplate(row, idx, categories) {
  return `
    <div class="import-row ${row._matchedManualId ? 'import-row-matched' : ''} ${row._duplicate ? 'import-row-duplicate' : ''}" data-idx="${idx}">
      ${row._duplicate ? '<div class="import-row-badge badge-warn">Already imported</div>' : ''}
      ${row._matchedManualId ? `<div class="import-row-badge">${row._matchedSource === 'alert' ? 'Matches a bank alert you saved' : 'Already logged'}</div>` : ''}
      <div class="import-row-top">
        <input type="date" class="ir-field ir-date" data-field="date" value="${row.date}">
        <input type="text" class="ir-field ir-desc" data-field="description" value="${escapeAttr(row.description)}">
        <button type="button" class="icon-btn ir-delete" title="Delete row">✕</button>
      </div>
      <div class="import-row-bottom">
        <div class="direction-toggle small">
          <button type="button" class="dir-btn ir-dir ${row.direction === 'debit' ? 'active' : ''}" data-dir="debit">Spent</button>
          <button type="button" class="dir-btn ir-dir ${row.direction === 'credit' ? 'active' : ''}" data-dir="credit">Received</button>
        </div>
        <input type="number" step="0.01" class="ir-field ir-amount" data-field="amount" value="${(row.amount / 100).toFixed(2)}">
        <select class="ir-field ir-category" data-field="categoryId">
          <option value="">Uncategorized</option>
          ${categories.map((c) => `<option value="${c.id}" ${c.id === row.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
    </div>
  `;
}

function handleFieldChange(e, resultsEl) {
  const field = e.target.dataset.field;
  if (!field) return;
  const rowEl = e.target.closest('.import-row');
  const idx = Number(rowEl.dataset.idx);
  const row = state.rows[idx];

  if (field === 'amount') {
    row.amount = Math.round(parseFloat(e.target.value || '0') * 100);
  } else if (field === 'categoryId') {
    row.categoryId = e.target.value || null;
  } else {
    row[field] = e.target.value;
  }
  updateTotals(resultsEl);
}

function handleClick(e, resultsEl) {
  const deleteBtn = e.target.closest('.ir-delete');
  if (deleteBtn) {
    const rowEl = deleteBtn.closest('.import-row');
    const idx = Number(rowEl.dataset.idx);
    state.rows[idx] = null;
    rowEl.remove();
    updateTotals(resultsEl);
    return;
  }

  const dirBtn = e.target.closest('.ir-dir');
  if (dirBtn) {
    const rowEl = dirBtn.closest('.import-row');
    const idx = Number(rowEl.dataset.idx);
    state.rows[idx].direction = dirBtn.dataset.dir;
    rowEl.querySelectorAll('.ir-dir').forEach((b) => b.classList.toggle('active', b === dirBtn));
    updateTotals(resultsEl);
  }
}

function committableRows() {
  return state.rows.filter((r) => r && !(state.skipDuplicates && r._duplicate));
}

function updateTotals(resultsEl) {
  const remaining = committableRows();
  const countEl = resultsEl.querySelector('#import-row-count');
  if (countEl) countEl.textContent = String(remaining.length);
  const commitBtn = resultsEl.querySelector('#import-commit-btn');
  if (commitBtn) commitBtn.textContent = `Commit ${remaining.length} rows`;
}

async function commit(resultsEl) {
  const statusEl = resultsEl.querySelector('#import-commit-status');
  const rows = committableRows();
  if (rows.length === 0) {
    showStatus(statusEl, 'No rows left to commit.', true);
    return;
  }

  const { meta, parser, unmatchedManual } = state;
  let account = state.existingAccount;
  if (!account) {
    account = {
      id: newId(),
      label: `${parser.issuerLabel}${meta.accountLast4 ? ` ••${meta.accountLast4}` : ''}`,
      type: parser.accountType,
      issuer: parser.issuerLabel,
      last4: meta.accountLast4 || null,
      billingCycleDay: null,
    };
  }

  const dates = rows.map((r) => r.date).sort();
  const periodEnd = meta.periodEnd || dates[dates.length - 1];
  const periodStart = meta.periodStart || dates[0];

  if (account.type === 'card' && !account.billingCycleDay) {
    account.billingCycleDay = new Date(periodEnd).getDate();
  }
  if (account.type === 'bank' && meta.statedClosingBalance != null) {
    account.knownBalance = Math.round(meta.statedClosingBalance * 100);
    account.knownBalanceDate = periodEnd;
  }
  if (account.type === 'card' && meta.totalAmountDue != null) {
    // A newer statement supersedes the last one, so the "paid" flag resets -
    // this is a fresh bill, even if the previous one was settled.
    const isNewerStatement = !account.statementPeriodEnd || periodEnd > account.statementPeriodEnd;
    if (isNewerStatement) {
      account.statementDue = meta.totalAmountDue;
      account.statementMinDue = meta.minimumDue ?? null;
      account.statementDueDate = meta.paymentDueDate ?? null;
      account.statementPeriodEnd = periodEnd;
      account.statementDuePaid = false;
    }
  }
  await put('accounts', account);

  const importBatch = {
    id: newId(),
    accountId: account.id,
    periodStart,
    periodEnd,
    importedAt: new Date().toISOString(),
    txCount: rows.length,
  };
  await put('importBatches', importBatch);

  let matchedCount = 0;
  for (const row of rows) {
    if (row._matchedManualId) {
      await remove('transactions', row._matchedManualId);
      matchedCount++;
    }
    // Carry over what you decided on the logged copy this row replaces: a
    // split, or that it was money moved rather than spent.
    const carry = row._carry || {};
    const transaction = {
      id: newId(),
      accountId: account.id,
      date: row.date,
      rawDescription: row.description,
      amount: row.amount,
      direction: row.direction,
      categoryId: row.categoryId || null,
      source: 'statement',
      importBatchId: importBatch.id,
      isTransfer: carry.isTransfer === true,
      notes: carry.notes || null,
      bankRef: row.ref || null,
    };
    if (carry.transferManual) transaction.transferManual = true;
    if (Array.isArray(carry.splits) && carry.splits.length) {
      transaction.splits = carry.splits;
      transaction.categoryId = null;
    }
    await put('transactions', transaction);
    if (row.categoryId) {
      await learnFromAssignment(row.description, row.categoryId);
    }
  }

  const transferCount = await detectTransfers();

  const parts = [`Committed ${rows.length} transactions`];
  if (matchedCount) parts.push(`matched ${matchedCount} you'd already logged`);
  if (transferCount) parts.push(`flagged ${transferCount} as transfers`);
  if (unmatchedManual && unmatchedManual.length) parts.push(`${unmatchedManual.length} of the entries you logged weren't found in the statement - check them above`);
  showStatus(statusEl, `${parts.join('. ')}. Go to Transactions to categorize the rest.`, false);
  resultsEl.querySelector('#import-commit-btn').disabled = true;
  state = null;
}

function shiftDays(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function showStatus(el, message, isError) {
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('out', !!isError);
  el.classList.toggle('in', !isError);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
