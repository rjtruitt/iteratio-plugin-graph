/**
 * SimpleGraphVisualizer.ts
 * Simple graph visualizer used by tests.
 */

// --- Simple GraphVisualizer (used by tests) ---

/** Generates visual representations of graph structures for debugging and documentation. */
export interface SimpleGraphVisualizer {
  toMermaid(graph: any): string;
  toDOT(graph: any): string;
  toExecutionTrace(graph: any, executionPath: string[]): string;
}

export class GraphVisualizerImpl implements SimpleGraphVisualizer {
  toMermaid(graph: any): string {
    const lines: string[] = ['graph TD'];

    // Add nodes
    for (const node of graph.nodes) {
      lines.push(`  ${node.name}[${node.name}]`);
    }

    // Add edges
    for (const edge of graph.edges) {
      if (edge.label) {
        lines.push(`  ${edge.from} -->|${edge.label}| ${edge.to}`);
      } else {
        lines.push(`  ${edge.from} --> ${edge.to}`);
      }
    }

    return lines.join('\n');
  }

  toDOT(graph: any): string {
    const lines: string[] = ['digraph G {'];

    // Add nodes
    for (const node of graph.nodes) {
      lines.push(`  "${node.name}";`);
    }

    // Add edges
    for (const edge of graph.edges) {
      if (edge.label) {
        lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.label}"];`);
      } else {
        lines.push(`  "${edge.from}" -> "${edge.to}";`);
      }
    }

    lines.push('}');
    return lines.join('\n');
  }

  toExecutionTrace(graph: any, executionPath: string[]): string {
    const lines: string[] = ['graph TD'];
    const visitedSet = new Set(executionPath);

    // Add nodes with visited styling
    for (const node of graph.nodes) {
      if (visitedSet.has(node.name)) {
        lines.push(`  ${node.name}[${node.name}]`);
        lines.push(`  style ${node.name} fill:#9f9,stroke:#333,stroke-width:4px`);
        lines.push(`  %% ${node.name} visited`);
      } else {
        lines.push(`  ${node.name}[${node.name}]`);
      }
    }

    // Add edges
    for (const edge of graph.edges) {
      if (edge.label) {
        lines.push(`  ${edge.from} -->|${edge.label}| ${edge.to}`);
      } else {
        lines.push(`  ${edge.from} --> ${edge.to}`);
      }
    }

    return lines.join('\n');
  }

  static toMermaid(graph: any): string {
    return new GraphVisualizerImpl().toMermaid(graph);
  }

  static toDot(graph: any): string {
    return new GraphVisualizerImpl().toDOT(graph);
  }

  static toAscii(graph: any): string {
    const lines: string[] = [];
    for (const node of graph.nodes) {
      lines.push(`[${node.name}]`);
    }
    for (const edge of graph.edges) {
      lines.push(`  ${edge.from} -> ${edge.to}`);
    }
    return lines.join('\n');
  }
}

export function createGraphVisualizer(): SimpleGraphVisualizer {
  return new GraphVisualizerImpl();
}
