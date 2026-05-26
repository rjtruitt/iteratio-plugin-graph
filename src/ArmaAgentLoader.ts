/**
 * ArmaAgentLoader — Load .arma.agent configuration files
 *
 * .arma.agent is a declarative agent definition format:
 *
 * ```yaml
 * name: code-reviewer
 * type: operator          # operator | worker | research | coder | planner
 * model: claude-sonnet-4
 * provider: bedrock
 *
 * system_prompt: |
 *   You are a code reviewer...
 *
 * tools:
 *   - bash
 *   - read_file
 *   - list_files
 *
 * graph:
 *   entry: start
 *   nodes:
 *     start: { type: llm }
 *     review: { type: tool, tools: [bash, read_file] }
 *     summarize: { type: llm, prompt: "Summarize findings" }
 *   edges:
 *     - start -> review [needs_review == true]
 *     - start -> summarize [needs_review == false]
 *     - review -> summarize
 *
 * workers:
 *   - name: linter
 *     model: claude-haiku
 *     prompt: "Run linting checks"
 *   - name: test-runner
 *     model: claude-haiku
 *     prompt: "Run test suite"
 *
 * permissions:
 *   bash: ask
 *   read_file: allow
 *   list_files: allow
 * ```
 */

export interface ArmaAgentConfig {
  name: string;
  type: AgentType;
  model?: string;
  provider?: string;
  system_prompt?: string;
  tools?: string[];
  graph?: ArmaGraphConfig;
  workers?: ArmaWorkerConfig[];
  permissions?: Record<string, 'allow' | 'deny' | 'ask'>;
  max_turns?: number;
  timeout?: number;
}

export type AgentType = 'operator' | 'worker' | 'research' | 'coder' | 'planner' | 'reviewer' | 'custom';

export interface ArmaGraphConfig {
  entry: string;
  nodes: Record<string, ArmaNodeConfig>;
  edges: string[];
}

export interface ArmaNodeConfig {
  type: 'llm' | 'tool' | 'condition' | 'parallel' | 'human';
  tools?: string[];
  prompt?: string;
  model?: string;
  timeout?: number;
}

export interface ArmaWorkerConfig {
  name: string;
  model?: string;
  provider?: string;
  prompt?: string;
  tools?: string[];
}

export interface ParsedEdge {
  from: string;
  to: string;
  condition?: string;
}

const PREBUILT_AGENTS: Record<AgentType, Partial<ArmaAgentConfig>> = {
  operator: {
    tools: ['bash', 'read_file', 'list_files', 'ask_user', 'spawn_worker'],
    max_turns: 50,
  },
  worker: {
    tools: ['bash', 'read_file', 'list_files'],
    max_turns: 20,
  },
  research: {
    tools: ['bash', 'read_file', 'list_files'],
    system_prompt: 'You are a research agent. Search, read, and synthesize information. Report findings concisely.',
    max_turns: 30,
  },
  coder: {
    tools: ['bash', 'read_file', 'list_files'],
    system_prompt: 'You are a coding agent. Write, test, and fix code. Follow the plan and report progress.',
    max_turns: 40,
  },
  planner: {
    tools: ['read_file', 'list_files'],
    system_prompt: 'You are a planning agent. Analyze requirements, break down tasks, and create implementation plans. Do not execute.',
    max_turns: 10,
  },
  reviewer: {
    tools: ['bash', 'read_file', 'list_files'],
    system_prompt: 'You are a code reviewer. Analyze code for correctness, style, security, and performance. Provide specific feedback.',
    max_turns: 15,
  },
  custom: {},
};

/** Loads and configures Arma agents for use within graph workflow nodes. */
export class ArmaAgentLoader {
  loadFromJSON(json: string): ArmaAgentConfig {
    const parsed = JSON.parse(json);
    return this.validate(parsed);
  }

  loadFromYAML(yaml: string): ArmaAgentConfig {
    const parsed = this.parseSimpleYAML(yaml);
    return this.validate(parsed);
  }

  loadFromObject(obj: Record<string, unknown>): ArmaAgentConfig {
    return this.validate(obj);
  }

  getPrebuiltConfig(type: AgentType): Partial<ArmaAgentConfig> {
    return { ...PREBUILT_AGENTS[type] };
  }

  resolveConfig(config: ArmaAgentConfig): ArmaAgentConfig {
    const prebuilt = PREBUILT_AGENTS[config.type] ?? {};
    return {
      ...prebuilt,
      ...config,
      tools: config.tools ?? prebuilt.tools,
      system_prompt: config.system_prompt ?? prebuilt.system_prompt,
      max_turns: config.max_turns ?? prebuilt.max_turns,
    };
  }

  parseEdge(edgeStr: string): ParsedEdge {
    // Format: "nodeA -> nodeB" or "nodeA -> nodeB [condition]"
    const match = edgeStr.match(/^([\w-]+)\s*->\s*([\w-]+)(?:\s*\[(.+)\])?$/);
    if (!match) {
      throw new Error(`Invalid edge format: "${edgeStr}". Expected "from -> to [condition]"`);
    }
    return {
      from: match[1],
      to: match[2],
      condition: match[3]?.trim(),
    };
  }

  private validate(raw: any): ArmaAgentConfig {
    if (!raw.name || typeof raw.name !== 'string') {
      throw new Error('.arma.agent: "name" field is required');
    }
    if (!raw.type || !['operator', 'worker', 'research', 'coder', 'planner', 'reviewer', 'custom'].includes(raw.type)) {
      throw new Error('.arma.agent: "type" must be one of: operator, worker, research, coder, planner, reviewer, custom');
    }

    const config: ArmaAgentConfig = {
      name: raw.name,
      type: raw.type as AgentType,
      model: raw.model,
      provider: raw.provider,
      system_prompt: raw.system_prompt,
      tools: raw.tools,
      graph: raw.graph,
      workers: raw.workers,
      permissions: raw.permissions,
      max_turns: raw.max_turns,
      timeout: raw.timeout,
    };

    // Validate graph edges if present
    if (config.graph?.edges) {
      for (const edge of config.graph.edges) {
        this.parseEdge(edge);
      }
    }

    return config;
  }

  private parseSimpleYAML(yaml: string): any {
    const result: any = {};
    const lines = yaml.split('\n');
    let currentKey: string | null = null;
    let multilineValue = '';
    let inMultiline = false;
    let indent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Multi-line string continuation
      if (inMultiline) {
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent > indent || trimmed === '') {
          multilineValue += (multilineValue ? '\n' : '') + trimmed;
          continue;
        } else {
          result[currentKey!] = multilineValue;
          inMultiline = false;
        }
      }

      // Top-level key: value
      const kvMatch = trimmed.match(/^([\w_]+):\s*(.*)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        indent = line.length - line.trimStart().length;

        if (value === '|') {
          // Multi-line string
          currentKey = key;
          multilineValue = '';
          inMultiline = true;
          continue;
        }

        if (value === '' || value === undefined) {
          // Nested object or array — look ahead
          currentKey = key;
          const nextLine = lines[i + 1];
          if (nextLine && nextLine.trim().startsWith('-')) {
            result[key] = this.parseYAMLArray(lines, i + 1);
          } else if (nextLine) {
            result[key] = this.parseYAMLObject(lines, i + 1);
          }
        } else {
          result[key] = this.parseYAMLValue(value);
        }
      }
    }

    if (inMultiline && currentKey) {
      result[currentKey] = multilineValue;
    }

    return result;
  }

  private parseYAMLArray(lines: string[], startIdx: number): any[] {
    const results: any[] = [];
    const baseIndent = lines[startIdx].length - lines[startIdx].trimStart().length;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent < baseIndent) break;

      if (trimmed.startsWith('- ')) {
        const value = trimmed.slice(2);
        results.push(this.parseYAMLValue(value));
      }
    }
    return results;
  }

  private parseYAMLObject(lines: string[], startIdx: number): any {
    const result: any = {};
    const baseIndent = lines[startIdx].length - lines[startIdx].trimStart().length;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent < baseIndent) break;

      const kvMatch = trimmed.match(/^([\w_-]+):\s*(.*)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        result[key] = this.parseYAMLValue(value);
      }
    }
    return result;
  }

  private parseYAMLValue(value: string): any {
    if (!value) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    // Inline array [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      return value.slice(1, -1).split(',').map(v => v.trim());
    }
    // Inline object { key: val }
    if (value.startsWith('{') && value.endsWith('}')) {
      const obj: any = {};
      const pairs = value.slice(1, -1).split(',');
      for (const pair of pairs) {
        const [k, v] = pair.split(':').map(s => s.trim());
        if (k && v) obj[k] = this.parseYAMLValue(v);
      }
      return obj;
    }
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
}
