import type { Listing, Retailer } from './types.ts';

/**
 * Deterministic fixture catalogs for `npm run scan:demo` and tests, so the
 * dashboard and diff logic can be exercised without network access. Titles
 * mirror how real retailers list Takada no Hamono.
 */

const FIXTURES: Record<string, Array<Partial<Listing> & { title: string; handle: string }>> = {
  tosho: [
    {
      title: 'Takada no Hamono Suiboku W2 Gyuto 240mm Ho/Horn',
      handle: 'takada-no-hamono-suiboku-w2-gyuto-240mm',
      vendor: 'Takada no Hamono',
      productType: 'Gyuto',
      priceMin: 640,
      priceMax: 640,
      available: true,
      variantsAvailable: 1,
      variantsTotal: 1,
    },
    {
      title: 'Takada no Hamono Reika Blue 1 Petty 150mm',
      handle: 'takada-no-hamono-reika-petty-150mm',
      vendor: 'Takada no Hamono',
      productType: 'Petty',
      priceMin: 380,
      priceMax: 380,
      available: false,
      variantsAvailable: 0,
      variantsTotal: 1,
    },
  ],
  'carbon-knife-co': [
    {
      title: 'Takada no Hamono Ginsan Suiboku Sujihiki 270mm',
      handle: 'takada-ginsan-suiboku-sujihiki-270',
      vendor: 'Takada no Hamono',
      productType: 'Sujihiki',
      priceMin: 750,
      priceMax: 750,
      available: false,
      variantsAvailable: 0,
      variantsTotal: 1,
    },
    {
      title: 'Hitohira Togashi White #1 Gyuto 240mm',
      handle: 'hitohira-togashi-gyuto-240',
      vendor: 'Hitohira',
      productType: 'Gyuto',
      priceMin: 420,
      priceMax: 420,
      available: true,
      variantsAvailable: 2,
      variantsTotal: 2,
    },
  ],
  'knives-and-stones-us': [
    {
      title: 'Takada no Hamono Suiboku White #2 Gyuto 210mm',
      handle: 'takada-suiboku-w2-gyuto-210',
      vendor: 'Takada no Hamono',
      productType: 'Gyuto',
      priceMin: 585,
      priceMax: 585,
      available: false,
      variantsAvailable: 0,
      variantsTotal: 1,
    },
  ],
};

export function demoCatalogs(retailer: Retailer): Listing[] {
  const rows = FIXTURES[retailer.id] ?? [];
  return rows.map((row) => ({
    retailerId: retailer.id,
    retailerName: retailer.name,
    region: retailer.region,
    currency: retailer.currency,
    title: row.title,
    vendor: row.vendor ?? '',
    productType: row.productType ?? '',
    tags: row.tags ?? [],
    handle: row.handle,
    url: `${retailer.url}/products/${row.handle}`,
    imageUrl: row.imageUrl,
    priceMin: row.priceMin ?? 0,
    priceMax: row.priceMax ?? 0,
    available: row.available ?? false,
    variantsAvailable: row.variantsAvailable ?? 0,
    variantsTotal: row.variantsTotal ?? 0,
    publishedAt: row.publishedAt,
  }));
}
