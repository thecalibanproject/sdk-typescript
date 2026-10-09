/**
 * Retry policy. Retries apply only to the *request phase*: once a 2xx response has been
 * returned (in particular once a stream has started) nothing is ever retried.
 */
export interface RetryOptions {
  /** Retries after the first attempt. Default 2 (so up to 3 attempts). */
  maxRetries?: number;
  /** First backoff delay. Default 500 ms. */
  initialDelayMs?: number;
  /** Upper bound for a computed backoff delay. Default 8000 ms. */
  maxDelayMs?: number;
  /** Exponential factor. Default 2. */
  backoffMultiplier?: number;
  /** Randomly shave up to 25% off each delay to avoid thundering herds. Default true. */
  jitter?: boolean;
  /** HTTP statuses that trigger a retry. Default [429, 502, 503]. */
  retryOnStatus?: readonly number[];
  /**
   * Also retry when the request fails before any response (DNS, reset, timeout).
   * Default false: chat completions are not idempotent and may have been billed upstream.
   */
  retryOnNetworkError?: boolean;
  /** Honour `retry-after-ms` / `retry-after` headers (capped at 60 s). Default true. */
  respectRetryAfter?: boolean;
}

export type RetryPolicy = Required<RetryOptions>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  backoffMultiplier: 2,
  jitter: true,
  retryOnStatus: Object.freeze([429, 502, 503]),
  retryOnNetworkError: false,
  respectRetryAfter: true,
});

/** Server-provided waits longer than this are ignored in favour of computed backoff. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** `false` disables retries; an object overrides individual fields of `base`. */
export function resolveRetryPolicy(
  options: RetryOptions | false | undefined,
  base: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryPolicy {
  if (options === false) return { ...base, maxRetries: 0 };
  if (!options) return base;
  const merged: RetryPolicy = { ...base };
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  merged.maxRetries = Math.max(0, Math.floor(merged.maxRetries));
  return merged;
}

/** Parse `retry-after-ms`, then `retry-after` (seconds or HTTP-date). Returns ms or undefined. */
export function parseRetryAfter(headers: Headers | undefined, now: number = Date.now()): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '') {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const ra = headers.get('retry-after');
  if (ra === null || ra.trim() === '') return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : undefined;
  const date = Date.parse(ra);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * Delay before retry number `retryIndex` (0 = first retry).
 * `random` is injectable for deterministic tests.
 */
export function computeRetryDelay(
  policy: RetryPolicy,
  retryIndex: number,
  headers?: Headers,
  random: () => number = Math.random,
): number {
  if (policy.respectRetryAfter) {
    const ra = parseRetryAfter(headers);
    if (ra !== undefined && ra <= MAX_RETRY_AFTER_MS) return ra;
  }
  const exp = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.backoffMultiplier ** retryIndex);
  return policy.jitter ? Math.round(exp * (1 - 0.25 * random())) : exp;
}

export function shouldRetryStatus(policy: RetryPolicy, status: number): boolean {
  return policy.retryOnStatus.includes(status);
}
