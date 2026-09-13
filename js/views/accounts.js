import { getAll, put } from '../db.js';
import { CURRENCY_SYMBOL } from '../config.js';

export async function render(container) {
  const [accounts, transactions, importBatches] = await Promise.all([getAll('accounts'), getAll('transactions'), getAll('importBatches')]);

  const groups = { cash: [], bank: [], card: [] };
  for (const a of accounts) (groups[a.type] || (groups[a.type] = [])).push(a);

  container.innerHTML = `
    <button type="button" id="go-import-btn" class="btn-secondary">+ Import statement</button>
    ${renderGroup('Cash', groups.cash, transactions, importBatches)}
    ${renderGroup('Bank', groups.bank, transactions, importBatches)}
    ${renderGroup('Credit Cards', groups.card, transactions, importBatches)}
  `;

  container.querySelector('#go-import-btn').addEventListener('click', () => {
    container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'import' } }));
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
    const batches = importBatches.filter((b) => b.accountId === account.id).sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
    const cycleStart = batches[0]?.periodEnd || null;
    const cycleSpend = acctTxns
      .filter((t) => t.direction === 'debit' && !t.isTransfer && (!cycleStart || t.date > cycleStart))
      .reduce((s, t) => s + t.amount, 0);

    return `
      <li class="cat-row">
        <div class="cat-row-main">
          <span class="cat-name">${escapeHtml(account.label)}</span>
          <span class="cat-actions"><button type="button" class="icon-btn account-rename" data-id="${account.id}">Rename</button></span>
        </div>
        <div class="account-projection">
          Projected next bill${cycleStart ? ` (since ${cycleStart})` : ''}: <strong class="out">${fmt(cycleSpend)}</strong>
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
        <span class="cat-actions"><button type="button" class="icon-btn account-rename" data-id="${account.id}">Rename</button></span>
      </div>
      <div class="account-projection">This month: <span class="in">+${fmt(inAmt)}</span> <span class="out">-${fmt(outAmt)}</span></div>
    </li>
  `;
}

function fmt(minorUnits) {
  return `${CURRENCY_SYMBOL}${(minorUnits / 100).toFixed(2)}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
