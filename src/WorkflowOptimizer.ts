/**
 * WorkflowOptimizer.ts
 *
 * Analyzes workflow definitions for optimization opportunities.
 */

import {
  WorkflowDefinition,
  WorkflowGraphDef,
  OptimizationSuggestion,
} from './WorkflowBuilderTypes';

// --- Optimizer ---

/** Optimizes workflow definitions by merging, parallelizing, or reordering steps. */
export class WorkflowOptimizer {
  analyze(wf: WorkflowDefinition): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    for (const [graphName, graphDef] of Object.entries(wf.graphs)) {
      this.checkRepeatedTools(graphName, graphDef, suggestions);
      this.checkHighSpawnCount(graphName, graphDef, suggestions);
      this.checkMissingDrift(graphName, graphDef, suggestions);
      this.checkMissingVerification(graphName, graphDef, suggestions);
      this.checkParallelizable(graphName, graphDef, suggestions);
    }

    return suggestions;
  }

  private checkRepeatedTools(
    graphName: string,
    graphDef: WorkflowGraphDef,
    suggestions: OptimizationSuggestion[]
  ): void {
    const toolCounts = new Map<string, number>();
    for (const nodeConfig of Object.values(graphDef.nodes)) {
      if (nodeConfig.type === 'tool' && nodeConfig.tool) {
        toolCounts.set(nodeConfig.tool, (toolCounts.get(nodeConfig.tool) || 0) + 1);
      }
    }

    for (const [tool, count] of toolCounts) {
      if (count >= 3) {
        suggestions.push({
          type: 'vector_cache',
          severity: 'suggestion',
          message: `Tool "${tool}" is called ${count} times in "${graphName}" — consider adding vector caching to reduce redundant calls`,
          graph: graphName,
        });
      }
    }
  }

  private checkHighSpawnCount(
    graphName: string,
    graphDef: WorkflowGraphDef,
    suggestions: OptimizationSuggestion[]
  ): void {
    for (const [nodeName, nodeConfig] of Object.entries(graphDef.nodes)) {
      if (nodeConfig.type === 'spawn' && nodeConfig.count && nodeConfig.count > 10) {
        suggestions.push({
          type: 'bounded_pool',
          severity: 'warning',
          message: `Spawn node "${nodeName}" creates ${nodeConfig.count} agents — consider using a bounded pool with queue instead`,
          graph: graphName,
          node: nodeName,
        });
      }
    }
  }

  private checkMissingDrift(
    graphName: string,
    graphDef: WorkflowGraphDef,
    suggestions: OptimizationSuggestion[]
  ): void {
    const hasPublish = Object.values(graphDef.nodes).some(
      n => n.type === 'tool' && n.tool && (
        n.tool.includes('createPage') ||
        n.tool.includes('updatePage') ||
        n.tool.includes('publish')
      )
    );
    const hasDrift = Object.values(graphDef.nodes).some(n => n.type === 'drift');

    if (hasPublish && !hasDrift) {
      suggestions.push({
        type: 'missing_drift',
        severity: 'suggestion',
        message: `Graph "${graphName}" publishes content but has no Drift snapshots — consider adding pre/post-publish snapshots`,
        graph: graphName,
      });
    }
  }

  private checkMissingVerification(
    graphName: string,
    graphDef: WorkflowGraphDef,
    suggestions: OptimizationSuggestion[]
  ): void {
    const edges = graphDef.edges;
    const nodes = graphDef.nodes;

    // Find LLM -> publish patterns with no verification in between
    for (const edge of edges) {
      const parsed = edge.match(/^([\w-]+)\s*->\s*([\w-]+)/);
      if (!parsed) continue;

      const [, from, to] = parsed;
      const fromNode = nodes[from];
      const toNode = nodes[to];

      if (
        fromNode?.type === 'llm' &&
        toNode?.type === 'tool' &&
        toNode.tool &&
        (toNode.tool.includes('createPage') || toNode.tool.includes('updatePage'))
      ) {
        suggestions.push({
          type: 'missing_verification',
          severity: 'warning',
          message: `LLM node "${from}" feeds directly into publish node "${to}" without hallucination verification`,
          graph: graphName,
        });
      }
    }
  }

  private checkParallelizable(
    graphName: string,
    graphDef: WorkflowGraphDef,
    suggestions: OptimizationSuggestion[]
  ): void {
    const edges = graphDef.edges;
    const nodes = graphDef.nodes;

    // Find sequential chains of independent tool calls
    const parsedEdges = edges
      .map(e => e.match(/^([\w-]+)\s*->\s*([\w-]+)/))
      .filter((m): m is RegExpMatchArray => m !== null);

    // Build sequential chain
    const chains: string[][] = [];
    for (const [, from] of parsedEdges) {
      const chain = [from];
      let current = from;
      while (true) {
        const next = parsedEdges.find(([, f]) => f === current);
        if (!next) break;
        const nextNode = next[2];
        chain.push(nextNode);
        current = nextNode;
      }
    }

    // Find runs of 3+ tool nodes in sequence
    for (const [, from, to] of parsedEdges) {
      const fromNode = nodes[from];
      const toNode = nodes[to];

      if (fromNode?.type === 'tool' && toNode?.type === 'tool') {
        // Check if 'to' also feeds into another tool
        const nextEdge = parsedEdges.find(([, f]) => f === to);
        if (nextEdge && nodes[nextEdge[2]]?.type === 'tool') {
          // 3 sequential tools found — likely parallelizable
          suggestions.push({
            type: 'parallelizable',
            severity: 'suggestion',
            message: `Sequential tool calls "${from}" → "${to}" → "${nextEdge[2]}" in "${graphName}" may be parallelizable`,
            graph: graphName,
          });
          break; // Only report once per graph
        }
      }
    }
  }
}
