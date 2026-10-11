import type { NodeSpec } from './generated/node.js';

export type { NodeSpec } from './generated/node.js';
export type NodeKind = NodeSpec['kind'];
export type NodePrompt = NodeSpec['prompt'];
export type NodeTool = NonNullable<NodeSpec['tools']>[number];
/**
 * A tool reference: `mcp://server/tool#sha256:<hash>` (an approved manifest), `node://name@vN`
 * (another node) or a built-in such as `builtin://datasource_query`. `NodeTool['ref']` is a plain
 * `string`; the control plane enforces the scheme.
 */
export type NodeToolRef = `mcp://${string}` | `node://${string}` | `builtin://${string}`;
export type NodeBudgets = NodeSpec['budgets'];
export type NodeModelPolicy = NodeSpec['model_policy'];
export type NodeGuardrails = NonNullable<NodeSpec['guardrails']>;
/** Only for `kind: 'agent'`: the bounded tool loop (`max_turns`, default `budgets.steps`). */
export type NodeAgent = NonNullable<NodeSpec['agent']>;
/** Loop guard and transient tool retries (`max_repeats`, `tool_retries`). Closed: other keys are errors. */
export type NodeGuards = NonNullable<NodeSpec['guards']>;
export type NodeGraph = NonNullable<NodeSpec['graph']>;
export type NodeVertex = NonNullable<NodeGraph['vertices']>[number];
export type NodeEdge = NonNullable<NodeGraph['edges']>[number];
export type TrustTier = NonNullable<NodeModelPolicy['min_trust_tier']>;

/**
 * Author a node spec with full editor completion and type-checking against
 * `core/schemas/node.schema.json`. Identity at runtime; the `const` type parameter keeps
 * literal types (e.g. `kind: 'agent'`) so the spec can be narrowed downstream.
 *
 * Note: JSON Schema constraints that TypeScript cannot express (`minimum`, `maximum`,
 * `pattern`) are enforced by the control plane when the node is created.
 */
export function defineNode<const T extends NodeSpec>(spec: T & CheckNodeSpec<T>): T {
  return spec;
}

/**
 * Generic inference disables TypeScript's excess-property check, so re-impose the schema's
 * `additionalProperties: false` explicitly: unknown keys must have type `never`. That holds at
 * the top level and in `guards`, the only closed nested object.
 */
type NoExtraKeys<T, Shape> = { [K in Exclude<keyof T, keyof Shape>]: never };
type CheckNodeSpec<T> = NoExtraKeys<T, NodeSpec> &
  (T extends { guards: infer G } ? { guards: NoExtraKeys<G, NodeGuards> } : unknown);
