import { describe, expect, it } from 'vitest';
import { CalibanAdmin, CalibanAPIError, CalibanConnectionError, defineNode } from '../src/index.js';
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
  });

  it('reviews ontology elements and starts introspection', async () => {
    const m = mockFetch(
      json({ id: 'e1', kind: 'metric', name: 'revenue', status: 'approved', provenance: 'llm' }),
      json({ job_id: 'job_1' }, { status: 202 }),
    );
    const a = admin(m.fetch);
    const el = await a.ontology.review('e1', { decision: 'approve', note: 'lgtm' });
    expect(el.status).toBe('approved');
    expect(m.calls[0]).toMatchObject({ method: 'POST', url: 'http://cp:8081/api/v1/ontology/elements/e1/review' });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ decision: 'approve', note: 'lgtm' });
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
      routed_model_cost_usd: 0.000026,
      flat_price_usd: 0.00026,
    };
    const totals = {
      requests: 2,
      prompt_tokens: 24,
      completion_tokens: 14,
      cache_hits: 1,
      semantic_cache_hits: 1,
      tokens_saved: 19,
      cost_usd: 0.000026,
      auto_requests: 1,
      flat_price_usd: 0.00026,
      routed_model_cost_usd: 0.000026,
      margin_usd: 0.000234,
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
      routed_model_cost_usd: 0.000026,
      flat_price_usd: 0.00026,
      tokens_saved: 19,
    });
    expect(report.totals).toEqual(totals);
    expect(report.totals.margin_usd).toBeCloseTo(report.totals.flat_price_usd! - report.totals.routed_model_cost_usd!, 12);
    // An older control plane omits the new totals.
    const older = await a.usage.get();
    expect(older.totals.semantic_cache_hits).toBeUndefined();
    expect(older.totals.margin_usd).toBeUndefined();
  });

  it('requires a token', () => {
    expect(() => new CalibanAdmin({ token: '', fetch: mockFetch().fetch })).toThrow(/Missing admin token/);
  });
});
