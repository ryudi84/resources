import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Config, Grail, GrailHit, Listing, Retailer, RetailerStatus, ScanResult } from './types.ts';
import { matchesGrail } from './matcher.ts';
import { adapters, catalogFetcher } from './adapters.ts';
import { notify } from './notify.ts';
import { renderDashboard } from './report.ts';
import { demoCatalogs } from './demo.ts';

const DATA_DIR = 'data';
const LATEST = `${DATA_DIR}/latest.json`;
const DASHBOARD = 'docs/index.html';
const CONCURRENCY = 6;

export async function loadConfig(): Promise<Config> {
  const grails = JSON.parse(await readFile('grails.json', 'utf8')).grails as Grail[];
  const retailers = JSON.parse(await readFile('retailers.json', 'utf8')).retailers as Retailer[];
  for (const g of grails) {
    if (!g.id || !g.name || !g.match) throw new Error(`grails.json: entry missing id/name/match: ${JSON.stringify(g)}`);
  }
  for (const r of retailers) {
    if (!r.id || !r.url || !(r.adapter in adapters)) throw new Error(`retailers.json: bad entry: ${JSON.stringify(r)}`);
  }
  return { grails, retailers };
}

/** A stable identity for "this grail at this product at this shop" across scans. */
export function hitKey(h: GrailHit): string {
  return `${h.grailId}::${h.listing.retailerId}::${h.listing.handle}`;
}

/** Hits that are available now but weren't available (or seen) last scan. */
export function newlyAvailable(current: GrailHit[], previous: GrailHit[]): GrailHit[] {
  const prevAvailable = new Set(previous.filter((h) => h.listing.available).map(hitKey));
  return current.filter((h) => h.listing.available && !prevAvailable.has(hitKey(h)));
}

async function scanRetailer(
  retailer: Retailer,
  fetchCatalog: (r: Retailer) => Promise<Listing[]>,
): Promise<{ status: RetailerStatus; listings: Listing[] }> {
  const started = performance.now();
  try {
    const listings = await fetchCatalog(retailer);
    return {
      status: {
        id: retailer.id,
        name: retailer.name,
        url: retailer.url,
        ok: true,
        products: listings.length,
        ms: Math.round(performance.now() - started),
      },
      listings,
    };
  } catch (err) {
    return {
      status: {
        id: retailer.id,
        name: retailer.name,
        url: retailer.url,
        ok: false,
        error: (err as Error).message,
        products: 0,
        ms: Math.round(performance.now() - started),
      },
      listings: [],
    };
  }
}

/** Run tasks with a bounded worker pool. */
async function pooled<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runScan(
  config: Config,
  fetchCatalog: (r: Retailer) => Promise<Listing[]>,
  demo = false,
): Promise<ScanResult> {
  const activeRetailers = config.retailers.filter((r) => r.enabled !== false);
  const activeGrails = config.grails.filter((g) => g.enabled !== false);

  const scans = await pooled(activeRetailers, CONCURRENCY, (r) => scanRetailer(r, fetchCatalog));

  const hits: GrailHit[] = [];
  for (const { listings } of scans) {
    for (const listing of listings) {
      for (const grail of activeGrails) {
        if (matchesGrail(grail, listing)) {
          hits.push({ grailId: grail.id, grailName: grail.name, listing });
        }
      }
    }
  }

  hits.sort((a, b) => Number(b.listing.available) - Number(a.listing.available) || a.grailName.localeCompare(b.grailName));

  return {
    generatedAt: new Date().toISOString(),
    demo: demo || undefined,
    retailers: scans.map((s) => s.status),
    hits,
  };
}

async function loadPrevious(): Promise<ScanResult | null> {
  if (!existsSync(LATEST)) return null;
  try {
    return JSON.parse(await readFile(LATEST, 'utf8')) as ScanResult;
  } catch {
    return null;
  }
}

async function writeGithubSummary(result: ScanResult, fresh: GrailHit[]): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const inStock = result.hits.filter((h) => h.listing.available);
  const lines = [
    `## 🔪 Grail scan — ${inStock.length} in stock, ${fresh.length} new`,
    '',
    ...fresh.map((h) => `- 🚨 **NEW** [${h.listing.title}](${h.listing.url}) @ ${h.listing.retailerName} (${h.grailName})`),
    ...inStock
      .filter((h) => !fresh.some((f) => hitKey(f) === hitKey(h)))
      .map((h) => `- ✅ [${h.listing.title}](${h.listing.url}) @ ${h.listing.retailerName}`),
    '',
    `Retailers: ${result.retailers.filter((r) => r.ok).length}/${result.retailers.length} ok`,
  ];
  await appendFile(summaryPath, lines.join('\n') + '\n');
}

/** Fires a synthetic alert through every configured channel to verify setup. */
async function sendTestAlert(): Promise<void> {
  console.log('Sending TEST alert through all configured channels…');
  await notify([
    {
      grailId: 'test',
      grailName: 'Test alert — your channels work',
      listing: {
        retailerId: 'test',
        retailerName: 'Grail Knife Finder',
        title: 'This is what a real drop will look like. No knife yet — but the wiring is live.',
        vendor: '',
        productType: '',
        tags: [],
        handle: 'test',
        url: 'https://github.com/ryudi84/resources',
        priceMin: 0,
        priceMax: 0,
        available: true,
        variantsAvailable: 1,
        variantsTotal: 1,
      },
    },
  ]);
  console.log('Test alert dispatched.');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      demo: { type: 'boolean', default: false },
      'test-alert': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const demo = values.demo as boolean;

  if (values['test-alert'] || process.env.TEST_ALERT === 'true') {
    await sendTestAlert();
  }

  const config = await loadConfig();
  console.log(
    `Hunting ${config.grails.filter((g) => g.enabled !== false).length} grail(s) across ${config.retailers.filter((r) => r.enabled !== false).length} retailer(s)${demo ? ' [DEMO DATA]' : ''}…`,
  );

  const fetcher = demo
    ? async (r: Retailer): Promise<Listing[]> => demoCatalogs(r)
    : catalogFetcher;

  const previous = await loadPrevious();
  const result = await runScan(config, fetcher, demo);

  // Only diff like-for-like: a demo scan never "discovers" stock relative to a real one.
  const comparable = previous && Boolean(previous.demo) === Boolean(result.demo) ? previous : null;
  const fresh = comparable ? newlyAvailable(result.hits, comparable.hits) : [];

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir('docs', { recursive: true });
  await writeFile(LATEST, JSON.stringify(result, null, 2) + '\n');
  const panelPassword = process.env.PANEL_PASSWORD?.trim() || undefined;
  await writeFile(DASHBOARD, await renderDashboard(result, config, panelPassword));
  if (panelPassword) console.log('Panel sealed with PANEL_PASSWORD (AES-256-GCM).');

  for (const r of result.retailers) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(26)} ${r.ok ? `${r.products} products` : r.error} (${r.ms}ms)`);
  }
  const inStock = result.hits.filter((h) => h.listing.available);
  console.log(`\n${result.hits.length} grail listing(s) sighted, ${inStock.length} IN STOCK, ${fresh.length} newly in stock.`);
  for (const h of inStock) {
    console.log(`  ✅ [${h.grailName}] ${h.listing.title} @ ${h.listing.retailerName} → ${h.listing.url}`);
  }

  if (!demo) await notify(fresh);
  await writeGithubSummary(result, fresh);
  console.log(`\nDashboard → ${DASHBOARD}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
