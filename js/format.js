import { CURRENCY_SYMBOL } from './config.js';

// en-IN groups digits the Indian way (lakh/crore: 12,34,567.89) instead of
// the Western 1,234,567.89 - without this, large amounts are hard to read
// at a glance.
const nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatAmount(minorUnits) {
  return nf.format(minorUnits / 100);
}

export function formatCurrency(minorUnits) {
  return `${CURRENCY_SYMBOL}${formatAmount(minorUnits)}`;
}

export function formatSignedCurrency(minorUnits) {
  const sign = minorUnits < 0 ? '-' : '';
  return `${sign}${CURRENCY_SYMBOL}${formatAmount(Math.abs(minorUnits))}`;
}
