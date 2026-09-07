---
name: solana-token-forensics
description: Investigate a Solana token's holder base on-chain and answer "are the holders bots or real people, who are the whales, are they colluding, is selling pressure rising, is it safe to buy and when." Use this whenever the user pastes a Solana mint address (a 32-44 character base58 string, often ending in "pump"), names a Solana memecoin or pump.fun token, or asks about a token's holders, whales, bots, bundles, snipers, insiders, dev wallet, rug risk, liquidity, or buy/sell pressure — even if they just say "now this one" with an address. It runs a zero-dependency forensics tool on a GitHub Actions runner (the sandbox cannot reach Solana RPC), then interprets the report the way an on-chain analyst would, and can draw the holder-link graph as an image.
---

# Solana token forensics

The user hands over a mint address and wants a real answer: bots or people, who holds what,
whether the big wallets are linked, whether the chart is painted, whether to buy and when.
The tool does the data pull; this skill is about running it reliably and, more importantly,
saying something true and non-obvious with the result.

## What the tool does

`scripts/token-forensics.ts` (zero dependencies, Node 22, `--experimental-strip-types`)
pulls, for one mint:

- market facts (DexScreener, GeckoTerminal), Rugcheck risks and insider graph, pump.fun metadata
- the holder set (getProgramAccounts, falling back to largest accounts + Rugcheck top holders)
- every wallet's age, lifetime tx count, funding source (fee payer of its first tx), exchange on-ramp
- the AMM pool's own transaction history parsed into swaps: who bought and sold, how much, when
- the launch: first transactions on the pump.fun bonding curve (deploy-bundle wallets)
- provenance: how each top holder got its bag (swap vs transfer, and from whom)
- creator wallet token history: every outbound transfer, flagging current top holders
- funder hops, funder clusters, portfolio-fingerprint clusters
- a "bot fleet fingerprint" for any portfolio cluster: fee payer, routing program, tip/fee
  recipients, and whether the shared tokens were bought or airdropped spam

It writes `investigations/<SYMBOL>-<mint8>.md` (human report) and `.json` (everything, for
follow-up analysis with a few lines of Python). `references/method.md` explains each signal
and the scoring.

## Run it

Read `references/runbook.md` before the first run in a session. Short version:

1. **Try the sandbox first, expect it to fail.** `curl -m 8 https://api.mainnet-beta.solana.com`
   — if the egress proxy returns 403, Solana is unreachable here and you must run on GitHub
   Actions. Do not spend more than one probe on this.
2. **Make sure the repo has the tool and workflow.** If `tools/token-forensics.ts` and
   `.github/workflows/token-probe.yml` are missing, copy them from this skill's `scripts/` and
   `assets/`, commit, push. First run needs the workflow to exist once; after that dispatch by
   numeric workflow id works from any branch (by file name it 404s until it is on the default
   branch).
3. **Dispatch** with the GitHub MCP tool `actions_run_trigger` / `run_workflow`, inputs
   `mint`, `top` (default 150), `activity` (default 400).
4. **Wait without polling in a loop.** Arm a `Monitor` on `git ls-remote` of the branch head;
   the workflow commits the report when done. Free public RPC is throttled from GitHub runners,
   so a run takes 35–45 minutes; with a `SOLANA_RPC_URLS` secret (a Helius/QuickNode URL) about
   3 minutes. Tell the user the timing up front and keep giving them value meanwhile (see below).
5. **If no commit after ~50 minutes,** check run status with `actions_list`; on failure pull the
   job log with `get_job_logs` — the script prints diagnostics to stderr and the whole report to
   stdout, so a run that finished but failed to push still has its report in the log and as an
   artifact.

While the run executes, do the off-chain part: web-search the mint and the token name for the
project, listings, backers, hackathon wins, announced events. That context changes how the
on-chain numbers read (a pump.fun-funded project is not an anonymous rug candidate).

## Interpret it

This is where the value is. Read `references/interpretation.md` — it is the playbook distilled
from real investigations, with the patterns that turned out to matter and the ones that
turned out to be artifacts. The core discipline:

- **Lead with the verdict and the one non-obvious thing.** The user already knows a micro cap
  is risky and that whales can dump. Do not repeat that; they will tell you to stop. Tell them
  what the data shows that they could not see from the chart.
- **Count versus value.** "Sells outnumber buys 2:1" is usually 50 micro-sells from arbitrage
  bots worth a fraction of a SOL each. Always split by SOL, and by wallet type.
- **Exit math beats market cap.** Compute what a whale bag actually yields if sold into the
  pool (constant product on the pool reserves). A 17% bag on $58k liquidity is worth ~$18k, not
  $50k. Illiquidity locks insiders in; that reframes "dump risk."
- **Transfers are the collusion test.** Shared funders and shared tokens are suggestive;
  a token transfer from the creator's holder to another top holder is conclusive.
- **Distrust portfolio clusters until checked.** Active wallets all receive the same spam
  airdrops. The fleet fingerprint (shared fee payer, shared tool fee account, shared funder)
  is what proves one operator; if those are absent, say so and retract.
- **Retract out loud.** When a later run overturns an earlier claim, say "I was wrong about X
  and here is why" before anything else. Trust depends on it.

## Draw it

When the user asks for a picture, or when the link structure is the finding, run
`scripts/holder_graph.py investigations/<file>.json out.svg` and render the SVG to PNG with the
bundled Chromium (`chrome --headless=new --screenshot`). It lays out the connected insider
network on the left (transfers solid, funding dashed, node size = share of supply) and the
unconnected groups beside it. Look at the PNG before sending; fix overlaps by editing the
layout constants at the top of the script.

## Report shape

Plain prose, tables for numbers, addresses in full when the user may want to watch them.
Typical order: verdict → what is non-obvious → who holds the float (grouped, with evidence) →
what to watch and when → data gaps. Never a closing lecture about risk.
