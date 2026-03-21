# @nanoclaw/memory

Standalone memory layer extracted from NanoClaw. SQLite-backed conversation memory with three tiers (turns, working memory, knowledge memory), automatic compaction scoring, and context health monitoring.

## Architecture

**Turns** - Raw conversation log. Append-only until archived by compaction.

**Working Memory** - Session-scoped summaries produced by compaction. Contains key_entities and topic_tags extracted from the turn range. Expires after 24h by default. Can be promoted to knowledge memory.

**Knowledge Memory** - Long-term facts. Supersedable (old fact points to replacement). Access-counted for relevance decay.

**Context Monitor** - One row per (channel, group_jid). Tracks compaction state, scores, and timing.

**Compaction Log** - Audit trail of every compaction event.

## Usage

```typescript
import {
  initMemoryDatabase,
  insertTurn,
  getActiveTurns,
  assessContext,
  getLatestWorkingMemory,
} from '@nanoclaw/memory';

// Initialize once at startup
initMemoryDatabase('/path/to/store/memory.db');

// Insert turns as conversation happens
const turn = insertTurn({
  session_id: 'tg_-100111_2026-03-21_a1b2c3',
  channel: 'telegram',
  group_jid: '-100111',
  sender: 'Greg',
  role: 'user',
  content: 'Build me a memory system.',
});

// Assess context health to decide if compaction is needed
const turns = getActiveTurns('telegram', '-100111');
const latestWm = getLatestWorkingMemory('telegram', '-100111');
const report = assessContext({
  channel: 'telegram',
  group_jid: '-100111',
  session_id: turn.session_id,
  active_turns: turns,
  latest_working_memory: latestWm,
});

if (report.recommendation.action === 'hard') {
  // Immediate compaction needed
} else if (report.recommendation.action === 'soft') {
  // Defer to next idle window (60s gap)
}
```

## Compaction Scoring

The monitor uses a multi-signal scoring system:

| Signal | Soft (+2) | Hard (+4) |
|--------|-----------|-----------|
| Turn count | >= 15 | >= 30 |
| Token estimate | >= 3000 | >= 6000 |

Plus:
- Topic drift (>= 2 of 4 signals): +2
- Task completion (any signal): +1
- Tool output (single turn >= 1200): +3, (>= 600 or cumulative >= 2400): +2

**Soft trigger**: score >= 4, defer to idle window, target 12 retained turns
**Hard trigger**: score >= 6, immediate, target 8 retained turns
**Floor**: No compaction if turns < 15 OR tokens < 3000

## Differences from NanoClaw-embedded version

- `initMemoryDatabase(dbPath)` replaces the hard `STORE_DIR` import
- `closeMemoryDatabase()` added for graceful shutdown
- `getMemoryDbPath()` returns the initialized path (or null for in-memory)
- No dependency on `../config.js`

## Write Order (Orchestrator Precondition)

When compacting: `insertWorkingMemory` -> `insertCompactionLog` -> `archiveTurn` x N.
This is the only order that satisfies FK constraints.

## Testing

```bash
npm install
npm test
```

36 storage tests + 30 monitor tests.
