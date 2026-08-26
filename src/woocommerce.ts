import type { Listing, Retailer } from './types.ts';
import { fetchJson } from './http.ts';

/**
 * WooCommerce storefronts ship the public Store API:
 * /wp-json/wc/store/v1/products?per_page=100&page=N — no auth, includes
 * stock state and prices (in minor units). Covers the knife retailers that
 * run WordPress instead of Shopify.
 */

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

interface WooTerm {
  name?: string;
}

interface WooPrices {
  price?: string;
  regular_price?: string;
  sale_price?: string;
  currency_code?: string;
  currency_minor_unit?: number;
}

interface WooProduct {
  name: string;
  slug?: string;
  permalink?: string;
  is_in_stock?: boolean;
  on_sale?: boolean;
  prices?: WooPrices;
  categories?: WooTerm[];
  tags?: WooTerm[];
  images?: Array<{ src?: string }>;
}

function minorToMajor(value: string | undefined, minorUnit: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n / 10 ** minorUnit : 0;
}

function toListing(retailer: Retailer, p: WooProduct): Listing {
  const minorUnit = p.prices?.currency_minor_unit ?? 2;
  const price = minorToMajor(p.prices?.price, minorUnit);
  const regular = minorToMajor(p.prices?.regular_price, minorUnit);
  const onSale = Boolean(p.on_sale) && regular > price && price > 0;
  const available = p.is_in_stock !== false;
  return {
    retailerId: retailer.id,
    retailerName: retailer.name,
    region: retailer.region,
    currency: p.prices?.currency_code ?? retailer.currency,
    title: p.name,
    vendor: '',
    productType: p.categories?.map((c) => c.name).filter(Boolean).join(' ') ?? '',
    tags: (p.tags ?? []).map((t) => t.name ?? '').filter(Boolean),
    handle: p.slug ?? p.permalink ?? p.name,
    url: p.permalink ?? retailer.url,
    imageUrl: p.images?.[0]?.src,
    priceMin: price,
    priceMax: price,
    ...(onSale ? { compareAtMax: regular, salePct: Math.round((1 - price / regular) * 100) } : {}),
    available,
    variantsAvailable: available ? 1 : 0,
    variantsTotal: 1,
  };
}

/** Pull the full catalog of one WooCommerce storefront as normalized listings. */
export async function fetchWooCatalog(retailer: Retailer): Promise<Listing[]> {
  const listings: Listing[] = [];
  // v1 is current; the unversioned path serves older Woo installs.
  let base = `${retailer.url}/wp-json/wc/store/v1/products`;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data = (await fetchJson(`${base}?per_page=${PAGE_SIZE}&page=${page}`)) as WooProduct[] | null;
    if (page === 1 && !Array.isArray(data)) {
      base = `${retailer.url}/wp-json/wc/store/products`;
      data = (await fetchJson(`${base}?per_page=${PAGE_SIZE}&page=${page}`)) as WooProduct[] | null;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const p of data) listings.push(toListing(retailer, p));
    if (data.length < PAGE_SIZE) break;
  }
  return listings;
}
