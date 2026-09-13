import { getAll } from '../db.js';
import { formatCurrency } from '../format.js';
import { categoryStyle } from '../category-style.js';
import { extractMerchantKey } from '../merchant-rules.js';
import { categorySlices } from '../splits.js';
import { spendingMonthOf, accountMap } from '../spending-month.js';
import { cycleAwareEnabled } from '../budgets.js';

// A month's spending told as a handful of single-idea cards you step through,
// instead of a wall of figures. Everything is computed on the device from
// transactions already stored - nothing is sent anywhere.

let monthOffset = 0; // 0 = latest month with activity, 1 = the month before it
let cardIndex = 0;

export async function render(container, params = {}) {
  if (params.reset !== false) {
    monthOffset = 0;
    cardIndex = 0;
  }
  const [transactions, categories, accounts, cycleAware] = await Promise.all([
    getAll('transactions'),
    getAll('categories'),
    getAll('accounts'),
    cycleAwareEnabled(),
  ]);
  // Tag each transaction with the month it actually belongs to, so a card
  // purchase after the statement day is recapped in the month it gets billed.
  const byId = accountMap(accounts);
  const spendable = transactions
    .filter((t) => !t.isTransfer)
    .map((t) => ({ ...t, month: spendingMonthOf(t, byId.get(t.accountId), cycleAware) }));

  const months = [...new Set(spendable.map((t) => t.month))].sort().reverse();
  if (months.length === 0) {
    container.innerHTML = '<p class="empty">Nothing to recap yet. Import a statement or add a few expenses first.</p>';
    return;
  }

  const month = months[Math.min(monthOffset, months.length - 1)];
  const prevMonth = months[Math.min(monthOffset + 1, months.length - 1)];
  const cards = buildCards(spendable, categories, month, prevMonth === month ? null : prevMonth);
  cardIndex = Math.min(cardIndex, cards.length - 1);

  container.innerHTML = `
    <div class="segmented" id="recap-months">
      <button type="button" class="seg-btn" id="recap-older" ${monthOffset >= months.length - 1 ? 'disabled' : ''}>‹ Older</button>
      <button type="button" class="seg-btn active">${monthLabel(month)}</button>
      <button type="button" class="seg-btn" id="recap-newer" ${monthOffset === 0 ? 'disabled' : ''}>Newer ›</button>
    </div>
    <div class="recap-deck" id="recap-deck">${cards[cardIndex]}</div>
    <div class="recap-nav">
      <button type="button" class="btn-tiny" id="recap-prev" ${cardIndex === 0 ? 'disabled' : ''}>Back</button>
      <div class="recap-dots">
        ${cards.map((_, i) => `<button type="button" class="recap-dot ${i === cardIndex ? 'active' : ''}" data-i="${i}" aria-label="Card ${i + 1}"></button>`).join('')}
      </div>
      <button type="button" class="btn-tiny primary" id="recap-next" ${cardIndex === cards.length - 1 ? 'disabled' : ''}>Next</button>
    </div>
  `;

  const go = (i) => {
    cardIndex = Math.max(0, Math.min(cards.length - 1, i));
    render(container, { reset: false });
  };
  container.querySelector('#recap-prev').addEventListener('click', () => go(cardIndex - 1));
  container.querySelector('#recap-next').addEventListener('click', () => go(cardIndex + 1));
  container.querySelectorAll('.recap-dot').forEach((d) => d.addEventListener('click', () => go(Number(d.dataset.i))));

  const older = container.querySelector('#recap-older');
  const newer = container.querySelector('#recap-newer');
  older.addEventListener('click', () => {
    monthOffset++;
    cardIndex = 0;
    render(container, { reset: false });
  });
  newer.addEventListener('click', () => {
    monthOffset = Math.max(0, monthOffset - 1);
    cardIndex = 0;
    render(container, { reset: false });
  });

  // Swiping between cards is how anyone expects a deck like this to work.
  const deck = container.querySelector('#recap-deck');
  let startX = null;
  deck.addEventListener('touchstart', (e) => {
    startX = e.changedTouches[0].clientX;
  }, { passive: true });
  deck.addEventListener('touchend', (e) => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 45) go(cardIndex + (dx < 0 ? 1 : -1));
    startX = null;
  }, { passive: true });
}

function buildCards(transactions, categories, month, prevMonth) {
  const inMonth = transactions.filter((t) => t.month === month);
  const debits = inMonth.filter((t) => t.direction === 'debit');
  const credits = inMonth.filter((t) => t.direction === 'credit');
  const spent = debits.reduce((s, t) => s + t.amount, 0);
  const received = credits.reduce((s, t) => s + t.amount, 0);

  const cards = [];

  // 1. The headline
  const today = new Date();
  const isCurrentMonth = month === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  let comparison = '';
  if (prevMonth) {
    const prevAll = transactions.filter((t) => t.month === prevMonth && t.direction === 'debit');
    // A month still in progress must be compared against the same stretch of
    // the previous one - thirteen days against a full month always looks like
    // a triumph. And a month you only hold the tail of (an old statement's
    // last few days) can't be compared at all: it produces "3657% up".
    const cutoff = isCurrentMonth ? `${prevMonth}-${String(today.getDate()).padStart(2, '0')}` : `${prevMonth}-31`;
    const prevDebits = prevAll.filter((t) => t.date <= cutoff);
    const prevSpent = prevDebits.reduce((s, t) => s + t.amount, 0);

    if (prevSpent > 0 && coveredDays(prevAll) >= 20) {
      const diff = spent - prevSpent;
      const pct = Math.round((diff / prevSpent) * 100);
      const against = isCurrentMonth ? `the same days of ${monthLabel(prevMonth)}` : monthLabel(prevMonth);
      comparison =
        diff === 0
          ? `Exactly the same as ${against}.`
          : `That's ${formatCurrency(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${against} — ${Math.abs(pct)}% ${diff > 0 ? 'up' : 'down'}.`;
    }
  }
  cards.push(
    card(
      'The damage',
      formatCurrency(spent),
      `${debits.length} transactions${isCurrentMonth ? ` so far in ${monthLabel(month)}` : ` across ${monthLabel(month)}`}. ${comparison}`
    )
  );

  // 2. Where it went
  const byCategory = new Map();
  for (const t of debits) {
    for (const slice of categorySlices(t)) {
      const key = slice.categoryId || 'uncategorized';
      byCategory.set(key, (byCategory.get(key) || 0) + slice.amount);
    }
  }
  const topCat = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCat) {
    const name = topCat[0] === 'uncategorized' ? 'Uncategorized' : categories.find((c) => c.id === topCat[0])?.name || 'Uncategorized';
    const share = spent > 0 ? Math.round((topCat[1] / spent) * 100) : 0;
    cards.push(
      card(
        'Biggest category',
        `${categoryStyle(name).icon} ${escapeHtml(name)}`,
        `${formatCurrency(topCat[1])} — that's ${share}% of everything you spent this month.`,
        true
      )
    );
  }

  // 3. Most visited merchant
  const byMerchant = new Map();
  for (const t of debits) {
    const key = extractMerchantKey(t.rawDescription);
    if (!key) continue;
    if (!byMerchant.has(key)) byMerchant.set(key, { count: 0, total: 0, label: t.rawDescription });
    const m = byMerchant.get(key);
    m.count++;
    m.total += t.amount;
  }
  const topMerchant = [...byMerchant.values()].sort((a, b) => b.count - a.count || b.total - a.total)[0];
  if (topMerchant && topMerchant.count > 1) {
    cards.push(
      card(
        'Your regular',
        escapeHtml(shorten(topMerchant.label)),
        `${topMerchant.count} times this month, ${formatCurrency(topMerchant.total)} in total. That's ${formatCurrency(Math.round(topMerchant.total / topMerchant.count))} a visit.`,
        true
      )
    );
  }

  // 4. The single biggest hit
  const biggest = [...debits].sort((a, b) => b.amount - a.amount)[0];
  if (biggest) {
    cards.push(
      card(
        'Biggest single spend',
        formatCurrency(biggest.amount),
        `${escapeHtml(shorten(biggest.rawDescription))} on ${new Date(biggest.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}.`
      )
    );
  }

  // 5. Days you spent nothing
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const daysElapsed = isCurrentMonth ? today.getDate() : daysInMonth;
  const spendDays = new Set(debits.map((t) => t.date)).size;
  const quietDays = Math.max(0, daysElapsed - spendDays);
  cards.push(
    card(
      'Quiet days',
      `${quietDays}`,
      quietDays === 0
        ? `You spent something every single day${isCurrentMonth ? ' so far' : ''}. Impressive, in a way.`
        : `${quietDays} day${quietDays === 1 ? '' : 's'} out of ${daysElapsed} where nothing left your accounts.`
    )
  );

  // 6. Net position
  cards.push(
    card(
      'In versus out',
      `${received >= spent ? '+' : '-'}${formatCurrency(Math.abs(received - spent))}`,
      `${formatCurrency(received)} came in, ${formatCurrency(spent)} went out. ${
        received >= spent ? 'You ended the month ahead.' : 'You spent more than you brought in.'
      }`
    )
  );

  return cards;
}

// How many days lie between the first and last transaction of a set - a rough
// but reliable read on whether a month's data is complete or just a fragment.
function coveredDays(rows) {
  if (rows.length === 0) return 0;
  const dates = rows.map((t) => t.date).sort();
  const first = new Date(dates[0]);
  const last = new Date(dates[dates.length - 1]);
  return Math.round((last - first) / 86400000) + 1;
}

function card(kicker, value, line, small = false) {
  return `
    <div class="recap-card">
      <p class="recap-kicker">${kicker}</p>
      <p class="recap-stat-value ${small ? 'small' : ''}">${value}</p>
      <p class="recap-line">${line}</p>
    </div>
  `;
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function shorten(desc) {
  const clean = desc.replace(/\s+/g, ' ').trim();
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
