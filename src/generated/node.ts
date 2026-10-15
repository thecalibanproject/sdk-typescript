/* eslint-disable */
/**
 * AUTO-GENERATED from core/schemas/node.schema.json by scripts/gen-schemas.mjs.
 * Do not edit by hand. Run `pnpm gen:schemas` to regenerate.
 */

/**
 * A node is a versioned, declarative AI sub-app. See docs/research/04-agent-orchestration.md §1.
 */
export interface NodeSpec {
  kind: 'agent' | 'workflow';
  description?: string;
  prompt: {
    system: string;
    /**
     * Validated against the run input (JSON Schema subset, see crates/caliban-nodes/src/schema.rs)
     */
    input_schema?: {
      [k: string]: unknown;
    };
    /**
     * Validated against the run output (JSON Schema subset)
     */
    output_schema?: {
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  model_policy: {
    /**
     * Model id (or caliban/auto) the node's calls ask for; default: the first candidate that is a model id, else caliban/auto
     */
    model?: string;
    intent_classes?: string[];
    /**
     * Model ids or tiers (tier:small, tier:frontier)
     */
    candidates?: string[];
    escalate_on?: ('schema_violation' | 'low_confidence' | 'tool_error')[];
    max_cost_usd?: number;
    min_trust_tier?: 't0_sovereign' | 't1_attested' | 't2_contracted' | 't3_public';
    /**
     * Default reasoning effort of the node's model calls (a vertex's config.reasoning overrides it); mapped per model family by the gateway
     */
    reasoning?: 'off' | 'low' | 'medium' | 'high';
    [k: string]: unknown;
  };
  tools?: {
    /**
     * mcp://server/tool#sha256:<hash> (an approved manifest), node://name@vN, builtin://datasource_query or builtin://rag_search
     */
    ref: string;
    effect: 'read' | 'write';
    requires?: string[];
    /**
     * writes, and reads that reach the network through their arguments: taint labels the arguments may carry without a human approval (tool:<server>/*, datasource, caller, *)
     */
    allow_tainted?: string[];
    [k: string]: unknown;
  }[];
  datasources?: {
    /**
     * <datasource>.<object or *>:<read|write> for datasources; rag.<collection or *>:read for document collections (builtin://rag_search)
     */
    scopes?: string[];
    [k: string]: unknown;
  };
  memory?: {
    short_term?: 'none' | 'run';
    long_term?: {
      scope?: 'end_user' | 'tenant';
      ttl_days?: number;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  guardrails?: {
    /**
     * The answer guard on the run's final output when it carries untrusted labels: links, contacts and references that only untrusted free text supplied, and echoes of injected instructions, are removed (redact) or fail the run (refuse).
     */
    answer?: 'redact' | 'refuse' | 'off';
    /**
     * A floor on the personal-data protection of the node's model calls, on every model class (sovereign models included), and of untrusted tool arguments and results. Only strengthens the tenant's mode.
     */
    pii?: 'off' | 'mask' | 'reversible';
    injection_mode?: 'none' | 'plan_then_execute' | 'camel';
    egress?: string[];
    [k: string]: unknown;
  };
  /**
   * Only for kind=agent: the bounded tool loop.
   */
  agent?: {
    /**
     * Model turns at most (default: budgets.steps)
     */
    max_turns?: number;
    [k: string]: unknown;
  };
  budgets: {
    steps: number;
    depth?: number;
    fanout?: number;
    tokens: number;
    wall_clock_s: number;
    /**
     * Most one run may spend on model calls (USD, priced like the metering)
     */
    usd?: number;
    [k: string]: unknown;
  };
  guards?: {
    /**
     * Loop guard: the same vertex with the same input at most this many times
     */
    max_repeats?: number;
    /**
     * Retries of a tool call that failed transiently
     */
    tool_retries?: number;
  };
  exposure?: {
    http?: boolean;
    mcp_tool?: boolean;
    a2a_agent?: boolean;
    [k: string]: unknown;
  };
  /**
   * Only for kind=workflow. Vertices + edges; loops must declare max_iterations. See docs/nodes.md for each vertex type's config.
   */
  graph?: {
    /**
     * The vertex a run starts at (default: the first)
     */
    entry?: string;
    vertices?: {
      id: string;
      /**
       * code is not yet supported (refused at publish)
       */
      type: 'llm' | 'tool' | 'router' | 'map' | 'reduce' | 'verify' | 'human' | 'subnode' | 'code';
      /**
       * Per vertex type (docs/nodes.md). Model vertices (llm, router, verify, reduce with mode llm) also take reasoning and structured_output.
       */
      config?: {
        /**
         * Reasoning effort of this vertex's model call, mapped per model family by the gateway (Qwen3 enable_thinking, reasoning_effort); overrides model_policy.reasoning
         */
        reasoning?: 'off' | 'low' | 'medium' | 'high';
        /**
         * With an output_schema (llm, reduce) and for router labels: json_schema asks the server for constrained decoding (response_format json_schema; vLLM and SGLang guided decoding, OpenAI structured outputs); prompt puts the schema in the prompt only. The answer is validated either way.
         */
        structured_output?: 'json_schema' | 'prompt';
        [k: string]: unknown;
      };
      max_iterations?: number;
      [k: string]: unknown;
    }[];
    edges?: {
      from: string;
      to: string;
      when?: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  };
  /**
   * Informational. Golden sets are stored per version through the admin API (docs/evals.md); their cases follow $defs/golden_case.
   */
  eval?: {
    suite?: string;
    metrics?: string[];
    [k: string]: unknown;
  };
}
