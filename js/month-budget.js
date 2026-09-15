import { getAll, getSetting } from './db.js';
import { isoLocal, monthlyAmountOf } from './frequency.js';
import { isFixed, entryMatcher } from './commitments.js';
import { spendingMonthOf, accountMap, currentMonthKey, monthLabel } from './spending-month.js';import { cycleAwareEnabled } from './budgets.js';
import { categorySlices } from './splits.js';
import { looksLikeCardPayment } from './transfers.js';
import { computeFreeToSpend } from './free-to-spend.js';

// The number the app leads with: how much is left to spend THIS month.
//
//   money for the month   the salary that pays for it, plus anything else
//                          that came into the bank this month
// − fixed commitments     each counted in full - or what actually went on it,
//                          if that was more
// − everything else spent this month (card refunds and cashback taken off)
// = left to spend
//
// "This month" is the calendar month you're in. Card spends count by
// statement cycle: with a statement day of the 25th, a card spend on 26
// September is on October's bill, so it counts in October. Bank entries count
// by calendar date, except those from payday onwards when payday is at the
// month's end - they are paid out of next month's salary.
//
// Which salary pays for a month: one that lands late in the month before
// (payday the 16th or later - a salary on the 30th or 31st pays for the next
// month) or early in the month itself (payday the 15th or earlier).

const SALARY_EARLY_DAYS = 7;
const SALARY_LATE_DAYS = 7;

function addDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoLocal(new Date(y, m - 1, d + delta));
}

function paydayFor(monthKey, salaryDay) {
  const [y, m] = monthKey.split('-').map(Number);
  const monthIndex = salaryDay >= 16 ? m - 2 : m - 1;
  const lastDay = new Date(y, monthIndex + 1, 0).getDate();
  return isoLocal(new Date(y, monthIndex, Math.min(salaryDay, lastDay)));
}

function shiftMonth(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  return isoLocal(new Date(y, m - 1 + delta, 1)).slice(0, 7);
}

export async function computeMonthBudget(now = new Date()) {
  const [accounts, transactions, recurring, monthlyIncome, salaryDay, cycleAware, cash] = await Promise.all([
    getAll('accounts'),
    getAll('transactions'),
    getAll('recurring'),
    getSetting('monthlyIncome', null),
    getSetting('salaryDay', null),
    cycleAwareEnabled(),
    computeFreeToSpend(now),
  ]);

  const today = isoLocal(now);
  const monthKey = currentMonthKey(now);
  const [y, m] = monthKey.split('-').map(Number);
  const monthStart = `${monthKey}-01`;
  const monthEnd = isoLocal(new Date(y, m, 0));
  const daysInMonth = new Date(y, m, 0).getDate();
  const daysLeft = daysInMonth - now.getDate() + 1; // today included
  const byId = accountMap(accounts);
  const isBank = (t) => byId.get(t.accountId)?.type !== 'card';
  const notes = [];

  // Bank money follows the salary: with payday on the 31st, the EMI and cash
  // taken out on 31 August come out of the salary that landed that day, so
  // they belong to September - the month that salary pays for.
  const monthOf = (t) => {
    const account = byId.get(t.accountId);
    if (account && account.type === 'card') return spendingMonthOf(t, account, cycleAware);
    const key = t.date.slice(0, 7);
    if (salaryDay && salaryDay >= 16 && t.date >= paydayFor(shiftMonth(key, 1), salaryDay)) return shiftMonth(key, 1);
    return key;
  };
  const inMonth = transactions.filter((t) => monthOf(t) === monthKey);

  // --- Money for the month -------------------------------------------------
  const isSalarySized = (t) => monthlyIncome && t.direction === 'credit' && !t.isTransfer && isBank(t) && t.amount >= monthlyIncome / 2;
  const salaryWindow = (key) => {
    const payday = paydayFor(key, salaryDay);
    return { payday, from: addDays(payday, -SALARY_EARLY_DAYS), to: addDays(payday, SALARY_LATE_DAYS) };
  };
  let salary = { amount: 0, expected: monthlyIncome || 0, received: [], payday: null };
  const salaryIds = new Set();
  if (monthlyIncome && salaryDay) {
    // Salaries of the months either side are excluded from "other money in",
    // so the 30 September salary isn't counted as September money.
    for (const key of [shiftMonth(monthKey, -1), monthKey, shiftMonth(monthKey, 1)]) {
      const w = salaryWindow(key);
      const hits = transactions.filter((t) => isSalarySized(t) && t.date >= w.from && t.date <= w.to);
      hits.forEach((t) => salaryIds.add(t.id));
      if (key === monthKey) {
        salary.payday = w.payday;
        salary.received = hits;
      }
    }
    if (salary.received.length) {
      salary.amount = salary.received.reduce((s, t) => s + t.amount, 0);
    } else {
      salary.amount = monthlyIncome;
      if (today > salaryWindow(monthKey).to) notes.push(`No salary seen around ${salary.payday}; counting the ${Math.round(monthlyIncome / 100).toLocaleString('en-IN')} you set on Plan.`);
    }
  } else if (monthlyIncome) {
    salary.amount = monthlyIncome;
    notes.push('Set your salary day on Plan so the app can tell which salary pays for which month.');
  }

  const otherIncome = inMonth.filter(
    (t) => isBank(t) && t.direction === 'credit' && !t.isTransfer && !salaryIds.has(t.id) && !(monthlyIncome && !salaryDay && t.amount >= monthlyIncome / 2)
  );
  const otherIncomeTotal = otherIncome.reduce((s, t) => s + t.amount, 0);
  const income = salary.amount + otherIncomeTotal;

  // --- Fixed commitments ---------------------------------------------------
  // A card bill payment is money moving between your own accounts; the spends
  // behind it are already counted on the card.
  const debits = inMonth.filter((t) => t.direction === 'debit' && !looksLikeCardPayment(t, byId.get(t.accountId)?.type === 'card' ? 'card' : 'bank'));
  const claimed = new Set();
  // One that ends partway through this month still counts for this month.
  const live = recurring.filter((r) => isFixed(r) && r.active !== false && !(r.endDate && r.endDate < monthStart));
  const items = live.map((item) => ({ item, label: item.label, planned: monthlyAmountOf(item), paid: 0, accountId: item.accountId || null }));

  // Payments that name the commitment (its bank wording, ATM cash) or, with
  // nothing else to go on, the one payment of about its amount.
  for (const c of items) {
    const onAccount = (t) => !c.accountId || t.accountId === c.accountId;
    const matcher = entryMatcher(c.item);
    if (matcher) {
      for (const t of debits) {
        if (claimed.has(t.id) || !onAccount(t) || !matcher(t)) continue;
        claimed.add(t.id);
        c.paid += t.amount;
      }
    } else if (!c.item.categoryId) {
      const hit = debits
        .filter((t) => !claimed.has(t.id) && onAccount(t) && Math.abs(t.amount - c.planned) <= c.planned * 0.02)
        .sort((a, b) => Math.abs(a.amount - c.planned) - Math.abs(b.amount - c.planned))[0];
      if (hit) {
        claimed.add(hit.id);
        c.paid += hit.amount;
      }
    }
  }

  // A commitment with a category ("Entertainment ₹10,000") is a ceiling for
  // everything spent in that category. Commitments sharing a category share
  // the spend, so it is never counted twice.
  const categorySpend = new Map();
  for (const t of debits) {
    if (claimed.has(t.id) || t.isTransfer) continue;
    for (const slice of categorySlices(t)) {
      if (!slice.categoryId) continue;
      categorySpend.set(slice.categoryId, (categorySpend.get(slice.categoryId) || 0) + slice.amount);
    }
  }
  const categoriesCovered = new Set();
  for (const categoryId of new Set(items.map((c) => c.item.categoryId).filter(Boolean))) {
    categoriesCovered.add(categoryId);
    let pool = categorySpend.get(categoryId) || 0;
    const group = items.filter((c) => c.item.categoryId === categoryId);
    group.forEach((c, i) => {
      const room = Math.max(0, c.planned - c.paid);
      const take = i === group.length - 1 ? pool : Math.min(room, pool);
      c.paid += take;
      pool -= take;
    });
  }

  for (const c of items) {
    c.counted = Math.max(c.planned, c.paid);
    c.remaining = Math.max(0, c.planned - c.paid);
    c.over = Math.max(0, c.paid - c.planned);
  }
  const committed = items.reduce((s, c) => s + c.counted, 0);

  // --- Everything else ---------------------------------------------------
  let otherSpent = 0;
  const otherRows = [];
  for (const t of debits) {
    if (claimed.has(t.id) || t.isTransfer) continue;
    for (const slice of categorySlices(t)) {
      if (slice.categoryId && categoriesCovered.has(slice.categoryId)) continue;
      otherSpent += slice.amount;
    }
    otherRows.push(t);
  }
  const cardRefunds = inMonth.filter((t) => !isBank(t) && t.direction === 'credit' && !t.isTransfer).reduce((s, t) => s + t.amount, 0);
  const spentNet = otherSpent - cardRefunds;

  const hasIncome = Boolean(monthlyIncome) || salary.received.length > 0;
  const left = hasIncome ? income - committed - spentNet : null;
  const daysElapsed = now.getDate();

  // --- Can the bank actually pay for it? -----------------------------------
  // The budget says what this month allows. The bank says whether the money
  // is there: balance, less card bills billed and not yet paid, less what the
  // commitments paid from the bank still have to take this month.
  const bankCommitmentsLeft = items.filter((c) => !c.accountId || isBankId(c.accountId, byId)).reduce((s, c) => s + c.remaining, 0);
  const unpaidBills = cash.totals.unpaidBills;
  const bankAfter = cash.bank == null ? null : cash.bank - unpaidBills - bankCommitmentsLeft;
  if (left != null && bankAfter != null && left > 0 && bankAfter < left) {
    notes.push(
      `Your bank can only cover ${fmt(Math.max(0, bankAfter))} of this right now - it holds ${fmt(cash.bank)}, with ${fmt(unpaidBills)} of card bills unpaid and ${fmt(bankCommitmentsLeft)} of commitments still to go out.`
    );
  }
  if (cash.bank == null) notes.push('Import a bank statement so the app can check your bank can pay for this.');

  return {
    monthKey,
    monthName: monthLabel(monthKey).split(' ')[0],
    monthStart,
    monthEnd,
    today,
    daysInMonth,
    daysElapsed,
    daysLeft,
    salary,
    otherIncome,
    otherIncomeTotal,
    income,
    commitments: items,
    committed,
    otherSpent,
    otherRows,
    cardRefunds,
    spentNet,
    spentTotal: spentNet + items.reduce((s, c) => s + c.paid, 0),
    left,
    perDay: left != null && left > 0 ? Math.floor(left / daysLeft) : 0,
    runRate: daysElapsed > 0 ? Math.round(Math.max(0, spentNet) / daysElapsed) : 0,
    bank: cash.bank,
    unpaidBills,
    bankCommitmentsLeft,
    bankAfter,
    cardsOwed: cash.totals.owedCards,
    notes: [...notes, ...cash.notes.filter((n) => !/salary/i.test(n))],
    setUp: hasIncome,
  };
}

function isBankId(id, byId) {
  return byId.get(id)?.type !== 'card';
}

function fmt(minor) {
  return `₹${Math.round(minor / 100).toLocaleString('en-IN')}`;
}
