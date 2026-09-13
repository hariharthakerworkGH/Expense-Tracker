// HDFC Bank credit card statement (works across HDFC's co-branded cards -
// the layout is the bank's own template, not specific to one card product).
//
// Each transaction is one line: "DD/MM/YYYY| HH:MM <description> [+] C<amount> l"
// The statement's PDF uses a custom font for the rupee sign that both pdf.js
// and every other extractor decode as a literal "C" - so "C 377.00" means
// Rs. 377.00, not a currency code. A trailing "+" marks credits (cashback,
// refunds, bill payments); its absence means a debit (purchase).
export const id = 'hdfc-credit-card';
export const accountType = 'card';
export const issuerLabel = 'HDFC Bank';

const TXN_RE = /^(\d{2})\/(\d{2})\/(\d{4})\|\s*(\d{2}:\d{2})\s+(.*?)\s*(\+)?\s*C\s*([\d,]+\.\d{2})\s*l?$/;
const CARD_NUMBER_RE = /\b(\d{4,6}X{2,8}(\d{4}))\b/;
const PERIOD_RE = /(\d{1,2}\s+\w{3},\s+\d{4})\s*-\s*(\d{1,2}\s+\w{3},\s+\d{4})/;
const SUMMARY_RE = /C\s?([\d,]+\.\d{2})\s*\+?\s*C\s?([\d,]+\.\d{2})\s*\+?\s*C\s?([\d,]+\.\d{2})\s*\+?\s*C\s?([\d,]+\.\d{2})/;

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

export function detect(text) {
  return /HDFC Bank Credit Card/i.test(text) && /TOTAL AMOUNT DUE/i.test(text);
}

export function parse(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [];

  for (const line of lines) {
    const m = line.match(TXN_RE);
    if (!m) continue;
    const [, dd, mm, yyyy, , desc, plus, amountStr] = m;
    const direction = plus ? 'credit' : 'debit';
    const amount = Math.round(toNumber(amountStr) * 100);
    rows.push({
      date: `${yyyy}-${mm}-${dd}`,
      description: desc.trim(),
      amount,
      direction,
    });
  }

  const meta = { rowCount: rows.length };

  const cardMatch = text.match(CARD_NUMBER_RE);
  meta.accountLast4 = cardMatch ? cardMatch[2] : null;

  const periodMatch = text.match(PERIOD_RE);
  if (periodMatch) {
    meta.periodStart = parseLongDate(periodMatch[1]);
    meta.periodEnd = parseLongDate(periodMatch[2]);
  }

  const summaryMatch = text.match(SUMMARY_RE);
  if (summaryMatch) {
    meta.statementPurchasesTotal = Math.round(toNumber(summaryMatch[3]) * 100);
    meta.statementPaymentsCreditsTotal = Math.round(toNumber(summaryMatch[2]) * 100);
  }

  const parsedDebitTotal = rows.filter((r) => r.direction === 'debit').reduce((s, r) => s + r.amount, 0);
  const parsedCreditTotal = rows.filter((r) => r.direction === 'credit').reduce((s, r) => s + r.amount, 0);
  meta.parsedDebitTotal = parsedDebitTotal;
  meta.parsedCreditTotal = parsedCreditTotal;
  meta.reconciled = meta.statementPurchasesTotal != null ? Math.abs(parsedDebitTotal - meta.statementPurchasesTotal) < 100 : null;

  return { rows, meta };
}

function parseLongDate(str) {
  const m = str.match(/(\d{1,2})\s+(\w{3}),\s+(\d{4})/);
  if (!m) return null;
  const [, dd, mon, yyyy] = m;
  const mm = MONTHS[mon] || '01';
  return `${yyyy}-${mm}-${dd.padStart(2, '0')}`;
}

function toNumber(str) {
  return parseFloat(str.replace(/,/g, ''));
}
