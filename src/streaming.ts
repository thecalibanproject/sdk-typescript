import { CalibanError, CalibanStreamError } from './errors.js';
import type { RequestLifetime } from './internal/http.js';
import { parseResponseMeta } from './meta.js';
import { reasoningText } from './reasoning.js';
import { iterJSONChunks, iterSSEEvents } from './sse.js';
import type { CalibanResponseMeta, ChatCompletionChunk, ChatCompletionChunkChoice } from './types.js';

/** A piece of streamed text, tagged as model reasoning ("thinking") or answer content. */
export interface StreamTextPart {
  type: 'reasoning' | 'content';
  text: string;
}

/** Reasoning and answer text of a fully consumed stream (choice 0). */
export interface StreamTextResult {
  /** Concatenated `delta.reasoning_content` (or `delta.reasoning`); `''` if the model did not think. */
  reasoning: string;
  /** Concatenated `delta.content`: the answer. */
  content: string;
}

function firstChoice(chunk: ChatCompletionChunk): ChatCompletionChunkChoice | undefined {
  return chunk.choices.find((c) => (c.index ?? 0) === 0);
}

/**
 * A started chat-completion stream. Iterate it once with `for await`.
 *
 * Header metadata is available immediately via `meta` (headers arrive before the body).
 * Errors after this object exists are never retried.
 */
export class ChatCompletionStream implements AsyncIterable<ChatCompletionChunk> {
  readonly meta: CalibanResponseMeta;
  private consumed = false;

  constructor(
    readonly response: Response,
    private readonly lifetime: RequestLifetime,
  ) {
    this.meta = parseResponseMeta(response);
  }

  /** Abort the underlying HTTP request. A pending iteration rejects with CalibanAbortError. */
  abort(reason?: unknown): void {
    this.lifetime.controller.abort(reason);
  }

  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChatCompletionChunk> {
    if (this.consumed) {
      throw new CalibanError({ type: 'stream_error', message: 'A ChatCompletionStream can only be iterated once.' });
    }
    this.consumed = true;
    const body = this.response.body;
    try {
      if (!body) {
        // Runtimes without streaming bodies: fall back to buffering the whole response.
        const text = await this.response.text();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(text));
            c.close();
          },
        });
        yield* iterJSONChunks<ChatCompletionChunk>(iterSSEEvents(stream), this.meta.requestId);
        return;
      }
      yield* iterJSONChunks<ChatCompletionChunk>(iterSSEEvents(body), this.meta.requestId);
    } catch (err) {
      if (err instanceof CalibanError) throw err;
      const mapped = this.lifetime.classify(err);
      if (mapped.type === 'connection_error') {
        throw new CalibanStreamError({
          message: `Stream interrupted: ${mapped.message}`,
          requestId: this.meta.requestId,
          cause: err,
        });
      }
      throw mapped;
    } finally {
      this.lifetime.dispose();
    }
  }

  /** Convenience: consume the stream and concatenate the answer (`delta.content` of choice 0). */
  async text(): Promise<string> {
    return (await this.collect()).content;
  }

  /**
   * Consume the stream, yielding choice 0's non-empty text deltas tagged as `reasoning`
   * (`delta.reasoning_content`, or `delta.reasoning` on some servers) or `content`.
   *
   * ```ts
   * for await (const part of stream.textParts()) {
   *   if (part.type === 'reasoning') process.stderr.write(part.text); // thinking
   *   else process.stdout.write(part.text);                           // answer
   * }
   * ```
   */
  async *textParts(): AsyncGenerator<StreamTextPart, void, undefined> {
    for await (const chunk of this) {
      const delta = firstChoice(chunk)?.delta;
      if (!delta) continue;
      const r = reasoningText(delta);
      if (r) yield { type: 'reasoning', text: r };
      if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'content', text: delta.content };
    }
  }

  /** Consume the stream and return reasoning and answer text separately (choice 0). */
  async collect(): Promise<StreamTextResult> {
    const out: StreamTextResult = { reasoning: '', content: '' };
    for await (const part of this.textParts()) out[part.type] += part.text;
    return out;
  }
}
