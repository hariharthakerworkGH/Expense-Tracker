// How often a commitment repeats, and what that works out to per month.
//
// The monthly figure is what every budget calculation needs, but it is almost
// never how you think about the expense. You think "₹120 of chai a day", not
// "₹3,650 a month". So the amount is stored exactly as you entered it, along
// with its frequency, and the monthly equivalent is derived.
//
// Conversions annualise first and then divide by twelve, rather than using
// "×30" or "×4" - over a year those shortcuts lose about 5 days and 4 weeks
// of spending respectively, which on a daily habit is thousands of rupees.

export const FREQUENCIES = {
  daily: { label: 'Every day', short: 'a day', perMonth: 365 / 12 },
  weekly: { label: 'Every week', short: 'a week', perMonth: 52 / 12 },
  fortnightly: { label: 'Every 2 weeks', short: 'every 2 weeks', perMonth: 26 / 12 },
  monthly: { label: 'Every month', short: 'a month', perMonth: 1 },
  quarterly: { label: 'Every 3 months', short: 'every 3 months', perMonth: 1 / 3 },
  halfYearly: { label: 'Every 6 months', short: 'every 6 months', perMonth: 1 / 6 },
  yearly: { label: 'Every year', short: 'a year', perMonth: 1 / 12 },
};

export const DEFAULT_FREQUENCY = 'monthly';

// Anything saved before frequencies existed was a monthly figure.
export function frequencyOf(item) {
  return FREQUENCIES[item.frequency] ? item.frequency : DEFAULT_FREQUENCY;
}

export function toMonthly(amount, frequency) {
  const f = FREQUENCIES[frequency] || FREQUENCIES[DEFAULT_FREQUENCY];
  return Math.round(amount * f.perMonth);
}

export function monthlyAmountOf(item) {
  return toMonthly(item.amount, frequencyOf(item));
}

// Computed from the original amount rather than from the rounded monthly
// figure - ₹250 a week is ₹13,000 a year, not the ₹12,999.96 you get by
// rounding to a month first and multiplying back up.
export function toYearly(amount, frequency) {
  const f = FREQUENCIES[frequency] || FREQUENCIES[DEFAULT_FREQUENCY];
  return Math.round(amount * f.perMonth * 12);
}

export function yearlyAmountOf(item) {
  return toYearly(item.amount, frequencyOf(item));
}

// True for anything that repeats monthly or less often - the only ones where
// "due on the 5th" and a reminder make any sense. Reminding you daily that you
// buy chai daily would be useless.
export function hasDueDate(frequency) {
  return (FREQUENCIES[frequency] || FREQUENCIES[DEFAULT_FREQUENCY]).perMonth <= 1;
}

// The next date on or after `from` that falls on `dayOfMonth`, as YYYY-MM-DD.
// A day the month doesn't have is clamped to that month's last day, so "the
// 31st" means 30 September, not 1 October. Built month by month rather than by
// letting Date roll over: new Date(2026, 8, 31) silently becomes 1 October,
// which is how a bill "due on the 31st" used to jump to 31 October.
export function nextOccurrence(dayOfMonth, from = new Date()) {
  const day = Math.min(Math.max(Number(dayOfMonth) || 1, 1), 31);
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let offset = 0; offset <= 12; offset++) {
    const year = start.getFullYear();
    const month = start.getMonth() + offset;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const candidate = new Date(year, month, Math.min(day, lastDay));
    if (candidate >= start) return isoLocal(candidate);
  }
  return null;
}

export function isoLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function frequencyShort(frequency) {
  return (FREQUENCIES[frequency] || FREQUENCIES[DEFAULT_FREQUENCY]).short;
}
