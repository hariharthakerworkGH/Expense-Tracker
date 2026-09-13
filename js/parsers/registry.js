import * as hdfcBankSavings from './hdfc-bank-savings.js';
import * as hdfcCreditCard from './hdfc-credit-card.js';
import * as iciciAmazonPayCreditCard from './icici-amazon-pay-credit-card.js';

export const parsers = [hdfcBankSavings, hdfcCreditCard, iciciAmazonPayCreditCard];

export function detectParser(text) {
  return parsers.find((p) => p.detect(text)) || null;
}
