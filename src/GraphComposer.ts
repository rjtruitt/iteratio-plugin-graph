/**
 * GraphComposer.ts
 * Compose and combine multiple graphs
 */

// Re-export simple composer for backwards compatibility
export {
  SimpleGraphDefinition,
  SimpleGraphComposer,
  SimpleComposeOptions,
  createGraphComposer,
} from './SimpleGraphComposer';

import {
  GraphDefinition,
  NodeConfig,
  Edge,
  EdgeType,
  NodeType,
  DirectEdge,
  ParallelEdge,
  detectCycles,
  detectUnreachableNodes,
} from './GraphDefinition';

export class CompositionError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
    this.name = 'CompositionError';
  }
}

export interface CompositionOptions {
  validateCycles?: boolean;
  validateUnreachable?: boolean;
  allowDuplicateNodes?: boolean;
  nodeNamePrefix?: string;
  mergeMetadata?: boolean;
  overwriteOnConflict?: boolean;
}

const defaultOptions: CompositionOptions = {
  validateCycles: true,
  validateUnreachable: false,
  allowDuplicateNodes: false,
  mergeMetadata: true,
  overwriteOnConflict: false,
};

/** Prefix all edge node references */
function prefixEdge(edge: Edge, prefixName: (n: string) => string): Edge {
  if (edge.type === EdgeType.DIRECT) {
    return { ...edge, from: prefixName(edge.from), to: prefixName(edge.to) };
  } else if (edge.type === EdgeType.CONDITIONAL) {
    return {
      ...edge,
      from: prefixName(edge.from),
      conditions: edge.conditions.map((c) => ({ ...c, to: prefixName(c.to) })),
      default: edge.default ? prefixName(edge.default) : undefined,
    };
  } else {
    return { ...edge, from: prefixName(edge.from), to: edge.to.map(prefixName) };
  }
}

/** Composes multiple subgraphs into a single executable graph with shared state. */
export class GraphComposer {
  static composeGraphs(graphs: GraphDefinition[], options?: CompositionOptions): GraphDefinition {
    const opts = { ...defaultOptions, ...options };

    if (graphs.length === 0) throw new CompositionError('No graphs provided for composition');
    if (graphs.length === 1) return graphs[0];

    const allNodes: NodeConfig[] = [];
    const nodeNames = new Set<string>();

    for (const graph of graphs) {
      for (const node of graph.nodes) {
        const nodeName = opts.nodeNamePrefix ? `${opts.nodeNamePrefix}_${node.name}` : node.name;

        if (nodeNames.has(nodeName)) {
          if (!opts.allowDuplicateNodes) {
            if (opts.overwriteOnConflict) {
              const idx = allNodes.findIndex((n) => n.name === nodeName);
              if (idx >= 0) allNodes.splice(idx, 1);
            } else {
              throw new CompositionError(`Duplicate node name '${nodeName}' found during composition`);
            }
          }
        }
        allNodes.push({ ...node, name: nodeName });
        nodeNames.add(nodeName);
      }
    }

    const allEdges: Edge[] = [];
    for (const graph of graphs) {
      const pfx = (name: string) => opts.nodeNamePrefix ? `${opts.nodeNamePrefix}_${name}` : name;
      for (const edge of graph.edges) allEdges.push(prefixEdge(edge, pfx));
    }

    const firstGraph = graphs[0];
    const pfx = (name: string) => opts.nodeNamePrefix ? `${opts.nodeNamePrefix}_${name}` : name;

    const composed: GraphDefinition = {
      version: '1.0.0',
      name: `composed_${graphs.map((g) => g.name).join('_')}`,
      description: `Composed from ${graphs.length} graphs`,
      nodes: allNodes,
      edges: allEdges,
      entryPoint: pfx(firstGraph.entryPoint),
      exitPoints: firstGraph.exitPoints.map(pfx),
      config: firstGraph.config,
      metadata: opts.mergeMetadata
        ? this.mergeMetadata(graphs.map((g) => g.metadata || {}))
        : firstGraph.metadata,
    };

    if (opts.validateCycles) {
      const { hasCycles, cycles } = detectCycles(composed);
      if (hasCycles) {
        throw new CompositionError(`Composed graph contains cycles: ${cycles.map((c) => c.join(' -> ')).join('; ')}`);
      }
    }
    if (opts.validateUnreachable) {
      const unreachable = detectUnreachableNodes(composed);
      if (unreachable.length > 0) {
        throw new CompositionError(`Composed graph contains unreachable nodes: ${unreachable.join(', ')}`);
      }
    }

    return composed;
  }

  static nestGraph(
    parentGraph: GraphDefinition,
    childGraph: GraphDefinition,
    options: { nodeName: string; description?: string; entryEdge?: { from: string }; exitEdges?: Array<{ to: string }> }
  ): GraphDefinition {
    const subgraphNode: NodeConfig = {
      name: options.nodeName,
      type: NodeType.SUBGRAPH,
      description: options.description || `Subgraph: ${childGraph.name}`,
      config: { subgraph: childGraph },
    };

    const nodes = [...parentGraph.nodes, subgraphNode];
    const edges = [...parentGraph.edges];

    if (options.entryEdge) {
      edges.push({ type: EdgeType.DIRECT, from: options.entryEdge.from, to: options.nodeName } as DirectEdge);
    }
    if (options.exitEdges) {
      for (const exitEdge of options.exitEdges) {
        edges.push({ type: EdgeType.DIRECT, from: options.nodeName, to: exitEdge.to } as DirectEdge);
      }
    }

    return { ...parentGraph, nodes, edges };
  }

  static mergeNodes(nodeArrays: NodeConfig[][], options?: CompositionOptions): NodeConfig[] {
    const opts = { ...defaultOptions, ...options };
    const merged: NodeConfig[] = [];
    const nodeNames = new Set<string>();

    for (const nodes of nodeArrays) {
      for (const node of nodes) {
        const nodeName = opts.nodeNamePrefix ? `${opts.nodeNamePrefix}_${node.name}` : node.name;

        if (nodeNames.has(nodeName)) {
          if (!opts.allowDuplicateNodes) {
            if (opts.overwriteOnConflict) {
              const idx = merged.findIndex((n) => n.name === nodeName);
              if (idx >= 0) merged.splice(idx, 1);
            } else {
              throw new CompositionError(`Duplicate node name '${nodeName}'`);
            }
          }
        }
        merged.push({ ...node, name: nodeName });
        nodeNames.add(nodeName);
      }
    }

    return merged;
  }

  static mergeEdges(edgeArrays: Edge[][], options?: CompositionOptions): Edge[] {
    const opts = { ...defaultOptions, ...options };
    const merged: Edge[] = [];
    const pfx = (name: string) => opts.nodeNamePrefix ? `${opts.nodeNamePrefix}_${name}` : name;

    for (const edges of edgeArrays) {
      for (const edge of edges) merged.push(prefixEdge(edge, pfx));
    }
    return merged;
  }

  static connectSequential(first: GraphDefinition, second: GraphDefinition, options?: CompositionOptions): GraphDefinition {
    const opts = { ...defaultOptions, ...options };
    const secondPrefix = `${second.name}_`;
    const pfx = (name: string) => `${secondPrefix}${name}`;

    const secondNodes = second.nodes.map((node) => ({ ...node, name: pfx(node.name) }));
    const secondEdges = second.edges.map((edge) => prefixEdge(edge, pfx));

    const connectionEdges: DirectEdge[] = first.exitPoints.map((exitPoint) => ({
      type: EdgeType.DIRECT,
      from: exitPoint,
      to: pfx(second.entryPoint),
    }));

    return {
      version: '1.0.0',
      name: `${first.name}_then_${second.name}`,
      description: `Sequential composition: ${first.name} -> ${second.name}`,
      nodes: [...first.nodes, ...secondNodes],
      edges: [...first.edges, ...secondEdges, ...connectionEdges],
      entryPoint: first.entryPoint,
      exitPoints: second.exitPoints.map(pfx),
      config: first.config,
      metadata: opts.mergeMetadata
        ? this.mergeMetadata([first.metadata || {}, second.metadata || {}])
        : first.metadata,
    };
  }

  static connectParallel(
    graphs: GraphDefinition[],
    options?: { entryNode?: string; exitNode?: string; aggregation?: 'merge' | 'array' | 'custom' }
  ): GraphDefinition {
    if (graphs.length === 0) throw new CompositionError('No graphs provided for parallel composition');

    const startNode: NodeConfig = { name: options?.entryNode || 'parallel_start', type: NodeType.START, description: 'Parallel execution start' };
    const endNode: NodeConfig = { name: options?.exitNode || 'parallel_end', type: NodeType.END, description: 'Parallel execution end' };

    const allNodes: NodeConfig[] = [startNode, endNode];
    const allEdges: Edge[] = [];
    const graphEntryPoints: string[] = [];
    const graphExitPoints: string[] = [];

    for (let i = 0; i < graphs.length; i++) {
      const graph = graphs[i];
      const pfx = (name: string) => `g${i}_${name}`;

      for (const node of graph.nodes) allNodes.push({ ...node, name: pfx(node.name) });
      for (const edge of graph.edges) allEdges.push(prefixEdge(edge, pfx));

      graphEntryPoints.push(pfx(graph.entryPoint));
      graphExitPoints.push(...graph.exitPoints.map(pfx));
    }

    const startEdge: ParallelEdge = {
      type: EdgeType.PARALLEL, from: startNode.name, to: graphEntryPoints,
      strategy: 'all', aggregation: { type: options?.aggregation || 'merge' },
    };
    allEdges.push(startEdge);

    for (const ep of graphExitPoints) {
      allEdges.push({ type: EdgeType.DIRECT, from: ep, to: endNode.name } as DirectEdge);
    }

    return {
      version: '1.0.0',
      name: `parallel_${graphs.map((g) => g.name).join('_')}`,
      description: `Parallel composition of ${graphs.length} graphs`,
      nodes: allNodes, edges: allEdges,
      entryPoint: startNode.name, exitPoints: [endNode.name],
      config: { maxIterations: 100, enableParallel: true },
    };
  }

  private static mergeMetadata(metadataArray: Record<string, unknown>[]): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const metadata of metadataArray) {
      for (const [key, value] of Object.entries(metadata)) {
        if (!(key in merged)) {
          merged[key] = value;
        } else if (Array.isArray(merged[key]) && Array.isArray(value)) {
          merged[key] = [...(merged[key] as unknown[]), ...value];
        } else if (typeof merged[key] === 'object' && typeof value === 'object') {
          merged[key] = { ...(merged[key] as object), ...(value as object) };
        } else {
          merged[key] = value;
        }
      }
    }
    return merged;
  }

  static validateComposition(graph: GraphDefinition): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const { hasCycles, cycles } = detectCycles(graph);
    if (hasCycles && cycles.length > 0) {
      errors.push(`Graph contains cycles: ${cycles.map((c) => c.join(' -> ')).join('; ')}`);
    }
    const unreachable = detectUnreachableNodes(graph);
    if (unreachable.length > 0) {
      errors.push(`Graph contains unreachable nodes: ${unreachable.join(', ')}`);
    }
    return { valid: errors.length === 0, errors };
  }
}
