/**
 * GraphDefinition.ts
 * JSON/YAML schema definitions for graphs with Zod validation
 *
 * Provides:
 * - Graph schema definition (nodes, edges, conditional edges)
 * - Zod validation schemas
 * - Type-safe graph configuration
 * - JSON/YAML serialization support
 */

// Re-export simple builder for backwards compatibility
export {
  SimpleGraphNode,
  SimpleGraphEdge,
  GraphDefinitionBuilder,
  SimpleGraphDefinitionResult,
  createGraphBuilder,
} from './SimpleGraphBuilder';

import { z } from 'zod';

/**
 * Node type enumeration
 */
export enum NodeType {
  LLM = 'llm',
  TOOL = 'tool',
  CONDITION = 'condition',
  TRANSFORM = 'transform',
  PARALLEL = 'parallel',
  SUBGRAPH = 'subgraph',
  CUSTOM = 'custom',
  START = 'start',
  END = 'end',
}

/**
 * Edge type enumeration
 */
export enum EdgeType {
  DIRECT = 'direct',
  CONDITIONAL = 'conditional',
  PARALLEL = 'parallel',
}

/**
 * Zod schema for node configuration
 */
export const NodeConfigSchema = z.object({
  name: z.string().min(1),
  type: z.nativeEnum(NodeType),
  description: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  timeout: z.number().positive().optional(),
  retries: z.number().min(0).optional(),
  fallback: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type NodeConfig = z.infer<typeof NodeConfigSchema>;

/**
 * Zod schema for direct edge
 */
export const DirectEdgeSchema = z.object({
  type: z.literal(EdgeType.DIRECT),
  from: z.string(),
  to: z.string(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type DirectEdge = z.infer<typeof DirectEdgeSchema>;

/**
 * Zod schema for conditional edge
 */
export const ConditionalEdgeSchema = z.object({
  type: z.literal(EdgeType.CONDITIONAL),
  from: z.string(),
  conditions: z.array(
    z.object({
      condition: z.string(),
      operator: z.enum(['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan', 'exists', 'custom']),
      value: z.unknown().optional(),
      to: z.string(),
    })
  ),
  default: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ConditionalEdge = z.infer<typeof ConditionalEdgeSchema>;

/**
 * Zod schema for parallel edge (fan-out to multiple nodes)
 */
export const ParallelEdgeSchema = z.object({
  type: z.literal(EdgeType.PARALLEL),
  from: z.string(),
  to: z.array(z.string()),
  strategy: z.enum(['all', 'race', 'any']).default('all'),
  aggregation: z
    .object({
      type: z.enum(['merge', 'array', 'custom']),
      key: z.string().optional(),
    })
    .optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ParallelEdge = z.infer<typeof ParallelEdgeSchema>;

/**
 * Union schema for all edge types
 */
export const EdgeSchema = z.discriminatedUnion('type', [
  DirectEdgeSchema,
  ConditionalEdgeSchema,
  ParallelEdgeSchema,
]);

export type Edge = z.infer<typeof EdgeSchema>;

/**
 * Zod schema for graph variables/parameters
 */
export const GraphVariableSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'object', 'array', 'any']),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  description: z.string().optional(),
  validation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
      enum: z.array(z.unknown()).optional(),
    })
    .optional(),
});

export type GraphVariable = z.infer<typeof GraphVariableSchema>;

/**
 * Zod schema for complete graph definition
 */
export const GraphDefinitionSchema = z.object({
  version: z.string().default('1.0.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  nodes: z.array(NodeConfigSchema),
  edges: z.array(EdgeSchema),
  entryPoint: z.string(),
  exitPoints: z.array(z.string()),
  variables: z.array(GraphVariableSchema).optional(),
  config: z
    .object({
      maxIterations: z.number().positive().optional(),
      timeout: z.number().positive().optional(),
      enableParallel: z.boolean().optional(),
      enableCheckpoints: z.boolean().optional(),
      checkpointInterval: z.number().positive().optional(),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type GraphDefinition = z.infer<typeof GraphDefinitionSchema>;

/**
 * Validate graph definition
 */
export function validateGraphDefinition(definition: unknown): {
  valid: boolean;
  data?: GraphDefinition;
  errors?: z.ZodError;
} {
  const result = GraphDefinitionSchema.safeParse(definition);

  if (!result.success) {
    return { valid: false, errors: result.error };
  }

  const graph = result.data;
  const nodeNames = new Set(graph.nodes.map((n) => n.name));

  // Check entry point exists
  if (!nodeNames.has(graph.entryPoint)) {
    return {
      valid: false,
      errors: new z.ZodError([
        { code: 'custom', message: `Entry point '${graph.entryPoint}' does not exist`, path: ['entryPoint'] },
      ]),
    };
  }

  // Check exit points exist
  for (const exitPoint of graph.exitPoints) {
    if (!nodeNames.has(exitPoint)) {
      return {
        valid: false,
        errors: new z.ZodError([
          { code: 'custom', message: `Exit point '${exitPoint}' does not exist`, path: ['exitPoints'] },
        ]),
      };
    }
  }

  // Check edge references exist
  for (const edge of graph.edges) {
    if (!nodeNames.has(edge.from)) {
      return {
        valid: false,
        errors: new z.ZodError([
          { code: 'custom', message: `Edge source '${edge.from}' does not exist`, path: ['edges'] },
        ]),
      };
    }

    if (edge.type === EdgeType.DIRECT || edge.type === EdgeType.CONDITIONAL) {
      const targets =
        edge.type === EdgeType.DIRECT
          ? [edge.to]
          : [...edge.conditions.map((c) => c.to), ...(edge.default ? [edge.default] : [])];

      for (const target of targets) {
        if (!nodeNames.has(target)) {
          return {
            valid: false,
            errors: new z.ZodError([
              { code: 'custom', message: `Edge target '${target}' does not exist`, path: ['edges'] },
            ]),
          };
        }
      }
    } else if (edge.type === EdgeType.PARALLEL) {
      for (const target of edge.to) {
        if (!nodeNames.has(target)) {
          return {
            valid: false,
            errors: new z.ZodError([
              { code: 'custom', message: `Parallel edge target '${target}' does not exist`, path: ['edges'] },
            ]),
          };
        }
      }
    }
  }

  return { valid: true, data: graph };
}

/**
 * Detect cycles in graph
 */
export function detectCycles(definition: GraphDefinition): {
  hasCycles: boolean;
  cycles: string[][];
} {
  const adjacencyList = new Map<string, string[]>();

  for (const edge of definition.edges) {
    if (edge.type === EdgeType.DIRECT) {
      if (!adjacencyList.has(edge.from)) adjacencyList.set(edge.from, []);
      adjacencyList.get(edge.from)!.push(edge.to);
    } else if (edge.type === EdgeType.CONDITIONAL) {
      if (!adjacencyList.has(edge.from)) adjacencyList.set(edge.from, []);
      for (const condition of edge.conditions) {
        adjacencyList.get(edge.from)!.push(condition.to);
      }
      if (edge.default) {
        adjacencyList.get(edge.from)!.push(edge.default);
      }
    } else if (edge.type === EdgeType.PARALLEL) {
      if (!adjacencyList.has(edge.from)) adjacencyList.set(edge.from, []);
      adjacencyList.get(edge.from)!.push(...edge.to);
    }
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const pathStack: string[] = [];

  function dfs(node: string): void {
    visited.add(node);
    recursionStack.add(node);
    pathStack.push(node);

    const neighbors = adjacencyList.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recursionStack.has(neighbor)) {
        const cycleStart = pathStack.indexOf(neighbor);
        const cycle = pathStack.slice(cycleStart);
        cycles.push([...cycle, neighbor]);
      }
    }

    pathStack.pop();
    recursionStack.delete(node);
  }

  dfs(definition.entryPoint);

  return { hasCycles: cycles.length > 0, cycles };
}

/**
 * Detect unreachable nodes
 */
export function detectUnreachableNodes(definition: GraphDefinition): string[] {
  const reachable = new Set<string>();
  const queue = [definition.entryPoint];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;

    reachable.add(current);

    for (const edge of definition.edges) {
      if (edge.from === current) {
        if (edge.type === EdgeType.DIRECT) {
          queue.push(edge.to);
        } else if (edge.type === EdgeType.CONDITIONAL) {
          for (const condition of edge.conditions) {
            queue.push(condition.to);
          }
          if (edge.default) {
            queue.push(edge.default);
          }
        } else if (edge.type === EdgeType.PARALLEL) {
          queue.push(...edge.to);
        }
      }
    }
  }

  const allNodes = new Set(definition.nodes.map((n) => n.name));
  const unreachable: string[] = [];

  for (const node of allNodes) {
    if (!reachable.has(node)) {
      unreachable.push(node);
    }
  }

  return unreachable;
}

/**
 * Example graph definition in JSON format
 */
export const exampleGraphDefinition: GraphDefinition = {
  version: '1.0.0',
  name: 'agent-tool-loop',
  description: 'Simple agent with tool calling loop',
  nodes: [
    { name: 'start', type: NodeType.START, description: 'Entry point' },
    { name: 'llm', type: NodeType.LLM, description: 'LLM reasoning', config: { model: 'claude-3-sonnet', temperature: 0.7 } },
    { name: 'tools', type: NodeType.TOOL, description: 'Tool execution', config: { tools: ['search', 'calculator'] } },
    { name: 'end', type: NodeType.END, description: 'Exit point' },
  ],
  edges: [
    { type: EdgeType.DIRECT, from: 'start', to: 'llm' },
    { type: EdgeType.CONDITIONAL, from: 'llm', conditions: [{ condition: 'needsTools', operator: 'equals', value: true, to: 'tools' }], default: 'end' },
    { type: EdgeType.DIRECT, from: 'tools', to: 'llm' },
  ],
  entryPoint: 'start',
  exitPoints: ['end'],
  config: { maxIterations: 10, enableParallel: false },
};
