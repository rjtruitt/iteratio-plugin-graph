/**
 * SimpleGraphComposer.ts
 * Simple graph composition types and factory for lightweight graph merging.
 */

// --- Simple graph composition types and factory ---

export interface SimpleGraphDefinition {
  nodes: Map<string, { name: string; handler: (state: any) => Promise<any> }>;
  edges: Array<{ from: string; to: string }>;
  entryPoints: string[];
  exitPoints: string[];
}

/** Simplified graph composer for merging multiple graphs into a single workflow. */
export interface SimpleGraphComposer {
  compose(graphA: SimpleGraphDefinition, graphB: SimpleGraphDefinition, options?: SimpleComposeOptions): SimpleGraphDefinition;
  embed(parent: SimpleGraphDefinition, subgraph: SimpleGraphDefinition, atNode: string): SimpleGraphDefinition;
  merge(graphs: SimpleGraphDefinition[]): SimpleGraphDefinition;
}

export interface SimpleComposeOptions {
  /** Connect exit points of A to entry points of B */
  sequential?: boolean;
  /** Strategy for handling name collisions */
  conflictResolution?: 'prefix' | 'error' | 'rename';
}

export function createGraphComposer(): SimpleGraphComposer {
  return {
    compose(graphA: SimpleGraphDefinition, graphB: SimpleGraphDefinition, options?: SimpleComposeOptions): SimpleGraphDefinition {
      const nodes = new Map(graphA.nodes);
      const edges = [...graphA.edges];
      let bNodes = new Map(graphB.nodes);
      let bEdges = [...graphB.edges];

      // Handle name collisions
      if (options?.conflictResolution === 'error') {
        for (const key of bNodes.keys()) {
          if (nodes.has(key)) {
            throw new Error(`Name collision: node '${key}' exists in both graphs`);
          }
        }
      } else if (options?.conflictResolution === 'prefix') {
        const newBNodes = new Map<string, { name: string; handler: (state: any) => Promise<any> }>();
        const renamedMap = new Map<string, string>();
        for (const [key, val] of bNodes.entries()) {
          if (nodes.has(key)) {
            const newName = `b_${key}`;
            renamedMap.set(key, newName);
            newBNodes.set(newName, { ...val, name: newName });
          } else {
            newBNodes.set(key, val);
          }
        }
        bNodes = newBNodes;
        bEdges = bEdges.map(e => ({
          from: renamedMap.get(e.from) || e.from,
          to: renamedMap.get(e.to) || e.to,
        }));
      }

      // Add B's nodes
      for (const [key, val] of bNodes.entries()) {
        nodes.set(key, val);
      }

      // Add B's edges
      edges.push(...bEdges);

      // Sequential connection: connect A's exit points to B's entry points
      if (options?.sequential) {
        for (const exit of graphA.exitPoints) {
          for (const entry of graphB.entryPoints) {
            edges.push({ from: exit, to: entry });
          }
        }
      }

      return {
        nodes,
        edges,
        entryPoints: [...graphA.entryPoints],
        exitPoints: [...graphB.exitPoints],
      };
    },

    embed(parent: SimpleGraphDefinition, subgraph: SimpleGraphDefinition, atNode: string): SimpleGraphDefinition {
      const nodes = new Map(parent.nodes);
      const edges: Array<{ from: string; to: string }> = [];

      // Remove the target node
      nodes.delete(atNode);

      // Add subgraph nodes
      for (const [key, val] of subgraph.nodes.entries()) {
        nodes.set(key, val);
      }

      // Rewire parent edges: edges that pointed TO atNode now point to subgraph entry
      // Edges that pointed FROM atNode now come from subgraph exit
      for (const edge of parent.edges) {
        if (edge.to === atNode) {
          for (const entry of subgraph.entryPoints) {
            edges.push({ from: edge.from, to: entry });
          }
        } else if (edge.from === atNode) {
          for (const exit of subgraph.exitPoints) {
            edges.push({ from: exit, to: edge.to });
          }
        } else {
          edges.push(edge);
        }
      }

      // Add subgraph internal edges
      edges.push(...subgraph.edges);

      // Entry points: keep parent's entry (unless it was the removed node)
      const entryPoints = parent.entryPoints.includes(atNode)
        ? subgraph.entryPoints
        : [...parent.entryPoints];

      // Exit points: if removed node was exit, use subgraph exits
      const exitPoints = parent.exitPoints.includes(atNode)
        ? subgraph.exitPoints
        : [...parent.exitPoints];

      return { nodes, edges, entryPoints, exitPoints };
    },

    merge(graphs: SimpleGraphDefinition[]): SimpleGraphDefinition {
      const nodes = new Map<string, { name: string; handler: (state: any) => Promise<any> }>();
      const edges: Array<{ from: string; to: string }> = [];
      const entryPoints: string[] = [];
      const exitPoints: string[] = [];

      for (const g of graphs) {
        for (const [key, val] of g.nodes.entries()) {
          nodes.set(key, val);
        }
        edges.push(...g.edges);
        entryPoints.push(...g.entryPoints);
        exitPoints.push(...g.exitPoints);
      }

      return { nodes, edges, entryPoints, exitPoints };
    },
  };
}
