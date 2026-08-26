import type { Config, ScanResult } from './types.ts';
import { sealPanel } from './crypto.ts';

/**
 * Renders the static dashboard (docs/index.html). Fully self-contained — no
 * external assets — so it can be served from GitHub Pages or opened off disk.
 *
 * With a password, the scan data is sealed (AES-256-GCM, PBKDF2 key) and the
 * page shows an unlock gate that decrypts in-browser; the host only ever
 * serves ciphertext. Without one, data is embedded in the clear.
 */
export async function renderDashboard(result: ScanResult, config: Config, password?: string): Promise<string> {
  const payload = JSON.stringify({
    generatedAt: result.generatedAt,
    demo: Boolean(result.demo),
    retailers: result.retailers,
    hits: result.hits,
    grails: config.grails.map((g) => ({ id: g.id, name: g.name, enabled: g.enabled !== false })),
  });

  const sealed = password ? await sealPanel(password, payload) : null;
  const dataScript = sealed
    ? `<script id="sealed-data" type="application/json">${JSON.stringify(sealed)}</script>`
    : `<script id="scan-data" type="application/json">${payload.replace(/</g, '\\u003c')}</script>`;

  const bootScript = sealed
    ? `
  const SEALED = JSON.parse(document.getElementById('sealed-data').textContent);
  const enc = new TextEncoder();
  function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
  async function unseal(password) {
    const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(SEALED.salt), iterations: SEALED.iterations },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(SEALED.iv) }, key, unb64(SEALED.data));
    return new TextDecoder().decode(plain);
  }
  async function tryUnlock(password, remember) {
    const btn = document.getElementById('gate-btn');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    try {
      const json = await unseal(password);
      try { if (remember) sessionStorage.setItem('gkf-key', password); } catch (e) {}
      document.getElementById('gate').remove();
      document.getElementById('panel').style.display = '';
      boot(JSON.parse(json));
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Unlock';
      document.getElementById('gate-err').textContent = 'Wrong password.';
    }
  }
  document.getElementById('gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    tryUnlock(document.getElementById('gate-pw').value, document.getElementById('gate-remember').checked);
  });
  try {
    const saved = sessionStorage.getItem('gkf-key');
    if (saved) tryUnlock(saved, true);
  } catch (e) {}
`
    : `
  document.getElementById('panel').style.display = '';
  boot(JSON.parse(document.getElementById('scan-data').textContent));
`;

  const gateHtml = sealed
    ? `<div id="gate">
  <form id="gate-form" class="gate-card" autocomplete="off">
    <div class="gate-title">⚔ Grail Knife Finder</div>
    <div class="gate-sub">This panel is encrypted. Enter the password to unlock.</div>
    <input id="gate-pw" type="password" placeholder="Password" autofocus>
    <label class="gate-remember"><input id="gate-remember" type="checkbox" checked> Remember for this session</label>
    <button id="gate-btn" type="submit">Unlock</button>
    <div id="gate-err"></div>
  </form>
</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Grail Knife Finder</title>
<style>
  :root {
    --bg: #0c0e12; --panel: #14171d; --panel2: #1a1e26; --line: #262b36;
    --ink: #e8e6e1; --dim: #8b93a3; --accent: #e0a458; --ok: #4ade80; --bad: #f87171;
    --radius: 12px;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    padding: 2rem 1rem 4rem; max-width: 1080px; margin: 0 auto;
  }
  header { margin-bottom: 1.5rem; }
  h1 { font-size: 1.7rem; letter-spacing: .01em; }
  h1 .blade { color: var(--accent); }
  .sub { color: var(--dim); margin-top: .25rem; font-size: .9rem; }
  .demo-banner {
    background: #3b2f1a; border: 1px solid #6b5426; color: #f0d9a8;
    padding: .5rem .9rem; border-radius: var(--radius); margin: 1rem 0; font-size: .88rem;
  }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1.2rem 0; }
  .chip {
    background: var(--panel); border: 1px solid var(--line); color: var(--dim);
    padding: .35rem .85rem; border-radius: 999px; cursor: pointer; font-size: .85rem;
    transition: all .15s;
  }
  .chip:hover { border-color: var(--accent); color: var(--ink); }
  .chip.active { background: var(--accent); border-color: var(--accent); color: #14120c; font-weight: 600; }
  h2 { font-size: 1.05rem; margin: 1.8rem 0 .8rem; color: var(--dim); text-transform: uppercase; letter-spacing: .08em; }
  h2 b { color: var(--ink); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: .8rem; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 1rem; display: flex; flex-direction: column; gap: .45rem;
  }
  .card.instock { border-color: #2c5a3d; background: linear-gradient(160deg, #14231a 0%, var(--panel) 55%); }
  .card .title { font-weight: 600; line-height: 1.35; }
  .card a { color: inherit; text-decoration: none; }
  .card a:hover .title { color: var(--accent); }
  .meta { display: flex; flex-wrap: wrap; gap: .4rem .9rem; color: var(--dim); font-size: .84rem; }
  .badges { display: flex; gap: .4rem; }
  .badge { font-size: .75rem; font-weight: 700; padding: .12rem .55rem; border-radius: 999px; width: fit-content; }
  .badge.ok { background: #143324; color: var(--ok); }
  .badge.gone { background: #2b1a1a; color: var(--bad); }
  .badge.sale { background: #33240f; color: var(--accent); }
  .grailtag { color: var(--accent); font-size: .78rem; }
  .price { font-variant-numeric: tabular-nums; color: var(--ink); }
  .price s { color: var(--dim); margin-left: .35rem; }
  .empty { color: var(--dim); padding: 1.2rem; background: var(--panel); border: 1px dashed var(--line); border-radius: var(--radius); }
  .status { display: flex; flex-wrap: wrap; gap: .5rem; }
  .pill {
    font-size: .78rem; padding: .3rem .7rem; border-radius: 999px;
    background: var(--panel2); border: 1px solid var(--line); color: var(--dim);
  }
  .pill.err { border-color: #4a2626; color: var(--bad); }
  .pill b { color: var(--ink); font-weight: 600; }
  footer { margin-top: 2.5rem; color: var(--dim); font-size: .8rem; border-top: 1px solid var(--line); padding-top: 1rem; }
  footer a { color: var(--accent); }
  #gate { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; padding: 1rem; }
  .gate-card {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 2rem; width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: .9rem;
  }
  .gate-title { font-size: 1.3rem; font-weight: 700; }
  .gate-sub { color: var(--dim); font-size: .88rem; }
  .gate-card input[type=password] {
    background: var(--panel2); border: 1px solid var(--line); border-radius: 8px;
    color: var(--ink); padding: .6rem .8rem; font-size: 1rem; width: 100%;
  }
  .gate-card input[type=password]:focus { outline: none; border-color: var(--accent); }
  .gate-remember { color: var(--dim); font-size: .85rem; display: flex; gap: .45rem; align-items: center; }
  .gate-card button {
    background: var(--accent); color: #14120c; border: none; border-radius: 8px;
    padding: .65rem; font-size: 1rem; font-weight: 700; cursor: pointer;
  }
  .gate-card button:disabled { opacity: .6; cursor: wait; }
  #gate-err { color: var(--bad); font-size: .85rem; min-height: 1.2em; }
</style>
</head>
<body>
${gateHtml}
<div id="panel" style="display:none">
<header>
  <h1><span class="blade">⚔</span> Grail Knife Finder</h1>
  <div class="sub" id="sub"></div>
</header>
<div id="demo"></div>
<div class="chips" id="chips"></div>
<h2>In stock now — <b id="count-in"></b></h2>
<div class="cards" id="instock"></div>
<h2>Sightings (sold out) — <b id="count-out"></b></h2>
<div class="cards" id="soldout"></div>
<h2>Retailer sweep</h2>
<div class="status" id="status"></div>
<footer>
  Watchlist lives in <a href="https://github.com/ryudi84/resources/blob/main/grails.json">grails.json</a> —
  add grails with <code>npm run grail:add</code>. Scans run automatically via GitHub Actions.
</footer>
</div>
${dataScript}
<script>
  let DATA = null;
  let filter = null;

  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
  function price(l) {
    if (!l.priceMin) return '';
    const cur = l.currency ? ' ' + l.currency : '';
    let out = l.priceMin === l.priceMax ? l.priceMin + cur : l.priceMin + '–' + l.priceMax + cur;
    if (l.salePct) out += ' <s>' + l.compareAtMax + cur + '</s>';
    return out;
  }

  function card(h) {
    const l = h.listing;
    const stock = l.available
      ? '<span class="badge ok">IN STOCK · ' + l.variantsAvailable + '/' + l.variantsTotal + ' variants</span>'
      : '<span class="badge gone">SOLD OUT</span>';
    const sale = l.salePct ? '<span class="badge sale">SALE −' + l.salePct + '%</span>' : '';
    return '<div class="card ' + (l.available ? 'instock' : '') + '">' +
      '<div class="badges">' + stock + sale + '</div>' +
      '<a href="' + esc(l.url) + '" target="_blank" rel="noopener"><div class="title">' + esc(l.title) + '</div></a>' +
      '<div class="grailtag">◈ ' + esc(h.grailName) + '</div>' +
      '<div class="meta"><span>' + esc(l.retailerName) + (l.region ? ' · ' + esc(l.region) : '') + '</span>' +
      '<span class="price">' + price(l) + '</span></div>' +
    '</div>';
  }

  function render() {
    const hits = filter ? DATA.hits.filter((h) => h.grailId === filter) : DATA.hits;
    const inStock = hits.filter((h) => h.listing.available);
    const soldOut = hits.filter((h) => !h.listing.available);
    document.getElementById('count-in').textContent = inStock.length;
    document.getElementById('count-out').textContent = soldOut.length;
    document.getElementById('instock').innerHTML = inStock.map(card).join('') ||
      '<div class="empty">Nothing in stock right now. The hunt continues — you\\'ll be pinged the moment something lands.</div>';
    document.getElementById('soldout').innerHTML = soldOut.map(card).join('') ||
      '<div class="empty">No sold-out sightings for this filter.</div>';

    document.getElementById('chips').innerHTML =
      '<button class="chip ' + (filter === null ? 'active' : '') + '" data-id="">All grails</button>' +
      DATA.grails.filter((g) => g.enabled).map((g) =>
        '<button class="chip ' + (filter === g.id ? 'active' : '') + '" data-id="' + esc(g.id) + '">' + esc(g.name) + '</button>'
      ).join('');

    document.getElementById('status').innerHTML = DATA.retailers.map((r) =>
      '<span class="pill ' + (r.ok ? '' : 'err') + '"><b>' + esc(r.name) + '</b> · ' +
      (r.ok ? r.products + ' products · ' + r.ms + 'ms' : '✗ ' + esc(r.error || 'error')) + '</span>'
    ).join('');
  }

  function boot(data) {
    DATA = data;
    const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    document.getElementById('sub').textContent =
      'Last sweep ' + fmtWhen(DATA.generatedAt) + ' · ' + DATA.hits.length + ' grail listing(s) sighted';
    if (DATA.demo) {
      document.getElementById('demo').innerHTML =
        '<div class="demo-banner">⚠️ Demo data — this page was generated from fixtures. The first scheduled scan replaces it with live stock.</div>';
    }
    document.getElementById('chips').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      filter = btn.dataset.id || null;
      render();
    });
    render();
  }
${bootScript}
</script>
</body>
</html>
`;
}
