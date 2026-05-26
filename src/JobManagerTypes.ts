/**
 * JobManagerTypes.ts
 *
 * Type definitions for the JobManager scheduled execution system.
 */

import { WorkflowDefinition, WorkflowSchedule } from './WorkflowBuilderTypes';

// --- Interfaces ---

/** Lifecycle status of a graph execution job. */
export type JobStatus = 'idle' | 'running' | 'paused' | 'error';

export interface JobHistoryEntry {
  runId: string;
  startedAt: Date;
  completedAt?: Date;
  status: 'completed' | 'failed' | 'timeout';
  error?: string;
  cost?: number;
  duration?: number;
}

export interface JobInfo {
  name: string;
  status: JobStatus;
  schedule: WorkflowSchedule;
  lastRun?: JobHistoryEntry;
  nextRunAt?: Date;
  history: JobHistoryEntry[];
  totalRuns: number;
  totalCost: number;
}

export type JobExecutor = (
  workflow: WorkflowDefinition,
  inputs: Record<string, unknown>
) => Promise<{ success: boolean; error?: string; cost?: number }>;

export interface JobManagerConfig {
  maxHistory?: number;
  defaultTimeout?: number;
  onJobStart?: (name: string) => void;
  onJobComplete?: (name: string, entry: JobHistoryEntry) => void;
  onJobError?: (name: string, error: Error) => void;
}
