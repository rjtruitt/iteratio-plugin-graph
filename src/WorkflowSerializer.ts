/**
 * WorkflowSerializer.ts
 *
 * Serializes WorkflowDefinition objects to YAML format.
 */

import {
  WorkflowDefinition,
  WorkflowNodeConfig,
} from './WorkflowBuilderTypes';

// --- Serializer ---

/** Serializes workflow and graph definitions to JSON/YAML for persistence. */
export class WorkflowSerializer {
  toYAML(wf: WorkflowDefinition): string {
    const lines: string[] = [];

    lines.push(`name: ${wf.name}`);
    lines.push(`version: "${wf.version}"`);
    if (wf.description) {
      lines.push(`description: "${wf.description}"`);
    }
    lines.push('');

    if (wf.schedule) {
      lines.push('schedule:');
      if (wf.schedule.interval_hours !== undefined) {
        lines.push(`  interval_hours: ${wf.schedule.interval_hours}`);
      }
      if (wf.schedule.cron) {
        lines.push(`  cron: "${wf.schedule.cron}"`);
      }
      if (wf.schedule.catch_up !== undefined) {
        lines.push(`  catch_up: ${wf.schedule.catch_up}`);
      }
      if (wf.schedule.max_concurrent !== undefined) {
        lines.push(`  max_concurrent: ${wf.schedule.max_concurrent}`);
      }
      if (wf.schedule.timezone) {
        lines.push(`  timezone: ${wf.schedule.timezone}`);
      }
      lines.push('');
    }

    if (wf.agents.length > 0) {
      lines.push('agents:');
      for (const agent of wf.agents) {
        lines.push(`  - name: ${agent.name}`);
        lines.push(`    type: ${agent.type}`);
        lines.push(`    model: ${agent.model}`);
        if (agent.config_ref) lines.push(`    config_ref: ${agent.config_ref}`);
        if (agent.lifecycle) lines.push(`    lifecycle: ${agent.lifecycle}`);
        if (agent.provider) lines.push(`    provider: ${agent.provider}`);
        lines.push('');
      }
    } else {
      lines.push('agents: []');
      lines.push('');
    }

    lines.push('graphs:');
    for (const [graphName, graphDef] of Object.entries(wf.graphs)) {
      lines.push(`  ${graphName}:`);
      lines.push(`    entry: ${graphDef.entry}`);
      lines.push('    nodes:');
      for (const [nodeName, nodeConfig] of Object.entries(graphDef.nodes)) {
        const inlineConfig = this.serializeNodeConfig(nodeConfig);
        lines.push(`      ${nodeName}: ${inlineConfig}`);
      }
      lines.push('    edges:');
      for (const edge of graphDef.edges) {
        lines.push(`      - ${edge}`);
      }
      lines.push('');
    }

    lines.push('pipeline:');
    for (const step of wf.pipeline) {
      if (step.for_each) {
        lines.push(`  - for_each: ${step.for_each}`);
        if (step.concurrency !== undefined) {
          lines.push(`    concurrency: ${step.concurrency}`);
        }
        lines.push(`    graph: ${step.graph}`);
      } else {
        lines.push(`  - graph: ${step.graph}`);
      }
    }
    lines.push('');

    if (wf.inputs) {
      lines.push('inputs:');
      for (const [key, value] of Object.entries(wf.inputs)) {
        lines.push(`  ${key}: "${value}"`);
      }
      lines.push('');
    }

    if (wf.memory) {
      lines.push('memory:');
      if (wf.memory.terminology && wf.memory.terminology.length > 0) {
        lines.push('  terminology:');
        for (const term of wf.memory.terminology) {
          lines.push(`    - "${term}"`);
        }
      }
      if (wf.memory.rules && wf.memory.rules.length > 0) {
        lines.push('  rules:');
        for (const rule of wf.memory.rules) {
          lines.push(`    - "${rule}"`);
        }
      }
      lines.push('');
    }

    if (wf.stickynote) {
      lines.push('stickynote:');
      lines.push(`  position: ${wf.stickynote.position}`);
      lines.push('  content:');
      for (const item of wf.stickynote.content) {
        lines.push(`    - "${item}"`);
      }
      lines.push('');
    }

    if (wf.pin_files && wf.pin_files.length > 0) {
      lines.push('pin_files:');
      for (const file of wf.pin_files) {
        lines.push(`  - ${file}`);
      }
      lines.push('');
    }

    if (wf.inject && wf.inject.length > 0) {
      lines.push('inject:');
      for (const file of wf.inject) {
        lines.push(`  - ${file}`);
      }
      lines.push('');
    }

    if (wf.synthetic_history && wf.synthetic_history.length > 0) {
      lines.push('synthetic_history:');
      for (const entry of wf.synthetic_history) {
        lines.push(`  - role: ${entry.role}`);
        if (entry.content.includes('\n')) {
          lines.push('    content: |');
          for (const line of entry.content.split('\n')) {
            lines.push(`      ${line}`);
          }
        } else {
          lines.push(`    content: "${entry.content}"`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private serializeNodeConfig(config: WorkflowNodeConfig): string {
    const parts: string[] = [`type: ${config.type}`];

    if (config.tool) parts.push(`tool: ${config.tool}`);
    if (config.prompt) parts.push(`prompt: "${config.prompt}"`);
    if (config.model) parts.push(`model: ${config.model}`);
    if (config.source) parts.push(`source: ${config.source}`);
    if (config.ref) parts.push(`ref: ${config.ref}`);
    if (config.count !== undefined) parts.push(`count: ${config.count}`);
    if (config.agent) parts.push(`agent: ${config.agent}`);
    if (config.lifecycle) parts.push(`lifecycle: ${config.lifecycle}`);
    if (config.action) parts.push(`action: ${config.action}`);
    if (config.tag) parts.push(`tag: ${config.tag}`);
    if (config.threshold !== undefined) parts.push(`threshold: ${config.threshold}`);
    if (config.items) parts.push(`items: ${config.items}`);
    if (config.timeout !== undefined) parts.push(`timeout: ${config.timeout}`);

    return `{ ${parts.join(', ')} }`;
  }
}
