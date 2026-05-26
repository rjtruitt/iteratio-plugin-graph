/**
 * SimpleGraphBuilder.ts
 * Simple graph definition builder factory used by tests.
 */

// --- Simple GraphDefinition builder (used by tests) ---

/** A node in a simple graph with a name, handler, and routing metadata. */
export interface SimpleGraphNode {
  name: string;
  handler: (state: any) => Promise<any>;
  metadata?: { description?: string; timeout?: number };
}

export interface SimpleGraphEdge {
  from: string;
  to: string;
  condition?: (state: any) => boolean;
}

export interface GraphDefinitionBuilder {
  addNode(node: SimpleGraphNode): GraphDefinitionBuilder;
  addEdge(from: string, to: string): GraphDefinitionBuilder;
  addConditionalEdge(from: string, condition: (state: any) => string): GraphDefinitionBuilder;
  setEntryPoint(nodeName: string): GraphDefinitionBuilder;
  setExitPoint(nodeName: string): GraphDefinitionBuilder;
  build(): SimpleGraphDefinitionResult;
  validate(): { valid: boolean; errors: string[] };
}

export interface SimpleGraphDefinitionResult {
  nodes: Map<string, SimpleGraphNode>;
  edges: SimpleGraphEdge[];
  entryPoints: string[];
  exitPoints: string[];
}

export function createGraphBuilder(): GraphDefinitionBuilder {
  const nodes = new Map<string, SimpleGraphNode>();
  const edges: SimpleGraphEdge[] = [];
  const entryPoints: string[] = [];
  const exitPoints: string[] = [];
  const conditionalEdges: Array<{ from: string; condition: (state: any) => string }> = [];
  const nodeRegistry = new Map<string, { type: string; create: (...args: any[]) => any; metadata?: any; variant?: string }>();

  const builder: GraphDefinitionBuilder = {
    addNode(node: SimpleGraphNode): GraphDefinitionBuilder {
      if (!node.name) {
        throw new Error('Node name must not be empty');
      }
      if (nodes.has(node.name)) {
        throw new Error(`Node '${node.name}' already exists`);
      }
      nodes.set(node.name, node);
      return builder;
    },

    addEdge(from: string, to: string): GraphDefinitionBuilder {
      // Allow dangling edges for validation purposes; only throw if neither node exists
      edges.push({ from, to });
      return builder;
    },

    addConditionalEdge(from: string, condition: (state: any) => string): GraphDefinitionBuilder {
      conditionalEdges.push({ from, condition });
      // Store a placeholder edge for the conditional
      edges.push({ from, to: '__conditional__', condition: condition as any });
      return builder;
    },

    setEntryPoint(nodeName: string): GraphDefinitionBuilder {
      if (!nodes.has(nodeName)) {
        throw new Error(`Node '${nodeName}' not found`);
      }
      if (!entryPoints.includes(nodeName)) {
        entryPoints.push(nodeName);
      }
      return builder;
    },

    setExitPoint(nodeName: string): GraphDefinitionBuilder {
      if (!nodes.has(nodeName)) {
        throw new Error(`Node '${nodeName}' not found`);
      }
      if (!exitPoints.includes(nodeName)) {
        exitPoints.push(nodeName);
      }
      return builder;
    },

    build(): SimpleGraphDefinitionResult {
      return {
        nodes: new Map(nodes),
        edges: [...edges],
        entryPoints: [...entryPoints],
        exitPoints: [...exitPoints],
      };
    },

    validate(): { valid: boolean; errors: string[] } {
      const errors: string[] = [];

      // Check entry point is defined
      if (entryPoints.length === 0) {
        errors.push('No entry point defined');
      }

      // Check all edge targets exist
      for (const edge of edges) {
        if (edge.to === '__conditional__') continue;
        if (!nodes.has(edge.from)) {
          errors.push(`Dangling edge: source node '${edge.from}' not found`);
        }
        if (!nodes.has(edge.to)) {
          errors.push(`Dangling edge: target node '${edge.to}' not found`);
        }
      }

      return { valid: errors.length === 0, errors };
    },
  };

  // Add registry methods via `as any`
  (builder as any).registerNode = (nodeFactory: any) => {
    nodeRegistry.set(nodeFactory.type + (nodeFactory.variant || ''), nodeFactory);
  };

  (builder as any).unregisterNode = (nodeType: string) => {
    for (const [key, val] of nodeRegistry.entries()) {
      if (val.type === nodeType) {
        nodeRegistry.delete(key);
        return;
      }
    }
  };

  (builder as any).getNode = (type: string) => {
    for (const [, val] of nodeRegistry.entries()) {
      if (val.type === type) return val;
    }
    return undefined;
  };

  (builder as any).getNodeMetadata = (type: string) => {
    for (const [, val] of nodeRegistry.entries()) {
      if (val.type === type) return val.metadata;
    }
    return undefined;
  };

  (builder as any).getAllNodes = () => {
    return Array.from(nodeRegistry.values());
  };

  (builder as any).getNodesByType = (type: string) => {
    return Array.from(nodeRegistry.values()).filter(n => n.type === type);
  };

  return builder;
}
