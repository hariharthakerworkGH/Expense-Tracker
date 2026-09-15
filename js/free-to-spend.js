import { getAll, getSetting } from './db.js';
import { bankBalance, cardBillDue, cardOwedThisCycle, cardPosition } from './account-metrics.js';
import { nextOccurrence, isoLocal, frequencyOf } from './frequency.js';
import { isLiveCommitment, commitmentDueInWindow, paidAround } from './commitments.js';
import { looksLikeCardPayment } from './transfers.js';

// Your spending power, in the two places you spend from.
//
// BANK - safe to spend by UPI until the salary lands:
//   bank balance now
// − bank-paid commitments still to go out before the salary
// − card bills billed and due before the salary
//
// CARDS - left to spend until the statement day. This cycle's card spends are
// billed on the statement day and paid from the salary that follows, which
// also has to cover that month's commitments:
//   the coming salary (every salary up to the one that pays this cycle)
// − the bank-paid commitments of the month each of those salaries pays for
// − card bills already cut that the salary pays
// − what you want left in the bank
// = card limit for this cycle
// − spent on cards so far this cycle (refunds and cashback taken off)
// − card-paid commitments still to be charged this cycle
// = left to spend on cards
//
// The two meet on bills day: bank money not spent by UPI is still in the
// account when the salary lands, so bank + cards + what you keep is the
// balance left once everything is paid. Commitments paid in cash come out
// of the ATM money and aren't counted again.
//
// Every line is returned so the screen can show the sum, not just its answer.

const DAY_MS = 86400000;
const SALARY_EARLY_DAYS = 7;
const SALARY_LATE_DAYS = 5;
// What stays in the bank after the bills, unless changed on Plan: ₹10,000.
export const DEFAULT_KEEP_IN_BANK = 1000000;

function addDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoLocal(new Date(y, m - 1, d + delta));
}

function dateOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// The latest payday on or before `iso`, with the day clamped to short months.
function paydayOnOrBefore(dayOfMonth, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const clamp = (year, monthIndex) => Math.min(dayOfMonth, new Date(year, monthIndex + 1, 0).getDate());
  if (clamp(y, m - 1) <= d) return isoLocal(new Date(y, m - 1, clamp(y, m - 1)));
  return isoLocal(new Date(y, m - 2, clamp(y, m - 2)));
}

function daysBetweenInclusive(fromIso, toIso) {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round((new Date(ty, tm - 1, td) - new Date(fy, fm - 1, fd)) / DAY_MS) + 1;
}

export async function computeFreeToSpend(now = new Date()) {
  const [accounts, transactions, importBatches, recurring, monthlyIncome, salaryDay, keepInBank] = await Promise.all([
    getAll('accounts'),
    getAll('transactions'),
    getAll('importBatches'),
    getAll('recurring'),
    getSetting('monthlyIncome', null),
    getSetting('salaryDay', null),
    getSetting('keepInBank', DEFAULT_KEEP_IN_BANK),
  ]);

  const today = isoLocal(now);
  const bankAccounts = accounts.filter((a) => a.type === 'bank');
  const cardAccounts = accounts.filter((a) => a.type === 'card');
  const cardIds = new Set(cardAccounts.map((a) => a.id));
  const notes = [];

  // --- The card cycle -------------------------------------------------------
  // It closes on the statement day. With cards on different days, the last to
  // close sets the date, so every card's current spends are inside it.
  const statementDays = [...new Set(cardAccounts.map((a) => a.billingCycleDay).filter(Boolean))];
  const cycleClose = statementDays.length ? statementDays.map((d) => nextOccurrence(d, now)).sort().pop() : null;
  const cycleStart = cycleClose ? addDays(paydayOnOrBefore(Math.max(...statementDays), addDays(cycleClose, -1)), 1) : null;

  // --- Bank ---------------------------------------------------------------
  const bankLines = bankAccounts
    .map((a) => {
      const balance = bankBalance(a, transactions);
      if (balance == null) return null;
      const since = transactions.filter((t) => t.accountId === a.id && t.date > a.knownBalanceDate).length;
      return { account: a, balance, asOf: a.knownBalanceDate, entriesSince: since };
    })
    .filter(Boolean);
  const bank = bankLines.length ? bankLines.reduce((s, l) => s + l.balance, 0) : null;
  if (bank == null) notes.push('Import a bank statement so the app knows your balance.');

  // --- Salary and the window ----------------------------------------------
  const bankIds = new Set(bankAccounts.map((a) => a.id));
  let salary = { amount: 0, date: null, counted: false, alreadyIn: false, late: false, setUp: false, dates: [], billsPayday: null };
  let windowEnd;
  if (salaryDay && monthlyIncome) {
    salary.setUp = true;
    // Salaries land a few days early (payday on a weekend or holiday) or a
    // day or two late. A big enough credit near a payday is that payday's
    // salary, and it's already in the bank balance.
    const landedFor = (payday) =>
      transactions.some(
        (t) =>
          bankIds.has(t.accountId) &&
          t.direction === 'credit' &&
          !t.isTransfer &&
          t.amount >= monthlyIncome / 2 &&
          t.date >= addDays(payday, -SALARY_EARLY_DAYS) &&
          t.date <= addDays(payday, SALARY_LATE_DAYS) &&
          t.date <= today
      );
    const dayAfter = (iso) => nextOccurrence(salaryDay, dateOf(addDays(iso, 1)));
    const previous = paydayOnOrBefore(salaryDay, today);
    const next = dayAfter(today);

    // The first salary not yet in the bank. One that came early, on the day
    // or a little late is already in the balance; one a few days late that
    // hasn't arrived is still to come, not missing.
    let first;
    if (next <= addDays(today, SALARY_EARLY_DAYS) && landedFor(next)) {
      first = dayAfter(next);
      salary.alreadyIn = true;
    } else if (landedFor(previous)) {
      first = next;
    } else if (today <= addDays(previous, SALARY_LATE_DAYS)) {
      first = previous;
      salary.late = true;
    } else {
      first = next;
    }

    // The salary that pays this cycle's card bills: the first payday on or
    // after the statement day. Every salary up to it is counted, and the
    // plan runs to the end of the month that salary pays for.
    const billsPayday = cycleClose ? nextOccurrence(salaryDay, dateOf(cycleClose)) : first;
    for (let d = first; d <= billsPayday; d = dayAfter(d)) salary.dates.push(d);
    salary.billsPayday = billsPayday;
    salary.nextUnreceived = first;
    salary.dayAfter = dayAfter;
    salary.amount = monthlyIncome * salary.dates.length;
    salary.counted = salary.dates.length > 0;
    salary.date = salary.dates[0] || null;
    windowEnd = addDays(dayAfter(billsPayday), -1);
  } else {
    // Without a salary day there's no pay period to plan to, so plan to the
    // end of this month and count no future income.
    windowEnd = isoLocal(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    notes.push('Set your salary day and monthly income on the Plan screen to count your next salary.');
  }
  const daysLeft = Math.max(1, daysBetweenInclusive(today, windowEnd));

  // --- Cards --------------------------------------------------------------
  // A card bill paid from the bank leaves the bank at once, but the card's
  // "payment received" only reaches the app with the next list or statement.
  // Until then the bank-side payment has to count as paying the card, or the
  // bill is taken off twice: once from the bank balance, once as unpaid.
  const cardCreditsPaired = new Set();
  const bankOnlyPayments = transactions.filter((t) => {
    if (!bankIds.has(t.accountId) || t.direction !== 'debit' || !t.isTransfer || !looksLikeCardPayment(t, 'bank')) return false;
    const twin = transactions.find(
      (c) => cardIds.has(c.accountId) && c.direction === 'credit' && c.isTransfer && c.amount === t.amount && !cardCreditsPaired.has(c.id) && Math.abs(dateOf(c.date) - dateOf(t.date)) <= 7 * DAY_MS
    );
    if (twin) cardCreditsPaired.add(twin.id);
    return !twin;
  });

  const cards = cardAccounts.map((account) => {
    const { owed: owedNet, cycleStart, since } = cardOwedThisCycle(account, transactions, importBatches);
    const bill = cardBillDue(account);
    const credits = transactions
      .filter((t) => t.accountId === account.id && t.isTransfer && t.direction === 'credit' && (!since || t.date > since))
      .reduce((s, t) => s + t.amount, 0);
    return { account, owedNet, cycleStart, since, bill, credits, extraPayments: [] };
  });

  // Hand each bank-only payment to the card it paid: the card's digits in the
  // bank's description first, otherwise the one card whose bill it equals.
  for (const p of bankOnlyPayments) {
    const desc = p.rawDescription || '';
    const candidates = cards.filter((c) => !c.since || p.date > c.since);
    let target = candidates.find((c) => [c.account.last4, ...(c.account.linkedLast4s || [])].filter(Boolean).some((d) => desc.includes(d)));
    if (!target) {
      const byAmount = candidates.filter((c) => c.bill && !c.bill.paid && c.bill.amount === p.amount);
      if (byAmount.length === 1) target = byAmount[0];
    }
    if (target) {
      target.credits += p.amount;
      target.extraPayments.push(p);
    }
  }

  // Cards with a statement day are worked out cycle by cycle, which matches
  // each payment to the bill it paid. The rest fall back to "everything since
  // the last imported statement".
  for (const c of cards) {
    if (!c.account.billingCycleDay) continue;
    const p = cardPosition(c.account, transactions, importBatches, today, c.extraPayments);
    c.owed = p.owed;
    c.unpaid = p.unpaid + p.billedNotImported;
    c.billedNotImported = p.billedNotImported;
    c.refunds = p.refunds;
    c.statementMissing = p.statementMissing;
    c.positioned = true;
  }

  for (const c of cards) {
    if (!c.positioned) {
      // Payments since the last statement first settle that statement's bill,
      // and anything beyond it comes off what's owed since. Once the bill is
      // marked paid, the first payments are taken to be the ones that paid it.
      const billed = c.bill && !c.bill.paid ? c.bill.amount : 0;
      const payments = c.bill && c.bill.paid ? Math.max(0, c.credits - c.bill.amount) : c.credits;
      const total = Math.max(0, billed + c.owedNet - payments);
      c.unpaid = Math.min(total, Math.max(0, billed - payments));
      c.owed = total - c.unpaid;
      c.billedNotImported = 0;
      c.statementMissing = false;
    }
    const latestList = importBatches
      .filter((b) => b.accountId === c.account.id && b.provisional)
      .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))[0];
    c.listImportedAt = latestList ? latestList.importedAt : null;
    delete c.credits;
    delete c.owedNet;
    delete c.extraPayments;
    delete c.positioned;
  }

  for (const c of cards) {
    if (c.owed === 0 && c.unpaid === 0) continue;
    if (!c.listImportedAt) {
      notes.push(`${c.account.label}: no current transactions list yet — only entries and alerts you've saved are counted.`);
    }
    if (c.billedNotImported > 0) {
      notes.push(`${c.account.label}: the bill from its last statement day is estimated from your entries. Import that statement so the amount is exact.`);
    }
  }

  // --- Commitments, by what pays them -------------------------------------
  // Bank-paid ones come out of the bank (before salary) or out of a salary
  // (the month it pays for). Card-paid ones are card spending, so they're
  // reserved inside this card cycle until they show up on the card. Cash ones
  // come out of the ATM money, which is its own commitment.
  const cashIds = new Set(accounts.filter((a) => a.type === 'cash').map((a) => a.id));
  const paidBy = (item) => {
    if (item.accountId === 'cash' || cashIds.has(item.accountId)) return 'cash';
    if (item.accountId && cardIds.has(item.accountId)) return 'card';
    return 'bank';
  };
  const live = recurring.filter((item) => isLiveCommitment(item, today));
  const bankEntries = transactions.filter((t) => bankIds.has(t.accountId) && t.direction === 'debit');
  const keep = Math.max(0, Number(keepInBank) || 0);
  const firstSalary = salary.setUp ? salary.dates[0] || salary.nextUnreceived : null;
  const spendEnd = cycleClose || windowEnd;

  // Before the next salary lands, from the bank.
  const beforeSalaryEnd = firstSalary ? addDays(firstSalary, -1) : windowEnd;
  const bankBeforeSalary = [];
  for (const item of live.filter((i) => paidBy(i) === 'bank')) {
    if (beforeSalaryEnd < today) break;
    const { amount, detail } = commitmentDueInWindow(item, { today, windowEnd: beforeSalaryEnd, bankEntries });
    if (amount > 0) bankBeforeSalary.push({ label: item.label, amount, detail });
  }

  // Each salary still to come, and the month of commitments it pays for.
  const fundedMonths = salary.dates.map((payday) => {
    const end = addDays(salary.dayAfter(payday), -1);
    const items = [];
    for (const item of live.filter((i) => paidBy(i) === 'bank')) {
      const { amount, detail } = commitmentForMonth(item, payday, end, bankEntries, today);
      if (amount > 0) items.push({ label: item.label, amount, detail });
    }
    return { payday, end, amount: monthlyIncome, commitments: items, total: items.reduce((s, c) => s + c.amount, 0) };
  });

  // Card-paid commitments not yet charged in this cycle.
  const cardUpcoming = [];
  for (const item of live.filter((i) => paidBy(i) === 'card')) {
    const entries = transactions.filter((t) => t.accountId === item.accountId && t.direction === 'debit');
    const { amount, detail } = commitmentDueInWindow(item, { today, windowEnd: spendEnd, bankEntries: entries });
    const card = cardAccounts.find((a) => a.id === item.accountId);
    if (amount > 0) cardUpcoming.push({ label: item.label, amount, detail: `${card ? card.label : 'card'} · ${detail}` });
  }

  // Card bills: a billed statement due before the salary has to be paid from
  // the bank; everything else on the cards is paid from the salary.
  const billsBeforeSalary = [];
  const cardBills = [];
  for (const c of cards) {
    const statementPart = c.unpaid - (c.billedNotImported || 0);
    const due = c.account.statementDueDate;
    if (statementPart > 0 && firstSalary && due && due < firstSalary) {
      billsBeforeSalary.push({ label: `${c.account.label} bill`, amount: statementPart, detail: `due ${formatShort(due)}` });
      if (c.billedNotImported) cardBills.push({ label: `${c.account.label} bill`, amount: c.billedNotImported, detail: 'billed, statement not imported yet' });
    } else if (c.unpaid > 0) {
      cardBills.push({ label: `${c.account.label} bill`, amount: c.unpaid, detail: c.billedNotImported ? 'billed, statement not imported yet' : 'billed, not paid yet' });
    }
  }

  const sum = (list) => list.reduce((s, x) => s + x.amount, 0);
  const owedCards = cards.reduce((s, c) => s + c.owed, 0);
  const unpaidBills = cards.reduce((s, c) => s + c.unpaid, 0);
  const upcomingTotal = sum(cardUpcoming);
  const setUp = bank != null && salary.setUp;

  // The bank: what's safe to spend by UPI until the salary lands.
  let bankSafe = setUp ? bank - sum(bankBeforeSalary) - sum(billsBeforeSalary) : null;
  // The cards: what the coming salaries can pay once their months'
  // commitments are covered, less the bills already cut and what you keep.
  const shared = setUp && fundedMonths.length === 0;
  let limit = null;
  if (setUp) {
    limit = shared
      ? bankSafe - sum(cardBills) - keep // the salary that pays these bills is already in the bank
      : fundedMonths.reduce((s, m) => s + m.amount - m.total, 0) - sum(cardBills) - keep;
  }
  const free = limit == null ? null : limit - owedCards - upcomingTotal;
  // Cards over what the salary can pay can only be paid with money already
  // in the bank - so that money isn't free to spend by UPI.
  const bankBeforeCards = bankSafe;
  const cardShortfall = setUp && !shared && free < 0 ? -free : 0;
  if (shared) bankSafe = free;
  else if (setUp) bankSafe -= cardShortfall;
  // If nothing more is spent: the bank balance once the salary is in and the
  // commitments and card bills are paid.
  const afterBills = !setUp ? null : shared ? free + keep : bankBeforeCards + free + keep;

  // --- How close to the limits --------------------------------------------
  const daysToClose = Math.max(1, daysBetweenInclusive(today, spendEnd));
  const daysToSalary = Math.max(1, daysBetweenInclusive(today, beforeSalaryEnd));
  const daysIntoCycle = cycleStart ? Math.max(1, daysBetweenInclusive(cycleStart, today)) : null;
  const pace = daysIntoCycle ? Math.round(Math.max(0, owedCards) / daysIntoCycle) : 0;
  // At the pace of this cycle so far, the day the limit would be crossed. The
  // first few days of a cycle are too few to judge a pace by.
  const crossesOn = free != null && free > 0 && pace > 0 && daysIntoCycle >= MIN_DAYS_FOR_PACE ? addDays(today, Math.floor(free / pace)) : null;
  const used = limit > 0 ? (owedCards + upcomingTotal) / limit : 1;
  let level = 'ok';
  if (free == null) level = 'unknown';
  else if (free < 0) level = bankSafe >= 0 && !shared ? 'critical' : 'over';
  else if (used >= CRITICAL_SHARE || (crossesOn && crossesOn <= addDays(today, 3))) level = 'critical';
  else if (used >= WARNING_SHARE || (crossesOn && crossesOn <= spendEnd)) level = 'warning';
  const bankLevel = bankSafe == null ? 'unknown' : bankSafe < 0 ? 'over' : bankSafe < BANK_LOW ? 'warning' : 'ok';

  return {
    today,
    windowEnd,
    daysLeft,
    cycleStart,
    cycleClose,
    daysToClose,
    daysIntoCycle,
    bank,
    bankLines,
    salary,
    cards,
    keep,
    // bank until salary
    beforeSalaryEnd,
    daysToSalary,
    bankBeforeSalary,
    billsBeforeSalary,
    bankSafe,
    cardShortfall,
    bankPerDay: bankSafe != null && bankSafe > 0 ? Math.floor(bankSafe / daysToSalary) : 0,
    bankLevel,
    // cards this cycle
    fundedMonths,
    cardBills,
    cardUpcoming,
    limit,
    spentThisCycle: owedCards,
    free,
    perDay: free != null && free > 0 ? Math.floor(free / daysToClose) : 0,
    pace,
    crossesOn: crossesOn && crossesOn <= spendEnd ? crossesOn : null,
    used,
    level,
    shared,
    afterBills,
    totals: { owedCards, unpaidBills, upcoming: upcomingTotal },
    notes,
  };
}

// Below this, the bank gets an amber warning: ₹5,000.
const BANK_LOW = 500000;

// A bank-paid commitment in the month a salary pays for (payday to the day
// before the next one). A spread one counts in full. A dated one counts on
// each due date in the month, unless it has already been paid early.
function commitmentForMonth(item, from, to, bankEntries, today) {
  if (frequencyOf(item) !== 'monthly') return commitmentDueInWindow(item, { today: from, windowEnd: to, bankEntries, wholeMonths: true });
  if (item.spread) return { amount: item.amount, detail: 'through the month' };
  let amount = 0;
  const dues = [];
  for (let due = nextOccurrence(item.dayOfMonth, dateOf(from)); due && due <= to; due = nextOccurrence(item.dayOfMonth, dateOf(addDays(due, 1)))) {
    if (item.endDate && due > item.endDate) break;
    if (paidAround(item, due, bankEntries, today)) continue;
    amount += item.amount;
    dues.push(formatShort(due));
  }
  return { amount, detail: dues.length ? `due ${dues.join(', ')}` : '' };
}

function formatShort(iso) {
  return dateOf(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// Warn at three quarters of the limit, and call it critical at 90%.
const WARNING_SHARE = 0.75;
const CRITICAL_SHARE = 0.9;
const MIN_DAYS_FOR_PACE = 5;
