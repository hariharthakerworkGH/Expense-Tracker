import { getAll, put, newId } from './db.js';

// Words that show up constantly in narrations but never identify a merchant
// (payment-gateway prefixes, corporate suffixes, generic connectors).
const STOPWORDS = new Set([
  'pay', 'ptm', 'rsp', 'bppy', 'upi', 'value', 'dt', 'ref', 'pvt', 'ltd',
  'private', 'limited', 'com', 'www', 'the', 'and', 'for', 'from', 'india',
  'llc', 'llp', 'inc', 'services', 'service', 'payment', 'transaction',
]);

// The same merchant often shows up under different payment-gateway prefixes
// across statements ("PAY*SWIGGY...", "PTM*SWIGGY...", "RSP*SWIGGY...") or
// with the city glued onto the end with no space ("SwiggyBENGALURU"). Exact
// or single-key matching misses all of that, so instead of one key we keep
// a handful of "significant" words per description and match on overlap.
export function significantTokens(rawDescription) {
  const cleaned = rawDescription
    .replace(/Value Dt.*$/i, '')
    .replace(/\(?Ref#?\s*\d+.*$/i, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(' ')
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());
}

export function extractMerchantKey(rawDescription) {
  return significantTokens(rawDescription).slice(0, 4).join(' ');
}

export async function matchCategoryForDescription(rawDescription) {
  return matchWithRules(rawDescription, await getAll('merchantRules'));
}

// Takes the rules as an argument so a bulk pass over hundreds of transactions
// reads the rule table once instead of once per transaction.
function matchWithRules(rawDescription, rules) {
  const tokens = new Set(significantTokens(rawDescription));
  if (tokens.size === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const rule of rules) {
    const ruleTokens = rule.matchPattern.split(' ').filter(Boolean);
    let score = 0;
    for (const t of tokens) {
      for (const rt of ruleTokens) {
        if (t === rt) score += 2;
        else if (t.length >= 4 && rt.length >= 4 && (t.includes(rt) || rt.includes(t))) score += 1;
      }
    }
    if (score > bestScore || (score === bestScore && score > 0 && rule.hitCount > (best?.hitCount || 0))) {
      bestScore = score;
      best = rule;
    }
  }

  return bestScore > 0 ? best.categoryId : null;
}

// Applies everything learned so far to transactions that still have no
// category - typically statements imported before you'd taught the app
// anything. Only ever fills a blank: a category set by hand, or a split, is
// never touched. Pass `dryRun` to count what it would do without doing it.
export async function applyLearnedCategories({ dryRun = false } = {}) {
  const [transactions, rules] = await Promise.all([getAll('transactions'), getAll('merchantRules')]);
  if (rules.length === 0) return 0;

  let changed = 0;
  for (const t of transactions) {
    if (t.categoryId || t.isTransfer || (Array.isArray(t.splits) && t.splits.length)) continue;
    const categoryId = matchWithRules(t.rawDescription, rules);
    if (!categoryId) continue;
    changed++;
    if (dryRun) continue;
    t.categoryId = categoryId;
    await put('transactions', t);
  }
  return changed;
}

export async function learnFromAssignment(rawDescription, categoryId) {
  const key = extractMerchantKey(rawDescription);
  if (!key) return;
  const rules = await getAll('merchantRules');
  const existing = rules.find((r) => r.matchPattern === key);
  if (existing) {
    existing.categoryId = categoryId;
    existing.hitCount = (existing.hitCount || 0) + 1;
    await put('merchantRules', existing);
  } else {
    await put('merchantRules', { id: newId(), matchPattern: key, categoryId, hitCount: 1 });
  }
}
