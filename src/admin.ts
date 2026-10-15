import createClient, { type Client } from 'openapi-fetch';
import { CalibanError, errorFromBody } from './errors.js';
import type { components, paths } from './generated/schema.js';
import { readEnv, resolveFetch, trimTrailingSlash } from './internal/env.js';
import { createRetryingFetch } from './internal/http.js';
import type { NodeSpec } from './node.js';
import { resolveRetryPolicy, type RetryOptions } from './retry.js';

type Schemas = components['schemas'];
/**
 * A tenant (contract: `Tenant`). `pii_patterns` and `pii_dictionary` (which may hold staff or
 * customer names) are present only for callers with `tenant.write` on the tenant; every caller of
 * `tenants.get()` and `tenants.list()` gets `pii_patterns_count` and `pii_dictionary_count`.
 */
export type Tenant = Schemas['Tenant'];
export type TenantCreate = Schemas['TenantCreate'];
/** Body for `tenants.update()` (contract: `TenantUpdate`). Absent fields keep their value. */
export type TenantUpdate = Schemas['TenantUpdate'];
/** `pii_surrogate_scope`: `tenant` (default, linkable within the tenant) or `session` (fresh per request). */
export type PiiSurrogateScope = NonNullable<Tenant['pii_surrogate_scope']>;
/** `semantic_cache` tenant setting: `off` (default) or `on`. */
export type SemanticCacheSetting = NonNullable<Tenant['semantic_cache']>;
/**
 * One of the tenant's own L0 PII patterns (contract: `PiiPattern`): a `label` and a linear-time
 * Rust `regex`. Labels are case-insensitive: stored as sent, used upper-cased (`phone` is `PHONE`).
 */
export type PiiPattern = Schemas['PiiPattern'];
/** One term of the tenant's PII dictionary (contract: `PiiTerm`): whole-word, case-insensitive, and so is its `label`. */
export type PiiTerm = Schemas['PiiTerm'];
/**
 * A Caliban API key, metadata only (contract: `ApiKeyInfo`): `nodes` is its node allowlist (`null`:
 * every published node; `[]`: none) and `datasource_scopes` the scopes it may read.
 */
export type ApiKeyInfo = Schemas['ApiKeyInfo'];
/**
 * Body of `apiKeys.update()`: absent fields are kept; `null` lifts a restriction (every published
 * node; every scope of the nodes it runs).
 */
export type ApiKeyUpdate =
  paths['/api/v1/tenants/{tenantId}/api-keys/{keyId}']['patch']['requestBody']['content']['application/json'];
export type ApiKeyCreated = Schemas['ApiKeyCreated'];
export type ProviderKind = Schemas['ProviderKind'];
export type ProviderKey = Schemas['ProviderKey'];
export type ProviderKeyCreate = Schemas['ProviderKeyCreate'];
/** A model in the control-plane catalogue (contract: `Model`). */
export type RegistryModel = Schemas['Model'];
/** Body for registering a model (contract: `ModelCreate`); also the shape of discovery suggestions. */
export type ModelCreate = Schemas['ModelCreate'];
/** A shared model server, e.g. an on-prem vLLM/SGLang/llama.cpp/Ollama pool (contract: `SharedProvider`). */
export type SharedProvider = Schemas['SharedProvider'];
export type SharedProviderCreate = Schemas['SharedProviderCreate'];
/** Result of `GET /api/v1/providers/{providerId}/health`. */
export type ProviderHealth =
  paths['/api/v1/providers/{providerId}/health']['get']['responses'][200]['content']['application/json'];
/** Result of `POST /api/v1/providers/{providerId}/discover`. */
export type ModelDiscovery =
  paths['/api/v1/providers/{providerId}/discover']['post']['responses'][200]['content']['application/json'];
export type DatasourceKind = Schemas['DatasourceKind'];
export type Datasource = Schemas['Datasource'];
/**
 * `pending` when created; `introspecting` while an introspection job runs, then `ready` or `failed`
 * (see the job's `error`). `connected` and `error` are reserved: core does not set them yet.
 */
export type DatasourceStatus = NonNullable<Datasource['status']>;
export type DatasourceCreate = Schemas['DatasourceCreate'];
/**
 * An element as proposed with `ontology.propose()` (contract: `OntologyElementProposal`):
 * `status` may be left out, and whatever it says is ignored (the server writes `proposed`).
 */
export type OntologyElementProposal = Schemas['OntologyElementProposal'];
/**
 * A stored element (contract: `OntologyElement`): a proposal with a `status`, always present, and
 * `changed_in`. The contract requires `status` in an `allOf` branch the generator does not carry
 * over, so it is required here.
 */
export type OntologyElement = Schemas['OntologyElement'] & {
  status: NonNullable<OntologyElementProposal['status']>;
};
/** A tenant's ontology (contract: `Ontology`), with every element's `status`. */
export type Ontology = Omit<Schemas['Ontology'], 'elements'> & { elements: OntologyElement[] };
/** `proposed`, `approved`, `rejected`, `stale` or `deprecated`. */
export type OntologyElementStatus = OntologyElement['status'];
/**
 * An approved element that a decision or a proposal withdraws while published node versions query
 * it (contract: `OntologyBreaking`): the `element`, the `change` (`approved -> proposed`), the
 * versions as `name@vN` in `nodes`, and the same versions structured in `versions`.
 */
export type OntologyBreaking = Schemas['OntologyBreaking'];
export type OntologyElementKind = Schemas['OntologyElementKind'];
/** Body of `ontology.review()`: `tenant_id` is required (element ids are per tenant). */
export type OntologyReview = NonNullable<
  paths['/api/v1/ontology/elements/{elementId}/review']['post']['requestBody']
>['content']['application/json'];
/** `approve`, `reject` or `deprecate`. */
export type OntologyDecision = OntologyReview['decision'];
/** Body of `ontology.reviewBatch()`: one decision per element id, written as one ontology version. */
export type OntologyBatchReview = NonNullable<
  paths['/api/v1/tenants/{tenantId}/ontology/review']['post']['requestBody']
>['content']['application/json'];
/** Result of `ontology.reviewBatch()`: the new `version`, the reviewed `elements` and the `breaking` changes acknowledged. */
export type OntologyBatchReviewResult = Omit<
  paths['/api/v1/tenants/{tenantId}/ontology/review']['post']['responses'][200]['content']['application/json'],
  'elements' | 'breaking'
> & { elements?: OntologyElement[]; breaking?: OntologyBreaking[] };
/** Body of `ontology.propose()`: elements made outside Caliban, written as `proposed` (1 to 5000). */
export type OntologyProposals = NonNullable<
  paths['/api/v1/tenants/{tenantId}/ontology/proposals']['post']['requestBody']
>['content']['application/json'];
/**
 * Result of `ontology.propose()`: the ontology `version` after the call (unchanged when nothing was
 * written), how many were `proposed` and `skipped` (unchanged in spec, name and description,
 * whatever status they were sent with), and `breaking`: the approved elements the call withdrew
 * that published node versions query (always present; empty unless `acknowledge_breaking`).
 */
export type OntologyProposalResult =
  paths['/api/v1/tenants/{tenantId}/ontology/proposals']['post']['responses'][201]['content']['application/json'];
/** An ontology bootstrap job of a datasource (contract: `IntrospectionJob`). */
export type IntrospectionJob = Schemas['IntrospectionJob'];
/** Result of `datasources.introspect()`: the job id and the job as it started. */
export type IntrospectStarted =
  paths['/api/v1/datasources/{datasourceId}/introspect']['post']['responses'][202]['content']['application/json'];
/** Result of `intents.list()`: the tenant's `caliban/auto` intents as routers use them. */
export type TenantIntents =
  paths['/api/v1/tenants/{tenantId}/intents']['get']['responses'][200]['content']['application/json'];
/** One intent: its exemplars, `source` (`config`: the config file; `api`: set with `intents.put()`) and the node it hands to. */
export type TenantIntent = NonNullable<TenantIntents['intents']>[number];
/** Result of `intents.put()`: the intent as stored (contract: `TenantIntentSet`); `exemplars` trimmed, duplicates dropped. */
export type TenantIntentSet = Schemas['TenantIntentSet'];
/** A catalogue model a collection can use (contract: `RagModel`). */
export type RagModel = Schemas['RagModel'];
/** Result of `rag.models()`: the embedding and rerank models the tenant can reach. */
export type RagModels =
  paths['/api/v1/tenants/{tenantId}/rag/models']['get']['responses'][200]['content']['application/json'];
/** A document collection (contract: `RagCollection`); `document_counts` (per status) in the listing only. */
export type RagCollection = Schemas['RagCollection'];
export type RagCollectionCreate = Schemas['RagCollectionCreate'];
export type RagCollectionSettings = Schemas['RagCollectionSettings'];
/** Result of `rag.collections.get()`: the collection and the published versions that search it (`used_by`). */
export type RagCollectionDetail =
  paths['/api/v1/tenants/{tenantId}/rag/collections/{collection}']['get']['responses'][200]['content']['application/json'];
/** One version of a document (contract: `RagDocument`). Never the content. */
export type RagDocument = Schemas['RagDocument'];
/** `pending`, `indexing`, `ready`, `quarantined`, `failed`, `superseded` or `deleted`. Only `ready` is served. */
export type RagDocumentStatus = Schemas['RagDocumentStatus'];
/** Why a version was quarantined: `kind`, the `chunk`, and the `heading_path` above it (never an excerpt). */
export type RagFinding = Schemas['RagFinding'];
export type RagDocumentIngest = Schemas['RagDocumentIngest'];
/** Result of `rag.documents.ingest()`: a new pending version, or the newest one with `unchanged: true`. */
export type RagIngestResult =
  | paths['/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents']['post']['responses'][202]['content']['application/json']
  | paths['/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents']['post']['responses'][200]['content']['application/json'];
/** Query of `rag.documents.list()`. */
export type RagDocumentListQuery = NonNullable<
  paths['/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents']['get']['parameters']['query']
>;
/** A page of `rag.documents.list()`: each document's newest version with its `live_version`. */
export type RagDocumentList =
  paths['/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents']['get']['responses'][200]['content']['application/json'];
/** Result of `rag.documents.get()`: every version, newest first, and the one being served. */
export type RagDocumentVersions =
  paths['/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents/{docId}']['get']['responses'][200]['content']['application/json'];
/** Body of `rag.documents.release()`. */
export type RagRelease =
  paths['/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents/{docId}/release']['post']['requestBody']['content']['application/json'];
/**
 * One immutable node version (contract: `Node`): its `state` (`draft`, `published` or `retired`),
 * `live` (the promotion pointer names it), the content `hash`, and `warnings` (broad
 * `allow_tainted` entries).
 */
export type Node = Schemas['Node'];
/** `draft`, `published` or `retired`. */
export type NodeState = Node['state'];
/** One entry per node from `nodes.summaries()` (contract: `NodeSummary`): live and latest version, counts. */
export type NodeSummary = Schemas['NodeSummary'];
/** Result of `nodes.versions()`: every version not deleted, oldest first, the `live` one and its `promotion`. */
export type NodeVersions =
  paths['/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions']['get']['responses'][200]['content']['application/json'];
/** Body of `nodes.publish()`: `promote` (default `true`) also makes the version live. */
export type NodePublish = NonNullable<
  paths['/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/publish']['post']['requestBody']
>['content']['application/json'];
/** Result of `nodes.diff()`: both versions' hashes and states, and the spec changes as JSON pointers. */
export type NodeDiff =
  paths['/api/v1/tenants/{tenantId}/nodes/{nodeName}/diff']['get']['responses'][200]['content']['application/json'];
/** One change of a {@link NodeDiff}: `added`, `removed` or `changed` at a JSON pointer `path`. */
export type NodeDiffChange = NonNullable<NodeDiff['changes']>[number];
/** Result of `usage.nodeSpend()`: the tenant's node spend today and this month (UTC), its caps and what remains. */
export type NodeSpend =
  paths['/api/v1/tenants/{tenantId}/node-spend']['get']['responses'][200]['content']['application/json'];
/** Tenant caps on node spend per UTC day and month (contract: `NodeSpendCaps`). */
export type NodeSpendCaps = Schemas['NodeSpendCaps'];
/** Tenant caps every node version's budgets must fit (contract: `NodeCaps`). */
export type NodeCaps = Schemas['NodeCaps'];
/** Tenant intent-to-node routing for `caliban/auto` (contract: `NodeRoutes`). */
export type NodeRoutes = Schemas['NodeRoutes'];
export type UsageReport = Schemas['UsageReport'];
export type UsageEvent = Schemas['UsageEvent'];
/** Per-stage durations of a request in ms (contract: `UsageTimings`): the `Server-Timing` numbers, kept on the usage event. */
export type UsageTimings = Schemas['UsageTimings'];
/** `UsageReport.totals`. */
export type UsageTotals = UsageReport['totals'];
/** Work Caliban did on the tenant's behalf (`rag.ingest`, `rag.search`); absent on client calls and node model calls. */
export type UsagePurpose = NonNullable<UsageEvent['purpose']>;
/** `UsageReport.by_purpose`: the totals per purpose, so retrieval spend is separable from the tenant's own calls. */
export type UsageByPurpose = NonNullable<UsageReport['by_purpose']>[number];
export type Health = Schemas['Health'];
/** `NodeCreate` with `spec` typed against node.schema.json instead of a free-form object. */
export type NodeCreate = Omit<Schemas['NodeCreate'], 'spec'> & { spec: NodeSpec };

// ── Node evals (golden sets, promotion bar, evals, the gate, the eval key) ──

type ContractCheck = Schemas['EvalCheck'];
/**
 * A check of a golden case's run output (contract: `EvalCheck`): `exact`, `contains`, `regex`,
 * `json_schema`, `llm_judge` (with an optional `reference` answer) or `tool_call` (the run called
 * `tool` with arguments containing `args`, or with `must_not_call` did not call it). Text checks
 * see the output as text (a string as is, other JSON compact). The generator types the free-form
 * `schema` of a `json_schema` check and the `args` of a `tool_call` check as
 * `Record<string, never>`; here they are any JSON object.
 */
export type EvalCheck =
  | Exclude<ContractCheck, { type: 'json_schema' } | { type: 'tool_call' }>
  | (Omit<Extract<ContractCheck, { type: 'json_schema' }>, 'schema'> & { schema: Record<string, unknown> })
  | (Omit<Extract<ContractCheck, { type: 'tool_call' }>, 'args'> & { args?: Record<string, unknown> });
/**
 * One golden case (contract: `GoldenCase`). `expected` is shorthand for an `exact` check;
 * `tool_results` scripts tool answers by tool name or reference (a trial never calls a write tool:
 * the eval sandbox answers this script, else a synthetic result marked `"sandbox": true`).
 */
export type GoldenCase = Omit<Schemas['GoldenCase'], 'checks'> & { checks?: EvalCheck[] };
/** A version's golden set (contract: `GoldenSet`). `cases` only when `content_visible` (the caller holds `runs.data`). */
export type GoldenSet = Omit<Schemas['GoldenSet'], 'cases'> & { cases?: GoldenCase[] };
/** Body of `goldenSets.put()`: at most 200 cases, unique ids, at least one check each. */
export interface GoldenSetPut {
  cases: GoldenCase[];
}
/** A node's promotion bar (contract: `EvalPolicy`). */
export type EvalPolicy = Schemas['EvalPolicy'];
/** Whether read-only versions need an injection eval to promote: `required` (default) or `optional`. */
export type InjectionReadOnly = NonNullable<NonNullable<EvalPolicy['injection']>['read_only']>;
/** The bar in effect (contract: `EvalPolicyView`); `injection_bar` applies to versions with write tools and to read-only versions. */
export type EvalPolicyView = Schemas['EvalPolicyView'];
/**
 * An eval of a node version (contract: `Eval`). While it is `pending` or `running`, `summary`
 * (metrics only) is null and its `trials` (only on `evals.get()`) may still be running, with an
 * empty verdict ({@link PendingVerdict}); see {@link isEvalDone} and {@link isPendingVerdict}.
 */
export type Eval = Omit<Schemas['Eval'], 'trials'> & { trials?: EvalTrial[] };
export type EvalSuite = Eval['suite'];
export type EvalStatus = Eval['status'];
/** Golden metrics (contract: `GoldenSummary`): `pass_hat_k` (pass^k), `pass_at_1`, `cost_per_success_usd`, `latency_ms`, `by_case`, ... */
export type GoldenSummary = Schemas['GoldenSummary'];
/** Injection metrics (contract: `InjectionSummary`): `pass_rate`, `attack_success_rate`, `by_category`, `not_applicable`, ... */
export type InjectionSummary = Schemas['InjectionSummary'];
export type LatencyPercentiles = Schemas['LatencyPercentiles'];
/**
 * The verdict of a trial still in flight (`status: 'running'`): an empty object, since its run
 * has not been scored yet. The contract's `oneOf` leaves it out; core sends it.
 */
export type PendingVerdict = Record<string, never>;
type ContractTrial = NonNullable<Schemas['Eval']['trials']>[number];
/**
 * One trial of an eval: a case's run. `verdict` is `{}` ({@link PendingVerdict}) while the trial
 * runs, then a golden or injection verdict, or `{ error }` when its run could not be created.
 * `detail` only with `runs.data` (and until run retention purges it).
 */
export type EvalTrial = Omit<ContractTrial, 'verdict'> & {
  verdict?: GoldenVerdict | InjectionVerdict | { error: string } | PendingVerdict;
};
/** A golden trial's verdict: the run's status and each check's result. */
export type GoldenVerdict = Schemas['GoldenVerdict'];
/** An injection trial's verdict: category, whether the attack succeeded or was followed, the defenses that held. */
export type InjectionVerdict = Schemas['InjectionVerdict'];
/** Body of `evals.start()`. Without `api_key_id` the eval runs as the tenant's eval key (see `evalKey`). */
export type EvalStart = NonNullable<
  paths['/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/evals']['post']['requestBody']
>['content']['application/json'];
/** Query of `evals.list()`. `status` is comma separated. */
export type EvalListQuery = NonNullable<
  paths['/api/v1/tenants/{tenantId}/evals']['get']['parameters']['query']
>;
/** A page of `evals.list()`; pass `next_cursor` as `cursor` for the next one (`null` on the last). */
export type EvalList =
  paths['/api/v1/tenants/{tenantId}/evals']['get']['responses'][200]['content']['application/json'];
/** The evals that met the bar, per suite, and per pinned subnode version under `subnodes` (contract: `GateEvidence`). */
export type GateEvidence = Schemas['GateEvidence'];
/** One reason a node version was refused (contract: `Problem`); `path` says where (a subnode for `eval_gate`). */
export type Problem = Schemas['Problem'];
/** What promoting a version would say: `allowed`, the `evidence`, or the `problems`. */
export type EvalGate =
  paths['/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/gate']['get']['responses'][200]['content']['application/json'];
/** Result of `evalKey.get()`: the tenant's eval key (`key` is null before the first eval that names no key). */
export type EvalKey =
  paths['/api/v1/tenants/{tenantId}/eval-key']['get']['responses'][200]['content']['application/json'];
/** Result of `evalKey.rotate()`: the new key and the id of the one it revoked. */
export type EvalKeyRotation =
  paths['/api/v1/tenants/{tenantId}/eval-key/rotate']['post']['responses'][200]['content']['application/json'];

// ── Node runs and the inbox (console) ──

/**
 * A run as the console sees it (contract: `ConsoleRun`): content (`input`, `output`, step outputs)
 * only with `runs.data`. `cost_usd` is what the run is billed and `model_cost_usd` the real cost of
 * the models its calls were routed to; `answer_check` (`AnswerCheck`, metadata only) with `runs.read`.
 */
export type ConsoleRun = Schemas['ConsoleRun'];
/** Query of `runs.list()` (admin). `status` is comma separated; times are RFC 3339. */
export type ConsoleRunListQuery = NonNullable<paths['/api/v1/tenants/{tenantId}/runs']['get']['parameters']['query']>;
/** A page of run summaries (contract: `NodeRunList`). */
export type ConsoleRunList = Schemas['NodeRunList'];
/** Body of `runs.input()` (admin): `answer` is any JSON value (`{ approve: boolean }` for an approval); `step` defaults to the awaited one. */
export type ConsoleRunInput =
  paths['/api/v1/tenants/{tenantId}/runs/{runId}/input']['post']['requestBody']['content']['application/json'];
/** One step of a run's timeline (contract: `RunStep`): vertex, kind, status, tokens, cost, `started_at` and `duration_ms`. */
export type ConsoleRunStep = Schemas['RunStep'];
/**
 * A MAST failure mode (contract: `MastLabel`, arXiv 2503.13657) a reviewer labels a bad run with:
 * FM-1.x specification, FM-2.x inter-agent misalignment, FM-3.x task verification.
 */
export type MastLabel = Schemas['MastLabel'];
/**
 * Body of `runs.captureGoldenCase()`: the `verdict` (`good`: the run did the right thing and must
 * have succeeded; `bad`: it did not, and `note` is required), an optional `mast_label` (bad runs
 * only) and the `version` whose golden set receives the case (default: the run's).
 */
export type GoldenCaseCapture = Schemas['GoldenCaseCapture'];
/**
 * Result of `runs.captureGoldenCase()` (contract: `CapturedGoldenCase`): the case id (the run id),
 * the check kinds derived from the run, the set's `previous_hash` and new `golden_set`, and the
 * `case` itself with `runs.data` (`content_visible`).
 */
export type CapturedGoldenCase = Omit<Schemas['CapturedGoldenCase'], 'case' | 'golden_set'> & {
  case?: GoldenCase;
  golden_set: GoldenSet;
};
/** Result of `inbox.list()`: runs waiting for a human, oldest wait first. */
export type Inbox = paths['/api/v1/tenants/{tenantId}/inbox']['get']['responses'][200]['content']['application/json'];
/** One waiting human step: a `question`, or an `approval` of a gated call (`approval` says what it would do). */
export type InboxItem = Inbox['data'][number];
/** What a gated call would do (`kind: 'approval'`): tool, effect, taint labels, and `arguments` with `runs.data`. */
export type InboxApproval = NonNullable<InboxItem['approval']>;

/** The eval ended: `succeeded`, `failed` or `cancelled` (its `summary` is set once it succeeded). */
export function isEvalDone(e: Pick<Eval, 'status'>): boolean {
  return e.status === 'succeeded' || e.status === 'failed' || e.status === 'cancelled';
}

/** The trial's verdict is the empty object of a trial in flight (or it has none yet). */
export function isPendingVerdict(verdict: EvalTrial['verdict'] | null): verdict is PendingVerdict | undefined {
  return verdict === undefined || verdict === null || Object.keys(verdict).length === 0;
}

export const DEFAULT_CONTROL_PLANE_URL = 'http://localhost:8081';

export interface CalibanAdminOptions {
  /** Admin bearer token. Defaults to `CALIBAN_ADMIN_TOKEN`. */
  token?: string;
  /** Control-plane origin **without** `/api/v1`. Defaults to `CALIBAN_ADMIN_URL` or `http://localhost:8081`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * Retry policy; `false` disables. Default: 2 retries on 429/502/503 for GET/DELETE, and on
   * 429/503 only for POST unless it carries an `Idempotency-Key` header.
   */
  retry?: RetryOptions | false;
  /** Per-attempt timeout (including body read). Default 60 000 ms. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface AdminRequestOptions {
  signal?: AbortSignal;
  /** Per-call headers. An `Idempotency-Key` here makes a POST retryable on 502 (not deduplicated by the server yet). */
  headers?: Record<string, string>;
}

/** Options for `tenants.list()`: request options plus the list query. */
export interface TenantListOptions extends AdminRequestOptions {
  /** Also return deleted tenants (tombstones, `status: 'deleted'`). Default false. */
  include_deleted?: boolean;
}

/** Options for `apiKeys.list()`: request options plus the list query. */
export interface ApiKeyListOptions extends AdminRequestOptions {
  /** Also return revoked keys (those with `revoked_at` set). Default false. */
  include_revoked?: boolean;
}

type ApiResult<D> = { data?: D; error?: unknown; response: Response };

/** Unwrap an openapi-fetch result, throwing a typed {@link CalibanAPIError} on non-2xx. */
async function unwrap<D>(promise: Promise<ApiResult<D>>): Promise<D> {
  const { data, error, response } = await promise;
  if (!response.ok) throw errorFromBody(response.status, error, response.headers, response.statusText);
  return data as D;
}

/**
 * Percent-encode a model id for use in a URL path while keeping its `/` separators, as the
 * contract requires (`DELETE /api/v1/models/local/qwen3-8b`, not `local%2Fqwen3-8b`). Each
 * segment is encoded with `encodeURIComponent`. Empty, `.` and `..` segments are rejected
 * because URL normalisation would otherwise turn them into a different path.
 */
export function encodeModelIdPath(modelId: string): string {
  const segments = modelId.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new CalibanError({
      type: 'invalid_request_error',
      code: 'invalid_model_id',
      message: `Invalid model id ${JSON.stringify(modelId)}: segments must be non-empty and not '.' or '..'`,
    });
  }
  return segments.map(encodeURIComponent).join('/');
}

/** openapi-fetch path serializer for `{modelId}`: slashes stay unescaped (see {@link encodeModelIdPath}). */
function modelIdPathSerializer(pathname: string, params: Record<string, unknown>): string {
  return pathname.replace('{modelId}', encodeModelIdPath(String(params.modelId)));
}

/**
 * Control-plane client (`:8081/api/v1`). Thin helpers over a fully typed
 * `openapi-fetch` client generated from `core/api/openapi.yaml`; use `raw` for anything
 * the helpers do not cover.
 */
export class CalibanAdmin {
  /** The underlying typed openapi-fetch client. */
  readonly raw: Client<paths>;

  constructor(options: CalibanAdminOptions = {}) {
    const token = options.token ?? readEnv('CALIBAN_ADMIN_TOKEN');
    if (!token) {
      throw new CalibanError({
        type: 'configuration_error',
        message: 'Missing admin token: pass `token` or set CALIBAN_ADMIN_TOKEN.',
      });
    }
    const baseUrl = trimTrailingSlash(options.baseUrl ?? readEnv('CALIBAN_ADMIN_URL') ?? DEFAULT_CONTROL_PLANE_URL);
    this.raw = createClient<paths>({
      baseUrl,
      fetch: createRetryingFetch(resolveFetch(options.fetch), resolveRetryPolicy(options.retry), options.timeoutMs ?? 60_000),
      headers: { ...options.headers, authorization: `Bearer ${token}` },
    });
  }

  /** `GET /api/v1/health` (unauthenticated on the server). */
  health(opts?: AdminRequestOptions): Promise<Health> {
    return unwrap(this.raw.GET('/api/v1/health', { ...opts }));
  }

  readonly tenants = {
    /** Active tenants; pass `{ include_deleted: true }` to include tombstones. */
    list: ({ include_deleted, ...opts }: TenantListOptions = {}): Promise<Tenant[]> =>
      unwrap(this.raw.GET('/api/v1/tenants', { ...opts, params: { query: { include_deleted } } })),
    create: (body: TenantCreate, opts?: AdminRequestOptions): Promise<Tenant> =>
      unwrap(this.raw.POST('/api/v1/tenants', { ...opts, body })),
    /** A deleted tenant is a 404. The PII detectors only with `tenant.write`; their counts always. */
    get: (tenantId: string, opts?: AdminRequestOptions): Promise<Tenant> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}', { ...opts, params: { path: { tenantId } } })),
    /**
     * Change a tenant's PII and cache settings (`PATCH`). Fields left out keep their value.
     * Audited as `tenant.update`; routers apply the change with their next snapshot. Retried on
     * 429/503 only (like a POST), unless the request carries an `Idempotency-Key` header.
     */
    update: (tenantId: string, patch: TenantUpdate, opts?: AdminRequestOptions): Promise<Tenant> =>
      unwrap(this.raw.PATCH('/api/v1/tenants/{tenantId}', { ...opts, params: { path: { tenantId } }, body: patch })),
    /**
     * Permanently delete a tenant. In one audited transaction the server turns it into a
     * tombstone, revokes its API keys, destroys its BYOK credentials, removes its routes and
     * soft-deletes its datasources and nodes. The id cannot be reused. Throws a 404
     * `CalibanAPIError` if the tenant is unknown or already deleted.
     */
    delete: async (tenantId: string, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(this.raw.DELETE('/api/v1/tenants/{tenantId}', { ...opts, params: { path: { tenantId } } }));
    },
  };

  readonly apiKeys = {
    /** Active keys; pass `{ include_revoked: true }` to include revoked ones. */
    list: (tenantId: string, { include_revoked, ...opts }: ApiKeyListOptions = {}): Promise<ApiKeyInfo[]> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/api-keys', {
          ...opts,
          params: { path: { tenantId }, query: { include_revoked } },
        }),
      ),
    /** Mint a key. `key` (plaintext) is returned exactly once: store it now. */
    create: (tenantId: string, body: { name?: string } = {}, opts?: AdminRequestOptions): Promise<ApiKeyCreated> =>
      unwrap(this.raw.POST('/api/v1/tenants/{tenantId}/api-keys', { ...opts, params: { path: { tenantId } }, body })),
    /**
     * Revoke a key (permanent). A standalone deployment rejects it on the next request; a
     * split-mode router rejects it after its next snapshot poll (10 s by default). Throws a 404
     * `CalibanAPIError` if the key is unknown, belongs to another tenant or is already revoked, and
     * a 409 for the tenant's eval key (rotate that with `evalKey.rotate()`).
     */
    revoke: async (tenantId: string, keyId: string, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(
        this.raw.DELETE('/api/v1/tenants/{tenantId}/api-keys/{keyId}', { ...opts, params: { path: { tenantId, keyId } } }),
      );
    },
    /**
     * Change a key's node allowlist (`nodes`) and datasource scopes (`PATCH`). Absent fields are
     * kept; `null` lifts the restriction. Changing node access needs `nodes.run` on the tenant (a
     * 403 otherwise). Audited as `api_key.update`; routers apply it with their next snapshot.
     */
    update: (tenantId: string, keyId: string, patch: ApiKeyUpdate, opts?: AdminRequestOptions): Promise<ApiKeyInfo> =>
      unwrap(
        this.raw.PATCH('/api/v1/tenants/{tenantId}/api-keys/{keyId}', {
          ...opts,
          params: { path: { tenantId, keyId } },
          body: patch,
        }),
      ),
  };

  readonly providerKeys = {
    list: (tenantId: string, opts?: AdminRequestOptions): Promise<ProviderKey[]> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/provider-keys', { ...opts, params: { path: { tenantId } } })),
    create: (tenantId: string, body: ProviderKeyCreate, opts?: AdminRequestOptions): Promise<ProviderKey> =>
      unwrap(this.raw.POST('/api/v1/tenants/{tenantId}/provider-keys', { ...opts, params: { path: { tenantId } }, body })),
    /** Deletes the credential; the server crypto-shreds the secret. */
    delete: async (tenantId: string, keyId: string, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(
        this.raw.DELETE('/api/v1/tenants/{tenantId}/provider-keys/{keyId}', {
          ...opts,
          params: { path: { tenantId, keyId } },
        }),
      );
    },
  };

  readonly models = {
    list: (opts?: AdminRequestOptions): Promise<RegistryModel[]> => unwrap(this.raw.GET('/api/v1/models', { ...opts })),
    /**
     * Register a model, e.g. an open model served on-prem. Often a (reviewed) suggestion from
     * `providers.discover()`. Throws a 409 `CalibanAPIError` if the id exists.
     */
    create: (body: ModelCreate, opts?: AdminRequestOptions): Promise<RegistryModel> =>
      unwrap(this.raw.POST('/api/v1/models', { ...opts, body })),
    /**
     * Remove a model from the catalogue (409 if a route still uses it). Ids such as
     * `local/qwen3-8b` are sent with the slash unescaped.
     */
    delete: async (modelId: string, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(
        this.raw.DELETE('/api/v1/models/{modelId}', {
          ...opts,
          params: { path: { modelId } },
          pathSerializer: modelIdPathSerializer,
        }),
      );
    },
  };

  /** Shared model servers (on-prem pools such as vLLM, SGLang, llama.cpp, Ollama). */
  readonly providers = {
    list: (opts?: AdminRequestOptions): Promise<SharedProvider[]> =>
      unwrap(this.raw.GET('/api/v1/providers', { ...opts })),
    /** Register a shared model server. `api_key` is write-only and sealed at rest. */
    create: (body: SharedProviderCreate, opts?: AdminRequestOptions): Promise<SharedProvider> =>
      unwrap(this.raw.POST('/api/v1/providers', { ...opts, body })),
    /** Remove a shared model server (409 if models still use it). */
    delete: async (providerId: string, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(this.raw.DELETE('/api/v1/providers/{providerId}', { ...opts, params: { path: { providerId } } }));
    },
    /** Probe the server's `/models` endpoint. */
    health: (providerId: string, opts?: AdminRequestOptions): Promise<ProviderHealth> =>
      unwrap(this.raw.GET('/api/v1/providers/{providerId}/health', { ...opts, params: { path: { providerId } } })),
    /**
     * List the models the server serves and get catalogue suggestions (`ModelCreate` bodies) for
     * the ones not registered yet. Suggestions are heuristic: review them, then pass the ones you
     * want to `models.create()`.
     */
    discover: (providerId: string, opts?: AdminRequestOptions): Promise<ModelDiscovery> =>
      unwrap(this.raw.POST('/api/v1/providers/{providerId}/discover', { ...opts, params: { path: { providerId } } })),
  };

  readonly datasources = {
    list: (query: { tenant_id?: string } = {}, opts?: AdminRequestOptions): Promise<Datasource[]> =>
      unwrap(this.raw.GET('/api/v1/datasources', { ...opts, params: { query } })),
    create: (body: DatasourceCreate, opts?: AdminRequestOptions): Promise<Datasource> =>
      unwrap(this.raw.POST('/api/v1/datasources', { ...opts, body })),
    /**
     * Permanently delete a datasource of `tenantId`; its stored connection settings are wiped and
     * its name can be used again. Throws a 404 `CalibanAPIError` if it is unknown, belongs to
     * another tenant or is already deleted.
     */
    delete: async (tenantId: string, datasourceId: string, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(
        this.raw.DELETE('/api/v1/tenants/{tenantId}/datasources/{datasourceId}', {
          ...opts,
          params: { path: { tenantId, datasourceId } },
        }),
      );
    },
    /**
     * Start the ontology bootstrap (`202`): connect with the datasource's credentials, check the
     * principal is read only, sample every collection and write proposals (`status: 'proposed'`) in
     * one ontology version. Elements a human already reviewed, and unchanged ones, are skipped.
     * MongoDB only. Resolves to the `job_id` and the `job`; follow it with `introspection()`. A 409
     * while a job of the datasource runs, on any replica.
     */
    introspect: (datasourceId: string, opts?: AdminRequestOptions): Promise<IntrospectStarted> =>
      unwrap(
        this.raw.POST('/api/v1/datasources/{datasourceId}/introspect', { ...opts, params: { path: { datasourceId } } }),
      ),
    /**
     * The newest introspection job of the datasource (`running`, `succeeded` or `failed`, with the
     * counts and the ontology `version` it wrote). Jobs are stored, so every control-plane replica
     * answers; a job whose control plane stopped before it ended shows as `failed` once it is older
     * than the job timeout (10 minutes) and a minute, and may be started again. A 404
     * `CalibanAPIError` when there is none.
     */
    introspection: (datasourceId: string, opts?: AdminRequestOptions): Promise<IntrospectionJob> =>
      unwrap(
        this.raw.GET('/api/v1/datasources/{datasourceId}/introspection', { ...opts, params: { path: { datasourceId } } }),
      ),
  };

  readonly ontology = {
    /**
     * The tenant's current ontology (Caliban Semantic Model). `tenant_id` is required: element ids
     * are per tenant, and the server answers `400` without it.
     */
    get: (query: { tenant_id: string }, opts?: AdminRequestOptions): Promise<Ontology> =>
      unwrap(this.raw.GET('/api/v1/ontology', { ...opts, params: { query } })) as Promise<Ontology>,
    /**
     * Approve, reject or deprecate one element of the tenant named in `body.tenant_id` (required:
     * element ids are per tenant). Withdrawing an approved element a published node version's fixed
     * query touches throws a {@link CalibanOntologyBreakingError} (409, `ontology_breaking_change`)
     * listing them, unless `acknowledge_breaking: true`.
     */
    review: (elementId: string, body: OntologyReview, opts?: AdminRequestOptions): Promise<OntologyElement> =>
      unwrap(
        this.raw.POST('/api/v1/ontology/elements/{elementId}/review', { ...opts, params: { path: { elementId } }, body }),
      ) as Promise<OntologyElement>,
    /**
     * Review many of the tenant's elements as one new ontology version (`ontology.review`). A
     * breaking change (see `review()`) throws a {@link CalibanOntologyBreakingError} unless
     * `acknowledge_breaking: true`; the result lists the `breaking` changes acknowledged.
     */
    reviewBatch: (tenantId: string, body: OntologyBatchReview, opts?: AdminRequestOptions): Promise<OntologyBatchReviewResult> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/ontology/review', { ...opts, params: { path: { tenantId } }, body }),
      ) as Promise<OntologyBatchReviewResult>,
    /**
     * Propose elements made outside Caliban (an exported model, a curated file): written as
     * `proposed` in one version for a human to review (`status` may be left out; it is ignored).
     * An element whose spec, name and description match the tenant's is skipped, so posting the
     * same model again writes no version and keeps every review decision. A changed element goes
     * back to `proposed`: over an approved element that withdraws it until it is approved again,
     * and throws a {@link CalibanOntologyBreakingError} (409) when published node versions query
     * it, unless `acknowledge_breaking: true`. A 400 for an empty batch, more than 5000 elements,
     * or an empty, too long or repeated id.
     */
    propose: (tenantId: string, body: OntologyProposals, opts?: AdminRequestOptions): Promise<OntologyProposalResult> =>
      unwrap(this.raw.POST('/api/v1/tenants/{tenantId}/ontology/proposals', { ...opts, params: { path: { tenantId } }, body })),
  };

  /**
   * The tenant's `caliban/auto` intents (kNN exemplars). Set here, they override the config
   * file intent by intent; routers rebuild their index with the next snapshot, without a restart.
   */
  readonly intents = {
    /** Every intent as routers use it, with its `source` and node; `removed`: file intents an empty list removes (`routes.read`). */
    list: (tenantId: string, opts?: AdminRequestOptions): Promise<TenantIntents> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/intents', { ...opts, params: { path: { tenantId } } })),
    /**
     * Set the tenant's exemplars of an intent (`PUT`, `routes.write`; audited as `tenant.intent.set`
     * with counts, never the texts). At most 100 intents per tenant and 200 exemplars per intent,
     * each 1 to 2000 characters; an empty list removes a config-file intent for the tenant. The
     * intent name is 1 to 64 characters of `[a-z0-9_.-]`; `pinned` is reserved (a 400), and an
     * unknown tenant is a 404.
     */
    put: (tenantId: string, intent: string, exemplars: string[], opts?: AdminRequestOptions): Promise<TenantIntentSet> =>
      unwrap(
        this.raw.PUT('/api/v1/tenants/{tenantId}/intents/{intent}', {
          ...opts,
          params: { path: { tenantId, intent } },
          body: { exemplars },
        }),
      ),
    /** Drop the tenant's own exemplars of an intent; the config file's apply again (audited as `tenant.intent.delete`). */
    delete: async (tenantId: string, intent: string, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(
        this.raw.DELETE('/api/v1/tenants/{tenantId}/intents/{intent}', { ...opts, params: { path: { tenantId, intent } } }),
      );
    },
  };

  /**
   * Nodes and their versions. A version is created as a `draft`, `publish()`ed (sealed and shipped to
   * routers and workers), made live with `promote()` (or by `publish()` itself), and `retire()`d.
   * Versions are immutable: changing a node means creating a new version.
   */
  readonly nodes = {
    /** Every version of every node (with its spec). */
    list: (query: { tenant_id?: string } = {}, opts?: AdminRequestOptions): Promise<Node[]> =>
      unwrap(this.raw.GET('/api/v1/nodes', { ...opts, params: { query } })) as Promise<Node[]>,
    /** One entry per node, without specs: its live version, its latest version and state, version counts. */
    summaries: (query: { tenant_id?: string } = {}, opts?: AdminRequestOptions): Promise<NodeSummary[]> =>
      unwrap(this.raw.GET('/api/v1/nodes', { ...opts, params: { query: { ...query, view: 'summary' as const } } })) as Promise<
        NodeSummary[]
      >,
    /** Every version of a node not deleted (drafts, published, retired), oldest first, and the `live` one (`nodes.read`). */
    versions: (tenantId: string, nodeName: string, opts?: AdminRequestOptions): Promise<NodeVersions> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions', {
          ...opts,
          params: { path: { tenantId, nodeName } },
        }),
      ),
    /** One version, with its spec and content hash. A 404 `CalibanAPIError` if there is none. */
    getVersion: (tenantId: string, nodeName: string, version: number, opts?: AdminRequestOptions): Promise<Node> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
        }),
      ),
    /**
     * Create a draft version numbered the node's latest plus one (`nodes.write`; audited as
     * `node.create`). The spec is checked statically and content-hashed; problems throw a 422
     * `CalibanAPIError`. The same as `create()` with the tenant and name in the path.
     */
    createVersion: (tenantId: string, nodeName: string, spec: NodeSpec, opts?: AdminRequestOptions): Promise<Node> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions', {
          ...opts,
          params: { path: { tenantId, nodeName } },
          body: { spec: spec as unknown as Schemas['NodeCreate']['spec'] },
        }),
      ),
    /**
     * Publish a draft (`nodes.publish`; audited as `node.publish`): it is validated against the
     * tenant, sealed and shipped in the signed snapshot. With `promote` (default `true`) it also
     * becomes live, which needs the node's promotion bar met: a version with write tools (or a node
     * with a golden bar) is refused with a 422 (problems of kind `eval_gate`) since a draft has no
     * evals yet. Publish it with `{ promote: false }`, run its evals, then `promote()` it. A version
     * that is not a draft is a 409; a validation failure a 422 listing every problem.
     */
    publish: (
      tenantId: string,
      nodeName: string,
      version: number,
      body: NodePublish = {},
      opts?: AdminRequestOptions,
    ): Promise<Node> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/publish', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
          body,
        }),
      ),
    /**
     * Make a published version the live one, or roll back to an earlier one (`nodes.publish`;
     * audited as `node.promote`). Its budgets must fit the tenant's `node_caps` and its latest
     * finished evals must meet the promotion bar, its pinned subnodes' too (a 422 with problems of
     * kind `eval_gate`; `evals.gate()` says the same in advance). A draft or retired version is a 409.
     */
    promote: (tenantId: string, nodeName: string, version: number, opts?: AdminRequestOptions): Promise<Node> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/nodes/{nodeName}/promote', {
          ...opts,
          params: { path: { tenantId, nodeName } },
          body: { version },
        }),
      ),
    /**
     * Retire a published version, for good (`nodes.publish`; audited as `node.retire`). New runs of
     * it are refused; runs already started finish on it. If it was live, the node has no live
     * version until another is promoted. A version another published version still calls is a 409.
     */
    retire: (tenantId: string, nodeName: string, version: number, opts?: AdminRequestOptions): Promise<Node> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/retire', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
        }),
      ),
    /** Two versions' hashes and a structural diff of their specs (JSON pointers; arrays index by index). */
    diff: (tenantId: string, nodeName: string, from: number, to: number, opts?: AdminRequestOptions): Promise<NodeDiff> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/nodes/{nodeName}/diff', {
          ...opts,
          params: { path: { tenantId, nodeName }, query: { from, to } },
        }),
      ),
    /** Create a new node version. The server validates `spec` against node.schema.json. */
    create: (body: NodeCreate, opts?: AdminRequestOptions): Promise<Node> =>
      unwrap(
        this.raw.POST('/api/v1/nodes', {
          ...opts,
          body: { ...body, spec: body.spec as unknown as Schemas['NodeCreate']['spec'] },
        }),
      ),
    /**
     * Permanently delete one node version of `tenantId`; its version number is not reused.
     * Throws a 404 `CalibanAPIError` if it is unknown, belongs to another tenant or is already deleted.
     */
    delete: async (tenantId: string, nodeId: string, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(
        this.raw.DELETE('/api/v1/tenants/{tenantId}/nodes/{nodeId}', { ...opts, params: { path: { tenantId, nodeId } } }),
      );
    },
  };

  /** The golden set of a node version: the cases its golden evals run. Needs a node journal (else 503). */
  readonly goldenSets = {
    /** Metadata with `nodes.read`; `cases` too with `runs.data` (`content_visible`). */
    get: (tenantId: string, nodeName: string, version: number, opts?: AdminRequestOptions): Promise<GoldenSet> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/golden-set', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
        }),
      ) as Promise<GoldenSet>,
    /**
     * Create or replace the golden set (`PUT`, retried like a GET). Inputs are checked against the
     * version's `prompt.input_schema`; problems throw a 422 `CalibanAPIError`. Audited as
     * `node.golden_set.update` (counts and hashes, never cases).
     */
    put: (
      tenantId: string,
      nodeName: string,
      version: number,
      body: GoldenSetPut,
      opts?: AdminRequestOptions,
    ): Promise<GoldenSet> =>
      unwrap(
        this.raw.PUT('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/golden-set', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
          body: body as { cases: Schemas['GoldenCase'][] },
        }),
      ) as Promise<GoldenSet>,
    /** Audited as `node.golden_set.delete`. Throws a 404 `CalibanAPIError` if there is none. */
    delete: async (tenantId: string, nodeName: string, version: number, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(
        this.raw.DELETE('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/golden-set', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
        }),
      );
    },
  };

  /** A node's promotion bar: what its versions' evals must reach before a version is promoted. */
  readonly evalPolicy = {
    get: (tenantId: string, nodeName: string, opts?: AdminRequestOptions): Promise<EvalPolicyView> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/nodes/{nodeName}/eval-policy', {
          ...opts,
          params: { path: { tenantId, nodeName } },
        }),
      ),
    /** Set the bar (`PUT`, needs `nodes.publish`; audited as `node.eval_policy.update`). Resolves to the bar now in effect. */
    put: (tenantId: string, nodeName: string, policy: EvalPolicy, opts?: AdminRequestOptions): Promise<EvalPolicyView> =>
      unwrap(
        this.raw.PUT('/api/v1/tenants/{tenantId}/nodes/{nodeName}/eval-policy', {
          ...opts,
          params: { path: { tenantId, nodeName } },
          body: policy,
        }),
      ),
  };

  /** Evals of published node versions: the golden suite (pass^k, cost per success) and the injection suite. */
  readonly evals = {
    /**
     * Start an eval of a published version (`202`; a version that is not published is a 409).
     * Trials run as ordinary node runs on workers, as the tenant's eval key unless `api_key_id`
     * names an API key of the tenant (active, allowed to run the node).
     */
    start: (tenantId: string, nodeName: string, version: number, body: EvalStart, opts?: AdminRequestOptions): Promise<Eval> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/evals', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
          body,
        }),
      ),
    /** The tenant's evals, newest first (metrics, never content). One page; follow `next_cursor`. */
    list: (tenantId: string, query: EvalListQuery = {}, opts?: AdminRequestOptions): Promise<EvalList> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/evals', { ...opts, params: { path: { tenantId }, query } })),
    /**
     * An eval with its trials (each trial's `detail` only with `runs.data`). Works in flight: a
     * running eval has no `summary` yet, and its running trials an empty verdict.
     */
    get: (tenantId: string, evalId: string, opts?: AdminRequestOptions): Promise<Eval> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/evals/{evalId}', { ...opts, params: { path: { tenantId, evalId } } }),
      ) as Promise<Eval>,
    /** The trials of an eval (`get()` and its `trials`). */
    trials: async (tenantId: string, evalId: string, opts?: AdminRequestOptions): Promise<EvalTrial[]> =>
      (await this.evals.get(tenantId, evalId, opts)).trials ?? [],
    /**
     * Cancel an eval: a pending one ends at once (`status: 'cancelled'`), a running one stops at its
     * worker's next check (`cancel_requested: true`). Throws a 409 `CalibanAPIError` if it ended otherwise.
     */
    cancel: (tenantId: string, evalId: string, opts?: AdminRequestOptions): Promise<Eval> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/evals/{evalId}/cancel', { ...opts, params: { path: { tenantId, evalId } } }),
      ),
    /** What promoting the version would say against the node's promotion bar. */
    gate: (tenantId: string, nodeName: string, version: number, opts?: AdminRequestOptions): Promise<EvalGate> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/gate', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
        }),
      ),
  };

  /**
   * The tenant's eval key: an API key the control plane creates (on the first eval that names no
   * key) and manages for the tenant's evals. Its plaintext is never returned; the data plane
   * refuses it on its endpoints. `apiKeys.revoke()` on it is a 409: rotate it instead.
   */
  readonly evalKey = {
    /** `key` is null before the tenant's first eval that names no key. */
    get: (tenantId: string, opts?: AdminRequestOptions): Promise<EvalKey> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/eval-key', { ...opts, params: { path: { tenantId } } })),
    /**
     * Revoke the eval key and create a new one (needs `api_keys.write`). Evals in flight lose
     * their key: rotate between evals.
     */
    rotate: (tenantId: string, opts?: AdminRequestOptions): Promise<EvalKeyRotation> =>
      unwrap(this.raw.POST('/api/v1/tenants/{tenantId}/eval-key/rotate', { ...opts, params: { path: { tenantId } } })),
  };

  /**
   * A tenant's node runs, as the console sees them (needs a node journal, else 503). Answers and
   * cancellations are recorded with the caller's identity in the audit chain.
   */
  readonly runs = {
    /** One page, newest first (`runs.read`). Pass `next_cursor` as `cursor` for the next. */
    list: (tenantId: string, query: ConsoleRunListQuery = {}, opts?: AdminRequestOptions): Promise<ConsoleRunList> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/runs', { ...opts, params: { path: { tenantId }, query } })),
    /**
     * Status, budget, cost (`cost_usd` billed, `model_cost_usd` the routed models' real cost), usage,
     * the answer guard's `answer_check` and steps (`runs.read`); content too with `runs.data` (`content_visible`).
     */
    get: (tenantId: string, runId: string, opts?: AdminRequestOptions): Promise<ConsoleRun> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/runs/{runId}', { ...opts, params: { path: { tenantId, runId } } })),
    /**
     * Answer a question, or approve (`{ approve: true }`) or deny (`{ approve: false }`) a gated
     * call (`runs.answer`; audited as `node.run.answer`, `node.write.approve` or `node.write.deny`).
     * Throws a 409 `CalibanAPIError` if the run is not waiting (or not for `step`).
     */
    input: (tenantId: string, runId: string, body: ConsoleRunInput, opts?: AdminRequestOptions): Promise<ConsoleRun> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/runs/{runId}/input', { ...opts, params: { path: { tenantId, runId } }, body }),
      ),
    /**
     * Cancel a run (`runs.answer`; audited as `node.run.cancel`). A waiting run ends at once; a
     * running one stops at its next step (`cancel_requested: true`). Throws a 409 `CalibanAPIError`
     * (`run_already_ended`) if it ended otherwise.
     */
    cancel: (tenantId: string, runId: string, opts?: AdminRequestOptions): Promise<ConsoleRun> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/runs/{runId}/cancel', { ...opts, params: { path: { tenantId, runId } } }),
      ),
    /**
     * Turn a finished run into a golden case ("save this run as a test"; `nodes.write`, audited as
     * `node.golden_set.capture`). The case (id: the run id) takes the run's input and its human
     * answers; `good` adds an `llm_judge` check with the run's output as `reference` and a
     * `tool_call` check per write it made, `bad` an `llm_judge` check whose rubric is the `note`.
     * A `mast_label` is stored on the run. A 409 if the run has not finished or is already in the
     * set; a 422 for `good` on a run that did not succeed, `bad` without a note, or a label on `good`.
     */
    captureGoldenCase: (
      tenantId: string,
      runId: string,
      body: GoldenCaseCapture,
      opts?: AdminRequestOptions,
    ): Promise<CapturedGoldenCase> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/runs/{runId}/golden-case', {
          ...opts,
          params: { path: { tenantId, runId } },
          body,
        }),
      ) as Promise<CapturedGoldenCase>,
  };

  /** Runs waiting for a human: questions and approvals of gated calls. */
  readonly inbox = {
    /** Oldest wait first (`runs.read`; questions and approval `arguments` with `runs.data`). */
    list: (tenantId: string, opts?: AdminRequestOptions): Promise<Inbox> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/inbox', { ...opts, params: { path: { tenantId } } })),
  };

  /**
   * Document collections nodes search with `builtin://rag_search` (scope `rag.<name>:read`). Needs
   * a document registry on the control plane, else 503.
   */
  readonly rag = {
    /** The embedding and rerank models the tenant can reach, to pick a collection's models from (`rag.read`). */
    models: (tenantId: string, opts?: AdminRequestOptions): Promise<RagModels> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/rag/models', { ...opts, params: { path: { tenantId } } })),
    collections: {
      /** The tenant's collections, each with `document_counts` per status. */
      list: (tenantId: string, opts?: AdminRequestOptions): Promise<RagCollection[]> =>
        unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/rag/collections', { ...opts, params: { path: { tenantId } } })),
      /** Create a collection; `embedding_model` is fixed for its life. Audited as `rag.collection.create`. */
      create: (tenantId: string, body: RagCollectionCreate, opts?: AdminRequestOptions): Promise<RagCollection> =>
        unwrap(this.raw.POST('/api/v1/tenants/{tenantId}/rag/collections', { ...opts, params: { path: { tenantId } }, body })),
      /** A collection with `used_by`: the published node versions that search it. */
      get: (tenantId: string, collection: string, opts?: AdminRequestOptions): Promise<RagCollectionDetail> =>
        unwrap(
          this.raw.GET('/api/v1/tenants/{tenantId}/rag/collections/{collection}', {
            ...opts,
            params: { path: { tenantId, collection } },
          }),
        ),
      /** Delete a collection and its documents. A 409 `CalibanAPIError` while a published node version names it. */
      delete: async (tenantId: string, collection: string, opts?: AdminRequestOptions): Promise<void> => {
        await unwrap(
          this.raw.DELETE('/api/v1/tenants/{tenantId}/rag/collections/{collection}', {
            ...opts,
            params: { path: { tenantId, collection } },
          }),
        );
      },
    },
    documents: {
      /** One page of documents (newest version of each, with `live_version`); follow `next_cursor`. Never the content. */
      list: (
        tenantId: string,
        collection: string,
        query: RagDocumentListQuery = {},
        opts?: AdminRequestOptions,
      ): Promise<RagDocumentList> =>
        unwrap(
          this.raw.GET('/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents', {
            ...opts,
            params: { path: { tenantId, collection }, query },
          }),
        ),
      /**
       * Ingest a version of `doc_id` (`202`, `pending` and invisible until indexed and vetted; an
       * untrusted one fails at `vet_deadline_at` if its checks have not passed). The same content
       * again resolves to the newest version with `unchanged: true`. Retried on 429/503 only.
       */
      ingest: (tenantId: string, collection: string, body: RagDocumentIngest, opts?: AdminRequestOptions): Promise<RagIngestResult> =>
        unwrap(
          this.raw.POST('/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents', {
            ...opts,
            params: { path: { tenantId, collection } },
            body,
          }),
        ),
      /** Every version of a document, newest first, with its status, `findings` and `vet_deadline_at`. */
      get: (tenantId: string, collection: string, docId: string, opts?: AdminRequestOptions): Promise<RagDocumentVersions> =>
        unwrap(
          this.raw.GET('/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents/{docId}', {
            ...opts,
            params: { path: { tenantId, collection, docId } },
          }),
        ),
      /** Delete every version; it stops being served at once and its sealed content is wiped. */
      delete: async (tenantId: string, collection: string, docId: string, opts?: AdminRequestOptions): Promise<void> => {
        await unwrap(
          this.raw.DELETE('/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents/{docId}', {
            ...opts,
            params: { path: { tenantId, collection, docId } },
          }),
        );
      },
      /**
       * Release a quarantined version (`rag.approve`): a decision about its findings, so
       * `acknowledge_findings` must be `true`. It goes back to `pending` and is indexed again;
       * its text stays labelled `retrieved` in node runs.
       */
      release: (
        tenantId: string,
        collection: string,
        docId: string,
        body: RagRelease,
        opts?: AdminRequestOptions,
      ): Promise<RagDocument> =>
        unwrap(
          this.raw.POST('/api/v1/tenants/{tenantId}/rag/collections/{collection}/documents/{docId}/release', {
            ...opts,
            params: { path: { tenantId, collection, docId } },
            body,
          }),
        ),
    },
  };

  readonly usage = {
    get: (query: { tenant_id?: string; limit?: number } = {}, opts?: AdminRequestOptions): Promise<UsageReport> =>
      unwrap(this.raw.GET('/api/v1/usage', { ...opts, params: { query } })),
    /**
     * What the tenant's node runs spent today and this month (UTC) next to its `node_spend_caps`,
     * what remains (`null`: no cap) and whether a cap is reached (`usage.read`; 503 without a node journal).
     */
    nodeSpend: (tenantId: string, opts?: AdminRequestOptions): Promise<NodeSpend> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/node-spend', { ...opts, params: { path: { tenantId } } })),
  };
}
