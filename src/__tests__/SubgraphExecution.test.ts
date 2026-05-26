/**
 * SubgraphExecution TDD Tests
 *
 * Tests for graph-of-graphs infrastructure:
 * - SubgraphRegistry: register, resolve, execute named subgraphs
 * - SubgraphNode: a node type that delegates to a named subgraph
 * - SpawnBridge: transition from graph execution into A2A bounded pool
 * - Input/output mapping between parent and child graphs
 * - Recursive subgraph invocation with depth limits
 * - Error propagation from subgraph to parent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SubgraphRegistry,
  createSubgraphRegistry,
  SpawnBridge,
  createSpawnBridge,
  SubgraphExecutionError,
} from '../SubgraphExecution';
import { createGraphBuilder, createGraphExecutor } from '../GraphExecution';

describe('SubgraphRegistry', () => {
  let registry: SubgraphRegistry;

  beforeEach(() => {
    registry = createSubgraphRegistry();
  });

  it('registers and executes a named subgraph', async () => {
    registry.register('enrich', () =>
      createGraphBuilder()
        .addNode('fetch', async (state) => ({ ...state, data: 'fetched' }))
        .addNode('transform', async (state) => ({ ...state, data: state.data + '-transformed' }))
        .addEdge('fetch', 'transform')
        .setEntryPoint('fetch')
        .setExitPoint('transform')
        .build()
    );

    const result = await registry.execute('enrich', { initial: true });

    expect(result.finalState.data).toBe('fetched-transformed');
    expect(result.finalState.initial).toBe(true);
    expect(result.path).toEqual(['fetch', 'transform']);
  });

  it('throws SubgraphExecutionError for unregistered graph', async () => {
    await expect(registry.execute('nonexistent', {})).rejects.toThrow(SubgraphExecutionError);
    await expect(registry.execute('nonexistent', {})).rejects.toThrow(/not found/i);
  });

  it('lists all registered subgraph names', () => {
    registry.register('a', () => createGraphBuilder().addNode('x', async (s) => s).setEntryPoint('x').setExitPoint('x').build());
    registry.register('b', () => createGraphBuilder().addNode('y', async (s) => s).setEntryPoint('y').setExitPoint('y').build());

    expect(registry.list()).toEqual(['a', 'b']);
  });

  it('allows unregistering a subgraph', () => {
    registry.register('temp', () => createGraphBuilder().addNode('x', async (s) => s).setEntryPoint('x').setExitPoint('x').build());
    expect(registry.has('temp')).toBe(true);

    registry.unregister('temp');
    expect(registry.has('temp')).toBe(false);
  });

  it('supports input mapping (select subset of parent state)', async () => {
    registry.register('focused', () =>
      createGraphBuilder()
        .addNode('process', async (state) => ({ ...state, result: `processed-${state.inputValue}` }))
        .setEntryPoint('process')
        .setExitPoint('process')
        .build()
    );

    const result = await registry.execute('focused', { inputValue: 'hello' }, {
      inputMapping: (parentState) => ({ inputValue: parentState.inputValue }),
    });

    expect(result.finalState.result).toBe('processed-hello');
    // Only mapped input was passed — other parent state not leaked
    expect(result.finalState.extraStuff).toBeUndefined();
  });

  it('supports output mapping (select subset of subgraph result)', async () => {
    registry.register('producer', () =>
      createGraphBuilder()
        .addNode('work', async (state) => ({
          ...state,
          useful: 'keep-this',
          internal: 'discard-this',
        }))
        .setEntryPoint('work')
        .setExitPoint('work')
        .build()
    );

    const result = await registry.execute('producer', {}, {
      outputMapping: (subState) => ({ useful: subState.useful }),
    });

    expect(result.finalState.useful).toBe('keep-this');
    expect(result.finalState.internal).toBeUndefined();
  });

  it('enforces max recursion depth', async () => {
    registry.register('recursive', () =>
      createGraphBuilder()
        .addNode('recurse', async (state) => {
          if (state.depth <= 0) return { ...state, done: true };
          const result = await registry.execute('recursive', { ...state, depth: state.depth - 1 });
          if (result.error) throw result.error;
          return { ...state, ...result.finalState };
        })
        .setEntryPoint('recurse')
        .setExitPoint('recurse')
        .build()
    );

    // Should succeed within limit
    const shallow = await registry.execute('recursive', { depth: 3 }, { maxDepth: 10 });
    expect(shallow.finalState.done).toBe(true);

    // Should hit depth limit and propagate error through result
    const deep = await registry.execute('recursive', { depth: 20 }, { maxDepth: 5 });
    expect(deep.error).toBeDefined();
    expect(deep.error!.message).toMatch(/max.*depth/i);
  });

  it('propagates errors from subgraph execution', async () => {
    registry.register('faulty', () =>
      createGraphBuilder()
        .addNode('explode', async () => { throw new Error('subgraph boom'); })
        .setEntryPoint('explode')
        .setExitPoint('explode')
        .build()
    );

    const result = await registry.execute('faulty', {});
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('subgraph boom');
  });

  it('isolates subgraph state from parent (no unintended leakage)', async () => {
    registry.register('isolated', () =>
      createGraphBuilder()
        .addNode('mutate', async (state) => ({
          ...state,
          childOnly: 'child-value',
          shared: 'child-override',
        }))
        .setEntryPoint('mutate')
        .setExitPoint('mutate')
        .build()
    );

    const parentState = { shared: 'parent-value', parentOnly: 'parent-secret' };
    const result = await registry.execute('isolated', parentState, {
      inputMapping: (s) => ({ shared: s.shared }),
      outputMapping: (s) => ({ shared: s.shared }),
    });

    expect(result.finalState.shared).toBe('child-override');
    expect(result.finalState.parentOnly).toBeUndefined();
    expect(result.finalState.childOnly).toBeUndefined();
  });
});

describe('SubgraphNode in parent graph', () => {
  it('executes a subgraph as a node within parent graph execution', async () => {
    const registry = createSubgraphRegistry();

    registry.register('code-analysis', () =>
      createGraphBuilder()
        .addNode('read-code', async (state) => ({ ...state, code: 'class Foo {}' }))
        .addNode('analyze', async (state) => ({ ...state, analysis: 'Simple class definition' }))
        .addEdge('read-code', 'analyze')
        .setEntryPoint('read-code')
        .setExitPoint('analyze')
        .build()
    );

    const parentGraph = createGraphBuilder()
      .addNode('prepare', async (state) => ({ ...state, ready: true }))
      .addNode('subgraph-code-analysis', async (state) => {
        const result = await registry.execute('code-analysis', state);
        return { ...state, ...result.finalState };
      })
      .addNode('summarize', async (state) => ({
        ...state,
        summary: `Analysis: ${state.analysis}`,
      }))
      .addEdge('prepare', 'subgraph-code-analysis')
      .addEdge('subgraph-code-analysis', 'summarize')
      .setEntryPoint('prepare')
      .setExitPoint('summarize')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(parentGraph, {});

    expect(result.error).toBeUndefined();
    expect(result.finalState.ready).toBe(true);
    expect(result.finalState.code).toBe('class Foo {}');
    expect(result.finalState.summary).toBe('Analysis: Simple class definition');
  });

  it('routes to different subgraphs based on conditional edges', async () => {
    const registry = createSubgraphRegistry();

    registry.register('path-a', () =>
      createGraphBuilder()
        .addNode('work-a', async (state) => ({ ...state, result: 'path-a-done' }))
        .setEntryPoint('work-a')
        .setExitPoint('work-a')
        .build()
    );

    registry.register('path-b', () =>
      createGraphBuilder()
        .addNode('work-b', async (state) => ({ ...state, result: 'path-b-done' }))
        .setEntryPoint('work-b')
        .setExitPoint('work-b')
        .build()
    );

    const graph = createGraphBuilder()
      .addNode('classify', async (state) => state)
      .addNode('exec-a', async (state) => {
        const r = await registry.execute('path-a', state);
        return { ...state, ...r.finalState };
      })
      .addNode('exec-b', async (state) => {
        const r = await registry.execute('path-b', state);
        return { ...state, ...r.finalState };
      })
      .addNode('done', async (state) => state)
      .addConditionalEdge('classify', (state) => state.route === 'a' ? 'exec-a' : 'exec-b')
      .addEdge('exec-a', 'done')
      .addEdge('exec-b', 'done')
      .setEntryPoint('classify')
      .setExitPoint('done')
      .build();

    const executor = createGraphExecutor();

    const resultA = await executor.execute(graph, { route: 'a' });
    expect(resultA.finalState.result).toBe('path-a-done');

    const resultB = await executor.execute(graph, { route: 'b' });
    expect(resultB.finalState.result).toBe('path-b-done');
  });
});

describe('SpawnBridge', () => {
  it('spawns bounded pool of workers from graph context', async () => {
    const spawnedAgents: string[] = [];
    const bridge = createSpawnBridge({
      spawn: async (config) => {
        spawnedAgents.push(config.name);
        return { agentId: config.name, status: 'completed', output: { verified: true } };
      },
      spawnPool: async (configs, concurrency) => {
        const results = [];
        for (const config of configs) {
          spawnedAgents.push(config.name);
          results.push({ agentId: config.name, status: 'completed' as const, output: { verified: true } });
        }
        return results;
      },
    });

    const results = await bridge.spawnPool(
      Array.from({ length: 5 }, (_, i) => ({
        name: `verifier-${i}`,
        input: { claim: `claim-${i}` },
        lifecycle: 'one-shot' as const,
      })),
      3 // max concurrency
    );

    expect(results).toHaveLength(5);
    expect(spawnedAgents).toHaveLength(5);
    expect(results.every(r => r.status === 'completed')).toBe(true);
  });

  it('respects concurrency limit in bounded pool', async () => {
    let activeConcurrency = 0;
    let maxConcurrency = 0;

    const bridge = createSpawnBridge({
      spawn: async (config) => {
        activeConcurrency++;
        maxConcurrency = Math.max(maxConcurrency, activeConcurrency);
        await new Promise(r => setTimeout(r, 5));
        activeConcurrency--;
        return { agentId: config.name, status: 'completed', output: {} };
      },
      spawnPool: async (configs, concurrency) => {
        // This won't be called — the bridge uses spawn internally
        return [];
      },
    });

    const results = await bridge.spawnPool(
      Array.from({ length: 6 }, (_, i) => ({
        name: `worker-${i}`,
        input: {},
        lifecycle: 'one-shot' as const,
      })),
      2
    );

    expect(results).toHaveLength(6);
    // Batch processing: max 2 concurrent since we await at limit
    expect(maxConcurrency).toBeLessThanOrEqual(2);
  });

  it('collects and merges results from all spawned workers', async () => {
    const bridge = createSpawnBridge({
      spawn: async (config) => ({
        agentId: config.name,
        status: 'completed',
        output: { confidence: 0.9 + Math.random() * 0.1 },
      }),
      spawnPool: async (configs) => {
        return configs.map((config, i) => ({
          agentId: config.name,
          status: 'completed' as const,
          output: { confidence: 0.91 + i * 0.01, issues: [] },
        }));
      },
    });

    const results = await bridge.spawnPool(
      Array.from({ length: 5 }, (_, i) => ({
        name: `checker-${i}`,
        input: { doc: 'test doc' },
        lifecycle: 'one-shot' as const,
      })),
      5
    );

    const avgConfidence = results.reduce(
      (sum, r) => sum + (r.output as any).confidence, 0
    ) / results.length;

    expect(avgConfidence).toBeGreaterThan(0.9);
    expect(results).toHaveLength(5);
  });

  it('handles worker failures gracefully in bounded pool', async () => {
    const bridge = createSpawnBridge({
      spawn: async (config) => {
        if (config.name === 'worker-2') {
          return { agentId: config.name, status: 'failed', output: { error: 'timeout' } };
        }
        return { agentId: config.name, status: 'completed', output: { ok: true } };
      },
      spawnPool: async (configs) => {
        return configs.map(config => {
          if (config.name === 'worker-2') {
            return { agentId: config.name, status: 'failed' as const, output: { error: 'timeout' } };
          }
          return { agentId: config.name, status: 'completed' as const, output: { ok: true } };
        });
      },
    });

    const results = await bridge.spawnPool(
      Array.from({ length: 4 }, (_, i) => ({
        name: `worker-${i}`,
        input: {},
        lifecycle: 'one-shot' as const,
      })),
      4
    );

    expect(results).toHaveLength(4);
    const failed = results.filter(r => r.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].agentId).toBe('worker-2');
  });

  it('integrates with graph execution as a spawn node', async () => {
    const bridge = createSpawnBridge({
      spawn: async () => ({ agentId: 'w', status: 'completed', output: { confidence: 0.95 } }),
      spawnPool: async (configs) =>
        configs.map(c => ({ agentId: c.name, status: 'completed' as const, output: { confidence: 0.95, issues: [] } })),
    });

    const graph = createGraphBuilder()
      .addNode('prepare-claims', async (state) => ({
        ...state,
        claims: ['claim1', 'claim2', 'claim3'],
      }))
      .addNode('spawn-verifiers', async (state) => {
        const results = await bridge.spawnPool(
          (state.claims as string[]).map((claim, i) => ({
            name: `verifier-${i}`,
            input: { claim },
            lifecycle: 'one-shot' as const,
          })),
          3
        );
        const avgConfidence = results.reduce(
          (sum, r) => sum + (r.output as any).confidence, 0
        ) / results.length;
        return { ...state, verificationResults: results, avgConfidence };
      })
      .addNode('done', async (state) => ({ ...state, verified: state.avgConfidence > 0.9 }))
      .addEdge('prepare-claims', 'spawn-verifiers')
      .addEdge('spawn-verifiers', 'done')
      .setEntryPoint('prepare-claims')
      .setExitPoint('done')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(graph, {});

    expect(result.error).toBeUndefined();
    expect(result.finalState.verified).toBe(true);
    expect(result.finalState.avgConfidence).toBeCloseTo(0.95);
  });
});
