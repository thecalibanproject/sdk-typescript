import { describe, expect, it } from 'vitest';
import {
  CalibanAdmin,
  CalibanAPIError,
  CalibanClient,
  CalibanError,
  buildEmbeddingsBody,
  buildRerankBody,
  encodeModelIdPath,
  reasoningText,
  type ModelCreate,
  type RerankCreateParams,
} from '../src/index.js';
import { completion, fastRetry, json, mockFetch, sse } from './helpers.js';

const msgs = [{ role: 'user' as const, content: 'hi' }];

function client(fetch: typeof globalThis.fetch, extra: Partial<ConstructorParameters<typeof CalibanClient>[0]> = {}) {
  return new CalibanClient({ apiKey: 'cal_test', baseURL: 'http://gw:8080/v1', fetch, retry: fastRetry, ...extra });
}

function admin(fetch: typeof globalThis.fetch) {
  return new CalibanAdmin({ token: 'adm', baseUrl: 'http://cp:8081', fetch, retry: fastRetry });
}

const embeddingResponse = {
  object: 'list',
  model: 'local/bge-m3',
  data: [
    { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
    { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
  ],
  usage: { prompt_tokens: 4, total_tokens: 4 },
};

describe('embeddings.create', () => {
  it('posts a batch to /v1/embeddings and exposes header metadata', async () => {
    const m = mockFetch(
      json(embeddingResponse, {
        headers: { 'x-caliban-request-id': 'req_e', 'x-caliban-routed-model': 'local/bge-m3', 'x-caliban-pii-entities': '2' },
      }),
    );
    const res = await client(m.fetch).embeddings.create({ model: 'local/bge-m3', input: ['a', 'b'], dimensions: 2 });
    const call = m.calls[0]!;
    expect(call).toMatchObject({ url: 'http://gw:8080/v1/embeddings', method: 'POST' });
    expect(call.headers.get('authorization')).toBe('Bearer cal_test');
    expect(JSON.parse(call.body!)).toEqual({ model: 'local/bge-m3', input: ['a', 'b'], dimensions: 2 });
    expect(res.data.map((d) => d.embedding)).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(res.meta).toMatchObject({ requestId: 'req_e', routedModel: 'local/bge-m3', piiEntities: 2, costUsd: null });
    expect(Object.keys(res)).not.toContain('meta');
  });

  it('accepts a single string and merges extraBody', async () => {
    const m = mockFetch(json(embeddingResponse));
    await client(m.fetch).embeddings.create({ model: 'e', input: 'one' }, { extraBody: { truncate_prompt_tokens: 512 } });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ model: 'e', input: 'one', truncate_prompt_tokens: 512 });
  });

  it('rejects non-string input before sending', async () => {
    const m = mockFetch(json(embeddingResponse));
    const bad = { model: 'e', input: [1, 2] } as unknown as Parameters<typeof buildEmbeddingsBody>[0];
    await expect(client(m.fetch).embeddings.create(bad)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(m.calls).toHaveLength(0);
  });

  it('maps errors to CalibanAPIError', async () => {
    const m = mockFetch(
      json({ error: { message: "model 'x' is not an embedding model", type: 'invalid_request_error' } }, { status: 400 }),
    );
    await expect(client(m.fetch).embeddings.create({ model: 'x', input: 'a' })).rejects.toBeInstanceOf(CalibanAPIError);
  });
});

const rerankDocs = ['Paris is in France.', 'Bananas are yellow.', 'The Eiffel Tower is in Paris.'];
const rerankResponse = {
  model: 'local/qwen3-reranker',
  // Sorted by relevance_score desc, so indices are not in input order.
  results: [
    { index: 2, relevance_score: 0.97 },
    { index: 0, relevance_score: 0.81 },
    { index: 1, relevance_score: 0.02 },
  ],
  usage: { total_tokens: 42 },
};

describe('rerank.create', () => {
  it('posts to /v1/rerank, keeps the server order and exposes header metadata', async () => {
    const m = mockFetch(
      json(rerankResponse, {
        headers: { 'x-caliban-request-id': 'req_r', 'x-caliban-routed-model': 'local/qwen3-reranker' },
      }),
    );
    const res = await client(m.fetch).rerank.create({
      model: 'local/qwen3-reranker',
      query: 'Where is the Eiffel Tower?',
      documents: rerankDocs,
    });
    const call = m.calls[0]!;
    expect(call).toMatchObject({ url: 'http://gw:8080/v1/rerank', method: 'POST' });
    expect(call.headers.get('authorization')).toBe('Bearer cal_test');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call.body!)).toEqual({
      model: 'local/qwen3-reranker',
      query: 'Where is the Eiffel Tower?',
      documents: rerankDocs,
    });
    expect(res.results.map((r) => r.index)).toEqual([2, 0, 1]);
    expect(res.results.map((r) => r.relevance_score)).toEqual([0.97, 0.81, 0.02]);
    expect(res.results[0]?.document).toBeUndefined();
    expect(res.usage?.total_tokens).toBe(42);
    expect(res.meta).toMatchObject({ requestId: 'req_r', routedModel: 'local/qwen3-reranker', costUsd: null });
    expect(Object.keys(res)).not.toContain('meta');
  });

  it('sends top_n and return_documents and returns document text', async () => {
    const m = mockFetch(
      json({
        model: 'local/bge-reranker',
        results: [
          { index: 2, relevance_score: 0.97, document: { text: rerankDocs[2] } },
          { index: 0, relevance_score: 0.81, document: { text: rerankDocs[0] } },
        ],
      }),
    );
    const res = await client(m.fetch).rerank.create(
      { model: 'local/bge-reranker', query: 'Eiffel', documents: rerankDocs, top_n: 2, return_documents: true },
      { extraBody: { truncate: true } },
    );
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({
      model: 'local/bge-reranker',
      query: 'Eiffel',
      documents: rerankDocs,
      top_n: 2,
      return_documents: true,
      truncate: true,
    });
    expect(res.results).toHaveLength(2);
    expect(res.results.map((r) => r.document?.text)).toEqual([rerankDocs[2], rerankDocs[0]]);
    expect(res.usage).toBeUndefined();
  });

  it('rejects empty or invalid input before sending', async () => {
    const m = mockFetch(json(rerankResponse));
    const c = client(m.fetch);
    const base = { model: 'r', query: 'q', documents: ['a'] };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ documents: [] }, 'invalid_documents'],
      [{ documents: ['a', 1] }, 'invalid_documents'],
      [{ documents: 'a' }, 'invalid_documents'],
      [{ query: undefined }, 'invalid_query'],
      [{ top_n: 0 }, 'invalid_top_n'],
      [{ top_n: 1.5 }, 'invalid_top_n'],
      [{ return_documents: 'yes' }, 'invalid_return_documents'],
    ];
    for (const [patch, code] of cases) {
      const params = { ...base, ...patch } as unknown as RerankCreateParams;
      const err = await c.rerank.create(params).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CalibanError);
      expect(err).toMatchObject({ type: 'invalid_request_error', code });
    }
    expect(() => buildRerankBody({ model: 'r', query: 'q', documents: [] })).toThrow(/at least one document/);
    expect(m.calls).toHaveLength(0);
  });

  it('retries 503 and maps errors to CalibanAPIError', async () => {
    const m = mockFetch(
      json({ error: { message: 'busy', type: 'upstream_error' } }, { status: 503 }),
      json(rerankResponse, { headers: { 'x-caliban-request-id': 'req_ok' } }),
      json({ error: { message: "model 'x' is not a rerank model", type: 'invalid_request_error' } }, { status: 400 }),
    );
    const c = client(m.fetch);
    const ok = await c.rerank.create({ model: 'r', query: 'q', documents: ['a'] });
    expect(ok.meta.requestId).toBe('req_ok');
    expect(m.calls).toHaveLength(2);
    const err = await c.rerank.create({ model: 'x', query: 'q', documents: ['a'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanAPIError);
    expect(err).toMatchObject({ status: 400, type: 'invalid_request_error' });
    expect(m.calls).toHaveLength(3);
  });
});

describe('reasoning', () => {
  it('sends caliban.reasoning, merged with client defaults', async () => {
    const m = mockFetch(json(completion));
    const c = client(m.fetch, { defaultCaliban: { reasoning: 'off', pii: 'mask' } });
    await c.chat.completions.create({ model: 'local/qwen3-8b', messages: msgs });
    expect(JSON.parse(m.calls[0]!.body!).caliban).toEqual({ reasoning: 'off', pii: 'mask' });
    await c.chat.completions.create({ model: 'local/qwen3-8b', messages: msgs, caliban: { reasoning: 'high' } });
    expect(JSON.parse(m.calls[1]!.body!).caliban).toEqual({ reasoning: 'high', pii: 'mask' });
  });

  it('rejects an unknown reasoning level at runtime', async () => {
    const m = mockFetch(json(completion));
    const err = await client(m.fetch)
      .chat.completions.create({
        model: 'm',
        messages: msgs,
        caliban: { reasoning: 'max' as unknown as 'high' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanError);
    expect(err).toMatchObject({ code: 'invalid_reasoning' });
    expect(m.calls).toHaveLength(0);
  });

  it('exposes reasoning_content on non-streaming messages', async () => {
    const body = {
      ...completion,
      choices: [
        { index: 0, message: { role: 'assistant', content: '4', reasoning_content: '2+2=4' }, finish_reason: 'stop' },
      ],
    };
    const m = mockFetch(json(body));
    const res = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, caliban: { reasoning: 'low' } });
    const message = res.choices[0]?.message;
    expect(message?.reasoning_content).toBe('2+2=4');
    expect(reasoningText(message)).toBe('2+2=4');
    expect(reasoningText({ reasoning: 'alt' })).toBe('alt');
    expect(reasoningText({ content: 'x' } as never)).toBeNull();
    expect(reasoningText(undefined)).toBeNull();
  });

  const chunkOf = (delta: Record<string, unknown>, index = 0) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index, delta, finish_reason: null }] })}\n\n`;

  it('separates streamed reasoning from answer text (reasoning_content)', async () => {
    const m = mockFetch(() =>
      sse([
        chunkOf({ role: 'assistant' }),
        chunkOf({ reasoning_content: 'Let me ' }),
        chunkOf({ reasoning_content: 'think.' }),
        chunkOf({ content: 'Answer' }),
        chunkOf({ content: ' 42' }),
        'data: [DONE]\n\n',
      ]).response,
    );
    const c = client(m.fetch);
    const parts = [];
    const stream = await c.chat.completions.create({ model: 'm', messages: msgs, stream: true });
    for await (const p of stream.textParts()) parts.push(p);
    expect(parts).toEqual([
      { type: 'reasoning', text: 'Let me ' },
      { type: 'reasoning', text: 'think.' },
      { type: 'content', text: 'Answer' },
      { type: 'content', text: ' 42' },
    ]);
    const again = await c.chat.completions.create({ model: 'm', messages: msgs, stream: true });
    expect(await again.collect()).toEqual({ reasoning: 'Let me think.', content: 'Answer 42' });
    const textOnly = await c.chat.completions.create({ model: 'm', messages: msgs, stream: true });
    expect(await textOnly.text()).toBe('Answer 42');
  });

  it('handles servers that stream `reasoning` and ignores other choices', async () => {
    const m = mockFetch(() =>
      sse([chunkOf({ reasoning: 'hmm' }), chunkOf({ content: 'other' }, 1), chunkOf({ content: 'ok' }), 'data: [DONE]\n\n'])
        .response,
    );
    const stream = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, stream: true });
    expect(await stream.collect()).toEqual({ reasoning: 'hmm', content: 'ok' });
  });
});

describe('x-caliban-cost-usd', () => {
  it('is parsed into meta.costUsd', async () => {
    const m = mockFetch(json(completion, { headers: { 'x-caliban-cost-usd': '0.00012500' } }));
    const res = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs });
    expect(res.meta.costUsd).toBeCloseTo(0.000125, 10);
  });

  it('is null when absent or malformed', async () => {
    const m = mockFetch(json(completion), json(completion, { headers: { 'x-caliban-cost-usd': 'n/a' } }));
    const c = client(m.fetch);
    expect((await c.chat.completions.create({ model: 'm', messages: msgs })).meta.costUsd).toBeNull();
    expect((await c.chat.completions.create({ model: 'm', messages: msgs })).meta.costUsd).toBeNull();
  });
});

describe('/v1/models caliban info', () => {
  it('types and returns the caliban object (absent on caliban/auto)', async () => {
    const m = mockFetch(
      json({
        object: 'list',
        data: [
          {
            id: 'local/qwen3-8b',
            object: 'model',
            owned_by: 'local-vllm',
            caliban: {
              kind: 'chat',
              family: 'qwen3',
              capabilities: { tools: true, reasoning: 'hybrid', reasoning_control: 'enable_thinking' },
              trust_tier: 't0_sovereign',
            },
          },
          { id: 'caliban/auto', object: 'model', owned_by: 'caliban' },
        ],
      }),
    );
    const list = await client(m.fetch).models.list();
    const [qwen, auto] = list.data;
    expect(qwen?.caliban?.capabilities.reasoning).toBe('hybrid');
    expect(qwen?.caliban?.trust_tier).toBe('t0_sovereign');
    expect(auto?.caliban).toBeUndefined();
  });
});

const qwenModel = {
  id: 'local/qwen3-8b',
  provider_id: 'gpu-pool',
  provider_kind: 'openai_compatible',
  upstream_model: 'Qwen/Qwen3-8B',
  kind: 'chat',
  family: 'qwen3',
  capabilities: { tools: true, reasoning: 'hybrid', reasoning_control: 'enable_thinking' },
  trust_tier: 't0_sovereign',
};

const sharedProvider = {
  id: 'gpu-pool',
  kind: 'openai_compatible',
  base_url: 'http://vllm:8000/v1',
  trust_tier: 't0_sovereign',
  cache_salt: true,
  has_api_key: false,
  tenants: [],
};

describe('CalibanAdmin models', () => {
  it('lists and creates models', async () => {
    const m = mockFetch(json([qwenModel]), json(qwenModel, { status: 201 }));
    const a = admin(m.fetch);
    const models = await a.models.list();
    expect(models[0]?.capabilities.reasoning).toBe('hybrid');
    const body: ModelCreate = {
      id: 'local/qwen3-8b',
      provider: 'gpu-pool',
      upstream_model: 'Qwen/Qwen3-8B',
      trust_tier: 't0_sovereign',
      kind: 'chat',
      family: 'qwen3',
      capabilities: { reasoning: 'hybrid', reasoning_control: 'enable_thinking' },
    };
    const created = await a.models.create(body);
    expect(created.provider_id).toBe('gpu-pool');
    expect(m.calls[1]).toMatchObject({ method: 'POST', url: 'http://cp:8081/api/v1/models' });
    expect(JSON.parse(m.calls[1]!.body!)).toEqual(body);
  });

  it('deletes a model whose id contains "/" with the slash unescaped', async () => {
    const m = mockFetch(new Response(null, { status: 204 }));
    const a = admin(m.fetch);
    await expect(a.models.delete('local/qwen3-8b')).resolves.toBeUndefined();
    expect(m.calls[0]).toMatchObject({ method: 'DELETE', url: 'http://cp:8081/api/v1/models/local/qwen3-8b' });
    await a.models.delete('hf/Qwen/Qwen3 8B?x#y');
    expect(m.calls[1]!.url).toBe('http://cp:8081/api/v1/models/hf/Qwen/Qwen3%208B%3Fx%23y');
    // Other path params keep the default (fully escaped) behaviour.
    await a.providers.delete('a/b');
    expect(m.calls[2]!.url).toBe('http://cp:8081/api/v1/providers/a%2Fb');
  });

  it('refuses model ids that URL normalisation would rewrite', async () => {
    const m = mockFetch(new Response(null, { status: 204 }));
    for (const bad of ['../tenants', 'local/./x', 'local//x', '/local', 'local/', '']) {
      await expect(admin(m.fetch).models.delete(bad)).rejects.toMatchObject({ code: 'invalid_model_id' });
    }
    expect(m.calls).toHaveLength(0);
    expect(encodeModelIdPath('local/qwen3-8b')).toBe('local/qwen3-8b');
    expect(encodeModelIdPath('a/%2e%2e')).toBe('a/%252e%252e');
  });

  it('surfaces 409 when a route still uses the model', async () => {
    const m = mockFetch(json({ error: { message: 'model in use', type: 'conflict' } }, { status: 409 }));
    await expect(admin(m.fetch).models.delete('local/qwen3-8b')).rejects.toMatchObject({ status: 409, type: 'conflict' });
  });
});

describe('CalibanAdmin providers', () => {
  it('lists, creates, probes and deletes shared model servers', async () => {
    const m = mockFetch(
      json([sharedProvider]),
      json(sharedProvider, { status: 201 }),
      json({ status: 'ok', latency_ms: 12, models: 3 }),
      new Response(null, { status: 204 }),
    );
    const a = admin(m.fetch);
    expect((await a.providers.list())[0]?.cache_salt).toBe(true);
    await a.providers.create({
      id: 'gpu-pool',
      kind: 'openai_compatible',
      base_url: 'http://vllm:8000/v1',
      trust_tier: 't0_sovereign',
      cache_salt: true,
    });
    expect(m.calls[1]).toMatchObject({ method: 'POST', url: 'http://cp:8081/api/v1/providers' });
    expect(JSON.parse(m.calls[1]!.body!)).toMatchObject({ id: 'gpu-pool', cache_salt: true });
    const health = await a.providers.health('gpu-pool');
    expect(health).toEqual({ status: 'ok', latency_ms: 12, models: 3 });
    expect(m.calls[2]).toMatchObject({ method: 'GET', url: 'http://cp:8081/api/v1/providers/gpu-pool/health' });
    await a.providers.delete('gpu-pool');
    expect(m.calls[3]).toMatchObject({ method: 'DELETE', url: 'http://cp:8081/api/v1/providers/gpu-pool' });
  });

  it('discovers models and registers the chosen suggestions', async () => {
    const suggestion = (id: string, upstream: string, kind: 'chat' | 'embedding') => ({
      id,
      provider: 'gpu-pool',
      upstream_model: upstream,
      kind,
      trust_tier: 't0_sovereign',
    });
    const discovery = {
      provider: 'gpu-pool',
      available: ['Qwen/Qwen3-8B', 'BAAI/bge-m3', 'meta-llama/Llama-3.1-8B-Instruct'],
      suggested: [
        suggestion('local/qwen3-8b', 'Qwen/Qwen3-8B', 'chat'),
        suggestion('local/bge-m3', 'BAAI/bge-m3', 'embedding'),
      ],
    };
    const m = mockFetch(json(discovery), (call) => {
      const b = JSON.parse(call.body!) as ModelCreate;
      return json({ ...qwenModel, id: b.id, upstream_model: b.upstream_model, kind: b.kind }, { status: 201 });
    });
    const a = admin(m.fetch);
    const found = await a.providers.discover('gpu-pool');
    expect(m.calls[0]).toMatchObject({ method: 'POST', url: 'http://cp:8081/api/v1/providers/gpu-pool/discover' });
    expect(found.available).toHaveLength(3);

    const chosen = found.suggested.filter((s) => s.id === 'local/qwen3-8b');
    const created = await Promise.all(chosen.map((s) => a.models.create({ ...s, family: 'qwen3' })));
    expect(created.map((c) => c.id)).toEqual(['local/qwen3-8b']);
    expect(m.calls).toHaveLength(2);
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ ...discovery.suggested[0], family: 'qwen3' });
  });

  it('maps a 502 from discovery (server unreachable) to CalibanAPIError', async () => {
    const m = mockFetch(json({ error: { message: 'connect refused', type: 'upstream_error' } }, { status: 502 }));
    const err = await admin(m.fetch).providers.discover('gpu-pool').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanAPIError);
    expect(err).toMatchObject({ status: 502, type: 'upstream_error' });
  });
});
