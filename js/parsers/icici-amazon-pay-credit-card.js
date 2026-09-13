// ICICI Bank Amazon Pay credit card statement.
// Each transaction starts as "DD/MM/YYYY <serial> <description> <rewardPts> <amount> [CR]"
// but the description can wrap onto extra lines with no date, so it's
// accumulated until a line completes the "<rewardPts> <amount> [CR]" tail.
// A trailing "CR" marks a credit (refund, cashback, bill payment); its
// absence means a debit (purchase). Reward points can be negative (a
// reversal), which is metadata only and doesn't affect direction.
export const id = 'icici-amazon-pay-credit-card';
export const accountType = 'card';
export const issuerLabel = 'ICICI Bank';

// Not anchored to the start of the line: an unrelated sidebar label (from a
// spending-breakdown pie chart) can land at the same text-layout Y position
// as a transaction row and get prepended to it.
const LINE_START_RE = /(\d{2})\/(\d{2})\/(\d{4})\s+\d+\s+(.*)$/;
const TAIL_RE = /^(.*?)\s+(-?\d+)\s+([\d,]+\.\d{2})(\s+CR)?$/;
const CARD_NUMBER_RE = /\b(\d{4}X{6,10}(\d{4}))\b/;
const PERIOD_RE = /Statement period\s*:\s*(\w+ \d{1,2}, \d{4})\s+to\s+(\w+ \d{1,2}, \d{4})/i;
// Matched as a whole line (not just 4 amounts in a row) because an
// unrelated single amount ("Total Amount due") sits on the line just
// above this block, and \s+ would otherwise happily span the newline
// and pull that stray value in as part of the match.
const SUMMARY_RE = /^`([\d,]+\.\d{2})\s+`([\d,]+\.\d{2})\s+`([\d,]+\.\d{2})\s+`([\d,]+\.\d{2})$/m;

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

export function detect(text) {
  return /ICICI Bank/i.test(text) && /Amazon Pay/i.test(text) && /CREDIT CARD STATEMENT/i.test(text);
}

export function parse(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(LINE_START_RE);
    if (!m) {
      i++;
      continue;
    }
    const [, dd, mm, yyyy] = m;
    let rest = m[4];
    let j = i + 1;
    let tail = rest.match(TAIL_RE);
    while (!tail && j < lines.length && j < i + 4 && !LINE_START_RE.test(lines[j])) {
      rest = `${rest} ${lines[j]}`;
      tail = rest.match(TAIL_RE);
      j++;
    }
    if (!tail) {
      i++;
      continue;
    }

    const [, desc, , amountStr, crFlag] = tail;
    rows.push({
      date: `${yyyy}-${mm}-${dd}`,
      description: desc.trim().replace(/\s+/g, ' '),
      amount: Math.round(toNumber(amountStr) * 100),
      direction: crFlag ? 'credit' : 'debit',
    });
    i = j;
  }

  const meta = { rowCount: rows.length };

  const cardMatch = text.match(CARD_NUMBER_RE);
  meta.accountLast4 = cardMatch ? cardMatch[2] : null;

  const periodMatch = text.match(PERIOD_RE);
  if (periodMatch) {
    meta.periodStart = parseLongDate(periodMatch[1]);
    meta.periodEnd = parseLongDate(periodMatch[2]);
  }

  // The "Previous Balance / Purchases / Cash Advances / Payments" block and
  // the unrelated "Credit Limit" block both look like 4 consecutive
  // backtick-amounts, so anchor the search to the labelled block by name.
  const anchorIdx = text.indexOf('Previous Balance');
  const searchText = anchorIdx >= 0 ? text.slice(anchorIdx) : text;
  const summaryMatch = searchText.match(SUMMARY_RE);
  if (summaryMatch) {
    meta.statementPurchasesTotal = Math.round(toNumber(summaryMatch[2]) * 100);
    meta.statementPaymentsCreditsTotal = Math.round(toNumber(summaryMatch[4]) * 100);
  }

  const parsedDebitTotal = rows.filter((r) => r.direction === 'debit').reduce((s, r) => s + r.amount, 0);
  const parsedCreditTotal = rows.filter((r) => r.direction === 'credit').reduce((s, r) => s + r.amount, 0);
  meta.parsedDebitTotal = parsedDebitTotal;
  meta.parsedCreditTotal = parsedCreditTotal;
  meta.reconciled = meta.statementPurchasesTotal != null ? Math.abs(parsedDebitTotal - meta.statementPurchasesTotal) < 100 : null;

  return { rows, meta };
}

function parseLongDate(str) {
  const m = str.match(/(\w+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const [, monthName, dd, yyyy] = m;
  const mm = MONTHS[monthName.toLowerCase()] || '01';
  return `${yyyy}-${mm}-${dd.padStart(2, '0')}`;
}

function toNumber(str) {
  return parseFloat(str.replace(/,/g, ''));
}
