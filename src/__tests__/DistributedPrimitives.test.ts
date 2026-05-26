import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createNodeDiscovery,
  createTaskDistributor,
  createLeaderElection,
  createMessageBus,
  NodeIdentity,
  NodeMessage,
  NodeDiscovery,
  TaskDistributor,
  LeaderElection,
} from '../DistributedPrimitives';

function makeNode(overrides: Partial<NodeIdentity> = {}): NodeIdentity {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    hostname: overrides.hostname ?? 'localhost',
    port: overrides.port ?? 8080,
    capabilities: overrides.capabilities ?? ['llm'],
    status: overrides.status ?? 'online',
    lastHeartbeat: overrides.lastHeartbeat ?? new Date(),
  };
}

function makeMessage(overrides: Partial<NodeMessage> = {}): NodeMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    from: overrides.from ?? 'node-a',
    to: overrides.to ?? 'node-b',
    type: overrides.type ?? 'task',
    payload: overrides.payload ?? { data: 'test' },
    timestamp: overrides.timestamp ?? new Date(),
    ttl: overrides.ttl,
  };
}

describe('DistributedPrimitives', () => {
  describe('NodeDiscovery', () => {
    let discovery: NodeDiscovery;

    beforeEach(() => {
      discovery = createNodeDiscovery();
    });

    it('should register a node and retrieve it by id', () => {
      const node = makeNode({ id: 'node-1' });
      discovery.register(node);

      const found = discovery.getNodeById('node-1');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('node-1');
      expect(found!.hostname).toBe('localhost');
    });

    it('should register multiple nodes and list all online', () => {
      const n1 = makeNode({ id: 'n1', status: 'online' });
      const n2 = makeNode({ id: 'n2', status: 'online' });
      const n3 = makeNode({ id: 'n3', status: 'offline' });

      discovery.register(n1);
      discovery.register(n2);
      discovery.register(n3);

      const online = discovery.getOnlineNodes();
      expect(online).toHaveLength(2);
      expect(online.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    });

    it('should unregister and remove a node', () => {
      const node = makeNode({ id: 'removable' });
      discovery.register(node);
      discovery.unregister('removable');

      expect(discovery.getNodeById('removable')).toBeNull();
      expect(discovery.getOnlineNodes()).toHaveLength(0);
    });

    it('should update lastHeartbeat on heartbeat call', () => {
      vi.useFakeTimers();
      const start = new Date();
      const node = makeNode({ id: 'hb-node', lastHeartbeat: start });
      discovery.register(node);

      vi.advanceTimersByTime(5000);
      discovery.heartbeat('hb-node');

      const updated = discovery.getNodeById('hb-node');
      expect(updated!.lastHeartbeat.getTime()).toBeGreaterThan(start.getTime());
      vi.useRealTimers();
    });

    it('should filter nodes by capability', () => {
      discovery.register(makeNode({ id: 'a', capabilities: ['llm', 'tools'] }));
      discovery.register(makeNode({ id: 'b', capabilities: ['vector-store'] }));
      discovery.register(makeNode({ id: 'c', capabilities: ['llm'] }));

      const llmNodes = discovery.getNodesByCapability('llm');
      expect(llmNodes).toHaveLength(2);
      expect(llmNodes.map((n) => n.id).sort()).toEqual(['a', 'c']);
    });

    it('should detect offline nodes with stale heartbeats', () => {
      vi.useFakeTimers();
      const now = new Date();

      const freshNode = makeNode({ id: 'fresh', lastHeartbeat: now });
      const staleNode = makeNode({
        id: 'stale',
        lastHeartbeat: new Date(now.getTime() - 10000),
      });

      discovery.register(freshNode);
      discovery.register(staleNode);

      const offline = discovery.detectOffline(5000);
      expect(offline).toHaveLength(1);
      expect(offline[0].id).toBe('stale');
      vi.useRealTimers();
    });

    it('should return null for unknown node id', () => {
      expect(discovery.getNodeById('does-not-exist')).toBeNull();
    });
  });

  describe('TaskDistributor', () => {
    let distributor: TaskDistributor;

    beforeEach(() => {
      distributor = createTaskDistributor();
    });

    it('should assign a task with assignedAt timestamp', () => {
      const before = new Date();
      const assignment = distributor.assign({
        taskId: 'task-1',
        nodeId: 'node-a',
        workflowName: 'wf-1',
        graphName: 'graph-1',
        nodeName: 'start',
        input: { prompt: 'hello' },
      });

      expect(assignment.taskId).toBe('task-1');
      expect(assignment.nodeId).toBe('node-a');
      expect(assignment.assignedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('should mark a task as completed with result', () => {
      distributor.assign({
        taskId: 'task-2',
        nodeId: 'node-a',
        workflowName: 'wf',
        graphName: 'g',
        nodeName: 'n',
        input: {},
      });

      distributor.complete('task-2', { output: 'done' });

      const completed = distributor.getCompletedTasks();
      expect(completed).toHaveLength(1);
      expect(completed[0].taskId).toBe('task-2');
      expect(completed[0].result).toEqual({ output: 'done' });
    });

    it('should mark a task as failed with error message', () => {
      distributor.assign({
        taskId: 'task-3',
        nodeId: 'node-b',
        workflowName: 'wf',
        graphName: 'g',
        nodeName: 'n',
        input: {},
      });

      distributor.fail('task-3', 'timeout exceeded');

      const failed = distributor.getFailedTasks();
      expect(failed).toHaveLength(1);
      expect(failed[0].taskId).toBe('task-3');
      expect(failed[0].error).toBe('timeout exceeded');
    });

    it('should retrieve assignment by task id', () => {
      distributor.assign({
        taskId: 'task-4',
        nodeId: 'node-c',
        workflowName: 'wf',
        graphName: 'g',
        nodeName: 'step-1',
        input: { x: 1 },
      });

      const assignment = distributor.getAssignment('task-4');
      expect(assignment).not.toBeNull();
      expect(assignment!.nodeName).toBe('step-1');
    });

    it('should return pending tasks (not completed or failed)', () => {
      distributor.assign({ taskId: 't1', nodeId: 'n1', workflowName: 'w', graphName: 'g', nodeName: 'a', input: {} });
      distributor.assign({ taskId: 't2', nodeId: 'n2', workflowName: 'w', graphName: 'g', nodeName: 'b', input: {} });
      distributor.assign({ taskId: 't3', nodeId: 'n1', workflowName: 'w', graphName: 'g', nodeName: 'c', input: {} });

      distributor.complete('t1', 'ok');
      distributor.fail('t2', 'err');

      const pending = distributor.getPendingTasks();
      expect(pending).toHaveLength(1);
      expect(pending[0].taskId).toBe('t3');
    });

    it('should filter pending tasks by nodeId', () => {
      distributor.assign({ taskId: 't1', nodeId: 'n1', workflowName: 'w', graphName: 'g', nodeName: 'a', input: {} });
      distributor.assign({ taskId: 't2', nodeId: 'n2', workflowName: 'w', graphName: 'g', nodeName: 'b', input: {} });
      distributor.assign({ taskId: 't3', nodeId: 'n1', workflowName: 'w', graphName: 'g', nodeName: 'c', input: {} });

      const n1Tasks = distributor.getPendingTasks('n1');
      expect(n1Tasks).toHaveLength(2);
      expect(n1Tasks.every((t) => t.nodeId === 'n1')).toBe(true);
    });

    it('should return completed tasks with results', () => {
      distributor.assign({ taskId: 't1', nodeId: 'n1', workflowName: 'w', graphName: 'g', nodeName: 'a', input: {} });
      distributor.assign({ taskId: 't2', nodeId: 'n1', workflowName: 'w', graphName: 'g', nodeName: 'b', input: {} });

      distributor.complete('t1', 'result-1');
      distributor.complete('t2', 'result-2');

      const completed = distributor.getCompletedTasks();
      expect(completed).toHaveLength(2);
      expect(completed[0].result).toBe('result-1');
      expect(completed[1].result).toBe('result-2');
    });

    it('should return failed tasks with errors', () => {
      distributor.assign({ taskId: 't1', nodeId: 'n1', workflowName: 'w', graphName: 'g', nodeName: 'a', input: {} });
      distributor.fail('t1', 'bad input');

      const failed = distributor.getFailedTasks();
      expect(failed).toHaveLength(1);
      expect(failed[0].error).toBe('bad input');
    });

    it('should reassign a task to a new node', () => {
      distributor.assign({ taskId: 't1', nodeId: 'n1', workflowName: 'w', graphName: 'g', nodeName: 'a', input: {} });

      const reassigned = distributor.reassign('t1', 'n2');
      expect(reassigned.nodeId).toBe('n2');
      expect(reassigned.taskId).toBe('t1');

      const assignment = distributor.getAssignment('t1');
      expect(assignment!.nodeId).toBe('n2');
    });

    it('should throw when reassigning an unknown task', () => {
      expect(() => distributor.reassign('nonexistent', 'n2')).toThrow();
    });
  });

  describe('LeaderElection', () => {
    let election: LeaderElection;

    beforeEach(() => {
      election = createLeaderElection();
    });

    it('should elect and return a node id', () => {
      const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' })];
      const leader = election.elect(nodes);

      expect(typeof leader).toBe('string');
      expect(['a', 'b']).toContain(leader);
    });

    it('should elect node with most capabilities as tie-break', () => {
      const nodeA = makeNode({ id: 'a', capabilities: ['llm'] });
      const nodeB = makeNode({ id: 'b', capabilities: ['llm', 'tools', 'vector-store'] });
      const nodeC = makeNode({ id: 'c', capabilities: ['llm', 'tools'] });

      const leader = election.elect([nodeA, nodeB, nodeC]);
      expect(leader).toBe('b');
    });

    it('should return true for isLeader on current leader', () => {
      const nodes = [makeNode({ id: 'x' }), makeNode({ id: 'y' })];
      const leader = election.elect(nodes);

      expect(election.isLeader(leader)).toBe(true);
    });

    it('should return false for isLeader on non-leader', () => {
      const nodeA = makeNode({ id: 'leader-node', capabilities: ['a', 'b', 'c'] });
      const nodeB = makeNode({ id: 'follower-node', capabilities: ['a'] });

      election.elect([nodeA, nodeB]);

      expect(election.isLeader('follower-node')).toBe(false);
    });

    it('should return current leader via getLeader', () => {
      const nodes = [makeNode({ id: 'solo' })];
      election.elect(nodes);

      expect(election.getLeader()).toBe('solo');
    });

    it('should clear leader on stepDown', () => {
      const nodes = [makeNode({ id: 'temp-leader' })];
      election.elect(nodes);
      election.stepDown();

      expect(election.getLeader()).toBeNull();
    });

    it('should throw when electing from empty array', () => {
      expect(() => election.elect([])).toThrow();
    });
  });

  describe('MessageBus', () => {
    it('should send and store messages', async () => {
      const { transport } = createMessageBus();
      const msg = makeMessage({ id: 'msg-1' });

      await transport.send(msg);
      // No error means success — messages are stored internally
    });

    it('should deliver messages to onReceive handler', () => {
      const { transport, deliver } = createMessageBus();
      const handler = vi.fn();
      transport.onReceive(handler);

      const msg = makeMessage({ id: 'msg-2', to: 'node-b' });
      deliver(msg);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-2' }));
    });

    it('should deliver broadcast messages (to: *) to handler', () => {
      const { transport, deliver } = createMessageBus();
      const handler = vi.fn();
      transport.onReceive(handler);

      const msg = makeMessage({ to: '*', type: 'discovery' });
      deliver(msg);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ to: '*' }));
    });

    it('should not deliver messages with expired TTL', () => {
      vi.useFakeTimers();
      const { transport, deliver } = createMessageBus();
      const handler = vi.fn();
      transport.onReceive(handler);

      const pastTimestamp = new Date(Date.now() - 5000);
      const msg = makeMessage({ timestamp: pastTimestamp, ttl: 2000 });

      deliver(msg);

      expect(handler).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should deliver to multiple handlers', () => {
      const { transport, deliver } = createMessageBus();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      transport.onReceive(handler1);
      transport.onReceive(handler2);
      transport.onReceive(handler3);

      const msg = makeMessage({ id: 'broadcast' });
      deliver(msg);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });
  });
});
