// Reads bank and card alert messages - an SMS, or the text of an alert email
// shared into the app - and turns each one into a draft transaction.
//
// The known formats below were written against real alerts from HDFC Bank and
// ICICI Bank, not guessed from the internet. Banks change their wording often,
// so anything that matches none of them still gets a best-effort read (amount,
// card or account digits, date) marked as partial, and nothing is ever saved
// without being shown to you first.

const AMOUNT = String.raw`([\d,]+(?:\.\d{1,2})?)`;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const FORMATS = [
  {
    id: 'hdfc-card-spend',
    re: new RegExp(String.raw`Spent\s+Rs\.?\s*${AMOUNT}\s+On\s+HDFC\s+Bank\s+Card\s+(\d{4})\s+At\s+(.+?)\s+On\s+(\d{4})-(\d{2})-(\d{2}):(\d{2}:\d{2})(?::\d{2})?`, 'i'),
    build: (m) => ({
      kind: 'card-spend',
      bank: 'HDFC',
      instrument: 'card',
      direction: 'debit',
      amount: m[1],
      last4: m[2],
      party: m[3],
      date: isoDate(m[4], m[5], m[6]),
      time: m[7],
    }),
  },
  {
    id: 'hdfc-debit-card-atm',
    re: new RegExp(String.raw`Withdrawn\s+Rs\.?\s*${AMOUNT}\s+From\s+HDFC\s+Bank\s+Card\s+x(\d{4})\s+At\s+(.+?)\s+On\s+(\d{4})-(\d{2})-(\d{2}):(\d{2}:\d{2})(?::\d{2})?`, 'i'),
    build: (m) => ({
      kind: 'atm-withdrawal',
      bank: 'HDFC',
      instrument: 'debit-card',
      direction: 'debit',
      amount: m[1],
      last4: m[2],
      party: m[3].replace(/^\+/, ''),
      date: isoDate(m[4], m[5], m[6]),
      time: m[7],
    }),
  },
  {
    id: 'hdfc-upi-sent',
    re: new RegExp(String.raw`Sent\s+Rs\.?\s*${AMOUNT}\s+From\s+HDFC\s+Bank\s+A\/C\s+\*?(\d{4})\s+To\s+(.+?)\s+On\s+(\d{2})\/(\d{2})\/(\d{2})\s+Ref\s+(\d+)`, 'i'),
    build: (m) => ({
      kind: 'upi-sent',
      bank: 'HDFC',
      instrument: 'account',
      direction: 'debit',
      amount: m[1],
      last4: m[2],
      party: m[3],
      date: isoDate(`20${m[6]}`, m[5], m[4]),
      ref: m[7],
    }),
  },
  {
    id: 'hdfc-upi-credit',
    re: new RegExp(String.raw`Rs\.?\s*${AMOUNT}\s+credited\s+to\s+HDFC\s+Bank\s+A\/c\s+(?:XX|\*)?(\d{4})\s+on\s+(\d{2})-(\d{2})-(\d{2})\s+from\s+VPA\s+(\S+)\s+\(UPI\s+(\d+)\)`, 'i'),
    build: (m) => ({
      kind: 'upi-credit',
      bank: 'HDFC',
      instrument: 'account',
      direction: 'credit',
      amount: m[1],
      last4: m[2],
      party: m[6],
      date: isoDate(`20${m[5]}`, m[4], m[3]),
      ref: m[7],
    }),
  },
  {
    id: 'icici-card-spend',
    re: new RegExp(String.raw`INR\s+${AMOUNT}\s+spent\s+using\s+ICICI\s+Bank\s+Card\s+XX(\d{4})\s+on\s+(\d{2})-([A-Za-z]{3})-(\d{2})\s+on\s+(.+?)\.\s+Avl\s+Limit`, 'i'),
    build: (m) => ({
      kind: 'card-spend',
      bank: 'ICICI',
      instrument: 'card',
      direction: 'debit',
      amount: m[1],
      last4: m[2],
      party: m[6],
      date: isoDate(`20${m[5]}`, MONTHS[m[4].toLowerCase()], m[3]),
    }),
  },
];

// Messages that mention an amount and a card but are not transactions.
const NOT_A_TRANSACTION = [
  { re: /\b(OTP|one[\s-]?time\s+password|verification\s+code)\b/i, reason: "That's a one-time password message, not a transaction." },
  { re: /\b(declined|was\s+not\s+successful|unsuccessful|failed)\b/i, reason: "That transaction didn't go through, so there's nothing to log." },
];

// --- Splitting -----------------------------------------------------------

// Sharing several messages at once arrives as one block of text. Each known
// alert found in it becomes its own draft; with none found, the whole text is
// treated as a single alert.
export function splitAlerts(text) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];

  // A blank line always separates two messages. Bank alerts themselves never
  // contain one - the UPI alerts span several lines, but with no gap - so this
  // can't cut an alert in half. It also keeps a message we can't read (an OTP,
  // say) as its own item instead of letting it vanish into its neighbour.
  return clean.split(/\n[ \t]*\n+/).flatMap(splitBlock);
}

// Within one block, several known alerts run together with no blank line
// between them; each becomes its own piece.
function splitBlock(block) {
  const text = block.trim();
  if (!text) return [];

  const starts = [];
  for (const f of FORMATS) {
    const global = new RegExp(f.re.source, 'gi');
    let m;
    while ((m = global.exec(text))) {
      starts.push(m.index);
      if (m.index === global.lastIndex) global.lastIndex++;
    }
  }
  if (starts.length <= 1) return [text];

  // Each alert runs from its own start to the next one's.
  const sorted = [...new Set(starts)].sort((a, b) => a - b);
  // Anything before the first match (a "Credit Alert!" heading, say) belongs
  // to the first alert rather than becoming a stray fragment.
  sorted[0] = 0;
  return sorted.map((start, i) => text.slice(start, sorted[i + 1] ?? text.length).trim()).filter(Boolean);
}

// --- Parsing -------------------------------------------------------------

export function parseAlert(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'Nothing to read.' };

  for (const f of FORMATS) {
    const m = raw.match(f.re);
    if (!m) continue;
    const built = f.build(m);
    const amount = toPaise(built.amount);
    if (amount == null || amount <= 0 || !built.date) continue;
    return finish({ ...built, amount, format: f.id, confidence: 'exact' });
  }

  for (const n of NOT_A_TRANSACTION) {
    if (n.re.test(raw)) return { ok: false, reason: n.reason };
  }

  return parseGeneric(raw);
}

// A best-effort read of an alert in a wording we haven't seen. It never guesses
// the direction when the message is ambiguous; you pick it on the confirm card.
function parseGeneric(raw) {
  const amountMatch = raw.match(/(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const amount = amountMatch ? toPaise(amountMatch[1]) : null;
  if (amount == null || amount <= 0) {
    return { ok: false, reason: "Couldn't find an amount in that message." };
  }

  const creditWords = /\b(credited|received|refund(?:ed)?|reversed|reversal|cashback)\b/i.test(raw);
  const debitWords = /\b(debited|spent|sent|withdrawn|paid|purchase|used\s+for)\b/i.test(raw);
  const direction = creditWords && !debitWords ? 'credit' : debitWords && !creditWords ? 'debit' : null;

  const digits = raw.match(/\b(?:card|a\/c|acct|account)\b[^\d]{0,24}?(?:ending(?:\s+with)?\s*|[x*]+)?(\d{4})\b/i);
  const isCard = /\bcard\b/i.test(raw);
  const isDebitCard = /\bdebit\s+card\b|\bDC\s+\d{4}\b/i.test(raw);

  const party = (raw.match(/\b(?:at|to|towards|Info:)\s+([A-Za-z0-9&@.\-*' ]{2,60}?)(?=\s+on\b|\s+Avl\b|\.\s|\.$|\n|$)/i) || [])[1];
  const ref = (raw.match(/\b(?:Ref(?:erence)?(?:\s*No)?\.?|UPI(?:\s*Ref)?)\s*:?\s*(\d{9,})/i) || [])[1];

  return finish({
    kind: 'unknown',
    bank: /HDFC/i.test(raw) ? 'HDFC' : /ICICI/i.test(raw) ? 'ICICI' : null,
    instrument: isDebitCard ? 'debit-card' : isCard ? 'card' : digits ? 'account' : null,
    direction,
    amount,
    last4: digits ? digits[1] : null,
    party: party || null,
    date: findDate(raw),
    time: null,
    ref: ref || null,
    format: 'generic',
    confidence: 'partial',
    // A payment arriving on a card is the bill being paid, not income.
    billPayment: /received\s+towards|payment\s+(?:of\s+)?(?:Rs\.?|INR)?.*received|thank\s+you\s+for\s+(?:your\s+)?payment/i.test(raw),
  });
}

function finish(p) {
  const party = p.party ? p.party.replace(/\s+/g, ' ').replace(/[.,;:\s]+$/, '').trim().slice(0, 60) : null;
  return {
    ok: true,
    kind: p.kind,
    format: p.format,
    confidence: p.confidence,
    bank: p.bank || null,
    instrument: p.instrument || null,
    direction: p.direction || null,
    amount: p.amount,
    last4: p.last4 || null,
    party,
    date: p.date || null,
    time: p.time || null,
    ref: p.ref || null,
    billPayment: Boolean(p.billPayment),
    description: describe(p.kind, party),
    // Moving money is not spending: cash out of an ATM, or paying a card bill.
    suggestTransfer: p.kind === 'atm-withdrawal' || Boolean(p.billPayment),
  };
}

function describe(kind, party) {
  if (kind === 'atm-withdrawal') return `Cash withdrawal${party ? ` · ${party}` : ''}`;
  if (kind === 'upi-sent') return `${party || 'UPI payment'} (UPI)`;
  if (kind === 'upi-credit') return `UPI from ${party || 'unknown'}`;
  return party || 'Bank alert';
}

// --- Identity, accounts and duplicates -----------------------------------

// Two drafts with the same fingerprint are the same alert shared twice.
// Includes the time and reference where the bank gives them, so two genuine
// ₹50 chai payments on the same card still count as two.
export function alertFingerprint(p) {
  return [p.bank || '', p.instrument || '', p.last4 || '', p.direction || '', p.amount, p.date || '', p.time || '', p.ref || ''].join('|');
}

export function resolveAccount(p, accounts, transactions) {
  if (!p.last4) return null;

  // An account you pointed this card at once before.
  const linked = accounts.find((a) => Array.isArray(a.linkedLast4s) && a.linkedLast4s.includes(p.last4));
  if (linked) return linked;

  const wantType = p.instrument === 'card' ? 'card' : p.instrument === 'account' ? 'bank' : null;
  const byDigits = accounts.filter((a) => a.last4 === p.last4 && (!wantType || a.type === wantType));
  if (byDigits.length === 1) return byDigits[0];

  // A debit card's number isn't the account's, but the bank's own statement
  // prints it on every ATM and card row ("ATW-416021XXXXXX9744-..."), which
  // is enough to work out which account it belongs to.
  if (p.instrument === 'debit-card' || p.instrument === null) {
    const pattern = new RegExp(`[xX*]{2,}${p.last4}(?!\\d)`);
    const bankIds = new Set(accounts.filter((a) => a.type === 'bank').map((a) => a.id));
    const owners = new Set(transactions.filter((t) => bankIds.has(t.accountId) && pattern.test(t.rawDescription || '')).map((t) => t.accountId));
    if (owners.size === 1) return accounts.find((a) => a.id === [...owners][0]) || null;
  }

  return null;
}

const daysApart = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

// Is this alert already in the app? Returns how sure, and what it matched.
//   same-alert : this exact alert was already added
//   reference  : the statement row carries the same UPI reference - certain
//   likely     : same account, amount and direction within 3 days - probably,
//                but two identical spends a day apart are possible, so ask
export function findExisting(p, accountId, transactions) {
  const key = alertFingerprint(p);
  const sameAlert = transactions.find((t) => t.alertKey === key);
  if (sameAlert) return { kind: 'same-alert', transaction: sameAlert };
  if (!accountId) return null;

  const onAccount = transactions.filter((t) => t.accountId === accountId && t.direction === p.direction && t.amount === p.amount);

  if (p.ref) {
    const byRef = onAccount.find((t) => t.alertRef === p.ref || t.bankRef === p.ref || (t.rawDescription || '').includes(p.ref));
    if (byRef) return { kind: 'reference', transaction: byRef };
  }

  if (!p.date) return null;
  const near = onAccount.filter((t) => daysApart(t.date, p.date) <= 3).sort((a, b) => daysApart(a.date, p.date) - daysApart(b.date, p.date));
  return near.length ? { kind: 'likely', transaction: near[0] } : null;
}

// --- Helpers -------------------------------------------------------------

function toPaise(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

function isoDate(y, m, d) {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!year || !month || !day || month > 12 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  // Rejects impossible dates like 31 February instead of rolling them over.
  if (date.getMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function findDate(raw) {
  let m = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = raw.match(/\b(\d{2})[/-](\d{2})[/-](\d{2}|\d{4})\b/);
  if (m) return isoDate(m[3].length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);
  m = raw.match(/\b(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[,\s-]+(\d{2}|\d{4})\b/);
  if (m && MONTHS[m[2].toLowerCase()]) return isoDate(m[3].length === 2 ? `20${m[3]}` : m[3], MONTHS[m[2].toLowerCase()], m[1]);
  return null;
}
