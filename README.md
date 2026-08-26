# ⚔ Grail Knife Finder

A stock finder for **Takada no Hamono** — and any other grail knife you decide to hunt.

Takada drops sell out in minutes. This tool doesn't scrape web pages: it reads the **live
inventory JSON APIs** that e-commerce platforms expose — Shopify's `/products.json` and
WooCommerce's Store API, with a pluggable adapter registry (`src/adapters.ts`) for adding
any other platform. That gives per-variant availability, prices, and markdowns with zero
HTML parsing, zero brittleness, and near-zero latency.

## How it works

```
grails.json  ──┐
               ├──▶  src/scan.ts ──▶ sweeps 17 retailers concurrently
retailers.json ┘         │
                         ├──▶ data/latest.json     (state + diff baseline)
                         ├──▶ docs/index.html      (live dashboard)
                         └──▶ alert if a grail JUST came in stock
                              (email via Gmail SMTP, Discord, ntfy phone push, Slack)
```

A GitHub Actions cron (`.github/workflows/scan.yml`) runs the sweep **every 20 minutes**,
commits the updated dashboard/state, and pings you only when something *newly* comes in
stock — no alert fatigue from things that were already listed.

## The stack (deliberately bleeding-edge, deliberately zero-dependency)

- **TypeScript executed natively by Node 22/24** — no build step, no `tsc`, no bundler;
  Node's type-stripping runs `.ts` straight from disk.
- **Zero npm dependencies.** Native `fetch`, `AbortSignal.timeout` for deadlines,
  exponential-backoff retries, a bounded worker pool, `node:util` `parseArgs` for the CLI,
  and the built-in `node:test` runner. Nothing to install, nothing to rot.
- Self-contained static dashboard — works from GitHub Pages or a double-click.

## Quick start

```bash
npm test            # 12 tests, includes a fake Shopify server integration test
npm run scan        # live sweep (needs normal internet access)
npm run scan:demo   # offline sweep against fixtures — see the dashboard shape
open docs/index.html
```

## Adding more grails

Edit `grails.json` by hand, or use the CLI:

```bash
npm run grail:add -- --name "Kato Workhorse Gyuto 240" \
  --all kato --all gyuto --any 240 --none petty --max-price 2000

npm run grail:list
npm run grail -- pause takada-suiboku-gyuto-240    # keep it, stop hunting it
npm run grail -- resume takada-suiboku-gyuto-240
npm run grail:remove -- kato-workhorse-gyuto-240
```

Matching semantics (case-, whitespace- and diacritic-insensitive, applied to
title + vendor + product type + tags):

| Field | Meaning |
|---|---|
| `match.all` | every term must appear |
| `match.any` | at least one term must appear |
| `match.none` | listing is rejected if any term appears |
| `priceMax` | skip listings above this price (retailer's currency) |
| `retailers` | optional list of retailer ids to restrict the hunt |
| `enabled: false` | pause without deleting |

## Retailer discovery — the roster grows itself

You don't hand-curate `retailers.json`. Once a day (and on demand via Actions → Run
workflow → "Run retailer discovery"), `src/discover.ts`:

1. takes every enabled grail's maker terms,
2. searches the open web for them (DuckDuckGo + Bing HTML endpoints — free, no API keys),
3. fingerprints each candidate domain for a sweepable platform (Shopify → WooCommerce →
   Squarespace probes), skipping marketplaces/socials/forums and known retailers,
4. pulls the candidate's live catalog and only accepts it if it **actually stocks a
   grail**, then
5. auto-appends it to `retailers.json`, commits it, and announces it on the alerts issue.

Manual entries still work — append any shop to `retailers.json` with its `adapter`
(`shopify` | `woocommerce` | `squarespace` + `path`). A retailer that errors shows up in
the dashboard's status strip.

## Getting alerted — email, Discord, phone push (all free)

Everything here is free end-to-end: the repo is public so GitHub Actions minutes are
unlimited, Gmail SMTP costs nothing, Discord webhooks cost nothing, and ntfy.sh is free.
Alerts fire around the clock — whenever a sweep catches a grail *newly* in stock.

### 📬 Zero-setup default: GitHub notifications

With no secrets at all, alerts and the daily digest are posted as comments on the
repo's pinned **"🔪 Grail stock alerts" issue** with an @mention of the repo owner —
GitHub then delivers them to your email and phone (GitHub app) through its normal
notification pipeline. Nothing to configure.

For richer channels, set these as **GitHub Actions secrets** (repo → Settings →
Secrets and variables → Actions → New repository secret), any or all:

### 📧 Email

Mail is sent through Gmail's own SMTP with a zero-dependency SMTP client (`src/smtp.ts`)
— no SendGrid/Mailgun/paid relay in the middle.

1. Google Account → Security → turn on **2-Step Verification** (required for the next step).
2. Google Account → Security → **App passwords** → create one named "grail-finder".
3. Add secrets: `SMTP_USER` = your Gmail address, `SMTP_PASS` = the 16-character app password.
4. Optional: `ALERT_EMAIL` to deliver somewhere other than `SMTP_USER` (comma-separate for
   multiple recipients). Optional `SMTP_HOST`/`SMTP_PORT` for a non-Gmail provider
   (default `smtp.gmail.com:465`, implicit TLS).

### 💬 Discord

1. In your server: channel → **Edit Channel → Integrations → Webhooks → New Webhook** → Copy Webhook URL.
2. Add it as the `DISCORD_WEBHOOK_URL` secret.

### 📱 Phone push (optional)

| Secret | What it does |
|---|---|
| `NTFY_TOPIC` | Pick a unique string (e.g. `ryudi-grails-x7k2`), subscribe to that topic in the free [ntfy](https://ntfy.sh) app — alerts arrive as urgent push notifications with a tap-through link to the product page. |
| `NTFY_SERVER` | Optional self-hosted ntfy server. |
| `SLACK_WEBHOOK_URL` | Posts alerts into a Slack channel. |

## Daily bargain digest

Once a day (13:00 UTC cron) a digest posts to your Discord channel: every grail
currently in stock, with **bargains first** — live markdowns detected from
compare-at/regular prices (with the discount %), plus B-grade / seconds / clearance /
promo listings spotted by keyword. Fire one on demand from Actions → Run workflow →
"Post the daily bargain digest".

## Hosted panel with a password (free)

Hosting is automatic: `.github/workflows/pages.yml` creates the GitHub Pages site on
its first run (no Settings clicks) and redeploys `docs/` after every sweep, so the
panel lives at `https://ryudi84.github.io/resources/`.

To lock it, add a `PANEL_PASSWORD` secret. From then on the published page contains
**only AES-256-GCM ciphertext** (key derived from your password via PBKDF2-SHA-256,
310k iterations) and shows an unlock screen; decryption happens in your browser via
WebCrypto. No auth service, no server, no cost — GitHub Pages never sees the data or
the password. Change the password by updating the secret; the next sweep re-seals.

## Repo layout

```
grails.json               # ← your watchlist, the file you'll touch most
retailers.json            # Shopify storefronts to sweep
src/scan.ts               # orchestrator: sweep → match → diff → report → notify
src/adapters.ts           # platform adapter registry (add new platforms here)
src/shopify.ts            # Shopify /products.json adapter (pagination, retries)
src/woocommerce.ts        # WooCommerce Store API adapter
src/digest.ts             # daily bargain digest (GitHub issue + Discord)
src/discover.ts           # retailer discovery engine (self-growing roster)
src/github.ts             # zero-secret alert channel via the stock-alerts issue
src/crypto.ts             # AES-256-GCM panel sealing (password protection)
src/matcher.ts            # normalization + all/any/none matching engine
src/grail.ts              # watchlist CLI (add/list/remove/pause/resume)
src/report.ts             # dashboard generator
src/notify.ts             # email / Discord / ntfy / Slack alert fan-out
src/smtp.ts               # zero-dependency SMTP client (Gmail app-password auth)
src/demo.ts               # offline fixtures
test/                     # node:test suite incl. fake-Shopify integration test
data/latest.json          # last sweep results (diff baseline for "newly in stock")
docs/index.html           # generated dashboard
.github/workflows/scan.yml# the 20-minute cron
```
