/**
 * Read an environment variable without assuming a Node runtime.
 * Returns `undefined` in browsers / edge runtimes where `process` is absent.
 */
export function readEnv(name: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const value = proc?.env?.[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a fetch implementation lazily so callers (and tests) can swap `globalThis.fetch`. */
export function resolveFetch(custom?: typeof fetch): typeof fetch {
  if (custom) return custom;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof globalThis.fetch !== 'function') {
      throw new Error(
        '@caliban/sdk: no global fetch found. Use Node 20+, Bun, Deno, a browser, or pass `fetch` in the client options.',
      );
    }
    return globalThis.fetch(input, init);
  }) as typeof fetch;
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
