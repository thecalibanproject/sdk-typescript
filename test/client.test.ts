import { describe, expect, it } from 'vitest';
import {
  CalibanAbortError,
  CalibanAPIError,
  CalibanClient,
  CalibanConnectionError,
  CalibanError,
  CalibanStreamError,
  CalibanTimeoutError,
  ChatCompletionStream,
  buildChatBody,
  isCalibanError,
} from '../src/index.js';
import { chunk, completion, fastRetry, json, mockFetch, sse } from './helpers.js';

const msgs = [{ role: 'user' as const, content: 'hi' }];

function client(fetch: typeof globalThis.fetch, extra: Partial<ConstructorParameters<typeof CalibanClient>[0]> = {}) {
  return new CalibanClient({ apiKey: 'cal_test', baseURL: 'http://gw:8080/v1/', fetch, retry: fastRetry, ...extra });
}

describe('extension serialization', () => {
  it('sends the caliban object with typed fields, auth and content headers', async () => {
    const m = mockFetch(json(completion));
    await client(m.fetch).chat.completions.create({
      model: 'caliban/auto',
      messages: msgs,
      caliban: {
        pii: 'reversible',
        cache: 'semantic',
        datasources: ['sales_dw'],
        node: 'invoice-triage',
        max_cost_usd: 0.05,
        zdr: true,
        trace_id: 'tr-1',
      },
    });
    const call = m.calls[0]!;
    expect(call.url).toBe('http://gw:8080/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe('Bearer cal_test');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('accept')).toBe('application/json');
    expect(JSON.parse(call.body!)).toEqual({
      model: 'caliban/auto',
      messages: msgs,
      caliban: {
        pii: 'reversible',
        cache: 'semantic',
        datasources: ['sales_dw'],
        node: 'invoice-triage',
        max_cost_usd: 0.05,
        zdr: true,
        trace_id: 'tr-1',
      },
    });
  });

  it('merges client defaults with request-level fields (request wins, undefined ignored)', () => {
    const body = buildChatBody(
      { model: 'm', messages: msgs, caliban: { cache: 'off', pii: undefined } },
      { pii: 'mask', cache: 'exact', zdr: true },
    );
    expect(body.caliban).toEqual({ pii: 'mask', cache: 'off', zdr: true });
  });

  it('omits `caliban` entirely when nothing is set, so plain OpenAI bodies stay plain', () => {
    const body = buildChatBody({ model: 'm', messages: msgs, temperature: undefined, caliban: {} });
    expect(body).toEqual({ model: 'm', messages: msgs });
    expect('caliban' in body).toBe(false);
  });

  it('merges extraBody but never lets it clobber the resolved extension', () => {
    const body = buildChatBody({ model: 'm', messages: msgs, caliban: { zdr: true } }, undefined, {
      logit_bias: { '1': 2 },
      caliban: { zdr: false },
    });
    expect(body).toMatchObject({ logit_bias: { '1': 2 }, caliban: { zdr: true } });
  });

  it('rejects an invalid max_cost_usd before sending anything', async () => {
    const m = mockFetch(json(completion));
    const err = await client(m.fetch)
      .chat.completions.create({ model: 'm', messages: msgs, caliban: { max_cost_usd: Number.NaN } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanError);
    expect(err).toMatchObject({ type: 'invalid_request_error', code: 'invalid_max_cost_usd' });
    expect(m.calls).toHaveLength(0);
  });

  it('applies defaultCaliban from the client options', async () => {
    const m = mockFetch(json(completion));
    await client(m.fetch, { defaultCaliban: { pii: 'mask' } }).chat.completions.create({ model: 'm', messages: msgs });
    expect(JSON.parse(m.calls[0]!.body!).caliban).toEqual({ pii: 'mask' });
  });

  it('requires an api key', () => {
    expect(() => new CalibanClient({ apiKey: '', fetch: mockFetch().fetch })).toThrow(/Missing API key/);
  });
});

describe('response metadata', () => {
  const headers = {
    'x-caliban-request-id': 'req_123',
    'x-caliban-routed-model': 'local/llama-3.1-8b',
    'x-caliban-cache': 'HIT',
    'x-caliban-pii-entities': '3',
  };

  it('exposes header metadata on a non-enumerable `meta`', async () => {
    const m = mockFetch(json(completion, { headers }));
    const res = await client(m.fetch).chat.completions.create({ model: 'caliban/auto', messages: msgs });
    expect(res.meta).toMatchObject({
      requestId: 'req_123',
      routedModel: 'local/llama-3.1-8b',
      cache: 'hit',
      piiEntities: 3,
      status: 200,
    });
    expect(res.choices[0]?.message?.content).toBe('hello');
    expect(Object.keys(res)).not.toContain('meta');
    expect(JSON.parse(JSON.stringify(res))).toEqual(completion);
  });

  it('returns nulls when headers are missing or malformed', async () => {
    const m = mockFetch(json(completion, { headers: { 'x-caliban-pii-entities': 'lots' } }));
    const res = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs });
    expect(res.meta).toMatchObject({ requestId: null, routedModel: null, cache: null, piiEntities: null });
  });

  it('exposes metadata on streams before the first chunk', async () => {
    const m = mockFetch(() => sse(['data: [DONE]\n\n'], headers).response);
    const stream = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, stream: true });
    expect(stream).toBeInstanceOf(ChatCompletionStream);
    expect(stream.meta.routedModel).toBe('local/llama-3.1-8b');
    expect(stream.meta.piiEntities).toBe(3);
  });

  it('models.list() hits /v1/models', async () => {
    const m = mockFetch(json({ object: 'list', data: [{ id: 'caliban/auto', object: 'model', owned_by: 'caliban' }] }));
    const list = await client(m.fetch).models.list();
    expect(m.calls[0]!.url).toBe('http://gw:8080/v1/models');
    expect(m.calls[0]!.method).toBe('GET');
    expect(list.data[0]?.id).toBe('caliban/auto');
  });
});

describe('streaming', () => {
  it('yields parsed chunks across arbitrary network boundaries and stops at [DONE]', async () => {
    const raw = `data: ${JSON.stringify(chunk('Hel'))}\r\n\r\n: keep-alive\r\n\r\ndata: ${JSON.stringify(chunk('lo'))}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const pieces = raw.match(/[\s\S]{1,7}/g)!; // 7-char slices: splits lines, JSON and CRLF pairs
    const m = mockFetch(() => sse(pieces).response);
    const stream = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, stream: true });
    expect(m.calls[0]!.headers.get('accept')).toBe('text/event-stream');
    expect(JSON.parse(m.calls[0]!.body!).stream).toBe(true);
    const contents: string[] = [];
    for await (const c of stream) contents.push(c.choices[0]!.delta.content!);
    expect(contents).toEqual(['Hel', 'lo']);
  });

  it('text() concatenates content', async () => {
    const m = mockFetch(() => sse([`data: ${JSON.stringify(chunk('a'))}\n\ndata: ${JSON.stringify(chunk('b'))}\n\ndata: [DONE]\n\n`]).response);
    const stream = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, stream: true });
    expect(await stream.text()).toBe('ab');
  });

  it('can only be iterated once', async () => {
    const m = mockFetch(() => sse(['data: [DONE]\n\n']).response);
    const stream = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, stream: true });
    await stream.text();
    await expect(stream.text()).rejects.toThrow(/only be iterated once/);
  });

  it('cancels the HTTP body when the consumer breaks early', async () => {
    const s = sse([`data: ${JSON.stringify(chunk('a'))}\n\n`], {}, { hang: true });
    const m = mockFetch(() => s.response);
    const stream = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, stream: true });
    for await (const _c of stream) break;
    expect(s.wasCancelled()).toBe(true);
  });

  it('surfaces a mid-stream gateway error as CalibanStreamError and never retries', async () => {
    const m = mockFetch(
      () =>
        sse([
          `data: ${JSON.stringify(chunk('a'))}\n\n`,
          'event: error\ndata: {"error":{"message":"upstream reset","type":"upstream_error","code":null}}\n\n',
        ]).response,
    );
    const stream = await client(m.fetch, { retry: { ...fastRetry, maxRetries: 5 } }).chat.completions.create({
      model: 'm',
      messages: msgs,
      stream: true,
    });
    const err = await stream.text().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanStreamError);
    expect(err).toMatchObject({ type: 'upstream_error' });
    expect(m.calls).toHaveLength(1);
  });

  it('maps a dropped connection mid-stream to CalibanStreamError without retrying', async () => {
    const m = mockFetch(() => {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (n++ === 0) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk('a'))}\n\n`));
          else c.error(new TypeError('socket hang up'));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const stream = await client(m.fetch, { retry: { ...fastRetry, maxRetries: 5, retryOnNetworkError: true } }).chat.completions.create({
      model: 'm',
      messages: msgs,
      stream: true,
    });
    const seen: string[] = [];
    const err = await (async () => {
      for await (const c of stream) seen.push(c.choices[0]!.delta.content!);
    })().catch((e: unknown) => e);
    expect(seen).toEqual(['a']);
    expect(err).toBeInstanceOf(CalibanStreamError);
    expect(m.calls).toHaveLength(1);
  });
});

describe('error mapping', () => {
  it('maps the OpenAPI Error shape to CalibanAPIError', async () => {
    const m = mockFetch(
      json(
        { error: { message: 'PII policy forbids t3 model', type: 'policy_violation', code: 'pii_tier' } },
        { status: 403, headers: { 'x-caliban-request-id': 'req_9' } },
      ),
    );
    const err = await client(m.fetch)
      .chat.completions.create({ model: 'm', messages: msgs })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanAPIError);
    expect(err).toBeInstanceOf(CalibanError);
    expect(isCalibanError(err)).toBe(true);
    expect(err).toMatchObject({
      status: 403,
      type: 'policy_violation',
      code: 'pii_tier',
      message: 'PII policy forbids t3 model',
      requestId: 'req_9',
      error: { message: 'PII policy forbids t3 model', type: 'policy_violation', code: 'pii_tier' },
    });
    expect(String(err)).toBe('CalibanAPIError: 403 policy_violation (pii_tier): PII policy forbids t3 model');
  });

  it('falls back to a status-derived type and raw text for non-JSON bodies', async () => {
    const m = mockFetch(new Response('<html>bad gateway</html>', { status: 500 }));
    const err = (await client(m.fetch)
      .chat.completions.create({ model: 'm', messages: msgs })
      .catch((e: unknown) => e)) as CalibanAPIError;
    expect(err).toMatchObject({ status: 500, type: 'api_error', code: null, message: '<html>bad gateway</html>' });
  });

  it('uses status-derived types when the body is empty', async () => {
    const m = mockFetch(new Response(null, { status: 401, statusText: 'Unauthorized' }));
    const err = await client(m.fetch).models.list().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, type: 'authentication_error', message: 'HTTP 401 Unauthorized' });
  });

  it('maps fetch rejections to CalibanConnectionError', async () => {
    const m = mockFetch(() => Promise.reject(new TypeError('fetch failed')));
    const err = await client(m.fetch).models.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanConnectionError);
    expect(err).toMatchObject({ type: 'connection_error', status: undefined });
  });
});

describe('retry policy', () => {
  const rateLimited = () => json({ error: { message: 'slow down', type: 'rate_limited' } }, { status: 429 });

  it.each([429, 502, 503])('retries %i then succeeds', async (status) => {
    const m = mockFetch(new Response('{}', { status }), json(completion));
    const res = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs });
    expect(res.id).toBe('chatcmpl-1');
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]!.body).toBe(m.calls[0]!.body); // body re-sent intact
  });

  it.each([400, 401, 403, 404, 500, 504])('does not retry %i', async (status) => {
    const m = mockFetch(new Response('{}', { status }), json(completion));
    await expect(client(m.fetch).chat.completions.create({ model: 'm', messages: msgs })).rejects.toMatchObject({
      status,
    });
    expect(m.calls).toHaveLength(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const m = mockFetch(rateLimited);
    const err = await client(m.fetch, { retry: { ...fastRetry, maxRetries: 3 } })
      .chat.completions.create({ model: 'm', messages: msgs })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, type: 'rate_limited', message: 'slow down' });
    expect(m.calls).toHaveLength(4);
  });

  it('retry: false disables retries (client and per-request)', async () => {
    const m1 = mockFetch(rateLimited);
    await expect(client(m1.fetch, { retry: false }).models.list()).rejects.toBeInstanceOf(CalibanAPIError);
    expect(m1.calls).toHaveLength(1);
    const m2 = mockFetch(rateLimited);
    await expect(client(m2.fetch).models.list({ retry: false })).rejects.toBeInstanceOf(CalibanAPIError);
    expect(m2.calls).toHaveLength(1);
  });

  it('honours retryOnStatus overrides', async () => {
    const m = mockFetch(new Response('{}', { status: 500 }), json(completion));
    await client(m.fetch, { retry: { ...fastRetry, retryOnStatus: [500] } }).chat.completions.create({
      model: 'm',
      messages: msgs,
    });
    expect(m.calls).toHaveLength(2);
  });

  it('does not retry network errors by default, but does when enabled', async () => {
    const fail = () => Promise.reject(new TypeError('ECONNRESET'));
    const m1 = mockFetch(fail, json(completion));
    await expect(client(m1.fetch).models.list()).rejects.toBeInstanceOf(CalibanConnectionError);
    expect(m1.calls).toHaveLength(1);
    const m2 = mockFetch(fail, json({ object: 'list', data: [] }));
    await client(m2.fetch, { retry: { ...fastRetry, retryOnNetworkError: true } }).models.list();
    expect(m2.calls).toHaveLength(2);
  });

  it('retries a stream request that failed before it started (429 before headers)', async () => {
    const m = mockFetch(rateLimited, () => sse(['data: [DONE]\n\n']).response);
    const stream = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, stream: true });
    expect(await stream.text()).toBe('');
    expect(m.calls).toHaveLength(2);
  });
});

describe('abort and timeout', () => {
  /** A fetch that only settles when its signal aborts (like a real hung request). */
  const hangingFetch = () =>
    mockFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal?.addEventListener('abort', () => reject(call.signal?.reason ?? new Error('aborted')));
        }),
    );

  it('rejects immediately with an already-aborted signal and sends nothing', async () => {
    const m = mockFetch(json(completion));
    const ac = new AbortController();
    ac.abort();
    await expect(
      client(m.fetch).chat.completions.create({ model: 'm', messages: msgs }, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(CalibanAbortError);
    expect(m.calls).toHaveLength(0);
  });

  it('aborts an in-flight request', async () => {
    const m = hangingFetch();
    const ac = new AbortController();
    const p = client(m.fetch).chat.completions.create({ model: 'm', messages: msgs }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(CalibanAbortError);
  });

  it('aborts during retry backoff', async () => {
    const m = mockFetch(new Response('{}', { status: 503 }));
    const ac = new AbortController();
    const p = client(m.fetch, { retry: { initialDelayMs: 10_000, jitter: false } }).models.list({ signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(CalibanAbortError);
    expect(m.calls).toHaveLength(1);
  });

  it('times out with CalibanTimeoutError', async () => {
    const m = hangingFetch();
    const err = await client(m.fetch, { timeoutMs: 10 }).models.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanTimeoutError);
    expect(err).toMatchObject({ type: 'timeout' });
  });

  it('aborts a running stream via the caller signal', async () => {
    const ac = new AbortController();
    const m = mockFetch((call) => sse([`data: ${JSON.stringify(chunk('a'))}\n\n`], {}, { hang: true, signal: call.signal }).response);
    const stream = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, stream: true }, { signal: ac.signal });
    const seen: string[] = [];
    const err = await (async () => {
      for await (const c of stream) {
        seen.push(c.choices[0]!.delta.content!);
        ac.abort();
      }
    })().catch((e: unknown) => e);
    expect(seen).toEqual(['a']);
    expect(err).toBeInstanceOf(CalibanAbortError);
  });

  it('stream.abort() stops the stream', async () => {
    const m = mockFetch((call) => sse([`data: ${JSON.stringify(chunk('a'))}\n\n`], {}, { hang: true, signal: call.signal }).response);
    const stream = await client(m.fetch).chat.completions.create({ model: 'm', messages: msgs, stream: true });
    const it = stream[Symbol.asyncIterator]();
    await it.next();
    stream.abort();
    await expect(it.next()).rejects.toBeInstanceOf(CalibanAbortError);
  });
});
