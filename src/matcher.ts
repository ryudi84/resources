import type { Grail, Listing, MatchSpec } from './types.ts';

/** Fold case, diacritics, and whitespace so "Takada  no Hámono" ≡ "takada no hamono". */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The searchable text for a listing. */
export function haystack(l: Listing): string {
  return normalize([l.title, l.vendor, l.productType, ...l.tags].join(' • '));
}

export function matchesSpec(hay: string, spec: MatchSpec): boolean {
  const all = spec.all?.map(normalize) ?? [];
  const any = spec.any?.map(normalize) ?? [];
  const none = spec.none?.map(normalize) ?? [];
  if (all.length === 0 && any.length === 0) return false; // an empty spec matches nothing, not everything
  if (!all.every((t) => hay.includes(t))) return false;
  if (any.length > 0 && !any.some((t) => hay.includes(t))) return false;
  if (none.some((t) => hay.includes(t))) return false;
  return true;
}

export function matchesGrail(grail: Grail, listing: Listing): boolean {
  if (grail.enabled === false) return false;
  if (grail.retailers && grail.retailers.length > 0 && !grail.retailers.includes(listing.retailerId)) {
    return false;
  }
  if (grail.priceMax != null && listing.priceMin > grail.priceMax) return false;
  return matchesSpec(haystack(listing), grail.match);
}
