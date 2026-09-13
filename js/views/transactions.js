import { getAll, put, remove } from '../db.js';
import { learnFromAssignment } from '../merchant-rules.js';
import { formatCurrency } from '../format.js';
import { categoryStyle } from '../category-style.js';
import { isSplit, categorySlices, needsCategory, splitTotal } from '../splits.js';

const PAGE_SIZE = 50;

const filters = { search: '', accountId: '', categoryId: '', range: 'all', from: '', to: '', shown: PAGE_SIZE };
let cache = { transactions: [], categories: [], accounts: [] };
let selected = new Set();
let expanded = null;
// Draft splits for the row being split, kept out of the database until saved
// so a half-finished split never affects any total.
let splitDraft = null;

export async function render(container, params = {}) {
  const [transactions, categories, accounts] = await Promise.all([getAll('transactions'), getAll('categories'), getAll('accounts')]);
  cache = { transactions, categories, accounts };
  selected = new Set();
  expanded = null;
  splitDraft = null;

  // Opening the screen always starts from a clean slate - a filter left over
  // from last time silently hides transactions with no obvious reason why.
  filters.search = params.search || '';
  filters.accountId = '';
  filters.categoryId = params.filter === 'uncategorized' ? 'uncategorized' : params.categoryId || '';
  filters.range = params.range || 'all';
  filters.from = '';
  filters.to = '';
  filters.shown = PAGE_SIZE;

  container.innerHTML = `
    <div class="filter-bar">
      <input type="search" id="txn-search" class="txn-search" placeholder="Search descriptions…" value="${escapeAttr(filters.search)}">
      <div class="filter-row">
        <select id="txn-account">
          <option value="">All accounts</option>
          ${accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.label)}</option>`).join('')}
        </select>
        <select id="txn-category">
          <option value="">All categories</option>
          <option value="uncategorized" ${filters.categoryId === 'uncategorized' ? 'selected' : ''}>Needs a category</option>
          ${categoryOptions(null)}
        </select>
      </div>
      <div class="filter-row">
        <select id="txn-range">
          <option value="all">Any time</option>
          <option value="this-month">This month</option>
          <option value="last-month">Last month</option>
          <option value="last-3">Last 3 months</option>
          <option value="this-year">This year</option>
          <option value="custom">Between two dates…</option>
        </select>
      </div>
      <div class="custom-range" id="txn-custom-range" hidden>
        <label>From<input type="date" id="txn-from"></label>
        <label>To<input type="date" id="txn-to"></label>
      </div>
    </div>
    <div class="txn-summary-row">
      <span id="txn-count"></span>
      <button type="button" id="txn-select-all" class="btn-tiny">Select all</button>
    </div>
    <div id="txn-list" class="txn-list"></div>
    <button type="button" id="txn-more" class="btn-secondary btn-block" hidden></button>
    <div id="bulk-bar" class="bulk-bar" hidden>
      <span id="bulk-count"></span>
      <select id="bulk-category">
        <option value="">Set category…</option>
        ${categoryOptions(null)}
      </select>
      <button type="button" id="bulk-delete" class="btn-tiny danger">Delete</button>
    </div>
  `;

  // Reflect filters arrived at by navigation (e.g. "see this budget's spend")
  // in the controls themselves, so what you're looking at is never a mystery.
  container.querySelector('#txn-category').value = filters.categoryId;
  container.querySelector('#txn-custom-range').hidden = filters.range !== 'custom';

  const searchEl = container.querySelector('#txn-search');
  searchEl.addEventListener('input', () => {
    filters.search = searchEl.value;
    resetPage(container);
  });
  container.querySelector('#txn-account').addEventListener('change', (e) => {
    filters.accountId = e.target.value;
    resetPage(container);
  });
  container.querySelector('#txn-category').addEventListener('change', (e) => {
    filters.categoryId = e.target.value;
    resetPage(container);
  });

  const rangeEl = container.querySelector('#txn-range');
  rangeEl.value = filters.range;
  rangeEl.addEventListener('change', (e) => {
    filters.range = e.target.value;
    container.querySelector('#txn-custom-range').hidden = filters.range !== 'custom';
    resetPage(container);
  });
  container.querySelector('#txn-from').addEventListener('change', (e) => {
    filters.from = e.target.value;
    resetPage(container);
  });
  container.querySelector('#txn-to').addEventListener('change', (e) => {
    filters.to = e.target.value;
    resetPage(container);
  });

  container.querySelector('#txn-more').addEventListener('click', () => {
    filters.shown += PAGE_SIZE;
    renderList(container);
  });
  container.querySelector('#txn-select-all').addEventListener('click', () => {
    const rows = matching();
    if (selected.size === rows.length) selected.clear();
    else rows.forEach((t) => selected.add(t.id));
    renderList(container);
  });

  container.querySelector('#bulk-category').addEventListener('change', async (e) => {
    const categoryId = e.target.value;
    if (!categoryId) return;
    for (const id of selected) {
      const t = cache.transactions.find((x) => x.id === id);
      if (!t) continue;
      // A split was set up deliberately; a bulk assign shouldn't flatten it.
      if (isSplit(t)) continue;
      t.categoryId = categoryId;
      await put('transactions', t);
      await learnFromAssignment(t.rawDescription, categoryId);
    }
    selected.clear();
    e.target.value = '';
    renderList(container);
  });

  container.querySelector('#bulk-delete').addEventListener('click', async () => {
    if (!confirm(`Delete ${selected.size} transaction${selected.size === 1 ? '' : 's'}? This can't be undone.`)) return;
    for (const id of selected) {
      await remove('transactions', id);
      cache.transactions = cache.transactions.filter((x) => x.id !== id);
    }
    selected.clear();
    renderList(container);
  });

  const listEl = container.querySelector('#txn-list');
  listEl.addEventListener('click', (e) => handleClick(e, container));
  listEl.addEventListener('change', (e) => handleChange(e, container));
  listEl.addEventListener('input', (e) => handleChange(e, container));

  renderList(container);
}

function resetPage(container) {
  filters.shown = PAGE_SIZE;
  selected.clear();
  renderList(container);
}

function categoryOptions(selectedId) {
  return cache.categories
    .map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${categoryStyle(c.name).icon} ${escapeHtml(c.name)}</option>`)
    .join('');
}

// Returns [from, to] as ISO dates, or null for "any time".
function rangeBounds() {
  const now = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  switch (filters.range) {
    case 'this-month':
      return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)];
    case 'last-month':
      return [iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))];
    case 'last-3':
      return [iso(new Date(now.getFullYear(), now.getMonth() - 2, 1)), iso(now)];
    case 'this-year':
      return [`${now.getFullYear()}-01-01`, iso(now)];
    case 'custom':
      // An open-ended custom range is still useful: "everything after 1 April".
      return [filters.from || '0000-01-01', filters.to || '9999-12-31'];
    default:
      return null;
  }
}

function matching() {
  const needle = filters.search.trim().toLowerCase();
  const bounds = rangeBounds();
  return cache.transactions
    .filter((t) => {
      if (filters.accountId && t.accountId !== filters.accountId) return false;
      if (filters.categoryId === 'uncategorized' && !needsCategory(t)) return false;
      if (filters.categoryId && filters.categoryId !== 'uncategorized') {
        const hit = categorySlices(t).some((s) => s.categoryId === filters.categoryId);
        if (!hit) return false;
      }
      if (bounds && (t.date < bounds[0] || t.date > bounds[1])) return false;
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
    ? `${rows.length} · <span class="out">-${formatCurrency(out)}</span> <span class="in">+${formatCurrency(inAmt)}</span>`
    : 'Nothing matches';

  container.querySelector('#txn-select-all').textContent = selected.size === rows.length && rows.length ? 'Clear' : `Select all ${rows.length || ''}`.trim();
  container.querySelector('#txn-select-all').hidden = rows.length === 0;

  container.querySelector('#txn-list').innerHTML = visible.map((t) => rowTemplate(t)).join('');

  const moreBtn = container.querySelector('#txn-more');
  moreBtn.hidden = rows.length <= visible.length;
  moreBtn.textContent = `Show ${Math.min(PAGE_SIZE, rows.length - visible.length)} more`;

  const bar = container.querySelector('#bulk-bar');
  bar.hidden = selected.size === 0;
  container.querySelector('#bulk-count').textContent = `${selected.size} selected`;
}

function catName(id) {
  return cache.categories.find((c) => c.id === id)?.name || null;
}

function rowTemplate(t) {
  const sign = t.direction === 'credit' ? '+' : '-';
  const isOpen = expanded === t.id;
  const split = isSplit(t);
  return `
    <div class="txn-row ${isOpen ? 'open' : ''} ${selected.has(t.id) ? 'selected' : ''}" data-id="${t.id}">
      <div class="txn-compact">
        <input type="checkbox" class="txn-check" ${selected.has(t.id) ? 'checked' : ''} aria-label="Select">
        <button type="button" class="txn-main">
          <span class="txn-desc">${escapeHtml(t.rawDescription)}</span>
          <span class="txn-meta">${shortDate(t.date)}${t.isTransfer ? ' · transfer' : ''}${split ? ' · split' : ''}</span>
        </button>
        <span class="txn-amount ${t.direction === 'credit' ? 'in' : 'out'}">${sign}${formatCurrency(t.amount)}</span>
      </div>
      ${
        split
          ? `<div class="txn-cat-split muted-note">${t.splits
              .map((s) => `${categoryStyle(catName(s.categoryId)).icon} ${escapeHtml(catName(s.categoryId) || 'Needs a category')} ${formatCurrency(s.amount)}`)
              .join(' · ')}</div>`
          : `<select class="txn-cat ${t.categoryId ? '' : 'needs-category'}" data-field="categoryId">
              <option value="">Needs a category</option>
              ${categoryOptions(t.categoryId)}
            </select>`
      }
      ${isOpen ? expandedTemplate(t) : ''}
    </div>
  `;
}

function expandedTemplate(t) {
  const accountLabel = cache.accounts.find((a) => a.id === t.accountId)?.label || 'Unknown';
  if (splitDraft && splitDraft.id === t.id) return splitTemplate(t);
  return `
    <div class="txn-expanded">
      <div class="txn-edit-row">
        <input type="date" class="rv-field" data-field="date" value="${t.date}">
        <span class="rv-account-label">${escapeHtml(accountLabel)}</span>
      </div>
      <input type="text" class="rv-field rv-desc" data-field="rawDescription" value="${escapeAttr(t.rawDescription)}">
      <div class="txn-edit-row">
        <div class="direction-toggle small">
          <button type="button" class="dir-btn rv-dir ${t.direction === 'debit' ? 'active' : ''}" data-dir="debit">Spent</button>
          <button type="button" class="dir-btn rv-dir ${t.direction === 'credit' ? 'active' : ''}" data-dir="credit">Received</button>
        </div>
        <input type="number" step="0.01" class="rv-field rv-amount-input" data-field="amount" value="${(t.amount / 100).toFixed(2)}">
      </div>
      <div class="txn-edit-row">
        <button type="button" class="icon-btn txn-split-btn">${isSplit(t) ? 'Edit split' : 'Split across categories'}</button>
        <button type="button" class="icon-btn review-transfer-toggle ${t.isTransfer ? 'active' : ''}">${t.isTransfer ? 'Not a transfer' : 'Mark as transfer'}</button>
        <button type="button" class="icon-btn danger txn-delete">Delete</button>
      </div>
    </div>
  `;
}

function splitTemplate(t) {
  const assigned = splitTotal(splitDraft.rows);
  const remainder = t.amount - assigned;
  return `
    <div class="txn-expanded">
      <span class="split-badge">Split ${formatCurrency(t.amount)}</span>
      <div class="split-list">
        ${splitDraft.rows
          .map(
            (row, i) => `
          <div class="split-row" data-index="${i}">
            <select class="split-cat">
              <option value="">Pick a category</option>
              ${categoryOptions(row.categoryId)}
            </select>
            <input type="number" step="0.01" class="split-amount" value="${row.amount ? (row.amount / 100).toFixed(2) : ''}" placeholder="0.00">
            <button type="button" class="icon-btn danger split-remove" aria-label="Remove">✕</button>
          </div>`
          )
          .join('')}
      </div>
      <div class="split-remainder ${remainder === 0 ? 'good' : 'bad'}">
        ${remainder === 0 ? 'Adds up exactly' : remainder > 0 ? `${formatCurrency(remainder)} still unassigned` : `${formatCurrency(-remainder)} over the transaction amount`}
      </div>
      <div class="txn-edit-row">
        <button type="button" class="btn-tiny split-add">Add a part</button>
        <button type="button" class="btn-tiny primary split-save" ${remainder === 0 ? '' : 'disabled'}>Save split</button>
        <button type="button" class="icon-btn split-cancel">Cancel</button>
        ${isSplit(t) ? '<button type="button" class="icon-btn danger split-clear">Remove split</button>' : ''}
      </div>
    </div>
  `;
}

async function handleChange(e, container) {
  const rowEl = e.target.closest('.txn-row');
  if (!rowEl) return;
  const t = cache.transactions.find((x) => x.id === rowEl.dataset.id);
  if (!t) return;

  if (e.target.classList.contains('txn-check')) {
    if (e.target.checked) selected.add(t.id);
    else selected.delete(t.id);
    rowEl.classList.toggle('selected', e.target.checked);
    const bar = container.querySelector('#bulk-bar');
    bar.hidden = selected.size === 0;
    container.querySelector('#bulk-count').textContent = `${selected.size} selected`;
    return;
  }

  // Split editor fields live only in the draft until saved.
  const splitRow = e.target.closest('.split-row');
  if (splitRow && splitDraft) {
    const i = Number(splitRow.dataset.index);
    if (e.target.classList.contains('split-cat')) splitDraft.rows[i].categoryId = e.target.value || null;
    if (e.target.classList.contains('split-amount')) {
      const parsed = parseFloat(e.target.value);
      splitDraft.rows[i].amount = Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
      updateRemainder(container, t);
    }
    return;
  }

  const field = e.target.dataset.field;
  if (!field) return;

  if (field === 'categoryId') {
    const categoryId = e.target.value || null;
    t.categoryId = categoryId;
    await put('transactions', t);
    if (categoryId) await learnFromAssignment(t.rawDescription, categoryId);
    e.target.classList.toggle('needs-category', !categoryId);
    if (filters.categoryId === 'uncategorized' && categoryId) {
      rowEl.remove();
      refreshCounts(container);
    }
    return;
  }

  if (field === 'amount') {
    const parsed = parseFloat(e.target.value);
    t.amount = Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
    const amountEl = rowEl.querySelector('.txn-amount');
    if (amountEl) amountEl.textContent = `${t.direction === 'credit' ? '+' : '-'}${formatCurrency(t.amount)}`;
  } else if (field === 'date') {
    if (!e.target.value) return;
    t.date = e.target.value;
    const metaEl = rowEl.querySelector('.txn-meta');
    if (metaEl) metaEl.textContent = shortDate(t.date);
  } else if (field === 'rawDescription') {
    t.rawDescription = e.target.value;
    const descEl = rowEl.querySelector('.txn-desc');
    if (descEl) descEl.textContent = t.rawDescription;
  }
  await put('transactions', t);
}

// Live feedback while typing split amounts, without re-rendering the row and
// stealing focus from the input being typed into.
function updateRemainder(container, t) {
  const el = container.querySelector('.split-remainder');
  if (!el) return;
  const remainder = t.amount - splitTotal(splitDraft.rows);
  el.classList.toggle('good', remainder === 0);
  el.classList.toggle('bad', remainder !== 0);
  el.textContent =
    remainder === 0
      ? 'Adds up exactly'
      : remainder > 0
        ? `${formatCurrency(remainder)} still unassigned`
        : `${formatCurrency(-remainder)} over the transaction amount`;
  const saveBtn = container.querySelector('.split-save');
  if (saveBtn) saveBtn.disabled = remainder !== 0;
}

async function handleClick(e, container) {
  const rowEl = e.target.closest('.txn-row');
  if (!rowEl) return;
  const t = cache.transactions.find((x) => x.id === rowEl.dataset.id);
  if (!t) return;

  if (e.target.closest('.txn-main')) {
    expanded = expanded === t.id ? null : t.id;
    splitDraft = null;
    renderList(container);
    return;
  }

  if (e.target.closest('.txn-split-btn')) {
    splitDraft = {
      id: t.id,
      rows: isSplit(t)
        ? t.splits.map((s) => ({ ...s }))
        : [
            { categoryId: t.categoryId || null, amount: t.amount },
            { categoryId: null, amount: 0 },
          ],
    };
    renderList(container);
    return;
  }

  if (e.target.closest('.split-add')) {
    splitDraft.rows.push({ categoryId: null, amount: 0 });
    renderList(container);
    return;
  }

  const removeBtn = e.target.closest('.split-remove');
  if (removeBtn) {
    const i = Number(removeBtn.closest('.split-row').dataset.index);
    splitDraft.rows.splice(i, 1);
    if (splitDraft.rows.length === 0) splitDraft.rows.push({ categoryId: null, amount: 0 });
    renderList(container);
    return;
  }

  if (e.target.closest('.split-cancel')) {
    splitDraft = null;
    renderList(container);
    return;
  }

  if (e.target.closest('.split-clear')) {
    delete t.splits;
    await put('transactions', t);
    splitDraft = null;
    renderList(container);
    return;
  }

  if (e.target.closest('.split-save')) {
    const rows = splitDraft.rows.filter((r) => r.amount > 0);
    if (splitTotal(rows) !== t.amount) return;
    t.splits = rows;
    // The top-level category becomes meaningless once split, and leaving a
    // stale one there would double-count in anything that misses the splits.
    t.categoryId = null;
    await put('transactions', t);
    for (const r of rows) {
      if (r.categoryId) await learnFromAssignment(t.rawDescription, r.categoryId);
    }
    splitDraft = null;
    renderList(container);
    return;
  }

  if (e.target.closest('.txn-delete')) {
    if (!confirm(`Delete "${t.rawDescription.slice(0, 60)}"? This can't be undone.`)) return;
    await remove('transactions', t.id);
    cache.transactions = cache.transactions.filter((x) => x.id !== t.id);
    selected.delete(t.id);
    expanded = null;
    renderList(container);
    return;
  }

  const transferBtn = e.target.closest('.review-transfer-toggle');
  if (transferBtn) {
    t.isTransfer = !t.isTransfer;
    // Remember that this was a human decision so auto-detection never
    // overrules it on a later import or app start.
    t.transferManual = true;
    await put('transactions', t);
    renderList(container);
    return;
  }

  const dirBtn = e.target.closest('.rv-dir');
  if (dirBtn) {
    t.direction = dirBtn.dataset.dir;
    await put('transactions', t);
    renderList(container);
  }
}

function refreshCounts(container) {
  const rows = matching();
  container.querySelector('#txn-count').innerHTML = rows.length ? `${rows.length} left to categorize` : 'All caught up';
}

function shortDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
