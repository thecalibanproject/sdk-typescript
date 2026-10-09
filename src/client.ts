import { CalibanError } from './errors.js';
import { readEnv, resolveFetch, trimTrailingSlash } from './internal/env.js';
import { sendWithRetry } from './internal/http.js';
import { attachMeta, parseResponseMeta } from './meta.js';
import { IDEMPOTENCY_KEY_HEADER, isIdempotentRequest, resolveRetryPolicy, type RetryOptions, type RetryPolicy } from './retry.js';
import { ChatCompletionStream } from './streaming.js';
import type {
  CalibanExtension,
  ChatCompletion,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
  ModelList,
  ReasoningEffort,
  RequestOptions,
  RerankCreateParams,
  RerankResponse,
  WithMeta,
} from './types.js';

const REASONING_EFFORTS: ReadonlySet<string> = new Set<ReasoningEffort>(['off', 'low', 'medium', 'high']);

export const DEFAULT_DATA_PLANE_URL = 'http://localhost:8080/v1';
export const DEFAULT_TIMEOUT_MS = 600_000;

export interface CalibanClientOptions {
  /** Tenant API key (`cal_…`). Defaults to `CALIBAN_API_KEY` when `process.env` exists. */
  apiKey?: string;
  /**
   * Data-plane base URL **including** `/v1`, like the OpenAI SDK's `baseURL`.
   * Defaults to `CALIBAN_BASE_URL` or `http://localhost:8080/v1`.
   */
  baseURL?: string;
  /** Custom fetch (e.g. for proxies or tests). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /**
   * Retry policy; `false` disables retries. Default: 2 retries on 429/502/503 for GET, and on
   * 429/503 only for POST without an `Idempotency-Key` (see `RetryOptions.retryOnStatus`).
   */
  retry?: RetryOptions | false;
  /** Per-attempt timeout. For streams, covers time-to-headers only. Default 600 000 ms. */
  timeoutMs?: number;
  /** Headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /** Extension fields applied to every chat request (request-level `caliban` keys win). */
  defaultCaliban?: CalibanExtension;
}

/** Merge client defaults and request-level extension; drop `undefined`; `undefined` if empty. */
export function mergeCalibanExtension(
  defaults: CalibanExtension | undefined,
  request: CalibanExtension | undefined,
): CalibanExtension | undefined {
  const merged: Record<string, unknown> = {};
  for (const src of [defaults, request]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) if (v !== undefined) merged[k] = v;
  }
  return Object.keys(merged).length > 0 ? (merged as CalibanExtension) : undefined;
}

function validateExtension(ext: CalibanExtension): void {
  if (ext.max_cost_usd !== undefined && !(Number.isFinite(ext.max_cost_usd) && ext.max_cost_usd >= 0)) {
    throw new CalibanError({
      type: 'invalid_request_error',
      code: 'invalid_max_cost_usd',
      message: `caliban.max_cost_usd must be a finite number >= 0 (got ${String(ext.max_cost_usd)})`,
    });
  }
  if (ext.reasoning !== undefined && !REASONING_EFFORTS.has(ext.reasoning)) {
    throw new CalibanError({
      type: 'invalid_request_error',
      code: 'invalid_reasoning',
      message: `caliban.reasoning must be one of off, low, medium, high (got ${String(ext.reasoning)})`,
    });
  }
  if (ext.datasources !== undefined && !Array.isArray(ext.datasources)) {
    throw new CalibanError({
      type: 'invalid_request_error',
      code: 'invalid_datasources',
      message: 'caliban.datasources must be an array of datasource names',
    });
  }
}

/** Build the JSON body for a chat request (exported for tests and advanced use). */
export function buildChatBody(
  params: ChatCompletionCreateParams,
  defaults?: CalibanExtension,
  extraBody?: Record<string, unknown>,
): Record<string, unknown> {
  const { caliban, ...rest } = params;
  const ext = mergeCalibanExtension(defaults, caliban);
  if (ext) validateExtension(ext);
  const body: Record<string, unknown> = { ...rest, ...extraBody };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  if (ext) body.caliban = ext;
  else delete body.caliban;
  return body;
}

class Completions {
  constructor(private readonly client: CalibanClient) {}

  /** `POST /v1/chat/completions` returning the full completion (header metadata on `.meta`). */
  create(params: ChatCompletionCreateParamsNonStreaming, options?: RequestOptions): Promise<WithMeta<ChatCompletion>>;
  /** `POST /v1/chat/completions` with `stream: true`: resolves once headers arrive. */
  create(params: ChatCompletionCreateParamsStreaming, options?: RequestOptions): Promise<ChatCompletionStream>;
  create(
    params: ChatCompletionCreateParams,
    options?: RequestOptions,
  ): Promise<WithMeta<ChatCompletion> | ChatCompletionStream>;
  async create(
    params: ChatCompletionCreateParams,
    options: RequestOptions = {},
  ): Promise<WithMeta<ChatCompletion> | ChatCompletionStream> {
    const body = buildChatBody(params, this.client.defaultCaliban, options.extraBody);
    const streaming = params.stream === true;
    const { response, lifetime } = await this.client._send('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      accept: streaming ? 'text/event-stream' : 'application/json',
      options,
    });
    if (streaming) {
      lifetime.clearTimeout(); // stream started: the timeout only guarded time-to-headers
      return new ChatCompletionStream(response, lifetime);
    }
    return this.client._readJSON<ChatCompletion>(response, lifetime);
  }
}

/** Build the JSON body for an embeddings request (exported for tests and advanced use). */
export function buildEmbeddingsBody(
  params: EmbeddingCreateParams,
  extraBody?: Record<string, unknown>,
): Record<string, unknown> {
  const { input } = params;
  const valid = typeof input === 'string' || (Array.isArray(input) && input.every((t) => typeof t === 'string'));
  if (!valid) {
    throw new CalibanError({
      type: 'invalid_request_error',
      code: 'invalid_input',
      message: 'embeddings input must be a string or an array of strings',
    });
  }
  const body: Record<string, unknown> = { ...params, ...extraBody };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  return body;
}

class Embeddings {
  constructor(private readonly client: CalibanClient) {}

  /**
   * `POST /v1/embeddings` (OpenAI shape). Header metadata (`requestId`, `routedModel`,
   * `piiEntities`, …) is on `.meta`, as for chat completions.
   */
  async create(params: EmbeddingCreateParams, options: RequestOptions = {}): Promise<WithMeta<CreateEmbeddingResponse>> {
    const body = buildEmbeddingsBody(params, options.extraBody);
    const { response, lifetime } = await this.client._send('/embeddings', {
      method: 'POST',
      body: JSON.stringify(body),
      accept: 'application/json',
      options,
    });
    return this.client._readJSON<CreateEmbeddingResponse>(response, lifetime);
  }
}

function invalidRerank(code: string, message: string): CalibanError {
  return new CalibanError({ type: 'invalid_request_error', code, message });
}

/** Build the JSON body for a rerank request (exported for tests and advanced use). */
export function buildRerankBody(
  params: RerankCreateParams,
  extraBody?: Record<string, unknown>,
): Record<string, unknown> {
  const { query, documents, top_n, return_documents } = params;
  if (typeof query !== 'string') {
    throw invalidRerank('invalid_query', 'rerank query must be a string');
  }
  if (!Array.isArray(documents) || !documents.every((d) => typeof d === 'string')) {
    throw invalidRerank('invalid_documents', 'rerank documents must be an array of strings');
  }
  if (documents.length === 0) {
    throw invalidRerank('invalid_documents', 'rerank documents must contain at least one document');
  }
  if (top_n !== undefined && !(Number.isInteger(top_n) && top_n >= 1)) {
    throw invalidRerank('invalid_top_n', `rerank top_n must be an integer >= 1 (got ${String(top_n)})`);
  }
  if (return_documents !== undefined && typeof return_documents !== 'boolean') {
    throw invalidRerank('invalid_return_documents', 'rerank return_documents must be a boolean');
  }
  const body: Record<string, unknown> = { ...params, ...extraBody };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  return body;
}

class Rerank {
  constructor(private readonly client: CalibanClient) {}

  /**
   * `POST /v1/rerank`. `results` keep the server's order (by `relevance_score`, descending);
   * `results[].index` points into `documents`. Header metadata is on `.meta`.
   */
  async create(params: RerankCreateParams, options: RequestOptions = {}): Promise<WithMeta<RerankResponse>> {
    const body = buildRerankBody(params, options.extraBody);
    const { response, lifetime } = await this.client._send('/rerank', {
      method: 'POST',
      body: JSON.stringify(body),
      accept: 'application/json',
      options,
    });
    return this.client._readJSON<RerankResponse>(response, lifetime);
  }
}

/**
 * Data-plane client for Caliban's OpenAI-compatible API (`:8080/v1`).
 *
 * ```ts
 * const caliban = new CalibanClient({ apiKey: process.env.CALIBAN_API_KEY });
 * const res = await caliban.chat.completions.create({
 *   model: 'caliban/auto',
 *   messages: [{ role: 'user', content: 'Hi' }],
 *   caliban: { pii: 'reversible', cache: 'semantic' },
 * });
 * console.log(res.choices[0]?.message?.content, res.meta.routedModel);
 * ```
 */
export class CalibanClient {
  readonly baseURL: string;
  readonly defaultCaliban: CalibanExtension | undefined;
  readonly chat: { readonly completions: Completions };
  readonly embeddings: Embeddings;
  readonly rerank: Rerank;
  readonly models: { list(options?: RequestOptions): Promise<WithMeta<ModelList>> };

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: CalibanClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnv('CALIBAN_API_KEY');
    if (!apiKey) {
      throw new CalibanError({
        type: 'configuration_error',
        message: 'Missing API key: pass `apiKey` or set CALIBAN_API_KEY (tenant keys look like `cal_…`).',
      });
    }
    this.apiKey = apiKey;
    this.baseURL = trimTrailingSlash(options.baseURL ?? readEnv('CALIBAN_BASE_URL') ?? DEFAULT_DATA_PLANE_URL);
    this.fetchImpl = resolveFetch(options.fetch);
    this.retry = resolveRetryPolicy(options.retry);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultHeaders = { ...options.defaultHeaders };
    this.defaultCaliban = options.defaultCaliban;
    this.chat = { completions: new Completions(this) };
    this.embeddings = new Embeddings(this);
    this.rerank = new Rerank(this);
    this.models = {
      list: async (opts: RequestOptions = {}) => {
        const { response, lifetime } = await this._send('/models', { method: 'GET', accept: 'application/json', options: opts });
        return this._readJSON<ModelList>(response, lifetime);
      },
    };
  }

  /** @internal */
  async _send(
    path: string,
    req: { method: string; body?: string; accept: string; options: RequestOptions },
  ) {
    const headers: Record<string, string> = {
      accept: req.accept,
      ...this.defaultHeaders,
      ...req.options.headers,
      authorization: `Bearer ${this.apiKey}`,
    };
    if (req.options.idempotencyKey !== undefined) {
      for (const k of Object.keys(headers)) if (k.toLowerCase() === IDEMPOTENCY_KEY_HEADER) delete headers[k];
      headers[IDEMPOTENCY_KEY_HEADER] = req.options.idempotencyKey;
    }
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    const url = `${this.baseURL}${path}`;
    return sendWithRetry(
      (signal) =>
        this.fetchImpl(url, {
          method: req.method,
          headers,
          signal,
          ...(req.body !== undefined ? { body: req.body } : {}),
        }),
      {
        retry: resolveRetryPolicy(req.options.retry, this.retry),
        idempotent: isIdempotentRequest(req.method, headers),
        timeoutMs: req.options.timeoutMs ?? this.timeoutMs,
        signal: req.options.signal,
      },
    );
  }

  /** @internal */
  async _readJSON<T extends object>(
    response: Response,
    lifetime: { dispose(): void; classify(err: unknown): CalibanError },
  ): Promise<WithMeta<T>> {
    const meta = parseResponseMeta(response);
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw lifetime.classify(err);
    } finally {
      lifetime.dispose();
    }
    try {
      return attachMeta(JSON.parse(text) as T, meta);
    } catch (cause) {
      throw new CalibanError({
        type: 'api_error',
        status: response.status,
        requestId: meta.requestId,
        message: `Invalid JSON in response: ${text.slice(0, 200)}`,
        body: text,
        cause,
      });
    }
  }
}
