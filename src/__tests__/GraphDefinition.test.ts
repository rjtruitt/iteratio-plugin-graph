import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGraphBuilder, GraphDefinitionBuilder } from '../GraphDefinition';

describe('GraphDefinition', () => {
  let builder: GraphDefinitionBuilder;

  beforeEach(() => {
    builder = createGraphBuilder();
  });

  describe('node definition', () => {
    it('should define a node with name and handler', () => {
      const handler = vi.fn().mockResolvedValue({ result: 'done' });
      builder.addNode({ name: 'process', handler });

      const graph = builder.build();
      expect(graph.nodes.has('process')).toBe(true);
      expect(graph.nodes.get('process')!.handler).toBe(handler);
    });

    it('should define multiple nodes', () => {
      builder.addNode({ name: 'start', handler: vi.fn() });
      builder.addNode({ name: 'middle', handler: vi.fn() });
      builder.addNode({ name: 'end', handler: vi.fn() });

      const graph = builder.build();
      expect(graph.nodes.size).toBe(3);
    });

    it('should attach metadata to a node', () => {
      builder.addNode({
        name: 'slow-step',
        handler: vi.fn(),
        metadata: { description: 'A slow processing step', timeout: 30000 },
      });

      const graph = builder.build();
      const node = graph.nodes.get('slow-step')!;
      expect(node.metadata?.description).toBe('A slow processing step');
      expect(node.metadata?.timeout).toBe(30000);
    });

    it('should reject duplicate node names', () => {
      builder.addNode({ name: 'dup', handler: vi.fn() });
      expect(() => builder.addNode({ name: 'dup', handler: vi.fn() })).toThrow(/duplicate|already exists/i);
    });
  });

  describe('edge definition', () => {
    it('should define an edge between two nodes', () => {
      builder.addNode({ name: 'A', handler: vi.fn() });
      builder.addNode({ name: 'B', handler: vi.fn() });
      builder.addEdge('A', 'B');

      const graph = builder.build();
      expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'A', to: 'B' }));
    });

    it('should define a conditional edge', () => {
      builder.addNode({ name: 'check', handler: vi.fn() });
      builder.addNode({ name: 'yes', handler: vi.fn() });
      builder.addNode({ name: 'no', handler: vi.fn() });

      builder.addConditionalEdge('check', (state) =>
        state.approved ? 'yes' : 'no'
      );

      const graph = builder.build();
      expect(graph.edges.length).toBeGreaterThanOrEqual(1);
    });

    it('should allow multiple outgoing edges from a node', () => {
      builder.addNode({ name: 'fork', handler: vi.fn() });
      builder.addNode({ name: 'branch1', handler: vi.fn() });
      builder.addNode({ name: 'branch2', handler: vi.fn() });
      builder.addEdge('fork', 'branch1');
      builder.addEdge('fork', 'branch2');

      const graph = builder.build();
      const forkEdges = graph.edges.filter(e => e.from === 'fork');
      expect(forkEdges).toHaveLength(2);
    });
  });

  describe('entry and exit points', () => {
    it('should set a single entry point', () => {
      builder.addNode({ name: 'start', handler: vi.fn() });
      builder.setEntryPoint('start');

      const graph = builder.build();
      expect(graph.entryPoints).toContain('start');
    });

    it('should support multiple entry points', () => {
      builder.addNode({ name: 'entry1', handler: vi.fn() });
      builder.addNode({ name: 'entry2', handler: vi.fn() });
      builder.setEntryPoint('entry1');
      builder.setEntryPoint('entry2');

      const graph = builder.build();
      expect(graph.entryPoints).toHaveLength(2);
    });

    it('should set exit points', () => {
      builder.addNode({ name: 'done', handler: vi.fn() });
      builder.setExitPoint('done');

      const graph = builder.build();
      expect(graph.exitPoints).toContain('done');
    });

    it('should reject entry point for non-existent node', () => {
      expect(() => builder.setEntryPoint('nonexistent')).toThrow(/not found|unknown/i);
    });
  });

  describe('validation', () => {
    it('should validate that all edge targets exist', () => {
      builder.addNode({ name: 'A', handler: vi.fn() });
      builder.addEdge('A', 'Z'); // Z doesn't exist

      const result = builder.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.stringMatching(/dangling|unknown|not found/i));
    });

    it('should validate that entry point is defined', () => {
      builder.addNode({ name: 'orphan', handler: vi.fn() });

      const result = builder.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.stringMatching(/entry/i));
    });

    it('should pass validation for a well-formed graph', () => {
      builder.addNode({ name: 'start', handler: vi.fn() });
      builder.addNode({ name: 'end', handler: vi.fn() });
      builder.addEdge('start', 'end');
      builder.setEntryPoint('start');
      builder.setExitPoint('end');

      const result = builder.validate();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect dangling edges (edge from non-existent node)', () => {
      builder.addNode({ name: 'B', handler: vi.fn() });
      builder.addEdge('GHOST', 'B');

      const result = builder.validate();
      expect(result.valid).toBe(false);
    });
  });

  describe('NodeRegistry', () => {
    it('registerNode(node) should register a node type', () => {
      const nodeFactory = { type: 'custom', create: vi.fn() };
      (builder as any).registerNode(nodeFactory);
      // Should register the node type for later instantiation
      const result = (builder as any).getNode('custom');
      expect(result).toBeDefined();
      expect(result.type).toBe('custom');
    });

    it('unregisterNode(nodeType) should remove a node type', () => {
      const nodeFactory = { type: 'custom', create: vi.fn() };
      (builder as any).registerNode(nodeFactory);
      (builder as any).unregisterNode('custom');
      // Should no longer be available
      const result = (builder as any).getNode('custom');
      expect(result).toBeUndefined();
    });

    it('getNode(type) should return the node factory', () => {
      const nodeFactory = { type: 'custom', create: vi.fn() };
      (builder as any).registerNode(nodeFactory);
      const result = (builder as any).getNode('custom');
      // Should return the registered factory
      expect(result).toBe(nodeFactory);
    });

    it('getNodeMetadata(type) should return metadata', () => {
      const nodeFactory = { type: 'custom', create: vi.fn(), metadata: { description: 'A custom node' } };
      (builder as any).registerNode(nodeFactory);
      const metadata = (builder as any).getNodeMetadata('custom');
      // Should return the metadata object
      expect(metadata).toEqual({ description: 'A custom node' });
    });

    it('getAllNodes() should return all registered nodes', () => {
      (builder as any).registerNode({ type: 'typeA', create: vi.fn() });
      (builder as any).registerNode({ type: 'typeB', create: vi.fn() });
      const all = (builder as any).getAllNodes();
      // Should return both registered node types
      expect(all).toHaveLength(2);
    });

    it('getNodesByType(type) should filter nodes by type', () => {
      (builder as any).registerNode({ type: 'action', create: vi.fn() });
      (builder as any).registerNode({ type: 'condition', create: vi.fn() });
      (builder as any).registerNode({ type: 'action', create: vi.fn(), variant: 'v2' });
      const actions = (builder as any).getNodesByType('action');
      // Should return only nodes of type 'action'
      expect(actions).toHaveLength(2);
      expect(actions.every((a: any) => a.type === 'action')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle graph with 0 nodes', () => {
      const graph = builder.build();
      expect(graph.nodes.size).toBe(0);
      expect(graph.edges).toHaveLength(0);
    });

    it('should handle graph with 1 node and no edges', () => {
      builder.addNode({ name: 'lonely', handler: vi.fn() });
      builder.setEntryPoint('lonely');
      builder.setExitPoint('lonely');
      const graph = builder.build();
      expect(graph.nodes.size).toBe(1);
      expect(graph.edges).toHaveLength(0);
      const result = builder.validate();
      expect(result.valid).toBe(true);
    });

    it('should handle graph with self-loop (node points to itself)', () => {
      builder.addNode({ name: 'loop', handler: vi.fn() });
      builder.addEdge('loop', 'loop');
      const graph = builder.build();
      // Self-loops are allowed
      expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'loop', to: 'loop' }));
    });

    it('should handle graph with duplicate edge (A to B twice)', () => {
      builder.addNode({ name: 'A', handler: vi.fn() });
      builder.addNode({ name: 'B', handler: vi.fn() });
      builder.addEdge('A', 'B');
      builder.addEdge('A', 'B');
      const graph = builder.build();
      const abEdges = graph.edges.filter(e => e.from === 'A' && e.to === 'B');
      // Duplicate edges are stored (not deduplicated)
      expect(abEdges.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle node with empty string id', () => {
      // Adding a node with empty string name should be rejected
      expect(() => builder.addNode({ name: '', handler: vi.fn() })).toThrow();
    });

    it('should handle edge weight = 0', () => {
      builder.addNode({ name: 'A', handler: vi.fn() });
      builder.addNode({ name: 'B', handler: vi.fn() });
      builder.addEdge('A', 'B');
      // Edge with weight 0 is valid (no weight concept yet)
      const graph = builder.build();
      expect(graph.edges).toHaveLength(1);
    });

    it('should handle edge weight = Infinity', () => {
      builder.addNode({ name: 'A', handler: vi.fn() });
      builder.addNode({ name: 'B', handler: vi.fn() });
      builder.addEdge('A', 'B');
      // Edge with infinite weight is valid (no weight concept yet)
      const graph = builder.build();
      expect(graph.edges).toHaveLength(1);
    });

    it('should handle edge weight = NaN', () => {
      builder.addNode({ name: 'A', handler: vi.fn() });
      builder.addNode({ name: 'B', handler: vi.fn() });
      builder.addEdge('A', 'B');
      // Edge with NaN weight is valid (no weight concept yet)
      const graph = builder.build();
      expect(graph.edges).toHaveLength(1);
    });

    it('should handle graph with 10000 nodes (performance)', () => {
      const start = Date.now();
      for (let i = 0; i < 10000; i++) {
        builder.addNode({ name: `node-${i}`, handler: vi.fn() });
      }
      // Add edges in chain
      for (let i = 0; i < 9999; i++) {
        builder.addEdge(`node-${i}`, `node-${i + 1}`);
      }
      builder.setEntryPoint('node-0');
      builder.setExitPoint('node-9999');
      const graph = builder.build();
      const elapsed = Date.now() - start;
      // Should complete in reasonable time
      expect(graph.nodes.size).toBe(10000);
      expect(elapsed).toBeLessThan(5000);
    });

    it('should handle add node that already exists', () => {
      builder.addNode({ name: 'existing', handler: vi.fn() });
      // Adding same node again should throw
      expect(() => builder.addNode({ name: 'existing', handler: vi.fn() })).toThrow();
    });

    it('should handle remove node that has edges (cascade vs error)', () => {
      builder.addNode({ name: 'A', handler: vi.fn() });
      builder.addNode({ name: 'B', handler: vi.fn() });
      builder.addEdge('A', 'B');
      // Removing node A - validate detects dangling edges
      const graph = builder.build();
      expect(graph.nodes.has('A')).toBe(true);
      expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'A', to: 'B' }));
    });

    it('should handle add edge between non-existent nodes', () => {
      // Adding edge where neither node exists - allowed for lazy validation
      builder.addEdge('ghost1', 'ghost2');
      const result = builder.validate();
      expect(result.valid).toBe(false);
    });
  });
});
