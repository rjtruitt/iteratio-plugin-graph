import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGraphVisualizer,
  SimpleGraphVisualizer as GraphVisualizer,
} from '../GraphVisualizer';

function createTestGraph() {
  return {
    nodes: [
      { name: 'start', type: 'passthrough' },
      { name: 'check', type: 'condition' },
      { name: 'approved', type: 'passthrough' },
      { name: 'rejected', type: 'passthrough' },
    ],
    edges: [
      { from: 'start', to: 'check' },
      { from: 'check', to: 'approved', label: 'valid' },
      { from: 'check', to: 'rejected', label: 'invalid' },
    ],
    entryPoint: 'start',
  };
}

describe('GraphVisualizer', () => {
  let visualizer: GraphVisualizer;
  let graph: any;

  beforeEach(() => {
    visualizer = createGraphVisualizer();
    graph = createTestGraph();
  });

  describe('Mermaid diagram', () => {
    it('should generate valid Mermaid flowchart syntax', () => {
      const mermaid = visualizer.toMermaid(graph);

      expect(mermaid).toContain('graph');
      expect(mermaid).toContain('start');
      expect(mermaid).toContain('check');
      expect(mermaid).toContain('approved');
      expect(mermaid).toContain('rejected');
    });

    it('should include edges in Mermaid output', () => {
      const mermaid = visualizer.toMermaid(graph);

      expect(mermaid).toContain('-->');
    });

    it('should include conditional edge labels', () => {
      const mermaid = visualizer.toMermaid(graph);

      expect(mermaid).toContain('valid');
      expect(mermaid).toContain('invalid');
    });
  });

  describe('Graphviz DOT format', () => {
    it('should generate valid DOT syntax', () => {
      const dot = visualizer.toDOT(graph);

      expect(dot).toContain('digraph');
      expect(dot).toContain('start');
      expect(dot).toContain('->');
    });

    it('should include node declarations', () => {
      const dot = visualizer.toDOT(graph);

      expect(dot).toContain('"start"');
      expect(dot).toContain('"check"');
      expect(dot).toContain('"approved"');
      expect(dot).toContain('"rejected"');
    });

    it('should include edge labels in DOT output', () => {
      const dot = visualizer.toDOT(graph);

      expect(dot).toContain('label');
      expect(dot).toContain('valid');
    });
  });

  describe('Untested Static Methods', () => {
    it('GraphVisualizer.toMermaid(graph) should generate Mermaid syntax', () => {
      // Static method variant that can be called without instance
      const mermaid = (visualizer as any).constructor.toMermaid(graph);
      // Should produce valid Mermaid diagram syntax
      expect(mermaid).toContain('graph');
      expect(mermaid).toContain('start');
    });

    it('GraphVisualizer.toDot(graph) should generate Graphviz DOT', () => {
      const dot = (visualizer as any).constructor.toDot(graph);
      // Should produce valid Graphviz DOT syntax
      expect(dot).toContain('digraph');
      expect(dot).toContain('->');
    });

    it('GraphVisualizer.toAscii(graph) should generate ASCII representation', () => {
      const ascii = (visualizer as any).constructor.toAscii(graph);
      // Should produce a human-readable ASCII diagram
      expect(ascii).toContain('start');
      expect(ascii).toContain('check');
    });
  });

  describe('execution trace visualization', () => {
    it('should highlight the path taken during execution', () => {
      const trace = visualizer.toExecutionTrace(graph, ['start', 'check', 'approved']);

      // The trace should somehow indicate which nodes were visited
      expect(trace).toContain('start');
      expect(trace).toContain('check');
      expect(trace).toContain('approved');
      // Should indicate the path was taken (e.g., different styling)
      expect(trace).toMatch(/visited|active|highlight|style/i);
    });

    it('should not highlight nodes not in the execution path', () => {
      const trace = visualizer.toExecutionTrace(graph, ['start', 'check', 'approved']);

      // 'rejected' was not visited, should not be highlighted
      expect(trace).not.toMatch(/rejected.*visited|rejected.*active/i);
    });
  });
});
