/** Configuration for drift workspace retention policies. */
export interface DriftRetentionConfig {
  maxAge: number;
  trigger: 'afterSnapshot' | 'onSchedule' | 'manual';
  maxSnapshots?: number;
  preserveLatest?: boolean;
}

export interface DriftEntry {
  id: string;
  tag: string;
  contentHash: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface DriftHook {
  name: string;
  trigger: 'beforeGC' | 'afterGC' | 'afterSnapshot' | 'onDrift';
  handler: (context: DriftHookContext) => Promise<void>;
}

export interface DriftHookContext {
  event: string;
  entries?: DriftEntry[];
  removedCount?: number;
  snapshot?: DriftEntry;
  driftDetected?: boolean;
  tag?: string;
}

/** Manages drift workspace lifecycle including cleanup, archiving, and retention enforcement. */
export interface DriftRetentionManager {
  addEntry(entry: DriftEntry): void;
  gc(): Promise<{ removed: DriftEntry[]; kept: DriftEntry[] }>;
  getEntries(tag?: string): DriftEntry[];
  getLatest(tag: string): DriftEntry | null;
  registerHook(hook: DriftHook): void;
  unregisterHook(name: string): void;
  setConfig(config: DriftRetentionConfig): void;
  getConfig(): DriftRetentionConfig;
  getStats(): {
    totalEntries: number;
    entriesByTag: Record<string, number>;
    oldestEntry?: Date;
    newestEntry?: Date;
  };
}

/** Creates a drift retention manager with the given configuration. */
export function createDriftRetentionManager(initialConfig: DriftRetentionConfig): DriftRetentionManager {
  let config: DriftRetentionConfig = { ...initialConfig };
  let entries: DriftEntry[] = [];
  let hooks: DriftHook[] = [];

  async function fireHooks(trigger: DriftHook['trigger'], context: DriftHookContext): Promise<void> {
    const matching = hooks.filter((h) => h.trigger === trigger);
    for (const hook of matching) {
      await hook.handler(context);
    }
  }

  function getLatestPerTag(): Map<string, DriftEntry> {
    const latest = new Map<string, DriftEntry>();
    for (const entry of entries) {
      const current = latest.get(entry.tag);
      if (!current || entry.createdAt.getTime() > current.createdAt.getTime()) {
        latest.set(entry.tag, entry);
      }
    }
    return latest;
  }

  const manager: DriftRetentionManager = {
    addEntry(entry: DriftEntry): void {
      entries.push(entry);

      // Fire afterSnapshot hooks (fire-and-forget for sync addEntry API)
      fireHooks('afterSnapshot', { event: 'afterSnapshot', snapshot: entry });

      if (config.trigger === 'afterSnapshot') {
        // Auto-run GC asynchronously
        manager.gc();
      }
    },

    async gc(): Promise<{ removed: DriftEntry[]; kept: DriftEntry[] }> {
      // Fire beforeGC hooks
      await fireHooks('beforeGC', { event: 'beforeGC', entries: [...entries] });

      const now = Date.now();
      const maxAgeMs = config.maxAge * 24 * 60 * 60 * 1000;
      const latestPerTag = config.preserveLatest ? getLatestPerTag() : new Map<string, DriftEntry>();

      // Step 1: Remove entries older than maxAge (preserving latest if configured)
      let kept: DriftEntry[] = [];
      let removed: DriftEntry[] = [];

      for (const entry of entries) {
        const age = now - entry.createdAt.getTime();
        const isOld = age > maxAgeMs;
        const isLatestForTag = config.preserveLatest && latestPerTag.get(entry.tag) === entry;

        if (isOld && !isLatestForTag) {
          removed.push(entry);
        } else {
          kept.push(entry);
        }
      }

      // Step 2: Apply maxSnapshots limit per tag
      if (config.maxSnapshots !== undefined) {
        const byTag = new Map<string, DriftEntry[]>();
        for (const entry of kept) {
          const tagEntries = byTag.get(entry.tag) || [];
          tagEntries.push(entry);
          byTag.set(entry.tag, tagEntries);
        }

        const finalKept: DriftEntry[] = [];
        for (const [, tagEntries] of byTag) {
          // Sort by createdAt descending (newest first)
          tagEntries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          const toKeep = tagEntries.slice(0, config.maxSnapshots);
          const toRemove = tagEntries.slice(config.maxSnapshots);
          finalKept.push(...toKeep);
          removed.push(...toRemove);
        }
        kept = finalKept;
      }

      // Update internal state
      entries = kept;

      // Fire afterGC hooks
      await fireHooks('afterGC', { event: 'afterGC', removedCount: removed.length });

      return { removed, kept };
    },

    getEntries(tag?: string): DriftEntry[] {
      if (tag === undefined) {
        return [...entries];
      }
      return entries.filter((e) => e.tag === tag);
    },

    getLatest(tag: string): DriftEntry | null {
      const tagged = entries.filter((e) => e.tag === tag);
      if (tagged.length === 0) return null;
      return tagged.reduce((latest, entry) =>
        entry.createdAt.getTime() > latest.createdAt.getTime() ? entry : latest,
      );
    },

    registerHook(hook: DriftHook): void {
      hooks.push(hook);
    },

    unregisterHook(name: string): void {
      hooks = hooks.filter((h) => h.name !== name);
    },

    setConfig(newConfig: DriftRetentionConfig): void {
      config = { ...newConfig };
    },

    getConfig(): DriftRetentionConfig {
      return { ...config };
    },

    getStats(): {
      totalEntries: number;
      entriesByTag: Record<string, number>;
      oldestEntry?: Date;
      newestEntry?: Date;
    } {
      const entriesByTag: Record<string, number> = {};
      let oldestEntry: Date | undefined;
      let newestEntry: Date | undefined;

      for (const entry of entries) {
        entriesByTag[entry.tag] = (entriesByTag[entry.tag] || 0) + 1;
        if (!oldestEntry || entry.createdAt.getTime() < oldestEntry.getTime()) {
          oldestEntry = entry.createdAt;
        }
        if (!newestEntry || entry.createdAt.getTime() > newestEntry.getTime()) {
          newestEntry = entry.createdAt;
        }
      }

      return {
        totalEntries: entries.length,
        entriesByTag,
        oldestEntry,
        newestEntry,
      };
    },
  };

  return manager;
}
