/**
 * TemplateRegistry.ts
 * Template registry for managing and instantiating graph templates.
 */

import { GraphDefinition } from './GraphDefinition';
import {
  TemplateParameters,
  TemplateFactory,
  TemplateMetadata,
  agentToolLoopTemplate,
  researchAnalyzeReportTemplate,
  planExecuteReviewTemplate,
  multiAgentCollaborationTemplate,
} from './GraphTemplates';

/**
 * Template registry
 */
export class TemplateRegistry {
  private templates = new Map<string, TemplateFactory>();
  private metadata = new Map<string, TemplateMetadata>();

  constructor() {
    this.registerBuiltinTemplates();
  }

  /**
   * Register a template
   */
  registerTemplate(
    name: string,
    factory: TemplateFactory,
    metadata: TemplateMetadata
  ): void {
    this.templates.set(name, factory);
    this.metadata.set(name, metadata);
  }

  /**
   * Get a template
   */
  getTemplate(name: string): TemplateFactory | undefined {
    return this.templates.get(name);
  }

  /**
   * Get template metadata
   */
  getMetadata(name: string): TemplateMetadata | undefined {
    return this.metadata.get(name);
  }

  /**
   * Get all templates
   */
  getAllTemplates(): Map<string, TemplateMetadata> {
    return new Map(this.metadata);
  }

  /**
   * Instantiate template with parameters
   */
  instantiate(name: string, params: TemplateParameters = {}): GraphDefinition {
    const factory = this.getTemplate(name);
    if (!factory) {
      throw new Error(`Template '${name}' not found`);
    }

    return factory(params);
  }

  /**
   * Register built-in templates
   */
  private registerBuiltinTemplates(): void {
    // Agent-tool loop
    this.registerTemplate(
      'agent-tool-loop',
      agentToolLoopTemplate as TemplateFactory,
      {
        name: 'agent-tool-loop',
        description: 'Simple agent with tool calling capability',
        parameters: [
          {
            name: 'llmModel',
            type: 'string',
            required: false,
            default: 'claude-3-sonnet',
            description: 'LLM model to use',
          },
          {
            name: 'temperature',
            type: 'number',
            required: false,
            default: 0.7,
            description: 'LLM temperature',
          },
          {
            name: 'maxIterations',
            type: 'number',
            required: false,
            default: 10,
            description: 'Maximum loop iterations',
          },
          {
            name: 'tools',
            type: 'array',
            required: false,
            default: [],
            description: 'Available tools',
          },
        ],
      }
    );

    // Research-analyze-report
    this.registerTemplate(
      'research-analyze-report',
      researchAnalyzeReportTemplate as TemplateFactory,
      {
        name: 'research-analyze-report',
        description: 'Research, analyze, and report workflow',
        parameters: [
          {
            name: 'researchTools',
            type: 'array',
            required: false,
            default: ['search', 'scrape', 'database'],
          },
          {
            name: 'analysisDepth',
            type: 'string',
            required: false,
            default: 'medium',
          },
          {
            name: 'reportFormat',
            type: 'string',
            required: false,
            default: 'summary',
          },
        ],
      }
    );

    // Plan-execute-review
    this.registerTemplate(
      'plan-execute-review',
      planExecuteReviewTemplate as TemplateFactory,
      {
        name: 'plan-execute-review',
        description: 'Plan, execute, and review workflow with replanning',
        parameters: [
          {
            name: 'maxPlanningIterations',
            type: 'number',
            required: false,
            default: 3,
          },
          {
            name: 'allowReplanning',
            type: 'boolean',
            required: false,
            default: true,
          },
          {
            name: 'reviewCriteria',
            type: 'array',
            required: false,
            default: ['completeness', 'correctness', 'quality'],
          },
        ],
      }
    );

    // Multi-agent collaboration
    this.registerTemplate(
      'multi-agent-collaboration',
      multiAgentCollaborationTemplate as TemplateFactory,
      {
        name: 'multi-agent-collaboration',
        description: 'Multiple agents collaborating on a task',
        parameters: [
          {
            name: 'agents',
            type: 'array',
            required: false,
            default: [
              { name: 'researcher', role: 'research' },
              { name: 'analyst', role: 'analysis' },
              { name: 'writer', role: 'writing' },
            ],
          },
          {
            name: 'coordinationStrategy',
            type: 'string',
            required: false,
            default: 'parallel',
          },
          {
            name: 'aggregationMethod',
            type: 'string',
            required: false,
            default: 'merge',
          },
        ],
      }
    );
  }
}

/**
 * Global template registry instance
 */
export const globalTemplateRegistry = new TemplateRegistry();

/**
 * Convenience function to instantiate template
 */
export function createFromTemplate(
  name: string,
  params?: TemplateParameters
): GraphDefinition {
  return globalTemplateRegistry.instantiate(name, params);
}
