/**
 * SubgraphExecution.ts
 *
 * Graph-of-graphs infrastructure:
 * - SubgraphRegistry: named graph storage + execution
 * - SpawnBridge: transition from graph execution to A2A bounded pool
 * - Input/output mapping between parent and child graphs
 * - Recursion depth enforcement
 */

import { createGraphExecutor, ExecutionResult } from './GraphExecution';

// --- Errors ---

/** Executes a subgraph as a single node within a parent graph. */
export class SubgraphExecutionError extends Error {
  constructor(message: string, public subgraphName?: string, public cause?: Error) {
    super(message);
    this.name = 'SubgraphExecutionError';
  }
}

// --- SubgraphRegistry ---

export interface SubgraphExecuteOptions {
  inputMapping?: (parentState: any) => any;
  outputMapping?: (subgraphState: any) => any;
  maxDepth?: number;
}

export interface SubgraphRegistry {
  register(name: string, buildFn: () => any): void;
  unregister(name: string): void;
  has(name: string): boolean;
  list(): string[];
  execute(name: string, state: any, options?: SubgraphExecuteOptions): Promise<ExecutionResult>;
}

export function createSubgraphRegistry(): SubgraphRegistry {
  const registry = new Map<string, () => any>();
  const executor = createGraphExecutor();
  let currentDepth = 0;
  let activeMaxDepth = 50;

  const self: SubgraphRegistry = {
    register(name: string, buildFn: () => any): void {
      registry.set(name, buildFn);
    },

    unregister(name: string): void {
      registry.delete(name);
    },

    has(name: string): boolean {
      return registry.has(name);
    },

    list(): string[] {
      return Array.from(registry.keys());
    },

    async execute(name: string, state: any, options?: SubgraphExecuteOptions): Promise<ExecutionResult> {
      const buildFn = registry.get(name);
      if (!buildFn) {
        throw new SubgraphExecutionError(`Subgraph "${name}" not found`, name);
      }

      // Set maxDepth on first call; recursive calls inherit it
      if (currentDepth === 0 && options?.maxDepth !== undefined) {
        activeMaxDepth = options.maxDepth;
      }

      currentDepth++;

      if (currentDepth > activeMaxDepth) {
        currentDepth--;
        throw new SubgraphExecutionError(
          `Max recursion depth (${activeMaxDepth}) exceeded while executing subgraph "${name}"`,
          name
        );
      }

      try {
        const graph = buildFn();
        const inputState = options?.inputMapping ? options.inputMapping(state) : state;
        const result = await executor.execute(graph, inputState);

        if (options?.outputMapping && !result.error) {
          return {
            ...result,
            finalState: options.outputMapping(result.finalState),
          };
        }

        return result;
      } finally {
        currentDepth--;
        if (currentDepth === 0) {
          activeMaxDepth = 50; // reset for next top-level call
        }
      }
    },
  };

  return self;
}

// --- SpawnBridge ---

export interface SpawnConfig {
  name: string;
  input: any;
  lifecycle: 'one-shot' | 'persistent' | 'until-idle';
}

export interface SpawnResult {
  agentId: string;
  status: 'completed' | 'failed';
  output: any;
}

export interface SpawnBackend {
  spawn(config: SpawnConfig): Promise<SpawnResult>;
  spawnPool(configs: SpawnConfig[], concurrency: number): Promise<SpawnResult[]>;
}

export interface SpawnBridge {
  spawn(config: SpawnConfig): Promise<SpawnResult>;
  spawnPool(configs: SpawnConfig[], concurrency: number): Promise<SpawnResult[]>;
}

export function createSpawnBridge(backend: SpawnBackend): SpawnBridge {
  return {
    async spawn(config: SpawnConfig): Promise<SpawnResult> {
      return backend.spawn(config);
    },

    async spawnPool(configs: SpawnConfig[], concurrency: number): Promise<SpawnResult[]> {
      const results: SpawnResult[] = [];

      for (let i = 0; i < configs.length; i += concurrency) {
        const batch = configs.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(config => backend.spawn(config))
        );
        results.push(...batchResults);
      }

      return results;
    },
  };
}
