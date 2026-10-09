import {
  CalibanAbortError,
  CalibanConnectionError,
  CalibanError,
  CalibanTimeoutError,
  errorFromResponse,
} from '../errors.js';
import { computeRetryDelay, shouldRetryStatus, type RetryPolicy } from '../retry.js';

/**
 * Owns the AbortController for one attempt: links the caller's signal and an optional
 * timeout. For streams the timeout is cleared as soon as headers arrive, but the caller's
 * signal stays linked until the stream is disposed.
 */
export class RequestLifetime {
  readonly controller = new AbortController();
  timedOut = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unlink: (() => void) | undefined;

  constructor(
    readonly userSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ) {
    if (userSignal) {
      if (userSignal.aborted) {
        this.controller.abort(userSignal.reason);
      } else {
        const onAbort = () => this.controller.abort(userSignal.reason);
        userSignal.addEventListener('abort', onAbort, { once: true });
        this.unlink = () => userSignal.removeEventListener('abort', onAbort);
      }
    }
    if (timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort(new CalibanTimeoutError({ message: `Request timed out after ${timeoutMs} ms` }));
      }, timeoutMs);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  clearTimeout(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.clearTimeout();
    this.unlink?.();
    this.unlink = undefined;
  }

  /** Map a failure (fetch rejection or body read error) to an SDK error. */
  classify(err: unknown): CalibanError {
    if (err instanceof CalibanError) return err;
    if (this.timedOut) {
      return new CalibanTimeoutError({ message: 'Request timed out', cause: err });
    }
    if (this.controller.signal.aborted) {
      return new CalibanAbortError({ message: 'Request was aborted', cause: this.controller.signal.reason ?? err });
    }
    const message = err instanceof Error ? err.message : String(err);
    return new CalibanConnectionError({ message: `Connection error: ${message}`, cause: err });
  }
}

export interface SendOptions {
  retry: RetryPolicy;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Throw a CalibanAPIError for non-2xx (default). When false, the final response is returned as-is. */
  throwOnHttpError?: boolean;
  /** Injectable sleep for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SendResult {
  response: Response;
  lifetime: RequestLifetime;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CalibanAbortError({ message: 'Request was aborted', cause: signal.reason }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CalibanAbortError({ message: 'Request was aborted', cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Run `attempt` with retry/backoff. `attempt` receives the per-attempt AbortSignal and must
 * return a fresh `Response` each time (request bodies are re-sent).
 *
 * On success the caller owns `lifetime` and must call `dispose()` when done reading.
 */
export async function sendWithRetry(
  attempt: (signal: AbortSignal) => Promise<Response>,
  opts: SendOptions,
): Promise<SendResult> {
  const sleep = opts.sleep ?? abortableSleep;
  const { retry } = opts;
  for (let i = 0; ; i++) {
    if (opts.signal?.aborted) {
      throw new CalibanAbortError({ message: 'Request was aborted', cause: opts.signal.reason });
    }
    const lifetime = new RequestLifetime(opts.signal, opts.timeoutMs);
    let response: Response;
    try {
      response = await attempt(lifetime.signal);
    } catch (err) {
      lifetime.dispose();
      const mapped = lifetime.classify(err);
      const networkish = mapped instanceof CalibanConnectionError; // includes timeouts
      if (networkish && retry.retryOnNetworkError && i < retry.maxRetries) {
        await sleep(computeRetryDelay(retry, i), opts.signal);
        continue;
      }
      throw mapped;
    }

    if (response.ok) return { response, lifetime };

    if (shouldRetryStatus(retry, response.status) && i < retry.maxRetries) {
      const delay = computeRetryDelay(retry, i, response.headers);
      discardBody(response);
      lifetime.dispose();
      await sleep(delay, opts.signal);
      continue;
    }

    if (opts.throwOnHttpError === false) return { response, lifetime };
    try {
      throw await errorFromResponse(response);
    } finally {
      lifetime.dispose();
    }
  }
}

/**
 * Wrap a fetch implementation with retry/backoff/timeout. Used for the admin client, where
 * `openapi-fetch` parses the final response itself (so HTTP errors are returned, not thrown).
 */
export function createRetryingFetch(
  baseFetch: typeof fetch,
  retry: RetryPolicy,
  timeoutMs: number | undefined,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { response, lifetime } = await sendWithRetry((signal) => baseFetch(new Request(request.clone(), { signal })), {
      retry,
      timeoutMs,
      signal: request.signal,
      throwOnHttpError: false,
    });
    // openapi-fetch reads the full body immediately; read it here so the timeout covers it.
    try {
      const body = response.status === 204 || response.status === 304 ? null : await response.arrayBuffer();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (err) {
      throw lifetime.classify(err);
    } finally {
      lifetime.dispose();
    }
  }) as typeof fetch;
}
