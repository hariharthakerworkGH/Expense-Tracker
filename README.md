# Expense Tracker — Phase 1

Manual entry, categories, and this-month/last-month summaries. No imports yet
(that's Phase 2+). Works fully offline once installed.

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
