import * as hdfcBankSavings from './hdfc-bank-savings.js';
import * as hdfcCreditCard from './hdfc-credit-card.js';

export const parsers = [hdfcBankSavings, hdfcCreditCard];

export function detectParser(text) {
  return parsers.find((p) => p.detect(text)) || null;
}
