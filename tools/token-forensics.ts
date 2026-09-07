/**
 * token-forensics — bot-vs-human holder analysis for a Solana SPL token.
 *
 * Zero dependencies, runs natively on Node 22+ (`--experimental-strip-types`).
 * The dev sandbox has no network access to Solana, so this is executed by the
 * `Token holder forensics` GitHub Actions workflow (see
 * .github/workflows/token-probe.yml), which commits the report back.
 *
 *   node --experimental-strip-types tools/token-forensics.ts --mint <MINT> [--out investigations] [--top 150] [--activity 400]
 *
 * Data sources (all free / keyless; each is optional and the report says what
 * was unavailable):
 *   - Solana JSON-RPC (public endpoints, rotated)  → full holder set, wallet
 *     age, tx counts, SOL balance, funding-source (first-tx fee payer).
 *   - pump.fun frontend API                         → creator, bonding-curve
 *     trade tape (slot-level timing for bundle/sniper detection, churn,
 *     identical-amount buy bursts).
 *   - Rugcheck                                      → insider graph clusters,
 *     risk flags, LP lock, authorities.
 *   - DexScreener + GeckoTerminal                   → liquidity, volume,
 *     buys/sells vs. unique buyers/sellers (wash-trade ratio).
 *
 * Methods (the "state of the art" for free, on-chain-only forensics):
 *   1. Bundle / sniper detection: buys landing in the creation slot (+2) are
 *      Jito-bundled with the deploy — the creator's own wallets or a sniper
 *      farm, never organic humans.
 *   2. Fresh-wallet ratio: wallets whose first-ever transaction is < 24 h
 *      before their first buy and have < 15 lifetime txs are farm wallets.
 *   3. Funding-source clustering (Bubblemaps/Arkham style): wallets funded by
 *      the same non-exchange wallet are one operator. Known CEX hot wallets
 *      are whitelisted as a human on-ramp signal.
 *   4. Insider graph from Rugcheck's transfer-graph clustering.
 *   5. Churn / wash: same wallet round-tripping repeatedly, or bursts of
 *      identical-size buys from "different" wallets within a minute.
 *   6. Unique-actor ratio: DEX trades per unique buyer over 24 h.
 *   7. Dust-holder inflation: holders with < 0.001 % of supply are usually
 *      airdrop/"holder-count" bots.
 *   8. Concentration: top-10 share of non-pool supply, creator holdings,
 *      authorities, LP lock.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------- constants

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** Program that owns an account → human label for pool/vault detection. */
const PROGRAM_LABELS: Record<string, string> = {
  [PUMP_PROGRAM]: 'pump.fun bonding curve',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap pool',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora pools',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool',
};

/**
 * Known centralised-exchange hot wallets (best-effort, public labels). A holder
 * whose first SOL came from one of these is a strong "real person on-ramped
 * from an exchange" signal. Unknown funders are clustered instead.
 */
const KNOWN_CEX: Record<string, string> = {
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Binance',
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: 'Coinbase',
  GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: 'Coinbase',
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm': 'Coinbase',
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFxY5XoWyAKG6DN': 'OKX',
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: 'Bybit',
  FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5: 'Kraken',
  BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6: 'KuCoin',
  u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w: 'Gate.io',
  ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ: 'MEXC',
  '5PAhQiYdLBd6SVdjzLQCRwqgn4MdNuUQ9ZnJ8vGyAZBu': 'Bitget',
};

const UA = 'token-forensics/1.0 (+https://github.com/ryudi84/resources)';

// ------------------------------------------------------------------- types

export interface Holder {
  owner: string;
  amount: number; // ui amount
  pct: number; // % of total supply
  ownerProgram?: string; // program owning the wallet account (System = normal wallet)
  label?: string; // pool / vault label
  lamports?: number;
  txCount?: number; // capped
  txCountCapped?: boolean;
  firstTxTime?: number; // unix seconds (true first tx if !txCountCapped)
  lastTxTime?: number;
  funder?: string;
  funderCex?: string;
  fundedBySameAs?: number; // size of funder cluster (holders sharing funder)
  insider?: boolean; // rugcheck insider flag
  insiderNetwork?: string;
  bundled?: boolean; // bought in creation slot (+2)
  firstBuySlot?: number;
  firstBuyTime?: number;
  buys?: number;
  sells?: number;
  solIn?: number;
  solOut?: number;
  churn?: boolean;
  burstBuyer?: boolean; // part of an identical-amount buy burst
  freshAtBuy?: boolean;
  recentBuys?: number;
  recentSells?: number;
  recentSolIn?: number;
  recentSolOut?: number;
  buyShare?: number; // share of recent pool buy volume
  regularBuyer?: boolean; // scheduled-looking buy cadence
  repeatSize?: number;
  score?: number;
  verdict?: 'bot' | 'suspicious' | 'organic' | 'pool' | 'unknown';
  reasons?: string[];
}

interface Trade {
  signature: string;
  user: string;
  is_buy: boolean;
  sol_amount: number; // lamports
  token_amount: number;
  timestamp: number;
  slot: number;
}

// ----------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, timeoutMs = 25_000, retries = 2): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      last = e;
      if (i < retries) await sleep(1500 * 2 ** i);
    }
  }
  console.error(`  ! ${url} failed: ${String(last)}`);
  return null;
}

/** Bounded concurrency map, preserving order. */
async function pmap<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// --------------------------------------------------------------------- RPC

/**
 * Keyless public endpoints. They are probed at startup (getSlot) and only the
 * responsive ones are kept, fastest first; SOLANA_RPC_URLS (comma-separated,
 * e.g. a Helius/QuickNode key URL) is prepended and always preferred.
 * `||` not `??`: an unset Actions secret arrives as an empty string.
 */
const RPC_CANDIDATES = [
  ...(process.env.SOLANA_RPC_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
  'https://solana.api.onfinality.io/public',
  'https://solana.blockpi.network/v1/rpc/public',
  'https://endpoints.omniatech.io/v1/sol/mainnet/public',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
  'https://solana.leorpc.com/?api_key=FREE',
  'https://solana.public-rpc.com',
  'https://mainnet.rpcpool.com',
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
];
let RPC_URLS: string[] = [...RPC_CANDIDATES];

async function selectRpcEndpoints(): Promise<void> {
  const pinned = (process.env.SOLANA_RPC_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const results = await Promise.all(
    RPC_CANDIDATES.map(async (url) => {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': UA },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
          signal: AbortSignal.timeout(8000),
        });
        const body = (await res.json()) as { result?: number; error?: { message: string } };
        if (!res.ok || typeof body.result !== 'number') return { url, ms: Infinity, why: body.error?.message ?? `HTTP ${res.status}` };
        return { url, ms: Date.now() - t0 };
      } catch (e) {
        return { url, ms: Infinity, why: String((e as Error).message ?? e) };
      }
    }),
  );
  const ok = results.filter((r) => r.ms < Infinity).sort((a, b) => a.ms - b.ms);
  for (const r of results) console.error(`  rpc ${r.ms < Infinity ? `${r.ms}ms` : 'FAIL'} ${r.url}${r.why ? ` (${r.why})` : ''}`);
  RPC_URLS = [...pinned.filter((u) => ok.some((r) => r.url === u)), ...ok.map((r) => r.url).filter((u) => !pinned.includes(u))];
  if (RPC_URLS.length === 0) RPC_URLS = [...RPC_CANDIDATES];
  console.error(`  using ${RPC_URLS.length} endpoint(s): ${RPC_URLS.join(', ')}`);
}

let rpcIdx = 0;
let rpcCalls = 0;
let lastRpcAt = 0;
const deadRpc = new Set<string>();
// api.mainnet-beta.solana.com allows ~40 calls of one method per 10 s.
const RPC_MIN_GAP_MS = Number(process.env.RPC_MIN_GAP_MS || 250);
const AUTH_ERR = /api.?key|token|plan|unauthori|forbidden|not available|not supported|disabled|upgrade|indexed requests/i;

function liveRpcUrl(): string | undefined {
  for (let i = 0; i < RPC_URLS.length; i++) {
    const url = RPC_URLS[(rpcIdx + i) % RPC_URLS.length];
    if (!deadRpc.has(url)) {
      rpcIdx = (rpcIdx + i) % RPC_URLS.length;
      return url;
    }
  }
  return undefined;
}

async function rpc<T = unknown>(method: string, params: unknown[], timeoutMs = 60_000): Promise<T> {
  let lastErr: unknown = new Error(`${method}: all RPC endpoints failed`);
  for (let attempt = 0; attempt < Math.max(24, RPC_URLS.length * 6); attempt++) {
    const url = liveRpcUrl();
    if (!url) break;
    const wait = lastRpcAt + RPC_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRpcAt = Date.now();
    rpcCalls++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`HTTP ${res.status}`), { auth: true });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) {
        const msg = body.error.message ?? String(body.error.code);
        throw Object.assign(new Error(msg), { auth: AUTH_ERR.test(msg) });
      }
      return body.result as T;
    } catch (e) {
      lastErr = e;
      if ((e as { auth?: boolean }).auth) {
        console.error(`  ! ${url} rejected (${String((e as Error).message)}); dropping endpoint`);
        deadRpc.add(url);
      }
      else if (attempt % 6 === 5) console.error(`  ! ${method} via ${url}: ${String((e as Error).message ?? e)} (attempt ${attempt + 1})`);
      rpcIdx++;
      await sleep(Math.min(500 * (attempt + 1), 8000));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------- data fetchers

async function fetchSupply(mint: string): Promise<{ amount: number; decimals: number }> {
  const r = await rpc<{ value: { uiAmount: number; decimals: number } }>('getTokenSupply', [mint]);
  return { amount: r.value.uiAmount, decimals: r.value.decimals };
}

/**
 * Every token account for the mint via getProgramAccounts (mint memcmp
 * filter). Some public endpoints silently return [] for token-program scans,
 * so an empty result rotates to the next endpoint before giving up.
 */
async function fetchAllHolders(mint: string, supply: number): Promise<Holder[] | null> {
  for (let attempt = 0; attempt < RPC_URLS.length; attempt++) {
    try {
      const accounts = await rpc<
        Array<{ account: { data: { parsed: { info: { owner: string; tokenAmount: { uiAmount: number } } } } } }>
      >(
        'getProgramAccounts',
        [
          TOKEN_PROGRAM,
          {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
            filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
          },
        ],
        120_000,
      );
      if (!Array.isArray(accounts) || accounts.length === 0) {
        console.error(`  ! getProgramAccounts returned nothing from ${RPC_URLS[rpcIdx % RPC_URLS.length]}; rotating`);
        rpcIdx++;
        continue;
      }
      const byOwner = new Map<string, number>();
      for (const a of accounts) {
        const info = a.account.data.parsed.info;
        const amt = info.tokenAmount.uiAmount ?? 0;
        if (amt > 0) byOwner.set(info.owner, (byOwner.get(info.owner) ?? 0) + amt);
      }
      return [...byOwner]
        .map(([owner, amount]) => ({ owner, amount, pct: (amount / supply) * 100 }))
        .sort((a, b) => b.amount - a.amount);
    } catch (e) {
      console.error(`  ! getProgramAccounts failed (${String(e)}); rotating`);
      rpcIdx++;
    }
  }
  console.error('  ! full holder scan unavailable on every endpoint; falling back to largest accounts + Rugcheck');
  return null;
}

/** Merge Rugcheck's top-holder list (owner + pct) into a partial holder set. */
function mergeRugcheckHolders(holders: Holder[], rug: Record<string, any> | null, supply: number): Holder[] {
  const byOwner = new Map(holders.map((h) => [h.owner, h]));
  for (const th of (rug?.topHolders ?? []) as Array<{ owner?: string; address?: string; pct?: number; uiAmount?: number }>) {
    const owner = th.owner ?? th.address;
    if (!owner || byOwner.has(owner)) continue;
    const pct = th.pct ?? ((th.uiAmount ?? 0) / supply) * 100;
    if (pct <= 0) continue;
    byOwner.set(owner, { owner, amount: (pct / 100) * supply, pct });
  }
  return [...byOwner.values()].sort((a, b) => b.amount - a.amount);
}

async function fetchLargestHolders(mint: string, supply: number): Promise<Holder[]> {
  let r: { value: Array<{ address: string; uiAmount: number }> };
  try {
    r = await rpc<{ value: Array<{ address: string; uiAmount: number }> }>('getTokenLargestAccounts', [mint]);
  } catch (e) {
    console.error(`  ! getTokenLargestAccounts failed (${String(e)}); using Rugcheck top holders only`);
    return [];
  }
  const tokenAccounts = r.value.filter((v) => v.uiAmount > 0);
  const infos = await rpc<{ value: Array<{ data: { parsed: { info: { owner: string } } } } | null> }>(
    'getMultipleAccounts',
    [tokenAccounts.map((t) => t.address), { encoding: 'jsonParsed' }],
  );
  const byOwner = new Map<string, number>();
  tokenAccounts.forEach((t, i) => {
    const owner = infos.value[i]?.data.parsed.info.owner ?? t.address;
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + t.uiAmount);
  });
  return [...byOwner]
    .map(([owner, amount]) => ({ owner, amount, pct: (amount / supply) * 100 }))
    .sort((a, b) => b.amount - a.amount);
}

/** Owner program + SOL balance for wallets, batched 100 per call. */
async function annotateAccounts(holders: Holder[]): Promise<void> {
  for (let i = 0; i < holders.length; i += 100) {
    const batch = holders.slice(i, i + 100);
    let r: { value: Array<{ owner: string; lamports: number } | null> };
    try {
      r = await rpc('getMultipleAccounts', [batch.map((h) => h.owner), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    } catch (e) {
      console.error(`  ! getMultipleAccounts failed (${String(e)}); assuming system wallets`);
      batch.forEach((h) => {
        h.ownerProgram = h.ownerProgram ?? (PROGRAM_LABELS[h.owner] ? h.owner : SYSTEM_PROGRAM);
      });
      continue;
    }
    batch.forEach((h, j) => {
      const acc = r.value[j];
      h.ownerProgram = acc?.owner ?? SYSTEM_PROGRAM; // missing account = never-funded system wallet
      h.lamports = acc?.lamports ?? 0;
      if (h.ownerProgram !== SYSTEM_PROGRAM) h.label = PROGRAM_LABELS[h.ownerProgram] ?? `program ${h.ownerProgram.slice(0, 6)}…`;
    });
  }
}

interface SigInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
}

/** Lifetime tx count (capped at 1000 × maxPages), first/last tx time, first signature. */
async function walletActivity(owner: string, maxPages: number): Promise<{
  count: number;
  capped: boolean;
  first?: SigInfo;
  last?: SigInfo;
}> {
  let count = 0;
  let before: string | undefined;
  let first: SigInfo | undefined;
  let last: SigInfo | undefined;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await rpc<SigInfo[]>('getSignaturesForAddress', [owner, { limit: 1000, before }]);
    if (sigs.length === 0) return { count, capped: false, first, last };
    if (!last) last = sigs[0];
    first = sigs[sigs.length - 1];
    count += sigs.length;
    if (sigs.length < 1000) return { count, capped: false, first, last };
    before = first.signature;
  }
  return { count, capped: true, first, last };
}

/** Fee payer of a wallet's first transaction = who funded it. */
async function funderOf(owner: string, firstSig: string): Promise<string | undefined> {
  try {
    const tx = await rpc<{
      transaction: { message: { accountKeys: Array<{ pubkey: string; signer: boolean }> } };
    } | null>('getTransaction', [firstSig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    const keys = tx?.transaction.message.accountKeys ?? [];
    const payer = keys[0]?.pubkey;
    if (payer && payer !== owner) return payer;
    // Wallet paid its own first tx (e.g. created via a CEX withdrawal that
    // lands as a system transfer where the CEX is payer — handled above — or
    // the account pre-dates the signature window). Try the first other signer.
    const other = keys.find((k) => k.signer && k.pubkey !== owner);
    return other?.pubkey;
  } catch {
    return undefined;
  }
}

async function fetchPumpCoin(mint: string): Promise<Record<string, unknown> | null> {
  return (await getJson(`https://frontend-api-v3.pump.fun/coins/${mint}`)) as Record<string, unknown> | null;
}

async function fetchPumpTrades(mint: string, max = 20_000): Promise<Trade[]> {
  const out: Trade[] = [];
  for (let offset = 0; offset < max; offset += 200) {
    const page = (await getJson(
      `https://frontend-api-v3.pump.fun/trades/all/${mint}?limit=200&offset=${offset}&minimumSize=0`,
    )) as Trade[] | null;
    if (!page || page.length === 0) break;
    out.push(...page);
    if (page.length < 200) break;
    await sleep(150);
  }
  return out;
}

async function fetchRugcheck(mint: string): Promise<Record<string, any> | null> {
  return (await getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`)) as Record<string, any> | null;
}

async function fetchDexscreener(mint: string): Promise<Record<string, any> | null> {
  return (await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)) as Record<string, any> | null;
}

async function fetchGecko(mint: string): Promise<Record<string, any> | null> {
  return (await getJson(
    `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}?include=top_pools`,
  )) as Record<string, any> | null;
}


// ------------------------------------------------------ pool trade parsing

export interface PoolTrade {
  signature: string;
  slot: number;
  time: number;
  trader: string;
  isBuy: boolean;
  tokens: number;
  sol: number;
}

/**
 * Recent swaps on the AMM pool, parsed from raw transactions: the trader is the
 * non-pool owner whose token balance moved; SOL is the pool's WSOL vault delta.
 */
async function fetchPoolTrades(
  pool: string,
  mint: string,
  opts: { maxSigs: number; parseTx: number; sinceDays: number },
): Promise<{ trades: PoolTrade[]; sigTimes: number[]; sigsScanned: number; parsed: number; failed: number }> {
  const since = Math.floor(Date.now() / 1000) - opts.sinceDays * 86_400;
  const sigs: SigInfo[] = [];
  let before: string | undefined;
  while (sigs.length < opts.maxSigs) {
    const page = await rpc<Array<SigInfo & { err: unknown }>>('getSignaturesForAddress', [pool, { limit: 1000, before }]);
    if (page.length === 0) break;
    for (const s of page) if (!s.err) sigs.push(s);
    before = page[page.length - 1].signature;
    if ((page[page.length - 1].blockTime ?? 0) < since || page.length < 1000) break;
  }
  const sigTimes = sigs.map((s) => s.blockTime ?? 0).filter(Boolean);
  const targets = sigs.slice(0, opts.parseTx);
  let failed = 0;
  const trades = await pmap(targets, 3, async (s): Promise<PoolTrade | null> => {
    try {
      const tx = await rpc<{
        blockTime: number | null;
        meta: {
          err: unknown;
          preTokenBalances: Array<{ mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }>;
          postTokenBalances: Array<{ mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }>;
        } | null;
      } | null>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      if (!tx?.meta || tx.meta.err) return null;
      const delta = new Map<string, number>(); // `${owner}|${mint}` → post - pre
      for (const b of tx.meta.preTokenBalances) if (b.owner) delta.set(`${b.owner}|${b.mint}`, -(b.uiTokenAmount.uiAmount ?? 0));
      for (const b of tx.meta.postTokenBalances) if (b.owner) {
        const k = `${b.owner}|${b.mint}`;
        delta.set(k, (delta.get(k) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
      }
      const WSOL = 'So11111111111111111111111111111111111111112';
      const poolSol = delta.get(`${pool}|${WSOL}`) ?? 0;
      const poolTok = delta.get(`${pool}|${mint}`) ?? 0;
      let trader: string | undefined;
      let tokens = 0;
      for (const [k, v] of delta) {
        const [owner, m] = k.split('|');
        if (m !== mint || owner === pool || Math.abs(v) < 1e-9) continue;
        if (!trader || Math.abs(v) > Math.abs(tokens)) {
          trader = owner;
          tokens = v;
        }
      }
      if (!trader || Math.abs(poolTok) < 1e-9) return null; // not a swap (LP op, transfer)
      const isBuy = poolTok < 0;
      return { signature: s.signature, slot: s.slot, time: tx.blockTime ?? s.blockTime ?? 0, trader, isBuy, tokens: Math.abs(tokens), sol: Math.abs(poolSol) };
    } catch {
      failed++;
      return null;
    }
  });
  return { trades: trades.filter((t): t is PoolTrade => t !== null), sigTimes, sigsScanned: sigs.length, parsed: targets.length, failed };
}

export interface TraderStat {
  trader: string;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  tokensIn: number;
  tokensOut: number;
  first: number;
  last: number;
  buyTimes: number[];
  buySizes: number[];
  intervalCv?: number; // coefficient of variation of buy intervals (low = scheduled)
  repeatSize?: number; // largest count of identical-size buys
}

export function analysePoolTrades(trades: PoolTrade[]): {
  stats: TraderStat[];
  buyVol: number;
  sellVol: number;
  buyers: number;
  sellers: number;
  topBuyerShare: number;
  top3BuyerShare: number;
  regularBuyers: string[];
} {
  const m = new Map<string, TraderStat>();
  let buyVol = 0;
  let sellVol = 0;
  for (const t of trades) {
    const st = m.get(t.trader) ?? { trader: t.trader, buys: 0, sells: 0, solIn: 0, solOut: 0, tokensIn: 0, tokensOut: 0, first: t.time, last: t.time, buyTimes: [], buySizes: [] };
    if (t.isBuy) {
      st.buys++;
      st.solIn += t.sol;
      st.tokensIn += t.tokens;
      st.buyTimes.push(t.time);
      st.buySizes.push(t.sol);
      buyVol += t.sol;
    } else {
      st.sells++;
      st.solOut += t.sol;
      st.tokensOut += t.tokens;
      sellVol += t.sol;
    }
    st.first = Math.min(st.first, t.time);
    st.last = Math.max(st.last, t.time);
    m.set(t.trader, st);
  }
  const regular: string[] = [];
  for (const st of m.values()) {
    if (st.buyTimes.length >= 4) {
      const ts = [...st.buyTimes].sort((a, b) => a - b);
      const iv = ts.slice(1).map((t, i) => t - ts[i]).filter((x) => x > 0);
      if (iv.length >= 3) {
        const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
        const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
        st.intervalCv = mean > 0 ? sd / mean : undefined;
        if (st.intervalCv !== undefined && st.intervalCv < 0.35) regular.push(st.trader);
      }
    }
    if (st.buySizes.length >= 3) {
      const counts = new Map<string, number>();
      for (const sz of st.buySizes) {
        const k = sz.toFixed(2);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      st.repeatSize = Math.max(...counts.values());
    }
  }
  const stats = [...m.values()].sort((a, b) => b.solIn + b.solOut - (a.solIn + a.solOut));
  const byBuy = [...stats].sort((a, b) => b.solIn - a.solIn);
  const topBuyerShare = buyVol > 0 ? (byBuy[0]?.solIn ?? 0) / buyVol : 0;
  const top3BuyerShare = buyVol > 0 ? byBuy.slice(0, 3).reduce((s, x) => s + x.solIn, 0) / buyVol : 0;
  return {
    stats,
    buyVol,
    sellVol,
    buyers: stats.filter((s) => s.buys > 0).length,
    sellers: stats.filter((s) => s.sells > 0).length,
    topBuyerShare,
    top3BuyerShare,
    regularBuyers: regular,
  };
}

/** Trades per UTC day from signature block times (cheap activity histogram). */
export function dailyHistogram(times: number[], days: number): Array<{ day: string; n: number }> {
  const now = Math.floor(Date.now() / 1000);
  const out: Array<{ day: string; n: number }> = [];
  for (let d = days - 1; d >= 0; d--) {
    const start = now - (d + 1) * 86_400;
    const end = now - d * 86_400;
    out.push({ day: new Date(end * 1000).toISOString().slice(5, 10), n: times.filter((t) => t >= start && t < end).length });
  }
  return out;
}

// ------------------------------------------------------------- analytics

export interface TradeStats {
  trades: number;
  uniqueUsers: number;
  createSlot: number;
  createTime: number;
  bundledBuyers: string[]; // bought within creation slot + 2
  earlyBuyers: string[]; // first 20 slots
  bundledSolIn: number;
  perUser: Map<string, { buys: number; sells: number; solIn: number; solOut: number; firstSlot: number; firstTime: number; lastTime: number }>;
  churners: string[];
  burstBuyers: string[];
  bursts: Array<{ sol: number; count: number; startTime: number; users: number }>;
  buyVolumeSol: number;
  sellVolumeSol: number;
}

export function analyseTrades(trades: Trade[]): TradeStats | null {
  if (trades.length === 0) return null;
  const sorted = [...trades].sort((a, b) => a.slot - b.slot || a.timestamp - b.timestamp);
  const createSlot = sorted[0].slot;
  const createTime = sorted[0].timestamp;
  const perUser: TradeStats['perUser'] = new Map();
  const bundled = new Set<string>();
  const early = new Set<string>();
  let bundledSolIn = 0;
  let buyVol = 0;
  let sellVol = 0;
  for (const t of sorted) {
    const sol = t.sol_amount / 1e9;
    const u = perUser.get(t.user) ?? { buys: 0, sells: 0, solIn: 0, solOut: 0, firstSlot: t.slot, firstTime: t.timestamp, lastTime: t.timestamp };
    if (t.is_buy) {
      u.buys++;
      u.solIn += sol;
      buyVol += sol;
      if (t.slot <= createSlot + 2) {
        bundled.add(t.user);
        bundledSolIn += sol;
      }
      if (t.slot <= createSlot + 20) early.add(t.user);
    } else {
      u.sells++;
      u.solOut += sol;
      sellVol += sol;
    }
    u.lastTime = Math.max(u.lastTime, t.timestamp);
    perUser.set(t.user, u);
  }

  // Churn: ≥3 buys AND ≥3 sells with the whole activity inside 30 minutes, or
  // ≥6 round trips regardless of time.
  const churners: string[] = [];
  for (const [user, u] of perUser) {
    const span = u.lastTime - u.firstTime;
    if ((u.buys >= 3 && u.sells >= 3 && span < 1800) || (u.buys >= 6 && u.sells >= 6)) churners.push(user);
  }

  // Identical-amount buy bursts: ≥5 buys of the same SOL size (to 0.001 SOL)
  // within 60 s from ≥3 distinct users → scripted volume.
  const buys = sorted.filter((t) => t.is_buy);
  const byAmt = new Map<string, Trade[]>();
  for (const t of buys) {
    const key = (Math.round(t.sol_amount / 1e6) / 1e3).toFixed(3);
    if (Number(key) === 0) continue;
    (byAmt.get(key) ?? byAmt.set(key, []).get(key)!).push(t);
  }
  const bursts: TradeStats['bursts'] = [];
  const burstBuyers = new Set<string>();
  for (const [key, list] of byAmt) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && list[j + 1].timestamp - list[i].timestamp <= 60) j++;
      const window = list.slice(i, j + 1);
      const users = new Set(window.map((t) => t.user));
      if (window.length >= 5 && users.size >= 3) {
        bursts.push({ sol: Number(key), count: window.length, startTime: list[i].timestamp, users: users.size });
        for (const u of users) burstBuyers.add(u);
        i = j + 1;
      } else i++;
    }
  }

  return {
    trades: trades.length,
    uniqueUsers: perUser.size,
    createSlot,
    createTime,
    bundledBuyers: [...bundled],
    earlyBuyers: [...early],
    bundledSolIn,
    perUser,
    churners,
    burstBuyers: [...burstBuyers],
    bursts: bursts.sort((a, b) => b.count - a.count),
    buyVolumeSol: buyVol,
    sellVolumeSol: sellVol,
  };
}

/** Group holders by funder; returns funder → holders (non-CEX only, size ≥ 2). */
export function funderClusters(holders: Holder[]): Map<string, Holder[]> {
  const m = new Map<string, Holder[]>();
  for (const h of holders) {
    if (!h.funder || h.funderCex) continue;
    (m.get(h.funder) ?? m.set(h.funder, []).get(h.funder)!).push(h);
  }
  for (const [k, v] of m) if (v.length < 2) m.delete(k);
  return m;
}

/** Bot-likelihood score per holder from the accumulated features. */
export function scoreHolder(h: Holder, ctx: { holderSet: Set<string>; creator?: string }): void {
  const reasons: string[] = [];
  if (h.ownerProgram && h.ownerProgram !== SYSTEM_PROGRAM) {
    h.verdict = 'pool';
    h.score = 0;
    h.reasons = [h.label ?? 'program-owned account'];
    return;
  }
  let s = 0;
  if (h.bundled) {
    s += 0.4;
    reasons.push('bought in the creation bundle (same/next slot as deploy)');
  }
  if (h.freshAtBuy) {
    s += 0.25;
    reasons.push('fresh wallet: first tx < 24h before its buy, < 15 lifetime txs');
  }
  if (h.fundedBySameAs && h.fundedBySameAs >= 3) {
    s += 0.25;
    reasons.push(`funded by the same wallet as ${h.fundedBySameAs - 1} other holders (${h.funder?.slice(0, 6)}…)`);
  } else if (h.fundedBySameAs === 2) {
    s += 0.1;
    reasons.push(`shares its funder with 1 other holder`);
  }
  if (h.funder && ctx.holderSet.has(h.funder) && h.funder !== h.owner) {
    s += 0.15;
    reasons.push('funded directly by another holder');
  }
  if (h.insider) {
    s += 0.2;
    reasons.push(`Rugcheck insider cluster${h.insiderNetwork ? ` ${h.insiderNetwork}` : ''}`);
  }
  if (h.churn) {
    s += 0.15;
    reasons.push('rapid buy/sell round-trips (wash pattern)');
  }
  if (h.burstBuyer) {
    s += 0.15;
    reasons.push('part of an identical-amount buy burst');
  }
  if (h.buyShare !== undefined && h.buyShare >= 0.2) {
    s += 0.2;
    reasons.push(`drives ${(h.buyShare * 100).toFixed(0)}% of recent buy volume`);
  }
  if (h.regularBuyer) {
    s += 0.25;
    reasons.push('buys on a regular cadence (scheduled bot)');
  }
  if (h.repeatSize && h.repeatSize >= 3) {
    s += 0.1;
    reasons.push(`${h.repeatSize} identical-size buys`);
  }
  if (h.txCountCapped) {
    s += 0.1;
    reasons.push(`hyperactive wallet (≥${h.txCount} txs; trading bot or MEV)`);
  }
  if (h.funderCex) {
    s -= 0.2;
    reasons.push(`funded from ${h.funderCex} (exchange on-ramp → real person)`);
  }
  if (h.lamports !== undefined && h.lamports < 5_000_000 && !h.funderCex) {
    s += 0.05;
    reasons.push('near-zero SOL balance (disposable wallet)');
  }
  if (ctx.creator && h.owner === ctx.creator) reasons.push('token creator');
  h.score = Math.max(0, Math.min(1, s));
  h.verdict = h.score >= 0.5 ? 'bot' : h.score >= 0.25 ? 'suspicious' : h.txCount === undefined ? 'unknown' : 'organic';
  h.reasons = reasons;
}

// ------------------------------------------------------------------ main

const fmtPct = (n: number) => `${n.toFixed(2)}%`;
const fmtSol = (n: number) => `${n.toFixed(2)} SOL`;
const fmtUsd = (n: unknown) => (typeof n === 'number' || (typeof n === 'string' && n !== '') ? `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'n/a');
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const iso = (t?: number | null) => (t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : 'n/a');

async function main() {
  const { values } = parseArgs({
    options: {
      mint: { type: 'string' },
      out: { type: 'string', default: 'investigations' },
      top: { type: 'string', default: '150' },
      activity: { type: 'string', default: '400' },
      'parse-tx': { type: 'string', default: '350' },
      days: { type: 'string', default: '30' },
    },
  });
  const mint = values.mint;
  if (!mint) {
    console.error('usage: token-forensics --mint <MINT> [--out dir] [--top N] [--activity N]');
    process.exit(2);
  }
  const TOP = Number(values.top);
  const ACTIVITY = Number(values.activity);
  const PARSE_TX = Number(values['parse-tx']);
  const DAYS = Number(values.days);
  const startedAt = Date.now();
  const now = Math.floor(startedAt / 1000);
  const unavailable: string[] = [];

  console.error(`== token-forensics ${mint}`);

  // Off-chain sources in parallel with the RPC endpoint probe.
  const [pump, rug, dex, gecko] = await Promise.all([
    fetchPumpCoin(mint),
    fetchRugcheck(mint),
    fetchDexscreener(mint),
    fetchGecko(mint),
    selectRpcEndpoints(),
  ]);
  let supply: { amount: number; decimals: number };
  try {
    supply = await fetchSupply(mint);
  } catch (e) {
    const m = rug?.markets?.[0]?.mintAAccount;
    if (!m) throw e;
    supply = { amount: Number(m.supply) / 10 ** Number(m.decimals), decimals: Number(m.decimals) };
    console.error(`  ! getTokenSupply failed (${String(e)}); using Rugcheck supply`);
  }
  if (!pump) unavailable.push('pump.fun coin API');
  if (!rug) unavailable.push('Rugcheck');
  if (!dex) unavailable.push('DexScreener');
  if (!gecko) unavailable.push('GeckoTerminal');

  console.error(`  supply ${supply.amount} (dec ${supply.decimals})`);
  let holders = await fetchAllHolders(mint, supply.amount);
  let holderSetComplete = true;
  if (!holders) {
    holderSetComplete = false;
    holders = mergeRugcheckHolders(await fetchLargestHolders(mint, supply.amount), rug, supply.amount);
  }
  console.error(`  holders: ${holders.length}${holderSetComplete ? '' : ' (largest accounts + Rugcheck top holders only)'}`);
  const creator = (pump?.creator as string | undefined) ?? (rug?.creator as string | undefined);

  // Recent swaps on the main AMM pool, parsed from chain.
  const poolAddr: string | undefined =
    (pump?.pump_swap_pool as string) ?? (pump?.raydium_pool as string) ?? dex?.pairs?.[0]?.pairAddress ?? rug?.markets?.[0]?.pubkey;
  let poolScan: Awaited<ReturnType<typeof fetchPoolTrades>> | null = null;
  let pa: ReturnType<typeof analysePoolTrades> | null = null;
  if (poolAddr) {
    try {
      poolScan = await fetchPoolTrades(poolAddr, mint, { maxSigs: 6000, parseTx: PARSE_TX, sinceDays: DAYS });
      pa = analysePoolTrades(poolScan.trades);
      console.error(`  pool ${poolAddr}: ${poolScan.sigsScanned} sigs, ${poolScan.trades.length} swaps parsed of ${poolScan.parsed}`);
    } catch (e) {
      console.error(`  ! pool scan failed: ${String(e)}`);
      unavailable.push('pool transaction scan');
    }
  } else unavailable.push('pool address (no market found)');

  // Recent traders join the profiling set so the price-drivers get funding/age checks.
  if (pa) {
    const known = new Set(holders.map((h) => h.owner));
    for (const st of pa.stats.slice(0, 60)) {
      if (!known.has(st.trader)) holders.push({ owner: st.trader, amount: 0, pct: 0 });
    }
    const byOwner = new Map(holders.map((h) => [h.owner, h]));
    for (const st of pa.stats) {
      const h = byOwner.get(st.trader);
      if (!h) continue;
      h.recentBuys = st.buys;
      h.recentSells = st.sells;
      h.recentSolIn = st.solIn;
      h.recentSolOut = st.solOut;
      h.buyShare = pa.buyVol > 0 ? st.solIn / pa.buyVol : 0;
      h.regularBuyer = pa.regularBuyers.includes(st.trader);
      h.repeatSize = st.repeatSize;
    }
  }

  await annotateAccounts(holders);

  // Trade tape.
  const trades = pump ? await fetchPumpTrades(mint) : [];
  if (pump && trades.length === 0) unavailable.push('pump.fun trade tape');
  const ts = analyseTrades(trades);
  console.error(`  trades: ${trades.length}`);

  const wallets = holders.filter((h) => h.ownerProgram === SYSTEM_PROGRAM);
  const holderSet = new Set(holders.filter((h) => h.pct > 0).map((h) => h.owner));

  // Rugcheck insiders.
  if (rug) {
    const insiderAddrs = new Map<string, string>();
    for (const th of (rug.topHolders ?? []) as Array<{ owner: string; insider?: boolean }>) {
      if (th.insider) insiderAddrs.set(th.owner, 'top-holder');
    }
    for (const net of (rug.insiderNetworks ?? []) as Array<{ id: string; wallets?: string[] }>) {
      for (const w of net.wallets ?? []) insiderAddrs.set(w, net.id);
    }
    for (const h of holders) {
      const n = insiderAddrs.get(h.owner);
      if (n) {
        h.insider = true;
        h.insiderNetwork = n;
      }
    }
  }

  // Trade features onto holders.
  if (ts) {
    const bundled = new Set(ts.bundledBuyers);
    const churn = new Set(ts.churners);
    const burst = new Set(ts.burstBuyers);
    for (const h of holders) {
      const u = ts.perUser.get(h.owner);
      if (u) {
        h.buys = u.buys;
        h.sells = u.sells;
        h.solIn = u.solIn;
        h.solOut = u.solOut;
        h.firstBuySlot = u.firstSlot;
        h.firstBuyTime = u.firstTime;
      }
      h.bundled = bundled.has(h.owner);
      h.churn = churn.has(h.owner);
      h.burstBuyer = burst.has(h.owner);
    }
  }

  // Wallet activity (cheap) for the top ACTIVITY wallets, funding (expensive)
  // for the top TOP wallets.
  const activityTargets = wallets.slice(0, ACTIVITY);
  console.error(`  activity lookups: ${activityTargets.length}, funding lookups: ${Math.min(TOP, wallets.length)}`);
  let activityFailures = 0;
  await pmap(activityTargets, 3, async (h, i) => {
    const deep = i < TOP;
    let a: Awaited<ReturnType<typeof walletActivity>>;
    try {
      a = await walletActivity(h.owner, deep ? 3 : 1);
    } catch {
      activityFailures++;
      return;
    }
    h.txCount = a.count;
    h.txCountCapped = a.capped;
    h.firstTxTime = a.first?.blockTime ?? undefined;
    h.lastTxTime = a.last?.blockTime ?? undefined;
    if (deep && a.first && !a.capped) {
      h.funder = await funderOf(h.owner, a.first.signature);
      if (h.funder) h.funderCex = KNOWN_CEX[h.funder];
    }
    const buyT = h.firstBuyTime ?? ts?.createTime ?? now;
    if (!a.capped && h.firstTxTime !== undefined && a.count < 15 && buyT - h.firstTxTime < 86_400) h.freshAtBuy = true;
    if ((i + 1) % 50 === 0) console.error(`    …${i + 1}/${activityTargets.length} (${rpcCalls} rpc calls)`);
  });

  const clusters = funderClusters(wallets);
  for (const [, list] of clusters) for (const h of list) h.fundedBySameAs = list.length;

  for (const h of holders) scoreHolder(h, { holderSet, creator });

  // ------------------------------------------------------------ aggregates
  const pools = holders.filter((h) => h.verdict === 'pool');
  const poolPct = pools.reduce((s, h) => s + h.pct, 0);
  const circPct = Math.max(1e-9, 100 - poolPct);
  const scored = wallets.filter((h) => h.txCount !== undefined);
  const bucket = (v: Holder['verdict']) => wallets.filter((h) => h.verdict === v);
  const pctOfCirc = (list: Holder[]) => (list.reduce((s, h) => s + h.pct, 0) / circPct) * 100;
  const bots = bucket('bot');
  const sus = bucket('suspicious');
  const org = bucket('organic');
  const unk = bucket('unknown');
  const dust = wallets.filter((h) => h.pct < 0.001);
  const top10 = wallets.slice(0, 10);
  const top10Pct = pctOfCirc(top10);
  const creatorHold = creator ? holders.find((h) => h.owner === creator) : undefined;
  const scoredPct = pctOfCirc(scored);

  // Market stats.
  const pair = dex?.pairs?.sort?.((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))?.[0];
  const gPool = gecko?.included?.find?.((p: any) => p.type === 'pool');
  const gTx = gPool?.attributes?.transactions?.h24;
  const tradesPerBuyer = gTx && gTx.buyers ? gTx.buys / gTx.buyers : undefined;
  const tradesPerSeller = gTx && gTx.sellers ? gTx.sells / gTx.sellers : undefined;

  // Overall verdict.
  const botSupply = pctOfCirc(bots);
  const susSupply = pctOfCirc(sus);
  const flags: string[] = [];
  if (ts && ts.bundledBuyers.length > 0) flags.push(`${ts.bundledBuyers.length} wallets bought in the deploy bundle (${fmtSol(ts.bundledSolIn)})`);
  if (clusters.size > 0) flags.push(`${clusters.size} funder clusters covering ${[...clusters.values()].reduce((s, l) => s + l.length, 0)} holders`);
  if (rug?.graphInsidersDetected) flags.push(`Rugcheck insider graph: ${rug.graphInsidersDetected} wallets`);
  if (ts && ts.bursts.length > 0) flags.push(`${ts.bursts.length} identical-amount buy bursts (largest ${ts.bursts[0].count}× ${ts.bursts[0].sol} SOL)`);
  if (pa && pa.topBuyerShare >= 0.3) flags.push(`one wallet is ${(pa.topBuyerShare * 100).toFixed(0)}% of recent buy volume (top 3: ${(pa.top3BuyerShare * 100).toFixed(0)}%)`);
  if (pa && pa.regularBuyers.length) flags.push(`${pa.regularBuyers.length} wallet(s) buy on a scheduled cadence`);
  if (pa && pa.sellers > pa.buyers * 1.5 && pa.buyVol > pa.sellVol) flags.push(`few large buyers vs many small sellers (${pa.buyers} buyers / ${pa.sellers} sellers, buy vol ${fmtSol(pa.buyVol)} > sell vol ${fmtSol(pa.sellVol)})`);
  if (tradesPerBuyer && tradesPerBuyer > 4) flags.push(`${tradesPerBuyer.toFixed(1)} buys per unique buyer in 24h (wash-like)`);
  if (dust.length > wallets.length * 0.3) flags.push(`${fmtPct((dust.length / wallets.length) * 100)} of holders are dust (< 0.001% supply)`);
  if (top10Pct > 40) flags.push(`top-10 wallets hold ${fmtPct(top10Pct)} of circulating supply`);
  if (rug?.mintAuthority) flags.push('mint authority still enabled');
  if (rug?.freezeAuthority) flags.push('freeze authority still enabled');

  let overall: string;
  const priceDriverBots = pa ? pa.stats.filter((st) => st.solIn / Math.max(pa!.buyVol, 1e-9) >= 0.2 && wallets.find((w) => w.owner === st.trader)?.verdict === 'bot').length : 0;
  if (priceDriverBots > 0 || botSupply >= 40 || (ts && ts.bundledBuyers.length >= 5 && botSupply + susSupply >= 40)) overall = 'MOSTLY BOTS / COORDINATED — the holder base is dominated by scripted or insider wallets.';
  else if (botSupply + susSupply >= 30 || flags.length >= 3) overall = 'MIXED — meaningful bot/insider presence alongside some organic holders. Treat as high-risk.';
  else if (scored.length >= 20) overall = 'MOSTLY ORGANIC — holder behaviour looks like real, independently-funded wallets.';
  else overall = 'INCONCLUSIVE — too few wallets could be profiled.';

  // ---------------------------------------------------------------- report
  const name = (pump?.name as string) ?? rug?.tokenMeta?.name ?? pair?.baseToken?.name ?? '?';
  const symbol = (pump?.symbol as string) ?? rug?.tokenMeta?.symbol ?? pair?.baseToken?.symbol ?? '?';
  const L: string[] = [];
  L.push(`# Holder forensics: ${name} ($${symbol})`);
  L.push('');
  L.push(`Mint \`${mint}\` · generated ${new Date().toISOString().slice(0, 16)}Z · ${rpcCalls} RPC calls · ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  L.push('');
  L.push(`## Verdict`);
  L.push('');
  L.push(`**${overall}**`);
  L.push('');
  L.push('| Class | Wallets | % of profiled wallets | % of circulating supply |');
  L.push('|---|---:|---:|---:|');
  const row = (label: string, list: Holder[]) =>
    L.push(`| ${label} | ${list.length} | ${scored.length ? fmtPct((list.length / scored.length) * 100) : 'n/a'} | ${fmtPct(pctOfCirc(list))} |`);
  row('Likely bot / farm', bots);
  row('Suspicious', sus);
  row('Likely organic', org);
  L.push(`| Not profiled (beyond --activity cap) | ${unk.length} | – | ${fmtPct(pctOfCirc(unk))} |`);
  L.push(`| Pools / program vaults | ${pools.length} | – | ${fmtPct(poolPct)} of total |`);
  L.push('');
  L.push(`Profiled wallets cover ${fmtPct(scoredPct)} of circulating supply.`);
  L.push('');
  if (flags.length) {
    L.push('Red flags:');
    for (const f of flags) L.push(`- ${f}`);
    L.push('');
  }

  L.push('## Token facts');
  L.push('');
  L.push(`- Holders: ${holders.length}${holderSetComplete ? '' : ' (largest-20 token accounts only; full list unavailable)'}${rug?.totalHolders ? ` (Rugcheck: ${rug.totalHolders})` : ''}`);
  L.push(`- Supply: ${supply.amount.toLocaleString('en-US')} · pools hold ${fmtPct(poolPct)}`);
  if (creator) L.push(`- Creator: \`${creator}\`${creatorHold ? ` holds ${fmtPct(creatorHold.pct)}` : ' holds 0'}`);
  if (pump) {
    L.push(`- Created: ${iso(Number(pump.created_timestamp) / 1000)} · bonded: ${pump.complete ? 'yes' : 'no'}${pump.raydium_pool || pump.pump_swap_pool ? ` (pool ${String(pump.pump_swap_pool ?? pump.raydium_pool)})` : ''}`);
    L.push(`- pump.fun replies: ${pump.reply_count ?? 'n/a'} · socials: ${['twitter', 'telegram', 'website'].filter((k) => pump[k]).map((k) => `${k}=${pump[k]}`).join(', ') || 'none'}`);
    if (pump.description) L.push(`- Description: ${String(pump.description).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  if (pair) {
    L.push(`- Market (${pair.dexId}): price ${pair.priceUsd ? `$${pair.priceUsd}` : 'n/a'} · liquidity ${fmtUsd(pair.liquidity?.usd)} · FDV ${fmtUsd(pair.fdv)} · 24h vol ${fmtUsd(pair.volume?.h24)} · 24h txns ${pair.txns?.h24?.buys ?? '?'} buys / ${pair.txns?.h24?.sells ?? '?'} sells · pair created ${iso(pair.pairCreatedAt ? pair.pairCreatedAt / 1000 : null)}`);
  }
  if (gTx) {
    L.push(`- 24h unique actors (GeckoTerminal): ${gTx.buyers} buyers / ${gTx.sellers} sellers → ${tradesPerBuyer?.toFixed(1)} buys per buyer, ${tradesPerSeller?.toFixed(1)} sells per seller`);
  }
  if (rug) {
    L.push(`- Rugcheck score: ${rug.score_normalised ?? rug.score ?? 'n/a'} · mint authority: ${rug.mintAuthority ? 'ENABLED' : 'revoked'} · freeze authority: ${rug.freezeAuthority ? 'ENABLED' : 'revoked'}`);
    const lp = (rug.markets ?? []).map((m: any) => `${m.marketType ?? 'pool'} LP locked ${Number(m.lp?.lpLockedPct ?? 0).toFixed(0)}%`);
    if (lp.length) L.push(`- Liquidity: ${lp.join('; ')}`);
    const risks = (rug.risks ?? []) as Array<{ name: string; level?: string; description?: string; value?: string }>;
    if (risks.length) {
      L.push('- Rugcheck risks:');
      for (const r of risks) L.push(`  - [${r.level ?? '?'}] ${r.name}${r.value ? ` (${r.value})` : ''}${r.description ? ` — ${r.description}` : ''}`);
    }
  }
  L.push('');

  if (pa && poolScan) {
    L.push(`## Recent pool activity (last ${DAYS} days, pool \`${poolAddr}\`)`);
    L.push('');
    L.push(`- ${poolScan.sigsScanned} successful pool transactions scanned; ${poolScan.trades.length} swaps parsed from the most recent ${poolScan.parsed}${poolScan.failed ? ` (${poolScan.failed} fetch failures)` : ''}`);
    const hist = dailyHistogram(poolScan.sigTimes, DAYS);
    const maxN = Math.max(1, ...hist.map((h) => h.n));
    L.push(`- Transactions per day: ${hist.map((h) => `${h.day}:${h.n}`).join(' ')}`);
    L.push(`- Activity bars: ${hist.map((h) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((h.n / maxN) * 7.99))]).join('')}`);
    const span = poolScan.trades.length ? `${iso(Math.min(...poolScan.trades.map((t) => t.time)))} → ${iso(Math.max(...poolScan.trades.map((t) => t.time)))}` : 'n/a';
    L.push(`- Parsed window: ${span}`);
    L.push(`- Buys ${pa.stats.reduce((s, x) => s + x.buys, 0)} (${fmtSol(pa.buyVol)}) from ${pa.buyers} wallets · sells ${pa.stats.reduce((s, x) => s + x.sells, 0)} (${fmtSol(pa.sellVol)}) from ${pa.sellers} wallets`);
    L.push(`- Top buyer = ${(pa.topBuyerShare * 100).toFixed(0)}% of buy volume · top 3 = ${(pa.top3BuyerShare * 100).toFixed(0)}%`);
    L.push(`- Scheduled-cadence buyers: ${pa.regularBuyers.length}${pa.regularBuyers.length ? ` — ${pa.regularBuyers.map(short).join(', ')}` : ''}`);
    L.push('');
    L.push('Top buyers:');
    L.push('');
    L.push('| Wallet | Buys | Sells | SOL in | SOL out | Share of buys | Interval CV | Same-size buys | Holds now |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const st of [...pa.stats].sort((a, b) => b.solIn - a.solIn).slice(0, 12)) {
      const h = holders.find((x) => x.owner === st.trader);
      L.push(`| \`${short(st.trader)}\` | ${st.buys} | ${st.sells} | ${st.solIn.toFixed(2)} | ${st.solOut.toFixed(2)} | ${((st.solIn / Math.max(pa.buyVol, 1e-9)) * 100).toFixed(0)}% | ${st.intervalCv?.toFixed(2) ?? ''} | ${st.repeatSize ?? ''} | ${h ? fmtPct(h.pct) : ''} |`);
    }
    L.push('');
    L.push('Top sellers:');
    L.push('');
    L.push('| Wallet | Sells | Buys | SOL out | SOL in | Holds now |');
    L.push('|---|---:|---:|---:|---:|---:|');
    for (const st of [...pa.stats].sort((a, b) => b.solOut - a.solOut).slice(0, 8)) {
      const h = holders.find((x) => x.owner === st.trader);
      L.push(`| \`${short(st.trader)}\` | ${st.sells} | ${st.buys} | ${st.solOut.toFixed(2)} | ${st.solIn.toFixed(2)} | ${h ? fmtPct(h.pct) : ''} |`);
    }
    L.push('');
  }

  if (ts) {
    L.push('## Bonding-curve trade tape (pump.fun)');
    L.push('');
    L.push(`- ${ts.trades} trades by ${ts.uniqueUsers} unique wallets · buy volume ${fmtSol(ts.buyVolumeSol)} · sell volume ${fmtSol(ts.sellVolumeSol)}`);
    L.push(`- Deploy slot ${ts.createSlot} at ${iso(ts.createTime)}`);
    L.push(`- Bundled buyers (creation slot +2): ${ts.bundledBuyers.length}, spending ${fmtSol(ts.bundledSolIn)}${ts.bundledBuyers.length ? ` — ${ts.bundledBuyers.slice(0, 12).map(short).join(', ')}${ts.bundledBuyers.length > 12 ? ', …' : ''}` : ''}`);
    L.push(`- Early buyers (first 20 slots): ${ts.earlyBuyers.length}`);
    L.push(`- Churners (rapid round-trips): ${ts.churners.length}${ts.churners.length ? ` — ${ts.churners.slice(0, 8).map(short).join(', ')}` : ''}`);
    if (ts.bursts.length) {
      L.push(`- Identical-amount buy bursts (≥5 buys, same size, ≤60s, ≥3 wallets): ${ts.bursts.length}`);
      for (const b of ts.bursts.slice(0, 8)) L.push(`  - ${b.count}× ${b.sol} SOL from ${b.users} wallets at ${iso(b.startTime)}`);
    } else L.push('- No identical-amount buy bursts detected');
    L.push('');
  }

  if (clusters.size) {
    L.push('## Funding-source clusters');
    L.push('');
    L.push('Holders whose first SOL came from the same non-exchange wallet (one operator controlling several "holders").');
    L.push('');
    const sortedClusters = [...clusters].sort((a, b) => b[1].reduce((s, h) => s + h.pct, 0) - a[1].reduce((s, h) => s + h.pct, 0));
    for (const [funder, list] of sortedClusters.slice(0, 15)) {
      const pct = list.reduce((s, h) => s + h.pct, 0);
      L.push(`- \`${funder}\`${holderSet.has(funder) ? ' (also a holder)' : ''}${funder === creator ? ' (CREATOR)' : ''} → ${list.length} holders, ${fmtPct(pct)} of supply: ${list.slice(0, 8).map((h) => short(h.owner)).join(', ')}${list.length > 8 ? ', …' : ''}`);
    }
    L.push('');
  }

  const cexFunded = wallets.filter((h) => h.funderCex);
  L.push('## Wallet-quality summary (profiled wallets)');
  L.push('');
  L.push(`- Profiled: ${scored.length} of ${wallets.length} wallets (funding traced for top ${Math.min(TOP, wallets.length)})`);
  L.push(`- Funded from a known exchange: ${cexFunded.length} (${Object.entries(cexFunded.reduce((m, h) => ((m[h.funderCex!] = (m[h.funderCex!] ?? 0) + 1), m), {} as Record<string, number>)).map(([k, v]) => `${k} ${v}`).join(', ') || '–'})`);
  L.push(`- Fresh at time of buy (< 24h old, < 15 txs): ${wallets.filter((h) => h.freshAtBuy).length}`);
  L.push(`- Hyperactive (≥1000 txs): ${wallets.filter((h) => h.txCountCapped).length}`);
  L.push(`- Rugcheck insiders among holders: ${wallets.filter((h) => h.insider).length}`);
  L.push(`- Dust holders (< 0.001% supply): ${dust.length} of ${wallets.length}`);
  L.push(`- Top-10 wallets: ${fmtPct(top10Pct)} of circulating supply`);
  const ages = scored.filter((h) => h.firstTxTime).map((h) => (now - h.firstTxTime!) / 86_400).sort((a, b) => a - b);
  if (ages.length) L.push(`- Wallet age (days): median ${ages[Math.floor(ages.length / 2)].toFixed(1)} · p10 ${ages[Math.floor(ages.length * 0.1)].toFixed(1)} · p90 ${ages[Math.floor(ages.length * 0.9)].toFixed(1)}`);
  L.push('');

  L.push('## Top holders');
  L.push('');
  L.push('| # | Wallet | % supply | Verdict | Score | Txs | Age (d) | Funder | Recent B/S | Signals |');
  L.push('|---:|---|---:|---|---:|---:|---:|---|---:|---|');
  holders.slice(0, 70).forEach((h, i) => {
    const age = h.firstTxTime ? ((now - h.firstTxTime) / 86_400).toFixed(0) : '';
    const funder = h.funderCex ? h.funderCex : h.funder ? short(h.funder) : '';
    const sig = h.verdict === 'pool' ? h.label : (h.reasons ?? []).join('; ');
    const bs = h.recentBuys !== undefined ? `${h.recentBuys}/${h.recentSells}` : '';
    L.push(`| ${i + 1} | \`${short(h.owner)}\` | ${fmtPct(h.pct)} | ${h.verdict} | ${h.score?.toFixed(2) ?? ''} | ${h.txCount !== undefined ? `${h.txCount}${h.txCountCapped ? '+' : ''}` : ''} | ${age} | ${funder} | ${bs} | ${sig ?? ''} |`);
  });
  L.push('');

  if (activityFailures) unavailable.push(`wallet activity for ${activityFailures} wallet(s) (RPC errors)`);
  if (unavailable.length) {
    L.push('## Data gaps');
    L.push('');
    for (const u of unavailable) L.push(`- ${u} unavailable`);
    if (!holderSetComplete) L.push('- Full holder list unavailable: only the largest token accounts, Rugcheck top holders and recent traders were profiled');
    L.push('');
  }

  L.push('## Method notes');
  L.push('');
  L.push('- Score = bundle 0.40 + fresh 0.25 + funder-cluster 0.25 + funded-by-holder 0.15 + insider 0.20 + churn 0.15 + burst 0.15 + buy-volume-driver 0.20 + scheduled-cadence 0.25 + same-size-buys 0.10 + hyperactive 0.10 + dust-SOL 0.05 − CEX-funded 0.20, clamped to [0,1]. ≥0.50 bot, ≥0.25 suspicious.');
  L.push('- "Fresh" is judged at the time of the wallet\'s first buy on the curve (or deploy time if never traded on the curve).');
  L.push('- Funder = fee payer of the wallet\'s first transaction. Only wallets with < 3000 lifetime txs are traced.');
  L.push('- Pool swaps are parsed from raw transactions: trader = non-pool owner whose token balance changed, SOL = pool WSOL vault delta. Interval CV = std-dev / mean of a wallet\'s buy intervals; < 0.35 is a scheduled bot.');
  L.push('- Exchange list is best-effort; an unknown funder is not evidence of a bot unless shared with other holders.');
  L.push('');

  const md = L.join('\n');
  mkdirSync(values.out!, { recursive: true });
  const base = join(values.out!, `${symbol.replace(/[^A-Za-z0-9_-]/g, '') || 'token'}-${mint.slice(0, 8)}`);
  writeFileSync(`${base}.md`, md);
  writeFileSync(
    `${base}.json`,
    JSON.stringify(
      {
        mint,
        name,
        symbol,
        generatedAt: new Date().toISOString(),
        overall,
        flags,
        summary: { bots: bots.length, suspicious: sus.length, organic: org.length, unknown: unk.length, pools: pools.length, botSupplyPct: botSupply, susSupplyPct: susSupply, top10Pct, poolPct },
        unavailable,
        holders,
        trades: ts ? { ...ts, perUser: Object.fromEntries(ts.perUser) } : null,
        pool: pa && poolScan ? { address: poolAddr, sigsScanned: poolScan.sigsScanned, parsed: poolScan.parsed, swaps: poolScan.trades, buyVol: pa.buyVol, sellVol: pa.sellVol, buyers: pa.buyers, sellers: pa.sellers, topBuyerShare: pa.topBuyerShare, top3BuyerShare: pa.top3BuyerShare, regularBuyers: pa.regularBuyers, traders: pa.stats.slice(0, 100) } : null,
        market: { pair, geckoPool: gPool?.attributes ?? null },
        rugcheck: rug ? { score: rug.score_normalised ?? rug.score, risks: rug.risks, insiderNetworks: rug.insiderNetworks, graphInsidersDetected: rug.graphInsidersDetected, totalHolders: rug.totalHolders, mintAuthority: rug.mintAuthority, freezeAuthority: rug.freezeAuthority, markets: rug.markets } : null,
        pump: pump ? { creator: pump.creator, created_timestamp: pump.created_timestamp, complete: pump.complete, reply_count: pump.reply_count, twitter: pump.twitter, telegram: pump.telegram, website: pump.website } : null,
      },
      null,
      2,
    ),
  );
  console.log(md);
  console.error(`== wrote ${base}.md / .json`);
}

if (process.argv[1] && /token-forensics\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}
