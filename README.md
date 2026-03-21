# memory-layer

`memory-layer` is a standalone memory package for AI assistants, agents, IDE copilots, and multi-system workflows. It gives a host system durable scoped memory, retrieval, compaction, knowledge growth, observability, and a recommended high-level facade while keeping low-level contracts public.

SQLite is the first adapter, not the whole design.

## What It Provides

- Scoped turns, working memory, and long-term knowledge
- Lexical retrieval plus optional semantic search
- Prompt-ready context assembly with ranking and token budgeting
- Compaction and summarization workflows
- Automated knowledge extraction and deduplication
- Policy controls for monitor, extraction, and context behavior
- Observability hooks and structured events
- A `createMemoryManager()` quick-start path for low-friction adoption

## Installation

```bash
npm install memory-layer
```

Optional AI SDKs:

```bash
npm install @anthropic-ai/sdk
# or
npm install openai
```

## 5-Minute Quick Start

```typescript
import {
  createMemoryManager,
  createSQLiteAdapterWithEmbeddings,
  createRegexExtractor,
  createSessionId,
} from 'memory-layer';

const adapter = createSQLiteAdapterWithEmbeddings('./data/memory.db');

const scope = {
  tenant_id: 'acme',
  system_id: 'ai-ide',
  workspace_id: 'repo-memory',
  scope_id: 'thread-123',
};

const manager = createMemoryManager({
  adapter,
  scope,
  sessionId: createSessionId(scope),
  summarizer: async (turns) => ({
    summary: `Summarized ${turns.length} turns`,
    key_entities: ['memory-layer'],
    topic_tags: ['coding'],
  }),
  extractor: createRegexExtractor(),
});

await manager.processTurn('user', 'I prefer SQLite for local-first tools.');
await manager.processTurn('assistant', 'Understood. I will keep the memory local.');

const context = manager.getContext('SQLite local-first');
console.log(context.relevantKnowledge);
```

## Core Concepts

### MemoryScope

Every record is scoped by:

```typescript
interface MemoryScope {
  tenant_id: string;
  system_id: string;
  workspace_id?: string; // defaults to 'default'
  scope_id: string;
}
```

Suggested mapping:

- `tenant_id`: organization or product boundary
- `system_id`: calling app, agent, or assistant
- `workspace_id`: optional shared memory pool inside that system
- `scope_id`: thread, room, task, or conversation id

### Memory Types

- `Turn`: raw conversation history
- `WorkingMemory`: compacted summaries for active context
- `KnowledgeMemory`: durable facts with access tracking and supersession
- `ContextMonitor`: compaction-health snapshot for a scope
- `CompactionLog`: audit trail for each compaction

## Recommended API

Use `createMemoryManager()` when you want a near-drop-in integration:

- `processTurn(role, content, actor?)`
- `getContext(relevanceQuery?)`
- `search(query, options?)`
- `forceCompact()`
- `learnFact(fact, factType, confidence?)`
- `close()`

## Low-Level API

Use the lower-level surface when you want more control:

```typescript
import {
  assessContext,
  buildMemoryContext,
  compactTurns,
  createSQLiteAdapter,
  createSessionId,
} from 'memory-layer';

const adapter = createSQLiteAdapter('./memory.db');
const scope = { tenant_id: 'acme', system_id: 'agent', scope_id: 'run-42' };
const sessionId = createSessionId(scope);

adapter.insertTurn({
  ...scope,
  session_id: sessionId,
  actor: 'user-1',
  role: 'user',
  content: 'Build me a memory system.',
});

const turns = adapter.getActiveTurns(scope);
const report = assessContext(
  {
    scope,
    session_id: sessionId,
    active_turns: turns,
    latest_working_memory: adapter.getLatestWorkingMemory(scope),
  },
);

if (report.recommendation.action !== 'none') {
  await compactTurns(
    adapter,
    scope,
    sessionId,
    turns,
    async (turnsToSummarize) => ({
      summary: `Summarized ${turnsToSummarize.length} turns`,
      key_entities: ['memory'],
      topic_tags: ['architecture'],
    }),
    report.recommendation.action,
    report.recommendation.post_compaction_target_turns,
  );
}

const promptReady = buildMemoryContext(adapter, scope, {
  relevanceQuery: 'memory architecture',
  tokenBudget: 3000,
});
```

## Retrieval

Lexical retrieval is exposed directly on the adapter:

```typescript
const turns = adapter.searchTurns(scope, 'postgres');
const facts = adapter.searchKnowledge(scope, 'local-first sqlite');
```

`buildMemoryContext()` combines:

- active turns
- latest working memory
- recent summaries
- ranked knowledge memory

When you pass an embedding adapter and query vector, semantic similarity is blended with lexical, recency, and importance signals.

## Knowledge Growth

The package supports both manual and automated durable-memory growth:

- `promoteToKnowledge()` for explicit promotion from a working-memory record
- `extractKnowledge()` for post-compaction extraction
- `createRegexExtractor()` for zero-dependency extraction
- optional Claude/OpenAI extractor helpers for LLM-powered extraction

Compaction write order is atomic:

```text
insertWorkingMemory -> insertCompactionLog -> archiveTurn x N
```

## Built-In AI Helpers

Prompt helpers:

- `SUMMARIZATION_SYSTEM_PROMPT`
- `EXTRACTION_SYSTEM_PROMPT`
- `formatTurnsForSummarization()`
- `parseSummarizerResponse()`
- `parseExtractionResponse()`

Optional summarizers/extractors:

- `createClaudeSummarizer()`
- `createOpenAISummarizer()`
- `createClaudeExtractor()`
- `createOpenAIExtractor()`

These use dynamic imports, so the package works without those SDKs installed.

## Observability

Most workflows accept:

- `logger`
- `onEvent`

Structured events are emitted for:

- search
- compaction
- promotion
- extraction
- context assembly
- manager workflow actions

## Native SQLite Notes

- The SQLite adapter uses `better-sqlite3`
- WAL mode and foreign keys are enabled automatically
- On some systems you may need normal native build prerequisites for `better-sqlite3`
- `createSQLiteAdapter(':memory:')` is useful for tests and ephemeral runs

## Examples

- `examples/chat-assistant.ts`
- `examples/autonomous-agent.ts`

## Validation And Release Checks

```bash
npm run lint
npm test
npm run build
npm run pack:check
```

## Benchmarks And Evals

```bash
npm run benchmark:search
npm run benchmark:semantic
npm run benchmark:compaction
npm run eval:retrieval
```
