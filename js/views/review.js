import { getAll, put } from '../db.js';
import { learnFromAssignment } from '../merchant-rules.js';
import { formatCurrency } from '../format.js';

export async function render(container) {
  const [transactions, categories, accounts] = await Promise.all([getAll('transactions'), getAll('categories'), getAll('accounts')]);
  const uncategorized = transactions.filter((t) => !t.categoryId).sort((a, b) => (a.date < b.date ? 1 : -1));

  container.innerHTML = `
    <p class="import-intro" id="review-count">${uncategorized.length} uncategorized transaction${uncategorized.length === 1 ? '' : 's'}.</p>
    <div id="review-list" class="review-list">
      ${uncategorized.map((t) => rowTemplate(t, categories, accounts)).join('') || '<p class="empty">Nothing to review.</p>'}
    </div>
  `;

  const listEl = container.querySelector('#review-list');

  listEl.addEventListener('input', (e) => handleFieldChange(e, transactions));
  listEl.addEventListener('change', (e) => handleFieldChange(e, transactions));

  listEl.addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      const rowEl = chip.closest('.review-row');
      const id = rowEl.dataset.id;
      const categoryId = chip.dataset.cat;
      const t = transactions.find((x) => x.id === id);
      t.categoryId = categoryId;
      await put('transactions', t);
      await learnFromAssignment(t.rawDescription, categoryId);
      rowEl.remove();
      updateCount(container);
      return;
    }

    const transferBtn = e.target.closest('.review-transfer-toggle');
    if (transferBtn) {
      const rowEl = transferBtn.closest('.review-row');
      const id = rowEl.dataset.id;
      const t = transactions.find((x) => x.id === id);
      t.isTransfer = !t.isTransfer;
      await put('transactions', t);
      transferBtn.textContent = t.isTransfer ? 'Unmark transfer' : 'Mark as transfer';
      transferBtn.classList.toggle('active', t.isTransfer);
      return;
    }

    const dirBtn = e.target.closest('.rv-dir');
    if (dirBtn) {
      const rowEl = dirBtn.closest('.review-row');
      const id = rowEl.dataset.id;
      const t = transactions.find((x) => x.id === id);
      t.direction = dirBtn.dataset.dir;
      await put('transactions', t);
      rowEl.querySelectorAll('.rv-dir').forEach((b) => b.classList.toggle('active', b === dirBtn));
      const amountEl = rowEl.querySelector('.rv-amount-display');
      if (amountEl) {
        amountEl.textContent = `${t.direction === 'credit' ? '+' : '-'}${formatCurrency(t.amount)}`;
        amountEl.className = `rv-amount-display ${t.direction === 'credit' ? 'in' : 'out'}`;
      }
    }
  });
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

function rowTemplate(t, categories, accounts) {
  const sign = t.direction === 'credit' ? '+' : '-';
  const amountClass = t.direction === 'credit' ? 'in' : 'out';
  return `
    <div class="review-row" data-id="${t.id}">
      <div class="review-row-top">
        <input type="date" class="rv-field rv-date" data-field="date" value="${t.date}">
        <select class="rv-field rv-account" data-field="accountId" disabled title="Account can't be changed here yet">
          ${accounts.map((a) => `<option value="${a.id}" ${a.id === t.accountId ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('')}
        </select>
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
        ${categories.map((c) => `<button type="button" class="chip" data-cat="${c.id}">${escapeHtml(c.name)}</button>`).join('')}
      </div>
      <button type="button" class="icon-btn review-transfer-toggle ${t.isTransfer ? 'active' : ''}">${t.isTransfer ? 'Unmark transfer' : 'Mark as transfer'}</button>
    </div>
  `;
}

function updateCount(container) {
  const remaining = container.querySelectorAll('.review-row').length;
  container.querySelector('#review-count').textContent = `${remaining} uncategorized transaction${remaining === 1 ? '' : 's'}.`;
  if (remaining === 0) {
    container.querySelector('#review-list').innerHTML = '<p class="empty">Nothing to review.</p>';
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
