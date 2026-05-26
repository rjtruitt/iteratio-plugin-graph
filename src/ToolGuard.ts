// ToolGuard.ts — Safety layer for tool execution + ToolSpec abstract bindings

// ──────────────────────────────────────────────
// Part 1: ToolSpec (Abstract Tool Bindings)
// ──────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  category?: string;
  inputs: Record<string, ToolSpecField>;
  outputs: Record<string, ToolSpecField>;
  cacheable?: boolean;
  cacheKeyFrom?: string[];
  writes?: boolean;
}

export interface ToolSpecField {
  type: string; // 'string' | 'number' | 'boolean' | 'string[]' | custom type names
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface ToolBinding {
  spec: string; // toolspec name
  implementation: string; // actual MCP tool path like "confluence.getPageDescendants"
}

export interface ToolResolver {
  register(spec: ToolSpec): void;
  bind(specName: string, implementation: string): void;
  resolve(specName: string): string | null;
  getSpec(name: string): ToolSpec | null;
  listSpecs(): ToolSpec[];
  listBindings(): ToolBinding[];
  unbind(specName: string): void;
  validateInputs(specName: string, inputs: Record<string, unknown>): { valid: boolean; errors: string[] };
}

// ──────────────────────────────────────────────
// Part 2: ToolGuard (Safety + Permissions)
// ──────────────────────────────────────────────

export interface HardstopPattern {
  pattern: string | RegExp;
  description: string;
  severity: 'block' | 'warn';
}

export interface PermissionRule {
  tool: string; // tool name or glob pattern (e.g. "confluence.*", "*.delete*")
  action: 'allow' | 'deny' | 'prompt';
  reason?: string;
}

/** Access control guard that intercepts tool calls and applies permission policies. */
export interface ToolGuardConfig {
  hardstopPatterns: HardstopPattern[];
  permissions: PermissionRule[];
  maxCallsPerMinute?: number;
  maxCallsPerRun?: number;
  onBlock?: (tool: string, reason: string) => void;
  onWarn?: (tool: string, reason: string) => void;
  onPrompt?: (tool: string, reason: string) => Promise<boolean>;
}

export interface ToolCallAttempt {
  tool: string;
  inputs: Record<string, unknown>;
  timestamp: Date;
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; reason: string; severity: 'block' | 'warn' | 'rate_limit' | 'budget_exceeded' };

export interface ToolGuard {
  check(attempt: ToolCallAttempt): Promise<GuardDecision>;
  recordCall(tool: string): void;
  getCallCount(tool: string): number;
  getTotalCalls(): number;
  getCallsInWindow(windowMs: number): number;
  reset(): void;
}

// ──────────────────────────────────────────────
// Glob matching helper
// ──────────────────────────────────────────────

function globMatch(pattern: string, value: string): boolean {
  // Convert glob pattern to regex: escape special regex chars, replace * with .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(value);
}

// ──────────────────────────────────────────────
// Type validation helper
// ──────────────────────────────────────────────

function validateType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    default:
      // For custom/unknown types, accept anything
      return true;
  }
}

// ──────────────────────────────────────────────
// createToolResolver
// ──────────────────────────────────────────────

/** Creates a tool resolver that maps tool names to their registered implementations. */
export function createToolResolver(): ToolResolver {
  const specs = new Map<string, ToolSpec>();
  const bindings = new Map<string, string>();

  return {
    register(spec: ToolSpec): void {
      specs.set(spec.name, spec);
    },

    bind(specName: string, implementation: string): void {
      bindings.set(specName, implementation);
    },

    resolve(specName: string): string | null {
      return bindings.get(specName) ?? null;
    },

    getSpec(name: string): ToolSpec | null {
      return specs.get(name) ?? null;
    },

    listSpecs(): ToolSpec[] {
      return Array.from(specs.values());
    },

    listBindings(): ToolBinding[] {
      return Array.from(bindings.entries()).map(([spec, implementation]) => ({
        spec,
        implementation,
      }));
    },

    unbind(specName: string): void {
      bindings.delete(specName);
    },

    validateInputs(specName: string, inputs: Record<string, unknown>): { valid: boolean; errors: string[] } {
      const spec = specs.get(specName);
      if (!spec) {
        return { valid: false, errors: [`Unknown spec: ${specName}`] };
      }

      const errors: string[] = [];

      for (const [fieldName, field] of Object.entries(spec.inputs)) {
        const value = inputs[fieldName];

        // Check required fields
        if (field.required && (value === undefined || value === null)) {
          errors.push(`Missing required field: ${fieldName}`);
          continue;
        }

        // If value is provided, check type
        if (value !== undefined && value !== null) {
          if (!validateType(value, field.type)) {
            errors.push(`Type mismatch for field: ${fieldName} (expected ${field.type}, got ${typeof value})`);
          }
        }
      }

      return { valid: errors.length === 0, errors };
    },
  };
}

// ──────────────────────────────────────────────
// createToolGuard
// ──────────────────────────────────────────────

interface CallRecord {
  tool: string;
  timestamp: number;
}

/** Creates a tool guard with the specified security configuration. */
export function createToolGuard(config: ToolGuardConfig): ToolGuard {
  let callRecords: CallRecord[] = [];
  let callCounts = new Map<string, number>();

  function matchesPattern(pattern: string | RegExp, text: string): boolean {
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }
    return text.includes(pattern);
  }

  return {
    async check(attempt: ToolCallAttempt): Promise<GuardDecision> {
      const serializedInputs = JSON.stringify(attempt.inputs);

      // 1. Check hardstop patterns
      for (const hardstop of config.hardstopPatterns) {
        const toolMatches = matchesPattern(hardstop.pattern, attempt.tool);
        const inputsMatch = matchesPattern(hardstop.pattern, serializedInputs);

        if (toolMatches || inputsMatch) {
          if (hardstop.severity === 'warn') {
            config.onWarn?.(attempt.tool, hardstop.description);
            // warn allows the call to proceed
            continue;
          }
          // block
          const reason = `Hardstop: ${hardstop.description}`;
          config.onBlock?.(attempt.tool, reason);
          return { allowed: false, reason, severity: 'block' };
        }
      }

      // 2. Check permissions (first matching rule wins)
      for (const rule of config.permissions) {
        if (globMatch(rule.tool, attempt.tool)) {
          switch (rule.action) {
            case 'allow':
              // Passed permission check, continue to rate/budget checks
              break;
            case 'deny': {
              const reason = rule.reason ?? `Permission denied for ${attempt.tool}`;
              config.onBlock?.(attempt.tool, reason);
              return { allowed: false, reason, severity: 'block' };
            }
            case 'prompt': {
              if (!config.onPrompt) {
                return { allowed: false, reason: `Prompt denied (no handler): ${rule.reason ?? attempt.tool}`, severity: 'block' };
              }
              const approved = await config.onPrompt(attempt.tool, rule.reason ?? `Approval needed for ${attempt.tool}`);
              if (!approved) {
                return { allowed: false, reason: `User denied: ${rule.reason ?? attempt.tool}`, severity: 'block' };
              }
              break;
            }
          }
          // First matching rule wins — stop checking further rules
          break;
        }
      }

      // 3. Check rate limit
      if (config.maxCallsPerMinute !== undefined) {
        const now = Date.now();
        const windowStart = now - 60_000;
        const callsInWindow = callRecords.filter((r) => r.timestamp > windowStart).length;
        if (callsInWindow >= config.maxCallsPerMinute) {
          return { allowed: false, reason: `Rate limit exceeded: ${callsInWindow}/${config.maxCallsPerMinute} calls per minute`, severity: 'rate_limit' };
        }
      }

      // 4. Check budget
      if (config.maxCallsPerRun !== undefined) {
        const totalCalls = callRecords.length;
        if (totalCalls >= config.maxCallsPerRun) {
          return { allowed: false, reason: `Budget exceeded: ${totalCalls}/${config.maxCallsPerRun} total calls`, severity: 'budget_exceeded' };
        }
      }

      // 5. Allowed
      return { allowed: true };
    },

    recordCall(tool: string): void {
      callRecords.push({ tool, timestamp: Date.now() });
      callCounts.set(tool, (callCounts.get(tool) ?? 0) + 1);
    },

    getCallCount(tool: string): number {
      return callCounts.get(tool) ?? 0;
    },

    getTotalCalls(): number {
      return callRecords.length;
    },

    getCallsInWindow(windowMs: number): number {
      const now = Date.now();
      const windowStart = now - windowMs;
      return callRecords.filter((r) => r.timestamp > windowStart).length;
    },

    reset(): void {
      callRecords = [];
      callCounts = new Map();
    },
  };
}
