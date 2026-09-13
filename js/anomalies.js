import { getAll } from './db.js';
import { significantTokens } from './merchant-rules.js';

const NEW_MERCHANT_THRESHOLD = 100000; // Rs. 1,000 in minor units - flag a first-ever big spend
const MIN_HISTORY_FOR_STATS = 2;

// Lightweight, explainable heuristics - not a hard guarantee. Flags recent
// debits that are unusually large for that specific merchant (based on their
// own history), or a meaningfully-sized spend at a merchant never seen before.
export async function detectAnomalies(sinceDate) {
  const transactions = await getAll('transactions');
  const debits = transactions.filter((t) => t.direction === 'debit' && !t.isTransfer);

  const byMerchant = new Map();
  for (const t of debits) {
    const key = merchantKeyFor(t.rawDescription);
    if (!key) continue;
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key).push(t);
  }

  const flagged = [];
  const recent = debits.filter((t) => t.date >= sinceDate);

  for (const t of recent) {
    const key = merchantKeyFor(t.rawDescription);
    const history = (byMerchant.get(key) || []).filter((h) => h.id !== t.id && h.date < t.date);

    if (history.length >= MIN_HISTORY_FOR_STATS) {
      const amounts = history.map((h) => h.amount);
      const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
      const variance = amounts.reduce((s, a) => s + (a - avg) ** 2, 0) / amounts.length;
      const stddev = Math.sqrt(variance);
      const threshold = Math.max(avg + 2 * stddev, avg * 1.5);
      if (t.amount > threshold) {
        flagged.push({ transaction: t, reason: 'unusual', averageAmount: avg });
      }
    } else if (history.length === 0 && t.amount >= NEW_MERCHANT_THRESHOLD) {
      flagged.push({ transaction: t, reason: 'new-merchant', averageAmount: null });
    }
  }

  return flagged;
}

function merchantKeyFor(desc) {
  return significantTokens(desc).slice(0, 3).join(' ');
}
