import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGraphLoader, SimpleGraphLoader as GraphLoader } from '../GraphLoader';

describe('GraphLoader', () => {
  let loader: GraphLoader;

  beforeEach(() => {
    loader = createGraphLoader();
  });

  describe('load from JSON', () => {
    it('should load a valid graph from JSON string', () => {
      const json = JSON.stringify({
        nodes: [
          { name: 'start', type: 'passthrough' },
          { name: 'end', type: 'passthrough' },
        ],
        edges: [{ from: 'start', to: 'end' }],
        entryPoint: 'start',
        exitPoint: 'end',
      });

      const graph = loader.loadFromJSON(json);

      expect(graph).toBeDefined();
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
    });

    it('should throw on invalid JSON syntax', () => {
      expect(() => loader.loadFromJSON('{ invalid json }')).toThrow();
    });

    it('should throw on missing required fields', () => {
      const json = JSON.stringify({ nodes: [] }); // missing edges, entryPoint

      expect(() => loader.loadFromJSON(json)).toThrow(/required|missing/i);
    });
  });

  describe('load from YAML', () => {
    it('should load a valid graph from YAML string', () => {
      const yaml = `
nodes:
  - name: start
    type: passthrough
  - name: end
    type: passthrough
edges:
  - from: start
    to: end
entryPoint: start
exitPoint: end
`;

      const graph = loader.loadFromYAML(yaml);

      expect(graph).toBeDefined();
      expect(graph.nodes).toHaveLength(2);
    });

    it('should throw on invalid YAML syntax', () => {
      const badYaml = `
nodes:
  - name: start
  invalid: [unclosed
`;
      expect(() => loader.loadFromYAML(badYaml)).toThrow();
    });
  });

  describe('validation', () => {
    it('should report validation errors on invalid schema', () => {
      const definition = {
        nodes: [{ name: 123 }], // name should be string
        edges: [],
      };

      const result = loader.validate(definition);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should report error for unknown node type', () => {
      const definition = {
        nodes: [{ name: 'x', type: 'UNKNOWN_TYPE_XYZ' }],
        edges: [],
        entryPoint: 'x',
        exitPoint: 'x',
      };

      const result = loader.validate(definition);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.stringMatching(/unknown.*type/i));
    });

    it('should pass validation for a correct definition', () => {
      const definition = {
        nodes: [
          { name: 'start', type: 'passthrough' },
          { name: 'end', type: 'passthrough' },
        ],
        edges: [{ from: 'start', to: 'end' }],
        entryPoint: 'start',
        exitPoint: 'end',
      };

      const result = loader.validate(definition);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
