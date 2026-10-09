import { describe, expect, it } from 'vitest';
import { CalibanAdmin, CalibanAPIError, defineNode } from '../src/index.js';
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

  it('requires a token', () => {
    expect(() => new CalibanAdmin({ token: '', fetch: mockFetch().fetch })).toThrow(/Missing admin token/);
  });
});
