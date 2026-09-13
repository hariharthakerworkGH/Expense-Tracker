import { getSetting, setSetting } from './db.js';
import { categorySlices } from './splits.js';

// Budgets are a plain map of categoryId -> monthly limit in paise, kept in the
// settings store rather than their own table: there are only ever a handful,
// and they're always read all at once.

export async function getBudgets() {
  return (await getSetting('budgets', null)) || {};
}

export async function setBudget(categoryId, amount) {
  const budgets = await getBudgets();
  if (amount == null || amount <= 0) delete budgets[categoryId];
  else budgets[categoryId] = amount;
  await setSetting('budgets', budgets);
  return budgets;
}

export function monthStartISO(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

// Spend per category for a period, split-aware. Credits and transfers never
// count against a budget - a refund shouldn't quietly buy you more headroom.
export function spendByCategory(transactions, from, to = '9999-12-31') {
  const totals = new Map();
  for (const t of transactions) {
    if (t.isTransfer || t.direction !== 'debit') continue;
    if (t.date < from || t.date > to) continue;
    for (const slice of categorySlices(t)) {
      const key = slice.categoryId || 'uncategorized';
      totals.set(key, (totals.get(key) || 0) + slice.amount);
    }
  }
  return totals;
}

// `state` drives the colour: fine under 80%, warn up to the limit, over past it.
export function budgetStatus(budgets, categories, transactions, from = monthStartISO(), to = '9999-12-31') {
  const spentMap = spendByCategory(transactions, from, to);
  return Object.entries(budgets)
    .map(([categoryId, limit]) => {
      const spent = spentMap.get(categoryId) || 0;
      const pct = limit > 0 ? spent / limit : 0;
      return {
        categoryId,
        name: categories.find((c) => c.id === categoryId)?.name || 'Deleted category',
        limit,
        spent,
        left: limit - spent,
        pct,
        state: pct > 1 ? 'over' : pct >= 0.8 ? 'warn' : 'ok',
      };
    })
    .sort((a, b) => b.pct - a.pct);
}
