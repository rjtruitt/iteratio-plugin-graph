import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGraphBuilder,
  createCycleDetector,
  createGraphExecutor,
  GraphBuilder,
  CycleDetector,
  GraphExecutor,
} from '../GraphCycleDetection';

describe('GraphCycleDetection', () => {
  let builder: GraphBuilder;
  let detector: CycleDetector;
  let executor: GraphExecutor;

  beforeEach(() => {
    builder = createGraphBuilder();
    detector = createCycleDetector();
    executor = createGraphExecutor();
  });

  describe('simple cycle detection', () => {
    it('should detect a simple cycle (A -> B -> A)', () => {
      builder
        .addNode('A', vi.fn())
        .addNode('B', vi.fn())
        .addEdge('A', 'B')
        .addEdge('B', 'A')
        .setEntryPoint('A');

      const graph = builder.build();
      const result = detector.detectCycles(graph);

      expect(result.hasCycle).toBe(true);
      expect(result.cycles).toHaveLength(1);
      expect(result.cycles[0]).toContain('A');
      expect(result.cycles[0]).toContain('B');
    });

    it('should detect a self-loop (A -> A)', () => {
      builder
        .addNode('A', vi.fn())
        .addEdge('A', 'A')
        .setEntryPoint('A');

      const graph = builder.build();
      const result = detector.detectCycles(graph);

      expect(result.hasCycle).toBe(true);
      expect(result.cycles[0]).toContain('A');
    });
  });

  describe('complex cycle detection', () => {
    it('should detect complex cycle (A -> B -> C -> A)', () => {
      builder
        .addNode('A', vi.fn())
        .addNode('B', vi.fn())
        .addNode('C', vi.fn())
        .addEdge('A', 'B')
        .addEdge('B', 'C')
        .addEdge('C', 'A')
        .setEntryPoint('A');

      const graph = builder.build();
      const result = detector.detectCycles(graph);

      expect(result.hasCycle).toBe(true);
      expect(result.cycles[0]).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    });

    it('should detect multiple independent cycles', () => {
      builder
        .addNode('A', vi.fn())
        .addNode('B', vi.fn())
        .addNode('C', vi.fn())
        .addNode('D', vi.fn())
        .addEdge('A', 'B')
        .addEdge('B', 'A')
        .addEdge('C', 'D')
        .addEdge('D', 'C')
        .setEntryPoint('A');

      const graph = builder.build();
      const result = detector.detectCycles(graph);

      expect(result.hasCycle).toBe(true);
      expect(result.cycles.length).toBeGreaterThanOrEqual(2);
    });

    it('should detect nested cycles', () => {
      builder
        .addNode('A', vi.fn())
        .addNode('B', vi.fn())
        .addNode('C', vi.fn())
        .addNode('D', vi.fn())
        .addEdge('A', 'B')
        .addEdge('B', 'C')
        .addEdge('C', 'B') // inner cycle B-C
        .addEdge('C', 'D')
        .addEdge('D', 'A') // outer cycle A-B-C-D
        .setEntryPoint('A');

      const graph = builder.build();
      const result = detector.detectCycles(graph);

      expect(result.hasCycle).toBe(true);
      expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('max iterations prevents infinite loop', () => {
    it('should stop at maxIterations even if cycle continues', async () => {
      let count = 0;
      builder
        .addNode('loop', async (s) => { count++; return s; })
        .addEdge('loop', 'loop')
        .setEntryPoint('loop')
        .setMaxIterations(5);

      const graph = builder.build();
      const result = await executor.execute(graph, {});

      expect(count).toBeLessThanOrEqual(5);
      expect(result.iterations).toBeLessThanOrEqual(5);
    });

    it('should report max iterations exceeded as non-error (intentional loop)', async () => {
      builder
        .addNode('repeat', async (s) => ({ ...s, n: (s.n || 0) + 1 }))
        .addNode('done', async (s) => s)
        .addConditionalEdge('repeat', (s) => s.n >= 3 ? 'done' : 'repeat')
        .setEntryPoint('repeat')
        .setExitPoint('done')
        .setMaxIterations(10);

      const graph = builder.build();
      const result = await executor.execute(graph, { n: 0 });

      expect(result.finalState.n).toBe(3);
      expect(result.error).toBeUndefined();
    });
  });

  describe('no false positives', () => {
    it('should not detect cycle in a DAG with reconverging paths', () => {
      // Diamond shape: A -> B, A -> C, B -> D, C -> D (no cycle!)
      builder
        .addNode('A', vi.fn())
        .addNode('B', vi.fn())
        .addNode('C', vi.fn())
        .addNode('D', vi.fn())
        .addEdge('A', 'B')
        .addEdge('A', 'C')
        .addEdge('B', 'D')
        .addEdge('C', 'D')
        .setEntryPoint('A')
        .setExitPoint('D');

      const graph = builder.build();
      const result = detector.detectCycles(graph);

      expect(result.hasCycle).toBe(false);
      expect(result.cycles).toHaveLength(0);
    });

    it('should not detect cycle in a linear graph', () => {
      builder
        .addNode('A', vi.fn())
        .addNode('B', vi.fn())
        .addNode('C', vi.fn())
        .addEdge('A', 'B')
        .addEdge('B', 'C')
        .setEntryPoint('A')
        .setExitPoint('C');

      const graph = builder.build();
      const result = detector.detectCycles(graph);

      expect(result.hasCycle).toBe(false);
    });

    it('should not detect cycle in a tree structure', () => {
      builder
        .addNode('root', vi.fn())
        .addNode('left', vi.fn())
        .addNode('right', vi.fn())
        .addNode('leftChild', vi.fn())
        .addNode('rightChild', vi.fn())
        .addEdge('root', 'left')
        .addEdge('root', 'right')
        .addEdge('left', 'leftChild')
        .addEdge('right', 'rightChild')
        .setEntryPoint('root');

      const graph = builder.build();
      const result = detector.detectCycles(graph);

      expect(result.hasCycle).toBe(false);
    });
  });
});
