/**
 * NodeRegistry.ts
 * Registry for custom and built-in graph nodes
 *
 * Provides:
 * - Node registration and lookup
 * - Built-in node implementations
 * - Node validation
 * - Node factory pattern
 */

import { IGraphNode, GraphState } from './index';
import { NodeType, NodeConfig } from './GraphDefinition';
import {
  StartNode,
  EndNode,
  LLMNode,
  ToolNode,
  ConditionNode,
  TransformNode,
  ParallelNode,
  SubgraphNode,
} from './BuiltinNodes';

// Re-export built-in nodes for backwards compatibility
export {
  StartNode,
  EndNode,
  LLMNode,
  ToolNode,
  ConditionNode,
  TransformNode,
  ParallelNode,
  SubgraphNode,
} from './BuiltinNodes';

/**
 * Node factory function
 */
export type NodeFactory = (config: NodeConfig) => IGraphNode;

/**
 * Node metadata
 */
export interface NodeMetadata {
  name: string;
  type: NodeType;
  description?: string;
  version?: string;
  author?: string;
  parameters?: Record<string, unknown>;
  examples?: unknown[];
}

/**
 * Registered node entry
 */
interface RegisteredNode {
  factory: NodeFactory;
  metadata: NodeMetadata;
  builtin: boolean;
}

/**
 * Node registry error
 */
/** Registry of all available graph node types with their constructor metadata. */
export class NodeRegistryError extends Error {
  constructor(message: string, public nodeName?: string) {
    super(message);
    this.name = 'NodeRegistryError';
  }
}

/**
 * NodeRegistry class
 * Manages node registration and instantiation
 */
export class NodeRegistry {
  private nodes = new Map<string, RegisteredNode>();

  constructor() {
    this.registerBuiltinNodes();
  }

  /**
   * Register a custom node
   */
  registerNode(
    name: string,
    factory: NodeFactory,
    metadata?: Partial<NodeMetadata>
  ): void {
    if (this.nodes.has(name)) {
      throw new NodeRegistryError(`Node '${name}' is already registered`, name);
    }

    this.nodes.set(name, {
      factory,
      metadata: { name, type: NodeType.CUSTOM, ...metadata },
      builtin: false,
    });
  }

  /**
   * Unregister a node
   */
  unregisterNode(name: string): boolean {
    const node = this.nodes.get(name);
    if (!node) return false;

    if (node.builtin) {
      throw new NodeRegistryError(`Cannot unregister built-in node '${name}'`, name);
    }

    return this.nodes.delete(name);
  }

  /**
   * Get a node factory
   */
  getNode(name: string): NodeFactory | undefined {
    return this.nodes.get(name)?.factory;
  }

  /**
   * Get node metadata
   */
  getNodeMetadata(name: string): NodeMetadata | undefined {
    return this.nodes.get(name)?.metadata;
  }

  /**
   * Get all registered nodes
   */
  getAllNodes(): Map<string, NodeMetadata> {
    const result = new Map<string, NodeMetadata>();
    for (const [name, node] of this.nodes.entries()) {
      result.set(name, node.metadata);
    }
    return result;
  }

  /**
   * Get nodes by type
   */
  getNodesByType(type: NodeType): Map<string, NodeMetadata> {
    const result = new Map<string, NodeMetadata>();
    for (const [name, node] of this.nodes.entries()) {
      if (node.metadata.type === type) {
        result.set(name, node.metadata);
      }
    }
    return result;
  }

  /**
   * Check if node exists
   */
  hasNode(name: string): boolean {
    return this.nodes.has(name);
  }

  /**
   * Create node instance
   */
  createNode(config: NodeConfig): IGraphNode {
    const factory = this.getNode(config.name);
    if (!factory) {
      throw new NodeRegistryError(`Node '${config.name}' not found in registry`, config.name);
    }

    try {
      const node = factory(config);
      return node;
    } catch (error) {
      throw new NodeRegistryError(`Failed to create node '${config.name}': ${error}`, config.name);
    }
  }

  /**
   * Validate node configuration
   */
  validateNodeConfig(config: NodeConfig): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    if (!config.name) errors.push('Node name is required');
    if (!config.type) errors.push('Node type is required');

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  /**
   * Register built-in nodes
   */
  private registerBuiltinNodes(): void {
    this.nodes.set('start', {
      factory: (config) => new StartNode(config),
      metadata: { name: 'start', type: NodeType.START, description: 'Entry point node' },
      builtin: true,
    });

    this.nodes.set('end', {
      factory: (config) => new EndNode(config),
      metadata: { name: 'end', type: NodeType.END, description: 'Exit point node' },
      builtin: true,
    });

    this.nodes.set('llm', {
      factory: (config) => new LLMNode(config),
      metadata: { name: 'llm', type: NodeType.LLM, description: 'LLM call node' },
      builtin: true,
    });

    this.nodes.set('tool', {
      factory: (config) => new ToolNode(config),
      metadata: { name: 'tool', type: NodeType.TOOL, description: 'Tool execution node' },
      builtin: true,
    });

    this.nodes.set('condition', {
      factory: (config) => new ConditionNode(config),
      metadata: { name: 'condition', type: NodeType.CONDITION, description: 'Conditional routing node' },
      builtin: true,
    });

    this.nodes.set('transform', {
      factory: (config) => new TransformNode(config),
      metadata: { name: 'transform', type: NodeType.TRANSFORM, description: 'State transformation node' },
      builtin: true,
    });

    this.nodes.set('parallel', {
      factory: (config) => new ParallelNode(config),
      metadata: { name: 'parallel', type: NodeType.PARALLEL, description: 'Parallel execution node' },
      builtin: true,
    });

    this.nodes.set('subgraph', {
      factory: (config) => new SubgraphNode(config),
      metadata: { name: 'subgraph', type: NodeType.SUBGRAPH, description: 'Nested graph node' },
      builtin: true,
    });
  }
}

/**
 * Global node registry instance
 */
export const globalNodeRegistry = new NodeRegistry();

/**
 * Convenience functions
 */
export function registerNode(
  name: string,
  factory: NodeFactory,
  metadata?: Partial<NodeMetadata>
): void {
  globalNodeRegistry.registerNode(name, factory, metadata);
}

export function getNode(name: string): NodeFactory | undefined {
  return globalNodeRegistry.getNode(name);
}

export function getAllNodes(): Map<string, NodeMetadata> {
  return globalNodeRegistry.getAllNodes();
}

export function createNode(config: NodeConfig): IGraphNode {
  return globalNodeRegistry.createNode(config);
}
