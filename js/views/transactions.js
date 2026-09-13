import { getAll, put, remove } from '../db.js';
import { learnFromAssignment } from '../merchant-rules.js';
import { formatCurrency } from '../format.js';

const PAGE_SIZE = 75;

const filters = { search: '', accountId: '', categoryId: '', shown: PAGE_SIZE };
let cache = { transactions: [], categories: [], accounts: [] };

export async function render(container, params = {}) {
  const [transactions, categories, accounts] = await Promise.all([getAll('transactions'), getAll('categories'), getAll('accounts')]);
  cache = { transactions, categories, accounts };

  // Opening the screen always starts from a clean slate - a filter left over
  // from last time silently hides transactions with no obvious reason why.
  filters.search = '';
  filters.accountId = '';
  filters.categoryId = params.filter === 'uncategorized' ? 'uncategorized' : '';
  filters.shown = PAGE_SIZE;

  container.innerHTML = `
    <div class="filter-bar">
      <input type="search" id="txn-search" class="txn-search" placeholder="Search descriptions…" value="${escapeAttr(filters.search)}">
      <div class="filter-row">
        <select id="txn-account">
          <option value="">All accounts</option>
          ${accounts.map((a) => `<option value="${a.id}" ${filters.accountId === a.id ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('')}
        </select>
        <select id="txn-category">
          <option value="">All categories</option>
          <option value="uncategorized" ${filters.categoryId === 'uncategorized' ? 'selected' : ''}>Needs a category</option>
          ${categories.map((c) => `<option value="${c.id}" ${filters.categoryId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <p class="import-intro" id="txn-count"></p>
    <div id="txn-list" class="review-list"></div>
    <button type="button" id="txn-more" class="btn-secondary btn-block" hidden>Show more</button>
  `;

  const searchEl = container.querySelector('#txn-search');
  searchEl.addEventListener('input', () => {
    filters.search = searchEl.value;
    filters.shown = PAGE_SIZE;
    renderList(container);
  });
  container.querySelector('#txn-account').addEventListener('change', (e) => {
    filters.accountId = e.target.value;
    filters.shown = PAGE_SIZE;
    renderList(container);
  });
  container.querySelector('#txn-category').addEventListener('change', (e) => {
    filters.categoryId = e.target.value;
    filters.shown = PAGE_SIZE;
    renderList(container);
  });
  container.querySelector('#txn-more').addEventListener('click', () => {
    filters.shown += PAGE_SIZE;
    renderList(container);
  });

  const listEl = container.querySelector('#txn-list');
  listEl.addEventListener('input', (e) => handleFieldChange(e, container));
  listEl.addEventListener('change', (e) => handleFieldChange(e, container));
  listEl.addEventListener('click', (e) => handleClick(e, container));

  renderList(container);
}

function matching() {
  const needle = filters.search.trim().toLowerCase();
  return cache.transactions
    .filter((t) => {
      if (filters.accountId && t.accountId !== filters.accountId) return false;
      if (filters.categoryId === 'uncategorized' && t.categoryId) return false;
      if (filters.categoryId && filters.categoryId !== 'uncategorized' && t.categoryId !== filters.categoryId) return false;
      if (needle && !t.rawDescription.toLowerCase().includes(needle)) return false;
      return true;
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function renderList(container) {
  const rows = matching();
  const visible = rows.slice(0, filters.shown);
  const out = rows.filter((t) => t.direction === 'debit' && !t.isTransfer).reduce((s, t) => s + t.amount, 0);
  const inAmt = rows.filter((t) => t.direction === 'credit' && !t.isTransfer).reduce((s, t) => s + t.amount, 0);

  container.querySelector('#txn-count').innerHTML = rows.length
    ? `${rows.length} transaction${rows.length === 1 ? '' : 's'} · <span class="out">-${formatCurrency(out)}</span> <span class="in">+${formatCurrency(inAmt)}</span>`
    : 'Nothing matches those filters.';

  container.querySelector('#txn-list').innerHTML = visible.map((t) => rowTemplate(t, cache.categories, cache.accounts)).join('');

  const moreBtn = container.querySelector('#txn-more');
  moreBtn.hidden = rows.length <= visible.length;
  moreBtn.textContent = `Show ${Math.min(PAGE_SIZE, rows.length - visible.length)} more`;
}

async function handleFieldChange(e, container) {
  const field = e.target.dataset.field;
  if (!field) return;
  const rowEl = e.target.closest('.review-row');
  const t = cache.transactions.find((x) => x.id === rowEl.dataset.id);

  if (field === 'amount') {
    const parsed = parseFloat(e.target.value);
    t.amount = Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
    const amountEl = rowEl.querySelector('.rv-amount-display');
    if (amountEl) amountEl.textContent = `${t.direction === 'credit' ? '+' : '-'}${formatCurrency(t.amount)}`;
  } else if (field === 'date') {
    if (!e.target.value) return;
    t.date = e.target.value;
  } else if (field === 'rawDescription') {
    t.rawDescription = e.target.value;
  } else if (field === 'categoryId') {
    const categoryId = e.target.value || null;
    t.categoryId = categoryId;
    await put('transactions', t);
    if (categoryId) await learnFromAssignment(t.rawDescription, categoryId);
    if (filters.categoryId === 'uncategorized' && categoryId) {
      rowEl.remove();
      renderCountOnly(container);
    }
    return;
  }
  await put('transactions', t);
}

function renderCountOnly(container) {
  const rows = matching();
  container.querySelector('#txn-count').innerHTML = rows.length
    ? `${rows.length} transaction${rows.length === 1 ? '' : 's'} left to categorize.`
    : 'All caught up - nothing needs a category.';
}

async function handleClick(e, container) {
  const rowEl = e.target.closest('.review-row');
  if (!rowEl) return;
  const t = cache.transactions.find((x) => x.id === rowEl.dataset.id);

  const deleteBtn = e.target.closest('.rv-delete');
  if (deleteBtn) {
    if (!confirm(`Delete "${t.rawDescription.slice(0, 60)}"? This can't be undone.`)) return;
    await remove('transactions', t.id);
    cache.transactions = cache.transactions.filter((x) => x.id !== t.id);
    rowEl.remove();
    renderCountOnly(container);
    return;
  }

  const transferBtn = e.target.closest('.review-transfer-toggle');
  if (transferBtn) {
    t.isTransfer = !t.isTransfer;
    await put('transactions', t);
    transferBtn.textContent = t.isTransfer ? 'Not a transfer' : 'Mark as transfer';
    transferBtn.classList.toggle('active', t.isTransfer);
    return;
  }

  const dirBtn = e.target.closest('.rv-dir');
  if (dirBtn) {
    t.direction = dirBtn.dataset.dir;
    await put('transactions', t);
    rowEl.querySelectorAll('.rv-dir').forEach((b) => b.classList.toggle('active', b === dirBtn));
    const amountEl = rowEl.querySelector('.rv-amount-display');
    amountEl.textContent = `${t.direction === 'credit' ? '+' : '-'}${formatCurrency(t.amount)}`;
    amountEl.className = `rv-amount-display ${t.direction === 'credit' ? 'in' : 'out'}`;
  }
}

function rowTemplate(t, categories, accounts) {
  const sign = t.direction === 'credit' ? '+' : '-';
  const amountClass = t.direction === 'credit' ? 'in' : 'out';
  const accountLabel = accounts.find((a) => a.id === t.accountId)?.label || 'Unknown';
  return `
    <div class="review-row" data-id="${t.id}">
      <div class="review-row-top">
        <input type="date" class="rv-field rv-date" data-field="date" value="${t.date}">
        <span class="rv-account-label">${escapeHtml(accountLabel)}</span>
        <button type="button" class="icon-btn rv-delete" title="Delete transaction" aria-label="Delete transaction">✕</button>
      </div>
      <input type="text" class="rv-field rv-desc" data-field="rawDescription" value="${escapeAttr(t.rawDescription)}">
      <div class="review-row-mid">
        <div class="direction-toggle small">
          <button type="button" class="dir-btn rv-dir ${t.direction === 'debit' ? 'active' : ''}" data-dir="debit">Spent</button>
          <button type="button" class="dir-btn rv-dir ${t.direction === 'credit' ? 'active' : ''}" data-dir="credit">Received</button>
        </div>
        <input type="number" step="0.01" class="rv-field rv-amount-input" data-field="amount" value="${(t.amount / 100).toFixed(2)}">
        <span class="rv-amount-display ${amountClass}">${sign}${formatCurrency(t.amount)}</span>
      </div>
      <div class="review-row-bottom">
        <select class="rv-field rv-category ${t.categoryId ? '' : 'needs-category'}" data-field="categoryId">
          <option value="">Needs a category</option>
          ${categories.map((c) => `<option value="${c.id}" ${c.id === t.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <button type="button" class="icon-btn review-transfer-toggle ${t.isTransfer ? 'active' : ''}">${t.isTransfer ? 'Not a transfer' : 'Mark as transfer'}</button>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
