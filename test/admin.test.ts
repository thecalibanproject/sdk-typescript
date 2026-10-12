import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CalibanAdmin,
  CalibanAPIError,
  CalibanConnectionError,
  CalibanOntologyBreakingError,
  defineNode,
  isOntologyBreakingError,
  ONTOLOGY_BREAKING_CHANGE,
  type Eval,
  type EvalCheck,
  type EvalGate,
  type EvalPolicy,
  type EvalPolicyView,
  type EvalStart,
  type EvalStatus,
  type EvalSuite,
  type EvalTrial,
  type GoldenCase,
  type GoldenSummary,
  type GoldenVerdict,
  type InjectionReadOnly,
  type InjectionVerdict,
  type OntologyBreaking,
  type OntologyElement,
  type OntologyElementProposal,
  type OntologyProposalResult,
  type PiiPattern,
  type PiiTerm,
  type Problem,
  type UsageByPurpose,
  type UsagePurpose,
} from '../src/index.js';
import { fastRetry, json, mockFetch } from './helpers.js';

const tenant = { id: 't_1', name: 'Acme', region: null, pii_default: 'reversible', created_at: '2026-10-02T00:00:00Z' };

function admin(fetch: typeof globalThis.fetch) {
  return new CalibanAdmin({ token: 'adm_secret', baseUrl: 'http://cp:8081/', fetch, retry: fastRetry });
}

describe('CalibanAdmin', () => {
  it('lists tenants with the admin bearer token', async () => {
    const m = mockFetch(json([tenant]));
    const tenants = await admin(m.fetch).tenants.list();
    expect(tenants[0]?.name).toBe('Acme');
    expect(m.calls[0]).toMatchObject({ url: 'http://cp:8081/api/v1/tenants', method: 'GET' });
    expect(m.calls[0]!.headers.get('authorization')).toBe('Bearer adm_secret');
  });

  it('creates tenants and fills path params', async () => {
    const m = mockFetch(json(tenant, { status: 201 }), json(tenant));
    const a = admin(m.fetch);
    await a.tenants.create({ name: 'Acme', pii_default: 'mask' });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ name: 'Acme', pii_default: 'mask' });
    await a.tenants.get('t/1');
    expect(m.calls[1]!.url).toBe('http://cp:8081/api/v1/tenants/t%2F1');
  });

  it('mints api keys and manages provider keys', async () => {
    const m = mockFetch(
      json({ id: 'k1', name: 'ci', prefix: 'cal_abcd', created_at: 'x', key: 'cal_abcd1234' }, { status: 201 }),
      json({ id: 'pk1', tenant_id: 't_1', kind: 'openai_compatible', label: 'vllm', trust_tier: 't0_sovereign', created_at: 'x' }, { status: 201 }),
      new Response(null, { status: 204 }),
    );
    const a = admin(m.fetch);
    const key = await a.apiKeys.create('t_1', { name: 'ci' });
    expect(key.key).toBe('cal_abcd1234');
    expect(m.calls[0]!.url).toBe('http://cp:8081/api/v1/tenants/t_1/api-keys');
    await a.providerKeys.create('t_1', {
      kind: 'openai_compatible',
      label: 'vllm',
      base_url: 'http://vllm:8000/v1',
      trust_tier: 't0_sovereign',
    });
    expect(m.calls[1]!.url).toBe('http://cp:8081/api/v1/tenants/t_1/provider-keys');
    await expect(a.providerKeys.delete('t_1', 'pk1')).resolves.toBeUndefined();
    expect(m.calls[2]).toMatchObject({ method: 'DELETE', url: 'http://cp:8081/api/v1/tenants/t_1/provider-keys/pk1' });
  });

  it('passes query params for tenant-scoped resources', async () => {
    const m = mockFetch(json({ events: [], totals: { requests: 0 } }), json({ tenant_id: 't_1', version: 3, elements: [] }));
    const a = admin(m.fetch);
    await a.usage.get({ tenant_id: 't_1', limit: 10 });
    expect(m.calls[0]!.url).toBe('http://cp:8081/api/v1/usage?tenant_id=t_1&limit=10');
    const onto = await a.ontology.get({ tenant_id: 't_1' });
    expect(onto.version).toBe(3);
    expect(m.calls[1]!.url).toBe('http://cp:8081/api/v1/ontology?tenant_id=t_1');
    // Element ids are per tenant: the server answers 400 without tenant_id, so it is required.
    // @ts-expect-error tenant_id is required
    expectTypeOf(a.ontology.get).toBeCallableWith({});
  });

  it('reviews ontology elements and starts introspection', async () => {
    const m = mockFetch(
      json({ id: 'e1', kind: 'metric', name: 'revenue', status: 'approved', provenance: 'llm' }),
      json({ job_id: 'job_1' }, { status: 202 }),
    );
    const a = admin(m.fetch);
    const el = await a.ontology.review('e1', { tenant_id: 't_1', decision: 'approve', note: 'lgtm' });
    expect(el.status).toBe('approved');
    expect(m.calls[0]).toMatchObject({ method: 'POST', url: 'http://cp:8081/api/v1/ontology/elements/e1/review' });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ tenant_id: 't_1', decision: 'approve', note: 'lgtm' });
    expect(await a.datasources.introspect('ds1')).toEqual({ job_id: 'job_1' });
  });

  it('creates nodes from defineNode specs', async () => {
    const spec = defineNode({
      kind: 'agent',
      prompt: { system: 'Triage invoices.' },
      model_policy: { candidates: ['tier:small'], min_trust_tier: 't1_attested' },
      budgets: { steps: 8, tokens: 20_000, wall_clock_s: 60 },
    });
    const m = mockFetch(json({ id: 'n1', tenant_id: 't_1', name: 'invoice-triage', version: 1, spec, created_at: 'x' }, { status: 201 }));
    const node = await admin(m.fetch).nodes.create({ tenant_id: 't_1', name: 'invoice-triage', spec });
    expect(node.version).toBe(1);
    expect(JSON.parse(m.calls[0]!.body!).spec).toEqual(spec);
  });

  it('throws CalibanAPIError with the contract error shape', async () => {
    const m = mockFetch(
      json({ error: { message: 'no such tenant', type: 'not_found', code: 'tenant_missing' } }, { status: 404, headers: { 'x-caliban-request-id': 'r1' } }),
    );
    const err = await admin(m.fetch).tenants.get('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanAPIError);
    expect(err).toMatchObject({ status: 404, type: 'not_found', code: 'tenant_missing', requestId: 'r1' });
  });

  it('retries 503 then succeeds, re-sending the request body', async () => {
    const m = mockFetch(new Response('', { status: 503 }), json(tenant, { status: 201 }));
    await admin(m.fetch).tenants.create({ name: 'Acme' });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]!.body).toBe(m.calls[0]!.body);
  });

  it('retries GET and DELETE on 502', async () => {
    const m = mockFetch(new Response('', { status: 502 }), json([tenant]));
    expect(await admin(m.fetch).tenants.list()).toHaveLength(1);
    expect(m.calls).toHaveLength(2);
    const d = mockFetch(new Response('', { status: 502 }), new Response(null, { status: 204 }));
    await admin(d.fetch).providers.delete('p1');
    expect(d.calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
  });

  it('does not retry a POST on 502, but retries 429 and 503', async () => {
    const bad = mockFetch(json({ error: { message: 'u', type: 'upstream_error' } }, { status: 502 }), json(tenant, { status: 201 }));
    await expect(admin(bad.fetch).tenants.create({ name: 'Acme' })).rejects.toMatchObject({ status: 502 });
    expect(bad.calls).toHaveLength(1);
    const limited = mockFetch(new Response('', { status: 429, headers: { 'retry-after': '0' } }), json(tenant, { status: 201 }));
    await admin(limited.fetch).tenants.create({ name: 'Acme' });
    expect(limited.calls).toHaveLength(2);
  });

  it('retries a POST carrying an Idempotency-Key header on 502', async () => {
    const m = mockFetch(new Response('', { status: 502 }), json(tenant, { status: 201 }));
    await admin(m.fetch).tenants.create({ name: 'Acme' }, { headers: { 'Idempotency-Key': 'tenant-acme' } });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]!.headers.get('idempotency-key')).toBe('tenant-acme');
  });

  it('does not retry a POST whose connection failed after the request was sent', async () => {
    const afterSend = () =>
      Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
    const m = mockFetch(afterSend, json(tenant, { status: 201 }));
    const a = new CalibanAdmin({ token: 't', baseUrl: 'http://cp:8081', fetch: m.fetch, retry: { ...fastRetry, retryOnNetworkError: true } });
    await expect(a.tenants.create({ name: 'Acme' })).rejects.toBeInstanceOf(CalibanConnectionError);
    expect(m.calls).toHaveLength(1);
  });

  it('deletes tenants, revokes api keys and deletes datasources and nodes (204 resolves to undefined)', async () => {
    const m = mockFetch(new Response(null, { status: 204 }));
    const a = admin(m.fetch);
    await expect(a.tenants.delete('t_1')).resolves.toBeUndefined();
    await expect(a.apiKeys.revoke('t_1', 'k1')).resolves.toBeUndefined();
    await expect(a.datasources.delete('t_1', 'ds1')).resolves.toBeUndefined();
    await expect(a.nodes.delete('t_1', 'n/1')).resolves.toBeUndefined();
    expect(m.calls.map((c) => [c.method, c.url])).toEqual([
      ['DELETE', 'http://cp:8081/api/v1/tenants/t_1'],
      ['DELETE', 'http://cp:8081/api/v1/tenants/t_1/api-keys/k1'],
      ['DELETE', 'http://cp:8081/api/v1/tenants/t_1/datasources/ds1'],
      ['DELETE', 'http://cp:8081/api/v1/tenants/t_1/nodes/n%2F1'],
    ]);
    expect(m.calls.every((c) => c.headers.get('authorization') === 'Bearer adm_secret' && c.body === null)).toBe(true);
  });

  it.each([
    ['tenants.delete', (a: CalibanAdmin) => a.tenants.delete('gone')],
    ['apiKeys.revoke', (a: CalibanAdmin) => a.apiKeys.revoke('t_1', 'gone')],
    ['datasources.delete', (a: CalibanAdmin) => a.datasources.delete('t_1', 'gone')],
    ['nodes.delete', (a: CalibanAdmin) => a.nodes.delete('t_1', 'gone')],
  ])('%s throws a not-found CalibanAPIError on 404 without retrying', async (_name, call) => {
    const m = mockFetch(
      json({ error: { message: 'not found', type: 'not_found', code: null } }, { status: 404, headers: { 'x-caliban-request-id': 'r404' } }),
    );
    const err = await call(admin(m.fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanAPIError);
    expect(err).toMatchObject({ status: 404, type: 'not_found', message: 'not found', requestId: 'r404' });
    expect(m.calls).toHaveLength(1);
  });

  it('retries the new DELETE routes on 502 like any idempotent request', async () => {
    const m = mockFetch(new Response('', { status: 502 }), new Response(null, { status: 204 }));
    await admin(m.fetch).apiKeys.revoke('t_1', 'k1');
    expect(m.calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
  });

  it('sends include_deleted and include_revoked only when set', async () => {
    const deleted = { ...tenant, id: 't_2', status: 'deleted', deleted_at: '2026-10-08T12:00:00Z' };
    const revoked = { id: 'k1', name: 'ci', prefix: 'cal_abcd', created_at: 'x', revoked_at: '2026-10-08T12:00:00Z' };
    const m = mockFetch(json([tenant]), json([{ ...tenant, status: 'active', deleted_at: null }, deleted]), json([]), json([revoked]));
    const a = admin(m.fetch);
    await a.tenants.list();
    const all = await a.tenants.list({ include_deleted: true, headers: { 'x-trace': '1' } });
    await a.apiKeys.list('t_1');
    const keys = await a.apiKeys.list('t_1', { include_revoked: true });
    expect(m.calls.map((c) => c.url)).toEqual([
      'http://cp:8081/api/v1/tenants',
      'http://cp:8081/api/v1/tenants?include_deleted=true',
      'http://cp:8081/api/v1/tenants/t_1/api-keys',
      'http://cp:8081/api/v1/tenants/t_1/api-keys?include_revoked=true',
    ]);
    expect(m.calls[1]!.headers.get('x-trace')).toBe('1');
    expect(all.map((t) => [t.status, t.deleted_at])).toEqual([
      ['active', null],
      ['deleted', '2026-10-08T12:00:00Z'],
    ]);
    expect(keys[0]?.revoked_at).toBe('2026-10-08T12:00:00Z');
  });

  it('passes include_deleted=false through when set explicitly', async () => {
    const m = mockFetch(json([]));
    await admin(m.fetch).tenants.list({ include_deleted: false });
    expect(m.calls[0]!.url).toBe('http://cp:8081/api/v1/tenants?include_deleted=false');
  });

  it('updates tenant settings with PATCH and returns the tenant', async () => {
    const updated = { ...tenant, pii_surrogate_scope: 'session', semantic_cache: 'on' };
    const m = mockFetch(json(updated), json(updated));
    const a = admin(m.fetch);
    const t = await a.tenants.update('t_1', { pii_surrogate_scope: 'session', semantic_cache: 'on' });
    expect(m.calls[0]).toMatchObject({ method: 'PATCH', url: 'http://cp:8081/api/v1/tenants/t_1' });
    expect(m.calls[0]!.headers.get('authorization')).toBe('Bearer adm_secret');
    expect(m.calls[0]!.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ pii_surrogate_scope: 'session', semantic_cache: 'on' });
    expect(t.pii_surrogate_scope).toBe('session');
    expect(t.semantic_cache).toBe('on');
    // Only the given fields are sent; the path id is escaped.
    await a.tenants.update('t/1', { pii_default: 'mask' });
    expect(m.calls[1]!.url).toBe('http://cp:8081/api/v1/tenants/t%2F1');
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ pii_default: 'mask' });
  });

  it('sets and clears the cache-hit fraction for caliban/auto', async () => {
    const m = mockFetch(json({ ...tenant, auto_cache_hit_fraction: 0.15 }), json({ ...tenant, auto_cache_hit_fraction: null }));
    const a = admin(m.fetch);
    const set = await a.tenants.update('t_1', { auto_cache_hit_fraction: 0.15 });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ auto_cache_hit_fraction: 0.15 });
    expect(set.auto_cache_hit_fraction).toBe(0.15);
    // null is sent as null (clears the override), not dropped.
    const cleared = await a.tenants.update('t_1', { auto_cache_hit_fraction: null });
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ auto_cache_hit_fraction: null });
    expect(cleared.auto_cache_hit_fraction).toBeNull();
  });

  it('sets the tenant PII patterns, dictionary and sovereign switch', async () => {
    const patterns: PiiPattern[] = [{ label: 'MRN', pattern: 'MRN-[0-9]{6}' }];
    const dictionary: PiiTerm[] = [{ term: 'Project Lumen', label: 'ORG' }];
    const updated = { ...tenant, pii_on_sovereign: true, pii_patterns: patterns, pii_dictionary: dictionary };
    const m = mockFetch(json(updated), json({ ...updated, pii_patterns: [], pii_dictionary: [] }));
    const a = admin(m.fetch);
    const t = await a.tenants.update('t_1', { pii_on_sovereign: true, pii_patterns: patterns, pii_dictionary: dictionary });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ pii_on_sovereign: true, pii_patterns: patterns, pii_dictionary: dictionary });
    expect([t.pii_on_sovereign, t.pii_patterns, t.pii_dictionary]).toEqual([true, patterns, dictionary]);
    // Lists are replaced as a whole: [] clears them.
    const cleared = await a.tenants.update('t_1', { pii_patterns: [], pii_dictionary: [] });
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ pii_patterns: [], pii_dictionary: [] });
    expect(cleared.pii_patterns).toEqual([]);
    // @ts-expect-error a pattern is closed: `flags` is not a field
    const bad: PiiPattern = { label: 'X', pattern: 'x', flags: 'i' };
    expect(bad).toBeDefined();
  });

  it('reports usage per purpose', async () => {
    const totals = { requests: 4, cost_usd: 0.002 };
    const report = {
      events: [{ request_id: 'r1', tenant_id: 't_1', model: 'local/bge-m3', prompt_tokens: 50, completion_tokens: 0, cache: 'bypass', latency_ms: 4, ts: 'x', purpose: 'rag.search' }],
      by_purpose: [
        { purpose: 'rag.ingest', totals: { requests: 3, cost_usd: 0.0015 } },
        { purpose: 'rag.search', totals: { requests: 1, cost_usd: 0.0005 } },
      ],
      totals,
    };
    const m = mockFetch(json(report));
    const usage = await admin(m.fetch).usage.get({ tenant_id: 't_1' });
    expect(usage.events[0]?.purpose).toBe('rag.search');
    const byPurpose: UsageByPurpose[] = usage.by_purpose ?? [];
    expect(byPurpose.map((p) => [p.purpose, p.totals?.requests])).toEqual([
      ['rag.ingest', 3],
      ['rag.search', 1],
    ]);
    expectTypeOf<UsagePurpose>().toEqualTypeOf<'rag.ingest' | 'rag.search'>();
  });

  it('PATCH throws a not-found CalibanAPIError on 404', async () => {
    const m = mockFetch(json({ error: { message: 'no such tenant', type: 'not_found', code: null } }, { status: 404 }));
    await expect(admin(m.fetch).tenants.update('gone', { semantic_cache: 'on' })).rejects.toMatchObject({
      status: 404,
      type: 'not_found',
    });
    expect(m.calls).toHaveLength(1);
  });

  it('retries PATCH on 503 but not on 502 (non-idempotent by default)', async () => {
    const retried = mockFetch(new Response('', { status: 503 }), json(tenant));
    await admin(retried.fetch).tenants.update('t_1', { semantic_cache: 'off' });
    expect(retried.calls.map((c) => c.method)).toEqual(['PATCH', 'PATCH']);
    expect(retried.calls[1]!.body).toBe(retried.calls[0]!.body);
    const bad = mockFetch(json({ error: { message: 'u', type: 'upstream_error' } }, { status: 502 }), json(tenant));
    await expect(admin(bad.fetch).tenants.update('t_1', { semantic_cache: 'off' })).rejects.toMatchObject({ status: 502 });
    expect(bad.calls).toHaveLength(1);
  });

  it('sends the new tenant settings on create and parses tenants with or without them', async () => {
    const m = mockFetch(json({ ...tenant, pii_surrogate_scope: 'tenant', semantic_cache: 'off' }, { status: 201 }), json([tenant]));
    const a = admin(m.fetch);
    const created = await a.tenants.create({ name: 'Acme', pii_surrogate_scope: 'tenant', semantic_cache: 'off' });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ name: 'Acme', pii_surrogate_scope: 'tenant', semantic_cache: 'off' });
    expect([created.pii_surrogate_scope, created.semantic_cache]).toEqual(['tenant', 'off']);
    const [older] = await a.tenants.list();
    expect(older?.pii_surrogate_scope).toBeUndefined();
    expect(older?.semantic_cache).toBeUndefined();
  });

  it('parses usage events with and without the routing, cache-tier and pricing fields, and the new totals', async () => {
    const base = {
      request_id: 'r1',
      tenant_id: 't_1',
      model: 'local/qwen3-8b',
      prompt_tokens: 12,
      completion_tokens: 7,
      cache: 'miss',
      latency_ms: 40,
      ts: '2026-10-09T00:00:00Z',
    };
    const auto = {
      ...base,
      request_id: 'r2',
      cache: 'hit',
      cache_tier: 'semantic',
      tokens_saved: 19,
      intent: 'translate',
      requested_model: 'caliban/auto',
      intent_confidence: 0.912,
      route_stage: 'knn',
      routed_model_cost_usd: 0,
      flat_price_usd: 0.00026,
      billed_usd: 0.000052,
      saved_usd: 0.000208,
    };
    const totals = {
      requests: 2,
      prompt_tokens: 24,
      completion_tokens: 14,
      cache_hits: 1,
      semantic_cache_hits: 1,
      tokens_saved: 19,
      cost_usd: 0.000026,
      saved_usd: 0.000208,
      auto_requests: 1,
      auto_cache_hits: 1,
      flat_price_usd: 0.00026,
      billed_usd: 0.000052,
      auto_saved_usd: 0.000208,
      routed_model_cost_usd: 0,
      margin_usd: 0.000052,
    };
    const m = mockFetch(json({ events: [base, auto], totals }), json({ events: [base], totals: { requests: 1 } }));
    const a = admin(m.fetch);
    const report = await a.usage.get({ tenant_id: 't_1' });
    const [plain, routed] = report.events;
    expect(plain).toEqual(base);
    expect(plain?.cache_tier).toBeUndefined();
    expect(plain?.route_stage).toBeUndefined();
    expect(routed).toMatchObject({
      cache: 'hit',
      cache_tier: 'semantic',
      requested_model: 'caliban/auto',
      intent_confidence: 0.912,
      route_stage: 'knn',
      routed_model_cost_usd: 0,
      flat_price_usd: 0.00026,
      billed_usd: 0.000052,
      saved_usd: 0.000208,
      tokens_saved: 19,
    });
    expect(plain?.billed_usd).toBeUndefined();
    expect(report.totals).toEqual(totals);
    // A caliban/auto cache hit is billed a share of the flat price; margin is billed minus routed cost.
    expect(report.totals.margin_usd).toBeCloseTo(report.totals.billed_usd! - report.totals.routed_model_cost_usd!, 12);
    expect(report.totals.auto_saved_usd).toBeCloseTo(report.totals.flat_price_usd! - report.totals.billed_usd!, 12);
    // An older control plane omits the new totals.
    const older = await a.usage.get();
    expect(older.totals.semantic_cache_hits).toBeUndefined();
    expect(older.totals.margin_usd).toBeUndefined();
    expect(older.totals.billed_usd).toBeUndefined();
  });

  it('requires a token', () => {
    expect(() => new CalibanAdmin({ token: '', fetch: mockFetch().fetch })).toThrow(/Missing admin token/);
  });
});

const N = 'http://cp:8081/api/v1/tenants/t_1/nodes/desk';
const evalBody = {
  id: 'ev_1',
  object: 'node.eval',
  node: 'desk',
  version: 2,
  hash: 'sha256:aa',
  suite: 'golden',
  k: 3,
  status: 'pending',
  case_count: 2,
  created_at: '2026-10-11T00:00:00Z',
};
const goldenCases: GoldenCase[] = [
  {
    id: 'chest',
    input: { case: 'Chest pain since Tuesday' },
    answers: { clarify: 'two days, nobody in danger' },
    checks: [
      { type: 'json_schema', schema: { type: 'object', required: ['urgency'] } },
      { type: 'contains', value: ['clinical'] },
      { type: 'llm_judge', rubric: 'Does the recommendation fit the case?', threshold: 0.7 },
    ],
  },
  { id: 'refund', input: { case: 'Refund my invoice' }, expected: 'billing' },
];

describe('CalibanAdmin node evals', () => {
  it('reads, replaces and deletes a golden set', async () => {
    const set = { object: 'node.golden_set', node: 'desk', version: 2, hash: 'sha256:bb', case_count: 2, updated_at: 'x', updated_by: 'u', content_visible: true, cases: goldenCases };
    const m = mockFetch(json(set), json(set), new Response(null, { status: 204 }));
    const a = admin(m.fetch);
    const got = await a.goldenSets.get('t_1', 'desk', 2);
    expect(got.cases?.[0]?.checks?.[0]).toEqual({ type: 'json_schema', schema: { type: 'object', required: ['urgency'] } });
    expect(m.calls[0]).toMatchObject({ method: 'GET', url: `${N}/versions/2/golden-set` });
    const put = await a.goldenSets.put('t_1', 'desk', 2, { cases: goldenCases });
    expect(put.case_count).toBe(2);
    expect(m.calls[1]).toMatchObject({ method: 'PUT', url: `${N}/versions/2/golden-set` });
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ cases: goldenCases });
    await expect(a.goldenSets.delete('t_1', 'desk', 2)).resolves.toBeUndefined();
    expect(m.calls[2]).toMatchObject({ method: 'DELETE', url: `${N}/versions/2/golden-set` });
  });

  it('retries a golden set PUT on 502 (PUT is idempotent)', async () => {
    const m = mockFetch(new Response('', { status: 502 }), json({ object: 'node.golden_set', case_count: 1 }));
    await admin(m.fetch).goldenSets.put('t_1', 'desk', 2, { cases: [{ id: 'a', input: 'x', expected: 'y' }] });
    expect(m.calls.map((c) => c.method)).toEqual(['PUT', 'PUT']);
  });

  it('gets and sets the promotion bar', async () => {
    const policy: EvalPolicy = {
      golden: { min_pass_k: 0.9, min_k: 3, max_cost_per_success_usd: 0.02, max_p95_latency_ms: 8000 },
      injection: { min_pass_rate: 1 },
    };
    const view = { object: 'node.eval_policy', node: 'desk', policy, injection_bar: 1, updated_at: 'x', updated_by: 'u' };
    const m = mockFetch(json(view), json(view));
    const a = admin(m.fetch);
    expect((await a.evalPolicy.get('t_1', 'desk')).injection_bar).toBe(1);
    expect(m.calls[0]).toMatchObject({ method: 'GET', url: `${N}/eval-policy` });
    expect((await a.evalPolicy.put('t_1', 'desk', policy)).policy).toEqual(policy);
    expect(m.calls[1]).toMatchObject({ method: 'PUT', url: `${N}/eval-policy` });
    expect(JSON.parse(m.calls[1]!.body!)).toEqual(policy);
  });

  it('makes the injection eval optional for read-only versions', async () => {
    const policy: EvalPolicy = { injection: { min_pass_rate: 1, read_only: 'optional' } };
    const view = { object: 'node.eval_policy', node: 'desk', policy, injection_bar: 1 };
    const m = mockFetch(
      json(view),
      json({ node: 'desk', version: 4, has_write_tools: false, has_untrusted_reads: true, allowed: true, evidence: null, problems: [] }),
    );
    const a = admin(m.fetch);
    await a.evalPolicy.put('t_1', 'desk', policy);
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ injection: { min_pass_rate: 1, read_only: 'optional' } });
    const gate = await a.evals.gate('t_1', 'desk', 4);
    expect([gate.has_write_tools, gate.has_untrusted_reads, gate.allowed]).toEqual([false, true, true]);
    expectTypeOf<InjectionReadOnly>().toEqualTypeOf<'required' | 'optional'>();
  });

  it('starts an eval as the eval key or a named api key', async () => {
    const m = mockFetch(json(evalBody, { status: 202 }));
    const a = admin(m.fetch);
    const started = await a.evals.start('t_1', 'desk', 2, { suite: 'golden', api_key_id: 'k1', k: 3, judge_model: 'local/qwen3-8b' });
    expect(started.status).toBe('pending');
    expect(m.calls[0]).toMatchObject({ method: 'POST', url: `${N}/versions/2/evals` });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ suite: 'golden', api_key_id: 'k1', k: 3, judge_model: 'local/qwen3-8b' });
    // Without api_key_id the eval runs as the tenant's eval key.
    await a.evals.start('t_1', 'desk', 2, { suite: 'injection', input_case: 'chest' });
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ suite: 'injection', input_case: 'chest' });
  });

  it('does not retry an eval start on 502 unless it carries an Idempotency-Key', async () => {
    const m = mockFetch(new Response('', { status: 502 }), json(evalBody, { status: 202 }));
    await expect(admin(m.fetch).evals.start('t_1', 'desk', 2, { suite: 'golden' })).rejects.toMatchObject({ status: 502 });
    expect(m.calls).toHaveLength(1);
  });

  it('lists, gets, cancels evals and reads trials', async () => {
    const verdict: GoldenVerdict = { run_status: 'succeeded', checks: [{ type: 'contains', passed: true }, { type: 'llm_judge', passed: true, score: 0.9 }] };
    const trial = { case: 'chest', trial: 0, run_id: 'run_1', status: 'passed', cost_usd: 0.001, verdict };
    const summary: GoldenSummary = {
      suite: 'golden',
      k: 3,
      cases: 2,
      trials: 6,
      passed_trials: 6,
      errors: 0,
      pass_hat_k: 1,
      pass_at_1: 1,
      pass_at_k: 1,
      cost_usd: 0.006,
      cost_per_success_usd: 0.001,
      judge_cost_usd: 0.0005,
      tokens: 900,
      latency_ms: { p50: 800, p95: 1200 },
      by_case: [{ case: 'chest', trials: 3, passed: 3, all_passed: true }],
    };
    const m = mockFetch(
      json({ object: 'list', data: [evalBody], next_cursor: 'c2' }),
      json({ ...evalBody, status: 'succeeded', summary, trials: [trial] }),
      json({ ...evalBody, trials: [trial] }),
      json({ ...evalBody, status: 'running', cancel_requested: true }, { status: 202 }),
      json({ error: { message: 'eval ended', type: 'conflict', code: 'eval_already_ended' } }, { status: 409 }),
    );
    const a = admin(m.fetch);
    const page = await a.evals.list('t_1', { node: 'desk', version: 2, suite: 'golden', status: 'succeeded,failed', limit: 10, cursor: 'c1' });
    expect(page.next_cursor).toBe('c2');
    expect(m.calls[0]!.url).toBe(
      'http://cp:8081/api/v1/tenants/t_1/evals?node=desk&version=2&suite=golden&status=succeeded%2Cfailed&limit=10&cursor=c1',
    );
    const ev = await a.evals.get('t_1', 'ev_1');
    // `summary` follows `suite`: narrow on its own `suite` field.
    if (ev.summary?.suite !== 'golden') throw new Error('expected a golden summary');
    expect(ev.summary.pass_hat_k).toBe(1);
    expect(ev.summary.latency_ms.p95).toBe(1200);
    expect(m.calls[1]).toMatchObject({ method: 'GET', url: 'http://cp:8081/api/v1/tenants/t_1/evals/ev_1' });
    expect(await a.evals.trials('t_1', 'ev_1')).toEqual([trial]);
    const cancelled = await a.evals.cancel('t_1', 'ev_1');
    expect(cancelled.cancel_requested).toBe(true);
    expect(m.calls[3]).toMatchObject({ method: 'POST', url: 'http://cp:8081/api/v1/tenants/t_1/evals/ev_1/cancel' });
    await expect(a.evals.cancel('t_1', 'ev_1')).rejects.toMatchObject({ status: 409, code: 'eval_already_ended' });
  });

  it('asks the gate', async () => {
    const m = mockFetch(
      json({
        node: 'desk',
        version: 2,
        has_write_tools: true,
        allowed: false,
        evidence: null,
        problems: [{ kind: 'eval_gate', message: 'kb@v1 has no injection eval', path: 'node://kb@v1' }],
      }),
      json({
        node: 'desk',
        version: 3,
        has_write_tools: true,
        allowed: true,
        evidence: { golden: { eval: 'ev_1', k: 3, pass_hat_k: 0.95 }, injection: { eval: 'ev_2', pass_rate: 1, bar: 1 }, subnodes: { 'kb@v1': null } },
        problems: [],
      }),
    );
    const a = admin(m.fetch);
    const gate = await a.evals.gate('t_1', 'desk', 2);
    expect(gate.allowed).toBe(false);
    expect(gate.problems?.[0]).toEqual({ kind: 'eval_gate', message: 'kb@v1 has no injection eval', path: 'node://kb@v1' });
    const ok = await a.evals.gate('t_1', 'desk', 3);
    expect(ok.evidence?.injection?.pass_rate).toBe(1);
    expect(ok.evidence?.subnodes?.['kb@v1']).toBeNull();
    expect(m.calls[0]).toMatchObject({ method: 'GET', url: `${N}/versions/2/gate` });
  });

  it('reads and rotates the tenant eval key', async () => {
    const key = { id: 'k_eval', name: 'eval', prefix: 'cal_ev12', created_at: 'x', purpose: 'eval' };
    const m = mockFetch(
      json({ tenant_id: 't_1', key: null }),
      json({ tenant_id: 't_1', key, revoked: 'k_old' }),
      json({ error: { message: 'the eval key is managed by the control plane', type: 'conflict' } }, { status: 409 }),
    );
    const a = admin(m.fetch);
    expect((await a.evalKey.get('t_1')).key).toBeNull();
    expect(m.calls[0]).toMatchObject({ method: 'GET', url: 'http://cp:8081/api/v1/tenants/t_1/eval-key' });
    const rotated = await a.evalKey.rotate('t_1');
    expect(rotated.key.purpose).toBe('eval');
    expect(rotated.revoked).toBe('k_old');
    expect(m.calls[1]).toMatchObject({ method: 'POST', url: 'http://cp:8081/api/v1/tenants/t_1/eval-key/rotate' });
    await expect(a.apiKeys.revoke('t_1', 'k_eval')).rejects.toMatchObject({ status: 409 });
  });

  it('types follow the contract', () => {
    expectTypeOf<EvalStart['api_key_id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<EvalStart['suite']>().toEqualTypeOf<EvalSuite>();
    expectTypeOf<EvalSuite>().toEqualTypeOf<'golden' | 'injection'>();
    expectTypeOf<EvalStatus>().toEqualTypeOf<'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'>();
    expectTypeOf<Extract<EvalCheck, { type: 'json_schema' }>['schema']>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<Extract<NonNullable<Eval['summary']>, { suite: 'golden' }>>().toEqualTypeOf<GoldenSummary>();
    expectTypeOf<NonNullable<EvalTrial['verdict']>>().toEqualTypeOf<GoldenVerdict | InjectionVerdict | { error: string }>();
    expectTypeOf<NonNullable<EvalGate['problems']>>().toEqualTypeOf<Problem[]>();
    expectTypeOf<Awaited<ReturnType<CalibanAdmin['evalPolicy']['put']>>>().toEqualTypeOf<EvalPolicyView>();
    // @ts-expect-error a check needs a known type
    const bad: EvalCheck = { type: 'similar', value: 'x' };
    expect(bad).toBeDefined();
  });
});

describe('CalibanAdmin console runs and inbox', () => {
  const R = 'http://cp:8081/api/v1/tenants/t_1/runs';
  const consoleRun = {
    id: 'run_1',
    object: 'node.run',
    node: 'desk',
    version: 2,
    status: 'input_required',
    steps: [],
    budget: {},
    content_visible: false,
    input_labels: ['caller'],
    awaiting: { step: 'write#0@approve', kind: 'approval', question: null },
    created_at: 'x',
  };

  it('lists, gets, answers and cancels runs', async () => {
    const m = mockFetch(
      json({ object: 'list', data: [], next_cursor: null }),
      json(consoleRun),
      json({ ...consoleRun, status: 'running', awaiting: null }, { status: 202 }),
      json({ ...consoleRun, status: 'running', cancel_requested: true }, { status: 202 }),
      json({ error: { message: 'run ended', type: 'conflict', code: 'run_already_ended' } }, { status: 409 }),
    );
    const a = admin(m.fetch);
    await a.runs.list('t_1', { node: 'desk', status: 'input_required', limit: 5 });
    expect(m.calls[0]!.url).toBe(`${R}?node=desk&status=input_required&limit=5`);
    const run = await a.runs.get('t_1', 'run_1');
    expect(run.input_labels).toEqual(['caller']);
    expect(run.awaiting?.kind).toBe('approval');
    expect(m.calls[1]).toMatchObject({ method: 'GET', url: `${R}/run_1` });
    await a.runs.input('t_1', 'run_1', { answer: { approve: false }, step: 'write#0@approve' });
    expect(m.calls[2]).toMatchObject({ method: 'POST', url: `${R}/run_1/input` });
    expect(JSON.parse(m.calls[2]!.body!)).toEqual({ answer: { approve: false }, step: 'write#0@approve' });
    expect((await a.runs.cancel('t_1', 'run_1')).cancel_requested).toBe(true);
    expect(m.calls[3]).toMatchObject({ method: 'POST', url: `${R}/run_1/cancel` });
    await expect(a.runs.cancel('t_1', 'run_1')).rejects.toMatchObject({ status: 409, code: 'run_already_ended' });
  });

  it('lists the inbox with structured approvals', async () => {
    const item = {
      run_id: 'run_1',
      node: 'desk',
      version: 2,
      step: 'write#0@approve',
      kind: 'approval',
      question: 'Allow erp/approve?',
      waiting_since: 'x',
      approval: { tool: 'mcp://erp/approve#sha256:ab', effect: 'write', labels: ['caller'], arguments: { invoice: 'INV-1' } },
    };
    const m = mockFetch(json({ object: 'list', content_visible: true, data: [item] }));
    const inbox = await admin(m.fetch).inbox.list('t_1');
    expect(inbox.data[0]?.approval?.labels).toEqual(['caller']);
    expect(m.calls[0]).toMatchObject({ method: 'GET', url: 'http://cp:8081/api/v1/tenants/t_1/inbox' });
  });
});

describe('CalibanAdmin: ontology bootstrap, intents and document collections', () => {
  const T = 'http://cp:8081/api/v1/tenants/t_1';
  const job = {
    id: 'ij_1',
    datasource_id: 'ds1',
    tenant_id: 't_1',
    status: 'succeeded',
    objects: 4,
    proposed: 9,
    skipped: 2,
    version: 7,
    started_at: '2026-10-11T09:00:00Z',
    finished_at: '2026-10-11T09:00:03Z',
  };
  const element: OntologyElement = { id: 'Service', kind: 'entity', name: 'Service', status: 'proposed', provenance: 'human', changed_in: 7 };

  it('starts introspection and reads the newest job back', async () => {
    const m = mockFetch(json({ job_id: 'ij_1', job: { ...job, status: 'running', version: null } }, { status: 202 }), json(job));
    const a = admin(m.fetch);
    const started = await a.datasources.introspect('ds1');
    expect(started.job?.status).toBe('running');
    const done = await a.datasources.introspection('ds/1');
    expect(m.calls[1]).toMatchObject({ method: 'GET', url: 'http://cp:8081/api/v1/datasources/ds%2F1/introspection' });
    expect([done.status, done.proposed, done.skipped, done.version]).toEqual(['succeeded', 9, 2, 7]);
    expectTypeOf(done.status).toEqualTypeOf<'running' | 'succeeded' | 'failed'>();
  });

  it('proposes elements and reviews a batch as one version', async () => {
    const m = mockFetch(
      json({ tenant_id: 't_1', version: 8, proposed: 1, skipped: 0 }, { status: 201 }),
      json({ tenant_id: 't_1', version: 9, elements: [{ ...element, status: 'approved' }], breaking: [] }),
      json({ error: { message: 'breaks invoice-triage@v3', type: 'conflict', code: null } }, { status: 409 }),
    );
    const a = admin(m.fetch);
    const res = await a.ontology.propose('t_1', { elements: [element] });
    expect(m.calls[0]).toMatchObject({ method: 'POST', url: `${T}/ontology/proposals` });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ elements: [element] });
    expect([res.version, res.proposed, res.skipped]).toEqual([8, 1, 0]);

    const batch = await a.ontology.reviewBatch('t_1', { decisions: [{ id: 'Service', decision: 'approve' }], note: 'checked' });
    expect(m.calls[1]).toMatchObject({ method: 'POST', url: `${T}/ontology/review` });
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ decisions: [{ id: 'Service', decision: 'approve' }], note: 'checked' });
    expect(batch.version).toBe(9);

    const err = await a.ontology
      .reviewBatch('t_1', { decisions: [{ id: 'Service', decision: 'deprecate' }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, type: 'conflict' });
    // A POST is not retried on 409.
    expect(m.calls).toHaveLength(3);
  });

  it('requires the tenant on the single-element review at compile time', async () => {
    const m = mockFetch(json({ ...element, status: 'deprecated' }));
    const a = admin(m.fetch);
    // @ts-expect-error tenant_id is required: element ids are per tenant
    const noTenant: Parameters<typeof a.ontology.review>[1] = { decision: 'approve' };
    expect(noTenant).toBeDefined();
    const el = await a.ontology.review('Service', { tenant_id: 't_1', decision: 'deprecate', acknowledge_breaking: true });
    expect(el.status).toBe('deprecated');
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ tenant_id: 't_1', decision: 'deprecate', acknowledge_breaking: true });
  });

  it('proposes elements without a status; the result always lists breaking', async () => {
    const m = mockFetch(json({ tenant_id: 't_1', version: 7, proposed: 0, skipped: 2, breaking: [] }, { status: 201 }));
    const a = admin(m.fetch);
    // An exported model sent again: status may be left out, and unchanged elements are skipped.
    const proposal: OntologyElementProposal = { id: 'Service', kind: 'entity', name: 'Service', provenance: 'human' };
    const res = await a.ontology.propose('t_1', { elements: [proposal, { ...proposal, id: 'Facility', status: 'approved' }] });
    expect(JSON.parse(m.calls[0]!.body!).elements[0]).not.toHaveProperty('status');
    expect([res.version, res.proposed, res.skipped, res.breaking]).toEqual([7, 0, 2, []]);
    expectTypeOf<OntologyProposalResult['breaking']>().toEqualTypeOf<OntologyBreaking[]>();
    expectTypeOf<OntologyElementProposal['status']>().toEqualTypeOf<OntologyElement['status'] | undefined>();
    // A stored element always has its status.
    expectTypeOf<OntologyElement['status']>().toEqualTypeOf<'proposed' | 'approved' | 'rejected' | 'stale' | 'deprecated'>();
  });

  it('throws a typed error listing the breaking changes of a refused withdrawal', async () => {
    const breaking: OntologyBreaking[] = [
      {
        element: 'Service.city',
        change: 'approved -> proposed',
        nodes: ['triage@v3'],
        versions: [{ node: 'triage', version: 3 }],
      },
    ];
    const body = {
      error: {
        message: 'proposing changes to approved elements withdraws them, and published node versions query them',
        type: 'conflict',
        code: 'ontology_breaking_change',
        breaking,
      },
    };
    const m = mockFetch(json(body, { status: 409 }), json(body, { status: 409 }), json(body, { status: 409 }));
    const a = admin(m.fetch);
    const proposal: OntologyElementProposal = { id: 'Service.city', kind: 'attribute', name: 'city', provenance: 'human' };
    const err = await a.ontology.propose('t_1', { elements: [proposal] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanOntologyBreakingError);
    expect(err).toBeInstanceOf(CalibanAPIError);
    expect(isOntologyBreakingError(err)).toBe(true);
    if (!(err instanceof CalibanOntologyBreakingError)) throw new Error('unreachable');
    expect([err.status, err.type, err.code]).toEqual([409, 'conflict', ONTOLOGY_BREAKING_CHANGE]);
    expect(err.breaking).toEqual(breaking);
    expect(err.breaking[0]!.versions[0]).toEqual({ node: 'triage', version: 3 });

    // The single and the batch review refuse the same way.
    const single = await a.ontology.review('Service.city', { tenant_id: 't_1', decision: 'reject' }).catch((e: unknown) => e);
    const batch = await a.ontology
      .reviewBatch('t_1', { decisions: [{ id: 'Service.city', decision: 'deprecate' }] })
      .catch((e: unknown) => e);
    expect([isOntologyBreakingError(single), isOntologyBreakingError(batch)]).toEqual([true, true]);
    expect(m.calls).toHaveLength(3);
  });

  it('keeps other 409s plain', async () => {
    const m = mockFetch(json({ error: { message: 'breaks invoice-triage@v3', type: 'conflict', code: null } }, { status: 409 }));
    const err = await admin(m.fetch)
      .ontology.reviewBatch('t_1', { decisions: [{ id: 'Service', decision: 'deprecate' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanAPIError);
    expect(err).not.toBeInstanceOf(CalibanOntologyBreakingError);
    expect(isOntologyBreakingError(err)).toBe(false);
  });

  it('lists, sets and drops the tenant intents', async () => {
    const intents = {
      tenant_id: 't_1',
      intents: [
        { intent: 'triage', exemplars: ['my chest hurts'], source: 'api', node: 'node/triage' },
        { intent: 'billing', exemplars: ['refund my invoice'], source: 'config', node: null },
      ],
      removed: ['smalltalk'],
    };
    const m = mockFetch(
      json(intents),
      json({ tenant_id: 't_1', intent: 'triage', exemplars: ['my chest hurts', 'I feel dizzy'], source: 'api' }),
      new Response(null, { status: 204 }),
    );
    const a = admin(m.fetch);
    const list = await a.intents.list('t_1');
    expect(m.calls[0]).toMatchObject({ method: 'GET', url: `${T}/intents` });
    expect(list.intents?.map((i) => [i.intent, i.source, i.node])).toEqual([
      ['triage', 'api', 'node/triage'],
      ['billing', 'config', null],
    ]);
    expect(list.removed).toEqual(['smalltalk']);

    const set = await a.intents.put('t_1', 'triage', ['my chest hurts', 'I feel dizzy']);
    expect(m.calls[1]).toMatchObject({ method: 'PUT', url: `${T}/intents/triage` });
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ exemplars: ['my chest hurts', 'I feel dizzy'] });
    expect(set).toEqual({ tenant_id: 't_1', intent: 'triage', exemplars: ['my chest hurts', 'I feel dizzy'], source: 'api' });

    await expect(a.intents.delete('t_1', 'triage')).resolves.toBeUndefined();
    expect(m.calls[2]).toMatchObject({ method: 'DELETE', url: `${T}/intents/triage`, body: null });
  });

  it('retries the intent PUT on 502 like a GET', async () => {
    const m = mockFetch(new Response('', { status: 502 }), json({ tenant_id: 't_1', intent: 'x', exemplars: [], source: 'api' }));
    await admin(m.fetch).intents.put('t_1', 'x', []);
    expect(m.calls.map((c) => c.method)).toEqual(['PUT', 'PUT']);
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ exemplars: [] });
  });

  it('lists the RAG models and collections with document counts', async () => {
    const collection = {
      id: 'rc_1',
      tenant_id: 't_1',
      name: 'policies',
      embedding_model: 'local/bge-m3',
      settings: { default_trust: 'untrusted', vet_deadline_secs: 900 },
      created_at: 'x',
      created_by: 'admin',
      document_counts: { ready: 12, pending: 1, quarantined: 2 },
    };
    const m = mockFetch(
      json({
        embedding: [{ id: 'local/bge-m3', provider: 'gpu-pool', trust_tier: 't0_sovereign' }],
        rerank: [{ id: 'local/qwen3-reranker', provider: 'gpu-pool', trust_tier: 't0_sovereign' }],
      }),
      json([collection]),
      json({ ...collection, document_counts: undefined, used_by: ['desk@v2'] }),
      json(collection, { status: 201 }),
      new Response(null, { status: 204 }),
    );
    const a = admin(m.fetch);
    const models = await a.rag.models('t_1');
    expect(m.calls[0]).toMatchObject({ method: 'GET', url: `${T}/rag/models` });
    expect(models.embedding.map((x) => x.id)).toEqual(['local/bge-m3']);
    expect(models.rerank[0]?.trust_tier).toBe('t0_sovereign');

    const [c] = await a.rag.collections.list('t_1');
    expect(c?.document_counts).toEqual({ ready: 12, pending: 1, quarantined: 2 });
    expectTypeOf(c!.document_counts).toEqualTypeOf<Record<string, number> | undefined>();
    const detail = await a.rag.collections.get('t_1', 'policies');
    expect(detail.used_by).toEqual(['desk@v2']);
    await a.rag.collections.create('t_1', { name: 'policies', embedding_model: 'local/bge-m3', rerank_model: 'local/qwen3-reranker' });
    expect(JSON.parse(m.calls[3]!.body!)).toEqual({ name: 'policies', embedding_model: 'local/bge-m3', rerank_model: 'local/qwen3-reranker' });
    await a.rag.collections.delete('t_1', 'policies');
    expect(m.calls.map((x) => [x.method, x.url]).slice(1)).toEqual([
      ['GET', `${T}/rag/collections`],
      ['GET', `${T}/rag/collections/policies`],
      ['POST', `${T}/rag/collections`],
      ['DELETE', `${T}/rag/collections/policies`],
    ]);
  });

  it('ingests, lists, reads and releases documents', async () => {
    const doc = {
      tenant_id: 't_1',
      collection_id: 'rc_1',
      doc_id: 'leave-policy',
      version: 2,
      content_type: 'text/markdown',
      trust: 'untrusted',
      bytes: 2048,
      status: 'quarantined',
      chunks: 6,
      tokens: 1500,
      pii_entities: 3,
      findings: [{ kind: 'instruction', chunk: 4, heading_path: ['Leave policy', 'Exceptions'] }],
      findings_acknowledged: false,
      attempts: 1,
      created_at: '2026-10-11T09:00:00Z',
      created_by: 'admin',
      vet_deadline_at: '2026-10-11T09:15:00Z',
    };
    const D = `${T}/rag/collections/policies/documents`;
    const m = mockFetch(
      json({ ...doc, status: 'pending', findings: [], unchanged: false }, { status: 202 }),
      json({ documents: [{ ...doc, live_version: 1 }], next_cursor: 'c2' }),
      json({ doc_id: 'leave-policy', live_version: 1, versions: [doc] }),
      json({ ...doc, status: 'pending', findings_acknowledged: true, released_by: 'admin', vet_deadline_at: '2026-10-11T10:15:00Z' }),
      new Response(null, { status: 204 }),
    );
    const a = admin(m.fetch);
    const ingested = await a.rag.documents.ingest('t_1', 'policies', { doc_id: 'leave-policy', content: '# Leave policy', trust: 'untrusted' });
    expect(ingested.unchanged).toBe(false);
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ doc_id: 'leave-policy', content: '# Leave policy', trust: 'untrusted' });

    const page = await a.rag.documents.list('t_1', 'policies', { status: 'quarantined', limit: 10 });
    expect(m.calls[1]!.url).toBe(`${D}?status=quarantined&limit=10`);
    expect(page.documents[0]?.live_version).toBe(1);
    expect(page.next_cursor).toBe('c2');

    const versions = await a.rag.documents.get('t_1', 'policies', 'leave-policy');
    const v = versions.versions[0]!;
    expect(v.vet_deadline_at).toBe('2026-10-11T09:15:00Z');
    expect(v.findings[0]?.heading_path).toEqual(['Leave policy', 'Exceptions']);
    expectTypeOf(v.findings[0]!.heading_path).toEqualTypeOf<string[] | undefined>();

    const released = await a.rag.documents.release('t_1', 'policies', 'leave-policy', { version: 2, acknowledge_findings: true });
    expect(m.calls[3]).toMatchObject({ method: 'POST', url: `${D}/leave-policy/release` });
    expect(JSON.parse(m.calls[3]!.body!)).toEqual({ version: 2, acknowledge_findings: true });
    expect(released.vet_deadline_at).toBe('2026-10-11T10:15:00Z');

    await a.rag.documents.delete('t_1', 'policies', 'leave-policy');
    expect(m.calls[4]).toMatchObject({ method: 'DELETE', url: `${D}/leave-policy` });
  });
});
