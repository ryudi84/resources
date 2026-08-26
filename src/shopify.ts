import type { Listing, Retailer } from './types.ts';

/**
 * Shopify storefronts expose their full public catalog at
 * /products.json?limit=250&page=N — no auth, no scraping, includes live
 * per-variant availability. Nearly every serious Japanese-knife retailer
 * runs Shopify, which makes this the cleanest possible stock signal.
 */

const PAGE_SIZE = 250;
const MAX_PAGES = 40; // 10k products; more than any knife shop carries
const UA = 'grail-knife-finder/1.0 (+https://github.com/ryudi84/resources)';

interface ShopifyVariant {
  price: string;
  available?: boolean;
}

interface ShopifyImage {
  src?: string;
}

interface ShopifyProduct {
  title: string;
  handle: string;
  vendor?: string;
  product_type?: string;
  tags?: string[] | string;
  published_at?: string;
  variants?: ShopifyVariant[];
  images?: ShopifyImage[];
}

async function fetchJson(url: string, timeoutMs = 20_000, retries = 2): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) return null; // 4xx other than 429: endpoint disabled/moved, don't retry
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

function toListing(retailer: Retailer, p: ShopifyProduct): Listing {
  const variants = p.variants ?? [];
  const prices = variants
    .map((v) => Number.parseFloat(v.price))
    .filter((n) => Number.isFinite(n));
  const availableCount = variants.filter((v) => v.available === true).length;
  const tags = Array.isArray(p.tags)
    ? p.tags
    : typeof p.tags === 'string'
      ? p.tags.split(',').map((t) => t.trim())
      : [];
  return {
    retailerId: retailer.id,
    retailerName: retailer.name,
    region: retailer.region,
    currency: retailer.currency,
    title: p.title,
    vendor: p.vendor ?? '',
    productType: p.product_type ?? '',
    tags,
    handle: p.handle,
    url: `${retailer.url}/products/${p.handle}`,
    imageUrl: p.images?.[0]?.src,
    priceMin: prices.length ? Math.min(...prices) : 0,
    priceMax: prices.length ? Math.max(...prices) : 0,
    available: availableCount > 0,
    variantsAvailable: availableCount,
    variantsTotal: variants.length,
    publishedAt: p.published_at,
  };
}

/** Pull the full catalog of one Shopify storefront as normalized listings. */
export async function fetchShopifyCatalog(retailer: Retailer): Promise<Listing[]> {
  const listings: Listing[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = (await fetchJson(
      `${retailer.url}/products.json?limit=${PAGE_SIZE}&page=${page}`,
    )) as { products?: ShopifyProduct[] } | null;
    const products = data?.products;
    if (!products || products.length === 0) break;
    for (const p of products) listings.push(toListing(retailer, p));
    if (products.length < PAGE_SIZE) break;
  }
  return listings;
}
