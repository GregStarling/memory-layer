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
  <a href="#knowledge-intelligence">Knowledge Intelligence</a> &nbsp;&bull;&nbsp;
  <a href="#context-governance">Governance</a> &nbsp;&bull;&nbsp;
  <a href="#api-reference">API</a>
</p>

---

Every AI system built today has the same blind spot: it forgets everything between sessions. Context vanishes. Preferences disappear. Mistakes repeat.

**memory-layer** is a complete cognitive memory architecture. Conversations compress into summaries, summaries crystallize into trust-scored knowledge, and the most relevant memory is assembled into a token-budgeted context window on every call. It handles compaction, extraction, evidence grounding, contradiction detection, hybrid retrieval, multi-tenant scoping, temporal replay, governance, and lifecycle management so you don't build any of it.

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
- **Built for real agent operations.** Multi-scope routing, work claims, handoffs, playbooks, profiles, association graphs, and context governance are first-class.
- **Knowledge improves itself.** Reflection detects patterns, clustering finds communities, linting catches quality issues, and derivation generates playbooks and rules from experience.

## When To Use It

Use `memory-layer` when your agent needs durable preferences and decisions across sessions, temporal replay and auditability, multi-agent coordination, or a memory abstraction that can start embedded and later move behind HTTP or MCP.

It is probably overkill when you only need vector search over a document corpus, a single chat transcript with no persistence, or no trust lifecycles or coordination.

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
// ctx.relevantKnowledge -> [{ fact: "Use TypeScript strict mode", knowledge_class: "constraint", ... }]
```

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

When `OPENAI_API_KEY` or `VOYAGE_API_KEY` is present, `createMemory()` upgrades the embedding tier automatically. Provider summarization and extraction produce higher-fidelity memory formation.

---

## How It Works

```
User Input --> Turn Storage --> Compaction --> Working Memory
                                    |
                              Extraction --> Knowledge Memory
                                    |               |
                              Association --> Knowledge Graph
                                    |
                              Retrieval --> Prompt-Ready Context
```

### Three-Tier Memory Architecture

Memory flows through three tiers, each optimized for a different time horizon:

| Tier | What It Stores | Lifecycle | Analogy |
|------|---------------|-----------|---------|
| **Short-term** (Turns) | Raw conversation exchanges | Until compacted | Working memory |
| **Medium-term** (Working Memory) | Summaries with entities and topic tags | Days to weeks | Episodic memory |
| **Long-term** (Knowledge) | Extracted facts with trust scores, evidence chains, and association graphs | Weeks to years | Semantic memory |

Turns accumulate until the compaction monitor fires. The summarizer compresses them into working memory. The extractor identifies durable facts and promotes them through a trust lifecycle before they become long-term knowledge.

### Knowledge Trust Lifecycle

Extracted facts aren't blindly trusted. Every fact earns its place through evidence:

```
candidate --> provisional --> trusted
                  |               |
                  +-- disputed    +-- superseded --> retired
```

Promotion requires grounding in source turns, corroboration across sessions, or explicit user statements. Contradictions are detected automatically. Every decision is audited via the evidence chain and knowledge audit log.

Facts are classified by type (`preference`, `constraint`, `entity`, `decision`, `reference`) and by knowledge class (`identity`, `preference`, `constraint`, `procedure`, `strategy`, `project_fact`, `anti_pattern`). Classification drives retrieval ranking, maintenance retention, and profile assembly.

### Hybrid Retrieval

`getContext()` scores every candidate fact across eight dimensions: lexical relevance, semantic similarity, recency, trust score, class importance, evidence density, scope affinity, and diversity. Selected knowledge seeds a single-hop association expansion, then the result is token-trimmed to budget and returned as a structured `MemoryContext` ready for prompt injection.

---

## Integrations

### Before/After Hooks (recommended)

```typescript
const runtime = createMemoryRuntime(manager);

const { prompt, messages } = await runtime.beforeModelCall(userInput);
const result = await model.generate(prompt);
await runtime.afterModelCall({ userInput, assistantOutput: result });
```

### Single-Line Wrapper

```typescript
const { result } = await runtime.wrapModelCall(
  (prepared) => model.generate(prepared.prompt),
  userInput,
);
```

### Framework Adapters

```typescript
// Claude Agent SDK
const run = wrapClaudeAgentModel(runtime, ({ system, messages, tools }) =>
  client.messages.create({ model: 'claude-sonnet-4-20250514', system, messages, tools }),
);

// OpenAI function tools
const tools = createOpenAIMemoryTools(runtime);

// Vercel AI SDK
const run = wrapVercelAIModel(runtime, ({ system, messages }) =>
  generateText({ system, messages }),
);

// LangChain memory bridge
const langchainMemory = createLangChainMemoryBridge(manager);

// Middleware (message-list passthrough)
const handler = wrapWithMemory((messages) => callModel(messages), manager);
```

### MCP Server

```typescript
const mcp = createMemoryMcpAdapter(runtime);
// Or run standalone:
```

```bash
npx memory-layer serve --transport mcp --db ./memory.db
```

### HTTP Service

```bash
npx memory-layer serve --transport http --db ./memory.db --port 3100
```

Full REST API documented in [`openapi.yaml`](openapi.yaml), with multi-tenant routing, SSE event streaming, bearer auth, and admin key separation.

---

## Surfaces

| Surface | Best For | Start |
|---------|---------|-------|
| **Node package** | In-process agents, IDEs, autonomous loops | `import { createMemory } from 'ai-memory-layer'` |
| **HTTP API** | Polyglot services, hosted deployments | `npx memory-layer serve --transport http` |
| **MCP server** | Tool ecosystems, Claude Desktop, agent frameworks | `npx memory-layer serve --transport mcp` |
| **CLI** | Inspection, debugging, admin | `npx memory-layer inspect` |
| **Python client** | Python agents consuming the HTTP API | `pip install memory-layer-client` |

---

## Multi-Tenancy & Scoping

Every record belongs to a five-tuple scope that enables isolation and selective sharing:

```typescript
const memory = createMemory({
  scope: {
    tenant_id: 'acme-corp',
    system_id: 'code-assistant',
    workspace_id: 'backend-repo',
    collaboration_id: 'incident-7',
    scope_id: 'task-refactor-auth',
  },
  crossScopeLevel: 'workspace',
});
```

### Cross-Scope Retrieval

```typescript
const results = await memory.searchCrossScope('rate limiting', 'workspace');

let cursor = await memory.resolveChangeStreamCursor();
const page = await memory.listKnowledgeChanges({ cursor, scopeLevel: 'workspace' });
cursor = page.nextCursor;
```

Retrieval levels: `scope` -> `workspace` -> `system` -> `tenant`. Each level widens the knowledge pool while preserving ranking preference for local, high-trust facts.

### Visibility Classes

Items carry a visibility class (`private`, `shared_collaboration`, `workspace`, `tenant`) controlling what surfaces under each view policy: `local_only`, `local_plus_shared_collaboration`, `workspace_shared`, and `operator_supervisor`.

---

## Temporal Intelligence

An append-only event log records every state change with before/after payloads.

### Point-in-Time Replay

```typescript
const context = await memory.getContextAt(asOfTimestamp, 'deployment status');
const state = await memory.getStateAt(asOfTimestamp);
```

### Temporal Diffs

```typescript
const diff = await memory.diffState(fromTimestamp, toTimestamp);
// diff.summary.byEntityKind -> { knowledge_memory: 3, work_item: 1 }
```

### Change Streaming

```typescript
for await (const event of memory.streamChanges({ signal: controller.signal })) {
  console.log(event.event_type, event.entity_kind, event.entity_id);
}
```

### Consistent Snapshots

Snapshots pin a watermark event id before assembling context, ensuring a consistent cut of the event log.

---

## Multi-Agent Coordination

### Work Items & Claims

```typescript
const item = await memory.trackWorkItem('Deploy canary to us-east-1', 'objective', 'open');

const claim = await memory.claimWorkItem({
  workItemId: item.id,
  actor: { actor_kind: 'agent', actor_id: 'deployer', system_id: null, display_name: 'Deploy Bot', metadata: null },
  leaseSeconds: 600,
});

await memory.renewWorkClaim(claim.id, claim.actor, 300);
await memory.releaseWorkClaim(claim.id, claim.actor, 'deployment complete');
```

### Handoffs

```typescript
const handoff = await memory.handoffWorkItem({
  workItemId: item.id,
  fromActor: deployBot,
  toActor: monitorBot,
  summary: 'Canary deployed. Monitor for 30min then promote.',
});
await memory.acceptHandoff(handoff.id, monitorBot);
```

### Episodic & Cognitive Retrieval

```typescript
const episodes = await memory.searchEpisodes({ query: 'deployment failures', limit: 5 });
const recap = await memory.summarizeEpisode('session-xyz', { detailLevel: 'detailed' });
const reflection = await memory.reflect({ query: 'What patterns emerge from our deployments?' });
const cognitive = await memory.searchCognitive({ query: 'rate limiting', limit: 10 });
```

### Playbooks

```typescript
const playbook = await memory.createPlaybook({
  title: 'Canary Deployment Runbook',
  description: 'Step-by-step canary deployment with rollback gates',
  instructions: '1. Deploy to canary. 2. Monitor error rate. 3. ...',
  tags: ['deployment', 'canary'],
});
// Playbooks surface automatically in getContext() when relevant
```

### Profiles & Association Graphs

```typescript
const profile = await memory.getProfile({ view: 'user' });
const graph = await memory.traverseAssociations('knowledge', factId, { maxDepth: 2, maxNodes: 20 });
```

---

## Knowledge Intelligence

Beyond storage and retrieval, memory-layer actively analyzes, improves, and curates the knowledge it holds.

### Reflection & Derivation

```typescript
// Detect patterns across the knowledge base
const reflection = await memory.reflect({ query: 'What recurring issues appear in deployments?' });

// Generate playbook candidates, coding rules, and anti-patterns from patterns
const derived = await memory.derive({ reflection });
```

### Graph Analysis & Clustering

```typescript
// Community detection in the knowledge association graph
const clusters = computeClusters(associations, knowledge);

// Full topology report: density, bridges, centrality, critical facts
const report = await memory.getGraphReport({ sections: ['topology', 'bridges', 'critical'] });
```

### Core Memory

```typescript
// Extract the essential knowledge subset that should always appear in context
const core = await getCoreMemory(adapter, scope, { overflowStrategy: 'truncate' });
```

### Knowledge Linting

```typescript
// Quality analysis: orphans, trust skew, evidence concentration, contradiction clusters, stale provisionals
const lint = await lintKnowledge(adapter, scope);
// lint.issues -> [{ type: 'orphan_knowledge', severity: 'warning', ... }, ...]
```

### Aliases & Entity Resolution

```typescript
const candidates = discoverAliasCandidates(knowledge);
const resolved = resolveAliases(knowledge, aliasMap);
```

### Ontology Validation

```typescript
const violations = checkOntologyViolations(facts, ontology);
const validation = validateExtractedFacts(extracted);
```

### Curation Workflow

```typescript
const summary = await memory.getCurationSummary();
// summary.actions -> [{ type: 'promotion', knowledgeId: 42, source: 'maintenance', ... }]
```

### Document Ingestion

```typescript
// Refresh knowledge from source documents with content-hash deduplication
const result = memory.refreshDocuments([
  { title: 'API Guidelines', contentHash: 'abc123', content: '...' },
]);
```

### Bundle Import/Export

```typescript
const bundle = memory.exportBundle('backup-2024', { includeTurns: true });
const result = memory.importBundle(bundle, { conflictStrategy: 'keep_existing' });
```

### Markdown Export

```typescript
const md = await memory.exportAsMarkdown({ groupBy: 'class', includeEvidence: true });
// md.markdown -> human-readable knowledge dump
```

---

## Context Governance

Use context contracts when different agents should see different slices of the same memory graph. Governance state is durable — contracts, invariants, and escalation policies persist to SQLite and survive restarts.

### Contracts & Invariants at Config Time

```typescript
const memory = createMemory({
  preset: 'ai_ide',
  contextContracts: {
    planner: {
      view: 'workspace_shared',
      crossScopeLevel: 'workspace',
      knowledgeClasses: ['constraint', 'procedure', 'strategy'],
      minimumTrustScore: 0.75,
      includeCoordinationState: true,
    },
    executor: {
      view: 'local_only',
      crossScopeLevel: 'scope',
      knowledgeClasses: ['constraint', 'procedure'],
      minimumTrustScore: 0.8,
    },
  },
  invariants: [
    {
      id: 'prod-data',
      title: 'Production data safety',
      instruction: 'Never delete production data without explicit approval.',
      severity: 'critical',
      scopeLevel: 'workspace',
    },
  ],
});

const plannerCtx = await memory.getContext('rollback plan', { contract: 'planner' });
const executorCtx = await memory.getContext('apply rollback', { contract: 'executor' });
```

Contracts bundle visibility, scope widening, knowledge class filters, trust thresholds, and token budgets into reusable lenses. Invariants are injected separately from ranked retrieval and prioritized by severity during token trimming.

### Runtime Management

Governance can also be managed at runtime instead of baking it into constructor config:

```typescript
await memory.putContextContract('executor', {
  tokenBudget: 2000,
  knowledgeClasses: ['constraint'],
});

await memory.putContextInvariant({
  id: 'english-only',
  title: 'Language',
  instruction: 'All responses must be in English.',
  severity: 'important',
});

await memory.setContextEscalationPolicy({
  defaultDecision: 'allow',
  byChange: { increase_token_budget: 'deny', broaden_view: 'review' },
  maxTokenBudget: 5000,
  maxView: 'workspace_shared',
});

// Read current state
const governance = await memory.getContextGovernance();

// Clean up
await memory.deleteContextContract('executor');
await memory.deleteContextInvariant('english-only');
```

### Escalation Requests

When an agent is blocked, it can request a broader contract:

```typescript
const expansion = await memory.requestContextExpansion(
  {
    reason: 'missing_workspace_context',
    note: 'Need the shared rollback procedure.',
    contract: { view: 'workspace_shared', crossScopeLevel: 'workspace' },
  },
  { currentContract: 'executor' },
);
// expansion.decision: 'approved' | 'requires_approval' | 'denied'
// expansion.changeKinds, expansion.warnings, expansion.rationale
```

### Transport Endpoints

- **HTTP**: `GET /v1/context/config`, `PUT/DELETE` for `/v1/context/config/default-contract`, `/contracts/:name`, `/invariants/:id`, `/escalation-policy`. POST `/v1/context/request` for escalation. Admin key required for mutations.
- **MCP**: `memory_get_context_config`, `memory_put_context_contract`, `memory_delete_context_contract`, `memory_put_context_invariant`, `memory_delete_context_invariant`, `memory_set_context_escalation_policy`, `memory_request_context`

Assembled contexts expose `appliedContract`, `warnings`, and `degradedContext` so callers can tell when governance filtered the context or when token pressure forced material out.

---

## Configuration

### Presets

| Preset | Designed For | Compaction | Cross-Scope | Knowledge TTL |
|--------|-------------|------------|-------------|---------------|
| `ai_ide` | Coding assistants, refactoring tools | Moderate (18/30 turns) | Workspace-shared | 14 days |
| `chat_agent` | Conversational agents, support bots | Balanced (14/24 turns) | Scope-local | 7 days |
| `autonomous_agent` | Dark factories, autonomous loops | Aggressive (10/18 turns) | Workspace-shared | 3 days |

### Quality Modes

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

### Tunable Policies

Four policy objects give fine-grained control over compaction thresholds, extraction behavior, context scoring weights, and maintenance lifecycles. See the `MonitorPolicy`, `ExtractionPolicy`, `ContextPolicy`, and `MaintenancePolicy` types for the full surface. Presets configure sensible defaults; override individual fields when you need to.

---

## API Reference

<details>
<summary><strong>MemoryManager</strong> — full surface</summary>

```typescript
interface MemoryManager {
  // Store
  processTurn(role, content, actor?): Promise<Turn>
  processExchange(userContent, assistantContent, actors?): Promise<{ userTurn; assistantTurn; compactionResult }>

  // Retrieve
  getContext(relevanceQuery?, options?): Promise<MemoryContext>
  getContextAt(asOf, relevanceQuery?, options?): Promise<MemoryContext>
  getSessionBootstrap(relevanceQuery?, options?): Promise<SessionBootstrap>
  getSessionBootstrapAt(asOf, relevanceQuery?, options?): Promise<SessionBootstrap>
  captureSnapshot(relevanceQuery?, options?): Promise<SnapshotData>
  search(query, options?): Promise<{ turns, knowledge }>
  searchCrossScope(query, level, options?): Promise<{ knowledge }>
  listKnowledgeChanges(options?): Promise<{ changes, nextCursor }>
  recall(timeRange): Promise<{ turns, workingMemory, knowledge, workItems }>

  // Governance
  requestContextExpansion(request, options?): Promise<ContextRequestResolution>
  getContextGovernance(): Promise<ContextGovernanceSnapshot>
  setDefaultContextContract(contract): Promise<ContextContract | null>
  putContextContract(name, contract): Promise<ContextContract>
  deleteContextContract(name): Promise<boolean>
  putContextInvariant(invariant): Promise<ContextInvariant>
  deleteContextInvariant(id): Promise<boolean>
  getContextEscalationPolicy(): Promise<ContextEscalationPolicy>
  setContextEscalationPolicy(policy): Promise<ContextEscalationPolicy>

  // Temporal
  getStateAt(asOf, options?): Promise<TemporalStateSnapshot>
  getTimeline(options?): Promise<TimelineResult>
  diffState(from, to, options?): Promise<TemporalStateDiff>
  listMemoryEvents(options?): Promise<TimelineResult>
  streamChanges(options?): AsyncIterable<MemoryEventRecord>
  resolveChangeStreamCursor(cursor?): Promise<string>

  // Knowledge
  learnFact(fact, factType, confidence?): Promise<KnowledgeMemory>
  inspectKnowledge(id): Promise<{ knowledge, evidence, audits }>
  listKnowledge(options?): Promise<PaginatedResult<KnowledgeMemory>>
  reverifyKnowledge(id): Promise<TrustAssessment>

  // Coordination
  trackWorkItem(title, kind?, status?, detail?): Promise<WorkItem>
  updateWorkItem(id, patch): Promise<WorkItem | null>
  claimWorkItem(input): Promise<WorkClaim>
  renewWorkClaim(claimId, actor, leaseSeconds?): Promise<WorkClaim | null>
  releaseWorkClaim(claimId, actor, reason?): Promise<WorkClaim | null>
  listWorkClaims(options?): Promise<WorkClaim[]>
  handoffWorkItem(input): Promise<HandoffRecord>
  acceptHandoff(id, actor): Promise<HandoffRecord | null>

  // Episodic & Cognitive
  searchEpisodes(options): Promise<EpisodeSummary[]>
  summarizeEpisode(sessionId, options?): Promise<EpisodeSummary>
  reflect(options): Promise<ReflectResult>
  searchCognitive(options): Promise<CognitiveSearchResult>

  // Knowledge Intelligence
  getGraphReport(options?): Promise<GraphReport>
  derive(options): Promise<DerivedOutput[]>
  getCoreMemory(options?): Promise<CoreMemoryBundle>
  getCurationSummary(input?, options?): Promise<CurationSummary>
  exportAsMarkdown(options?): Promise<MarkdownExportResult>

  // Playbooks
  createPlaybook(input): Promise<Playbook>
  searchPlaybooks(query): Promise<SearchResult<Playbook>[]>
  revisePlaybook(id, instructions, reason): Promise<{ playbook, revision }>

  // Profiles & Associations
  getProfile(options?): Promise<Profile>
  traverseAssociations(kind, id, options?): Promise<AssociationGraph>
  addAssociation(input): Promise<Association>
  removeAssociation(id): Promise<void>

  // Bundles & Documents
  exportBundle(name, options?): ExportBundleResult
  importBundle(bundle, options): ImportBundleResult
  refreshDocuments(documents): RefreshResult

  // System
  forceCompact(): Promise<CompactionResult | null>
  runMaintenance(policy?): Promise<MaintenanceReport>
  getRuntimeDiagnostics(): Promise<DiagnosticsReport>
  close(): Promise<void>
}
```
</details>

<details>
<summary><strong>MemoryRuntime</strong> — model-call integration hooks</summary>

```typescript
interface MemoryRuntime {
  manager: MemoryManager;
  startSession(relevanceQuery?): Promise<{ bootstrap, bootstrapPrompt }>
  resumeSession(relevanceQuery?): Promise<{ bootstrap, bootstrapPrompt }>
  beforeModelCall(input): Promise<{ bootstrap, context, bootstrapPrompt, prompt, messages }>
  afterModelCall(input): Promise<{ exchange, trackedWorkItems }>
  wrapModelCall(modelFn, input, actors?): Promise<{ result, runtime, exchange, trackedWorkItems }>
  refreshSnapshot(): Promise<SessionSnapshot | null>
  getSnapshot(): SessionSnapshot | null
}
```
</details>

---

## Python Client

```bash
pip install memory-layer-client
```

```python
from memory_layer_client import MemoryClient, MemoryRuntimeClient, MemoryScope

client = MemoryClient(
    "http://localhost:3100",
    default_scope=MemoryScope(tenant_id="acme", system_id="research-agent", scope_id="session-1"),
)
runtime = MemoryRuntimeClient(client)
result = runtime.run_turn("What constraints apply?", lambda prepared: call_model(prepared.context))
```

Async support via `AsyncMemoryClient` and `AsyncMemoryRuntimeClient`. Full HTTP API surface parity.

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
const emitter = createMemoryEventEmitter();
emitter.on('compaction', (e) => metrics.track('compaction', e.durationMs));
emitter.on('extraction', (e) => metrics.track('facts_extracted', e.meta.factCount));
emitter.on('knowledge_change', (e) => audit.log(e.meta.action, e.meta.knowledgeId));
```

### PII Redaction

```typescript
const memory = createMemory({
  redactText: ({ kind, text }) =>
    text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]'),
});
```

### Circuit Breakers

Summarizer, extractor, and embedding subsystems each have independent circuit breakers. When a provider goes down, the system degrades gracefully and telemetry emits `degraded_mode` events.

---

## Storage Backends

| Backend | Best For | Install | Search |
|---------|---------|---------|--------|
| **In-memory** | Tests, prototypes | Built-in | Exact match |
| **SQLite** | Single-process production | `npm install better-sqlite3` | FTS5 + local embeddings |
| **PostgreSQL** | Multi-writer, hosted | `npm install pg` | tsvector + pgvector ANN |

SQLite is the zero-friction production path. PostgreSQL + pgvector is the scaling path with ANN indexing for high-volume semantic retrieval.
