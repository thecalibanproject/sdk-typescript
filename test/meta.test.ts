import { describe, expect, it } from 'vitest';
import {
  CalibanClient,
  HEADER_BILLED_USD,
  HEADER_CACHE_TIER,
  HEADER_COST_USD,
  HEADER_INTENT,
  HEADER_PII_ENTITIES,
  HEADER_REQUEST_ID,
  HEADER_ROUTE,
  HEADER_ROUTE_FALLBACK,
  HEADER_ROUTED_MODEL,
  HEADER_RUN_ID,
  HEADER_RUN_STATUS,
  HEADER_SERVER_TIMING,
  parseCacheTier,
  parseIntentHeader,
  parseResponseMeta,
  parseServerTiming,
} from '../src/index.js';
import { completion, fastRetry, json, mockFetch, sse } from './helpers.js';

const msgs = [{ role: 'user' as const, content: 'hi' }];

function client(fetch: typeof globalThis.fetch) {
  return new CalibanClient({ apiKey: 'cal_test', baseURL: 'http://gw:8080/v1', fetch, retry: fastRetry });
}

function meta(headers: Record<string, string>) {
  return parseResponseMeta(new Response(null, { status: 200, headers }));
}

describe('x-caliban-intent', () => {
  it('parses a kNN decision', () => {
    expect(parseIntentHeader('translate;confidence=0.912;stage=knn')).toEqual({
      intent: 'translate',
      confidence: 0.912,
      stage: 'knn',
    });
  });

  it('parses a pinned model and a keyword fallback with its kNN reason', () => {
    expect(parseIntentHeader('pinned;confidence=1.000;stage=rules')).toEqual({ intent: 'pinned', confidence: 1, stage: 'rules' });
    expect(parseIntentHeader('summarize;confidence=0.640;stage=keyword;knn=timeout')).toEqual({
      intent: 'summarize',
      confidence: 0.64,
      stage: 'keyword',
      knnReason: 'timeout',
    });
  });

  it('tolerates whitespace, case, field order, unknown fields and a trailing separator', () => {
    expect(parseIntentHeader('  code ; STAGE=KNN ; flavour=x; bare ; confidence=0 ; knn=abstain_margin;')).toEqual({
      intent: 'code',
      confidence: 0,
      stage: 'knn',
      knnReason: 'abstain_margin',
    });
  });

  it('keeps the first occurrence of a repeated field and drops an empty knn reason', () => {
    expect(parseIntentHeader('qa;confidence=0.5;confidence=0.9;stage=knn;stage=rules;knn=')).toEqual({
      intent: 'qa',
      confidence: 0.5,
      stage: 'knn',
    });
  });

  it.each([
    ['absent', null],
    ['undefined', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['intent only', 'translate'],
    ['no stage', 'translate;confidence=0.9'],
    ['no confidence', 'translate;stage=knn'],
    ['no intent name', ';confidence=0.9;stage=knn'],
    ['intent name is a field', 'confidence=0.9;stage=knn'],
    ['confidence not a number', 'translate;confidence=high;stage=knn'],
    ['confidence negative', 'translate;confidence=-0.1;stage=knn'],
    ['confidence above 1', 'translate;confidence=1.5;stage=knn'],
    ['confidence NaN', 'translate;confidence=NaN;stage=knn'],
    ['confidence empty', 'translate;confidence=;stage=knn'],
    ['unknown stage', 'translate;confidence=0.9;stage=llm'],
    ['garbage', ';;;=;=='],
  ])('gives undefined when %s', (_name, value) => {
    expect(() => parseIntentHeader(value)).not.toThrow();
    expect(parseIntentHeader(value)).toBeUndefined();
  });
});

describe('x-caliban-cache-tier', () => {
  it('accepts exact and semantic, case-insensitively', () => {
    expect(parseCacheTier('exact')).toBe('exact');
    expect(parseCacheTier(' Semantic ')).toBe('semantic');
  });

  it.each([null, undefined, '', 'hit', 'fuzzy', 'semantic;q=1'])('gives undefined for %j', (value) => {
    expect(parseCacheTier(value)).toBeUndefined();
  });
});

describe('parseResponseMeta with routing and cache-tier headers', () => {
  it('fills cacheTier and intent from good headers', () => {
    const m = meta({
      'x-caliban-cache': 'hit',
      [HEADER_CACHE_TIER]: 'semantic',
      [HEADER_INTENT]: 'translate;confidence=0.912;stage=knn',
    });
    expect(m.cache).toBe('hit');
    expect(m.cacheTier).toBe('semantic');
    expect(m.intent).toEqual({ intent: 'translate', confidence: 0.912, stage: 'knn' });
  });

  it('leaves them undefined on a miss without routing headers (older servers)', () => {
    const m = meta({ 'x-caliban-cache': 'miss', 'x-caliban-request-id': 'r1' });
    expect(m.cache).toBe('miss');
    expect(m.cacheTier).toBeUndefined();
    expect(m.intent).toBeUndefined();
    expect('cacheTier' in m).toBe(false);
    expect('intent' in m).toBe(false);
  });

  it('keeps the other fields when the new headers are malformed', () => {
    const m = meta({
      'x-caliban-request-id': 'r1',
      'x-caliban-cache': 'hit',
      [HEADER_CACHE_TIER]: 'warm',
      [HEADER_INTENT]: 'translate;confidence=2;stage=knn',
    });
    expect(m).toMatchObject({ requestId: 'r1', cache: 'hit' });
    expect(m.cacheTier).toBeUndefined();
    expect(m.intent).toBeUndefined();
  });

  it('is exposed on completions and on streams', async () => {
    const headers = {
      'x-caliban-cache': 'hit',
      'x-caliban-cache-tier': 'exact',
      'x-caliban-intent': 'summarize;confidence=0.640;stage=keyword;knn=embed_error',
    };
    const m = mockFetch(json(completion, { headers }), () => sse(['data: [DONE]\n\n'], headers).response);
    const c = client(m.fetch);
    const res = await c.chat.completions.create({ model: 'caliban/auto', messages: msgs });
    expect(res.meta.cacheTier).toBe('exact');
    expect(res.meta.intent).toEqual({ intent: 'summarize', confidence: 0.64, stage: 'keyword', knnReason: 'embed_error' });
    expect(JSON.parse(JSON.stringify(res))).toEqual(completion);
    const stream = await c.chat.completions.create({ model: 'caliban/auto', messages: msgs, stream: true });
    expect(stream.meta.cacheTier).toBe('exact');
    expect(stream.meta.intent?.stage).toBe('keyword');
  });
});

describe('parseResponseMeta on node answers', () => {
  const nodeAnswer = {
    [HEADER_REQUEST_ID]: 'req_7',
    [HEADER_ROUTED_MODEL]: 'node/triage@v3',
    'x-caliban-cache': 'bypass',
    [HEADER_PII_ENTITIES]: '2',
    [HEADER_COST_USD]: '0.0011',
    [HEADER_BILLED_USD]: '0.004',
    [HEADER_ROUTE]: 'node/triage@v3',
    [HEADER_RUN_ID]: 'run_9',
    [HEADER_RUN_STATUS]: 'succeeded',
  };

  it('reads the request id, routed model, PII count, real and billed cost, route and run', () => {
    expect(meta(nodeAnswer)).toMatchObject({
      requestId: 'req_7',
      routedModel: 'node/triage@v3',
      cache: 'bypass',
      piiEntities: 2,
      costUsd: 0.0011,
      billedUsd: 0.004,
      route: 'node/triage@v3',
      runId: 'run_9',
      runStatus: 'succeeded',
    });
  });

  it('reports a caliban/auto fallback to a model', () => {
    const m = meta({ [HEADER_ROUTE]: 'model:local/qwen3-8b', [HEADER_ROUTE_FALLBACK]: 'low_confidence' });
    expect([m.route, m.routeFallback, m.runId]).toEqual(['model:local/qwen3-8b', 'low_confidence', undefined]);
  });

  it('leaves the node fields out when absent, blank or malformed', () => {
    const m = meta({ [HEADER_BILLED_USD]: 'free', [HEADER_ROUTE]: '  ', [HEADER_RUN_ID]: '' });
    for (const k of ['billedUsd', 'route', 'routeFallback', 'runId', 'runStatus']) expect(k in m).toBe(false);
    expect(meta({ [HEADER_BILLED_USD]: '-1' }).billedUsd).toBeUndefined();
  });

  it('is exposed on a chat completion a node answered', async () => {
    const m = mockFetch(json(completion, { headers: nodeAnswer }));
    const res = await client(m.fetch).chat.completions.create({ model: 'node/triage', messages: msgs });
    expect(res.meta).toMatchObject({ requestId: 'req_7', routedModel: 'node/triage@v3', piiEntities: 2, costUsd: 0.0011, runId: 'run_9' });
    expect(JSON.parse(JSON.stringify(res))).toEqual(completion);
  });
});

describe('/v1/messages responses', () => {
  it('reads the billing, route and run headers of an Anthropic Messages response', () => {
    const m = meta({
      [HEADER_REQUEST_ID]: 'req_m1',
      [HEADER_COST_USD]: '0.0021',
      [HEADER_BILLED_USD]: '0.01',
      [HEADER_ROUTE]: 'node/triage@v3',
      [HEADER_RUN_ID]: 'run_m1',
      [HEADER_RUN_STATUS]: 'succeeded',
      'content-type': 'application/json',
    });
    expect([m.requestId, m.costUsd, m.billedUsd, m.route, m.runId, m.runStatus]).toEqual([
      'req_m1',
      0.0021,
      0.01,
      'node/triage@v3',
      'run_m1',
      'succeeded',
    ]);
  });
});

describe('Server-Timing', () => {
  const value =
    'auth;dur=0.210, route;dur=4.810;desc="knn", embed;dur=4.020, pii;dur=1.130, cache;dur=0.040;desc="miss", upstream;dur=182.400, upstream_total;dur=611.900, total;dur=618.700';

  it('parses every stage in order, with its duration and description', () => {
    const t = parseServerTiming(value);
    expect(t?.map((e) => e.name)).toEqual(['auth', 'route', 'embed', 'pii', 'cache', 'upstream', 'upstream_total', 'total']);
    expect(t?.[1]).toEqual({ name: 'route', dur: 4.81, desc: 'knn' });
    expect(t?.[4]).toEqual({ name: 'cache', dur: 0.04, desc: 'miss' });
    expect(t?.at(-1)).toEqual({ name: 'total', dur: 618.7 });
  });

  it('keeps a node stage without a duration (streams) and quoted separators in desc', () => {
    expect(parseServerTiming('node;desc="run_1", total;dur=3')).toEqual([
      { name: 'node', desc: 'run_1' },
      { name: 'total', dur: 3 },
    ]);
    expect(parseServerTiming('x;desc="a, b; c"')).toEqual([{ name: 'x', desc: 'a, b; c' }]);
  });

  it('skips nameless entries and bad durations, and never throws', () => {
    expect(parseServerTiming(undefined)).toBeUndefined();
    expect(parseServerTiming('  ')).toBeUndefined();
    expect(parseServerTiming(', ;dur=1')).toBeUndefined();
    expect(parseServerTiming('auth;dur=abc, pii;dur=-1')).toEqual([{ name: 'auth' }, { name: 'pii' }]);
  });

  it('is on response meta when the gateway sends it, and absent otherwise', async () => {
    expect(meta({ [HEADER_SERVER_TIMING]: 'auth;dur=1, total;dur=2' }).serverTiming).toEqual([
      { name: 'auth', dur: 1 },
      { name: 'total', dur: 2 },
    ]);
    expect(meta({}).serverTiming).toBeUndefined();
    const m = mockFetch(json(completion, { headers: { 'server-timing': value } }));
    const res = await client(m.fetch).chat.completions.create({ model: 'caliban/auto', messages: msgs });
    expect(res.meta.serverTiming?.find((e) => e.name === 'upstream')?.dur).toBe(182.4);
  });
});
