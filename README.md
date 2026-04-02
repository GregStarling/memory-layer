<p align="center">
  <h1 align="center">memory-layer</h1>
  <p align="center">
    Persistent memory for AI systems.<br/>
    Drop it into any agent, IDE, or autonomous loop.<br/>
    Two lines to remember. Zero lines to forget.
  </p>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &nbsp;&bull;&nbsp;
  <a href="#how-it-works">How It Works</a> &nbsp;&bull;&nbsp;
  <a href="#integration-patterns">Integrations</a> &nbsp;&bull;&nbsp;
  <a href="#python">Python</a> &nbsp;&bull;&nbsp;
  <a href="#api-reference">API</a> &nbsp;&bull;&nbsp;
  <a href="#configuration">Config</a> &nbsp;&bull;&nbsp;
  <a href="docs/ULTIMATE_MEMORY_LAYER_ROADMAP.md">Roadmap</a> &nbsp;&bull;&nbsp;
  <a href="docs/DEPLOYMENT.md">Deploy</a>
</p>

---

## The Problem

AI systems have no memory. Every session starts cold. Context vanishes. Learned preferences disappear. Mistakes repeat.

If you're building an autonomous agent, a coding assistant, or a dark-factory loop, the model forgets everything the moment the conversation ends. Bolting on memory means building compaction, extraction, trust scoring, retrieval, multi-tenant scoping, and lifecycle management from scratch.

**memory-layer** is that entire stack as a drop-in package.

```typescript
import { createMemory } from 'ai-memory-layer';

const memory = createMemory();
```

That's a working memory system. No API keys. No infrastructure. No configuration.

---

## Quick Start

### Install

```bash
npm install ai-memory-layer
```

### Zero-Config (in-memory, fully offline)

```typescript
import { createMemory } from 'ai-memory-layer';

const memory = createMemory();

await memory.processExchange(
  'Always use TypeScript strict mode in this project.',
  'Got it — TypeScript strict mode is now a stored constraint.',
);

// Later, in a new session or turn:
const ctx = await memory.getContext('typescript config');
// ctx.relevantKnowledge → [{ fact: "Use TypeScript strict mode", knowledge_class: "constraint", ... }]
```

No API keys required. Uses a pure-JS extractive summarizer, heuristic fact extractor, and local embedding fallback. Good enough to start. Upgrades automatically when provider credentials appear.

### Persistent (SQLite)

```bash
npm install better-sqlite3
```

```typescript
const memory = createMemory({
  adapter: 'sqlite',
  path: './data/memory.db',
  scope: 'my-agent',
});
```

Memory survives restarts. Same API. One line changed.

### Provider-Backed (strongest quality)

```bash
npm install openai  # or @anthropic-ai/sdk
```

```typescript
const memory = createMemory({
  adapter: 'sqlite',
  path: './data/memory.db',
  preset: 'autonomous_agent',
  qualityMode: 'high_fidelity_memory',
  summarizer: 'openai',
  extractor: 'openai',
});
```

When `OPENAI_API_KEY` or `VOYAGE_API_KEY` is present, `createMemory()` auto-upgrades to provider-backed embeddings. You don't have to change anything — the quality tier shifts silently.

---

## How It Works

```
User Input ──> Turn Storage ──> Compaction ──> Working Memory
                                    │
                              Extraction ──> Knowledge Memory
                                    │
                              Retrieval ──> Prompt-Ready Context
```

### Three-Tier Memory

Memory flows through three tiers, each optimized for a different time horizon:

| Tier | What It Stores | How Long It Lives |
|------|---------------|-------------------|
| **Short-term** (Turns) | Raw conversation exchanges | Until compacted |
| **Medium-term** (Working Memory) | Summaries with entities and topic tags | Days to weeks (TTL) |
| **Long-term** (Knowledge) | Extracted facts with trust scores and evidence | Weeks to years (lifecycle) |

### Knowledge Trust Lifecycle

Extracted facts aren't blindly trusted. Every fact has a state:

```
candidate ──> provisional ──> trusted
                  │               │
                  └── disputed    └── superseded ──> retired
```

Promotion requires evidence. A fact needs grounding in source turns, explicit user statements, tool verification, or repeated corroboration before it reaches `trusted`. Contradictions are detected and facts are marked `disputed` — not silently overwritten.

Every decision is audited. You can inspect why any fact was promoted, demoted, or retired.

### Hybrid Retrieval

When you call `getContext()`, the engine scores every candidate fact across multiple dimensions:

- **Lexical** — full-text search relevance
- **Semantic** — vector similarity (when embeddings are available)
- **Recency** — when the fact was last accessed
- **Trust** — knowledge state and confidence score
- **Class importance** — identity facts rank higher than episodic ones
- **Evidence density** — better-grounded facts rank higher
- **Scope relation** — local facts rank higher than cross-scope ones
- **Diversity** — penalizes clustering of same-type results

The result is a `MemoryContext` object ready to inject into any model call.

---

## Integration Patterns

### Before/After Hooks (recommended)

```typescript
import { createMemory, createMemoryRuntime } from 'ai-memory-layer';

const manager = createMemory({ adapter: 'sqlite', path: './memory.db' });
const runtime = createMemoryRuntime(manager);

// Before the model call — get context
const { prompt, messages } = await runtime.beforeModelCall(userInput);

// Call your model with enriched context
const result = await model.generate(prompt);

// After the model call — store the exchange, trigger compaction + extraction
await runtime.afterModelCall({ userInput, assistantOutput: result });
```

### Single-Line Wrapper

```typescript
const { result } = await runtime.wrapModelCall(
  (prepared) => model.generate(prepared.prompt),
  userInput,
);
```

`wrapModelCall` handles the full cycle: context assembly, model call, turn storage, compaction, extraction, and work item tracking.

### Claude Agent SDK

```typescript
import { wrapClaudeAgentModel } from 'ai-memory-layer';

const run = wrapClaudeAgentModel(runtime, ({ system, messages, tools }) =>
  client.messages.create({ model: 'claude-sonnet-4-20250514', system, messages, tools }),
);

const { result } = await run(userInput);
```

### OpenAI / Vercel AI / LangChain

```typescript
// OpenAI function tools
import { createOpenAIMemoryTools } from 'ai-memory-layer';
const tools = createOpenAIMemoryTools(runtime);

// Vercel AI SDK
import { wrapVercelAIModel } from 'ai-memory-layer';
const run = wrapVercelAIModel(runtime, ({ system, messages }) =>
  generateText({ system, messages }),
);

// LangChain memory bridge
import { createLangChainMemoryBridge } from 'ai-memory-layer';
const langchainMemory = createLangChainMemoryBridge(manager);
```

### Middleware (message-list passthrough)

```typescript
import { wrapWithMemory } from 'ai-memory-layer';

const handler = wrapWithMemory(
  (messages) => callModel(messages),
  manager,
  { injectContext: true, contextPosition: 'system' },
);
```

### MCP Server

```typescript
import { createMemoryMcpAdapter } from 'ai-memory-layer';

const mcp = createMemoryMcpAdapter(runtime);
// mcp.tools — tool definitions
// mcp.callTool(name, args) — dispatcher
```

Or run as a standalone MCP server:

```bash
npx memory-layer serve --transport mcp --db ./memory.db
```

### HTTP Service

For polyglot deployments, run memory-layer as a standalone HTTP service:

```bash
npx memory-layer serve --transport http --db ./memory.db --port 3100
```

Full REST API documented in [`openapi.yaml`](openapi.yaml). Supports multi-tenant routing via scope headers, event streaming via SSE, and API key authentication.

---

## Python

```bash
pip install memory-layer-client
```

The Python client mirrors the HTTP API surface. It's an HTTP client, not a second engine — run the Node service and point Python at it.

```python
from memory_layer_client import MemoryClient, MemoryRuntimeClient, MemoryScope

client = MemoryClient(
    "http://localhost:3100",
    default_scope=MemoryScope(
        tenant_id="acme",
        system_id="research-agent",
        scope_id="session-1",
    ),
)

runtime = MemoryRuntimeClient(client)

# Full before/after cycle with your model
result = runtime.run_turn(
    "What constraints apply to this project?",
    lambda prepared: call_model(prepared.context),
)

# Direct operations
client.learn_fact("Deployment target is AWS us-east-1", "constraint")
results = client.search("deployment")
context = client.get_context("deployment constraints")
```

Async support included:

```python
from memory_layer_client import AsyncMemoryClient, AsyncMemoryRuntimeClient

async with AsyncMemoryClient("http://localhost:3100") as client:
    runtime = AsyncMemoryRuntimeClient(client)
    result = await runtime.run_turn(user_input, model_call)
```

---

## Presets

Start with a preset. Override only when you need to.

| Preset | Designed For | Compaction | Cross-Scope | Knowledge TTL |
|--------|-------------|------------|-------------|---------------|
| `ai_ide` | Coding assistants, refactoring tools | Moderate (18/30 turns) | Workspace-shared | 14 days |
| `chat_agent` | Conversational agents, support bots | Balanced (14/24 turns) | Scope-local | 7 days |
| `autonomous_agent` | Dark factories, autonomous loops | Aggressive (10/18 turns) | Workspace-shared | 3 days |

```typescript
const memory = createMemory({ preset: 'autonomous_agent' });
```

### Quality Modes

Orthogonal to presets. Controls how aggressively the system trusts and retains knowledge.

| Mode | Trust Threshold | Retention | Best For |
|------|----------------|-----------|----------|
| `fast_adoption` | 0.55 | 60-day core | Prototyping, low-stakes agents |
| `balanced_memory` | 0.70 | 365-day core | Production default |
| `high_fidelity_memory` | 0.82 | 730-day core | Safety-critical, long-running systems |

```typescript
const memory = createMemory({
  preset: 'autonomous_agent',
  qualityMode: 'high_fidelity_memory',
});
```

---

## Quality Tiers

`createMemory()` auto-detects your environment and resolves to the best available tier:

| Tier | Extraction | Retrieval | Requires |
|------|-----------|-----------|----------|
| **Offline default** | Regex + heuristic | Lexical + local embeddings | Nothing |
| **Local semantic** | Composite heuristic | Lexical + local TF-IDF embeddings | Nothing |
| **Provider-backed** | Claude/OpenAI LLM | Lexical + provider embeddings | API key |

Pass `onEvent` to see which tier resolved at startup:

```typescript
const memory = createMemory({
  onEvent: (event) => {
    if (event.type === 'capability') {
      console.log(event.meta);
      // { qualityMode: 'balanced_memory', extractorTier: 'local_heuristic',
      //   embeddingTier: 'local_semantic', providerBacked: false }
    }
  },
});
```

The local path is an honest fallback — functional, not aspirational. Provider-backed is the gold standard for extraction and retrieval quality.

---

## Scoping & Multi-Tenancy

Every record belongs to a scope. Scopes enable isolation and selective sharing across agents, workspaces, and tenants.

```typescript
const memory = createMemory({
  scope: {
    tenant_id: 'acme-corp',         // Organization boundary
    system_id: 'code-assistant',    // Which agent
    workspace_id: 'backend-repo',   // Shared project context
    scope_id: 'task-refactor-auth', // This specific task
  },
  crossScopeLevel: 'workspace',    // Can read workspace-wide knowledge
});
```

### Cross-Scope Retrieval

```typescript
// Search across the workspace
const results = await memory.searchCrossScope('rate limiting', 'workspace');

// Poll for knowledge changes from other agents
const changes = await memory.pollForChanges(lastSyncTimestamp);
```

Retrieval levels: `scope` (exact match) → `workspace` → `system` → `tenant`

---

## API Reference

### MemoryManager

Returned by `createMemory()`, `createMemoryManager()`, and provider factories.

```typescript
interface MemoryManager {
  // --- Store ---
  processTurn(role, content, actor?): Promise<Turn>
  processExchange(userContent, assistantContent, actors?): Promise<{
    userTurn: Turn; assistantTurn: Turn; compactionResult: CompactionResult | null;
  }>

  // --- Retrieve ---
  getContext(relevanceQuery?): Promise<MemoryContext>
  getContextAt(asOf, relevanceQuery?): Promise<MemoryContext>
  getSessionBootstrap(relevanceQuery?): Promise<SessionBootstrap>
  search(query, options?): Promise<{ turns, knowledge }>
  searchCrossScope(query, level, options?): Promise<{ knowledge }>
  recall(timeRange): Promise<{ turns, workingMemory, knowledge, workItems }>
  pollForChanges(since, options?): Promise<KnowledgeMemory[]>

  // --- Knowledge ---
  learnFact(fact, factType, confidence?): Promise<KnowledgeMemory>
  trackWorkItem(title, kind?, status?, detail?): Promise<WorkItem>
  inspectKnowledge(id): Promise<{ knowledge, evidence, audits }>
  listKnowledge(options?): Promise<PaginatedResult<KnowledgeMemory>>

  // --- System ---
  forceCompact(): Promise<CompactionResult | null>
  runMaintenance(policy?): Promise<MaintenanceReport>
  runReverification(options?): Promise<{ reverifiedIds, demotedIds }>
  close(): Promise<void>
}
```

### MemoryRuntime

Returned by `createMemoryRuntime(manager)`. Higher-level hooks for model call integration.

```typescript
interface MemoryRuntime {
  startSession(relevanceQuery?): Promise<{ bootstrap, bootstrapPrompt }>
  resumeSession(relevanceQuery?): Promise<{ bootstrap, bootstrapPrompt }>
  beforeModelCall(input): Promise<{
    bootstrap, context, bootstrapPrompt, prompt, messages
  }>
  afterModelCall(input): Promise<{ exchange, trackedWorkItems }>
  wrapModelCall(modelFn, input, actors?): Promise<{
    result, runtime, exchange, trackedWorkItems
  }>
}
```

### MemoryContext

The structured object returned by `getContext()`. Ready for prompt injection.

```typescript
interface MemoryContext {
  mode: 'chat' | 'coding' | 'autonomous_agent' | 'review';
  activeTurns: Turn[];
  workingMemory: WorkingMemory | null;
  trustedCoreMemory: KnowledgeMemory[];      // High-confidence, durable facts
  taskRelevantKnowledge: KnowledgeMemory[];   // Matched to current query
  provisionalKnowledge: KnowledgeMemory[];    // Not yet fully trusted
  disputedKnowledge: KnowledgeMemory[];       // Contradicted facts
  relevantKnowledge: KnowledgeMemory[];       // All selected facts
  recentSummaries: WorkingMemory[];
  currentObjective: string | null;
  activeObjectives: WorkItem[];
  unresolvedWork: string[];
  knowledgeSelectionReasons: KnowledgeSelectionReason[];
  tokenEstimate: number;
}
```

---

## Configuration

### createMemory() Options

```typescript
createMemory({
  // Storage
  adapter?: 'sqlite' | 'memory' | StorageAdapter,
  path?: string,

  // Identity
  scope?: string | MemoryScope,
  sessionId?: string,

  // Behavior
  preset?: 'ai_ide' | 'chat_agent' | 'autonomous_agent',
  qualityMode?: 'fast_adoption' | 'balanced_memory' | 'high_fidelity_memory',

  // Components (auto-resolved if omitted)
  summarizer?: 'extractive' | 'claude' | 'openai' | Summarizer,
  extractor?: 'regex' | 'heuristic' | 'claude' | 'openai' | Extractor | false,
  embeddingGenerator?: 'local' | EmbeddingGenerator | false,

  // Fine-tuning (partial overrides merge with preset/quality defaults)
  policies?: {
    monitor?: Partial<MonitorPolicy>,
    extraction?: Partial<ExtractionPolicy>,
    context?: Partial<ContextPolicy>,
    maintenance?: Partial<MaintenancePolicy>,
  },

  // Automation
  autoCompact?: boolean,        // default: true
  autoExtract?: boolean,        // default: true (when extractor present)
  crossScopeLevel?: ScopeLevel,

  // Observability
  logger?: Logger,
  onEvent?: EventHook,
  redactText?: (input: { kind: string; text: string }) => string,

  // Resilience
  failurePolicy?: {
    summarizer?: 'throw' | 'retry_once' | 'log_and_continue',
    extractor?: 'throw' | 'retry_once' | 'log_and_continue' | 'disable_auto_extract',
  },
})
```

### Policy Reference

<details>
<summary><strong>MonitorPolicy</strong> — when compaction triggers</summary>

| Field | Default | Description |
|-------|---------|-------------|
| `softTurnThreshold` | 15 | Turns before soft compaction is considered |
| `hardTurnThreshold` | 30 | Turns that force compaction |
| `softTokenThreshold` | 3000 | Token estimate for soft trigger |
| `hardTokenThreshold` | 6000 | Token estimate that forces compaction |
| `softRetainTurns` | 12 | Turns to keep after soft compaction |
| `hardRetainTurns` | 8 | Turns to keep after hard compaction |
| `intraSessionGapSeconds` | 1800 | Idle gap that triggers session_gap compaction |

</details>

<details>
<summary><strong>ExtractionPolicy</strong> — how facts are extracted and promoted</summary>

| Field | Default | Description |
|-------|---------|-------------|
| `autoExtractAfterCompaction` | true | Run extraction after each compaction |
| `maxFactsPerExtraction` | 10 | Max facts per compaction cycle |
| `deduplicateFacts` | true | Deduplicate against existing knowledge |
| `minConfidenceForPromotion` | `'medium'` | Minimum confidence for storage |
| `trustPromotionThreshold` | 0.7 | Score required for `trusted` state |
| `contradictionDisputeThreshold` | 0.35 | Score that marks facts `disputed` |
| `requireGroundingForTrusted` | true | Require evidence in source turns |
| `conflictStrategy` | `'supersede'` | How to handle conflicting facts |

</details>

<details>
<summary><strong>ContextPolicy</strong> — how knowledge is selected for prompts</summary>

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `'chat'` | Scoring profile: `chat`, `coding`, `autonomous_agent`, `review` |
| `maxKnowledgeItems` | 20 | Max facts in assembled context |
| `maxRecentSummaries` | 3 | Max summaries in context |
| `tokenBudget` | unlimited | Token cap for context |
| `lexicalWeight` | 1.0 | Full-text search weight |
| `semanticWeight` | 1.0 | Embedding similarity weight |
| `recencyWeight` | 1.0 | Access recency weight |
| `trustWeight` | 1.3 | Knowledge confidence weight |
| `importanceWeight` | 0.25 | Access frequency weight |
| `diversityPenalty` | 0.2 | Same-type clustering penalty |

</details>

<details>
<summary><strong>MaintenancePolicy</strong> — data lifecycle and cleanup</summary>

| Field | Default | Description |
|-------|---------|-------------|
| `workingMemoryTtlSeconds` | 30 days | Summary expiry |
| `completedWorkItemTtlSeconds` | 14 days | Completed work item cleanup |
| `knowledgeStaleAfterSeconds` | 60 days | Knowledge staleness threshold |
| `minKnowledgeAccessCount` | 1 | Minimum accesses to avoid retirement |
| `maxActiveKnowledgeItems` | 500 | Hard cap on active knowledge |
| `reverificationCadenceDays` | 30 | Days between reverification checks |
| `trustedCoreRetentionDays` | 365 | Retention for identity/preference/constraint |
| `provisionalRetentionDays` | 7 | Retention for provisional facts |

</details>

---

## Observability

### Event Hooks

```typescript
const memory = createMemory({
  onEvent: (event) => {
    // event.type: 'compaction' | 'extraction' | 'promotion' | 'retrieval' |
    //             'search' | 'maintenance' | 'capability' | 'knowledge_change'
    console.log(`[${event.type}] scope=${event.scope.scope_id} duration=${event.durationMs}ms`);
  },
});
```

### Typed Event Emitter

```typescript
import { createMemoryEventEmitter } from 'ai-memory-layer';

const emitter = createMemoryEventEmitter();
emitter.on('compaction', (e) => metrics.track('compaction', e.durationMs));
emitter.on('extraction', (e) => metrics.track('facts_extracted', e.meta.factCount));

const memory = createMemory({ eventEmitter: emitter });
```

### PII Redaction

```typescript
const memory = createMemory({
  redactText: ({ kind, text }) =>
    text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]'),
});
```

---

## Surfaces

One memory engine, multiple access patterns:

| Surface | Best For | How to Start |
|---------|---------|-------------|
| **Node package** | In-process agents, IDEs | `import { createMemory } from 'ai-memory-layer'` |
| **HTTP API** | Polyglot services, hosted deployments | `npx memory-layer serve --transport http` |
| **MCP server** | Tool ecosystems that speak MCP | `npx memory-layer serve --transport mcp` |
| **CLI** | Inspection, admin, debugging | `npx memory-layer inspect` |
| **Python client** | Python agents consuming the HTTP API | `pip install memory-layer-client` |

The Node package is the source of truth. HTTP mirrors it over REST ([`openapi.yaml`](openapi.yaml)). MCP and CLI are operational wrappers. The Python client follows the HTTP contract.

---

## Storage

| Backend | Best For | Install |
|---------|---------|---------|
| **In-memory** | Tests, prototypes, zero-friction | Built-in |
| **SQLite** | Single-process production, local agents | `npm install better-sqlite3` |
| **PostgreSQL + pgvector** | Multi-writer, hosted, high-volume | `npm install pg` |

SQLite is the low-friction path. Postgres + pgvector is the strongest scaling path with ANN indexing for semantic retrieval.

---

## Embeddings

```typescript
// Auto-resolved: local heuristic if no API key, OpenAI/Voyage if key present
const memory = createMemory(); // just works

// Explicit local (offline, pure-JS)
const memory = createMemory({ embeddingGenerator: 'local' });

// Explicit provider
import { createOpenAIEmbeddingGenerator } from 'ai-memory-layer';
const memory = createMemory({
  embeddingGenerator: createOpenAIEmbeddingGenerator({ apiKey: process.env.OPENAI_API_KEY }),
});

// Custom
const memory = createMemory({
  embeddingGenerator: async (texts) => texts.map(t => new Float32Array(/* your vectors */)),
});
```

Built-in resilience for provider embeddings: `withRetry()`, `batchedGenerate()`, `createCachedEmbeddingGenerator()`.

---

## Testing & Evals

### Unit Tests

```bash
npm test                          # 257 test cases across 30+ files
npm run test:coverage             # with coverage reporting
```

### Memory Quality Gate

A 14-metric behavioral eval suite that acts as a hard release gate:

```bash
npm run eval:memory-quality:enforce       # all 14 metrics must pass
npm run eval:memory-quality:delta:enforce  # must not regress from baseline
```

Metrics include: constraint retention, preference retention, identity retention, update correctness, false memory rate, contradiction resolution, trusted memory precision/recall, scope isolation, compaction fidelity, and maintenance fidelity.

Current baseline: **100/100** on all 14 metrics.

### Full Release Gate

```bash
npm run release:check
```

Runs: lint, test coverage, retrieval eval, scenario eval, memory quality gate, delta regression check, Python client checks, platform quality proof (HTTP + Node CLI + Python CLI), and package validation.

---

## Docker

```bash
docker build -t memory-layer .
docker run --rm -p 3100:3100 -v "$(pwd)/data:/data" memory-layer
```

---

## Examples

| Example | What It Shows |
|---------|--------------|
| [`zero-config.ts`](examples/zero-config.ts) | Ephemeral memory, no setup |
| [`chat-assistant.ts`](examples/chat-assistant.ts) | Claude-backed conversation agent |
| [`ai-ide.ts`](examples/ai-ide.ts) | OpenAI-backed coding assistant with work items |
| [`autonomous-agent.ts`](examples/autonomous-agent.ts) | Claude agent wrapper with work item inference |
| [`dark-factory.ts`](examples/dark-factory.ts) | Autonomous loop with streaming and maintenance |
| [`tool-calling-agent.ts`](examples/tool-calling-agent.ts) | OpenAI/Claude tool schemas |
| [`mcp-server.ts`](examples/mcp-server.ts) | MCP tool adapter |
| [`hosted-service.ts`](examples/hosted-service.ts) | Standalone HTTP service |
| [`vercel-ai.ts`](examples/vercel-ai.ts) | Vercel AI SDK wrapper |
| [`langchain.ts`](examples/langchain.ts) | LangChain memory bridge |
| [`multi-agent-postgres.ts`](examples/multi-agent-postgres.ts) | Shared Postgres memory across agents |
| [`python-client/agent.py`](examples/python-client/agent.py) | Python agent consuming HTTP API |

---

## Export / Import

```bash
node scripts/export-memory.mjs ./data/memory.db ./backup.json
node scripts/import-memory.mjs ./data/restored.db ./backup.json
```

---

## Further Reading

- [Deployment Guide](docs/DEPLOYMENT.md) — embedded, HTTP, MCP, Docker
- [Integration Patterns](docs/INTEGRATIONS.md) — AI IDE, hosted service, autonomous agent, framework adapters
- [Memory Quality Rubric](docs/MEMORY_QUALITY_RUBRIC.md) — the 14-metric eval framework
- [Release Gate](docs/MEMORY_QUALITY_RELEASE_GATE.md) — how quality gates enforce the baseline
- [OpenAPI Spec](openapi.yaml) — full HTTP API contract
- [Security Guide](docs/SECURITY.md)

---

## Requirements

- Node 20+
- MIT licensed
- Optional provider SDKs are dynamically imported — no hard dependencies on `@anthropic-ai/sdk`, `openai`, `better-sqlite3`, or `pg`
