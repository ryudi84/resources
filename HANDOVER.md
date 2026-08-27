# ⚔ Grail Knife Finder — Full Handover

**Repo:** `ryudi84/resources` · **Owner:** @ryudi84 · **Handover date:** 2026-08-27
**Status:** 🟢 Deployed and running 24/7 on `main`, unattended, at $0/month.
Built end-to-end in an autonomous Claude Code session: designed, implemented, live-debugged
against real retailers, and deployed — including two production incidents found and fixed
from the system's own unattended run history.

---

## 1. TL;DR — what you have

A zero-cost, self-running hunter for grail kitchen knives (Takada no Hamono, Bryan
Raquin, and anything you add). Every ~20 minutes, GitHub Actions sweeps the **live
inventory APIs** of 24 retailers across **4 e-commerce platforms** — no HTML scraping —
matches listings against your watchlist, and pings you **only when something newly comes
in stock**. Once a day it posts a bargain digest and runs a **discovery engine** that
searches the web for new stockists, verifies them against your grails, filters out scam
clone-storefronts, and adds the real ones to its own roster.

**As of the last sweep (2026-08-27 21:03 UTC):** 24/24 retailers healthy, **376 grail
sightings** tracked, 2 in stock — both Bryan Raquin at JNS:

| In stock now | Price | Link |
|---|---|---|
| JNS Raquin Collab Bunka 190mm SC125 | ~$1,091 | https://www.japanesenaturalstones.com/jns-raquin-collab-bunka-190mm-sc125/ |
| JNS Raquin Collab Gyuto 260mm 145sc | ~$1,091 | https://www.japanesenaturalstones.com/jns-raquin-collab-gyuto-260mm-145sc/ |

**Live panel (no login, no setup):**
https://raw.githack.com/ryudi84/resources/main/docs/index.html

**Where alerts land:** [Issue #5 — 🔪 Grail stock alerts](https://github.com/ryudi84/resources/issues/5).
Every alert @mentions you, so GitHub forwards it to your email and phone (GitHub app).

---

## 2. Architecture

```
                       ┌──────────────────────────────────────────────┐
 GitHub Actions cron   │            src/scan.ts (orchestrator)        │
 */20 min (scan.yml)   │                                              │
 0 13 UTC daily  ──────▶  retailers.json ──▶ adapter registry ────────┼──▶ per-retailer catalogs
                       │      ▲              (src/adapters.ts)        │      (bounded pool, retries,
                       │      │               shopify | woocommerce   │       deadlines)
   discovery engine ───┼──────┘               squarespace | bigcommerce
   (src/discover.ts,   │                                              │
    daily, self-grows  │  grails.json ──▶ matcher (all/any/none, ─────┼──▶ hits
    the roster)        │                  diacritic-insensitive,      │
                       │                  price caps, per-retailer)   │
                       │                                              │
                       │  diff vs data/latest.json ──▶ NEWLY in stock ┼──▶ notify fan-out
                       │                                              │     ├─ GitHub issue #5 (@mention → email/app)  [no secrets]
                       │  render ──▶ docs/index.html (panel)          │     ├─ Discord rich embeds       [needs DISCORD_WEBHOOK_URL]
                       │  commit data/ docs/ retailers.json to main   │     ├─ Gmail SMTP (zero-dep)     [needs SMTP_USER/SMTP_PASS]
                       └──────────────────────────────────────────────┘     └─ ntfy phone push           [needs NTFY_TOPIC]
```

**Stack principles:** TypeScript executed **natively by Node 22** (no build step, no
bundler), **zero npm dependencies** (native fetch, `AbortSignal.timeout`, `node:test`,
`node:tls`, `parseArgs`), everything stateful committed to git, everything hosted on
GitHub's free tier (public repo = unlimited Actions minutes).

## 3. Repository map

| Path | Purpose |
|---|---|
| `grails.json` | **Your watchlist** — the file you'll touch most |
| `retailers.json` | Sweep roster (24 shops; discovery appends to it automatically) |
| `src/scan.ts` | Orchestrator: sweep → match → diff → panel → notify |
| `src/adapters.ts` | Platform adapter registry — add new platforms here |
| `src/shopify.ts` | Shopify `/products.json` (paginated, compare-at sale detection) |
| `src/woocommerce.ts` | WooCommerce Store API (minor-unit prices, sale state) |
| `src/squarespace.ts` | Squarespace `?format=json` (per-variant `qtyInStock`; vendor=shop name so maker-direct boutiques match maker grails) |
| `src/bigcommerce.ts` | BigCommerce GraphQL Storefront API — **self-bootstraps** by scraping the theme's embedded bearer token, then pages the official API |
| `src/matcher.ts` | Normalization (case/diacritics/whitespace) + all/any/none matching over title+vendor+type+tags |
| `src/discover.ts` | Discovery engine + clone-store scam guard (see §5) |
| `src/notify.ts` | Alert fan-out (issue, Discord embeds, SMTP, ntfy, Slack) |
| `src/github.ts` | Zero-secret channel: comments on issue #5 with @mention via the workflow's own token |
| `src/digest.ts` | Daily bargain digest (markdowns/B-grade/clearance first, with −% and links) |
| `src/smtp.ts` | ~150-line zero-dependency SMTP client (implicit TLS, AUTH LOGIN) for Gmail app-password email |
| `src/crypto.ts` + `src/report.ts` | Panel generator; with `PANEL_PASSWORD` set, seals data with AES-256-GCM (PBKDF2, 310k iters) and unlocks in-browser via WebCrypto |
| `src/grail.ts` | Watchlist CLI (add/list/remove/pause/resume) |
| `test/` | 26 tests via `node:test`, incl. mock servers for all four platforms and the scam detector |
| `.github/workflows/scan.yml` | The 20-min sweep + daily digest/discovery cron |
| `.github/workflows/pages.yml` | Deploys panel to GitHub Pages *if* Pages is ever enabled; no-ops green otherwise |
| `.github/workflows/probe.yml` | Diagnostic scratchpad: edit + push to curl anything from a runner, read the job log |
| `data/latest.json` | Last sweep results — diff baseline for "newly in stock" and price index for the scam guard |
| `docs/index.html` | The panel, regenerated every sweep |

## 4. The four adapters (why "Shopify-only is naive" was right)

1. **Shopify** (`/products.json?limit=250&page=N`) — most NA/AU knife shops. Per-variant
   availability, `compare_at_price` → sale detection.
2. **WooCommerce** (`/wp-json/wc/store/v1/products`) — e.g. Oishya, shirasagistore.
   Prices arrive in minor units (`currency_minor_unit`).
3. **Squarespace** (`<shop-path>?format=json`) — found via probing **bryanraquin.com**:
   Bryan Raquin sells direct from `/boutique` (74 products, EUR, per-variant
   `qtyInStock`). Adapter needs `"path"` in the retailer entry.
4. **BigCommerce** (GraphQL Storefront API) — built for **JNS**
   (japanesenaturalstones.com), which exposes no anonymous endpoint. The adapter
   extracts the Stencil theme's embedded `graphQLToken` from the page HTML (handling
   JSON-escaped quotes) and pages `site.products` with cursors. **Gotchas learned in
   production:** JNS has 6,529 products and cursors walk ascending product id — newest
   listings (the drops!) come *last*, so the page cap is 300 with a cursor-stall guard.

## 5. Discovery engine — the roster grows itself

Daily at 13:00 UTC (and on demand): takes every enabled grail's maker terms → searches
DuckDuckGo + Bing HTML endpoints (free, no API keys) → skips marketplaces/socials/forums
and known shops → fingerprints each candidate domain (Shopify → Woo → Squarespace →
BigCommerce probes) → fetches its live catalog (60s per-candidate deadline, 15-min step
timeout) → **only accepts shops that actually stock a grail** → auto-appends to
`retailers.json`, commits, and announces on issue #5 **with the matched product's direct
link, price, and stock state**.

**Autonomous wins so far:** hitohira-japan.com (96 Takada listings — deepest Takada
source in the roster) and staysharpmtl.com (23 Takada listings) were found, verified,
and added with zero human input.

**Scam guard:** discovery once auto-added `gourmetkitchenanddining.com` — a fraudulent
clone storefront scraping real shops' catalogs verbatim at ~90% off ("$98 Raquin
gyuto"). It is removed and hard-blocklisted, and every candidate is now checked against
a price index built from the previous sweep: grail listings duplicating known titles at
<45% of the tracked price mark the shop as a clone and reject it. **Standing rule: a
grail at an unbelievable price on an unknown site is a scam, not a deal.**

## 6. Alerts, digest, and channels

- **Default (active now, zero secrets):** alerts and the daily digest post as comments
  on issue #5 with `@ryudi84` — GitHub notifies your email/app. Alerts fire **only** for
  newly-in-stock items (diff vs previous sweep), so no repeat noise.
- **Daily digest (13:00 UTC):** everything in stock, bargains first — real markdowns
  (compare-at vs price, with −%) plus B-grade/seconds/clearance keyword finds.
- **Optional upgrades** — add any of these as repo **Actions secrets** (Settings →
  Secrets and variables → Actions); the code lights them up automatically:
  - `DISCORD_WEBHOOK_URL` — rich embeds into your #shoryu channel (webhook you already created)
  - `SMTP_USER` + `SMTP_PASS` (+ optional `ALERT_EMAIL`) — direct Gmail delivery via app password
  - `NTFY_TOPIC` — urgent phone push via the free ntfy app
  - `PANEL_PASSWORD` — seals the panel with AES-256-GCM; page shows an unlock screen
  - Note: these require the repo settings UI; they could not be set from within the
    session (secrets APIs need admin credentials — by design).

## 7. Operations runbook

```bash
npm test                 # 26 tests, all platforms mocked
npm run scan             # manual sweep (or Actions → "Grail knife scan" → Run workflow)
npm run scan:demo        # offline, fixture-driven
npm run digest           # post the bargain digest now
npm run discover         # discovery pass now

# Watchlist
npm run grail:add -- --name "Kato Workhorse Gyuto 240" --all kato --all gyuto --any 240 --none petty --max-price 2000
npm run grail:list
npm run grail -- pause <id> | resume <id>
npm run grail:remove -- <id>
```

- **Run-workflow toggles** (Actions → Grail knife scan → Run workflow): `test_alert`
  (fires a synthetic alert through all channels), `run_digest`, `run_discovery`.
- **Add a retailer manually:** append to `retailers.json` with the right `adapter`
  (+ `path` for Squarespace). Broken retailers show in the panel's status strip.
- **Probe anything from a runner:** edit `.github/workflows/probe.yml`, push, read the
  job log. This is how JNS's platform and Raquin's Squarespace shop were reverse-engineered
  (the dev sandbox has no direct network access to retailer sites — the runners do).
- **Sweep data conflicts:** `data/` + `docs/` are regenerated every sweep; when git
  conflicts on them, either side is safe to take.

## 8. Build history (PRs, all merged to `main`)

| PR | What |
|---|---|
| #1 | Core system: scanner, matcher, watchlist CLI, panel, alerts, tests, 20-min cron |
| #2 | Discovery engine, zero-secret GitHub alerts, JNS seeded, Pages workflow |
| #3 | Pages: detect-and-deploy + githack fallback (GitHub refuses site *creation* from workflow tokens) |
| #4 | Discovery time-bounds (60s/candidate, 15-min step) after first run stalled |
| #6 | **BigCommerce adapter** (GraphQL token bootstrap) — JNS swept correctly |
| #7 | Pin workflow to Node 22; tests non-blocking (Node 24 test-runner IPC flake was killing sweeps) |
| #8 | Full-catalog pagination for JNS (6.5k products; newest-last cursor order) |
| #9 | Discovery announcements carry the matched product link/price/stock, not just the shop |
| #10 | Scam clone-store detector + blocklist; removed gourmetkitchenanddining.com |

Notable incidents, both caught from unattended run history: the **Node 24 IPC flake**
(intermittent `Unable to deserialize cloned data` failing scheduled sweeps → #7) and the
**scam storefront** (→ #10, warning posted on issue #5).

## 9. Known limitations & sensible next steps

- **Secrets not set** → Discord/email/push/panel-password inactive until pasted (see §6).
  GitHub-issue notifications carry everything meanwhile.
- **GitHub Pages not enabled** → panel served via githack (works fine). Enabling Pages
  (Settings → Pages → main + GitHub Actions) makes `pages.yml` auto-deploy to
  `ryudi84.github.io/resources`.
- **Forum classifieds not covered** (Kitchen Knife Forums BST has active Raquin/Takada
  secondary-market listings) — XenForo scraping, a separate project.
- **Discovered retailers lack region metadata** (e.g. `staysharpmtl-com` has no
  region/currency for Shopify — cosmetic only).
- **Digest/discovery cron can drift** — GitHub delays busy cron slots (observed ~55 min);
  harmless, everything is idempotent.
- Candidate grails if wanted: Kato (Yoshiaki Fujiwara) and Toyama — JNS and Hitohira,
  already in the roster, are the canonical sources; one `grail:add` each.

## 10. Cost

$0. Public repo → unlimited GitHub Actions minutes; retailer inventory APIs are public;
DuckDuckGo/Bing HTML endpoints are free; githack is free; GitHub notifications are free;
optional channels (Gmail SMTP, Discord webhooks, ntfy) are free.
