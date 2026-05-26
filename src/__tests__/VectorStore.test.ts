import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VectorStore,
  DriftStore,
  cosineSimilarity,
  hashContent,
  type VectorStoreConfig,
  type EmbeddingProvider,
  type DriftConfig,
  type VectorEntry,
} from '../VectorStore';

// --- Mock Embedding Provider ---
// Produces deterministic embeddings based on content hash.
// For testing similarity, we allow injecting specific vectors.
function createMockEmbeddingProvider(dimensions = 4): EmbeddingProvider & { overrides: Map<string, number[]> } {
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
        // Use different character positions for each dimension
        const charCode = hash.charCodeAt(i % hash.length) || 1;
        vec.push(Math.sin(charCode * (i + 1)));
      }
      // Normalize
      const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      return vec.map((v) => v / (magnitude || 1));
    },
  };
}

// --- cosineSimilarity Tests ---
describe('cosineSimilarity', () => {
  it('should return 1.0 for identical vectors', () => {
    const a = [1, 0, 0, 0];
    const b = [1, 0, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('should return 1.0 for identical non-unit vectors', () => {
    const a = [3, 4, 0];
    const b = [3, 4, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('should return 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('should return -1.0 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('should return known computed value for arbitrary vectors', () => {
    // cos([1,2,3], [4,5,6]) = (4+10+18) / (sqrt(14) * sqrt(77))
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
  });

  it('should return 0 when one vector is zero', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('should handle negative components', () => {
    const a = [-1, -1];
    const b = [-1, -1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});

// --- hashContent Tests ---
describe('hashContent', () => {
  it('should return a string', () => {
    expect(typeof hashContent('hello')).toBe('string');
  });

  it('should return same hash for same content', () => {
    expect(hashContent('test')).toBe(hashContent('test'));
  });

  it('should return different hash for different content', () => {
    expect(hashContent('hello')).not.toBe(hashContent('world'));
  });

  it('should handle empty string', () => {
    const h = hashContent('');
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });
});

// --- VectorStore Tests ---
describe('VectorStore', () => {
  let store: VectorStore;
  let embedder: EmbeddingProvider & { overrides: Map<string, number[]> };
  let config: VectorStoreConfig;

  beforeEach(() => {
    config = {
      table: 'test_table',
      dimensions: 4,
      stalenessCheck: 'source_hash',
    };
    embedder = createMockEmbeddingProvider(4);
    store = new VectorStore(config, embedder);
  });

  describe('construction', () => {
    it('should create a VectorStore with config', () => {
      expect(store).toBeInstanceOf(VectorStore);
    });

    it('should start with zero entries', async () => {
      expect(await store.count()).toBe(0);
    });

    it('should start with empty ids list', async () => {
      expect(await store.listIds()).toEqual([]);
    });
  });

  describe('upsert', () => {
    it('should upsert a new entry and return it with correct fields', async () => {
      const entry = await store.upsert('doc1', 'Hello world', { author: 'tester' });

      expect(entry.id).toBe('doc1');
      expect(entry.content).toBe('Hello world');
      expect(entry.embedding).toHaveLength(4);
      expect(entry.metadata).toEqual({ author: 'tester' });
      expect(entry.sourceHash).toBe(hashContent('Hello world'));
      expect(entry.createdAt).toBeInstanceOf(Date);
      expect(entry.updatedAt).toBeInstanceOf(Date);
    });

    it('should store the entry so it can be retrieved', async () => {
      await store.upsert('doc1', 'Hello world');
      const retrieved = await store.get('doc1');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('doc1');
      expect(retrieved!.content).toBe('Hello world');
    });

    it('should not update if content has same sourceHash (no-op)', async () => {
      const first = await store.upsert('doc1', 'Same content');
      const second = await store.upsert('doc1', 'Same content');

      expect(second.sourceHash).toBe(first.sourceHash);
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
      // updatedAt should remain the same since no actual update happened
      expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    });

    it('should update if content changed (different sourceHash)', async () => {
      const first = await store.upsert('doc1', 'Version 1');
      // Small delay so updatedAt differs
      await new Promise((r) => setTimeout(r, 5));
      const second = await store.upsert('doc1', 'Version 2');

      expect(second.sourceHash).not.toBe(first.sourceHash);
      expect(second.content).toBe('Version 2');
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
      expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    });

    it('should preserve createdAt on update', async () => {
      const first = await store.upsert('doc1', 'Original');
      await new Promise((r) => setTimeout(r, 5));
      const second = await store.upsert('doc1', 'Updated');

      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    });

    it('should default metadata to empty object', async () => {
      const entry = await store.upsert('doc1', 'No meta');
      expect(entry.metadata).toEqual({});
    });

    it('should increment count after upsert', async () => {
      await store.upsert('doc1', 'A');
      await store.upsert('doc2', 'B');
      expect(await store.count()).toBe(2);
    });

    it('should not increment count on re-upsert of same id', async () => {
      await store.upsert('doc1', 'A');
      await store.upsert('doc1', 'B');
      expect(await store.count()).toBe(1);
    });
  });

  describe('search', () => {
    it('should return results above threshold sorted by similarity desc', async () => {
      // Set up embeddings so we control similarity
      embedder.overrides.set('base', [1, 0, 0, 0]);
      embedder.overrides.set('similar', [0.9, 0.1, 0, 0]);
      embedder.overrides.set('less similar', [0.5, 0.5, 0.5, 0]);
      embedder.overrides.set('orthogonal', [0, 0, 0, 1]);
      embedder.overrides.set('query', [1, 0, 0, 0]);

      await store.upsert('a', 'similar');
      await store.upsert('b', 'less similar');
      await store.upsert('c', 'orthogonal');

      const results = await store.search('query', { threshold: 0.3 });

      // 'similar' and 'less similar' should match; 'orthogonal' should not
      expect(results.length).toBeGreaterThanOrEqual(1);
      // Results should be sorted by similarity desc
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
      }
    });

    it('should return empty array when nothing matches threshold', async () => {
      embedder.overrides.set('stored', [1, 0, 0, 0]);
      embedder.overrides.set('query_no_match', [0, 0, 0, 1]);

      await store.upsert('a', 'stored');
      const results = await store.search('query_no_match', { threshold: 0.9 });

      expect(results).toEqual([]);
    });

    it('should respect custom threshold', async () => {
      embedder.overrides.set('content1', [1, 0, 0, 0]);
      embedder.overrides.set('query_thresh', [0.8, 0.6, 0, 0]);

      await store.upsert('a', 'content1');

      // With low threshold, should match
      const low = await store.search('query_thresh', { threshold: 0.5 });
      expect(low.length).toBe(1);

      // With very high threshold, should not match
      const high = await store.search('query_thresh', { threshold: 0.99 });
      expect(high.length).toBe(0);
    });

    it('should respect limit parameter', async () => {
      // Insert many similar entries
      for (let i = 0; i < 20; i++) {
        const vec = [1, 0.01 * i, 0, 0];
        const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        embedder.overrides.set(`content_${i}`, vec.map((v) => v / mag));
        await store.upsert(`doc_${i}`, `content_${i}`);
      }
      embedder.overrides.set('search_query', [1, 0, 0, 0]);

      const results = await store.search('search_query', { limit: 5, threshold: 0.5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should default limit to 10', async () => {
      for (let i = 0; i < 15; i++) {
        const vec = [1, 0.001 * i, 0, 0];
        const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        embedder.overrides.set(`item_${i}`, vec.map((v) => v / mag));
        await store.upsert(`id_${i}`, `item_${i}`);
      }
      embedder.overrides.set('default_limit_query', [1, 0, 0, 0]);

      const results = await store.search('default_limit_query', { threshold: 0.5 });
      expect(results.length).toBeLessThanOrEqual(10);
    });

    it('should default threshold to 0.7', async () => {
      embedder.overrides.set('high_sim', [1, 0, 0, 0]);
      embedder.overrides.set('low_sim', [0.5, 0.5, 0.5, 0.5]);
      embedder.overrides.set('threshold_query', [1, 0, 0, 0]);

      await store.upsert('high', 'high_sim');
      await store.upsert('low', 'low_sim');

      const results = await store.search('threshold_query');
      // Only high_sim should pass default 0.7 threshold (similarity ~1.0)
      // low_sim has similarity ~0.5 which is below 0.7
      const ids = results.map((r) => r.entry.id);
      expect(ids).toContain('high');
      expect(ids).not.toContain('low');
    });

    it('should return empty array when store is empty', async () => {
      embedder.overrides.set('empty_query', [1, 0, 0, 0]);
      const results = await store.search('empty_query');
      expect(results).toEqual([]);
    });

    it('should include similarity score in results', async () => {
      embedder.overrides.set('sim_content', [1, 0, 0, 0]);
      embedder.overrides.set('sim_query', [1, 0, 0, 0]);

      await store.upsert('exact', 'sim_content');
      const results = await store.search('sim_query');

      expect(results.length).toBe(1);
      expect(results[0].similarity).toBeCloseTo(1.0, 5);
    });
  });

  describe('get', () => {
    it('should return existing entry', async () => {
      await store.upsert('doc1', 'Hello', { key: 'value' });
      const entry = await store.get('doc1');

      expect(entry).not.toBeNull();
      expect(entry!.id).toBe('doc1');
      expect(entry!.content).toBe('Hello');
      expect(entry!.metadata).toEqual({ key: 'value' });
    });

    it('should return null for non-existent entry', async () => {
      const entry = await store.get('nonexistent');
      expect(entry).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete existing entry and return true', async () => {
      await store.upsert('doc1', 'Content');
      const result = await store.delete('doc1');

      expect(result).toBe(true);
      expect(await store.get('doc1')).toBeNull();
      expect(await store.count()).toBe(0);
    });

    it('should return false for non-existent entry', async () => {
      const result = await store.delete('nonexistent');
      expect(result).toBe(false);
    });

    it('should not affect other entries', async () => {
      await store.upsert('doc1', 'A');
      await store.upsert('doc2', 'B');
      await store.delete('doc1');

      expect(await store.get('doc2')).not.toBeNull();
      expect(await store.count()).toBe(1);
    });
  });

  describe('isStale', () => {
    describe('source_hash strategy', () => {
      it('should return false when content hash matches', async () => {
        await store.upsert('doc1', 'Current content');
        const stale = await store.isStale('doc1', 'Current content');
        expect(stale).toBe(false);
      });

      it('should return true when content hash differs', async () => {
        await store.upsert('doc1', 'Old content');
        const stale = await store.isStale('doc1', 'New content');
        expect(stale).toBe(true);
      });

      it('should return false for non-existent entry (nothing to refresh)', async () => {
        const stale = await store.isStale('nonexistent', 'whatever');
        expect(stale).toBe(false);
      });
    });

    describe('ttl strategy', () => {
      let ttlStore: VectorStore;

      beforeEach(() => {
        ttlStore = new VectorStore(
          { table: 'ttl_test', dimensions: 4, stalenessCheck: 'ttl', ttlMs: 100 },
          embedder
        );
      });

      it('should return false when entry is within TTL', async () => {
        await ttlStore.upsert('doc1', 'Content');
        const stale = await ttlStore.isStale('doc1', 'Content');
        expect(stale).toBe(false);
      });

      it('should return true when entry exceeds TTL', async () => {
        await ttlStore.upsert('doc1', 'Content');
        // Wait for TTL to expire
        await new Promise((r) => setTimeout(r, 110));
        const stale = await ttlStore.isStale('doc1', 'Content');
        expect(stale).toBe(true);
      });
    });

    describe('none strategy', () => {
      it('should always return false', async () => {
        const noneStore = new VectorStore(
          { table: 'none_test', dimensions: 4, stalenessCheck: 'none' },
          embedder
        );
        await noneStore.upsert('doc1', 'Content');
        const stale = await noneStore.isStale('doc1', 'Different content');
        expect(stale).toBe(false);
      });
    });
  });

  describe('clear', () => {
    it('should remove all entries', async () => {
      await store.upsert('doc1', 'A');
      await store.upsert('doc2', 'B');
      await store.upsert('doc3', 'C');

      await store.clear();

      expect(await store.count()).toBe(0);
      expect(await store.listIds()).toEqual([]);
      expect(await store.get('doc1')).toBeNull();
    });
  });

  describe('count', () => {
    it('should return 0 for empty store', async () => {
      expect(await store.count()).toBe(0);
    });

    it('should return correct count after inserts', async () => {
      await store.upsert('a', 'A');
      await store.upsert('b', 'B');
      await store.upsert('c', 'C');
      expect(await store.count()).toBe(3);
    });

    it('should return correct count after deletes', async () => {
      await store.upsert('a', 'A');
      await store.upsert('b', 'B');
      await store.delete('a');
      expect(await store.count()).toBe(1);
    });
  });

  describe('listIds', () => {
    it('should return empty array when empty', async () => {
      expect(await store.listIds()).toEqual([]);
    });

    it('should return all stored ids', async () => {
      await store.upsert('alpha', 'A');
      await store.upsert('beta', 'B');
      await store.upsert('gamma', 'C');

      const ids = await store.listIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('alpha');
      expect(ids).toContain('beta');
      expect(ids).toContain('gamma');
    });
  });
});

// --- DriftStore Tests ---
describe('DriftStore', () => {
  let driftStore: DriftStore;
  let config: DriftConfig;

  beforeEach(() => {
    config = {
      retention: {
        maxAge: 7, // 7 days
        trigger: 'afterSnapshot',
        storage: 'memory',
        table: 'drift_test',
      },
    };
    driftStore = new DriftStore(config);
  });

  describe('snapshot', () => {
    it('should create a snapshot with content hash', async () => {
      const snap = await driftStore.snapshot('v1', 'Hello world');

      expect(snap.id).toBeDefined();
      expect(snap.tag).toBe('v1');
      expect(snap.content).toBe('Hello world');
      expect(snap.contentHash).toBe(hashContent('Hello world'));
      expect(snap.createdAt).toBeInstanceOf(Date);
    });

    it('should store metadata', async () => {
      const snap = await driftStore.snapshot('v1', 'Content', { version: '1.0' });
      expect(snap.metadata).toEqual({ version: '1.0' });
    });

    it('should create distinct snapshots for same tag', async () => {
      const snap1 = await driftStore.snapshot('tag', 'Content 1');
      const snap2 = await driftStore.snapshot('tag', 'Content 2');

      expect(snap1.id).not.toBe(snap2.id);
      expect(snap1.contentHash).not.toBe(snap2.contentHash);
    });

    it('should default metadata to empty object', async () => {
      const snap = await driftStore.snapshot('tag', 'Content');
      expect(snap.metadata).toEqual({});
    });
  });

  describe('compare', () => {
    it('should detect no drift when content is the same', async () => {
      await driftStore.snapshot('deploy', 'stable content');
      const result = await driftStore.compare('deploy', 'stable content');

      expect(result.drifted).toBe(false);
      expect(result.currentHash).toBe(hashContent('stable content'));
      expect(result.previousSnapshot).toBeDefined();
      expect(result.previousSnapshot!.tag).toBe('deploy');
    });

    it('should detect drift when content differs', async () => {
      await driftStore.snapshot('deploy', 'original content');
      const result = await driftStore.compare('deploy', 'modified content');

      expect(result.drifted).toBe(true);
      expect(result.currentHash).toBe(hashContent('modified content'));
      expect(result.previousSnapshot).toBeDefined();
      expect(result.previousSnapshot!.contentHash).toBe(hashContent('original content'));
    });

    it('should return drifted=false with no previousSnapshot when tag has no history', async () => {
      const result = await driftStore.compare('never_seen', 'some content');

      expect(result.drifted).toBe(false);
      expect(result.previousSnapshot).toBeUndefined();
      expect(result.currentHash).toBe(hashContent('some content'));
    });

    it('should compare against the most recent snapshot for the tag', async () => {
      await driftStore.snapshot('tag', 'version 1');
      await driftStore.snapshot('tag', 'version 2');
      const result = await driftStore.compare('tag', 'version 2');

      expect(result.drifted).toBe(false);
    });
  });

  describe('getHistory', () => {
    it('should return snapshots newest first', async () => {
      await driftStore.snapshot('tag', 'first');
      await new Promise((r) => setTimeout(r, 5));
      await driftStore.snapshot('tag', 'second');
      await new Promise((r) => setTimeout(r, 5));
      await driftStore.snapshot('tag', 'third');

      const history = await driftStore.getHistory('tag');

      expect(history).toHaveLength(3);
      expect(history[0].content).toBe('third');
      expect(history[1].content).toBe('second');
      expect(history[2].content).toBe('first');
    });

    it('should return empty array for unknown tag', async () => {
      const history = await driftStore.getHistory('unknown');
      expect(history).toEqual([]);
    });

    it('should only return snapshots for the specified tag', async () => {
      await driftStore.snapshot('alpha', 'A content');
      await driftStore.snapshot('beta', 'B content');

      const alphaHistory = await driftStore.getHistory('alpha');
      expect(alphaHistory).toHaveLength(1);
      expect(alphaHistory[0].tag).toBe('alpha');
    });
  });

  describe('gc', () => {
    it('should remove snapshots older than maxAge', async () => {
      // Create a store with 0-day maxAge for easier testing
      const shortConfig: DriftConfig = {
        retention: { maxAge: 0, trigger: 'afterSnapshot', storage: 'memory', table: 'gc_test' },
      };
      const shortStore = new DriftStore(shortConfig);

      await shortStore.snapshot('old', 'old content');
      // Wait a tiny bit so it's in the past
      await new Promise((r) => setTimeout(r, 10));

      const removed = await shortStore.gc();
      expect(removed).toBe(1);

      const history = await shortStore.getHistory('old');
      expect(history).toHaveLength(0);
    });

    it('should preserve recent snapshots', async () => {
      await driftStore.snapshot('recent', 'content');

      const removed = await driftStore.gc();
      expect(removed).toBe(0);

      const history = await driftStore.getHistory('recent');
      expect(history).toHaveLength(1);
    });

    it('should return count of removed snapshots', async () => {
      const shortConfig: DriftConfig = {
        retention: { maxAge: 0, trigger: 'afterSnapshot', storage: 'memory', table: 'gc_test' },
      };
      const shortStore = new DriftStore(shortConfig);

      await shortStore.snapshot('a', 'content a');
      await shortStore.snapshot('b', 'content b');
      await shortStore.snapshot('c', 'content c');
      await new Promise((r) => setTimeout(r, 10));

      const removed = await shortStore.gc();
      expect(removed).toBe(3);
    });
  });

  describe('clear', () => {
    it('should remove all snapshots', async () => {
      await driftStore.snapshot('tag1', 'content 1');
      await driftStore.snapshot('tag2', 'content 2');
      await driftStore.snapshot('tag3', 'content 3');

      await driftStore.clear();

      expect(await driftStore.getHistory('tag1')).toEqual([]);
      expect(await driftStore.getHistory('tag2')).toEqual([]);
      expect(await driftStore.getHistory('tag3')).toEqual([]);
    });
  });
});
