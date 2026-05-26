import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDriftRetentionManager,
  DriftRetentionConfig,
  DriftEntry,
  DriftHook,
  DriftRetentionManager,
} from '../DriftRetention';

function makeEntry(overrides: Partial<DriftEntry> = {}): DriftEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tag: overrides.tag ?? 'default',
    contentHash: overrides.contentHash ?? 'abc123',
    content: overrides.content ?? 'snapshot content',
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? new Date(),
  };
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

describe('DriftRetention', () => {
  let manager: DriftRetentionManager;
  let defaultConfig: DriftRetentionConfig;

  beforeEach(() => {
    defaultConfig = {
      maxAge: 30,
      trigger: 'manual',
    };
    manager = createDriftRetentionManager(defaultConfig);
  });

  describe('gc removes entries older than maxAge', () => {
    it('should remove entries older than maxAge days', async () => {
      const oldEntry = makeEntry({ id: 'old', createdAt: daysAgo(31) });
      const recentEntry = makeEntry({ id: 'recent', createdAt: daysAgo(5) });

      manager.addEntry(oldEntry);
      manager.addEntry(recentEntry);

      const result = await manager.gc();

      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].id).toBe('old');
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0].id).toBe('recent');
    });
  });

  describe('gc preserves entries within maxAge', () => {
    it('should keep all entries newer than maxAge', async () => {
      const entry1 = makeEntry({ id: 'e1', createdAt: daysAgo(10) });
      const entry2 = makeEntry({ id: 'e2', createdAt: daysAgo(20) });
      const entry3 = makeEntry({ id: 'e3', createdAt: daysAgo(29) });

      manager.addEntry(entry1);
      manager.addEntry(entry2);
      manager.addEntry(entry3);

      const result = await manager.gc();

      expect(result.removed).toHaveLength(0);
      expect(result.kept).toHaveLength(3);
    });
  });

  describe('gc with preserveLatest', () => {
    it('should keep the newest entry per tag even if older than maxAge', async () => {
      manager.setConfig({ ...defaultConfig, preserveLatest: true });

      const oldest = makeEntry({ id: 'oldest', tag: 'deploy', createdAt: daysAgo(60) });
      const newer = makeEntry({ id: 'newer', tag: 'deploy', createdAt: daysAgo(45) });
      const unrelatedOld = makeEntry({ id: 'other', tag: 'backup', createdAt: daysAgo(50) });

      manager.addEntry(oldest);
      manager.addEntry(newer);
      manager.addEntry(unrelatedOld);

      const result = await manager.gc();

      // 'newer' is the latest for 'deploy' — preserved
      // 'unrelatedOld' is the latest for 'backup' — preserved
      // 'oldest' is NOT the latest for 'deploy' and is old — removed
      expect(result.kept.map((e) => e.id).sort()).toEqual(['newer', 'other'].sort());
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].id).toBe('oldest');
    });
  });

  describe('gc with maxSnapshots', () => {
    it('should trim excess snapshots per tag keeping only the N most recent', async () => {
      manager.setConfig({ ...defaultConfig, maxSnapshots: 2 });

      const e1 = makeEntry({ id: 'e1', tag: 'logs', createdAt: daysAgo(3) });
      const e2 = makeEntry({ id: 'e2', tag: 'logs', createdAt: daysAgo(2) });
      const e3 = makeEntry({ id: 'e3', tag: 'logs', createdAt: daysAgo(1) });

      manager.addEntry(e1);
      manager.addEntry(e2);
      manager.addEntry(e3);

      const result = await manager.gc();

      expect(result.kept).toHaveLength(2);
      expect(result.kept.map((e) => e.id).sort()).toEqual(['e2', 'e3'].sort());
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].id).toBe('e1');
    });
  });

  describe('gc with both maxAge and maxSnapshots', () => {
    it('maxSnapshots takes precedence on count after maxAge filtering', async () => {
      manager.setConfig({ ...defaultConfig, maxAge: 30, maxSnapshots: 1 });

      // All within maxAge, but maxSnapshots=1 trims to most recent per tag
      const e1 = makeEntry({ id: 'e1', tag: 'x', createdAt: daysAgo(10) });
      const e2 = makeEntry({ id: 'e2', tag: 'x', createdAt: daysAgo(5) });
      const e3 = makeEntry({ id: 'e3', tag: 'x', createdAt: daysAgo(1) });

      manager.addEntry(e1);
      manager.addEntry(e2);
      manager.addEntry(e3);

      const result = await manager.gc();

      expect(result.kept).toHaveLength(1);
      expect(result.kept[0].id).toBe('e3');
      expect(result.removed).toHaveLength(2);
    });
  });

  describe('afterSnapshot trigger auto-runs GC on addEntry', () => {
    it('should call gc automatically when trigger is afterSnapshot', async () => {
      manager.setConfig({ ...defaultConfig, trigger: 'afterSnapshot' });

      const oldEntry = makeEntry({ id: 'old', createdAt: daysAgo(31) });
      manager.addEntry(oldEntry);

      // GC runs after addEntry, so old entry should be removed
      // We need to wait a tick for the async gc to complete
      await vi.waitFor(() => {
        expect(manager.getEntries()).toHaveLength(0);
      });
    });
  });

  describe('manual trigger does NOT auto-run GC', () => {
    it('should not remove old entries on addEntry when trigger is manual', () => {
      manager.setConfig({ ...defaultConfig, trigger: 'manual' });

      const oldEntry = makeEntry({ id: 'old', createdAt: daysAgo(31) });
      manager.addEntry(oldEntry);

      // Entry is still there because gc was not called
      expect(manager.getEntries()).toHaveLength(1);
    });
  });

  describe('onSchedule trigger does NOT auto-run GC', () => {
    it('should not remove old entries on addEntry when trigger is onSchedule', () => {
      manager.setConfig({ ...defaultConfig, trigger: 'onSchedule' });

      const oldEntry = makeEntry({ id: 'old', createdAt: daysAgo(31) });
      manager.addEntry(oldEntry);

      expect(manager.getEntries()).toHaveLength(1);
    });
  });

  describe('Hook: beforeGC fires before removal', () => {
    it('should invoke beforeGC hook with entries before any are removed', async () => {
      const handler = vi.fn();
      manager.registerHook({
        name: 'pre-gc',
        trigger: 'beforeGC',
        handler,
      });

      const entry = makeEntry({ id: 'e1', createdAt: daysAgo(31) });
      manager.addEntry(entry);

      await manager.gc();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'beforeGC',
          entries: expect.arrayContaining([expect.objectContaining({ id: 'e1' })]),
        }),
      );
    });
  });

  describe('Hook: afterGC fires with removed count', () => {
    it('should invoke afterGC hook with the number of removed entries', async () => {
      const handler = vi.fn();
      manager.registerHook({
        name: 'post-gc',
        trigger: 'afterGC',
        handler,
      });

      manager.addEntry(makeEntry({ id: 'old1', createdAt: daysAgo(31) }));
      manager.addEntry(makeEntry({ id: 'old2', createdAt: daysAgo(32) }));
      manager.addEntry(makeEntry({ id: 'recent', createdAt: daysAgo(1) }));

      await manager.gc();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'afterGC',
          removedCount: 2,
        }),
      );
    });
  });

  describe('Hook: afterSnapshot fires on addEntry', () => {
    it('should invoke afterSnapshot hook whenever an entry is added', () => {
      const handler = vi.fn();
      manager.registerHook({
        name: 'snap-hook',
        trigger: 'afterSnapshot',
        handler,
      });

      const entry = makeEntry({ id: 'snap1' });
      manager.addEntry(entry);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'afterSnapshot',
          snapshot: expect.objectContaining({ id: 'snap1' }),
        }),
      );
    });
  });

  describe('Hook: onDrift registration', () => {
    it('should register and unregister an onDrift hook without error', () => {
      const handler = vi.fn();
      manager.registerHook({
        name: 'drift-hook',
        trigger: 'onDrift',
        handler,
      });

      // Verify it doesn't throw
      expect(() => manager.unregisterHook('drift-hook')).not.toThrow();
    });
  });

  describe('getEntries with no tag returns all', () => {
    it('should return all stored entries when no tag filter provided', () => {
      manager.addEntry(makeEntry({ tag: 'alpha' }));
      manager.addEntry(makeEntry({ tag: 'beta' }));
      manager.addEntry(makeEntry({ tag: 'alpha' }));

      expect(manager.getEntries()).toHaveLength(3);
    });
  });

  describe('getEntries with tag filters correctly', () => {
    it('should return only entries matching the given tag', () => {
      manager.addEntry(makeEntry({ id: 'a1', tag: 'alpha' }));
      manager.addEntry(makeEntry({ id: 'b1', tag: 'beta' }));
      manager.addEntry(makeEntry({ id: 'a2', tag: 'alpha' }));

      const alphas = manager.getEntries('alpha');
      expect(alphas).toHaveLength(2);
      expect(alphas.every((e) => e.tag === 'alpha')).toBe(true);
    });
  });

  describe('getLatest returns most recent for tag', () => {
    it('should return the entry with the newest createdAt for the given tag', () => {
      manager.addEntry(makeEntry({ id: 'old', tag: 'deploy', createdAt: daysAgo(10) }));
      manager.addEntry(makeEntry({ id: 'new', tag: 'deploy', createdAt: daysAgo(1) }));
      manager.addEntry(makeEntry({ id: 'other', tag: 'backup', createdAt: new Date() }));

      const latest = manager.getLatest('deploy');
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe('new');
    });
  });

  describe('getLatest returns null for unknown tag', () => {
    it('should return null when no entries exist for the tag', () => {
      manager.addEntry(makeEntry({ tag: 'alpha' }));

      expect(manager.getLatest('nonexistent')).toBeNull();
    });
  });

  describe('getStats returns correct counts and dates', () => {
    it('should produce accurate summary statistics', () => {
      const oldest = daysAgo(20);
      const newest = daysAgo(1);

      manager.addEntry(makeEntry({ tag: 'a', createdAt: oldest }));
      manager.addEntry(makeEntry({ tag: 'a', createdAt: daysAgo(10) }));
      manager.addEntry(makeEntry({ tag: 'b', createdAt: newest }));

      const stats = manager.getStats();

      expect(stats.totalEntries).toBe(3);
      expect(stats.entriesByTag).toEqual({ a: 2, b: 1 });
      expect(stats.oldestEntry).toEqual(oldest);
      expect(stats.newestEntry).toEqual(newest);
    });

    it('should return undefined dates when no entries exist', () => {
      const stats = manager.getStats();

      expect(stats.totalEntries).toBe(0);
      expect(stats.entriesByTag).toEqual({});
      expect(stats.oldestEntry).toBeUndefined();
      expect(stats.newestEntry).toBeUndefined();
    });
  });

  describe('setConfig updates behavior dynamically', () => {
    it('should change maxAge and affect subsequent gc calls', async () => {
      manager.addEntry(makeEntry({ id: 'e1', createdAt: daysAgo(10) }));

      // With maxAge=30, entry is kept
      let result = await manager.gc();
      expect(result.kept).toHaveLength(1);

      // Change maxAge to 5 days
      manager.setConfig({ ...defaultConfig, maxAge: 5 });
      result = await manager.gc();
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].id).toBe('e1');
    });
  });

  describe('unregisterHook removes the hook', () => {
    it('should not fire a hook after it has been unregistered', async () => {
      const handler = vi.fn();
      manager.registerHook({
        name: 'removable',
        trigger: 'afterGC',
        handler,
      });

      manager.unregisterHook('removable');

      manager.addEntry(makeEntry({ createdAt: daysAgo(31) }));
      await manager.gc();

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
