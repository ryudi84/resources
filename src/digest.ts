import { readFile } from 'node:fs/promises';
import type { GrailHit, ScanResult } from './types.ts';

/**
 * Daily Discord digest: a once-a-day post summarizing the hunt — every grail
 * currently in stock, with bargains (live markdowns, B-grades, clearance)
 * surfaced first. Runs from the daily cron in .github/workflows/scan.yml
 * against the freshest sweep in data/latest.json.
 */

const BARGAIN_WORDS = ['b-grade', 'b grade', 'blem', 'second', 'seconds', 'sale', 'clearance', 'discount', 'promo', 'special'];

export function isBargain(h: GrailHit): boolean {
  if ((h.listing.salePct ?? 0) >= 5) return true;
  const t = h.listing.title.toLowerCase();
  return BARGAIN_WORDS.some((w) => t.includes(w));
}

function money(h: GrailHit): string {
  const l = h.listing;
  if (!l.priceMin) return '';
  const cur = l.currency ? ` ${l.currency}` : '';
  return l.priceMin === l.priceMax ? `${l.priceMin}${cur}` : `${l.priceMin}–${l.priceMax}${cur}`;
}

function line(h: GrailHit): string {
  const l = h.listing;
  const sale = l.salePct ? ` · **−${l.salePct}%** (was ${l.compareAtMax})` : '';
  return `• [${l.title.slice(0, 90)}](${l.url}) @ ${l.retailerName} — ${money(h)}${sale}`;
}

function clamp(lines: string[], max: number): string {
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(`…and ${lines.length - max} more on the panel.`);
  return shown.join('\n').slice(0, 4000);
}

export function buildDigest(result: ScanResult): { content: string; embeds: unknown[] } {
  const inStock = result.hits.filter((h) => h.listing.available);
  const bargains = inStock.filter(isBargain).toSorted((a, b) => (b.listing.salePct ?? 0) - (a.listing.salePct ?? 0));
  const regular = inStock.filter((h) => !isBargain(h));
  const soldOutCount = result.hits.length - inStock.length;
  const okRetailers = result.retailers.filter((r) => r.ok).length;

  const date = result.generatedAt.slice(0, 10);
  const embeds: unknown[] = [];

  if (bargains.length > 0) {
    embeds.push({
      title: `🏷️ Bargains & promos — ${bargains.length}`,
      description: clamp(bargains.map(line), 12),
      color: 0xe0a458,
    });
  }
  if (regular.length > 0) {
    embeds.push({
      title: `✅ In stock at full price — ${regular.length}`,
      description: clamp(regular.map(line), 12),
      color: 0x4ade80,
    });
  }
  if (inStock.length === 0) {
    embeds.push({
      title: 'Nothing in stock today',
      description: `${soldOutCount} grail listing(s) sighted but sold out. The 20-minute watch continues — you'll be pinged the moment anything lands.`,
      color: 0x8b93a3,
    });
  }
  embeds.push({
    description: `Swept ${okRetailers}/${result.retailers.length} retailers · ${result.hits.length} sightings total · ${soldOutCount} sold out`,
    color: 0x262b36,
  });

  return { content: `**⚔ Daily grail digest — ${date}**`, embeds };
}

async function main(): Promise<void> {
  const result = JSON.parse(await readFile('data/latest.json', 'utf8')) as ScanResult;
  if (result.demo) {
    console.log('digest: latest.json is demo data; skipping post.');
    return;
  }
  const digest = buildDigest(result);

  const discord = process.env.DISCORD_WEBHOOK_URL;
  if (!discord) {
    console.log('digest: DISCORD_WEBHOOK_URL not set; printing instead:\n');
    console.log(JSON.stringify(digest, null, 2));
    return;
  }
  const res = await fetch(discord, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(digest),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`digest: Discord responded ${res.status}: ${await res.text()}`);
  console.log('digest: posted to Discord.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
