import { getAll, put, remove, newId } from '../db.js';
import { formatCurrency, formatDateNice, ordinal } from '../format.js';
import { bankBalance, cardCycleSpend, cardBillDue, cardPosition } from '../account-metrics.js';
import { isoLocal } from '../frequency.js';

// null = form closed, 'new' = adding, otherwise the id being edited
let editing = null;

export async function render(container) {
  const [accounts, transactions, importBatches] = await Promise.all([getAll('accounts'), getAll('transactions'), getAll('importBatches')]);

  const groups = { cash: [], bank: [], card: [] };
  for (const a of accounts) (groups[a.type] || (groups[a.type] = [])).push(a);

  const editingAccount = editing && editing !== 'new' ? accounts.find((a) => a.id === editing) : null;

  container.innerHTML = `
    <p class="import-intro">Where your money lives: your bank balance, what you owe on each card, and cash on hand. Log spends here, or import a statement to bring in everything at once.</p>
    <div class="accounts-actions">
      <button type="button" id="go-import-btn" class="btn-secondary">Import a statement</button>
      <button type="button" id="add-account-btn" class="btn-secondary">${editing === 'new' ? 'Cancel' : 'Add an account'}</button>
    </div>
    ${editing === 'new' ? accountForm(null, transactions) : ''}
    ${renderGroup('Cash', 'Whatever you spend that never touches a bank or card.', groups.cash, transactions, importBatches, editingAccount)}
    ${renderGroup('Bank accounts', 'Balance as of your last imported statement, adjusted for anything since.', groups.bank, transactions, importBatches, editingAccount)}
    ${renderGroup('Credit cards', "What your last statement says you owe, and what you've spent since.", groups.card, transactions, importBatches, editingAccount)}
  `;

  container.querySelector('#go-import-btn').addEventListener('click', () => {
    container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'import' } }));
  });

  container.querySelector('#add-account-btn').addEventListener('click', () => {
    editing = editing === 'new' ? null : 'new';
    render(container);
  });

  container.querySelectorAll('.account-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      editing = editing === btn.dataset.id ? null : btn.dataset.id;
      render(container);
    });
  });

  container.querySelectorAll('.account-form').forEach((form) => wireForm(form, container, accounts, transactions));

  container.querySelectorAll('.bill-toggle-paid').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const account = accounts.find((a) => a.id === btn.dataset.id);
      account.statementDuePaid = !account.statementDuePaid;
      await put('accounts', account);
      render(container);
    });
  });

  container.querySelectorAll('.account-add-expense').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'add', accountId: btn.dataset.id } }));
    });
  });
}

function accountForm(account, transactions) {
  const a = account || { label: '', type: 'card', issuer: '', last4: '', billingCycleDay: '' };
  const txnCount = account ? transactions.filter((t) => t.accountId === account.id).length : 0;
  return `
    <form class="totals-card account-form" data-id="${account ? account.id : ''}">
      <label class="field">
        <span>Name</span>
        <input type="text" class="af-label" value="${escapeAttr(a.label)}" placeholder="e.g. HDFC Swiggy Card" required>
      </label>
      <div class="field">
        <span>Type</span>
        <div class="segmented af-type-group">
          ${['bank', 'card', 'cash']
            .map(
              (t) =>
                `<button type="button" class="seg-btn af-type ${a.type === t ? 'active' : ''}" data-type="${t}">${t === 'bank' ? 'Bank' : t === 'card' ? 'Credit card' : 'Cash'}</button>`
            )
            .join('')}
        </div>
      </div>
      <label class="field">
        <span>Bank / issuer <span class="muted">(optional)</span></span>
        <input type="text" class="af-issuer" value="${escapeAttr(a.issuer || '')}" placeholder="e.g. HDFC Bank">
      </label>
      <label class="field">
        <span>Last 4 digits <span class="muted">(optional)</span></span>
        <input type="text" class="af-last4" value="${escapeAttr(a.last4 || '')}" inputmode="numeric" maxlength="4" placeholder="6671">
      </label>
      <p class="muted-note">Issuer and last 4 let the app recognise this account automatically when you import its statement.</p>
      <label class="field af-cycle-field" ${a.type === 'card' ? '' : 'hidden'}>
        <span>Statement closes on day of month</span>
        <input type="number" class="af-cycle" min="1" max="31" value="${a.billingCycleDay || ''}" placeholder="25">
      </label>
      <button type="submit" class="btn-primary">${account ? 'Save changes' : 'Add account'}</button>
      <p class="af-error status" hidden></p>
      ${
        account
          ? `<button type="button" class="btn-tiny danger account-delete" data-id="${account.id}">Delete this account${txnCount ? ` and its ${txnCount} transaction${txnCount === 1 ? '' : 's'}` : ''}</button>`
          : ''
      }
    </form>
  `;
}

function wireForm(form, container, accounts, transactions) {
  const cycleField = form.querySelector('.af-cycle-field');
  let type = form.querySelector('.af-type.active')?.dataset.type || 'card';

  form.querySelectorAll('.af-type').forEach((btn) => {
    btn.addEventListener('click', () => {
      type = btn.dataset.type;
      form.querySelectorAll('.af-type').forEach((b) => b.classList.toggle('active', b === btn));
      cycleField.hidden = type !== 'card';
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = form.querySelector('.af-error');
    const label = form.querySelector('.af-label').value.trim();
    if (!label) {
      errorEl.hidden = false;
      errorEl.textContent = 'Give the account a name.';
      errorEl.classList.add('out');
      return;
    }

    const last4 = form.querySelector('.af-last4').value.trim();
    if (last4 && !/^\d{4}$/.test(last4)) {
      errorEl.hidden = false;
      errorEl.textContent = 'Last 4 digits should be exactly four numbers, or left blank.';
      errorEl.classList.add('out');
      return;
    }

    const cycleRaw = form.querySelector('.af-cycle').value.trim();
    const cycleDay = cycleRaw ? Number(cycleRaw) : null;
    if (type === 'card' && cycleDay !== null && (!Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 31)) {
      errorEl.hidden = false;
      errorEl.textContent = 'Statement day should be a number between 1 and 31.';
      errorEl.classList.add('out');
      return;
    }

    const id = form.dataset.id;
    const existing = id ? accounts.find((a) => a.id === id) : null;
    const account = {
      ...(existing || {}),
      id: existing ? existing.id : newId(),
      label,
      type,
      issuer: form.querySelector('.af-issuer').value.trim() || null,
      last4: last4 || null,
      billingCycleDay: type === 'card' ? cycleDay : null,
    };
    await put('accounts', account);
    editing = null;
    render(container);
  });

  const deleteBtn = form.querySelector('.account-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const id = deleteBtn.dataset.id;
      const affected = transactions.filter((t) => t.accountId === id);
      const ok = confirm(
        `Delete this account?\n\n${affected.length} transaction${affected.length === 1 ? '' : 's'} on it will be deleted too. This cannot be undone - take a backup first if you're unsure.`
      );
      if (!ok) return;

      for (const t of affected) await remove('transactions', t.id);
      const batches = await getAll('importBatches');
      for (const b of batches.filter((b) => b.accountId === id)) await remove('importBatches', b.id);
      await remove('accounts', id);
      editing = null;
      render(container);
    });
  }
}

function renderGroup(title, subtitle, accounts, transactions, importBatches, editingAccount) {
  if (!accounts || accounts.length === 0) return '';
  return `
    <h3>${title}</h3>
    <p class="group-subtitle">${subtitle}</p>
    ${accounts.map((a) => (editingAccount && editingAccount.id === a.id ? accountForm(a, transactions) : accountCard(a, transactions, importBatches))).join('')}
  `;
}

function accountCard(account, transactions, importBatches) {
  const acctTxns = transactions.filter((t) => t.accountId === account.id);

  if (account.type === 'card') {
    // Same figure as the Summary: spends this cycle less refunds and cashback.
    const position = account.billingCycleDay ? cardPosition(account, transactions, importBatches, isoLocal(new Date())) : null;
    const { cycleStart, spend: fallbackSpend } = cardCycleSpend(account, transactions, importBatches);
    const cycleSpend = position ? position.owed : fallbackSpend;
    const since = position ? position.lastClose : cycleStart;
    const bill = cardBillDue(account);

    return `
      <div class="totals-card account-card">
        <div class="account-card-head">
          <span class="cat-name">${escapeHtml(account.label)}</span>
          <button type="button" class="icon-btn account-edit" data-id="${account.id}">Edit</button>
        </div>
        ${renderBill(bill, account)}
        <div class="account-secondary">
          <span class="out">${formatCurrency(cycleSpend)}</span> spent since${since ? ` ${formatDateNice(since)}` : ''}${
            position && position.refunds ? ` (after ${formatCurrency(position.refunds)} refunds and cashback)` : ''
          } — goes on your next bill${position && position.billedNotImported ? `<br>${formatCurrency(position.billedNotImported)} billed on ${formatDateNice(position.lastClose)}, statement not imported yet` : ''}
        </div>
        <div class="account-subrow">
          <span class="muted-note">${account.billingCycleDay ? `Statement day: ${ordinal(account.billingCycleDay)}` : 'No statement day set'}</span>
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
          <button type="button" class="icon-btn account-edit" data-id="${account.id}">Edit</button>
        </div>
        ${
          balance != null
            ? `<div class="account-headline">${formatCurrency(balance)}</div><div class="muted-note">as of ${formatDateNice(account.knownBalanceDate)}, adjusted for anything since</div>`
            : `<p class="muted-note">Balance unknown - import a statement to see it.</p>`
        }
        <div class="account-subrow">
          <button type="button" class="btn-tiny account-add-expense" data-id="${account.id}">+ Log a spend</button>
        </div>
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
        <button type="button" class="icon-btn account-edit" data-id="${account.id}">Edit</button>
      </div>
      <div class="account-headline out">${formatCurrency(outAmt)}</div>
      <div class="muted-note">spent this month <span class="in">(+${formatCurrency(inAmt)} received)</span></div>
      <div class="account-subrow">
        <button type="button" class="btn-tiny account-add-expense" data-id="${account.id}">+ Log a spend</button>
      </div>
    </div>
  `;
}

function renderBill(bill, account) {
  if (!bill) {
    return `<p class="muted-note">No statement imported yet - import one to see what's due.</p>`;
  }
  if (bill.paid) {
    return `
      <div class="account-headline in">${formatCurrency(bill.amount)} <span class="bill-tag">paid</span></div>
      <div class="muted-note">bill from ${formatDateNice(account.statementPeriodEnd)}</div>
      <button type="button" class="btn-tiny bill-toggle-paid" data-id="${account.id}">Mark unpaid</button>
    `;
  }
  const urgency = bill.daysLeft == null ? '' : bill.daysLeft < 0 ? 'overdue' : bill.daysLeft <= 3 ? 'urgent' : '';
  const when =
    bill.daysLeft == null
      ? `due ${bill.dueDate ? formatDateNice(bill.dueDate) : 'date unknown'}`
      : bill.daysLeft < 0
        ? `overdue by ${Math.abs(bill.daysLeft)} day${Math.abs(bill.daysLeft) === 1 ? '' : 's'}`
        : bill.daysLeft === 0
          ? 'due today'
          : `due in ${bill.daysLeft} day${bill.daysLeft === 1 ? '' : 's'} (${formatDateNice(bill.dueDate)})`;
  return `
    <div class="account-headline out">${formatCurrency(bill.amount)}</div>
    <div class="muted-note ${urgency ? 'bill-' + urgency : ''}">${when}${bill.minimum != null ? ` · minimum ${formatCurrency(bill.minimum)}` : ''}</div>
    <button type="button" class="btn-tiny bill-toggle-paid" data-id="${account.id}">Mark as paid</button>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
