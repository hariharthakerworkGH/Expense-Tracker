import { getAll, put, remove } from '../db.js';
import { learnFromAssignment } from '../merchant-rules.js';
import { formatCurrency } from '../format.js';

let filter = 'needs-review'; // 'needs-review' | 'all'

export async function render(container) {
  const [transactions, categories, accounts] = await Promise.all([getAll('transactions'), getAll('categories'), getAll('accounts')]);
  renderList(container, transactions, categories, accounts);
}

function renderList(container, transactions, categories, accounts) {
  const filtered = (filter === 'needs-review' ? transactions.filter((t) => !t.categoryId) : transactions).sort((a, b) => (a.date < b.date ? 1 : -1));

  container.innerHTML = `
    <div class="segmented">
      <button type="button" class="seg-btn ${filter === 'needs-review' ? 'active' : ''}" data-filter="needs-review">Needs review</button>
      <button type="button" class="seg-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">All transactions</button>
    </div>
    <p class="import-intro" id="txn-count">${filtered.length} transaction${filtered.length === 1 ? '' : 's'}${filter === 'needs-review' ? ' need a category' : ''}.</p>
    <div id="txn-list" class="review-list">
      ${filtered.map((t) => rowTemplate(t, categories, accounts)).join('') || '<p class="empty">Nothing here.</p>'}
    </div>
  `;

  container.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      renderList(container, transactions, categories, accounts);
    });
  });

  const listEl = container.querySelector('#txn-list');
  listEl.addEventListener('input', (e) => handleFieldChange(e, transactions));
  listEl.addEventListener('change', (e) => handleFieldChange(e, transactions));
  listEl.addEventListener('click', (e) => handleClick(e, container, transactions));
}

async function handleFieldChange(e, transactions) {
  const field = e.target.dataset.field;
  if (!field) return;
  const rowEl = e.target.closest('.review-row');
  const id = rowEl.dataset.id;
  const t = transactions.find((x) => x.id === id);

  if (field === 'amount') {
    t.amount = Math.round(parseFloat(e.target.value || '0') * 100);
    const amountEl = rowEl.querySelector('.rv-amount-display');
    if (amountEl) amountEl.textContent = `${t.direction === 'credit' ? '+' : '-'}${formatCurrency(t.amount)}`;
  } else if (field === 'date') {
    t.date = e.target.value;
  } else if (field === 'rawDescription') {
    t.rawDescription = e.target.value;
  }
  await put('transactions', t);
}

async function handleClick(e, container, transactions) {
  const rowEl = e.target.closest('.review-row');
  if (!rowEl) return;
  const id = rowEl.dataset.id;
  const t = transactions.find((x) => x.id === id);

  const chip = e.target.closest('.chip');
  if (chip) {
    const categoryId = chip.dataset.cat || null;
    t.categoryId = categoryId;
    await put('transactions', t);
    if (categoryId) await learnFromAssignment(t.rawDescription, categoryId);
    rowEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    if (filter === 'needs-review' && categoryId) {
      rowEl.remove();
      updateCount(container);
    }
    return;
  }

  const deleteBtn = e.target.closest('.rv-delete');
  if (deleteBtn) {
    if (confirm('Delete this transaction? This can\'t be undone.')) {
      await remove('transactions', id);
      rowEl.remove();
      updateCount(container);
    }
    return;
  }

  const transferBtn = e.target.closest('.review-transfer-toggle');
  if (transferBtn) {
    t.isTransfer = !t.isTransfer;
    await put('transactions', t);
    transferBtn.textContent = t.isTransfer ? 'Unmark transfer' : 'Mark as transfer';
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
        <button type="button" class="icon-btn rv-delete" title="Delete transaction">✕</button>
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
      <div class="chip-row">
        <button type="button" class="chip ${!t.categoryId ? 'active' : ''}" data-cat="">Uncategorized</button>
        ${categories.map((c) => `<button type="button" class="chip ${c.id === t.categoryId ? 'active' : ''}" data-cat="${c.id}">${escapeHtml(c.name)}</button>`).join('')}
      </div>
      <button type="button" class="icon-btn review-transfer-toggle ${t.isTransfer ? 'active' : ''}">${t.isTransfer ? 'Unmark transfer' : 'Mark as transfer'}</button>
    </div>
  `;
}

function updateCount(container) {
  const remaining = container.querySelectorAll('.review-row').length;
  const suffix = filter === 'needs-review' ? ' need a category' : '';
  container.querySelector('#txn-count').textContent = `${remaining} transaction${remaining === 1 ? '' : 's'}${suffix}.`;
  if (remaining === 0) {
    container.querySelector('#txn-list').innerHTML = '<p class="empty">Nothing here.</p>';
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
