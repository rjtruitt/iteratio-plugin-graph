/**
 * GraphCycleDetection.ts
 * Cycle detection and graph builder/executor for simple graph structures
 *
 * Provides:
 * - GraphBuilder: fluent API to build graph definitions
 * - CycleDetector: DFS-based cycle detection
 * - GraphExecutor: execute a built graph against state
 */

/** Detects cycles in a graph structure and provides cycle analysis. */
export interface CycleDetector {
  detectCycles(graph: any): CycleResult;
}

export interface CycleResult {
  hasCycle: boolean;
  cycles: string[][]; // each cycle is a path of node names
}

export interface GraphBuilder {
  addNode(name: string, handler: (state: any) => Promise<any>): GraphBuilder;
  addEdge(from: string, to: string): GraphBuilder;
  addConditionalEdge(from: string, router: (state: any) => string): GraphBuilder;
  setEntryPoint(name: string): GraphBuilder;
  setExitPoint(name: string): GraphBuilder;
  setMaxIterations(n: number): GraphBuilder;
  build(): any;
}

export interface GraphExecutor {
  execute(graph: any, initialState: any): Promise<{ finalState: any; iterations: number; error?: Error }>;
}

export function createGraphBuilder(): GraphBuilder {
  const nodes = new Map<string, { name: string; handler: (state: any) => Promise<any> }>();
  const edges: Array<{ from: string; to: string }> = [];
  const conditionalEdges: Array<{ from: string; router: (state: any) => string }> = [];
  const entryPoints: string[] = [];
  const exitPoints: string[] = [];
  let maxIterations = 100;

  const builder: GraphBuilder = {
    addNode(name: string, handler: (state: any) => Promise<any>): GraphBuilder {
      nodes.set(name, { name, handler });
      return builder;
    },
    addEdge(from: string, to: string): GraphBuilder {
      edges.push({ from, to });
      return builder;
    },
    addConditionalEdge(from: string, router: (state: any) => string): GraphBuilder {
      conditionalEdges.push({ from, router });
      return builder;
    },
    setEntryPoint(name: string): GraphBuilder {
      if (!entryPoints.includes(name)) entryPoints.push(name);
      return builder;
    },
    setExitPoint(name: string): GraphBuilder {
      if (!exitPoints.includes(name)) exitPoints.push(name);
      return builder;
    },
    setMaxIterations(n: number): GraphBuilder {
      maxIterations = n;
      return builder;
    },
    build(): any {
      return {
        nodes: new Map(nodes),
        edges: [...edges],
        conditionalEdges: [...conditionalEdges],
        entryPoints: [...entryPoints],
        exitPoints: [...exitPoints],
        maxIterations,
      };
    },
  };
  return builder;
}

export function createCycleDetector(): CycleDetector {
  return {
    detectCycles(graph: any): CycleResult {
      const adjacency = new Map<string, string[]>();
      for (const node of graph.nodes.keys()) {
        adjacency.set(node, []);
      }
      for (const edge of graph.edges) {
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
        adjacency.get(edge.from)!.push(edge.to);
      }

      const cycles: string[][] = [];
      const visited = new Set<string>();
      const recStack = new Set<string>();
      const path: string[] = [];

      function dfs(node: string): void {
        visited.add(node);
        recStack.add(node);
        path.push(node);

        const neighbors = adjacency.get(node) || [];
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            dfs(neighbor);
          } else if (recStack.has(neighbor)) {
            const cycleStart = path.indexOf(neighbor);
            const cycle = path.slice(cycleStart);
            cycles.push([...cycle]);
          }
        }

        path.pop();
        recStack.delete(node);
      }

      // Run DFS from all nodes to find all cycles (including disconnected components)
      for (const node of graph.nodes.keys()) {
        if (!visited.has(node)) {
          dfs(node);
        }
      }

      return {
        hasCycle: cycles.length > 0,
        cycles,
      };
    },
  };
}

export function createGraphExecutor(): GraphExecutor {
  return {
    async execute(graph: any, initialState: any): Promise<{ finalState: any; iterations: number; error?: Error }> {
      let state = { ...initialState };
      let iterations = 0;
      const maxIter = graph.maxIterations || 100;
      let currentNode = graph.entryPoints[0];

      while (iterations < maxIter) {
        iterations++;
        const nodeEntry = graph.nodes.get(currentNode);
        if (!nodeEntry) break;

        try {
          state = await nodeEntry.handler(state);
        } catch (err: any) {
          return { finalState: state, iterations, error: err };
        }

        // Check if current node is an exit point
        if (graph.exitPoints.includes(currentNode)) {
          return { finalState: state, iterations };
        }

        // Check conditional edges first
        let nextNode: string | undefined;
        for (const ce of graph.conditionalEdges) {
          if (ce.from === currentNode) {
            nextNode = ce.router(state);
            break;
          }
        }

        // If no conditional edge matched, check direct edges
        if (!nextNode) {
          const directEdge = graph.edges.find((e: any) => e.from === currentNode);
          if (directEdge) {
            nextNode = directEdge.to;
          }
        }

        if (!nextNode || nextNode === '__END__') break;
        currentNode = nextNode;
      }

      return { finalState: state, iterations };
    },
  };
}
