/**
 * GraphLoader.ts
 * Load graph definitions from various sources (file, URL, object).
 */

// Re-export simple loader for backwards compatibility
export { SimpleGraphLoader, createGraphLoader } from './SimpleGraphLoader';

import {
  GraphDefinition,
  validateGraphDefinition,
  GraphDefinitionSchema,
} from './GraphDefinition';

/**
 * Graph loading error
 */
export class GraphLoadError extends Error {
  constructor(
    message: string,
    public source: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'GraphLoadError';
  }
}

/**
 * Loader options
 */
export interface LoaderOptions {
  validate?: boolean;
  allowCycles?: boolean;
  allowUnreachable?: boolean;
  cache?: boolean;
  cacheTTL?: number;
  timeout?: number;
  retries?: number;
  encoding?: string;
}

const defaultOptions: LoaderOptions = {
  validate: true,
  allowCycles: true,
  allowUnreachable: false,
  cache: false,
  timeout: 5000,
  retries: 3,
  encoding: 'utf-8',
};

/**
 * Cache entry
 */
interface CacheEntry {
  graph: GraphDefinition;
  timestamp: number;
  source: string;
}

/**
 * GraphLoader class
 * Handles loading graphs from various sources
 */
export class GraphLoader {
  private cache = new Map<string, CacheEntry>();
  private options: LoaderOptions;

  constructor(options: LoaderOptions = {}) {
    this.options = { ...defaultOptions, ...options };
  }

  /**
   * Load graph from file
   */
  async loadFromFile(filePath: string, options?: LoaderOptions): Promise<GraphDefinition> {
    const opts = { ...this.options, ...options };

    try {
      if (opts.cache) {
        const cached = this.getFromCache(filePath, opts.cacheTTL);
        if (cached) return cached;
      }

      throw new Error('File loading requires Node.js fs module - TODO: implement');
    } catch (error) {
      throw new GraphLoadError(`Failed to load graph from file: ${filePath}`, filePath, error);
    }
  }

  /**
   * Load graph from URL
   */
  async loadFromURL(url: string, options?: LoaderOptions): Promise<GraphDefinition> {
    const opts = { ...this.options, ...options };

    try {
      if (opts.cache) {
        const cached = this.getFromCache(url, opts.cacheTTL);
        if (cached) return cached;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), opts.timeout);

      let response: Response;
      let lastError: Error | null = null;
      const maxRetries = opts.retries || 1;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          response = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' },
          });
          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const contentType = response.headers.get('content-type');
          let data: unknown;

          if (contentType?.includes('application/json')) {
            data = await response.json();
          } else {
            const text = await response.text();
            data = this.parseContent(text, url);
          }

          const graph = await this.loadFromObject(data, opts);

          if (opts.cache) {
            this.addToCache(url, graph);
          }

          return graph;
        } catch (error) {
          lastError = error as Error;
          if (attempt < maxRetries - 1) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      throw lastError || new Error('Failed to fetch graph');
    } catch (error) {
      throw new GraphLoadError(`Failed to load graph from URL: ${url}`, url, error);
    }
  }

  /**
   * Load graph from JavaScript object
   */
  async loadFromObject(obj: unknown, options?: LoaderOptions): Promise<GraphDefinition> {
    const opts = { ...this.options, ...options };

    try {
      if (opts.validate !== false) {
        const result = validateGraphDefinition(obj);

        if (!result.valid) {
          throw new Error(
            `Graph validation failed: ${result.errors?.errors.map((e) => e.message).join(', ')}`
          );
        }

        const graph = result.data!;

        if (!opts.allowCycles) {
          const { hasCycles, cycles } = await this.detectCycles(graph);
          if (hasCycles) {
            throw new Error(`Graph contains cycles: ${cycles.map((c) => c.join(' -> ')).join('; ')}`);
          }
        }

        if (!opts.allowUnreachable) {
          const unreachable = this.detectUnreachableNodes(graph);
          if (unreachable.length > 0) {
            throw new Error(`Graph contains unreachable nodes: ${unreachable.join(', ')}`);
          }
        }

        return graph;
      } else {
        return GraphDefinitionSchema.parse(obj);
      }
    } catch (error) {
      throw new GraphLoadError('Failed to load graph from object', 'object', error);
    }
  }

  /**
   * Load graph from JSON string
   */
  async loadFromJSON(json: string, options?: LoaderOptions): Promise<GraphDefinition> {
    try {
      const obj = JSON.parse(json);
      return this.loadFromObject(obj, options);
    } catch (error) {
      throw new GraphLoadError('Failed to parse JSON', 'json-string', error);
    }
  }

  /**
   * Load graph from YAML string
   */
  async loadFromYAML(yaml: string, options?: LoaderOptions): Promise<GraphDefinition> {
    try {
      throw new Error('YAML parsing not yet implemented - TODO: add yaml parser');
    } catch (error) {
      throw new GraphLoadError('Failed to parse YAML', 'yaml-string', error);
    }
  }

  /**
   * Parse content based on format detection
   */
  private parseContent(content: string, source: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      // Not JSON
    }

    if (content.includes('\n- ') || content.includes('\n  ') || content.match(/^\w+:/)) {
      throw new Error('YAML format detected but not yet supported - TODO: implement');
    }

    throw new Error(`Unable to parse content from ${source}: unknown format`);
  }

  /**
   * Detect cycles
   */
  private async detectCycles(graph: GraphDefinition): Promise<{ hasCycles: boolean; cycles: string[][] }> {
    const adjacencyList = new Map<string, string[]>();

    for (const edge of graph.edges) {
      if (!adjacencyList.has(edge.from)) adjacencyList.set(edge.from, []);

      if (edge.type === 'direct') {
        adjacencyList.get(edge.from)!.push(edge.to);
      } else if (edge.type === 'conditional') {
        for (const condition of edge.conditions) {
          adjacencyList.get(edge.from)!.push(condition.to);
        }
        if (edge.default) adjacencyList.get(edge.from)!.push(edge.default);
      } else if (edge.type === 'parallel') {
        adjacencyList.get(edge.from)!.push(...edge.to);
      }
    }

    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[][] = [];
    const path: string[] = [];

    function dfs(node: string): void {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const neighbors = adjacencyList.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recursionStack.has(neighbor)) {
          const cycleStart = path.indexOf(neighbor);
          cycles.push([...path.slice(cycleStart), neighbor]);
        }
      }

      path.pop();
      recursionStack.delete(node);
    }

    dfs(graph.entryPoint);

    return { hasCycles: cycles.length > 0, cycles };
  }

  /**
   * Detect unreachable nodes
   */
  private detectUnreachableNodes(graph: GraphDefinition): string[] {
    const reachable = new Set<string>();
    const queue = [graph.entryPoint];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;

      reachable.add(current);

      for (const edge of graph.edges) {
        if (edge.from === current) {
          if (edge.type === 'direct') queue.push(edge.to);
          else if (edge.type === 'conditional') {
            for (const condition of edge.conditions) queue.push(condition.to);
            if (edge.default) queue.push(edge.default);
          } else if (edge.type === 'parallel') queue.push(...edge.to);
        }
      }
    }

    const allNodes = new Set(graph.nodes.map((n) => n.name));
    return Array.from(allNodes).filter((node) => !reachable.has(node));
  }

  /**
   * Get from cache
   */
  private getFromCache(source: string, ttl?: number): GraphDefinition | null {
    const entry = this.cache.get(source);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    const maxAge = ttl || 60000;

    if (age > maxAge) {
      this.cache.delete(source);
      return null;
    }

    return entry.graph;
  }

  /**
   * Add to cache
   */
  private addToCache(source: string, graph: GraphDefinition): void {
    this.cache.set(source, { graph, timestamp: Date.now(), source });
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; entries: Array<{ source: string; age: number }> } {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([source, entry]) => ({
      source,
      age: now - entry.timestamp,
    }));

    return { size: this.cache.size, entries };
  }
}

/**
 * Convenience function to load graph from any source
 */
export async function loadGraph(
  source: string | unknown,
  options?: LoaderOptions
): Promise<GraphDefinition> {
  const loader = new GraphLoader(options);

  if (typeof source === 'string') {
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return loader.loadFromURL(source, options);
    } else if (source.startsWith('{') || source.startsWith('[')) {
      return loader.loadFromJSON(source, options);
    } else {
      return loader.loadFromFile(source, options);
    }
  } else {
    return loader.loadFromObject(source, options);
  }
}

/**
 * Load multiple graphs
 */
export async function loadGraphs(
  sources: Array<string | unknown>,
  options?: LoaderOptions
): Promise<GraphDefinition[]> {
  const graphs: GraphDefinition[] = [];

  for (const source of sources) {
    const graph = await loadGraph(source, options);
    graphs.push(graph);
  }

  return graphs;
}
