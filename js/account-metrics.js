import { currentCycleStart } from './billing-cycle.js';

// A bank account's balance is a snapshot (from the last imported statement)
// adjusted forward by anything dated after it - transfers included, since
// they're real money movement even though they're excluded from spend totals.
export function bankBalance(account, transactions) {
  if (account.knownBalance == null || !account.knownBalanceDate) return null;
  let balance = account.knownBalance;
  for (const t of transactions) {
    if (t.accountId !== account.id) continue;
    if (t.date <= account.knownBalanceDate) continue;
    balance += t.direction === 'credit' ? t.amount : -t.amount;
  }
  return balance;
}

// What the last imported statement says is owed, and whether it's still
// outstanding. Returns null when no statement has been imported for the card
// yet - which is different from owing nothing.
export function cardBillDue(account) {
  if (account.type !== 'card' || account.statementDue == null) return null;
  return {
    amount: account.statementDue,
    minimum: account.statementMinDue ?? null,
    dueDate: account.statementDueDate ?? null,
    paid: account.statementDuePaid === true,
    daysLeft: account.statementDueDate ? daysUntil(account.statementDueDate) : null,
  };
}

function daysUntil(isoDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(isoDate);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

// The date a current-transactions list stands for. A list is a snapshot of
// the day it was taken, not of its newest row: a list holding only a refund
// dated before the cycle closed still belongs to the cycle it was taken in.
export function listTakenOn(batch) {
  const taken = batch.takenOn || (batch.importedAt ? localDate(new Date(batch.importedAt)) : null);
  if (!taken) return batch.periodEnd || null;
  return batch.periodEnd && batch.periodEnd > taken ? batch.periodEnd : taken;
}

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Everything on a card that the imported statements haven't settled, as
// money: spends minus refunds and cashback since the last imported statement
// closed. Bill payments are transfers and don't count here. Unlike
// cardCycleSpend (a spending figure, where a refund shouldn't buy headroom),
// a ₹333 refund really does make what you owe ₹333 smaller.
//
// It runs from the last imported statement, not from today's cycle boundary.
// From the statement day until that statement is imported, the closed
// cycle's spends are still owed - they just haven't been billed in the app yet.
//
// A row from a current-transactions list taken after that statement counts
// even when its own date is earlier: ICICI lists a refund dated 11 Aug in the
// cycle that began on 26 Aug, because that's the bill it comes off.
//
// The same list pasted on two devices before they synced leaves two copies of
// every row; identical rows from different lists are counted once.
export function cardOwedThisCycle(account, transactions, importBatches) {
  const statements = importBatches
    .filter((b) => b.accountId === account.id && !b.provisional && b.periodEnd)
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
  const since = [account.statementPeriodEnd, statements[0]?.periodEnd].filter(Boolean).sort().pop() || null;
  const listBatches = new Set(
    importBatches.filter((b) => b.accountId === account.id && b.provisional && (!since || listTakenOn(b) > since)).map((b) => b.id)
  );
  let owed = 0;
  let rows = 0;
  // key -> (list id -> how many identical rows that list holds)
  const listRows = new Map();
  for (const t of transactions) {
    if (t.accountId !== account.id || t.isTransfer) continue;
    const fromList = t.importBatchId && listBatches.has(t.importBatchId);
    if (since && t.date <= since && !fromList) continue;
    if (t.source === 'unbilled') {
      const key = `${t.date}|${t.amount}|${t.direction}|${t.rawDescription}`;
      const perList = listRows.get(key) || new Map();
      perList.set(t.importBatchId, (perList.get(t.importBatchId) || 0) + 1);
      listRows.set(key, perList);
      continue;
    }
    owed += t.direction === 'credit' ? -t.amount : t.amount;
    rows++;
  }
  // Twin rows inside one list are real (two ₹413 orders on one day); the same
  // row in two lists is one row pasted twice. So each row counts as many times
  // as the list holding the most copies of it.
  for (const [key, perList] of listRows) {
    const [, amount, direction] = key.split('|');
    const copies = Math.max(...perList.values());
    owed += (direction === 'credit' ? -1 : 1) * Number(amount) * copies;
    rows += copies;
  }
  return { cycleStart: currentCycleStart(account, importBatches), since, owed, rows };
}

export function cardCycleSpend(account, transactions, importBatches) {
  const cycleStart = currentCycleStart(account, importBatches);
  const spend = transactions
    .filter((t) => t.accountId === account.id && t.direction === 'debit' && !t.isTransfer && (!cycleStart || t.date > cycleStart))
    .reduce((s, t) => s + t.amount, 0);
  return { cycleStart, spend };
}
