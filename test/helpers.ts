import { vi } from 'vitest';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  signal: AbortSignal | null;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch mock that records calls and answers from a queue of responders (last one repeats). */
export function mockFetch(...responders: Array<Responder | Response>) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const body = req.body ? await req.text() : null;
    const call: RecordedCall = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body,
      signal: init?.signal ?? (input instanceof Request ? input.signal : null),
    };
    calls.push(call);
    const r = responders[Math.min(calls.length - 1, responders.length - 1)];
    if (!r) throw new Error('mockFetch: no responder');
    return typeof r === 'function' ? r(call) : r.clone();
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
}

/** A Response whose body is delivered in exactly the given pieces (strings or raw bytes). */
export function chunkedBody(pieces: Array<string | Uint8Array>, opts: { signal?: AbortSignal | null; hang?: boolean } = {}) {
  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(typeof p === 'string' ? enc.encode(p) : p);
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => controller.error(opts.signal?.reason ?? new Error('aborted')));
      }
      if (!opts.hang) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

export function sse(pieces: Array<string | Uint8Array>, headers: Record<string, string> = {}, opts: Parameters<typeof chunkedBody>[1] = {}) {
  const { stream, wasCancelled } = chunkedBody(pieces, opts);
  const response = new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
  return { response, wasCancelled };
}

export function chunk(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...extra,
  };
}

export const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'local/llama',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

/** Fast retries for tests. */
export const fastRetry = { initialDelayMs: 1, maxDelayMs: 2, jitter: false } as const;
