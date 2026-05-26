import { describe, it, expect, beforeEach } from 'vitest';
import { ArmaAgentLoader, AgentType, ArmaAgentConfig } from '../ArmaAgentLoader';

describe('ArmaAgentLoader', () => {
  let loader: ArmaAgentLoader;

  beforeEach(() => {
    loader = new ArmaAgentLoader();
  });

  describe('loadFromJSON', () => {
    it('parses valid JSON with name and type', () => {
      const json = JSON.stringify({ name: 'test-agent', type: 'worker' });
      const config = loader.loadFromJSON(json);
      expect(config.name).toBe('test-agent');
      expect(config.type).toBe('worker');
    });

    it('parses JSON with all optional fields', () => {
      const json = JSON.stringify({
        name: 'full-agent',
        type: 'operator',
        model: 'claude-sonnet-4',
        provider: 'bedrock',
        system_prompt: 'You are helpful.',
        tools: ['bash', 'read_file'],
        max_turns: 25,
        timeout: 60000,
        permissions: { bash: 'ask', read_file: 'allow' },
        workers: [{ name: 'sub-worker', model: 'claude-haiku', prompt: 'Do stuff' }],
      });
      const config = loader.loadFromJSON(json);
      expect(config.model).toBe('claude-sonnet-4');
      expect(config.provider).toBe('bedrock');
      expect(config.system_prompt).toBe('You are helpful.');
      expect(config.tools).toEqual(['bash', 'read_file']);
      expect(config.max_turns).toBe(25);
      expect(config.timeout).toBe(60000);
      expect(config.permissions).toEqual({ bash: 'ask', read_file: 'allow' });
      expect(config.workers).toHaveLength(1);
      expect(config.workers![0].name).toBe('sub-worker');
    });

    it('parses JSON with graph config including valid edges', () => {
      const json = JSON.stringify({
        name: 'graph-agent',
        type: 'operator',
        graph: {
          entry: 'start',
          nodes: {
            start: { type: 'llm' },
            review: { type: 'tool', tools: ['bash'] },
          },
          edges: ['start -> review', 'review -> start [retry == true]'],
        },
      });
      const config = loader.loadFromJSON(json);
      expect(config.graph).toBeDefined();
      expect(config.graph!.entry).toBe('start');
      expect(config.graph!.nodes.start.type).toBe('llm');
      expect(config.graph!.edges).toHaveLength(2);
    });

    it('throws on invalid JSON syntax', () => {
      expect(() => loader.loadFromJSON('{ not valid json }')).toThrow();
    });

    it('throws on empty string', () => {
      expect(() => loader.loadFromJSON('')).toThrow();
    });

    it('throws when name is missing', () => {
      const json = JSON.stringify({ type: 'worker' });
      expect(() => loader.loadFromJSON(json)).toThrow('"name" field is required');
    });

    it('throws when name is not a string', () => {
      const json = JSON.stringify({ name: 123, type: 'worker' });
      expect(() => loader.loadFromJSON(json)).toThrow('"name" field is required');
    });

    it('throws when name is empty string', () => {
      const json = JSON.stringify({ name: '', type: 'worker' });
      expect(() => loader.loadFromJSON(json)).toThrow('"name" field is required');
    });

    it('throws when type is missing', () => {
      const json = JSON.stringify({ name: 'test' });
      expect(() => loader.loadFromJSON(json)).toThrow('"type" must be one of');
    });

    it('throws when type is invalid', () => {
      const json = JSON.stringify({ name: 'test', type: 'invalid-type' });
      expect(() => loader.loadFromJSON(json)).toThrow('"type" must be one of');
    });

    it('throws when type is not a string', () => {
      const json = JSON.stringify({ name: 'test', type: 42 });
      expect(() => loader.loadFromJSON(json)).toThrow('"type" must be one of');
    });
  });

  describe('loadFromYAML', () => {
    it('parses basic YAML with name and type', () => {
      const yaml = `name: my-agent\ntype: worker`;
      const config = loader.loadFromYAML(yaml);
      expect(config.name).toBe('my-agent');
      expect(config.type).toBe('worker');
    });

    it('parses YAML with scalar values', () => {
      const yaml = [
        'name: coder-agent',
        'type: coder',
        'model: claude-sonnet-4',
        'provider: bedrock',
        'max_turns: 40',
        'timeout: 30000',
      ].join('\n');
      const config = loader.loadFromYAML(yaml);
      expect(config.name).toBe('coder-agent');
      expect(config.type).toBe('coder');
      expect(config.model).toBe('claude-sonnet-4');
      expect(config.provider).toBe('bedrock');
      expect(config.max_turns).toBe(40);
      expect(config.timeout).toBe(30000);
    });

    it('parses multiline string with pipe operator', () => {
      const yaml = [
        'name: prompt-agent',
        'type: research',
        'system_prompt: |',
        '  You are a research agent.',
        '  Search and synthesize information.',
        '  Report findings concisely.',
      ].join('\n');
      const config = loader.loadFromYAML(yaml);
      expect(config.system_prompt).toContain('You are a research agent.');
      expect(config.system_prompt).toContain('Search and synthesize information.');
      expect(config.system_prompt).toContain('Report findings concisely.');
    });

    it('parses YAML array (tools list)', () => {
      const yaml = [
        'name: tool-agent',
        'type: worker',
        'tools:',
        '  - bash',
        '  - read_file',
        '  - list_files',
      ].join('\n');
      const config = loader.loadFromYAML(yaml);
      expect(config.tools).toEqual(['bash', 'read_file', 'list_files']);
    });

    it('parses inline array syntax', () => {
      const yaml = [
        'name: inline-agent',
        'type: worker',
        'tools: [bash, read_file, list_files]',
      ].join('\n');
      const config = loader.loadFromYAML(yaml);
      expect(config.tools).toEqual(['bash', 'read_file', 'list_files']);
    });

    it('parses nested object (permissions)', () => {
      const yaml = [
        'name: perm-agent',
        'type: operator',
        'permissions:',
        '  bash: ask',
        '  read_file: allow',
        '  write_file: deny',
      ].join('\n');
      const config = loader.loadFromYAML(yaml);
      expect(config.permissions).toEqual({
        bash: 'ask',
        read_file: 'allow',
        write_file: 'deny',
      });
    });

    it('ignores comment lines', () => {
      const yaml = [
        '# This is a comment',
        'name: commented-agent',
        '# Another comment',
        'type: worker',
      ].join('\n');
      const config = loader.loadFromYAML(yaml);
      expect(config.name).toBe('commented-agent');
      expect(config.type).toBe('worker');
    });

    it('handles numeric values', () => {
      const yaml = [
        'name: numeric-agent',
        'type: worker',
        'max_turns: 50',
        'timeout: 120000',
      ].join('\n');
      const config = loader.loadFromYAML(yaml);
      expect(config.max_turns).toBe(50);
      expect(config.timeout).toBe(120000);
    });

    it('throws when YAML has missing name', () => {
      const yaml = `type: worker`;
      expect(() => loader.loadFromYAML(yaml)).toThrow('"name" field is required');
    });

    it('throws when YAML has invalid type', () => {
      const yaml = [
        'name: bad-type',
        'type: nonexistent',
      ].join('\n');
      expect(() => loader.loadFromYAML(yaml)).toThrow('"type" must be one of');
    });
  });

  describe('loadFromObject', () => {
    it('validates and returns config from a plain object', () => {
      const obj = { name: 'obj-agent', type: 'planner' };
      const config = loader.loadFromObject(obj as Record<string, unknown>);
      expect(config.name).toBe('obj-agent');
      expect(config.type).toBe('planner');
    });

    it('passes through all fields from the object', () => {
      const obj = {
        name: 'full-obj',
        type: 'reviewer',
        model: 'claude-opus-4',
        tools: ['bash'],
        system_prompt: 'Review code.',
        max_turns: 10,
      };
      const config = loader.loadFromObject(obj as Record<string, unknown>);
      expect(config.model).toBe('claude-opus-4');
      expect(config.tools).toEqual(['bash']);
      expect(config.system_prompt).toBe('Review code.');
      expect(config.max_turns).toBe(10);
    });

    it('throws when object fails validation (missing name)', () => {
      const obj = { type: 'worker' };
      expect(() => loader.loadFromObject(obj as Record<string, unknown>)).toThrow('"name" field is required');
    });

    it('throws when object fails validation (invalid type)', () => {
      const obj = { name: 'test', type: 'bogus' };
      expect(() => loader.loadFromObject(obj as Record<string, unknown>)).toThrow('"type" must be one of');
    });
  });

  describe('getPrebuiltConfig', () => {
    it('returns operator config with spawn_worker tool', () => {
      const config = loader.getPrebuiltConfig('operator');
      expect(config.tools).toContain('spawn_worker');
      expect(config.tools).toContain('bash');
      expect(config.max_turns).toBe(50);
    });

    it('returns worker config with basic tools', () => {
      const config = loader.getPrebuiltConfig('worker');
      expect(config.tools).toContain('bash');
      expect(config.tools).toContain('read_file');
      expect(config.tools).toContain('list_files');
      expect(config.tools).not.toContain('spawn_worker');
      expect(config.max_turns).toBe(20);
    });

    it('returns research config with research-specific prompt', () => {
      const config = loader.getPrebuiltConfig('research');
      expect(config.system_prompt).toContain('research agent');
      expect(config.system_prompt).toContain('synthesize');
      expect(config.max_turns).toBe(30);
    });

    it('returns coder config with coding-specific prompt', () => {
      const config = loader.getPrebuiltConfig('coder');
      expect(config.system_prompt).toContain('coding agent');
      expect(config.system_prompt).toContain('Write, test, and fix code');
      expect(config.max_turns).toBe(40);
    });

    it('returns planner config with plan-only prompt and no bash', () => {
      const config = loader.getPrebuiltConfig('planner');
      expect(config.system_prompt).toContain('planning agent');
      expect(config.system_prompt).toContain('Do not execute');
      expect(config.tools).not.toContain('bash');
      expect(config.tools).toContain('read_file');
      expect(config.tools).toContain('list_files');
      expect(config.max_turns).toBe(10);
    });

    it('returns reviewer config with review-specific prompt', () => {
      const config = loader.getPrebuiltConfig('reviewer');
      expect(config.system_prompt).toContain('code reviewer');
      expect(config.system_prompt).toContain('correctness');
      expect(config.system_prompt).toContain('security');
      expect(config.max_turns).toBe(15);
    });

    it('returns empty config for custom type', () => {
      const config = loader.getPrebuiltConfig('custom');
      expect(config.tools).toBeUndefined();
      expect(config.system_prompt).toBeUndefined();
      expect(config.max_turns).toBeUndefined();
    });

    it('returns a new object each call (shallow copy)', () => {
      const config1 = loader.getPrebuiltConfig('operator');
      const config2 = loader.getPrebuiltConfig('operator');
      expect(config1).toEqual(config2);
      // Shallow copy: top-level object identity differs
      expect(config1).not.toBe(config2);
    });

    it('shallow copy shares nested arrays (implementation note)', () => {
      const config1 = loader.getPrebuiltConfig('operator');
      const config2 = loader.getPrebuiltConfig('operator');
      // The tools array is the same reference due to shallow spread
      config1.tools!.push('extra_tool');
      expect(config2.tools).toContain('extra_tool');
      // Clean up the mutation so it does not affect other tests
      config1.tools!.pop();
    });
  });

  describe('resolveConfig', () => {
    it('merges user config with prebuilt defaults', () => {
      const config: ArmaAgentConfig = {
        name: 'my-worker',
        type: 'worker',
      };
      const resolved = loader.resolveConfig(config);
      expect(resolved.name).toBe('my-worker');
      expect(resolved.type).toBe('worker');
      expect(resolved.tools).toEqual(['bash', 'read_file', 'list_files']);
      expect(resolved.max_turns).toBe(20);
    });

    it('user tools override prebuilt tools', () => {
      const config: ArmaAgentConfig = {
        name: 'custom-tools',
        type: 'operator',
        tools: ['only_this'],
      };
      const resolved = loader.resolveConfig(config);
      expect(resolved.tools).toEqual(['only_this']);
      expect(resolved.tools).not.toContain('spawn_worker');
    });

    it('user system_prompt overrides prebuilt system_prompt', () => {
      const config: ArmaAgentConfig = {
        name: 'custom-prompt',
        type: 'research',
        system_prompt: 'My custom prompt.',
      };
      const resolved = loader.resolveConfig(config);
      expect(resolved.system_prompt).toBe('My custom prompt.');
    });

    it('user max_turns overrides prebuilt max_turns', () => {
      const config: ArmaAgentConfig = {
        name: 'fewer-turns',
        type: 'coder',
        max_turns: 5,
      };
      const resolved = loader.resolveConfig(config);
      expect(resolved.max_turns).toBe(5);
    });

    it('falls back to prebuilt system_prompt when user does not provide one', () => {
      const config: ArmaAgentConfig = {
        name: 'no-prompt',
        type: 'reviewer',
      };
      const resolved = loader.resolveConfig(config);
      expect(resolved.system_prompt).toContain('code reviewer');
    });

    it('preserves user-specific fields not in prebuilt', () => {
      const config: ArmaAgentConfig = {
        name: 'with-model',
        type: 'worker',
        model: 'claude-opus-4',
        provider: 'vertex',
        timeout: 5000,
      };
      const resolved = loader.resolveConfig(config);
      expect(resolved.model).toBe('claude-opus-4');
      expect(resolved.provider).toBe('vertex');
      expect(resolved.timeout).toBe(5000);
    });

    it('custom type has no defaults to merge', () => {
      const config: ArmaAgentConfig = {
        name: 'custom-agent',
        type: 'custom',
        tools: ['my_tool'],
        system_prompt: 'Custom behavior.',
      };
      const resolved = loader.resolveConfig(config);
      expect(resolved.tools).toEqual(['my_tool']);
      expect(resolved.system_prompt).toBe('Custom behavior.');
    });
  });

  describe('parseEdge', () => {
    it('parses simple edge "a -> b"', () => {
      const edge = loader.parseEdge('start -> review');
      expect(edge.from).toBe('start');
      expect(edge.to).toBe('review');
      expect(edge.condition).toBeUndefined();
    });

    it('parses edge with condition "a -> b [x == true]"', () => {
      const edge = loader.parseEdge('start -> review [needs_review == true]');
      expect(edge.from).toBe('start');
      expect(edge.to).toBe('review');
      expect(edge.condition).toBe('needs_review == true');
    });

    it('parses edge with complex condition', () => {
      const edge = loader.parseEdge('check -> retry [attempts < 3]');
      expect(edge.from).toBe('check');
      expect(edge.to).toBe('retry');
      expect(edge.condition).toBe('attempts < 3');
    });

    it('handles varying whitespace around arrow', () => {
      const edge = loader.parseEdge('a->b');
      expect(edge.from).toBe('a');
      expect(edge.to).toBe('b');
    });

    it('handles extra whitespace around arrow', () => {
      const edge = loader.parseEdge('nodeA   ->   nodeB');
      expect(edge.from).toBe('nodeA');
      expect(edge.to).toBe('nodeB');
    });

    it('throws on invalid format - missing arrow', () => {
      expect(() => loader.parseEdge('start review')).toThrow('Invalid edge format');
    });

    it('throws on empty string', () => {
      expect(() => loader.parseEdge('')).toThrow('Invalid edge format');
    });

    it('throws on reversed arrow', () => {
      expect(() => loader.parseEdge('start <- review')).toThrow('Invalid edge format');
    });

    it('throws on malformed condition brackets', () => {
      // Unclosed bracket
      expect(() => loader.parseEdge('a -> b [unclosed')).toThrow('Invalid edge format');
    });
  });

  describe('graph edge validation during load', () => {
    it('throws when graph has invalid edge format', () => {
      const json = JSON.stringify({
        name: 'bad-graph',
        type: 'operator',
        graph: {
          entry: 'start',
          nodes: { start: { type: 'llm' } },
          edges: ['start review'],
        },
      });
      expect(() => loader.loadFromJSON(json)).toThrow('Invalid edge format');
    });

    it('throws when any edge in the list is invalid', () => {
      const json = JSON.stringify({
        name: 'partial-bad',
        type: 'operator',
        graph: {
          entry: 'start',
          nodes: {
            start: { type: 'llm' },
            end: { type: 'llm' },
          },
          edges: ['start -> end', 'bad edge here'],
        },
      });
      expect(() => loader.loadFromJSON(json)).toThrow('Invalid edge format');
    });

    it('does not throw when graph edges are all valid', () => {
      const json = JSON.stringify({
        name: 'good-graph',
        type: 'operator',
        graph: {
          entry: 'start',
          nodes: {
            start: { type: 'llm' },
            middle: { type: 'tool', tools: ['bash'] },
            end: { type: 'llm' },
          },
          edges: [
            'start -> middle [ready == true]',
            'middle -> end',
            'start -> end [skip == true]',
          ],
        },
      });
      expect(() => loader.loadFromJSON(json)).not.toThrow();
    });

    it('accepts config with no graph (graph is optional)', () => {
      const json = JSON.stringify({ name: 'no-graph', type: 'worker' });
      expect(() => loader.loadFromJSON(json)).not.toThrow();
    });

    it('accepts graph with empty edges array', () => {
      const json = JSON.stringify({
        name: 'empty-edges',
        type: 'operator',
        graph: {
          entry: 'start',
          nodes: { start: { type: 'llm' } },
          edges: [],
        },
      });
      expect(() => loader.loadFromJSON(json)).not.toThrow();
    });
  });

  describe('all agent types are valid', () => {
    const validTypes: AgentType[] = ['operator', 'worker', 'research', 'coder', 'planner', 'reviewer', 'custom'];

    it.each(validTypes)('"%s" is accepted as a valid agent type', (type) => {
      const config = loader.loadFromObject({ name: `${type}-agent`, type } as Record<string, unknown>);
      expect(config.type).toBe(type);
    });

    it.each(validTypes)('getPrebuiltConfig does not throw for type "%s"', (type) => {
      expect(() => loader.getPrebuiltConfig(type)).not.toThrow();
    });

    it('rejects types not in the valid list', () => {
      const invalidTypes = ['manager', 'assistant', 'bot', '', 'OPERATOR', 'Worker'];
      for (const type of invalidTypes) {
        expect(() => loader.loadFromObject({ name: 'test', type } as Record<string, unknown>)).toThrow(
          '"type" must be one of'
        );
      }
    });
  });
});
