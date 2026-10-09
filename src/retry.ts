/**
 * Retry policy. Retries apply only to the *request phase*: once a 2xx response has been
 * returned (in particular once a stream has started) nothing is ever retried.
 *
 * A POST without an `Idempotency-Key` header is not idempotent: the gateway may already
 * have run (and billed) it upstream. With the default `retryOnStatus` such a request is
 * retried only on 429 and 503 (never 500, 502 or 504), and a network error is retried
 * only when the request provably never left the client (a connect failure).
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
  /**
   * HTTP statuses that trigger a retry. Default [429, 502, 503] for idempotent requests
   * (GET, HEAD, OPTIONS, PUT, DELETE, or any request with an `Idempotency-Key` header) and
   * [429, 503] for other POSTs. Setting it applies your list to every request as-is.
   */
  retryOnStatus?: readonly number[];
  /**
   * Also retry when the request fails before any response (DNS, refused, reset, timeout).
   * Default false. For a POST without an `Idempotency-Key` only connect failures (the
   * request was never sent) are retried, since a chat completion may have been billed upstream.
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

/**
 * Statuses retried for a non-idempotent request when `retryOnStatus` is left at its default.
 * 500, 502 and 504 are excluded: the upstream may already have executed the request.
 */
export const NON_IDEMPOTENT_RETRY_STATUSES: readonly number[] = Object.freeze([429, 503]);

const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** Header that marks a POST as safe to retry. The gateway does not deduplicate on it yet. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * True for idempotent methods, and for any request carrying an `Idempotency-Key` header
 * (matched case-insensitively).
 */
export function isIdempotentRequest(method: string, headers?: Headers | Record<string, string>): boolean {
  if (IDEMPOTENT_METHODS.has(method.toUpperCase())) return true;
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has(IDEMPOTENCY_KEY_HEADER);
  return Object.keys(headers).some((k) => k.toLowerCase() === IDEMPOTENCY_KEY_HEADER);
}

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

/**
 * Whether `status` should be retried. A non-idempotent request uses
 * {@link NON_IDEMPOTENT_RETRY_STATUSES} unless the caller set `retryOnStatus` explicitly
 * (an explicit list never shares identity with the frozen default array).
 */
export function shouldRetryStatus(policy: RetryPolicy, status: number, idempotent = true): boolean {
  const statuses =
    !idempotent && policy.retryOnStatus === DEFAULT_RETRY_POLICY.retryOnStatus
      ? NON_IDEMPOTENT_RETRY_STATUSES
      : policy.retryOnStatus;
  return statuses.includes(status);
}
