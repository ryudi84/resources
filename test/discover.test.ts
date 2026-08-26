import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { extractResultUrls, isBlocked, detectPlatform, discoverRetailers } from '../src/discover.ts';
import { demoCatalogs } from '../src/demo.ts';
import type { Config, Retailer } from '../src/types.ts';

test('extractResultUrls parses DuckDuckGo uddg links and Bing redirects', () => {
  const ddg = '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fjapanesenaturalstones.com%2Fraquin&rut=abc">';
  const bingWrapped = `<a class="b" href="https://www.bing.com/ck/a?!&&p=xyz&u=a1${Buffer.from('https://tosho.example/raquin').toString('base64url')}&ntb=1">`;
  const plain = '<a href="https://eatingtools.example/products/raquin">';
  const urls = extractResultUrls(ddg + bingWrapped + plain);
  assert.ok(urls.includes('https://japanesenaturalstones.com/raquin'));
  assert.ok(urls.includes('https://tosho.example/raquin'));
  assert.ok(urls.includes('https://eatingtools.example/products/raquin'));
});

test('blocklist rejects marketplaces and socials', () => {
  assert.ok(isBlocked('www.ebay.com'));
  assert.ok(isBlocked('reddit.com'));
  assert.ok(isBlocked('www.kitchenknifeforums.com'));
  assert.ok(!isBlocked('japanesenaturalstones.com'));
});

async function startMock(handler: (path: string) => { status: number; body: string }): Promise<{ origin: string; close: () => void }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const { status, body } = handler(url.pathname + (url.search ? url.search : ''));
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('detectPlatform fingerprints shopify and squarespace', async () => {
  const shopify = await startMock((p) =>
    p.startsWith('/products.json') ? { status: 200, body: '{"products":[]}' } : { status: 404, body: '{}' },
  );
  const squarespace = await startMock((p) => {
    if (p === '/') return { status: 200, body: '<!-- This is Squarespace. --><a href="/boutique">shop</a>' };
    if (p.startsWith('/boutique?format=json'))
      return { status: 200, body: '{"items":[{"structuredContent":{"variants":[{}]}}]}' };
    return { status: 404, body: '{}' };
  });
  const nothing = await startMock(() => ({ status: 404, body: 'nope' }));

  const io = {
    json: async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) return null;
      return res.json().catch(() => null);
    },
    text: async (url: string) => {
      const res = await fetch(url).catch(() => null);
      return res?.ok ? res.text() : null;
    },
  };
  try {
    assert.deepEqual(await detectPlatform(shopify.origin, io), { adapter: 'shopify' });
    assert.deepEqual(await detectPlatform(squarespace.origin, io), { adapter: 'squarespace', path: '/boutique' });
    assert.equal(await detectPlatform(nothing.origin, io), null);
  } finally {
    shopify.close();
    squarespace.close();
    nothing.close();
  }
});

test('discoverRetailers verifies stock against grails and skips known/blocked domains', async () => {
  const config: Config = {
    grails: [{ id: 'takada', name: 'Takada', match: { any: ['takada'] } }],
    retailers: [{ id: 'known', name: 'Known Shop', url: 'https://known.example', adapter: 'shopify' }],
  };
  const io = {
    search: async () => [
      'https://www.ebay.com/itm/takada', // blocked
      'https://known.example/products/takada', // already in roster
      'https://newshop.example/products/takada-gyuto', // real candidate
      'https://emptyshop.example/products/nothing', // platform but no grail stock
    ],
    json: async (url: string) =>
      url.includes('newshop') || url.includes('emptyshop')
        ? url.includes('/products.json') ? { products: [] } : null
        : null,
    text: async () => null,
    fetchCatalog: async (r: Retailer) =>
      r.url.includes('newshop')
        ? demoCatalogs({ ...r, id: 'tosho' }) // fixtures include Takada listings
        : [],
  };
  const found = await discoverRetailers(config, io);
  assert.equal(found.length, 1);
  assert.equal(found[0].retailer.id, 'newshop-example');
  assert.equal(found[0].retailer.adapter, 'shopify');
  // The announcement must carry the actual matched product, not just the shop.
  assert.match(found[0].sample.title, /takada/i);
  assert.ok(found[0].sample.url.startsWith('http'));
  assert.equal(found[0].grailName, 'Takada');
  assert.ok(found[0].matches >= 1);
});
