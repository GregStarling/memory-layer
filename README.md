# ai-memory-layer

Version 4.1.0

Backend-agnostic cognitive memory for AI systems.

Memory Layer gives an AI system durable, evolving memory across sessions: raw conversations compress into summaries, summaries crystallize into trust-scored knowledge, and the most relevant memory is assembled into a token-budgeted context window on every call. It handles compaction, extraction, evidence grounding, contradiction detection, hybrid retrieval, multi-tenant scoping, temporal replay, coordination, governance, and lifecycle management.

**Mental model**: Interactions become summaries. Summaries become knowledge. Knowledge becomes context.

Memory Layer is narrow on purpose — it is NOT Heart (what the system believes, values, and refuses) and NOT Voice (how the writing sounds at the surface). Memory is what the system remembers happened. See the [architecture docs](docs/) for the full three-layer split.

**Version 4.0.0** — Phase 5 ships the temporal event log with point-in-time replay and diffs, multi-agent coordination (work items, claims, handoffs), SQLite migration hardening (forward-only v13→v14), and a 100/100 codebase score. See [CHANGELOG.md](CHANGELOG.md) for the full release notes.

## Quick Start

### Prerequisites

```bash
npm install ai-memory-layer
```

No API keys required. Uses a pure-JS extractive summarizer, heuristic fact extractor, and local embedding fallback out of the box.

Optional dependencies for persistence and higher-quality memory formation:

```bash
npm install better-sqlite3    # SQLite adapter (recommended for production)
npm install pg                # PostgreSQL adapter (multi-writer scaling)
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

### Persistent (SQLite)

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

### Runtime Wrapper for Generation Lifecycle

```typescript
import { createMemoryRuntime } from 'ai-memory-layer';

const runtime = createMemoryRuntime(manager);

// Hook-based
const { prompt, messages } = await runtime.beforeModelCall(userInput);
const result = await model.generate(prompt);
await runtime.afterModelCall({ userInput, assistantOutput: result });

// Or single-line wrapper
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

| Tier | Content | Lifecycle | Analogy |
|------|---------|-----------|---------|
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

Facts are classified by type (`preference`, `constraint`, `entity`, `decision`, `reference`) and by knowledge class (`identity`, `preference`, `constraint`, `procedure`, `strategy`, `project_fact`, `anti_pattern`, `episodic_fact`). Classification drives retrieval ranking, maintenance retention, and profile assembly.

### Hybrid Retrieval

`getContext()` scores every candidate fact across eight dimensions: lexical relevance, semantic similarity, recency, trust score, class importance, evidence density, scope affinity, and diversity. Selected knowledge seeds a single-hop association expansion, then the result is token-trimmed to budget and returned as a structured `MemoryContext` ready for prompt injection.

## Surfaces

| Surface | Best For | Start |
|---------|---------|-------|
| **Node package** | In-process agents, IDEs, autonomous loops | `import { createMemory } from 'ai-memory-layer'` |
| **HTTP API** | Polyglot services, hosted deployments | `npx memory-layer serve --transport http` |
| **MCP server** | Tool ecosystems, Claude Desktop, agent frameworks | `npx memory-layer serve --transport mcp` |
| **CLI** | Inspection, debugging, admin | `npx memory-layer inspect` |
| **Python client** | Python agents consuming the HTTP API | `pip install ai-memory-layer-client` |

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

Each agent gets its own `scope_id`. Agents in the same `workspace_id` share knowledge via cross-scope retrieval. Retrieval levels: `scope` → `workspace` → `system` → `tenant`. Each level widens the knowledge pool while preserving ranking preference for local, high-trust facts.

Items carry a visibility class (`private`, `shared_collaboration`, `workspace`, `tenant`) controlling what surfaces under each view policy.

## Temporal Intelligence

An append-only event log records every state change with before/after payloads.

```typescript
// Point-in-time replay
const context = await memory.getContextAt(asOfTimestamp, 'deployment status');
const state = await memory.getStateAt(asOfTimestamp);

// Temporal diffs
const diff = await memory.diffState(fromTimestamp, toTimestamp);

// Change streaming
for await (const event of memory.streamChanges({ signal: controller.signal })) {
  console.log(event.event_type, event.entity_kind, event.entity_id);
}
```

Snapshots pin a watermark event ID before assembling context, ensuring a consistent cut of the event log.

## Multi-Agent Coordination

```typescript
// Work items & claims
const item = await memory.trackWorkItem('Deploy canary to us-east-1', 'objective', 'open');
const claim = await memory.claimWorkItem({
  workItemId: item.id,
  actor: { actor_kind: 'agent', actor_id: 'deployer', system_id: null, display_name: 'Deploy Bot', metadata: null },
  leaseSeconds: 600,
});
await memory.renewWorkClaim(claim.id, claim.actor, 300);
await memory.releaseWorkClaim(claim.id, claim.actor, 'deployment complete');

// Handoffs
const handoff = await memory.handoffWorkItem({
  workItemId: item.id,
  fromActor: deployBot,
  toActor: monitorBot,
  summary: 'Canary deployed. Monitor for 30min then promote.',
});
await memory.acceptHandoff(handoff.id, monitorBot);

// Episodic & cognitive retrieval
const episodes = await memory.searchEpisodes({ query: 'deployment failures', limit: 5 });
const reflection = await memory.reflect({ query: 'What patterns emerge from our deployments?' });

// Playbooks
const playbook = await memory.createPlaybook({
  title: 'Canary Deployment Runbook',
  description: 'Step-by-step canary deployment with rollback gates',
  instructions: '1. Deploy to canary. 2. Monitor error rate. 3. ...',
  tags: ['deployment', 'canary'],
});
```

## Knowledge Intelligence

Beyond storage and retrieval, memory-layer actively analyzes, improves, and curates the knowledge it holds.

```typescript
// Reflection — detect patterns across the knowledge base
const reflection = await memory.reflect({ query: 'What recurring issues appear in deployments?' });

// Derivation — generate playbook candidates, rules, and anti-patterns from patterns
const derived = await memory.derive({ reflection });

// Graph analysis — community detection, topology, bridges, centrality
const report = await memory.getGraphReport({ sections: ['topology', 'bridges', 'critical'] });

// Knowledge linting — orphans, trust skew, evidence concentration, contradictions, stale provisionals
const lint = await lintKnowledge(adapter, scope);

// Aliases & entity resolution
const candidates = discoverAliasCandidates(knowledge);

// Core memory — essential knowledge subset that should always appear in context
const core = await getCoreMemory(adapter, scope, { overflowStrategy: 'truncate' });

// Curation — pending promotions, conflicts, and retirement candidates
const summary = await memory.getCurationSummary();

// Document ingestion — refresh knowledge from source documents with content-hash deduplication
const result = memory.refreshDocuments([
  { title: 'API Guidelines', contentHash: 'abc123', content: '...' },
]);

// Export/import
const bundle = memory.exportBundle('backup-2024', { includeTurns: true });
const md = await memory.exportAsMarkdown({ groupBy: 'class', includeEvidence: true });
```

## Context Governance

Context contracts let different agents see different slices of the same memory graph. Governance state is durable — contracts, invariants, and escalation policies persist to SQLite and survive restarts.

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

Governance can also be managed at runtime:

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
```

When an agent is blocked, it can request a broader context. The escalation policy decides whether to approve, deny, or flag for human review.

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

Four policy objects (`MonitorPolicy`, `ExtractionPolicy`, `ContextPolicy`, `MaintenancePolicy`) give fine-grained control over compaction thresholds, extraction behavior, context scoring weights, and maintenance lifecycles. Presets configure sensible defaults; override individual fields when needed.

## Storage Backends

| Backend | Best For | Install | Search |
|---------|---------|---------|--------|
| **In-memory** | Tests, prototypes | Built-in | Exact match |
| **SQLite** | Single-process production | `npm install better-sqlite3` | FTS5 + local embeddings |
| **PostgreSQL** | Multi-writer, hosted | `npm install pg` | tsvector + pgvector ANN |

SQLite is the zero-friction production path. PostgreSQL + pgvector is the scaling path with ANN indexing for high-volume semantic retrieval.

## Observability

```typescript
// Event hooks
const memory = createMemory({
  onEvent: (event) => {
    // event.type: 'compaction' | 'extraction' | 'promotion' | 'retrieval' |
    //   'search' | 'maintenance' | 'capability' | 'knowledge_change' | 'context_assembly'
    console.log(`[${event.type}] scope=${event.scope.scope_id} duration=${event.durationMs}ms`);
  },
});

// Typed event emitter
const emitter = createMemoryEventEmitter();
emitter.on('compaction', (e) => metrics.track('compaction', e.durationMs));
emitter.on('extraction', (e) => metrics.track('facts_extracted', e.meta.factCount));

// PII redaction
const memory = createMemory({
  redactText: ({ kind, text }) =>
    text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]'),
});
```

Summarizer, extractor, and embedding subsystems each have independent circuit breakers. When a provider goes down, the system degrades gracefully and emits `degraded_mode` events.

## Python Client

```bash
pip install ai-memory-layer-client
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

## Local Development

```bash
# Install dependencies
npm install

# Run the full test suite
npm test

# Run tests with coverage report
npm run test:coverage

# Type-check without emitting
npm run typecheck

# PostgreSQL integration tests (requires POSTGRES_TEST_URL)
npm run test:postgres

# Quality evaluation gates
npm run eval:retrieval
npm run eval:gate
npm run eval:memory-quality

# Full pre-publish release check
npm run release:check

# Build the package
npm run build
```

## Design Principles

- **Package first** — works offline and in-process out of the box, grows into SQLite, PostgreSQL, HTTP, and MCP without changing the core mental model
- **Memory is evolving state, not search results** — turns compact into summaries, summaries promote into evidence-backed knowledge, and context assembly respects trust, scope, and token budget
- **Evidence-driven trust** — every fact earns trust through grounding in source turns, corroboration across sessions, or explicit user statements
- **Token accountability** — all context assembly respects token budgets with explicit trimming traces
- **Full temporal lineage** — append-only event log enables replay, diffs, streaming, and point-in-time queries
- **Scope isolation** — five-tuple scopes enable multi-tenant safety with selective sharing
- **Governance as code** — contracts, invariants, and escalation policies are durable, versioned configuration
- **Knowledge self-improvement** — reflection, clustering, linting, and derivation continuously strengthen the knowledge graph
- **Coordination-first** — work items, claims, handoffs, and profiles are first-class for multi-agent orchestration
- **Memory is not heart** — heart is what the system believes and values; memory is what it remembers happened
