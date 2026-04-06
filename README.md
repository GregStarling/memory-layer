<p align="center">
  <h1 align="center">memory-layer</h1>
  <p align="center">
    A cognitive memory architecture for AI systems.<br/>
    Interactions become summaries. Summaries become knowledge. Knowledge becomes context.<br/>
    Two lines to start. Enough architecture to scale.
  </p>
</p>

<p align="center">
  <a href="#why-it-stands-out">Why</a> &nbsp;&bull;&nbsp;
  <a href="#quick-start">Quick Start</a> &nbsp;&bull;&nbsp;
  <a href="#how-it-works">How It Works</a> &nbsp;&bull;&nbsp;
  <a href="#integrations">Integrations</a> &nbsp;&bull;&nbsp;
  <a href="#temporal-intelligence">Temporal</a> &nbsp;&bull;&nbsp;
  <a href="#multi-agent-coordination">Coordination</a> &nbsp;&bull;&nbsp;
  <a href="#python-client">Python</a> &nbsp;&bull;&nbsp;
  <a href="#api-reference">API</a> &nbsp;&bull;&nbsp;
  <a href="#configuration">Config</a>
</p>

---

Every AI system built today has the same blind spot: it forgets everything between sessions. Context vanishes. Learned preferences disappear. Mistakes repeat. The model is perpetually starting over.

**memory-layer** is a complete cognitive memory architecture — not a vector store, not a chat log, but a tiered system where conversations compress into summaries, summaries crystallize into trust-scored knowledge, and the most relevant memory is assembled into a token-budgeted context window on every call. It handles compaction, extraction, evidence grounding, contradiction detection, hybrid retrieval, multi-tenant scoping, temporal replay, and lifecycle management so you don't build any of it.

```typescript
import { createMemory } from 'ai-memory-layer';

const memory = createMemory();
```

That's a working memory system. No API keys. No infrastructure. No configuration.

---

## Why It Stands Out

- **Starts as a package, not an infrastructure project.** `createMemory()` works offline out of the box, then grows into SQLite, PostgreSQL, HTTP, or MCP without changing the core mental model.
- **Treats memory as evolving state, not just search results.** Turns compact into summaries, summaries promote into evidence-backed knowledge, and context assembly respects trust, scope, and token budget.
- **Keeps history, not just the latest projection.** Replay, diffs, streaming, and snapshots let you ask what changed and what the system knew at a specific time.
- **Built for real agent operations.** Multi-scope routing, work claims, handoffs, playbooks, profiles, and association graphs are first-class instead of bolted on later.

## When To Use It

Use `memory-layer` when:

- your agent needs durable preferences, constraints, and decisions across sessions
- you need temporal replay, auditability, or change streams
- multiple agents share workspace memory or coordinate on work
- you want one memory abstraction that can start embedded and later move behind HTTP or MCP

It is probably overkill when:

- you only need vector search over a document corpus
- a single chat transcript is enough and nothing needs to persist
- you do not need trust lifecycles, temporal semantics, or multi-agent coordination

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

await memory.learnFact(
  'Always use TypeScript strict mode in this project.',
  'constraint',
);

const ctx = await memory.getContext('typescript config');
// ctx.relevantKnowledge → [{ fact: "Use TypeScript strict mode", knowledge_class: "constraint", ... }]
```

For direct durable memory in one call, use `learnFact(...)`. Conversation-driven extraction also works, but durable knowledge appears after compaction rather than after a single exchange.

No API keys required. Uses a pure-JS extractive summarizer, heuristic fact extractor, and local embedding fallback out of the box.

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

When `OPENAI_API_KEY` or `VOYAGE_API_KEY` is present, `createMemory()` upgrades the embedding tier automatically. You keep the same integration code and can opt into provider summarization or extraction when you want higher-fidelity memory formation.

---

## How It Works

```
User Input ──> Turn Storage ──> Compaction ──> Working Memory
                                    │
                              Extraction ──> Knowledge Memory
                                    │               │
                              Association ──> Knowledge Graph
                                    │
                              Retrieval ──> Prompt-Ready Context
```

### Three-Tier Memory Architecture

Memory flows through three tiers, each optimized for a different time horizon — modeled on how durable memory actually forms:

| Tier | What It Stores | Lifecycle | Analogy |
|------|---------------|-----------|---------|
| **Short-term** (Turns) | Raw conversation exchanges | Until compacted | Working memory |
| **Medium-term** (Working Memory) | Summaries with entities and topic tags | Days to weeks | Episodic memory |
| **Long-term** (Knowledge) | Extracted facts with trust scores, evidence chains, and association graphs | Weeks to years | Semantic memory |

Turns accumulate until the compaction monitor fires (configurable thresholds for turn count, token budget, session gaps, and topic drift). The summarizer compresses them into a working memory summary. The extractor identifies durable facts — preferences, constraints, decisions, entities — and promotes them through a trust lifecycle before they become long-term knowledge.

### Knowledge Trust Lifecycle

Extracted facts aren't blindly trusted. Every fact earns its place through evidence:

```
candidate ──> provisional ──> trusted
                  │               │
                  └── disputed    └── superseded ──> retired
```

Promotion requires grounding in source turns, corroboration across sessions, or explicit user statements. Contradictions are detected automatically — conflicting facts are marked `disputed`, not silently overwritten. Every decision is audited: you can inspect why any fact was promoted, demoted, or retired via the evidence chain and knowledge audit log.

Facts are classified by type (`preference`, `constraint`, `entity`, `decision`, `reference`) and by knowledge class (`identity`, `preference`, `constraint`, `procedure`, `strategy`, `project_fact`, `anti_pattern`). Classification drives retrieval ranking, maintenance retention, and profile assembly.

### Hybrid Retrieval

When you call `getContext()`, the engine scores every candidate fact across eight dimensions:

- **Lexical** — full-text search relevance (FTS5 on SQLite, tsvector on Postgres)
- **Semantic** — vector similarity via embeddings (pgvector ANN, local cosine, or provider-backed)
- **Recency** — when the fact was last accessed
- **Trust** — knowledge state and confidence score
- **Class importance** — identity and constraint facts outrank episodic ones
- **Evidence density** — better-grounded facts rank higher
- **Scope affinity** — local facts rank higher than cross-scope; lineage scoring for branched scopes
- **Diversity** — penalizes clustering of same-type or same-slot results

Selected knowledge then seeds a **single-hop association expansion**: the top seeds' `supports` and `related_to` edges are traversed, and connected facts are pulled in ranked by confidence. The result is token-trimmed to budget (turns → summaries → playbooks → associated knowledge → core knowledge, in priority order) and returned as a structured `MemoryContext` ready to inject into any model call.

---

## Integrations

### Before/After Hooks (recommended)

```typescript
import { createMemory, createMemoryRuntime } from 'ai-memory-layer';

const manager = createMemory({ adapter: 'sqlite', path: './memory.db' });
const runtime = createMemoryRuntime(manager);

// Before the model call — assemble context
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

Handles the full cycle: context assembly, model call, turn storage, compaction, extraction, and work item tracking in one call.

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
// mcp.tools — tool definitions for memory_store_turn, memory_get_context,
//   memory_search, memory_learn_fact, memory_stream_changes, memory_snapshot, ...
```

Or run standalone:

```bash
npx memory-layer serve --transport mcp --db ./memory.db
```

Tool surface spanning turns, context, search, episodes, cognitive retrieval, playbooks, associations, coordination, temporal queries, maintenance, and snapshots.

### HTTP Service

```bash
npx memory-layer serve --transport http --db ./memory.db --port 3100
```

Full REST API documented in [`openapi.yaml`](openapi.yaml), with multi-tenant routing via scope headers, SSE event streaming, bearer auth, and admin key separation.

Important trust-model note: the built-in HTTP server treats a valid API key as one trust domain. Scope headers and query/body scope overrides are routing inputs, not tenant authorization boundaries. If you expose the server beyond localhost or a private service mesh, put tenant-aware auth in front of it.

---

## Surfaces

One memory engine, every access pattern:

| Surface | Best For | Start |
|---------|---------|-------|
| **Node package** | In-process agents, IDEs, autonomous loops | `import { createMemory } from 'ai-memory-layer'` |
| **HTTP API** | Polyglot services, hosted deployments | `npx memory-layer serve --transport http` |
| **MCP server** | Tool ecosystems, Claude Desktop, agent frameworks | `npx memory-layer serve --transport mcp` |
| **CLI** | Inspection, debugging, admin | `npx memory-layer inspect` |
| **Python client** | Python agents consuming the HTTP API | `pip install memory-layer-client` |

---

## Multi-Tenancy & Scoping

Every record belongs to a five-tuple scope that enables isolation and selective sharing across agents, projects, and organizations:

```typescript
const memory = createMemory({
  scope: {
    tenant_id: 'acme-corp',            // Organization boundary
    system_id: 'code-assistant',       // Which agent or system
    workspace_id: 'backend-repo',      // Shared project context
    collaboration_id: 'incident-7',    // Cross-system collaboration boundary
    scope_id: 'task-refactor-auth',    // This specific task or thread
  },
  crossScopeLevel: 'workspace',       // Read workspace-wide knowledge
});
```

### Cross-Scope Retrieval

```typescript
// Search across the workspace
const results = await memory.searchCrossScope('rate limiting', 'workspace');

// Poll for knowledge changes from other agents
const changes = await memory.pollForChanges(lastSyncTimestamp);
```

Retrieval levels: `scope` → `workspace` → `system` → `tenant`. Each level widens the knowledge pool while preserving ranking preference for local, high-trust facts.

### Visibility Classes

Items carry a visibility class (`private`, `shared_collaboration`, `workspace`, `tenant`) that controls what surfaces under each context view policy:

| View | Sees |
|------|------|
| `local_only` | Private items in the exact scope |
| `local_plus_shared_collaboration` | Private + collaboration-shared items |
| `workspace_shared` | Private + collaboration + workspace items |
| `operator_supervisor` | Everything including tenant-wide items |

---

## Temporal Intelligence

An append-only event log records every state change — turn created, knowledge promoted, work item claimed, fact disputed — with before/after payloads. This powers capabilities most memory systems can't offer:

### Point-in-Time Replay

```typescript
// What did the system know at 2pm yesterday?
const context = await memory.getContextAt(asOfTimestamp, 'deployment status');

// Full state snapshot at a past time
const state = await memory.getStateAt(asOfTimestamp);
// state.turns, state.knowledge, state.workItems, state.workClaims, state.handoffs, ...
```

Historical replay is exact after the replay cutover and best-effort before it. For exactness-sensitive flows, `getStateAt(...)` exposes whether the reconstruction is exact.

### Temporal Diffs

```typescript
// What changed between two timestamps?
const diff = await memory.diffState(fromTimestamp, toTimestamp);
// diff.summary.byEntityKind → { knowledge_memory: 3, work_item: 1 }
// diff.events → full event records
```

### Change Streaming

```typescript
// Real-time SSE stream of memory events
for await (const event of memory.streamChanges({ signal: controller.signal })) {
  console.log(event.event_type, event.entity_kind, event.entity_id);
}
```

### Consistent Snapshots

Snapshots pin a watermark event id before assembling context, then filter events by that watermark. Same-second writes that land during capture are excluded — the snapshot is a consistent cut of the event log.

---

## Multi-Agent Coordination

Built-in primitives for multi-agent workflows where agents need to share work, claim tasks, and hand off context:

### Work Items & Claims

```typescript
// Track work
const item = await memory.trackWorkItem('Deploy canary to us-east-1', 'objective', 'open');

// Claim it (lease-based, with automatic expiry)
const claim = await memory.claimWorkItem({
  workItemId: item.id,
  actor: { actor_kind: 'agent', actor_id: 'deployer', system_id: null, display_name: 'Deploy Bot', metadata: null },
  leaseSeconds: 600,
});

// Renew or release
await memory.renewWorkClaim(claim.id, claim.actor, 300);
await memory.releaseWorkClaim(claim.id, claim.actor, 'deployment complete');
```

### Handoffs

```typescript
// Hand off work between agents with context
const handoff = await memory.handoffWorkItem({
  workItemId: item.id,
  fromActor: deployBot,
  toActor: monitorBot,
  summary: 'Canary deployed. Monitor for 30min then promote.',
});

// Receiving agent accepts
await memory.acceptHandoff(handoff.id, monitorBot);
```

### Episodic & Cognitive Retrieval

```typescript
// Search across episodes (requires a structuredClient)
const episodes = await memory.searchEpisodes({ query: 'deployment failures', limit: 5 });

// Summarize a specific session
const recap = await memory.summarizeEpisode('session-xyz', { detailLevel: 'detailed' });

// Reflect across memory types
const reflection = await memory.reflect({ query: 'What patterns emerge from our deployments?' });

// Cognitive search (grouped by memory type)
const cognitive = await memory.searchCognitive({ query: 'rate limiting', limit: 10 });
```

### Playbooks

```typescript
// Create reusable procedures from experience
const playbook = await memory.createPlaybook({
  title: 'Canary Deployment Runbook',
  description: 'Step-by-step canary deployment with rollback gates',
  instructions: '1. Deploy to canary. 2. Monitor error rate. 3. ...',
  tags: ['deployment', 'canary'],
});

// Search for relevant playbooks during context assembly
const matches = await memory.searchPlaybooks('deployment procedure');

// Playbooks surface automatically in getContext() when relevant
```

### Profiles

```typescript
// Aggregate knowledge into a structured profile
const profile = await memory.getProfile({ view: 'user' });
// profile.sections → { identity: [...], preferences: [...], constraints: [...], ... }
```

### Association Graphs

```typescript
// Traverse the knowledge graph
const graph = await memory.traverseAssociations('knowledge', factId, { maxDepth: 2, maxNodes: 20 });
// graph.nodes, graph.edges — typed association graph with supports/contradicts/supersedes/related_to edges
```

---

## Configuration

### Presets

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

### Quality Tiers

`createMemory()` auto-detects your environment and resolves to the best available tier:

| Tier | Extraction | Retrieval | Requires |
|------|-----------|-----------|----------|
| **Offline default** | Regex + heuristic | Lexical + local embeddings | Nothing |
| **Local semantic** | Composite heuristic | Lexical + local TF-IDF embeddings | Nothing |
| **Provider-backed** | Claude/OpenAI LLM | Lexical + provider embeddings | API key |

The local path is fully functional offline. Provider-backed is the highest-quality tier when API access is available.

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

## API Reference

Most integrations only need a small slice of the surface:

- `createMemory()` or `createMemoryRuntime(manager)`
- `processExchange(...)` or `wrapModelCall(...)`
- `getContext(...)` or `getSessionBootstrap(...)`
- `learnFact(...)` for explicit durable memory
- `forceCompact()`, `runMaintenance()`, and `getRuntimeDiagnostics()` for operations

For the full transport contract, see [openapi.yaml](openapi.yaml). For the TypeScript surface, the package exports the types shown below.

<details>
<summary><strong>MemoryManager</strong> — full manager surface</summary>

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
  getSessionBootstrapAt(asOf, relevanceQuery?): Promise<SessionBootstrap>
  captureSnapshot(relevanceQuery?): Promise<SnapshotData>
  search(query, options?): Promise<{ turns, knowledge }>
  searchCrossScope(query, level, options?): Promise<{ knowledge }>
  recall(timeRange): Promise<{ turns, workingMemory, knowledge, workItems }>
  pollForChanges(since, options?): Promise<KnowledgeMemory[]>

  // --- Temporal ---
  getStateAt(asOf, options?): Promise<TemporalStateSnapshot>
  getTimeline(options?): Promise<TimelineResult>
  diffState(from, to, options?): Promise<TemporalStateDiff>
  listMemoryEvents(options?): Promise<TimelineResult>
  streamChanges(options?): AsyncIterable<MemoryEventRecord>

  // --- Knowledge ---
  learnFact(fact, factType, confidence?): Promise<KnowledgeMemory>
  inspectKnowledge(id): Promise<{ knowledge, evidence, audits }>
  listKnowledge(options?): Promise<PaginatedResult<KnowledgeMemory>>
  reverifyKnowledge(id): Promise<TrustAssessment>

  // --- Coordination ---
  trackWorkItem(title, kind?, status?, detail?): Promise<WorkItem>
  updateWorkItem(id, patch): Promise<WorkItem | null>
  claimWorkItem(input): Promise<WorkClaim>
  renewWorkClaim(claimId, actor, leaseSeconds?): Promise<WorkClaim | null>
  releaseWorkClaim(claimId, actor, reason?): Promise<WorkClaim | null>
  listWorkClaims(options?): Promise<WorkClaim[]>
  handoffWorkItem(input): Promise<HandoffRecord>
  acceptHandoff(id, actor): Promise<HandoffRecord | null>

  // --- Episodic & Cognitive ---
  searchEpisodes(options): Promise<EpisodeSummary[]>
  summarizeEpisode(sessionId, options?): Promise<EpisodeSummary>
  reflect(options): Promise<ReflectResult>
  searchCognitive(options): Promise<CognitiveSearchResult>

  // --- Playbooks ---
  createPlaybook(input): Promise<Playbook>
  searchPlaybooks(query): Promise<SearchResult<Playbook>[]>
  revisePlaybook(id, instructions, reason): Promise<{ playbook, revision }>

  // --- Profiles & Associations ---
  getProfile(options?): Promise<Profile>
  traverseAssociations(kind, id, options?): Promise<AssociationGraph>
  addAssociation(input): Promise<Association>
  removeAssociation(id): Promise<void>

  // --- System ---
  forceCompact(): Promise<CompactionResult | null>
  runMaintenance(policy?): Promise<MaintenanceReport>
  getRuntimeDiagnostics(): Promise<DiagnosticsReport>
  close(): Promise<void>
}
```
</details>

<details>
<summary><strong>MemoryRuntime</strong> — model-call integration hooks</summary>

Returned by `createMemoryRuntime(manager)`. Higher-level hooks for model call integration.

```typescript
interface MemoryRuntime {
  manager: MemoryManager;
  startSession(relevanceQuery?): Promise<{ bootstrap, bootstrapPrompt }>
  resumeSession(relevanceQuery?): Promise<{ bootstrap, bootstrapPrompt }>
  beforeModelCall(input): Promise<{
    bootstrap, context, bootstrapPrompt, prompt, messages
  }>
  afterModelCall(input): Promise<{ exchange, trackedWorkItems }>
  wrapModelCall(modelFn, input, actors?): Promise<{
    result, runtime, exchange, trackedWorkItems
  }>
  refreshSnapshot(): Promise<SessionSnapshot | null>
  getSnapshot(): SessionSnapshot | null
}
```
</details>

<details>
<summary><strong>MemoryContext</strong> — prompt-ready retrieval output</summary>

The structured object returned by `getContext()`. Ready for prompt injection.

```typescript
interface MemoryContext {
  mode: 'chat' | 'coding' | 'autonomous_agent' | 'review';
  activeTurns: Turn[];
  workingMemory: WorkingMemory | null;
  trustedCoreMemory: KnowledgeMemory[];
  taskRelevantKnowledge: KnowledgeMemory[];
  provisionalKnowledge: KnowledgeMemory[];
  disputedKnowledge: KnowledgeMemory[];
  relevantKnowledge: KnowledgeMemory[];
  associatedKnowledge: KnowledgeMemory[];
  recentSummaries: WorkingMemory[];
  currentObjective: string | null;
  sessionState: SessionState;
  activeObjectives: WorkItem[];
  unresolvedWork: string[];
  coordinationState: CoordinationState | null;
  relevantPlaybooks: Playbook[];
  knowledgeSelectionReasons: KnowledgeSelectionReason[];
  debugTrace: ContextDebugTrace;
  tokenEstimate: number;
}
```

</details>

---

## Python Client

```bash
pip install memory-layer-client
```

The Python client mirrors the full HTTP API surface. Run the Node service and point Python at it.

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

Async support:

```python
from memory_layer_client import AsyncMemoryClient, AsyncMemoryRuntimeClient

async with AsyncMemoryClient("http://localhost:3100") as client:
    runtime = AsyncMemoryRuntimeClient(client)
    result = await runtime.run_turn(user_input, model_call)
```

---

## Observability

### Event Hooks

```typescript
const memory = createMemory({
  onEvent: (event) => {
    // event.type: 'compaction' | 'extraction' | 'promotion' | 'retrieval' |
    //   'search' | 'maintenance' | 'capability' | 'knowledge_change' | 'context_assembly'
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
emitter.on('knowledge_change', (e) => audit.log(e.meta.action, e.meta.knowledgeId));

const memory = createMemory({ eventEmitter: emitter });
```

### PII Redaction

```typescript
const memory = createMemory({
  redactText: ({ kind, text }) =>
    text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]'),
});
```

### Circuit Breakers

Summarizer, extractor, and embedding subsystems each have independent circuit breakers. When a provider goes down, the system degrades gracefully — retrieval falls back to lexical-only, extraction disables auto-extract, and telemetry emits `degraded_mode` events so you can alert on it.

```typescript
const diagnostics = await memory.getRuntimeDiagnostics();
// diagnostics.circuitBreakers → { summarizer: { state, failures, ... }, extractor: ..., embeddings: ... }
```

---

## Storage Backends

| Backend | Best For | Install | Search |
|---------|---------|---------|--------|
| **In-memory** | Tests, prototypes | Built-in | Exact match |
| **SQLite** | Single-process production | `npm install better-sqlite3` | FTS5 + local embeddings |
| **PostgreSQL** | Multi-writer, hosted | `npm install pg` | tsvector + pgvector ANN |

SQLite is the zero-friction production path. PostgreSQL + pgvector is the scaling path with ANN indexing for high-volume semantic retrieval.

---

## Testing & Quality

Broad automated test coverage plus a behavioral eval gate keep the package honest before release.

```bash
npm test                                      # full test suite
npm run eval:memory-quality:enforce           # all 14 metrics must pass
npm run eval:memory-quality:delta:enforce     # must not regress from baseline
npm run release:check                         # full release gate
```

Release checks cover unit and integration tests, behavioral memory-quality evals, transport parity, platform proofs, and packaging validation.

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

## Docker

```bash
docker build -t memory-layer .
docker run --rm -p 3100:3100 -v "$(pwd)/data:/data" memory-layer
```

---

## Further Reading

- [Deployment Guide](docs/DEPLOYMENT.md) — embedded, HTTP, MCP, Docker
- [Integration Patterns](docs/INTEGRATIONS.md) — AI IDE, hosted service, autonomous agent, framework adapters
- [Operations Guide](docs/OPERATIONS.md) — monitoring, maintenance, scaling
- [Security Guide](docs/SECURITY.md) — trust model, auth boundaries, PII handling
- [Memory Quality Rubric](docs/MEMORY_QUALITY_RUBRIC.md) — the 14-metric eval framework
- [OpenAPI Spec](openapi.yaml) — full HTTP API contract
- [Changelog](CHANGELOG.md)

---

## Requirements

- **Node 20+**
- **MIT licensed**
- Optional provider SDKs (`@anthropic-ai/sdk`, `openai`, `better-sqlite3`, `pg`) are dynamically imported — zero hard dependencies beyond Node
