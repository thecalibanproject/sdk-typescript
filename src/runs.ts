import type { CalibanClient } from './client.js';
import { CalibanError, CalibanStreamError } from './errors.js';
import type { RequestLifetime } from './internal/http.js';
import { HEADER_RUN_ID, parseResponseMeta } from './meta.js';
import { iterSSEEvents } from './sse.js';
import type {
  CalibanResponseMeta,
  NodeRun,
  NodeRunList,
  RequestOptions,
  RunCreateParams,
  RunCreateParamsNonStreaming,
  RunCreateParamsStreaming,
  RunEvent,
  RunEventsOptions,
  RunInputParams,
  RunListQuery,
  WithMeta,
} from './types.js';

export { HEADER_RUN_ID };

/** Event types after which a run's event stream ends. */
const TERMINAL_EVENTS: ReadonlySet<string> = new Set(['run.finished', 'run.input_required']);

/**
 * A run's event stream (`text/event-stream`, one {@link RunEvent} per SSE event). Iterate it
 * once with `for await`. The server ends it after `run.finished`, or after `run.input_required`
 * while the run waits for that answer; that last event carries the run in `run`.
 *
 * To resume after a dropped connection, call `runs.events(runId, { after: stream.lastEventId })`.
 * Errors after this object exists are never retried.
 */
export class RunEventStream implements AsyncIterable<RunEvent> {
  readonly meta: CalibanResponseMeta;
  /** The run's id from the `Caliban-Run-Id` header (`null` if the server did not send it). */
  readonly runId: string | null;
  /** True when an `Idempotency-Key` replay returned the run an earlier request created. */
  readonly replayed: boolean;
  /** Number of the last event received so far (`0` before the first). */
  lastEventId = 0;
  /** The run carried by the last event, once the stream has delivered it. */
  run: NodeRun | undefined;
  private consumed = false;

  constructor(
    readonly response: Response,
    private readonly lifetime: RequestLifetime,
  ) {
    this.meta = parseResponseMeta(response);
    this.runId = response.headers.get(HEADER_RUN_ID);
    this.replayed = response.headers.get('idempotent-replayed') === 'true';
  }

  /** Abort the underlying HTTP request. A pending iteration rejects with CalibanAbortError. */
  abort(reason?: unknown): void {
    this.lifetime.controller.abort(reason);
  }

  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    if (this.consumed) {
      throw new CalibanError({ type: 'stream_error', message: 'A RunEventStream can only be iterated once.' });
    }
    this.consumed = true;
    const requestId = this.meta.requestId;
    try {
      const body = this.response.body ?? bufferedBody(await this.response.text());
      for await (const sse of iterSSEEvents(body)) {
        const raw = sse.data.trim();
        if (raw === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (cause) {
          throw new CalibanStreamError({ message: `Malformed run event: ${raw.slice(0, 200)}`, requestId, body: raw, cause });
        }
        if (sse.event === 'error' || (isObject(parsed) && parsed.type === 'error')) {
          throw runStreamError(parsed, raw, requestId);
        }
        const event = parsed as RunEvent;
        if (typeof event.id === 'number') this.lastEventId = event.id;
        if (isObject(event.run)) this.run = event.run;
        yield event;
        if (TERMINAL_EVENTS.has(event.type)) return;
      }
    } catch (err) {
      if (err instanceof CalibanError) throw err;
      const mapped = this.lifetime.classify(err);
      if (mapped.type === 'connection_error') {
        throw new CalibanStreamError({ message: `Stream interrupted: ${mapped.message}`, requestId, cause: err });
      }
      throw mapped;
    } finally {
      this.lifetime.dispose();
    }
  }

  /**
   * Consume the stream and return the run its last event carries (`run.finished`, or
   * `run.input_required` while the run waits), or `undefined` if the stream ended without one.
   */
  async finalRun(): Promise<NodeRun | undefined> {
    for await (const _ of this) {
      // drain
    }
    return this.run;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bufferedBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

/** The server ends a stream it cannot continue with `event: error`, `{"type":"error","data":{"message"}}`. */
function runStreamError(payload: unknown, raw: string, requestId: string | null): CalibanStreamError {
  const data = isObject(payload) && isObject(payload.data) ? payload.data : {};
  const nested = isObject(payload) && isObject(payload.error) ? payload.error : {};
  const message = [data.message, nested.message].find((m): m is string => typeof m === 'string');
  return new CalibanStreamError({ message: message ?? (raw || 'Stream error'), requestId, body: payload });
}

function segment(value: string, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CalibanError({ type: 'invalid_request_error', code: `invalid_${what}`, message: `${what} must be a non-empty string` });
  }
  return encodeURIComponent(value);
}

function queryString(query: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const MAX_UNTRUSTED_POINTERS = 64;

/**
 * Check an `untrusted` value (run requests, and `caliban.untrusted` on chat requests): a boolean,
 * or at most 64 JSON pointers (`''` or strings starting with `/`). Throws before anything is sent.
 */
export function validateUntrusted(value: unknown, field = 'untrusted'): void {
  if (value === undefined || typeof value === 'boolean') return;
  const fail = (message: string) =>
    new CalibanError({ type: 'invalid_request_error', code: 'invalid_untrusted', message: `${field} ${message}` });
  if (!Array.isArray(value)) throw fail('must be a boolean or an array of JSON pointers');
  if (value.length > MAX_UNTRUSTED_POINTERS) throw fail(`takes at most ${MAX_UNTRUSTED_POINTERS} JSON pointers (got ${value.length})`);
  for (const ptr of value) {
    if (typeof ptr !== 'string' || (ptr !== '' && !ptr.startsWith('/'))) {
      throw fail(`entries must be JSON pointers ('' or starting with '/'), got ${JSON.stringify(ptr)}`);
    }
  }
}

/** Build the JSON body for a run request (exported for tests and advanced use). */
export function buildRunBody(params: RunCreateParams, extraBody?: Record<string, unknown>): Record<string, unknown> {
  validateUntrusted(params.untrusted);
  const body: Record<string, unknown> = { ...params, ...extraBody };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  return body;
}

/**
 * Node runs on the data plane (`/v1/nodes/{name}/runs`, `/v1/runs`). The API key must be
 * allowed to run the node.
 */
export class Runs {
  constructor(private readonly client: CalibanClient) {}

  /**
   * `POST /v1/nodes/{nodeName}/runs`: run the node's live version (or `version`).
   * Sync by default: resolves when the run ends or waits for a human, or after the server's wait
   * (`wait_s`) with the run so far; check `status`. `async: true` resolves at once with the
   * pending run. `stream: true` resolves to a {@link RunEventStream} once headers arrive.
   *
   * Pass `idempotencyKey` to make a retry return the run the first request created. Mark untrusted
   * caller data with `untrusted` (`true`, or JSON pointers such as `['/email/body']`): it carries
   * the `caller` taint label (see the run's `input_labels`), so a write it reaches needs an
   * `allow_tainted` entry or a human approval.
   */
  create(nodeName: string, params: RunCreateParamsNonStreaming, options?: RequestOptions): Promise<WithMeta<NodeRun>>;
  create(nodeName: string, params: RunCreateParamsStreaming, options?: RequestOptions): Promise<RunEventStream>;
  create(nodeName: string, params: RunCreateParams, options?: RequestOptions): Promise<WithMeta<NodeRun> | RunEventStream>;
  async create(
    nodeName: string,
    params: RunCreateParams,
    options: RequestOptions = {},
  ): Promise<WithMeta<NodeRun> | RunEventStream> {
    const path = `/nodes/${segment(nodeName, 'node_name')}/runs`;
    const streaming = params.stream === true;
    const { response, lifetime } = await this.client._send(path, {
      method: 'POST',
      body: JSON.stringify(buildRunBody(params, options.extraBody)),
      accept: streaming ? 'text/event-stream' : 'application/json',
      options,
    });
    if (streaming) {
      lifetime.clearTimeout(); // stream started: the timeout only guarded time-to-headers
      return new RunEventStream(response, lifetime);
    }
    return this.client._readJSON<NodeRun>(response, lifetime);
  }

  /** `GET /v1/runs/{runId}`: status, output, the awaited question, budget, usage and steps. */
  async get(runId: string, options: RequestOptions = {}): Promise<WithMeta<NodeRun>> {
    const { response, lifetime } = await this.client._send(`/runs/${segment(runId, 'run_id')}`, {
      method: 'GET',
      accept: 'application/json',
      options,
    });
    return this.client._readJSON<NodeRun>(response, lifetime);
  }

  /** `GET /v1/runs`: one page of run summaries, newest first. Pass `next_cursor` as `cursor` for the next. */
  async list(query: RunListQuery = {}, options: RequestOptions = {}): Promise<WithMeta<NodeRunList>> {
    const { response, lifetime } = await this.client._send(`/runs${queryString(query)}`, {
      method: 'GET',
      accept: 'application/json',
      options,
    });
    return this.client._readJSON<NodeRunList>(response, lifetime);
  }

  /**
   * `GET /v1/runs/{runId}/events`: follow a run's events (SSE) from the journal. `after` resumes
   * after that event number (e.g. a previous stream's `lastEventId`). Resolves once headers arrive.
   */
  async events(runId: string, options: RunEventsOptions = {}): Promise<RunEventStream> {
    const { after, ...rest } = options;
    if (after !== undefined && !(Number.isInteger(after) && after >= 0)) {
      throw new CalibanError({
        type: 'invalid_request_error',
        code: 'invalid_after',
        message: `after must be an integer >= 0 (got ${String(after)})`,
      });
    }
    const { response, lifetime } = await this.client._send(
      `/runs/${segment(runId, 'run_id')}/events${queryString({ after })}`,
      { method: 'GET', accept: 'text/event-stream', options: rest },
    );
    lifetime.clearTimeout();
    return new RunEventStream(response, lifetime);
  }

  /**
   * `POST /v1/runs/{runId}/input`: answer the human step the run waits for (`step` defaults to
   * `awaiting.step`) and resume it. For a `<step>@approve` step answer `{ approve: true }` or
   * `{ approve: false }`. Throws a 409 `CalibanAPIError` (`run_not_awaiting_input`) if the run
   * does not wait for that step.
   */
  async input(runId: string, params: RunInputParams, options: RequestOptions = {}): Promise<WithMeta<NodeRun>> {
    const { response, lifetime } = await this.client._send(`/runs/${segment(runId, 'run_id')}/input`, {
      method: 'POST',
      body: JSON.stringify({ ...params, ...options.extraBody }),
      accept: 'application/json',
      options,
    });
    return this.client._readJSON<NodeRun>(response, lifetime);
  }

  /**
   * `POST /v1/runs/{runId}/cancel`: a waiting run is cancelled at once; a running one stops at its
   * next step boundary (`cancel_requested: true`). Throws a 409 `CalibanAPIError`
   * (`run_already_ended`) if the run ended otherwise.
   */
  async cancel(runId: string, options: RequestOptions = {}): Promise<WithMeta<NodeRun>> {
    const { response, lifetime } = await this.client._send(`/runs/${segment(runId, 'run_id')}/cancel`, {
      method: 'POST',
      accept: 'application/json',
      options,
    });
    return this.client._readJSON<NodeRun>(response, lifetime);
  }
}
