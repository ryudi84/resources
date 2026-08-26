import type { Listing, Retailer } from './types.ts';
import { fetchJson } from './http.ts';

/**
 * Squarespace commerce sites expose their shop page as JSON at
 * <site><path>?format=json — items carry per-variant stock counts
 * (qtyInStock/unlimited), prices, and sale state. Covers maker-direct shops
 * like bryanraquin.com that run neither Shopify nor WooCommerce.
 *
 * Note: listings get vendor = retailer name, so a grail term like "raquin"
 * matches a maker-direct boutique even when product titles don't repeat the
 * maker's name.
 */

const MAX_PAGES = 20;

interface SqVariant {
  price?: number; // cents
  salePrice?: number; // cents
  onSale?: boolean;
  unlimited?: boolean;
  qtyInStock?: number;
  priceMoney?: { currency?: string; value?: string };
}

interface SqItem {
  title: string;
  fullUrl?: string;
  urlId?: string;
  assetUrl?: string;
  tags?: string[] | null;
  categories?: string[] | null;
  structuredContent?: {
    _type?: string;
    variants?: SqVariant[];
  };
}

interface SqPage {
  items?: SqItem[];
  pagination?: { nextPageUrl?: string };
}

function toListing(retailer: Retailer, item: SqItem): Listing {
  const variants = item.structuredContent?.variants ?? [];
  const currency = variants.find((v) => v.priceMoney?.currency)?.priceMoney?.currency ?? retailer.currency;

  const effective: number[] = [];
  let compareAtMax = 0;
  let salePct = 0;
  let availableCount = 0;
  for (const v of variants) {
    const regular = (v.price ?? 0) / 100;
    const sale = (v.salePrice ?? 0) / 100;
    const onSale = Boolean(v.onSale) && sale > 0 && sale < regular;
    const price = onSale ? sale : regular;
    if (price > 0) effective.push(price);
    if (onSale) {
      compareAtMax = Math.max(compareAtMax, regular);
      salePct = Math.max(salePct, Math.round((1 - sale / regular) * 100));
    }
    if (v.unlimited === true || (v.qtyInStock ?? 0) > 0) availableCount++;
  }

  const fullUrl = item.fullUrl ?? '';
  return {
    retailerId: retailer.id,
    retailerName: retailer.name,
    region: retailer.region,
    currency,
    title: item.title,
    vendor: retailer.name,
    productType: item.structuredContent?._type ?? '',
    tags: [...(item.tags ?? []), ...(item.categories ?? [])],
    handle: item.urlId ?? fullUrl ?? item.title,
    url: fullUrl.startsWith('http') ? fullUrl : `${retailer.url}${fullUrl}`,
    imageUrl: item.assetUrl,
    priceMin: effective.length ? Math.min(...effective) : 0,
    priceMax: effective.length ? Math.max(...effective) : 0,
    ...(salePct > 0 ? { compareAtMax, salePct } : {}),
    available: availableCount > 0,
    variantsAvailable: availableCount,
    variantsTotal: variants.length,
  };
}

/** Pull the shop page of one Squarespace site as normalized listings. */
export async function fetchSquarespaceCatalog(retailer: Retailer): Promise<Listing[]> {
  if (!retailer.path) throw new Error(`squarespace retailer ${retailer.id} needs a "path" (e.g. "/boutique")`);
  const listings: Listing[] = [];
  let pageUrl: string | null = `${retailer.url}${retailer.path}?format=json`;
  for (let page = 1; page <= MAX_PAGES && pageUrl; page++) {
    const data = (await fetchJson(pageUrl)) as SqPage | null;
    const items = data?.items;
    if (!items || items.length === 0) break;
    // Only commerce items (products carry structuredContent.variants).
    for (const item of items) {
      if (item.structuredContent?.variants?.length) listings.push(toListing(retailer, item));
    }
    const next = data?.pagination?.nextPageUrl;
    pageUrl = next ? (next.startsWith('http') ? next : `${retailer.url}${next}`) : null;
  }
  return listings;
}
