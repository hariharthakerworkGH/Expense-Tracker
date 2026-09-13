// Which month a spend actually belongs to.
//
// A calendar month is the wrong unit for a credit card. With a statement day
// of the 25th, something bought on the 26th of September never appears on the
// September statement - it lands on the one cut on 25 October and is paid in
// November. Filing it under September makes September look expensive and
// October look cheap, and neither figure matches what leaves your account.
//
// So card transactions are filed by billing cycle: anything after the
// statement day rolls into the next month. Bank and cash transactions are
// filed by calendar date, because that money has already gone.

export const CYCLE_SETTING_KEY = 'cycleAwareMonths';

export function monthKeyOf(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonthKey(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKeyOf(d);
}

// The month a single transaction counts towards.
export function spendingMonthOf(txn, account, cycleAware = true) {
  const base = monthKeyOf(txn.date);
  if (!cycleAware) return base;
  if (!account || account.type !== 'card' || !account.billingCycleDay) return base;

  const day = new Date(txn.date).getDate();
  // On or before the statement day, it is still on the cycle that closes this
  // month. After it, it belongs to the next one.
  return day > account.billingCycleDay ? shiftMonthKey(base, 1) : base;
}

export function accountMap(accounts) {
  return new Map(accounts.map((a) => [a.id, a]));
}

// All transactions belonging to a spending month.
export function transactionsForMonth(transactions, accounts, monthKey, cycleAware = true) {
  const byId = accountMap(accounts);
  return transactions.filter((t) => spendingMonthOf(t, byId.get(t.accountId), cycleAware) === monthKey);
}

// Every spending month that has any activity, newest first.
export function monthsWithActivity(transactions, accounts, cycleAware = true) {
  const byId = accountMap(accounts);
  const set = new Set(transactions.map((t) => spendingMonthOf(t, byId.get(t.accountId), cycleAware)));
  return [...set].sort().reverse();
}

export function currentMonthKey(now = new Date()) {
  return monthKeyOf(now);
}

export function previousMonthKey(monthKey) {
  return shiftMonthKey(monthKey, -1);
}

export function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

// A human explanation of what the month actually covers, for the cards in play.
// Without this the numbers look arbitrary: "why is my 26 September dinner in
// October?" deserves an answer on the screen, not in a changelog.
export function cycleExplanation(accounts, cycleAware = true) {
  if (!cycleAware) return null;
  const days = [...new Set(accounts.filter((a) => a.type === 'card' && a.billingCycleDay).map((a) => a.billingCycleDay))];
  if (days.length === 0) return null;
  if (days.length === 1) {
    const d = days[0];
    return `Card spending after the ${ordinalDay(d)} counts towards the next month, matching your statement cycle.`;
  }
  return `Card spending is counted by each card's own statement cycle (${days.sort((a, b) => a - b).map(ordinalDay).join(', ')}), not by calendar date.`;
}

function ordinalDay(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
