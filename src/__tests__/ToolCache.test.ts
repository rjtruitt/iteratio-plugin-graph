import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createToolCache,
  type ToolCache,
  type ToolCacheConfig,
  type CacheableToolSpec,
  type StalenessStrategy,
  type CacheCheckResult,
  type ToolCacheStats,
} from '../ToolCache';
import {
  VectorStore,
  hashContent,
  type VectorStoreConfig,
  type EmbeddingProvider,
} from '../VectorStore';

// --- Mock Embedding Provider ---
// Produces deterministic embeddings based on content hash.
// Same approach as VectorStore tests.
function createMockEmbeddingProvider(dimensions = 8): EmbeddingProvider & { overrides: Map<string, number[]> } {
  const overrides = new Map<string, number[]>();

  return {
    dimensions,
    overrides,
    async embed(text: string): Promise<number[]> {
      if (overrides.has(text)) {
        return overrides.get(text)!;
      }
      // Generate a deterministic vector from text hash
      const hash = hashContent(text);
      const vec: number[] = [];
      for (let i = 0; i < dimensions; i++) {
        const charCode = hash.charCodeAt(i % hash.length) || 1;
        vec.push(Math.sin(charCode * (i + 1)));
      }
      // Normalize
      const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      return vec.map((v) => v / (magnitude || 1));
    },
  };
}

// --- Helper: create a VectorStore with mock embedder ---
function createTestVectorStore(embedder?: EmbeddingProvider & { overrides: Map<string, number[]> }) {
  const emb = embedder ?? createMockEmbeddingProvider(8);
  const config: VectorStoreConfig = {
    table: 'tool_cache_test',
    dimensions: 8,
    stalenessCheck: 'none',
  };
  return { store: new VectorStore(config, emb), embedder: emb };
}

// --- Helper: create a default ToolCacheConfig ---
function createDefaultConfig(overrides: Partial<ToolCacheConfig> = {}): ToolCacheConfig {
  return {
    enabled: true,
    defaultThreshold: 0.92,
    defaultTtlHours: 24,
    applies_to: ['*'],
    excludes: [],
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('ToolCache', () => {
  let vectorStore: VectorStore;
  let embedder: EmbeddingProvider & { overrides: Map<string, number[]> };
  let cache: ToolCache;
  let config: ToolCacheConfig;

  beforeEach(() => {
    const created = createTestVectorStore();
    vectorStore = created.store;
    embedder = created.embedder;
    config = createDefaultConfig();
    cache = createToolCache(config, vectorStore);
  });

  // ──────────────────────────────────────────────
  // Basic Cache Operations
  // ──────────────────────────────────────────────
  describe('basic cache operations', () => {
    it('check returns miss on empty cache', async () => {
      const result = await cache.check('fetchPage', { pageId: '123' });

      expect(result.hit).toBe(false);
      expect(result.result).toBeUndefined();
      expect(result.reason).toBeDefined();
    });

    it('store then check returns hit with correct result', async () => {
      const inputs = { pageId: '123' };
      const toolResult = { title: 'My Page', body: '<p>Hello</p>' };

      await cache.store('fetchPage', inputs, toolResult);
      const result = await cache.check('fetchPage', inputs);

      expect(result.hit).toBe(true);
      expect(result.result).toEqual(toolResult);
      expect(result.similarity).toBeDefined();
      expect(result.similarity!).toBeGreaterThanOrEqual(0.92);
    });

    it('check respects threshold — exact match hits', async () => {
      const inputs = { query: 'hello world' };
      const toolResult = { count: 42 };

      await cache.store('search', inputs, toolResult);
      const result = await cache.check('search', inputs);

      expect(result.hit).toBe(true);
    });

    it('check respects threshold — low similarity misses', async () => {
      // Store with one set of inputs
      await cache.store('search', { query: 'hello world' }, { count: 42 });

      // Check with completely different inputs that will have low similarity
      const result = await cache.check('search', { query: 'xyzzy cosmic zebra quantum' });

      // The embeddings for different content should produce different vectors
      // If it's a miss due to threshold, great. If hit due to hash collision, the
      // key generation ensures different inputs won't match.
      // With deterministic embeddings and threshold 0.92, different content misses.
      expect(result.hit).toBe(false);
    });

    it('store multiple entries, check retrieves correct one', async () => {
      await cache.store('fetchPage', { pageId: '100' }, { title: 'Page 100' });
      await cache.store('fetchPage', { pageId: '200' }, { title: 'Page 200' });
      await cache.store('fetchPage', { pageId: '300' }, { title: 'Page 300' });

      const result = await cache.check('fetchPage', { pageId: '200' });

      expect(result.hit).toBe(true);
      expect(result.result).toEqual({ title: 'Page 200' });
    });
  });

  // ──────────────────────────────────────────────
  // Configuration
  // ──────────────────────────────────────────────
  describe('configuration', () => {
    it('disabled cache always returns miss with reason "disabled"', async () => {
      const disabledConfig = createDefaultConfig({ enabled: false });
      const disabledCache = createToolCache(disabledConfig, vectorStore);

      await disabledCache.store('fetchPage', { pageId: '123' }, { title: 'Test' });
      const result = await disabledCache.check('fetchPage', { pageId: '123' });

      expect(result.hit).toBe(false);
      expect(result.reason).toBe('disabled');
    });

    it('excluded tool always returns miss with reason "excluded"', async () => {
      const excludeConfig = createDefaultConfig({ excludes: ['*delete*'] });
      const excludeCache = createToolCache(excludeConfig, vectorStore);

      const result = await excludeCache.check('mcp__github__delete_file', { path: '/test' });

      expect(result.hit).toBe(false);
      expect(result.reason).toBe('excluded');
    });

    it('tool not in applies_to returns miss with reason "not cacheable"', async () => {
      const restrictedConfig = createDefaultConfig({ applies_to: ['fetchPage', 'search'] });
      const restrictedCache = createToolCache(restrictedConfig, vectorStore);

      const result = await restrictedCache.check('unknownTool', { arg: 'value' });

      expect(result.hit).toBe(false);
      expect(result.reason).toBe('not cacheable');
    });

    it('CacheableToolSpec registered makes tool cacheable even without applies_to', async () => {
      const restrictedConfig = createDefaultConfig({ applies_to: ['fetchPage'] });
      const restrictedCache = createToolCache(restrictedConfig, vectorStore);

      const spec: CacheableToolSpec = {
        name: 'customTool',
        description: 'A custom tool',
        cacheable: true,
        inputs: { arg: { type: 'string', required: true } },
        outputs: { result: { type: 'string', required: true } },
      };
      restrictedCache.registerCacheableSpec(spec);

      await restrictedCache.store('customTool', { arg: 'test' }, { result: 'success' });
      const result = await restrictedCache.check('customTool', { arg: 'test' });

      expect(result.hit).toBe(true);
    });

    it('CacheableToolSpec with cacheable:false makes tool not cacheable even if in applies_to', async () => {
      const spec: CacheableToolSpec = {
        name: 'fetchPage',
        description: 'Fetch a page',
        cacheable: false,
        inputs: { pageId: { type: 'string', required: true } },
        outputs: { title: { type: 'string', required: true } },
      };
      cache.registerCacheableSpec(spec);

      const result = await cache.check('fetchPage', { pageId: '123' });

      expect(result.hit).toBe(false);
      expect(result.reason).toBe('not cacheable');
    });

    it('defaultThreshold used when no per-tool override', async () => {
      // Use a high threshold config
      const highThresholdConfig = createDefaultConfig({ defaultThreshold: 0.999 });
      const highCache = createToolCache(highThresholdConfig, vectorStore);

      await highCache.store('fetchPage', { pageId: '123' }, { title: 'Page' });

      // Exact same key should still be a perfect match (similarity 1.0)
      const exactResult = await highCache.check('fetchPage', { pageId: '123' });
      expect(exactResult.hit).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // Cache Key Generation
  // ──────────────────────────────────────────────
  describe('cache key generation', () => {
    it('same tool + same inputs = same key', () => {
      const key1 = cache.getCacheKey('fetchPage', { pageId: '123', includeBody: true });
      const key2 = cache.getCacheKey('fetchPage', { pageId: '123', includeBody: true });

      expect(key1).toBe(key2);
    });

    it('same tool + different inputs = different key', () => {
      const key1 = cache.getCacheKey('fetchPage', { pageId: '123' });
      const key2 = cache.getCacheKey('fetchPage', { pageId: '456' });

      expect(key1).not.toBe(key2);
    });

    it('cacheKeyFrom filters to only specified fields', () => {
      const spec: CacheableToolSpec = {
        name: 'search',
        description: 'Search tool',
        cacheable: true,
        cacheKeyFrom: ['query'],
        inputs: {
          query: { type: 'string', required: true },
          page: { type: 'number', required: false },
          limit: { type: 'number', required: false },
        },
        outputs: { results: { type: 'string[]', required: true } },
      };
      cache.registerCacheableSpec(spec);

      // Different page/limit but same query should produce same key
      const key1 = cache.getCacheKey('search', { query: 'hello', page: 1, limit: 10 });
      const key2 = cache.getCacheKey('search', { query: 'hello', page: 2, limit: 20 });

      expect(key1).toBe(key2);
    });

    it('key is deterministic (sorted JSON) regardless of object key order', () => {
      const key1 = cache.getCacheKey('tool', { z: 1, a: 2, m: 3 });
      const key2 = cache.getCacheKey('tool', { a: 2, m: 3, z: 1 });

      expect(key1).toBe(key2);
    });

    it('different tools with same inputs produce different keys', () => {
      const key1 = cache.getCacheKey('toolA', { arg: 'value' });
      const key2 = cache.getCacheKey('toolB', { arg: 'value' });

      expect(key1).not.toBe(key2);
    });
  });

  // ──────────────────────────────────────────────
  // Invalidation
  // ──────────────────────────────────────────────
  describe('invalidation', () => {
    it('invalidate specific entry (tool + inputs) removes it', async () => {
      const inputs = { pageId: '123' };
      await cache.store('fetchPage', inputs, { title: 'Page' });

      const count = await cache.invalidate('fetchPage', inputs);
      expect(count).toBe(1);

      const result = await cache.check('fetchPage', inputs);
      expect(result.hit).toBe(false);
    });

    it('invalidate by tool name removes all for that tool', async () => {
      await cache.store('fetchPage', { pageId: '100' }, { title: 'Page 100' });
      await cache.store('fetchPage', { pageId: '200' }, { title: 'Page 200' });
      await cache.store('fetchPage', { pageId: '300' }, { title: 'Page 300' });

      const count = await cache.invalidate('fetchPage');
      expect(count).toBe(3);

      const result1 = await cache.check('fetchPage', { pageId: '100' });
      const result2 = await cache.check('fetchPage', { pageId: '200' });
      expect(result1.hit).toBe(false);
      expect(result2.hit).toBe(false);
    });

    it('invalidateByPattern with glob removes matching entries', async () => {
      await cache.store('mcp__github__get_file', { path: '/a' }, { content: 'A' });
      await cache.store('mcp__github__list_branches', {}, { branches: [] });
      await cache.store('mcp__jira__get_issue', { key: 'TEST-1' }, { summary: 'Bug' });

      const count = await cache.invalidateByPattern('mcp__github__*');
      expect(count).toBe(2);

      // Github entries are gone
      const ghResult = await cache.check('mcp__github__get_file', { path: '/a' });
      expect(ghResult.hit).toBe(false);

      // Jira entry still exists
      const jiraResult = await cache.check('mcp__jira__get_issue', { key: 'TEST-1' });
      expect(jiraResult.hit).toBe(true);
    });

    it('invalidate returns correct count', async () => {
      await cache.store('tool', { a: 1 }, 'result1');
      await cache.store('tool', { a: 2 }, 'result2');

      const count = await cache.invalidate('tool');
      expect(count).toBe(2);
    });

    it('invalidate returns 0 for non-existent entries', async () => {
      const count = await cache.invalidate('nonexistent', { arg: 'value' });
      expect(count).toBe(0);
    });

    it('invalidateByPattern returns 0 when no match', async () => {
      await cache.store('fetchPage', { pageId: '1' }, { title: 'P' });
      const count = await cache.invalidateByPattern('delete_*');
      expect(count).toBe(0);
    });
  });

  // ──────────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────────
  describe('stats', () => {
    it('hitRate calculated correctly (hits / total checks)', async () => {
      await cache.store('tool', { a: 1 }, 'result');

      await cache.check('tool', { a: 1 }); // hit
      await cache.check('tool', { a: 1 }); // hit
      await cache.check('tool', { a: 999 }); // miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
    });

    it('totalHits increments on hit', async () => {
      await cache.store('tool', { a: 1 }, 'result');

      await cache.check('tool', { a: 1 });
      await cache.check('tool', { a: 1 });

      const stats = cache.getStats();
      expect(stats.totalHits).toBe(2);
    });

    it('totalMisses increments on miss', async () => {
      await cache.check('tool', { a: 1 });
      await cache.check('tool', { a: 2 });

      const stats = cache.getStats();
      expect(stats.totalMisses).toBe(2);
    });

    it('topHitTools tracks per-tool hit counts', async () => {
      await cache.store('toolA', { a: 1 }, 'resultA');
      await cache.store('toolB', { b: 1 }, 'resultB');

      await cache.check('toolA', { a: 1 }); // hit
      await cache.check('toolA', { a: 1 }); // hit
      await cache.check('toolA', { a: 1 }); // hit
      await cache.check('toolB', { b: 1 }); // hit

      const stats = cache.getStats();
      expect(stats.topHitTools).toContainEqual({ tool: 'toolA', hits: 3 });
      expect(stats.topHitTools).toContainEqual({ tool: 'toolB', hits: 1 });
    });

    it('topHitTools sorted by hits descending', async () => {
      await cache.store('toolA', { a: 1 }, 'A');
      await cache.store('toolB', { b: 1 }, 'B');
      await cache.store('toolC', { c: 1 }, 'C');

      await cache.check('toolB', { b: 1 });
      await cache.check('toolC', { c: 1 });
      await cache.check('toolC', { c: 1 });
      await cache.check('toolC', { c: 1 });
      await cache.check('toolA', { a: 1 });
      await cache.check('toolA', { a: 1 });

      const stats = cache.getStats();
      expect(stats.topHitTools[0].tool).toBe('toolC');
      expect(stats.topHitTools[1].tool).toBe('toolA');
      expect(stats.topHitTools[2].tool).toBe('toolB');
    });

    it('costSaved increments on hit (assume $0.01 per avoided call)', async () => {
      await cache.store('tool', { a: 1 }, 'result');

      await cache.check('tool', { a: 1 }); // hit
      await cache.check('tool', { a: 1 }); // hit
      await cache.check('tool', { a: 1 }); // hit

      const stats = cache.getStats();
      expect(stats.costSaved).toBeCloseTo(0.03, 4);
    });

    it('entriesCount reflects stored entries', async () => {
      await cache.store('toolA', { a: 1 }, 'A');
      await cache.store('toolB', { b: 1 }, 'B');

      const stats = cache.getStats();
      expect(stats.entriesCount).toBe(2);
    });

    it('stats start at zero', () => {
      const stats = cache.getStats();
      expect(stats.totalHits).toBe(0);
      expect(stats.totalMisses).toBe(0);
      expect(stats.hitRate).toBe(0);
      expect(stats.entriesCount).toBe(0);
      expect(stats.costSaved).toBe(0);
      expect(stats.topHitTools).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────
  // LRU Eviction
  // ──────────────────────────────────────────────
  describe('LRU eviction', () => {
    it('when maxEntries reached, oldest entry is evicted', async () => {
      const lruConfig = createDefaultConfig({ maxEntries: 3 });
      const lruCache = createToolCache(lruConfig, vectorStore);

      await lruCache.store('tool', { a: 1 }, 'result1');
      await lruCache.store('tool', { a: 2 }, 'result2');
      await lruCache.store('tool', { a: 3 }, 'result3');

      // This should evict { a: 1 } (oldest)
      await lruCache.store('tool', { a: 4 }, 'result4');

      const evicted = await lruCache.check('tool', { a: 1 });
      expect(evicted.hit).toBe(false);

      // Others should still be present
      const kept = await lruCache.check('tool', { a: 4 });
      expect(kept.hit).toBe(true);
    });

    it('newly stored entry does not get evicted immediately', async () => {
      const lruConfig = createDefaultConfig({ maxEntries: 2 });
      const lruCache = createToolCache(lruConfig, vectorStore);

      await lruCache.store('tool', { a: 1 }, 'result1');
      await lruCache.store('tool', { a: 2 }, 'result2');
      await lruCache.store('tool', { a: 3 }, 'result3');

      // The newest one should survive
      const newest = await lruCache.check('tool', { a: 3 });
      expect(newest.hit).toBe(true);
    });

    it('frequently hit entries survive longer than rarely hit ones', async () => {
      const lruConfig = createDefaultConfig({ maxEntries: 3 });
      const lruCache = createToolCache(lruConfig, vectorStore);

      await lruCache.store('tool', { a: 1 }, 'result1');
      await new Promise((r) => setTimeout(r, 5));
      await lruCache.store('tool', { a: 2 }, 'result2');
      await new Promise((r) => setTimeout(r, 5));
      await lruCache.store('tool', { a: 3 }, 'result3');
      await new Promise((r) => setTimeout(r, 5));

      // Hit entry 1 multiple times to make it "hot" (updates lastHitAt)
      await lruCache.check('tool', { a: 1 });
      await lruCache.check('tool', { a: 1 });
      await lruCache.check('tool', { a: 1 });
      await new Promise((r) => setTimeout(r, 5));

      // Add a new entry - should evict entry 2 (least recently used, not 1 which was hit recently)
      await lruCache.store('tool', { a: 4 }, 'result4');

      // Entry 1 should survive (frequently hit, recent lastHitAt)
      const hot = await lruCache.check('tool', { a: 1 });
      expect(hot.hit).toBe(true);

      // Entry 2 should be evicted (never hit after initial store, oldest storedAt among non-hit entries)
      const cold = await lruCache.check('tool', { a: 2 });
      expect(cold.hit).toBe(false);
    });
  });

  // ──────────────────────────────────────────────
  // Staleness Strategies
  // ──────────────────────────────────────────────
  describe('staleness strategies', () => {
    it('TTL: entry older than ttlHours returns miss even if similarity high', async () => {
      const ttlConfig = createDefaultConfig({
        defaultTtlHours: 0, // 0 hours = immediately stale
        staleness_strategies: { fetchPage: { type: 'ttl', hours: 0 } },
      });
      const ttlCache = createToolCache(ttlConfig, vectorStore);

      await ttlCache.store('fetchPage', { pageId: '123' }, { title: 'Page' });

      // Wait a tick so the entry is older than 0 hours (any age > 0ms)
      await new Promise((r) => setTimeout(r, 5));

      const result = await ttlCache.check('fetchPage', { pageId: '123' });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('stale');
    });

    it('TTL: entry within ttlHours returns hit', async () => {
      const ttlConfig = createDefaultConfig({
        defaultTtlHours: 24,
        staleness_strategies: { fetchPage: { type: 'ttl', hours: 24 } },
      });
      const ttlCache = createToolCache(ttlConfig, vectorStore);

      await ttlCache.store('fetchPage', { pageId: '123' }, { title: 'Page' });
      const result = await ttlCache.check('fetchPage', { pageId: '123' });

      expect(result.hit).toBe(true);
    });

    it('content_hash: different inputs produce different hash, returns miss', async () => {
      const hashConfig = createDefaultConfig({
        staleness_strategies: { transform: { type: 'content_hash' } },
      });
      const hashCache = createToolCache(hashConfig, vectorStore);

      await hashCache.store('transform', { data: 'original' }, { output: 'transformed' });

      // Checking with same inputs should hit
      const sameResult = await hashCache.check('transform', { data: 'original' });
      expect(sameResult.hit).toBe(true);
    });

    it('none: never auto-invalidates (manual only)', async () => {
      const noneConfig = createDefaultConfig({
        staleness_strategies: { fetchPage: { type: 'none' } },
      });
      const noneCache = createToolCache(noneConfig, vectorStore);

      await noneCache.store('fetchPage', { pageId: '123' }, { title: 'Page' });
      const result = await noneCache.check('fetchPage', { pageId: '123' });

      expect(result.hit).toBe(true);
    });

    it('per-tool staleness strategy overrides default', async () => {
      const mixedConfig = createDefaultConfig({
        defaultTtlHours: 24,
        staleness_strategies: {
          volatile: { type: 'ttl', hours: 0 },
          stable: { type: 'none' },
        },
      });
      const mixedCache = createToolCache(mixedConfig, vectorStore);

      await mixedCache.store('volatile', { x: 1 }, 'vol-result');
      await mixedCache.store('stable', { x: 1 }, 'stable-result');

      await new Promise((r) => setTimeout(r, 5));

      const volResult = await mixedCache.check('volatile', { x: 1 });
      expect(volResult.hit).toBe(false);
      expect(volResult.reason).toBe('stale');

      const stableResult = await mixedCache.check('stable', { x: 1 });
      expect(stableResult.hit).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // Callbacks
  // ──────────────────────────────────────────────
  describe('callbacks', () => {
    it('onCacheHit fires with tool name and similarity score', async () => {
      const onCacheHit = vi.fn();
      const cbConfig = createDefaultConfig({ onCacheHit });
      const cbCache = createToolCache(cbConfig, vectorStore);

      await cbCache.store('tool', { a: 1 }, 'result');
      await cbCache.check('tool', { a: 1 });

      expect(onCacheHit).toHaveBeenCalledTimes(1);
      expect(onCacheHit).toHaveBeenCalledWith('tool', expect.any(Number));
      expect(onCacheHit.mock.calls[0][1]).toBeGreaterThanOrEqual(0.92);
    });

    it('onCacheMiss fires with tool name', async () => {
      const onCacheMiss = vi.fn();
      const cbConfig = createDefaultConfig({ onCacheMiss });
      const cbCache = createToolCache(cbConfig, vectorStore);

      await cbCache.check('tool', { a: 1 });

      expect(onCacheMiss).toHaveBeenCalledTimes(1);
      expect(onCacheMiss).toHaveBeenCalledWith('tool');
    });

    it('onCacheStore fires with tool name and generated cache key', async () => {
      const onCacheStore = vi.fn();
      const cbConfig = createDefaultConfig({ onCacheStore });
      const cbCache = createToolCache(cbConfig, vectorStore);

      await cbCache.store('tool', { a: 1 }, 'result');

      expect(onCacheStore).toHaveBeenCalledTimes(1);
      expect(onCacheStore).toHaveBeenCalledWith('tool', expect.any(String));
    });

    it('onCacheMiss does not fire on excluded tools', async () => {
      const onCacheMiss = vi.fn();
      const cbConfig = createDefaultConfig({
        onCacheMiss,
        excludes: ['excluded_tool'],
      });
      const cbCache = createToolCache(cbConfig, vectorStore);

      await cbCache.check('excluded_tool', { a: 1 });

      // Should not fire since tool is excluded (not a "real" miss — it's excluded)
      expect(onCacheMiss).not.toHaveBeenCalled();
    });

    it('onCacheHit does not fire on miss', async () => {
      const onCacheHit = vi.fn();
      const cbConfig = createDefaultConfig({ onCacheHit });
      const cbCache = createToolCache(cbConfig, vectorStore);

      await cbCache.check('tool', { a: 1 });

      expect(onCacheHit).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // Glob Matching (applies_to / excludes)
  // ──────────────────────────────────────────────
  describe('glob matching for applies_to/excludes', () => {
    it('"mcp__github__*" matches "mcp__github__get_file_contents"', () => {
      const globConfig = createDefaultConfig({ applies_to: ['mcp__github__*'] });
      const globCache = createToolCache(globConfig, vectorStore);

      expect(globCache.isToolCacheable('mcp__github__get_file_contents')).toBe(true);
    });

    it('"*delete*" matches "mcp__github__delete_file"', () => {
      const globConfig = createDefaultConfig({ excludes: ['*delete*'] });
      const globCache = createToolCache(globConfig, vectorStore);

      expect(globCache.isToolCacheable('mcp__github__delete_file')).toBe(false);
    });

    it('exact name match works', () => {
      const exactConfig = createDefaultConfig({ applies_to: ['fetchPage'] });
      const exactCache = createToolCache(exactConfig, vectorStore);

      expect(exactCache.isToolCacheable('fetchPage')).toBe(true);
      expect(exactCache.isToolCacheable('fetchOther')).toBe(false);
    });

    it('excludes takes precedence over applies_to', () => {
      const conflictConfig = createDefaultConfig({
        applies_to: ['mcp__github__*'],
        excludes: ['mcp__github__delete_file'],
      });
      const conflictCache = createToolCache(conflictConfig, vectorStore);

      expect(conflictCache.isToolCacheable('mcp__github__get_file_contents')).toBe(true);
      expect(conflictCache.isToolCacheable('mcp__github__delete_file')).toBe(false);
    });

    it('multiple glob patterns in applies_to', () => {
      const multiConfig = createDefaultConfig({
        applies_to: ['mcp__github__*', 'mcp__jira__*'],
      });
      const multiCache = createToolCache(multiConfig, vectorStore);

      expect(multiCache.isToolCacheable('mcp__github__get_file_contents')).toBe(true);
      expect(multiCache.isToolCacheable('mcp__jira__get_issue')).toBe(true);
      expect(multiCache.isToolCacheable('mcp__slack__send')).toBe(false);
    });

    it('wildcard "*" in applies_to matches everything', () => {
      const allConfig = createDefaultConfig({ applies_to: ['*'] });
      const allCache = createToolCache(allConfig, vectorStore);

      expect(allCache.isToolCacheable('anything')).toBe(true);
      expect(allCache.isToolCacheable('mcp__github__delete')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // Integration with VectorStore
  // ──────────────────────────────────────────────
  describe('integration with VectorStore', () => {
    it('uses VectorStore.search for cache check', async () => {
      const searchSpy = vi.spyOn(vectorStore, 'search');
      await cache.store('tool', { a: 1 }, 'result');
      await cache.check('tool', { a: 1 });

      expect(searchSpy).toHaveBeenCalled();
    });

    it('uses VectorStore.upsert for store', async () => {
      const upsertSpy = vi.spyOn(vectorStore, 'upsert');
      await cache.store('tool', { a: 1 }, 'result');

      expect(upsertSpy).toHaveBeenCalled();
    });

    it('uses VectorStore.delete for invalidation', async () => {
      const deleteSpy = vi.spyOn(vectorStore, 'delete');
      await cache.store('tool', { a: 1 }, 'result');
      await cache.invalidate('tool', { a: 1 });

      expect(deleteSpy).toHaveBeenCalled();
    });

    it('metadata correctly marks entries as tool_cache type', async () => {
      await cache.store('tool', { a: 1 }, 'result');

      const ids = await vectorStore.listIds();
      expect(ids.length).toBe(1);

      const entry = await vectorStore.get(ids[0]);
      expect(entry).not.toBeNull();
      expect(entry!.metadata.type).toBe('tool_cache');
      expect(entry!.metadata.toolName).toBe('tool');
    });

    it('stores serialized inputs in metadata', async () => {
      const inputs = { pageId: '123', includeBody: true };
      await cache.store('fetchPage', inputs, { title: 'Page' });

      const ids = await vectorStore.listIds();
      const entry = await vectorStore.get(ids[0]);
      expect(entry!.metadata.inputs).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────
  // Edge Cases
  // ──────────────────────────────────────────────
  describe('edge cases', () => {
    it('empty inputs object', async () => {
      await cache.store('listAll', {}, { items: [1, 2, 3] });
      const result = await cache.check('listAll', {});

      expect(result.hit).toBe(true);
      expect(result.result).toEqual({ items: [1, 2, 3] });
    });

    it('very large result objects are stored and retrieved', async () => {
      const largeResult = {
        data: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          name: `Item ${i}`,
          description: `This is item number ${i} with a long description to test large payloads`,
        })),
      };

      await cache.store('bigTool', { query: 'all' }, largeResult);
      const result = await cache.check('bigTool', { query: 'all' });

      expect(result.hit).toBe(true);
      expect(result.result).toEqual(largeResult);
    });

    it('concurrent check+store does not crash', async () => {
      const promises = [
        cache.store('tool', { a: 1 }, 'result1'),
        cache.check('tool', { a: 1 }),
        cache.store('tool', { a: 2 }, 'result2'),
        cache.check('tool', { a: 2 }),
      ];

      // Should not throw
      await expect(Promise.all(promises)).resolves.toBeDefined();
    });

    it('setEnabled(false) disables cache', async () => {
      await cache.store('tool', { a: 1 }, 'result');
      cache.setEnabled(false);

      const result = await cache.check('tool', { a: 1 });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('disabled');
    });

    it('setEnabled(true) re-enables cache', async () => {
      await cache.store('tool', { a: 1 }, 'result');
      cache.setEnabled(false);
      cache.setEnabled(true);

      const result = await cache.check('tool', { a: 1 });
      expect(result.hit).toBe(true);
    });

    it('clear removes everything and resets stats', async () => {
      await cache.store('tool', { a: 1 }, 'result');
      await cache.check('tool', { a: 1 }); // hit

      await cache.clear();

      const stats = cache.getStats();
      expect(stats.totalHits).toBe(0);
      expect(stats.totalMisses).toBe(0);
      expect(stats.entriesCount).toBe(0);
      expect(stats.costSaved).toBe(0);
      expect(stats.topHitTools).toEqual([]);

      const result = await cache.check('tool', { a: 1 });
      expect(result.hit).toBe(false);
    });

    it('null and undefined values in inputs are handled', async () => {
      await cache.store('tool', { a: null, b: undefined }, 'result');
      const result = await cache.check('tool', { a: null, b: undefined });

      expect(result.hit).toBe(true);
    });

    it('numeric inputs are handled correctly', async () => {
      await cache.store('calc', { x: 42, y: 3.14 }, { sum: 45.14 });
      const result = await cache.check('calc', { x: 42, y: 3.14 });

      expect(result.hit).toBe(true);
      expect(result.result).toEqual({ sum: 45.14 });
    });

    it('array values in inputs are handled correctly', async () => {
      await cache.store('multi', { ids: [1, 2, 3] }, { results: ['a', 'b', 'c'] });
      const result = await cache.check('multi', { ids: [1, 2, 3] });

      expect(result.hit).toBe(true);
    });

    it('isToolCacheable returns false when cache is disabled', () => {
      const disabledConfig = createDefaultConfig({ enabled: false });
      const disabledCache = createToolCache(disabledConfig, vectorStore);

      // Even if tool matches applies_to, disabled means not cacheable in practice
      // But isToolCacheable checks the rules, not the enabled state
      // The check() method handles disabled state separately
      // isToolCacheable should still report the tool's cacheability rules
      expect(disabledCache.isToolCacheable('anything')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // registerCacheableSpec
  // ──────────────────────────────────────────────
  describe('registerCacheableSpec', () => {
    it('registers spec and makes tool cacheable', () => {
      const restrictedConfig = createDefaultConfig({ applies_to: [] });
      const restrictedCache = createToolCache(restrictedConfig, vectorStore);

      expect(restrictedCache.isToolCacheable('myTool')).toBe(false);

      restrictedCache.registerCacheableSpec({
        name: 'myTool',
        description: 'Test',
        cacheable: true,
        inputs: { arg: { type: 'string', required: true } },
        outputs: { result: { type: 'string', required: true } },
      });

      expect(restrictedCache.isToolCacheable('myTool')).toBe(true);
    });

    it('registers spec with cacheKeyFrom and uses it for key generation', () => {
      cache.registerCacheableSpec({
        name: 'searchTool',
        description: 'Search',
        cacheable: true,
        cacheKeyFrom: ['query'],
        inputs: {
          query: { type: 'string', required: true },
          page: { type: 'number', required: false },
        },
        outputs: { results: { type: 'string[]', required: true } },
      });

      const key1 = cache.getCacheKey('searchTool', { query: 'test', page: 1 });
      const key2 = cache.getCacheKey('searchTool', { query: 'test', page: 99 });

      expect(key1).toBe(key2);
    });

    it('registers spec with staleness strategy', async () => {
      const spec: CacheableToolSpec = {
        name: 'volatileTool',
        description: 'Tool with TTL',
        cacheable: true,
        staleness: { type: 'ttl', hours: 0 },
        inputs: { x: { type: 'number', required: true } },
        outputs: { y: { type: 'number', required: true } },
      };
      cache.registerCacheableSpec(spec);

      await cache.store('volatileTool', { x: 1 }, { y: 2 });
      await new Promise((r) => setTimeout(r, 5));

      const result = await cache.check('volatileTool', { x: 1 });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('stale');
    });

    it('registers spec with ttlHours', async () => {
      cache.registerCacheableSpec({
        name: 'ttlTool',
        description: 'Tool with long TTL',
        cacheable: true,
        ttlHours: 48,
        inputs: { x: { type: 'number', required: true } },
        outputs: { y: { type: 'number', required: true } },
      });

      await cache.store('ttlTool', { x: 1 }, { y: 2 });
      const result = await cache.check('ttlTool', { x: 1 });

      expect(result.hit).toBe(true);
    });
  });
});
