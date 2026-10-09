import { describe, expect, it } from 'vitest';
import { isConnectFailure } from '../src/internal/http.js';
import {
  computeRetryDelay,
  DEFAULT_RETRY_POLICY,
  isIdempotentRequest,
  parseRetryAfter,
  resolveRetryPolicy,
  shouldRetryStatus,
} from '../src/retry.js';

const noJitter = resolveRetryPolicy({ jitter: false });

describe('retry policy helpers', () => {
  it('defaults to 2 retries on 429/502/503 without network retries', () => {
    expect(DEFAULT_RETRY_POLICY).toMatchObject({ maxRetries: 2, retryOnStatus: [429, 502, 503], retryOnNetworkError: false });
    expect(resolveRetryPolicy(false).maxRetries).toBe(0);
    expect(resolveRetryPolicy({ maxRetries: undefined }).maxRetries).toBe(2);
  });

  it('backs off exponentially and caps at maxDelayMs', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => computeRetryDelay(noJitter, i))).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
  });

  it('jitter only ever shortens the delay, by at most 25%', () => {
    const p = resolveRetryPolicy({});
    expect(computeRetryDelay(p, 1, undefined, () => 0)).toBe(1000);
    expect(computeRetryDelay(p, 1, undefined, () => 1)).toBe(750);
  });

  it('honours retry-after-ms, retry-after seconds and HTTP dates', () => {
    expect(computeRetryDelay(noJitter, 0, new Headers({ 'retry-after-ms': '1234' }))).toBe(1234);
    expect(computeRetryDelay(noJitter, 0, new Headers({ 'retry-after': '3' }))).toBe(3000);
    const now = Date.parse('2026-10-02T00:00:00Z');
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Fri, 02 Oct 2026 00:00:05 GMT' }), now)).toBe(5000);
  });

  it('ignores retry-after beyond 60 s, garbage, or when disabled', () => {
    expect(computeRetryDelay(noJitter, 0, new Headers({ 'retry-after': '120' }))).toBe(500);
    expect(computeRetryDelay(noJitter, 0, new Headers({ 'retry-after': 'soon' }))).toBe(500);
    const p = resolveRetryPolicy({ jitter: false, respectRetryAfter: false });
    expect(computeRetryDelay(p, 0, new Headers({ 'retry-after': '3' }))).toBe(500);
  });

  it('classifies idempotent requests by method or Idempotency-Key header', () => {
    for (const m of ['GET', 'head', 'OPTIONS', 'PUT', 'DELETE']) expect(isIdempotentRequest(m)).toBe(true);
    expect(isIdempotentRequest('POST')).toBe(false);
    expect(isIdempotentRequest('POST', { 'Idempotency-Key': 'k' })).toBe(true);
    expect(isIdempotentRequest('POST', new Headers({ 'idempotency-key': 'k' }))).toBe(true);
    expect(isIdempotentRequest('POST', { 'x-other': 'k' })).toBe(false);
  });

  it('drops 502 for non-idempotent requests only while retryOnStatus is the default', () => {
    expect([429, 502, 503].map((s) => shouldRetryStatus(DEFAULT_RETRY_POLICY, s, true))).toEqual([true, true, true]);
    expect([429, 500, 502, 503, 504].map((s) => shouldRetryStatus(DEFAULT_RETRY_POLICY, s, false))).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
    // A policy merged from defaults keeps the default list; an explicit list is used as-is.
    expect(shouldRetryStatus(resolveRetryPolicy({ maxRetries: 5 }), 502, false)).toBe(false);
    expect(shouldRetryStatus(resolveRetryPolicy({ retryOnStatus: [429, 502, 503] }), 502, false)).toBe(true);
  });

  it('recognises connect failures, but not resets after sending', () => {
    const wrap = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    expect(isConnectFailure(wrap('ECONNREFUSED'))).toBe(true);
    expect(isConnectFailure(wrap('ENOTFOUND'))).toBe(true);
    expect(isConnectFailure(wrap('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
    expect(isConnectFailure(wrap('UND_ERR_SOCKET'))).toBe(false);
    expect(isConnectFailure(wrap('ECONNRESET'))).toBe(false);
    expect(isConnectFailure(new TypeError('Failed to fetch'))).toBe(false); // browsers: no cause
  });
});
