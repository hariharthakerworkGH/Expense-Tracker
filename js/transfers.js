import { getAll, put } from './db.js';

const MAX_DAYS_APART = 5;

// A credit card bill payment shows up twice: once as a debit on the paying
// account (bank/cash), once as a "payment received" credit on the card
// itself. Counting both inflates spend, so we auto-flag same-amount,
// close-in-time pairs across account types and exclude them from totals.
export async function detectTransfers() {
  const [transactions, accounts] = await Promise.all([getAll('transactions'), getAll('accounts')]);
  const accountType = new Map(accounts.map((a) => [a.id, a.type]));

  // `transferManual` means you decided this one yourself - detection leaves it alone.
  const auto = transactions.filter((t) => !t.transferManual);
  const payingDebits = auto.filter((t) => !t.isTransfer && t.direction === 'debit' && accountType.get(t.accountId) !== 'card');
  const cardCredits = auto.filter((t) => !t.isTransfer && t.direction === 'credit' && accountType.get(t.accountId) === 'card');

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

  // Pairing only works when both halves have been imported. In practice they
  // often haven't: you pay the August card bill in September, so the bank
  // statement has the debit while the card's matching "payment received" is in
  // a cycle you haven't imported yet. Left alone, that bill payment counts as
  // ordinary spending and gets flagged as a suspicious new merchant. So also
  // recognise an unmatched half by how the bank itself describes it.
  for (const t of auto) {
    if (t.isTransfer || updates.includes(t)) continue;
    if (!looksLikeCardPayment(t, accountType.get(t.accountId))) continue;
    t.isTransfer = true;
    updates.push(t);
  }

  for (const t of updates) {
    delete t._claimed;
    await put('transactions', t);
  }
  return updates.length;
}

// Deliberately narrow: these wordings are card-bill settlements, not ordinary
// bill payments. "BBPS" alone is not enough - electricity and gas go through
// BBPS too - so it only counts alongside an explicit card-payment phrase.
const PAYMENT_OUT_RE = /\b(CRED\b|CRED\.CLUB|CC\s*PAYMENT|CREDIT\s*CARD\s*(BILL\s*)?(PAYMENT|PMT)|PAYMENT\s*ON\s*CRED)/i;
const PAYMENT_IN_RE = /\b(PAYMENT\s*RECEIVED|CC\s*PAYMENT|BPPY\s*CC|CRED\b|AUTOPAY\s*RECEIVED)/i;

function looksLikeCardPayment(t, type) {
  const desc = t.rawDescription || '';
  if (type === 'card') return t.direction === 'credit' && PAYMENT_IN_RE.test(desc);
  return t.direction === 'debit' && PAYMENT_OUT_RE.test(desc);
}

function daysApart(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.abs((a - b) / (1000 * 60 * 60 * 24));
}
