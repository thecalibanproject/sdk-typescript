import createClient, { type Client } from 'openapi-fetch';
import { CalibanError, errorFromBody } from './errors.js';
import type { components, paths } from './generated/schema.js';
import { readEnv, resolveFetch, trimTrailingSlash } from './internal/env.js';
import { createRetryingFetch } from './internal/http.js';
import type { NodeSpec } from './node.js';
import { resolveRetryPolicy, type RetryOptions } from './retry.js';

type Schemas = components['schemas'];
export type Tenant = Schemas['Tenant'];
export type TenantCreate = Schemas['TenantCreate'];
/** Body for `tenants.update()` (contract: `TenantUpdate`). Absent fields keep their value. */
export type TenantUpdate = Schemas['TenantUpdate'];
/** `pii_surrogate_scope`: `tenant` (default, linkable within the tenant) or `session` (fresh per request). */
export type PiiSurrogateScope = NonNullable<Tenant['pii_surrogate_scope']>;
/** `semantic_cache` tenant setting: `off` (default) or `on`. */
export type SemanticCacheSetting = NonNullable<Tenant['semantic_cache']>;
export type ApiKeyInfo = Schemas['ApiKeyInfo'];
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
export type DatasourceCreate = Schemas['DatasourceCreate'];
export type Ontology = Schemas['Ontology'];
export type OntologyElement = Schemas['OntologyElement'];
export type OntologyElementKind = Schemas['OntologyElementKind'];
export type OntologyReview = NonNullable<
  paths['/api/v1/ontology/elements/{elementId}/review']['post']['requestBody']
>['content']['application/json'];
export type Node = Schemas['Node'];
export type UsageReport = Schemas['UsageReport'];
export type UsageEvent = Schemas['UsageEvent'];
/** `UsageReport.totals`. */
export type UsageTotals = UsageReport['totals'];
export type Health = Schemas['Health'];
/** `NodeCreate` with `spec` typed against node.schema.json instead of a free-form object. */
export type NodeCreate = Omit<Schemas['NodeCreate'], 'spec'> & { spec: NodeSpec };

// ── Node evals (golden sets, promotion bar, evals, the gate) ──
// The generator renders an object schema without properties as `Record<string, never>`; the
// types below widen those spots (a check's JSON Schema, an eval's metrics, a trial's verdict,
// the gate's problems) to `Record<string, unknown>`.

type ContractCheck = Schemas['EvalCheck'];
/**
 * A check of a golden case's run output (contract: `EvalCheck`): `exact`, `contains`, `regex`,
 * `json_schema` or `llm_judge`. Text checks see the output as text (a string as is, other JSON compact).
 */
export type EvalCheck =
  | Exclude<ContractCheck, { type: 'json_schema' }>
  | (Omit<Extract<ContractCheck, { type: 'json_schema' }>, 'schema'> & { schema: Record<string, unknown> });
/** One golden case (contract: `GoldenCase`). `expected` is shorthand for an `exact` check. */
export type GoldenCase = Omit<Schemas['GoldenCase'], 'checks'> & { checks?: EvalCheck[] };
/** A version's golden set (contract: `GoldenSet`). `cases` only when `content_visible` (the caller holds `runs.data`). */
export type GoldenSet = Omit<Schemas['GoldenSet'], 'cases'> & { cases?: GoldenCase[] };
/** Body of `goldenSets.put()`: at most 200 cases, unique ids, at least one check each. */
export interface GoldenSetPut {
  cases: GoldenCase[];
}
/** A node's promotion bar (contract: `EvalPolicy`). */
export type EvalPolicy = Schemas['EvalPolicy'];
/** Result of `evalPolicy.get()`: the bar, and `injection_bar`, the bar in effect for versions with write tools. */
export type EvalPolicyInfo =
  paths['/api/v1/tenants/{tenantId}/nodes/{nodeName}/eval-policy']['get']['responses'][200]['content']['application/json'];
export type EvalSuite = Schemas['Eval']['suite'];
export type EvalStatus = Schemas['Eval']['status'];
type ContractTrial = NonNullable<Schemas['Eval']['trials']>[number];
/** One trial of an eval: a case's run. `detail` only with `runs.data`. */
export type EvalTrial = Omit<ContractTrial, 'verdict'> & { verdict?: Record<string, unknown> };
/**
 * An eval of a node version (contract: `Eval`). `summary` holds metrics only (golden: `pass_hat_k`,
 * `pass_at_1`, `cost_per_success_usd`, `latency_ms`, ...; injection: `pass_rate`,
 * `attack_success_rate`, `by_category`, ...); `trials` only on `evals.get()`.
 */
export type Eval = Omit<Schemas['Eval'], 'summary' | 'trials'> & {
  summary?: Record<string, unknown> | null;
  trials?: EvalTrial[];
};
type ContractEvalStart = NonNullable<
  paths['/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/evals']['post']['requestBody']
>['content']['application/json'];
/**
 * Body of `evals.start()`. `api_key_id` is optional here although the current contract requires
 * it: core is moving evals to a per-tenant eval key the control plane manages. Until a server
 * does, pass the id of an active API key of the tenant that may run the node (its quotas apply
 * and its usage is the eval's); a server that needs it and does not get one answers `422`.
 */
export type EvalStart = Omit<ContractEvalStart, 'api_key_id'> & { api_key_id?: string };
/** Query of `evals.list()`. `status` is comma separated. */
export type EvalListQuery = NonNullable<
  paths['/api/v1/tenants/{tenantId}/evals']['get']['parameters']['query']
>;
/** A page of `evals.list()`; pass `next_cursor` as `cursor` for the next one (`null` on the last). */
export type EvalList = Omit<
  paths['/api/v1/tenants/{tenantId}/evals']['get']['responses'][200]['content']['application/json'],
  'data'
> & { data?: Eval[] };
type ContractGate =
  paths['/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/gate']['get']['responses'][200]['content']['application/json'];
/** What promoting a version would say: `allowed`, the evals that meet the bar (`evidence`), or the `problems`. */
export type EvalGate = Omit<ContractGate, 'problems'> & { problems?: Record<string, unknown>[] };

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
    /** A deleted tenant is a 404. */
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
     * `CalibanAPIError` if the key is unknown, belongs to another tenant or is already revoked.
     */
    revoke: async (tenantId: string, keyId: string, opts?: AdminRequestOptions): Promise<void> => {
      await unwrap(
        this.raw.DELETE('/api/v1/tenants/{tenantId}/api-keys/{keyId}', { ...opts, params: { path: { tenantId, keyId } } }),
      );
    },
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
    /** Start an introspect/profile job that proposes ontology elements. Returns the job id. */
    introspect: (datasourceId: string, opts?: AdminRequestOptions): Promise<{ job_id?: string }> =>
      unwrap(
        this.raw.POST('/api/v1/datasources/{datasourceId}/introspect', { ...opts, params: { path: { datasourceId } } }),
      ),
  };

  readonly ontology = {
    get: (query: { tenant_id?: string } = {}, opts?: AdminRequestOptions): Promise<Ontology> =>
      unwrap(this.raw.GET('/api/v1/ontology', { ...opts, params: { query } })),
    /** Approve or reject a proposed ontology element. */
    review: (elementId: string, body: OntologyReview, opts?: AdminRequestOptions): Promise<OntologyElement> =>
      unwrap(
        this.raw.POST('/api/v1/ontology/elements/{elementId}/review', { ...opts, params: { path: { elementId } }, body }),
      ),
  };

  readonly nodes = {
    /** Every version of every node (with its spec). */
    list: (query: { tenant_id?: string } = {}, opts?: AdminRequestOptions): Promise<Node[]> =>
      unwrap(this.raw.GET('/api/v1/nodes', { ...opts, params: { query } })) as Promise<Node[]>,
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
    get: (tenantId: string, nodeName: string, opts?: AdminRequestOptions): Promise<EvalPolicyInfo> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/nodes/{nodeName}/eval-policy', {
          ...opts,
          params: { path: { tenantId, nodeName } },
        }),
      ),
    /**
     * Set the bar (`PUT`, needs `nodes.publish`; audited as `node.eval_policy.update`). Resolves to
     * the stored bar as `get()` returns it, or `undefined` from a server that answers without a body
     * (the contract does not promise one).
     */
    put: (
      tenantId: string,
      nodeName: string,
      policy: EvalPolicy,
      opts?: AdminRequestOptions,
    ): Promise<EvalPolicyInfo | undefined> =>
      unwrap(
        this.raw.PUT('/api/v1/tenants/{tenantId}/nodes/{nodeName}/eval-policy', {
          ...opts,
          params: { path: { tenantId, nodeName } },
          body: policy,
        }),
      ) as Promise<EvalPolicyInfo | undefined>,
  };

  /** Evals of published node versions: the golden suite (pass^k, cost per success) and the injection suite. */
  readonly evals = {
    /**
     * Start an eval of a published version (`202`; a version that is not published is a 409).
     * Trials run as ordinary node runs on workers. See {@link EvalStart} for `api_key_id`.
     */
    start: (tenantId: string, nodeName: string, version: number, body: EvalStart, opts?: AdminRequestOptions): Promise<Eval> =>
      unwrap(
        this.raw.POST('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/evals', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
          body: body as ContractEvalStart,
        }),
      ) as Promise<Eval>,
    /** The tenant's evals, newest first (metrics, never content). One page; follow `next_cursor`. */
    list: (tenantId: string, query: EvalListQuery = {}, opts?: AdminRequestOptions): Promise<EvalList> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/evals', { ...opts, params: { path: { tenantId }, query } })) as Promise<EvalList>,
    /** An eval with its trials (each trial's `detail` only with `runs.data`). */
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
      ) as Promise<Eval>,
    /** What promoting the version would say against the node's promotion bar. */
    gate: (tenantId: string, nodeName: string, version: number, opts?: AdminRequestOptions): Promise<EvalGate> =>
      unwrap(
        this.raw.GET('/api/v1/tenants/{tenantId}/nodes/{nodeName}/versions/{version}/gate', {
          ...opts,
          params: { path: { tenantId, nodeName, version } },
        }),
      ) as Promise<EvalGate>,
  };

  readonly usage = {
    get: (query: { tenant_id?: string; limit?: number } = {}, opts?: AdminRequestOptions): Promise<UsageReport> =>
      unwrap(this.raw.GET('/api/v1/usage', { ...opts, params: { query } })),
  };
}
