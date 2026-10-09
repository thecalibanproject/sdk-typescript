import { describe, expect, expectTypeOf, it } from 'vitest';
import type { components, paths } from '../src/generated/schema.js';
import type {
  ApiKeyInfo,
  ApiKeyListOptions,
  CalibanExtension,
  ChatCompletion,
  ChatCompletionCreateParams,
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
  ModelCalibanInfo,
  ModelCreate,
  ModelDiscovery,
  ModelInfo,
  ModelList,
  ProviderHealth,
  ReasoningEffort,
  RegistryModel,
  RerankCreateParams,
  RerankResponse,
  RerankResult,
  SharedProvider,
  SharedProviderCreate,
  Tenant,
  TenantListOptions,
  TrustTier,
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
