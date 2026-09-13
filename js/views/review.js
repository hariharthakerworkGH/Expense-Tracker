import { getAll, put } from '../db.js';
import { learnFromAssignment } from '../merchant-rules.js';
import { CURRENCY_SYMBOL } from '../config.js';

export async function render(container) {
  const [transactions, categories, accounts] = await Promise.all([getAll('transactions'), getAll('categories'), getAll('accounts')]);
  const uncategorized = transactions.filter((t) => !t.categoryId).sort((a, b) => (a.date < b.date ? 1 : -1));
  const acctName = (id) => accounts.find((a) => a.id === id)?.label || 'Unknown';

  container.innerHTML = `
    <p class="import-intro" id="review-count">${uncategorized.length} uncategorized transaction${uncategorized.length === 1 ? '' : 's'}.</p>
    <div id="review-list" class="review-list">
      ${uncategorized.map((t) => rowTemplate(t, categories, acctName(t.accountId))).join('') || '<p class="empty">Nothing to review.</p>'}
    </div>
  `;

  const listEl = container.querySelector('#review-list');
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
    }
  });
}

function rowTemplate(t, categories, accountLabel) {
  const sign = t.direction === 'credit' ? '+' : '-';
  const amountClass = t.direction === 'credit' ? 'in' : 'out';
  return `
    <div class="review-row" data-id="${t.id}">
      <div class="review-row-top">
        <span class="review-date">${t.date}</span>
        <span class="review-account">${escapeHtml(accountLabel)}</span>
        <span class="${amountClass}">${sign}${CURRENCY_SYMBOL}${(t.amount / 100).toFixed(2)}</span>
      </div>
      <div class="review-desc">${escapeHtml(t.rawDescription)}</div>
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
