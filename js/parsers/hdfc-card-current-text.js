// HDFC credit card "current transactions" - the unbilled list for the cycle
// that hasn't been billed yet. HDFC offers no file download for it, so this
// reads the text you copy from NetBanking instead. Each transaction arrives as:
//
//   14 Sept 2026
//   10% Swiggy Cashback
//   ₹49.00    credit icon
//
// (the "credit icon"/"debit icon" words are the icons' labels, copied along
// with the text). A description can take two lines, e.g. a second
// "ELIGIBLE FOR SMARTEMI" label. A heading line ending in the card's last four
// digits - "Swiggy Credit Card 6671" - says which card the rows below it are
// for; several headings means several cards pasted at once.
//
// There are no printed totals in this list, so unlike statements it can't be
// reconciled automatically. The review screen shows the computed totals so
// they can be checked against the unbilled figure HDFC shows.
export const id = 'hdfc-card-current-text';
export const accountType = 'card';
export const issuerLabel = 'HDFC Bank';
// Rows from here are a snapshot of an unbilled cycle, superseded by the next
// paste and finally by the monthly statement - never a statement themselves.
export const provisional = true;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_LINE_RE = /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\s*$/i;
const AMOUNT_LINE_RE = /^₹\s*([\d,]+(?:\.\d{1,2})?)\s*(credit|debit)\s+icon\s*$/i;
// A heading: text ending in exactly four digits, seen between transactions.
const HEADING_RE = /^(?=.*[A-Za-z]).*?(\d{4})\s*$/;
// Labels HDFC prints under a merchant that aren't part of its name.
const LABEL_LINE_RE = /^(ELIGIBLE FOR SMARTEMI|CONVERT TO EMI|EMI AVAILABLE)$/i;

export function detect(text) {
  return /\b(credit|debit)\s+icon\b/i.test(text) && /₹\s*[\d,]+\.\d{2}/.test(text) && /^\s*\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{4}\s*$/im.test(text);
}

// One block of text per card, split at each heading. Text with no headings
// (a single card copied on its own) comes back as one block with no digits.
export function splitSections(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = { last4: null, heading: null, lines: [] };
  let expectingDate = true;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, ' ').trim();
    if (!line) continue;
    if (DATE_LINE_RE.test(line)) {
      expectingDate = false;
      current.lines.push(line);
      continue;
    }
    if (AMOUNT_LINE_RE.test(line)) {
      expectingDate = true;
      current.lines.push(line);
      continue;
    }
    // Only a line sitting between transactions can be a heading. Inside a
    // transaction, a description like "Upi-tfs 90310077 Kol Banchhar" also
    // ends in digits and must not be mistaken for one.
    const heading = expectingDate ? line.match(HEADING_RE) : null;
    if (heading) {
      if (current.lines.length) sections.push(current);
      current = { last4: heading[1], heading: line, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length) sections.push(current);

  return sections
    .map((s) => ({ last4: s.last4, heading: s.heading, text: s.lines.join('\n'), rowCount: s.lines.filter((l) => AMOUNT_LINE_RE.test(l)).length }))
    .filter((s) => s.rowCount > 0);
}

export function parse(text) {
  const sections = splitSections(text);
  // Called on one card's section at a time; if given several, read the first.
  const section = sections[0] || { last4: null, text: '' };
  const lines = section.text.split('\n').map((l) => l.trim()).filter(Boolean);

  const rows = [];
  let pending = null;
  for (const line of lines) {
    const dm = line.match(DATE_LINE_RE);
    if (dm) {
      // A date with no amount before the next date is an incomplete copy;
      // it's dropped rather than guessed at.
      pending = { date: isoDate(dm[3], MONTHS[dm[2].slice(0, 3).toLowerCase()], dm[1]), description: [] };
      continue;
    }
    const am = line.match(AMOUNT_LINE_RE);
    if (am) {
      if (pending && pending.date) {
        rows.push({
          date: pending.date,
          description: pending.description.join(' ').replace(/\s+/g, ' ').trim() || 'HDFC card transaction',
          amount: toPaise(am[1]),
          direction: am[2].toLowerCase() === 'credit' ? 'credit' : 'debit',
        });
      }
      pending = null;
      continue;
    }
    if (pending && !LABEL_LINE_RE.test(line)) pending.description.push(line);
  }

  const dates = rows.map((r) => r.date).sort();
  const isPayment = (r) => r.direction === 'credit' && /\b(Bppy|BBPS)\s*Cc\s*Payment|Payment\s+Received/i.test(r.description);
  const sum = (list) => list.reduce((s, r) => s + r.amount, 0);
  const debits = rows.filter((r) => r.direction === 'debit');
  const payments = rows.filter(isPayment);
  const otherCredits = rows.filter((r) => r.direction === 'credit' && !isPayment(r));

  return {
    rows,
    meta: {
      provisional: true,
      accountLast4: section.last4,
      heading: section.heading || null,
      periodStart: dates[0] || null,
      periodEnd: dates[dates.length - 1] || null,
      // Shown on the review screen so the paste can be checked by eye against
      // HDFC's own unbilled figure. There is nothing printed to reconcile to.
      totals: {
        spends: sum(debits),
        refundsAndCashback: sum(otherCredits),
        billPayments: sum(payments),
        owed: sum(debits) - sum(otherCredits),
      },
    },
  };
}

function toPaise(str) {
  const cleaned = String(str).replace(/,/g, '');
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

function isoDate(y, m, d) {
  if (!m) return null;
  const date = new Date(Number(y), m - 1, Number(d));
  if (date.getMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}
