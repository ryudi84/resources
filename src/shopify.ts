import type { Listing, Retailer } from './types.ts';
import { fetchJson } from './http.ts';

/**
 * Shopify storefronts expose their full public catalog at
 * /products.json?limit=250&page=N — no auth, no scraping, includes live
 * per-variant availability. Most serious Japanese-knife retailers run
 * Shopify, which makes this the cleanest possible stock signal.
 */

const PAGE_SIZE = 250;
const MAX_PAGES = 40; // 10k products; more than any knife shop carries

interface ShopifyVariant {
  price: string;
  compare_at_price?: string | null;
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

function toListing(retailer: Retailer, p: ShopifyProduct): Listing {
  const variants = p.variants ?? [];
  const prices = variants
    .map((v) => Number.parseFloat(v.price))
    .filter((n) => Number.isFinite(n));
  const availableCount = variants.filter((v) => v.available === true).length;

  // Sale detection: a compare_at_price above the price means a live markdown.
  let compareAtMax = 0;
  let salePct = 0;
  for (const v of variants) {
    const price = Number.parseFloat(v.price);
    const compareAt = Number.parseFloat(v.compare_at_price ?? '');
    if (Number.isFinite(price) && Number.isFinite(compareAt) && compareAt > price) {
      compareAtMax = Math.max(compareAtMax, compareAt);
      salePct = Math.max(salePct, Math.round((1 - price / compareAt) * 100));
    }
  }
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
    ...(salePct > 0 ? { compareAtMax, salePct } : {}),
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
