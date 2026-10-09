import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineNode, type NodeSpec } from '../src/index.js';

describe('defineNode', () => {
  it('is an identity function that preserves literal types', () => {
    const spec = defineNode({
      kind: 'workflow',
      prompt: { system: 'Route then verify.' },
      model_policy: { escalate_on: ['schema_violation'] },
      budgets: { steps: 20, tokens: 50_000, wall_clock_s: 120 },
      tools: [{ ref: 'mcp://erp/lookup_invoice#sha256:abc', effect: 'read' }],
      graph: {
        vertices: [
          { id: 'route', type: 'router' },
          { id: 'check', type: 'verify', max_iterations: 3 },
        ],
        edges: [{ from: 'route', to: 'check' }],
      },
    });
    expect(spec.kind).toBe('workflow');
    expectTypeOf(spec.kind).toEqualTypeOf<'workflow'>();
    expectTypeOf(spec).toExtend<NodeSpec>();
  });

  it('rejects specs that violate node.schema.json at compile time', () => {
    // These are type-level assertions; the runtime calls are harmless identities.
    defineNode({
      // @ts-expect-error kind must be 'agent' | 'workflow'
      kind: 'chain',
      prompt: { system: 'x' },
      model_policy: {},
      budgets: { steps: 1, tokens: 1, wall_clock_s: 1 },
    });
    // @ts-expect-error budgets is required
    defineNode({ kind: 'agent', prompt: { system: 'x' }, model_policy: {} });
    defineNode({
      kind: 'agent',
      prompt: { system: 'x' },
      model_policy: {},
      budgets: { steps: 1, tokens: 1, wall_clock_s: 1 },
      // @ts-expect-error top-level additionalProperties: false
      unknown_field: true,
    });
    defineNode({
      kind: 'agent',
      prompt: { system: 'x' },
      model_policy: {},
      budgets: { steps: 1, tokens: 1, wall_clock_s: 1 },
      // @ts-expect-error effect must be read | write
      tools: [{ ref: 'mcp://a/b', effect: 'delete' }],
    });
    expect(true).toBe(true);
  });
});
