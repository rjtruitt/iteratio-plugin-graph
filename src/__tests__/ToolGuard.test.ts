import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createToolResolver,
  createToolGuard,
  ToolSpec,
  ToolGuardConfig,
  ToolCallAttempt,
} from '../ToolGuard';

describe('ToolResolver', () => {
  const sampleSpec: ToolSpec = {
    name: 'fetchPage',
    description: 'Fetches a confluence page by ID',
    category: 'confluence',
    inputs: {
      pageId: { type: 'string', required: true, description: 'The page ID' },
      includeBody: { type: 'boolean', required: false, default: true },
    },
    outputs: {
      title: { type: 'string', required: true },
      body: { type: 'string', required: false },
    },
  };

  const anotherSpec: ToolSpec = {
    name: 'createIssue',
    description: 'Creates a Jira issue',
    category: 'jira',
    inputs: {
      summary: { type: 'string', required: true },
      priority: { type: 'number', required: false, default: 3 },
      labels: { type: 'string[]', required: false },
    },
    outputs: {
      issueKey: { type: 'string', required: true },
    },
  };

  it('registers a spec and retrieves it', () => {
    const resolver = createToolResolver();
    resolver.register(sampleSpec);
    const retrieved = resolver.getSpec('fetchPage');
    expect(retrieved).toEqual(sampleSpec);
  });

  it('registers multiple specs and lists all', () => {
    const resolver = createToolResolver();
    resolver.register(sampleSpec);
    resolver.register(anotherSpec);
    const specs = resolver.listSpecs();
    expect(specs).toHaveLength(2);
    expect(specs).toContainEqual(sampleSpec);
    expect(specs).toContainEqual(anotherSpec);
  });

  it('binds a spec to implementation and resolve returns it', () => {
    const resolver = createToolResolver();
    resolver.register(sampleSpec);
    resolver.bind('fetchPage', 'confluence.getPageDescendants');
    expect(resolver.resolve('fetchPage')).toBe('confluence.getPageDescendants');
  });

  it('resolve returns null for unbound spec', () => {
    const resolver = createToolResolver();
    resolver.register(sampleSpec);
    expect(resolver.resolve('fetchPage')).toBeNull();
  });

  it('resolve returns null for unknown spec', () => {
    const resolver = createToolResolver();
    expect(resolver.resolve('nonexistent')).toBeNull();
  });

  it('unbind removes binding, resolve returns null after unbind', () => {
    const resolver = createToolResolver();
    resolver.register(sampleSpec);
    resolver.bind('fetchPage', 'confluence.getPageDescendants');
    expect(resolver.resolve('fetchPage')).toBe('confluence.getPageDescendants');
    resolver.unbind('fetchPage');
    expect(resolver.resolve('fetchPage')).toBeNull();
  });

  it('unbind keeps spec intact after removing binding', () => {
    const resolver = createToolResolver();
    resolver.register(sampleSpec);
    resolver.bind('fetchPage', 'confluence.getPageDescendants');
    resolver.unbind('fetchPage');
    expect(resolver.getSpec('fetchPage')).toEqual(sampleSpec);
  });

  it('listBindings returns all current bindings', () => {
    const resolver = createToolResolver();
    resolver.register(sampleSpec);
    resolver.register(anotherSpec);
    resolver.bind('fetchPage', 'confluence.getPageDescendants');
    resolver.bind('createIssue', 'jira.createIssue');
    const bindings = resolver.listBindings();
    expect(bindings).toHaveLength(2);
    expect(bindings).toContainEqual({ spec: 'fetchPage', implementation: 'confluence.getPageDescendants' });
    expect(bindings).toContainEqual({ spec: 'createIssue', implementation: 'jira.createIssue' });
  });

  describe('validateInputs', () => {
    it('all required fields present and correct types → valid', () => {
      const resolver = createToolResolver();
      resolver.register(sampleSpec);
      const result = resolver.validateInputs('fetchPage', { pageId: 'abc123' });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('missing required field → invalid with error message', () => {
      const resolver = createToolResolver();
      resolver.register(sampleSpec);
      const result = resolver.validateInputs('fetchPage', {});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('pageId');
    });

    it('type mismatch → invalid', () => {
      const resolver = createToolResolver();
      resolver.register(sampleSpec);
      const result = resolver.validateInputs('fetchPage', { pageId: 42 });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('pageId');
    });

    it('optional fields can be omitted', () => {
      const resolver = createToolResolver();
      resolver.register(sampleSpec);
      const result = resolver.validateInputs('fetchPage', { pageId: 'abc' });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('optional field with wrong type → invalid', () => {
      const resolver = createToolResolver();
      resolver.register(sampleSpec);
      const result = resolver.validateInputs('fetchPage', { pageId: 'abc', includeBody: 'yes' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('includeBody');
    });

    it('unknown spec → invalid', () => {
      const resolver = createToolResolver();
      const result = resolver.validateInputs('nonexistent', { foo: 'bar' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('nonexistent');
    });

    it('validates number type correctly', () => {
      const resolver = createToolResolver();
      resolver.register(anotherSpec);
      const result = resolver.validateInputs('createIssue', { summary: 'test', priority: 'high' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('priority');
    });

    it('validates string[] type correctly with valid array', () => {
      const resolver = createToolResolver();
      resolver.register(anotherSpec);
      const result = resolver.validateInputs('createIssue', { summary: 'test', labels: ['bug', 'urgent'] });
      expect(result.valid).toBe(true);
    });

    it('validates string[] type correctly with invalid value', () => {
      const resolver = createToolResolver();
      resolver.register(anotherSpec);
      const result = resolver.validateInputs('createIssue', { summary: 'test', labels: 'bug' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('labels');
    });
  });

  it('getSpec for unknown name returns null', () => {
    const resolver = createToolResolver();
    expect(resolver.getSpec('unknown')).toBeNull();
  });
});

describe('ToolGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeAttempt(tool: string, inputs: Record<string, unknown> = {}): ToolCallAttempt {
    return { tool, inputs, timestamp: new Date() };
  }

  describe('Hardstop patterns', () => {
    it('blocks matching tool name (string pattern)', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [
          { pattern: 'dangerous.tool', description: 'Blocked tool', severity: 'block' },
        ],
        permissions: [],
      });
      const result = await guard.check(makeAttempt('dangerous.tool'));
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.severity).toBe('block');
        expect(result.reason).toContain('Blocked tool');
      }
    });

    it('blocks matching tool name (regex pattern)', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [
          { pattern: /^destroy\./, description: 'No destroy tools', severity: 'block' },
        ],
        permissions: [],
      });
      const result = await guard.check(makeAttempt('destroy.everything'));
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.severity).toBe('block');
      }
    });

    it('regex does not match non-matching tool', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [
          { pattern: /^destroy\./, description: 'No destroy tools', severity: 'block' },
        ],
        permissions: [],
      });
      const result = await guard.check(makeAttempt('create.something'));
      expect(result.allowed).toBe(true);
    });

    it('checks inputs — blocks "rm -rf" in any input value', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [
          { pattern: 'rm -rf', description: 'No recursive delete', severity: 'block' },
        ],
        permissions: [],
      });
      const result = await guard.check(makeAttempt('shell.exec', { command: 'rm -rf /' }));
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.severity).toBe('block');
      }
    });

    it('does not block when inputs do not contain pattern', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [
          { pattern: 'rm -rf', description: 'No recursive delete', severity: 'block' },
        ],
        permissions: [],
      });
      const result = await guard.check(makeAttempt('shell.exec', { command: 'ls -la' }));
      expect(result.allowed).toBe(true);
    });

    it('warn severity triggers onWarn callback but still allows', async () => {
      const onWarn = vi.fn();
      const guard = createToolGuard({
        hardstopPatterns: [
          { pattern: 'risky.tool', description: 'Risky operation', severity: 'warn' },
        ],
        permissions: [],
        onWarn,
      });
      const result = await guard.check(makeAttempt('risky.tool'));
      expect(result.allowed).toBe(true);
      expect(onWarn).toHaveBeenCalledWith('risky.tool', expect.stringContaining('Risky operation'));
    });

    it('block severity triggers onBlock callback', async () => {
      const onBlock = vi.fn();
      const guard = createToolGuard({
        hardstopPatterns: [
          { pattern: 'banned.tool', description: 'Banned', severity: 'block' },
        ],
        permissions: [],
        onBlock,
      });
      const result = await guard.check(makeAttempt('banned.tool'));
      expect(result.allowed).toBe(false);
      expect(onBlock).toHaveBeenCalledWith('banned.tool', expect.stringContaining('Banned'));
    });
  });

  describe('Permissions', () => {
    it('deny blocks tool', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: 'secret.tool', action: 'deny', reason: 'Forbidden' }],
      });
      const result = await guard.check(makeAttempt('secret.tool'));
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Forbidden');
      }
    });

    it('allow passes tool', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: 'safe.tool', action: 'allow' }],
      });
      const result = await guard.check(makeAttempt('safe.tool'));
      expect(result.allowed).toBe(true);
    });

    it('prompt calls onPrompt and respects true answer (allow)', async () => {
      const onPrompt = vi.fn().mockResolvedValue(true);
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: 'ask.tool', action: 'prompt', reason: 'Needs approval' }],
        onPrompt,
      });
      const result = await guard.check(makeAttempt('ask.tool'));
      expect(result.allowed).toBe(true);
      expect(onPrompt).toHaveBeenCalledWith('ask.tool', expect.stringContaining('Needs approval'));
    });

    it('prompt calls onPrompt and respects false answer (block)', async () => {
      const onPrompt = vi.fn().mockResolvedValue(false);
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: 'ask.tool', action: 'prompt', reason: 'Needs approval' }],
        onPrompt,
      });
      const result = await guard.check(makeAttempt('ask.tool'));
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('denied');
      }
    });

    it('prompt with no onPrompt callback blocks by default', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: 'ask.tool', action: 'prompt', reason: 'Needs approval' }],
      });
      const result = await guard.check(makeAttempt('ask.tool'));
      expect(result.allowed).toBe(false);
    });

    it('glob matching: "confluence.*" matches "confluence.getPage"', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: 'confluence.*', action: 'allow' }],
      });
      const result = await guard.check(makeAttempt('confluence.getPage'));
      expect(result.allowed).toBe(true);
    });

    it('glob matching: "confluence.*" does not match "jira.getIssue"', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: 'confluence.*', action: 'deny' }],
      });
      // jira.getIssue doesn't match confluence.* so no rule applies → allowed
      const result = await guard.check(makeAttempt('jira.getIssue'));
      expect(result.allowed).toBe(true);
    });

    it('glob matching: "*.delete*" matches "github.deleteFile"', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: '*.delete*', action: 'deny', reason: 'No deletes' }],
      });
      const result = await guard.check(makeAttempt('github.deleteFile'));
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('No deletes');
      }
    });

    it('glob matching: "*.delete*" matches "confluence.deletePage"', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: '*.delete*', action: 'deny' }],
      });
      const result = await guard.check(makeAttempt('confluence.deletePage'));
      expect(result.allowed).toBe(false);
    });

    it('first matching permission rule wins', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [
          { tool: 'confluence.deletePage', action: 'allow', reason: 'Exception for this one' },
          { tool: '*.delete*', action: 'deny', reason: 'No deletes' },
        ],
      });
      const result = await guard.check(makeAttempt('confluence.deletePage'));
      expect(result.allowed).toBe(true);
    });

    it('first matching permission rule wins (deny before allow)', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [
          { tool: 'confluence.*', action: 'deny', reason: 'Confluence locked' },
          { tool: 'confluence.getPage', action: 'allow' },
        ],
      });
      const result = await guard.check(makeAttempt('confluence.getPage'));
      expect(result.allowed).toBe(false);
    });
  });

  describe('Rate limiting', () => {
    it('within limit → allowed', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [],
        maxCallsPerMinute: 5,
      });
      guard.recordCall('tool.a');
      guard.recordCall('tool.a');
      const result = await guard.check(makeAttempt('tool.a'));
      expect(result.allowed).toBe(true);
    });

    it('exceeds limit → blocked with rate_limit', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [],
        maxCallsPerMinute: 3,
      });
      guard.recordCall('tool.a');
      guard.recordCall('tool.b');
      guard.recordCall('tool.c');
      const result = await guard.check(makeAttempt('tool.a'));
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.severity).toBe('rate_limit');
      }
    });

    it('calls outside the 60-second window do not count toward rate limit', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [],
        maxCallsPerMinute: 3,
      });
      guard.recordCall('tool.a');
      guard.recordCall('tool.a');
      guard.recordCall('tool.a');

      // Advance time by 61 seconds so those calls fall outside the window
      vi.advanceTimersByTime(61_000);

      const result = await guard.check(makeAttempt('tool.a'));
      expect(result.allowed).toBe(true);
    });
  });

  describe('Budget', () => {
    it('within budget → allowed', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [],
        maxCallsPerRun: 10,
      });
      guard.recordCall('tool.a');
      guard.recordCall('tool.b');
      const result = await guard.check(makeAttempt('tool.a'));
      expect(result.allowed).toBe(true);
    });

    it('exceeds budget → blocked with budget_exceeded', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [],
        maxCallsPerRun: 2,
      });
      guard.recordCall('tool.a');
      guard.recordCall('tool.b');
      const result = await guard.check(makeAttempt('tool.c'));
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.severity).toBe('budget_exceeded');
      }
    });
  });

  describe('Call tracking', () => {
    it('recordCall increments counts', () => {
      const guard = createToolGuard({ hardstopPatterns: [], permissions: [] });
      guard.recordCall('tool.a');
      guard.recordCall('tool.a');
      guard.recordCall('tool.b');
      expect(guard.getCallCount('tool.a')).toBe(2);
      expect(guard.getCallCount('tool.b')).toBe(1);
    });

    it('getCallCount returns 0 for unrecorded tool', () => {
      const guard = createToolGuard({ hardstopPatterns: [], permissions: [] });
      expect(guard.getCallCount('never.called')).toBe(0);
    });

    it('getTotalCalls returns sum of all calls', () => {
      const guard = createToolGuard({ hardstopPatterns: [], permissions: [] });
      guard.recordCall('tool.a');
      guard.recordCall('tool.b');
      guard.recordCall('tool.c');
      expect(guard.getTotalCalls()).toBe(3);
    });

    it('getCallsInWindow only counts recent calls', () => {
      const guard = createToolGuard({ hardstopPatterns: [], permissions: [] });
      guard.recordCall('tool.a');
      vi.advanceTimersByTime(5000);
      guard.recordCall('tool.b');
      vi.advanceTimersByTime(5000);
      // window of 6000ms should only contain tool.b
      expect(guard.getCallsInWindow(6000)).toBe(1);
    });

    it('getCallsInWindow counts all calls within window', () => {
      const guard = createToolGuard({ hardstopPatterns: [], permissions: [] });
      guard.recordCall('tool.a');
      guard.recordCall('tool.b');
      guard.recordCall('tool.c');
      vi.advanceTimersByTime(1000);
      // window of 5000ms should contain all 3
      expect(guard.getCallsInWindow(5000)).toBe(3);
    });

    it('reset clears all state', () => {
      const guard = createToolGuard({ hardstopPatterns: [], permissions: [] });
      guard.recordCall('tool.a');
      guard.recordCall('tool.b');
      guard.reset();
      expect(guard.getCallCount('tool.a')).toBe(0);
      expect(guard.getTotalCalls()).toBe(0);
      expect(guard.getCallsInWindow(60000)).toBe(0);
    });
  });

  describe('Default behavior', () => {
    it('no permissions or patterns defined → everything allowed', async () => {
      const guard = createToolGuard({ hardstopPatterns: [], permissions: [] });
      const result = await guard.check(makeAttempt('any.tool', { anything: 'goes' }));
      expect(result.allowed).toBe(true);
    });

    it('no matching permission rule → allowed', async () => {
      const guard = createToolGuard({
        hardstopPatterns: [],
        permissions: [{ tool: 'specific.tool', action: 'deny' }],
      });
      const result = await guard.check(makeAttempt('other.tool'));
      expect(result.allowed).toBe(true);
    });
  });
});
