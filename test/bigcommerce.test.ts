import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { extractGraphQLToken, fetchBigCommerceCatalog } from '../src/bigcommerce.ts';
import type { Retailer } from '../src/types.ts';

const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.payload_chunk-123.sig_chunk';

test('extractGraphQLToken handles plain and JSON-escaped embeddings', () => {
  assert.equal(extractGraphQLToken(`{"graphQLToken":"${TOKEN}"}`), TOKEN);
  assert.equal(extractGraphQLToken(`"{\\"graphQLToken\\":\\"${TOKEN}\\"}"`), TOKEN); // JNS-style escaped
  assert.equal(extractGraphQLToken(`graphQLToken = '${TOKEN}';`), TOKEN);
  assert.equal(extractGraphQLToken('<html>no token here</html>'), null);
});

test('bigcommerce adapter bootstraps token from HTML and pages GraphQL', async () => {
  const page1 = {
    data: {
      site: {
        products: {
          pageInfo: { hasNextPage: true, endCursor: 'CURSOR1' },
          edges: [
            {
              node: {
                name: 'Bryan Raquin Gyuto 240mm',
                path: '/bryan-raquin-gyuto-240mm/',
                sku: 'RAQ240',
                brand: { name: 'Bryan Raquin' },
                prices: {
                  price: { value: 1450, currencyCode: 'EUR' },
                  basePrice: { value: 1450 },
                  salePrice: null,
                },
                inventory: { isInStock: true },
                defaultImage: { url: 'https://cdn.example/raq.jpg' },
              },
            },
          ],
        },
      },
    },
  };
  const page2 = {
    data: {
      site: {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [
            {
              node: {
                name: 'Ohira Renge Suita',
                path: '/ohira-suita/',
                prices: { price: { value: 800, currencyCode: 'EUR' }, basePrice: { value: 1000 } },
                inventory: { isInStock: false },
              },
            },
          ],
        },
      },
    },
  };

  let sawAuth = '';
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '') {
      res.setHeader('content-type', 'text/html');
      res.end(`<html>bigcommerce theme "{\\"graphQLToken\\":\\"${TOKEN}\\"}"</html>`);
      return;
    }
    if (req.url === '/graphql') {
      sawAuth = req.headers.authorization ?? '';
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { variables } = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(variables?.after === 'CURSOR1' ? page2 : page1));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  try {
    const retailer: Retailer = {
      id: 'jns',
      name: 'JNS',
      url: `http://127.0.0.1:${port}`,
      adapter: 'bigcommerce',
      currency: 'EUR',
    };
    const listings = await fetchBigCommerceCatalog(retailer);
    assert.equal(sawAuth, `Bearer ${TOKEN}`);
    assert.equal(listings.length, 2);

    const raquin = listings[0];
    assert.equal(raquin.vendor, 'Bryan Raquin');
    assert.equal(raquin.available, true);
    assert.equal(raquin.priceMin, 1450);
    assert.equal(raquin.currency, 'EUR');
    assert.equal(raquin.url, `http://127.0.0.1:${port}/bryan-raquin-gyuto-240mm/`);

    const suita = listings[1];
    assert.equal(suita.available, false);
    assert.equal(suita.salePct, 20); // 800 vs basePrice 1000
    assert.equal(suita.compareAtMax, 1000);
  } finally {
    server.close();
  }
});
