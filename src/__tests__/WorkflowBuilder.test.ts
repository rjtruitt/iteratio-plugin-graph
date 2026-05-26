/**
 * WorkflowBuilder TDD Tests
 *
 * Tests for the .arma.workflow builder infrastructure:
 * - WorkflowBuilder: programmatic construction of workflow definitions
 * - WorkflowValidator: structural validation (graphs, edges, refs, tools)
 * - WorkflowSerializer: output valid YAML
 * - WorkflowParser: parse .arma.workflow YAML back into objects
 * - WorkflowOptimizer: detect patterns and suggest improvements
 */

import { describe, it, expect } from 'vitest';
import {
  WorkflowBuilder,
  WorkflowValidator,
  WorkflowSerializer,
  WorkflowParser,
  WorkflowOptimizer,
  WorkflowDefinition,
  WorkflowNodeType,
  PipelineStep,
} from '../WorkflowBuilder';

describe('WorkflowBuilder', () => {
  describe('construction', () => {
    it('creates a minimal workflow with name and version', () => {
      const wf = new WorkflowBuilder('my-workflow')
        .setDescription('Test workflow')
        .build();

      expect(wf.name).toBe('my-workflow');
      expect(wf.version).toBe('1.0');
      expect(wf.description).toBe('Test workflow');
    });

    it('sets schedule configuration', () => {
      const wf = new WorkflowBuilder('scheduled-job')
        .setSchedule({ interval_hours: 4, catch_up: true, max_concurrent: 1 })
        .build();

      expect(wf.schedule).toEqual({
        interval_hours: 4,
        catch_up: true,
        max_concurrent: 1,
      });
    });

    it('sets cron-based schedule', () => {
      const wf = new WorkflowBuilder('cron-job')
        .setSchedule({ cron: '0 */6 * * *', catch_up: false, max_concurrent: 2 })
        .build();

      expect(wf.schedule!.cron).toBe('0 */6 * * *');
      expect(wf.schedule!.interval_hours).toBeUndefined();
    });

    it('adds agent definitions', () => {
      const wf = new WorkflowBuilder('agent-workflow')
        .addAgent({
          name: 'orchestrator',
          type: 'operator',
          model: 'claude-sonnet-4',
          config_ref: 'orchestrator.arma.agent',
        })
        .addAgent({
          name: 'verifier',
          type: 'worker',
          model: 'claude-haiku',
          lifecycle: 'one-shot',
        })
        .build();

      expect(wf.agents).toHaveLength(2);
      expect(wf.agents[0].name).toBe('orchestrator');
      expect(wf.agents[0].type).toBe('operator');
      expect(wf.agents[1].lifecycle).toBe('one-shot');
    });

    it('adds input parameters', () => {
      const wf = new WorkflowBuilder('parameterized')
        .setInputs({
          parentPageId: '1070865008',
          spaceId: '311787538',
          targetOrg: 'lodging-staging',
        })
        .build();

      expect(wf.inputs).toEqual({
        parentPageId: '1070865008',
        spaceId: '311787538',
        targetOrg: 'lodging-staging',
      });
    });

    it('adds memory/terminology rules', () => {
      const wf = new WorkflowBuilder('memory-workflow')
        .setMemory({
          terminology: ['Oppy ≠ Opportunity: Oppy = AM Opportunity from Scout/Brain'],
          rules: ['CODE WINS on conflicts (technical truth)'],
        })
        .build();

      expect(wf.memory!.terminology).toHaveLength(1);
      expect(wf.memory!.rules).toHaveLength(1);
    });
  });

  describe('graph construction', () => {
    it('adds a graph with nodes and edges', () => {
      const wf = new WorkflowBuilder('graph-workflow')
        .addGraph('discovery', {
          entry: 'scan',
          nodes: {
            scan: { type: 'tool', tool: 'confluence.getPageDescendants' },
            classify: { type: 'condition', source: 'comment.type' },
            done: { type: 'transform' },
          },
          edges: ['scan -> classify', 'classify -> done'],
        })
        .build();

      expect(wf.graphs['discovery']).toBeDefined();
      expect(wf.graphs['discovery'].entry).toBe('scan');
      expect(Object.keys(wf.graphs['discovery'].nodes)).toHaveLength(3);
      expect(wf.graphs['discovery'].edges).toHaveLength(2);
    });

    it('adds conditional edges with bracket notation', () => {
      const wf = new WorkflowBuilder('conditional')
        .addGraph('routing', {
          entry: 'classify',
          nodes: {
            classify: { type: 'condition', source: 'state.type' },
            code: { type: 'llm', prompt: 'Handle code change' },
            config: { type: 'llm', prompt: 'Handle config refresh' },
            fallback: { type: 'llm', prompt: 'Decide route' },
          },
          edges: [
            'classify -> code [type == "code-change"]',
            'classify -> config [type == "config-refresh"]',
            'classify -> fallback',
          ],
        })
        .build();

      const edges = wf.graphs['routing'].edges;
      expect(edges).toHaveLength(3);
      expect(edges[0]).toBe('classify -> code [type == "code-change"]');
      expect(edges[2]).toBe('classify -> fallback');
    });

    it('adds a graph with spawn node', () => {
      const wf = new WorkflowBuilder('spawn-workflow')
        .addGraph('verification', {
          entry: 'spawn-verifiers',
          nodes: {
            'spawn-verifiers': {
              type: 'spawn',
              count: 5,
              agent: 'hallucination-checker',
              lifecycle: 'one-shot',
            },
            evaluate: { type: 'condition', source: 'state.avgConfidence' },
            done: { type: 'transform' },
          },
          edges: [
            'spawn-verifiers -> evaluate',
            'evaluate -> done [avgConfidence > 0.9]',
          ],
        })
        .build();

      const spawnNode = wf.graphs['verification'].nodes['spawn-verifiers'];
      expect(spawnNode.type).toBe('spawn');
      expect(spawnNode.count).toBe(5);
      expect(spawnNode.agent).toBe('hallucination-checker');
    });

    it('adds a graph with loop node', () => {
      const wf = new WorkflowBuilder('loop-workflow')
        .addGraph('retry', {
          entry: 'attempt',
          nodes: {
            attempt: { type: 'llm', prompt: 'Fix issues' },
            check: { type: 'condition', source: 'state.fixed' },
            done: { type: 'transform' },
          },
          edges: [
            'attempt -> check',
            'check -> done [fixed == true]',
            'check -> attempt [fixIteration < 3]',
          ],
        })
        .build();

      const edges = wf.graphs['retry'].edges;
      expect(edges).toContain('check -> attempt [fixIteration < 3]');
    });

    it('adds a graph with vector node', () => {
      const wf = new WorkflowBuilder('vector-workflow')
        .addGraph('search', {
          entry: 'embed',
          nodes: {
            embed: { type: 'vector', action: 'upsert' },
            query: { type: 'vector', action: 'search', threshold: 0.92 },
            done: { type: 'transform' },
          },
          edges: ['embed -> query', 'query -> done'],
        })
        .build();

      expect(wf.graphs['search'].nodes['query'].threshold).toBe(0.92);
    });

    it('adds a graph with drift node', () => {
      const wf = new WorkflowBuilder('drift-workflow')
        .addGraph('snapshot', {
          entry: 'pre-snap',
          nodes: {
            'pre-snap': { type: 'drift', action: 'snapshot', tag: 'pre-publish' },
            publish: { type: 'tool', tool: 'confluence.createPage' },
            'post-snap': { type: 'drift', action: 'snapshot', tag: 'post-publish' },
          },
          edges: ['pre-snap -> publish', 'publish -> post-snap'],
        })
        .build();

      const preSnap = wf.graphs['snapshot'].nodes['pre-snap'];
      expect(preSnap.type).toBe('drift');
      expect(preSnap.tag).toBe('pre-publish');
    });

    it('adds multiple graphs', () => {
      const wf = new WorkflowBuilder('multi-graph')
        .addGraph('phase1', {
          entry: 'start',
          nodes: { start: { type: 'tool', tool: 'scan' }, end: { type: 'transform' } },
          edges: ['start -> end'],
        })
        .addGraph('phase2', {
          entry: 'process',
          nodes: { process: { type: 'llm', prompt: 'Process' }, done: { type: 'transform' } },
          edges: ['process -> done'],
        })
        .build();

      expect(Object.keys(wf.graphs)).toHaveLength(2);
      expect(wf.graphs['phase1']).toBeDefined();
      expect(wf.graphs['phase2']).toBeDefined();
    });
  });

  describe('pipeline construction', () => {
    it('sets a linear pipeline', () => {
      const wf = new WorkflowBuilder('pipeline-workflow')
        .addGraph('phase1', {
          entry: 'start',
          nodes: { start: { type: 'transform' } },
          edges: [],
        })
        .addGraph('phase2', {
          entry: 'start',
          nodes: { start: { type: 'transform' } },
          edges: [],
        })
        .setPipeline([
          { graph: 'phase1' },
          { graph: 'phase2' },
        ])
        .build();

      expect(wf.pipeline).toHaveLength(2);
      expect(wf.pipeline[0].graph).toBe('phase1');
    });

    it('sets a pipeline with for_each step', () => {
      const wf = new WorkflowBuilder('foreach-workflow')
        .addGraph('discovery', {
          entry: 'scan',
          nodes: { scan: { type: 'tool', tool: 'scan' } },
          edges: [],
        })
        .addGraph('per-page', {
          entry: 'process',
          nodes: { process: { type: 'llm', prompt: 'Process page' } },
          edges: [],
        })
        .setPipeline([
          { graph: 'discovery' },
          { for_each: 'state.workQueue', concurrency: 3, graph: 'per-page' },
        ])
        .build();

      expect(wf.pipeline[1].for_each).toBe('state.workQueue');
      expect(wf.pipeline[1].concurrency).toBe(3);
      expect(wf.pipeline[1].graph).toBe('per-page');
    });

    it('rejects pipeline referencing non-existent graph', () => {
      const builder = new WorkflowBuilder('bad-pipeline')
        .addGraph('real', {
          entry: 'start',
          nodes: { start: { type: 'transform' } },
          edges: [],
        })
        .setPipeline([
          { graph: 'real' },
          { graph: 'nonexistent' },
        ]);

      expect(() => builder.build()).toThrow(/graph.*nonexistent.*not defined/i);
    });
  });

  describe('graph-of-graphs', () => {
    it('allows subgraph references between defined graphs', () => {
      const wf = new WorkflowBuilder('graph-of-graphs')
        .addGraph('main', {
          entry: 'start',
          nodes: {
            start: { type: 'tool', tool: 'scan' },
            sub: { type: 'subgraph', ref: 'child-graph' },
            end: { type: 'transform' },
          },
          edges: ['start -> sub', 'sub -> end'],
        })
        .addGraph('child-graph', {
          entry: 'process',
          nodes: { process: { type: 'llm', prompt: 'Do work' }, done: { type: 'transform' } },
          edges: ['process -> done'],
        })
        .setPipeline([{ graph: 'main' }])
        .build();

      expect(wf.graphs['main'].nodes['sub'].ref).toBe('child-graph');
      expect(wf.graphs['child-graph']).toBeDefined();
    });

    it('detects missing subgraph references', () => {
      const builder = new WorkflowBuilder('missing-ref')
        .addGraph('main', {
          entry: 'start',
          nodes: {
            start: { type: 'tool', tool: 'scan' },
            sub: { type: 'subgraph', ref: 'does-not-exist' },
          },
          edges: ['start -> sub'],
        })
        .setPipeline([{ graph: 'main' }]);

      expect(() => builder.build()).toThrow(/subgraph.*does-not-exist.*not defined/i);
    });
  });
});

describe('WorkflowValidator', () => {
  const validator = new WorkflowValidator();

  it('validates a correct workflow', () => {
    const wf: WorkflowDefinition = {
      name: 'valid-workflow',
      version: '1.0',
      agents: [{ name: 'bot', type: 'operator', model: 'claude-sonnet-4' }],
      graphs: {
        main: {
          entry: 'start',
          nodes: {
            start: { type: 'tool', tool: 'scan' },
            end: { type: 'transform' },
          },
          edges: ['start -> end'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const result = validator.validate(wf);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects missing entry node in graph', () => {
    const wf: WorkflowDefinition = {
      name: 'bad-entry',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'nonexistent',
          nodes: { start: { type: 'transform' } },
          edges: [],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const result = validator.validate(wf);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: 'missing_entry_node' })
    );
  });

  it('detects dangling edge references', () => {
    const wf: WorkflowDefinition = {
      name: 'dangling-edge',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'start',
          nodes: { start: { type: 'transform' } },
          edges: ['start -> ghost'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const result = validator.validate(wf);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: 'dangling_edge' })
    );
  });

  it('detects unreachable nodes', () => {
    const wf: WorkflowDefinition = {
      name: 'unreachable',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'start',
          nodes: {
            start: { type: 'transform' },
            end: { type: 'transform' },
            orphan: { type: 'transform' },
          },
          edges: ['start -> end'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const result = validator.validate(wf);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: 'unreachable_node' })
    );
  });

  it('detects unresolvable cycles (no exit condition)', () => {
    const wf: WorkflowDefinition = {
      name: 'infinite-loop',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'a',
          nodes: {
            a: { type: 'transform' },
            b: { type: 'transform' },
          },
          edges: ['a -> b', 'b -> a'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const result = validator.validate(wf);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: 'unresolvable_cycle' })
    );
  });

  it('allows intentional loops with exit conditions', () => {
    const wf: WorkflowDefinition = {
      name: 'bounded-loop',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'attempt',
          nodes: {
            attempt: { type: 'llm', prompt: 'Try' },
            check: { type: 'condition', source: 'state.done' },
            done: { type: 'transform' },
          },
          edges: [
            'attempt -> check',
            'check -> done [done == true]',
            'check -> attempt [iteration < 3]',
          ],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const result = validator.validate(wf);
    expect(result.valid).toBe(true);
  });

  it('validates spawn node has required fields', () => {
    const wf: WorkflowDefinition = {
      name: 'bad-spawn',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'spawn',
          nodes: {
            spawn: { type: 'spawn' }, // missing count and agent
          },
          edges: [],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const result = validator.validate(wf);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: 'invalid_node_config' })
    );
  });

  it('validates vector node has required fields', () => {
    const wf: WorkflowDefinition = {
      name: 'bad-vector',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'vec',
          nodes: {
            vec: { type: 'vector' }, // missing action
          },
          edges: [],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const result = validator.validate(wf);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: 'invalid_node_config' })
    );
  });

  it('validates pipeline graph references', () => {
    const wf: WorkflowDefinition = {
      name: 'bad-pipeline',
      version: '1.0',
      agents: [],
      graphs: {
        real: {
          entry: 'start',
          nodes: { start: { type: 'transform' } },
          edges: [],
        },
      },
      pipeline: [{ graph: 'real' }, { graph: 'fake' }],
    };

    const result = validator.validate(wf);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: 'missing_pipeline_graph' })
    );
  });

  it('validates agent references in spawn nodes', () => {
    const wf: WorkflowDefinition = {
      name: 'agent-ref',
      version: '1.0',
      agents: [{ name: 'checker', type: 'worker', model: 'claude-haiku' }],
      graphs: {
        main: {
          entry: 'spawn',
          nodes: {
            spawn: { type: 'spawn', count: 3, agent: 'nonexistent-agent' },
            done: { type: 'transform' },
          },
          edges: ['spawn -> done'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const result = validator.validate(wf);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'unresolved_agent_ref' })
    );
  });
});

describe('WorkflowSerializer', () => {
  const serializer = new WorkflowSerializer();

  it('serializes a minimal workflow to YAML', () => {
    const wf: WorkflowDefinition = {
      name: 'test-workflow',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'start',
          nodes: { start: { type: 'transform' } },
          edges: [],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const yaml = serializer.toYAML(wf);
    expect(yaml).toContain('name: test-workflow');
    expect(yaml).toContain('version: "1.0"');
    expect(yaml).toContain('graphs:');
    expect(yaml).toContain('pipeline:');
  });

  it('serializes schedule correctly', () => {
    const wf: WorkflowDefinition = {
      name: 'scheduled',
      version: '1.0',
      schedule: { interval_hours: 4, catch_up: true, max_concurrent: 1 },
      agents: [],
      graphs: {
        main: {
          entry: 'start',
          nodes: { start: { type: 'transform' } },
          edges: [],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const yaml = serializer.toYAML(wf);
    expect(yaml).toContain('schedule:');
    expect(yaml).toContain('interval_hours: 4');
    expect(yaml).toContain('catch_up: true');
    expect(yaml).toContain('max_concurrent: 1');
  });

  it('serializes agents with all fields', () => {
    const wf: WorkflowDefinition = {
      name: 'agents',
      version: '1.0',
      agents: [
        { name: 'bot', type: 'operator', model: 'claude-sonnet-4', config_ref: 'bot.arma.agent' },
        { name: 'worker', type: 'worker', model: 'claude-haiku', lifecycle: 'one-shot' },
      ],
      graphs: {
        main: {
          entry: 'start',
          nodes: { start: { type: 'transform' } },
          edges: [],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const yaml = serializer.toYAML(wf);
    expect(yaml).toContain('- name: bot');
    expect(yaml).toContain('type: operator');
    expect(yaml).toContain('config_ref: bot.arma.agent');
    expect(yaml).toContain('lifecycle: one-shot');
  });

  it('serializes graph nodes with inline config', () => {
    const wf: WorkflowDefinition = {
      name: 'nodes',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'scan',
          nodes: {
            scan: { type: 'tool', tool: 'confluence.getPageDescendants' },
            classify: { type: 'condition', source: 'comment.type' },
          },
          edges: ['scan -> classify'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const yaml = serializer.toYAML(wf);
    expect(yaml).toContain('scan:');
    expect(yaml).toContain('type: tool');
    expect(yaml).toContain('tool: confluence.getPageDescendants');
  });

  it('serializes conditional edges with bracket conditions', () => {
    const wf: WorkflowDefinition = {
      name: 'cond-edges',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'route',
          nodes: {
            route: { type: 'condition', source: 'state.type' },
            a: { type: 'transform' },
            b: { type: 'transform' },
          },
          edges: ['route -> a [type == "code"]', 'route -> b [type == "config"]'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const yaml = serializer.toYAML(wf);
    expect(yaml).toContain('- route -> a [type == "code"]');
    expect(yaml).toContain('- route -> b [type == "config"]');
  });

  it('serializes for_each pipeline steps', () => {
    const wf: WorkflowDefinition = {
      name: 'foreach',
      version: '1.0',
      agents: [],
      graphs: {
        disc: { entry: 's', nodes: { s: { type: 'transform' } }, edges: [] },
        page: { entry: 'p', nodes: { p: { type: 'transform' } }, edges: [] },
      },
      pipeline: [
        { graph: 'disc' },
        { for_each: 'state.workQueue', concurrency: 3, graph: 'page' },
      ],
    };

    const yaml = serializer.toYAML(wf);
    expect(yaml).toContain('for_each: state.workQueue');
    expect(yaml).toContain('concurrency: 3');
  });

  it('serializes memory section', () => {
    const wf: WorkflowDefinition = {
      name: 'memory',
      version: '1.0',
      agents: [],
      graphs: { main: { entry: 's', nodes: { s: { type: 'transform' } }, edges: [] } },
      pipeline: [{ graph: 'main' }],
      memory: {
        terminology: ['Oppy ≠ Opportunity'],
        rules: ['CODE WINS'],
      },
    };

    const yaml = serializer.toYAML(wf);
    expect(yaml).toContain('memory:');
    expect(yaml).toContain('terminology:');
    expect(yaml).toContain('- "Oppy ≠ Opportunity"');
    expect(yaml).toContain('rules:');
    expect(yaml).toContain('- "CODE WINS"');
  });

  it('round-trips through serialize/parse', () => {
    const original: WorkflowDefinition = {
      name: 'roundtrip',
      version: '1.0',
      description: 'Test roundtrip',
      schedule: { interval_hours: 2, catch_up: true, max_concurrent: 1 },
      agents: [{ name: 'bot', type: 'operator', model: 'claude-sonnet-4' }],
      graphs: {
        main: {
          entry: 'start',
          nodes: {
            start: { type: 'tool', tool: 'scan' },
            end: { type: 'transform' },
          },
          edges: ['start -> end'],
        },
      },
      pipeline: [{ graph: 'main' }],
      inputs: { orgId: 'test-org' },
    };

    const yaml = serializer.toYAML(original);
    const parser = new WorkflowParser();
    const parsed = parser.fromYAML(yaml);

    expect(parsed.name).toBe(original.name);
    expect(parsed.schedule).toEqual(original.schedule);
    expect(parsed.agents).toEqual(original.agents);
    expect(parsed.graphs['main'].entry).toBe('start');
    expect(parsed.pipeline).toEqual(original.pipeline);
    expect(parsed.inputs).toEqual(original.inputs);
  });
});

describe('WorkflowParser', () => {
  const parser = new WorkflowParser();

  it('parses a basic .arma.workflow YAML', () => {
    const yaml = `
name: simple-workflow
version: "1.0"
description: "A simple test workflow"

agents:
  - name: bot
    type: operator
    model: claude-sonnet-4

graphs:
  main:
    entry: start
    nodes:
      start: { type: tool, tool: confluence.getPage }
      end: { type: transform }
    edges:
      - start -> end

pipeline:
  - graph: main
`;

    const wf = parser.fromYAML(yaml);
    expect(wf.name).toBe('simple-workflow');
    expect(wf.version).toBe('1.0');
    expect(wf.agents[0].name).toBe('bot');
    expect(wf.graphs['main'].entry).toBe('start');
    expect(wf.graphs['main'].nodes['start'].tool).toBe('confluence.getPage');
    expect(wf.pipeline[0].graph).toBe('main');
  });

  it('parses schedule section', () => {
    const yaml = `
name: scheduled
version: "1.0"

schedule:
  interval_hours: 4
  catch_up: true
  max_concurrent: 1

agents: []

graphs:
  main:
    entry: s
    nodes:
      s: { type: transform }
    edges: []

pipeline:
  - graph: main
`;

    const wf = parser.fromYAML(yaml);
    expect(wf.schedule!.interval_hours).toBe(4);
    expect(wf.schedule!.catch_up).toBe(true);
  });

  it('parses conditional edges', () => {
    const yaml = `
name: conditional
version: "1.0"
agents: []

graphs:
  main:
    entry: route
    nodes:
      route: { type: condition, source: state.type }
      a: { type: transform }
      b: { type: transform }
    edges:
      - route -> a [type == "code"]
      - route -> b [type == "config"]

pipeline:
  - graph: main
`;

    const wf = parser.fromYAML(yaml);
    expect(wf.graphs['main'].edges[0]).toBe('route -> a [type == "code"]');
  });

  it('parses for_each pipeline steps', () => {
    const yaml = `
name: foreach
version: "1.0"
agents: []

graphs:
  disc:
    entry: s
    nodes:
      s: { type: transform }
    edges: []
  page:
    entry: p
    nodes:
      p: { type: transform }
    edges: []

pipeline:
  - graph: disc
  - for_each: state.workQueue
    concurrency: 3
    graph: page
`;

    const wf = parser.fromYAML(yaml);
    expect(wf.pipeline[1].for_each).toBe('state.workQueue');
    expect(wf.pipeline[1].concurrency).toBe(3);
  });

  it('parses inputs section', () => {
    const yaml = `
name: inputs
version: "1.0"
agents: []
graphs:
  main:
    entry: s
    nodes:
      s: { type: transform }
    edges: []
pipeline:
  - graph: main

inputs:
  parentPageId: "1070865008"
  spaceId: "311787538"
  targetOrg: lodging-staging
`;

    const wf = parser.fromYAML(yaml);
    expect(wf.inputs!['parentPageId']).toBe('1070865008');
    expect(wf.inputs!['targetOrg']).toBe('lodging-staging');
  });

  it('throws on invalid YAML structure', () => {
    const yaml = `
not-a-workflow: true
random: stuff
`;
    expect(() => parser.fromYAML(yaml)).toThrow(/name.*required/i);
  });
});

describe('WorkflowOptimizer', () => {
  const optimizer = new WorkflowOptimizer();

  it('suggests vector caching for repeated tool calls', () => {
    const wf: WorkflowDefinition = {
      name: 'repetitive',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'search1',
          nodes: {
            search1: { type: 'tool', tool: 'github.searchCode' },
            search2: { type: 'tool', tool: 'github.searchCode' },
            search3: { type: 'tool', tool: 'github.searchCode' },
            compile: { type: 'llm', prompt: 'Compile' },
          },
          edges: ['search1 -> search2', 'search2 -> search3', 'search3 -> compile'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const suggestions = optimizer.analyze(wf);
    expect(suggestions).toContainEqual(
      expect.objectContaining({ type: 'vector_cache', severity: 'suggestion' })
    );
  });

  it('suggests bounded pool instead of high spawn count', () => {
    const wf: WorkflowDefinition = {
      name: 'too-many-spawns',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'spawn',
          nodes: {
            spawn: { type: 'spawn', count: 50, agent: 'worker' },
            done: { type: 'transform' },
          },
          edges: ['spawn -> done'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const suggestions = optimizer.analyze(wf);
    expect(suggestions).toContainEqual(
      expect.objectContaining({ type: 'bounded_pool', severity: 'warning' })
    );
  });

  it('suggests drift snapshots for publish operations', () => {
    const wf: WorkflowDefinition = {
      name: 'no-drift',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'publish',
          nodes: {
            publish: { type: 'tool', tool: 'confluence.createPage' },
            done: { type: 'transform' },
          },
          edges: ['publish -> done'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const suggestions = optimizer.analyze(wf);
    expect(suggestions).toContainEqual(
      expect.objectContaining({ type: 'missing_drift', severity: 'suggestion' })
    );
  });

  it('suggests hallucination check for LLM-generated content before publish', () => {
    const wf: WorkflowDefinition = {
      name: 'no-verification',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'generate',
          nodes: {
            generate: { type: 'llm', prompt: 'Generate content' },
            publish: { type: 'tool', tool: 'confluence.updatePage' },
          },
          edges: ['generate -> publish'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const suggestions = optimizer.analyze(wf);
    expect(suggestions).toContainEqual(
      expect.objectContaining({ type: 'missing_verification', severity: 'warning' })
    );
  });

  it('returns no suggestions for well-structured workflow', () => {
    const wf: WorkflowDefinition = {
      name: 'optimized',
      version: '1.0',
      agents: [{ name: 'checker', type: 'worker', model: 'claude-haiku' }],
      graphs: {
        main: {
          entry: 'vector-check',
          nodes: {
            'vector-check': { type: 'vector', action: 'search', threshold: 0.92 },
            generate: { type: 'llm', prompt: 'Generate' },
            verify: { type: 'spawn', count: 3, agent: 'checker', lifecycle: 'one-shot' },
            'drift-pre': { type: 'drift', action: 'snapshot', tag: 'pre-publish' },
            publish: { type: 'tool', tool: 'confluence.updatePage' },
            'drift-post': { type: 'drift', action: 'snapshot', tag: 'post-publish' },
          },
          edges: [
            'vector-check -> generate',
            'generate -> verify',
            'verify -> drift-pre',
            'drift-pre -> publish',
            'publish -> drift-post',
          ],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const suggestions = optimizer.analyze(wf);
    const warnings = suggestions.filter(s => s.severity === 'warning');
    expect(warnings).toHaveLength(0);
  });

  it('detects parallelizable sequential tool calls', () => {
    const wf: WorkflowDefinition = {
      name: 'sequential-tools',
      version: '1.0',
      agents: [],
      graphs: {
        main: {
          entry: 'github',
          nodes: {
            github: { type: 'tool', tool: 'github.searchCode' },
            glean: { type: 'tool', tool: 'glean.search' },
            jira: { type: 'tool', tool: 'jira.search' },
            compile: { type: 'llm', prompt: 'Compile' },
          },
          edges: ['github -> glean', 'glean -> jira', 'jira -> compile'],
        },
      },
      pipeline: [{ graph: 'main' }],
    };

    const suggestions = optimizer.analyze(wf);
    expect(suggestions).toContainEqual(
      expect.objectContaining({ type: 'parallelizable', severity: 'suggestion' })
    );
  });
});

describe('WorkflowBuilder - full doc-bot scenario', () => {
  it('builds the complete doc-bot workflow definition', () => {
    const wf = new WorkflowBuilder('doc-bot-confluence-refresh')
      .setDescription('Maintain Confluence docs via comment-driven refresh')
      .setSchedule({ interval_hours: 4, catch_up: true, max_concurrent: 1 })
      .addAgent({
        name: 'doc-bot-orchestrator',
        type: 'operator',
        model: 'claude-sonnet-4',
        config_ref: 'doc-bot-orchestrator.arma.agent',
      })
      .addAgent({
        name: 'hallucination-checker',
        type: 'worker',
        model: 'claude-sonnet-4',
        lifecycle: 'one-shot',
      })
      .addAgent({
        name: 'formatter',
        type: 'worker',
        model: 'claude-haiku',
        lifecycle: 'one-shot',
      })
      .addGraph('discovery-graph', {
        entry: 'scan-confluence',
        nodes: {
          'scan-confluence': { type: 'tool', tool: 'confluence.getPageDescendants' },
          'drift-compare': { type: 'drift', action: 'compare', tag: 'post-publish' },
          'check-comments': { type: 'tool', tool: 'confluence.getPageComments' },
          classify: { type: 'condition', source: 'comment.type' },
          prioritize: { type: 'transform' },
          'build-queue': { type: 'transform' },
        },
        edges: [
          'scan-confluence -> drift-compare',
          'drift-compare -> check-comments',
          'check-comments -> classify',
          'classify -> prioritize',
          'prioritize -> build-queue',
        ],
      })
      .addGraph('per-page-graph', {
        entry: 'read-comment',
        nodes: {
          'read-comment': { type: 'tool', tool: 'confluence.getPage' },
          route: { type: 'condition', source: 'state.updateType' },
          'code-review': { type: 'subgraph', ref: 'code-review-graph' },
          'config-refresh': { type: 'subgraph', ref: 'config-refresh-graph' },
          'full-refresh': { type: 'subgraph', ref: 'full-discovery-graph' },
          compile: { type: 'llm', prompt: 'Compile findings, CODE WINS' },
          embed: { type: 'vector', action: 'upsert' },
        },
        edges: [
          'read-comment -> route',
          'route -> code-review [updateType == "code-change"]',
          'route -> config-refresh [updateType == "config-refresh"]',
          'route -> full-refresh [updateType == "full-refresh"]',
          'code-review -> compile',
          'config-refresh -> compile',
          'full-refresh -> compile',
          'compile -> embed',
        ],
      })
      .addGraph('code-review-graph', {
        entry: 'vector-lookup',
        nodes: {
          'vector-lookup': { type: 'vector', action: 'search', threshold: 0.92 },
          'github-code': { type: 'tool', tool: 'github.getFileContents' },
          'glean-search': { type: 'tool', tool: 'glean.search' },
          'compare-code-vs-doc': { type: 'llm', prompt: 'What claims are now wrong?' },
          'compile-findings': { type: 'llm', prompt: 'Merge all sources. CODE WINS.' },
          'embed-findings': { type: 'vector', action: 'upsert' },
        },
        edges: [
          'vector-lookup -> github-code',
          'vector-lookup -> glean-search',
          'github-code -> compare-code-vs-doc',
          'glean-search -> compare-code-vs-doc',
          'compare-code-vs-doc -> compile-findings',
          'compile-findings -> embed-findings',
        ],
      })
      .addGraph('config-refresh-graph', {
        entry: 'identify-config',
        nodes: {
          'identify-config': { type: 'llm', prompt: 'Identify config sources' },
          'rerun-queries': { type: 'tool', tool: 'sf.dataQuery' },
          'compare-old-new': { type: 'llm', prompt: 'Diff config values' },
          'embed-config': { type: 'vector', action: 'upsert' },
        },
        edges: [
          'identify-config -> rerun-queries',
          'rerun-queries -> compare-old-new',
          'compare-old-new -> embed-config',
        ],
      })
      .addGraph('full-discovery-graph', {
        entry: 'full-scan',
        nodes: {
          'full-scan': { type: 'tool', tool: 'github.searchCode' },
          'full-compile': { type: 'llm', prompt: 'Full discovery compile' },
          'embed-all': { type: 'vector', action: 'upsert' },
        },
        edges: ['full-scan -> full-compile', 'full-compile -> embed-all'],
      })
      .addGraph('hallucination-graph', {
        entry: 'vector-precheck',
        nodes: {
          'vector-precheck': { type: 'vector', action: 'search', threshold: 0.92 },
          'spawn-verifiers': { type: 'spawn', count: 5, agent: 'hallucination-checker', lifecycle: 'one-shot' },
          evaluate: { type: 'condition', source: 'state.avgConfidence' },
          'fix-issues': { type: 'llm', prompt: 'Fix identified issues' },
          done: { type: 'transform' },
        },
        edges: [
          'vector-precheck -> spawn-verifiers [unverified_claims > 0]',
          'vector-precheck -> done [unverified_claims == 0]',
          'spawn-verifiers -> evaluate',
          'evaluate -> done [avgConfidence > 0.9]',
          'evaluate -> fix-issues [avgConfidence <= 0.9]',
          'fix-issues -> spawn-verifiers [fixIteration < 3]',
          'fix-issues -> done [fixIteration >= 3]',
        ],
      })
      .addGraph('publish-graph', {
        entry: 'drift-pre',
        nodes: {
          'drift-pre': { type: 'drift', action: 'snapshot', tag: 'pre-publish' },
          'publish-parent': { type: 'tool', tool: 'confluence.createPage' },
          'publish-children': { type: 'loop', items: 'state.childPages', tool: 'confluence.createPage' },
          'drift-post': { type: 'drift', action: 'snapshot', tag: 'post-publish' },
          'hierarchy-check': { type: 'tool', tool: 'confluence.getPageDescendants' },
          'hierarchy-fix': { type: 'tool', tool: 'confluence.updatePage' },
          'reply-comment': { type: 'tool', tool: 'confluence.createFooterComment' },
        },
        edges: [
          'drift-pre -> publish-parent',
          'publish-parent -> publish-children',
          'publish-children -> drift-post',
          'drift-post -> hierarchy-check',
          'hierarchy-check -> reply-comment [hierarchyCorrect]',
          'hierarchy-check -> hierarchy-fix [!hierarchyCorrect]',
          'hierarchy-fix -> hierarchy-check [checkCount < 3]',
          'hierarchy-fix -> reply-comment [checkCount >= 3]',
        ],
      })
      .setPipeline([
        { graph: 'discovery-graph' },
        { for_each: 'state.workQueue', concurrency: 3, graph: 'per-page-graph' },
        { graph: 'hallucination-graph' },
        { graph: 'publish-graph' },
      ])
      .setInputs({
        parentPageId: '1070865008',
        spaceId: '311787538',
        cloudId: '72b0730e-31cc-4f34-a316-c126b5d3b1b0',
        cutoffStrategy: 'since-last-run',
        targetOrg: 'lodging-staging',
      })
      .setMemory({
        terminology: [
          'Oppy ≠ Opportunity: Oppy = AM Opportunity from Scout/Brain, Salesforce Opportunity = Distribution Engine',
          'OppyHub syncs 4 sources: AM Opportunities + Partner Outreaches + Planners + SF Opportunities',
        ],
        rules: [
          'CODE WINS on conflicts (technical truth)',
          'PRD = business truth (why, not how)',
          'Every technical claim needs code citation (file:line)',
          "Don't trust code comments alone",
        ],
      })
      .build();

    // Structural assertions
    expect(wf.name).toBe('doc-bot-confluence-refresh');
    expect(wf.agents).toHaveLength(3);
    expect(Object.keys(wf.graphs)).toHaveLength(7);
    expect(wf.pipeline).toHaveLength(4);
    expect(wf.pipeline[1].for_each).toBe('state.workQueue');
    expect(wf.pipeline[1].concurrency).toBe(3);
    expect(wf.memory!.rules).toHaveLength(4);

    // Validate it
    const validator = new WorkflowValidator();
    const result = validator.validate(wf);
    expect(result.valid).toBe(true);

    // Serialize and verify it's valid YAML
    const serializer = new WorkflowSerializer();
    const yaml = serializer.toYAML(wf);
    expect(yaml.length).toBeGreaterThan(500);
    expect(yaml).toContain('doc-bot-confluence-refresh');
    expect(yaml).toContain('for_each: state.workQueue');
  });
});
