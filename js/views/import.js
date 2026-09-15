import { getAll, put, remove, newId } from '../db.js';
import { extractPdfText, PdfPasswordError, PdfNoTextError } from '../pdf-text.js';
import { detectParser } from '../parsers/registry.js';
import { matchCategoryForDescription, learnFromAssignment } from '../merchant-rules.js';
import { detectTransfers } from '../transfers.js';
import { matchAgainstManualEntries } from '../reconciliation.js';
import { formatCurrency, formatDateNice } from '../format.js';
import { currentCycleStart } from '../billing-cycle.js';

// Two kinds of import share this screen:
//   - statements (PDF): a closed, billed period. Authoritative.
//   - current transactions (a pasted HDFC list, an ICICI "current statement"
//     PDF): a snapshot of the cycle that is still open. "Provisional" - each
//     new snapshot replaces the last, and the monthly statement replaces them
//     all. These never touch a card's bill, statement day or bank balance.

let state = null;
let categoriesCache = [];

export async function render(container) {
  state = null;
  categoriesCache = await getAll('categories');

  container.innerHTML = `
    <p class="import-intro">Bring in a statement, or the current transactions on a card. Everything is read on this device and never leaves it.</p>

    <h3>Statement PDF</h3>
    <div class="totals-card">
      <div class="field">
        <span>Bank or credit card statement — or ICICI's current statement</span>
        <input type="file" id="import-file" accept=".pdf,application/pdf">
      </div>
      <div class="field">
        <span>Password (if the PDF is protected)</span>
        <input type="password" id="import-password" placeholder="Only used to open the file, never saved">
      </div>
      <button type="button" id="import-parse-btn" class="btn-primary">Read PDF</button>
    </div>

    <h3>Current card transactions</h3>
    <div class="totals-card">
      <p class="muted-note" style="margin-top:0">HDFC doesn't let you download these. In NetBanking, open the card's unbilled transactions, select the whole list, copy it and paste it here. One card or several — put the card's name and last four digits on a line above each list.</p>
      <label class="field" style="margin-top:12px">
        <span>Pasted transactions</span>
        <textarea id="import-paste" rows="6" spellcheck="false" autocomplete="off" placeholder="Swiggy Credit Card 6671&#10;14 Sept 2026&#10;10% Swiggy Cashback&#10;₹49.00  credit icon"></textarea>
      </label>
      <button type="button" id="import-paste-btn" class="btn-secondary btn-block">Read pasted list</button>
    </div>

    <p id="import-status" class="status" hidden></p>
    <div id="import-results"></div>
  `;

  container.querySelector('#import-parse-btn').addEventListener('click', () => parseFile(container));
  container.querySelector('#import-paste-btn').addEventListener('click', () => parsePasted(container));

  const resultsEl = container.querySelector('#import-results');
  resultsEl.addEventListener('input', (e) => handleFieldChange(e, resultsEl));
  resultsEl.addEventListener('change', (e) => handleFieldChange(e, resultsEl));
  resultsEl.addEventListener('click', (e) => handleClick(e, resultsEl, container));
}

async function parseFile(container) {
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
      showStatus(status, "Couldn't recognise this PDF. Supported: HDFC Bank savings and credit card statements, ICICI Amazon Pay credit card statements, and ICICI's current statement.", true);
      return;
    }
    await startReview({ parser, text, queue: [] }, status, resultsEl);
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

async function parsePasted(container) {
  const status = container.querySelector('#import-status');
  const resultsEl = container.querySelector('#import-results');
  const textarea = container.querySelector('#import-paste');
  const text = textarea.value;
  resultsEl.innerHTML = '';

  if (!text.trim()) {
    showStatus(status, 'Paste the transactions first.', true);
    return;
  }
  const parser = detectParser(text);
  if (!parser || !parser.provisional || typeof parser.splitSections !== 'function') {
    showStatus(status, "That doesn't look like HDFC's current transactions list. Each transaction should have a date line, a description, and an amount line ending in \"credit icon\" or \"debit icon\".", true);
    return;
  }
  const sections = parser.splitSections(text);
  if (sections.length === 0) {
    showStatus(status, 'Found no complete transactions in that text.', true);
    return;
  }
  textarea.value = '';
  await startReview({ parser, text: sections[0].text, last4: sections[0].last4, queue: sections.slice(1) }, status, resultsEl);
}

// Parses one card's worth of text and builds the review.
async function startReview({ parser, text, last4 = null, queue }, status, resultsEl) {
  const { rows, meta } = parser.parse(text);
  if (last4 && !meta.accountLast4) meta.accountLast4 = last4;
  if (rows.length === 0) {
    showStatus(status, 'Recognised the format but found no transaction rows in it.', true);
    return;
  }
  for (const row of rows) {
    row.categoryId = await matchCategoryForDescription(row.description);
  }

  const accounts = await getAll('accounts');
  const provisional = Boolean(parser.provisional);
  const account = provisional ? findCardAccount(accounts, parser, meta.accountLast4) : accounts.find((a) => a.type === parser.accountType && a.issuer === parser.issuerLabel && a.last4 === meta.accountLast4) || null;

  state = {
    parser,
    rows,
    meta,
    provisional,
    account,
    accounts,
    queue,
    skipDuplicates: false,
  };
  await analyse();
  showStatus(status, `Read ${rows.length} rows${meta.accountLast4 ? ` for ••${meta.accountLast4}` : ''}.`, false);
  renderResults(resultsEl);
}

// A card from the list's last four digits: first the same bank, then any card
// with those digits, then a card these digits were linked to before.
function findCardAccount(accounts, parser, last4) {
  if (!last4) return null;
  const cards = accounts.filter((a) => a.type === 'card');
  return (
    cards.find((a) => a.issuer === parser.issuerLabel && a.last4 === last4) ||
    cards.find((a) => a.last4 === last4) ||
    cards.find((a) => Array.isArray(a.linkedLast4s) && a.linkedLast4s.includes(last4)) ||
    null
  );
}

// Works out what this import will match, replace and remove on the chosen
// account. Re-run when the card is picked, since all of it depends on which
// account the rows land on.
async function analyse() {
  const { rows, meta, provisional, account } = state;
  for (const row of rows) {
    if (!row) continue;
    delete row._matchedManualId;
    delete row._matchedSource;
    delete row._carry;
    delete row._keepExisting;
    delete row._duplicate;
  }
  state.unmatchedLogged = [];
  state.superseded = [];
  state.duplicateCount = 0;
  state.priorImport = null;
  if (!account) return;

  const allTxns = await getAll('transactions');
  const dates = rows.filter(Boolean).map((r) => r.date).sort();
  // A current list can hold a refund dated before its cycle (ICICI lists an
  // 11 Aug refund in the cycle from 26 Aug), so its span is the rows' own
  // dates. A statement's span is its printed period.
  const rangeStart = provisional ? dates[0] : meta.periodStart || dates[0];
  const rangeEnd = provisional ? dates[dates.length - 1] : meta.periodEnd || dates[dates.length - 1];

  // Rows from current-transactions lists taken during the cycle this import
  // covers. They're chosen by WHEN THE LIST WAS TAKEN, not by each row's own
  // date: a list can carry a refund dated weeks before its cycle (ICICI's
  // 11 Aug Pepe Jeans refund sits in the cycle from 26 Aug). Picking by row
  // date would leave that row behind when the statement arrives, and the
  // refund would then be counted twice.
  const batches = await getAll('importBatches');
  const cycleStart = currentCycleStart(account, batches);
  const statementStart = meta.periodStart || rangeStart;
  const statementEnd = meta.periodEnd || rangeEnd;
  const listBatchIds = new Set(
    batches
      .filter(
        (b) =>
          b.accountId === account.id &&
          b.provisional &&
          (provisional
            ? !cycleStart || b.periodEnd > cycleStart // earlier lists in this same open cycle
            : b.periodEnd >= statementStart && b.periodEnd <= statementEnd) // lists taken during the statement's cycle
      )
      .map((b) => b.id)
  );
  const listRows = allTxns.filter((t) => t.accountId === account.id && t.source === 'unbilled' && listBatchIds.has(t.importBatchId));

  // Everything already on this card that this import should confirm rather
  // than duplicate: those list rows, plus entries you logged and bank alerts
  // you saved within a few days of the period (a spend alerted on the 24th can
  // post on the 26th).
  const logged = allTxns.filter(
    (t) =>
      t.accountId === account.id &&
      (t.source === 'manual' || t.source === 'alert') &&
      t.date >= shiftDays(rangeStart, -3) &&
      t.date <= shiftDays(rangeEnd, 3)
  );
  const pool = [...listRows, ...logged];
  const { unmatchedManual } = matchAgainstManualEntries(rows.filter(Boolean), pool);
  const byId = new Map(pool.map((t) => [t.id, t]));

  // Re-pasting a list you already imported: a row identical to the one it
  // matched is left exactly as it is, so nothing is rewritten or re-synced.
  // Only for lists - a statement must always take the row over, turning it
  // from "unbilled" into a billed statement row, even when nothing else changed.
  for (const row of rows) {
    if (!provisional || !row || !row._matchedManualId) continue;
    const existing = byId.get(row._matchedManualId);
    if (
      existing &&
      existing.source === 'unbilled' &&
      existing.date === row.date &&
      existing.rawDescription === row.description &&
      (existing.categoryId || null) === (row.categoryId || null)
    ) {
      row._keepExisting = true;
    }
  }

  const inRange = (t) => t.date >= rangeStart && t.date <= rangeEnd;
  // Rows from an earlier list that this import doesn't contain - a dropped
  // pre-authorisation, a reversed charge. The newer source is right, so they go.
  //   - A statement is the final word on its cycle: every unmatched list row
  //     from that cycle goes.
  //   - A newer list only speaks for the dates it shows. If you copied just
  //     the latest screenful, older rows it doesn't show aren't "gone".
  state.superseded = unmatchedManual.filter((t) => t.source === 'unbilled' && (!provisional || inRange(t)));
  // Entries you logged yourself that aren't on the list: kept, but pointed out.
  state.unmatchedLogged = unmatchedManual.filter((t) => t.source !== 'unbilled' && inRange(t));

  if (!provisional) {
    // Re-importing the same statement would silently double every row.
    const alreadyImported = allTxns.filter((t) => t.accountId === account.id && t.source === 'statement');
    const seen = new Set(alreadyImported.map((t) => `${t.date}|${t.amount}|${t.direction}|${t.rawDescription}`));
    for (const row of rows) {
      if (row && seen.has(`${row.date}|${row.amount}|${row.direction}|${row.description}`)) {
        row._duplicate = true;
        state.duplicateCount++;
      }
    }
    state.skipDuplicates = state.duplicateCount > 0;
    state.priorImport =
      batches
        .filter((b) => b.accountId === account.id && !b.provisional && b.periodStart <= rangeEnd && b.periodEnd >= rangeStart)
        .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))[0] || null;
  }
}

function renderResults(resultsEl) {
  const { rows, meta, parser, provisional, account, accounts } = state;
  const live = rows.filter(Boolean);
  const matchedCount = live.filter((r) => r._matchedManualId && !r._keepExisting).length;
  const unchangedCount = live.filter((r) => r._keepExisting).length;
  const cards = accounts.filter((a) => a.type === 'card');

  resultsEl.innerHTML = `
    <div class="totals-card">
      <div class="totals-row"><span><strong>${provisional ? 'Current transactions' : 'Statement'}</strong> · ${escapeHtml(parser.issuerLabel)}${meta.accountLast4 ? ` ••${meta.accountLast4}` : ''}</span></div>
      ${
        provisional
          ? `<label class="field" style="margin:10px 0 4px">
              <span>Card</span>
              <select id="import-card">
                <option value="">Pick the card these belong to</option>
                ${cards.map((a) => `<option value="${a.id}" ${account && account.id === a.id ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('')}
              </select>
            </label>
            ${!account ? '<p class="muted-note">Pick the card before saving — these transactions only mean something against the right card.</p>' : ''}`
          : ''
      }
      ${renderReconciliation(meta)}
      ${provisional ? '<div id="import-live-totals"></div>' : ''}
      ${matchedCount ? `<div class="totals-row"><span class="in">${matchedCount} row${matchedCount === 1 ? '' : 's'} match entries already in the app ✓</span></div>` : ''}
      ${unchangedCount ? `<div class="totals-row"><span class="muted">${unchangedCount} row${unchangedCount === 1 ? '' : 's'} unchanged since your last paste</span></div>` : ''}
      <div class="totals-row"><span>Rows to save</span><span id="import-row-count"></span></div>
    </div>
    ${provisional ? '' : renderDuplicateWarning(state)}
    ${renderSuperseded(state.superseded, provisional)}
    ${renderUnmatchedLogged(state.unmatchedLogged, provisional)}
    <div id="import-row-list" class="import-row-list"></div>
    <button type="button" id="import-commit-btn" class="btn-primary">Save</button>
    <p id="import-commit-status" class="status" hidden></p>
    <div id="import-next"></div>
  `;

  resultsEl.querySelector('#import-row-list').innerHTML = rows.map((row, idx) => (row ? rowTemplate(row, idx, categoriesCache) : '')).join('');
  resultsEl.querySelector('#import-commit-btn').addEventListener('click', () => commit(resultsEl));

  const skipBox = resultsEl.querySelector('#skip-duplicates');
  if (skipBox) {
    skipBox.addEventListener('change', () => {
      state.skipDuplicates = skipBox.checked;
      updateTotals(resultsEl);
    });
  }

  const cardSelect = resultsEl.querySelector('#import-card');
  if (cardSelect) {
    cardSelect.addEventListener('change', async () => {
      state.account = state.accounts.find((a) => a.id === cardSelect.value) || null;
      await analyse();
      renderResults(resultsEl);
    });
  }

  updateTotals(resultsEl);
}

function renderSuperseded(list, provisional) {
  if (!list || !list.length) return '';
  return `
    <div class="totals-card warn-card">
      <div class="totals-row"><span>${list.length} earlier row${list.length === 1 ? '' : 's'} ${provisional ? "aren't on this list any more" : "didn't make it onto the statement"} and will be removed</span></div>
      <ul class="breakdown-list">
        ${list.map((t) => `<li class="breakdown-row"><span>${escapeHtml(t.rawDescription)} (${formatDateNice(t.date)})</span><span class="${t.direction === 'credit' ? 'in' : 'out'}">${t.direction === 'credit' ? '+' : '-'}${formatCurrency(t.amount)}</span></li>`).join('')}
      </ul>
      <p class="muted-note">${provisional ? 'Usually a pre-authorisation that was dropped, or a charge reversed before it posted.' : 'They came from a current-transactions list; the statement is the final word.'}</p>
    </div>
  `;
}

function renderUnmatchedLogged(list, provisional) {
  if (!list || list.length === 0) return '';
  return `
    <div class="totals-card warn-card">
      <div class="totals-row"><span>⚠ ${list.length} entr${list.length === 1 ? 'y' : 'ies'} you logged ${provisional ? "aren't on this list" : "in this period didn't show up in the statement"}</span></div>
      <ul class="breakdown-list">
        ${list.map((m) => `<li class="breakdown-row"><span>${escapeHtml(m.rawDescription)} (${formatDateNice(m.date)})</span><span class="${m.direction === 'credit' ? 'in' : 'out'}">${m.direction === 'credit' ? '+' : '-'}${formatCurrency(m.amount)}</span></li>`).join('')}
      </ul>
      <p class="muted-note">${provisional ? "They stay. A spend from today can take a day or two to appear on the bank's list." : "These stay as-is - double check they're correct, or that the charge didn't get cancelled."}</p>
    </div>
  `;
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

function renderReconciliation(meta) {
  if (meta.printedCharges != null) {
    return meta.reconciled
      ? `<div class="totals-row"><span class="in">Matches ICICI's printed totals ✓</span></div>`
      : `<div class="totals-row"><span class="out">⚠ Read ${formatCurrency(meta.parsedDebitTotal)} charges / ${formatCurrency(meta.parsedCreditTotal)} credits, but ICICI prints ${formatCurrency(meta.printedCharges)} / ${formatCurrency(meta.printedCredits)} - some rows may be off</span></div>`;
  }
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
  const badge = row._keepExisting
    ? '<div class="import-row-badge">Unchanged</div>'
    : row._matchedManualId
      ? `<div class="import-row-badge">${row._matchedSource === 'alert' ? 'Matches a bank alert you saved' : row._matchedSource === 'unbilled' ? 'Updates your earlier list' : 'Already logged'}</div>`
      : '';
  return `
    <div class="import-row ${row._matchedManualId ? 'import-row-matched' : ''} ${row._duplicate ? 'import-row-duplicate' : ''}" data-idx="${idx}">
      ${row._duplicate ? '<div class="import-row-badge badge-warn">Already imported</div>' : ''}
      ${badge}
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
  // After a save, the saved rows stay on screen but no longer belong to
  // anything that can change.
  if (!state || !state.rows) return;
  if (e.target.id === 'import-check-figure') {
    updateTotals(resultsEl);
    return;
  }
  const field = e.target.dataset.field;
  if (!field) return;
  const rowEl = e.target.closest('.import-row');
  if (!rowEl) return;
  const row = state.rows[Number(rowEl.dataset.idx)];
  if (!row) return;

  if (field === 'amount') {
    row.amount = Math.round(parseFloat(e.target.value || '0') * 100);
  } else if (field === 'categoryId') {
    row.categoryId = e.target.value || null;
  } else {
    row[field] = e.target.value;
  }
  // An edited row is no longer identical to the saved one; save it for real.
  delete row._keepExisting;
  updateTotals(resultsEl);
}

function handleClick(e, resultsEl, container) {
  const nextBtn = e.target.closest('#import-next-btn');
  if (nextBtn && state && state.queue && state.queue.length) {
    const [next, ...rest] = state.queue;
    const status = container.querySelector('#import-status');
    startReview({ parser: state.parser, text: next.text, last4: next.last4, queue: rest }, status, resultsEl);
    return;
  }
  if (!state || !state.rows) return;

  const deleteBtn = e.target.closest('.ir-delete');
  if (deleteBtn) {
    const rowEl = deleteBtn.closest('.import-row');
    state.rows[Number(rowEl.dataset.idx)] = null;
    rowEl.remove();
    updateTotals(resultsEl);
    return;
  }

  const dirBtn = e.target.closest('.ir-dir');
  if (dirBtn) {
    const rowEl = dirBtn.closest('.import-row');
    const row = state.rows[Number(rowEl.dataset.idx)];
    row.direction = dirBtn.dataset.dir;
    delete row._keepExisting;
    rowEl.querySelectorAll('.ir-dir').forEach((b) => b.classList.toggle('active', b === dirBtn));
    updateTotals(resultsEl);
  }
}

function committableRows() {
  return state.rows.filter((r) => r && !(state.skipDuplicates && r._duplicate));
}

const isBillPayment = (r) => r.direction === 'credit' && /\b(Bppy|BBPS)\s*Cc\s*Payment|Payment\s+received|BBPS/i.test(r.description);

function updateTotals(resultsEl) {
  if (!state) return;
  const remaining = committableRows();
  const countEl = resultsEl.querySelector('#import-row-count');
  if (countEl) countEl.textContent = String(remaining.length);
  const commitBtn = resultsEl.querySelector('#import-commit-btn');
  if (commitBtn) commitBtn.textContent = `Save ${remaining.length} rows`;

  // For a current list, show what the rows add up to - so a paste can be
  // checked against the unbilled figure the bank's own site shows.
  const totalsEl = resultsEl.querySelector('#import-live-totals');
  if (totalsEl) {
    const sum = (list) => list.reduce((s, r) => s + r.amount, 0);
    const spends = sum(remaining.filter((r) => r.direction === 'debit'));
    const payments = sum(remaining.filter(isBillPayment));
    const refunds = sum(remaining.filter((r) => r.direction === 'credit' && !isBillPayment(r)));
    const owed = spends - refunds;
    const existingInput = totalsEl.querySelector('#import-check-figure');
    const typed = existingInput ? existingInput.value : '';
    const check = parseFloat(typed);
    const matches = Number.isFinite(check) && Math.abs(Math.round(check * 100) - owed) <= 100;
    totalsEl.innerHTML = `
      <div class="totals-row"><span>Spends</span><span class="out">-${formatCurrency(spends)}</span></div>
      <div class="totals-row"><span>Refunds and cashback</span><span class="in">+${formatCurrency(refunds)}</span></div>
      ${payments ? `<div class="totals-row"><span>Bill payments <span class="muted">(not spending)</span></span><span class="muted">${formatCurrency(payments)}</span></div>` : ''}
      <div class="totals-row net"><span>Owed this cycle</span><span>${formatCurrency(owed)}</span></div>
      ${
        state.meta.printedCharges == null
          ? `<label class="field" style="margin-top:10px">
              <span>Check it: the unbilled amount the bank shows ${typed ? (matches ? '<span class="in">✓ matches</span>' : '<span class="out">doesn\'t match</span>') : ''}</span>
              <input type="number" id="import-check-figure" step="0.01" inputmode="decimal" placeholder="Optional" value="${escapeAttr(typed)}">
            </label>`
          : ''
      }
    `;
    // Keep typing in the box uninterrupted after the redraw.
    const input = totalsEl.querySelector('#import-check-figure');
    if (input && document.activeElement && document.activeElement.id === 'import-check-figure') input.focus();
  }
}

async function commit(resultsEl) {
  const statusEl = resultsEl.querySelector('#import-commit-status');
  const rows = committableRows();
  if (rows.length === 0) {
    showStatus(statusEl, 'No rows left to save.', true);
    return;
  }

  const { meta, parser, provisional, superseded } = state;
  let account = state.account;

  if (provisional) {
    if (!account) {
      showStatus(statusEl, 'Pick the card these belong to first.', true);
      return;
    }
    // Digits that belong to this card but aren't its recorded number (a
    // renewed card, say) are remembered, so the next list finds it on its own.
    if (meta.accountLast4 && account.last4 !== meta.accountLast4) {
      const links = new Set(account.linkedLast4s || []);
      if (!links.has(meta.accountLast4)) {
        links.add(meta.accountLast4);
        account = { ...account, linkedLast4s: [...links] };
        await put('accounts', account);
      }
    }
    // Deliberately nothing else on the account changes: a current list is
    // not a bill. ICICI's prints "Total Amount Due INR 0", which would
    // otherwise wipe out the real amount due.
  } else {
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
    if (account.type === 'card' && !account.billingCycleDay) {
      account.billingCycleDay = new Date(periodEnd).getDate();
    }
    if (account.type === 'bank' && meta.statedClosingBalance != null) {
      account.knownBalance = Math.round(meta.statedClosingBalance * 100);
      account.knownBalanceDate = periodEnd;
    }
    if (account.type === 'card' && meta.totalAmountDue != null) {
      // A newer statement supersedes the last one, so the "paid" flag resets.
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
  }

  const dates = rows.map((r) => r.date).sort();
  const importBatch = {
    id: newId(),
    accountId: account.id,
    periodStart: provisional ? dates[0] : meta.periodStart || dates[0],
    periodEnd: provisional ? meta.periodEnd || dates[dates.length - 1] : meta.periodEnd || dates[dates.length - 1],
    importedAt: new Date().toISOString(),
    txCount: rows.length,
    provisional,
  };
  await put('importBatches', importBatch);

  let matchedCount = 0;
  let unchanged = 0;
  for (const row of rows) {
    if (row._keepExisting) {
      unchanged++;
      continue;
    }
    if (row._matchedManualId) {
      await remove('transactions', row._matchedManualId);
      matchedCount++;
    }
    // Carry over what you decided on the entry this row replaces: a category
    // (already applied to the row), a split, money-moved, the alert it came from.
    const carry = row._carry || {};
    const transaction = {
      id: newId(),
      accountId: account.id,
      date: row.date,
      rawDescription: row.description,
      amount: row.amount,
      direction: row.direction,
      categoryId: row.categoryId || null,
      source: provisional ? 'unbilled' : 'statement',
      importBatchId: importBatch.id,
      isTransfer: carry.isTransfer === true,
      notes: carry.notes || null,
      bankRef: row.ref || null,
    };
    if (carry.transferManual) transaction.transferManual = true;
    if (carry.alertKey) transaction.alertKey = carry.alertKey;
    if (carry.alertRef) transaction.alertRef = carry.alertRef;
    if (Array.isArray(carry.splits) && carry.splits.length) {
      transaction.splits = carry.splits;
      transaction.categoryId = null;
    }
    await put('transactions', transaction);
    if (row.categoryId) await learnFromAssignment(row.description, row.categoryId);
  }

  for (const t of superseded || []) {
    await remove('transactions', t.id);
  }

  const transferCount = await detectTransfers();

  const saved = rows.length - unchanged;
  const parts = [`Saved ${saved} row${saved === 1 ? '' : 's'}`];
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (matchedCount) parts.push(`${matchedCount} matched entries already in the app`);
  if (superseded && superseded.length) parts.push(`removed ${superseded.length} no longer listed`);
  if (transferCount) parts.push(`flagged ${transferCount} as transfers`);
  showStatus(statusEl, `${parts.join(' · ')}.`, false);
  resultsEl.querySelector('#import-commit-btn').disabled = true;

  const nextEl = resultsEl.querySelector('#import-next');
  if (state.queue && state.queue.length) {
    const next = state.queue[0];
    nextEl.innerHTML = `<button type="button" id="import-next-btn" class="btn-primary">Next card${next.last4 ? `: ••${next.last4}` : ''} (${next.rowCount} rows) →</button>`;
    state = { parser: state.parser, queue: state.queue };
  } else {
    state = null;
  }
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
