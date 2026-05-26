// ToolWrapper.ts — Tool interception/wrapper system for armament workflows

// ──────────────────────────────────────────────
// Interfaces
// ──────────────────────────────────────────────

export interface ToolCallContext {
  tool: string;
  inputs: Record<string, unknown>;
  timestamp: Date;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallResult {
  output: unknown;
  fromWrapper: boolean;
  wrapperName?: string;
  duration?: number;
  cached?: boolean;
}

export type WrapperAction =
  | { type: 'replace'; output: unknown }
  | { type: 'passthrough' }
  | { type: 'transform_input'; inputs: Record<string, unknown> }
  | { type: 'transform_output'; transform: (output: unknown) => unknown }
  | { type: 'error'; message: string };

export interface ToolWrapperDef {
  name: string;
  description?: string;
  tools: string[];
  priority?: number;
  condition?: (ctx: ToolCallContext) => boolean;
  handler: (ctx: ToolCallContext, callReal: (inputs?: Record<string, unknown>) => Promise<unknown>) => Promise<WrapperAction | unknown>;
}

/** Registry of middleware wrappers that augment tool behavior with logging, retry, or validation. */
export interface ToolWrapperRegistry {
  register(wrapper: ToolWrapperDef): void;
  unregister(name: string): void;
  has(toolName: string): boolean;
  getWrappersForTool(toolName: string): ToolWrapperDef[];
  list(): ToolWrapperDef[];
  execute(
    ctx: ToolCallContext,
    realTool: (inputs: Record<string, unknown>) => Promise<unknown>,
  ): Promise<ToolCallResult>;
  getStats(): WrapperStats;
  reset(): void;
}

export interface WrapperStats {
  totalIntercepted: number;
  totalPassthrough: number;
  totalReplaced: number;
  totalErrors: number;
  byWrapper: Record<string, { intercepted: number; replaced: number; passthrough: number }>;
  byTool: Record<string, { intercepted: number; replaced: number; passthrough: number }>;
}

// ──────────────────────────────────────────────
// Glob matching helper (same as ToolGuard)
// ──────────────────────────────────────────────

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(value);
}

// ──────────────────────────────────────────────
// WrapperAction type guard
// ──────────────────────────────────────────────

function isWrapperAction(value: unknown): value is WrapperAction {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (!('type' in obj)) return false;
  const validTypes = ['replace', 'passthrough', 'transform_input', 'transform_output', 'error'];
  return validTypes.includes(obj.type as string);
}

// ──────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────

/** Creates a tool wrapper registry for managing tool middleware. */
export function createToolWrapperRegistry(): ToolWrapperRegistry {
  const wrappers = new Map<string, ToolWrapperDef>();

  let stats: WrapperStats = {
    totalIntercepted: 0,
    totalPassthrough: 0,
    totalReplaced: 0,
    totalErrors: 0,
    byWrapper: {},
    byTool: {},
  };

  function matchesTool(wrapper: ToolWrapperDef, toolName: string): boolean {
    return wrapper.tools.some((pattern) => globMatch(pattern, toolName));
  }

  function ensureWrapperStats(name: string): void {
    if (!stats.byWrapper[name]) {
      stats.byWrapper[name] = { intercepted: 0, replaced: 0, passthrough: 0 };
    }
  }

  function ensureToolStats(tool: string): void {
    if (!stats.byTool[tool]) {
      stats.byTool[tool] = { intercepted: 0, replaced: 0, passthrough: 0 };
    }
  }

  return {
    register(wrapper: ToolWrapperDef): void {
      wrappers.set(wrapper.name, wrapper);
    },

    unregister(name: string): void {
      wrappers.delete(name);
    },

    has(toolName: string): boolean {
      for (const wrapper of wrappers.values()) {
        if (matchesTool(wrapper, toolName)) return true;
      }
      return false;
    },

    getWrappersForTool(toolName: string): ToolWrapperDef[] {
      const matching: ToolWrapperDef[] = [];
      for (const wrapper of wrappers.values()) {
        if (matchesTool(wrapper, toolName)) {
          matching.push(wrapper);
        }
      }
      matching.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
      return matching;
    },

    list(): ToolWrapperDef[] {
      return Array.from(wrappers.values());
    },

    async execute(
      ctx: ToolCallContext,
      realTool: (inputs: Record<string, unknown>) => Promise<unknown>,
    ): Promise<ToolCallResult> {
      const startTime = Date.now();

      // Find matching wrappers
      const matching = this.getWrappersForTool(ctx.tool);

      // Filter by condition
      const activeWrappers = matching.filter((w) => {
        if (w.condition) return w.condition(ctx);
        return true;
      });

      // No active wrappers → call real tool directly
      if (activeWrappers.length === 0) {
        const output = await realTool(ctx.inputs);
        return {
          output,
          fromWrapper: false,
          duration: Date.now() - startTime,
        };
      }

      // Track current inputs (may be modified by transform_input)
      let currentInputs = { ...ctx.inputs };
      // Collect transform_output functions to apply after real tool call
      const outputTransforms: Array<(output: unknown) => unknown> = [];

      for (const wrapper of activeWrappers) {
        // Build context with potentially-modified inputs
        const wrapperCtx: ToolCallContext = { ...ctx, inputs: currentInputs };

        // Build callReal for this wrapper — calls the actual realTool with current or specified inputs
        const callReal = async (inputs?: Record<string, unknown>): Promise<unknown> => {
          return realTool(inputs ?? currentInputs);
        };

        let actionOrValue: unknown;
        try {
          actionOrValue = await wrapper.handler(wrapperCtx, callReal);
        } catch (err) {
          // Wrapper threw — record stats and propagate
          stats.totalIntercepted++;
          stats.totalErrors++;
          ensureWrapperStats(wrapper.name);
          stats.byWrapper[wrapper.name].intercepted++;
          ensureToolStats(ctx.tool);
          stats.byTool[ctx.tool].intercepted++;
          throw err;
        }

        // Determine action
        const action: WrapperAction = isWrapperAction(actionOrValue)
          ? actionOrValue
          : { type: 'replace', output: actionOrValue };

        // Record intercept
        stats.totalIntercepted++;
        ensureWrapperStats(wrapper.name);
        stats.byWrapper[wrapper.name].intercepted++;
        ensureToolStats(ctx.tool);
        stats.byTool[ctx.tool].intercepted++;

        switch (action.type) {
          case 'replace': {
            stats.totalReplaced++;
            stats.byWrapper[wrapper.name].replaced++;
            stats.byTool[ctx.tool].replaced++;
            // Apply any collected output transforms in reverse order (outermost first)
            let finalOutput: unknown = action.output;
            for (let i = outputTransforms.length - 1; i >= 0; i--) {
              finalOutput = outputTransforms[i](finalOutput);
            }
            return {
              output: finalOutput,
              fromWrapper: true,
              wrapperName: wrapper.name,
              duration: Date.now() - startTime,
            };
          }

          case 'passthrough': {
            // Continue to next wrapper
            stats.byWrapper[wrapper.name].passthrough++;
            continue;
          }

          case 'transform_input': {
            currentInputs = action.inputs;
            continue;
          }

          case 'transform_output': {
            outputTransforms.push(action.transform);
            continue;
          }

          case 'error': {
            stats.totalErrors++;
            throw new Error(action.message);
          }
        }
      }

      // All wrappers passed through (or only did input/output transforms) → call real tool
      const output = await realTool(currentInputs);

      // Apply output transforms (first registered = outermost)
      let finalOutput = output;
      for (let i = outputTransforms.length - 1; i >= 0; i--) {
        finalOutput = outputTransforms[i](finalOutput);
      }

      const hasOutputTransforms = outputTransforms.length > 0;

      // Track passthrough stats
      if (!hasOutputTransforms) {
        stats.totalPassthrough++;
        ensureToolStats(ctx.tool);
        stats.byTool[ctx.tool].passthrough++;
      } else {
        // Output was transformed — this counts as a wrapper-influenced result
        stats.totalReplaced++;
        ensureToolStats(ctx.tool);
        stats.byTool[ctx.tool].replaced++;
      }

      return {
        output: finalOutput,
        fromWrapper: hasOutputTransforms,
        wrapperName: hasOutputTransforms ? activeWrappers[0]?.name : undefined,
        duration: Date.now() - startTime,
      };
    },

    getStats(): WrapperStats {
      return { ...stats, byWrapper: { ...stats.byWrapper }, byTool: { ...stats.byTool } };
    },

    reset(): void {
      stats = {
        totalIntercepted: 0,
        totalPassthrough: 0,
        totalReplaced: 0,
        totalErrors: 0,
        byWrapper: {},
        byTool: {},
      };
    },
  };
}
