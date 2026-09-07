# Method — what each signal means

The tool (`scripts/token-forensics.ts`) computes these per wallet and per token. Free,
on-chain-only, keyless. Each is a heuristic; the report lists the reasons per wallet so you
argue from evidence, not from the score.

## Data sources
| Source | Gives | Notes |
|---|---|---|
| Solana JSON-RPC (probed list of keyless endpoints) | holders, wallet history, funders, pool swaps, launch, provenance | history routed only to archival-depth endpoints |
| pump.fun coin API | creator, created time, bonded, bonding curve address, socials | trade tape endpoint is dead for bonded tokens |
| Rugcheck | risks, insider graph, top holders (fallback), LP lock, authorities | |
| DexScreener / GeckoTerminal | price, liquidity, FDV, buys/sells and unique buyers/sellers per window | GeckoTerminal has unique actors |
| DexScreener tokens/v1 | names + liquidity for shared mints (spam vs real) | |

## Per-wallet signals
- **bundled** — bought in the deploy slot or the next two (reconstructed from the bonding curve's first transactions).
- **launchBuyer** — bought within the first parsed launch transactions (sniper).
- **freshAtBuy** — first-ever tx < 24 h before its first buy and < 15 lifetime txs (only trusted from archival endpoints).
- **funder / funderCex / fundedBySameAs** — fee payer of the wallet's first tx; whitelist of exchange hot wallets; cluster size of holders sharing that funder.
- **provenance** — parse of the wallet's token account: swaps in (with SOL), transfers in (from whom), transfers out (to whom). Counterparties that are the creator or other top holders are flagged.
- **recentBuys/Sells, buyShare, regularBuyer, repeatSize** — from parsed pool swaps in the window: share of buy volume, interval coefficient of variation (< 0.35 = scheduled), identical-size buy count.
- **churn / burstBuyer** — rapid round trips; identical-amount buy bursts across wallets (bonding-curve tape only).
- **txCountCapped** — ≥ 3000 lifetime txs = automated trading wallet (not necessarily malicious).
- **insider** — Rugcheck's transfer-graph insider flag.
- **portfolioCluster** — shares ≥ 3 non-major mints with other big holders; **must** be confirmed by the fleet fingerprint before it means "one operator" (spam airdrops create false clusters).

## Token-level sections
- **Launch** — creator/bundle share, still-holding bundle wallets, where bundle bags went (closed accounts = sold long ago).
- **Creator wallet** — age, funder, every outbound token transfer with current-top-holder flags.
- **Recent pool activity** — day histogram, buys/sells by count and SOL, unique actors, top buyer share, top buyers and sellers with holdings.
- **Funder hops** — who funded the funders; links to creator/holders; shared grand-funders.
- **Bot fleet fingerprint** — per cluster wallet: fee payer, routing programs (Jupiter, PumpSwap, Raydium, known bot fee accounts), SOL recipients (Jito tips vs tool fee accounts), deep-search funder; shared-mint table (real market / dead / no market / address lookalike) and how sampled mints were acquired.

## Scoring
bundle 0.40 · fresh 0.25 · funder-cluster 0.25 (0.10 for a pair) · funded-by-holder 0.15 · launch sniper 0.15 · transfer-from-insider 0.25 (0.10 if bag arrived by transfer from unknowns and never bought) · portfolio cluster 0.15 · insider 0.20 · churn 0.15 · burst 0.15 · buy-volume-driver 0.20 · scheduled-cadence 0.25 · same-size-buys 0.10 · automated 0.25 · near-zero SOL 0.05 · exchange-funded −0.20. Clamp 0–1; ≥ 0.50 bot, ≥ 0.25 suspicious, 0 indexed txs = unknown.

## Follow-up analysis on the JSON
The `.json` has every holder with all fields, all parsed swaps (`pool.swaps`), trader stats, launch buyers, bundle destinations, creator provenance, funder hops, fleet fingerprints and shared-mint info. Ten lines of Python answer most follow-ups: largest buys/sells with wallet tags, weekly SOL flow, hour-of-day by wallet type, exit math from `market.pair.liquidity` (`quote` = SOL, `base` = tokens).
