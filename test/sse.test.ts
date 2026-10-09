import { describe, expect, it } from 'vitest';
import { CalibanStreamError } from '../src/errors.js';
import { iterJSONChunks, iterSSEEvents, SSEDecoder, type ServerSentEvent } from '../src/sse.js';
import { chunkedBody } from './helpers.js';

function decodeAll(pieces: string[]): ServerSentEvent[] {
  const d = new SSEDecoder();
  const out: ServerSentEvent[] = [];
  for (const p of pieces) out.push(...d.push(p));
  out.push(...d.flush());
  return out;
}

const datas = (evs: ServerSentEvent[]) => evs.map((e) => e.data);

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('SSEDecoder', () => {
  it('parses simple LF-delimited events', () => {
    expect(datas(decodeAll(['data: a\n\ndata: b\n\n']))).toEqual(['a', 'b']);
  });

  it('handles chunk boundaries split mid-line and mid-field-name', () => {
    expect(datas(decodeAll(['da', 'ta: {"x"', ':1}\n', '\nd', 'ata: 2\n\n']))).toEqual(['{"x":1}', '2']);
  });

  it('handles CRLF and bare CR line endings', () => {
    expect(datas(decodeAll(['data: a\r\n\r\ndata: b\r\rdata: c\n\n']))).toEqual(['a', 'b', 'c']);
  });

  it('treats a CRLF pair split across pushes as one line ending', () => {
    // If the trailing \r were treated as a full line ending, the following \n would be a
    // blank line and dispatch `a` early, then dispatch an empty-type event again.
    const evs = decodeAll(['data: a\r', '\ndata: b\r', '\n\r', '\n']);
    expect(datas(evs)).toEqual(['a\nb']);
  });

  it('gives identical results for every possible split point', () => {
    const raw = ': keep-alive\r\nevent: delta\r\nid: 7\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: [DONE]\r\n\r\n';
    const expected = decodeAll([raw]);
    expect(expected).toHaveLength(2);
    for (let i = 0; i <= raw.length; i++) {
      for (let j = i; j <= raw.length; j += 5) {
        expect(decodeAll([raw.slice(0, i), raw.slice(i, j), raw.slice(j)])).toEqual(expected);
      }
    }
  });

  it('ignores comments and keep-alives', () => {
    expect(datas(decodeAll([': ping\n\n:\n\ndata: x\n: mid-event comment\n\n']))).toEqual(['x']);
  });

  it('joins multi-line data with \\n and strips exactly one leading space', () => {
    expect(datas(decodeAll(['data: line1\ndata:line2\ndata:  two-spaces\n\n']))).toEqual([
      'line1\nline2\n two-spaces',
    ]);
  });

  it('parses event, id and retry fields; id persists, event type resets', () => {
    const evs = decodeAll(['event: error\nid: 1\nretry: 3000\ndata: x\n\ndata: y\n\n']);
    expect(evs[0]).toEqual({ event: 'error', data: 'x', id: '1', retry: 3000 });
    expect(evs[1]).toEqual({ event: null, data: 'y', id: '1', retry: null });
  });

  it('does not dispatch events without data, and treats a bare `data` as an empty line', () => {
    expect(decodeAll(['event: noop\n\n'])).toEqual([]);
    expect(datas(decodeAll(['data\ndata: z\n\n']))).toEqual(['\nz']);
  });

  it('strips a leading BOM', () => {
    expect(datas(decodeAll(['\uFEFFdata: x\n\n']))).toEqual(['x']);
  });

  it('flushes a trailing event without the final blank line (lenient)', () => {
    expect(datas(decodeAll(['data: a\n\ndata: tail']))).toEqual(['a', 'tail']);
    expect(datas(decodeAll(['data: tail\r']))).toEqual(['tail']);
  });
});

describe('iterSSEEvents (bytes)', () => {
  it('decodes multi-byte UTF-8 split across network chunks', async () => {
    const bytes = new TextEncoder().encode('data: héllo 🌍\n\n');
    const pieces = Array.from(bytes, (b) => new Uint8Array([b])); // one byte per chunk
    const { stream } = chunkedBody(pieces);
    expect(datas(await collect(iterSSEEvents(stream)))).toEqual(['héllo 🌍']);
  });

  it('cancels the reader when the consumer stops early', async () => {
    const { stream, wasCancelled } = chunkedBody(['data: 1\n\ndata: 2\n\n'], { hang: true });
    for await (const _ev of iterSSEEvents(stream)) break;
    expect(wasCancelled()).toBe(true);
  });
});

describe('iterJSONChunks', () => {
  async function chunksOf(raw: string[]) {
    const { stream } = chunkedBody(raw);
    return collect(iterJSONChunks<Record<string, unknown>>(iterSSEEvents(stream), 'req_1'));
  }

  it('stops at data: [DONE] and ignores anything after it', async () => {
    const out = await chunksOf(['data: {"n":1}\n\ndata: [DONE]\n\ndata: {"n":2}\n\n']);
    expect(out).toEqual([{ n: 1 }]);
  });

  it('parses JSON spread over multiple data lines and skips empty events', async () => {
    const out = await chunksOf(['data: {"n":\ndata: 1}\n\ndata:\n\ndata: [DONE]\n\n']);
    expect(out).toEqual([{ n: 1 }]);
  });

  it('throws CalibanStreamError for `event: error`', async () => {
    const err = await chunksOf([
      'data: {"n":1}\n\nevent: error\ndata: {"error":{"message":"upstream died","type":"upstream_error","code":"eof"}}\n\n',
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalibanStreamError);
    expect(err).toMatchObject({ type: 'upstream_error', code: 'eof', message: 'upstream died', requestId: 'req_1' });
  });

  it('throws CalibanStreamError for an inline {"error": ...} payload', async () => {
    const err = await chunksOf(['data: {"error":{"message":"budget","type":"policy_violation","code":null}}\n\n']).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CalibanStreamError);
    expect(err).toMatchObject({ type: 'policy_violation', code: null });
  });

  it('throws CalibanStreamError on malformed JSON', async () => {
    await expect(chunksOf(['data: {not json\n\n'])).rejects.toBeInstanceOf(CalibanStreamError);
  });
});
