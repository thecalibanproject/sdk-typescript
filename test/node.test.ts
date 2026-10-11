import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineNode,
  type NodeAgent,
  type NodeGuards,
  type NodeSpec,
  type NodeTool,
  type NodeToolRef,
} from '../src/index.js';

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

  it('accepts the fields core added: input_schema, model, agent, guards, budgets.usd, entry, allow_tainted, builtin://', () => {
    const agent = defineNode({
      kind: 'agent',
      prompt: {
        system: 'Approve or flag invoices.',
        input_schema: { type: 'object', required: ['invoice_id'] },
        output_schema: { type: 'object' },
      },
      model_policy: { model: 'caliban/auto', candidates: ['tier:small'] },
      tools: [
        { ref: 'builtin://datasource_query', effect: 'read' },
        { ref: 'mcp://erp/approve#sha256:ab', effect: 'write', allow_tainted: ['tool:erp/*', 'datasource'] },
        { ref: 'node://kb@v2', effect: 'read' },
      ],
      datasources: { scopes: ['erp.invoices:read'] },
      guardrails: { injection_mode: 'camel' },
      agent: { max_turns: 4 },
      budgets: { steps: 5, tokens: 100, wall_clock_s: 10, usd: 1 },
      guards: { max_repeats: 2, tool_retries: 0 },
    });
    expect(agent.agent.max_turns).toBe(4);
    expect(agent.budgets.usd).toBe(1);
    expectTypeOf(agent.guards).toEqualTypeOf<{ readonly max_repeats: 2; readonly tool_retries: 0 }>();
    expectTypeOf(agent).toExtend<NodeSpec>();

    const workflow = defineNode({
      kind: 'workflow',
      prompt: { system: 'Classify, then answer.' },
      model_policy: {},
      budgets: { steps: 10, tokens: 1_000, wall_clock_s: 30 },
      graph: {
        entry: 'classify',
        vertices: [
          { id: 'classify', type: 'llm' },
          { id: 'answer', type: 'llm' },
        ],
        edges: [{ from: 'classify', to: 'answer' }],
      },
    });
    expect(workflow.graph.entry).toBe('classify');

    expectTypeOf<NonNullable<NodeSpec['prompt']['input_schema']>>().toEqualTypeOf<{ [k: string]: unknown }>();
    expectTypeOf<NodeSpec['model_policy']['model']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NodeAgent['max_turns']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NodeGuards>().toEqualTypeOf<{ max_repeats?: number; tool_retries?: number }>();
    expectTypeOf<NodeSpec['budgets']['usd']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NonNullable<NodeSpec['graph']>['entry']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NodeTool['allow_tainted']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<'builtin://datasource_query'>().toExtend<NodeToolRef>();
    expectTypeOf<'mcp://erp/approve#sha256:ab'>().toExtend<NodeToolRef>();
    expectTypeOf<'node://kb@v2'>().toExtend<NodeToolRef>();
    expectTypeOf<'https://example.com'>().not.toExtend<NodeToolRef>();
  });

  it('rejects unknown keys in guards (additionalProperties: false) at compile time', () => {
    defineNode({
      kind: 'agent',
      prompt: { system: 'x' },
      model_policy: {},
      budgets: { steps: 1, tokens: 1, wall_clock_s: 1 },
      // @ts-expect-error guards is closed: `max_loops` is not a field
      guards: { max_repeats: 2, max_loops: 3 },
    });
    defineNode({
      kind: 'agent',
      prompt: { system: 'x' },
      model_policy: {},
      budgets: { steps: 1, tokens: 1, wall_clock_s: 1 },
      // @ts-expect-error agent.max_turns is a number
      agent: { max_turns: 'many' },
    });
    expect(true).toBe(true);
  });
});
