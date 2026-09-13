import { put, getAll, newId } from '../db.js';
import { CASH_ACCOUNT_ID } from '../config.js';

export async function render(container, params = {}) {
  const [categories, accounts] = await Promise.all([getAll('categories'), getAll('accounts')]);
  const today = new Date().toISOString().slice(0, 10);
  const initialAccountId = params.accountId && accounts.some((a) => a.id === params.accountId) ? params.accountId : CASH_ACCOUNT_ID;

  container.innerHTML = `
    <form id="add-form" class="add-form">
      <label class="field">
        <span>Amount</span>
        <input id="add-amount" type="number" inputmode="decimal" step="0.01" min="0.01" placeholder="0.00" required>
      </label>
      <div class="direction-toggle">
        <button type="button" class="dir-btn active" data-dir="debit">Spent</button>
        <button type="button" class="dir-btn" data-dir="credit">Received</button>
      </div>
      <label class="field">
        <span>What</span>
        <input id="add-desc" type="text" placeholder="e.g. coffee" required>
      </label>
      <div class="chip-row" id="add-categories">
        <button type="button" class="chip active" data-cat="">Uncategorized</button>
        ${categories.map((c) => `<button type="button" class="chip" data-cat="${c.id}">${escapeHtml(c.name)}</button>`).join('')}
      </div>
      <label class="field">
        <span>Account</span>
        <select id="add-account">
          ${accounts.map((a) => `<option value="${a.id}" ${a.id === initialAccountId ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('')}
        </select>
      </label>
      <label class="field field-date">
        <span>Date</span>
        <input id="add-date" type="date" value="${today}">
      </label>
      <button type="submit" class="btn-primary">Save</button>
      <p id="add-status" class="status" hidden></p>
    </form>
  `;

  let direction = 'debit';
  let categoryId = null;

  container.querySelectorAll('.dir-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      direction = btn.dataset.dir;
      container.querySelectorAll('.dir-btn').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  container.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      categoryId = chip.dataset.cat || null;
      container.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    });
  });

  const amountInput = container.querySelector('#add-amount');
  const dateInput = container.querySelector('#add-date');
  const accountSelect = container.querySelector('#add-account');
  const form = container.querySelector('#add-form');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Math.round(parseFloat(amountInput.value) * 100);
    if (!Number.isFinite(amount) || amount <= 0) return;

    const transaction = {
      id: newId(),
      accountId: accountSelect.value,
      date: dateInput.value || today,
      rawDescription: container.querySelector('#add-desc').value.trim(),
      amount,
      direction,
      categoryId,
      source: 'manual',
      importBatchId: null,
      isTransfer: false,
      notes: null,
    };
    await put('transactions', transaction);

    const status = container.querySelector('#add-status');
    status.hidden = false;
    status.textContent = 'Saved.';

    form.reset();
    direction = 'debit';
    categoryId = null;
    container.querySelectorAll('.dir-btn').forEach((b) => b.classList.toggle('active', b.dataset.dir === 'debit'));
    container.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', !c.dataset.cat));
    dateInput.value = today;
    accountSelect.value = initialAccountId;
    amountInput.focus();
    setTimeout(() => {
      status.hidden = true;
    }, 1500);
  });

  amountInput.focus();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
