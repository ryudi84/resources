import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchWooCatalog } from '../src/woocommerce.ts';
import { sealPanel, unsealPanel } from '../src/crypto.ts';
import { isBargain, buildDigest } from '../src/digest.ts';
import type { GrailHit, Listing, Retailer, ScanResult } from '../src/types.ts';

const WOO_PAGE1 = [
  {
    name: 'Takada no Hamono Suiboku Gyuto 24cm',
    slug: 'takada-suiboku-gyuto-24',
    permalink: 'https://shop.example/product/takada-suiboku-gyuto-24',
    is_in_stock: true,
    on_sale: true,
    prices: { price: '52000', regular_price: '65000', currency_code: 'GBP', currency_minor_unit: 2 },
    categories: [{ name: 'Gyuto' }],
    tags: [{ name: 'takada' }],
    images: [{ src: 'https://cdn.example/takada.jpg' }],
  },
  {
    name: 'Sakai Petty 135mm',
    slug: 'sakai-petty',
    permalink: 'https://shop.example/product/sakai-petty',
    is_in_stock: false,
    prices: { price: '18000', regular_price: '18000', currency_code: 'GBP', currency_minor_unit: 2 },
  },
];

test('woocommerce adapter reads the Store API and normalizes minor units', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/wp-json/wc/store/v1/products') {
      res.end(JSON.stringify(url.searchParams.get('page') === '1' ? WOO_PAGE1 : []));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  try {
    const retailer: Retailer = {
      id: 'woo-shop',
      name: 'Woo Shop',
      url: `http://127.0.0.1:${port}`,
      adapter: 'woocommerce',
    };
    const listings = await fetchWooCatalog(retailer);
    assert.equal(listings.length, 2);

    const takada = listings[0];
    assert.equal(takada.priceMin, 520); // minor units → major
    assert.equal(takada.compareAtMax, 650);
    assert.equal(takada.salePct, 20);
    assert.equal(takada.available, true);
    assert.equal(takada.currency, 'GBP');
    assert.equal(takada.url, 'https://shop.example/product/takada-suiboku-gyuto-24');
    assert.equal(listings[1].available, false);
  } finally {
    server.close();
  }
});

test('panel sealing round-trips with the right password and rejects the wrong one', async () => {
  const secret = JSON.stringify({ hits: ['takada'] });
  const sealed = await sealPanel('correct horse', secret);
  assert.equal(await unsealPanel('correct horse', sealed), secret);
  await assert.rejects(unsealPanel('wrong password', sealed));
  assert.ok(!JSON.stringify(sealed).includes('takada'), 'ciphertext must not leak plaintext');
});

function hit(overrides: Partial<Listing>): GrailHit {
  return {
    grailId: 'g',
    grailName: 'Takada',
    listing: {
      retailerId: 'r',
      retailerName: 'Shop',
      title: 'Takada Gyuto',
      vendor: '',
      productType: '',
      tags: [],
      handle: 'x',
      url: 'https://x.example/p',
      priceMin: 500,
      priceMax: 500,
      available: true,
      variantsAvailable: 1,
      variantsTotal: 1,
      ...overrides,
    },
  };
}

test('bargain detection: markdowns and B-grade keywords', () => {
  assert.ok(isBargain(hit({ salePct: 20, compareAtMax: 650 })));
  assert.ok(isBargain(hit({ title: 'Takada Gyuto 240mm (B-Grade)' })));
  assert.ok(!isBargain(hit({})));
});

test('digest separates bargains from full-price stock', () => {
  const result: ScanResult = {
    generatedAt: '2026-08-26T13:00:00.000Z',
    retailers: [{ id: 'r', name: 'Shop', url: 'https://x.example', ok: true, products: 10, ms: 5 }],
    hits: [
      hit({ salePct: 20, compareAtMax: 650, title: 'Takada Deal' }),
      hit({ title: 'Takada Full Price' }),
      hit({ title: 'Takada Sold Out', available: false }),
    ],
  };
  const digest = buildDigest(result);
  assert.match(digest.content, /2026-08-26/);
  const [bargains, fullPrice] = digest.embeds as Array<{ title: string; description: string }>;
  assert.match(bargains.title, /Bargains/);
  assert.match(bargains.description, /Takada Deal.*−20%/);
  assert.match(fullPrice.title, /full price/);
  assert.match(fullPrice.description, /Takada Full Price/);
});
