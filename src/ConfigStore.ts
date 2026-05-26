/**
 * ConfigStore — manages which workflow settings live in the VectorStore
 * (for semantic retrieval) vs. plain YAML files (for human editing).
 */

import type { VectorStore, VectorSearchResult } from './VectorStore.js';

// --- Types ---

export type ConfigLocation = 'vectorstore' | 'file' | 'both';

export interface ConfigFieldSpec {
  key: string;
  location: ConfigLocation;
  description: string;
  mutable: boolean;
}

/** Persistent store for graph workflow configuration with vector and file backends. */
export interface ConfigStoreOptions {
  vectorStore: VectorStore;
  filePath?: string; // path to .arma.workflow YAML
}

export interface ConfigStore {
  getFieldSpecs(): ConfigFieldSpec[];
  getFileFields(): string[];
  getVectorFields(): string[];
  set(key: string, value: unknown, metadata?: Record<string, unknown>): Promise<void>;
  get(key: string): Promise<unknown | null>;
  searchConfig(query: string, threshold?: number): Promise<Array<{ key: string; value: unknown; similarity: number }>>;
  migrate(key: string, to: ConfigLocation): Promise<void>;
  exportAll(): Promise<Record<string, unknown>>;
}

// --- Default Field Specs ---

const DEFAULT_FIELD_SPECS: ConfigFieldSpec[] = [
  // File (YAML) — human-editable
  { key: 'schedule', location: 'file', description: 'Scheduling: interval_hours, cron, catch_up', mutable: true },
  { key: 'agents', location: 'file', description: 'Agent definitions, models, providers', mutable: true },
  { key: 'inputs', location: 'file', description: 'Workflow inputs: parentPageId, spaceId, cloudId', mutable: true },
  { key: 'memory.terminology', location: 'file', description: 'Domain-specific terminology definitions', mutable: true },
  { key: 'memory.rules', location: 'file', description: 'Operating rules and constraints', mutable: true },
  { key: 'pipeline', location: 'file', description: 'Graph execution order and stage definitions', mutable: true },

  // VectorStore — computed/cached
  { key: 'drift_snapshots', location: 'vectorstore', description: 'Content state snapshots over time for drift detection', mutable: false },
  { key: 'embeddings', location: 'vectorstore', description: 'Verified claims, cached tool results as embeddings', mutable: false },
  { key: 'tool_call_history', location: 'vectorstore', description: 'Historical tool calls with timestamps and cost', mutable: false },
  { key: 'verification_results', location: 'vectorstore', description: 'Hallucination check outcomes and verification state', mutable: false },

  // Both (synced)
  { key: 'graphs', location: 'both', description: 'Graph definitions: defined in YAML, indexed in vector store for semantic search', mutable: true },
];

// --- Implementation ---

/** Creates a configuration store backed by the specified location. */
export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  const { vectorStore } = options;

  // In-memory map simulates YAML file storage
  const fileStore = new Map<string, unknown>();

  // Mutable copy of field specs (can change via migrate)
  const fieldSpecs = [...DEFAULT_FIELD_SPECS];

  function getSpecForKey(key: string): ConfigFieldSpec | undefined {
    return fieldSpecs.find((spec) => spec.key === key);
  }

  function getLocationForKey(key: string): ConfigLocation {
    const spec = getSpecForKey(key);
    return spec?.location ?? 'file';
  }

  return {
    getFieldSpecs(): ConfigFieldSpec[] {
      return [...fieldSpecs];
    },

    getFileFields(): string[] {
      return fieldSpecs
        .filter((s) => s.location === 'file' || s.location === 'both')
        .map((s) => s.key);
    },

    getVectorFields(): string[] {
      return fieldSpecs
        .filter((s) => s.location === 'vectorstore' || s.location === 'both')
        .map((s) => s.key);
    },

    async set(key: string, value: unknown, metadata?: Record<string, unknown>): Promise<void> {
      const location = getLocationForKey(key);

      if (location === 'file' || location === 'both') {
        fileStore.set(key, value);
      }

      if (location === 'vectorstore' || location === 'both') {
        const content = typeof value === 'string' ? value : JSON.stringify(value);
        await vectorStore.upsert(`config:${key}`, content, {
          ...metadata,
          configField: true,
          configKey: key,
        });
      }
    },

    async get(key: string): Promise<unknown | null> {
      const location = getLocationForKey(key);

      // Check file first (for 'file' and 'both')
      if (location === 'file' || location === 'both') {
        const fileValue = fileStore.get(key);
        if (fileValue !== undefined) {
          return fileValue;
        }
      }

      // Fall through to vector store
      if (location === 'vectorstore' || location === 'both') {
        const entry = await vectorStore.get(`config:${key}`);
        if (entry) {
          // Try to parse JSON, fall back to raw string
          try {
            return JSON.parse(entry.content);
          } catch {
            return entry.content;
          }
        }
      }

      return null;
    },

    async searchConfig(query: string, threshold = 0.5): Promise<Array<{ key: string; value: unknown; similarity: number }>> {
      const results = await vectorStore.search(query, { threshold, limit: 20 });

      // Filter to only config entries
      const configResults = results.filter(
        (r) => r.entry.metadata.configField === true,
      );

      return configResults.map((r) => {
        const key = r.entry.metadata.configKey as string;
        let value: unknown;
        try {
          value = JSON.parse(r.entry.content);
        } catch {
          value = r.entry.content;
        }
        return { key, value, similarity: r.similarity };
      });
    },

    async migrate(key: string, to: ConfigLocation): Promise<void> {
      const specIndex = fieldSpecs.findIndex((s) => s.key === key);
      if (specIndex === -1) {
        throw new Error(`Unknown config field: ${key}`);
      }

      const currentSpec = fieldSpecs[specIndex];
      const currentLocation = currentSpec.location;

      if (currentLocation === to) {
        return; // Already in target location
      }

      // Read current value from wherever it currently lives
      let currentValue: unknown = null;

      if (currentLocation === 'file' || currentLocation === 'both') {
        currentValue = fileStore.get(key) ?? null;
      }

      if (currentValue === null && (currentLocation === 'vectorstore' || currentLocation === 'both')) {
        const entry = await vectorStore.get(`config:${key}`);
        if (entry) {
          try {
            currentValue = JSON.parse(entry.content);
          } catch {
            currentValue = entry.content;
          }
        }
      }

      // Remove from old location
      if (currentLocation === 'file' || currentLocation === 'both') {
        fileStore.delete(key);
      }
      if (currentLocation === 'vectorstore' || currentLocation === 'both') {
        await vectorStore.delete(`config:${key}`);
      }

      // Update the spec
      fieldSpecs[specIndex] = { ...currentSpec, location: to };

      // Write to new location (if we have a value)
      if (currentValue !== null) {
        if (to === 'file' || to === 'both') {
          fileStore.set(key, currentValue);
        }
        if (to === 'vectorstore' || to === 'both') {
          const content = typeof currentValue === 'string' ? currentValue : JSON.stringify(currentValue);
          await vectorStore.upsert(`config:${key}`, content, {
            configField: true,
            configKey: key,
          });
        }
      }
    },

    async exportAll(): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {};

      // Gather all file-stored values
      for (const [key, value] of fileStore.entries()) {
        result[key] = value;
      }

      // Gather all vector-stored config values
      const vectorFields = fieldSpecs.filter(
        (s) => s.location === 'vectorstore' || s.location === 'both',
      );

      for (const spec of vectorFields) {
        if (result[spec.key] !== undefined) {
          continue; // File value takes precedence (already set)
        }
        const entry = await vectorStore.get(`config:${spec.key}`);
        if (entry) {
          try {
            result[spec.key] = JSON.parse(entry.content);
          } catch {
            result[spec.key] = entry.content;
          }
        }
      }

      return result;
    },
  };
}
