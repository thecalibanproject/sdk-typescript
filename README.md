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
| `pii_floor` | `off`, `mask`, `reversible` | A minimum protection applied to every model class, sovereign and attested models included. It only strengthens: the request gets the stricter of this and `pii` (or the tenant's mode), ordered `off` < `reversible` < `mask`. A node's `guardrails.pii` sets it on the node's calls. |
| `cache` | `off`, `exact`, `semantic` | Response cache mode. `off`: no cache. `exact`: exact cache only. `semantic`: exact, then the semantic cache if the tenant has it on, whatever the temperature. Left out: exact, plus semantic up to the gateway's temperature limit if the tenant has it on (see [Tenant settings](#tenant-settings)). |
| `datasources` | `string[]` | Datasources (by name) the request may query through the ontology layer. |
| `node` | `string` | Run the request through a named node (agent). |
| `max_cost_usd` | number, `>= 0` | Cost ceiling for the request. |
| `reasoning` | `off`, `low`, `medium`, `high` | Reasoning effort, translated for the model family (see [Reasoning models](#reasoning-models)). |
| `zdr` | `boolean` | Zero data retention. |
| `trace_id` | `string` | Your own correlation id. |
| `untrusted` | `boolean`, or JSON pointers | With `model: 'node/<name>'` (or `caliban/auto` handing the request to a node): the node input you mark as untrusted data, like `untrusted` on [`runs.create()`](#calibanclient-data-plane). |

Fields you leave out take the gateway's defaults (in the API contract: `pii: 'reversible'`, `cache: 'exact'`, `zdr: false`).

Set defaults for every chat request with `defaultCaliban`. Request-level keys win:

```ts
const caliban = new CalibanClient({ defaultCaliban: { pii: 'reversible', zdr: true } });
```

The SDK checks the extension before sending: `max_cost_usd` must be a finite number `>= 0`, `reasoning` must be one of the four values, `datasources` must be an array, and `untrusted` must be a boolean or at most 64 JSON pointers. A failure throws `CalibanError` with `type: 'invalid_request_error'`.

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
| `x-caliban-cost-usd` | `costUsd` | Non-streaming responses only; `null` when the model has no price. For a node answer, the routed models' real cost (the run's `model_cost_usd`). |
| `x-caliban-billed-usd` | `billedUsd` | Non-streaming only: what the request is billed, the flat `caliban/auto` price (discounted on a cache hit) or the model's cost; for a node answer, the run's `cost_usd`. `undefined` when absent. |
| `x-caliban-route` | `route` | `node/<name>@v<N>` when a node answered, `model:<id>` when `caliban/auto` answered with a model for a tenant that maps intents to nodes. |
| `x-caliban-route-fallback` | `routeFallback` | Why `caliban/auto` answered with a model rather than a node (`low_confidence`, `no_node_for_intent`, ...). |
| `Caliban-Run-Id` | `runId` | The node run that answered. |
| `x-caliban-run-status` | `runStatus` | Its status, for example `succeeded` or `input_required`. |
| `Server-Timing` | `serverTiming` | The gateway's per-stage durations in ms, in pipeline order: `[{ name, dur?, desc? }]` for `auth`, `route` (`desc`: the deciding stage), `embed`, `pii`, `cache` (`desc`: `hit` or `miss`), `upstream`, `upstream_total`, `node` (`desc`: the run id) and `total`. `undefined` when the gateway has it off (`[telemetry] server_timing = false`). |

`meta.status` holds the HTTP status and `meta.headers` the full `Headers` object. The header names are exported as constants (`HEADER_REQUEST_ID`, `HEADER_ROUTED_MODEL`, `HEADER_CACHE`, `HEADER_CACHE_TIER`, `HEADER_INTENT`, `HEADER_PII_ENTITIES`, `HEADER_COST_USD`, `HEADER_BILLED_USD`, `HEADER_ROUTE`, `HEADER_ROUTE_FALLBACK`, `HEADER_RUN_ID`, `HEADER_RUN_STATUS`, `HEADER_SERVER_TIMING`), and `parseResponseMeta(response)` works on any `Response`, including one from `POST /v1/messages` (the Anthropic Messages API), where the gateway sends the same headers: billed cost, route, run id and run status included. The last six are only set when the gateway sends them. `parseServerTiming(value)` parses a raw `Server-Timing` string; the usage event of each request keeps the same numbers as `timings` (`UsageTimings`).

A node answer (`model: 'node/<name>'`, or `caliban/auto` handing the request to a node) carries the headers of every chat response: `requestId`, `routedModel` (`node/<name>@v<N>`), `cache: 'bypass'`, and on non-streaming answers `piiEntities` (the entities protected across the run's model calls), `costUsd` and `billedUsd`.

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
| `runs.create(nodeName, params, options?)` | `POST /v1/nodes/{nodeName}/runs` | `WithMeta<NodeRun>`, or a `RunEventStream` when `stream: true` |
| `runs.get(runId, options?)` | `GET /v1/runs/{runId}` | `WithMeta<NodeRun>` |
| `runs.list(query?, options?)` | `GET /v1/runs` | `WithMeta<NodeRunList>` |
| `runs.events(runId, { after?, ...options })` | `GET /v1/runs/{runId}/events` | `RunEventStream` |
| `runs.input(runId, { answer, step? }, options?)` | `POST /v1/runs/{runId}/input` | `WithMeta<NodeRun>` |
| `runs.cancel(runId, options?)` | `POST /v1/runs/{runId}/cancel` | `WithMeta<NodeRun>` |

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

**Node runs.** Run a published node with a tenant key the node is allowed for (its node allowlist, or every published node of the tenant without one). The input is checked against the node's `prompt.input_schema`.

```ts
// Sync (default): resolves when the run ends or waits for a human, or after the server's
// wait (at most CALIBAN_NODE_SYNC_WAIT_SECS, or wait_s) with the run so far.
let run = await caliban.runs.create('invoice-triage', { input: { invoice_id: 'INV-42' } }, { idempotencyKey: 'inv-42' });

if (run.status === 'input_required') {
  console.log(run.awaiting?.question);
  run = await caliban.runs.input(run.id, { answer: 'approved by finance' }); // resumes the run
}
while (['pending', 'running', 'sleeping'].includes(run.status)) {
  await new Promise((r) => setTimeout(r, 1000));
  run = await caliban.runs.get(run.id);
}
console.log(run.status, run.output, run.cost_usd, run.model_cost_usd, run.usage?.pii_entities);

// Stream the run's events (SSE) instead.
const stream = await caliban.runs.create('invoice-triage', { input: { invoice_id: 'INV-43' }, stream: true });
for await (const ev of stream) console.log(ev.id, ev.type, ev.data); // step.started, step.finished, ...
console.log(stream.run?.status); // the run, from the last event
```

- **Untrusted caller data.** Input you pass is trusted by default: the API key that may run the node is the principal. When part of it comes from someone else (an email body, a web page, a ticket), mark it with `untrusted`: `true` for the whole input, or JSON pointers to fields (`['/email/body']`; `''` is the whole input; at most 64, checked before sending). Marked values make the run input carry the `caller` taint label, shown in the run's `input_labels`, so a write tool (or a read that reaches the network) their data reaches needs an `allow_tainted` entry such as `'caller'` or a human approval. Fields the node's input schema marks `x-caliban-untrusted` are untrusted whoever calls.

  ```ts
  const run = await caliban.runs.create('inbox-agent', {
    input: { from: 'customer@example.com', email: { subject: 'Refund', body: emailText } },
    untrusted: ['/email/body'],
  });
  console.log(run.input_labels); // ['caller']
  ```
- **Cost, PII and the answer guard.** `cost_usd` is what the run is billed (for a run `caliban/auto` started, the flat auto price) and `model_cost_usd` the real cost of the models its calls were routed to; they differ only for runs billed as `caliban/auto`, and each step carries the same pair (`usd`, `model_cost_usd`). `usage.pii_entities` counts the personal-data entities the gateway protected in the run's model calls. `answer_check` (`AnswerCheck`, also exported as `RunAnswerCheck`) is present when the final output carried untrusted labels: the output's `labels`, the `findings` by rule (`untrusted_link`, `untrusted_contact`, `untrusted_reference`, `instruction_echo`), label and JSON pointer, never their text, and the `action` (`passed`, `redacted` or `refused`). See the node's `guardrails.answer` under [`defineNode`](#definenode-node-authoring).
- `async: true` answers at once with the pending run; poll `runs.get()` or follow `runs.events()`. `version` runs a published version other than the live one (`runs.list({ node, version })` filters by it); `budget` can only lower the version's budget for this run; `chat: { messages }` replaces `input` with chat messages.
- A `RunEventStream` yields `RunEvent`s (`run.created`, `step.started`, `step.finished`, `run.input_required`, `run.sleeping`, `run.input_received`, `run.cancel_requested`, `run.finished`). The server ends it after `run.finished`, or after `run.input_required` while the run waits; that last event carries the run (`stream.run`, or `await stream.finalRun()`). Events never carry step content. `stream.runId` is the `Caliban-Run-Id` header. The timeout covers the time until headers arrive; the stream is not retried or resumed by itself: resume with `runs.events(runId, { after: stream.lastEventId })`.
- `runs.input()` answers the step the run waits for (`awaiting.step`, or `step`). A step named `<step>@approve` asks to approve a write whose arguments carry untrusted taint labels: answer `{ approve: true }` or `{ approve: false }`. Not waiting for that step is a `409` (`run_not_awaiting_input`).
- `runs.cancel()` cancels a waiting run at once and asks a running one to stop at its next step (`cancel_requested: true`); a run that already ended otherwise is a `409` (`run_already_ended`).
- With `idempotencyKey`, a retried start returns the run the first request created (`idempotent-replayed: true`, `stream.replayed`) and starts nothing; the same key with another body is a `422` (`idempotency_key_reused`). Without one, a run start is a POST like any other: retried on 429 and 503 only.

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
await admin.datasources.introspect(ds.id); // starts a job: { job_id, job }
const job = await admin.datasources.introspection(ds.id); // the newest job: status, proposed, skipped, version

const ontology = await admin.ontology.get({ tenant_id: tenant.id });
const proposed = ontology.elements.filter((e) => e.status === 'proposed');
await admin.ontology.reviewBatch(tenant.id, {
  decisions: proposed.map((e) => ({ id: e.id, decision: 'approve' as const })),
  note: 'checked by data team',
});

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
| `datasources` | `list`, `create`, `delete`, `introspect`, `introspection` |
| `ontology` | `get`, `review`, `reviewBatch`, `propose` |
| `intents` | `list`, `put`, `delete` (the tenant's `caliban/auto` exemplars) |
| `nodes` | `list`, `create`, `delete` |
| `goldenSets` | `get`, `put`, `delete` (per node version) |
| `evalPolicy` | `get`, `put` (per node: the promotion bar) |
| `evals` | `start`, `list`, `get`, `trials`, `cancel`, `gate` |
| `evalKey` | `get`, `rotate` (the tenant's eval key) |
| `runs` | `list`, `get`, `input`, `cancel` (a tenant's node runs, as the console sees them) |
| `inbox` | `list` (runs waiting for a human) |
| `rag` | `models`, `collections.{list, create, get, delete}`, `documents.{list, ingest, get, delete, release}` |
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
| `pii_on_sovereign` | `boolean` | `false` | Also apply the tenant's PII mode to models inside the trust boundary (`t0_sovereign`, `t1_attested`). Off, those models receive the text as is. External models always get the mode, and `caliban.pii_floor` (a node's `guardrails.pii`) applies to every model class. |
| `pii_patterns` | `PiiPattern[]` (at most 50) | `[]` | The tenant's own L0 detection patterns: `{ label, pattern }`. Labels are case-insensitive (stored as sent, used upper-cased: `phone` is `PHONE`). `NATIONAL_ID`, `PHONE`, `EMAIL`, `PERSON`, `ORG`, `LOCATION`, `IBAN` and `CARD` (and the aliases `ID`, `NATIONALID`, `NAME`, `ORGANIZATION`, `ADDRESS`) use the built-in surrogates; other labels get shape-preserving ones and are masked as `[LABEL]`, upper-cased. `pattern` uses the Rust `regex` syntax (linear time: no backreferences or lookaround) and must not match the empty string. Replaced as a whole; `[]` clears them. |
| `pii_dictionary` | `PiiTerm[]` (at most 10 000) | `[]` | Whole-word, case-insensitive terms to protect: `{ term, label }` (customer names, internal codes); the label is case-insensitive too. Replaced as a whole; `[]` clears it. Audited as a count of terms, never the terms. |
| `semantic_cache` | `off`, `on` | `off` | Whether the tenant's eligible requests may use the semantic cache. |
| `auto_cache_hit_fraction` | `0` to `1`, or `null` | `null` | Share of the flat `caliban/auto` price billed for the tenant's cache hits. `null` uses the deployment's `[routing] auto_cache_hit_fraction` (0.2 unless configured); sending `null` clears an override. |
| `node_caps` | `{ steps, tokens, wall_clock_s, depth, fanout, usd? }`, or `null` | `null` | Caps on the budgets of published node versions. `null` restores the defaults (steps 200, tokens 2 000 000, wall_clock_s 3600, depth 5, fanout 32). With `usd` set, every version must declare `budgets.usd` within it. |
| `node_spend_caps` | `{ daily_usd?, monthly_usd? }`, or `null` | `null` | What the tenant's node runs may spend on model calls per UTC day and month. A cap reached ends runs as `budget_exhausted`. `null` removes them. |
| `node_routes` | `{ [intent]: 'node/<name>' }`, or `null` | `null` | Intents `caliban/auto` hands to the tenant's nodes (`node/<name>`, `node/<name>@published` or `node/<name>@v<N>`). `null` clears them. |

```ts
await admin.tenants.update(tenant.id, { semantic_cache: 'on' });
const t = await admin.tenants.update(tenant.id, { pii_surrogate_scope: 'session' });
console.log(t.pii_surrogate_scope, t.semantic_cache); // 'session' 'on'
```

- **`pii_surrogate_scope: 'tenant'`** (the default): a given value always gets the same surrogate within the tenant (a keyed HMAC per tenant, derived from `CALIBAN_KEK`). That lets pseudonymised requests hit the exact cache. The trade-off is linkability: anyone who can see the pseudonymised traffic (an upstream provider, for example) can tell that two requests or sessions of the tenant mention the same person, even without learning who it is. Surrogates never cross tenants.
- **`pii_surrogate_scope: 'session'`**: every request gets fresh surrogates, so requests cannot be linked through them. Requests that carry PII then bypass the exact and semantic caches.
- **`pii_patterns` and `pii_dictionary`** are the deterministic first tier of PII detection, compiled per tenant (see [research note 05](https://github.com/thecalibanproject/docs/blob/main/research/05-anonymization-and-privacy.md)): `await admin.tenants.update(t, { pii_patterns: [{ label: 'MRN', pattern: 'MRN-[0-9]{6}' }], pii_dictionary: [{ term: 'Project Lumen', label: 'ORG' }] })`.
- **`auto_cache_hit_fraction`**: a cache hit (exact or semantic) calls no model, so a `caliban/auto` request answered from cache is billed this share of the flat price. Out of range is a `422`.
- **`semantic_cache: 'on'`**: an eligible request may be answered with the response to an earlier, semantically similar request of the same tenant (same model, system prompt, history and parameters). Entries never cross tenants. The deployment must also enable it (`[cache.semantic] enabled`). Hits report `x-caliban-cache: hit` with `x-caliban-cache-tier: semantic`.

**Who sees the detectors.** `tenants.get()` and `tenants.list()` return `pii_patterns` and `pii_dictionary` only to callers with `tenant.write` on the tenant, since the dictionary may hold staff or customer names. Every caller gets `pii_patterns_count` and `pii_dictionary_count`. Both lists are therefore optional in `Tenant`: check the counts, not the lists, to see whether a tenant has detectors.

Tenants from an older server omit the fields it does not know, so they are `undefined`.

#### Usage fields

`usage.get()` returns `{ events, totals }` (`UsageEvent[]` and `UsageTotals`). Beyond the request basics (`model`, tokens, `cache`, `cost_usd`, `latency_ms`, `ts`), an event can carry these optional fields. They are omitted, never `null`, when they do not apply, and they are all absent on events from an older server.

| Field | When present | Meaning |
|---|---|---|
| `cache_tier` | Cache hits | `'exact'` or `'semantic'`. `cache` stays `hit`, `miss` or `bypass`. |
| `tokens_saved` | Cache hits | Tokens not sent upstream: the cached answer's prompt plus completion tokens. |
| `requested_model` | Chat requests | The model the client asked for: `caliban/auto` or a pinned id. |
| `routed_model_cost_usd` | `caliban/auto`, priced model | Real cost of the routed model for this request. |
| `flat_price_usd` | `caliban/auto` | The full flat auto price for the same tokens. On a cache hit, the flat price of the cached answer's tokens (what a miss would have billed). |
| `billed_usd` | `caliban/auto` | What the customer is billed: `flat_price_usd` on a miss, `flat_price_usd` x the tenant's cache-hit fraction on a hit. |
| `saved_usd` | Priced cache hits | What the hit saved: `flat_price_usd - billed_usd` for `caliban/auto`, the avoided model cost for other models. |
| `timings` | Events written by a current gateway | Per-stage durations in ms (`UsageTimings`): `auth_ms`, `route_ms`, `embed_ms`, `pii_ms`, `cache_ms`, `upstream_ms` (to the first byte), `upstream_total_ms` and `total_ms`, the `Server-Timing` numbers; for streams the last two run to the end of the stream. A stage that did not run is absent. |
| `purpose` | Work Caliban did for the tenant | `rag.ingest` (embedding a collection's documents) or `rag.search` (a node's retrieval query, its embedding and reranking). Absent on client calls and node model calls. Kept in reports. |

**Routing decisions are content-class**: which intent a request went to reveals its topic, so reports never carry them. `intent` is empty and `intent_confidence`, `route_stage`, `route` and `route_fallback` are absent on reported events (they exist only in transit between a data plane and the control plane). `by_route` counts requests per tenant, UTC day, intent, deciding stage and fallback reason instead (empty strings: not set); it is not computed when you filter by `node` or `run_id`. The `x-caliban-intent` response header still tells the caller of a request how it was routed.

`by_purpose` gives the same totals per `purpose` (`UsageByPurpose[]`), so retrieval spend is separable from the tenant's own calls; it is absent from an older server.

`totals` adds `charged_usd` (what the customer is charged: the billed `caliban/auto` price, the model's cost otherwise; over a run's events it equals the run's `cost_usd`), `semantic_cache_hits` (`cache_hits` counts both tiers), `saved_usd` (what cache hits saved, all models), `auto_requests` (requests for `caliban/auto`) and `auto_cache_hits`, and, summed over the `caliban/auto` events that carry both prices, `flat_price_usd`, `billed_usd`, `auto_saved_usd`, `routed_model_cost_usd` and `margin_usd` (`billed_usd - routed_model_cost_usd`).

```ts
const { totals } = await admin.usage.get({ tenant_id: tenant.id });
console.log(`${totals.semantic_cache_hits ?? 0} of ${totals.cache_hits ?? 0} hits were semantic`);
console.log(`auto margin: $${(totals.margin_usd ?? 0).toFixed(4)} over ${totals.auto_requests ?? 0} requests`);
console.log(`${totals.auto_cache_hits ?? 0} auto cache hits saved customers $${(totals.auto_saved_usd ?? 0).toFixed(4)}`);
```

#### Ontology bootstrap and review

`datasources.introspect(datasourceId)` starts the ontology bootstrap and resolves to `{ job_id, job }`: the control plane connects with the datasource's credentials, checks that the principal is read only, samples every collection and writes its proposals (`status: 'proposed'`) in one ontology version. Elements a human already reviewed, and unchanged ones, are skipped. It is MongoDB only for now. `datasources.introspection(datasourceId)` returns the newest job (`running`, `succeeded` or `failed`, with `objects`, `proposed`, `skipped`, the ontology `version`, `error`, `started_at` and `finished_at`); a datasource without a job throws a 404. Jobs are stored, so every control-plane replica answers, and a second `introspect()` while one runs, wherever it runs, is a `409`. A job whose control plane stopped before it ended shows as `failed` once it is older than the job timeout (10 minutes) and a minute, and may be started again. The datasource's `status` (`DatasourceStatus`) follows the job: `pending` when created, `introspecting` while a job runs, then `ready` or `failed`; `connected` and `error` are reserved and not set yet.

```ts
import { isOntologyBreakingError } from '@caliban/sdk';

const decisions = [{ id: 'Service', decision: 'approve' as const }];
await admin.ontology.propose(tenant.id, { elements: curatedElements }); // made outside Caliban: { version, proposed, skipped, breaking }
const res = await admin.ontology.reviewBatch(tenant.id, { decisions, note: 'reviewed' }); // one new version
try {
  await admin.ontology.review('Customer', { tenant_id: tenant.id, decision: 'deprecate' });
} catch (err) {
  if (!isOntologyBreakingError(err)) throw err;
  for (const b of err.breaking) console.log(b.element, b.change, b.nodes); // 'Customer' 'approved -> deprecated' ['triage@v3']
}
```

- Element ids are per tenant (two tenants may both have `Service`), so `ontology.get()` requires `tenant_id` in its query and `ontology.review()` in its body; the server answers `400` without it. Decisions are `approve`, `reject` or `deprecate`.
- **Proposals** (`ontology.propose()`, `OntologyElementProposal`): `status` may be left out, and whatever it says is ignored, because every element is written as `proposed`. An element whose spec, name and description match the tenant's is skipped (`skipped`), whatever status it was sent with, so posting the same exported model again writes no version and keeps every review decision (synonyms, confidence and provenance are not compared). A changed element goes back to `proposed`. The result always carries `breaking` (empty unless you acknowledged some). `400` for an empty batch, more than 5000 elements, or an empty, too long or repeated id; `404` for an unknown tenant.
- **Breaking changes.** Withdrawing an approved element that a published node version's fixed CQIR query touches (a decision, or a proposal that changes it) is refused with a `409` unless you send `acknowledge_breaking: true` (those versions then fail on that query until a version written on the new ontology is published). The SDK throws it as a `CalibanOntologyBreakingError` (a `CalibanAPIError` with `code: 'ontology_breaking_change'`), whose `breaking` lists each element, the `change` (`approved -> proposed`), the node versions as `name@vN` (`nodes`) and the same versions as `{ node, version }` (`versions`). `isOntologyBreakingError()` also works across two copies of the SDK. `reviewBatch()` and `propose()` return the `breaking` changes they acknowledged.
- Stored elements (`OntologyElement`) always have a `status`, and carry `changed_in`, the ontology version their spec or status last changed in.

#### Intents for `caliban/auto`

A tenant's `caliban/auto` intents (the kNN exemplars routers classify with) come from the config file and from the admin API, which overrides the file intent by intent and needs no restart: routers rebuild their index with the next snapshot.

```ts
await admin.intents.put(tenant.id, 'triage', ['my chest hurts', 'I feel dizzy']); // { tenant_id, intent, exemplars, source: 'api' }
await admin.tenants.update(tenant.id, { node_routes: { triage: 'node/triage' } }); // hand the intent to a node
const { intents, removed } = await admin.intents.list(tenant.id); // each with source ('config' | 'api') and node
await admin.intents.delete(tenant.id, 'triage'); // the config file's exemplars apply again
```

At most 100 intents per tenant and 200 exemplars per intent, each 1 to 2000 characters (duplicates are dropped). Intent names are 1 to 64 characters of `[a-z0-9_.-]`, and `pinned` is reserved. An empty list removes a config-file intent for the tenant (listed in `removed`). Changes are audited as `tenant.intent.set` and `tenant.intent.delete`, with counts and never the texts. `put()` is a `PUT`, retried like a GET.

#### Document collections (RAG)

Nodes search a collection with the `builtin://rag_search` tool, naming it in their scopes as `rag.<name>:read`. The control plane needs a document registry for these calls (else `503`).

```ts
const { embedding, rerank } = await admin.rag.models(tenant.id); // the models the tenant can reach
await admin.rag.collections.create(tenant.id, { name: 'policies', embedding_model: embedding[0]!.id, rerank_model: rerank[0]?.id });
await admin.rag.documents.ingest(tenant.id, 'policies', { doc_id: 'leave', content: markdown, trust: 'untrusted' });

for (const c of await admin.rag.collections.list(tenant.id)) console.log(c.name, c.document_counts); // { ready: 12, quarantined: 1 }
const { versions } = await admin.rag.documents.get(tenant.id, 'policies', 'leave');
const v = versions[0]!;
if (v.status === 'quarantined') {
  console.log(v.findings.map((f) => `${f.kind} under ${f.heading_path?.join(' > ')}`));
  await admin.rag.documents.release(tenant.id, 'policies', 'leave', { version: v.version, acknowledge_findings: true });
}
```

- `rag.models()` lists the catalogue models of kind `embedding` and `rerank` that one of the tenant's providers, or a shared provider that serves it, can reach, each with its `trust_tier`.
- `document_counts` (on the collection listing only) counts documents per status, using each document's newest version; deleted documents are not counted.
- A version is `pending` and invisible until a worker has indexed it and its checks passed. An untrusted version whose checks have not passed by `vet_deadline_at` (the collection's `vet_deadline_secs` after ingest, or after its release) fails and stays invisible.
- A finding's `heading_path` gives the headings above the chunk it was found in, so a reviewer can find the place in the source. It is pseudonymised like the indexed text and is never an excerpt of what triggered the finding.
- Released text is still labelled `retrieved` in node runs: a tainted write it inspires needs an allowlist entry or a human approval.

#### Node runs and the inbox

The admin client sees a tenant's node runs as the console does: `runs.list(tenantId, query)` and `runs.get(tenantId, runId)` need `runs.read`, and include content (`input`, `output`, step outputs, the question) only with `runs.data` (`content_visible`). `runs.input()` and `runs.cancel()` need `runs.answer` and are recorded with the caller's identity (`node.run.answer`, `node.write.approve`, `node.write.deny`, `node.run.cancel`). `inbox.list(tenantId)` lists the runs waiting for a human, oldest wait first; an approval carries `approval` (the tool, its effect, the untrusted taint labels its arguments carry, and the `arguments` with `runs.data`). A run from `runs.get()` carries its cost as the data plane's run does: `cost_usd` (billed; the flat auto price for a run `caliban/auto` started) and `model_cost_usd` (the real cost of the models its calls were routed to), and `answer_check` (`AnswerCheck`, shared with `NodeRun`) with `runs.read`: metadata only (labels, rules, JSON pointers, the action), never text. It is absent when the output carried no untrusted labels or the data key cannot be opened.

```ts
const { data } = await admin.inbox.list(tenant.id);
for (const item of data.filter((i) => i.kind === 'approval')) {
  const ok = item.approval?.labels?.every((l) => l === 'datasource') ?? false;
  await admin.runs.input(tenant.id, item.run_id, { answer: { approve: ok }, step: item.step });
}
await admin.runs.cancel(tenant.id, stuckRunId); // 409 if it already ended otherwise
```

#### Node evals

A node version is evaluated before it is promoted: the **golden** suite runs each case of the version's golden set `k` times as ordinary node runs and reports pass^k (`pass_hat_k`, the share of cases whose `k` runs all passed), `pass_at_1`, cost per success and latency; the **injection** suite runs the version against sandboxed tools and reports the share of attacks blocked (`pass_rate`). The node's promotion bar decides what may be promoted, and a version with write tools always needs an injection eval. The endpoints are the core contract's `evals` tag; see core's `docs/evals.md` for the checks, metrics and gate rules.

```ts
const t = tenant.id;

// 1. The golden set of version 2 (at most 200 cases; inputs are checked against prompt.input_schema).
await admin.goldenSets.put(t, 'desk', 2, {
  cases: [
    {
      id: 'chest',
      input: { case: 'Chest pain since Tuesday' },
      answers: { clarify: 'two days, nobody in danger' }, // scripted answers to human steps
      checks: [
        { type: 'json_schema', schema: { type: 'object', required: ['urgency'] } },
        { type: 'llm_judge', rubric: 'Does the recommendation fit the case?', threshold: 0.7 },
      ],
    },
    { id: 'refund', input: { case: 'Refund my invoice' }, expected: 'billing' }, // expected: an exact check
  ],
});

// 2. The promotion bar (needs nodes.publish).
await admin.evalPolicy.put(t, 'desk', { golden: { min_pass_k: 0.9, min_k: 3 }, injection: { min_pass_rate: 1 } });

// 3. Evaluate the published version, then follow it.
const ev = await admin.evals.start(t, 'desk', 2, { suite: 'golden', k: 3 }); // runs as the tenant's eval key
const done = await admin.evals.get(t, ev.id); // status, summary (metrics only, null until it ends) and trials
if (done.summary?.suite === 'golden') {
  console.log(done.summary.pass_hat_k, done.summary.cost_per_success_usd, done.summary.latency_ms.p95);
} else if (done.summary?.suite === 'injection') {
  console.log(done.summary.pass_rate, done.summary.by_category, done.summary.not_applicable);
}

// 4. Would promotion pass?
const gate = await admin.evals.gate(t, 'desk', 2);
if (!gate.allowed) console.log(gate.problems); // Problem[]: kind eval_gate, path names a failing subnode
else console.log(gate.evidence);                 // GateEvidence: golden, injection, subnodes
```

- **The eval key.** Without `api_key_id`, trials and judge calls run as the tenant's eval key: an API key the control plane creates on the first such eval and manages (`purpose: 'eval'`). Its quotas apply and its usage is the eval's. `evalKey.get(tenantId)` shows it (`key` is `null` before that first eval; the plaintext is never returned, and the data plane refuses it on its endpoints); `evalKey.rotate(tenantId)` revokes it and creates a new one (`revoked` is the old id), so rotate between evals: evals in flight lose their key. `apiKeys.revoke()` on the eval key is a `409`. Pass `api_key_id` to run an eval as one of the tenant's own keys instead (active, allowed to run the node).
- `summary` and each trial's `verdict` follow the eval's suite: narrow on `summary.suite` (`GoldenSummary` or `InjectionSummary`); a verdict is a `GoldenVerdict` (run status and each check's result), an `InjectionVerdict` (category, `succeeded`, `attacked`, the defenses that held) or `{ error }` when the trial's run could not be created. Run retention purges trial `detail` (`content_purged: true`); summaries and verdicts stay.
- `evals.list(tenantId, { node, version, suite, status, limit, cursor })` returns one page (`data`, `next_cursor`), newest first, metrics and never content. `evals.trials(tenantId, evalId)` is `evals.get()` and its `trials`; each trial's `detail` (outputs, what the scorers said) is only there when the caller holds `runs.data`, and so are golden set `cases` (`content_visible`).
- **Read-only versions.** A version with read tools that bring data in (MCP, `builtin://datasource_query`, `builtin://rag_search`) and no write tool needs an injection eval too, because what it reads can steer its answer (the suite's `answer_integrity` cases). `evalPolicy.put(t, node, { injection: { min_pass_rate: 1, read_only: 'optional' } })` lets such versions promote without one (`InjectionReadOnly`); a finished injection eval is still checked against the bar. `evals.gate()` reports `has_untrusted_reads` next to `has_write_tools`.
- `evals.cancel()` ends a pending eval at once and asks a running one to stop (`cancel_requested: true`); an eval that already ended throws a `409`.
- `goldenSets.put()` and `evalPolicy.put()` are `PUT`s, retried like a GET. `evals.start()` is a POST: retried on 429 and 503 only, unless you pass an `Idempotency-Key` header.
- The control plane keeps evals next to the node journal; without one these calls answer `503`.

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

`defineNode()` type-checks a node spec against `core/schemas/node.schema.json` and returns it unchanged, keeping literal types. Unknown top-level keys (and unknown keys in `guards`), wrong enum values and missing required fields are compile errors. Constraints TypeScript cannot express (`minimum`, `maximum`, `pattern`, such as the `mcp://`, `node://` or `builtin://` scheme of a tool `ref`) are checked by the control plane.

```ts
import { CalibanAdmin, defineNode } from '@caliban/sdk';

export const invoiceTriage = defineNode({
  kind: 'agent',
  description: 'Classify inbound invoices and flag anomalies.',
  prompt: {
    system: 'You triage supplier invoices.',
    input_schema: { type: 'object', required: ['invoice_id'] }, // checked against every run's input
    output_schema: { type: 'object' },
  },
  model_policy: {
    model: 'caliban/auto', // what the node's calls ask for (default: the first model id in candidates)
    candidates: ['tier:small', 'tier:frontier'],
    escalate_on: ['schema_violation', 'low_confidence'],
    min_trust_tier: 't1_attested',
    max_cost_usd: 0.02,
  },
  tools: [
    { ref: 'mcp://erp/lookup_invoice#sha256:<hash>', effect: 'read' },
    { ref: 'builtin://datasource_query', effect: 'read' },
    // A write (or a read that reaches the network through its arguments) whose arguments may
    // carry these taint labels without a human approval: tool:<server>/*, datasource, caller, *.
    { ref: 'mcp://erp/flag_invoice#sha256:<hash>', effect: 'write', allow_tainted: ['datasource'] },
  ],
  datasources: { scopes: ['erp.invoices:read'] },
  guardrails: { pii: 'reversible', injection_mode: 'plan_then_execute' },
  agent: { max_turns: 6 },                                        // kind: 'agent' only
  budgets: { steps: 12, tokens: 40_000, wall_clock_s: 90, usd: 0.5 }, // usd: the most one run may spend
  guards: { max_repeats: 3, tool_retries: 2 },                    // loop guard, transient tool retries
  exposure: { http: true, mcp_tool: true },
});

await new CalibanAdmin().nodes.create({ tenant_id: 't_1', name: 'invoice-triage', spec: invoiceTriage });
```

**Reasoning and constrained decoding.** `model_policy.reasoning` (`off`, `low`, `medium`, `high`) is the default reasoning effort of the node's model calls, and a model vertex's `config.reasoning` (`llm`, `router`, `verify`, `reduce` with mode `llm`) overrides it; the gateway maps it per model family, as for `caliban.reasoning`. `config.structured_output` is `json_schema` (the default: the vertex's `output_schema`, or a router's labels, go as `response_format` so vLLM, SGLang and OpenAI constrain decoding) or `prompt` (the schema in the prompt only, for servers without guided decoding). The answer is validated either way.

**Guardrails.** `guardrails.answer` is the answer guard on the run's final output when it carries untrusted labels: `redact` (the default) removes links, contacts and references that only untrusted free text supplied, and echoes of injected instructions; `refuse` fails the run instead; `off` skips the check. `guardrails.pii` is a floor on the personal-data protection of the node's model calls on every model class, sovereign models included, and of untrusted tool arguments; it only strengthens the tenant's mode (`off` < `reversible` < `mask`). How tool results enter the run depends on the resulting mode:

- `reversible`: tool results enter the run as they are. The gateway pseudonymises every model call and restores its reply, untrusted tools get surrogates in their arguments, and the answer is restored for the caller, so a phone number from a catalogue row that the answer quotes reaches the caller as the real number. (Pseudonymising results as they entered the run would hand the caller surrogates nothing could restore.) Pseudonymised data is still personal data ([research note 05](https://github.com/thecalibanproject/docs/blob/main/research/05-anonymization-and-privacy.md)).
- `mask`: tool results are masked as they enter, irreversibly: the model, every later step and the caller see `[PHONE]`.
- `off`: as they are.

```ts
const triage = defineNode({
  kind: 'workflow',
  prompt: { system: 'Triage the case.' },
  model_policy: { reasoning: 'low' },
  guardrails: { answer: 'refuse', pii: 'mask' },
  budgets: { steps: 10, tokens: 10_000, wall_clock_s: 60 },
  graph: {
    vertices: [
      { id: 'route', type: 'router', config: { routes: { urgent: 'Needs care now', routine: 'Can wait' }, reasoning: 'off' } },
      { id: 'advise', type: 'llm', config: { output_schema: { type: 'object' }, reasoning: 'high', structured_output: 'json_schema' } },
    ],
    edges: [{ from: 'route', to: 'advise' }],
  },
});
```

Mark the fields of `prompt.input_schema` that hold untrusted data (an email body, a web page) with `'x-caliban-untrusted': true` on the property, its `items` or the whole schema: whoever calls, their values make the run input carry the `caller` taint label, so a write their data reaches needs an `allow_tainted` entry or a human approval. A caller can mark more with `untrusted` on `runs.create()`, never less.

A workflow (`kind: 'workflow'`) declares a `graph` of vertices and edges instead; `graph.entry` names the vertex a run starts at (default: the first). The helper types `NodePrompt`, `NodeTool`, `NodeToolRef`, `NodeModelPolicy`, `NodeGuardrails`, `NodeAgent`, `NodeBudgets`, `NodeGuards`, `NodeGraph`, `NodeVertex`, `NodeVertexConfig`, `NodeEdge`, `NodeReasoning`, `NodeStructuredOutput` and `NodeAnswerGuard` name the parts of a spec.

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
| `CalibanOntologyBreakingError` | Subclass of `CalibanAPIError`: an ontology review or proposal was refused (`409`, `code: 'ontology_breaking_change'`). `breaking` lists the approved elements it would withdraw and the published node versions that query them. |
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
- To make a POST retryable like a GET, pass `idempotencyKey` (or an `Idempotency-Key` header). The SDK never sends one on its own; use a fresh key per logical request and the same key for its retries. The gateway deduplicates on it for `chat.completions`, `messages`, `embeddings` and `rerank`: the first request runs (to completion, even if the connection drops); a retry after it finished gets the stored response for 24 h (header `idempotent-replayed: true`, nothing charged again; streams are replayed as one SSE body); a retry while it is still running gets `409` with code `idempotency_key_in_use` and `retry-after: 1`, which the SDK does not retry, so catch it and retry later; the same key with a different body gets `422` (`idempotency_key_reused`). A failed request frees its key. Run starts (`runs.create`) are deduplicated too, per tenant and for as long as the run is kept: a repeat returns the run the first request created. The admin API does not deduplicate: there a retried POST after a 502 can run twice.
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
pnpm check:generated   # fail if src/generated/ differs from what core produces
```

Set `CALIBAN_CORE_DIR` if `core` is somewhere else. `pnpm test` runs the same drift check (`test/generated.test.ts`) when it finds `core` and skips it otherwise; `pnpm check:generated` and CI (`CALIBAN_REQUIRE_CORE=1`, with `core`'s `schemas/` and `api/` checked out next to this repo) fail instead, so a contract change in `core` fails CI here until the generated files are regenerated and committed.

## Licence

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 Elie Sfeir.

This SDK is open source. The Caliban gateway and the other Caliban repositories are proprietary and source-available under their own terms.
