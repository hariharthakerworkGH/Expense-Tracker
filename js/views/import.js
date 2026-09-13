import { getAll, put, newId } from '../db.js';
import { extractPdfText, PdfPasswordError, PdfNoTextError } from '../pdf-text.js';
import { detectParser } from '../parsers/registry.js';
import { matchCategoryForDescription, learnFromAssignment } from '../merchant-rules.js';
import { detectTransfers } from '../transfers.js';

let state = null; // { rows, meta, parser, categories }

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
      showStatus(status, "Couldn't recognize this statement's format. Only HDFC Bank savings and HDFC credit card statements are supported so far.", true);
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

    state = { rows, meta, parser, categories };
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
  const { rows, meta, parser } = state;

  resultsEl.innerHTML = `
    <div class="totals-card">
      <div class="totals-row"><span>${parser.issuerLabel} - ${parser.accountType}${meta.accountLast4 ? ` ••${meta.accountLast4}` : ''}</span></div>
      ${renderReconciliation(meta)}
      <div class="totals-row"><span>Parsed rows</span><span id="import-row-count"></span></div>
    </div>
    <div id="import-row-list" class="import-row-list"></div>
    <button type="button" id="import-commit-btn" class="btn-primary">Commit ${rows.length} rows</button>
    <p id="import-commit-status" class="status" hidden></p>
  `;

  const listEl = resultsEl.querySelector('#import-row-list');
  listEl.innerHTML = rows.map((row, idx) => rowTemplate(row, idx, state.categories)).join('');

  resultsEl.querySelector('#import-commit-btn').addEventListener('click', () => commit(resultsEl));

  updateTotals(resultsEl);
}

function renderReconciliation(meta) {
  if (meta.reconciled === true) {
    return `<div class="totals-row"><span class="in">Reconciles with the statement's own balance ✓</span></div>`;
  }
  if (meta.reconciled === false && meta.statedClosingBalance != null) {
    return `<div class="totals-row"><span class="out">⚠ Computed closing ${fmtRupees(meta.computedClosingBalance)} vs statement's ${fmtRupees(meta.statedClosingBalance)} - some rows may be off</span></div>`;
  }
  if (meta.reconciled === false && meta.statementPurchasesTotal != null) {
    return `<div class="totals-row"><span class="out">⚠ Parsed debit total ${fmt(meta.parsedDebitTotal)} vs statement's purchase total ${fmt(meta.statementPurchasesTotal)}</span></div>`;
  }
  if (meta.reconciled === true && meta.statementPurchasesTotal != null) {
    return `<div class="totals-row"><span class="in">Matches statement's purchase total ✓</span></div>`;
  }
  return '';
}

function rowTemplate(row, idx, categories) {
  return `
    <div class="import-row" data-idx="${idx}">
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

function updateTotals(resultsEl) {
  const remaining = state.rows.filter(Boolean);
  const countEl = resultsEl.querySelector('#import-row-count');
  if (countEl) countEl.textContent = String(remaining.length);
  const commitBtn = resultsEl.querySelector('#import-commit-btn');
  if (commitBtn) commitBtn.textContent = `Commit ${remaining.length} rows`;
}

async function commit(resultsEl) {
  const statusEl = resultsEl.querySelector('#import-commit-status');
  const rows = state.rows.filter(Boolean);
  if (rows.length === 0) {
    showStatus(statusEl, 'No rows left to commit.', true);
    return;
  }

  const { meta, parser } = state;
  const accounts = await getAll('accounts');
  let account = accounts.find((a) => a.type === parser.accountType && a.issuer === parser.issuerLabel && a.last4 === meta.accountLast4);
  if (!account) {
    account = {
      id: newId(),
      label: `${parser.issuerLabel}${meta.accountLast4 ? ` ••${meta.accountLast4}` : ''}`,
      type: parser.accountType,
      issuer: parser.issuerLabel,
      last4: meta.accountLast4 || null,
    };
    await put('accounts', account);
  }

  const dates = rows.map((r) => r.date).sort();
  const importBatch = {
    id: newId(),
    accountId: account.id,
    periodStart: meta.periodStart || dates[0],
    periodEnd: meta.periodEnd || dates[dates.length - 1],
    importedAt: new Date().toISOString(),
    txCount: rows.length,
  };
  await put('importBatches', importBatch);

  for (const row of rows) {
    await put('transactions', {
      id: newId(),
      accountId: account.id,
      date: row.date,
      rawDescription: row.description,
      amount: row.amount,
      direction: row.direction,
      categoryId: row.categoryId || null,
      source: 'statement',
      importBatchId: importBatch.id,
      isTransfer: false,
      notes: null,
    });
    if (row.categoryId) {
      await learnFromAssignment(row.description, row.categoryId);
    }
  }

  const transferCount = await detectTransfers();

  showStatus(statusEl, `Committed ${rows.length} transactions${transferCount ? `, flagged ${transferCount} as transfers` : ''}. Go to Review to categorize the rest.`, false);
  resultsEl.querySelector('#import-commit-btn').disabled = true;
  state = null;
}

function fmt(minorUnits) {
  return `₹${(minorUnits / 100).toFixed(2)}`;
}

function fmtRupees(value) {
  return `₹${value.toFixed(2)}`;
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
