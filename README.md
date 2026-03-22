# memory-layer

Drop-in memory for AI systems. Give any agent, IDE, or autonomous runtime persistent memory with compaction, knowledge growth, hybrid retrieval, and prompt assembly.

SQLite is the first adapter, not the architecture.

```
User Input ──> Turn Storage ──> Compaction ──> Working Memory
                                    |
                              Extraction ──> Knowledge Memory
                                    |
                              Retrieval ──> Prompt-Ready Context
```

## Install

```bash
npm install memory-layer
```

Optionally install a provider SDK for AI-backed summarization and extraction:

```bash
npm install @anthropic-ai/sdk   # Claude summarizer + extractor
# or
npm install openai              # OpenAI summarizer + extractor
```

Without a provider SDK, `memory-layer` uses a zero-dependency extractive summarizer and regex-based extractor. No API keys required.

## Quick Start

### Zero-config (in-memory, extractive summarization)

```typescript
import { createMemory } from 'memory-layer';

const memory = createMemory();
await memory.processExchange(
  'Remember that this project must stay local-first.',
  'Stored. I will keep local-first constraints in memory.',
);
const context = await memory.getContext('local-first');
```

### Persistent SQLite

```typescript
const memory = createMemory({
  adapter: 'sqlite',
  path: './data/memory.db',
  scope: 'my-agent',
});
```

### Claude-backed

```typescript
import { createClaudeMemoryManager, createMemoryRuntime } from 'memory-layer';

const manager = createClaudeMemoryManager({
  dbPath: './data/memory.db',
  scope: {
    tenant_id: 'acme',
    system_id: 'ai-ide',
    workspace_id: 'repo-memory',
    scope_id: 'task-123',
  },
  preset: 'ai_ide',
});

const runtime = createMemoryRuntime(manager);
const prepared = await runtime.beforeModelCall('Refactor the search layer.');
// Send prepared.prompt or prepared.messages to your model
await runtime.afterModelCall({
  userInput: 'Refactor the search layer.',
  assistantOutput: 'I will preserve hybrid retrieval behavior.',
});
manager.close();
```

### OpenAI-backed

```typescript
import { createOpenAIMemoryManager } from 'memory-layer';

const manager = createOpenAIMemoryManager({
  dbPath: './data/memory.db',
  scope: { tenant_id: 'acme', system_id: 'chat-agent', scope_id: 'conv-42' },
  preset: 'chat_agent',
});
```

## Architecture

### Memory Model

Memory flows through three tiers, mimicking biological memory:

| Tier | Record Type | Purpose | Lifecycle |
|------|-------------|---------|-----------|
| Short-term | **Turn** | Raw conversation history | Active until compacted, then archived |
| Medium-term | **WorkingMemory** | Compacted summaries with entities and tags | Active until expired (TTL) or promoted |
| Long-term | **KnowledgeMemory** | Durable learned facts | Active until retired (staleness) or superseded |

Supporting records:
- **WorkItem**: Objectives, unresolved work, constraints
- **ContextMonitor**: Persisted compaction health state
- **CompactionLog**: Compaction audit trail
- **KnowledgeMemoryAudit**: Extraction decision trail

### Data Flow

1. **Ingest**: `processTurn()` / `processExchange()` stores raw turns
2. **Monitor**: Context health is assessed against `MonitorPolicy` thresholds
3. **Compact**: When thresholds are met, turns are summarized into `WorkingMemory`
4. **Extract**: Facts are mined from summaries, normalized, deduplicated, and stored as `KnowledgeMemory`
5. **Embed**: Optionally, knowledge facts get vector embeddings for semantic search
6. **Retrieve**: `getContext()` assembles prompt-ready context using hybrid scoring
7. **Maintain**: Stale summaries expire, unused knowledge retires, completed work items clean up

### Scoping

Every record belongs to a scope. This enables multi-tenant isolation and cross-scope retrieval:

```typescript
interface MemoryScope {
  tenant_id: string;    // Product or organization boundary
  system_id: string;    // Caller identity (e.g., "ai-ide", "chat-agent")
  workspace_id?: string; // Optional shared memory boundary
  scope_id: string;     // Conversation, task, run, or thread ID
}
```

Cross-scope retrieval levels: `scope` (exact) | `workspace` | `system` | `tenant`

## API Reference

### MemoryManager

The core interface returned by `createMemory()`, `createMemoryManager()`, and provider factories.

```typescript
interface MemoryManager {
  // Data entry
  processTurn(role, content, actor?): Promise<Turn>
  processExchange(userContent, assistantContent, actors?): Promise<{
    userTurn: Turn;
    assistantTurn: Turn;
    compactionResult: CompactionResult | null;
  }>

  // Retrieval
  getContext(relevanceQuery?): Promise<MemoryContext>
  getSessionBootstrap(relevanceQuery?): Promise<SessionBootstrap>
  search(query, options?): Promise<{
    turns: SearchResult<Turn>[];
    knowledge: SearchResult<KnowledgeMemory>[];
  }>
  searchCrossScope(query, level, options?): Promise<{
    knowledge: SearchResult<KnowledgeMemory>[];
  }>
  recall(timeRange): {
    turns: Turn[];
    workingMemory: WorkingMemory[];
    knowledge: KnowledgeMemory[];
    workItems: WorkItem[];
  }

  // Knowledge management
  learnFact(fact, factType, confidence?): KnowledgeMemory
  trackWorkItem(title, kind?, status?, detail?): WorkItem
  forceCompact(): Promise<CompactionResult | null>
  runMaintenance(policy?): MaintenanceReport

  close(): void
}
```

### MemoryRuntime

Higher-level hooks for model call integration, returned by `createMemoryRuntime(manager)`.

```typescript
interface MemoryRuntime {
  startSession(relevanceQuery?): Promise<{ bootstrap, bootstrapPrompt }>
  resumeSession(relevanceQuery?): Promise<{ bootstrap, bootstrapPrompt }>
  beforeModelCall(input): Promise<{
    bootstrap, context, bootstrapPrompt, prompt, messages
  }>
  afterModelCall({ userInput, assistantOutput, actors?, workItems? }): Promise<{
    exchange, trackedWorkItems
  }>
  wrapModelCall(modelFn, input, actors?): Promise<{
    result, runtime, exchange, trackedWorkItems
  }>
}
```

### createMemory() Options

The quick factory with sensible defaults:

```typescript
createMemory({
  adapter?: 'sqlite' | 'memory' | StorageAdapter,  // default: 'sqlite' at ':memory:'
  path?: string,                                     // SQLite file path
  scope?: string | MemoryScope,                      // default: 'default'
  preset?: 'ai_ide' | 'chat_agent' | 'autonomous_agent',
  summarizer?: 'extractive' | 'claude' | 'openai' | Summarizer,
  extractor?: 'regex' | 'claude' | 'openai' | Extractor | false,
  policies?: {
    monitor?: Partial<MonitorPolicy>,
    extraction?: Partial<ExtractionPolicy>,
    context?: Partial<ContextPolicy>,
    maintenance?: Partial<MaintenancePolicy>,
  },
  autoCompact?: boolean,     // default: true
  autoExtract?: boolean,     // default: true if extractor present
  logger?: Logger,
  onEvent?: EventHook,
})
```

## Presets

Use a preset first and override only when needed:

| Preset | Use Case | Compaction | Retrieval | TTL |
|--------|----------|------------|-----------|-----|
| `ai_ide` | Coding assistants | Moderate (20/40 turns) | Workspace-shared | 14 days |
| `chat_agent` | Conversational agents | Default (15/30 turns) | Scope-local | 7 days |
| `autonomous_agent` | Dark factory / autonomous | Aggressive (10/20 turns) | Workspace-wide | 3 days |

## Integration Patterns

### Pattern 1: Direct Manager

```typescript
const manager = createMemory({ scope: 'my-agent' });
await manager.processExchange(userInput, assistantOutput);
const context = await manager.getContext(userInput);
manager.close();
```

### Pattern 2: Runtime Hooks

```typescript
const runtime = createMemoryRuntime(manager);
const { prompt } = await runtime.beforeModelCall(userInput);
const result = await callModel(prompt);
await runtime.afterModelCall({ userInput, assistantOutput: result });
```

### Pattern 3: wrapModelCall (End-to-End)

```typescript
const { result } = await runtime.wrapModelCall(
  (prepared) => callModel(prepared.prompt),
  userInput,
);
```

### Pattern 4: Middleware

```typescript
import { wrapWithMemory } from 'memory-layer';

const handler = wrapWithMemory(
  (messages) => callModel(messages),
  manager,
  { injectContext: true, contextPosition: 'system' },
);
const response = await handler([{ role: 'user', content: userInput }]);
```

### Pattern 5: MCP Tool Adapter

```typescript
import { createMemoryMcpAdapter, createMemoryRuntime } from 'memory-layer';

const runtime = createMemoryRuntime(manager);
const mcp = createMemoryMcpAdapter(runtime);
// mcp.tools = tool definitions, mcp.callTool(name, args) = dispatcher
```

### Pattern 6: Claude / OpenAI Tool Schemas

```typescript
import { createClaudeMemoryTools, createOpenAIMemoryTools } from 'memory-layer';

const claudeTools = createClaudeMemoryTools(runtime);
const openaiTools = createOpenAIMemoryTools(runtime);
```

## Policy Configuration

### MonitorPolicy (Compaction Triggers)

| Field | Default | Description |
|-------|---------|-------------|
| `softTurnThreshold` | 15 | Turns before soft compaction is considered |
| `hardTurnThreshold` | 30 | Turns that force compaction |
| `softTokenThreshold` | 3000 | Token estimate for soft trigger |
| `hardTokenThreshold` | 6000 | Token estimate that forces compaction |
| `softRetainTurns` | 12 | Turns to keep after soft compaction |
| `hardRetainTurns` | 8 | Turns to keep after hard compaction |
| `intraSessionGapSeconds` | 1800 | Idle gap (30 min) that triggers session_gap compaction |

### ExtractionPolicy (Knowledge Growth)

| Field | Default | Description |
|-------|---------|-------------|
| `autoExtractAfterCompaction` | true | Run extraction after each compaction |
| `maxFactsPerExtraction` | 10 | Max facts to extract per compaction |
| `deduplicateFacts` | true | Deduplicate against existing knowledge |
| `touchDuplicates` | true | Update access time on duplicate detection |
| `minConfidenceForPromotion` | 'medium' | Minimum confidence for storage |
| `conflictStrategy` | 'supersede' | How to handle conflicting facts |

### ContextPolicy (Retrieval)

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | 'chat' | Scoring profile: chat, coding, autonomous_agent, review |
| `maxKnowledgeItems` | 20 | Max knowledge facts in context |
| `maxRecentSummaries` | 3 | Max recent summaries in context |
| `tokenBudget` | unlimited | Token cap for assembled context |
| `lexicalWeight` | 1.0 | Weight for FTS score |
| `semanticWeight` | 1.0 | Weight for embedding similarity |
| `recencyWeight` | 1.0 | Weight for access recency |
| `importanceWeight` | 0.25 | Weight for access frequency |
| `diversityPenalty` | 0.2 | Penalty for same-type clustering |

### MaintenancePolicy (Cleanup)

| Field | Default | Description |
|-------|---------|-------------|
| `workingMemoryTtlSeconds` | 30 days | TTL for working memory summaries |
| `completedWorkItemTtlSeconds` | 14 days | TTL for completed work items |
| `knowledgeStaleAfterSeconds` | 60 days | Knowledge staleness threshold |
| `minKnowledgeAccessCount` | 1 | Min accesses to avoid retirement |
| `maxActiveKnowledgeItems` | 500 | Hard cap on active knowledge |

## Embeddings

Enable semantic search by providing an embedding generator:

```typescript
import { createMemory } from 'memory-layer';
import { createSQLiteAdapterWithEmbeddings } from 'memory-layer';

const { adapter, embeddingAdapter } = createSQLiteAdapterWithEmbeddings('./memory.db');

const manager = createMemoryManager({
  adapter,
  embeddingAdapter,
  embeddingGenerator: async (texts) => {
    // Call your embedding API (OpenAI, Voyage, etc.)
    return texts.map(text => new Float32Array(/* vector */));
  },
  // ... other config
});
```

The `EmbeddingGenerator` type is `(texts: string[]) => Promise<Float32Array[]>`.

## Observability

### Event Hooks

```typescript
const memory = createMemory({
  onEvent: (event) => {
    console.log(`[${event.type}]`, event);
  },
});
```

### Typed Event Emitter

```typescript
import { createMemoryEventEmitter } from 'memory-layer';

const emitter = createMemoryEventEmitter();
emitter.on('compaction', (event) => { /* ... */ });
emitter.on('extraction', (event) => { /* ... */ });

const memory = createMemory({ eventEmitter: emitter });
```

### Content Redaction

```typescript
const memory = createMemory({
  redactText: ({ kind, text }) => {
    return text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]');
  },
});
```

## Failure Handling

Configure how summarization and extraction failures are handled:

```typescript
const memory = createMemoryManager({
  failurePolicy: {
    summarizer: 'retry_once',      // 'throw' | 'retry_once' | 'log_and_continue'
    extractor: 'log_and_continue', // + 'disable_auto_extract'
  },
  // ...
});
```

## Evals and CI

```bash
npm run lint               # Type check
npm test                   # Unit tests
npm run build              # Compile
npm run eval:retrieval     # Retrieval quality eval
npm run eval:scenarios     # Scenario continuity eval
npm run eval:gate          # Enforced eval gate (for CI)
npm run benchmark:search   # Search performance
npm run benchmark:semantic # Semantic search performance
npm run benchmark:compaction # Compaction performance
npm run pack:check         # Package verification
```

## Export / Import

```bash
node scripts/export-memory.mjs ./data/memory.db ./backup.json
node scripts/import-memory.mjs ./data/restored.db ./backup.json
```

## Examples

| Example | Pattern | Provider |
|---------|---------|----------|
| `examples/zero-config.ts` | Direct manager | Extractive |
| `examples/chat-assistant.ts` | Runtime hooks | Claude |
| `examples/ai-ide.ts` | Runtime + work items | OpenAI |
| `examples/autonomous-agent.ts` | wrapModelCall | Claude |
| `examples/tool-calling-agent.ts` | Tool schemas | OpenAI |
| `examples/mcp-server.ts` | MCP adapter | Claude |

## Notes

- Optional provider SDKs are dynamically imported
- `createSQLiteAdapter(':memory:')` is useful for tests
- Requires Node 20+
- MIT licensed
