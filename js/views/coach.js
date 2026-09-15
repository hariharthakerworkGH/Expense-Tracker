import { formatCurrency, formatSignedCurrency, formatDateNice } from '../format.js';
import { isoLocal } from '../frequency.js';
import { categoryStyle } from '../category-style.js';
import { financialSnapshot, affordability, savingsPlan, whereToCut, observations } from '../planner.js';

// The planning screen: you pick a question, it answers with your own numbers.
//
// It is not a chatbot and does not pretend to be one. Every answer is
// computed on this device from your transactions - which is why it works
// offline, costs nothing, and never sends your spending anywhere.

let openQuestion = null;
let lastAnswer = null;

export async function render(container) {
  // The snapshot's "left to spend" is the same month figure the Summary leads
  // with, so the app never gives two different answers to the same question.
  const snapshot = await financialSnapshot();
  const notes = observations(snapshot);
  // "Can I afford this?" spreads what's left over the days until the statement.
  const cash = { ...snapshot, daysLeft: snapshot.cycle.daysToClose, runRate: snapshot.cycle.pace };

  container.innerHTML = `
    ${heroTemplate(snapshot)}

    <h3>Ask about your money</h3>
    <div class="coach-questions">
      ${questionBtn('afford', '💸', 'Can I afford this?')}
      ${questionBtn('goal', '🎯', 'Help me save for something')}
      ${questionBtn('cut', '✂️', "Where's it going wrong?")}
    </div>
    <div id="coach-panel">${panelTemplate(snapshot)}</div>

    ${
      notes.length
        ? `<h3>What I noticed</h3>
           ${notes.map((n) => noteTemplate(n)).join('')}`
        : ''
    }

    <p class="muted-note coach-footnote">Worked out on this phone from your own transactions. Nothing here is sent anywhere, and it all works with no signal.</p>
  `;

  container.querySelectorAll('.coach-q').forEach((btn) => {
    btn.addEventListener('click', () => {
      openQuestion = openQuestion === btn.dataset.q ? null : btn.dataset.q;
      lastAnswer = null;
      render(container);
    });
  });

  wirePanel(container, snapshot, cash);
}

// The forecast: at the pace your cards have been used this cycle, where does
// what's left end up by the statement day?
function heroTemplate(snapshot) {
  const c = snapshot.cycle;
  if (c.free == null || !c.salary.setUp) {
    return `
      <div class="hero">
        <p class="hero-label">Left to spend</p>
        <p class="hero-amount">—</p>
        <p class="hero-sub">Import a bank statement and put your income and salary day on Plan, and I can tell you how far your money goes.</p>
      </div>`;
  }

  const s = { runRate: c.pace };
  const projected = c.pace * c.daysToClose;
  const leftAtEnd = c.free - projected;
  const over = leftAtEnd < 0;
  const pct = c.free > 0 ? Math.min(100, Math.round((projected / c.free) * 100)) : 100;
  return `
    <div class="hero level-${c.level}">
      <p class="hero-label">💳 Cards · left to spend until ${formatDateNice(c.cycleClose || c.windowEnd)}</p>
      <p class="hero-amount ${c.free < 0 ? 'negative' : ''}">${formatSignedCurrency(c.free)}</p>
      <div class="hero-meter"><div class="hero-meter-fill ${over ? 'over' : ''}" style="width:${pct}%"></div></div>
      <p class="hero-sub">${
        s.runRate === 0
          ? `No card spending yet this cycle to set a pace from.`
          : over
            ? `At your pace of ${formatCurrency(s.runRate)} a day you'd spend ${formatCurrency(projected)} by then — ${formatCurrency(-leftAtEnd)} more than you have.`
            : `At your pace of ${formatCurrency(s.runRate)} a day you'd finish with ${formatCurrency(leftAtEnd)} to spare.`
      }</p>
      <div class="hero-split">
        <div class="hero-stat"><span class="stat-label">Your pace</span><span class="stat-value out">${formatCurrency(s.runRate)}/day</span></div>
        <div class="hero-stat"><span class="stat-label">Safe per day</span><span class="stat-value">${c.perDay > 0 ? formatCurrency(c.perDay) : '₹0'}</span></div>
      </div>
    </div>
  `;
}

function questionBtn(id, icon, label) {
  return `<button type="button" class="coach-q ${openQuestion === id ? 'active' : ''}" data-q="${id}"><span class="coach-q-icon">${icon}</span>${label}</button>`;
}

function panelTemplate(s) {
  if (openQuestion === 'afford') {
    return `
      <div class="coach-panel">
        <label class="field">
          <span>How much is it?</span>
          <div class="amount-input-wrap">
            <span class="amount-prefix">₹</span>
            <input type="number" class="amount-input" id="afford-amount" inputmode="decimal" placeholder="0">
          </div>
        </label>
        <button type="button" class="btn-primary" id="afford-go">Work it out</button>
        <div id="afford-answer">${lastAnswer === 'afford' ? '' : ''}</div>
      </div>`;
  }

  if (openQuestion === 'goal') {
    const defaultDate = new Date(s.now.getFullYear(), s.now.getMonth() + 6, s.now.getDate());
    return `
      <div class="coach-panel">
        <label class="field">
          <span>How much do you want to save?</span>
          <div class="amount-input-wrap">
            <span class="amount-prefix">₹</span>
            <input type="number" class="amount-input" id="goal-amount" inputmode="decimal" placeholder="50000">
          </div>
        </label>
        <label class="field">
          <span>By when?</span>
          <input type="date" id="goal-date" value="${isoLocal(defaultDate)}">
        </label>
        <button type="button" class="btn-primary" id="goal-go">Make a plan</button>
        <div id="goal-answer"></div>
      </div>`;
  }

  if (openQuestion === 'cut') {
    return `<div class="coach-panel" id="cut-answer">${cutAnswer(s)}</div>`;
  }

  return '';
}

function wirePanel(container, s, cash) {
  const affordGo = container.querySelector('#afford-go');
  if (affordGo) {
    const run = () => {
      const raw = parseFloat(container.querySelector('#afford-amount').value);
      const target = container.querySelector('#afford-answer');
      if (!Number.isFinite(raw) || raw <= 0) {
        target.innerHTML = '';
        return;
      }
      target.innerHTML = affordAnswer(cash, affordability(cash, Math.round(raw * 100)));
    };
    affordGo.addEventListener('click', run);
    container.querySelector('#afford-amount').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run();
    });
  }

  const sortBtn = container.querySelector('#coach-go-sort');
  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'transactions', filter: 'uncategorized' } }));
    });
  }

  const goalGo = container.querySelector('#goal-go');
  if (goalGo) {
    goalGo.addEventListener('click', () => {
      const raw = parseFloat(container.querySelector('#goal-amount').value);
      const date = container.querySelector('#goal-date').value;
      const target = container.querySelector('#goal-answer');
      if (!Number.isFinite(raw) || raw <= 0 || !date) {
        target.innerHTML = '';
        return;
      }
      target.innerHTML = goalAnswer(s, savingsPlan(s, Math.round(raw * 100), date));
    });
  }
}

function affordAnswer(s, a) {
  if (!a.known) {
    return `<div class="coach-answer"><p class="coach-verdict">I need your income first</p><p class="recap-line">Put your monthly income and salary day on the Plan screen and I can tell you whether this fits.</p></div>`;
  }

  const verdict = !a.canAfford ? 'Not right now' : a.tight ? 'It fits, but only just' : 'Yes, comfortably';
  const tone = !a.canAfford ? 'bad' : a.tight ? 'warn' : 'good';
  const until = ` until ${formatDateNice(s.cycle.cycleClose || s.cycle.windowEnd)}`;

  return `
    <div class="coach-answer">
      <p class="coach-verdict ${tone}">${verdict}</p>
      <div class="totals-card">
        <div class="totals-row"><span>Left to spend${until}</span><span>${formatSignedCurrency(s.leftToSpend)}</span></div>
        <div class="totals-row"><span>This purchase</span><span class="out">-${formatCurrency(a.amount)}</span></div>
        <div class="totals-row net"><span>Left after it</span><span class="${a.after < 0 ? 'out' : 'in'}">${formatSignedCurrency(a.after)}</span></div>
      </div>
      <p class="recap-line">${
        !a.canAfford
          ? `That's ${formatCurrency(-a.after)} more than is left${until}. ${
              s.daysLeft > 0 ? `You'd need to find it by cutting back elsewhere — see "Where's it going wrong?".` : ''
            }`
          : a.newPerDay != null && s.daysLeft > 0
            ? `You'd have ${formatCurrency(a.newPerDay)} a day for the remaining ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'}${
                a.tight ? `, down from ${formatCurrency(s.perDayAllowance)} — that's a real squeeze on your usual ${formatCurrency(s.runRate)} a day.` : '.'
              }`
            : 'The month is nearly done, so this mostly comes out of next month.'
      }</p>
    </div>
  `;
}

function goalAnswer(s, plan) {
  if (!plan.valid) {
    return `<div class="coach-answer"><p class="coach-verdict bad">Pick a date in the future</p></div>`;
  }
  if (!plan.known) {
    return `
      <div class="coach-answer">
        <p class="coach-verdict">${formatCurrency(plan.requiredPerMonth)} a month</p>
        <p class="recap-line">Over ${plan.monthsLeft} month${plan.monthsLeft === 1 ? '' : 's'}. Set your income on the Plan screen and I can tell you whether that's realistic.</p>
      </div>`;
  }

  return `
    <div class="coach-answer">
      <p class="coach-verdict ${plan.feasible ? 'good' : 'warn'}">${formatCurrency(plan.requiredPerMonth)} a month</p>
      <p class="recap-line">To have ${formatCurrency(plan.target)} in ${plan.monthsLeft} month${plan.monthsLeft === 1 ? '' : 's'}.</p>
      <div class="totals-card">
        <div class="totals-row"><span>Free each month</span><span>${formatCurrency(s.free)}</span></div>
        <div class="totals-row"><span>You typically spend</span><span class="out">-${formatCurrency(plan.typicalVariable)}</span></div>
        <div class="totals-row net"><span>Usually spare</span><span class="${plan.typicalSpare < 0 ? 'out' : 'in'}">${formatSignedCurrency(plan.typicalSpare)}</span></div>
      </div>
      ${
        plan.feasible
          ? `<p class="recap-line">That works without changing anything — you usually have ${formatCurrency(plan.typicalSpare)} spare, which covers it.</p>`
          : (() => {
              const found = plan.cuts.reduce((t, c) => t + c.cut, 0);
              const covers = found >= plan.shortfall;
              return `
                <p class="recap-line">You're ${formatCurrency(plan.shortfall)} a month short.${
                  plan.cuts.length ? ' Here\'s where that could come from:' : ''
                }</p>
                ${plan.cuts.length ? cutList(plan.cuts) : ''}
                ${
                  covers
                    ? ''
                    : `<p class="recap-line">That only finds ${formatCurrency(found)} of it. For the remaining ${formatCurrency(
                        plan.shortfall - found
                      )} a month you'd need to move the date, lower the target, or earn more — I'd rather say that than pretend the sums work.</p>`
                }`;
            })()
      }
    </div>
  `;
}

function cutAnswer(s) {
  if (s.free == null) {
    return `<div class="coach-answer"><p class="coach-verdict">I need your income first</p><p class="recap-line">Set it on the Plan screen and I can show you what's out of line.</p></div>`;
  }
  if (s.categoryAverages.monthsCounted === 0) {
    return `<div class="coach-answer"><p class="coach-verdict">Not enough history yet</p><p class="recap-line">Once there's a full month or two behind you, I can compare this month against your normal and show what's drifted.</p></div>`;
  }

  const needed = Math.max(s.projectedOver || 0, 0);
  const cuts = whereToCut(s, needed > 0 ? needed : Math.round(s.variableSpent * 0.1));

  // Advice built on mostly-unsorted spending would be confidently wrong, so
  // say so and point at the fix instead of inventing a recommendation.
  if (s.categoryAverages.uncategorizedShare > 0.25) {
    return `
      <div class="coach-answer">
        <p class="coach-verdict warn">I can't see enough yet</p>
        <p class="recap-line">${formatCurrency(s.categoryAverages.uncategorized)} a month — ${Math.round(
          s.categoryAverages.uncategorizedShare * 100
        )}% of your spending — has no category on it, so I'd only be guessing about where it's going wrong.</p>
        <button type="button" class="btn-primary" id="coach-go-sort">Sort my transactions</button>
        ${cuts.length ? `<p class="muted-note">From what is categorised, these are the biggest:</p>${cutList(cuts)}` : ''}
      </div>`;
  }

  if (cuts.length === 0) {
    return `<div class="coach-answer"><p class="coach-verdict good">Nothing obvious to cut</p><p class="recap-line">Your discretionary spending is either small or evenly spread — there's no single category running away with the month.</p></div>`;
  }

  return `
    <div class="coach-answer">
      <p class="coach-verdict ${needed > 0 ? 'warn' : 'good'}">${
        needed > 0 ? `Find ${formatCurrency(needed)} a month` : 'Your biggest levers'
      }</p>
      <p class="recap-line">${
        needed > 0
          ? `That's what stops you overshooting. Trimming the categories you spend most on, none by more than a third:`
          : `You're not overspending. If you wanted to save more, these are where the money actually is:`
      }</p>
      ${cutList(cuts)}
      <p class="muted-note">Based on your average over the last ${s.categoryAverages.monthsCounted} month${s.categoryAverages.monthsCounted === 1 ? '' : 's'}.</p>
    </div>
  `;
}

function cutList(cuts) {
  return `
    <div class="totals-card">
      ${cuts
        .map((c) => {
          const { icon, color } = categoryStyle(c.name);
          return `
        <div class="attention-row">
          <span class="breakdown-label">
            <span class="cat-chip" style="--chip-color:${color}">${icon}</span>
            <span>${escapeHtml(c.name)}<br><span class="muted-note">${formatCurrency(c.average)} a month → aim for ${formatCurrency(c.newTarget)}</span></span>
          </span>
          <span class="fixed-row-right"><span class="out">-${formatCurrency(c.cut)}</span></span>
        </div>`;
        })
        .join('')}
    </div>`;
}

function noteTemplate(n) {
  const icon = n.tone === 'warn' ? '⚠️' : n.tone === 'good' ? '✅' : 'ℹ️';
  return `
    <div class="coach-note coach-note-${n.tone}">
      <span class="coach-note-icon">${icon}</span>
      <span>
        <strong>${escapeHtml(n.title)}</strong>
        <span class="muted-note">${escapeHtml(n.body)}</span>
      </span>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
