import type { Config, ScanResult } from './types.ts';

/**
 * Renders the static dashboard (docs/index.html). Fully self-contained —
 * scan data is embedded, no external assets — so it can be served from
 * GitHub Pages or opened straight off disk.
 */
export function renderDashboard(result: ScanResult, config: Config): string {
  const payload = JSON.stringify({
    generatedAt: result.generatedAt,
    demo: Boolean(result.demo),
    retailers: result.retailers,
    hits: result.hits,
    grails: config.grails.map((g) => ({ id: g.id, name: g.name, enabled: g.enabled !== false })),
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
  .badge { font-size: .75rem; font-weight: 700; padding: .12rem .55rem; border-radius: 999px; width: fit-content; }
  .badge.ok { background: #143324; color: var(--ok); }
  .badge.gone { background: #2b1a1a; color: var(--bad); }
  .grailtag { color: var(--accent); font-size: .78rem; }
  .price { font-variant-numeric: tabular-nums; color: var(--ink); }
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
</style>
</head>
<body>
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
<script id="scan-data" type="application/json">${payload}</script>
<script>
  const DATA = JSON.parse(document.getElementById('scan-data').textContent);
  let filter = null;

  const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  document.getElementById('sub').textContent =
    'Last sweep ' + fmtWhen(DATA.generatedAt) + ' · ' + DATA.hits.length + ' grail listing(s) sighted';
  if (DATA.demo) {
    document.getElementById('demo').innerHTML =
      '<div class="demo-banner">⚠️ Demo data — this page was generated from fixtures. The first scheduled scan replaces it with live stock.</div>';
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
  function price(l) {
    if (!l.priceMin) return '';
    const cur = l.currency ? ' ' + l.currency : '';
    return l.priceMin === l.priceMax ? l.priceMin + cur : l.priceMin + '–' + l.priceMax + cur;
  }

  function card(h) {
    const l = h.listing;
    const badge = l.available
      ? '<span class="badge ok">IN STOCK · ' + l.variantsAvailable + '/' + l.variantsTotal + ' variants</span>'
      : '<span class="badge gone">SOLD OUT</span>';
    return '<div class="card ' + (l.available ? 'instock' : '') + '">' +
      badge +
      '<a href="' + esc(l.url) + '" target="_blank" rel="noopener"><div class="title">' + esc(l.title) + '</div></a>' +
      '<div class="grailtag">◈ ' + esc(h.grailName) + '</div>' +
      '<div class="meta"><span>' + esc(l.retailerName) + (l.region ? ' · ' + esc(l.region) : '') + '</span>' +
      '<span class="price">' + esc(price(l)) + '</span></div>' +
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

  document.getElementById('chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    filter = btn.dataset.id || null;
    render();
  });

  render();
</script>
</body>
</html>
`;
}
