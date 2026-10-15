import type { CacheTier, CalibanResponseMeta, IntentDecision, RouteStage, ServerTimingEntry, WithMeta } from './types.js';

export const HEADER_REQUEST_ID = 'x-caliban-request-id';
export const HEADER_ROUTED_MODEL = 'x-caliban-routed-model';
export const HEADER_CACHE = 'x-caliban-cache';
export const HEADER_CACHE_TIER = 'x-caliban-cache-tier';
export const HEADER_INTENT = 'x-caliban-intent';
export const HEADER_PII_ENTITIES = 'x-caliban-pii-entities';
export const HEADER_COST_USD = 'x-caliban-cost-usd';
export const HEADER_BILLED_USD = 'x-caliban-billed-usd';
export const HEADER_ROUTE = 'x-caliban-route';
export const HEADER_ROUTE_FALLBACK = 'x-caliban-route-fallback';
export const HEADER_RUN_STATUS = 'x-caliban-run-status';
/** W3C `Server-Timing`: the gateway's per-stage durations of the request, in milliseconds. */
export const HEADER_SERVER_TIMING = 'server-timing';
/** Response header naming the run a response is about (run creation, event streams, node answers). */
export const HEADER_RUN_ID = 'caliban-run-id';

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

/**
 * Parse a `Server-Timing` value (`auth;dur=0.210, route;dur=4.810;desc="knn", ...`) into its
 * metrics, in order. Entries without a name are skipped; a `dur` that is not a non-negative number
 * is left out. `undefined` when absent or empty. Never throws.
 */
export function parseServerTiming(value: string | null | undefined): ServerTimingEntry[] | undefined {
  const raw = nonEmpty(value);
  if (raw === null) return undefined;
  const out: ServerTimingEntry[] = [];
  for (const metric of splitOutsideQuotes(raw, ',')) {
    const [head = '', ...params] = splitOutsideQuotes(metric, ';');
    const name = head.trim();
    if (name === '' || name.includes('=')) continue;
    const entry: ServerTimingEntry = { name };
    for (const param of params) {
      const eq = param.indexOf('=');
      if (eq <= 0) continue;
      const key = param.slice(0, eq).trim().toLowerCase();
      let v = param.slice(eq + 1).trim();
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
      if (key === 'dur' && entry.dur === undefined) {
        const n = Number(v);
        if (v !== '' && Number.isFinite(n) && n >= 0) entry.dur = n;
      } else if (key === 'desc' && entry.desc === undefined) {
        entry.desc = v;
      }
    }
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/** Split on `sep`, ignoring separators inside double-quoted strings. */
function splitOutsideQuotes(value: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quoted && c === '\\' && i + 1 < value.length) {
      cur += c + value[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/** Parse Caliban response headers into {@link CalibanResponseMeta}. */
export function parseResponseMeta(response: Pick<Response, 'headers' | 'status'>): CalibanResponseMeta {
  const h = response.headers;
  const cache = nonEmpty(h.get(HEADER_CACHE));
  const piiRaw = nonEmpty(h.get(HEADER_PII_ENTITIES));
  const pii = piiRaw !== null && /^\d+$/.test(piiRaw) ? Number(piiRaw) : null;
  const cost = parseUsd(h.get(HEADER_COST_USD));
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
  const billed = parseUsd(h.get(HEADER_BILLED_USD));
  if (billed !== null) meta.billedUsd = billed;
  const route = nonEmpty(h.get(HEADER_ROUTE));
  if (route !== null) meta.route = route;
  const fallback = nonEmpty(h.get(HEADER_ROUTE_FALLBACK));
  if (fallback !== null) meta.routeFallback = fallback;
  const runId = nonEmpty(h.get(HEADER_RUN_ID));
  if (runId !== null) meta.runId = runId;
  const runStatus = nonEmpty(h.get(HEADER_RUN_STATUS));
  if (runStatus !== null) meta.runStatus = runStatus;
  const timing = parseServerTiming(h.get(HEADER_SERVER_TIMING));
  if (timing !== undefined) meta.serverTiming = timing;
  return meta;
}

/** A non-negative decimal USD amount, or `null` when absent or malformed. */
function parseUsd(value: string | null): number | null {
  const raw = nonEmpty(value);
  return raw !== null && /^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw) ? Number(raw) : null;
}

/** Attach `meta` as a non-enumerable property so `JSON.stringify` keeps the OpenAI shape. */
export function attachMeta<T extends object>(value: T, meta: CalibanResponseMeta): WithMeta<T> {
  Object.defineProperty(value, 'meta', { value: meta, enumerable: false, configurable: true, writable: false });
  return value as WithMeta<T>;
}
