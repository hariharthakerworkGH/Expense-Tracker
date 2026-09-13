// Matches freshly-parsed statement rows against manual entries you already
// logged on the same account, so importing a statement tells you what you
// missed (or what showed up that you didn't expect) instead of creating
// duplicates for everything you'd already tracked by hand.
const MAX_DAYS_APART = 3;

export function matchAgainstManualEntries(rows, manualTxns) {
  const pool = manualTxns.map((t) => ({ ...t, _claimed: false }));

  for (const row of rows) {
    const match = pool.find(
      (m) => !m._claimed && m.direction === row.direction && m.amount === row.amount && daysApart(m.date, row.date) <= MAX_DAYS_APART
    );
    if (match) {
      match._claimed = true;
      row._matchedManualId = match.id;
      if (!row.categoryId && match.categoryId) {
        row.categoryId = match.categoryId;
      }
    }
  }

  const unmatchedManual = pool.filter((m) => !m._claimed).map(({ _claimed, ...rest }) => rest);
  return { unmatchedManual };
}

function daysApart(dateA, dateB) {
  return Math.abs((new Date(dateA) - new Date(dateB)) / (1000 * 60 * 60 * 24));
}
