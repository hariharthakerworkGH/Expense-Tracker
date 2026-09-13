import { getAll, put } from '../db.js';
import { formatCurrency, formatSignedCurrency, formatDateNice } from '../format.js';
import { bankBalance, cardCycleSpend, cardBillDue } from '../account-metrics.js';
import { detectRecurring, nextDueDate } from '../recurring.js';
import { detectAnomalies } from '../anomalies.js';

let currentRange = 'this-month';

export async function render(container) {
  container.innerHTML = `
    <div id="dashboard"></div>
    <div class="segmented">
      <button type="button" class="seg-btn ${currentRange === 'this-month' ? 'active' : ''}" data-range="this-month">This Month</button>
      <button type="button" class="seg-btn ${currentRange === 'last-month' ? 'active' : ''}" data-range="last-month">Last Month</button>
      <button type="button" class="seg-btn ${currentRange === 'custom' ? 'active' : ''}" data-range="custom">Custom</button>
    </div>
    <div id="custom-range" class="custom-range" ${currentRange === 'custom' ? '' : 'hidden'}>
      <label>From <input type="date" id="range-from"></label>
      <label>To <input type="date" id="range-to"></label>
      <button type="button" id="range-apply" class="btn-secondary">Apply</button>
    </div>
    <div id="summary-content">Loading…</div>
  `;

  container.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentRange = btn.dataset.range;
      render(container);
    });
  });

  if (currentRange === 'custom') {
    container.querySelector('#range-apply').addEventListener('click', () => renderContent(container));
  }

  await Promise.all([renderDashboard(container), renderContent(container)]);
}

// --- Dashboard: net position, things needing attention, upcoming bills ---

async function renderDashboard(container) {
  const dashboardEl = container.querySelector('#dashboard');
  const [accounts, transactions, importBatches] = await Promise.all([getAll('accounts'), getAll('transactions'), getAll('importBatches')]);

  dashboardEl.innerHTML = [renderNetPosition(accounts, transactions, importBatches), '<div id="attention-section"></div>', '<div id="upcoming-section"></div>'].join('');

  await renderAttention(container, transactions);
  await renderUpcoming(container);
}

function renderNetPosition(accounts, transactions, importBatches) {
  const bankAccounts = accounts.filter((a) => a.type === 'bank');
  const cardAccounts = accounts.filter((a) => a.type === 'card');

  const bankBalances = bankAccounts.map((a) => bankBalance(a, transactions)).filter((b) => b != null);
  const knownBank = bankBalances.length > 0;
  const totalBank = bankBalances.reduce((s, b) => s + b, 0);

  const bills = cardAccounts.map((a) => cardBillDue(a)).filter((b) => b && !b.paid);
  const billsDue = bills.reduce((s, b) => s + b.amount, 0);
  const unbilled = cardAccounts.reduce((s, a) => s + cardCycleSpend(a, transactions, importBatches).spend, 0);

  const soonest = bills
    .filter((b) => b.daysLeft != null)
    .sort((a, b) => a.daysLeft - b.daysLeft)[0];

  if (!knownBank && cardAccounts.length === 0) {
    return `<div class="totals-card"><p class="muted-note">Add a bank account or card and import a statement to see your net position here.</p></div>`;
  }

  const dueNote = soonest
    ? soonest.daysLeft < 0
      ? `<span class="bill-overdue">overdue</span>`
      : soonest.daysLeft === 0
        ? `<span class="bill-urgent">due today</span>`
        : `<span class="${soonest.daysLeft <= 3 ? 'bill-urgent' : 'muted'}">soonest in ${soonest.daysLeft}d</span>`
    : '';

  return `
    <div class="totals-card">
      <div class="totals-row"><span>In your bank</span><span>${knownBank ? formatCurrency(totalBank) : '<span class="muted">unknown</span>'}</span></div>
      <div class="totals-row"><span>Card bills due ${dueNote}</span><span class="out">${formatCurrency(billsDue)}</span></div>
      ${knownBank ? `<div class="totals-row net"><span>Left after paying bills</span><span>${formatSignedCurrency(totalBank - billsDue)}</span></div>` : ''}
      ${unbilled > 0 ? `<div class="muted-note">plus ${formatCurrency(unbilled)} spent on cards since your last statements, not billed yet</div>` : ''}
    </div>
  `;
}

async function renderAttention(container, transactions) {
  const el = container.querySelector('#attention-section');
  if (!el) return;

  const uncategorizedCount = transactions.filter((t) => !t.categoryId).length;
  const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
  const anomalies = await detectAnomalies(monthStart);

  if (uncategorizedCount === 0 && anomalies.length === 0) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <h3>Needs your attention</h3>
    <div class="totals-card">
      ${uncategorizedCount > 0 ? `<div class="attention-row"><span>${uncategorizedCount} transaction${uncategorizedCount === 1 ? '' : 's'} need${uncategorizedCount === 1 ? 's' : ''} a category</span><button type="button" class="btn-tiny" id="go-transactions-btn">Review</button></div>` : ''}
      ${anomalies
        .slice(0, 3)
        .map(
          (a) => `
        <div class="attention-row">
          <span>${escapeHtml(a.transaction.rawDescription)} - ${formatCurrency(a.transaction.amount)}</span>
          <span class="muted-note">${a.reason === 'new-merchant' ? 'new merchant' : `usually ~${formatCurrency(a.averageAmount)}`}</span>
        </div>`
        )
        .join('')}
    </div>
  `;

  const goBtn = el.querySelector('#go-transactions-btn');
  if (goBtn) {
    goBtn.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'transactions', filter: 'uncategorized' } }));
    });
  }
}

async function renderUpcoming(container) {
  const el = container.querySelector('#upcoming-section');
  if (!el) return;

  const [detected, categories] = await Promise.all([detectRecurring(), getAll('categories')]);
  if (detected.length === 0) {
    el.innerHTML = '';
    return;
  }

  const withDueDates = detected
    .map((r) => ({ ...r, due: nextDueDate(r.dayOfMonth) }))
    .sort((a, b) => (a.due < b.due ? -1 : 1));

  const catName = (id) => categories.find((c) => c.id === id)?.name;

  el.innerHTML = `
    <h3>Upcoming</h3>
    <div class="totals-card">
      ${withDueDates
        .map(
          (r) => `
        <div class="upcoming-row">
          <div class="attention-row">
            <span>${escapeHtml(r.label)}${catName(r.categoryId) ? ` <span class="muted-note">(${escapeHtml(catName(r.categoryId))})</span>` : ''}<br><span class="muted-note">due ${formatDateNice(r.due)}</span></span>
            <span class="out">${formatCurrency(r.amount)}</span>
          </div>
          <button type="button" class="icon-btn recurring-dismiss" data-id="${r.id}">Not recurring</button>
        </div>
      `
        )
        .join('')}
    </div>
  `;

  el.querySelectorAll('.recurring-dismiss').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const rec = detected.find((r) => r.id === btn.dataset.id);
      rec.active = false;
      await put('recurring', rec);
      renderUpcoming(container);
    });
  });
}

// --- Existing range breakdown ---

function getRangeDates() {
  const now = new Date();
  if (currentRange === 'this-month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return [toISODate(start), toISODate(end)];
  }
  if (currentRange === 'last-month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return [toISODate(start), toISODate(end)];
  }
  return null;
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

// Comparing a month that's only 13 days old against a full previous month
// reads as a huge drop that isn't real, so compare like with like: this
// month-to-date against the same slice of last month.
function comparisonPeriod(now = new Date()) {
  if (currentRange === 'this-month') {
    const dayOfMonth = now.getDate();
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const prevEnd = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(dayOfMonth, prevMonthEnd));
    return { from: toISODate(prevStart), to: toISODate(prevEnd), label: 'vs the same days last month' };
  }
  if (currentRange === 'last-month') {
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const prevEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0);
    return { from: toISODate(prevStart), to: toISODate(prevEnd), label: 'vs the month before' };
  }
  return null;
}

async function renderContent(container) {
  const content = container.querySelector('#summary-content');
  let from;
  let to;

  if (currentRange === 'custom') {
    from = container.querySelector('#range-from').value;
    to = container.querySelector('#range-to').value;
    if (!from || !to) {
      content.innerHTML = '<p class="empty">Pick both dates.</p>';
      return;
    }
  } else {
    [from, to] = getRangeDates();
  }

  const [transactions, categories, accounts] = await Promise.all([getAll('transactions'), getAll('categories'), getAll('accounts')]);
  const inRange = transactions.filter((t) => t.date >= from && t.date <= to && !t.isTransfer);

  let totalIn = 0;
  let totalOut = 0;
  const byCategory = new Map();
  const byAccount = new Map();

  for (const t of inRange) {
    if (t.direction === 'credit') totalIn += t.amount;
    else totalOut += t.amount;

    addToBucket(byCategory, t.categoryId || 'uncategorized', t);
    addToBucket(byAccount, t.accountId, t);
  }

  let comparisonHtml = '';
  const comparison = comparisonPeriod();
  if (comparison) {
    const prevOut = transactions.filter((t) => t.date >= comparison.from && t.date <= comparison.to && !t.isTransfer && t.direction === 'debit').reduce((s, t) => s + t.amount, 0);
    if (prevOut > 0) {
      const pctChange = Math.round(((totalOut - prevOut) / prevOut) * 100);
      const arrow = pctChange > 0 ? '↑' : pctChange < 0 ? '↓' : '→';
      comparisonHtml = `<div class="muted-note">${arrow} ${Math.abs(pctChange)}% ${comparison.label} (${formatCurrency(prevOut)})</div>`;
    }
  }

  const catName = (id) => (id === 'uncategorized' ? 'Uncategorized' : categories.find((c) => c.id === id)?.name || 'Uncategorized');
  const acctName = (id) => accounts.find((a) => a.id === id)?.label || 'Unknown';

  content.innerHTML = `
    <div class="totals-card">
      <div class="totals-row"><span>Total In</span><span class="in">+${formatCurrency(totalIn)}</span></div>
      <div class="totals-row"><span>Total Out</span><span class="out">-${formatCurrency(totalOut)}</span></div>
      ${comparisonHtml}
      <div class="totals-row net"><span>Net</span><span>${formatSignedCurrency(totalIn - totalOut)}</span></div>
    </div>
    <h3>By Category</h3>
    <ul class="breakdown-list">${renderBreakdown(byCategory, catName)}</ul>
    <h3>By Account</h3>
    <ul class="breakdown-list">${renderBreakdown(byAccount, acctName)}</ul>
  `;
}

function addToBucket(map, key, t) {
  if (!map.has(key)) map.set(key, { in: 0, out: 0 });
  const bucket = map.get(key);
  if (t.direction === 'credit') bucket.in += t.amount;
  else bucket.out += t.amount;
}

function renderBreakdown(map, nameFn) {
  const rows = [...map.entries()]
    .sort((a, b) => b[1].out - b[1].in - (a[1].out - a[1].in))
    .map(
      ([id, v]) => `
      <li class="breakdown-row">
        <span>${escapeHtml(nameFn(id))}</span>
        <span class="amounts">
          ${v.out ? `<span class="out">-${formatCurrency(v.out)}</span>` : ''}
          ${v.in ? `<span class="in">+${formatCurrency(v.in)}</span>` : ''}
        </span>
      </li>`
    )
    .join('');
  return rows || '<li class="empty">No transactions.</li>';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
