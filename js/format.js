import { CURRENCY_SYMBOL } from './config.js';

// en-IN groups digits the Indian way (lakh/crore: 12,34,567.89) instead of
// the Western 1,234,567.89 - without this, large amounts are hard to read
// at a glance.
const nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatAmount(minorUnits) {
  return nf.format(minorUnits / 100);
}

export function formatCurrency(minorUnits) {
  return `${CURRENCY_SYMBOL}${formatAmount(minorUnits)}`;
}

export function formatSignedCurrency(minorUnits) {
  const sign = minorUnits < 0 ? '-' : '';
  return `${sign}${CURRENCY_SYMBOL}${formatAmount(Math.abs(minorUnits))}`;
}

export function formatDateNice(isoDate) {
  const d = new Date(isoDate);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
