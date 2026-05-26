/** Uniquely identifies a node in the distributed graph network. */
export interface NodeIdentity {
  id: string;
  hostname: string;
  port: number;
  capabilities: string[];
  status: 'online' | 'offline' | 'busy';
  lastHeartbeat: Date;
}

export interface NodeMessage {
  id: string;
  from: string;
  to: string;
  type: 'task' | 'result' | 'heartbeat' | 'discovery' | 'coordination';
  payload: unknown;
  timestamp: Date;
  ttl?: number;
}

export interface TaskAssignment {
  taskId: string;
  nodeId: string;
  workflowName: string;
  graphName: string;
  nodeName: string;
  input: unknown;
  assignedAt: Date;
  deadline?: Date;
}

export interface ClusterState {
  nodes: NodeIdentity[];
  leader: string | null;
  epoch: number;
  tasks: TaskAssignment[];
}

export interface MessageTransport {
  send(message: NodeMessage): Promise<void>;
  onReceive(handler: (message: NodeMessage) => void): void;
}

export interface NodeDiscovery {
  register(node: NodeIdentity): void;
  unregister(nodeId: string): void;
  heartbeat(nodeId: string): void;
  getOnlineNodes(): NodeIdentity[];
  getNodeById(id: string): NodeIdentity | null;
  getNodesByCapability(capability: string): NodeIdentity[];
  detectOffline(timeoutMs: number): NodeIdentity[];
}

export interface TaskDistributor {
  assign(task: Omit<TaskAssignment, 'assignedAt'>): TaskAssignment;
  complete(taskId: string, result: unknown): void;
  fail(taskId: string, error: string): void;
  getAssignment(taskId: string): TaskAssignment | null;
  getPendingTasks(nodeId?: string): TaskAssignment[];
  getCompletedTasks(): Array<TaskAssignment & { result: unknown }>;
  getFailedTasks(): Array<TaskAssignment & { error: string }>;
  reassign(taskId: string, newNodeId: string): TaskAssignment;
}

export interface LeaderElection {
  elect(nodes: NodeIdentity[]): string;
  isLeader(nodeId: string): boolean;
  getLeader(): string | null;
  stepDown(): void;
}

// --- Implementations ---

/** Creates a node discovery service for finding peers in the distributed network. */
export function createNodeDiscovery(): NodeDiscovery {
  const nodes = new Map<string, NodeIdentity>();

  return {
    register(node: NodeIdentity): void {
      nodes.set(node.id, { ...node });
    },

    unregister(nodeId: string): void {
      nodes.delete(nodeId);
    },

    heartbeat(nodeId: string): void {
      const node = nodes.get(nodeId);
      if (node) {
        node.lastHeartbeat = new Date();
      }
    },

    getOnlineNodes(): NodeIdentity[] {
      return Array.from(nodes.values()).filter((n) => n.status === 'online');
    },

    getNodeById(id: string): NodeIdentity | null {
      return nodes.get(id) ?? null;
    },

    getNodesByCapability(capability: string): NodeIdentity[] {
      return Array.from(nodes.values()).filter((n) => n.capabilities.includes(capability));
    },

    detectOffline(timeoutMs: number): NodeIdentity[] {
      const now = Date.now();
      return Array.from(nodes.values()).filter(
        (n) => now - n.lastHeartbeat.getTime() > timeoutMs,
      );
    },
  };
}

/** Creates a task distributor for assigning work across distributed nodes. */
export function createTaskDistributor(): TaskDistributor {
  const assignments = new Map<string, TaskAssignment>();
  const completed = new Map<string, { assignment: TaskAssignment; result: unknown }>();
  const failed = new Map<string, { assignment: TaskAssignment; error: string }>();

  return {
    assign(task: Omit<TaskAssignment, 'assignedAt'>): TaskAssignment {
      const assignment: TaskAssignment = {
        ...task,
        assignedAt: new Date(),
      };
      assignments.set(task.taskId, assignment);
      return assignment;
    },

    complete(taskId: string, result: unknown): void {
      const assignment = assignments.get(taskId);
      if (!assignment) return;
      assignments.delete(taskId);
      completed.set(taskId, { assignment, result });
    },

    fail(taskId: string, error: string): void {
      const assignment = assignments.get(taskId);
      if (!assignment) return;
      assignments.delete(taskId);
      failed.set(taskId, { assignment, error });
    },

    getAssignment(taskId: string): TaskAssignment | null {
      return assignments.get(taskId) ?? null;
    },

    getPendingTasks(nodeId?: string): TaskAssignment[] {
      const all = Array.from(assignments.values());
      if (nodeId !== undefined) {
        return all.filter((a) => a.nodeId === nodeId);
      }
      return all;
    },

    getCompletedTasks(): Array<TaskAssignment & { result: unknown }> {
      return Array.from(completed.values()).map(({ assignment, result }) => ({
        ...assignment,
        result,
      }));
    },

    getFailedTasks(): Array<TaskAssignment & { error: string }> {
      return Array.from(failed.values()).map(({ assignment, error }) => ({
        ...assignment,
        error,
      }));
    },

    reassign(taskId: string, newNodeId: string): TaskAssignment {
      const assignment = assignments.get(taskId);
      if (!assignment) {
        throw new Error(`Task not found: ${taskId}`);
      }
      assignment.nodeId = newNodeId;
      return assignment;
    },
  };
}

/** Creates a leader election algorithm for coordinating distributed graph execution. */
export function createLeaderElection(): LeaderElection {
  let currentLeader: string | null = null;

  return {
    elect(nodes: NodeIdentity[]): string {
      if (nodes.length === 0) {
        throw new Error('Cannot elect leader from empty node list');
      }

      // Sort by capability count descending; first in array wins ties
      const sorted = [...nodes].sort(
        (a, b) => b.capabilities.length - a.capabilities.length,
      );

      currentLeader = sorted[0].id;
      return currentLeader;
    },

    isLeader(nodeId: string): boolean {
      return currentLeader === nodeId;
    },

    getLeader(): string | null {
      return currentLeader;
    },

    stepDown(): void {
      currentLeader = null;
    },
  };
}

/** Creates an in-memory message bus for node-to-node communication. */
export function createMessageBus(): { transport: MessageTransport; deliver(message: NodeMessage): void } {
  const messages: NodeMessage[] = [];
  const handlers: Array<(message: NodeMessage) => void> = [];

  function isExpired(message: NodeMessage): boolean {
    if (message.ttl === undefined) return false;
    const now = Date.now();
    const messageAge = now - message.timestamp.getTime();
    return messageAge > message.ttl;
  }

  const transport: MessageTransport = {
    async send(message: NodeMessage): Promise<void> {
      messages.push(message);
    },

    onReceive(handler: (message: NodeMessage) => void): void {
      handlers.push(handler);
    },
  };

  function deliver(message: NodeMessage): void {
    if (isExpired(message)) return;

    for (const handler of handlers) {
      handler(message);
    }
  }

  return { transport, deliver };
}
