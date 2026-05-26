/**
 * ToolCache.ts — Transparent caching middleware for tool execution in armament workflows.
 * Sits between ToolGuard (safety layer) and actual MCP tool calls.
 */

// Re-export types for backwards compatibility
export {
  StalenessStrategy,
  CacheableToolSpec,
  ToolCacheConfig,
  ToolCacheEntry,
  CacheCheckResult,
  ToolCacheStats,
  ToolCache,
} from './ToolCacheTypes';

import { VectorStore, hashContent } from './VectorStore';
import {
  StalenessStrategy,
  CacheableToolSpec,
  ToolCacheConfig,
  ToolCacheEntry,
  CacheCheckResult,
  ToolCacheStats,
  ToolCache,
} from './ToolCacheTypes';

// --- Glob Matching ---

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(value);
}

// --- Cost per avoided call (for stats) ---
const COST_PER_CALL = 0.01;

// --- Factory ---

/** Creates a tool cache with TTL-based expiration. */
export function createToolCache(config: ToolCacheConfig, vectorStore: VectorStore): ToolCache {
  let enabled = config.enabled;
  const registeredSpecs = new Map<string, CacheableToolSpec>();
  const entryTracker = new Map<string, ToolCacheEntry>();

  let totalHits = 0;
  let totalMisses = 0;
  let costSaved = 0;
  const perToolHits = new Map<string, number>();

  // --- Helpers ---

  function matchesAnyGlob(patterns: string[], toolName: string): boolean {
    return patterns.some((p) => globMatch(p, toolName));
  }

  function isExcluded(toolName: string): boolean {
    return matchesAnyGlob(config.excludes, toolName);
  }

  function isInAppliesTo(toolName: string): boolean {
    return matchesAnyGlob(config.applies_to, toolName);
  }

  function getSpec(toolName: string): CacheableToolSpec | undefined {
    return registeredSpecs.get(toolName);
  }

  function getCacheKeyFields(toolName: string, inputs: Record<string, unknown>): Record<string, unknown> {
    const spec = getSpec(toolName);
    if (spec?.cacheKeyFrom && spec.cacheKeyFrom.length > 0) {
      const filtered: Record<string, unknown> = {};
      for (const field of spec.cacheKeyFrom) {
        if (field in inputs) filtered[field] = inputs[field];
      }
      return filtered;
    }
    return inputs;
  }

  function buildCacheKey(toolName: string, inputs: Record<string, unknown>): string {
    const relevantInputs = getCacheKeyFields(toolName, inputs);
    const sortedKeys = Object.keys(relevantInputs).sort();
    const sortedObj: Record<string, unknown> = {};
    for (const k of sortedKeys) sortedObj[k] = relevantInputs[k];
    return `${toolName}:${JSON.stringify(sortedObj)}`;
  }

  function getStalenessStrategy(toolName: string): StalenessStrategy | undefined {
    if (config.staleness_strategies && config.staleness_strategies[toolName]) {
      return config.staleness_strategies[toolName];
    }
    const spec = getSpec(toolName);
    if (spec?.staleness) return spec.staleness;
    return undefined;
  }

  function isEntryStale(entry: ToolCacheEntry, toolName: string): boolean {
    const strategy = getStalenessStrategy(toolName);
    if (!strategy) return false;

    switch (strategy.type) {
      case 'ttl': {
        const ttlMs = strategy.hours * 60 * 60 * 1000;
        const age = Date.now() - entry.storedAt.getTime();
        return age > ttlMs;
      }
      case 'content_hash':
      case 'none':
      case 'commit_sha':
      case 'version':
      case 'timestamp':
        return false;
      default:
        return false;
    }
  }

  function recordHit(toolName: string): void {
    totalHits++;
    costSaved += COST_PER_CALL;
    perToolHits.set(toolName, (perToolHits.get(toolName) ?? 0) + 1);
  }

  function recordMiss(): void {
    totalMisses++;
  }

  function getVectorId(cacheKey: string): string {
    return `tc_${hashContent(cacheKey)}`;
  }

  async function evictLRU(): Promise<void> {
    if (!config.maxEntries || entryTracker.size <= config.maxEntries) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of entryTracker.entries()) {
      const time = entry.lastHitAt?.getTime() ?? entry.storedAt.getTime();
      if (time < oldestTime) { oldestTime = time; oldestKey = key; }
    }

    if (oldestKey) {
      const vectorId = getVectorId(oldestKey);
      await vectorStore.delete(vectorId);
      entryTracker.delete(oldestKey);
    }
  }

  // --- ToolCache Implementation ---

  const toolCache: ToolCache = {
    async check(toolName: string, inputs: Record<string, unknown>): Promise<CacheCheckResult> {
      if (!enabled) return { hit: false, reason: 'disabled' };
      if (isExcluded(toolName)) return { hit: false, reason: 'excluded' };
      if (!toolCache.isToolCacheable(toolName)) return { hit: false, reason: 'not cacheable' };

      const cacheKey = buildCacheKey(toolName, inputs);

      const results = await vectorStore.search(cacheKey, { threshold: config.defaultThreshold, limit: 1 });

      if (results.length === 0) {
        recordMiss();
        config.onCacheMiss?.(toolName);
        return { hit: false, reason: 'below threshold' };
      }

      const topResult = results[0];

      if (topResult.entry.metadata.type !== 'tool_cache') {
        recordMiss();
        config.onCacheMiss?.(toolName);
        return { hit: false, reason: 'below threshold' };
      }

      const trackedEntry = entryTracker.get(cacheKey);
      if (!trackedEntry) {
        recordMiss();
        config.onCacheMiss?.(toolName);
        return { hit: false, reason: 'below threshold' };
      }

      if (isEntryStale(trackedEntry, toolName)) {
        recordMiss();
        config.onCacheMiss?.(toolName);
        return { hit: false, reason: 'stale' };
      }

      trackedEntry.hitCount++;
      trackedEntry.lastHitAt = new Date();
      recordHit(toolName);
      config.onCacheHit?.(toolName, topResult.similarity);

      return { hit: true, result: trackedEntry.result, similarity: topResult.similarity, entry: { ...trackedEntry } };
    },

    async store(toolName: string, inputs: Record<string, unknown>, result: unknown): Promise<void> {
      const cacheKey = buildCacheKey(toolName, inputs);
      const vectorId = getVectorId(cacheKey);
      const content = cacheKey;

      await vectorStore.upsert(vectorId, content, {
        type: 'tool_cache',
        toolName,
        inputs: JSON.stringify(inputs),
        storedAt: new Date().toISOString(),
        hitCount: 0,
      });

      const entry: ToolCacheEntry = {
        toolName, cacheKey, inputs, result,
        storedAt: new Date(), hitCount: 0, lastHitAt: undefined,
      };
      entryTracker.set(cacheKey, entry);

      config.onCacheStore?.(toolName, cacheKey);
      await evictLRU();
    },

    async invalidate(toolName: string, inputs?: Record<string, unknown>): Promise<number> {
      let count = 0;

      if (inputs !== undefined) {
        const cacheKey = buildCacheKey(toolName, inputs);
        const vectorId = getVectorId(cacheKey);
        const deleted = await vectorStore.delete(vectorId);
        if (deleted) { entryTracker.delete(cacheKey); count = 1; }
      } else {
        const keysToDelete: string[] = [];
        for (const [key, entry] of entryTracker.entries()) {
          if (entry.toolName === toolName) keysToDelete.push(key);
        }
        for (const key of keysToDelete) {
          const vectorId = getVectorId(key);
          await vectorStore.delete(vectorId);
          entryTracker.delete(key);
          count++;
        }
      }

      return count;
    },

    async invalidateByPattern(pattern: string): Promise<number> {
      let count = 0;
      const keysToDelete: string[] = [];

      for (const [key, entry] of entryTracker.entries()) {
        if (globMatch(pattern, entry.toolName)) keysToDelete.push(key);
      }

      for (const key of keysToDelete) {
        const vectorId = getVectorId(key);
        await vectorStore.delete(vectorId);
        entryTracker.delete(key);
        count++;
      }

      return count;
    },

    getStats(): ToolCacheStats {
      const total = totalHits + totalMisses;
      const hitRate = total > 0 ? totalHits / total : 0;

      const topHitTools: Array<{ tool: string; hits: number }> = [];
      for (const [tool, hits] of perToolHits.entries()) topHitTools.push({ tool, hits });
      topHitTools.sort((a, b) => b.hits - a.hits);

      return { totalHits, totalMisses, hitRate, entriesCount: entryTracker.size, costSaved, topHitTools };
    },

    isToolCacheable(toolName: string): boolean {
      if (isExcluded(toolName)) return false;
      const spec = getSpec(toolName);
      if (spec && !spec.cacheable) return false;
      if (isInAppliesTo(toolName)) return true;
      if (spec && spec.cacheable) return true;
      return false;
    },

    getCacheKey(toolName: string, inputs: Record<string, unknown>): string {
      return buildCacheKey(toolName, inputs);
    },

    setEnabled(value: boolean): void {
      enabled = value;
    },

    async clear(): Promise<void> {
      for (const key of entryTracker.keys()) {
        const vectorId = getVectorId(key);
        await vectorStore.delete(vectorId);
      }
      entryTracker.clear();
      totalHits = 0;
      totalMisses = 0;
      costSaved = 0;
      perToolHits.clear();
    },

    registerCacheableSpec(spec: CacheableToolSpec): void {
      registeredSpecs.set(spec.name, spec);
    },
  };

  return toolCache;
}
