import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, matchesGrail, matchesSpec, haystack } from '../src/matcher.ts';
import type { Grail, Listing } from '../src/types.ts';

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    retailerId: 'tosho',
    retailerName: 'Tosho Knife Arts',
    currency: 'CAD',
    title: 'Takada no Hamono Suiboku W2 Gyuto 240mm',
    vendor: 'Takada no Hamono',
    productType: 'Gyuto',
    tags: ['w2', 'kasumi'],
    handle: 'takada-suiboku-gyuto-240',
    url: 'https://toshoknifearts.com/products/takada-suiboku-gyuto-240',
    priceMin: 640,
    priceMax: 640,
    available: true,
    variantsAvailable: 1,
    variantsTotal: 1,
    ...overrides,
  };
}

test('normalize folds case, whitespace and diacritics', () => {
  assert.equal(normalize('  Takada  no  Hámono '), 'takada no hamono');
});

test('any-term grail matches a Takada listing', () => {
  const grail: Grail = { id: 'g', name: 'Takada', match: { any: ['takada'] } };
  assert.ok(matchesGrail(grail, listing()));
});

test('all terms must be present', () => {
  const grail: Grail = { id: 'g', name: 'g', match: { all: ['takada', 'suiboku', 'gyuto'] } };
  assert.ok(matchesGrail(grail, listing()));
  assert.ok(!matchesGrail(grail, listing({ title: 'Takada no Hamono Suiboku Petty', productType: 'Petty' })));
});

test('none terms exclude', () => {
  const grail: Grail = { id: 'g', name: 'g', match: { any: ['takada'], none: ['petty'] } };
  assert.ok(!matchesGrail(grail, listing({ title: 'Takada Petty 150mm' })));
});

test('empty spec matches nothing', () => {
  assert.ok(!matchesSpec(haystack(listing()), {}));
});

test('disabled grail never matches', () => {
  const grail: Grail = { id: 'g', name: 'g', enabled: false, match: { any: ['takada'] } };
  assert.ok(!matchesGrail(grail, listing()));
});

test('price cap filters expensive listings', () => {
  const grail: Grail = { id: 'g', name: 'g', match: { any: ['takada'] }, priceMax: 500 };
  assert.ok(!matchesGrail(grail, listing()));
  assert.ok(matchesGrail(grail, listing({ priceMin: 450, priceMax: 450 })));
});

test('retailer restriction honored', () => {
  const grail: Grail = { id: 'g', name: 'g', match: { any: ['takada'] }, retailers: ['carbon-knife-co'] };
  assert.ok(!matchesGrail(grail, listing()));
  assert.ok(matchesGrail(grail, listing({ retailerId: 'carbon-knife-co' })));
});

test('matches against vendor and tags, not just title', () => {
  const grail: Grail = { id: 'g', name: 'g', match: { all: ['takada', 'kasumi'] } };
  assert.ok(matchesGrail(grail, listing({ title: 'Suiboku W2 Gyuto 240mm' })));
});
