# Expense Tracker

Manual entry, categories, a dashboard (net position, things needing
attention, upcoming bills), statement import for three issuers so far, a
Transactions screen for categorizing and editing anything, and an Accounts
screen that projects your next credit card bill from spend since the last
import. Works fully offline once installed.

## Parsers supported so far
- `js/parsers/hdfc-bank-savings.js` — HDFC Bank savings account statements
- `js/parsers/hdfc-credit-card.js` — HDFC Bank credit card statements (any
  co-branded card on HDFC's own template - Swiggy, Millennia, UPI RuPay, etc.)
- `js/parsers/icici-amazon-pay-credit-card.js` — ICICI Bank Amazon Pay card

Each new bank/card statement format needs its own parser module added to
`js/parsers/registry.js`. Give me a real statement PDF and I'll build it the
same way — parse, then verify the totals reconcile against the statement's
own figures before trusting it.

## Manual entries against any account, and statement reconciliation
The Add screen lets you log a manual entry against any account, not just
Cash — including a credit card, before that month's statement even exists.
When you later import that card's statement, `js/reconciliation.js` matches
statement rows against your manual entries (same account, amount, and date
within 3 days): a match replaces the manual entry with the statement's own
data (keeping whatever category you'd already set), and anything left
unmatched shows up in two places — manual entries the statement didn't
confirm are listed on the import screen so you can double-check them, and
statement rows you hadn't logged by hand are just new transactions to
categorize in Transactions. This is how you catch recurring auto-payments you
forgot about.

## Billing cycles
Every card account has a `billingCycleDay` (the day of month its statement
closes) — set automatically from the first statement you import, or by hand
from the Accounts screen (tap "Set billing cycle day"). `js/billing-cycle.js`
uses it to figure out the currently-open cycle even before any statement
exists for that card, so manual entries you log right after getting a card
still land in the right cycle for the spend projection.

## Credit card bill payments and double-counting
When both a bank and a card statement are imported, a debit in the bank
account paying off the card bill and a matching "payment received" credit
in the card account both represent the same money moving — not two separate
expenses. `js/transfers.js` auto-flags same-amount pairs within 5 days
across accounts as transfers, and Summary excludes them from spend totals.
You can flag/unflag any transaction by hand from the Transactions screen.

## Merchant matching (auto-categorization)
`js/merchant-rules.js` extracts a handful of "significant" words from a
description (stripping payment-gateway noise like `PAY*`/`PTM*`/`RSP*`,
value-date/ref boilerplate, and generic connector words) and matches on
word overlap rather than one exact key. That's what lets `PAY*SWIGGY
FOODBANGALORE`, `PTM*SWIGGY INBANGALORE`, and `SwiggyBENGALURU` all hit the
same rule even though the same merchant shows up differently across payment
gateways. It can't unify a merchant whose statement name shares literally no
words with the one you categorized (e.g. Swiggy trading as "BUNDL
TECHNOLOGIES" for some orders) - that needs a hand-curated alias table,
which isn't built.

## Recurring bills ("Upcoming" on the dashboard)
`js/recurring.js` scans debit history for the same merchant recurring
roughly monthly (25-36 days apart) at a roughly stable amount (within 15%),
and surfaces detected bills with a projected next due date. Detections are
upserted into the `recurring` store, so dismissing one ("Not recurring")
sticks — it won't get re-flagged next time the dashboard recomputes this.
It's a heuristic, not a guarantee: needs at least 2 occurrences, and a
brand-new bill won't show up until its second charge.

## Anomaly flags ("Needs your attention" on the dashboard)
`js/anomalies.js` flags two things among this month's debits: a spend at a
merchant meaningfully larger than that merchant's own history (average +
2 standard deviations, or 1.5x average, whichever is higher), and a
first-ever spend at a new merchant above ₹1,000. Both thresholds are
arbitrary starting points in the source file, not tuned against real data -
adjust them if they're too noisy or too quiet for how you actually spend.

## Try it locally
ES modules need a real server, not double-clicking `index.html`. From this
folder:
```
py -m http.server 5173
```
Then open `http://localhost:5173` in a browser.

## Publish to GitHub Pages
Same as Signal: push this folder to a GitHub repo and enable Pages on it
(Settings → Pages → deploy from the `main` branch, root folder). Then open
that URL on your phone and use "Add to Home Screen" to install it as a PWA.

## One thing to remember when you come back for changes
`sw.js` caches the app shell so it works offline. Every time a file changes,
bump the `CACHE_NAME` constant at the top of `sw.js` (e.g. `v1` → `v2`) or
your phone will keep showing the old cached version after you reload.

## Note on account types
The data model says account `type` is `bank|card`. Phase 1 seeds a default
`Cash` account with `type: "cash"` so manual entries have somewhere to
attach — this is a small extension beyond the original spec, done because
manual entries need an account and there's no cash type otherwise.

## Currency symbol and formatting
Symbol is set in `js/config.js` (`CURRENCY_SYMBOL`), defaults to ₹. All
amounts are formatted through `js/format.js`, which uses `Intl.NumberFormat`
with the `en-IN` locale so large numbers group the Indian way (₹12,34,567.89)
instead of the Western way (₹1,234,567.89).

## Bank balance
A bank account's balance is a snapshot: the last imported statement's own
closing balance and date (`account.knownBalance` / `knownBalanceDate`),
adjusted forward by anything dated after that. It reads "Balance unknown"
until you import at least one statement for that account.

## PDF parsing
`js/vendor/pdf.min.js` and `pdf.worker.min.js` are pdf.js, downloaded once
and committed here so the app never calls out to a CDN at runtime (per the
no-third-party-calls privacy rule). Password-protected PDFs are supported —
enter the password in the Import screen; it's held in memory only for that
one parse and never written to storage.
