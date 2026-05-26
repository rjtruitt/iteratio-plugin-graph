/**
 * GraphExecution.ts
 * Graph execution engine with support for linear, conditional, parallel,
 * and cyclic graph traversal.
 *
 * Provides:
 * - GraphBuilder: fluent API to build executable graph definitions
 * - GraphExecutor: execute a built graph with state tracking, parallel branches,
 *   conditional routing, timeouts, and max iteration enforcement
 */

/** Executes a graph definition by traversing nodes according to edges and routing logic. */
export interface GraphExecutor {
  execute(graph: any, initialState: any): Promise<ExecutionResult>;
}

export interface ExecutionResult {
  finalState: any;
  path: string[]; // sequence of node names visited
  error?: Error;
  iterations: number;
}

export interface GraphBuilder {
  addNode(name: string, handler: (state: any) => Promise<any>): GraphBuilder;
  addEdge(from: string, to: string): GraphBuilder;
  addConditionalEdge(from: string, router: (state: any) => string): GraphBuilder;
  setEntryPoint(name: string): GraphBuilder;
  setExitPoint(name: string): GraphBuilder;
  setMaxIterations(n: number): GraphBuilder;
  setNodeTimeout(name: string, ms: number): GraphBuilder;
  build(): any;
}

export function createGraphBuilder(): GraphBuilder {
  const nodes = new Map<string, { name: string; handler: (state: any) => Promise<any> }>();
  const edges: Array<{ from: string; to: string }> = [];
  const conditionalEdges: Array<{ from: string; router: (state: any) => string }> = [];
  const entryPoints: string[] = [];
  const exitPoints: string[] = [];
  let maxIterations = 100;
  const nodeTimeouts = new Map<string, number>();

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
    setNodeTimeout(name: string, ms: number): GraphBuilder {
      nodeTimeouts.set(name, ms);
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
        nodeTimeouts: new Map(nodeTimeouts),
      };
    },
  };
  return builder;
}

/** Creates a graph executor for running graph-based workflows. */
export function createGraphExecutor(): GraphExecutor {
  return {
    async execute(graph: any, initialState: any): Promise<ExecutionResult> {
      let state = { ...initialState };
      let iterations = 0;
      const maxIter = graph.maxIterations || 100;
      const path: string[] = [];
      const entryPoint = graph.entryPoints[0];

      // Build adjacency info: for each node, what are outgoing direct edges
      const outgoingEdges = new Map<string, string[]>();
      for (const edge of graph.edges) {
        if (!outgoingEdges.has(edge.from)) outgoingEdges.set(edge.from, []);
        outgoingEdges.get(edge.from)!.push(edge.to);
      }

      // Build incoming edges map for join detection
      const incomingEdges = new Map<string, string[]>();
      for (const edge of graph.edges) {
        if (!incomingEdges.has(edge.to)) incomingEdges.set(edge.to, []);
        incomingEdges.get(edge.to)!.push(edge.from);
      }

      // Topological execution with parallel support
      async function executeNode(nodeName: string, currentState: any): Promise<any> {
        const nodeEntry = graph.nodes.get(nodeName);
        if (!nodeEntry) return currentState;

        const timeout = graph.nodeTimeouts?.get(nodeName);
        if (timeout) {
          const result = await Promise.race([
            nodeEntry.handler(currentState),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: node '${nodeName}' exceeded ${timeout}ms`)), timeout)),
          ]);
          return result;
        }
        return nodeEntry.handler(currentState);
      }

      // Execute graph using traversal
      async function traverse(startNode: string, currentState: any): Promise<{ state: any; error?: Error }> {
        let current = startNode;
        let s = currentState;

        while (iterations < maxIter) {
          iterations++;

          // Check if this is a join node (has multiple incoming edges)
          const outgoing = outgoingEdges.get(current) || [];
          const conditionalEdge = graph.conditionalEdges.find((ce: any) => ce.from === current);

          // Execute current node
          try {
            s = await executeNode(current, s);
          } catch (err: any) {
            path.push(current);
            return { state: s, error: err };
          }
          path.push(current);

          // Check if this is an exit point
          if (graph.exitPoints.includes(current)) {
            return { state: s };
          }

          // Determine next node(s)
          if (conditionalEdge) {
            const next = conditionalEdge.router(s);
            if (next === '__END__' || !next) return { state: s };
            current = next;
          } else if (outgoing.length > 1) {
            // Parallel fan-out: execute all branches, then find join node
            const branchPromises = outgoing.map(async (branchStart) => {
              let branchState = { ...s };
              let branchNode = branchStart;
              const branchPath: string[] = [];

              while (true) {
                const nodeEntry = graph.nodes.get(branchNode);
                if (!nodeEntry) break;

                try {
                  branchState = await executeNode(branchNode, branchState);
                } catch (err: any) {
                  branchPath.push(branchNode);
                  return { state: branchState, path: branchPath, error: err };
                }
                branchPath.push(branchNode);

                if (graph.exitPoints.includes(branchNode)) {
                  return { state: branchState, path: branchPath };
                }

                // Find next in this branch
                const branchOutgoing = outgoingEdges.get(branchNode) || [];
                const branchCond = graph.conditionalEdges.find((ce: any) => ce.from === branchNode);

                if (branchCond) {
                  const next = branchCond.router(branchState);
                  if (!next || next === '__END__') break;
                  branchNode = next;
                } else if (branchOutgoing.length === 1) {
                  // Check if next is a join node (reachable from multiple branches)
                  const nextNode = branchOutgoing[0];
                  const incomingToNext = incomingEdges.get(nextNode) || [];
                  if (incomingToNext.length > 1) {
                    // This is a join node - stop branch here
                    return { state: branchState, path: branchPath, joinNode: nextNode };
                  }
                  branchNode = nextNode;
                } else {
                  break;
                }
              }

              return { state: branchState, path: branchPath };
            });

            const results = await Promise.all(branchPromises);

            // Check for errors
            for (const r of results) {
              if (r.error) {
                path.push(...r.path);
                return { state: r.state, error: r.error };
              }
            }

            // Merge states from branches
            let mergedState = { ...s };
            for (const r of results) {
              mergedState = { ...mergedState, ...r.state };
            }
            s = mergedState;

            // Add branch paths
            for (const r of results) {
              path.push(...r.path);
            }

            // Find join node
            const joinNode = results.find(r => (r as any).joinNode)?.joinNode;
            if (joinNode) {
              current = joinNode;
            } else {
              // Branches ended at exit points
              return { state: s };
            }
          } else if (outgoing.length === 1) {
            current = outgoing[0];
          } else {
            // No outgoing edges, we're done
            return { state: s };
          }
        }

        return { state: s };
      }

      const result = await traverse(entryPoint, state);

      return {
        finalState: result.state,
        path,
        error: result.error,
        iterations,
      };
    },
  };
}
