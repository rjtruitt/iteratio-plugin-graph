/**
 * ToolCacheTypes.ts
 *
 * Type definitions for the ToolCache transparent caching middleware.
 */

import type { ToolSpec } from './ToolGuard';

// --- Types & Interfaces ---

/** Strategy for determining when a cached tool result is stale. */
export type StalenessStrategy =
  | { type: 'commit_sha'; field: string }
  | { type: 'version'; field: string }
  | { type: 'timestamp'; field: string }
  | { type: 'ttl'; hours: number }
  | { type: 'content_hash' }
  | { type: 'none' };

export interface CacheableToolSpec extends ToolSpec {
  cacheable: boolean;
  cacheKeyFrom?: string[];
  staleness?: StalenessStrategy;
  ttlHours?: number;
}

export interface ToolCacheConfig {
  enabled: boolean;
  defaultThreshold: number;
  defaultTtlHours: number;
  applies_to: string[];
  excludes: string[];
  staleness_strategies?: Record<string, StalenessStrategy>;
  maxEntries?: number;
  onCacheHit?: (tool: string, similarity: number) => void;
  onCacheMiss?: (tool: string) => void;
  onCacheStore?: (tool: string, key: string) => void;
}

export interface ToolCacheEntry {
  toolName: string;
  cacheKey: string;
  inputs: Record<string, unknown>;
  result: unknown;
  storedAt: Date;
  hitCount: number;
  lastHitAt?: Date;
}

export interface CacheCheckResult {
  hit: boolean;
  result?: unknown;
  similarity?: number;
  entry?: ToolCacheEntry;
  reason?: string;
}

export interface ToolCacheStats {
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  entriesCount: number;
  costSaved: number;
  topHitTools: Array<{ tool: string; hits: number }>;
}

export interface ToolCache {
  check(toolName: string, inputs: Record<string, unknown>): Promise<CacheCheckResult>;
  store(toolName: string, inputs: Record<string, unknown>, result: unknown): Promise<void>;
  invalidate(toolName: string, inputs?: Record<string, unknown>): Promise<number>;
  invalidateByPattern(pattern: string): Promise<number>;
  getStats(): ToolCacheStats;
  isToolCacheable(toolName: string): boolean;
  getCacheKey(toolName: string, inputs: Record<string, unknown>): string;
  setEnabled(enabled: boolean): void;
  clear(): Promise<void>;
  registerCacheableSpec(spec: CacheableToolSpec): void;
}
