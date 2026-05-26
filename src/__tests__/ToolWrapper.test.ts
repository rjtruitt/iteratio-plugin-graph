import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createToolWrapperRegistry,
  ToolCallContext,
  ToolWrapperDef,
  WrapperAction,
} from '../ToolWrapper';

function makeCtx(tool: string, inputs: Record<string, unknown> = {}, extra?: Partial<ToolCallContext>): ToolCallContext {
  return { tool, inputs, timestamp: new Date(), ...extra };
}

function makeRealTool(returnValue: unknown = 'real-output') {
  return vi.fn().mockResolvedValue(returnValue);
}

describe('ToolWrapperRegistry', () => {
  describe('Registration', () => {
    it('register a wrapper, list shows it', () => {
      const registry = createToolWrapperRegistry();
      const wrapper: ToolWrapperDef = {
        name: 'cache-wrapper',
        tools: ['read_file'],
        handler: async () => ({ type: 'passthrough' as const }),
      };
      registry.register(wrapper);
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0].name).toBe('cache-wrapper');
    });

    it('register multiple wrappers, list shows all', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w1', tools: ['tool_a'], handler: async () => ({ type: 'passthrough' as const }) });
      registry.register({ name: 'w2', tools: ['tool_b'], handler: async () => ({ type: 'passthrough' as const }) });
      registry.register({ name: 'w3', tools: ['tool_c'], handler: async () => ({ type: 'passthrough' as const }) });
      expect(registry.list()).toHaveLength(3);
    });

    it('unregister removes wrapper', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'removable', tools: ['t'], handler: async () => ({ type: 'passthrough' as const }) });
      expect(registry.list()).toHaveLength(1);
      registry.unregister('removable');
      expect(registry.list()).toHaveLength(0);
    });

    it('unregister non-existent wrapper does not throw', () => {
      const registry = createToolWrapperRegistry();
      expect(() => registry.unregister('nope')).not.toThrow();
    });

    it('has() returns true for matching tool', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['mcp__github__*'], handler: async () => ({ type: 'passthrough' as const }) });
      expect(registry.has('mcp__github__createPR')).toBe(true);
    });

    it('has() returns false for non-matching tool', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['mcp__github__*'], handler: async () => ({ type: 'passthrough' as const }) });
      expect(registry.has('mcp__atlassian__getPage')).toBe(false);
    });

    it('has() returns false when registry is empty', () => {
      const registry = createToolWrapperRegistry();
      expect(registry.has('anything')).toBe(false);
    });

    it('getWrappersForTool returns matching wrappers sorted by priority', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'low-pri', tools: ['tool_a'], priority: 50, handler: async () => ({ type: 'passthrough' as const }) });
      registry.register({ name: 'high-pri', tools: ['tool_a'], priority: 10, handler: async () => ({ type: 'passthrough' as const }) });
      registry.register({ name: 'default-pri', tools: ['tool_a'], handler: async () => ({ type: 'passthrough' as const }) });
      const wrappers = registry.getWrappersForTool('tool_a');
      expect(wrappers).toHaveLength(3);
      expect(wrappers[0].name).toBe('high-pri');
      expect(wrappers[1].name).toBe('low-pri');
      expect(wrappers[2].name).toBe('default-pri');
    });

    it('getWrappersForTool returns empty array for non-matching tool', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['tool_a'], handler: async () => ({ type: 'passthrough' as const }) });
      expect(registry.getWrappersForTool('tool_b')).toHaveLength(0);
    });
  });

  describe('Basic execution', () => {
    it('no wrapper registered → calls real tool, fromWrapper: false', async () => {
      const registry = createToolWrapperRegistry();
      const realTool = makeRealTool('hello');
      const result = await registry.execute(makeCtx('some_tool', { x: 1 }), realTool);
      expect(realTool).toHaveBeenCalledWith({ x: 1 });
      expect(result.output).toBe('hello');
      expect(result.fromWrapper).toBe(false);
    });

    it('wrapper returns replace action → real tool NOT called, output returned', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'replacer',
        tools: ['target'],
        handler: async () => ({ type: 'replace', output: 'cached-value' } as WrapperAction),
      });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(realTool).not.toHaveBeenCalled();
      expect(result.output).toBe('cached-value');
      expect(result.fromWrapper).toBe(true);
      expect(result.wrapperName).toBe('replacer');
    });

    it('wrapper returns passthrough → real tool called normally', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'logger',
        tools: ['target'],
        handler: async () => ({ type: 'passthrough' } as WrapperAction),
      });
      const realTool = makeRealTool('tool-result');
      const result = await registry.execute(makeCtx('target', { a: 'b' }), realTool);
      expect(realTool).toHaveBeenCalledWith({ a: 'b' });
      expect(result.output).toBe('tool-result');
      expect(result.fromWrapper).toBe(false);
    });

    it('wrapper returns raw value (not WrapperAction) → treated as replace', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'raw-replacer',
        tools: ['target'],
        handler: async () => ({ data: 'intercepted' }),
      });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(realTool).not.toHaveBeenCalled();
      expect(result.output).toEqual({ data: 'intercepted' });
      expect(result.fromWrapper).toBe(true);
      expect(result.wrapperName).toBe('raw-replacer');
    });

    it('wrapper returns raw string value → treated as replace', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'string-replacer',
        tools: ['target'],
        handler: async () => 'just a string',
      });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(result.output).toBe('just a string');
      expect(result.fromWrapper).toBe(true);
    });

    it('wrapper returns null → treated as replace with null output', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'null-replacer',
        tools: ['target'],
        handler: async () => null,
      });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(result.output).toBeNull();
      expect(result.fromWrapper).toBe(true);
    });

    it('wrapper returns error action → throws, real tool not called', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'blocker',
        tools: ['target'],
        handler: async () => ({ type: 'error', message: 'Blocked by policy' } as WrapperAction),
      });
      const realTool = makeRealTool();
      await expect(registry.execute(makeCtx('target'), realTool)).rejects.toThrow('Blocked by policy');
      expect(realTool).not.toHaveBeenCalled();
    });
  });

  describe('Input/output transforms', () => {
    it('transform_input modifies inputs before real tool gets them', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'input-transformer',
        tools: ['target'],
        handler: async () => ({
          type: 'transform_input',
          inputs: { pageId: 'transformed-id', extra: true },
        } as WrapperAction),
      });
      const realTool = makeRealTool('result');
      const result = await registry.execute(makeCtx('target', { pageId: 'original-id' }), realTool);
      expect(realTool).toHaveBeenCalledWith({ pageId: 'transformed-id', extra: true });
      expect(result.output).toBe('result');
    });

    it('transform_output modifies result after real tool returns', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'output-transformer',
        tools: ['target'],
        handler: async () => ({
          type: 'transform_output',
          transform: (output: unknown) => ({ wrapped: true, original: output }),
        } as WrapperAction),
      });
      const realTool = makeRealTool('raw-result');
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(realTool).toHaveBeenCalled();
      expect(result.output).toEqual({ wrapped: true, original: 'raw-result' });
      expect(result.fromWrapper).toBe(true);
    });

    it('both transform_input and transform_output can chain in sequence', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'input-mod',
        tools: ['target'],
        priority: 10,
        handler: async () => ({
          type: 'transform_input',
          inputs: { query: 'modified-query' },
        } as WrapperAction),
      });
      registry.register({
        name: 'output-mod',
        tools: ['target'],
        priority: 20,
        handler: async () => ({
          type: 'transform_output',
          transform: (output: unknown) => `enriched:${output}`,
        } as WrapperAction),
      });
      const realTool = makeRealTool('base-result');
      const result = await registry.execute(makeCtx('target', { query: 'original' }), realTool);
      expect(realTool).toHaveBeenCalledWith({ query: 'modified-query' });
      expect(result.output).toBe('enriched:base-result');
    });

    it('multiple transform_output wrappers compose in order', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'first-transform',
        tools: ['target'],
        priority: 10,
        handler: async () => ({
          type: 'transform_output',
          transform: (output: unknown) => `[first:${output}]`,
        } as WrapperAction),
      });
      registry.register({
        name: 'second-transform',
        tools: ['target'],
        priority: 20,
        handler: async () => ({
          type: 'transform_output',
          transform: (output: unknown) => `[second:${output}]`,
        } as WrapperAction),
      });
      const realTool = makeRealTool('raw');
      const result = await registry.execute(makeCtx('target'), realTool);
      // First transform wraps outer, second wraps inner (since transforms apply after tool call)
      // Pipeline: tool returns 'raw', second-transform (inner) applies first to get '[second:raw]',
      // then first-transform (outer) applies to get '[first:[second:raw]]'
      expect(result.output).toBe('[first:[second:raw]]');
    });
  });

  describe('Conditions', () => {
    it('wrapper with condition returning false → skipped, real tool called', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'conditional',
        tools: ['target'],
        condition: () => false,
        handler: async () => ({ type: 'replace', output: 'intercepted' } as WrapperAction),
      });
      const realTool = makeRealTool('real-result');
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(result.output).toBe('real-result');
      expect(result.fromWrapper).toBe(false);
    });

    it('wrapper with condition returning true → executes normally', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'conditional',
        tools: ['target'],
        condition: () => true,
        handler: async () => ({ type: 'replace', output: 'intercepted' } as WrapperAction),
      });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(result.output).toBe('intercepted');
      expect(result.fromWrapper).toBe(true);
    });

    it('condition receives full context (tool name, inputs, metadata)', async () => {
      const registry = createToolWrapperRegistry();
      const conditionSpy = vi.fn().mockReturnValue(true);
      registry.register({
        name: 'conditional',
        tools: ['target'],
        condition: conditionSpy,
        handler: async () => ({ type: 'passthrough' } as WrapperAction),
      });
      const ctx = makeCtx('target', { key: 'value' }, { runId: 'run-123', metadata: { env: 'test' } });
      await registry.execute(ctx, makeRealTool());
      expect(conditionSpy).toHaveBeenCalledWith(expect.objectContaining({
        tool: 'target',
        inputs: { key: 'value' },
        runId: 'run-123',
        metadata: { env: 'test' },
      }));
    });

    it('wrapper without condition always runs', async () => {
      const registry = createToolWrapperRegistry();
      const handler = vi.fn().mockResolvedValue({ type: 'passthrough' });
      registry.register({ name: 'no-condition', tools: ['target'], handler });
      await registry.execute(makeCtx('target'), makeRealTool());
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('Priority ordering', () => {
    it('lower priority number runs first', async () => {
      const registry = createToolWrapperRegistry();
      const order: string[] = [];
      registry.register({
        name: 'second',
        tools: ['target'],
        priority: 20,
        handler: async () => { order.push('second'); return { type: 'passthrough' } as WrapperAction; },
      });
      registry.register({
        name: 'first',
        tools: ['target'],
        priority: 10,
        handler: async () => { order.push('first'); return { type: 'passthrough' } as WrapperAction; },
      });
      await registry.execute(makeCtx('target'), makeRealTool());
      expect(order).toEqual(['first', 'second']);
    });

    it('if first wrapper replaces → later wrappers never run', async () => {
      const registry = createToolWrapperRegistry();
      const secondHandler = vi.fn().mockResolvedValue({ type: 'passthrough' });
      registry.register({
        name: 'replacer',
        tools: ['target'],
        priority: 10,
        handler: async () => ({ type: 'replace', output: 'done' } as WrapperAction),
      });
      registry.register({
        name: 'second',
        tools: ['target'],
        priority: 20,
        handler: secondHandler,
      });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(result.output).toBe('done');
      expect(secondHandler).not.toHaveBeenCalled();
      expect(realTool).not.toHaveBeenCalled();
    });

    it('if first wrapper passthroughs → second wrapper gets to run', async () => {
      const registry = createToolWrapperRegistry();
      const secondHandler = vi.fn().mockResolvedValue({ type: 'replace', output: 'from-second' });
      registry.register({
        name: 'first',
        tools: ['target'],
        priority: 10,
        handler: async () => ({ type: 'passthrough' } as WrapperAction),
      });
      registry.register({
        name: 'second',
        tools: ['target'],
        priority: 20,
        handler: secondHandler,
      });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(result.output).toBe('from-second');
      expect(secondHandler).toHaveBeenCalled();
      expect(realTool).not.toHaveBeenCalled();
    });

    it('default priority (100) for wrappers without explicit priority', async () => {
      const registry = createToolWrapperRegistry();
      const order: string[] = [];
      registry.register({
        name: 'explicit-50',
        tools: ['target'],
        priority: 50,
        handler: async () => { order.push('50'); return { type: 'passthrough' } as WrapperAction; },
      });
      registry.register({
        name: 'default',
        tools: ['target'],
        handler: async () => { order.push('default'); return { type: 'passthrough' } as WrapperAction; },
      });
      registry.register({
        name: 'explicit-150',
        tools: ['target'],
        priority: 150,
        handler: async () => { order.push('150'); return { type: 'passthrough' } as WrapperAction; },
      });
      await registry.execute(makeCtx('target'), makeRealTool());
      expect(order).toEqual(['50', 'default', '150']);
    });
  });

  describe('Chaining multiple wrappers', () => {
    it('Wrapper A transforms input, Wrapper B replaces → B gets transformed inputs', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'A-transform',
        tools: ['target'],
        priority: 10,
        handler: async () => ({
          type: 'transform_input',
          inputs: { modified: true },
        } as WrapperAction),
      });
      registry.register({
        name: 'B-replace',
        tools: ['target'],
        priority: 20,
        handler: async (ctx) => ({
          type: 'replace',
          output: { gotInputs: ctx.inputs },
        } as WrapperAction),
      });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target', { original: true }), realTool);
      expect(result.output).toEqual({ gotInputs: { modified: true } });
      expect(realTool).not.toHaveBeenCalled();
    });

    it('Wrapper A passthroughs, Wrapper B passthroughs → real tool called', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'A',
        tools: ['target'],
        priority: 10,
        handler: async () => ({ type: 'passthrough' } as WrapperAction),
      });
      registry.register({
        name: 'B',
        tools: ['target'],
        priority: 20,
        handler: async () => ({ type: 'passthrough' } as WrapperAction),
      });
      const realTool = makeRealTool('final');
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(realTool).toHaveBeenCalled();
      expect(result.output).toBe('final');
      expect(result.fromWrapper).toBe(false);
    });

    it('Wrapper A replaces → B never runs, real tool never called', async () => {
      const registry = createToolWrapperRegistry();
      const bHandler = vi.fn().mockResolvedValue({ type: 'passthrough' });
      registry.register({
        name: 'A',
        tools: ['target'],
        priority: 10,
        handler: async () => ({ type: 'replace', output: 'from-A' } as WrapperAction),
      });
      registry.register({ name: 'B', tools: ['target'], priority: 20, handler: bHandler });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(result.output).toBe('from-A');
      expect(bHandler).not.toHaveBeenCalled();
      expect(realTool).not.toHaveBeenCalled();
    });

    it('error in first wrapper stops chain immediately', async () => {
      const registry = createToolWrapperRegistry();
      const bHandler = vi.fn().mockResolvedValue({ type: 'passthrough' });
      registry.register({
        name: 'A',
        tools: ['target'],
        priority: 10,
        handler: async () => ({ type: 'error', message: 'stopped' } as WrapperAction),
      });
      registry.register({ name: 'B', tools: ['target'], priority: 20, handler: bHandler });
      const realTool = makeRealTool();
      await expect(registry.execute(makeCtx('target'), realTool)).rejects.toThrow('stopped');
      expect(bHandler).not.toHaveBeenCalled();
      expect(realTool).not.toHaveBeenCalled();
    });
  });

  describe('Glob matching', () => {
    it('"mcp__atlassian__*" matches "mcp__atlassian__getConfluencePage"', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['mcp__atlassian__*'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      expect(registry.has('mcp__atlassian__getConfluencePage')).toBe(true);
    });

    it('"mcp__atlassian__*" does not match "mcp__github__createPR"', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['mcp__atlassian__*'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      expect(registry.has('mcp__github__createPR')).toBe(false);
    });

    it('"*" matches everything', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'catch-all', tools: ['*'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      expect(registry.has('anything_at_all')).toBe(true);
      expect(registry.has('mcp__github__push')).toBe(true);
      expect(registry.has('')).toBe(true);
    });

    it('exact name matches', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['read_file'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      expect(registry.has('read_file')).toBe(true);
      expect(registry.has('read_files')).toBe(false);
      expect(registry.has('xread_file')).toBe(false);
    });

    it('multiple patterns in tools array match independently', () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'multi',
        tools: ['mcp__github__*', 'mcp__atlassian__*'],
        handler: async () => ({ type: 'passthrough' } as WrapperAction),
      });
      expect(registry.has('mcp__github__createPR')).toBe(true);
      expect(registry.has('mcp__atlassian__getPage')).toBe(true);
      expect(registry.has('mcp__slack__sendMessage')).toBe(false);
    });

    it('glob with pattern in middle: "mcp__*__get*" matches "mcp__github__getFile"', () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['mcp__*__get*'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      expect(registry.has('mcp__github__getFile')).toBe(true);
      expect(registry.has('mcp__github__createFile')).toBe(false);
    });
  });

  describe('callReal usage in handler', () => {
    it('handler calls callReal() to get real tool output, then modifies it', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'modifier',
        tools: ['target'],
        handler: async (_ctx, callReal) => {
          const output = await callReal();
          return { type: 'replace', output: `modified:${output}` } as WrapperAction;
        },
      });
      const realTool = makeRealTool('original');
      const result = await registry.execute(makeCtx('target', { x: 1 }), realTool);
      expect(realTool).toHaveBeenCalledWith({ x: 1 });
      expect(result.output).toBe('modified:original');
      expect(result.fromWrapper).toBe(true);
    });

    it('handler calls callReal() with different inputs than original', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'redirect',
        tools: ['target'],
        handler: async (_ctx, callReal) => {
          const output = await callReal({ overridden: true });
          return { type: 'replace', output } as WrapperAction;
        },
      });
      const realTool = makeRealTool('result');
      const result = await registry.execute(makeCtx('target', { original: true }), realTool);
      expect(realTool).toHaveBeenCalledWith({ overridden: true });
      expect(result.output).toBe('result');
    });

    it('handler does not call callReal() (pure replacement)', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'pure-replace',
        tools: ['target'],
        handler: async (_ctx, _callReal) => {
          return { type: 'replace', output: 'no-real-tool' } as WrapperAction;
        },
      });
      const realTool = makeRealTool();
      const result = await registry.execute(makeCtx('target'), realTool);
      expect(realTool).not.toHaveBeenCalled();
      expect(result.output).toBe('no-real-tool');
    });

    it('callReal() properly calls the realTool function passed to execute()', async () => {
      const registry = createToolWrapperRegistry();
      const specificRealTool = vi.fn().mockResolvedValue({ data: [1, 2, 3] });
      registry.register({
        name: 'inspector',
        tools: ['target'],
        handler: async (ctx, callReal) => {
          const output = await callReal(ctx.inputs);
          return { type: 'replace', output } as WrapperAction;
        },
      });
      const result = await registry.execute(makeCtx('target', { query: 'test' }), specificRealTool);
      expect(specificRealTool).toHaveBeenCalledWith({ query: 'test' });
      expect(result.output).toEqual({ data: [1, 2, 3] });
    });

    it('callReal() without args uses current ctx.inputs', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'passthrough-via-callreal',
        tools: ['target'],
        handler: async (_ctx, callReal) => {
          const output = await callReal();
          return { type: 'replace', output: `got:${output}` } as WrapperAction;
        },
      });
      const realTool = makeRealTool('hello');
      await registry.execute(makeCtx('target', { a: 1 }), realTool);
      expect(realTool).toHaveBeenCalledWith({ a: 1 });
    });
  });

  describe('Stats', () => {
    it('totalIntercepted increments when a wrapper runs (even passthrough)', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['target'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      await registry.execute(makeCtx('target'), makeRealTool());
      expect(registry.getStats().totalIntercepted).toBe(1);
    });

    it('totalReplaced increments when a wrapper replaces', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['target'], handler: async () => ({ type: 'replace', output: 'x' } as WrapperAction) });
      await registry.execute(makeCtx('target'), makeRealTool());
      expect(registry.getStats().totalReplaced).toBe(1);
    });

    it('totalPassthrough increments when all wrappers passthrough to real tool', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['target'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      await registry.execute(makeCtx('target'), makeRealTool());
      expect(registry.getStats().totalPassthrough).toBe(1);
    });

    it('totalErrors increments on error action', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['target'], handler: async () => ({ type: 'error', message: 'fail' } as WrapperAction) });
      await registry.execute(makeCtx('target'), makeRealTool()).catch(() => {});
      expect(registry.getStats().totalErrors).toBe(1);
    });

    it('byWrapper tracks per-wrapper stats', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'cache', tools: ['tool_a'], handler: async () => ({ type: 'replace', output: 'cached' } as WrapperAction) });
      registry.register({ name: 'logger', tools: ['tool_b'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      await registry.execute(makeCtx('tool_a'), makeRealTool());
      await registry.execute(makeCtx('tool_a'), makeRealTool());
      await registry.execute(makeCtx('tool_b'), makeRealTool());
      const stats = registry.getStats();
      expect(stats.byWrapper['cache']).toEqual({ intercepted: 2, replaced: 2, passthrough: 0 });
      expect(stats.byWrapper['logger']).toEqual({ intercepted: 1, replaced: 0, passthrough: 1 });
    });

    it('byTool tracks per-tool stats', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['*'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      await registry.execute(makeCtx('tool_a'), makeRealTool());
      await registry.execute(makeCtx('tool_a'), makeRealTool());
      await registry.execute(makeCtx('tool_b'), makeRealTool());
      const stats = registry.getStats();
      expect(stats.byTool['tool_a']).toEqual({ intercepted: 2, replaced: 0, passthrough: 2 });
      expect(stats.byTool['tool_b']).toEqual({ intercepted: 1, replaced: 0, passthrough: 1 });
    });

    it('reset clears everything', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['*'], handler: async () => ({ type: 'replace', output: 'x' } as WrapperAction) });
      await registry.execute(makeCtx('tool_a'), makeRealTool());
      await registry.execute(makeCtx('tool_b'), makeRealTool());
      registry.reset();
      const stats = registry.getStats();
      expect(stats.totalIntercepted).toBe(0);
      expect(stats.totalReplaced).toBe(0);
      expect(stats.totalPassthrough).toBe(0);
      expect(stats.totalErrors).toBe(0);
      expect(stats.byWrapper).toEqual({});
      expect(stats.byTool).toEqual({});
    });

    it('stats track correctly across multiple calls', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'conditional-cache',
        tools: ['target'],
        condition: (ctx) => ctx.inputs.cached === true,
        handler: async () => ({ type: 'replace', output: 'from-cache' } as WrapperAction),
      });
      // First call: condition false → passthrough to real tool (wrapper skipped, so no intercept)
      await registry.execute(makeCtx('target', { cached: false }), makeRealTool());
      // Second call: condition true → replaced
      await registry.execute(makeCtx('target', { cached: true }), makeRealTool());
      const stats = registry.getStats();
      expect(stats.totalIntercepted).toBe(1); // only the one where condition was true
      expect(stats.totalReplaced).toBe(1);
      expect(stats.totalPassthrough).toBe(0); // first call had no active wrappers
    });

    it('no wrapper matched → no stats recorded for intercept', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['other_tool'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      await registry.execute(makeCtx('unmatched_tool'), makeRealTool());
      const stats = registry.getStats();
      expect(stats.totalIntercepted).toBe(0);
      expect(stats.totalPassthrough).toBe(0);
    });
  });

  describe('Edge cases', () => {
    it('empty registry → all calls go to real tool', async () => {
      const registry = createToolWrapperRegistry();
      const realTool = makeRealTool('direct');
      const result = await registry.execute(makeCtx('any_tool', { data: 123 }), realTool);
      expect(realTool).toHaveBeenCalledWith({ data: 123 });
      expect(result.output).toBe('direct');
      expect(result.fromWrapper).toBe(false);
    });

    it('wrapper registered for different tool → does not affect this tool', async () => {
      const registry = createToolWrapperRegistry();
      const handler = vi.fn().mockResolvedValue({ type: 'replace', output: 'nope' });
      registry.register({ name: 'other', tools: ['other_tool'], handler });
      const realTool = makeRealTool('real');
      const result = await registry.execute(makeCtx('my_tool'), realTool);
      expect(handler).not.toHaveBeenCalled();
      expect(result.output).toBe('real');
    });

    it('real tool throws → error propagates (wrapper does not swallow it)', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['target'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      const realTool = vi.fn().mockRejectedValue(new Error('tool exploded'));
      await expect(registry.execute(makeCtx('target'), realTool)).rejects.toThrow('tool exploded');
    });

    it('wrapper handler throws → error propagates with wrapper context', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'broken-wrapper',
        tools: ['target'],
        handler: async () => { throw new Error('wrapper bug'); },
      });
      const realTool = makeRealTool();
      await expect(registry.execute(makeCtx('target'), realTool)).rejects.toThrow('wrapper bug');
      expect(realTool).not.toHaveBeenCalled();
    });

    it('multiple wrappers match same tool via different patterns', async () => {
      const registry = createToolWrapperRegistry();
      const order: string[] = [];
      registry.register({
        name: 'star-match',
        tools: ['*'],
        priority: 50,
        handler: async () => { order.push('star'); return { type: 'passthrough' } as WrapperAction; },
      });
      registry.register({
        name: 'prefix-match',
        tools: ['mcp__github__*'],
        priority: 10,
        handler: async () => { order.push('prefix'); return { type: 'passthrough' } as WrapperAction; },
      });
      await registry.execute(makeCtx('mcp__github__push'), makeRealTool());
      expect(order).toEqual(['prefix', 'star']);
    });

    it('wrapper with tools: ["*"] catches everything', async () => {
      const registry = createToolWrapperRegistry();
      const handler = vi.fn().mockResolvedValue({ type: 'passthrough' });
      registry.register({ name: 'global', tools: ['*'], handler });
      await registry.execute(makeCtx('random_tool_1'), makeRealTool());
      await registry.execute(makeCtx('random_tool_2'), makeRealTool());
      await registry.execute(makeCtx('mcp__x__y'), makeRealTool());
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('duration is tracked in result', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['target'], handler: async () => ({ type: 'passthrough' } as WrapperAction) });
      const result = await registry.execute(makeCtx('target'), makeRealTool());
      expect(result.duration).toBeTypeOf('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('re-registering wrapper with same name replaces the old one', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({ name: 'w', tools: ['tool_a'], handler: async () => ({ type: 'replace', output: 'v1' } as WrapperAction) });
      registry.register({ name: 'w', tools: ['tool_a'], handler: async () => ({ type: 'replace', output: 'v2' } as WrapperAction) });
      expect(registry.list()).toHaveLength(1);
      const result = await registry.execute(makeCtx('tool_a'), makeRealTool());
      expect(result.output).toBe('v2');
    });
  });

  describe('Real-world patterns (integration scenarios)', () => {
    it('cache wrapper: checks local map, if exists return content, else passthrough', async () => {
      const cache = new Map<string, string>();
      cache.set('page-123', 'cached page content');

      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'page-cache',
        tools: ['mcp__atlassian__getConfluencePage'],
        handler: async (ctx) => {
          const pageId = ctx.inputs.pageId as string;
          if (cache.has(pageId)) {
            return { type: 'replace', output: cache.get(pageId) } as WrapperAction;
          }
          return { type: 'passthrough' } as WrapperAction;
        },
      });

      // Cache hit
      const realTool = makeRealTool('from-api');
      const hit = await registry.execute(
        makeCtx('mcp__atlassian__getConfluencePage', { pageId: 'page-123' }),
        realTool,
      );
      expect(hit.output).toBe('cached page content');
      expect(hit.fromWrapper).toBe(true);
      expect(realTool).not.toHaveBeenCalled();

      // Cache miss
      const miss = await registry.execute(
        makeCtx('mcp__atlassian__getConfluencePage', { pageId: 'page-999' }),
        realTool,
      );
      expect(miss.output).toBe('from-api');
      expect(miss.fromWrapper).toBe(false);
      expect(realTool).toHaveBeenCalledWith({ pageId: 'page-999' });
    });

    it('script wrapper: replaces real tool with custom logic', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'script-override',
        tools: ['mcp__atlassian__getConfluencePage'],
        handler: async (ctx) => {
          // Simulates running a curl script instead of the real MCP tool
          return {
            type: 'replace',
            output: { title: 'Scripted', body: `Fetched ${ctx.inputs.pageId} via script` },
          } as WrapperAction;
        },
      });

      const result = await registry.execute(
        makeCtx('mcp__atlassian__getConfluencePage', { pageId: 'ABC' }),
        makeRealTool(),
      );
      expect(result.output).toEqual({ title: 'Scripted', body: 'Fetched ABC via script' });
      expect(result.fromWrapper).toBe(true);
    });

    it('metrics wrapper: passthrough but records timing/call count', async () => {
      const metrics: Array<{ tool: string; duration: number }> = [];

      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'metrics',
        tools: ['*'],
        priority: 1, // run first
        handler: async (ctx, callReal) => {
          const start = Date.now();
          const output = await callReal();
          const duration = Date.now() - start;
          metrics.push({ tool: ctx.tool, duration });
          return { type: 'replace', output } as WrapperAction;
        },
      });

      const realTool = makeRealTool('result');
      const result = await registry.execute(makeCtx('some_tool'), realTool);
      expect(result.output).toBe('result');
      expect(metrics).toHaveLength(1);
      expect(metrics[0].tool).toBe('some_tool');
      expect(metrics[0].duration).toBeGreaterThanOrEqual(0);
    });

    it('enrichment wrapper: calls real tool, then adds extra metadata to result', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'enricher',
        tools: ['mcp__github__get_file_contents'],
        handler: async (ctx, callReal) => {
          const output = await callReal();
          return {
            type: 'replace',
            output: { content: output, enriched: true, fetchedAt: ctx.timestamp },
          } as WrapperAction;
        },
      });

      const realTool = makeRealTool('file content here');
      const result = await registry.execute(
        makeCtx('mcp__github__get_file_contents', { path: 'README.md' }),
        realTool,
      );
      expect(realTool).toHaveBeenCalledWith({ path: 'README.md' });
      expect(result.output).toEqual({
        content: 'file content here',
        enriched: true,
        fetchedAt: expect.any(Date),
      });
    });

    it('batching wrapper: accumulates calls, returns placeholder until flush', async () => {
      const batch: Array<{ inputs: Record<string, unknown>; resolve: (v: unknown) => void }> = [];

      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'batcher',
        tools: ['bulk_insert'],
        handler: async (ctx) => {
          // In a real system this would accumulate and flush on a timer/threshold.
          // For test purposes we just show the accumulation pattern.
          return new Promise((resolve) => {
            batch.push({ inputs: ctx.inputs, resolve: (v) => resolve({ type: 'replace', output: v }) });
          });
        },
      });

      // Start two calls (they will pend)
      const promise1 = registry.execute(makeCtx('bulk_insert', { row: 1 }), makeRealTool());
      const promise2 = registry.execute(makeCtx('bulk_insert', { row: 2 }), makeRealTool());

      // Simulate batch flush
      expect(batch).toHaveLength(2);
      batch[0].resolve('inserted-1');
      batch[1].resolve('inserted-2');

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1.output).toBe('inserted-1');
      expect(result2.output).toBe('inserted-2');
    });

    it('conditional wrapper: only intercepts under certain conditions', async () => {
      const registry = createToolWrapperRegistry();
      registry.register({
        name: 'read-only-mode',
        tools: ['mcp__github__*'],
        condition: (ctx) => ctx.metadata?.readOnly === true,
        handler: async (ctx) => {
          if (ctx.tool.includes('create') || ctx.tool.includes('push') || ctx.tool.includes('delete')) {
            return { type: 'error', message: 'Read-only mode: write operations blocked' } as WrapperAction;
          }
          return { type: 'passthrough' } as WrapperAction;
        },
      });

      // Read-only mode + write operation → blocked
      await expect(
        registry.execute(
          makeCtx('mcp__github__push_files', {}, { metadata: { readOnly: true } }),
          makeRealTool(),
        ),
      ).rejects.toThrow('Read-only mode');

      // Read-only mode + read operation → passthrough
      const readResult = await registry.execute(
        makeCtx('mcp__github__get_file_contents', {}, { metadata: { readOnly: true } }),
        makeRealTool('file-data'),
      );
      expect(readResult.output).toBe('file-data');

      // Normal mode (condition false) → wrapper skipped entirely
      const normalResult = await registry.execute(
        makeCtx('mcp__github__push_files', {}, { metadata: { readOnly: false } }),
        makeRealTool('pushed'),
      );
      expect(normalResult.output).toBe('pushed');
    });
  });
});
