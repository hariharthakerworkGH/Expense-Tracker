import { getSetting, setSetting, getAll } from './db.js';
import { categorySlices } from './splits.js';
import { spendingMonthOf, accountMap, CYCLE_SETTING_KEY } from './spending-month.js';

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
  return tally(transactions.filter((t) => t.date >= from && t.date <= to));
}

// The same tally, but for a billing-cycle month rather than a calendar range:
// a card purchase after its statement day counts towards the next month.
export function spendByCategoryForMonth(transactions, accounts, monthKey, cycleAware = true) {
  const byId = accountMap(accounts);
  return tally(transactions.filter((t) => spendingMonthOf(t, byId.get(t.accountId), cycleAware) === monthKey));
}

function tally(rows) {
  const totals = new Map();
  for (const t of rows) {
    if (t.isTransfer || t.direction !== 'debit') continue;
    for (const slice of categorySlices(t)) {
      const key = slice.categoryId || 'uncategorized';
      totals.set(key, (totals.get(key) || 0) + slice.amount);
    }
  }
  return totals;
}

export async function cycleAwareEnabled() {
  return (await getSetting(CYCLE_SETTING_KEY, true)) !== false;
}

// Budget progress for a spending month, which is what the rest of the app now
// means by "this month".
export async function budgetStatusForMonth(budgets, categories, transactions, monthKey) {
  const accounts = await getAll('accounts');
  const spentMap = spendByCategoryForMonth(transactions, accounts, monthKey, await cycleAwareEnabled());
  return statusFrom(budgets, categories, spentMap);
}

// `state` drives the colour: fine under 80%, warn up to the limit, over past it.
export function budgetStatus(budgets, categories, transactions, from = monthStartISO(), to = '9999-12-31') {
  return statusFrom(budgets, categories, spendByCategory(transactions, from, to));
}

function statusFrom(budgets, categories, spentMap) {
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
