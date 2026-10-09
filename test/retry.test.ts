import { describe, expect, it } from 'vitest';
import { computeRetryDelay, DEFAULT_RETRY_POLICY, parseRetryAfter, resolveRetryPolicy } from '../src/retry.js';

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
});
