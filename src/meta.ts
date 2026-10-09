import type { CacheTier, CalibanResponseMeta, IntentDecision, RouteStage, WithMeta } from './types.js';

export const HEADER_REQUEST_ID = 'x-caliban-request-id';
export const HEADER_ROUTED_MODEL = 'x-caliban-routed-model';
export const HEADER_CACHE = 'x-caliban-cache';
export const HEADER_CACHE_TIER = 'x-caliban-cache-tier';
export const HEADER_INTENT = 'x-caliban-intent';
export const HEADER_PII_ENTITIES = 'x-caliban-pii-entities';
export const HEADER_COST_USD = 'x-caliban-cost-usd';

const CACHE_TIERS: ReadonlySet<string> = new Set<CacheTier>(['exact', 'semantic']);
const ROUTE_STAGES: ReadonlySet<string> = new Set<RouteStage>(['rules', 'knn', 'keyword']);
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  return v === '' ? null : v;
}

/** Parse an `x-caliban-cache-tier` value. `undefined` when absent or not `exact`/`semantic`. */
export function parseCacheTier(value: string | null | undefined): CacheTier | undefined {
  const v = nonEmpty(value)?.toLowerCase();
  return v !== undefined && CACHE_TIERS.has(v) ? (v as CacheTier) : undefined;
}

/**
 * Parse an `x-caliban-intent` value (`<intent>;confidence=<0..1>;stage=<rules|knn|keyword>`,
 * optionally `;knn=<reason>`). Unknown fields are ignored; a value without an intent name, a
 * valid `confidence` in 0..1, or a known `stage` gives `undefined`. Never throws.
 */
export function parseIntentHeader(value: string | null | undefined): IntentDecision | undefined {
  const raw = nonEmpty(value);
  if (raw === null) return undefined;
  const [head = '', ...rest] = raw.split(';');
  const intent = head.trim();
  if (intent === '' || intent.includes('=')) return undefined;

  const fields = new Map<string, string>();
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!fields.has(key)) fields.set(key, part.slice(eq + 1).trim());
  }

  const confRaw = fields.get('confidence');
  if (confRaw === undefined || !DECIMAL.test(confRaw)) return undefined;
  const confidence = Number(confRaw);
  if (!(confidence >= 0 && confidence <= 1)) return undefined;

  const stage = fields.get('stage')?.toLowerCase();
  if (stage === undefined || !ROUTE_STAGES.has(stage)) return undefined;

  const decision: IntentDecision = { intent, confidence, stage: stage as RouteStage };
  const knn = fields.get('knn');
  if (knn) decision.knnReason = knn;
  return decision;
}

/** Parse Caliban response headers into {@link CalibanResponseMeta}. */
export function parseResponseMeta(response: Pick<Response, 'headers' | 'status'>): CalibanResponseMeta {
  const h = response.headers;
  const cache = nonEmpty(h.get(HEADER_CACHE));
  const piiRaw = nonEmpty(h.get(HEADER_PII_ENTITIES));
  const pii = piiRaw !== null && /^\d+$/.test(piiRaw) ? Number(piiRaw) : null;
  const costRaw = nonEmpty(h.get(HEADER_COST_USD));
  const cost = costRaw !== null && /^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(costRaw) ? Number(costRaw) : null;
  const meta: CalibanResponseMeta = {
    requestId: nonEmpty(h.get(HEADER_REQUEST_ID)),
    routedModel: nonEmpty(h.get(HEADER_ROUTED_MODEL)),
    cache: cache === null ? null : cache.toLowerCase(),
    piiEntities: pii,
    costUsd: cost,
    status: response.status,
    headers: h,
  };
  const cacheTier = parseCacheTier(h.get(HEADER_CACHE_TIER));
  if (cacheTier !== undefined) meta.cacheTier = cacheTier;
  const intent = parseIntentHeader(h.get(HEADER_INTENT));
  if (intent !== undefined) meta.intent = intent;
  return meta;
}

/** Attach `meta` as a non-enumerable property so `JSON.stringify` keeps the OpenAI shape. */
export function attachMeta<T extends object>(value: T, meta: CalibanResponseMeta): WithMeta<T> {
  Object.defineProperty(value, 'meta', { value: meta, enumerable: false, configurable: true, writable: false });
  return value as WithMeta<T>;
}
