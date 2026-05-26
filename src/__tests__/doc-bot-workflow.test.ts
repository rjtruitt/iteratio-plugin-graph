import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGraphBuilder, createGraphExecutor } from '../GraphExecution.js';
import type { ExecutionResult } from '../GraphExecution.js';
import { ArmaAgentLoader } from '../ArmaAgentLoader.js';
import type { ArmaAgentConfig } from '../ArmaAgentLoader.js';

// --- Mock MCP interfaces (what the real MCP plugin would provide) ---

interface McpTool {
  name: string;
  call(params: Record<string, unknown>): Promise<unknown>;
}

interface McpToolkit {
  confluence: {
    getPageDescendants: McpTool['call'];
    getPageComments: McpTool['call'];
    getPage: McpTool['call'];
    createPage: McpTool['call'];
    updatePage: McpTool['call'];
    searchCql: McpTool['call'];
  };
  github: {
    getFileContents: McpTool['call'];
    searchCode: McpTool['call'];
  };
  glean: {
    search: McpTool['call'];
  };
}

// --- Mock A2A interfaces (what the real A2A plugin would provide) ---

interface SpawnResult {
  agentId: string;
  status: 'completed' | 'failed';
  output: unknown;
}

interface OrchestratorBridge {
  spawn(config: { name: string; graph: string; input: unknown; lifecycle: string }): Promise<SpawnResult>;
  spawnParallel(configs: Array<{ name: string; graph: string; input: unknown }>): Promise<SpawnResult[]>;
  collectResults(agentIds: string[]): Promise<SpawnResult[]>;
}

// --- Subgraph Registry (graph-of-graphs) ---

interface SubgraphRegistry {
  register(name: string, buildFn: () => ReturnType<typeof createGraphBuilder>['build']): void;
  execute(name: string, state: any): Promise<ExecutionResult>;
}

function createSubgraphRegistry(): SubgraphRegistry {
  const registry = new Map<string, () => any>();
  const executor = createGraphExecutor();

  return {
    register(name, buildFn) {
      registry.set(name, buildFn);
    },
    async execute(name, state) {
      const buildFn = registry.get(name);
      if (!buildFn) throw new Error(`Subgraph '${name}' not found`);
      const graph = buildFn();
      return executor.execute(graph, state);
    },
  };
}

// --- Test Data ---

const MOCK_CONFLUENCE_PAGES = [
  { id: 'page-001', title: 'Email Services', lastUpdated: '2026-05-10' },
  { id: 'page-002', title: 'Case Routing', lastUpdated: '2026-05-12' },
  { id: 'page-003', title: 'Partner Outreach', lastUpdated: '2026-05-08' },
];

const MOCK_COMMENTS = [
  { pageId: 'page-001', author: 'sarah.chen', body: 'Code has changed — thread detection was refactored', created: '2026-05-15' },
  { pageId: 'page-003', author: 'mike.jones', body: 'Please refresh, new segment added', created: '2026-05-14' },
];

const MOCK_CODE_CONTENT = `
public class ProcessEmailServices implements Messaging.InboundEmailHandler {
    public Messaging.InboundEmailResult handleInboundEmail(Messaging.InboundEmail email, Messaging.InboundEnvelope envelope) {
        // Thread detection refactored to use Lightning Threading Token
        String threadId = detectThread(email.fromAddress, email.subject, email.headers);
        if (threadId != null) {
            attachToExistingCase(threadId, email);
        } else {
            createNewCase(email, envelope);
        }
        return new Messaging.InboundEmailResult();
    }
}
`;

const MOCK_DECLARATIVE_CONTENT = `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Email_to_Case_Routing</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
</Flow>
`;

// =============================================================================
// Phase 1: Discovery Graph
// =============================================================================

describe('Doc Bot — Phase 1: Discovery Graph', () => {
  let mcp: McpToolkit;

  beforeEach(() => {
    mcp = {
      confluence: {
        getPageDescendants: vi.fn().mockResolvedValue(MOCK_CONFLUENCE_PAGES),
        getPageComments: vi.fn().mockResolvedValue(MOCK_COMMENTS),
        getPage: vi.fn().mockResolvedValue({ id: 'parent-001', title: 'Lodging Documentation' }),
        createPage: vi.fn().mockResolvedValue({ id: 'new-page-001' }),
        updatePage: vi.fn().mockResolvedValue({ id: 'page-001' }),
        searchCql: vi.fn().mockResolvedValue([]),
      },
      github: {
        getFileContents: vi.fn().mockResolvedValue(MOCK_CODE_CONTENT),
        searchCode: vi.fn().mockResolvedValue([{ path: 'force-app/main/default/classes/ProcessEmailServices.cls' }]),
      },
      glean: {
        search: vi.fn().mockResolvedValue([{ title: 'Email Services PRD', url: 'https://confluence.example.com/prd' }]),
      },
    };
  });

  it('should scan confluence parent page and collect descendants', async () => {
    const graph = createGraphBuilder()
      .addNode('scan-confluence', async (state) => {
        const pages = await mcp.confluence.getPageDescendants({ parentId: state.parentPageId });
        return { ...state, pages };
      })
      .addNode('filter-stale', async (state) => {
        const stalePages = (state.pages as any[]).filter(
          (p) => new Date(p.lastUpdated) < new Date(state.cutoffDate)
        );
        return { ...state, stalePages };
      })
      .addNode('collect-comments', async (state) => {
        const comments = await mcp.confluence.getPageComments({ pageIds: (state.stalePages as any[]).map((p: any) => p.id) });
        return { ...state, comments };
      })
      .addNode('build-work-queue', async (state) => {
        const workQueue = (state.comments as any[]).map((c: any) => ({
          pageId: c.pageId,
          reason: c.body,
          requestedBy: c.author,
        }));
        return { ...state, workQueue };
      })
      .addEdge('scan-confluence', 'filter-stale')
      .addEdge('filter-stale', 'collect-comments')
      .addEdge('collect-comments', 'build-work-queue')
      .setEntryPoint('scan-confluence')
      .setExitPoint('build-work-queue')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(graph, {
      parentPageId: 'parent-001',
      cutoffDate: '2026-05-11',
    });

    expect(result.error).toBeUndefined();
    expect(result.path).toEqual(['scan-confluence', 'filter-stale', 'collect-comments', 'build-work-queue']);
    expect(result.finalState.workQueue).toHaveLength(2);
    expect(result.finalState.workQueue[0].pageId).toBe('page-001');
    expect(result.finalState.workQueue[1].pageId).toBe('page-003');
    expect(mcp.confluence.getPageDescendants).toHaveBeenCalledWith({ parentId: 'parent-001' });
  });

  it('should produce empty work queue when no pages have comments since last update', async () => {
    mcp.confluence.getPageComments = vi.fn().mockResolvedValue([]);

    const graph = createGraphBuilder()
      .addNode('scan-confluence', async (state) => {
        const pages = await mcp.confluence.getPageDescendants({ parentId: state.parentPageId });
        return { ...state, pages };
      })
      .addNode('filter-stale', async (state) => ({ ...state, stalePages: [] }))
      .addNode('collect-comments', async (state) => ({ ...state, comments: [] }))
      .addNode('build-work-queue', async (state) => ({ ...state, workQueue: [] }))
      .addEdge('scan-confluence', 'filter-stale')
      .addEdge('filter-stale', 'collect-comments')
      .addEdge('collect-comments', 'build-work-queue')
      .setEntryPoint('scan-confluence')
      .setExitPoint('build-work-queue')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(graph, { parentPageId: 'parent-001', cutoffDate: '2026-05-20' });

    expect(result.finalState.workQueue).toEqual([]);
    expect(result.iterations).toBe(4);
  });
});

// =============================================================================
// Phase 2: Per-Page Processing (Subgraphs)
// =============================================================================

describe('Doc Bot — Phase 2: Per-Page Processing with Subgraphs', () => {
  let mcp: McpToolkit;
  let subgraphs: SubgraphRegistry;

  beforeEach(() => {
    mcp = {
      confluence: {
        getPageDescendants: vi.fn().mockResolvedValue([]),
        getPageComments: vi.fn().mockResolvedValue([]),
        getPage: vi.fn().mockResolvedValue({ id: 'page-001', title: 'Email Services', body: '<h1>Email Services</h1>' }),
        createPage: vi.fn().mockResolvedValue({ id: 'new-001' }),
        updatePage: vi.fn().mockResolvedValue({ id: 'page-001' }),
        searchCql: vi.fn().mockResolvedValue([{ title: 'Email thread detection upgrade', url: '/wiki/thread-detection' }]),
      },
      github: {
        getFileContents: vi.fn().mockResolvedValue(MOCK_CODE_CONTENT),
        searchCode: vi.fn().mockResolvedValue([{ path: 'classes/ProcessEmailServices.cls' }]),
      },
      glean: {
        search: vi.fn().mockResolvedValue([{ title: 'Thread Detection PRD' }]),
      },
    };

    subgraphs = createSubgraphRegistry();

    // Register code-review subgraph
    subgraphs.register('code-review', () =>
      createGraphBuilder()
        .addNode('pull-code', async (state) => {
          const code = await mcp.github.getFileContents({ path: state.codePath });
          return { ...state, code };
        })
        .addNode('analyze-code', async (state) => {
          // LLM would analyze here; mock the output
          return { ...state, codeAnalysis: { changes: ['thread detection refactored'], confidence: 0.92 } };
        })
        .addNode('extract-deltas', async (state) => {
          return { ...state, codeDeltas: ['handleInboundEmail now uses Lightning Threading Token'] };
        })
        .addEdge('pull-code', 'analyze-code')
        .addEdge('analyze-code', 'extract-deltas')
        .setEntryPoint('pull-code')
        .setExitPoint('extract-deltas')
        .build()
    );

    // Register declarative-review subgraph
    subgraphs.register('declarative-review', () =>
      createGraphBuilder()
        .addNode('pull-metadata', async (state) => {
          const metadata = await mcp.github.getFileContents({ path: state.metadataPath });
          return { ...state, metadata };
        })
        .addNode('parse-flows', async (state) => {
          return { ...state, flowAnalysis: { active: true, type: 'AutoLaunchedFlow' } };
        })
        .addNode('compare-to-doc', async (state) => {
          return { ...state, declarativeDeltas: ['Flow is still active, no structural changes'] };
        })
        .addEdge('pull-metadata', 'parse-flows')
        .addEdge('parse-flows', 'compare-to-doc')
        .setEntryPoint('pull-metadata')
        .setExitPoint('compare-to-doc')
        .build()
    );
  });

  it('should execute code-review subgraph and return deltas', async () => {
    const result = await subgraphs.execute('code-review', {
      codePath: 'classes/ProcessEmailServices.cls',
    });

    expect(result.error).toBeUndefined();
    expect(result.path).toEqual(['pull-code', 'analyze-code', 'extract-deltas']);
    expect(result.finalState.codeDeltas).toContain('handleInboundEmail now uses Lightning Threading Token');
    expect(mcp.github.getFileContents).toHaveBeenCalledWith({ path: 'classes/ProcessEmailServices.cls' });
  });

  it('should execute declarative-review subgraph and return deltas', async () => {
    const result = await subgraphs.execute('declarative-review', {
      metadataPath: 'flows/Email_to_Case_Routing.flow-meta.xml',
    });

    expect(result.error).toBeUndefined();
    expect(result.finalState.declarativeDeltas).toHaveLength(1);
  });

  it('should route to appropriate subgraph based on comment content', async () => {
    const codeReviewSpy = vi.fn().mockResolvedValue({
      finalState: { codeDeltas: ['refactored thread detection'] },
      path: ['pull-code', 'analyze-code', 'extract-deltas'],
      iterations: 3,
    });
    const declarativeReviewSpy = vi.fn().mockResolvedValue({
      finalState: { declarativeDeltas: ['no changes'] },
      path: ['pull-metadata', 'parse-flows', 'compare-to-doc'],
      iterations: 3,
    });

    const perPageGraph = createGraphBuilder()
      .addNode('review-page', async (state) => {
        const page = await mcp.confluence.getPage({ pageId: state.pageId });
        return { ...state, pageContent: page, updateType: 'code-change' };
      })
      .addNode('route-by-comment', async (state) => {
        // Determine what kind of review is needed
        if (state.updateType === 'code-change') {
          return { ...state, route: 'code-review' };
        } else if (state.updateType === 'config-change') {
          return { ...state, route: 'declarative-review' };
        }
        return { ...state, route: 'full-refresh' };
      })
      .addNode('code-review', async (state) => {
        const result = await codeReviewSpy(state);
        return { ...state, ...result.finalState };
      })
      .addNode('declarative-review', async (state) => {
        const result = await declarativeReviewSpy(state);
        return { ...state, ...result.finalState };
      })
      .addNode('search-supporting', async (state) => {
        const gleanResults = await mcp.glean.search({ query: state.pageContent.title });
        const confluenceResults = await mcp.confluence.searchCql({ cql: `title ~ "${state.pageContent.title}"` });
        return { ...state, supportingDocs: [...gleanResults, ...confluenceResults] };
      })
      .addNode('compile-findings', async (state) => {
        return {
          ...state,
          compiledFindings: {
            codeDeltas: state.codeDeltas || [],
            declarativeDeltas: state.declarativeDeltas || [],
            supportingDocs: state.supportingDocs || [],
            sourceOfTruth: 'code',
          },
        };
      })
      .addEdge('review-page', 'route-by-comment')
      .addConditionalEdge('route-by-comment', (state) => state.route)
      .addEdge('code-review', 'search-supporting')
      .addEdge('declarative-review', 'search-supporting')
      .addEdge('search-supporting', 'compile-findings')
      .setEntryPoint('review-page')
      .setExitPoint('compile-findings')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(perPageGraph, {
      pageId: 'page-001',
      comment: 'Code has changed — thread detection was refactored',
    });

    expect(result.error).toBeUndefined();
    expect(result.finalState.compiledFindings.codeDeltas).toContain('refactored thread detection');
    expect(result.finalState.compiledFindings.sourceOfTruth).toBe('code');
    expect(codeReviewSpy).toHaveBeenCalled();
    expect(declarativeReviewSpy).not.toHaveBeenCalled();
  });

  it('should execute both subgraphs in parallel when comment indicates both changed', async () => {
    const graph = createGraphBuilder()
      .addNode('review-page', async (state) => ({ ...state, updateType: 'both' }))
      .addNode('code-review', async (state) => {
        const result = await subgraphs.execute('code-review', { codePath: 'classes/ProcessEmailServices.cls' });
        return { ...state, codeDeltas: result.finalState.codeDeltas };
      })
      .addNode('declarative-review', async (state) => {
        const result = await subgraphs.execute('declarative-review', { metadataPath: 'flows/Email_to_Case_Routing.flow-meta.xml' });
        return { ...state, declarativeDeltas: result.finalState.declarativeDeltas };
      })
      .addNode('merge-results', async (state) => {
        return {
          ...state,
          compiledFindings: {
            codeDeltas: state.codeDeltas,
            declarativeDeltas: state.declarativeDeltas,
          },
        };
      })
      .addEdge('review-page', 'code-review')
      .addEdge('review-page', 'declarative-review')
      .addEdge('code-review', 'merge-results')
      .addEdge('declarative-review', 'merge-results')
      .setEntryPoint('review-page')
      .setExitPoint('merge-results')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(graph, { pageId: 'page-001' });

    expect(result.error).toBeUndefined();
    expect(result.finalState.compiledFindings.codeDeltas).toBeDefined();
    expect(result.finalState.compiledFindings.declarativeDeltas).toBeDefined();
    // Both branches should have been visited
    expect(result.path).toContain('code-review');
    expect(result.path).toContain('declarative-review');
  });
});

// =============================================================================
// Phase 3: Hallucination Detection (A2A Spawn + Loop)
// =============================================================================

describe('Doc Bot — Phase 3: Hallucination Detection Loop', () => {
  let orchestrator: OrchestratorBridge;

  beforeEach(() => {
    orchestrator = {
      spawn: vi.fn(),
      spawnParallel: vi.fn(),
      collectResults: vi.fn(),
    };
  });

  it('should spawn 5 verification agents and collect results', async () => {
    const verificationResults: SpawnResult[] = Array.from({ length: 5 }, (_, i) => ({
      agentId: `verifier-${i}`,
      status: 'completed' as const,
      output: { confidence: 0.92 + i * 0.01, issues: [] },
    }));

    (orchestrator.spawnParallel as ReturnType<typeof vi.fn>).mockResolvedValue(verificationResults);

    const hallucinationGraph = createGraphBuilder()
      .addNode('spawn-verifiers', async (state) => {
        const configs = Array.from({ length: state.verificationCount }, (_, i) => ({
          name: `verifier-${i}`,
          graph: 'hallucination-check',
          input: { doc: state.compiledDoc, iteration: i },
        }));
        const results = await orchestrator.spawnParallel(configs);
        return { ...state, verificationResults: results };
      })
      .addNode('evaluate-confidence', async (state) => {
        const results = state.verificationResults as SpawnResult[];
        const avgConfidence = results.reduce(
          (sum: number, r: SpawnResult) => sum + (r.output as any).confidence, 0
        ) / results.length;
        const allIssues = results.flatMap((r: SpawnResult) => (r.output as any).issues);
        return { ...state, avgConfidence, allIssues, passedVerification: avgConfidence > 0.9 && allIssues.length === 0 };
      })
      .addNode('fix-issues', async (state) => {
        // LLM fixes the doc based on issues
        return { ...state, compiledDoc: state.compiledDoc + ' [FIXED]', fixIteration: (state.fixIteration || 0) + 1 };
      })
      .addNode('done', async (state) => state)
      .addEdge('spawn-verifiers', 'evaluate-confidence')
      .addConditionalEdge('evaluate-confidence', (state) => {
        if (state.passedVerification) return 'done';
        if ((state.fixIteration || 0) >= 3) return 'done'; // max 3 fix attempts
        return 'fix-issues';
      })
      .addEdge('fix-issues', 'spawn-verifiers') // loop back
      .setEntryPoint('spawn-verifiers')
      .setExitPoint('done')
      .setMaxIterations(20)
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(hallucinationGraph, {
      compiledDoc: '<h1>Email Services</h1><p>Handles inbound email routing...</p>',
      verificationCount: 5,
    });

    expect(result.error).toBeUndefined();
    expect(result.finalState.passedVerification).toBe(true);
    expect(result.finalState.avgConfidence).toBeGreaterThan(0.9);
    expect(orchestrator.spawnParallel).toHaveBeenCalledTimes(1);
  });

  it('should loop and fix when verification finds issues', async () => {
    let callCount = 0;
    (orchestrator.spawnParallel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First run: issues found
        return Array.from({ length: 5 }, (_, i) => ({
          agentId: `verifier-${i}`,
          status: 'completed' as const,
          output: { confidence: 0.75, issues: ['Incorrect thread detection description'] },
        }));
      }
      // Second run: issues fixed
      return Array.from({ length: 5 }, (_, i) => ({
        agentId: `verifier-${i}`,
        status: 'completed' as const,
        output: { confidence: 0.95, issues: [] },
      }));
    });

    const hallucinationGraph = createGraphBuilder()
      .addNode('spawn-verifiers', async (state) => {
        const results = await orchestrator.spawnParallel(
          Array.from({ length: 5 }, (_, i) => ({
            name: `verifier-${i}`,
            graph: 'hallucination-check',
            input: { doc: state.compiledDoc },
          }))
        );
        return { ...state, verificationResults: results };
      })
      .addNode('evaluate-confidence', async (state) => {
        const results = state.verificationResults as SpawnResult[];
        const avgConfidence = results.reduce(
          (sum: number, r: SpawnResult) => sum + (r.output as any).confidence, 0
        ) / results.length;
        const allIssues = results.flatMap((r: SpawnResult) => (r.output as any).issues);
        return { ...state, avgConfidence, allIssues, passedVerification: avgConfidence > 0.9 && allIssues.length === 0 };
      })
      .addNode('fix-issues', async (state) => {
        return { ...state, compiledDoc: state.compiledDoc + ' [FIXED]', fixIteration: (state.fixIteration || 0) + 1 };
      })
      .addNode('done', async (state) => state)
      .addEdge('spawn-verifiers', 'evaluate-confidence')
      .addConditionalEdge('evaluate-confidence', (state) => {
        if (state.passedVerification) return 'done';
        if ((state.fixIteration || 0) >= 3) return 'done';
        return 'fix-issues';
      })
      .addEdge('fix-issues', 'spawn-verifiers')
      .setEntryPoint('spawn-verifiers')
      .setExitPoint('done')
      .setMaxIterations(20)
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(hallucinationGraph, {
      compiledDoc: '<h1>Email Services</h1>',
      verificationCount: 5,
    });

    expect(result.error).toBeUndefined();
    expect(result.finalState.passedVerification).toBe(true);
    expect(result.finalState.fixIteration).toBe(1);
    expect(orchestrator.spawnParallel).toHaveBeenCalledTimes(2);
    // Path should show the loop: spawn → evaluate → fix → spawn → evaluate → done
    expect(result.path).toContain('fix-issues');
  });

  it('should bail after 3 fix attempts and flag for human review', async () => {
    (orchestrator.spawnParallel as ReturnType<typeof vi.fn>).mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        agentId: `verifier-${i}`,
        status: 'completed' as const,
        output: { confidence: 0.6, issues: ['Persistent hallucination in section 3'] },
      }))
    );

    const hallucinationGraph = createGraphBuilder()
      .addNode('spawn-verifiers', async (state) => {
        const results = await orchestrator.spawnParallel([]);
        return { ...state, verificationResults: results };
      })
      .addNode('evaluate-confidence', async (state) => {
        const results = state.verificationResults as SpawnResult[];
        const avgConfidence = results.reduce(
          (sum: number, r: SpawnResult) => sum + (r.output as any).confidence, 0
        ) / results.length;
        const allIssues = results.flatMap((r: SpawnResult) => (r.output as any).issues);
        return { ...state, avgConfidence, allIssues, passedVerification: avgConfidence > 0.9 && allIssues.length === 0 };
      })
      .addNode('fix-issues', async (state) => {
        return { ...state, fixIteration: (state.fixIteration || 0) + 1 };
      })
      .addNode('done', async (state) => ({
        ...state,
        needsHumanReview: !state.passedVerification,
      }))
      .addEdge('spawn-verifiers', 'evaluate-confidence')
      .addConditionalEdge('evaluate-confidence', (state) => {
        if (state.passedVerification) return 'done';
        if ((state.fixIteration || 0) >= 3) return 'done';
        return 'fix-issues';
      })
      .addEdge('fix-issues', 'spawn-verifiers')
      .setEntryPoint('spawn-verifiers')
      .setExitPoint('done')
      .setMaxIterations(30)
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(hallucinationGraph, { fixIteration: 0 });

    expect(result.error).toBeUndefined();
    expect(result.finalState.fixIteration).toBe(3);
    expect(result.finalState.passedVerification).toBe(false);
    expect(result.finalState.needsHumanReview).toBe(true);
    expect(orchestrator.spawnParallel).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});

// =============================================================================
// Phase 4: Formatting (Container vs Leaf decision)
// =============================================================================

describe('Doc Bot — Phase 4: Formatting Graph', () => {
  it('should route to container format for index pages', async () => {
    const graph = createGraphBuilder()
      .addNode('determine-page-type', async (state) => {
        const containerKeywords = ['index', 'list', 'all', 'complete', 'flows', 'overview'];
        const isContainer = containerKeywords.some((kw) => state.pageTitle.toLowerCase().includes(kw));
        return { ...state, pageType: isContainer ? 'container' : 'leaf' };
      })
      .addNode('format-container', async (state) => {
        return {
          ...state,
          formattedPages: [{
            title: state.pageTitle,
            html: `<h1>${state.pageTitle}</h1><h2>Overview</h2><ul>${state.items.map((i: string) => `<li>${i}</li>`).join('')}</ul>`,
          }],
        };
      })
      .addNode('format-leaf', async (state) => {
        return {
          ...state,
          formattedPages: [
            { title: state.pageTitle, html: '<h1>Parent</h1>' },
            { title: `${state.pageTitle} - Business Perspective`, html: '<h2>Business</h2>' },
            { title: `${state.pageTitle} - Technical Perspective`, html: '<h2>Technical</h2>' },
            { title: `${state.pageTitle} - Architecture & Integration`, html: '<h2>Architecture</h2>' },
          ],
        };
      })
      .addNode('generic-language-pass', async (state) => {
        // Replace jargon with generic terms
        const pages = (state.formattedPages as any[]).map((p: any) => ({
          ...p,
          html: p.html.replace(/SOQL/g, 'database query').replace(/Apex/g, 'server-side code'),
        }));
        return { ...state, formattedPages: pages };
      })
      .addEdge('determine-page-type', 'format-container') // will be conditional
      .addConditionalEdge('determine-page-type', (state) => state.pageType === 'container' ? 'format-container' : 'format-leaf')
      .addEdge('format-container', 'generic-language-pass')
      .addEdge('format-leaf', 'generic-language-pass')
      .setEntryPoint('determine-page-type')
      .setExitPoint('generic-language-pass')
      .build();

    const executor = createGraphExecutor();
    const containerResult = await executor.execute(graph, {
      pageTitle: 'Case Flows - Complete Index',
      items: ['Case_Routing_Master', 'CaseClosure', 'Case_Creation_from_Guest'],
    });

    expect(containerResult.error).toBeUndefined();
    expect(containerResult.finalState.pageType).toBe('container');
    expect(containerResult.finalState.formattedPages).toHaveLength(1);
    expect(containerResult.finalState.formattedPages[0].html).toContain('<ul>');
  });

  it('should route to leaf format for specific systems (4-page structure)', async () => {
    const graph = createGraphBuilder()
      .addNode('determine-page-type', async (state) => {
        const containerKeywords = ['index', 'list', 'all', 'complete', 'flows', 'overview'];
        const isContainer = containerKeywords.some((kw) => state.pageTitle.toLowerCase().includes(kw));
        return { ...state, pageType: isContainer ? 'container' : 'leaf' };
      })
      .addNode('format-container', async (state) => ({ ...state, formattedPages: [{ title: state.pageTitle, html: '<ul></ul>' }] }))
      .addNode('format-leaf', async (state) => ({
        ...state,
        formattedPages: [
          { title: state.pageTitle, html: '<h1>Email Services</h1>' },
          { title: `${state.pageTitle} - Business Perspective`, html: '<h2>Business Problem</h2>' },
          { title: `${state.pageTitle} - Technical Perspective`, html: '<h2>Data Model</h2><p>SOQL queries</p>' },
          { title: `${state.pageTitle} - Architecture & Integration`, html: '<h2>Design Patterns</h2><p>Apex handler</p>' },
        ],
      }))
      .addNode('generic-language-pass', async (state) => {
        const pages = (state.formattedPages as any[]).map((p: any) => ({
          ...p,
          html: p.html.replace(/SOQL/g, 'database query').replace(/Apex/g, 'server-side code'),
        }));
        return { ...state, formattedPages: pages };
      })
      .addConditionalEdge('determine-page-type', (state) => state.pageType === 'container' ? 'format-container' : 'format-leaf')
      .addEdge('format-container', 'generic-language-pass')
      .addEdge('format-leaf', 'generic-language-pass')
      .setEntryPoint('determine-page-type')
      .setExitPoint('generic-language-pass')
      .build();

    const executor = createGraphExecutor();
    const leafResult = await executor.execute(graph, { pageTitle: 'Email Services' });

    expect(leafResult.error).toBeUndefined();
    expect(leafResult.finalState.pageType).toBe('leaf');
    expect(leafResult.finalState.formattedPages).toHaveLength(4);
    // Should have replaced jargon
    expect(leafResult.finalState.formattedPages[2].html).toContain('database query');
    expect(leafResult.finalState.formattedPages[3].html).toContain('server-side code');
  });
});

// =============================================================================
// Phase 5: Publishing + Hierarchy Check
// =============================================================================

describe('Doc Bot — Phase 5: Publishing and Hierarchy Verification', () => {
  let mcp: McpToolkit;

  beforeEach(() => {
    mcp = {
      confluence: {
        getPageDescendants: vi.fn().mockResolvedValue([
          { id: 'child-1', title: 'Email Services - Business' },
          { id: 'child-2', title: 'Email Services - Technical' },
          { id: 'child-3', title: 'Email Services - Architecture' },
        ]),
        getPageComments: vi.fn().mockResolvedValue([]),
        getPage: vi.fn().mockResolvedValue({ id: 'page-001', title: 'Email Services' }),
        createPage: vi.fn().mockImplementation(async (params: any) => ({ id: `new-${Date.now()}`, title: params.title })),
        updatePage: vi.fn().mockResolvedValue({ id: 'page-001' }),
        searchCql: vi.fn().mockResolvedValue([]),
      },
      github: {
        getFileContents: vi.fn().mockResolvedValue(''),
        searchCode: vi.fn().mockResolvedValue([]),
      },
      glean: {
        search: vi.fn().mockResolvedValue([]),
      },
    };
  });

  it('should publish parent page and 3 children in sequence', async () => {
    const publishGraph = createGraphBuilder()
      .addNode('publish-parent', async (state) => {
        const parent = await mcp.confluence.createPage({
          parentId: state.targetParentId,
          title: state.formattedPages[0].title,
          body: state.formattedPages[0].html,
        });
        return { ...state, publishedParentId: (parent as any).id };
      })
      .addNode('publish-children', async (state) => {
        const childPages = state.formattedPages.slice(1);
        const publishedChildren = [];
        for (const child of childPages) {
          const result = await mcp.confluence.createPage({
            parentId: state.publishedParentId,
            title: child.title,
            body: child.html,
          });
          publishedChildren.push(result);
        }
        return { ...state, publishedChildren };
      })
      .addNode('verify-publish', async (state) => {
        const page = await mcp.confluence.getPage({ pageId: state.publishedParentId });
        return { ...state, publishVerified: !!(page as any).id };
      })
      .addEdge('publish-parent', 'publish-children')
      .addEdge('publish-children', 'verify-publish')
      .setEntryPoint('publish-parent')
      .setExitPoint('verify-publish')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(publishGraph, {
      targetParentId: 'lodging-root',
      formattedPages: [
        { title: 'Email Services', html: '<h1>Email Services</h1>' },
        { title: 'Email Services - Business', html: '<h2>Business</h2>' },
        { title: 'Email Services - Technical', html: '<h2>Technical</h2>' },
        { title: 'Email Services - Architecture', html: '<h2>Architecture</h2>' },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.finalState.publishVerified).toBe(true);
    expect(mcp.confluence.createPage).toHaveBeenCalledTimes(4);
    // First call should be parent with lodging-root as parent
    expect((mcp.confluence.createPage as ReturnType<typeof vi.fn>).mock.calls[0][0].parentId).toBe('lodging-root');
    // Children should use published parent ID
    expect((mcp.confluence.createPage as ReturnType<typeof vi.fn>).mock.calls[1][0].parentId).toBe(result.finalState.publishedParentId);
  });

  it('should check hierarchy and fix if structure is wrong', async () => {
    let hierarchyCheckCount = 0;

    const hierarchyGraph = createGraphBuilder()
      .addNode('check-hierarchy', async (state) => {
        hierarchyCheckCount++;
        const descendants = await mcp.confluence.getPageDescendants({ parentId: state.publishedParentId });
        const expectedChildren = ['Business', 'Technical', 'Architecture'];
        const actualTitles = (descendants as any[]).map((d: any) => d.title);
        const isCorrect = expectedChildren.every((expected) =>
          actualTitles.some((actual: string) => actual.includes(expected))
        );
        return { ...state, hierarchyCorrect: isCorrect, hierarchyCheckCount: hierarchyCheckCount };
      })
      .addNode('fix-hierarchy', async (state) => {
        // Move/rename pages to fix structure
        await mcp.confluence.updatePage({ pageId: 'misplaced-page', parentId: state.publishedParentId });
        return { ...state, hierarchyFixed: true };
      })
      .addNode('done', async (state) => state)
      .addEdge('check-hierarchy', 'fix-hierarchy')
      .addConditionalEdge('check-hierarchy', (state) => {
        if (state.hierarchyCorrect) return 'done';
        if (state.hierarchyCheckCount >= 3) return 'done'; // bail after 3 checks
        return 'fix-hierarchy';
      })
      .addEdge('fix-hierarchy', 'check-hierarchy')
      .setEntryPoint('check-hierarchy')
      .setExitPoint('done')
      .setMaxIterations(10)
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(hierarchyGraph, { publishedParentId: 'page-001' });

    expect(result.error).toBeUndefined();
    expect(result.finalState.hierarchyCorrect).toBe(true);
    expect(hierarchyCheckCount).toBe(1); // Should pass on first check
  });
});

// =============================================================================
// End-to-End: Full Pipeline
// =============================================================================

describe('Doc Bot — End-to-End Pipeline', () => {
  it('should execute full discovery → process → verify → format → publish pipeline', async () => {
    const phaseResults: string[] = [];

    const fullPipeline = createGraphBuilder()
      .addNode('discovery', async (state) => {
        phaseResults.push('discovery');
        return { ...state, workQueue: [{ pageId: 'page-001', reason: 'code changed' }] };
      })
      .addNode('check-queue', async (state) => {
        return { ...state, hasWork: (state.workQueue as any[]).length > 0 };
      })
      .addNode('process-page', async (state) => {
        phaseResults.push('process-page');
        const item = (state.workQueue as any[]).shift();
        return { ...state, currentPage: item, compiledDoc: '<h1>Updated Email Services</h1>' };
      })
      .addNode('verify', async (state) => {
        phaseResults.push('verify');
        return { ...state, passedVerification: true, avgConfidence: 0.95 };
      })
      .addNode('format', async (state) => {
        phaseResults.push('format');
        return {
          ...state,
          formattedPages: [
            { title: 'Email Services', html: state.compiledDoc },
            { title: 'Email Services - Business', html: '<h2>Business</h2>' },
            { title: 'Email Services - Technical', html: '<h2>Technical</h2>' },
            { title: 'Email Services - Architecture', html: '<h2>Architecture</h2>' },
          ],
        };
      })
      .addNode('publish', async (state) => {
        phaseResults.push('publish');
        return { ...state, published: true, publishedPageId: 'page-001' };
      })
      .addNode('hierarchy-check', async (state) => {
        phaseResults.push('hierarchy-check');
        return { ...state, hierarchyCorrect: true };
      })
      .addNode('complete', async (state) => {
        phaseResults.push('complete');
        return { ...state, status: 'success' };
      })
      .addEdge('discovery', 'check-queue')
      .addConditionalEdge('check-queue', (state) => state.hasWork ? 'process-page' : 'complete')
      .addEdge('process-page', 'verify')
      .addConditionalEdge('verify', (state) => state.passedVerification ? 'format' : 'process-page')
      .addEdge('format', 'publish')
      .addEdge('publish', 'hierarchy-check')
      .addConditionalEdge('hierarchy-check', (state) => state.hierarchyCorrect ? 'complete' : 'hierarchy-check')
      .setEntryPoint('discovery')
      .setExitPoint('complete')
      .setMaxIterations(50)
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(fullPipeline, { workQueue: [] });

    expect(result.error).toBeUndefined();
    expect(result.finalState.status).toBe('success');
    expect(result.finalState.published).toBe(true);
    expect(result.finalState.hierarchyCorrect).toBe(true);
    expect(phaseResults).toEqual([
      'discovery', 'process-page', 'verify', 'format', 'publish', 'hierarchy-check', 'complete',
    ]);
  });

  it('should handle multiple pages in work queue sequentially', async () => {
    let pagesProcessed = 0;

    const multiPagePipeline = createGraphBuilder()
      .addNode('discovery', async (state) => ({
        ...state,
        workQueue: [
          { pageId: 'page-001', reason: 'code changed' },
          { pageId: 'page-002', reason: 'new segment' },
          { pageId: 'page-003', reason: 'refresh requested' },
        ],
      }))
      .addNode('check-queue', async (state) => ({
        ...state,
        hasWork: (state.workQueue as any[]).length > 0,
      }))
      .addNode('process-next', async (state) => {
        const queue = [...(state.workQueue as any[])];
        const item = queue.shift();
        pagesProcessed++;
        return { ...state, workQueue: queue, currentPage: item, lastProcessed: item.pageId };
      })
      .addNode('done', async (state) => ({ ...state, totalProcessed: pagesProcessed }))
      .addEdge('discovery', 'check-queue')
      .addConditionalEdge('check-queue', (state) => state.hasWork ? 'process-next' : 'done')
      .addEdge('process-next', 'check-queue') // loop back
      .setEntryPoint('discovery')
      .setExitPoint('done')
      .setMaxIterations(20)
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(multiPagePipeline, {});

    expect(result.error).toBeUndefined();
    expect(result.finalState.totalProcessed).toBe(3);
    expect(result.finalState.lastProcessed).toBe('page-003');
    expect(result.finalState.workQueue).toHaveLength(0);
  });
});

// =============================================================================
// .arma.agent Definition Loading
// =============================================================================

describe('Doc Bot — Agent Definition Loading', () => {
  it('should load doc-bot orchestrator from .arma.agent config', () => {
    const loader = new ArmaAgentLoader();

    const config = loader.loadFromObject({
      name: 'doc-bot-orchestrator',
      type: 'operator',
      model: 'claude-sonnet-4',
      provider: 'bedrock',
      system_prompt: 'You are a documentation bot that maintains Confluence pages by reviewing code and declarative config changes.',
      tools: ['confluence_mcp', 'github_mcp', 'glean_mcp', 'bash', 'spawn_worker'],
      graph: {
        entry: 'discovery',
        nodes: {
          discovery: { type: 'tool', tools: ['confluence_mcp'] },
          'process-page': { type: 'llm', model: 'claude-sonnet-4' },
          verify: { type: 'parallel' },
          format: { type: 'llm' },
          publish: { type: 'tool', tools: ['confluence_mcp'] },
        },
        edges: [
          'discovery -> process-page',
          'process-page -> verify',
          'verify -> format [confidence > 0.9]',
          'verify -> process-page [confidence <= 0.9]',
          'format -> publish',
        ],
      },
      workers: [
        { name: 'code-reviewer', model: 'claude-haiku', prompt: 'Review code for changes since last documentation update' },
        { name: 'declarative-reviewer', model: 'claude-haiku', prompt: 'Review Salesforce declarative config for changes' },
        { name: 'hallucination-checker', model: 'claude-sonnet-4', prompt: 'Verify documentation accuracy against source code' },
        { name: 'formatter', model: 'claude-haiku', prompt: 'Format documentation for Confluence with proper HTML structure' },
        { name: 'hierarchy-checker', model: 'claude-haiku', prompt: 'Verify Confluence page hierarchy is correct' },
      ],
      permissions: {
        confluence_mcp: 'allow',
        github_mcp: 'allow',
        glean_mcp: 'allow',
        bash: 'ask',
        spawn_worker: 'allow',
      },
      max_turns: 100,
      timeout: 600000,
    });

    expect(config.name).toBe('doc-bot-orchestrator');
    expect(config.type).toBe('operator');
    expect(config.model).toBe('claude-sonnet-4');
    expect(config.tools).toContain('confluence_mcp');
    expect(config.tools).toContain('spawn_worker');
    expect(config.graph!.entry).toBe('discovery');
    expect(config.graph!.edges).toHaveLength(5);
    expect(config.workers).toHaveLength(5);
    expect(config.workers![0].name).toBe('code-reviewer');
    expect(config.permissions!.bash).toBe('ask');
  });

  it('should load hallucination-checker worker definition', () => {
    const loader = new ArmaAgentLoader();

    const config = loader.loadFromObject({
      name: 'hallucination-checker',
      type: 'worker',
      model: 'claude-sonnet-4',
      system_prompt: 'You verify documentation accuracy. Compare each claim against source code and declarative config. Score confidence 0-1.',
      tools: ['github_mcp', 'bash'],
      graph: {
        entry: 'read-doc',
        nodes: {
          'read-doc': { type: 'llm', prompt: 'Parse the compiled document into claims' },
          'verify-code': { type: 'tool', tools: ['github_mcp', 'bash'] },
          'verify-declarative': { type: 'tool', tools: ['github_mcp'] },
          'score': { type: 'llm', prompt: 'Score each claim 0-1 confidence' },
        },
        edges: [
          'read-doc -> verify-code',
          'read-doc -> verify-declarative',
          'verify-code -> score',
          'verify-declarative -> score',
        ],
      },
      max_turns: 20,
    });

    expect(config.name).toBe('hallucination-checker');
    expect(config.type).toBe('worker');
    expect(config.graph!.nodes['read-doc'].type).toBe('llm');
    expect(config.graph!.nodes['verify-code'].tools).toContain('github_mcp');
  });

  it('should resolve prebuilt config for worker type', () => {
    const loader = new ArmaAgentLoader();

    const config = loader.loadFromObject({
      name: 'formatter',
      type: 'worker',
      model: 'claude-haiku',
    });

    const resolved = loader.resolveConfig(config);
    expect(resolved.max_turns).toBe(20); // from worker prebuilt
    expect(resolved.tools).toContain('bash'); // from worker prebuilt
    expect(resolved.model).toBe('claude-haiku'); // overridden
  });

  it('should parse edge conditions correctly', () => {
    const loader = new ArmaAgentLoader();

    const edge1 = loader.parseEdge('verify -> format [confidence > 0.9]');
    expect(edge1.from).toBe('verify');
    expect(edge1.to).toBe('format');
    expect(edge1.condition).toBe('confidence > 0.9');

    const edge2 = loader.parseEdge('discovery -> process-page');
    expect(edge2.from).toBe('discovery');
    expect(edge2.to).toBe('process-page');
    expect(edge2.condition).toBeUndefined();
  });

  it('should reject invalid agent config', () => {
    const loader = new ArmaAgentLoader();

    expect(() => loader.loadFromObject({ type: 'worker' })).toThrow('name');
    expect(() => loader.loadFromObject({ name: 'test', type: 'invalid' })).toThrow('type');
  });
});

// =============================================================================
// Graph-of-Graphs: Subgraph Node Type
// =============================================================================

describe('Doc Bot — Graph-of-Graphs Composition', () => {
  it('should invoke a subgraph as a node within a parent graph', async () => {
    const subgraphs = createSubgraphRegistry();

    // Register a simple subgraph
    subgraphs.register('enrich-with-code', () =>
      createGraphBuilder()
        .addNode('fetch', async (state) => ({ ...state, code: 'class Foo {}' }))
        .addNode('analyze', async (state) => ({ ...state, analysis: 'Foo is a simple class' }))
        .addEdge('fetch', 'analyze')
        .setEntryPoint('fetch')
        .setExitPoint('analyze')
        .build()
    );

    // Parent graph that invokes subgraph via a node
    const parentGraph = createGraphBuilder()
      .addNode('start', async (state) => ({ ...state, started: true }))
      .addNode('invoke-subgraph', async (state) => {
        const result = await subgraphs.execute('enrich-with-code', state);
        return { ...state, ...result.finalState };
      })
      .addNode('finalize', async (state) => ({ ...state, finalized: true }))
      .addEdge('start', 'invoke-subgraph')
      .addEdge('invoke-subgraph', 'finalize')
      .setEntryPoint('start')
      .setExitPoint('finalize')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(parentGraph, {});

    expect(result.error).toBeUndefined();
    expect(result.finalState.started).toBe(true);
    expect(result.finalState.code).toBe('class Foo {}');
    expect(result.finalState.analysis).toBe('Foo is a simple class');
    expect(result.finalState.finalized).toBe(true);
  });

  it('should support graphs calling different subgraphs based on state', async () => {
    const subgraphs = createSubgraphRegistry();

    subgraphs.register('graph-a', () =>
      createGraphBuilder()
        .addNode('a-work', async (state) => ({ ...state, result: 'from-graph-a' }))
        .setEntryPoint('a-work')
        .setExitPoint('a-work')
        .build()
    );

    subgraphs.register('graph-b', () =>
      createGraphBuilder()
        .addNode('b-work', async (state) => ({ ...state, result: 'from-graph-b' }))
        .setEntryPoint('b-work')
        .setExitPoint('b-work')
        .build()
    );

    const routingGraph = createGraphBuilder()
      .addNode('decide', async (state) => state)
      .addNode('run-a', async (state) => {
        const r = await subgraphs.execute('graph-a', state);
        return r.finalState;
      })
      .addNode('run-b', async (state) => {
        const r = await subgraphs.execute('graph-b', state);
        return r.finalState;
      })
      .addNode('end', async (state) => state)
      .addConditionalEdge('decide', (state) => state.choice === 'a' ? 'run-a' : 'run-b')
      .addEdge('run-a', 'end')
      .addEdge('run-b', 'end')
      .setEntryPoint('decide')
      .setExitPoint('end')
      .build();

    const executor = createGraphExecutor();

    const resultA = await executor.execute(routingGraph, { choice: 'a' });
    expect(resultA.finalState.result).toBe('from-graph-a');

    const resultB = await executor.execute(routingGraph, { choice: 'b' });
    expect(resultB.finalState.result).toBe('from-graph-b');
  });

  it('should handle recursive subgraph invocation (graph calls itself with decremented counter)', async () => {
    const subgraphs = createSubgraphRegistry();
    let invocationCount = 0;

    subgraphs.register('recursive-check', () =>
      createGraphBuilder()
        .addNode('check', async (state) => {
          invocationCount++;
          if (state.depth <= 0) {
            return { ...state, done: true };
          }
          // Recurse by calling self with lower depth
          const result = await subgraphs.execute('recursive-check', { ...state, depth: state.depth - 1 });
          return { ...state, ...result.finalState, checksCompleted: (state.checksCompleted || 0) + 1 };
        })
        .setEntryPoint('check')
        .setExitPoint('check')
        .build()
    );

    const result = await subgraphs.execute('recursive-check', { depth: 3, checksCompleted: 0 });

    expect(result.error).toBeUndefined();
    expect(result.finalState.done).toBe(true);
    expect(invocationCount).toBe(4); // depth 3, 2, 1, 0
  });
});

// =============================================================================
// Context Pinning (state fields that survive compression)
// =============================================================================

describe('Doc Bot — Context Pinning', () => {
  it('should mark critical state fields as pinned (not compressible)', async () => {
    const graph = createGraphBuilder()
      .addNode('collect-data', async (state) => ({
        ...state,
        workQueue: [{ pageId: 'page-001' }],
        ephemeralLogs: ['log1', 'log2', 'log3'],
        __pinned: ['workQueue', 'compiledFindings'], // metadata: these keys must survive compression
      }))
      .addNode('process', async (state) => {
        // Simulate compression — ephemeral data might be lost, pinned data stays
        return {
          ...state,
          compiledFindings: { codeDeltas: ['thread detection changed'] },
        };
      })
      .addEdge('collect-data', 'process')
      .setEntryPoint('collect-data')
      .setExitPoint('process')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(graph, {});

    expect(result.finalState.__pinned).toContain('workQueue');
    expect(result.finalState.__pinned).toContain('compiledFindings');
    expect(result.finalState.workQueue).toHaveLength(1);
    expect(result.finalState.compiledFindings.codeDeltas).toContain('thread detection changed');
  });
});

// =============================================================================
// Phase 2 Revision: Bounded Queue (NOT spawn-per-page)
// =============================================================================

describe('Doc Bot — Bounded Queue Processing', () => {
  it('should process work queue sequentially with bounded concurrency (not spawn-per-page)', async () => {
    const processedPages: string[] = [];
    const concurrencyTracker: number[] = [];
    let activeConcurrency = 0;

    const processPage = async (pageId: string) => {
      activeConcurrency++;
      concurrencyTracker.push(activeConcurrency);
      processedPages.push(pageId);
      // Simulate work
      await new Promise(r => setTimeout(r, 10));
      activeConcurrency--;
      return { pageId, status: 'done' };
    };

    const queueGraph = createGraphBuilder()
      .addNode('init-queue', async (state) => {
        return { ...state, queue: [...state.workQueue], results: [], processed: 0 };
      })
      .addNode('dequeue', async (state) => {
        const queue = [...(state.queue as any[])];
        const batch = queue.splice(0, state.concurrency || 1);
        return { ...state, queue, currentBatch: batch, hasMore: queue.length > 0 || batch.length > 0 };
      })
      .addNode('process-batch', async (state) => {
        const batch = state.currentBatch as any[];
        if (batch.length === 0) return state;
        const batchResults = await Promise.all(
          batch.map((item: any) => processPage(item.pageId))
        );
        return {
          ...state,
          results: [...(state.results as any[]), ...batchResults],
          processed: (state.processed as number) + batch.length,
        };
      })
      .addNode('done', async (state) => ({ ...state, status: 'complete' }))
      .addEdge('init-queue', 'dequeue')
      .addEdge('dequeue', 'process-batch')
      .addConditionalEdge('process-batch', (state) => {
        return (state.queue as any[]).length > 0 ? 'dequeue' : 'done';
      })
      .setEntryPoint('init-queue')
      .setExitPoint('done')
      .setMaxIterations(50)
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(queueGraph, {
      workQueue: [
        { pageId: 'page-001' },
        { pageId: 'page-002' },
        { pageId: 'page-003' },
        { pageId: 'page-004' },
        { pageId: 'page-005' },
      ],
      concurrency: 3,
    });

    expect(result.error).toBeUndefined();
    expect(result.finalState.processed).toBe(5);
    expect(result.finalState.status).toBe('complete');
    expect(processedPages).toEqual(['page-001', 'page-002', 'page-003', 'page-004', 'page-005']);
    // Max concurrency never exceeded the bound
    expect(Math.max(...concurrencyTracker)).toBeLessThanOrEqual(3);
  });

  it('should handle empty work queue gracefully', async () => {
    const queueGraph = createGraphBuilder()
      .addNode('init-queue', async (state) => ({
        ...state, queue: [], results: [], processed: 0,
      }))
      .addNode('dequeue', async (state) => {
        const queue = [...(state.queue as any[])];
        const batch = queue.splice(0, 3);
        return { ...state, queue, currentBatch: batch };
      })
      .addNode('process-batch', async (state) => state)
      .addNode('done', async (state) => ({ ...state, status: 'complete' }))
      .addEdge('init-queue', 'dequeue')
      .addEdge('dequeue', 'process-batch')
      .addConditionalEdge('process-batch', (state) => {
        return (state.queue as any[]).length > 0 ? 'dequeue' : 'done';
      })
      .setEntryPoint('init-queue')
      .setExitPoint('done')
      .setMaxIterations(10)
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(queueGraph, { workQueue: [] });

    expect(result.error).toBeUndefined();
    expect(result.finalState.status).toBe('complete');
    expect(result.finalState.processed).toBe(0);
  });

  it('should track per-page results and accumulate errors without failing entire queue', async () => {
    const queueGraph = createGraphBuilder()
      .addNode('init', async (state) => ({
        ...state,
        queue: [...state.workQueue],
        results: [],
        errors: [],
      }))
      .addNode('process-next', async (state) => {
        const queue = [...(state.queue as any[])];
        const item = queue.shift();
        const results = [...(state.results as any[])];
        const errors = [...(state.errors as any[])];

        // Simulate: page-002 fails but doesn't kill the pipeline
        if (item.pageId === 'page-002') {
          errors.push({ pageId: item.pageId, error: 'Confluence API timeout' });
        } else {
          results.push({ pageId: item.pageId, status: 'done' });
        }

        return { ...state, queue, results, errors };
      })
      .addNode('done', async (state) => ({
        ...state,
        status: (state.errors as any[]).length > 0 ? 'partial' : 'success',
      }))
      .addConditionalEdge('process-next', (state) => {
        return (state.queue as any[]).length > 0 ? 'process-next' : 'done';
      })
      .addEdge('init', 'process-next')
      .setEntryPoint('init')
      .setExitPoint('done')
      .setMaxIterations(20)
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(queueGraph, {
      workQueue: [
        { pageId: 'page-001' },
        { pageId: 'page-002' },
        { pageId: 'page-003' },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.finalState.status).toBe('partial');
    expect(result.finalState.results).toHaveLength(2);
    expect(result.finalState.errors).toHaveLength(1);
    expect(result.finalState.errors[0].pageId).toBe('page-002');
  });
});

// =============================================================================
// Drift Snapshots (pre/post publish, manual edit detection)
// =============================================================================

describe('Doc Bot — Drift Snapshot Nodes', () => {
  it('should take pre-publish and post-publish drift snapshots', async () => {
    const snapshots: Array<{ pageId: string; tag: string; content: string }> = [];

    const drift = {
      snapshot: vi.fn().mockImplementation(async (pageId: string, content: string, opts: { tag: string }) => {
        snapshots.push({ pageId, tag: opts.tag, content });
        return { id: `snap-${snapshots.length}`, pageId, tag: opts.tag };
      }),
      compare: vi.fn().mockResolvedValue({ changed: false, delta: null }),
    };

    const publishWithDrift = createGraphBuilder()
      .addNode('drift-pre', async (state) => {
        await drift.snapshot(state.pageId, state.currentContent, { tag: 'pre-publish' });
        return state;
      })
      .addNode('publish', async (state) => {
        return { ...state, publishedContent: '<h1>Updated</h1>' + state.newContent };
      })
      .addNode('drift-post', async (state) => {
        await drift.snapshot(state.pageId, state.publishedContent, { tag: 'post-publish' });
        return state;
      })
      .addNode('done', async (state) => state)
      .addEdge('drift-pre', 'publish')
      .addEdge('publish', 'drift-post')
      .addEdge('drift-post', 'done')
      .setEntryPoint('drift-pre')
      .setExitPoint('done')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(publishWithDrift, {
      pageId: 'page-001',
      currentContent: '<h1>Old</h1>',
      newContent: '<p>New documentation content</p>',
    });

    expect(result.error).toBeUndefined();
    expect(drift.snapshot).toHaveBeenCalledTimes(2);
    expect(snapshots[0].tag).toBe('pre-publish');
    expect(snapshots[0].content).toBe('<h1>Old</h1>');
    expect(snapshots[1].tag).toBe('post-publish');
    expect(snapshots[1].content).toContain('New documentation content');
  });

  it('should detect manual edits between bot runs using drift compare', async () => {
    const drift = {
      snapshot: vi.fn().mockResolvedValue({ id: 'snap-1' }),
      compare: vi.fn().mockResolvedValue({
        changed: true,
        delta: {
          additions: ['Human added a note about deployment process'],
          removals: [],
          humanEdited: true,
        },
      }),
    };

    const discoveryWithDrift = createGraphBuilder()
      .addNode('check-drift', async (state) => {
        const comparison = await drift.compare(state.pageId, 'post-publish');
        return {
          ...state,
          manualEditDetected: comparison.changed && comparison.delta.humanEdited,
          editDelta: comparison.delta,
        };
      })
      .addNode('handle-manual-edit', async (state) => {
        // Strategy: preserve human edits and merge bot changes
        return { ...state, mergeStrategy: 'preserve-human-additions', flaggedForReview: true };
      })
      .addNode('proceed-normal', async (state) => {
        return { ...state, mergeStrategy: 'overwrite' };
      })
      .addNode('done', async (state) => state)
      .addConditionalEdge('check-drift', (state) =>
        state.manualEditDetected ? 'handle-manual-edit' : 'proceed-normal'
      )
      .addEdge('handle-manual-edit', 'done')
      .addEdge('proceed-normal', 'done')
      .setEntryPoint('check-drift')
      .setExitPoint('done')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(discoveryWithDrift, { pageId: 'page-001' });

    expect(result.error).toBeUndefined();
    expect(result.finalState.manualEditDetected).toBe(true);
    expect(result.finalState.mergeStrategy).toBe('preserve-human-additions');
    expect(result.finalState.flaggedForReview).toBe(true);
    expect(drift.compare).toHaveBeenCalledWith('page-001', 'post-publish');
  });

  it('should track drift retention metadata (90 days for doc pages)', () => {
    const driftRetentionPolicy = {
      maxAge: 90, // days
      maxPerFile: 'unlimited' as const,
      sizeThreshold: null, // pages are <100KB
      trigger: 'afterSnapshot' as const,
      storage: 'lancedb',
      table: 'drift_snapshots',
    };

    expect(driftRetentionPolicy.maxAge).toBe(90);
    expect(driftRetentionPolicy.trigger).toBe('afterSnapshot');
    expect(driftRetentionPolicy.storage).toBe('lancedb');
  });
});

// =============================================================================
// Vector Cache Nodes (LanceDB semantic similarity)
// =============================================================================

describe('Doc Bot — Vector Cache Nodes', () => {
  it('should check vector cache before making MCP calls', async () => {
    let mcpCallCount = 0;
    const vectorCache = {
      search: vi.fn().mockImplementation(async (query: string, threshold: number) => {
        // Simulate: high confidence match for known content
        if (query.includes('thread detection')) {
          return {
            matches: [
              { content: 'Thread detection uses Lightning Threading Token', confidence: 0.95, source: 'classes/ProcessEmailServices.cls:7' },
            ],
            topConfidence: 0.95,
          };
        }
        return { matches: [], topConfidence: 0 };
      }),
      upsert: vi.fn().mockResolvedValue({ id: 'vec-001' }),
    };

    const vectorFirstGraph = createGraphBuilder()
      .addNode('vector-lookup', async (state) => {
        const cached = await vectorCache.search(state.query, 0.92);
        return {
          ...state,
          vectorHit: cached.topConfidence >= 0.92,
          cachedKnowledge: cached.matches,
        };
      })
      .addNode('mcp-search', async (state) => {
        // Only called if no vector match
        mcpCallCount++;
        return { ...state, freshResults: ['New MCP data'] };
      })
      .addNode('use-cached', async (state) => {
        return { ...state, findings: (state.cachedKnowledge as any[]).map((m: any) => m.content) };
      })
      .addNode('embed-results', async (state) => {
        // Store fresh findings for next time
        if (state.freshResults) {
          await vectorCache.upsert(state.freshResults);
        }
        return state;
      })
      .addNode('done', async (state) => state)
      .addConditionalEdge('vector-lookup', (state) =>
        state.vectorHit ? 'use-cached' : 'mcp-search'
      )
      .addEdge('mcp-search', 'embed-results')
      .addEdge('embed-results', 'done')
      .addEdge('use-cached', 'done')
      .setEntryPoint('vector-lookup')
      .setExitPoint('done')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(vectorFirstGraph, {
      query: 'thread detection implementation',
    });

    expect(result.error).toBeUndefined();
    expect(result.finalState.vectorHit).toBe(true);
    expect(result.finalState.findings).toContain('Thread detection uses Lightning Threading Token');
    expect(mcpCallCount).toBe(0); // MCP was skipped thanks to vector cache
    expect(vectorCache.search).toHaveBeenCalledWith('thread detection implementation', 0.92);
  });

  it('should fall through to MCP when vector cache has no match', async () => {
    let mcpCalled = false;
    const vectorCache = {
      search: vi.fn().mockResolvedValue({ matches: [], topConfidence: 0.3 }),
      upsert: vi.fn().mockResolvedValue({ id: 'vec-002' }),
    };

    const graph = createGraphBuilder()
      .addNode('vector-lookup', async (state) => {
        const cached = await vectorCache.search(state.query, 0.92);
        return { ...state, vectorHit: cached.topConfidence >= 0.92 };
      })
      .addNode('mcp-search', async (state) => {
        mcpCalled = true;
        return { ...state, freshResults: ['Discovered new info from code review'] };
      })
      .addNode('embed-new', async (state) => {
        await vectorCache.upsert(state.freshResults);
        return state;
      })
      .addNode('done', async (state) => state)
      .addConditionalEdge('vector-lookup', (state) =>
        state.vectorHit ? 'done' : 'mcp-search'
      )
      .addEdge('mcp-search', 'embed-new')
      .addEdge('embed-new', 'done')
      .setEntryPoint('vector-lookup')
      .setExitPoint('done')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(graph, { query: 'brand new feature nobody documented' });

    expect(result.error).toBeUndefined();
    expect(result.finalState.vectorHit).toBe(false);
    expect(mcpCalled).toBe(true);
    expect(vectorCache.upsert).toHaveBeenCalled(); // New findings were cached
  });

  it('should demonstrate progressive cost reduction (cached claims skip verification)', async () => {
    const claims = [
      { text: 'Uses Lightning Threading Token', verifiedBefore: true, cachedConfidence: 0.96 },
      { text: 'Handles email routing', verifiedBefore: true, cachedConfidence: 0.94 },
      { text: 'New feature: attachment parsing', verifiedBefore: false, cachedConfidence: 0.0 },
      { text: 'Integrates with Platform Events', verifiedBefore: true, cachedConfidence: 0.93 },
      { text: 'Recently added batch processing', verifiedBefore: false, cachedConfidence: 0.2 },
    ];

    const vectorCache = {
      search: vi.fn().mockImplementation(async (claim: string) => {
        const match = claims.find(c => c.text === claim);
        return { topConfidence: match?.cachedConfidence || 0 };
      }),
    };

    let workerVerifications = 0;

    const verificationGraph = createGraphBuilder()
      .addNode('split-claims', async (state) => ({ ...state, claims, autoVerified: [], needsWorker: [] }))
      .addNode('vector-check-claims', async (state) => {
        const autoVerified: any[] = [];
        const needsWorker: any[] = [];

        for (const claim of state.claims as typeof claims) {
          const result = await vectorCache.search(claim.text);
          if (result.topConfidence >= 0.92) {
            autoVerified.push({ ...claim, verificationMethod: 'vector-cache' });
          } else {
            needsWorker.push(claim);
          }
        }

        return { ...state, autoVerified, needsWorker };
      })
      .addNode('verify-remaining', async (state) => {
        workerVerifications = (state.needsWorker as any[]).length;
        return { ...state, allVerified: true };
      })
      .addNode('done', async (state) => ({
        ...state,
        costSavings: `${((state.autoVerified as any[]).length / (state.claims as any[]).length * 100).toFixed(0)}% claims resolved from cache`,
      }))
      .addEdge('split-claims', 'vector-check-claims')
      .addEdge('vector-check-claims', 'verify-remaining')
      .addEdge('verify-remaining', 'done')
      .setEntryPoint('split-claims')
      .setExitPoint('done')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(verificationGraph, {});

    expect(result.error).toBeUndefined();
    expect((result.finalState.autoVerified as any[]).length).toBe(3); // 3 claims with confidence >= 0.92
    expect(workerVerifications).toBe(2); // only 2 claims need workers
    expect(result.finalState.costSavings).toBe('60% claims resolved from cache');
  });

  it('should upsert new findings after verification for progressive learning', async () => {
    const embeddedItems: Array<{ content: string; source: string; confidence: number }> = [];
    const vectorCache = {
      upsert: vi.fn().mockImplementation(async (items: any[]) => {
        embeddedItems.push(...items);
        return items.map((_, i) => ({ id: `vec-${i}` }));
      }),
    };

    const embedGraph = createGraphBuilder()
      .addNode('compile-verified-findings', async (state) => ({
        ...state,
        verifiedFindings: [
          { content: 'Thread detection uses Lightning Threading Token', source: 'ProcessEmailServices.cls:7', confidence: 0.95 },
          { content: 'Case routing handled by Email_to_Case_Routing flow', source: 'Email_to_Case_Routing.flow-meta.xml', confidence: 0.98 },
        ],
      }))
      .addNode('embed-findings', async (state) => {
        await vectorCache.upsert(state.verifiedFindings as any[]);
        return { ...state, embedded: true };
      })
      .addNode('done', async (state) => state)
      .addEdge('compile-verified-findings', 'embed-findings')
      .addEdge('embed-findings', 'done')
      .setEntryPoint('compile-verified-findings')
      .setExitPoint('done')
      .build();

    const executor = createGraphExecutor();
    const result = await executor.execute(embedGraph, {});

    expect(result.error).toBeUndefined();
    expect(result.finalState.embedded).toBe(true);
    expect(vectorCache.upsert).toHaveBeenCalledTimes(1);
    expect(embeddedItems).toHaveLength(2);
    expect(embeddedItems[0].confidence).toBe(0.95);
    expect(embeddedItems[1].source).toContain('flow-meta.xml');
  });
});

// =============================================================================
// Scheduler Integration (Toad-Scheduler trigger shape)
// =============================================================================

describe('Doc Bot — Scheduler Job Definition', () => {
  it('should define a schedulable job with cron-like config', () => {
    const jobDefinition = {
      id: 'doc-bot-confluence-refresh',
      name: 'Documentation Refresh',
      schedule: { intervalHours: 4 },
      agentConfig: 'doc-bot-orchestrator.arma.agent',
      input: {
        parentPageId: '1070865008',
        spaceId: '311787538',
        cutoffStrategy: 'since-last-run',
      },
      catchUp: true, // run missed executions on boot
      maxConcurrent: 1,
      timeout: 600000,
    };

    expect(jobDefinition.schedule.intervalHours).toBe(4);
    expect(jobDefinition.catchUp).toBe(true);
    expect(jobDefinition.maxConcurrent).toBe(1);
    expect(jobDefinition.agentConfig).toContain('.arma.agent');
  });

  it('should track last-run timestamp for catch-up logic', () => {
    interface RunManifest {
      jobId: string;
      lastRun: string;
      lastStatus: 'success' | 'failed' | 'partial';
      pagesProcessed: number;
      nextScheduled: string;
    }

    const manifest: RunManifest = {
      jobId: 'doc-bot-confluence-refresh',
      lastRun: '2026-05-20T04:00:00Z',
      lastStatus: 'success',
      pagesProcessed: 3,
      nextScheduled: '2026-05-20T08:00:00Z',
    };

    // Catch-up logic: if boot time > nextScheduled, run immediately
    const bootTime = new Date('2026-05-20T09:30:00Z');
    const nextScheduled = new Date(manifest.nextScheduled);
    const shouldCatchUp = bootTime > nextScheduled;

    expect(shouldCatchUp).toBe(true);
  });
});
