import { getAll, put, newId } from '../db.js';
import { formatCurrency } from '../format.js';
import { currentCycleStart } from '../billing-cycle.js';

export async function render(container) {
  const [accounts, transactions, importBatches] = await Promise.all([getAll('accounts'), getAll('transactions'), getAll('importBatches')]);

  const groups = { cash: [], bank: [], card: [] };
  for (const a of accounts) (groups[a.type] || (groups[a.type] = [])).push(a);

  container.innerHTML = `
    <div class="accounts-actions">
      <button type="button" id="go-import-btn" class="btn-secondary">Import a statement</button>
      <button type="button" id="add-account-btn" class="btn-secondary">Add an account</button>
    </div>
    ${renderGroup('Cash', groups.cash, transactions, importBatches)}
    ${renderGroup('Bank accounts', groups.bank, transactions, importBatches)}
    ${renderGroup('Credit cards', groups.card, transactions, importBatches)}
  `;

  container.querySelector('#go-import-btn').addEventListener('click', () => {
    container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'import' } }));
  });

  container.querySelector('#add-account-btn').addEventListener('click', async () => {
    const label = prompt('Account name (e.g. "HDFC Debit Card" or "Amex Card")');
    if (!label || !label.trim()) return;
    const typeInput = (prompt('Type "bank" or "card"', 'card') || '').trim().toLowerCase();
    const type = typeInput === 'bank' ? 'bank' : 'card';
    const issuer = (prompt('Bank/issuer name (optional - helps match future statement imports)') || '').trim() || null;
    const last4 = (prompt('Last 4 digits (optional - helps match future statement imports)') || '').trim() || null;
    let billingCycleDay = null;
    if (type === 'card') {
      const day = parseInt(prompt("What day of the month does this card's statement close? (e.g. 25)") || '', 10);
      if (day >= 1 && day <= 31) billingCycleDay = day;
    }
    await put('accounts', { id: newId(), label: label.trim(), type, issuer, last4, billingCycleDay: billingCycleDay || null });
    render(container);
  });

  container.querySelectorAll('.account-rename').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const account = accounts.find((a) => a.id === btn.dataset.id);
      const name = prompt('Rename account', account.label);
      if (name && name.trim()) {
        account.label = name.trim();
        await put('accounts', account);
        render(container);
      }
    });
  });

  container.querySelectorAll('.account-cycle-edit').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const account = accounts.find((a) => a.id === btn.dataset.id);
      const day = parseInt(prompt("What day of the month does this card's statement close? (e.g. 25)", account.billingCycleDay || '') || '', 10);
      if (day >= 1 && day <= 31) {
        account.billingCycleDay = day;
        await put('accounts', account);
        render(container);
      }
    });
  });

  container.querySelectorAll('.account-add-expense').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'add', accountId: btn.dataset.id } }));
    });
  });
}

function renderGroup(title, accounts, transactions, importBatches) {
  if (!accounts || accounts.length === 0) return '';
  return `
    <h3>${title}</h3>
    <ul class="cat-list">
      ${accounts.map((a) => accountRow(a, transactions, importBatches)).join('')}
    </ul>
  `;
}

function accountRow(account, transactions, importBatches) {
  const acctTxns = transactions.filter((t) => t.accountId === account.id);

  if (account.type === 'card') {
    const cycleStart = currentCycleStart(account, importBatches);
    const cycleSpend = acctTxns
      .filter((t) => t.direction === 'debit' && !t.isTransfer && (!cycleStart || t.date > cycleStart))
      .reduce((s, t) => s + t.amount, 0);

    return `
      <li class="cat-row">
        <div class="cat-row-main">
          <span class="cat-name">${escapeHtml(account.label)}</span>
          <span class="cat-actions">
            <button type="button" class="icon-btn account-rename" data-id="${account.id}">Rename</button>
          </span>
        </div>
        <div class="account-projection">
          Current cycle spend<span class="muted">${cycleStart ? ` since ${cycleStart}` : ''}</span>: <strong class="out">${formatCurrency(cycleSpend)}</strong>
        </div>
        <div class="account-subrow">
          <button type="button" class="icon-btn account-cycle-edit" data-id="${account.id}">
            ${account.billingCycleDay ? `Bill closes day ${account.billingCycleDay}` : 'Set billing cycle day'}
          </button>
          <button type="button" class="btn-tiny account-add-expense" data-id="${account.id}">+ Log a spend</button>
        </div>
      </li>
    `;
  }

  if (account.type === 'bank') {
    const balance = bankBalance(account, acctTxns);
    return `
      <li class="cat-row">
        <div class="cat-row-main">
          <span class="cat-name">${escapeHtml(account.label)}</span>
          <span class="cat-actions"><button type="button" class="icon-btn account-rename" data-id="${account.id}">Rename</button></span>
        </div>
        <div class="account-projection">
          ${balance != null ? `Balance: <strong>${formatCurrency(balance)}</strong>` : 'Balance unknown - import a statement to see it'}
        </div>
      </li>
    `;
  }

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const thisMonth = acctTxns.filter((t) => t.date >= monthStart && !t.isTransfer);
  const inAmt = thisMonth.filter((t) => t.direction === 'credit').reduce((s, t) => s + t.amount, 0);
  const outAmt = thisMonth.filter((t) => t.direction === 'debit').reduce((s, t) => s + t.amount, 0);

  return `
    <li class="cat-row">
      <div class="cat-row-main">
        <span class="cat-name">${escapeHtml(account.label)}</span>
        <span class="cat-actions">
          <button type="button" class="icon-btn account-rename" data-id="${account.id}">Rename</button>
        </span>
      </div>
      <div class="account-projection">This month: <span class="in">+${formatCurrency(inAmt)}</span> <span class="out">-${formatCurrency(outAmt)}</span></div>
      <div class="account-subrow">
        <button type="button" class="btn-tiny account-add-expense" data-id="${account.id}">+ Log a spend</button>
      </div>
    </li>
  `;
}

function bankBalance(account, acctTxns) {
  if (account.knownBalance == null || !account.knownBalanceDate) return null;
  let balance = account.knownBalance;
  for (const t of acctTxns) {
    if (t.date <= account.knownBalanceDate) continue;
    balance += t.direction === 'credit' ? t.amount : -t.amount;
  }
  return balance;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
