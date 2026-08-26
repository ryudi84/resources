import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchSquarespaceCatalog } from '../src/squarespace.ts';
import { matchesGrail } from '../src/matcher.ts';
import type { Grail, Retailer } from '../src/types.ts';

const SQ_PAGE = {
  items: [
    {
      title: 'Gyuto 240mm san mai',
      fullUrl: '/boutique/p/gyuto-240-sanmai',
      urlId: 'gyuto-240-sanmai',
      assetUrl: 'https://images.squarespace-cdn.com/gyuto.jpg',
      tags: null,
      categories: null,
      structuredContent: {
        _type: 'website.components.product',
        variants: [
          {
            price: 95000,
            salePrice: 80000,
            onSale: true,
            unlimited: false,
            qtyInStock: 1,
            priceMoney: { currency: 'EUR', value: '950.00' },
          },
        ],
      },
    },
    {
      title: "nakiri's raffle",
      fullUrl: '/boutique/p/nakiri-raffle',
      urlId: 'nakiri-raffle',
      structuredContent: {
        variants: [{ price: 1000, salePrice: 0, onSale: false, unlimited: false, qtyInStock: 0, priceMoney: { currency: 'EUR', value: '10.00' } }],
      },
    },
    { title: 'A blog post, not a product', fullUrl: '/journal/post' },
  ],
  pagination: {},
};

test('squarespace adapter reads ?format=json, keeps only products, and grail-matches via vendor', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(url.pathname === '/boutique' && url.searchParams.get('format') === 'json' ? SQ_PAGE : {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  try {
    const retailer: Retailer = {
      id: 'bryan-raquin-direct',
      name: 'Bryan Raquin (direct)',
      url: `http://127.0.0.1:${port}`,
      adapter: 'squarespace',
      path: '/boutique',
      currency: 'EUR',
    };
    const listings = await fetchSquarespaceCatalog(retailer);
    assert.equal(listings.length, 2, 'non-product items are dropped');

    const gyuto = listings[0];
    assert.equal(gyuto.priceMin, 800); // sale price in effect
    assert.equal(gyuto.compareAtMax, 950);
    assert.equal(gyuto.salePct, 16);
    assert.equal(gyuto.available, true);
    assert.equal(gyuto.currency, 'EUR');
    assert.equal(gyuto.url, `http://127.0.0.1:${port}/boutique/p/gyuto-240-sanmai`);

    assert.equal(listings[1].available, false); // qtyInStock 0

    // Maker-direct matching: title has no "raquin", vendor carries it.
    const grail: Grail = { id: 'raquin', name: 'Raquin', match: { any: ['raquin'] } };
    assert.ok(matchesGrail(grail, gyuto));
  } finally {
    server.close();
  }
});
