import type { CalibanResponseMeta, WithMeta } from './types.js';

export const HEADER_REQUEST_ID = 'x-caliban-request-id';
export const HEADER_ROUTED_MODEL = 'x-caliban-routed-model';
export const HEADER_CACHE = 'x-caliban-cache';
export const HEADER_PII_ENTITIES = 'x-caliban-pii-entities';
export const HEADER_COST_USD = 'x-caliban-cost-usd';

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  return v === '' ? null : v;
}

/** Parse Caliban response headers into {@link CalibanResponseMeta}. */
export function parseResponseMeta(response: Pick<Response, 'headers' | 'status'>): CalibanResponseMeta {
  const h = response.headers;
  const cache = nonEmpty(h.get(HEADER_CACHE));
  const piiRaw = nonEmpty(h.get(HEADER_PII_ENTITIES));
  const pii = piiRaw !== null && /^\d+$/.test(piiRaw) ? Number(piiRaw) : null;
  const costRaw = nonEmpty(h.get(HEADER_COST_USD));
  const cost = costRaw !== null && /^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(costRaw) ? Number(costRaw) : null;
  return {
    requestId: nonEmpty(h.get(HEADER_REQUEST_ID)),
    routedModel: nonEmpty(h.get(HEADER_ROUTED_MODEL)),
    cache: cache === null ? null : cache.toLowerCase(),
    piiEntities: pii,
    costUsd: cost,
    status: response.status,
    headers: h,
  };
}

/** Attach `meta` as a non-enumerable property so `JSON.stringify` keeps the OpenAI shape. */
export function attachMeta<T extends object>(value: T, meta: CalibanResponseMeta): WithMeta<T> {
  Object.defineProperty(value, 'meta', { value: meta, enumerable: false, configurable: true, writable: false });
  return value as WithMeta<T>;
}
