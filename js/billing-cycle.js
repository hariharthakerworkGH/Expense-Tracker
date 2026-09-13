// A card's billing cycle closes on the same day-of-month every statement
// (the "billingCycleDay"). Given that, and no more recent real statement,
// we can still tell which transactions belong to the currently-open cycle
// (not yet billed) so manual entries logged before any statement exists
// still land in the right bucket.
function computeCycleBoundary(billingCycleDay, today = new Date()) {
  if (!billingCycleDay) return null;
  const y = today.getFullYear();
  const m = today.getMonth();
  let boundary = new Date(y, m, billingCycleDay);
  if (boundary > today) {
    boundary = new Date(y, m - 1, billingCycleDay);
  }
  return toISODate(boundary);
}

// The open cycle's start date is whichever is later: the last real
// statement's period end, or the computed boundary from billingCycleDay.
// Transactions dated AFTER this value belong to the currently-open cycle.
export function currentCycleStart(account, importBatches) {
  const batches = importBatches.filter((b) => b.accountId === account.id).sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
  const lastImportBoundary = batches[0]?.periodEnd || null;
  const computedBoundary = computeCycleBoundary(account.billingCycleDay);

  if (lastImportBoundary && computedBoundary) {
    return lastImportBoundary > computedBoundary ? lastImportBoundary : computedBoundary;
  }
  return lastImportBoundary || computedBoundary;
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
