// HDFC Bank credit card statement (works across HDFC's co-branded cards -
// the layout is the bank's own template, not specific to one card product).
//
// Each transaction starts as "DD/MM/YYYY| HH:MM <description> [+] C<amount> l"
// but a long description can wrap onto extra lines with no date, so the
// description is accumulated until a line completes the C<amount> tail.
// The statement's PDF uses a custom font for the rupee sign that both pdf.js
// and every other extractor decode as a literal "C" - so "C 377.00" means
// Rs. 377.00, not a currency code. A trailing "+" marks credits (cashback,
// refunds, bill payments); its absence means a debit (purchase).
export const id = 'hdfc-credit-card';
export const accountType = 'card';
export const issuerLabel = 'HDFC Bank';

const LINE_START_RE = /^(\d{2})\/(\d{2})\/(\d{4})\|\s*(\d{2}:\d{2})\s+(.*)$/;
const TAIL_RE = /^(.*?)\s*(\+)?\s*C\s*([\d,]+\.\d{2})\s*l?$/;
const CARD_NUMBER_RE = /\b(\d{4,8}X{2,8}(\d{4}))\b/;
const PERIOD_RE = /(\d{1,2}\s+\w{3},\s+\d{4})\s*-\s*(\d{1,2}\s+\w{3},\s+\d{4})/;
const SUMMARY_RE = /C\s?([\d,]+\.\d{2})\s*\+?\s*C\s?([\d,]+\.\d{2})\s*\+?\s*C\s?([\d,]+\.\d{2})\s*\+?\s*C\s?([\d,]+\.\d{2})/;

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

export function detect(text) {
  return /HDFC Bank Credit Card/i.test(text) && /TOTAL AMOUNT DUE/i.test(text);
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
    let rest = m[5];
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

    let [, desc, plus, amountStr] = tail;

    // Rare case: a long description wraps so that the date+amount line ends
    // up sandwiched between the description's two halves (line ordering
    // gets scrambled when a sidebar/legend element shares a Y position).
    // If the description came back empty, the missing half is the line
    // just before this one (never consumed, since it has no date to match)
    // and/or the line just after (not yet consumed either).
    if (!desc.trim()) {
      const before = i > 0 && !LINE_START_RE.test(lines[i - 1]) ? lines[i - 1] : '';
      let after = '';
      if (j < lines.length && !LINE_START_RE.test(lines[j])) {
        after = lines[j];
        j++;
      }
      desc = [before, after].filter(Boolean).join(' ');
    }

    rows.push({
      date: `${yyyy}-${mm}-${dd}`,
      description: desc.trim().replace(/\s+/g, ' '),
      amount: Math.round(toNumber(amountStr) * 100),
      direction: plus ? 'credit' : 'debit',
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
