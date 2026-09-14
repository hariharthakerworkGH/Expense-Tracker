import { getAll, put, getSetting, setSetting } from '../db.js';
import { formatCurrency, formatSignedCurrency, formatDateNice } from '../format.js';
import { bankBalance, cardCycleSpend, cardBillDue } from '../account-metrics.js';
import { detectRecurring, nextDueDate } from '../recurring.js';
import { detectAnomalies } from '../anomalies.js';
import { categoryStyle } from '../category-style.js';
import { categorySlices, needsCategory } from '../splits.js';
import { getBudgets, budgetStatusForMonth, cycleAwareEnabled } from '../budgets.js';
import { spendingMonthOf, accountMap, currentMonthKey, previousMonthKey, cycleExplanation } from '../spending-month.js';
import { APP_VERSION, versionStatus, checkForUpdate } from '../version.js';
import { getSyncConfig } from '../sync.js';
import { pendingCount } from '../alert-inbox.js';
import { applyLearnedCategories } from '../merchant-rules.js';
import { showToast } from '../toast.js';

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

  dashboardEl.innerHTML = [
    renderNetPosition(accounts, transactions, importBatches),
    '<div id="attention-section"></div>',
    '<div id="upcoming-section"></div>',
  ].join('');

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

  const soonest = bills.filter((b) => b.daysLeft != null).sort((a, b) => a.daysLeft - b.daysLeft)[0];

  if (!knownBank && cardAccounts.length === 0) {
    return `<div class="totals-card"><p class="muted-note">Add a bank account or card and import a statement to see your net position here.</p></div>`;
  }

  const dueNote = soonest
    ? soonest.daysLeft < 0
      ? `<span class="bill-overdue">overdue</span>`
      : soonest.daysLeft === 0
        ? `<span class="bill-urgent">due today</span>`
        : `<span class="${soonest.daysLeft <= 3 ? 'bill-urgent' : 'muted'}">in ${soonest.daysLeft}d</span>`
    : '';

  // The number that actually answers "can I afford this?" is what's left once
  // the cards are settled, so that gets the hero treatment - not the raw
  // balance, which flatters you by the size of your unpaid bills.
  const net = totalBank - billsDue;
  return `
    <div class="hero">
      <p class="hero-label">${knownBank ? 'Left after paying bills' : 'Card bills due'}</p>
      <p class="hero-amount ${knownBank ? (net < 0 ? 'negative' : '') : 'negative'}">${knownBank ? formatSignedCurrency(net) : formatCurrency(billsDue)}</p>
      ${unbilled > 0 ? `<p class="hero-sub">Plus ${formatCurrency(unbilled)} spent on cards since your last statements, not billed yet.</p>` : ''}
      <div class="hero-split">
        <div class="hero-stat">
          <span class="stat-label">In your bank</span>
          <span class="stat-value">${knownBank ? formatCurrency(totalBank) : '—'}</span>
        </div>
        <div class="hero-stat">
          <span class="stat-label">Bills due ${dueNote}</span>
          <span class="stat-value out">${formatCurrency(billsDue)}</span>
        </div>
      </div>
    </div>
  `;
}

async function renderAttention(container, transactions) {
  const el = container.querySelector('#attention-section');
  if (!el) return;

  const [accounts, categories, budgets, alertsWaiting] = await Promise.all([
    getAll('accounts'),
    getAll('categories'),
    getBudgets(),
    pendingCount(),
  ]);
  const uncategorized = transactions.filter((t) => needsCategory(t));
  const monthStart = `${currentMonthKey()}-01`;
  const dismissed = new Set(await getSetting('dismissedAnomalies', []));
  const anomalies = (await detectAnomalies(monthStart)).filter((a) => !dismissed.has(a.transaction.id));

  // How many of the uncategorised ones the app could sort on its own from what
  // it has already learned. Offering "sort 94 of these for me" is a far better
  // answer than "136 need a category".
  const autoSortable = uncategorized.length ? await applyLearnedCategories({ dryRun: true }) : 0;

  const dueCards = accounts
    .map((a) => ({ account: a, bill: cardBillDue(a) }))
    .filter((x) => x.bill && !x.bill.paid && x.bill.daysLeft != null && x.bill.daysLeft <= 5);

  const budgetAlerts = (await budgetStatusForMonth(budgets, categories, transactions, currentMonthKey())).filter((b) => b.state !== 'ok');

  if (alertsWaiting === 0 && uncategorized.length === 0 && anomalies.length === 0 && dueCards.length === 0 && budgetAlerts.length === 0) {
    el.innerHTML = `<h3>Needs your attention</h3><div class="totals-card"><p class="muted-note">Nothing to deal with right now.</p></div>`;
    return;
  }

  el.innerHTML = `
    <h3>Needs your attention</h3>
    <div class="totals-card">
      ${
        alertsWaiting > 0
          ? `<div class="attention-row">
              <span>${alertsWaiting} bank alert${alertsWaiting === 1 ? '' : 's'} to check<br><span class="muted-note">Shared from your messages, not counted until you save ${alertsWaiting === 1 ? 'it' : 'them'}</span></span>
              <button type="button" class="btn-tiny primary" id="go-inbox-btn">Check</button>
            </div>`
          : ''
      }
      ${dueCards
        .map(
          ({ account, bill }) => `
        <div class="attention-row">
          <span>${escapeHtml(account.label)} — ${formatCurrency(bill.amount)}<br><span class="muted-note bill-${bill.daysLeft < 0 ? 'overdue' : 'urgent'}">${bill.daysLeft < 0 ? `overdue by ${Math.abs(bill.daysLeft)}d` : bill.daysLeft === 0 ? 'due today' : `due in ${bill.daysLeft}d`}</span></span>
          <button type="button" class="btn-tiny mark-paid" data-id="${account.id}">Mark paid</button>
        </div>`
        )
        .join('')}
      ${budgetAlerts
        .map((b) => {
          const { icon, color } = categoryStyle(b.name);
          return `
        <div class="attention-row">
          <span class="breakdown-label">
            <span class="cat-chip" style="--chip-color:${color}">${icon}</span>
            <span>${escapeHtml(b.name)} budget<br><span class="muted-note ${b.state === 'over' ? 'bill-overdue' : 'bill-urgent'}">${
              b.state === 'over' ? `over by ${formatCurrency(-b.left)}` : `${formatCurrency(b.left)} left of ${formatCurrency(b.limit)}`
            }</span></span>
          </span>
          <button type="button" class="btn-tiny budget-open" data-id="${b.categoryId}">See</button>
        </div>`;
        })
        .join('')}
      ${
        uncategorized.length > 0
          ? `<div class="attention-row">
              <span>${uncategorized.length} transaction${uncategorized.length === 1 ? '' : 's'} need${uncategorized.length === 1 ? 's' : ''} a category${
                autoSortable > 0 ? `<br><span class="muted-note">${autoSortable} can be sorted from what you've already taught it</span>` : ''
              }</span>
              <span class="attention-actions">
                ${autoSortable > 0 ? `<button type="button" class="btn-tiny primary" id="auto-sort-btn">Sort ${autoSortable}</button>` : ''}
                <button type="button" class="btn-tiny" id="go-transactions-btn">Open</button>
              </span>
            </div>`
          : ''
      }
      ${anomalies
        .slice(0, 3)
        .map(
          (a) => `
        <div class="attention-row">
          <span>${escapeHtml(a.transaction.rawDescription.slice(0, 46))} — ${formatCurrency(a.transaction.amount)}<br><span class="muted-note">${a.reason === 'new-merchant' ? 'first time at this merchant' : `usually around ${formatCurrency(a.averageAmount)}`}</span></span>
          <span class="attention-actions">
            <button type="button" class="btn-tiny anomaly-open" data-desc="${escapeAttr(a.transaction.rawDescription.slice(0, 24))}">Open</button>
            <button type="button" class="icon-btn anomaly-dismiss" data-id="${a.transaction.id}" aria-label="Dismiss">✕</button>
          </span>
        </div>`
        )
        .join('')}
    </div>
  `;

  const inboxBtn = el.querySelector('#go-inbox-btn');
  if (inboxBtn) {
    inboxBtn.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'inbox' } }));
    });
  }

  const goBtn = el.querySelector('#go-transactions-btn');
  if (goBtn) {
    goBtn.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'transactions', filter: 'uncategorized' } }));
    });
  }

  const autoBtn = el.querySelector('#auto-sort-btn');
  if (autoBtn) {
    autoBtn.addEventListener('click', async () => {
      autoBtn.disabled = true;
      autoBtn.textContent = 'Sorting…';
      const n = await applyLearnedCategories();
      showToast(`Sorted ${n} transaction${n === 1 ? '' : 's'}`);
      render(container);
    });
  }

  el.querySelectorAll('.budget-open').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'transactions', categoryId: btn.dataset.id, range: 'this-month' } }));
    });
  });

  el.querySelectorAll('.mark-paid').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const account = accounts.find((a) => a.id === btn.dataset.id);
      account.statementDuePaid = true;
      await put('accounts', account);
      render(container);
    });
  });

  el.querySelectorAll('.anomaly-open').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'transactions', search: btn.dataset.desc } }));
    });
  });

  el.querySelectorAll('.anomaly-dismiss').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const list = await getSetting('dismissedAnomalies', []);
      await setSetting('dismissedAnomalies', [...new Set([...list, btn.dataset.id])]);
      render(container);
    });
  });
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

// --- Range breakdown ---

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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const cycleAware = await cycleAwareEnabled();

  // For "this month" and "last month" the unit is a spending month, so card
  // purchases sit in the month they'll actually be billed in. A custom range
  // stays literal - if you asked for two dates, you meant those two dates.
  const monthKey = currentRange === 'this-month' ? currentMonthKey() : currentRange === 'last-month' ? previousMonthKey(currentMonthKey()) : null;
  const byAccountId = accountMap(accounts);
  const inRange = (
    monthKey
      ? transactions.filter((t) => spendingMonthOf(t, byAccountId.get(t.accountId), cycleAware) === monthKey)
      : transactions.filter((t) => t.date >= from && t.date <= to)
  ).filter((t) => !t.isTransfer);

  let totalIn = 0;
  let totalOut = 0;
  const byCategory = new Map();
  const byAccount = new Map();

  for (const t of inRange) {
    if (t.direction === 'credit') totalIn += t.amount;
    else totalOut += t.amount;

    // Split-aware: one transaction can land in several categories.
    for (const slice of categorySlices(t)) {
      addToBucket(byCategory, slice.categoryId || 'uncategorized', t.direction, slice.amount);
    }
    addToBucket(byAccount, t.accountId, t.direction, t.amount);
  }

  let comparisonHtml = '';
  const comparison = comparisonPeriod();
  if (comparison) {
    const prevOut = transactions
      .filter((t) => {
        if (t.isTransfer || t.direction !== 'debit') return false;
        // Compare against the same slice of the previous spending month, so a
        // half-finished month isn't measured against a complete one.
        if (monthKey) {
          const m = spendingMonthOf(t, byAccountId.get(t.accountId), cycleAware);
          return m === previousMonthKey(monthKey) && t.date <= comparison.to;
        }
        return t.date >= comparison.from && t.date <= comparison.to;
      })
      .reduce((s, t) => s + t.amount, 0);
    if (prevOut > 0) {
      const pctChange = Math.round(((totalOut - prevOut) / prevOut) * 100);
      const arrow = pctChange > 0 ? '↑' : pctChange < 0 ? '↓' : '→';
      comparisonHtml = `<div class="muted-note">${arrow} ${Math.abs(pctChange)}% ${comparison.label} (${formatCurrency(prevOut)})</div>`;
    }
  }

  const catName = (id) => (id === 'uncategorized' ? 'Uncategorized' : categories.find((c) => c.id === id)?.name || 'Uncategorized');
  const cycleNote = monthKey ? cycleExplanation(accounts, cycleAware) : null;

  content.innerHTML = `
    <div class="totals-card">
      <div class="totals-row"><span>Total In</span><span class="in">+${formatCurrency(totalIn)}</span></div>
      <div class="totals-row"><span>Total Out</span><span class="out">-${formatCurrency(totalOut)}</span></div>
      ${comparisonHtml}
      <div class="totals-row net"><span>Net</span><span>${formatSignedCurrency(totalIn - totalOut)}</span></div>
    </div>
    ${cycleNote ? `<p class="muted-note cycle-note">${escapeHtml(cycleNote)}</p>` : ''}
    <button type="button" id="recap-link" class="btn-secondary btn-block">See your month in review →</button>
    <h3>Where it went</h3>
    <ul class="breakdown-list">${renderCategoryBreakdown(byCategory, catName, totalOut)}</ul>
    <h3>Which account paid</h3>
    <p class="group-subtitle">Every account you've added. Ones you didn't touch in this period say so, rather than quietly vanishing.</p>
    <ul class="breakdown-list">${renderAccountBreakdown(byAccount, accounts, transactions)}</ul>
    <div class="version-line" id="version-line">
      <span id="version-text">Version ${APP_VERSION}</span>
      <button type="button" class="icon-btn" id="version-check">Check for update</button>
    </div>
  `;

  content.querySelector('#recap-link').addEventListener('click', () => {
    container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'recap' } }));
  });

  renderVersionLine(content);
}

// Answers two questions at a glance: am I running the current code, and is my
// data current. Both have caused confusion, and both are cheap to state.
async function renderVersionLine(content) {
  const textEl = content.querySelector('#version-text');
  const btn = content.querySelector('#version-check');
  if (!textEl || !btn) return;

  const paint = async (status) => {
    const bits = [`Version ${status.running}`];
    // With no cached copy to compare against there is nothing to be stale
    // against either, so claim nothing rather than a reassuring "up to date".
    if (status.stale) bits.push(`version ${status.cached} ready — reopen the app`);
    else if (status.cached != null) bits.push('up to date');

    const { configured, lastSync } = await getSyncConfig();
    if (!configured) bits.push('sync off');
    else if (lastSync) bits.push(`synced ${relativeTime(lastSync)}`);
    else bits.push('not synced yet');

    textEl.textContent = bits.join(' · ');
    textEl.classList.toggle('stale', status.stale);
  };

  await paint(await versionStatus());

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const status = await checkForUpdate();
    await paint(status);
    btn.disabled = false;
    btn.textContent = status.stale ? 'Reload' : 'Check for update';
    if (status.stale) btn.onclick = () => window.location.reload();
  });
}

function relativeTime(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function addToBucket(map, key, direction, amount) {
  if (!map.has(key)) map.set(key, { in: 0, out: 0 });
  const bucket = map.get(key);
  if (direction === 'credit') bucket.in += amount;
  else bucket.out += amount;
}

function renderCategoryBreakdown(map, nameFn, totalOut) {
  const rows = [...map.entries()].sort((a, b) => b[1].out - b[1].in - (a[1].out - a[1].in));
  if (rows.length === 0) return '<li class="empty">No transactions.</li>';

  return rows
    .map(([id, v]) => {
      const name = nameFn(id);
      const { icon, color } = categoryStyle(name);
      const share = totalOut > 0 ? Math.min(100, Math.round((v.out / totalOut) * 100)) : 0;
      return `
      <li class="breakdown-row" style="--chip-color:${color}">
        <span class="breakdown-label">
          <span class="cat-chip" style="--chip-color:${color}">${icon}</span>
          <span>
            ${escapeHtml(name)}
            ${v.out ? `<span class="breakdown-bar" style="width:${Math.max(6, share)}%"></span>` : ''}
          </span>
        </span>
        <span class="amounts">
          ${v.out ? `<span class="out">-${formatCurrency(v.out)}</span>` : ''}
          ${v.in ? `<span class="in">+${formatCurrency(v.in)}</span>` : ''}
        </span>
      </li>`;
    })
    .join('');
}

// Unlike the category breakdown, this lists accounts with no activity too.
// An account dropping off the list looks like a bug; "not used since 25 Aug"
// is the actual answer to "why isn't my card here?".
function renderAccountBreakdown(byAccount, accounts, transactions) {
  const lastUsed = new Map();
  for (const t of transactions) {
    const prev = lastUsed.get(t.accountId);
    if (!prev || t.date > prev) lastUsed.set(t.accountId, t.date);
  }

  // Accounts that spent money first, biggest first; then the idle ones by how
  // recently they were used, with never-used accounts at the very bottom.
  const rows = accounts
    .map((a) => ({ account: a, bucket: byAccount.get(a.id) || { in: 0, out: 0 }, last: lastUsed.get(a.id) }))
    .sort((x, y) => {
      const xu = x.bucket.out || x.bucket.in;
      const yu = y.bucket.out || y.bucket.in;
      if (xu && yu) return y.bucket.out - y.bucket.in - (x.bucket.out - x.bucket.in);
      if (xu !== yu) return xu ? -1 : 1;
      return (y.last || '').localeCompare(x.last || '');
    });

  return rows
    .map(({ account, bucket, last }) => {
      const used = bucket.out || bucket.in;
      const note = last ? `nothing in this period · last used ${formatDateNice(last)}` : 'never used';
      const icon = account.type === 'card' ? '💳' : account.type === 'cash' ? '💵' : '🏦';
      return `
      <li class="breakdown-row${used ? '' : ' breakdown-idle'}">
        <span class="breakdown-label">
          <span class="cat-chip" style="--chip-color:#8b5cf6">${icon}</span>
          <span>${escapeHtml(account.label)}${used ? '' : `<br><span class="muted-note">${note}</span>`}</span>
        </span>
        <span class="amounts">
          ${bucket.out ? `<span class="out">-${formatCurrency(bucket.out)}</span>` : ''}
          ${bucket.in ? `<span class="in">+${formatCurrency(bucket.in)}</span>` : ''}
          ${used ? '' : '<span class="muted">—</span>'}
        </span>
      </li>`;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
