import { describe, expect, it } from 'vitest';
import {
  CalibanClient,
  HEADER_CACHE_TIER,
  HEADER_INTENT,
  parseCacheTier,
  parseIntentHeader,
  parseResponseMeta,
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
