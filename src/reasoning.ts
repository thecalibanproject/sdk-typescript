import type { ReasoningFields } from './types.js';

/**
 * The reasoning ("thinking") text of a completion message or stream delta, or `null` if there is
 * none. Reads `reasoning_content` (vLLM, SGLang, DeepSeek; also where Caliban puts inline
 * `<think>` blocks) and falls back to `reasoning` (the name some newer servers use).
 *
 * ```ts
 * const res = await caliban.chat.completions.create({ model: 'local/qwen3-8b', messages, caliban: { reasoning: 'high' } });
 * console.log(reasoningText(res.choices[0]?.message), res.choices[0]?.message?.content);
 * ```
 */
export function reasoningText(source: ReasoningFields | null | undefined): string | null {
  if (!source) return null;
  if (typeof source.reasoning_content === 'string') return source.reasoning_content;
  if (typeof source.reasoning === 'string') return source.reasoning;
  return null;
}
