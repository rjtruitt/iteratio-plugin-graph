import { describe, it, expect, beforeEach } from 'vitest';
import type { ConfigStore, ConfigFieldSpec, ConfigLocation } from '../ConfigStore.js';
import { createConfigStore } from '../ConfigStore.js';
import type {
  VectorEntry,
  VectorSearchResult,
  VectorStoreConfig,
  EmbeddingProvider,
} from '../VectorStore.js';
import { VectorStore } from '../VectorStore.js';

// --- Reuse the SemanticEmbeddingProvider from the semantic search tests ---

const CONCEPT_DIMENSIONS = 20;

const CONCEPT_KEYWORDS: Record<number, string[]> = {
  0: ['salesforce', 'apex', 'soql', 'sobject', 'trigger', 'lwc', 'visualforce', 'sf'],
  1: ['javascript', 'typescript', 'js', 'ts', 'node', 'npm', 'esm', 'module'],
  2: ['database', 'sql', 'query', 'table', 'schema', 'index', 'postgres', 'migration'],
  3: ['authentication', 'auth', 'login', 'oauth', 'token', 'session', 'sso', 'credential'],
  4: ['deployment', 'deploy', 'production', 'release', 'ci', 'cd', 'pipeline', 'build'],
  5: ['api', 'endpoint', 'rest', 'graphql', 'request', 'response', 'http', 'route'],
  6: ['testing', 'test', 'unit', 'integration', 'mock', 'assert', 'coverage', 'spec'],
  7: ['documentation', 'docs', 'readme', 'wiki', 'confluence', 'page', 'guide'],
  8: ['scheduling', 'schedule', 'cron', 'interval', 'timer', 'batch', 'job', 'queue'],
  9: ['configuration', 'config', 'settings', 'env', 'yaml', 'toml', 'properties'],
  10: ['monitoring', 'monitor', 'alert', 'metric', 'log', 'observability', 'dashboard'],
  11: ['caching', 'cache', 'redis', 'memcached', 'ttl', 'invalidation', 'store'],
  12: ['networking', 'network', 'dns', 'proxy', 'load-balancer', 'cdn', 'ssl', 'tls'],
  13: ['security', 'vulnerability', 'encryption', 'firewall', 'audit', 'compliance'],
  14: ['ui', 'component', 'react', 'css', 'layout', 'render', 'dom', 'frontend'],
  15: ['data-pipeline', 'etl', 'transform', 'stream', 'kafka', 'ingestion', 'warehouse'],
  16: ['verification', 'verify', 'validate', 'check', 'hallucination', 'claim', 'fact'],
  17: ['sync', 'synchronize', 'source', 'import', 'export', 'merge', 'diff'],
  18: ['workflow', 'graph', 'node', 'edge', 'execution', 'state', 'transition'],
  19: ['cost', 'token', 'usage', 'billing', 'budget', 'expensive', 'optimization'],
};

function deterministicNoise(text: string, dimension: number): number {
  let h = 2166136261;
  const combined = `${text}:${dimension}`;
  for (let i = 0; i < combined.length; i++) {
    h ^= combined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 0.05 + ((Math.abs(h) % 100) / 100) * 0.1;
}

function normalize(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

function generateSemanticEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  const vec = new Array(CONCEPT_DIMENSIONS).fill(0);
  for (let dim = 0; dim < CONCEPT_DIMENSIONS; dim++) {
    const keywords = CONCEPT_KEYWORDS[dim];
    const matched = keywords.some((kw) => lower.includes(kw));
    vec[dim] = matched ? 1.0 : deterministicNoise(text, dim);
  }
  return normalize(vec);
}

class SemanticEmbeddingProvider implements EmbeddingProvider {
  dimensions = CONCEPT_DIMENSIONS;
  async embed(text: string): Promise<number[]> {
    return generateSemanticEmbedding(text);
  }
}

// --- Tests ---

describe('ConfigStore', () => {
  let configStore: ConfigStore;
  let vectorStore: VectorStore;
  let provider: SemanticEmbeddingProvider;

  beforeEach(() => {
    provider = new SemanticEmbeddingProvider();
    vectorStore = new VectorStore(
      { table: 'config_test', dimensions: CONCEPT_DIMENSIONS },
      provider,
    );
    configStore = createConfigStore({ vectorStore, filePath: '.arma.workflow' });
  });

  // ------------------------------------------------------------------
  // Field spec queries
  // ------------------------------------------------------------------
  describe('Field specs', () => {
    it('getFieldSpecs returns all known specs', () => {
      const specs = configStore.getFieldSpecs();
      expect(specs.length).toBeGreaterThanOrEqual(11);

      const keys = specs.map((s) => s.key);
      expect(keys).toContain('schedule');
      expect(keys).toContain('agents');
      expect(keys).toContain('inputs');
      expect(keys).toContain('memory.terminology');
      expect(keys).toContain('memory.rules');
      expect(keys).toContain('pipeline');
      expect(keys).toContain('drift_snapshots');
      expect(keys).toContain('embeddings');
      expect(keys).toContain('tool_call_history');
      expect(keys).toContain('verification_results');
      expect(keys).toContain('graphs');
    });

    it('getFileFields returns only file-location fields (including "both")', () => {
      const fileFields = configStore.getFileFields();
      expect(fileFields).toContain('schedule');
      expect(fileFields).toContain('agents');
      expect(fileFields).toContain('inputs');
      expect(fileFields).toContain('memory.terminology');
      expect(fileFields).toContain('memory.rules');
      expect(fileFields).toContain('pipeline');
      expect(fileFields).toContain('graphs'); // 'both' includes file
      expect(fileFields).not.toContain('drift_snapshots');
      expect(fileFields).not.toContain('embeddings');
    });

    it('getVectorFields returns only vectorstore-location fields (including "both")', () => {
      const vectorFields = configStore.getVectorFields();
      expect(vectorFields).toContain('drift_snapshots');
      expect(vectorFields).toContain('embeddings');
      expect(vectorFields).toContain('tool_call_history');
      expect(vectorFields).toContain('verification_results');
      expect(vectorFields).toContain('graphs'); // 'both' includes vectorstore
      expect(vectorFields).not.toContain('schedule');
      expect(vectorFields).not.toContain('agents');
    });
  });

  // ------------------------------------------------------------------
  // Set and Get
  // ------------------------------------------------------------------
  describe('set and get', () => {
    it('set to file field stores in memory map, get retrieves it', async () => {
      await configStore.set('schedule', { interval_hours: 4, cron: '0 */4 * * *', catch_up: true });
      const value = await configStore.get('schedule');
      expect(value).toEqual({ interval_hours: 4, cron: '0 */4 * * *', catch_up: true });
    });

    it('set to vector field stores in vector store', async () => {
      await configStore.set('drift_snapshots', 'OppyHub syncs 3 sources as of 2024-01-01');
      const value = await configStore.get('drift_snapshots');
      expect(value).toBe('OppyHub syncs 3 sources as of 2024-01-01');
    });

    it('set to "both" field stores in both locations', async () => {
      const graphDef = { name: 'auth-graph', nodes: ['fetch', 'validate', 'store'], edges: [['fetch', 'validate'], ['validate', 'store']] };
      await configStore.set('graphs', graphDef);

      // Should be retrievable (file takes precedence)
      const value = await configStore.get('graphs');
      expect(value).toEqual(graphDef);

      // Should also be in vector store
      const vectorEntry = await vectorStore.get('config:graphs');
      expect(vectorEntry).not.toBeNull();
      expect(JSON.parse(vectorEntry!.content)).toEqual(graphDef);
    });

    it('get returns null for unset key', async () => {
      const value = await configStore.get('schedule');
      expect(value).toBeNull();
    });

    it('set with object value serializes to JSON in vector store', async () => {
      const history = { tool: 'confluence.getPage', cost: 0.003, timestamp: '2024-01-01T00:00:00Z' };
      await configStore.set('tool_call_history', history);

      const entry = await vectorStore.get('config:tool_call_history');
      expect(entry).not.toBeNull();
      expect(JSON.parse(entry!.content)).toEqual(history);
    });

    it('set with string value stores raw string in vector store', async () => {
      await configStore.set('embeddings', 'verified claim: OppyHub syncs data from three sources');

      const entry = await vectorStore.get('config:embeddings');
      expect(entry).not.toBeNull();
      expect(entry!.content).toBe('verified claim: OppyHub syncs data from three sources');
    });

    it('get for "both" field returns file value (file takes precedence)', async () => {
      // Set via configStore which writes to both
      await configStore.set('graphs', { name: 'test-graph' });

      // File value should be returned
      const value = await configStore.get('graphs');
      expect(value).toEqual({ name: 'test-graph' });
    });

    it('set preserves metadata in vector store entries', async () => {
      await configStore.set('drift_snapshots', 'snapshot data', { version: 3, source: 'auto' });

      const entry = await vectorStore.get('config:drift_snapshots');
      expect(entry).not.toBeNull();
      expect(entry!.metadata.configField).toBe(true);
      expect(entry!.metadata.configKey).toBe('drift_snapshots');
      expect(entry!.metadata.version).toBe(3);
      expect(entry!.metadata.source).toBe('auto');
    });
  });

  // ------------------------------------------------------------------
  // searchConfig
  // ------------------------------------------------------------------
  describe('searchConfig', () => {
    beforeEach(async () => {
      // Populate vector store with various config entries
      await configStore.set('drift_snapshots', 'OppyHub authentication flow changed: now uses OAuth 2.0 tokens');
      await configStore.set('embeddings', 'Verified: deployment pipeline runs automated tests before release');
      await configStore.set('tool_call_history', 'Called confluence.getPage for documentation retrieval');
      await configStore.set('verification_results', 'Hallucination check passed: database schema claim verified');

      // Also set a 'both' field so it's in vector store too
      await configStore.set('graphs', JSON.stringify({ name: 'auth-verification-graph', handles: 'authentication verification workflow' }));
    });

    it('finds semantically related config entries', async () => {
      const results = await configStore.searchConfig('OAuth authentication token', 0.4);
      expect(results.length).toBeGreaterThan(0);

      const keys = results.map((r) => r.key);
      expect(keys).toContain('drift_snapshots'); // mentions auth + OAuth
    });

    it('returns similarity scores', async () => {
      const results = await configStore.searchConfig('deployment pipeline testing', 0.4);
      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        expect(r.similarity).toBeGreaterThanOrEqual(0.4);
        expect(typeof r.similarity).toBe('number');
      }
    });

    it('respects threshold parameter', async () => {
      const looseResults = await configStore.searchConfig('deployment', 0.3);
      const strictResults = await configStore.searchConfig('deployment', 0.8);

      expect(looseResults.length).toBeGreaterThanOrEqual(strictResults.length);
    });

    it('returns empty array when nothing matches', async () => {
      const results = await configStore.searchConfig('quantum physics laser beam', 0.9);
      expect(results).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  // migrate
  // ------------------------------------------------------------------
  describe('migrate', () => {
    it('migrate file → vectorstore moves data correctly', async () => {
      // Set in file location
      await configStore.set('schedule', { interval_hours: 6 });

      // Verify it's in file
      const beforeMigrate = await configStore.get('schedule');
      expect(beforeMigrate).toEqual({ interval_hours: 6 });

      // Migrate to vectorstore
      await configStore.migrate('schedule', 'vectorstore');

      // Should now be retrievable from vector store
      const afterMigrate = await configStore.get('schedule');
      expect(afterMigrate).toEqual({ interval_hours: 6 });

      // Field spec should reflect new location
      const specs = configStore.getFieldSpecs();
      const scheduleSpec = specs.find((s) => s.key === 'schedule');
      expect(scheduleSpec?.location).toBe('vectorstore');

      // Should now appear in vectorFields
      expect(configStore.getVectorFields()).toContain('schedule');
      expect(configStore.getFileFields()).not.toContain('schedule');
    });

    it('migrate vectorstore → file moves data correctly', async () => {
      // Set in vectorstore location
      await configStore.set('drift_snapshots', 'snapshot at t=100');

      // Migrate to file
      await configStore.migrate('drift_snapshots', 'file');

      // Should now be retrievable from file store
      const value = await configStore.get('drift_snapshots');
      expect(value).toBe('snapshot at t=100');

      // Field spec should reflect new location
      const specs = configStore.getFieldSpecs();
      const driftSpec = specs.find((s) => s.key === 'drift_snapshots');
      expect(driftSpec?.location).toBe('file');

      // Should now appear in fileFields
      expect(configStore.getFileFields()).toContain('drift_snapshots');
      expect(configStore.getVectorFields()).not.toContain('drift_snapshots');
    });

    it('migrate to same location is a no-op', async () => {
      await configStore.set('schedule', { interval_hours: 2 });
      await configStore.migrate('schedule', 'file'); // already file

      const value = await configStore.get('schedule');
      expect(value).toEqual({ interval_hours: 2 });
    });

    it('migrate unknown key throws error', async () => {
      await expect(
        configStore.migrate('nonexistent_field', 'vectorstore'),
      ).rejects.toThrow('Unknown config field: nonexistent_field');
    });

    it('migrate file → both writes to both locations', async () => {
      await configStore.set('pipeline', { stages: ['fetch', 'verify', 'write'] });
      await configStore.migrate('pipeline', 'both');

      // File store should have it
      const value = await configStore.get('pipeline');
      expect(value).toEqual({ stages: ['fetch', 'verify', 'write'] });

      // Vector store should also have it
      const entry = await vectorStore.get('config:pipeline');
      expect(entry).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // exportAll
  // ------------------------------------------------------------------
  describe('exportAll', () => {
    it('merges file and vector store values', async () => {
      await configStore.set('schedule', { interval_hours: 4 });
      await configStore.set('agents', [{ name: 'doc-bot', model: 'claude-4' }]);
      await configStore.set('drift_snapshots', 'current state of sync');
      await configStore.set('embeddings', 'verified claims data');
      await configStore.set('graphs', { name: 'main-workflow' });

      const exported = await configStore.exportAll();

      expect(exported.schedule).toEqual({ interval_hours: 4 });
      expect(exported.agents).toEqual([{ name: 'doc-bot', model: 'claude-4' }]);
      expect(exported.drift_snapshots).toBe('current state of sync');
      expect(exported.embeddings).toBe('verified claims data');
      expect(exported.graphs).toEqual({ name: 'main-workflow' });
    });

    it('file values take precedence over vector store for "both" fields', async () => {
      await configStore.set('graphs', { name: 'from-file' });

      const exported = await configStore.exportAll();
      expect(exported.graphs).toEqual({ name: 'from-file' });
    });

    it('returns empty object when nothing is set', async () => {
      const exported = await configStore.exportAll();
      expect(exported).toEqual({});
    });

    it('includes values from all locations', async () => {
      // Set one field in each location type
      await configStore.set('schedule', 'every 4 hours');
      await configStore.set('drift_snapshots', 'latest drift');
      await configStore.set('graphs', 'auth graph definition');

      const exported = await configStore.exportAll();
      expect(Object.keys(exported).length).toBe(3);
      expect(exported.schedule).toBe('every 4 hours');
      expect(exported.drift_snapshots).toBe('latest drift');
      expect(exported.graphs).toBe('auth graph definition');
    });
  });
});
