import { getAll, getSetting } from './db.js';
import { bankBalance, cardBillDue, cardOwedThisCycle } from './account-metrics.js';
import { frequencyOf, toMonthly, nextOccurrence, isoLocal } from './frequency.js';

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

function addDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoLocal(new Date(y, m - 1, d + delta));
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
  let salary = { amount: 0, date: null, counted: false, alreadyIn: false, setUp: false };
  let windowEnd;
  if (salaryDay && monthlyIncome) {
    salary.setUp = true;
    let next = nextOccurrence(salaryDay, now);
    // Payday itself: if the salary has already landed, it's in the bank
    // balance - adding it again would count it twice.
    const landedToday =
      next === today &&
      transactions.some(
        (t) => bankAccounts.some((a) => a.id === t.accountId) && t.date === today && t.direction === 'credit' && !t.isTransfer && t.amount >= monthlyIncome / 2
      );
    if (landedToday) {
      salary.alreadyIn = true;
      const following = nextOccurrence(salaryDay, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
      windowEnd = addDays(following, -1);
    } else {
      salary = { ...salary, amount: monthlyIncome, date: next, counted: true };
      const [ny, nm, nd] = next.split('-').map(Number);
      const following = nextOccurrence(salaryDay, new Date(ny, nm - 1, nd + 1));
      windowEnd = addDays(following, -1);
    }
  } else {
    // Without a salary day there's no pay period to plan to, so plan to the
    // end of this month and count no future income.
    windowEnd = isoLocal(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    notes.push('Set your salary day and monthly income on the Plan screen to count your next salary.');
  }
  const daysLeft = Math.max(1, daysBetweenInclusive(today, windowEnd));

  // --- Cards --------------------------------------------------------------
  const cards = cardAccounts.map((account) => {
    const { owed, cycleStart } = cardOwedThisCycle(account, transactions, importBatches);

    // A billed amount counts as unpaid only after subtracting payments made
    // since that statement closed. The app often knows a bill was paid (the
    // CRED or BBPS payment is right there on the card) even if "Mark paid"
    // was never tapped.
    const bill = cardBillDue(account);
    let unpaid = 0;
    if (bill && !bill.paid) {
      const paidSince = transactions
        .filter((t) => t.accountId === account.id && t.isTransfer && t.direction === 'credit' && (!account.statementPeriodEnd || t.date > account.statementPeriodEnd))
        .reduce((s, t) => s + t.amount, 0);
      unpaid = Math.max(0, bill.amount - paidSince);
    }

    const latestList = importBatches
      .filter((b) => b.accountId === account.id && b.provisional)
      .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))[0];
    return { account, owed, unpaid, cycleStart, listImportedAt: latestList ? latestList.importedAt : null };
  });

  for (const c of cards) {
    if (c.owed === 0 && c.unpaid === 0) continue;
    if (!c.listImportedAt) {
      notes.push(`${c.account.label}: no current transactions list yet — only entries and alerts you've saved are counted.`);
    }
  }

  // --- Commitments paid from the bank -------------------------------------
  const commitments = [];
  for (const item of recurring) {
    if (item.source !== 'fixed' || item.active === false) continue;
    // Charged to a card: it will show up in what the card owes.
    if (item.accountId && cardIds.has(item.accountId)) continue;

    const freq = frequencyOf(item);
    let amount = 0;
    let detail = '';
    if (freq === 'monthly') {
      let count = 0;
      let due = nextOccurrence(item.dayOfMonth, now);
      const dates = [];
      while (due && due <= windowEnd) {
        count++;
        dates.push(due);
        const [y, m, d] = due.split('-').map(Number);
        due = nextOccurrence(item.dayOfMonth, new Date(y, m - 1, d + 1));
      }
      amount = item.amount * count;
      detail = dates.length ? `due ${dates.map((d) => shortDate(d)).join(', ')}` : '';
    } else if (freq === 'daily') {
      amount = item.amount * daysLeft;
      detail = `${daysLeft} days`;
    } else if (freq === 'weekly') {
      amount = Math.round(item.amount * (daysLeft / 7));
      detail = `about ${Math.round(daysLeft / 7)} weeks`;
    } else if (freq === 'fortnightly') {
      amount = Math.round(item.amount * (daysLeft / 14));
      detail = `about ${Math.round(daysLeft / 14)} fortnights`;
    } else {
      // Quarterly, half-yearly, yearly: the month it falls in isn't known, so
      // it's spread evenly - set aside a slice for every day in the window.
      amount = Math.round(toMonthly(item.amount, freq) * (daysLeft / (365 / 12)));
      detail = 'set aside, spread over the year';
    }
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

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
