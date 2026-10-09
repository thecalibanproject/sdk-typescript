import type { components } from './generated/schema.js';

/** The OpenAPI `Error` response body: `{ "error": { "message", "type", "code" } }`. */
export type ErrorBody = components['schemas']['Error'];
export type ErrorObject = ErrorBody['error'];

/**
 * Well-known error `type` values. Server-side types come from the contract
 * (`invalid_request_error`, `authentication_error`, `policy_violation`, `upstream_error`,
 * `rate_limited`, ...); the client-side ones (`connection_error`, `timeout`, `aborted`,
 * `stream_error`, `configuration_error`) are produced by this SDK.
 */
export type CalibanErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'policy_violation'
  | 'rate_limited'
  | 'upstream_error'
  | 'api_error'
  | 'connection_error'
  | 'timeout'
  | 'aborted'
  | 'stream_error'
  | 'configuration_error'
  | (string & {});

export interface CalibanErrorInit {
  message: string;
  type: CalibanErrorType;
  code?: string | null;
  status?: number;
  requestId?: string | null;
  headers?: Headers;
  body?: unknown;
  cause?: unknown;
}

const BRAND = Symbol.for('caliban.sdk.error');

/**
 * Base class for every error thrown by the SDK.
 *
 * `status`, `type` and `code` mirror the OpenAPI `Error` shape. `status` is `undefined`
 * for errors that never got an HTTP response (connection failures, aborts, timeouts).
 */
export class CalibanError extends Error {
  readonly status: number | undefined;
  readonly type: CalibanErrorType;
  readonly code: string | null;
  /** Value of `x-caliban-request-id`, when the gateway sent one. Quote it in bug reports. */
  readonly requestId: string | null;
  readonly headers: Headers | undefined;
  /** Parsed response body (JSON when possible, raw text otherwise). */
  readonly body: unknown;
  /** The `error` object exactly as the contract defines it. */
  readonly error: ErrorObject;

  constructor(init: CalibanErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'CalibanError';
    this.status = init.status;
    this.type = init.type;
    this.code = init.code ?? null;
    this.requestId = init.requestId ?? null;
    this.headers = init.headers;
    this.body = init.body;
    this.error = { message: init.message, type: init.type, code: this.code };
    Object.defineProperty(this, BRAND, { value: true });
  }
}

/** The gateway answered with a non-2xx status. */
export class CalibanAPIError extends CalibanError {
  declare readonly status: number;
  constructor(init: CalibanErrorInit & { status: number }) {
    super(init);
    this.name = 'CalibanAPIError';
  }
  override toString(): string {
    return `${this.name}: ${this.status} ${this.type}${this.code ? ` (${this.code})` : ''}: ${this.message}`;
  }
}

/** Network failure before a response was received. */
export class CalibanConnectionError extends CalibanError {
  constructor(init: Omit<CalibanErrorInit, 'type'> & { type?: CalibanErrorType }) {
    super({ ...init, type: init.type ?? 'connection_error' });
    this.name = 'CalibanConnectionError';
  }
}

/** The request exceeded `timeoutMs`. */
export class CalibanTimeoutError extends CalibanConnectionError {
  constructor(init: Omit<CalibanErrorInit, 'type'>) {
    super({ ...init, type: 'timeout' });
    this.name = 'CalibanTimeoutError';
  }
}

/** The caller aborted the request via its `AbortSignal` (or `stream.abort()`). */
export class CalibanAbortError extends CalibanError {
  constructor(init: Omit<CalibanErrorInit, 'type'>) {
    super({ ...init, type: 'aborted' });
    this.name = 'CalibanAbortError';
  }
}

/**
 * A stream that had already started failed: the gateway sent an error event, a chunk
 * could not be parsed, or the connection dropped mid-stream. Never retried.
 */
export class CalibanStreamError extends CalibanError {
  constructor(init: Omit<CalibanErrorInit, 'type'> & { type?: CalibanErrorType }) {
    super({ ...init, type: init.type ?? 'stream_error' });
    this.name = 'CalibanStreamError';
  }
}

/** Works across duplicated copies of the SDK (e.g. ESM + CJS in one process). */
export function isCalibanError(value: unknown): value is CalibanError {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}

export function defaultErrorType(status: number): CalibanErrorType {
  switch (status) {
    case 400:
    case 422:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 429:
      return 'rate_limited';
    case 502:
    case 503:
    case 504:
      return 'upstream_error';
    default:
      return 'api_error';
  }
}

function isErrorBody(value: unknown): value is { error: { message?: unknown; type?: unknown; code?: unknown } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'object' &&
    (value as { error?: unknown }).error !== null
  );
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Build a typed error from an already-parsed error body (JSON object or raw text). */
export function errorFromBody(status: number, body: unknown, headers?: Headers, statusText = ''): CalibanAPIError {
  let message: string | undefined;
  let type: CalibanErrorType | undefined;
  let code: string | null = null;
  if (isErrorBody(body)) {
    const e = body.error;
    if (typeof e.message === 'string') message = e.message;
    if (typeof e.type === 'string') type = e.type;
    if (typeof e.code === 'string') code = e.code;
  } else if (typeof body === 'string' && body.trim() !== '') {
    message = truncate(body.trim());
  }
  return new CalibanAPIError({
    status,
    type: type ?? defaultErrorType(status),
    code,
    message: message ?? (`HTTP ${status} ${statusText}`.trim()),
    requestId: headers?.get('x-caliban-request-id') ?? null,
    ...(headers ? { headers } : {}),
    body,
  });
}

/** Read a non-2xx `Response` and map it to a {@link CalibanAPIError}. Consumes the body. */
export async function errorFromResponse(response: Response): Promise<CalibanAPIError> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    // body unreadable; fall back to status text
  }
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
  }
  return errorFromBody(response.status, body, response.headers, response.statusText);
}
