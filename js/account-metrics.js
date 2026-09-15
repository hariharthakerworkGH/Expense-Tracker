import { currentCycleStart } from './billing-cycle.js';
import { nextOccurrence, isoLocal } from './frequency.js';

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

// Where a card stands, cycle by cycle - for cards with a statement day.
//
// Every spend is placed in the cycle whose statement it lands on. Each
// closed cycle has a bill: the imported statement's amount when there is
// one, otherwise what was spent in that cycle. Payments are matched to the
// oldest bill cut before them. A payment with no bill in the app to settle
// (it paid a statement from before your data starts) is left out - it must
// never be taken off this cycle's spending, which is what used to make
// ₹97,000 of card spends look like ₹12,781.
//
// Returns:
//   unpaid              imported bills not yet paid
//   billedNotImported   bills cut on the statement day but not imported yet
//   owed                spent this cycle, refunds and cashback taken off
//   refunds             the refunds and cashback inside `owed`
//   cycleClose          this cycle's statement day; lastClose the previous one
//
// `extraPayments` are card payments seen only on the bank side.
export function cardPosition(account, transactions, importBatches, today, extraPayments = []) {
  const day = account.billingCycleDay;
  const closeOf = (iso) => nextOccurrence(day, dateOf(iso));
  const closeBefore = (iso) => closeOnOrBefore(day, addDays(iso, -1));
  const cycleClose = closeOf(today);
  const lastClose = closeBefore(today);
  const prevClose = closeBefore(lastClose);
  const batches = new Map(importBatches.map((b) => [b.id, b]));

  // Which cycle a transaction belongs to.
  const cycleOf = (t) => {
    const b = t.importBatchId ? batches.get(t.importBatchId) : null;
    if (b && !b.provisional && b.periodEnd) return closeOf(b.periodEnd);
    const close = closeOf(t.date);
    // A current list shows only what's unbilled. A row dated in a cycle that
    // closed well before the list was taken (ICICI's 11 Aug refund on the
    // 15 Sep list) is on the bill of the cycle the list was taken in.
    if (b && b.provisional) {
      const taken = listTakenOn(b);
      if (taken && close < addDays(taken, -3)) return closeOf(taken);
    }
    return close;
  };

  const spend = new Map(); // close -> net spend
  const refunds = new Map();
  const add = (close, t) => {
    const signed = t.direction === 'credit' ? -t.amount : t.amount;
    spend.set(close, (spend.get(close) || 0) + signed);
    if (t.direction === 'credit') refunds.set(close, (refunds.get(close) || 0) + t.amount);
  };
  // The same list pasted on two devices before they synced: identical rows
  // from different lists are counted as often as the list with most copies.
  const listRows = new Map();
  for (const t of transactions) {
    if (t.accountId !== account.id || t.isTransfer) continue;
    const close = cycleOf(t);
    if (close < prevClose) continue; // long since billed and paid
    if (t.source === 'unbilled') {
      const key = `${close}|${t.date}|${t.amount}|${t.direction}|${t.rawDescription}`;
      const perList = listRows.get(key) || new Map();
      perList.set(t.importBatchId, [...(perList.get(t.importBatchId) || []), t]);
      listRows.set(key, perList);
      continue;
    }
    add(close, t);
  }
  for (const [key, perList] of listRows) {
    const close = key.split('|')[0];
    const copies = [...perList.values()].sort((a, b) => b.length - a.length)[0];
    for (const t of copies) add(close, t);
  }

  // Bills for the cycles that have closed.
  const bills = [prevClose, lastClose].map((close) => {
    const fromStatement =
      account.statementDue != null && account.statementPeriodEnd && Math.abs(dateOf(account.statementPeriodEnd) - dateOf(close)) <= 3 * DAY_MS;
    return {
      close,
      fromStatement: Boolean(fromStatement),
      known: Boolean(fromStatement) || spend.has(close),
      amount: fromStatement ? account.statementDue : Math.max(0, spend.get(close) || 0),
      markedPaid: Boolean(fromStatement && account.statementDuePaid),
      left: 0,
    };
  });
  bills.forEach((b) => (b.left = b.amount));

  const payments = [
    ...transactions.filter((t) => t.accountId === account.id && t.isTransfer && t.direction === 'credit'),
    ...extraPayments,
  ]
    .filter((p) => p.date > prevClose)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  let advance = 0;
  for (const p of payments) {
    let amount = p.amount;
    const payable = bills.filter((b) => b.known && b.close < p.date);
    for (const b of payable) {
      const take = Math.min(b.left, amount);
      b.left -= take;
      amount -= take;
    }
    // Paid more than the bills in the app: the extra comes off this cycle.
    if (amount > 0 && payable.length) advance += amount;
  }
  for (const b of bills) if (b.markedPaid) b.left = 0;

  const unpaid = bills.filter((b) => b.fromStatement).reduce((s, b) => s + b.left, 0);
  const billedNotImported = bills.filter((b) => !b.fromStatement).reduce((s, b) => s + b.left, 0);
  const owed = Math.max((spend.get(cycleClose) || 0) - advance, -(unpaid + billedNotImported));
  return {
    unpaid,
    billedNotImported,
    owed,
    refunds: refunds.get(cycleClose) || 0,
    cycleClose,
    lastClose,
    statementMissing: bills[1].known && !bills[1].fromStatement,
  };
}

const DAY_MS = 86400000;

function dateOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoLocal(new Date(y, m - 1, d + delta));
}

// The latest statement day on or before `iso`, clamped to short months.
function closeOnOrBefore(dayOfMonth, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const clamp = (year, monthIndex) => Math.min(dayOfMonth, new Date(year, monthIndex + 1, 0).getDate());
  if (clamp(y, m - 1) <= d) return isoLocal(new Date(y, m - 1, clamp(y, m - 1)));
  return isoLocal(new Date(y, m - 2, clamp(y, m - 2)));
}

export function cardCycleSpend(account, transactions, importBatches) {
  const cycleStart = currentCycleStart(account, importBatches);
  const spend = transactions
    .filter((t) => t.accountId === account.id && t.direction === 'debit' && !t.isTransfer && (!cycleStart || t.date > cycleStart))
    .reduce((s, t) => s + t.amount, 0);
  return { cycleStart, spend };
}
