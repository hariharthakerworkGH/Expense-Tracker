import * as hdfcBankSavings from './hdfc-bank-savings.js';
import * as hdfcBankSavingsNetbanking from './hdfc-bank-savings-netbanking.js';
import * as hdfcCreditCard from './hdfc-credit-card.js';
import * as iciciAmazonPayCreditCard from './icici-amazon-pay-credit-card.js';
import * as hdfcCardCurrentText from './hdfc-card-current-text.js';
import * as iciciCreditCardCurrent from './icici-credit-card-current.js';

export const parsers = [
  // Unbilled "current transactions" lists (a pasted HDFC list, an ICICI PDF)
  // go first. Their markers are the more specific ones - a statement parser
  // looking for "Credit Card Statement" could otherwise claim a current list
  // and write its "Total Amount Due 0" over the real bill.
  hdfcCardCurrentText,
  iciciCreditCardCurrent,
  hdfcBankSavings,
  hdfcBankSavingsNetbanking,
  hdfcCreditCard,
  iciciAmazonPayCreditCard,
];

export function detectParser(text) {
  return parsers.find((p) => p.detect(text)) || null;
}
