import { getAll, getSetting } from './db.js';
import { bankBalance, cardBillDue, cardOwedThisCycle, cardPosition } from './account-metrics.js';
import { nextOccurrence, isoLocal } from './frequency.js';
import { isLiveCommitment, commitmentDueInWindow } from './commitments.js';
import { looksLikeCardPayment } from './transfers.js';

// The one number the app leads with: how much more can go on your cards (or
// out by UPI) in this card cycle, so that once the salary lands, the fixed
// commitments go out and this cycle's card bills are paid, the bank still
// holds what you asked it to keep.
//
// This cycle's card spends are billed on the statement day (the 25th) and
// paid from the salary that follows it. So:
//
//   bank balance now
// + salaries still to come, up to the one that pays this cycle's bills
// − card bills already billed and not yet paid
// − fixed commitments paid from the bank until that salary's month is over
//   (its whole month - every commitment comes out of that salary)
// − what you want left in the bank
// = spending limit for this card cycle
// − spent on cards so far this cycle (refunds and cashback taken off)
// = left to spend
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

  // --- Commitments paid from the bank -------------------------------------
  // Charged to a card, a commitment shows up in what the card owes, so only
  // bank-paid ones are taken off here - and only what hasn't gone out yet.
  const bankEntries = transactions.filter((t) => bankIds.has(t.accountId) && t.direction === 'debit');
  const commitments = [];
  for (const item of recurring) {
    if (!isLiveCommitment(item, today)) continue;
    if (item.accountId && cardIds.has(item.accountId)) continue;
    const { amount, detail } = commitmentDueInWindow(item, { today, windowEnd, bankEntries, wholeMonths: true });
    if (amount > 0) commitments.push({ label: item.label, amount, detail });
  }

  const owedCards = cards.reduce((s, c) => s + c.owed, 0);
  const unpaidBills = cards.reduce((s, c) => s + c.unpaid, 0);
  const commitmentsTotal = commitments.reduce((s, c) => s + c.amount, 0);
  const keep = Math.max(0, Number(keepInBank) || 0);
  const limit = bank == null ? null : bank + salary.amount - unpaidBills - commitmentsTotal - keep;
  const free = limit == null ? null : limit - owedCards;

  // --- How close to the limit ---------------------------------------------
  const spendEnd = cycleClose || windowEnd;
  const daysToClose = Math.max(1, daysBetweenInclusive(today, spendEnd));
  const daysIntoCycle = cycleStart ? Math.max(1, daysBetweenInclusive(cycleStart, today)) : null;
  const pace = daysIntoCycle ? Math.round(Math.max(0, owedCards) / daysIntoCycle) : 0;
  // At the pace of this cycle so far, the day the limit would be crossed. The
  // first few days of a cycle are too few to judge a pace by.
  const crossesOn = free != null && free > 0 && pace > 0 && daysIntoCycle >= MIN_DAYS_FOR_PACE ? addDays(today, Math.floor(free / pace)) : null;
  const used = limit > 0 ? owedCards / limit : 1;
  let level = 'ok';
  if (free == null) level = 'unknown';
  else if (free < 0) level = 'over';
  else if (used >= CRITICAL_SHARE || (crossesOn && crossesOn <= addDays(today, 3))) level = 'critical';
  else if (used >= WARNING_SHARE || (crossesOn && crossesOn <= spendEnd)) level = 'warning';

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
    commitments,
    keep,
    totals: { owedCards, unpaidBills, commitments: commitmentsTotal },
    limit,
    spentThisCycle: owedCards,
    free,
    perDay: free != null && free > 0 ? Math.floor(free / daysToClose) : 0,
    pace,
    crossesOn: crossesOn && crossesOn <= spendEnd ? crossesOn : null,
    used,
    level,
    notes,
  };
}

// Warn at three quarters of the limit, and call it critical at 90%.
const WARNING_SHARE = 0.75;
const CRITICAL_SHARE = 0.9;
const MIN_DAYS_FOR_PACE = 5;
