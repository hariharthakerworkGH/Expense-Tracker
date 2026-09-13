# Expense Tracker

Manual entry, categories, summaries, statement import (HDFC Bank savings +
HDFC credit card), a review inbox for categorizing, and an accounts screen
that projects your next credit card bill from spend since the last import.
Works fully offline once installed.

## Parsers supported so far
- `js/parsers/hdfc-bank-savings.js` — HDFC Bank savings account statements
- `js/parsers/hdfc-credit-card.js` — HDFC Bank credit card statements (any
  co-branded card on HDFC's own template, not just one card product)

Each new bank/card statement format needs its own parser module added to
`js/parsers/registry.js`. Give me a real statement PDF and I'll build it the
same way — parse, then verify the totals reconcile against the statement's
own figures before trusting it.

## Credit card bill payments and double-counting
When both a bank and a card statement are imported, a debit in the bank
account paying off the card bill and a matching "payment received" credit
in the card account both represent the same money moving — not two separate
expenses. `js/transfers.js` auto-flags same-amount pairs within 5 days
across accounts as transfers, and Summary excludes them from spend totals.
You can flag/unflag any transaction by hand from the Review screen.

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

## Currency symbol
Set in `js/config.js` (`CURRENCY_SYMBOL`), defaults to ₹.

## PDF parsing
`js/vendor/pdf.min.js` and `pdf.worker.min.js` are pdf.js, downloaded once
and committed here so the app never calls out to a CDN at runtime (per the
no-third-party-calls privacy rule). Password-protected PDFs are supported —
enter the password in the Import screen; it's held in memory only for that
one parse and never written to storage.
