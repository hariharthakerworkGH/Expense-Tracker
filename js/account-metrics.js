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

export function cardCycleSpend(account, transactions, importBatches) {
  const cycleStart = currentCycleStart(account, importBatches);
  const spend = transactions
    .filter((t) => t.accountId === account.id && t.direction === 'debit' && !t.isTransfer && (!cycleStart || t.date > cycleStart))
    .reduce((s, t) => s + t.amount, 0);
  return { cycleStart, spend };
}
