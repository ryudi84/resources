import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchShopifyCatalog } from '../src/shopify.ts';
import { newlyAvailable, runScan } from '../src/scan.ts';
import { demoCatalogs } from '../src/demo.ts';
import type { Config, GrailHit, Listing, Retailer } from '../src/types.ts';

const PAGE1 = {
  products: [
    {
      title: 'Takada no Hamono Suiboku W2 Gyuto 240mm',
      handle: 'takada-suiboku-gyuto-240',
      vendor: 'Takada no Hamono',
      product_type: 'Gyuto',
      tags: ['w2'],
      published_at: '2026-08-01T00:00:00Z',
      variants: [
        { price: '640.00', available: true },
        { price: '660.00', available: false },
      ],
      images: [{ src: 'https://cdn.example/img.jpg' }],
    },
    {
      title: 'Random Whetstone 1000',
      handle: 'whetstone-1000',
      vendor: 'Naniwa',
      product_type: 'Sharpening',
      tags: 'stones, 1000',
      variants: [{ price: '45.00', available: true }],
    },
  ],
};

test('shopify adapter paginates and normalizes listings', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const page = url.searchParams.get('page');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(page === '1' ? PAGE1 : { products: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  try {
    const retailer: Retailer = {
      id: 'fake',
      name: 'Fake Shop',
      url: `http://127.0.0.1:${port}`,
      adapter: 'shopify',
      currency: 'USD',
    };
    const listings = await fetchShopifyCatalog(retailer);
    assert.equal(listings.length, 2);

    const takada = listings[0];
    assert.equal(takada.title, 'Takada no Hamono Suiboku W2 Gyuto 240mm');
    assert.equal(takada.available, true);
    assert.equal(takada.variantsAvailable, 1);
    assert.equal(takada.variantsTotal, 2);
    assert.equal(takada.priceMin, 640);
    assert.equal(takada.priceMax, 660);
    assert.equal(takada.url, `http://127.0.0.1:${port}/products/takada-suiboku-gyuto-240`);

    const stone = listings[1];
    assert.deepEqual(stone.tags, ['stones', '1000']); // comma-string tags normalized
  } finally {
    server.close();
  }
});

test('runScan matches grails and survives a failing retailer', async () => {
  const config: Config = {
    grails: [{ id: 'takada', name: 'Takada (anything)', match: { any: ['takada'] } }],
    retailers: [
      { id: 'tosho', name: 'Tosho Knife Arts', url: 'https://t.example', adapter: 'shopify' },
      { id: 'broken', name: 'Broken Shop', url: 'https://b.example', adapter: 'shopify' },
    ],
  };
  const fetcher = async (r: Retailer): Promise<Listing[]> => {
    if (r.id === 'broken') throw new Error('ECONNREFUSED');
    return demoCatalogs(r);
  };
  const result = await runScan(config, fetcher, true);

  assert.equal(result.retailers.length, 2);
  assert.equal(result.retailers.find((r) => r.id === 'broken')?.ok, false);
  assert.equal(result.hits.length, 2); // both Tosho fixtures mention Takada
  assert.ok(result.hits[0].listing.available, 'in-stock hits sort first');
});

test('newlyAvailable flags only fresh stock', () => {
  const hit = (handle: string, available: boolean): GrailHit => ({
    grailId: 'g',
    grailName: 'g',
    listing: { retailerId: 'r', handle, available } as Listing,
  });
  const prev = [hit('a', true), hit('b', false)];
  const curr = [hit('a', true), hit('b', true), hit('c', true), hit('d', false)];
  const fresh = newlyAvailable(curr, prev);
  assert.deepEqual(fresh.map((h) => h.listing.handle), ['b', 'c']);
});
