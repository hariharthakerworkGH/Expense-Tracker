// ICICI credit card "VIEW CURRENT STATEMENT" PDF - the transactions so far in
// the cycle that hasn't been billed yet, as opposed to the monthly statement
// (see icici-amazon-pay-credit-card.js). Rows look like:
//
//   14-09-2026 GOOGLE PLAY CONTENT PU -MUMBAI 489 Dr. 4 14172436168
//
// with the details column often wrapping onto the next line. The page prints
// its own totals ("Purchases and Other Charges", "Payments and Other
// Credits"), so every read is checked against them, the same way statements
// are.
export const id = 'icici-credit-card-current';
export const accountType = 'card';
export const issuerLabel = 'ICICI Bank';
// A snapshot of an unbilled cycle: replaced by the next one, and by the
// monthly statement once it arrives.
export const provisional = true;

// Details are matched lazily up to the first "amount Dr./Cr. points reference"
// that completes a row, so numbers inside a merchant's details ("<5/12>",
// "CGST-CI@9%") don't end the row early.
const ROW_RE = /(\d{2})-(\d{2})-(\d{4})\s+(.+?)\s+([\d,]+(?:\.\d{1,2})?)\s+(Dr|Cr)\.?\s+(-?\d+)\s+(\d{8,})(?=\s|$)/g;

export function detect(text) {
  return /VIEW CURRENT STATEMENT/i.test(text) && /Reward Points/i.test(text) && /Reference Number/i.test(text);
}

export function parse(text) {
  const flat = String(text).replace(/\s+/g, ' ');

  // Rows only exist after the table header; the summary block above it
  // contains dates and amounts that must not be read as transactions.
  const headerAt = flat.search(/Reference Number/i);
  const table = headerAt >= 0 ? flat.slice(headerAt + 'Reference Number'.length) : flat;

  const rows = [];
  let m;
  let lastEnd = 0;
  ROW_RE.lastIndex = 0;
  while ((m = ROW_RE.exec(table))) {
    // pdf.js places a wrapped details line AFTER that row's numbers, so the
    // text between one row and the next belongs to the previous row - that's
    // where "Amortization - <5/12>WWW DYSON IN" ends up for an EMI instalment.
    if (rows.length) appendDetails(rows[rows.length - 1], table.slice(lastEnd, m.index));
    rows.push({
      date: `${m[3]}-${m[2]}-${m[1]}`,
      details: m[4],
      amount: toPaise(m[5]),
      direction: m[6] === 'Cr' ? 'credit' : 'debit',
      ref: m[8],
    });
    lastEnd = ROW_RE.lastIndex;
  }
  // The last row's wrap is whatever follows it, up to the end of the page.
  if (rows.length) appendDetails(rows[rows.length - 1], table.slice(lastEnd, lastEnd + 60));
  for (const row of rows) {
    row.description = row.details.replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').replace(/^\s*-\s*|\s*-\s*$/g, '').trim();
    delete row.details;
  }

  const money = (label) => {
    const hit = flat.match(new RegExp(`${label}\\s*INR\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i'));
    return hit ? toPaise(hit[1]) : null;
  };
  const period = flat.match(/Statement Period\s*(\d{2})-(\d{2})-(\d{4})\s*TO\s*(\d{2})-(\d{2})-(\d{4})/i);
  const cardDigits = flat.match(/\*{2,}\s*(\d{4})\b/);

  const debitTotal = rows.filter((r) => r.direction === 'debit').reduce((s, r) => s + r.amount, 0);
  const creditTotal = rows.filter((r) => r.direction === 'credit').reduce((s, r) => s + r.amount, 0);
  const printedCharges = money('Purchases and Other Charges');
  const printedCredits = money('Payments and Other Credits');
  const isPayment = (r) => r.direction === 'credit' && /Payment\s+received|BBPS/i.test(r.description);
  const payments = rows.filter(isPayment).reduce((s, r) => s + r.amount, 0);

  return {
    rows,
    meta: {
      provisional: true,
      accountLast4: cardDigits ? cardDigits[1] : null,
      periodStart: period ? `${period[3]}-${period[2]}-${period[1]}` : null,
      periodEnd: period ? `${period[6]}-${period[5]}-${period[4]}` : null,
      previousBalance: money('Previous Balance'),
      printedCharges,
      printedCredits,
      parsedDebitTotal: debitTotal,
      parsedCreditTotal: creditTotal,
      reconciled: printedCharges != null && printedCredits != null ? debitTotal === printedCharges && creditTotal === printedCredits : false,
      totals: {
        spends: debitTotal,
        refundsAndCashback: creditTotal - payments,
        billPayments: payments,
        owed: debitTotal - (creditTotal - payments),
      },
    },
  };
}

function appendDetails(row, extra) {
  const text = String(extra || '').trim();
  if (text) row.details = `${row.details} ${text}`;
}

function toPaise(str) {
  const cleaned = String(str).replace(/,/g, '');
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}
