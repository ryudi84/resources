import type { Listing, Retailer } from './types.ts';
import { fetchText } from './http.ts';

/**
 * BigCommerce storefronts have no anonymous catalog endpoint, but Stencil
 * themes embed a GraphQL Storefront API bearer token in the page HTML. The
 * adapter self-bootstraps: scrape the token from the homepage, then page
 * through the official GraphQL products API (name, price, sale price, live
 * stock state). Covers e.g. Japanese Natural Stones (JNS).
 */

const PAGE_SIZE = 50;
// JNS alone lists 6.5k products, and BigCommerce cursors walk ascending
// product ids — the newest (grail drops) come LAST, so truncation loses
// exactly the listings that matter.
const MAX_PAGES = 300;

const PRODUCTS_QUERY = `query($after:String){site{products(first:${PAGE_SIZE},after:$after){pageInfo{hasNextPage endCursor}edges{node{name path sku brand{name}prices{price{value currencyCode}basePrice{value}salePrice{value}}inventory{isInStock}defaultImage{url(width:500)}}}}}}`;

interface BcMoney {
  value?: number;
  currencyCode?: string;
}

interface BcNode {
  name: string;
  path?: string;
  sku?: string;
  brand?: { name?: string } | null;
  prices?: { price?: BcMoney; basePrice?: BcMoney; salePrice?: BcMoney | null } | null;
  inventory?: { isInStock?: boolean } | null;
  defaultImage?: { url?: string } | null;
}

interface BcPage {
  data?: {
    site?: {
      products?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        edges?: Array<{ node: BcNode }>;
      };
    };
  };
}

export function extractGraphQLToken(html: string): string | null {
  // The token may sit inside JSON-escaped strings (graphQLToken\":\"eyJ…),
  // so quotes are optionally backslash-escaped.
  const patterns = [
    /graphQLToken\\?['"]?\s*[:=]\s*\\?['"]([A-Za-z0-9._-]{20,})/,
    /"storefront_api"\s*:\s*{\s*"token"\s*:\s*"([A-Za-z0-9._-]{20,})"/,
  ];
  for (const p of patterns) {
    const m = p.exec(html);
    if (m) return m[1];
  }
  return null;
}

function toListing(retailer: Retailer, node: BcNode): Listing {
  const price = node.prices?.price?.value ?? 0;
  const base = node.prices?.basePrice?.value ?? 0;
  const onSale = base > price && price > 0;
  const available = node.inventory?.isInStock !== false;
  const path = node.path ?? '';
  return {
    retailerId: retailer.id,
    retailerName: retailer.name,
    region: retailer.region,
    currency: node.prices?.price?.currencyCode ?? retailer.currency,
    title: node.name,
    vendor: node.brand?.name ?? '',
    productType: '',
    tags: [],
    handle: node.sku || path || node.name,
    url: path.startsWith('http') ? path : `${retailer.url}${path}`,
    imageUrl: node.defaultImage?.url,
    priceMin: price,
    priceMax: price,
    ...(onSale ? { compareAtMax: base, salePct: Math.round((1 - price / base) * 100) } : {}),
    available,
    variantsAvailable: available ? 1 : 0,
    variantsTotal: 1,
  };
}

async function graphql(retailer: Retailer, token: string, after: string | null): Promise<BcPage | null> {
  try {
    const res = await fetch(`${retailer.url}/graphql`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'grail-knife-finder/1.0',
      },
      body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { after } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    return (await res.json()) as BcPage;
  } catch (err) {
    throw new Error(`bigcommerce graphql: ${(err as Error).message}`);
  }
}

/** Pull the full catalog of one BigCommerce storefront as normalized listings. */
export async function fetchBigCommerceCatalog(retailer: Retailer): Promise<Listing[]> {
  const home = await fetchText(retailer.url);
  const token = home ? extractGraphQLToken(home) : null;
  if (!token) throw new Error('no storefront GraphQL token found in page HTML');

  const listings: Listing[] = [];
  let after: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await graphql(retailer, token, after);
    const products = data?.data?.site?.products;
    const edges = products?.edges ?? [];
    for (const edge of edges) listings.push(toListing(retailer, edge.node));
    if (!products?.pageInfo?.hasNextPage || edges.length === 0) break;
    const next = products.pageInfo.endCursor ?? null;
    if (next === after) break; // cursor stopped advancing — bail, never loop
    after = next;
  }
  return listings;
}
