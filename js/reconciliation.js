// Matches freshly-parsed statement rows against transactions you already
// logged on the same account - by hand, or from a bank alert you shared - so
// importing a statement tells you what you missed (or what showed up that you
// didn't expect) instead of creating duplicates for everything you'd already
// tracked.
const MAX_DAYS_APART = 3;

export function matchAgainstManualEntries(rows, loggedTxns) {
  const pool = loggedTxns.map((t) => ({ ...t, _claimed: false }));

  // Pass 1 - certain matches. A UPI alert carries the same reference number
  // the bank prints on the statement, so there's no need to guess by amount
  // and date; and a guess could pair the wrong two of several equal payments.
  for (const row of rows) {
    const haystack = `${row.description || ''} ${row.ref || ''}`;
    const match = pool.find(
      (m) => !m._claimed && m.alertRef && m.direction === row.direction && m.amount === row.amount && haystack.includes(m.alertRef)
    );
    if (match) claim(row, match);
  }

  // Pass 2 - same amount and direction within a few days (card spends often
  // post a day or two after the alert). The closest date wins, so two equal
  // spends in the same week each pair with the right row.
  for (const row of rows) {
    if (row._matchedManualId) continue;
    const match = pool
      .filter((m) => !m._claimed && m.direction === row.direction && m.amount === row.amount && daysApart(m.date, row.date) <= MAX_DAYS_APART)
      .sort((a, b) => daysApart(a.date, row.date) - daysApart(b.date, row.date))[0];
    if (match) claim(row, match);
  }

  const unmatchedManual = pool.filter((m) => !m._claimed).map(({ _claimed, ...rest }) => rest);
  return { unmatchedManual };
}

function claim(row, match) {
  match._claimed = true;
  row._matchedManualId = match.id;
  row._matchedSource = match.source;
  // The statement row replaces the logged one, so decisions you made on the
  // logged copy must survive the swap. A category you picked beats the one the
  // merchant rules guessed for the statement row.
  if (match.categoryId) row.categoryId = match.categoryId;
  row._carry = {
    splits: match.splits,
    isTransfer: match.isTransfer === true,
    transferManual: match.transferManual === true,
    notes: match.notes || null,
    // Kept so the same bank alert shared again later is still recognised as
    // already saved, after this row has replaced the alert's own entry.
    alertKey: match.alertKey || null,
    alertRef: match.alertRef || null,
  };
}

function daysApart(dateA, dateB) {
  return Math.abs((new Date(dateA) - new Date(dateB)) / (1000 * 60 * 60 * 24));
}
