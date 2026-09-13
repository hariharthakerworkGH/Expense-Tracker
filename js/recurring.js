import { getAll, put } from './db.js';
import { significantTokens } from './merchant-rules.js';

const MIN_OCCURRENCES = 2;
const MIN_INTERVAL_DAYS = 25;
const MAX_INTERVAL_DAYS = 36;
const AMOUNT_TOLERANCE = 0.15; // same "merchant" charging within 15% counts as the same bill

// Scans debit history for the same merchant recurring roughly monthly at a
// roughly stable amount. Detected bills are upserted into the `recurring`
// store so a dismissal ("not recurring") persists across re-runs - this
// function is safe to call every time the dashboard loads.
export async function detectRecurring() {
  const [transactions, existingRecurring] = await Promise.all([getAll('transactions'), getAll('recurring')]);
  const debits = transactions.filter((t) => t.direction === 'debit' && !t.isTransfer);

  const groups = new Map();
  for (const t of debits) {
    const key = merchantKeyFor(t.rawDescription);
    if (!key) continue;
    const groupKey = `${t.accountId}::${key}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(t);
  }

  const detected = [];
  for (const [groupKey, txns] of groups) {
    if (txns.length < MIN_OCCURRENCES) continue;
    txns.sort((a, b) => (a.date < b.date ? -1 : 1));

    const hasMonthlyGap = txns.slice(1).some((t, i) => {
      const days = daysBetween(txns[i].date, t.date);
      return days >= MIN_INTERVAL_DAYS && days <= MAX_INTERVAL_DAYS;
    });
    if (!hasMonthlyGap) continue;

    const amounts = txns.map((t) => t.amount);
    const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const stable = amounts.every((a) => Math.abs(a - avg) / avg <= AMOUNT_TOLERANCE);
    if (!stable) continue;

    const last = txns[txns.length - 1];
    const id = recurringIdFor(groupKey);
    const existing = existingRecurring.find((r) => r.id === id);
    if (existing && existing.active === false) continue; // user dismissed this one

    const record = {
      id,
      label: existing?.label || last.rawDescription.slice(0, 48),
      amount: last.amount,
      dayOfMonth: new Date(last.date).getDate(),
      categoryId: last.categoryId || existing?.categoryId || null,
      accountId: last.accountId,
      active: true,
    };
    await put('recurring', record);
    detected.push(record);
  }

  return detected;
}

export function nextDueDate(dayOfMonth, today = new Date()) {
  const y = today.getFullYear();
  const m = today.getMonth();
  let due = new Date(y, m, dayOfMonth);
  if (due < today) due = new Date(y, m + 1, dayOfMonth);
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
}

function merchantKeyFor(desc) {
  return significantTokens(desc).slice(0, 3).join(' ');
}

function recurringIdFor(groupKey) {
  return `rec-${groupKey}`.replace(/[^a-z0-9_:-]/gi, '_');
}

function daysBetween(a, b) {
  return Math.abs((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
}
