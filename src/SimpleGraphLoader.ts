/**
 * SimpleGraphLoader.ts
 * Simple graph loader factory used by tests.
 */

// --- Simple GraphLoader (used by tests) ---

/** Loads graph definitions from serialized formats (JSON/YAML). */
export interface SimpleGraphLoader {
  loadFromJSON(json: string): any;
  loadFromYAML(yaml: string): any;
  validate(definition: any): { valid: boolean; errors: string[] };
}

const KNOWN_TYPES = ['passthrough', 'llm', 'tool', 'condition', 'transform', 'parallel', 'subgraph', 'start', 'end'];

export function createGraphLoader(): SimpleGraphLoader {
  return {
    loadFromJSON(json: string): any {
      let parsed: any;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        throw new Error(`Invalid JSON: ${(e as Error).message}`);
      }

      // Validate required fields
      if (!parsed.edges) {
        throw new Error('Missing required field: edges');
      }
      if (!parsed.entryPoint) {
        throw new Error('Missing required field: entryPoint');
      }

      return parsed;
    },

    loadFromYAML(yaml: string): any {
      // Simple YAML parser for basic structures
      try {
        const result: any = { nodes: [], edges: [] };
        const lines = yaml.split('\n');
        let currentSection: string | null = null;
        let currentItem: any = null;

        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (!trimmed || trimmed.startsWith('#')) continue;

          // Detect unclosed brackets
          if (trimmed.includes('[') && !trimmed.includes(']')) {
            throw new Error('Invalid YAML: unclosed bracket');
          }

          // Top-level keys
          const topLevelMatch = trimmed.match(/^(\w+):\s*(.*)$/);
          if (topLevelMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
            currentSection = topLevelMatch[1];
            if (topLevelMatch[2]) {
              result[currentSection] = topLevelMatch[2];
            }
            currentItem = null;
            continue;
          }

          // Array items
          const arrayItemMatch = trimmed.match(/^\s+-\s+(.*)$/);
          if (arrayItemMatch && currentSection) {
            if (!Array.isArray(result[currentSection])) {
              result[currentSection] = [];
            }
            // Check if it's a key-value pair
            const kvMatch = arrayItemMatch[1].match(/^(\w+):\s*(.*)$/);
            if (kvMatch) {
              currentItem = { [kvMatch[1]]: kvMatch[2] };
              result[currentSection].push(currentItem);
            } else {
              currentItem = { value: arrayItemMatch[1] };
              result[currentSection].push(currentItem);
            }
            continue;
          }

          // Nested properties
          const nestedMatch = trimmed.match(/^\s+(\w+):\s*(.*)$/);
          if (nestedMatch && currentItem) {
            currentItem[nestedMatch[1]] = nestedMatch[2];
            continue;
          }
        }

        return result;
      } catch (e: any) {
        throw new Error(`YAML parse error: ${e.message}`);
      }
    },

    validate(definition: any): { valid: boolean; errors: string[] } {
      const errors: string[] = [];

      // Check nodes array
      if (definition.nodes) {
        for (const node of definition.nodes) {
          if (typeof node.name !== 'string') {
            errors.push('Node name must be a string');
          }
          if (node.type && !KNOWN_TYPES.includes(node.type)) {
            errors.push(`Unknown node type: '${node.type}'`);
          }
        }
      }

      // Check required fields
      if (!definition.entryPoint) {
        errors.push('Missing required field: entryPoint');
      }
      if (!definition.exitPoint) {
        errors.push('Missing required field: exitPoint');
      }

      return {
        valid: errors.length === 0,
        errors,
      };
    },
  };
}
