/**
 * WorkflowParser.ts
 * Parses YAML workflow definitions into WorkflowDefinition objects.
 */

import {
  WorkflowDefinition,
  WorkflowSchedule,
  WorkflowAgentDef,
  WorkflowGraphDef,
  WorkflowNodeConfig,
  WorkflowMemory,
  PipelineStep,
} from './WorkflowBuilderTypes';

/** Parses workflow definitions from YAML/JSON configuration strings. */
export class WorkflowParser {
  fromYAML(yaml: string): WorkflowDefinition {
    const lines = yaml.split('\n');
    const result: any = {};
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        i++;
        continue;
      }

      if (trimmed.startsWith('name:')) {
        result.name = this.extractValue(trimmed, 'name');
      } else if (trimmed.startsWith('version:')) {
        result.version = this.extractValue(trimmed, 'version');
      } else if (trimmed.startsWith('description:')) {
        result.description = this.extractValue(trimmed, 'description');
      } else if (trimmed === 'schedule:') {
        const { value, endIdx } = this.parseSchedule(lines, i + 1);
        result.schedule = value;
        i = endIdx;
        continue;
      } else if (trimmed === 'agents:' || trimmed === 'agents: []') {
        if (trimmed === 'agents: []') {
          result.agents = [];
        } else {
          const { value, endIdx } = this.parseAgents(lines, i + 1);
          result.agents = value;
          i = endIdx;
          continue;
        }
      } else if (trimmed === 'graphs:') {
        const { value, endIdx } = this.parseGraphs(lines, i + 1);
        result.graphs = value;
        i = endIdx;
        continue;
      } else if (trimmed === 'pipeline:') {
        const { value, endIdx } = this.parsePipeline(lines, i + 1);
        result.pipeline = value;
        i = endIdx;
        continue;
      } else if (trimmed === 'inputs:') {
        const { value, endIdx } = this.parseSimpleMap(lines, i + 1);
        result.inputs = value;
        i = endIdx;
        continue;
      } else if (trimmed === 'memory:') {
        const { value, endIdx } = this.parseMemory(lines, i + 1);
        result.memory = value;
        i = endIdx;
        continue;
      }

      i++;
    }

    if (!result.name) {
      throw new Error('Workflow YAML: "name" is required');
    }
    if (!result.version) {
      result.version = '1.0';
    }
    if (!result.agents) {
      result.agents = [];
    }
    if (!result.graphs) {
      result.graphs = {};
    }
    if (!result.pipeline) {
      result.pipeline = [];
    }

    return result as WorkflowDefinition;
  }

  private extractValue(line: string, key: string): string {
    const raw = line.slice(key.length + 1).trim();
    return this.unquote(raw);
  }

  private unquote(s: string): string {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  private getIndent(line: string): number {
    return line.length - line.trimStart().length;
  }

  private parseSchedule(lines: string[], startIdx: number): { value: WorkflowSchedule; endIdx: number } {
    const schedule: WorkflowSchedule = {};
    let i = startIdx;
    const baseIndent = this.getIndent(lines[i] || '');
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }
      if (this.getIndent(line) < baseIndent) break;
      if (trimmed.startsWith('interval_hours:')) schedule.interval_hours = parseInt(this.extractValue(trimmed, 'interval_hours'));
      else if (trimmed.startsWith('cron:')) schedule.cron = this.extractValue(trimmed, 'cron');
      else if (trimmed.startsWith('catch_up:')) schedule.catch_up = this.extractValue(trimmed, 'catch_up') === 'true';
      else if (trimmed.startsWith('max_concurrent:')) schedule.max_concurrent = parseInt(this.extractValue(trimmed, 'max_concurrent'));
      else if (trimmed.startsWith('timezone:')) schedule.timezone = this.extractValue(trimmed, 'timezone');
      i++;
    }
    return { value: schedule, endIdx: i };
  }

  private parseAgents(lines: string[], startIdx: number): { value: WorkflowAgentDef[]; endIdx: number } {
    const agents: WorkflowAgentDef[] = [];
    let i = startIdx;
    let cur: any = null;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }
      const indent = this.getIndent(line);
      if (indent === 0 && !trimmed.startsWith('-') && !trimmed.startsWith(' ')) break;
      if (indent < 2 && !trimmed.startsWith('-')) break;
      if (trimmed.startsWith('- name:')) {
        if (cur) agents.push(cur);
        cur = { name: this.extractValue(trimmed.slice(2), 'name') };
      } else if (cur) {
        if (trimmed.startsWith('type:')) cur.type = this.extractValue(trimmed, 'type');
        else if (trimmed.startsWith('model:')) cur.model = this.extractValue(trimmed, 'model');
        else if (trimmed.startsWith('config_ref:')) cur.config_ref = this.extractValue(trimmed, 'config_ref');
        else if (trimmed.startsWith('lifecycle:')) cur.lifecycle = this.extractValue(trimmed, 'lifecycle');
        else if (trimmed.startsWith('provider:')) cur.provider = this.extractValue(trimmed, 'provider');
      }
      i++;
    }
    if (cur) agents.push(cur);
    return { value: agents, endIdx: i };
  }

  private parseGraphs(lines: string[], startIdx: number): { value: Record<string, WorkflowGraphDef>; endIdx: number } {
    const graphs: Record<string, WorkflowGraphDef> = {};
    let i = startIdx;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }
      const indent = this.getIndent(line);
      if (indent === 0 && trimmed && !trimmed.startsWith('#')) break;
      if (indent === 2 && trimmed.endsWith(':') && !trimmed.startsWith('-')) {
        const { value, endIdx } = this.parseSingleGraph(lines, i + 1);
        graphs[trimmed.slice(0, -1)] = value;
        i = endIdx;
        continue;
      }
      i++;
    }
    return { value: graphs, endIdx: i };
  }

  private parseSingleGraph(lines: string[], startIdx: number): { value: WorkflowGraphDef; endIdx: number } {
    const graph: WorkflowGraphDef = { entry: '', nodes: {}, edges: [] };
    let i = startIdx;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }

      const indent = this.getIndent(line);
      if (indent <= 2 && trimmed && !trimmed.startsWith('#')) break;

      if (trimmed.startsWith('entry:')) {
        graph.entry = this.extractValue(trimmed, 'entry');
      } else if (trimmed === 'nodes:') {
        const { value, endIdx } = this.parseNodes(lines, i + 1);
        graph.nodes = value;
        i = endIdx;
        continue;
      } else if (trimmed === 'edges:' || trimmed === 'edges: []') {
        if (trimmed === 'edges: []') {
          graph.edges = [];
        } else {
          const { value, endIdx } = this.parseEdgeList(lines, i + 1);
          graph.edges = value;
          i = endIdx;
          continue;
        }
      }

      i++;
    }

    return { value: graph, endIdx: i };
  }

  private parseNodes(lines: string[], startIdx: number): { value: Record<string, WorkflowNodeConfig>; endIdx: number } {
    const nodes: Record<string, WorkflowNodeConfig> = {};
    let i = startIdx;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }

      const indent = this.getIndent(line);
      if (indent <= 4 && trimmed && !trimmed.startsWith('#')) break;

      // Node: name: { inline config }
      const nodeMatch = trimmed.match(/^([\w-]+):\s*\{(.+)\}$/);
      if (nodeMatch) {
        const [, nodeName, inlineConfig] = nodeMatch;
        nodes[nodeName] = this.parseInlineConfig(inlineConfig);
      }

      i++;
    }

    return { value: nodes, endIdx: i };
  }

  private parseInlineConfig(str: string): WorkflowNodeConfig {
    const config: any = {};
    // Parse key: value pairs from inline object
    const pairs = this.splitInlinePairs(str);

    for (const pair of pairs) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) continue;
      const key = pair.slice(0, colonIdx).trim();
      const rawValue = pair.slice(colonIdx + 1).trim();
      config[key] = this.parseInlineValue(rawValue);
    }

    return config as WorkflowNodeConfig;
  }

  private splitInlinePairs(str: string): string[] {
    const pairs: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (inQuote) {
        current += ch;
        if (ch === quoteChar) inQuote = false;
      } else if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
        current += ch;
      } else if (ch === ',') {
        pairs.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) pairs.push(current.trim());

    return pairs;
  }

  private parseInlineValue(raw: string): unknown {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    if (/^\d+\.\d+$/.test(raw)) return parseFloat(raw);
    return this.unquote(raw);
  }

  private parseEdgeList(lines: string[], startIdx: number): { value: string[]; endIdx: number } {
    const edges: string[] = [];
    let i = startIdx;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }

      const indent = this.getIndent(line);
      if (indent <= 4 && trimmed && !trimmed.startsWith('-')) break;

      if (trimmed.startsWith('- ')) {
        edges.push(trimmed.slice(2));
      }

      i++;
    }

    return { value: edges, endIdx: i };
  }

  private parsePipeline(lines: string[], startIdx: number): { value: PipelineStep[]; endIdx: number } {
    const pipeline: PipelineStep[] = [];
    let i = startIdx;
    let currentStep: any = null;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }

      const indent = this.getIndent(line);
      if (indent === 0 && trimmed && !trimmed.startsWith('#')) break;

      if (trimmed.startsWith('- graph:')) {
        if (currentStep) pipeline.push(currentStep);
        currentStep = { graph: this.extractValue(trimmed.slice(2), 'graph') };
      } else if (trimmed.startsWith('- for_each:')) {
        if (currentStep) pipeline.push(currentStep);
        currentStep = { for_each: this.extractValue(trimmed.slice(2), 'for_each'), graph: '' };
      } else if (currentStep && trimmed.startsWith('concurrency:')) {
        currentStep.concurrency = parseInt(this.extractValue(trimmed, 'concurrency'));
      } else if (currentStep && trimmed.startsWith('graph:')) {
        currentStep.graph = this.extractValue(trimmed, 'graph');
      }

      i++;
    }

    if (currentStep) pipeline.push(currentStep);
    return { value: pipeline, endIdx: i };
  }

  private parseSimpleMap(lines: string[], startIdx: number): { value: Record<string, unknown>; endIdx: number } {
    const map: Record<string, unknown> = {};
    let i = startIdx;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }

      const indent = this.getIndent(line);
      if (indent === 0 && trimmed && !trimmed.startsWith('#')) break;

      const kvMatch = trimmed.match(/^([\w-]+):\s*(.+)$/);
      if (kvMatch) {
        map[kvMatch[1]] = this.unquote(kvMatch[2]);
      }

      i++;
    }

    return { value: map, endIdx: i };
  }

  private parseMemory(lines: string[], startIdx: number): { value: WorkflowMemory; endIdx: number } {
    const memory: WorkflowMemory = {};
    let i = startIdx;
    let currentList: 'terminology' | 'rules' | null = null;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }

      const indent = this.getIndent(line);
      if (indent === 0 && trimmed && !trimmed.startsWith('#')) break;

      if (trimmed === 'terminology:') {
        currentList = 'terminology';
        memory.terminology = [];
      } else if (trimmed === 'rules:') {
        currentList = 'rules';
        memory.rules = [];
      } else if (trimmed.startsWith('- ') && currentList) {
        const value = this.unquote(trimmed.slice(2));
        memory[currentList]!.push(value);
      }

      i++;
    }

    return { value: memory, endIdx: i };
  }
}
