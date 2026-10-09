import { CalibanStreamError, defaultErrorType } from './errors.js';

/** One dispatched Server-Sent Event (WHATWG HTML §9.2 "event stream" format). */
export interface ServerSentEvent {
  /** `event:` field, or `null` for the default "message" type. */
  event: string | null;
  /** All `data:` lines of the event joined with `\n`. */
  data: string;
  /** Last event ID seen on the stream (persists across events, per spec). */
  id: string | null;
  /** `retry:` reconnection time in ms, if sent on this event. */
  retry: number | null;
}

const LF = 10;
const CR = 13;

/**
 * Incremental, spec-compliant SSE decoder. Feed it decoded text in arbitrary pieces;
 * it handles `\n`, `\r\n` and bare `\r` line endings (including a `\r\n` pair split across
 * two pushes), comment lines (`:`), multi-line `data:` fields, and a leading BOM.
 */
export class SSEDecoder {
  private buffer = '';
  private dataLines: string[] = [];
  private eventType: string | null = null;
  private lastEventId: string | null = null;
  private retry: number | null = null;
  private started = false;

  /** Push a piece of text; returns every event completed by it. */
  push(text: string): ServerSentEvent[] {
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.buffer += text;
    return this.drain(false);
  }

  /**
   * Signal end of stream. Processes a trailing unterminated line and, leniently, dispatches
   * a pending event even if the server omitted the final blank line.
   */
  flush(): ServerSentEvent[] {
    const out = this.drain(true);
    if (this.buffer.length > 0) {
      this.processLine(this.buffer, out);
      this.buffer = '';
    }
    this.dispatch(out);
    return out;
  }

  private drain(final: boolean): ServerSentEvent[] {
    const out: ServerSentEvent[] = [];
    const buf = this.buffer;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (c === LF) {
        this.processLine(buf.slice(start, i), out);
        start = i + 1;
      } else if (c === CR) {
        // A trailing CR might be the first half of CRLF: wait for the next push.
        if (i + 1 === buf.length && !final) break;
        this.processLine(buf.slice(start, i), out);
        if (buf.charCodeAt(i + 1) === LF) i++;
        start = i + 1;
      }
    }
    this.buffer = buf.slice(start);
    return out;
  }

  private processLine(line: string, out: ServerSentEvent[]): void {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.charCodeAt(0) === 58 /* ':' */) return; // comment / keep-alive
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 32 /* ' ' */) value = value.slice(1);
    }
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        // unknown field: ignored per spec
        break;
    }
  }

  private dispatch(out: ServerSentEvent[]): void {
    if (this.dataLines.length === 0) {
      // Per spec, an event with no data is not dispatched; reset the type.
      this.eventType = null;
      this.retry = null;
      return;
    }
    out.push({ event: this.eventType, data: this.dataLines.join('\n'), id: this.lastEventId, retry: this.retry });
    this.dataLines = [];
    this.eventType = null;
    this.retry = null;
  }
}

/** Decode a byte stream into SSE events. Cancels the underlying reader on early exit. */
export async function* iterSSEEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const sse = new SSEDecoder();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        yield* sse.push(decoder.decode(value, { stream: true }));
      }
    }
    const tail = decoder.decode();
    if (tail) yield* sse.push(tail);
    yield* sse.flush();
    finished = true;
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/** Terminal sentinel used by OpenAI-compatible streams. */
export const DONE_SENTINEL = '[DONE]';

function streamErrorFrom(payload: unknown, raw: string, requestId: string | null): CalibanStreamError {
  const err =
    typeof payload === 'object' && payload !== null && 'error' in payload
      ? (payload as { error: unknown }).error
      : payload;
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    message?: unknown;
    type?: unknown;
    code?: unknown;
    status?: unknown;
  };
  const status = typeof e.status === 'number' ? e.status : undefined;
  return new CalibanStreamError({
    message: typeof e.message === 'string' ? e.message : raw || 'Stream error',
    type: typeof e.type === 'string' ? e.type : status ? defaultErrorType(status) : 'stream_error',
    code: typeof e.code === 'string' ? e.code : null,
    requestId,
    body: payload,
    ...(status !== undefined ? { status } : {}),
  });
}

/**
 * Turn SSE events into parsed JSON chunks. Stops at `data: [DONE]`, skips empty events,
 * and throws {@link CalibanStreamError} on `event: error`, on `{"error": ...}` payloads
 * and on malformed JSON.
 */
export async function* iterJSONChunks<T>(
  events: AsyncIterable<ServerSentEvent>,
  requestId: string | null = null,
): AsyncGenerator<T> {
  for await (const ev of events) {
    const data = ev.data;
    const trimmed = data.trim();
    if (trimmed === DONE_SENTINEL) return;
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (cause) {
      if (ev.event === 'error') throw streamErrorFrom(undefined, data, requestId);
      throw new CalibanStreamError({
        message: `Malformed stream chunk: ${trimmed.slice(0, 200)}`,
        requestId,
        body: data,
        cause,
      });
    }
    if (
      ev.event === 'error' ||
      (typeof parsed === 'object' && parsed !== null && 'error' in parsed && !('choices' in parsed))
    ) {
      throw streamErrorFrom(parsed, data, requestId);
    }
    yield parsed as T;
  }
}
