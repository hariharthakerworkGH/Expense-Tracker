// HDFC Bank savings account statement - the self-service "Statement of
// Account" export from NetBanking, as opposed to the mailed/emailed combined
// statement (see hdfc-bank-savings.js). Same bank and account, different
// template entirely: 2-digit years, an extra Chq./Ref.No. column, and only
// ONE of withdrawal/deposit is ever printed (never a "0.00" for the other),
// so direction has to be inferred from how the running balance moved rather
// than from which column has a value.
//
// Each transaction's date+narration-start, and separately its numbers line
// (ref no, value date, amount, balance), can land in either order depending
// on how the narration wraps - sometimes combined on one line, sometimes
// with narration continuing both before AND after the numbers line. A
// single forward pass tracks whatever's "open" and attaches trailing
// continuation lines to whichever row was most recently completed.
export const id = 'hdfc-bank-savings-netbanking';
export const accountType = 'bank';
export const issuerLabel = 'HDFC Bank';

const DATE_START_RE = /^(\d{2})\/(\d{2})\/(\d{2})\s*(.*)$/;
const NUMBERS_TAIL_RE = /^(.*?)\S+\s+\d{2}\/\d{2}\/\d{2}\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/;
const ACCOUNT_NUMBER_RE = /:\s*(\d{12,18})\b/;
// Not anchored to "Statement of account" immediately before "From:" - the
// text layout reconstruction can put "Statement of account" AFTER the
// From/To dates instead of before them, depending on where pdf.js's
// left-to-right, top-to-bottom sort lands relative to pypdf's.
const PERIOD_RE = /\bFrom\s*:\s*(\d{2}\/\d{2}\/\d{4})\s*To\s*:\s*(\d{2}\/\d{2}\/\d{4})/i;
const SUMMARY_RE = /^([\d,]+\.\d{2})\s+(\d+)\s+(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/m;

export function detect(text) {
  return /HDFC Bank/i.test(text) && /Withdrawal Amt/i.test(text) && /Deposit Amt/i.test(text);
}

// The account's letterhead (address, IFSC, customer ID, page numbers) repeats
// on every page and - because of how the PDF text layout interleaves it with
// the transaction table - can land chronologically between two transactions
// instead of neatly before or after all of them. None of it looks like a
// real narration line: it's either a "Label : value" pair or one of a fixed
// set of boilerplate phrases, so it's filtered out before narration ever
// gets accumulated, rather than trying to bound it by position.
const BOILERPLATE_RE = /^\*|^[A-Za-z][A-Za-z0-9 ./]*:\s|^(MR\.|HDFC BANK LIMITED|JOINT HOLDERS|STATEMENT SUMMARY|Generated On|This is a computer|Contents of this statement|State account branch|HDFC Bank GSTIN|Registered Office|Page No)/;
const MAX_NARRATION_PARTS = 3;

export function parse(text) {
  const rawLines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // The letterhead and footer are reprinted on every page, so any line that
  // appears more than once is page furniture. Real narration fragments carry
  // a unique reference number, so they never repeat. This catches the
  // address block and wrapped footer sentences without hardcoding them.
  const seenCount = new Map();
  for (const l of rawLines) seenCount.set(l, (seenCount.get(l) || 0) + 1);

  const lines = rawLines.filter((l) => !BOILERPLATE_RE.test(l) && !(seenCount.get(l) > 1 && !DATE_START_RE.test(l)));
  const rows = [];
  let currentDate = null;
  let narrationParts = [];
  let awaitingNumbers = false;

  for (const line of lines) {
    const dm = line.match(DATE_START_RE);
    const searchText = dm ? dm[4] : line;
    const nm = searchText.match(NUMBERS_TAIL_RE);

    if (dm && !nm) {
      currentDate = toIsoDate2(dm[1], dm[2], dm[3]);
      narrationParts = [dm[4]];
      awaitingNumbers = true;
      continue;
    }

    if (nm) {
      // A line carrying both the date and the numbers is a complete
      // transaction on its own - anything accumulated before it belongs to
      // the page furniture, not to this row, so start its narration fresh.
      if (dm) {
        currentDate = toIsoDate2(dm[1], dm[2], dm[3]);
        narrationParts = [];
      }
      const leadNarration = nm[1].trim();
      const parts = leadNarration ? [...narrationParts, leadNarration] : narrationParts;
      rows.push({
        date: currentDate,
        narrationParts: parts,
        _amount: toNumber(nm[2]),
        _balance: toNumber(nm[3]),
      });
      narrationParts = [];
      awaitingNumbers = false;
      continue;
    }

    // Plain continuation line - trailing text belongs to the row just
    // completed, unless we're still waiting for that row's numbers line.
    // Capped: real narration wraps at most a couple of lines, so anything
    // beyond that is almost certainly stray letterhead content that slipped
    // past the boilerplate filter, not a real continuation.
    if (rows.length > 0 && !awaitingNumbers) {
      const lastRow = rows[rows.length - 1];
      if (lastRow.narrationParts.length < MAX_NARRATION_PARTS) lastRow.narrationParts.push(line);
    } else if (narrationParts.length < MAX_NARRATION_PARTS) {
      narrationParts.push(line);
    }
  }

  const meta = { rowCount: rows.length };
  const summaryMatch = text.match(SUMMARY_RE);
  let runningBalance = summaryMatch ? toNumber(summaryMatch[1]) : null;

  const normalizedRows = rows.map((r, i) => {
    let direction;
    if (runningBalance != null) {
      direction = r._balance > runningBalance ? 'credit' : 'debit';
      runningBalance = r._balance;
    } else {
      // No summary line found - fall back to comparing against the previous
      // row's balance; the very first row's direction can't be determined
      // this way, so default it to debit (the common case) and flag it.
      direction = i === 0 ? 'debit' : r._balance > rows[i - 1]._balance ? 'credit' : 'debit';
    }
    return {
      date: r.date,
      description: r.narrationParts.join(' ').replace(/\s+/g, ' ').trim(),
      amount: Math.round(r._amount * 100),
      direction,
    };
  });

  const drCount = normalizedRows.filter((r) => r.direction === 'debit').length;
  const crCount = normalizedRows.filter((r) => r.direction === 'credit').length;
  const debitTotal = normalizedRows.filter((r) => r.direction === 'debit').reduce((s, r) => s + r.amount, 0);
  const creditTotal = normalizedRows.filter((r) => r.direction === 'credit').reduce((s, r) => s + r.amount, 0);

  if (summaryMatch) {
    meta.statedOpeningBalance = toNumber(summaryMatch[1]);
    meta.statedDrCount = parseInt(summaryMatch[2], 10);
    meta.statedCrCount = parseInt(summaryMatch[3], 10);
    meta.statedDebitTotal = Math.round(toNumber(summaryMatch[4]) * 100);
    meta.statedCreditTotal = Math.round(toNumber(summaryMatch[5]) * 100);
    meta.statedClosingBalance = toNumber(summaryMatch[6]);
    meta.computedClosingBalance = rows.length ? rows[rows.length - 1]._balance : meta.statedOpeningBalance;
    meta.reconciled =
      Math.abs(meta.computedClosingBalance - meta.statedClosingBalance) < 0.01 &&
      drCount === meta.statedDrCount &&
      crCount === meta.statedCrCount &&
      debitTotal === meta.statedDebitTotal &&
      creditTotal === meta.statedCreditTotal;
  }

  const accountMatch = text.match(ACCOUNT_NUMBER_RE);
  meta.accountLast4 = accountMatch ? accountMatch[1].slice(-4) : null;

  const periodMatch = text.match(PERIOD_RE);
  if (periodMatch) {
    meta.periodStart = toIsoDate4(periodMatch[1]);
    meta.periodEnd = toIsoDate4(periodMatch[2]);
  }

  return { rows: normalizedRows, meta };
}

function toIsoDate2(dd, mm, yy) {
  return `20${yy}-${mm}-${dd}`;
}

function toIsoDate4(ddmmyyyy) {
  const [dd, mm, yyyy] = ddmmyyyy.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

function toNumber(str) {
  return parseFloat(str.replace(/,/g, ''));
}
