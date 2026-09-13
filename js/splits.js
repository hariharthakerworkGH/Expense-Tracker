// A transaction can be split across categories - one Amazon order that was
// half groceries, half a birthday present. Everything that reports on spending
// must go through here, otherwise a split transaction gets counted under a
// single category (or not at all).

export function isSplit(t) {
  return Array.isArray(t.splits) && t.splits.length > 0;
}

// The category slices of a transaction: its splits if it has them, otherwise
// the whole amount under its single category.
export function categorySlices(t) {
  if (isSplit(t)) return t.splits.map((s) => ({ categoryId: s.categoryId || null, amount: s.amount }));
  return [{ categoryId: t.categoryId || null, amount: t.amount }];
}

// A split transaction counts as categorised once every slice has a category.
export function needsCategory(t) {
  if (isSplit(t)) return t.splits.some((s) => !s.categoryId);
  return !t.categoryId;
}

export function splitTotal(splits) {
  return splits.reduce((sum, s) => sum + (Number.isFinite(s.amount) ? s.amount : 0), 0);
}
