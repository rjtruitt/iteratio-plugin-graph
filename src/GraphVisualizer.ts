/**
 * GraphVisualizer.ts
 * Visualize graphs in various formats (Mermaid, DOT, ASCII)
 */

// Re-export simple visualizer for backwards compatibility
export {
  SimpleGraphVisualizer,
  GraphVisualizerImpl,
  createGraphVisualizer,
} from './SimpleGraphVisualizer';

import {
  GraphDefinition,
  NodeConfig,
  Edge,
  EdgeType,
  NodeType,
} from './GraphDefinition';

/**
 * Visualization options
 */
export interface VisualizationOptions {
  includeMetadata?: boolean;
  includeDescription?: boolean;
  highlightPath?: string[];
  theme?: 'default' | 'dark' | 'light';
  direction?: 'TB' | 'LR' | 'BT' | 'RL';
  showNodeTypes?: boolean;
  showEdgeLabels?: boolean;
}

const defaultOptions: VisualizationOptions = {
  includeMetadata: false,
  includeDescription: true,
  theme: 'default',
  direction: 'TB',
  showNodeTypes: true,
  showEdgeLabels: true,
};

/**
 * GraphVisualizer class
 * Generate various visualization formats
 */
/** Generates visual representations of graph structures (Mermaid, DOT, text). */
export class GraphVisualizer {
  /**
   * Generate Mermaid diagram
   */
  static toMermaid(graph: GraphDefinition, options?: VisualizationOptions): string {
    const opts = { ...defaultOptions, ...options };
    const lines: string[] = [];

    lines.push(`graph ${opts.direction}`);

    if (graph.description && opts.includeDescription) {
      lines.push(`  %% ${graph.description}`);
    }

    for (const node of graph.nodes) {
      const nodeId = this.sanitizeId(node.name);
      const nodeLabel = this.formatNodeLabel(node, opts);
      const nodeShape = this.getMermaidNodeShape(node.type);

      lines.push(`  ${nodeId}${nodeShape[0]}${nodeLabel}${nodeShape[1]}`);

      const nodeStyle = this.getMermaidNodeStyle(node.type);
      if (nodeStyle) {
        lines.push(`  style ${nodeId} ${nodeStyle}`);
      }

      if (opts.highlightPath?.includes(node.name)) {
        lines.push(`  style ${nodeId} fill:#ff9,stroke:#333,stroke-width:4px`);
      }
    }

    for (const edge of graph.edges) {
      if (edge.type === EdgeType.DIRECT) {
        const fromId = this.sanitizeId(edge.from);
        const toId = this.sanitizeId(edge.to);
        const label = opts.showEdgeLabels && edge.description ? `|${edge.description}|` : '';
        lines.push(`  ${fromId} -->${label} ${toId}`);
      } else if (edge.type === EdgeType.CONDITIONAL) {
        const fromId = this.sanitizeId(edge.from);
        for (const condition of edge.conditions) {
          const toId = this.sanitizeId(condition.to);
          const label = opts.showEdgeLabels ? `|${condition.condition}: ${condition.value}|` : '';
          lines.push(`  ${fromId} -.${label}.-> ${toId}`);
        }
        if (edge.default) {
          const toId = this.sanitizeId(edge.default);
          const label = opts.showEdgeLabels ? '|default|' : '';
          lines.push(`  ${fromId} -->${label} ${toId}`);
        }
      } else if (edge.type === EdgeType.PARALLEL) {
        const fromId = this.sanitizeId(edge.from);
        for (const to of edge.to) {
          const toId = this.sanitizeId(to);
          const label = opts.showEdgeLabels ? '|parallel|' : '';
          lines.push(`  ${fromId} ==>${label} ${toId}`);
        }
      }
    }

    if (opts.includeMetadata && graph.metadata) {
      lines.push('');
      lines.push('  %% Metadata:');
      for (const [key, value] of Object.entries(graph.metadata)) {
        lines.push(`  %% ${key}: ${JSON.stringify(value)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate Graphviz DOT format
   */
  static toDot(graph: GraphDefinition, options?: VisualizationOptions): string {
    const opts = { ...defaultOptions, ...options };
    const lines: string[] = [];

    lines.push('digraph G {');
    lines.push('  rankdir=' + opts.direction + ';');
    lines.push('  node [shape=box, style=rounded];');
    lines.push('');

    if (graph.description) {
      lines.push(`  label="${this.escapeDot(graph.description)}";`);
      lines.push('  labelloc="t";');
      lines.push('');
    }

    for (const node of graph.nodes) {
      const nodeId = this.sanitizeId(node.name);
      const nodeLabel = this.formatNodeLabel(node, opts);
      const nodeAttrs = this.getDotNodeAttributes(node.type, opts);
      lines.push(`  ${nodeId} [label="${this.escapeDot(nodeLabel)}"${nodeAttrs}];`);
    }

    lines.push('');

    for (const edge of graph.edges) {
      if (edge.type === EdgeType.DIRECT) {
        const fromId = this.sanitizeId(edge.from);
        const toId = this.sanitizeId(edge.to);
        const label = opts.showEdgeLabels && edge.description ? `, label="${this.escapeDot(edge.description)}"` : '';
        lines.push(`  ${fromId} -> ${toId} [${label}];`);
      } else if (edge.type === EdgeType.CONDITIONAL) {
        const fromId = this.sanitizeId(edge.from);
        for (const condition of edge.conditions) {
          const toId = this.sanitizeId(condition.to);
          const label = opts.showEdgeLabels
            ? `, label="${this.escapeDot(`${condition.condition}: ${condition.value}`)}"`
            : '';
          lines.push(`  ${fromId} -> ${toId} [style=dashed${label}];`);
        }
        if (edge.default) {
          const toId = this.sanitizeId(edge.default);
          const label = opts.showEdgeLabels ? ', label="default"' : '';
          lines.push(`  ${fromId} -> ${toId} [${label}];`);
        }
      } else if (edge.type === EdgeType.PARALLEL) {
        const fromId = this.sanitizeId(edge.from);
        for (const to of edge.to) {
          const toId = this.sanitizeId(to);
          const label = opts.showEdgeLabels ? ', label="parallel"' : '';
          lines.push(`  ${fromId} -> ${toId} [style=bold${label}];`);
        }
      }
    }

    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate ASCII art visualization
   */
  static toASCII(graph: GraphDefinition, options?: VisualizationOptions): string {
    const opts = { ...defaultOptions, ...options };
    const lines: string[] = [];

    if (graph.description && opts.includeDescription) {
      lines.push(graph.description);
      lines.push('='.repeat(graph.description.length));
      lines.push('');
    }

    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);

      if (edge.type === EdgeType.DIRECT) {
        adjacency.get(edge.from)!.push(edge.to);
      } else if (edge.type === EdgeType.CONDITIONAL) {
        for (const condition of edge.conditions) adjacency.get(edge.from)!.push(condition.to);
        if (edge.default) adjacency.get(edge.from)!.push(edge.default);
      } else if (edge.type === EdgeType.PARALLEL) {
        adjacency.get(edge.from)!.push(...edge.to);
      }
    }

    const visited = new Set<string>();
    const queue: Array<{ node: string; level: number }> = [{ node: graph.entryPoint, level: 0 }];

    while (queue.length > 0) {
      const { node, level } = queue.shift()!;
      if (visited.has(node)) continue;

      visited.add(node);

      const indent = '  '.repeat(level);
      const nodeInfo = graph.nodes.find((n) => n.name === node);
      const nodeLabel = nodeInfo
        ? `[${node}]${opts.showNodeTypes ? ` (${nodeInfo.type})` : ''}`
        : `[${node}]`;

      lines.push(`${indent}${nodeLabel}`);

      const children = adjacency.get(node) || [];
      if (children.length > 0) {
        lines.push(`${indent}  |`);
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const isLast = i === children.length - 1;
          const prefix = isLast ? '  └─> ' : '  ├─> ';

          if (!visited.has(child)) {
            queue.push({ node: child, level: level + 1 });
          } else {
            lines.push(`${indent}${prefix}[${child}] (cycle)`);
          }
        }
      }
    }

    const unreached = graph.nodes.map((n) => n.name).filter((n) => !visited.has(n));
    if (unreached.length > 0) {
      lines.push('');
      lines.push('Unreachable nodes:');
      for (const node of unreached) lines.push(`  [${node}]`);
    }

    return lines.join('\n');
  }

  /**
   * Generate simple text summary
   */
  static toSummary(graph: GraphDefinition): string {
    const lines: string[] = [];

    lines.push(`Graph: ${graph.name}`);
    if (graph.description) lines.push(`Description: ${graph.description}`);
    lines.push(`Version: ${graph.version}`);
    lines.push('');
    lines.push(`Nodes: ${graph.nodes.length}`);
    lines.push(`Edges: ${graph.edges.length}`);
    lines.push(`Entry Point: ${graph.entryPoint}`);
    lines.push(`Exit Points: ${graph.exitPoints.join(', ')}`);
    lines.push('');

    const nodeTypes = new Map<NodeType, number>();
    for (const node of graph.nodes) {
      nodeTypes.set(node.type, (nodeTypes.get(node.type) || 0) + 1);
    }
    lines.push('Node Types:');
    for (const [type, count] of nodeTypes.entries()) lines.push(`  ${type}: ${count}`);
    lines.push('');

    const edgeTypes = new Map<EdgeType, number>();
    for (const edge of graph.edges) {
      edgeTypes.set(edge.type, (edgeTypes.get(edge.type) || 0) + 1);
    }
    lines.push('Edge Types:');
    for (const [type, count] of edgeTypes.entries()) lines.push(`  ${type}: ${count}`);

    return lines.join('\n');
  }

  private static sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private static formatNodeLabel(node: NodeConfig, opts: VisualizationOptions): string {
    let label = node.name;
    if (opts.showNodeTypes) label += `\\n(${node.type})`;
    if (opts.includeDescription && node.description) label += `\\n${node.description}`;
    return label;
  }

  private static getMermaidNodeShape(type: NodeType): [string, string] {
    switch (type) {
      case NodeType.START: return ['([', '])'];
      case NodeType.END: return ['([', '])'];
      case NodeType.CONDITION: return ['{', '}'];
      case NodeType.PARALLEL: return ['[[', ']]'];
      case NodeType.SUBGRAPH: return ['[(', ')]'];
      default: return ['[', ']'];
    }
  }

  private static getMermaidNodeStyle(type: NodeType): string | null {
    switch (type) {
      case NodeType.START: return 'fill:#9f9,stroke:#333,stroke-width:2px';
      case NodeType.END: return 'fill:#f99,stroke:#333,stroke-width:2px';
      case NodeType.LLM: return 'fill:#99f,stroke:#333,stroke-width:2px';
      case NodeType.TOOL: return 'fill:#f9f,stroke:#333,stroke-width:2px';
      case NodeType.CONDITION: return 'fill:#ff9,stroke:#333,stroke-width:2px';
      case NodeType.PARALLEL: return 'fill:#9ff,stroke:#333,stroke-width:2px';
      case NodeType.SUBGRAPH: return 'fill:#fcf,stroke:#333,stroke-width:2px';
      default: return null;
    }
  }

  private static getDotNodeAttributes(type: NodeType, opts: VisualizationOptions): string {
    const attrs: string[] = [];
    switch (type) {
      case NodeType.START: attrs.push('shape=circle', 'style=filled', 'fillcolor=lightgreen'); break;
      case NodeType.END: attrs.push('shape=doublecircle', 'style=filled', 'fillcolor=lightcoral'); break;
      case NodeType.CONDITION: attrs.push('shape=diamond', 'style=filled', 'fillcolor=lightyellow'); break;
      case NodeType.PARALLEL: attrs.push('shape=parallelogram', 'style=filled', 'fillcolor=lightcyan'); break;
      case NodeType.LLM: attrs.push('shape=box', 'style="rounded,filled"', 'fillcolor=lightblue'); break;
      case NodeType.TOOL: attrs.push('shape=box', 'style="rounded,filled"', 'fillcolor=plum'); break;
      case NodeType.SUBGRAPH: attrs.push('shape=folder', 'style=filled', 'fillcolor=lavender'); break;
      default: attrs.push('shape=box', 'style=rounded');
    }
    return attrs.length > 0 ? ', ' + attrs.join(', ') : '';
  }

  private static escapeDot(str: string): string {
    return str.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }
}

/**
 * Convenience functions
 */
export function visualizeGraph(
  graph: GraphDefinition,
  format: 'mermaid' | 'dot' | 'ascii' | 'summary' = 'mermaid',
  options?: VisualizationOptions
): string {
  switch (format) {
    case 'mermaid': return GraphVisualizer.toMermaid(graph, options);
    case 'dot': return GraphVisualizer.toDot(graph, options);
    case 'ascii': return GraphVisualizer.toASCII(graph, options);
    case 'summary': return GraphVisualizer.toSummary(graph);
    default: throw new Error(`Unknown format: ${format}`);
  }
}

/**
 * Export graph visualization to file
 */
export async function exportVisualization(
  graph: GraphDefinition,
  outputPath: string,
  format: 'mermaid' | 'dot' | 'ascii' | 'summary' = 'mermaid',
  options?: VisualizationOptions
): Promise<void> {
  const content = visualizeGraph(graph, format, options);
  throw new Error('File export not yet implemented - TODO: add file writing');
}
