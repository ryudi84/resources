import type { Listing, Retailer } from './types.ts';
import { fetchShopifyCatalog } from './shopify.ts';
import { fetchWooCatalog } from './woocommerce.ts';
import { fetchSquarespaceCatalog } from './squarespace.ts';

/**
 * Platform adapter registry. To support another platform (BigCommerce,
 * Squarespace, a bespoke shop), write one function (Retailer) => Listing[]
 * and register it here; retailers.json selects it via its "adapter" field.
 */
export const adapters: Record<Retailer['adapter'], (r: Retailer) => Promise<Listing[]>> = {
  shopify: fetchShopifyCatalog,
  woocommerce: fetchWooCatalog,
  squarespace: fetchSquarespaceCatalog,
};

export function catalogFetcher(retailer: Retailer): Promise<Listing[]> {
  const adapter = adapters[retailer.adapter];
  if (!adapter) throw new Error(`Unknown adapter "${retailer.adapter}" for retailer ${retailer.id}`);
  return adapter(retailer);
}
