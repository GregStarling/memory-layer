# memory-layer

Standalone memory package for AI systems that need scoped conversation history, compaction policy, and long-term memory. The public surface is backend-agnostic; SQLite is the first adapter, not the product itself.

## Architecture

- **Public API**: package entrypoint with contracts, core workflows, and adapters
- **Domain Core**: token estimation, compaction policy, and workflow orchestration
- **Storage Contracts**: backend-neutral adapter interface
- **SQLite Adapter**: first persistence backend, implemented with `better-sqlite3`

### Memory Model

- **Turns**: raw scoped conversation history
- **Working Memory**: summaries created by compaction, with optional expiry
- **Knowledge Memory**: promoted long-term facts with supersession and access tracking
- **Context Monitor**: compaction health snapshots for a scope
- **Compaction Log**: audit trail of each compaction event

## Identity Model

All data is scoped by a normalized `MemoryScope`:

```typescript
interface MemoryScope {
  tenant_id: string;
  system_id: string;
  workspace_id?: string; // normalized to 'default'
  scope_id: string;
}
```

## Usage

```typescript
import {
  assessContext,
  compactTurns,
  createSessionId,
  createSQLiteAdapter,
} from 'memory-layer';

const adapter = createSQLiteAdapter('/path/to/memory.db');

const scope = {
  tenant_id: 'acme',
  system_id: 'assistant',
  scope_id: 'thread-123',
};

const sessionId = createSessionId(scope);

adapter.insertTurn({
  ...scope,
  session_id: sessionId,
  actor: 'user-42',
  role: 'user',
  content: 'Build me a memory system.',
});

const turns = adapter.getActiveTurns(scope);
const latestWorkingMemory = adapter.getLatestWorkingMemory(scope);
const report = assessContext({
  scope,
  session_id: sessionId,
  active_turns: turns,
  latest_working_memory: latestWorkingMemory,
});

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
```

## Compaction Semantics

The package owns the safe persistence order for compaction:

```text
insertWorkingMemory -> insertCompactionLog -> archiveTurn x N
```

`compactTurns()` performs summarization outside the transaction, then persists the commit atomically through the adapter transaction boundary.

## Scoring

The compaction monitor keeps the existing multi-signal policy:

- Turn count: soft at `>= 15`, hard at `>= 30`
- Token estimate: soft at `>= 3000`, hard at `>= 6000`
- Topic drift: `+2` when at least 2 drift signals fire
- Task completion: `+1` when any completion signal fires
- Heavy output: `+3` for a hard spike, `+2` for a soft spike or cumulative surge

Recommendations:

- `soft`: score `>= 4`, retain 12 turns, defer to idle
- `hard`: score `>= 6`, retain 8 turns, compact immediately
- `none`: below threshold or below floor

Floor rule:

- no compaction if active turns `< 15`
- no compaction if active token estimate `< 3000`

## Testing

```bash
npm install
npm test
npm run lint
```
