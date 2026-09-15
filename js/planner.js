import { getAll, getSetting } from './db.js';
import { spendByCategoryForMonth, monthStartISO, getBudgets, cycleAwareEnabled } from './budgets.js';
import { currentMonthKey, previousMonthKey } from './spending-month.js';
import { monthlyAmountOf, yearlyAmountOf } from './frequency.js';
import { isLiveCommitment } from './commitments.js';
import { computeFreeToSpend } from './free-to-spend.js';

// The planning engine.
//
// Every answer here is arithmetic against your own transactions, done on this
// device. Nothing is sent anywhere and it works with the phone in flight mode.
// That is a deliberate limit: the questions people actually want answered
// about their own money - can I afford this, will I hit my goal, where is it
// going wrong - are forecasting and comparison problems, not language ones.

const DISCRETIONARY_EXCLUDE = /rent|emi|loan|insurance|tax|income|transfer|bill|utilit/i;

// A single read of everything the other functions need, so a screen asking
// four questions doesn't hit the database four times.
export async function financialSnapshot(now = new Date()) {
  const [transactions, categories, recurring, income, budgets, accounts, cycleAware] = await Promise.all([
    getAll('transactions'),
    getAll('categories'),
    getAll('recurring'),
    getSetting('monthlyIncome', null),
    getBudgets(),
    getAll('accounts'),
    cycleAwareEnabled(),
  ]);

  const fixed = recurring.filter((r) => isLiveCommitment(r));
  const fixedCategoryIds = new Set(fixed.map((r) => r.categoryId).filter(Boolean));

  const monthStart = monthStartISO(now);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = now.getDate();
  const daysLeft = Math.max(0, daysInMonth - daysElapsed);

  const spentMap = spendByCategoryForMonth(transactions, accounts, currentMonthKey(now), cycleAware);

  const fixedMonthly = fixed.reduce((s, r) => s + monthlyAmountOf(r), 0);
  let variableSpent = 0;
  for (const [categoryId, amount] of spentMap) {
    if (!fixedCategoryIds.has(categoryId)) variableSpent += amount;
  }
  const free = income != null ? income - fixedMonthly : null;

  // "Left to spend" is the Summary's headline - what can still go on the cards
  // this cycle - so Plan, Coach and Summary always agree.
  const cycle = await computeFreeToSpend(now);
  const leftToSpend = cycle.free;

  // Run rate is measured over the days that have actually happened, then
  // carried across the days that haven't.
  const runRate = daysElapsed > 0 ? Math.round(variableSpent / daysElapsed) : 0;
  const projectedVariable = variableSpent + runRate * daysLeft;
  const projectedOver = free != null ? projectedVariable - free : null;

  return {
    now,
    transactions,
    categories,
    budgets,
    fixed,
    fixedMonthly,
    fixedCategoryIds,
    income,
    free,
    monthStart,
    daysInMonth,
    daysElapsed,
    daysLeft,
    variableSpent,
    leftToSpend,
    runRate,
    projectedVariable,
    projectedOver,
    perDayAllowance: leftToSpend != null ? cycle.perDay : null,
    cycle,
    spentMap,
    accounts,
    cycleAware,
    categoryAverages: monthlyAveragesByCategory(transactions, accounts, cycleAware, now),
    categoryName: (id) => (id === 'uncategorized' ? 'Uncategorized' : categories.find((c) => c.id === id)?.name || 'Uncategorized'),
  };
}

// Average monthly spend per category across the last three *complete* months.
// The current month is excluded - halfway through, it would drag every average
// down and make today's spending look unusually high.
function monthlyAveragesByCategory(transactions, accounts, cycleAware, now) {
  const months = [];
  let key = currentMonthKey(now);
  for (let i = 1; i <= 3; i++) {
    key = previousMonthKey(key);
    months.push(key);
  }

  const totals = new Map();
  const monthsWithData = new Set();
  for (const month of months) {
    const map = spendByCategoryForMonth(transactions, accounts, month, cycleAware);
    if (map.size === 0) continue;
    monthsWithData.add(month);
    for (const [categoryId, amount] of map) {
      totals.set(categoryId, (totals.get(categoryId) || 0) + amount);
    }
  }

  const divisor = Math.max(1, monthsWithData.size);
  const averages = new Map();
  for (const [categoryId, total] of totals) averages.set(categoryId, Math.round(total / divisor));

  // How much of the picture is still unsorted decides whether any advice here
  // is worth giving: you cannot be told where to cut if most of your spending
  // has no name on it.
  const uncategorized = averages.get('uncategorized') || 0;
  let totalAverage = 0;
  for (const amount of averages.values()) totalAverage += amount;

  return {
    averages,
    monthsCounted: monthsWithData.size,
    uncategorized,
    totalAverage,
    uncategorizedShare: totalAverage > 0 ? uncategorized / totalAverage : 0,
  };
}

// --- Question 1: can I afford this? ---

export function affordability(snapshot, amount) {
  if (snapshot.leftToSpend == null) {
    return { known: false, reason: 'no-income' };
  }
  const after = snapshot.leftToSpend - amount;
  const daysOfAllowance = snapshot.perDayAllowance > 0 ? Math.round(amount / snapshot.perDayAllowance) : null;
  const newPerDay = snapshot.daysLeft > 0 ? Math.floor(after / snapshot.daysLeft) : null;

  return {
    known: true,
    amount,
    after,
    canAfford: after >= 0,
    daysOfAllowance,
    newPerDay,
    // Even when it fits, spending it may leave an unrealistic daily budget for
    // the rest of the month, which is worth saying out loud.
    tight: after >= 0 && newPerDay != null && snapshot.runRate > 0 && newPerDay < snapshot.runRate * 0.5,
  };
}

// --- Question 2: help me save for something ---

export function savingsPlan(snapshot, target, targetDateISO) {
  const monthsLeft = monthsBetween(snapshot.now, new Date(targetDateISO));
  if (monthsLeft <= 0) return { valid: false, reason: 'past' };

  // Rounded up to whole rupees - "₹16,666.67 a month" is not a figure anyone
  // sets aside.
  const requiredPerMonth = Math.ceil(target / monthsLeft / 100) * 100;
  const free = snapshot.free;

  if (free == null) return { valid: true, monthsLeft, requiredPerMonth, known: false };

  // What you typically have left over, judged on how you actually spend rather
  // than on the theoretical free figure.
  const typicalVariable = averageMonthlyVariable(snapshot);
  const typicalSpare = free - typicalVariable;
  const shortfall = requiredPerMonth - typicalSpare;

  return {
    valid: true,
    known: true,
    target,
    monthsLeft,
    requiredPerMonth,
    typicalSpare,
    typicalVariable,
    feasible: shortfall <= 0,
    shortfall: Math.max(0, shortfall),
    cuts: shortfall > 0 ? whereToCut(snapshot, shortfall) : [],
  };
}

function averageMonthlyVariable(snapshot) {
  const { averages } = snapshot.categoryAverages;
  let total = 0;
  for (const [categoryId, amount] of averages) {
    if (snapshot.fixedCategoryIds.has(categoryId)) continue;
    total += amount;
  }
  // With no history at all, this month's run rate is the only evidence there is.
  return total > 0 ? total : Math.round(snapshot.runRate * snapshot.daysInMonth);
}

// --- Question 3: where should I cut? ---

// Ranks the categories worth trimming. Rent and EMIs are excluded: telling
// someone to spend less on rent is not advice.
export function whereToCut(snapshot, amountNeeded) {
  const { averages } = snapshot.categoryAverages;
  const candidates = [];

  for (const [categoryId, average] of averages) {
    if (snapshot.fixedCategoryIds.has(categoryId)) continue;
    // "Spend ₹39,000 less on Uncategorized" is not advice anyone can act on.
    if (categoryId === 'uncategorized') continue;
    const name = snapshot.categoryName(categoryId);
    if (DISCRETIONARY_EXCLUDE.test(name)) continue;
    if (average <= 0) continue;
    candidates.push({ categoryId, name, average, thisMonth: snapshot.spentMap.get(categoryId) || 0 });
  }

  candidates.sort((a, b) => b.average - a.average);

  // Spread the cut across the biggest categories in proportion to their size,
  // capped at a third of each - a suggestion to halve your food budget is one
  // nobody follows.
  const pool = candidates.slice(0, 4);
  const poolTotal = pool.reduce((s, c) => s + c.average, 0);
  if (poolTotal === 0) return [];

  let remaining = amountNeeded;
  const cuts = [];
  for (const c of pool) {
    if (remaining <= 0) break;
    const share = Math.round(amountNeeded * (c.average / poolTotal));
    const cut = Math.min(share, Math.round(c.average / 3), remaining);
    if (cut <= 0) continue;
    cuts.push({ ...c, cut, newTarget: c.average - cut, pct: Math.round((cut / c.average) * 100) });
    remaining -= cut;
  }

  return cuts;
}

// --- Question 4: what did you notice? ---

// Plain observations, each one a fact with the number that produced it. No
// advice without a figure attached to it.
export function observations(snapshot) {
  const notes = [];
  const { averages, monthsCounted } = snapshot.categoryAverages;

  if (snapshot.projectedOver != null && snapshot.daysLeft > 0) {
    if (snapshot.projectedOver > 0) {
      notes.push({
        tone: 'warn',
        title: `Heading for ${fmtShort(snapshot.projectedOver)} over`,
        body: `You're spending about ${fmtShort(snapshot.runRate)} a day. Carry that through to the ${snapshot.daysInMonth}th and you'll finish ${fmtShort(snapshot.projectedOver)} past what's free this month.`,
      });
    } else {
      notes.push({
        tone: 'good',
        title: `On track, ${fmtShort(-snapshot.projectedOver)} to spare`,
        body: `At ${fmtShort(snapshot.runRate)} a day you'll finish the month inside what's free.`,
      });
    }
  }

  // When most spending has no category, say that instead of dressing it up as
  // an insight - and it's now a one-tap fix from the Summary.
  if (snapshot.categoryAverages.uncategorizedShare > 0.25) {
    notes.push({
      tone: 'info',
      title: `${Math.round(snapshot.categoryAverages.uncategorizedShare * 100)}% of your spending has no category`,
      body: `That's about ${fmtShort(snapshot.categoryAverages.uncategorized)} a month I can't account for. Sort those on the Summary and everything here - forecasts, goals, where to cut - gets a lot sharper.`,
    });
  }

  // Categories running well above their own normal.
  if (monthsCounted > 0) {
    const spikes = [];
    for (const [categoryId, amount] of snapshot.spentMap) {
      if (categoryId === 'uncategorized') continue;
      const average = averages.get(categoryId);
      if (!average || average < 50000) continue; // ignore noise under ~₹500/month
      // Compare like with like: this month is only partly done.
      const expectedByNow = Math.round(average * (snapshot.daysElapsed / snapshot.daysInMonth));
      if (amount > expectedByNow * 1.4) {
        spikes.push({ categoryId, amount, expectedByNow, name: snapshot.categoryName(categoryId) });
      }
    }
    spikes.sort((a, b) => b.amount - b.expectedByNow - (a.amount - a.expectedByNow));
    for (const s of spikes.slice(0, 2)) {
      notes.push({
        tone: 'warn',
        title: `${s.name} is running hot`,
        body: `${fmtShort(s.amount)} so far this month against ${fmtShort(s.expectedByNow)} by this point in a normal month.`,
      });
    }
  }

  // The quiet cost of small repeating things.
  const daily = snapshot.fixed.filter((f) => f.frequency === 'daily' || f.frequency === 'weekly');
  if (daily.length) {
    const yearly = daily.reduce((s, f) => s + yearlyAmountOf(f), 0);
    notes.push({
      tone: 'info',
      title: `Your small habits cost ${fmtShort(yearly)} a year`,
      body: `${daily.map((d) => d.label).join(', ')} — easy to miss one at a time, less easy across twelve months.`,
    });
  }

  if (snapshot.income == null) {
    notes.push({
      tone: 'info',
      title: 'Tell me what you earn',
      body: 'Set your monthly income on the Plan screen and everything here gets sharper - forecasts, goals, what you can safely spend.',
    });
  }

  return notes;
}

// --- Question 5: what if I changed something? ---

export function whatIf(snapshot, categoryId, newMonthlyAmount) {
  const current = snapshot.categoryAverages.averages.get(categoryId) || 0;
  const saved = current - newMonthlyAmount;
  return {
    current,
    proposed: newMonthlyAmount,
    savedPerMonth: saved,
    savedPerYear: saved * 12,
    newFree: snapshot.free != null ? snapshot.free : null,
  };
}

// Whole months you have left to save in. Rounded DOWN deliberately: a target
// five and a half months away is planned as five, so the monthly figure is one
// you'll actually have saved by the date rather than just after it. Anything
// under a month still counts as one - you have some time, just not much.
function monthsBetween(from, to) {
  if (to <= from) return 0;
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(1, months);
}

// Compact figures for sentences, where "₹12,340.00" reads worse than "₹12,340".
function fmtShort(minorUnits) {
  return `₹${Math.round(Math.abs(minorUnits) / 100).toLocaleString('en-IN')}`;
}
