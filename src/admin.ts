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
export type Health = Schemas['Health'];
/** `NodeCreate` with `spec` typed against node.schema.json instead of a free-form object. */
export type NodeCreate = Omit<Schemas['NodeCreate'], 'spec'> & { spec: NodeSpec };

export const DEFAULT_CONTROL_PLANE_URL = 'http://localhost:8081';

export interface CalibanAdminOptions {
  /** Admin bearer token. Defaults to `CALIBAN_ADMIN_TOKEN`. */
  token?: string;
  /** Control-plane origin **without** `/api/v1`. Defaults to `CALIBAN_ADMIN_URL` or `http://localhost:8081`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retry policy; `false` disables. Default: 2 retries on 429/502/503. */
  retry?: RetryOptions | false;
  /** Per-attempt timeout (including body read). Default 60 000 ms. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface AdminRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
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
    list: (opts?: AdminRequestOptions): Promise<Tenant[]> => unwrap(this.raw.GET('/api/v1/tenants', { ...opts })),
    create: (body: TenantCreate, opts?: AdminRequestOptions): Promise<Tenant> =>
      unwrap(this.raw.POST('/api/v1/tenants', { ...opts, body })),
    get: (tenantId: string, opts?: AdminRequestOptions): Promise<Tenant> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}', { ...opts, params: { path: { tenantId } } })),
  };

  readonly apiKeys = {
    list: (tenantId: string, opts?: AdminRequestOptions): Promise<ApiKeyInfo[]> =>
      unwrap(this.raw.GET('/api/v1/tenants/{tenantId}/api-keys', { ...opts, params: { path: { tenantId } } })),
    /** Mint a key. `key` (plaintext) is returned exactly once: store it now. */
    create: (tenantId: string, body: { name?: string } = {}, opts?: AdminRequestOptions): Promise<ApiKeyCreated> =>
      unwrap(this.raw.POST('/api/v1/tenants/{tenantId}/api-keys', { ...opts, params: { path: { tenantId } }, body })),
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
    list: (query: { tenant_id?: string } = {}, opts?: AdminRequestOptions): Promise<Node[]> =>
      unwrap(this.raw.GET('/api/v1/nodes', { ...opts, params: { query } })),
    /** Create a new node version. The server validates `spec` against node.schema.json. */
    create: (body: NodeCreate, opts?: AdminRequestOptions): Promise<Node> =>
      unwrap(
        this.raw.POST('/api/v1/nodes', {
          ...opts,
          body: { ...body, spec: body.spec as unknown as Schemas['NodeCreate']['spec'] },
        }),
      ),
  };

  readonly usage = {
    get: (query: { tenant_id?: string; limit?: number } = {}, opts?: AdminRequestOptions): Promise<UsageReport> =>
      unwrap(this.raw.GET('/api/v1/usage', { ...opts, params: { query } })),
  };
}
