# @caliban/sdk

TypeScript SDK for **Caliban**, the on-prem-capable, BYOK AI gateway.

- **Data plane** (`:8080`, `/v1/*`): an OpenAI-compatible client with typed Caliban extensions,
  header metadata, SSE streaming, retries and typed errors.
- **Control plane** (`:8081`, `/api/v1/*`): a fully typed admin client generated from
  [`core/api/openapi.yaml`](../core/api/openapi.yaml).
- **Node authoring**: `defineNode()`, typed from [`core/schemas/node.schema.json`](../core/schemas/node.schema.json).

The package ships ESM and CJS builds plus type declarations. It runs on Node 20+, Bun, Deno,
browsers and edge runtimes: it only needs `fetch`. Its one runtime dependency is
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/), and it sends **no telemetry**.

> **Licence:** [Apache-2.0](./LICENSE). Copyright 2026 Elie Sfeir. The package stays marked
> `private` in `package.json` until it is published to a registry.

```sh
pnpm add @caliban/sdk
```

---

## 1. Use the official `openai` package against Caliban

Caliban speaks the OpenAI wire protocol, so the official SDK works unchanged: just point
`baseURL` at the gateway and use a tenant key (`cal_…`). `@caliban/sdk` does **not** depend on
`openai`; this section is documentation only.

```ts
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.CALIBAN_API_KEY, // cal_…
  baseURL: 'http://localhost:8080/v1',
});

const { data, response } = await openai.chat.completions
  .create({
    model: 'caliban/auto',
    messages: [{ role: 'user', content: 'Summarise last quarter’s churn.' }],
    // The extension is passed through as an extra body field. Plain OpenAI types don't know it:
    // @ts-expect-error Caliban extension
    caliban: { pii: 'reversible', cache: 'semantic', datasources: ['sales_dw'] },
  })
  .withResponse();

console.log(data.choices[0]?.message.content);
console.log(response.headers.get('x-caliban-routed-model'), response.headers.get('x-caliban-cache'));
```

You can import `CalibanExtension` from `@caliban/sdk` to type that object
(`caliban: { … } satisfies CalibanExtension`).

## 2. `CalibanClient` (data plane)

```ts
import { CalibanClient } from '@caliban/sdk';

const caliban = new CalibanClient({
  apiKey: process.env.CALIBAN_API_KEY,  // defaults to $CALIBAN_API_KEY
  baseURL: 'http://localhost:8080/v1',  // defaults to $CALIBAN_BASE_URL or this value
  defaultCaliban: { pii: 'reversible' }, // merged into every request (request keys win)
});

const completion = await caliban.chat.completions.create({
  model: 'caliban/auto',
  messages: [{ role: 'user', content: 'Which invoices are overdue for ACME?' }],
  caliban: {
    pii: 'reversible',          // off | mask | reversible
    cache: 'exact',             // off | exact | semantic
    datasources: ['sales_dw'],
    node: 'invoice-triage',
    max_cost_usd: 0.05,
    reasoning: 'low',           // off | low | medium | high (reasoning models only)
    zdr: true,                  // zero data retention
    trace_id: 'checkout-1234',
  },
});

console.log(completion.choices[0]?.message?.content);

// Metadata from the x-caliban-* response headers. It sits on a non-enumerable `meta`
// property, so JSON.stringify(completion) still gives the plain OpenAI shape.
const { requestId, routedModel, cache, piiEntities, costUsd } = completion.meta;
// costUsd comes from x-caliban-cost-usd: non-streaming only, null when the model has no price.

const models = await caliban.models.list(); // GET /v1/models; items carry a `caliban` object
// { kind, family, capabilities, trust_tier } (absent on the virtual `caliban/auto` entry)

const { data } = await caliban.embeddings.create({ model: 'local/bge-m3', input: ['a', 'b'] }); // POST /v1/embeddings
```

The request type has no open index signature on purpose. A typo such as `calliban:` fails to
compile; otherwise the PII/ZDR policy you meant to apply would be dropped without any warning.
To send other OpenAI-compatible fields, pass them through `{ extraBody: { … } }` in the request
options.

### Streaming

```ts
const stream = await caliban.chat.completions.create({
  model: 'caliban/auto',
  messages: [{ role: 'user', content: 'Write a haiku about sovereignty.' }],
  stream: true,
  caliban: { cache: 'off' },
});

console.log('routed to', stream.meta.routedModel); // headers arrive before the body

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}
// or: const text = await stream.text();
```

The SSE parser follows the WHATWG spec. It handles `data: [DONE]`, events with several
`data:` lines, comments and keep-alives, `\n`, `\r\n` and bare `\r` line endings, and chunk
boundaries anywhere, including inside a UTF-8 character or between the `\r` and `\n` of a
CRLF pair. If the gateway sends an error mid-stream (`event: error` or `{"error": …}`), you get
a `CalibanStreamError`.

### Errors, retries, timeouts, cancellation

```ts
import { CalibanAPIError, CalibanAbortError, isCalibanError } from '@caliban/sdk';

const ac = new AbortController();
try {
  await caliban.chat.completions.create(
    { model: 'caliban/auto', messages },
    { signal: ac.signal, timeoutMs: 30_000, retry: { maxRetries: 4 } },
  );
} catch (err) {
  if (err instanceof CalibanAPIError) {
    // Mirrors the contract's Error shape: { error: { message, type, code } }
    console.error(err.status, err.type, err.code, err.message, err.requestId);
  } else if (err instanceof CalibanAbortError) {
    /* cancelled */
  }
}
```

| Error class | When |
|---|---|
| `CalibanAPIError` | Non-2xx response. `status`, `type` (e.g. `policy_violation`, `rate_limited`), `code`, `requestId`. |
| `CalibanConnectionError` | No response (DNS, reset, …). `CalibanTimeoutError` is a subclass. |
| `CalibanAbortError` | Your `AbortSignal` fired, or you called `stream.abort()`. |
| `CalibanStreamError` | A stream that had already started failed (error event, bad chunk, dropped connection). |

All of them extend `CalibanError`. `isCalibanError()` also works when two copies of the SDK
are loaded.

**Retries:** 2 retries by default on **429, 502 and 503**. The delay grows exponentially from
500 ms up to 8 s, with jitter, and the client honours `retry-after-ms` and `retry-after` up to
60 s. You can configure this per client or per request; `retry: false` turns it off.
Network-level failures are **not** retried by default (`retryOnNetworkError: true` turns that
on), because a chat completion may already have been billed upstream. **Once a stream has
started, nothing is retried.** The timeout (default 10 min) applies to each attempt. For
streams it only covers the time until the headers arrive.

## 3. `CalibanAdmin` (control plane)

```ts
import { CalibanAdmin } from '@caliban/sdk';

const admin = new CalibanAdmin({
  token: process.env.CALIBAN_ADMIN_TOKEN, // defaults to $CALIBAN_ADMIN_TOKEN
  baseUrl: 'http://localhost:8081',       // defaults to $CALIBAN_ADMIN_URL or this value
});

const tenant = await admin.tenants.create({ name: 'Acme', pii_default: 'reversible' });

// BYOK: a customer key, or a keyless on-prem endpoint (vLLM, Ollama, …)
await admin.providerKeys.create(tenant.id, {
  kind: 'openai_compatible',
  label: 'on-prem vLLM',
  base_url: 'http://vllm:8000/v1',
  trust_tier: 't0_sovereign',
});

const { key } = await admin.apiKeys.create(tenant.id, { name: 'ci' }); // plaintext shown once

const ds = await admin.datasources.create({
  tenant_id: tenant.id, kind: 'postgres', name: 'sales_dw',
  connection: { url: 'postgres://…' },
});
await admin.datasources.introspect(ds.id);

const ontology = await admin.ontology.get({ tenant_id: tenant.id });
for (const el of ontology.elements.filter((e) => e.status === 'proposed')) {
  await admin.ontology.review(el.id, { decision: 'approve', note: 'checked by data team' });
}

const usage = await admin.usage.get({ tenant_id: tenant.id, limit: 50 });
console.log(usage.totals.tokens_saved);

// Anything not wrapped yet: the fully typed openapi-fetch client
const { data } = await admin.raw.GET('/api/v1/health');
```

Helpers: `tenants` (list/create/get), `apiKeys` (list/create), `providerKeys`
(list/create/delete), `models` (list/create/delete), `providers` (list/create/delete/health/discover),
`datasources` (list/create/introspect), `ontology` (get/review), `nodes` (list/create), `usage.get`
and `health()`. Non-2xx responses throw a `CalibanAPIError`.

## 4. Open models on-prem (Qwen etc.)

Caliban can route to open models you serve yourself (vLLM, SGLang, llama.cpp, Ollama, TEI…)
through any OpenAI-compatible endpoint. Traffic to a `t0_sovereign` server never leaves your
network.

### Register an on-prem server and its models (control plane)

```ts
import { CalibanAdmin } from '@caliban/sdk';

const admin = new CalibanAdmin();

// 1. A shared model server, usable by all tenants (or an allow-list in `tenants`).
await admin.providers.create({
  id: 'gpu-pool',
  kind: 'openai_compatible',
  base_url: 'http://vllm.internal:8000/v1',
  trust_tier: 't0_sovereign',
  cache_salt: true, // per-tenant vLLM prefix-cache isolation
});
console.log(await admin.providers.health('gpu-pool')); // { status: 'ok', latency_ms, models }

// 2. Ask the server what it serves. Caliban suggests catalogue entries (kind, family,
//    reasoning capabilities…) for models that are not registered yet. Suggestions are
//    heuristic: review them before saving.
const { available, suggested } = await admin.providers.discover('gpu-pool');
console.log(available); // e.g. ['Qwen/Qwen3-8B', 'BAAI/bge-m3']

// 3. Register the ones you want, adjusting fields as needed.
for (const s of suggested.filter((s) => s.upstream_model.startsWith('Qwen/') || s.kind === 'embedding')) {
  await admin.models.create({ ...s, context_window: s.context_window ?? 32_768 });
}

// Model ids contain '/', e.g. local/qwen3-8b. The SDK sends them unescaped, as the API expects.
await admin.models.delete('local/old-model'); // 409 if a route still uses it
```

### Reasoning toggle

`caliban.reasoning` (`off | low | medium | high`) is translated for the model family: Qwen3's
`enable_thinking` switch, `reasoning_effort` for models that take one. Thinking comes back in
`reasoning_content` (Caliban also moves inline `<think>…</think>` blocks there), separate from the
answer in `content`.

```ts
import { CalibanClient, reasoningText } from '@caliban/sdk';

const caliban = new CalibanClient();

// Fast path: thinking off.
const quick = await caliban.chat.completions.create({
  model: 'local/qwen3-8b',
  messages: [{ role: 'user', content: 'Capital of France?' }],
  caliban: { reasoning: 'off' },
});

// Think hard, and keep the reasoning apart from the answer.
const res = await caliban.chat.completions.create({
  model: 'local/qwen3-8b',
  messages: [{ role: 'user', content: 'Is 3599 prime?' }],
  caliban: { reasoning: 'high' },
});
console.log(reasoningText(res.choices[0]?.message)); // reasoning_content (or `reasoning`)
console.log(res.choices[0]?.message?.content);       // the answer

// Streaming: textParts() tags each delta; collect() returns both strings.
const stream = await caliban.chat.completions.create({
  model: 'local/qwen3-8b',
  messages: [{ role: 'user', content: 'Plan a 3-step migration.' }],
  stream: true,
  caliban: { reasoning: 'medium' },
});
for await (const part of stream.textParts()) {
  if (part.type === 'reasoning') process.stderr.write(part.text);
  else process.stdout.write(part.text);
}
// or: const { reasoning, content } = await stream.collect();
```

Streams read `delta.reasoning_content` and fall back to `delta.reasoning`, which some servers use.
`stream.text()` returns the answer only.

### Embeddings

```ts
const res = await caliban.embeddings.create({
  model: 'local/bge-m3',               // a model registered with kind: 'embedding'
  input: ['first passage', 'second passage'], // a string or an array of strings
});
const vectors = res.data.map((d) => d.embedding);
console.log(res.meta.routedModel, res.meta.piiEntities);
```

Inputs sent to a provider outside the trust boundary are PII-masked (`[EMAIL]`, `[PERSON]`…), not
pseudonymised, because vectors cannot be rehydrated. Pass server-specific fields through
`{ extraBody: { … } }`.

### Rerank

Score candidate passages against a query with a rerank model, e.g. Qwen3-Reranker served by
vLLM or bge-reranker served by TEI, registered with `kind: 'rerank'`.

```ts
const docs = ['Paris is in France.', 'Bananas are yellow.', 'The Eiffel Tower is in Paris.'];
const res = await caliban.rerank.create({
  model: 'local/qwen3-reranker',  // or e.g. 'local/bge-reranker-v2-m3' on TEI
  query: 'Where is the Eiffel Tower?',
  documents: docs,                 // at least one string
  top_n: 2,                        // optional: keep only the best N
  return_documents: true,          // optional: echo the text in results[].document.text
});
for (const r of res.results) console.log(r.relevance_score, docs[r.index]); // best first
console.log(res.meta.requestId, res.meta.routedModel);
```

`results` keep the server's order (highest `relevance_score` first); `index` points into
`documents`. The SDK rejects an empty `documents` array, a non-string document or an invalid
`top_n` before sending. Text sent outside the trust boundary is PII-masked, and returned
documents are always your originals.

## 5. `defineNode` (node authoring)

```ts
import { CalibanAdmin, defineNode } from '@caliban/sdk';

export const invoiceTriage = defineNode({
  kind: 'agent',
  description: 'Classify inbound invoices and flag anomalies.',
  prompt: { system: 'You triage supplier invoices…', output_schema: { type: 'object' } },
  model_policy: {
    candidates: ['tier:small', 'tier:frontier'],
    escalate_on: ['schema_violation', 'low_confidence'],
    min_trust_tier: 't1_attested',
    max_cost_usd: 0.02,
  },
  tools: [{ ref: 'mcp://erp/lookup_invoice#sha256:…', effect: 'read' }],
  datasources: { scopes: ['erp.invoices:read'] },
  guardrails: { pii: 'reversible', injection_mode: 'plan_then_execute' },
  budgets: { steps: 12, tokens: 40_000, wall_clock_s: 90 },
  exposure: { http: true, mcp_tool: true },
});

await new CalibanAdmin().nodes.create({ tenant_id: 't_1', name: 'invoice-triage', spec: invoiceTriage });
```

`defineNode` returns its argument unchanged and keeps literal types. Unknown top-level keys,
wrong enums and missing required fields are compile errors. Constraints that TypeScript cannot
express (`minimum`, `maximum`, `pattern`) are checked by the control plane.

---

## Development

The `core` repo has to be checked out next to this one (`~/caliban/core`) for code generation.
Generated files are committed under `src/generated/`, so a normal build does not need `core`.

```sh
pnpm install
pnpm gen:api       # core/api/openapi.yaml        -> src/generated/schema.ts (openapi-typescript)
pnpm gen:schemas   # core/schemas/node.schema.json -> src/generated/node.ts   (json-schema-to-typescript)
pnpm typecheck
pnpm test          # vitest run (one-shot, fetch is mocked, no network); `pnpm test:watch` for watch mode
pnpm build         # tsup -> dist/ (ESM + CJS + .d.ts/.d.cts)
```

The tooling needs Node 22.12+ (vitest 5). The published library supports Node 20+. pnpm's built-in
`test` command rejects unknown flags such as `pnpm test --run`. Use `pnpm test`,
`pnpm run test --run` or `pnpm test -- <vitest args>` instead.

| Env var | Used by | Default |
|---|---|---|
| `CALIBAN_API_KEY` | `CalibanClient` | (required) |
| `CALIBAN_BASE_URL` | `CalibanClient` | `http://localhost:8080/v1` |
| `CALIBAN_ADMIN_TOKEN` | `CalibanAdmin` | (required) |
| `CALIBAN_ADMIN_URL` | `CalibanAdmin` | `http://localhost:8081` |

These are only read where `process.env` exists. In browsers and edge runtimes, pass the values
explicitly. Never ship an admin token to a browser.
