import { describe, it, expect, beforeEach } from 'vitest';
import type {
  VectorEntry,
  VectorSearchResult,
  VectorStoreConfig,
  EmbeddingProvider,
} from '../VectorStore.js';
import { VectorStore, cosineSimilarity, hashContent } from '../VectorStore.js';

// --- Semantic Embedding Provider ---
// Maps keyword presence to concept dimensions, producing deterministic
// unit-vector embeddings where semantically related content has high cosine similarity.

const CONCEPT_DIMENSIONS = 20;

const CONCEPT_KEYWORDS: Record<number, string[]> = {
  0: ['salesforce', 'apex', 'soql', 'sobject', 'trigger', 'lwc', 'visualforce', 'sf'],
  1: ['javascript', 'typescript', 'js', 'ts', 'node', 'npm', 'esm', 'module'],
  2: ['database', 'sql', 'query', 'table', 'schema', 'index', 'postgres', 'migration', 'optimization'],
  3: ['authentication', 'auth', 'login', 'oauth', 'token', 'session', 'sso', 'credential', 'password'],
  4: ['deployment', 'deploy', 'production', 'release', 'ci', 'cd', 'pipeline', 'build', 'artifact'],
  5: ['api', 'endpoint', 'rest', 'graphql', 'request', 'response', 'http', 'route'],
  6: ['testing', 'test', 'unit', 'integration', 'mock', 'assert', 'coverage', 'spec'],
  7: ['documentation', 'docs', 'readme', 'wiki', 'confluence', 'page', 'guide'],
  8: ['scheduling', 'schedule', 'cron', 'interval', 'timer', 'batch', 'job', 'queue'],
  9: ['configuration', 'config', 'settings', 'env', 'yaml', 'toml', 'properties'],
  10: ['monitoring', 'monitor', 'alert', 'metric', 'log', 'observability', 'dashboard', 'health'],
  11: ['caching', 'cache', 'redis', 'memcached', 'ttl', 'invalidation', 'store'],
  12: ['networking', 'network', 'dns', 'proxy', 'load-balancer', 'cdn', 'ssl', 'tls'],
  13: ['security', 'vulnerability', 'encryption', 'firewall', 'audit', 'compliance', 'permission'],
  14: ['ui', 'component', 'react', 'css', 'layout', 'render', 'dom', 'frontend', 'button'],
  15: ['data-pipeline', 'etl', 'transform', 'stream', 'kafka', 'ingestion', 'warehouse'],
  16: ['verification', 'verify', 'validate', 'check', 'hallucination', 'claim', 'fact'],
  17: ['sync', 'synchronize', 'source', 'import', 'export', 'merge', 'diff'],
  18: ['workflow', 'graph', 'node', 'edge', 'execution', 'state', 'transition'],
  19: ['cost', 'token', 'usage', 'billing', 'budget', 'expensive', 'optimization', 'efficient'],
};

/**
 * Deterministic hash for a string → small number for noise generation.
 * Uses a simple FNV-1a-like hash to avoid randomness in tests.
 */
function deterministicNoise(text: string, dimension: number): number {
  let h = 2166136261;
  const combined = `${text}:${dimension}`;
  for (let i = 0; i < combined.length; i++) {
    h ^= combined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map to 0.05 - 0.15 range
  return 0.05 + ((Math.abs(h) % 100) / 100) * 0.1;
}

/**
 * Normalize a vector to unit length.
 */
function normalize(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

/**
 * Given text, produce a deterministic embedding that encodes concept presence.
 * Dimensions corresponding to matched keywords get 1.0; others get small noise.
 */
function generateSemanticEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  const vec = new Array(CONCEPT_DIMENSIONS).fill(0);

  for (let dim = 0; dim < CONCEPT_DIMENSIONS; dim++) {
    const keywords = CONCEPT_KEYWORDS[dim];
    const matched = keywords.some((kw) => lower.includes(kw));
    if (matched) {
      vec[dim] = 1.0;
    } else {
      vec[dim] = deterministicNoise(text, dim);
    }
  }

  return normalize(vec);
}

/**
 * SemanticEmbeddingProvider: deterministic, keyword-based concept embeddings.
 */
class SemanticEmbeddingProvider implements EmbeddingProvider {
  dimensions = CONCEPT_DIMENSIONS;

  async embed(text: string): Promise<number[]> {
    return generateSemanticEmbedding(text);
  }
}

// --- Test Suite ---

describe('VectorStore Semantic Search', () => {
  let store: VectorStore;
  let provider: SemanticEmbeddingProvider;

  beforeEach(async () => {
    provider = new SemanticEmbeddingProvider();
    store = new VectorStore(
      { table: 'semantic_test', dimensions: CONCEPT_DIMENSIONS },
      provider,
    );
  });

  // ------------------------------------------------------------------
  // Document retrieval by topic
  // ------------------------------------------------------------------
  describe('Document retrieval by topic', () => {
    const corpus = [
      { id: 'sf-config', content: 'Salesforce org configuration with custom objects, triggers, and SOQL queries for OppyHub' },
      { id: 'js-testing', content: 'JavaScript unit testing with vitest, mock assertions, and integration test coverage' },
      { id: 'api-endpoints', content: 'REST API endpoint documentation for /api/v2/lodging with request and response schemas' },
      { id: 'db-schema', content: 'Database schema with SQL tables, indexes, and query optimization for Postgres migrations' },
      { id: 'deploy-pipeline', content: 'Deployment pipeline to production using CI/CD build artifacts and release automation' },
      { id: 'auth-flow', content: 'OAuth authentication flow with SSO login, token refresh, and session management' },
      { id: 'monitor-setup', content: 'Monitoring dashboard with alert metrics, health checks, and observability logging' },
      { id: 'cache-strategy', content: 'Redis caching strategy with TTL invalidation and memcached store patterns' },
      { id: 'ui-components', content: 'React UI component library with CSS layout, button rendering, and frontend DOM patterns' },
      { id: 'schedule-jobs', content: 'Cron scheduling for batch jobs with interval timers and queue processing' },
      { id: 'data-etl', content: 'ETL data pipeline with Kafka stream ingestion and warehouse transformation' },
      { id: 'network-infra', content: 'Network infrastructure with DNS, CDN proxy, SSL/TLS load-balancer configuration' },
    ];

    beforeEach(async () => {
      for (const doc of corpus) {
        await store.upsert(doc.id, doc.content, { type: 'documentation' });
      }
    });

    it('search "How does authentication work?" returns auth docs, not deployment', async () => {
      const results = await store.search('How does authentication work?', { threshold: 0.5, limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      const topResult = results[0];
      expect(topResult.entry.id).toBe('auth-flow');

      // Auth doc should score higher than deploy doc
      const authScore = results.find((r) => r.entry.id === 'auth-flow')?.similarity ?? 0;
      const deployScore = results.find((r) => r.entry.id === 'deploy-pipeline')?.similarity ?? 0;
      expect(authScore).toBeGreaterThan(deployScore);
    });

    it('search "database query optimization" returns database docs, not UI', async () => {
      const results = await store.search('database query optimization', { threshold: 0.4, limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      const ids = results.map((r) => r.entry.id);
      expect(ids).toContain('db-schema');

      const dbScore = results.find((r) => r.entry.id === 'db-schema')?.similarity ?? 0;
      const uiScore = results.find((r) => r.entry.id === 'ui-components')?.similarity ?? 0;
      expect(dbScore).toBeGreaterThan(uiScore);
    });

    it('search "deploy to production" returns deployment docs', async () => {
      const results = await store.search('deploy to production', { threshold: 0.4, limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      const topIds = results.slice(0, 3).map((r) => r.entry.id);
      expect(topIds).toContain('deploy-pipeline');
    });

    it('search "caching and Redis" returns cache docs', async () => {
      const results = await store.search('Redis cache TTL invalidation', { threshold: 0.4, limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.id).toBe('cache-strategy');
    });

    it('search "React component rendering" returns UI docs', async () => {
      const results = await store.search('React component rendering frontend', { threshold: 0.4, limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.id).toBe('ui-components');
    });
  });

  // ------------------------------------------------------------------
  // Progressive cost reduction simulation
  // ------------------------------------------------------------------
  describe('Progressive cost reduction simulation', () => {
    const CACHE_HIT_THRESHOLD = 0.92;

    // Base verified claims (what's already in the store)
    const verifiedClaims = [
      'OppyHub synchronizes data from Salesforce, GitHub, and Confluence',
      'The authentication flow uses OAuth 2.0 with token refresh',
      'Deployment runs through a CI/CD pipeline with automated tests',
      'Database migrations are managed with versioned SQL scripts',
      'The REST API exposes endpoints at /api/v2/lodging',
      'Monitoring alerts fire when latency exceeds 500ms threshold',
      'The cache layer uses Redis with a 1-hour TTL for session data',
      'Batch jobs run on a cron schedule every 4 hours',
      'The ETL pipeline ingests data from Kafka streams',
      'Network traffic is routed through a CDN with SSL termination',
    ];

    // Incoming claims that may or may not match verified ones
    const incomingClaimsPerRun = [
      // Run 1: all new, no matches
      [
        'UI components use React with server-side rendering',
        'Security audits happen quarterly with compliance checks',
        'The workflow graph uses state machines for transitions',
      ],
      // Run 2: some similar to verified + run 1
      [
        'OAuth authentication uses token refresh for session management',
        'The caching layer stores session data in Redis',
        'DNS configuration uses CloudFlare as the CDN provider',
      ],
      // Run 3: more overlap
      [
        'The CI/CD deployment pipeline includes automated testing',
        'Database SQL migrations are version controlled',
        'The REST API has /api/v2 endpoints for lodging data',
      ],
      // Run 4: high overlap
      [
        'OAuth 2.0 token refresh handles the authentication flow',
        'Redis cache with TTL for session data storage',
        'Kafka stream ingestion feeds the ETL data pipeline',
      ],
      // Run 5: mostly duplicates of earlier verified claims
      [
        'OppyHub syncs data between Salesforce, GitHub, and Confluence',
        'Automated CI/CD pipeline deploys with test coverage',
        'Cron-scheduled batch jobs execute every 4 hours',
      ],
    ];

    it('cache hit rate increases across workflow runs', async () => {
      // Seed the store with verified claims
      for (let i = 0; i < verifiedClaims.length; i++) {
        await store.upsert(`verified-${i}`, verifiedClaims[i], { verified: true, run: 0 });
      }

      const hitRates: number[] = [];

      for (let run = 0; run < incomingClaimsPerRun.length; run++) {
        const claims = incomingClaimsPerRun[run];
        let hits = 0;

        for (const claim of claims) {
          const results = await store.search(claim, { threshold: CACHE_HIT_THRESHOLD, limit: 1 });
          if (results.length > 0) {
            hits++;
          }
        }

        const hitRate = hits / claims.length;
        hitRates.push(hitRate);

        // Add this run's claims as newly verified (simulates progressive enrichment)
        for (let i = 0; i < claims.length; i++) {
          await store.upsert(`run${run}-claim-${i}`, claims[i], { verified: true, run: run + 1 });
        }
      }

      // Run 1 should have low hit rate (mostly new topics)
      expect(hitRates[0]).toBeLessThanOrEqual(0.5);

      // Hit rate should generally increase (later runs have more overlap)
      // Allow some non-monotonicity but overall trend should be upward
      const firstHalf = hitRates.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
      const secondHalf = hitRates.slice(3).reduce((a, b) => a + b, 0) / (hitRates.length - 3);
      expect(secondHalf).toBeGreaterThan(firstHalf);

      // Final run should have high hit rate (claims are near-duplicates of verified)
      expect(hitRates[4]).toBeGreaterThanOrEqual(0.5);
    });
  });

  // ------------------------------------------------------------------
  // Deduplication detection
  // ------------------------------------------------------------------
  describe('Deduplication detection', () => {
    it('detects near-duplicate claims with different wording', async () => {
      const originalClaims = [
        { id: 'claim-1', content: 'The OAuth authentication system uses token refresh for session management' },
        { id: 'claim-2', content: 'Database queries are optimized with SQL indexes on frequently accessed tables' },
        { id: 'claim-3', content: 'The deployment pipeline runs CI/CD builds before releasing to production' },
      ];

      for (const claim of originalClaims) {
        await store.upsert(claim.id, claim.content, { verified: true });
      }

      // Slightly reworded versions of the same claims
      const rewordedClaims = [
        'Authentication via OAuth tokens with session refresh capability',
        'SQL database index optimization for table query performance',
        'CI/CD build pipeline deploys releases to production environment',
      ];

      for (const rewording of rewordedClaims) {
        const results = await store.search(rewording, { threshold: 0.7, limit: 1 });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].similarity).toBeGreaterThan(0.7);
      }
    });

    it('does NOT flag unrelated claims as duplicates', async () => {
      await store.upsert('auth-claim', 'OAuth authentication uses token refresh for session management', { verified: true });

      const unrelatedResults = await store.search('React UI component renders a button in the DOM', { threshold: 0.85, limit: 1 });
      expect(unrelatedResults.length).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // Staleness detection with semantic drift
  // ------------------------------------------------------------------
  describe('Staleness detection with semantic drift', () => {
    it('detects staleness when content has changed', async () => {
      await store.upsert('oppyhub-sync', 'OppyHub syncs 3 sources: Salesforce, GitHub, Confluence');

      const isStale = await store.isStale('oppyhub-sync', 'OppyHub syncs 4 sources: Salesforce, GitHub, Confluence, Jira');
      expect(isStale).toBe(true);
    });

    it('is NOT stale when content is the same', async () => {
      const content = 'OppyHub syncs 3 sources: Salesforce, GitHub, Confluence';
      await store.upsert('oppyhub-sync', content);

      const isStale = await store.isStale('oppyhub-sync', content);
      expect(isStale).toBe(false);
    });

    it('is stale when content hash differs even slightly', async () => {
      await store.upsert('config-doc', 'The server runs on port 3000 with debug mode enabled');

      const isStale = await store.isStale('config-doc', 'The server runs on port 8080 with debug mode enabled');
      expect(isStale).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Metadata filtering combined with search
  // ------------------------------------------------------------------
  describe('Metadata filtering combined with search', () => {
    beforeEach(async () => {
      await store.upsert('gh-lodging-auth', 'Authentication config for lodging service with OAuth', {
        source: 'github',
        repo: 'lodging-staging',
        type: 'config',
      });
      await store.upsert('gh-lodging-deploy', 'Deployment pipeline for lodging service with CI/CD', {
        source: 'github',
        repo: 'lodging-staging',
        type: 'pipeline',
      });
      await store.upsert('gh-osiris-auth', 'Salesforce authentication for Osiris with SSO', {
        source: 'github',
        repo: 'lodging-osiris',
        type: 'config',
      });
      await store.upsert('conf-auth-docs', 'Confluence page documenting authentication flow and login', {
        source: 'confluence',
        spaceId: 'ENG',
        type: 'documentation',
      });
      await store.upsert('conf-deploy-docs', 'Confluence page about deployment procedures and releases', {
        source: 'confluence',
        spaceId: 'ENG',
        type: 'documentation',
      });
    });

    it('search + filter by source: github returns only github docs', async () => {
      const allResults = await store.search('authentication login OAuth', { threshold: 0.3, limit: 10 });
      const githubOnly = allResults.filter((r) => r.entry.metadata.source === 'github');

      expect(githubOnly.length).toBeGreaterThan(0);
      expect(githubOnly.every((r) => r.entry.metadata.source === 'github')).toBe(true);
    });

    it('search + filter by repo narrows to specific repository', async () => {
      const allResults = await store.search('authentication OAuth SSO', { threshold: 0.3, limit: 10 });
      const lodgingOnly = allResults.filter((r) => r.entry.metadata.repo === 'lodging-staging');

      expect(lodgingOnly.length).toBeGreaterThan(0);
      for (const r of lodgingOnly) {
        expect(r.entry.metadata.repo).toBe('lodging-staging');
      }
    });

    it('search + filter by type returns only matching types', async () => {
      const allResults = await store.search('deployment release CI/CD pipeline', { threshold: 0.3, limit: 10 });
      const docsOnly = allResults.filter((r) => r.entry.metadata.type === 'documentation');
      const pipelineOnly = allResults.filter((r) => r.entry.metadata.type === 'pipeline');

      // Both types should have results about deployment
      expect(docsOnly.length).toBeGreaterThan(0);
      expect(pipelineOnly.length).toBeGreaterThan(0);
    });

    it('search + multiple filters narrows results precisely', async () => {
      const allResults = await store.search('authentication', { threshold: 0.3, limit: 10 });
      const precise = allResults.filter(
        (r) => r.entry.metadata.source === 'github' && r.entry.metadata.repo === 'lodging-osiris',
      );

      expect(precise.length).toBe(1);
      expect(precise[0].entry.id).toBe('gh-osiris-auth');
    });
  });

  // ------------------------------------------------------------------
  // Threshold tuning
  // ------------------------------------------------------------------
  describe('Threshold tuning', () => {
    beforeEach(async () => {
      const docs = [
        'OAuth authentication with token refresh and session management',
        'Authentication security audit and credential compliance',
        'User login flow with password validation and SSO',
        'API endpoint authentication middleware with JWT tokens',
        'Database authentication for Postgres connection pooling',
        'Network security with TLS authentication handshake',
        'Monitoring dashboard shows authentication failure metrics',
        'Deployment pipeline has no authentication-related steps',
        'React UI component for login form rendering',
        'Scheduling batch jobs for auth token cleanup',
      ];

      for (let i = 0; i < docs.length; i++) {
        await store.upsert(`doc-${i}`, docs[i], { index: i });
      }
    });

    it('low threshold (0.3) returns many results', async () => {
      const results = await store.search('authentication and security', { threshold: 0.3, limit: 20 });
      expect(results.length).toBeGreaterThanOrEqual(5);
    });

    it('high threshold (0.85) returns fewer, more relevant results', async () => {
      const results = await store.search('authentication and security', { threshold: 0.85, limit: 20 });
      // Should be fewer than low-threshold
      expect(results.length).toBeLessThan(5);
      // All returned results should be highly relevant
      for (const r of results) {
        expect(r.similarity).toBeGreaterThanOrEqual(0.85);
      }
    });

    it('very high threshold (0.99) returns only near-exact or empty', async () => {
      const results = await store.search('authentication and security', { threshold: 0.99, limit: 20 });
      // Very unlikely any result scores 0.99+ unless near-identical
      expect(results.length).toBeLessThanOrEqual(1);
      for (const r of results) {
        expect(r.similarity).toBeGreaterThanOrEqual(0.99);
      }
    });
  });

  // ------------------------------------------------------------------
  // Empty/edge cases
  // ------------------------------------------------------------------
  describe('Empty and edge cases', () => {
    it('search empty store returns empty results', async () => {
      const results = await store.search('anything at all', { threshold: 0.3, limit: 10 });
      expect(results).toEqual([]);
    });

    it('search with query matching nothing returns empty', async () => {
      await store.upsert('only-doc', 'Salesforce Apex trigger for account object');

      // Query about something completely unrelated at high threshold
      const results = await store.search('quantum physics particle acceleration', { threshold: 0.9, limit: 10 });
      expect(results.length).toBe(0);
    });

    it('upsert same content twice does not create duplicates', async () => {
      await store.upsert('my-doc', 'OAuth authentication with token refresh');
      await store.upsert('my-doc', 'OAuth authentication with token refresh');

      const count = await store.count();
      expect(count).toBe(1);

      const ids = await store.listIds();
      expect(ids).toEqual(['my-doc']);
    });

    it('upsert same id with different content updates the entry', async () => {
      await store.upsert('my-doc', 'OAuth authentication with token refresh');
      await store.upsert('my-doc', 'Database schema with SQL indexes');

      const count = await store.count();
      expect(count).toBe(1);

      const entry = await store.get('my-doc');
      expect(entry).not.toBeNull();
      expect(entry!.content).toBe('Database schema with SQL indexes');
    });

    it('delete then search does not return deleted entry', async () => {
      await store.upsert('to-delete', 'OAuth authentication for the login flow');
      await store.upsert('to-keep', 'Database schema and SQL queries');

      await store.delete('to-delete');

      const results = await store.search('OAuth authentication login', { threshold: 0.3, limit: 10 });
      const ids = results.map((r) => r.entry.id);
      expect(ids).not.toContain('to-delete');
    });

    it('get non-existent id returns null', async () => {
      const entry = await store.get('does-not-exist');
      expect(entry).toBeNull();
    });

    it('delete non-existent id returns false', async () => {
      const deleted = await store.delete('does-not-exist');
      expect(deleted).toBe(false);
    });

    it('clear removes all entries', async () => {
      await store.upsert('a', 'authentication flow');
      await store.upsert('b', 'database schema');
      await store.upsert('c', 'deployment pipeline');

      await store.clear();

      const count = await store.count();
      expect(count).toBe(0);

      const results = await store.search('authentication', { threshold: 0.1, limit: 10 });
      expect(results.length).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // Batch operations simulation
  // ------------------------------------------------------------------
  describe('Batch operations simulation', () => {
    it('handles 50+ rapid upserts and searches correctly', async () => {
      const topics = [
        'salesforce', 'javascript', 'database', 'authentication', 'deployment',
        'api', 'testing', 'documentation', 'scheduling', 'configuration',
      ];

      // Upsert 50 entries
      for (let i = 0; i < 50; i++) {
        const topic = topics[i % topics.length];
        const variation = Math.floor(i / topics.length);
        await store.upsert(
          `batch-${i}`,
          `${topic} related content variation ${variation} with specific details about ${topic} systems`,
          { batch: true, topic, index: i },
        );
      }

      // Count should reflect all entries
      const count = await store.count();
      expect(count).toBe(50);

      // Search should still return relevant results
      const results = await store.search('Salesforce Apex trigger', { threshold: 0.4, limit: 10 });
      expect(results.length).toBeGreaterThan(0);

      // All returned results should relate to salesforce
      for (const r of results) {
        expect(r.entry.metadata.topic).toBe('salesforce');
      }
    });

    it('listIds returns all 50 ids', async () => {
      for (let i = 0; i < 50; i++) {
        await store.upsert(`item-${i}`, `content for item ${i} about testing`);
      }

      const ids = await store.listIds();
      expect(ids.length).toBe(50);
      expect(ids).toContain('item-0');
      expect(ids).toContain('item-49');
    });
  });

  // ------------------------------------------------------------------
  // Cosine similarity utility verification
  // ------------------------------------------------------------------
  describe('Cosine similarity utility', () => {
    it('identical vectors have similarity 1.0', () => {
      const vec = normalize([1, 0, 0, 1, 0]);
      expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
    });

    it('orthogonal vectors have similarity 0.0', () => {
      const a = [1, 0, 0, 0, 0];
      const b = [0, 1, 0, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    it('similar vectors have high similarity', () => {
      const a = normalize([1, 0.9, 0.1, 0, 0]);
      const b = normalize([0.9, 1, 0.1, 0, 0]);
      expect(cosineSimilarity(a, b)).toBeGreaterThan(0.9);
    });

    it('dissimilar vectors have low similarity', () => {
      const a = normalize([1, 0, 0, 0, 0]);
      const b = normalize([0, 0, 0, 0, 1]);
      expect(cosineSimilarity(a, b)).toBeLessThan(0.3);
    });
  });

  // ------------------------------------------------------------------
  // Hash content utility
  // ------------------------------------------------------------------
  describe('hashContent utility', () => {
    it('same content produces same hash', () => {
      expect(hashContent('hello world')).toBe(hashContent('hello world'));
    });

    it('different content produces different hash', () => {
      expect(hashContent('hello world')).not.toBe(hashContent('hello universe'));
    });

    it('hash is deterministic across calls', () => {
      const hash1 = hashContent('test content');
      const hash2 = hashContent('test content');
      const hash3 = hashContent('test content');
      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });
  });
});
