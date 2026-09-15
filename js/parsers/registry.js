import * as hdfcBankSavings from './hdfc-bank-savings.js';
import * as hdfcBankSavingsNetbanking from './hdfc-bank-savings-netbanking.js';
import * as hdfcCreditCard from './hdfc-credit-card.js';
import * as iciciAmazonPayCreditCard from './icici-amazon-pay-credit-card.js';
import * as hdfcCardCurrentText from './hdfc-card-current-text.js';
import * as iciciCreditCardCurrent from './icici-credit-card-current.js';

export const parsers = [
  hdfcBankSavings,
  hdfcBankSavingsNetbanking,
  hdfcCreditCard,
  iciciAmazonPayCreditCard,
  // Unbilled "current transactions" lists: a pasted HDFC list, an ICICI PDF.
  hdfcCardCurrentText,
  iciciCreditCardCurrent,
];

export function detectParser(text) {
  return parsers.find((p) => p.detect(text)) || null;
}
