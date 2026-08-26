import { readFile, writeFile, appendFile } from 'node:fs/promises';
import type { Config, Grail, Retailer } from './types.ts';
import { fetchJson, fetchText } from './http.ts';
import { catalogFetcher } from './adapters.ts';
import { matchesGrail, normalize } from './matcher.ts';
import { loadConfig } from './scan.ts';
import { postToAlertsIssue } from './github.ts';

/**
 * Retailer discovery engine — no more hand-rolled rosters.
 *
 * Daily (and on demand) it takes every enabled grail, searches the open web
 * for shops mentioning it (DuckDuckGo + Bing HTML endpoints, both free),
 * fingerprints each candidate domain for a platform we can sweep
 * (Shopify → WooCommerce → Squarespace probes), verifies the store's live
 * catalog actually matches a grail, and auto-appends confirmed stockists to
 * retailers.json — which the same workflow run then commits. The roster
 * grows itself as new dealers appear.
 */

const MAX_CANDIDATES_PER_RUN = 12;
const SQ_PATH_CANDIDATES = ['/shop', '/store', '/boutique', '/products', '/knives', '/available'];

/** Marketplaces, socials, forums, junk — never shop roster material. */
const BLOCKED = [
  'amazon.', 'ebay.', 'etsy.', 'aliexpress.', 'walmart.', 'rakuten.',
  'reddit.com', 'youtube.com', 'facebook.com', 'instagram.com', 'pinterest.',
  'tiktok.com', 'x.com', 'twitter.com', 'quora.com', 'wikipedia.org',
  'kitchenknifeforums.com', 'chefknivestogoforums.com', 'bladeforums.com',
  'google.', 'bing.com', 'duckduckgo.com', 'github.com', 'discord.',
];

export function isBlocked(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return BLOCKED.some((b) => h === b || h.includes(b));
}

/** Pull result URLs out of DuckDuckGo/Bing HTML SERPs. */
export function extractResultUrls(html: string): string[] {
  const urls: string[] = [];
  // DuckDuckGo html endpoint: links carry the target in a uddg= param.
  for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
    try {
      urls.push(decodeURIComponent(m[1]));
    } catch {
      /* skip malformed */
    }
  }
  // Bing: result anchors, sometimes wrapped in /ck/a redirects with u=a1<base64url>.
  for (const m of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/g)) {
    const href = m[1];
    if (href.includes('bing.com/ck/')) {
      const u = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href)?.[1];
      if (u) {
        try {
          urls.push(Buffer.from(u, 'base64url').toString('utf8'));
        } catch {
          /* skip malformed */
        }
      }
    } else {
      urls.push(href);
    }
  }
  return urls.filter((u) => u.startsWith('http'));
}

export type TextFetcher = (url: string) => Promise<string | null>;
export type JsonFetcher = (url: string) => Promise<unknown>;

export async function searchWeb(term: string, fetchPage: TextFetcher): Promise<string[]> {
  const queries = [`"${term}" knife shop buy`, `"${term}" gyuto in stock`];
  const engines = (q: string) => [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  ];
  const urls: string[] = [];
  for (const q of queries) {
    for (const engine of engines(q)) {
      const html = await fetchPage(engine);
      if (html) urls.push(...extractResultUrls(html));
    }
  }
  return urls;
}

/** Fingerprint which platform (if any) a domain runs, cheapest probe first. */
export async function detectPlatform(
  origin: string,
  io: { json: JsonFetcher; text: TextFetcher },
): Promise<{ adapter: Retailer['adapter']; path?: string } | null> {
  const shopify = (await io.json(`${origin}/products.json?limit=1`).catch(() => null)) as { products?: unknown[] } | null;
  if (Array.isArray(shopify?.products)) return { adapter: 'shopify' };

  const woo = (await io.json(`${origin}/wp-json/wc/store/v1/products?per_page=1`).catch(() => null)) as unknown[] | null;
  if (Array.isArray(woo)) return { adapter: 'woocommerce' };

  const home = await io.text(origin);
  if (home?.includes('Squarespace')) {
    const navPaths = [...home.matchAll(/href="(\/[a-z0-9-]{2,30})"/g)].map((m) => m[1]);
    const paths = [...new Set([...SQ_PATH_CANDIDATES, ...navPaths])].slice(0, 10);
    for (const path of paths) {
      const page = (await io.json(`${origin}${path}?format=json`).catch(() => null)) as {
        items?: Array<{ structuredContent?: { variants?: unknown[] } }>;
      } | null;
      if (page?.items?.some((i) => i.structuredContent?.variants?.length)) {
        return { adapter: 'squarespace', path };
      }
    }
  }
  return null;
}

function slug(hostname: string): string {
  return hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

export interface DiscoveryIo {
  search: (term: string) => Promise<string[]>;
  json: JsonFetcher;
  text: TextFetcher;
  fetchCatalog: (r: Retailer) => Promise<import('./types.ts').Listing[]>;
}

/** One discovery pass: returns verified new retailers (not yet persisted). */
export async function discoverRetailers(config: Config, io: DiscoveryIo): Promise<Retailer[]> {
  const known = new Set(config.retailers.map((r) => new URL(r.url).hostname.replace(/^www\./, '')));
  const grails = config.grails.filter((g: Grail) => g.enabled !== false);
  const terms = [...new Set(grails.flatMap((g) => [...(g.match.all ?? []), ...(g.match.any ?? [])]))]
    .map(normalize)
    .filter((t) => t.length > 3 && !/^\d+$/.test(t)); // maker names, not sizes

  const candidates = new Map<string, string>(); // bare hostname -> origin
  for (const term of terms) {
    for (const url of await io.search(term)) {
      try {
        const u = new URL(url);
        const bare = u.hostname.replace(/^www\./, '');
        if (isBlocked(u.hostname) || known.has(bare) || candidates.has(bare)) continue;
        candidates.set(bare, u.origin);
      } catch {
        /* skip unparseable */
      }
    }
  }

  const found: Retailer[] = [];
  let probed = 0;
  for (const [bare, origin] of candidates) {
    if (probed >= MAX_CANDIDATES_PER_RUN) break;
    probed++;
    const platform = await detectPlatform(origin, io);
    if (!platform) {
      console.log(`  · ${bare}: no sweepable platform`);
      continue;
    }
    const retailer: Retailer = { id: slug(bare), name: bare, url: origin, adapter: platform.adapter, ...(platform.path ? { path: platform.path } : {}) };
    try {
      const listings = await io.fetchCatalog(retailer);
      const hit = listings.find((l) => grails.some((g) => matchesGrail(g, l)));
      if (hit) {
        retailer.currency = hit.currency;
        found.push(retailer);
        console.log(`  ★ ${bare}: ${platform.adapter}, stocks "${hit.title}" — added`);
      } else {
        console.log(`  · ${bare}: ${platform.adapter}, ${listings.length} products, no grail match`);
      }
    } catch (err) {
      console.log(`  · ${bare}: catalog fetch failed (${(err as Error).message})`);
    }
  }
  return found;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  console.log(`Discovery: hunting new stockists for ${config.grails.filter((g) => g.enabled !== false).length} grail(s)…`);

  const io: DiscoveryIo = {
    search: (term) => searchWeb(term, fetchText),
    json: (url) => fetchJson(url, 12_000, 0),
    text: (url) => fetchText(url, 12_000),
    fetchCatalog: catalogFetcher,
  };
  const found = await discoverRetailers(config, io);

  if (found.length === 0) {
    console.log('Discovery: no new verified stockists this run.');
    return;
  }

  const file = JSON.parse(await readFile('retailers.json', 'utf8'));
  file.retailers.push(...found);
  await writeFile('retailers.json', JSON.stringify(file, null, 2) + '\n');
  console.log(`Discovery: added ${found.length} retailer(s): ${found.map((r) => r.id).join(', ')}`);

  const lines = found.map((r) => `- **${r.name}** (${r.adapter}) — ${r.url}`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await appendFile(summaryPath, `## 🔭 Discovery: ${found.length} new stockist(s)\n${lines.join('\n')}\n`);
  await postToAlertsIssue(`🔭 **Discovery** found ${found.length} new grail stockist(s), now in the sweep:\n${lines.join('\n')}`).catch(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
