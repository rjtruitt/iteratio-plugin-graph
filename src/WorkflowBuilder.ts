/**
 * WorkflowBuilder.ts
 *
 * Programmatic construction and validation of .arma.workflow definitions.
 */

// Re-export all types for backwards compatibility
export * from './WorkflowBuilderTypes';
export { WorkflowSerializer } from './WorkflowSerializer';
export { WorkflowParser } from './WorkflowParser';
export { WorkflowOptimizer } from './WorkflowOptimizer';

import {
  WorkflowDefinition,
  WorkflowSchedule,
  WorkflowAgentDef,
  WorkflowGraphDef,
  WorkflowNodeConfig,
  WorkflowMemory,
  PipelineStep,
  ValidationError,
  ValidationResult,
} from './WorkflowBuilderTypes';

// --- Builder ---

/** Fluent builder for constructing linear workflows from graph nodes. */
export class WorkflowBuilder {
  private _name: string;
  private _version = '1.0';
  private _description?: string;
  private _schedule?: WorkflowSchedule;
  private _agents: WorkflowAgentDef[] = [];
  private _graphs: Record<string, WorkflowGraphDef> = {};
  private _pipeline: PipelineStep[] = [];
  private _inputs?: Record<string, unknown>;
  private _memory?: WorkflowMemory;

  constructor(name: string) {
    this._name = name;
  }

  setDescription(desc: string): this {
    this._description = desc;
    return this;
  }

  setVersion(version: string): this {
    this._version = version;
    return this;
  }

  setSchedule(schedule: WorkflowSchedule): this {
    this._schedule = schedule;
    return this;
  }

  addAgent(agent: WorkflowAgentDef): this {
    this._agents.push(agent);
    return this;
  }

  addGraph(name: string, graph: WorkflowGraphDef): this {
    this._graphs[name] = graph;
    return this;
  }

  setPipeline(pipeline: PipelineStep[]): this {
    this._pipeline = pipeline;
    return this;
  }

  setInputs(inputs: Record<string, unknown>): this {
    this._inputs = inputs;
    return this;
  }

  setMemory(memory: WorkflowMemory): this {
    this._memory = memory;
    return this;
  }

  build(): WorkflowDefinition {
    // Validate pipeline references
    for (const step of this._pipeline) {
      if (!this._graphs[step.graph]) {
        throw new Error(`Pipeline references graph "${step.graph}" which is not defined`);
      }
    }

    // Validate subgraph references
    for (const [graphName, graphDef] of Object.entries(this._graphs)) {
      for (const [nodeName, nodeConfig] of Object.entries(graphDef.nodes)) {
        if (nodeConfig.type === 'subgraph' && nodeConfig.ref) {
          if (!this._graphs[nodeConfig.ref]) {
            throw new Error(
              `Graph "${graphName}" node "${nodeName}" references subgraph "${nodeConfig.ref}" which is not defined`
            );
          }
        }
      }
    }

    return {
      name: this._name,
      version: this._version,
      description: this._description,
      schedule: this._schedule,
      agents: this._agents,
      graphs: this._graphs,
      pipeline: this._pipeline,
      inputs: this._inputs,
      memory: this._memory,
    };
  }
}

// --- Validator ---

export class WorkflowValidator {
  validate(wf: WorkflowDefinition): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // Validate each graph
    for (const [graphName, graphDef] of Object.entries(wf.graphs)) {
      this.validateGraph(graphName, graphDef, wf, errors, warnings);
    }

    // Validate pipeline references
    for (const step of wf.pipeline) {
      if (!wf.graphs[step.graph]) {
        errors.push({
          type: 'missing_pipeline_graph',
          message: `Pipeline references undefined graph "${step.graph}"`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private validateGraph(
    graphName: string,
    graphDef: WorkflowGraphDef,
    wf: WorkflowDefinition,
    errors: ValidationError[],
    warnings: ValidationError[]
  ): void {
    const nodeNames = new Set(Object.keys(graphDef.nodes));

    // Entry node must exist
    if (!nodeNames.has(graphDef.entry)) {
      errors.push({
        type: 'missing_entry_node',
        message: `Graph "${graphName}" entry node "${graphDef.entry}" does not exist`,
        graph: graphName,
      });
    }

    // Parse and validate edges
    const parsedEdges: Array<{ from: string; to: string; condition?: string }> = [];
    for (const edgeStr of graphDef.edges) {
      const parsed = this.parseEdge(edgeStr);
      if (!parsed) {
        errors.push({
          type: 'invalid_edge_format',
          message: `Invalid edge format: "${edgeStr}"`,
          graph: graphName,
          edge: edgeStr,
        });
        continue;
      }
      parsedEdges.push(parsed);

      if (!nodeNames.has(parsed.from)) {
        errors.push({
          type: 'dangling_edge',
          message: `Edge source "${parsed.from}" not found in graph "${graphName}"`,
          graph: graphName,
          edge: edgeStr,
        });
      }
      if (!nodeNames.has(parsed.to)) {
        errors.push({
          type: 'dangling_edge',
          message: `Edge target "${parsed.to}" not found in graph "${graphName}"`,
          graph: graphName,
          edge: edgeStr,
        });
      }
    }

    // Check for unreachable nodes
    const reachable = this.findReachable(graphDef.entry, parsedEdges);
    for (const nodeName of nodeNames) {
      if (!reachable.has(nodeName)) {
        errors.push({
          type: 'unreachable_node',
          message: `Node "${nodeName}" is unreachable from entry in graph "${graphName}"`,
          graph: graphName,
          node: nodeName,
        });
      }
    }

    // Check for unresolvable cycles
    this.detectUnresolvableCycles(graphName, graphDef, parsedEdges, errors);

    // Validate node configs
    for (const [nodeName, nodeConfig] of Object.entries(graphDef.nodes)) {
      this.validateNodeConfig(graphName, nodeName, nodeConfig, wf, errors, warnings);
    }
  }

  private validateNodeConfig(
    graphName: string,
    nodeName: string,
    config: WorkflowNodeConfig,
    wf: WorkflowDefinition,
    errors: ValidationError[],
    warnings: ValidationError[]
  ): void {
    if (config.type === 'spawn') {
      if (!config.count || !config.agent) {
        errors.push({
          type: 'invalid_node_config',
          message: `Spawn node "${nodeName}" requires "count" and "agent" fields`,
          graph: graphName,
          node: nodeName,
        });
      }
      // Check if agent is defined
      if (config.agent && !wf.agents.find(a => a.name === config.agent)) {
        warnings.push({
          type: 'unresolved_agent_ref',
          message: `Spawn node "${nodeName}" references agent "${config.agent}" which is not defined in agents list`,
          graph: graphName,
          node: nodeName,
        });
      }
    }

    if (config.type === 'vector') {
      if (!config.action) {
        errors.push({
          type: 'invalid_node_config',
          message: `Vector node "${nodeName}" requires "action" field`,
          graph: graphName,
          node: nodeName,
        });
      }
    }

    if (config.type === 'subgraph') {
      if (config.ref && !wf.graphs[config.ref]) {
        errors.push({
          type: 'missing_subgraph_ref',
          message: `Subgraph node "${nodeName}" references "${config.ref}" which is not defined`,
          graph: graphName,
          node: nodeName,
        });
      }
    }
  }

  private parseEdge(edgeStr: string): { from: string; to: string; condition?: string } | null {
    const match = edgeStr.match(/^([\w-]+)\s*->\s*([\w-]+)(?:\s*\[(.+)\])?$/);
    if (!match) return null;
    return { from: match[1], to: match[2], condition: match[3]?.trim() };
  }

  private findReachable(
    entry: string,
    edges: Array<{ from: string; to: string }>
  ): Set<string> {
    const reachable = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);

      for (const edge of edges) {
        if (edge.from === current && !reachable.has(edge.to)) {
          queue.push(edge.to);
        }
      }
    }

    return reachable;
  }

  private detectUnresolvableCycles(
    graphName: string,
    graphDef: WorkflowGraphDef,
    edges: Array<{ from: string; to: string; condition?: string }>,
    errors: ValidationError[]
  ): void {
    // Build adjacency list
    const adj = new Map<string, Array<{ to: string; condition?: string }>>();
    for (const edge of edges) {
      if (!adj.has(edge.from)) adj.set(edge.from, []);
      adj.get(edge.from)!.push({ to: edge.to, condition: edge.condition });
    }

    // Find all cycles using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const pathStack: string[] = [];

    const dfs = (node: string): void => {
      visited.add(node);
      recursionStack.add(node);
      pathStack.push(node);

      const neighbors = adj.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.to)) {
          dfs(neighbor.to);
        } else if (recursionStack.has(neighbor.to)) {
          // Cycle detected
          const cycleStart = pathStack.indexOf(neighbor.to);
          const cyclePath = pathStack.slice(cycleStart);

          // Check if any edge in the cycle has a condition that could break it
          let hasExit = false;
          for (let i = 0; i < cyclePath.length; i++) {
            const from = cyclePath[i];
            const fromEdges = adj.get(from) || [];
            for (const e of fromEdges) {
              if (!cyclePath.includes(e.to) && e.condition) {
                hasExit = true;
                break;
              }
              if (cyclePath.includes(e.to) && e.condition) {
                hasExit = true;
                break;
              }
            }
            if (hasExit) break;
          }

          if (!hasExit) {
            errors.push({
              type: 'unresolvable_cycle',
              message: `Unresolvable cycle in graph "${graphName}": ${[...cyclePath, neighbor.to].join(' -> ')}`,
              graph: graphName,
            });
          }
        }
      }

      pathStack.pop();
      recursionStack.delete(node);
    };

    dfs(graphDef.entry);
  }
}
