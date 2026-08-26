# ⚔ Grail Knife Finder

A stock finder for **Takada no Hamono** — and any other grail knife you decide to hunt.

Takada drops sell out in minutes. This tool doesn't scrape web pages: it reads the **live
inventory JSON API** (`/products.json`) that every Shopify storefront exposes, which is
exactly what the serious knife retailers run on. That gives per-variant availability and
prices with zero HTML parsing, zero brittleness, and near-zero latency.

## How it works

```
grails.json  ──┐
               ├──▶  src/scan.ts ──▶ sweeps 17 retailers concurrently
retailers.json ┘         │
                         ├──▶ data/latest.json     (state + diff baseline)
                         ├──▶ docs/index.html      (live dashboard)
                         └──▶ push alert if a grail JUST came in stock
                              (ntfy → your phone, Discord, Slack)
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

## Adding retailers

Any Shopify knife shop works — append to `retailers.json`:

```json
{ "id": "my-shop", "name": "My Shop", "url": "https://example.com", "adapter": "shopify", "region": "US", "currency": "USD" }
```

A retailer that errors shows up in the dashboard's status strip; fix its URL or delete it.

## Getting pinged on your phone

Set these as **GitHub Actions secrets** (Settings → Secrets and variables → Actions),
any or all:

| Secret | What it does |
|---|---|
| `NTFY_TOPIC` | Easiest: pick a unique string (e.g. `ryudi-grails-x7k2`), subscribe to that topic in the free [ntfy](https://ntfy.sh) app — alerts arrive as urgent push notifications with a tap-through link to the product page. |
| `NTFY_SERVER` | Optional self-hosted ntfy server. |
| `DISCORD_WEBHOOK_URL` | Posts alerts into a Discord channel. |
| `SLACK_WEBHOOK_URL` | Posts alerts into a Slack channel. |

## Dashboard hosting (optional)

Enable GitHub Pages (Settings → Pages → deploy from branch, `/docs` folder) and the
dashboard gets a public URL that refreshes with every sweep.

## Repo layout

```
grails.json               # ← your watchlist, the file you'll touch most
retailers.json            # Shopify storefronts to sweep
src/scan.ts               # orchestrator: sweep → match → diff → report → notify
src/shopify.ts            # Shopify /products.json adapter (pagination, retries)
src/matcher.ts            # normalization + all/any/none matching engine
src/grail.ts              # watchlist CLI (add/list/remove/pause/resume)
src/report.ts             # dashboard generator
src/notify.ts             # ntfy / Discord / Slack alerts
src/demo.ts               # offline fixtures
test/                     # node:test suite incl. fake-Shopify integration test
data/latest.json          # last sweep results (diff baseline for "newly in stock")
docs/index.html           # generated dashboard
.github/workflows/scan.yml# the 20-minute cron
```
