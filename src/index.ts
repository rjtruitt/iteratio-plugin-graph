/**
 * iteratio-plugin-graph
 * Graph-based workflow plugin (LangGraph-style)
 *
 * Provides graph-based execution flow where:
 * - Nodes are execution units
 * - Edges define transitions
 * - Conditional routing based on state
 * - Cycles and loops supported
 * - Parallel branches
 *
 * Different from step-based pipeline:
 * - Steps are linear (configurable order)
 * - Graphs are non-linear (conditional branches, loops, parallel)
 *
 * Use graphs when:
 * - You need conditional branching
 * - You need cycles/loops based on state
 * - You need parallel execution paths
 * - You need complex state machines
 *
 * TODO: Implement GraphPlugin
 * TODO: Add node definition
 * TODO: Add edge definition
 * TODO: Add conditional edges
 * TODO: Add parallel execution
 * TODO: Add cycle detection
 * TODO: Add graph visualization
 * TODO: Add state management
 * TODO: Add checkpoint integration
 * TODO: LangGraph compatibility layer
 */

import { IPlugin, PluginConfig, TurnContext } from 'iteratio';
import { Container } from 'inversify';

/**
 * Graph node interface
 */
export interface IGraphNode {
  name: string;
  execute(state: GraphState): Promise<GraphState>;
}

/**
 * Graph edge interface
 */
export interface IGraphEdge {
  from: string;
  to: string;
  condition?: (state: GraphState) => boolean;
}

/**
 * Graph state (passed between nodes)
 */
export interface GraphState {
  [key: string]: unknown;
  messages?: Array<{ role: string; content: string }>;
  metadata?: Record<string, unknown>;
}

/**
 * Graph definition
 */
export interface Graph {
  nodes: Map<string, IGraphNode>;
  edges: IGraphEdge[];
  entryPoint: string;
  exitPoints: string[];
}

export interface GraphPluginConfig extends PluginConfig {
  maxIterations?: number;
  enableParallel?: boolean;
  enableVisualization?: boolean;
}

/**
 * Manages non-linear workflow execution via directed graphs with conditional
 * routing, cycles, and parallel branches. Integrates with the agent loop
 * via beforeTurn/afterTurn hooks to inject and extract graph state.
 */
export class GraphPlugin implements IPlugin {
  readonly name = 'graph';
  readonly version = '1.0.0';

  private _config: GraphPluginConfig = {};
  private _activeGraph: Graph | null = null;
  private _state: GraphState = {};

  async initialize(_container: Container): Promise<void> {
    // Graph plugin doesn't need DI registration — it operates on the state
    // passed through beforeTurn/afterTurn hooks
  }

  configure(config: PluginConfig): void {
    this._config = config as GraphPluginConfig;
  }

  async beforeTurn(context: TurnContext): Promise<void> {
    if (this._activeGraph && context.metadata) {
      context.metadata.graphState = this._state;
    }
  }

  async afterTurn(context: TurnContext): Promise<void> {
    if (context.metadata?.graphState) {
      this._state = context.metadata.graphState as GraphState;
    }
  }

  async shutdown(): Promise<void> {
    this._activeGraph = null;
    this._state = {};
  }

  /** Set the active graph for execution and reset state. */
  loadGraph(graph: Graph): void {
    this._activeGraph = graph;
    this._state = {};
  }

  getActiveGraph(): Graph | null {
    return this._activeGraph;
  }

  getState(): GraphState {
    return this._state;
  }
}

/** Fluent API for constructing graph definitions. Stub -- see GraphDefinition.ts for implementation. */
export class GraphBuilder {}

/** Graph node that invokes an LLM. Stub -- wire to provider in production. */
export class LLMNode implements IGraphNode {
  name = 'llm';

  async execute(state: GraphState): Promise<GraphState> {
    return state;
  }
}

/** Graph node that executes tools from the agent's tool set. Stub. */
export class ToolNode implements IGraphNode {
  name = 'tool';

  async execute(state: GraphState): Promise<GraphState> {
    return state;
  }
}

// Export graph utilities
export * from './GraphDefinition';
export * from './GraphLoader';
export * from './NodeRegistry';
export * from './GraphComposer';
export * from './GraphTemplates';
export * from './GraphVisualizer';
export * from './GraphExecution';
export * from './ArmaAgentLoader';
export * from './WorkflowBuilder';
export * from './SubgraphExecution';
export * from './JobManager';
export * from './VectorStore';
export * from './ToolGuard';
export * from './DriftRetention';
export * from './DistributedPrimitives';
export * from './ConfigStore';
export * from './ToolCache';
export * from './ToolWrapper';
