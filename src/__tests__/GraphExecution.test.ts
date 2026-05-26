import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGraphBuilder,
  createGraphExecutor,
  GraphBuilder,
  GraphExecutor,
} from '../GraphExecution';

describe('GraphExecution', () => {
  let builder: GraphBuilder;
  let executor: GraphExecutor;

  beforeEach(() => {
    builder = createGraphBuilder();
    executor = createGraphExecutor();
  });

  describe('linear graph execution', () => {
    it('should execute A -> B -> C in order', async () => {
      const order: string[] = [];
      builder
        .addNode('A', async (s) => { order.push('A'); return { ...s, a: true }; })
        .addNode('B', async (s) => { order.push('B'); return { ...s, b: true }; })
        .addNode('C', async (s) => { order.push('C'); return { ...s, c: true }; })
        .addEdge('A', 'B')
        .addEdge('B', 'C')
        .setEntryPoint('A')
        .setExitPoint('C');

      const graph = builder.build();
      const result = await executor.execute(graph, {});

      expect(order).toEqual(['A', 'B', 'C']);
      expect(result.finalState).toEqual({ a: true, b: true, c: true });
      expect(result.path).toEqual(['A', 'B', 'C']);
    });

    it('should pass state between nodes', async () => {
      builder
        .addNode('init', async () => ({ count: 1 }))
        .addNode('increment', async (s) => ({ count: s.count + 1 }))
        .addNode('done', async (s) => s)
        .addEdge('init', 'increment')
        .addEdge('increment', 'done')
        .setEntryPoint('init')
        .setExitPoint('done');

      const graph = builder.build();
      const result = await executor.execute(graph, {});

      expect(result.finalState.count).toBe(2);
    });
  });

  describe('conditional routing', () => {
    it('should follow conditional edge based on state', async () => {
      builder
        .addNode('check', async (s) => s)
        .addNode('approved', async (s) => ({ ...s, outcome: 'approved' }))
        .addNode('rejected', async (s) => ({ ...s, outcome: 'rejected' }))
        .addConditionalEdge('check', (s) => s.isValid ? 'approved' : 'rejected')
        .setEntryPoint('check')
        .setExitPoint('approved')
        .setExitPoint('rejected');

      const graph = builder.build();

      const result1 = await executor.execute(graph, { isValid: true });
      expect(result1.finalState.outcome).toBe('approved');

      const result2 = await executor.execute(graph, { isValid: false });
      expect(result2.finalState.outcome).toBe('rejected');
    });

    it('should support multi-way conditional routing', async () => {
      builder
        .addNode('classify', async (s) => s)
        .addNode('low', async (s) => ({ ...s, priority: 'low' }))
        .addNode('medium', async (s) => ({ ...s, priority: 'medium' }))
        .addNode('high', async (s) => ({ ...s, priority: 'high' }))
        .addConditionalEdge('classify', (s) => {
          if (s.score > 80) return 'high';
          if (s.score > 50) return 'medium';
          return 'low';
        })
        .setEntryPoint('classify')
        .setExitPoint('low')
        .setExitPoint('medium')
        .setExitPoint('high');

      const graph = builder.build();

      const result = await executor.execute(graph, { score: 90 });
      expect(result.finalState.priority).toBe('high');
    });
  });

  describe('parallel branches', () => {
    it('should execute parallel branches (A -> [B,C] -> D)', async () => {
      const executed: string[] = [];
      builder
        .addNode('A', async (s) => { executed.push('A'); return s; })
        .addNode('B', async (s) => { executed.push('B'); return { ...s, b: true }; })
        .addNode('C', async (s) => { executed.push('C'); return { ...s, c: true }; })
        .addNode('D', async (s) => { executed.push('D'); return s; })
        .addEdge('A', 'B')
        .addEdge('A', 'C')
        .addEdge('B', 'D')
        .addEdge('C', 'D')
        .setEntryPoint('A')
        .setExitPoint('D');

      const graph = builder.build();
      const result = await executor.execute(graph, {});

      expect(executed).toContain('A');
      expect(executed).toContain('B');
      expect(executed).toContain('C');
      expect(executed).toContain('D');
      // D should come after both B and C
      expect(executed.indexOf('D')).toBeGreaterThan(executed.indexOf('B'));
      expect(executed.indexOf('D')).toBeGreaterThan(executed.indexOf('C'));
    });

    it('should join node waits for all branches before proceeding', async () => {
      let bDone = false;
      let cDone = false;

      builder
        .addNode('fork', async (s) => s)
        .addNode('slow', async (s) => {
          await new Promise(r => setTimeout(r, 50));
          bDone = true;
          return { ...s, slow: true };
        })
        .addNode('fast', async (s) => {
          cDone = true;
          return { ...s, fast: true };
        })
        .addNode('join', async (s) => {
          // At this point both branches should be complete
          expect(bDone).toBe(true);
          expect(cDone).toBe(true);
          return s;
        })
        .addEdge('fork', 'slow')
        .addEdge('fork', 'fast')
        .addEdge('slow', 'join')
        .addEdge('fast', 'join')
        .setEntryPoint('fork')
        .setExitPoint('join');

      const graph = builder.build();
      const result = await executor.execute(graph, {});

      expect(result.finalState.slow).toBe(true);
      expect(result.finalState.fast).toBe(true);
    });
  });

  describe('cycle detection and max iterations', () => {
    it('should enforce max iteration limit on cycles', async () => {
      let count = 0;
      builder
        .addNode('loop', async (s) => { count++; return { ...s, count }; })
        .addConditionalEdge('loop', (s) => s.count < 100 ? 'loop' : '__END__')
        .setEntryPoint('loop')
        .setMaxIterations(10);

      const graph = builder.build();
      const result = await executor.execute(graph, { count: 0 });

      expect(result.iterations).toBeLessThanOrEqual(10);
      expect(count).toBeLessThanOrEqual(10);
    });

    it('should allow intentional loops within max iterations', async () => {
      let count = 0;
      builder
        .addNode('retry', async (s) => { count++; return { ...s, attempts: count }; })
        .addNode('done', async (s) => s)
        .addConditionalEdge('retry', (s) => s.attempts >= 3 ? 'done' : 'retry')
        .setEntryPoint('retry')
        .setExitPoint('done')
        .setMaxIterations(5);

      const graph = builder.build();
      const result = await executor.execute(graph, { attempts: 0 });

      expect(result.finalState.attempts).toBe(3);
      expect(result.path).toContain('done');
    });
  });

  describe('node timeout', () => {
    it('should timeout a node that exceeds its configured timeout', async () => {
      builder
        .addNode('slow', async () => {
          await new Promise(r => setTimeout(r, 5000));
          return {};
        })
        .setEntryPoint('slow')
        .setExitPoint('slow')
        .setNodeTimeout('slow', 100);

      const graph = builder.build();
      const result = await executor.execute(graph, {});

      expect(result.error).toBeDefined();
      expect(result.error!.message).toMatch(/timeout/i);
    });
  });

  describe('node failure', () => {
    it('should capture error when node handler throws', async () => {
      builder
        .addNode('explode', async () => { throw new Error('Node failed!'); })
        .setEntryPoint('explode')
        .setExitPoint('explode');

      const graph = builder.build();
      const result = await executor.execute(graph, {});

      expect(result.error).toBeDefined();
      expect(result.error!.message).toBe('Node failed!');
    });

    it('should record path up to the failing node', async () => {
      builder
        .addNode('A', async (s) => s)
        .addNode('B', async () => { throw new Error('B failed'); })
        .addNode('C', async (s) => s)
        .addEdge('A', 'B')
        .addEdge('B', 'C')
        .setEntryPoint('A')
        .setExitPoint('C');

      const graph = builder.build();
      const result = await executor.execute(graph, {});

      expect(result.path).toContain('A');
      expect(result.path).toContain('B');
      expect(result.path).not.toContain('C');
    });
  });

  describe('skip node', () => {
    it('should skip a node based on a condition', async () => {
      builder
        .addNode('A', async (s) => s)
        .addNode('optional', async (s) => ({ ...s, optional: true }))
        .addNode('C', async (s) => s)
        .addConditionalEdge('A', (s) => s.skipOptional ? 'C' : 'optional')
        .addEdge('optional', 'C')
        .setEntryPoint('A')
        .setExitPoint('C');

      const graph = builder.build();
      const result = await executor.execute(graph, { skipOptional: true });

      expect(result.finalState.optional).toBeUndefined();
      expect(result.path).not.toContain('optional');
    });
  });

  describe('data passing between nodes', () => {
    it('should accumulate state modifications across nodes', async () => {
      builder
        .addNode('step1', async (s) => ({ ...s, step1: 'done' }))
        .addNode('step2', async (s) => ({ ...s, step2: 'done', step1Check: s.step1 }))
        .addNode('step3', async (s) => ({ ...s, step3: 'done' }))
        .addEdge('step1', 'step2')
        .addEdge('step2', 'step3')
        .setEntryPoint('step1')
        .setExitPoint('step3');

      const graph = builder.build();
      const result = await executor.execute(graph, {});

      expect(result.finalState.step1).toBe('done');
      expect(result.finalState.step2).toBe('done');
      expect(result.finalState.step3).toBe('done');
      expect(result.finalState.step1Check).toBe('done');
    });

    it('should pass initial state to entry node', async () => {
      builder
        .addNode('reader', async (s) => ({ ...s, read: s.input }))
        .setEntryPoint('reader')
        .setExitPoint('reader');

      const graph = builder.build();
      const result = await executor.execute(graph, { input: 'hello world' });

      expect(result.finalState.read).toBe('hello world');
    });
  });
});
