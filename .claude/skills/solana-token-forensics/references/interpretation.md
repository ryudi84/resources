# Interpretation playbook

What to compute, what it means, and what turned out to be noise. Written from a real
investigation ($MAXIS, Sep 2026) where several first-pass conclusions were wrong and the
deeper passes fixed them. Use it as a checklist, not a script.

## Read the report in this order

1. **Verdict block and red flags** — orientation only; the scoring is a heuristic.
2. **Launch section** — who took what in the deploy slot (+0..+2) and the first seconds.
   Creator buying >10% in slot 0 plus several wallets taking near-identical 2–3% within four
   slots = a bundled launch. Then check "Where the launch-bundle bags went": token accounts
   closed = they sold long ago = not a current overhang. Bags transferred to a current top
   holder = the insider block still exists under new addresses.
3. **Creator wallet** — every outbound transfer. A transfer into a current top holder is the
   single most conclusive collusion finding. Round trips (send, receive back, send elsewhere)
   before the final destination are the signature of someone obscuring the origin.
4. **How the top holders got their bags** — swap vs transfer. A holder that *never bought* and
   only received from several wallets is a collection/treasury wallet. Transfers from other
   top holders (`*`) chain wallets into one entity.
5. **Recent pool activity** — buys vs sells by count *and* SOL, unique buyers vs sellers, top
   buyer share, the day histogram. Then the top-buyer/top-seller tables.
6. **Funder clusters and funder hops** — shared funders are suggestive; a funder that is the
   creator or a top holder is conclusive; 1000+-tx funders are usually exchanges/services.
7. **Portfolio clusters and the fleet fingerprint** — see the caveat below.
8. **Top holders table** — verdict and reasons per wallet; the reasons are the evidence.

## The insights that mattered

**Exit math, not market cap.** Constant product on the pool reserves (x SOL, y tokens):
selling `t` tokens yields `x − x·y/(y+t)` SOL; price after ≈ `((x−out)/x)²`. Compute this for
each whale bag. On thin liquidity the biggest holder often cannot realize a third of its
marked value and would crater the price 80%+ doing it. That explains why insiders have not
sold, and reframes the risk: their exit is a liquidity event (listing, deeper pool), not a
dump into the pool. Also compute the buy side: how many SOL move price 10%? That tells the
user what their own entry does to the chart.

**Count vs value.** Sells outnumbering buys by count is usually bots scalping fractions of a
SOL. Split by SOL and by wallet type (bot ≥ ~1000 lifetime txs vs human vs exchange-funded).
"Selling pressure rising?" is answered by weekly SOL sold ÷ SOL traded and by *who* sold, not
by transaction counts.

**Staircase charts.** Flat shelves and vertical steps mean no trades for hours then a single
buy that moves a thin pool. Identify the wallets behind the 20 largest buys. If they are a few
exchange-funded humans and some accumulating bot-wallets, the chart is real buying into thin
liquidity, not painting. Painting looks like one wallet, regular cadence (interval CV < 0.35),
identical sizes.

**Time of day = geography.** Bucket human buys by UTC hour. A 09:00 UTC peak is Japanese
evening; 13:00–15:00 UTC is US morning. Different peaks for different groups means different
crowds.

**Holder count is inflated.** A spike of hundreds of 0.01 SOL buys in two days is a
holder-count campaign, not money. Thousands of holders sharing 30% of supply are $20 bags.

**Bonded in under three minutes = bundled launch.** Pump.fun graduation needs ~85 SOL of buys;
that speed only happens pre-arranged.

## Things that looked like findings and were not

**Portfolio-fingerprint clusters.** Seven busy wallets sharing 38 obscure tokens looked like
one operator's fleet. Half the tokens were spam airdrops (one a USDT address lookalike) and the
rest were popular memecoins every active trader holds. The fleet fingerprint then showed each
wallet signs for itself, routes through Jupiter/PumpSwap directly, shares no fee account and
no funder, and two on-ramped from different exchanges. Independent traders. **Never present a
portfolio cluster as one operator until the fingerprint confirms a shared fee payer, a shared
non-Jito fee recipient, or a shared funder.**

**Fresh-wallet ratios from non-archival nodes.** A first pass showed median wallet age 0.2
days and 14 "fresh" buyers. The RPC only served hours of history. Check the "History served
by" line and the day histogram: a month of activity showing as one day means truncation, and
every age/funder/fresh flag from that run is void.

**Bundle wallets as an overhang.** They sold in the first days; the token accounts are closed.
The launch bundle explains the post-launch crash, not the current holder map.

**"Hyperactive = bot = bad."** 3000+-tx wallets that buy repeatedly and never sell are people
running trading bots and accumulating. Treat them as fast hands, not as manipulation.

## Talking to the user

- Lead with the verdict and the non-obvious point. One sentence each.
- The user who asks "is it safe / when should I buy" already knows the generic risks. If you
  find yourself writing "a whale could dump" a second time, delete it. Say instead *which*
  wallets are the loose hands (recent big buyers with real money, launch-minute snipers), what
  a flush would look like in the tape, and what event could trigger it.
- Position sizing follows from the impact table: give the SOL amount that moves price ~5% and
  its dollar value; that is the exit-in-one-trade size.
- When a later run overturns something you said, retract first, then explain what the new
  evidence was. Users forgive being wrong; they do not forgive being confidently wrong twice.
- Give full addresses when the user might set alerts on them.
- Offer the graph when the finding *is* the link structure.

## Score reference (from the tool)

bundle 0.40 · fresh 0.25 · funder-cluster 0.25 · funded-by-holder 0.15 · insider 0.20 ·
churn 0.15 · burst 0.15 · buy-volume-driver 0.20 · scheduled-cadence 0.25 · same-size-buys
0.10 · launch sniper 0.15 · received-by-transfer-from-insider 0.25 · portfolio cluster 0.15 ·
automated 0.25 · dust-SOL 0.05 · exchange-funded −0.20. ≥ 0.50 bot, ≥ 0.25 suspicious. It is
a triage score; the report's per-wallet reasons are what you argue from.
