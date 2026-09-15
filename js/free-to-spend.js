import { getAll, getSetting } from './db.js';
import { bankBalance, cardBillDue, cardOwedThisCycle } from './account-metrics.js';
import { nextOccurrence, isoLocal } from './frequency.js';
import { isLiveCommitment, commitmentDueInWindow } from './commitments.js';
import { looksLikeCardPayment } from './transfers.js';

// The one number the app leads with: how much you can still spend before your
// bank account runs out, once everything already owed is taken off.
//
//   bank balance now
// + your next salary (the one that pays this cycle's card bills)
// − card bills already billed and not yet paid
// − what you owe on each card for the cycle not yet billed (refunds and cashback taken off)
// − commitments paid from the bank that fall due before the window ends
//
// The window runs from today to the day before the salary after next, so it
// holds exactly one salary: one allowance for one pay period. Every line is
// returned so the screen can show the sum rather than just its answer.

const DAY_MS = 86400000;
const SALARY_EARLY_DAYS = 7;
const SALARY_LATE_DAYS = 5;

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
  const [accounts, transactions, importBatches, recurring, monthlyIncome, salaryDay] = await Promise.all([
    getAll('accounts'),
    getAll('transactions'),
    getAll('importBatches'),
    getAll('recurring'),
    getSetting('monthlyIncome', null),
    getSetting('salaryDay', null),
  ]);

  const today = isoLocal(now);
  const bankAccounts = accounts.filter((a) => a.type === 'bank');
  const cardAccounts = accounts.filter((a) => a.type === 'card');
  const cardIds = new Set(cardAccounts.map((a) => a.id));
  const notes = [];

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
  let salary = { amount: 0, date: null, counted: false, alreadyIn: false, late: false, setUp: false };
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

    // Once a salary is in the bank, the plan moves on to the pay period it
    // funds and counts the salary after it - whether it landed on the day,
    // early or late - so the number changes when the money arrives, not on a
    // date that happens to be on the calendar.
    if (next <= addDays(today, SALARY_EARLY_DAYS) && landedFor(next)) {
      const after = dayAfter(next);
      salary = { ...salary, amount: monthlyIncome, date: after, counted: true, alreadyIn: true };
      windowEnd = addDays(dayAfter(after), -1);
    } else if (landedFor(previous)) {
      salary = { ...salary, amount: monthlyIncome, date: next, counted: true };
      windowEnd = addDays(dayAfter(next), -1);
    } else if (today <= addDays(previous, SALARY_LATE_DAYS)) {
      // Payday was in the last few days and nothing has arrived yet: it's
      // late, not missing. Count it, and plan only until the next payday.
      salary = { ...salary, amount: monthlyIncome, date: previous, counted: true, late: true };
      windowEnd = addDays(next, -1);
    } else {
      salary = { ...salary, amount: monthlyIncome, date: next, counted: true };
      windowEnd = addDays(dayAfter(next), -1);
    }
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
    return { account, owedNet, cycleStart, since, bill, credits };
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
    if (target) target.credits += p.amount;
  }

  for (const c of cards) {
    // Payments since the last statement first settle that statement's bill,
    // and anything beyond it comes off what's owed since. Once the bill is
    // marked paid, the first payments are taken to be the ones that paid it.
    const billed = c.bill && !c.bill.paid ? c.bill.amount : 0;
    const payments = c.bill && c.bill.paid ? Math.max(0, c.credits - c.bill.amount) : c.credits;
    const total = Math.max(0, billed + c.owedNet - payments);
    c.unpaid = Math.min(total, Math.max(0, billed - payments));
    c.owed = total - c.unpaid;
    const latestList = importBatches
      .filter((b) => b.accountId === c.account.id && b.provisional)
      .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))[0];
    c.listImportedAt = latestList ? latestList.importedAt : null;
    // A statement day has passed since the last imported statement.
    c.statementMissing = Boolean(c.cycleStart && c.since && c.cycleStart > c.since);
    delete c.credits;
    delete c.owedNet;
  }

  for (const c of cards) {
    if (c.owed === 0 && c.unpaid === 0) continue;
    if (!c.listImportedAt) {
      notes.push(`${c.account.label}: no current transactions list yet — only entries and alerts you've saved are counted.`);
    }
    if (c.statementMissing) {
      notes.push(`${c.account.label}: its statement day has passed. Import the new statement so the bill and its due date are exact.`);
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
    const { amount, detail } = commitmentDueInWindow(item, { today, windowEnd, bankEntries });
    if (amount > 0) commitments.push({ label: item.label, amount, detail });
  }

  const owedCards = cards.reduce((s, c) => s + c.owed, 0);
  const unpaidBills = cards.reduce((s, c) => s + c.unpaid, 0);
  const commitmentsTotal = commitments.reduce((s, c) => s + c.amount, 0);
  const free = bank == null ? null : bank + salary.amount - unpaidBills - owedCards - commitmentsTotal;

  return {
    today,
    windowEnd,
    daysLeft,
    bank,
    bankLines,
    salary,
    cards,
    commitments,
    totals: { owedCards, unpaidBills, commitments: commitmentsTotal },
    free,
    perDay: free != null && free > 0 ? Math.floor(free / daysLeft) : 0,
    notes,
  };
}
