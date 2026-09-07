/**
 * market-beta — does a token's own price follow SOL and Bitcoin?
 *
 * Reads the parsed pool swaps from a token-forensics JSON report, builds the
 * token's daily price in SOL, fetches SOL/USD and BTC/USD daily closes, and
 * reports correlation, beta, lagged correlation and a decomposition of the
 * USD move into "SOL leg" and "token-specific leg".
 *
 *   node --experimental-strip-types tools/market-beta.ts --report investigations/MAXIS-HHf2VfXS.json
 *
 * Zero dependencies. Runs on the Actions runner (price APIs are blocked in the sandbox).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const UA = 'market-beta/1.0 (+https://github.com/ryudi84/resources)';

async function getJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Daily closes for a Binance spot symbol; falls back to CoinGecko. */
async function dailyCloses(binanceSymbol: string, geckoId: string, days: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const k = (await getJson(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1d&limit=${days}`)) as unknown[][] | null;
  if (k && k.length) {
    for (const row of k) out.set(day(Number(row[0]) / 1000), Number(row[4]));
    return out;
  }
  const g = (await getJson(`https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}&interval=daily`)) as { prices: [number, number][] } | null;
  for (const [t, p] of g?.prices ?? []) out.set(day(t / 1000), p);
  return out;
}

export function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN;
}

export function beta(y: number[], x: number[]): number {
  const n = Math.min(x.length, y.length);
  const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  return sxx ? sxy / sxx : NaN;
}

/** Correlation of y[t] with x[t-lag]; positive lag = y follows x. */
export function laggedCorr(y: number[], x: number[], lag: number): number {
  if (lag >= 0) return pearson(y.slice(lag), x.slice(0, x.length - lag));
  return pearson(y.slice(0, y.length + lag), x.slice(-lag));
}

/** Forward-fill a sparse daily series over the full date range. */
export function fillDays(series: Map<string, number>): { days: string[]; values: number[] } {
  const keys = [...series.keys()].sort();
  if (!keys.length) return { days: [], values: [] };
  const days: string[] = [];
  const values: number[] = [];
  let cur = new Date(keys[0] + 'T00:00:00Z');
  const end = new Date(keys[keys.length - 1] + 'T00:00:00Z');
  let last = series.get(keys[0])!;
  while (cur <= end) {
    const k = cur.toISOString().slice(0, 10);
    if (series.has(k)) last = series.get(k)!;
    days.push(k);
    values.push(last);
    cur = new Date(cur.getTime() + 86_400_000);
  }
  return { days, values };
}

async function main() {
  const { values: args } = parseArgs({ options: { report: { type: 'string' }, days: { type: 'string', default: '60' } } });
  if (!args.report) {
    console.error('usage: market-beta --report investigations/<file>.json');
    process.exit(2);
  }
  const rep = JSON.parse(readFileSync(args.report, 'utf8')) as { name: string; symbol: string; mint: string; pool: { swaps: Array<{ time: number; tokens: number; sol: number; isBuy: boolean }> } | null };
  const swaps = (rep.pool?.swaps ?? []).filter((s) => s.tokens > 0 && s.sol > 0.02);
  if (swaps.length < 10) {
    console.error('not enough swaps in report');
    process.exit(1);
  }
  const byDay = new Map<string, number[]>();
  for (const s of swaps) (byDay.get(day(s.time)) ?? byDay.set(day(s.time), []).get(day(s.time))!).push((s.sol / s.tokens) * 1e6);
  const tokDaily = new Map<string, number>();
  for (const [k, v] of byDay) tokDaily.set(k, median(v));
  const tok = fillDays(tokDaily);
  const observedDays = new Set(byDay.keys());

  const DAYS = Number(args.days);
  const [sol, btc] = await Promise.all([dailyCloses('SOLUSDT', 'solana', DAYS + 5), dailyCloses('BTCUSDT', 'bitcoin', DAYS + 5)]);
  if (!sol.size || !btc.size) {
    console.error('price feeds unavailable');
    process.exit(1);
  }

  // Align on the token's date range where all three exist.
  const days = tok.days.filter((d) => sol.has(d) && btc.has(d));
  const pTok = days.map((d) => tok.values[tok.days.indexOf(d)]);
  const pSol = days.map((d) => sol.get(d)!);
  const pBtc = days.map((d) => btc.get(d)!);
  const pTokUsd = pTok.map((v, i) => v * pSol[i]);
  const lr = (p: number[]) => p.slice(1).map((v, i) => Math.log(v / p[i]));
  const rTok = lr(pTok), rSol = lr(pSol), rBtc = lr(pBtc), rTokUsd = lr(pTokUsd);

  // Only days where the token actually traded carry information; forward-filled days would dilute correlation toward zero.
  const idx = days.slice(1).map((d, i) => (observedDays.has(d) ? i : -1)).filter((i) => i >= 0);
  const pick = (r: number[]) => idx.map((i) => r[i]);

  const lags = [-2, -1, 0, 1, 2].map((lag) => ({ lag, vsBtc: laggedCorr(rTok, rBtc, lag), vsSol: laggedCorr(rTok, rSol, lag) }));
  const stepDays = days.slice(1).map((d, i) => ({ d, tok: rTok[i], btc: rBtc[i], sol: rSol[i], btcPrev: i ? rBtc[i - 1] : 0 })).filter((x) => Math.abs(x.tok) >= 0.1 && observedDays.has(x.d));

  const first = 0, last = days.length - 1;
  const totalUsd = Math.log(pTokUsd[last] / pTokUsd[first]);
  const solLeg = Math.log(pSol[last] / pSol[first]);
  const tokLeg = Math.log(pTok[last] / pTok[first]);
  const btcMove = Math.log(pBtc[last] / pBtc[first]);

  const L: string[] = [];
  L.push(`# Market beta: ${rep.name} ($${rep.symbol})`);
  L.push('');
  L.push(`Window ${days[first]} → ${days[last]} · ${days.length} days, ${observedDays.size} with trades · generated ${new Date().toISOString().slice(0, 16)}Z`);
  L.push('');
  L.push('## Decomposition of the USD move');
  L.push('');
  L.push('| Leg | Multiple | Share of log move |');
  L.push('|---|---:|---:|');
  L.push(`| Token in USD (total) | ${Math.exp(totalUsd).toFixed(2)}x | 100% |`);
  L.push(`| SOL/USD (Bitcoin-beta leg) | ${Math.exp(solLeg).toFixed(2)}x | ${((solLeg / totalUsd) * 100).toFixed(0)}% |`);
  L.push(`| Token/SOL (token-specific leg) | ${Math.exp(tokLeg).toFixed(2)}x | ${((tokLeg / totalUsd) * 100).toFixed(0)}% |`);
  L.push(`| Bitcoin over the same window | ${Math.exp(btcMove).toFixed(2)}x | – |`);
  L.push('');
  L.push('## Daily-return correlation (trade days only)');
  L.push('');
  L.push('| Pair | Pearson r | Beta | n |');
  L.push('|---|---:|---:|---:|');
  L.push(`| Token/SOL vs BTC/USD | ${pearson(pick(rTok), pick(rBtc)).toFixed(2)} | ${beta(pick(rTok), pick(rBtc)).toFixed(2)} | ${idx.length} |`);
  L.push(`| Token/SOL vs SOL/USD | ${pearson(pick(rTok), pick(rSol)).toFixed(2)} | ${beta(pick(rTok), pick(rSol)).toFixed(2)} | ${idx.length} |`);
  L.push(`| Token/USD vs BTC/USD | ${pearson(pick(rTokUsd), pick(rBtc)).toFixed(2)} | ${beta(pick(rTokUsd), pick(rBtc)).toFixed(2)} | ${idx.length} |`);
  L.push(`| SOL/USD vs BTC/USD (reference) | ${pearson(rSol, rBtc).toFixed(2)} | ${beta(rSol, rBtc).toFixed(2)} | ${rSol.length} |`);
  L.push('');
  L.push('Reading: |r| < 0.2 is noise; 0.2–0.5 weak; > 0.5 the token moves with the benchmark. Beta is the token/SOL return per 1.0 of benchmark return.');
  L.push('');
  L.push('## Lagged correlation, token/SOL vs Bitcoin (all days)');
  L.push('');
  L.push('| Lag (days) | r vs BTC | r vs SOL | Meaning |');
  L.push('|---:|---:|---:|---|');
  for (const l of lags) L.push(`| ${l.lag} | ${l.vsBtc.toFixed(2)} | ${l.vsSol.toFixed(2)} | ${l.lag > 0 ? `token follows benchmark by ${l.lag}d` : l.lag < 0 ? `token leads by ${-l.lag}d` : 'same day'} |`);
  L.push('');
  L.push('## Step days (token/SOL moved ≥ 10% on a trade day)');
  L.push('');
  L.push('| Day | Token/SOL | BTC same day | BTC prior day | SOL same day |');
  L.push('|---|---:|---:|---:|---:|');
  for (const s of stepDays) L.push(`| ${s.d} | ${(Math.exp(s.tok) * 100 - 100).toFixed(0)}% | ${(Math.exp(s.btc) * 100 - 100).toFixed(1)}% | ${(Math.exp(s.btcPrev) * 100 - 100).toFixed(1)}% | ${(Math.exp(s.sol) * 100 - 100).toFixed(1)}% |`);
  L.push('');
  L.push('## Daily series');
  L.push('');
  L.push('| Day | Token/SOL (per 1M) | Traded | SOL/USD | BTC/USD | Token/USD |');
  L.push('|---|---:|:-:|---:|---:|---:|');
  days.forEach((d, i) => L.push(`| ${d} | ${pTok[i].toFixed(4)} | ${observedDays.has(d) ? '●' : ''} | ${pSol[i].toFixed(2)} | ${pBtc[i].toFixed(0)} | ${(pTokUsd[i] / 1e6).toExponential(3)} |`));
  L.push('');
  L.push('Method: token price = median SOL/token of parsed pool swaps per UTC day (≥ 0.02 SOL trades), forward-filled on days without trades; benchmarks are Binance daily closes (CoinGecko fallback). Correlations use log returns; the per-pair table uses only days the token traded.');

  const base = args.report.replace(/\.json$/, '');
  writeFileSync(`${base}-beta.md`, L.join('\n'));
  writeFileSync(`${base}-beta.json`, JSON.stringify({ days, pTok, pSol, pBtc, pTokUsd, observed: [...observedDays], lags, stepDays, decomposition: { totalUsd, solLeg, tokLeg, btcMove } }, null, 2));
  console.log(L.join('\n'));
}

if (process.argv[1] && /market-beta\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
