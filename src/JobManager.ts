/**
 * JobManager.ts
 *
 * Toad-Scheduler abstraction for .arma.workflow scheduled execution.
 * Uses setInterval/setTimeout primitives — no external scheduler dependency.
 */

// Re-export types for backwards compatibility
export {
  JobStatus,
  JobHistoryEntry,
  JobInfo,
  JobExecutor,
  JobManagerConfig,
} from './JobManagerTypes';

import { WorkflowDefinition, WorkflowSchedule } from './WorkflowBuilderTypes';
import {
  JobHistoryEntry,
  JobExecutor,
  JobManagerConfig,
  JobInfo,
} from './JobManagerTypes';

// --- Internal state ---

interface JobState {
  workflow: WorkflowDefinition;
  status: 'idle' | 'running' | 'paused' | 'error';
  timerId: ReturnType<typeof setInterval> | null;
  nextRunAt: Date | null;
  history: JobHistoryEntry[];
  totalRuns: number;
  totalCost: number;
  isExecuting: boolean;
  registeredAt: Date;
  caughtUp: boolean;
}

// --- Class ---

/** Manages async job lifecycle for graph executions with status tracking. */
export class JobManager {
  private readonly executor: JobExecutor;
  private readonly maxHistory: number;
  private readonly defaultTimeout: number;
  private readonly onJobStart?: (name: string) => void;
  private readonly onJobComplete?: (name: string, entry: JobHistoryEntry) => void;
  private readonly onJobError?: (name: string, error: Error) => void;

  private jobs = new Map<string, JobState>();

  constructor(executor: JobExecutor, config?: JobManagerConfig) {
    this.executor = executor;
    this.maxHistory = config?.maxHistory ?? 50;
    this.defaultTimeout = config?.defaultTimeout ?? 300000;
    this.onJobStart = config?.onJobStart;
    this.onJobComplete = config?.onJobComplete;
    this.onJobError = config?.onJobError;
  }

  // --- Public API ---

  register(workflow: WorkflowDefinition): void {
    if (!workflow.schedule) {
      throw new Error(`Workflow "${workflow.name}" has no schedule defined`);
    }
    if (this.jobs.has(workflow.name)) {
      throw new Error(`Workflow "${workflow.name}" is already registered`);
    }

    const state: JobState = {
      workflow,
      status: 'idle',
      timerId: null,
      nextRunAt: null,
      history: [],
      totalRuns: 0,
      totalCost: 0,
      isExecuting: false,
      registeredAt: new Date(),
      caughtUp: true,
    };

    this.jobs.set(workflow.name, state);
    this.start(workflow.name);
  }

  unregister(name: string): void {
    const state = this.getState(name);
    this.clearTimer(state);
    this.jobs.delete(name);
  }

  start(name: string): void {
    const state = this.getState(name);
    this.clearTimer(state);

    const intervalMs = this.getIntervalMs(state.workflow.schedule!);
    state.nextRunAt = new Date(Date.now() + intervalMs);
    state.status = 'running';

    state.timerId = setInterval(() => {
      this.scheduledRun(name);
    }, intervalMs);
  }

  stop(name: string): void {
    const state = this.getState(name);
    this.clearTimer(state);
    state.status = 'paused';
    state.nextRunAt = null;
  }

  async trigger(name: string): Promise<JobHistoryEntry> {
    const state = this.getState(name);
    return this.executeJob(state);
  }

  getInfo(name: string): JobInfo {
    const state = this.getState(name);
    return {
      name,
      status: state.status,
      schedule: state.workflow.schedule!,
      lastRun: state.history.length > 0 ? state.history[state.history.length - 1] : undefined,
      nextRunAt: state.nextRunAt ?? undefined,
      history: [...state.history],
      totalRuns: state.totalRuns,
      totalCost: state.totalCost,
    };
  }

  listJobs(): JobInfo[] {
    const infos: JobInfo[] = [];
    for (const name of this.jobs.keys()) {
      infos.push(this.getInfo(name));
    }
    return infos;
  }

  startAll(): void {
    for (const name of this.jobs.keys()) this.start(name);
  }

  stopAll(): void {
    for (const name of this.jobs.keys()) this.stop(name);
  }

  shutdown(): void {
    for (const state of this.jobs.values()) this.clearTimer(state);
    this.jobs.clear();
  }

  getCatchUpJobs(): string[] {
    const result: string[] = [];
    for (const [name, state] of this.jobs.entries()) {
      if (!state.workflow.schedule?.catch_up) continue;
      if (!state.caughtUp) {
        result.push(name);
        continue;
      }

      const intervalMs = this.getIntervalMs(state.workflow.schedule);
      const lastRunTime = this.getLastRunTime(state);

      if (lastRunTime === null) {
        const elapsed = Date.now() - state.registeredAt.getTime();
        if (elapsed > intervalMs) result.push(name);
      } else {
        const elapsed = Date.now() - lastRunTime;
        if (elapsed > intervalMs) result.push(name);
      }
    }
    return result;
  }

  markCaughtUp(name: string): void {
    const state = this.getState(name);
    state.caughtUp = true;
    state.registeredAt = new Date();
  }

  // --- Private methods ---

  private getState(name: string): JobState {
    const state = this.jobs.get(name);
    if (!state) throw new Error(`Job "${name}" is not registered`);
    return state;
  }

  private clearTimer(state: JobState): void {
    if (state.timerId !== null) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  private getIntervalMs(schedule: WorkflowSchedule): number {
    if (schedule.interval_hours) return schedule.interval_hours * 60 * 60 * 1000;
    return 60 * 60 * 1000;
  }

  private getLastRunTime(state: JobState): number | null {
    if (state.history.length === 0) return null;
    const lastEntry = state.history[state.history.length - 1];
    return (lastEntry.completedAt ?? lastEntry.startedAt).getTime();
  }

  private scheduledRun(name: string): void {
    const state = this.jobs.get(name);
    if (!state) return;

    const maxConcurrent = state.workflow.schedule?.max_concurrent ?? Infinity;
    if (maxConcurrent <= 1 && state.isExecuting) return;

    const intervalMs = this.getIntervalMs(state.workflow.schedule!);
    state.nextRunAt = new Date(Date.now() + intervalMs);

    this.executeJobScheduled(state);
  }

  private async executeJob(state: JobState): Promise<JobHistoryEntry> {
    const name = state.workflow.name;
    const runId = `${name}-${Date.now()}`;
    const startedAt = new Date();

    state.isExecuting = true;
    const previousStatus = state.status;
    state.status = 'running';

    this.onJobStart?.(name);

    let entry: JobHistoryEntry;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const inputs = state.workflow.inputs ?? {};

      const result = await new Promise<{ success: boolean; error?: string; cost?: number; timeout?: boolean }>((resolve, reject) => {
        let settled = false;

        timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({ success: false, timeout: true, error: 'Job execution timed out' });
          }
        }, this.defaultTimeout);

        this.executor(state.workflow, inputs).then(
          (res) => {
            if (!settled) { settled = true; if (timeoutId !== null) clearTimeout(timeoutId); resolve(res); }
          },
          (err) => {
            if (!settled) { settled = true; if (timeoutId !== null) clearTimeout(timeoutId); reject(err); }
          }
        );
      });

      const completedAt = new Date();
      const duration = completedAt.getTime() - startedAt.getTime();

      if ((result as any).timeout) {
        entry = { runId, startedAt, completedAt, status: 'timeout', error: 'Job execution timed out', duration };
      } else if (result.success) {
        entry = { runId, startedAt, completedAt, status: 'completed', cost: result.cost, duration };
      } else {
        entry = { runId, startedAt, completedAt, status: 'failed', error: result.error, cost: result.cost, duration };
      }

      state.status = previousStatus === 'running' ? 'running' : previousStatus;
      this.onJobComplete?.(name, entry);
    } catch (err: unknown) {
      if (timeoutId !== null) clearTimeout(timeoutId);
      const completedAt = new Date();
      const duration = completedAt.getTime() - startedAt.getTime();
      const error = err instanceof Error ? err : new Error(String(err));

      entry = { runId, startedAt, completedAt, status: 'failed', error: error.message, duration };
      state.status = previousStatus === 'running' ? 'running' : previousStatus;
      this.onJobError?.(name, error);
      this.onJobComplete?.(name, entry);
    }

    state.isExecuting = false;
    state.totalRuns++;
    if (entry.cost) state.totalCost += entry.cost;
    state.history.push(entry);

    while (state.history.length > this.maxHistory) state.history.shift();

    return entry;
  }

  private async executeJobScheduled(state: JobState): Promise<void> {
    const name = state.workflow.name;
    const runId = `${name}-${Date.now()}`;
    const startedAt = new Date();

    state.isExecuting = true;
    const previousStatus = state.status;
    state.status = 'running';

    this.onJobStart?.(name);

    let entry: JobHistoryEntry;

    try {
      const inputs = state.workflow.inputs ?? {};
      const result = await this.executor(state.workflow, inputs);

      const completedAt = new Date();
      const duration = completedAt.getTime() - startedAt.getTime();

      if (result.success) {
        entry = { runId, startedAt, completedAt, status: 'completed', cost: result.cost, duration };
      } else {
        entry = { runId, startedAt, completedAt, status: 'failed', error: result.error, cost: result.cost, duration };
      }

      state.status = previousStatus === 'running' ? 'running' : previousStatus;
      this.onJobComplete?.(name, entry);
    } catch (err: unknown) {
      const completedAt = new Date();
      const duration = completedAt.getTime() - startedAt.getTime();
      const error = err instanceof Error ? err : new Error(String(err));

      entry = { runId, startedAt, completedAt, status: 'failed', error: error.message, duration };
      state.status = previousStatus === 'running' ? 'running' : previousStatus;
      this.onJobError?.(name, error);
      this.onJobComplete?.(name, entry);
    }

    state.isExecuting = false;
    state.totalRuns++;
    if (entry.cost) state.totalCost += entry.cost;
    state.history.push(entry);

    while (state.history.length > this.maxHistory) state.history.shift();
  }
}
