/**
 * WorkflowBuilderTypes.ts
 *
 * Type definitions for .arma.workflow programmatic construction.
 */

// --- Types ---

export type WorkflowNodeType =
  | 'tool'
  | 'llm'
  | 'condition'
  | 'transform'
  | 'parallel'
  | 'subgraph'
  | 'spawn'
  | 'loop'
  | 'queue'
  | 'drift'
  | 'vector'
  | 'human'
  | 'timer';

export interface WorkflowNodeConfig {
  type: WorkflowNodeType;
  tool?: string;
  prompt?: string;
  model?: string;
  source?: string;
  ref?: string;
  count?: number;
  agent?: string;
  lifecycle?: string;
  action?: string;
  tag?: string;
  threshold?: number;
  items?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface WorkflowGraphDef {
  entry: string;
  nodes: Record<string, WorkflowNodeConfig>;
  edges: string[];
}

export interface WorkflowAgentDef {
  name: string;
  type: string;
  model: string;
  config_ref?: string;
  lifecycle?: string;
  provider?: string;
  context_files?: string[];
  pin_files?: string[];
}

export interface WorkflowSchedule {
  interval_hours?: number;
  cron?: string;
  catch_up?: boolean;
  max_concurrent?: number;
  timezone?: string;
}

export interface WorkflowMemory {
  terminology?: string[];
  rules?: string[];
}

export interface WorkflowStickynote {
  position: 'top' | 'bottom' | 'both';
  content: string[];
}

export interface SyntheticHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export type StalenessStrategyType = 'commit_sha' | 'version' | 'timestamp' | 'ttl' | 'content_hash' | 'none';

export interface StalenessStrategy {
  type: StalenessStrategyType;
  field?: string;
  hours?: number;
}

export interface WorkflowToolCache {
  enabled: boolean;
  defaultThreshold?: number;
  defaultTtlHours?: number;
  applies_to: string[];
  excludes: string[];
  staleness_strategies?: Record<string, StalenessStrategy>;
  maxEntries?: number;
}

export interface WorkflowWrapperDef {
  name: string;
  description?: string;
  tools: string[];
  priority?: number;
  handler: string;
  config?: Record<string, unknown>;
  condition?: string;
}

export interface PipelineStep {
  graph: string;
  for_each?: string;
  concurrency?: number;
}

/** Definition of a linear workflow composed of ordered steps with conditional logic. */
export interface WorkflowDefinition {
  name: string;
  version: string;
  description?: string;
  schedule?: WorkflowSchedule;
  agents: WorkflowAgentDef[];
  graphs: Record<string, WorkflowGraphDef>;
  pipeline: PipelineStep[];
  inputs?: Record<string, unknown>;
  memory?: WorkflowMemory;
  tool_cache?: WorkflowToolCache;
  wrappers?: WorkflowWrapperDef[];
  stickynote?: WorkflowStickynote;
  pin_files?: string[];
  inject?: string[];
  synthetic_history?: SyntheticHistoryEntry[];
}

export interface ValidationError {
  type: string;
  message: string;
  graph?: string;
  node?: string;
  edge?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface OptimizationSuggestion {
  type: string;
  severity: 'suggestion' | 'warning';
  message: string;
  graph?: string;
  node?: string;
}
