import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGraphComposer,
  SimpleGraphDefinition as GraphDefinition,
  SimpleGraphComposer as GraphComposer,
} from '../GraphComposer';

function createSimpleGraph(prefix: string): GraphDefinition {
  const handler = vi.fn().mockResolvedValue({});
  return {
    nodes: new Map([
      [`${prefix}_start`, { name: `${prefix}_start`, handler }],
      [`${prefix}_end`, { name: `${prefix}_end`, handler }],
    ]),
    edges: [{ from: `${prefix}_start`, to: `${prefix}_end` }],
    entryPoints: [`${prefix}_start`],
    exitPoints: [`${prefix}_end`],
  };
}

describe('GraphComposer', () => {
  let composer: GraphComposer;

  beforeEach(() => {
    composer = createGraphComposer();
  });

  describe('compose two graphs', () => {
    it('should compose two graphs sequentially (A exits to B entry)', () => {
      const graphA = createSimpleGraph('A');
      const graphB = createSimpleGraph('B');

      const composed = composer.compose(graphA, graphB, { sequential: true });

      expect(composed.nodes.size).toBe(4);
      // Should have edge from A_end to B_start
      expect(composed.edges).toContainEqual(
        expect.objectContaining({ from: 'A_end', to: 'B_start' })
      );
    });

    it('should preserve all nodes from both graphs', () => {
      const graphA = createSimpleGraph('A');
      const graphB = createSimpleGraph('B');

      const composed = composer.compose(graphA, graphB);

      expect(composed.nodes.has('A_start')).toBe(true);
      expect(composed.nodes.has('A_end')).toBe(true);
      expect(composed.nodes.has('B_start')).toBe(true);
      expect(composed.nodes.has('B_end')).toBe(true);
    });

    it('should preserve all edges from both graphs', () => {
      const graphA = createSimpleGraph('A');
      const graphB = createSimpleGraph('B');

      const composed = composer.compose(graphA, graphB);

      expect(composed.edges).toContainEqual({ from: 'A_start', to: 'A_end' });
      expect(composed.edges).toContainEqual({ from: 'B_start', to: 'B_end' });
    });
  });

  describe('subgraph embedding', () => {
    it('should embed a subgraph at a specific node position', () => {
      const parent = createSimpleGraph('P');
      const sub = createSimpleGraph('S');

      // Replace P_end with the entire subgraph
      const result = composer.embed(parent, sub, 'P_end');

      expect(result.nodes.has('S_start')).toBe(true);
      expect(result.nodes.has('S_end')).toBe(true);
      // The replaced node should be removed or rewired
      expect(result.edges).toContainEqual(
        expect.objectContaining({ from: 'P_start', to: 'S_start' })
      );
    });

    it('should maintain parent graph integrity after embedding', () => {
      const parent = createSimpleGraph('P');
      const sub = createSimpleGraph('S');

      const result = composer.embed(parent, sub, 'P_end');

      expect(result.entryPoints).toContain('P_start');
      expect(result.exitPoints).toContain('S_end');
    });
  });

  describe('graph merging', () => {
    it('should merge independent graphs into one', () => {
      const g1 = createSimpleGraph('G1');
      const g2 = createSimpleGraph('G2');
      const g3 = createSimpleGraph('G3');

      const merged = composer.merge([g1, g2, g3]);

      expect(merged.nodes.size).toBe(6);
      expect(merged.entryPoints).toHaveLength(3);
    });
  });

  describe('shared nodes', () => {
    it('should handle shared nodes between composed graphs', () => {
      const graphA: GraphDefinition = {
        nodes: new Map([
          ['shared', { name: 'shared', handler: vi.fn() }],
          ['A_end', { name: 'A_end', handler: vi.fn() }],
        ]),
        edges: [{ from: 'shared', to: 'A_end' }],
        entryPoints: ['shared'],
        exitPoints: ['A_end'],
      };
      const graphB: GraphDefinition = {
        nodes: new Map([
          ['shared', { name: 'shared', handler: vi.fn() }],
          ['B_end', { name: 'B_end', handler: vi.fn() }],
        ]),
        edges: [{ from: 'shared', to: 'B_end' }],
        entryPoints: ['shared'],
        exitPoints: ['B_end'],
      };

      const composed = composer.compose(graphA, graphB, { conflictResolution: 'prefix' });

      // Should not lose either handler
      expect(composed.nodes.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe('name collision resolution', () => {
    it('should throw on collision when conflictResolution is "error"', () => {
      const g1 = createSimpleGraph('same');
      const g2 = createSimpleGraph('same');

      expect(() =>
        composer.compose(g1, g2, { conflictResolution: 'error' })
      ).toThrow(/collision|conflict|duplicate/i);
    });

    it('should auto-prefix on collision when conflictResolution is "prefix"', () => {
      const g1 = createSimpleGraph('same');
      const g2 = createSimpleGraph('same');

      const composed = composer.compose(g1, g2, { conflictResolution: 'prefix' });

      // All 4 nodes should exist, potentially renamed
      expect(composed.nodes.size).toBe(4);
    });
  });
});
