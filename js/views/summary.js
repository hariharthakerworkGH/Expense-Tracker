import { getAll } from '../db.js';
import { formatCurrency, formatSignedCurrency } from '../format.js';

let currentRange = 'this-month';

export async function render(container) {
  container.innerHTML = `
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

  await renderContent(container);
}

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

  const catName = (id) => (id === 'uncategorized' ? 'Uncategorized' : categories.find((c) => c.id === id)?.name || 'Uncategorized');
  const acctName = (id) => accounts.find((a) => a.id === id)?.label || 'Unknown';

  content.innerHTML = `
    <div class="totals-card">
      <div class="totals-row"><span>Total In</span><span class="in">+${formatCurrency(totalIn)}</span></div>
      <div class="totals-row"><span>Total Out</span><span class="out">-${formatCurrency(totalOut)}</span></div>
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
