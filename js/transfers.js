import { getAll, put } from './db.js';

const MAX_DAYS_APART = 5;

// A credit card bill payment shows up twice: once as a debit on the paying
// account (bank/cash), once as a "payment received" credit on the card
// itself. Counting both inflates spend, so we auto-flag same-amount,
// close-in-time pairs across account types and exclude them from totals.
export async function detectTransfers() {
  const [transactions, accounts] = await Promise.all([getAll('transactions'), getAll('accounts')]);
  const accountType = new Map(accounts.map((a) => [a.id, a.type]));

  const payingDebits = transactions.filter((t) => !t.isTransfer && t.direction === 'debit' && accountType.get(t.accountId) !== 'card');
  const cardCredits = transactions.filter((t) => !t.isTransfer && t.direction === 'credit' && accountType.get(t.accountId) === 'card');

  const updates = [];
  for (const debit of payingDebits) {
    const match = cardCredits.find((credit) => credit.amount === debit.amount && !credit._claimed && daysApart(debit.date, credit.date) <= MAX_DAYS_APART);
    if (match) {
      match._claimed = true;
      debit.isTransfer = true;
      match.isTransfer = true;
      updates.push(debit, match);
    }
  }

  for (const t of updates) {
    delete t._claimed;
    await put('transactions', t);
  }
  return updates.length;
}

function daysApart(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.abs((a - b) / (1000 * 60 * 60 * 24));
}
