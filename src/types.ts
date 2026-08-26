/** A grail is one knife (or maker) you are hunting. Lives in grails.json. */
export interface Grail {
  id: string;
  name: string;
  /** Set false to pause hunting without deleting the entry. Default true. */
  enabled?: boolean;
  match: MatchSpec;
  /** Skip listings priced above this (in the retailer's own currency). */
  priceMax?: number;
  /** Restrict the hunt to these retailer ids. Default: all retailers. */
  retailers?: string[];
  notes?: string;
}

/**
 * Term matching against a listing's title + vendor + product type + tags.
 * Matching is case-, whitespace- and diacritic-insensitive.
 */
export interface MatchSpec {
  /** Every one of these must appear. */
  all?: string[];
  /** At least one of these must appear. */
  any?: string[];
  /** None of these may appear. */
  none?: string[];
}

export interface Retailer {
  id: string;
  name: string;
  /** Base URL of the storefront, no trailing slash. */
  url: string;
  /** Which platform adapter to use — see src/adapters.ts for the registry. */
  adapter: 'shopify' | 'woocommerce' | 'squarespace' | 'bigcommerce';
  /** Squarespace only: the shop page path, e.g. "/boutique" or "/shop". */
  path?: string;
  region?: string;
  currency?: string;
  /** Set false to skip without deleting. Default true. */
  enabled?: boolean;
}

/** One product as seen at one retailer. */
export interface Listing {
  retailerId: string;
  retailerName: string;
  region?: string;
  currency?: string;
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  handle: string;
  url: string;
  imageUrl?: string;
  priceMin: number;
  priceMax: number;
  /** Highest original (compare-at/regular) price when the listing is discounted. */
  compareAtMax?: number;
  /** Best discount across variants, whole percent (e.g. 20 = 20% off). */
  salePct?: number;
  available: boolean;
  variantsAvailable: number;
  variantsTotal: number;
  publishedAt?: string;
}

export interface GrailHit {
  grailId: string;
  grailName: string;
  listing: Listing;
}

export interface RetailerStatus {
  id: string;
  name: string;
  url: string;
  ok: boolean;
  error?: string;
  products: number;
  ms: number;
}

export interface ScanResult {
  generatedAt: string;
  demo?: boolean;
  retailers: RetailerStatus[];
  hits: GrailHit[];
}

export interface Config {
  grails: Grail[];
  retailers: Retailer[];
}
