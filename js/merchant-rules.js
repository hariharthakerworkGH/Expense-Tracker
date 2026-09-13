import { getAll, put, newId } from './db.js';

// Crude but effective: strip UPI/value-date/ref noise, keep the merchant
// fragment before the first separator, use it as a case-insensitive key.
export function extractMerchantKey(rawDescription) {
  return rawDescription
    .replace(/UPI-/gi, '')
    .replace(/Value Dt.*$/i, '')
    .replace(/Ref\s*\d+.*$/i, '')
    .split(/[-|]/)[0]
    .trim()
    .toLowerCase()
    .slice(0, 40);
}

export async function matchCategoryForDescription(rawDescription) {
  const key = extractMerchantKey(rawDescription);
  if (!key) return null;
  const rules = await getAll('merchantRules');
  const hit = rules.find((r) => key.includes(r.matchPattern) || r.matchPattern.includes(key));
  return hit ? hit.categoryId : null;
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
