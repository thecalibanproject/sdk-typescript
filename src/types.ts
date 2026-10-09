import type { components, paths } from './generated/schema.js';
import type { RetryOptions } from './retry.js';

type Schemas = components['schemas'];

/** The `caliban` request extension (contract: `CalibanExtension`). Unknown to plain OpenAI clients. */
export type CalibanExtension = Schemas['CalibanExtension'];
export type PiiMode = NonNullable<CalibanExtension['pii']>;
export type CacheMode = NonNullable<CalibanExtension['cache']>;
/**
 * `caliban.reasoning`: how hard a reasoning model should think. Caliban maps it per model family
 * (e.g. Qwen3 `enable_thinking`, OpenAI-style `reasoning_effort`); `off` disables thinking on
 * hybrid models. Ignored for models without reasoning.
 */
export type ReasoningEffort = NonNullable<CalibanExtension['reasoning']>;

export type ChatMessage = Schemas['ChatMessage'];
export type ChatRole = ChatMessage['role'];

/** Reasoning fields that reasoning models add next to `content` (servers use either name). */
export interface ReasoningFields {
  /** Thinking text (vLLM/SGLang/DeepSeek naming; Caliban also moves inline `<think>` blocks here). */
  reasoning_content?: string | null;
  /** Thinking text under the name some newer servers use. */
  reasoning?: string | null;
}

/**
 * Assistant message in a completion: the contract `ChatMessage` plus the reasoning fields.
 */
export type ChatCompletionMessage = ChatMessage & ReasoningFields;

/** Like `Omit`, but keeps known keys on types that also have an index signature. */
type OmitKnown<T, K extends PropertyKey> = { [P in keyof T as P extends K ? never : P]: T[P] };

type ContractCompletion = Schemas['ChatCompletionResponse'];
type ContractChoice = ContractCompletion['choices'][number];
export type ChatCompletionChoice = OmitKnown<ContractChoice, 'message'> & { message?: ChatCompletionMessage };

/** Non-streaming response body (contract: `ChatCompletionResponse`, with reasoning fields on messages). */
export type ChatCompletion = OmitKnown<ContractCompletion, 'choices'> & { choices: ChatCompletionChoice[] };

export type ModelKind = Schemas['ModelKind'];
export type ModelCapabilities = Schemas['ModelCapabilities'];
// `TrustTier` itself is exported from node.ts (same values; a contract test checks they match).
type TrustTier = Schemas['TrustTier'];

/** Caliban details on a `/v1/models` item (absent on the virtual `caliban/auto` entry). */
export interface ModelCalibanInfo {
  kind: ModelKind;
  family?: string | null;
  capabilities: ModelCapabilities;
  trust_tier: TrustTier;
}

type ContractModelList = paths['/v1/models']['get']['responses'][200]['content']['application/json'];
/**
 * One `/v1/models` item.
 * The `caliban` object is absent on `caliban/auto`.
 */
export type ModelInfo = ContractModelList['data'][number] & { caliban?: ModelCalibanInfo };
export type ModelList = OmitKnown<ContractModelList, 'data'> & { data: ModelInfo[] };

type ContractEmbeddingsRequest = paths['/v1/embeddings']['post']['requestBody']['content']['application/json'];

/**
 * Request body for `POST /v1/embeddings` (OpenAI shape). Use `RequestOptions.extraBody` for
 * server-specific fields not listed here.
 */
export interface EmbeddingCreateParams {
  /** Registry id of an embedding model (`kind: embedding`), e.g. `local/bge-m3`. */
  model: ContractEmbeddingsRequest['model'];
  /** One text or a batch of texts. Texts leaving the trust boundary are PII-masked. */
  input: ContractEmbeddingsRequest['input'];
  /** Output dimensions, for models that support truncation (e.g. Matryoshka embeddings). */
  dimensions?: number;
  encoding_format?: 'float';
  user?: string;
}

export interface Embedding {
  object?: 'embedding' | (string & {});
  index: number;
  embedding: number[];
  [key: string]: unknown;
}

/** Response body of `POST /v1/embeddings`. */
export interface CreateEmbeddingResponse {
  object: 'list' | (string & {});
  model: string;
  data: Embedding[];
  usage?: { prompt_tokens?: number; total_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

type ContractRerankRequest = paths['/v1/rerank']['post']['requestBody']['content']['application/json'];

/**
 * Request body for `POST /v1/rerank` (Cohere/Jina style). Use `RequestOptions.extraBody` for
 * server-specific fields not listed here.
 */
export interface RerankCreateParams {
  /** Registry id of a rerank model (`kind: rerank`), e.g. `local/qwen3-reranker`. */
  model: ContractRerankRequest['model'];
  /** The query to score each document against. */
  query: ContractRerankRequest['query'];
  /** Candidate texts (at least one). Text leaving the trust boundary is PII-masked. */
  documents: ContractRerankRequest['documents'];
  /** Return only the `top_n` best results (integer >= 1). Default: all documents. */
  top_n?: ContractRerankRequest['top_n'];
  /** Echo each document's text in `results[].document.text` (always your original text). */
  return_documents?: ContractRerankRequest['return_documents'];
}

/** One scored document. `index` points into the request's `documents` array. */
export interface RerankResult {
  index: number;
  relevance_score: number;
  /** Present when `return_documents: true`. */
  document?: { text: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Response body of `POST /v1/rerank`. `results` are sorted by `relevance_score`, descending. */
export interface RerankResponse {
  model: string;
  results: RerankResult[];
  usage?: { total_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Request body for `POST /v1/chat/completions`.
 *
 * Deliberately has no open index signature: a typo such as `calliban` would otherwise be
 * accepted silently and the PII/ZDR policy you meant to request would not apply. Use
 * `RequestOptions.extraBody` to send OpenAI-compatible fields not listed here.
 */
export interface ChatCompletionCreateParamsBase {
  /** Registry model id, tenant alias, or `caliban/auto`. */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number | null;
  max_tokens?: number;
  max_completion_tokens?: number | null;
  n?: number | null;
  stop?: string | string[] | null;
  seed?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  logprobs?: boolean | null;
  top_logprobs?: number | null;
  user?: string;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: 'none' | 'auto' | 'required' | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  response_format?: Record<string, unknown>;
  metadata?: Record<string, string>;
  /** Caliban extension. Merged over the client's `defaultCaliban` (request keys win). */
  caliban?: CalibanExtension;
}

export interface ChatCompletionCreateParamsNonStreaming extends ChatCompletionCreateParamsBase {
  stream?: false;
}

export interface ChatCompletionCreateParamsStreaming extends ChatCompletionCreateParamsBase {
  stream: true;
  stream_options?: { include_usage?: boolean } | null;
}

export type ChatCompletionCreateParams = ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming;

export interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface ChatCompletionChunkToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunkDelta extends ReasoningFields {
  role?: ChatRole;
  content?: string | null;
  refusal?: string | null;
  tool_calls?: ChatCompletionChunkToolCallDelta[];
  [key: string]: unknown;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: string | null;
  logprobs?: unknown;
  [key: string]: unknown;
}

/**
 * One `chat.completion.chunk` from a streaming response.
 * TODO(contract): not yet described in core/api/openapi.yaml; mirrors the OpenAI shape.
 */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: CompletionUsage | null;
  system_fingerprint?: string | null;
  [key: string]: unknown;
}

/** `x-caliban-cache` values; open-ended for forward compatibility. */
export type CacheStatus = 'hit' | 'miss' | 'bypass' | (string & {});

/** Caliban metadata parsed from data-plane response headers. */
export interface CalibanResponseMeta {
  /** `x-caliban-request-id` */
  requestId: string | null;
  /** `x-caliban-routed-model`: the model the router actually used (useful with `caliban/auto`). */
  routedModel: string | null;
  /** `x-caliban-cache`: `hit | miss | bypass` */
  cache: CacheStatus | null;
  /** `x-caliban-pii-entities`: number of PII entities detected/redacted. */
  piiEntities: number | null;
  /**
   * `x-caliban-cost-usd`: cost of this request in USD. Non-streaming responses only, and `null`
   * when the model has no price (streams report cost in usage events instead).
   */
  costUsd: number | null;
  /** HTTP status of the response. */
  status: number;
  /** All response headers. */
  headers: Headers;
}

/** A value returned by the data-plane client, with header metadata on a non-enumerable `meta`. */
export type WithMeta<T> = T & { readonly meta: CalibanResponseMeta };

export interface RequestOptions {
  signal?: AbortSignal;
  /** Overrides the client timeout for this call. For streams it covers time-to-headers only. */
  timeoutMs?: number;
  /** Overrides (merged with) the client retry policy; `false` disables retries. */
  retry?: RetryOptions | false;
  headers?: Record<string, string>;
  /** Extra JSON fields merged into the request body (after typed params, before `caliban`). */
  extraBody?: Record<string, unknown>;
}
