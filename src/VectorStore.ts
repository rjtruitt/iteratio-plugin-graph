// VectorStore.ts — LanceDB-compatible unified storage layer for armament workflows.
// Provides vector embeddings, drift snapshots, and semantic similarity search.
// In-memory implementation with pluggable backend interface.

// --- Interfaces & Types ---

export interface VectorEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  sourceHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VectorSearchResult {
  entry: VectorEntry;
  similarity: number;
}

export interface VectorStoreConfig {
  table: string;
  dimensions: number;
  embeddingModel?: string;
  stalenessCheck?: 'source_hash' | 'ttl' | 'none';
  ttlMs?: number;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimensions: number;
}

export interface DriftSnapshot {
  id: string;
  tag: string;
  contentHash: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface DriftCompareResult {
  drifted: boolean;
  previousSnapshot?: DriftSnapshot;
  currentHash: string;
  changes?: string[];
}

export interface DriftConfig {
  retention: {
    maxAge: number; // days
    trigger: 'afterSnapshot' | 'manual';
    storage: string;
    table: string;
  };
}

// --- Helpers ---

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  if (magnitude === 0) return 0;
  return dot / magnitude;
}

/**
 * Simple djb2-based string hash. Returns a hex string.
 */
export function hashContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit then to hex
  return (hash >>> 0).toString(16);
}

// --- VectorStore Class ---

export class VectorStore {
  private entries: Map<string, VectorEntry> = new Map();
  private config: VectorStoreConfig;
  private embeddingProvider: EmbeddingProvider;

  constructor(config: VectorStoreConfig, embeddingProvider: EmbeddingProvider) {
    this.config = config;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * Upsert an entry. Embeds content and stores it.
   * If the id already exists and the sourceHash hasn't changed, this is a no-op.
   */
  async upsert(
    id: string,
    content: string,
    metadata: Record<string, unknown> = {}
  ): Promise<VectorEntry> {
    const newHash = hashContent(content);
    const existing = this.entries.get(id);

    if (existing && existing.sourceHash === newHash) {
      // No change — return existing entry as-is
      return existing;
    }

    const embedding = await this.embeddingProvider.embed(content);
    const now = new Date();

    const entry: VectorEntry = {
      id,
      content,
      embedding,
      metadata,
      sourceHash: newHash,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.entries.set(id, entry);
    return entry;
  }

  /**
   * Semantic similarity search. Embeds query, finds entries above threshold,
   * returns sorted by similarity descending, capped at limit.
   */
  async search(
    query: string,
    options: { threshold?: number; limit?: number } = {}
  ): Promise<VectorSearchResult[]> {
    const { threshold = 0.7, limit = 10 } = options;

    if (this.entries.size === 0) {
      return [];
    }

    const queryEmbedding = await this.embeddingProvider.embed(query);
    const results: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity >= threshold) {
        results.push({ entry, similarity });
      }
    }

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);

    // Apply limit
    return results.slice(0, limit);
  }

  /**
   * Get an entry by id.
   */
  async get(id: string): Promise<VectorEntry | null> {
    return this.entries.get(id) ?? null;
  }

  /**
   * Delete an entry by id. Returns true if it existed, false otherwise.
   */
  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  /**
   * Check if an entry is stale based on the configured staleness strategy.
   * - source_hash: stale if content hash differs from stored hash
   * - ttl: stale if entry is older than ttlMs
   * - none: never stale
   *
   * Returns false for non-existent entries (nothing to refresh).
   */
  async isStale(id: string, currentContent: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }

    const strategy = this.config.stalenessCheck ?? 'source_hash';

    switch (strategy) {
      case 'source_hash': {
        const currentHash = hashContent(currentContent);
        return entry.sourceHash !== currentHash;
      }
      case 'ttl': {
        const ttl = this.config.ttlMs ?? 0;
        const age = Date.now() - entry.updatedAt.getTime();
        return age > ttl;
      }
      case 'none':
        return false;
      default:
        return false;
    }
  }

  /**
   * Remove all entries.
   */
  async clear(): Promise<void> {
    this.entries.clear();
  }

  /**
   * Return the number of stored entries.
   */
  async count(): Promise<number> {
    return this.entries.size;
  }

  /**
   * Return all stored ids.
   */
  async listIds(): Promise<string[]> {
    return Array.from(this.entries.keys());
  }
}

// --- DriftStore Class ---

let driftIdCounter = 0;

export class DriftStore {
  private snapshots: DriftSnapshot[] = [];
  private config: DriftConfig;

  constructor(config: DriftConfig) {
    this.config = config;
  }

  /**
   * Take a drift snapshot. Stores content with its hash and metadata.
   */
  async snapshot(
    tag: string,
    content: string,
    metadata: Record<string, unknown> = {}
  ): Promise<DriftSnapshot> {
    const snap: DriftSnapshot = {
      id: `drift_${++driftIdCounter}_${Date.now()}`,
      tag,
      contentHash: hashContent(content),
      content,
      metadata,
      createdAt: new Date(),
    };

    this.snapshots.push(snap);
    return snap;
  }

  /**
   * Compare current content against the most recent snapshot for a tag.
   * - If no snapshot exists for the tag, returns drifted=false with no previousSnapshot.
   * - If content hash matches last snapshot, returns drifted=false.
   * - If content hash differs, returns drifted=true.
   */
  async compare(tag: string, currentContent: string): Promise<DriftCompareResult> {
    const currentHash = hashContent(currentContent);
    const tagSnapshots = this.snapshots.filter((s) => s.tag === tag);

    if (tagSnapshots.length === 0) {
      return { drifted: false, currentHash };
    }

    // Most recent = last inserted (highest index), stable regardless of timestamp ties
    const latest = tagSnapshots[tagSnapshots.length - 1];
    const drifted = latest.contentHash !== currentHash;

    return {
      drifted,
      previousSnapshot: latest,
      currentHash,
    };
  }

  /**
   * Get all snapshots for a tag, newest first.
   * Uses reverse insertion order (most recently added = newest).
   */
  async getHistory(tag: string): Promise<DriftSnapshot[]> {
    return this.snapshots.filter((s) => s.tag === tag).reverse();
  }

  /**
   * Garbage collect expired snapshots based on retention.maxAge (in days).
   * Returns the number of removed snapshots.
   */
  async gc(): Promise<number> {
    const maxAgeMs = this.config.retention.maxAge * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;
    const before = this.snapshots.length;

    this.snapshots = this.snapshots.filter((s) => s.createdAt.getTime() > cutoff);

    return before - this.snapshots.length;
  }

  /**
   * Remove all snapshots.
   */
  async clear(): Promise<void> {
    this.snapshots = [];
  }
}
