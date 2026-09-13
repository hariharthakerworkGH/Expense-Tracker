import { getAll, put, newId } from '../db.js';
import { formatCurrency, formatDateNice, ordinal } from '../format.js';
import { bankBalance, cardCycleSpend } from '../account-metrics.js';

export async function render(container) {
  const [accounts, transactions, importBatches] = await Promise.all([getAll('accounts'), getAll('transactions'), getAll('importBatches')]);

  const groups = { cash: [], bank: [], card: [] };
  for (const a of accounts) (groups[a.type] || (groups[a.type] = [])).push(a);

  container.innerHTML = `
    <p class="import-intro">Where your money lives: your bank balance, what you owe on each card, and cash on hand. Log spends here, or import a statement to bring in everything at once.</p>
    <div class="accounts-actions">
      <button type="button" id="go-import-btn" class="btn-secondary">Import a statement</button>
      <button type="button" id="add-account-btn" class="btn-secondary">Add an account</button>
    </div>
    ${renderGroup('Cash', 'Whatever you spend that never touches a bank or card.', groups.cash, transactions, importBatches)}
    ${renderGroup('Bank accounts', 'Balance as of your last imported statement, adjusted for anything since.', groups.bank, transactions, importBatches)}
    ${renderGroup('Credit cards', "What you'd owe if your bill closed today.", groups.card, transactions, importBatches)}
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

function renderGroup(title, subtitle, accounts, transactions, importBatches) {
  if (!accounts || accounts.length === 0) return '';
  return `
    <h3>${title}</h3>
    <p class="group-subtitle">${subtitle}</p>
    ${accounts.map((a) => accountCard(a, transactions, importBatches)).join('')}
  `;
}

function accountCard(account, transactions, importBatches) {
  const acctTxns = transactions.filter((t) => t.accountId === account.id);

  if (account.type === 'card') {
    const { cycleStart, spend: cycleSpend } = cardCycleSpend(account, transactions, importBatches);

    return `
      <div class="totals-card account-card">
        <div class="account-card-head">
          <span class="cat-name">${escapeHtml(account.label)}</span>
          <button type="button" class="icon-btn account-rename" data-id="${account.id}">Rename</button>
        </div>
        <div class="account-headline out">${formatCurrency(cycleSpend)}</div>
        <div class="muted-note">${cycleStart ? `spent since your last statement (${formatDateNice(cycleStart)})` : 'spent so far - no billing cycle set yet'}</div>
        <div class="account-subrow">
          <button type="button" class="btn-tiny account-cycle-edit" data-id="${account.id}">
            ${account.billingCycleDay ? `Statement day: ${ordinal(account.billingCycleDay)} · Edit` : 'Set statement day'}
          </button>
          <button type="button" class="btn-tiny account-add-expense" data-id="${account.id}">+ Log a spend</button>
        </div>
      </div>
    `;
  }

  if (account.type === 'bank') {
    const balance = bankBalance(account, acctTxns);
    return `
      <div class="totals-card account-card">
        <div class="account-card-head">
          <span class="cat-name">${escapeHtml(account.label)}</span>
          <button type="button" class="icon-btn account-rename" data-id="${account.id}">Rename</button>
        </div>
        ${
          balance != null
            ? `<div class="account-headline">${formatCurrency(balance)}</div><div class="muted-note">as of ${formatDateNice(account.knownBalanceDate)}, adjusted for anything since</div>`
            : `<p class="muted-note">Balance unknown - import a statement to see it.</p>`
        }
      </div>
    `;
  }

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const thisMonth = acctTxns.filter((t) => t.date >= monthStart && !t.isTransfer);
  const inAmt = thisMonth.filter((t) => t.direction === 'credit').reduce((s, t) => s + t.amount, 0);
  const outAmt = thisMonth.filter((t) => t.direction === 'debit').reduce((s, t) => s + t.amount, 0);

  return `
    <div class="totals-card account-card">
      <div class="account-card-head">
        <span class="cat-name">${escapeHtml(account.label)}</span>
        <button type="button" class="icon-btn account-rename" data-id="${account.id}">Rename</button>
      </div>
      <div class="account-headline out">${formatCurrency(outAmt)}</div>
      <div class="muted-note">spent this month <span class="in">(+${formatCurrency(inAmt)} received)</span></div>
      <div class="account-subrow">
        <button type="button" class="btn-tiny account-add-expense" data-id="${account.id}">+ Log a spend</button>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
