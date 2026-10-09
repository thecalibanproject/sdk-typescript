<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thecalibanproject/website/main/public/brand/logo-white.svg">
  <img alt="Caliban" src="https://raw.githubusercontent.com/thecalibanproject/website/main/public/brand/logo.svg" width="200">
</picture>

# Caliban TypeScript SDK

Typed TypeScript client for the Caliban AI gateway: OpenAI-compatible inference with Caliban extensions, the admin API, and node authoring.

[Docs](https://github.com/thecalibanproject/docs) · [Core](https://github.com/thecalibanproject/core) · [Python SDK](https://github.com/thecalibanproject/sdk-python)

## What it is

[Caliban](https://github.com/thecalibanproject/core) is a sovereign AI gateway. It gives a company a single OpenAI- and Anthropic-compatible endpoint and handles:

- intent classification and routing (`caliban/auto` picks the model);
- PII screening and pseudonymisation before anything reaches an outside provider;
- an ontology layer that compiles typed queries (CQIR) to MongoDB pipelines, or to SQL over a CDC replica;
- exact and semantic caching;
- agents ("nodes");
- open-weight models (Qwen and others) served on your own hardware.

Caliban is BYOK only: you bring your own provider keys or local model endpoints, and upstream keys are never pooled. It can run fully on-prem with zero egress. The core is a single Rust binary.

This package, `@caliban/sdk`, covers three surfaces:

| Surface | Where | In this SDK |
|---|---|---|
| Data plane (OpenAI-compatible) | `http://localhost:8080/v1` | `CalibanClient` |
| Control plane (admin API) | `http://localhost:8081/api/v1` | `CalibanAdmin` |
| Node authoring | types from `core/schemas/node.schema.json` | `defineNode()` |

It ships ESM and CJS builds with type declarations and runs anywhere `fetch` exists: Node 20+, Bun, Deno, browsers and edge runtimes. The only runtime dependency is [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/). The SDK sends no telemetry and talks only to the URLs you configure.

**Status:** Caliban is in active development with design partners. The SDK is at version 0.1.0 and its API may still change.

## Install

`@caliban/sdk` is not published to npm yet (the package is marked `private`). The build output is not committed and there is no `prepare` script, so `npm install github:thecalibanproject/sdk-typescript` will not give you a working package. Build it from source and install the tarball instead:

```sh
git clone https://github.com/thecalibanproject/sdk-typescript.git
cd sdk-typescript
pnpm install
pnpm build
npm pack            # writes caliban-sdk-0.1.0.tgz
```

Then, in your project:

```sh
npm install /path/to/sdk-typescript/caliban-sdk-0.1.0.tgz
```

`pnpm add` and `yarn add` accept the same tarball path.

## Quick start

You need a running Caliban gateway and a tenant API key (`cal_…`).

```ts
import { CalibanClient } from '@caliban/sdk';

const caliban = new CalibanClient({
  apiKey: process.env.CALIBAN_API_KEY,  // defaults to $CALIBAN_API_KEY
  baseURL: 'http://localhost:8080/v1',  // defaults to $CALIBAN_BASE_URL, then this value
});

const completion = await caliban.chat.completions.create({
  model: 'caliban/auto',
  messages: [{ role: 'user', content: 'Which invoices are overdue for ACME?' }],
  caliban: { pii: 'reversible', cache: 'semantic', datasources: ['sales'] },
});

console.log(completion.choices[0]?.message?.content);
console.log(completion.meta.routedModel, completion.meta.cache, completion.meta.piiEntities);
```

## Core concepts

### The `caliban` request extension

Every data-plane request body can carry a `caliban` object. Clients that do not know about it simply leave it out, so the gateway stays wire-compatible with OpenAI. The type is exported as `CalibanExtension`.

| Field | Values | Meaning |
|---|---|---|
| `pii` | `off`, `mask`, `reversible` | How PII is handled before text leaves your trust boundary. `mask` replaces entities with placeholders such as `[EMAIL]`; `reversible` pseudonymises them and restores the originals in the response. |
| `cache` | `off`, `exact`, `semantic` | Response cache mode. `off`: no cache. `exact`: exact cache only. `semantic`: exact, then the semantic cache if the tenant has it on, whatever the temperature. Left out: exact, plus semantic up to the gateway's temperature limit if the tenant has it on (see [Tenant settings](#tenant-settings)). |
| `datasources` | `string[]` | Datasources (by name) the request may query through the ontology layer. |
| `node` | `string` | Run the request through a named node (agent). |
| `max_cost_usd` | number, `>= 0` | Cost ceiling for the request. |
| `reasoning` | `off`, `low`, `medium`, `high` | Reasoning effort, translated for the model family (see [Reasoning models](#reasoning-models)). |
| `zdr` | `boolean` | Zero data retention. |
| `trace_id` | `string` | Your own correlation id. |

Fields you leave out take the gateway's defaults (in the API contract: `pii: 'reversible'`, `cache: 'exact'`, `zdr: false`).

Set defaults for every chat request with `defaultCaliban`. Request-level keys win:

```ts
const caliban = new CalibanClient({ defaultCaliban: { pii: 'reversible', zdr: true } });
```

The SDK checks the extension before sending: `max_cost_usd` must be a finite number `>= 0`, `reasoning` must be one of the four values, and `datasources` must be an array. A failure throws `CalibanError` with `type: 'invalid_request_error'`.

The chat request type deliberately has no open index signature. A typo such as `calliban:` is a compile error instead of a silently dropped PII or ZDR policy. To send other OpenAI-compatible fields, use `extraBody` in the request options.

### Response metadata

The gateway reports what it did in `x-caliban-*` response headers. The SDK parses them into a `CalibanResponseMeta` on a non-enumerable `meta` property, so `JSON.stringify(completion)` still gives the plain OpenAI shape.

| Header | `meta` field | Notes |
|---|---|---|
| `x-caliban-request-id` | `requestId` | Quote it in bug reports. |
| `x-caliban-routed-model` | `routedModel` | The model the router actually used (useful with `caliban/auto`). |
| `x-caliban-cache` | `cache` | `hit`, `miss` or `bypass`. `hit` covers both cache tiers. |
| `x-caliban-cache-tier` | `cacheTier` | `'exact'` or `'semantic'`, sent on hits only. `undefined` otherwise. |
| `x-caliban-intent` | `intent` | The routing decision, parsed into `{ intent, confidence, stage, knnReason? }`. `undefined` when absent or malformed. |
| `x-caliban-pii-entities` | `piiEntities` | Number of PII entities detected and protected. |
| `x-caliban-cost-usd` | `costUsd` | Non-streaming responses only; `null` when the model has no price. |

`meta.status` holds the HTTP status and `meta.headers` the full `Headers` object. The header names are exported as constants (`HEADER_REQUEST_ID`, `HEADER_ROUTED_MODEL`, `HEADER_CACHE`, `HEADER_CACHE_TIER`, `HEADER_INTENT`, `HEADER_PII_ENTITIES`, `HEADER_COST_USD`), and `parseResponseMeta(response)` works on any `Response`.

The gateway sends `x-caliban-intent` as `<intent>;confidence=<0..1>;stage=<rules|knn|keyword>`, plus `;knn=<reason>` when kNN routing was on but did not decide (`timeout`, `embed_error`, `unavailable`, `no_text`, `abstain_oos`, `abstain_confidence`, `abstain_margin`, `abstain_empty`). A request for a named model reports `pinned;confidence=1.000;stage=rules`.

```ts
const res = await caliban.chat.completions.create({ model: 'caliban/auto', messages });
if (res.meta.cache === 'hit') console.log('served from the', res.meta.cacheTier, 'cache');
const route = res.meta.intent; // { intent: 'translate', confidence: 0.912, stage: 'knn' }
if (route?.knnReason) console.warn('kNN fell back to', route.stage, 'because of', route.knnReason);
```

Parsing never throws. Unknown `key=value` fields are ignored, so a newer gateway can add fields. A value with no intent name, a missing or out-of-range `confidence`, or a missing or unknown `stage` gives `intent: undefined`; an unknown cache tier gives `cacheTier: undefined`. `parseIntentHeader(value)` and `parseCacheTier(value)` are exported for raw header strings.

### Reasoning models

`caliban.reasoning` is translated for the model family: Qwen3's `enable_thinking` switch, or `reasoning_effort` for models that take one. `off` disables thinking on hybrid models. The thinking text comes back in `reasoning_content`, separate from the answer in `content`; Caliban also moves inline `<think>…</think>` blocks there. `reasoningText()` reads `reasoning_content` and falls back to `reasoning`, the name some servers use.

```ts
import { CalibanClient, reasoningText } from '@caliban/sdk';

const caliban = new CalibanClient();

const res = await caliban.chat.completions.create({
  model: 'local/qwen3-8b',
  messages: [{ role: 'user', content: 'Is 3599 prime?' }],
  caliban: { reasoning: 'high' },
});
console.log(reasoningText(res.choices[0]?.message)); // the thinking
console.log(res.choices[0]?.message?.content);       // the answer
```

See [Streaming](#streaming) for separating reasoning from content in a stream.

## API reference highlights

### `CalibanClient` (data plane)

```ts
new CalibanClient(options?: CalibanClientOptions)
```

| Option | Default | Notes |
|---|---|---|
| `apiKey` | `$CALIBAN_API_KEY` | Tenant key (`cal_…`). Required. |
| `baseURL` | `$CALIBAN_BASE_URL` or `http://localhost:8080/v1` | Includes `/v1`, like the OpenAI SDK. |
| `defaultCaliban` | none | Merged into every chat request. |
| `timeoutMs` | `600_000` | Per attempt. For streams it covers the time until headers arrive. |
| `retry` | 2 retries on 429 and 503 (GET also on 502) | `RetryOptions`, or `false` to disable. See [Retries](#errors-retries-and-timeouts). |
| `defaultHeaders` | none | Sent on every request. |
| `fetch` | `globalThis.fetch` | Custom fetch, for example for proxies or tests. |

| Method | Endpoint | Returns |
|---|---|---|
| `chat.completions.create(params, options?)` | `POST /v1/chat/completions` | `WithMeta<ChatCompletion>`, or a `ChatCompletionStream` when `stream: true` |
| `embeddings.create(params, options?)` | `POST /v1/embeddings` | `WithMeta<CreateEmbeddingResponse>` |
| `rerank.create(params, options?)` | `POST /v1/rerank` | `WithMeta<RerankResponse>` |
| `models.list(options?)` | `GET /v1/models` | `WithMeta<ModelList>` |

Every method takes the same `RequestOptions`:

| Option | Notes |
|---|---|
| `signal` | An `AbortSignal` to cancel the request. |
| `timeoutMs` | Overrides the client timeout for this call. |
| `retry` | Merged over the client retry policy; `false` disables retries. |
| `headers` | Extra headers for this call. |
| `idempotencyKey` | Sent as the `Idempotency-Key` header, which makes this POST retryable on 502 and lets the gateway answer a retry from the first attempt instead of running it again (see [Errors, retries and timeouts](#errors-retries-and-timeouts)). Not sent unless you set it. |
| `extraBody` | Extra JSON fields merged into the body (after the typed params, before `caliban`). |

**Models.** Items from `models.list()` carry a `caliban` object (`kind`, `family`, `capabilities`, `trust_tier`). It is absent on the virtual `caliban/auto` entry.

**Embeddings.**

```ts
const res = await caliban.embeddings.create({
  model: 'local/bge-m3',                        // a model registered with kind: 'embedding'
  input: ['first passage', 'second passage'],   // a string or an array of strings
});
const vectors = res.data.map((d) => d.embedding);
console.log(res.meta.routedModel, res.meta.piiEntities);
```

Inputs sent to a provider outside the trust boundary are PII-masked (`[EMAIL]`, `[PERSON]`, and so on), not pseudonymised, because vectors cannot be rehydrated. `dimensions`, `encoding_format: 'float'` and `user` are also accepted.

**Rerank.** Score candidate passages against a query with a model registered as `kind: 'rerank'`, for example Qwen3-Reranker on vLLM or bge-reranker on TEI.

```ts
const docs = ['Paris is in France.', 'Bananas are yellow.', 'The Eiffel Tower is in Paris.'];
const res = await caliban.rerank.create({
  model: 'local/qwen3-reranker',
  query: 'Where is the Eiffel Tower?',
  documents: docs,          // at least one string
  top_n: 2,                 // optional: keep only the best N
  return_documents: true,   // optional: echo the text in results[].document.text
});
for (const r of res.results) console.log(r.relevance_score, docs[r.index]); // best first
```

`results` keep the server's order (highest `relevance_score` first) and `index` points into `documents`. The SDK rejects a non-string query, an empty or non-string `documents` array and an invalid `top_n` before sending. Text sent outside the trust boundary is PII-masked; returned documents are always your originals.

### `CalibanAdmin` (control plane)

Thin helpers over a fully typed `openapi-fetch` client generated from the [core API contract](https://github.com/thecalibanproject/core/blob/main/api/openapi.yaml). Never ship an admin token to a browser.

```ts
import { CalibanAdmin } from '@caliban/sdk';

const admin = new CalibanAdmin({
  token: process.env.CALIBAN_ADMIN_TOKEN, // defaults to $CALIBAN_ADMIN_TOKEN
  baseUrl: 'http://localhost:8081',       // origin without /api/v1; defaults to $CALIBAN_ADMIN_URL, then this value
});

const tenant = await admin.tenants.create({ name: 'Acme', pii_default: 'reversible' });

// BYOK: a provider key, or a keyless on-prem endpoint (vLLM, Ollama, ...)
await admin.providerKeys.create(tenant.id, {
  kind: 'openai_compatible',
  label: 'on-prem vLLM',
  base_url: 'http://vllm:8000/v1',
  trust_tier: 't0_sovereign',
});

const { key } = await admin.apiKeys.create(tenant.id, { name: 'ci' }); // plaintext, shown once

const ds = await admin.datasources.create({
  tenant_id: tenant.id,
  kind: 'mongodb',
  name: 'sales',
  connection: { uri: 'mongodb://mongo:27017', database: 'sales' },
});
await admin.datasources.introspect(ds.id); // starts a job, returns { job_id }

const ontology = await admin.ontology.get({ tenant_id: tenant.id });
for (const el of ontology.elements.filter((e) => e.status === 'proposed')) {
  await admin.ontology.review(el.id, { decision: 'approve', note: 'checked by data team' });
}

const usage = await admin.usage.get({ tenant_id: tenant.id, limit: 50 });
console.log(usage.totals.tokens_saved);

// Anything without a helper: the typed openapi-fetch client
const { data } = await admin.raw.GET('/api/v1/health');
```

| Helper | Methods |
|---|---|
| `tenants` | `list` (`{ include_deleted }`), `create`, `get`, `update`, `delete` |
| `apiKeys` | `list` (`{ include_revoked }`), `create`, `revoke` |
| `providerKeys` | `list`, `create`, `delete` (the server crypto-shreds the secret) |
| `models` | `list`, `create`, `delete` |
| `providers` | `list`, `create`, `delete`, `health`, `discover` |
| `datasources` | `list`, `create`, `delete`, `introspect` |
| `ontology` | `get`, `review` |
| `nodes` | `list`, `create`, `delete` |
| `usage` | `get` |
| `health()` | `GET /api/v1/health` |
| `raw` | the underlying `openapi-fetch` client |

Options: `token`, `baseUrl`, `timeoutMs` (default `60_000`, including the body read), `retry`, `headers`, `fetch`. Each helper also takes `{ signal, headers }` as its last argument. Non-2xx responses throw `CalibanAPIError`. Retries follow the same rules as the data-plane client: GET and DELETE retry on 429, 502 and 503, while POST and PATCH retry only on 429 and 503 unless you pass an `Idempotency-Key` in `headers`.

#### Tenant settings

`tenants.update(tenantId, patch)` sends `PATCH /api/v1/tenants/{tenantId}` and resolves to the updated tenant. Fields you leave out keep their value; any other field is a compile error (`TenantUpdate` is closed). The change is audited as `tenant.update`, and split-mode routers apply it with their next snapshot. An unknown or deleted tenant throws a `CalibanAPIError` with `status: 404`. The same fields can be set on `tenants.create()`.

| Field | Values | Default | Meaning |
|---|---|---|---|
| `pii_default` | `off`, `mask`, `reversible` | `reversible` | PII mode for requests that do not set `caliban.pii`. |
| `pii_surrogate_scope` | `tenant`, `session` | `tenant` | How reversible PII surrogates are chosen. |
| `semantic_cache` | `off`, `on` | `off` | Whether the tenant's eligible requests may use the semantic cache. |

```ts
await admin.tenants.update(tenant.id, { semantic_cache: 'on' });
const t = await admin.tenants.update(tenant.id, { pii_surrogate_scope: 'session' });
console.log(t.pii_surrogate_scope, t.semantic_cache); // 'session' 'on'
```

- **`pii_surrogate_scope: 'tenant'`** (the default): a given value always gets the same surrogate within the tenant (a keyed HMAC per tenant, derived from `CALIBAN_KEK`). That lets pseudonymised requests hit the exact cache. The trade-off is linkability: anyone who can see the pseudonymised traffic (an upstream provider, for example) can tell that two requests or sessions of the tenant mention the same person, even without learning who it is. Surrogates never cross tenants.
- **`pii_surrogate_scope: 'session'`**: every request gets fresh surrogates, so requests cannot be linked through them. Requests that carry PII then bypass the exact and semantic caches.
- **`semantic_cache: 'on'`**: an eligible request may be answered with the response to an earlier, semantically similar request of the same tenant (same model, system prompt, history and parameters). Entries never cross tenants. The deployment must also enable it (`[cache.semantic] enabled`). Hits report `x-caliban-cache: hit` with `x-caliban-cache-tier: semantic`.

Tenants from an older server omit both fields, so they are `undefined`.

#### Usage fields

`usage.get()` returns `{ events, totals }` (`UsageEvent[]` and `UsageTotals`). Beyond the request basics (`model`, tokens, `cache`, `cost_usd`, `latency_ms`, `ts`), an event can carry these optional fields. They are omitted, never `null`, when they do not apply, and they are all absent on events from an older server.

| Field | When present | Meaning |
|---|---|---|
| `cache_tier` | Cache hits | `'exact'` or `'semantic'`. `cache` stays `hit`, `miss` or `bypass`. |
| `tokens_saved` | Cache hits | Tokens not sent upstream: the cached answer's prompt plus completion tokens. |
| `requested_model` | Chat requests | The model the client asked for: `caliban/auto` or a pinned id. |
| `intent_confidence` | Chat requests | Confidence of the intent decision, 0..1. |
| `route_stage` | Chat requests | `'rules'`, `'knn'` or `'keyword'`. |
| `routed_model_cost_usd` | `caliban/auto`, priced model | Real cost of the routed model for this request. |
| `flat_price_usd` | `caliban/auto` | The flat auto price for the same tokens. `0` on a cache hit. |

`totals` adds `semantic_cache_hits` (`cache_hits` counts both tiers), `auto_requests` (requests for `caliban/auto`), and `flat_price_usd`, `routed_model_cost_usd` and `margin_usd` (`flat_price_usd - routed_model_cost_usd`), summed over the `caliban/auto` events that carry both prices.

```ts
const { totals } = await admin.usage.get({ tenant_id: tenant.id });
console.log(`${totals.semantic_cache_hits ?? 0} of ${totals.cache_hits ?? 0} hits were semantic`);
console.log(`auto margin: $${(totals.margin_usd ?? 0).toFixed(4)} over ${totals.auto_requests ?? 0} requests`);
```

**Deleting and revoking.** `tenants.delete(tenantId)`, `apiKeys.revoke(tenantId, keyId)`, `datasources.delete(tenantId, datasourceId)` and `nodes.delete(tenantId, nodeId)` resolve to `undefined` on success (204). An unknown id, an id that belongs to another tenant, or one that is already deleted throws a `CalibanAPIError` with `status: 404`, so a repeated delete throws too.

```ts
// Revoke a leaked key, then retire the whole tenant.
await admin.apiKeys.revoke(tenant.id, keyId);
await admin.tenants.delete(tenant.id); // revokes keys, wipes BYOK credentials, removes routes,
                                       // soft-deletes datasources and nodes

// Deleted tenants and revoked keys are hidden unless you ask for them.
const tombstones = (await admin.tenants.list({ include_deleted: true })).filter((t) => t.status === 'deleted');
const revoked = (await admin.apiKeys.list(otherTenantId, { include_revoked: true })).filter((k) => k.revoked_at);
```

- Deletes are permanent. The server keeps the rows for audit, but nothing can be restored, and secrets they held (BYOK credentials, datasource connection settings) are destroyed.
- A deleted tenant's id cannot be reused, and every tenant-scoped call for it returns 404.
- A standalone deployment rejects a revoked key on the next request. A split-mode router stops accepting it after its next snapshot poll (`CALIBAN_SNAPSHOT_POLL_SECS`, 10 s by default).
- Tenants carry `status` (`'active' | 'deleted'`) and `deleted_at`; API keys carry `revoked_at`. These fields are optional, so they are `undefined` when an older server omits them.

### Open models on-prem

Caliban can route to open models you serve yourself (vLLM, SGLang, llama.cpp, Ollama, TEI) through any OpenAI-compatible endpoint. Traffic to a `t0_sovereign` server never leaves your network.

```ts
const admin = new CalibanAdmin();

// 1. A shared model server, usable by all tenants (or an allow-list in `tenants`).
await admin.providers.create({
  id: 'gpu-pool',
  kind: 'openai_compatible',
  base_url: 'http://vllm.internal:8000/v1',
  trust_tier: 't0_sovereign',
  cache_salt: true, // per-tenant vLLM prefix-cache isolation
});
console.log(await admin.providers.health('gpu-pool')); // { status, latency_ms, models }

// 2. Ask the server what it serves. Caliban suggests catalogue entries (kind, family,
//    reasoning capabilities) for unregistered models. Suggestions are heuristic: review them.
const { available, suggested } = await admin.providers.discover('gpu-pool');

// 3. Register the ones you want, adjusting fields as needed.
for (const s of suggested.filter((s) => s.upstream_model.startsWith('Qwen/') || s.kind === 'embedding')) {
  await admin.models.create({ ...s, context_window: s.context_window ?? 32_768 });
}

// Model ids contain '/'. The SDK keeps the slash unescaped, as the API expects.
await admin.models.delete('local/old-model'); // 409 if a route still uses it
```

Background on model choice, serving engines and hardware tiers is in [research note 09](https://github.com/thecalibanproject/docs/blob/main/research/09-open-models-on-prem.md).

### `defineNode` (node authoring)

`defineNode()` type-checks a node spec against `core/schemas/node.schema.json` and returns it unchanged, keeping literal types. Unknown top-level keys, wrong enum values and missing required fields are compile errors. Constraints TypeScript cannot express (`minimum`, `maximum`, `pattern`) are checked by the control plane.

```ts
import { CalibanAdmin, defineNode } from '@caliban/sdk';

export const invoiceTriage = defineNode({
  kind: 'agent',
  description: 'Classify inbound invoices and flag anomalies.',
  prompt: { system: 'You triage supplier invoices.', output_schema: { type: 'object' } },
  model_policy: {
    candidates: ['tier:small', 'tier:frontier'],
    escalate_on: ['schema_violation', 'low_confidence'],
    min_trust_tier: 't1_attested',
    max_cost_usd: 0.02,
  },
  tools: [{ ref: 'mcp://erp/lookup_invoice#sha256:<hash>', effect: 'read' }],
  datasources: { scopes: ['erp.invoices:read'] },
  guardrails: { pii: 'reversible', injection_mode: 'plan_then_execute' },
  budgets: { steps: 12, tokens: 40_000, wall_clock_s: 90 },
  exposure: { http: true, mcp_tool: true },
});

await new CalibanAdmin().nodes.create({ tenant_id: 't_1', name: 'invoice-triage', spec: invoiceTriage });
```

Once created, a node is called from the data plane with `caliban: { node: 'invoice-triage' }`. The node design is described in [research note 04](https://github.com/thecalibanproject/docs/blob/main/research/04-agent-orchestration.md).

## Streaming

With `stream: true`, `create()` resolves to a `ChatCompletionStream` as soon as the headers arrive, so `meta` is available before the first chunk.

```ts
const stream = await caliban.chat.completions.create({
  model: 'caliban/auto',
  messages: [{ role: 'user', content: 'Write a haiku about sovereignty.' }],
  stream: true,
  caliban: { cache: 'off' },
});

console.log('routed to', stream.meta.routedModel);

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}
```

A stream can be consumed once. Instead of iterating it yourself you can call:

- `stream.text()`: the concatenated answer (`delta.content` of choice 0);
- `stream.textParts()`: an async generator of `{ type: 'reasoning' | 'content', text }`;
- `stream.collect()`: `{ reasoning, content }` as two strings.

`stream.abort()` cancels the underlying request.

```ts
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
```

Reasoning deltas are read from `delta.reasoning_content`, falling back to `delta.reasoning`.

The SSE parser follows the WHATWG rules: `data: [DONE]`, multi-line `data:` fields, comments and keep-alives, `\n`, `\r\n` and bare `\r` line endings, and chunk boundaries anywhere (including inside a UTF-8 character or between the `\r` and `\n` of a CRLF pair). `SSEDecoder`, `iterSSEEvents` and `iterJSONChunks` are exported if you need them directly.

## Errors, retries and timeouts

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
    // Mirrors the contract's error body: { error: { message, type, code } }
    console.error(err.status, err.type, err.code, err.message, err.requestId);
  } else if (err instanceof CalibanAbortError) {
    // cancelled
  } else if (isCalibanError(err)) {
    // any other SDK error
  }
}
```

| Class | When |
|---|---|
| `CalibanAPIError` | Non-2xx response. Has `status`, `type` (for example `policy_violation`, `rate_limited`, `upstream_error`), `code`, `requestId`, `headers` and `body`. |
| `CalibanConnectionError` | No response (DNS failure, connection reset, and so on). |
| `CalibanTimeoutError` | Subclass of `CalibanConnectionError`: the attempt exceeded `timeoutMs`. |
| `CalibanAbortError` | Your `AbortSignal` fired, or you called `stream.abort()`. |
| `CalibanStreamError` | A started stream failed: an `event: error` or `{"error": …}` payload, an unparseable chunk, or a dropped connection. |

All of them extend `CalibanError`, which is also thrown directly for client-side problems such as a missing API key (`type: 'configuration_error'`) or invalid parameters (`type: 'invalid_request_error'`). `isCalibanError()` works even when two copies of the SDK are loaded (for example ESM and CJS in one process).

**Retries.** By default the client retries up to twice. The delay grows exponentially from 500 ms to at most 8 s, with jitter, and the client honours `retry-after-ms` and `retry-after` when they ask for 60 s or less. Configure retries per client or per request with `RetryOptions` (`maxRetries`, `initialDelayMs`, `maxDelayMs`, `backoffMultiplier`, `jitter`, `retryOnStatus`, `retryOnNetworkError`, `respectRetryAfter`), or pass `retry: false`.

What is retried depends on whether the request is safe to repeat:

| Request | Statuses retried | Network failures (with `retryOnNetworkError: true`) |
|---|---|---|
| GET, HEAD, OPTIONS, PUT, DELETE | 429, 502, 503 | Any |
| POST (chat completions, embeddings, rerank, admin creates) and PATCH (`tenants.update`) | 429, 503 | Only when the connection was never established (refused, DNS failure, connect timeout) |
| POST with an `Idempotency-Key` header | 429, 502, 503 | Any |

- A POST is never retried on 500, 502 or 504, because the gateway may already have run the request and billed it upstream. The same goes for a reset or timeout after the request was sent. In browsers fetch does not say whether the request was sent, so a failed POST is not retried there.
- Network failures are not retried by default for any request; `retryOnNetworkError: true` turns that on within the limits above.
- To make a POST retryable like a GET, pass `idempotencyKey` (or an `Idempotency-Key` header). The SDK never sends one on its own; use a fresh key per logical request and the same key for its retries. The gateway deduplicates on it for `chat.completions`, `messages`, `embeddings` and `rerank`: the first request runs (to completion, even if the connection drops); a retry after it finished gets the stored response for 24 h (header `idempotent-replayed: true`, nothing charged again; streams are replayed as one SSE body); a retry while it is still running gets `409` with code `idempotency_key_in_use` and `retry-after: 1`, which the SDK does not retry, so catch it and retry later; the same key with a different body gets `422` (`idempotency_key_reused`). A failed request frees its key. The admin API does not deduplicate: there a retried POST after a 502 can run twice.
- Setting `retryOnStatus` explicitly applies your list to every request as-is, POSTs included. For example, `retry: { retryOnStatus: [429, 502, 503] }` restores the old behaviour of retrying POSTs on 502.
- Once a stream has started, nothing is retried.

**Timeouts.** The timeout (default 10 minutes for `CalibanClient`, 60 s for `CalibanAdmin`) applies to each attempt. For streams it only covers the time until headers arrive.

## Using the stock OpenAI and Anthropic SDKs

You do not need this package to use Caliban. `@caliban/sdk` does not depend on `openai` or `@anthropic-ai/sdk`; this section is documentation only.

**OpenAI SDK.** Point `baseURL` at the gateway and use a tenant key. The extension is sent as an extra body field:

```ts
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.CALIBAN_API_KEY, // cal_...
  baseURL: 'http://localhost:8080/v1',
});

const { data, response } = await openai.chat.completions
  .create({
    model: 'caliban/auto',
    messages: [{ role: 'user', content: 'Summarise last quarter’s churn.' }],
    // @ts-expect-error Caliban extension, unknown to the OpenAI types
    caliban: { pii: 'reversible', cache: 'semantic', datasources: ['sales'] },
  })
  .withResponse();

console.log(data.choices[0]?.message.content);
console.log(response.headers.get('x-caliban-routed-model'), response.headers.get('x-caliban-cache'));
```

You can import `CalibanExtension` from `@caliban/sdk` to type that object (`caliban: { … } satisfies CalibanExtension`).

**Anthropic SDK.** The gateway also serves the Anthropic Messages API (`POST /v1/messages`, plus an approximate `POST /v1/messages/count_tokens`) through the same pipeline. Point `baseURL` at the gateway root, without `/v1`. The SDK sends the tenant key as `x-api-key`, which Caliban accepts.

```ts
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.CALIBAN_API_KEY, // cal_...
  baseURL: 'http://localhost:8080',
});

const { data, response } = await anthropic.messages
  .create({
    model: 'caliban/auto',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Summarise last quarter’s churn.' }],
    // @ts-expect-error Caliban extension, unknown to the Anthropic types
    caliban: { pii: 'reversible' },
  })
  .withResponse();

console.log(data.content, response.headers.get('x-caliban-routed-model'));
```

When the routed model is an Anthropic model the request is passed through natively (`cache_control` breakpoints are kept and `anthropic-beta` is forwarded); otherwise the request and response, including stream events, are translated. `thinking` maps to `caliban.reasoning`. Errors use the Anthropic error shape.

The `x-caliban-*` headers are CORS-exposed, so browser clients can read them too.

## Configuration

| Env var | Used by | Default |
|---|---|---|
| `CALIBAN_API_KEY` | `CalibanClient` | none (required) |
| `CALIBAN_BASE_URL` | `CalibanClient` | `http://localhost:8080/v1` |
| `CALIBAN_ADMIN_TOKEN` | `CalibanAdmin` | none (required) |
| `CALIBAN_ADMIN_URL` | `CalibanAdmin` | `http://localhost:8081` |

Environment variables are only read where `process.env` exists. In browsers and edge runtimes, pass the values explicitly.

## Development and tests

```sh
pnpm install
pnpm typecheck
pnpm test          # vitest, one-shot; fetch is mocked, no network needed
pnpm test:watch
pnpm build         # tsup -> dist/ (ESM, CJS, .d.ts and .d.cts)
```

The dev tooling needs Node 22.12+ or 24+ (a vitest 5 requirement); the library itself supports Node 20+. pnpm's built-in `test` command rejects unknown flags such as `pnpm test --run`; use `pnpm test -- <vitest args>` instead.

The API and node types are generated from the [core](https://github.com/thecalibanproject/core) repo and committed under `src/generated/`, so a normal build does not need `core`. To regenerate after a contract change, check out `core` next to this repo (as `../core`) and run:

```sh
pnpm gen:api       # core/api/openapi.yaml         -> src/generated/schema.ts
pnpm gen:schemas   # core/schemas/node.schema.json -> src/generated/node.ts
pnpm gen           # both
```

## Licence

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 Elie Sfeir.

This SDK is open source. The Caliban gateway and the other Caliban repositories are proprietary and source-available under their own terms.
