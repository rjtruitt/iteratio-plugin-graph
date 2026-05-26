# iteratio-plugin-graph

Graph-based workflow execution plugin for iteratio.

## Install

```
npm install iteratio-plugin-graph
```

## What It Does

Defines a single agent's execution flow as a directed acyclic graph. Nodes are execution steps, edges are transitions. Supports conditional routing, cycles, and parallel branches. Use this when your agent needs structured state-machine logic rather than free-form conversation.

## Usage

```typescript
import { AgentLoop } from 'iteratio';
import { GraphPlugin, GraphBuilder } from 'iteratio-plugin-graph';

const graph = new GraphBuilder()
  .addNode('llm', llmNode)
  .addNode('tools', toolsNode)
  .addNode('done', doneNode)
  .addConditionalEdge('llm', (state) => {
    return state.hasToolCalls ? 'tools' : 'done';
  })
  .addEdge('tools', 'llm')
  .setEntryPoint('llm')
  .build();

const loop = AgentLoop.builder()
  .withLLM(llm)
  .withPlugin(new GraphPlugin({ graph }))
  .build();
```

## License

MIT
