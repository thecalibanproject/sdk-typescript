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
    output_schema?: {
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  model_policy: {
    intent_classes?: string[];
    /**
     * Model ids or tiers (tier:small, tier:frontier)
     */
    candidates?: string[];
    escalate_on?: ('schema_violation' | 'low_confidence' | 'tool_error')[];
    max_cost_usd?: number;
    min_trust_tier?: 't0_sovereign' | 't1_attested' | 't2_contracted' | 't3_public';
    [k: string]: unknown;
  };
  tools?: {
    /**
     * mcp://server/tool#sha256:<hash> or node://name@vN
     */
    ref: string;
    effect: 'read' | 'write';
    requires?: string[];
    [k: string]: unknown;
  }[];
  datasources?: {
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
    pii?: 'off' | 'mask' | 'reversible';
    injection_mode?: 'none' | 'plan_then_execute' | 'camel';
    egress?: string[];
    [k: string]: unknown;
  };
  budgets: {
    steps: number;
    depth?: number;
    fanout?: number;
    tokens: number;
    wall_clock_s: number;
    [k: string]: unknown;
  };
  exposure?: {
    http?: boolean;
    mcp_tool?: boolean;
    a2a_agent?: boolean;
    [k: string]: unknown;
  };
  /**
   * Only for kind=workflow. Vertices + edges; loops must declare max_iterations.
   */
  graph?: {
    vertices?: {
      id: string;
      type: 'llm' | 'tool' | 'router' | 'map' | 'reduce' | 'verify' | 'human' | 'subnode' | 'code';
      config?: {
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
  eval?: {
    suite?: string;
    metrics?: string[];
    [k: string]: unknown;
  };
}
