# Runbook — running the tool reliably

Everything here was learned the hard way in one session. Read it before the first run.

## Why GitHub Actions

Claude Code's remote sandbox routes HTTPS through an egress proxy that blocks every Solana
RPC and every DEX/explorer API (mainnet-beta, Helius, Solscan, DexScreener, Rugcheck,
pump.fun, GeckoTerminal, Birdeye, gmgn…). `WebFetch` is blocked on the same hosts. GitHub
is allowed, and GitHub Actions runners have open internet. So the tool runs there and
commits its report back to the branch. This mirrors the repo's existing `probe.yml` pattern.

## Files

- `tools/token-forensics.ts` — the analyser (copy in this skill's `scripts/`)
- `.github/workflows/token-probe.yml` — the runner (copy in `assets/`)
- `investigations/<SYMBOL>-<mint8>.md|json` — outputs, committed by the workflow

## Dispatching

- `workflow_dispatch` by **file name** returns 404 until the workflow file exists on the
  default branch. Dispatch by **numeric workflow id** instead; it works from any branch as
  soon as the workflow has run once. Get the id from `actions_list` / `list_workflows`
  (the repo's is 352391947 at time of writing).
- The very first run on a fresh repo therefore needs a trigger that does not depend on
  dispatch: temporarily add a `push:` trigger on the workflow path, push, then remove it.
  Or get the workflow onto the default branch.
- Inputs: `mint` (required), `top` (holders to fund-trace, default 150), `activity`
  (holders to profile, default 400). The workflow has a `concurrency` group so a second
  dispatch queues behind the first; GitHub replaces an already-queued run with the newer
  one.
- Optional secret `SOLANA_RPC_URLS`: comma-separated private RPC URLs. With it, a run takes
  ~3 minutes; without it 35–45 minutes. Suggest it to the user once, not repeatedly.

## Waiting

- Never `sleep`-poll in the foreground. Arm a `Monitor` (or a background `until` loop) that
  runs `git ls-remote origin refs/heads/<branch>` every 20 s and exits when the head changes.
  Monitors cap at 30 minutes, so re-arm once for a public-RPC run.
- Your own pushes change the head too and will trip the monitor; key the monitor to the head
  *after* your push, and expect one false event per push.
- The unauthenticated `api.github.com` is blocked from the sandbox; use the GitHub MCP
  tools (`actions_list`, `actions_get`, `get_job_logs`) for status and logs.

## Failure modes seen, and their fixes (all already in the tool)

| Symptom | Cause | Handling |
|---|---|---|
| Script dies with `undefined` on first RPC | empty `SOLANA_RPC_URLS` secret → `""`, which `??` accepted | `\|\|` fallback |
| Endpoint says "plan/token required" | publicnode, drpc, ankr reject keyless calls | marked dead on auth-like errors, rotate |
| getProgramAccounts returns `[]` with no error | public node disables token-program scans | treat empty as failure, rotate, fall back to largest accounts + Rugcheck |
| HTTP 429 storms | api.mainnet-beta limits ~40 calls/method/10 s per IP, shared across GitHub runners | 250 ms pacing, backoff to 8 s, every phase fails soft |
| Pool history shows only today | fast free nodes are **not archival**; they serve hours of `getSignaturesForAddress` | probe each endpoint's depth on the pool address, route history calls only to the deepest |
| Wallet ages of 0 and "fresh" flags everywhere | same non-archival truncation | fixed by the routing above; capped scans report age unknown |
| Provenance section missing | Rugcheck fallback dropped token-account addresses | keep `address` from Rugcheck top holders |
| Run killed at 45 min | too many history calls under throttling | timeout 150 min; lookups trimmed |
| Launch SOL column reads 0 | bonding curve holds native SOL, not WSOL | read the curve's lamport delta |

If a new failure appears: read the job log (stderr diagnostics are prefixed `!`), fix the
tool, push, and re-dispatch. Keep every phase soft-failing so a partial report still lands.

## Reading results without a commit

The workflow uploads `investigations/` as an artifact and prints the full markdown to the
job log. `get_job_logs` with `tail_lines` ~400 on the job id returns the report if the
commit step was rejected (e.g. you pushed while it ran).

## Costs and timing budget

A public-RPC run makes ~2,500 RPC calls in ~35 minutes: pool scan ~25 min, wallet activity
~10 min, deep modules ~10 min. If the user needs an answer faster, dispatch with smaller
`activity`/`top`, or ask for the RPC secret.
