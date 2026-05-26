/**
 * GraphTemplates.ts
 * Predefined graph templates for common workflow patterns.
 */

import {
  GraphDefinition,
  NodeType,
  EdgeType,
  NodeConfig,
  DirectEdge,
  ConditionalEdge,
  ParallelEdge,
} from './GraphDefinition';

// Re-export registry for backwards compatibility
export { TemplateRegistry, globalTemplateRegistry, createFromTemplate } from './TemplateRegistry';

/**
 * Template parameters base interface
 */
export interface TemplateParameters {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * Template factory function
 */
export type TemplateFactory<T extends TemplateParameters = TemplateParameters> = (
  params: T
) => GraphDefinition;

/**
 * Template metadata
 */
export interface TemplateMetadata {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    default?: unknown;
    description?: string;
  }>;
  examples?: unknown[];
}

/**
 * Agent-tool loop template parameters
 */
export interface AgentToolLoopParams extends TemplateParameters {
  llmModel?: string;
  temperature?: number;
  maxIterations?: number;
  tools?: string[];
}

/**
 * Agent-tool loop template
 * Simple agent that can call tools in a loop
 */
export function agentToolLoopTemplate(
  params: AgentToolLoopParams = {}
): GraphDefinition {
  const {
    name = 'agent-tool-loop',
    description = 'Agent with tool calling capability',
    llmModel = 'claude-3-sonnet',
    temperature = 0.7,
    maxIterations = 10,
    tools = [],
  } = params;

  const nodes: NodeConfig[] = [
    {
      name: 'start',
      type: NodeType.START,
      description: 'Entry point',
    },
    {
      name: 'llm',
      type: NodeType.LLM,
      description: 'LLM reasoning and decision making',
      config: {
        model: llmModel,
        temperature,
      },
    },
    {
      name: 'tools',
      type: NodeType.TOOL,
      description: 'Tool execution',
      config: {
        tools,
      },
    },
    {
      name: 'end',
      type: NodeType.END,
      description: 'Exit point',
    },
  ];

  const edges: Array<DirectEdge | ConditionalEdge> = [
    {
      type: EdgeType.DIRECT,
      from: 'start',
      to: 'llm',
    },
    {
      type: EdgeType.CONDITIONAL,
      from: 'llm',
      conditions: [
        {
          condition: 'needsTools',
          operator: 'equals',
          value: true,
          to: 'tools',
        },
      ],
      default: 'end',
    },
    {
      type: EdgeType.DIRECT,
      from: 'tools',
      to: 'llm',
      description: 'Loop back to LLM with tool results',
    },
  ];

  return {
    version: '1.0.0',
    name,
    description,
    nodes,
    edges,
    entryPoint: 'start',
    exitPoints: ['end'],
    config: {
      maxIterations,
      enableParallel: false,
    },
  };
}

/**
 * Research-analyze-report template parameters
 */
export interface ResearchAnalyzeReportParams extends TemplateParameters {
  researchTools?: string[];
  analysisDepth?: 'shallow' | 'medium' | 'deep';
  reportFormat?: 'summary' | 'detailed' | 'executive';
}

/**
 * Research-analyze-report template
 */
export function researchAnalyzeReportTemplate(
  params: ResearchAnalyzeReportParams = {}
): GraphDefinition {
  const {
    name = 'research-analyze-report',
    description = 'Research, analyze, and report workflow',
    researchTools = ['search', 'scrape', 'database'],
    analysisDepth = 'medium',
    reportFormat = 'summary',
  } = params;

  const nodes: NodeConfig[] = [
    { name: 'start', type: NodeType.START },
    {
      name: 'research',
      type: NodeType.TOOL,
      description: 'Gather information from various sources',
      config: { tools: researchTools, parallel: true },
    },
    {
      name: 'analyze',
      type: NodeType.LLM,
      description: 'Analyze and synthesize research findings',
      config: { model: 'claude-3-opus', temperature: 0.5, depth: analysisDepth },
    },
    {
      name: 'report',
      type: NodeType.TRANSFORM,
      description: 'Format analysis into report',
      config: { format: reportFormat },
    },
    { name: 'end', type: NodeType.END },
  ];

  const edges: DirectEdge[] = [
    { type: EdgeType.DIRECT, from: 'start', to: 'research' },
    { type: EdgeType.DIRECT, from: 'research', to: 'analyze' },
    { type: EdgeType.DIRECT, from: 'analyze', to: 'report' },
    { type: EdgeType.DIRECT, from: 'report', to: 'end' },
  ];

  return {
    version: '1.0.0',
    name,
    description,
    nodes,
    edges,
    entryPoint: 'start',
    exitPoints: ['end'],
    config: { maxIterations: 20, enableParallel: true },
  };
}

/**
 * Plan-execute-review template parameters
 */
export interface PlanExecuteReviewParams extends TemplateParameters {
  maxPlanningIterations?: number;
  allowReplanning?: boolean;
  reviewCriteria?: string[];
}

/**
 * Plan-execute-review template
 */
export function planExecuteReviewTemplate(
  params: PlanExecuteReviewParams = {}
): GraphDefinition {
  const {
    name = 'plan-execute-review',
    description = 'Plan, execute, and review workflow with replanning',
    maxPlanningIterations = 3,
    allowReplanning = true,
    reviewCriteria = ['completeness', 'correctness', 'quality'],
  } = params;

  const nodes: NodeConfig[] = [
    { name: 'start', type: NodeType.START },
    {
      name: 'plan',
      type: NodeType.LLM,
      description: 'Create execution plan',
      config: { model: 'claude-3-sonnet', temperature: 0.7 },
    },
    {
      name: 'execute',
      type: NodeType.TOOL,
      description: 'Execute planned tasks',
      config: { parallel: true },
    },
    {
      name: 'review',
      type: NodeType.LLM,
      description: 'Review execution results',
      config: { model: 'claude-3-sonnet', temperature: 0.3, criteria: reviewCriteria },
    },
    { name: 'end', type: NodeType.END },
  ];

  const edges: Array<DirectEdge | ConditionalEdge> = [
    { type: EdgeType.DIRECT, from: 'start', to: 'plan' },
    { type: EdgeType.DIRECT, from: 'plan', to: 'execute' },
    { type: EdgeType.DIRECT, from: 'execute', to: 'review' },
  ];

  if (allowReplanning) {
    edges.push({
      type: EdgeType.CONDITIONAL,
      from: 'review',
      conditions: [
        { condition: 'acceptable', operator: 'equals', value: false, to: 'plan' },
        { condition: 'iterations', operator: 'lessThan', value: maxPlanningIterations, to: 'plan' },
      ],
      default: 'end',
    });
  } else {
    edges.push({ type: EdgeType.DIRECT, from: 'review', to: 'end' });
  }

  return {
    version: '1.0.0',
    name,
    description,
    nodes,
    edges,
    entryPoint: 'start',
    exitPoints: ['end'],
    config: { maxIterations: maxPlanningIterations * 5, enableParallel: true },
  };
}

/**
 * Multi-agent collaboration template parameters
 */
export interface MultiAgentCollaborationParams extends TemplateParameters {
  agents?: Array<{
    name: string;
    role: string;
    model?: string;
    tools?: string[];
  }>;
  coordinationStrategy?: 'sequential' | 'parallel' | 'hierarchical';
  aggregationMethod?: 'consensus' | 'voting' | 'merge';
}

/**
 * Multi-agent collaboration template
 */
export function multiAgentCollaborationTemplate(
  params: MultiAgentCollaborationParams = {}
): GraphDefinition {
  const {
    name = 'multi-agent-collaboration',
    description = 'Multiple agents collaborating on a task',
    agents = [
      { name: 'researcher', role: 'research', tools: ['search'] },
      { name: 'analyst', role: 'analysis', tools: ['analyze'] },
      { name: 'writer', role: 'writing', tools: ['format'] },
    ],
    coordinationStrategy = 'parallel',
    aggregationMethod = 'merge',
  } = params;

  const nodes: NodeConfig[] = [
    { name: 'start', type: NodeType.START },
    {
      name: 'coordinator',
      type: NodeType.LLM,
      description: 'Coordinate agent tasks',
      config: { model: 'claude-3-sonnet', temperature: 0.5 },
    },
  ];

  // Add agent nodes
  for (const agent of agents) {
    nodes.push({
      name: agent.name,
      type: NodeType.LLM,
      description: `Agent: ${agent.role}`,
      config: { model: agent.model || 'claude-3-sonnet', role: agent.role, tools: agent.tools },
    });
  }

  nodes.push(
    {
      name: 'aggregator',
      type: NodeType.TRANSFORM,
      description: 'Aggregate agent results',
      config: { method: aggregationMethod },
    },
    { name: 'end', type: NodeType.END }
  );

  const edges: Array<DirectEdge | ParallelEdge> = [
    { type: EdgeType.DIRECT, from: 'start', to: 'coordinator' },
  ];

  if (coordinationStrategy === 'parallel') {
    edges.push({
      type: EdgeType.PARALLEL,
      from: 'coordinator',
      to: agents.map((a) => a.name),
      strategy: 'all',
    });
    for (const agent of agents) {
      edges.push({ type: EdgeType.DIRECT, from: agent.name, to: 'aggregator' });
    }
  } else if (coordinationStrategy === 'sequential') {
    edges.push({ type: EdgeType.DIRECT, from: 'coordinator', to: agents[0].name });
    for (let i = 0; i < agents.length - 1; i++) {
      edges.push({ type: EdgeType.DIRECT, from: agents[i].name, to: agents[i + 1].name });
    }
    edges.push({ type: EdgeType.DIRECT, from: agents[agents.length - 1].name, to: 'aggregator' });
  } else {
    edges.push({
      type: EdgeType.PARALLEL,
      from: 'coordinator',
      to: agents.map((a) => a.name),
      strategy: 'all',
    });
    for (const agent of agents) {
      edges.push({ type: EdgeType.DIRECT, from: agent.name, to: 'aggregator' });
    }
  }

  edges.push({ type: EdgeType.DIRECT, from: 'aggregator', to: 'end' });

  return {
    version: '1.0.0',
    name,
    description,
    nodes,
    edges,
    entryPoint: 'start',
    exitPoints: ['end'],
    config: { maxIterations: 50, enableParallel: coordinationStrategy === 'parallel' },
  };
}
