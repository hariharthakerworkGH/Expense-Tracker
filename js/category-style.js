// Every category gets an icon and a colour so a list of spending reads as
// shapes and colour before you've read a single word. Matching is by name, not
// id, so categories you create yourself still get sensible treatment.

const KNOWN = [
  { match: /^uncategori[sz]ed$/i, icon: '❓', color: '#7c8698' },
  { match: /food|dining|restaurant|eat|swiggy|zomato/i, icon: '🍔', color: '#ff8a5c' },
  { match: /grocer|supermarket|vegetab|kirana/i, icon: '🛒', color: '#4ade80' },
  { match: /transport|travel|cab|uber|ola|fuel|petrol|metro/i, icon: '🚕', color: '#38bdf8' },
  { match: /bill|utilit|electric|recharge|broadband|internet/i, icon: '💡', color: '#fbbf24' },
  { match: /rent|house|home/i, icon: '🏠', color: '#a78bfa' },
  { match: /shop|amazon|flipkart|cloth|myntra/i, icon: '🛍️', color: '#f472b6' },
  { match: /entertain|movie|netflix|spotify|game|subscription/i, icon: '🎬', color: '#c084fc' },
  { match: /health|medic|pharma|doctor|gym|fitness/i, icon: '💊', color: '#34d399' },
  { match: /income|salary|credit|refund/i, icon: '💰', color: '#c9f24d' },
  { match: /transfer|payment/i, icon: '🔄', color: '#94a3b8' },
  { match: /invest|mutual|stock|sip/i, icon: '📈', color: '#22d3ee' },
  { match: /educat|course|book|tuition/i, icon: '📚', color: '#60a5fa' },
  { match: /gift|donat|charit/i, icon: '🎁', color: '#fb7185' },
  { match: /other|misc/i, icon: '✨', color: '#94a3b8' },
];

// Used for categories that match nothing above - picked by name so the same
// category keeps the same colour every time rather than flickering.
const FALLBACK = ['#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f43f5e', '#14b8a6', '#a855f7'];

export function categoryStyle(name) {
  if (!name) return { icon: '❓', color: '#64748b' };
  const hit = KNOWN.find((k) => k.match.test(name));
  if (hit) return { icon: hit.icon, color: hit.color };
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return { icon: '🏷️', color: FALLBACK[hash % FALLBACK.length] };
}

// Small round icon chip used in lists.
export function categoryChip(name) {
  const { icon, color } = categoryStyle(name);
  return `<span class="cat-chip" style="--chip-color:${color}">${icon}</span>`;
}
