/**
 * JobManager.test.ts — Exhaustive TDD test suite for JobManager
 *
 * Tests the toad-scheduler abstraction layer for .arma.workflow scheduled execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JobManager,
  JobExecutor,
  JobManagerConfig,
  JobStatus,
  JobHistoryEntry,
  JobInfo,
} from '../JobManager';
import { WorkflowDefinition, WorkflowSchedule } from '../WorkflowBuilder';

// --- Helpers ---

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'test-workflow',
    version: '1.0',
    description: 'A test workflow',
    schedule: { interval_hours: 1, max_concurrent: 1, catch_up: false },
    agents: [],
    graphs: {},
    pipeline: [],
    ...overrides,
  };
}

function makeExecutor(result: { success: boolean; error?: string; cost?: number } = { success: true, cost: 0.05 }): JobExecutor {
  return vi.fn().mockResolvedValue(result);
}

function makeSlowExecutor(ms: number, result: { success: boolean; error?: string; cost?: number } = { success: true }): JobExecutor {
  return vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(result), ms)));
}

function makeFailingExecutor(error: string = 'execution failed'): JobExecutor {
  return vi.fn().mockResolvedValue({ success: false, error });
}

function makeThrowingExecutor(error: string = 'unexpected crash'): JobExecutor {
  return vi.fn().mockRejectedValue(new Error(error));
}

// --- Tests ---

describe('JobManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Registration', () => {
    it('should register a workflow with a schedule', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);

      const info = manager.getInfo('test-workflow');
      expect(info.name).toBe('test-workflow');
      expect(info.status).toBe('running');
      expect(info.schedule).toEqual(wf.schedule);
      expect(info.history).toEqual([]);
      expect(info.totalRuns).toBe(0);
      expect(info.totalCost).toBe(0);
    });

    it('should throw if workflow has no schedule', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: undefined });

      expect(() => manager.register(wf)).toThrow(/schedule/i);
    });

    it('should throw if workflow is already registered', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      expect(() => manager.register(wf)).toThrow(/already registered/i);
    });

    it('should auto-start the job upon registration', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);

      const info = manager.getInfo('test-workflow');
      expect(info.status).toBe('running');
      expect(info.nextRunAt).toBeDefined();
    });

    it('should compute nextRunAt based on interval_hours', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 2 } });

      manager.register(wf);

      const info = manager.getInfo('test-workflow');
      const expectedNext = new Date(Date.now() + 2 * 60 * 60 * 1000);
      expect(info.nextRunAt!.getTime()).toBe(expectedNext.getTime());
    });
  });

  describe('Unregistration', () => {
    it('should remove a registered job', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      manager.unregister('test-workflow');

      expect(() => manager.getInfo('test-workflow')).toThrow();
    });

    it('should throw when unregistering an unknown job', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      expect(() => manager.unregister('nonexistent')).toThrow(/not registered/i);
    });

    it('should stop the timer when unregistering', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1 } });

      manager.register(wf);
      manager.unregister('test-workflow');

      // Advance time past the interval — executor should NOT be called
      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('Start/Stop lifecycle', () => {
    it('should stop a running job (pauses timer)', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1 } });

      manager.register(wf);
      manager.stop('test-workflow');

      const info = manager.getInfo('test-workflow');
      expect(info.status).toBe('paused');
    });

    it('should not fire executor when job is stopped', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1 } });

      manager.register(wf);
      manager.stop('test-workflow');

      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should restart a stopped job', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1 } });

      manager.register(wf);
      manager.stop('test-workflow');
      manager.start('test-workflow');

      const info = manager.getInfo('test-workflow');
      expect(info.status).toBe('running');
    });

    it('should fire executor after restart when interval elapses', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1 } });

      manager.register(wf);
      manager.stop('test-workflow');
      manager.start('test-workflow');

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(executor).toHaveBeenCalledTimes(1);
    });

    it('should throw when starting an unknown job', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      expect(() => manager.start('nonexistent')).toThrow(/not registered/i);
    });

    it('should throw when stopping an unknown job', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      expect(() => manager.stop('nonexistent')).toThrow(/not registered/i);
    });
  });

  describe('Trigger (immediate execution)', () => {
    it('should run the workflow immediately and return a history entry', async () => {
      const executor = makeExecutor({ success: true, cost: 0.10 });
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      const entry = await manager.trigger('test-workflow');

      expect(entry.status).toBe('completed');
      expect(entry.cost).toBe(0.10);
      expect(entry.runId).toMatch(/^test-workflow-/);
      expect(entry.startedAt).toBeInstanceOf(Date);
      expect(entry.completedAt).toBeInstanceOf(Date);
    });

    it('should pass workflow and inputs to executor', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ inputs: { key: 'value' } });

      manager.register(wf);
      await manager.trigger('test-workflow');

      expect(executor).toHaveBeenCalledWith(wf, { key: 'value' });
    });

    it('should record a failed entry when executor returns success: false', async () => {
      const executor = makeFailingExecutor('bad input');
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      const entry = await manager.trigger('test-workflow');

      expect(entry.status).toBe('failed');
      expect(entry.error).toBe('bad input');
    });

    it('should record a failed entry when executor throws', async () => {
      const executor = makeThrowingExecutor('crash!');
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      const entry = await manager.trigger('test-workflow');

      expect(entry.status).toBe('failed');
      expect(entry.error).toBe('crash!');
    });

    it('should throw when triggering an unknown job', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      await expect(manager.trigger('nonexistent')).rejects.toThrow(/not registered/i);
    });

    it('should add entry to history', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');

      const info = manager.getInfo('test-workflow');
      expect(info.history.length).toBe(1);
      expect(info.totalRuns).toBe(1);
    });
  });

  describe('Scheduled execution (interval)', () => {
    it('should execute when the interval elapses', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1 } });

      manager.register(wf);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(executor).toHaveBeenCalledTimes(1);
    });

    it('should execute multiple times across multiple intervals', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1 } });

      manager.register(wf);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(executor).toHaveBeenCalledTimes(2);
    });

    it('should update nextRunAt after each execution', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1 } });

      manager.register(wf);

      const initialNext = manager.getInfo('test-workflow').nextRunAt!.getTime();

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      const updatedNext = manager.getInfo('test-workflow').nextRunAt!.getTime();
      expect(updatedNext).toBeGreaterThan(initialNext);
    });
  });

  describe('Max concurrent enforcement', () => {
    it('should skip execution when job is already running (max_concurrent: 1)', async () => {
      // Executor that takes 2 hours to complete
      const executor = makeSlowExecutor(3 * 60 * 60 * 1000);
      const manager = new JobManager(executor, { defaultTimeout: 10 * 60 * 60 * 1000 });
      const wf = makeWorkflow({ schedule: { interval_hours: 1, max_concurrent: 1 } });

      manager.register(wf);

      // First interval fires — starts execution
      vi.advanceTimersByTime(60 * 60 * 1000);

      // Second interval fires — should skip because still running
      vi.advanceTimersByTime(60 * 60 * 1000);

      // Only one call should have been made
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it('should allow execution after previous completes', async () => {
      let resolveExec: (v: any) => void;
      const executor = vi.fn().mockImplementation(() => new Promise(r => { resolveExec = r; }));
      const manager = new JobManager(executor, { defaultTimeout: 10 * 60 * 60 * 1000 });
      const wf = makeWorkflow({ schedule: { interval_hours: 1, max_concurrent: 1 } });

      manager.register(wf);

      // First interval fires
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(executor).toHaveBeenCalledTimes(1);

      // Complete the first execution
      resolveExec!({ success: true });
      await Promise.resolve();
      await Promise.resolve();

      // Second interval fires — should execute now
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(executor).toHaveBeenCalledTimes(2);
    });
  });

  describe('History tracking', () => {
    it('should add entries to history after each run', async () => {
      const executor = makeExecutor({ success: true, cost: 0.01 });
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');
      await manager.trigger('test-workflow');

      const info = manager.getInfo('test-workflow');
      expect(info.history.length).toBe(2);
      expect(info.totalRuns).toBe(2);
    });

    it('should set lastRun to the most recent entry', async () => {
      const executor = makeExecutor({ success: true, cost: 0.01 });
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');

      const info = manager.getInfo('test-workflow');
      expect(info.lastRun).toBeDefined();
      expect(info.lastRun!.status).toBe('completed');
    });

    it('should enforce ring buffer at maxHistory', async () => {
      const executor = makeExecutor({ success: true, cost: 0.01 });
      const manager = new JobManager(executor, { maxHistory: 3 });
      const wf = makeWorkflow();

      manager.register(wf);

      for (let i = 0; i < 5; i++) {
        await manager.trigger('test-workflow');
      }

      const info = manager.getInfo('test-workflow');
      expect(info.history.length).toBe(3);
      expect(info.totalRuns).toBe(5);
    });

    it('should default maxHistory to 50', async () => {
      const executor = makeExecutor({ success: true, cost: 0.01 });
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);

      for (let i = 0; i < 55; i++) {
        await manager.trigger('test-workflow');
      }

      const info = manager.getInfo('test-workflow');
      expect(info.history.length).toBe(50);
      expect(info.totalRuns).toBe(55);
    });

    it('should compute duration in history entries', async () => {
      const executor = makeSlowExecutor(5000, { success: true });
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      const triggerPromise = manager.trigger('test-workflow');
      vi.advanceTimersByTime(5000);
      const entry = await triggerPromise;

      expect(entry.duration).toBe(5000);
    });
  });

  describe('Catch-up detection', () => {
    it('should flag jobs with catch_up: true that missed their interval', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1, catch_up: true } });

      manager.register(wf);
      manager.stop('test-workflow');

      // Simulate time passing well beyond the interval without any run
      vi.advanceTimersByTime(5 * 60 * 60 * 1000);

      const catchUpJobs = manager.getCatchUpJobs();
      expect(catchUpJobs).toContain('test-workflow');
    });

    it('should not flag jobs with catch_up: false', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1, catch_up: false } });

      manager.register(wf);
      manager.stop('test-workflow');

      vi.advanceTimersByTime(5 * 60 * 60 * 1000);

      const catchUpJobs = manager.getCatchUpJobs();
      expect(catchUpJobs).not.toContain('test-workflow');
    });

    it('should not flag jobs that ran recently', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1, catch_up: true } });

      manager.register(wf);
      await manager.trigger('test-workflow');

      const catchUpJobs = manager.getCatchUpJobs();
      expect(catchUpJobs).not.toContain('test-workflow');
    });

    it('should remove job from catch-up list after markCaughtUp', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1, catch_up: true } });

      manager.register(wf);
      manager.stop('test-workflow');
      vi.advanceTimersByTime(5 * 60 * 60 * 1000);

      expect(manager.getCatchUpJobs()).toContain('test-workflow');

      manager.markCaughtUp('test-workflow');
      expect(manager.getCatchUpJobs()).not.toContain('test-workflow');
    });
  });

  describe('Timeout enforcement', () => {
    it('should timeout and mark as failed when executor exceeds defaultTimeout', async () => {
      const executor = makeSlowExecutor(600000); // 10 min
      const manager = new JobManager(executor, { defaultTimeout: 300000 }); // 5 min timeout
      const wf = makeWorkflow();

      manager.register(wf);
      const triggerPromise = manager.trigger('test-workflow');

      // Advance past timeout
      vi.advanceTimersByTime(300000);
      const entry = await triggerPromise;

      expect(entry.status).toBe('timeout');
      expect(entry.error).toMatch(/timed out/i);
    });

    it('should not timeout when executor completes in time', async () => {
      const executor = makeSlowExecutor(1000, { success: true, cost: 0.05 });
      const manager = new JobManager(executor, { defaultTimeout: 300000 });
      const wf = makeWorkflow();

      manager.register(wf);
      const triggerPromise = manager.trigger('test-workflow');
      vi.advanceTimersByTime(1000);
      const entry = await triggerPromise;

      expect(entry.status).toBe('completed');
    });

    it('should default timeout to 300000ms (5 minutes)', async () => {
      const executor = makeSlowExecutor(400000); // 6.67 min
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      const triggerPromise = manager.trigger('test-workflow');
      vi.advanceTimersByTime(300000);
      const entry = await triggerPromise;

      expect(entry.status).toBe('timeout');
    });
  });

  describe('Callbacks', () => {
    it('should call onJobStart when a job begins', async () => {
      const onJobStart = vi.fn();
      const executor = makeExecutor();
      const manager = new JobManager(executor, { onJobStart });
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');

      expect(onJobStart).toHaveBeenCalledWith('test-workflow');
    });

    it('should call onJobComplete when a job finishes successfully', async () => {
      const onJobComplete = vi.fn();
      const executor = makeExecutor({ success: true, cost: 0.05 });
      const manager = new JobManager(executor, { onJobComplete });
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');

      expect(onJobComplete).toHaveBeenCalledWith('test-workflow', expect.objectContaining({ status: 'completed' }));
    });

    it('should call onJobError when a job fails', async () => {
      const onJobError = vi.fn();
      const executor = makeThrowingExecutor('kaboom');
      const manager = new JobManager(executor, { onJobError });
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');

      expect(onJobError).toHaveBeenCalledWith('test-workflow', expect.any(Error));
    });

    it('should call onJobComplete even for failed runs (non-throw)', async () => {
      const onJobComplete = vi.fn();
      const executor = makeFailingExecutor('bad');
      const manager = new JobManager(executor, { onJobComplete });
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');

      expect(onJobComplete).toHaveBeenCalledWith('test-workflow', expect.objectContaining({ status: 'failed' }));
    });
  });

  describe('Cost tracking', () => {
    it('should accumulate totalCost across runs', async () => {
      const executor = makeExecutor({ success: true, cost: 0.10 });
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');
      await manager.trigger('test-workflow');
      await manager.trigger('test-workflow');

      const info = manager.getInfo('test-workflow');
      expect(info.totalCost).toBeCloseTo(0.30);
    });

    it('should not add cost from failed runs that report no cost', async () => {
      const executor = makeFailingExecutor('error');
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');

      const info = manager.getInfo('test-workflow');
      expect(info.totalCost).toBe(0);
    });

    it('should add cost from failed runs that report a cost', async () => {
      const executor = vi.fn().mockResolvedValue({ success: false, error: 'err', cost: 0.02 });
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      await manager.trigger('test-workflow');

      const info = manager.getInfo('test-workflow');
      expect(info.totalCost).toBeCloseTo(0.02);
    });
  });

  describe('startAll / stopAll', () => {
    it('should start all registered jobs', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      manager.register(makeWorkflow({ name: 'job-a', schedule: { interval_hours: 1 } }));
      manager.register(makeWorkflow({ name: 'job-b', schedule: { interval_hours: 2 } }));

      manager.stopAll();
      manager.startAll();

      expect(manager.getInfo('job-a').status).toBe('running');
      expect(manager.getInfo('job-b').status).toBe('running');
    });

    it('should stop all registered jobs', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      manager.register(makeWorkflow({ name: 'job-a', schedule: { interval_hours: 1 } }));
      manager.register(makeWorkflow({ name: 'job-b', schedule: { interval_hours: 2 } }));

      manager.stopAll();

      expect(manager.getInfo('job-a').status).toBe('paused');
      expect(manager.getInfo('job-b').status).toBe('paused');
    });

    it('should not fire executors after stopAll', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      manager.register(makeWorkflow({ name: 'job-a', schedule: { interval_hours: 1 } }));
      manager.register(makeWorkflow({ name: 'job-b', schedule: { interval_hours: 1 } }));

      manager.stopAll();

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('should stop all jobs and clear state', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      manager.register(makeWorkflow({ name: 'job-a', schedule: { interval_hours: 1 } }));
      manager.register(makeWorkflow({ name: 'job-b', schedule: { interval_hours: 2 } }));

      manager.shutdown();

      expect(manager.listJobs()).toEqual([]);
    });

    it('should not fire executors after shutdown', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      manager.register(makeWorkflow({ name: 'job-a', schedule: { interval_hours: 1 } }));
      manager.shutdown();

      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);

      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('listJobs', () => {
    it('should return info for all registered jobs', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      manager.register(makeWorkflow({ name: 'alpha', schedule: { interval_hours: 1 } }));
      manager.register(makeWorkflow({ name: 'beta', schedule: { interval_hours: 4 } }));

      const jobs = manager.listJobs();
      expect(jobs.length).toBe(2);
      expect(jobs.map(j => j.name).sort()).toEqual(['alpha', 'beta']);
    });

    it('should return an empty array when no jobs are registered', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      expect(manager.listJobs()).toEqual([]);
    });
  });

  describe('getInfo', () => {
    it('should throw for an unknown job name', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      expect(() => manager.getInfo('nope')).toThrow(/not registered/i);
    });

    it('should reflect paused status', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);
      manager.stop('test-workflow');

      expect(manager.getInfo('test-workflow').status).toBe('paused');
    });
  });

  describe('getCatchUpJobs / markCaughtUp', () => {
    it('should return empty array when no jobs need catch-up', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ schedule: { interval_hours: 1, catch_up: true } });

      manager.register(wf);
      expect(manager.getCatchUpJobs()).toEqual([]);
    });

    it('should throw when marking an unknown job as caught up', () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);

      expect(() => manager.markCaughtUp('unknown')).toThrow(/not registered/i);
    });
  });

  describe('Edge cases', () => {
    it('should handle workflow with empty inputs', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow({ inputs: undefined });

      manager.register(wf);
      await manager.trigger('test-workflow');

      expect(executor).toHaveBeenCalledWith(wf, {});
    });

    it('should generate unique runIds', async () => {
      const executor = makeExecutor();
      const manager = new JobManager(executor);
      const wf = makeWorkflow();

      manager.register(wf);

      // Advance time by 1ms between triggers to guarantee unique timestamps
      const entry1 = await manager.trigger('test-workflow');
      vi.advanceTimersByTime(1);
      const entry2 = await manager.trigger('test-workflow');

      expect(entry1.runId).not.toBe(entry2.runId);
    });

    it('should handle multiple workflows independently', async () => {
      const executor = makeExecutor({ success: true, cost: 0.05 });
      const manager = new JobManager(executor);

      manager.register(makeWorkflow({ name: 'wf-1', schedule: { interval_hours: 1 } }));
      manager.register(makeWorkflow({ name: 'wf-2', schedule: { interval_hours: 2 } }));

      await manager.trigger('wf-1');

      expect(manager.getInfo('wf-1').totalRuns).toBe(1);
      expect(manager.getInfo('wf-2').totalRuns).toBe(0);
    });
  });
});
