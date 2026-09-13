// HDFC Bank savings account statement.
// Each transaction's date, first line of narration, and all three amounts
// (withdrawal, deposit, running closing balance) share one visual row, so a
// text-layout-aware extractor keeps them on one line. Any further narration
// wrapping appears on subsequent lines with no amounts, until the next
// transaction's date line.
export const id = 'hdfc-bank-savings';
export const accountType = 'bank';
export const issuerLabel = 'HDFC Bank';

const FULL_LINE_RE = /^(\d{2})\/(\d{2})\/(\d{4})\s+(.*?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/;
const DATE_START_RE = /^\d{2}\/\d{2}\/\d{4}\b/;
const ACCOUNT_NUMBER_RE = /:\s*(\d{12,18})\b/;

export function detect(text) {
  return /HDFC Bank/i.test(text) && /Narration/.test(text) && /Withdrawals/.test(text) && /Deposits/.test(text);
}

export function parse(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(FULL_LINE_RE);
    if (!m) {
      i++;
      continue;
    }

    const [, dd, mm, yyyy, narrationStart, withdrawalStr, depositStr, closingStr] = m;
    const narrationParts = [narrationStart];
    let j = i + 1;
    while (j < lines.length && j < i + 5 && !DATE_START_RE.test(lines[j]) && !FULL_LINE_RE.test(lines[j])) {
      narrationParts.push(lines[j]);
      j++;
    }

    const withdrawal = toNumber(withdrawalStr);
    const deposit = toNumber(depositStr);
    const closingBalance = toNumber(closingStr);
    const direction = deposit > 0 ? 'credit' : 'debit';
    const amount = Math.round((direction === 'credit' ? deposit : withdrawal) * 100);

    rows.push({
      date: `${yyyy}-${mm}-${dd}`,
      description: narrationParts.join(' ').replace(/\s+/g, ' ').trim(),
      amount,
      direction,
      _closingBalance: closingBalance,
      _withdrawal: withdrawal,
      _deposit: deposit,
    });

    i = j;
  }

  const meta = reconcile(rows);
  const accountMatch = text.match(ACCOUNT_NUMBER_RE);
  meta.accountLast4 = accountMatch ? accountMatch[1].slice(-4) : null;

  return { rows: rows.map(stripInternalFields), meta };
}

function reconcile(rows) {
  if (rows.length === 0) {
    return { reconciled: null, note: 'No transactions found.' };
  }
  const first = rows[0];
  const impliedOpening = first._closingBalance - first._deposit + first._withdrawal;
  let running = impliedOpening;
  for (const r of rows) {
    running = running - r._withdrawal + r._deposit;
  }
  const statedClosing = rows[rows.length - 1]._closingBalance;
  const reconciled = Math.abs(running - statedClosing) < 0.01;
  return {
    reconciled,
    impliedOpeningBalance: impliedOpening,
    computedClosingBalance: running,
    statedClosingBalance: statedClosing,
    rowCount: rows.length,
  };
}

function stripInternalFields(row) {
  const { _closingBalance, _withdrawal, _deposit, ...rest } = row;
  return rest;
}

function toNumber(str) {
  return parseFloat(str.replace(/,/g, ''));
}
