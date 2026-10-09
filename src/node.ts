import type { NodeSpec } from './generated/node.js';

export type { NodeSpec } from './generated/node.js';
export type NodeKind = NodeSpec['kind'];
export type NodeTool = NonNullable<NodeSpec['tools']>[number];
export type NodeBudgets = NodeSpec['budgets'];
export type NodeModelPolicy = NodeSpec['model_policy'];
export type NodeGuardrails = NonNullable<NodeSpec['guardrails']>;
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
export function defineNode<const T extends NodeSpec>(spec: T & NoExtraKeys<T, NodeSpec>): T {
  return spec;
}

/**
 * Generic inference disables TypeScript's excess-property check, so re-impose the schema's
 * top-level `additionalProperties: false` explicitly: unknown keys must have type `never`.
 */
type NoExtraKeys<T, Shape> = { [K in Exclude<keyof T, keyof Shape>]: never };
