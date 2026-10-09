import { describe, expect, expectTypeOf, it } from 'vitest';
import type { components, paths } from '../src/generated/schema.js';
import type {
  ApiKeyInfo,
  ApiKeyListOptions,
  CacheTier,
  CalibanExtension,
  ChatCompletion,
  ChatCompletionCreateParams,
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
  IntentDecision,
  ModelCalibanInfo,
  ModelCreate,
  ModelDiscovery,
  ModelInfo,
  ModelList,
  PiiSurrogateScope,
  ProviderHealth,
  ReasoningEffort,
  RegistryModel,
  RerankCreateParams,
  RerankResponse,
  RerankResult,
  RouteStage,
  SemanticCacheSetting,
  SharedProvider,
  SharedProviderCreate,
  Tenant,
  TenantListOptions,
  TenantUpdate,
  TrustTier,
  UsageEvent,
  UsageTotals,
} from '../src/index.js';

type Schemas = components['schemas'];
/** Re-map an interface to an anonymous object type so it can meet the contract's open index signature. */
type Plain<T> = { [K in keyof T]: T[K] };
/** Declared property names of T, ignoring any index signature. */
type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

describe('contract alignment (type-level)', () => {
  it('hand-written request params stay assignable to the OpenAPI ChatCompletionRequest', () => {
    // Compile-time assignability: fails `pnpm typecheck` if the params drift from the contract.
    const toContract = (p: Plain<ChatCompletionCreateParams>): Schemas['ChatCompletionRequest'] => p;
    expect(typeof toContract).toBe('function');
    expectTypeOf<CalibanExtension>().toEqualTypeOf<Schemas['CalibanExtension']>();
    expectTypeOf<NonNullable<CalibanExtension['pii']>>().toEqualTypeOf<'off' | 'mask' | 'reversible'>();
    expect(true).toBe(true);
  });

  it('reasoning, embeddings and model types follow the contract', () => {
    expectTypeOf<ReasoningEffort>().toEqualTypeOf<'off' | 'low' | 'medium' | 'high'>();
    expectTypeOf<ReasoningEffort>().toEqualTypeOf<NonNullable<Schemas['CalibanExtension']['reasoning']>>();

    type EmbReq = paths['/v1/embeddings']['post']['requestBody']['content']['application/json'];
    type EmbRes = paths['/v1/embeddings']['post']['responses'][200]['content']['application/json'];
    const embToContract = (p: Plain<EmbeddingCreateParams>): EmbReq => p;
    const embFromContract = (r: CreateEmbeddingResponse): EmbRes => r;
    expectTypeOf<EmbeddingCreateParams['input']>().toEqualTypeOf<EmbReq['input']>();

    // Hand-written response types stay compatible with the contract in both directions where it matters.
    const completionToContract = (c: ChatCompletion): Schemas['ChatCompletionResponse'] => c;
    // Known keys survive the reshaping despite the contract's open index signature.
    expectTypeOf<ChatCompletion['id']>().toEqualTypeOf<string>();
    expectTypeOf<ChatCompletion['object']>().toEqualTypeOf<'chat.completion'>();
    expectTypeOf<NonNullable<ChatCompletion['choices'][number]['message']>['reasoning_content']>().toEqualTypeOf<
      string | null | undefined
    >();
    const modelsToContract = (l: ModelList): paths['/v1/models']['get']['responses'][200]['content']['application/json'] => l;
    expectTypeOf<ModelCalibanInfo['kind']>().toEqualTypeOf<Schemas['ModelKind']>();
    expectTypeOf<ModelCalibanInfo['capabilities']>().toEqualTypeOf<Schemas['ModelCapabilities']>();
    expectTypeOf<ModelCalibanInfo['trust_tier']>().toEqualTypeOf<Schemas['TrustTier']>();
    expectTypeOf<NonNullable<ModelInfo['caliban']>>().toEqualTypeOf<ModelCalibanInfo>();
    expectTypeOf<TrustTier>().toEqualTypeOf<Schemas['TrustTier']>();

    expectTypeOf<RegistryModel>().toEqualTypeOf<Schemas['Model']>();
    expectTypeOf<ModelCreate>().toEqualTypeOf<Schemas['ModelCreate']>();
    expectTypeOf<SharedProvider>().toEqualTypeOf<Schemas['SharedProvider']>();
    expectTypeOf<SharedProviderCreate>().toEqualTypeOf<Schemas['SharedProviderCreate']>();
    expectTypeOf<ModelDiscovery['suggested'][number]>().toEqualTypeOf<Schemas['ModelCreate']>();
    expectTypeOf<ProviderHealth['status']>().toEqualTypeOf<'ok' | 'unreachable'>();
    // The admin endpoints the helpers call exist in the contract.
    expectTypeOf<paths['/api/v1/models/{modelId}']['delete']>().not.toBeNever();
    expectTypeOf<paths['/api/v1/providers/{providerId}/discover']['post']>().not.toBeNever();
    expectTypeOf<paths['/api/v1/tenants/{tenantId}']['delete']>().not.toBeNever();
    expectTypeOf<paths['/api/v1/tenants/{tenantId}/api-keys/{keyId}']['delete']>().not.toBeNever();
    expectTypeOf<paths['/api/v1/tenants/{tenantId}/datasources/{datasourceId}']['delete']>().not.toBeNever();
    expectTypeOf<paths['/api/v1/tenants/{tenantId}/nodes/{nodeId}']['delete']>().not.toBeNever();
    // Soft-delete fields and list options.
    expectTypeOf<Tenant['status']>().toEqualTypeOf<'active' | 'deleted' | undefined>();
    expectTypeOf<Tenant['deleted_at']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ApiKeyInfo['revoked_at']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<TenantListOptions['include_deleted']>().toEqualTypeOf<
      NonNullable<paths['/api/v1/tenants']['get']['parameters']['query']>['include_deleted']
    >();
    expectTypeOf<ApiKeyListOptions['include_revoked']>().toEqualTypeOf<
      NonNullable<paths['/api/v1/tenants/{tenantId}/api-keys']['get']['parameters']['query']>['include_revoked']
    >();

    for (const f of [embToContract, embFromContract, completionToContract, modelsToContract]) expect(typeof f).toBe('function');
  });

  it('rerank types follow the contract', () => {
    type RerankReq = paths['/v1/rerank']['post']['requestBody']['content']['application/json'];
    type RerankRes = paths['/v1/rerank']['post']['responses'][200]['content']['application/json'];
    type RerankHeaders = paths['/v1/rerank']['post']['responses'][200]['headers'];

    // Params -> contract and contract -> params: the request shape matches in both directions.
    const reqToContract = (p: Plain<RerankCreateParams>): RerankReq => p;
    const reqFromContract = (p: RerankReq): RerankCreateParams => p;
    expectTypeOf<keyof RerankCreateParams>().toEqualTypeOf<keyof RerankReq>();
    expectTypeOf<RerankCreateParams['documents']>().toEqualTypeOf<string[]>();
    expectTypeOf<RerankCreateParams['top_n']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<RerankCreateParams['return_documents']>().toEqualTypeOf<boolean | undefined>();

    // Response: what the SDK returns is a valid contract response.
    const resToContract = (r: RerankResponse): RerankRes => r;
    expectTypeOf<RerankResult['index']>().toEqualTypeOf<RerankRes['results'][number]['index']>();
    expectTypeOf<RerankResult['relevance_score']>().toEqualTypeOf<RerankRes['results'][number]['relevance_score']>();
    expectTypeOf<RerankResponse['results']>().toEqualTypeOf<RerankResult[]>();
    // Every documented response property is modelled by the SDK type.
    expectTypeOf<KnownKeys<RerankResponse>>().toEqualTypeOf<keyof RerankRes>();
    expectTypeOf<KnownKeys<RerankResult>>().toEqualTypeOf<keyof RerankRes['results'][number]>();
    // The metadata headers the SDK parses are declared on the endpoint.
    expectTypeOf<RerankHeaders['x-caliban-request-id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<RerankHeaders['x-caliban-routed-model']>().toEqualTypeOf<string | undefined>();

    for (const f of [reqToContract, reqFromContract, resToContract]) expect(typeof f).toBe('function');
  });

  it('tenant settings, routing headers and usage fields follow the contract', () => {
    type ChatHeaders = paths['/v1/chat/completions']['post']['responses'][200]['headers'];
    type MessagesHeaders = paths['/v1/messages']['post']['responses'][200]['headers'];
    // PATCH /api/v1/tenants/{tenantId} exists and takes TenantUpdate.
    expectTypeOf<paths['/api/v1/tenants/{tenantId}']['patch']>().not.toBeNever();
    expectTypeOf<
      paths['/api/v1/tenants/{tenantId}']['patch']['requestBody']['content']['application/json']
    >().toEqualTypeOf<TenantUpdate>();
    expectTypeOf<KnownKeys<TenantUpdate>>().toEqualTypeOf<
      'pii_default' | 'pii_surrogate_scope' | 'semantic_cache' | 'auto_cache_hit_fraction'
    >();
    // Cache-hit billing: a fraction in 0..1, `null` = the deployment value (and clears it on PATCH).
    expectTypeOf<TenantUpdate['auto_cache_hit_fraction']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<Tenant['auto_cache_hit_fraction']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<Schemas['TenantCreate']['auto_cache_hit_fraction']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<PiiSurrogateScope>().toEqualTypeOf<'tenant' | 'session'>();
    expectTypeOf<SemanticCacheSetting>().toEqualTypeOf<'off' | 'on'>();
    expectTypeOf<Tenant['pii_surrogate_scope']>().toEqualTypeOf<PiiSurrogateScope | undefined>();
    expectTypeOf<Tenant['semantic_cache']>().toEqualTypeOf<SemanticCacheSetting | undefined>();
    expectTypeOf<Schemas['TenantCreate']['pii_surrogate_scope']>().toEqualTypeOf<PiiSurrogateScope | undefined>();
    expectTypeOf<Schemas['TenantCreate']['semantic_cache']>().toEqualTypeOf<SemanticCacheSetting | undefined>();
    // @ts-expect-error TenantUpdate is closed (additionalProperties: false): `name` cannot be patched
    const badPatch: TenantUpdate = { name: 'x' };
    expect(badPatch).toBeDefined();

    // Header types the meta parser narrows to.
    expectTypeOf<CacheTier>().toEqualTypeOf<NonNullable<ChatHeaders['x-caliban-cache-tier']>>();
    expectTypeOf<CacheTier>().toEqualTypeOf<NonNullable<MessagesHeaders['x-caliban-cache-tier']>>();
    expectTypeOf<ChatHeaders['x-caliban-intent']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<MessagesHeaders['x-caliban-intent']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NonNullable<ChatHeaders['x-caliban-cache']>>().toEqualTypeOf<'hit' | 'miss' | 'bypass'>();
    expectTypeOf<RouteStage>().toEqualTypeOf<NonNullable<UsageEvent['route_stage']>>();
    expectTypeOf<IntentDecision['stage']>().toEqualTypeOf<RouteStage>();

    // Usage events: the cache enum is unchanged; the new fields are optional.
    expectTypeOf<UsageEvent['cache']>().toEqualTypeOf<'hit' | 'miss' | 'bypass'>();
    expectTypeOf<UsageEvent['cache_tier']>().toEqualTypeOf<CacheTier | undefined>();
    expectTypeOf<UsageEvent['requested_model']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<UsageEvent['intent_confidence']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<UsageEvent['routed_model_cost_usd']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<UsageEvent['flat_price_usd']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<UsageEvent['tokens_saved']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<UsageEvent['billed_usd']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<UsageEvent['saved_usd']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<KnownKeys<UsageTotals>>().toEqualTypeOf<
      | 'requests'
      | 'prompt_tokens'
      | 'completion_tokens'
      | 'cached_prompt_tokens'
      | 'cache_write_tokens'
      | 'estimated_requests'
      | 'cache_hits'
      | 'saved_usd'
      | 'semantic_cache_hits'
      | 'tokens_saved'
      | 'cost_usd'
      | 'auto_requests'
      | 'auto_cache_hits'
      | 'flat_price_usd'
      | 'billed_usd'
      | 'auto_saved_usd'
      | 'routed_model_cost_usd'
      | 'margin_usd'
    >();
  });

  it('rejects a misspelled extension key at compile time', () => {
    const params: ChatCompletionCreateParams = {
      model: 'caliban/auto',
      messages: [],
      // @ts-expect-error `calliban` is not a valid field; typos must not silently drop PII policy
      calliban: { pii: 'mask' },
    };
    expect(params.model).toBe('caliban/auto');
  });
});
