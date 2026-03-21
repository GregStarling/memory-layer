import type { MemoryScope } from '../contracts/identity.js';
import { normalizeScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type {
  CompactionTrigger,
  FactConfidence,
  FactType,
  KnowledgeMemory,
  Turn,
  WorkingMemory,
} from '../contracts/types.js';
import {
  assertCompactionTrigger,
  assertFactConfidence,
  assertFactType,
  assertNonEmpty,
  assertStringArray,
  assertMaxEntries,
  nowSeconds,
} from './validation.js';

export interface CompactionResult {
  workingMemory: WorkingMemory;
  compactionLog: import('../contracts/types.js').CompactionLog;
  archivedTurnIds: number[];
}

export interface SummarizerOutput {
  summary: string;
  key_entities: string[];
  topic_tags: string[];
}

export type Summarizer = (turns: Turn[]) => Promise<SummarizerOutput>;

function sortTurnsAscending(turns: Turn[]): Turn[] {
  return [...turns].sort((a, b) => a.id - b.id);
}

function assertTurnsMatchScope(turns: Turn[], scope: MemoryScope, sessionId: string): void {
  const normalized = normalizeScope(scope);
  for (const turn of turns) {
    if (turn.session_id !== sessionId) {
      throw new Error(
        `Memory validation: turn ${turn.id} session_id '${turn.session_id}' does not match '${sessionId}'`,
      );
    }
    if (
      turn.tenant_id !== normalized.tenant_id ||
      turn.system_id !== normalized.system_id ||
      turn.workspace_id !== normalized.workspace_id ||
      turn.scope_id !== normalized.scope_id
    ) {
      throw new Error(`Memory validation: turn ${turn.id} does not belong to the requested scope`);
    }
  }
}

export function commitCompaction(
  adapter: StorageAdapter,
  input: {
    scope: MemoryScope;
    sessionId: string;
    summary: string;
    keyEntities: string[];
    topicTags: string[];
    turnsToArchive: Turn[];
    activeTurnCountBefore: number;
    activeTurnCountAfter: number;
    trigger: CompactionTrigger;
    durationMs: number;
    modelCallMade: boolean;
  },
): CompactionResult {
  const normalizedScope = normalizeScope(input.scope);
  assertNonEmpty(input.sessionId, 'sessionId');
  assertNonEmpty(input.summary, 'summary');
  assertCompactionTrigger(input.trigger, 'trigger');
  assertStringArray(input.keyEntities, 'keyEntities');
  assertStringArray(input.topicTags, 'topicTags');
  assertMaxEntries(input.topicTags, 'topicTags', 5);

  const turnsToArchive = sortTurnsAscending(input.turnsToArchive);
  if (turnsToArchive.length === 0) {
    throw new Error("Memory validation: 'turnsToArchive' must not be empty");
  }
  assertTurnsMatchScope(turnsToArchive, normalizedScope, input.sessionId);

  const turnIdStart = turnsToArchive[0].id;
  const turnIdEnd = turnsToArchive[turnsToArchive.length - 1].id;
  const tokensCompactedEstimate = turnsToArchive.reduce(
    (acc, turn) => acc + turn.token_estimate,
    0,
  );
  const archivedAt = nowSeconds();

  return adapter.transaction(() => {
    const workingMemory = adapter.insertWorkingMemory({
      ...normalizedScope,
      session_id: input.sessionId,
      summary: input.summary,
      key_entities: input.keyEntities,
      topic_tags: input.topicTags,
      turn_id_start: turnIdStart,
      turn_id_end: turnIdEnd,
      turn_count: turnsToArchive.length,
      compaction_trigger: input.trigger,
    });

    const compactionLog = adapter.insertCompactionLog({
      ...normalizedScope,
      session_id: input.sessionId,
      trigger_type: input.trigger,
      turn_id_start: turnIdStart,
      turn_id_end: turnIdEnd,
      turns_compacted: turnsToArchive.length,
      tokens_compacted_estimate: tokensCompactedEstimate,
      working_memory_id: workingMemory.id,
      active_turn_count_before: input.activeTurnCountBefore,
      active_turn_count_after: input.activeTurnCountAfter,
      duration_ms: input.durationMs,
      model_call_made: input.modelCallMade,
    });

    for (const turn of turnsToArchive) {
      adapter.archiveTurn(turn.id, archivedAt, compactionLog.id);
    }

    return {
      workingMemory,
      compactionLog,
      archivedTurnIds: turnsToArchive.map((turn) => turn.id),
    };
  });
}

export async function compactTurns(
  adapter: StorageAdapter,
  scope: MemoryScope,
  sessionId: string,
  turnsToCompact: Turn[],
  summarize: Summarizer,
  trigger: CompactionTrigger,
  retainedTurnCount: number,
): Promise<CompactionResult> {
  assertCompactionTrigger(trigger, 'trigger');
  if (!Number.isInteger(retainedTurnCount) || retainedTurnCount < 0) {
    throw new Error(
      `Memory validation: 'retainedTurnCount' must be a non-negative integer, got '${retainedTurnCount}'`,
    );
  }

  const orderedTurns = sortTurnsAscending(turnsToCompact);
  assertTurnsMatchScope(orderedTurns, scope, sessionId);
  const turnsToArchive = orderedTurns.slice(0, Math.max(0, orderedTurns.length - retainedTurnCount));
  if (turnsToArchive.length === 0) {
    throw new Error('Memory validation: no turns are eligible for compaction');
  }

  const startedAtMs = Date.now();
  const summary = await summarize(turnsToArchive);
  const durationMs = Date.now() - startedAtMs;

  return commitCompaction(adapter, {
    scope,
    sessionId,
    summary: summary.summary,
    keyEntities: summary.key_entities,
    topicTags: summary.topic_tags,
    turnsToArchive,
    activeTurnCountBefore: orderedTurns.length,
    activeTurnCountAfter: orderedTurns.length - turnsToArchive.length,
    trigger,
    durationMs,
    modelCallMade: true,
  });
}

export function promoteToKnowledge(
  adapter: StorageAdapter,
  workingMemoryId: number,
  input: {
    scope: MemoryScope;
    fact: string;
    factType: FactType;
    confidence: FactConfidence;
  },
): KnowledgeMemory {
  assertNonEmpty(input.fact, 'fact');
  assertFactType(input.factType);
  assertFactConfidence(input.confidence);

  const normalizedScope = normalizeScope(input.scope);
  const workingMemory = adapter.getWorkingMemoryById(workingMemoryId);
  if (!workingMemory) {
    throw new Error(`Memory validation: working memory ${workingMemoryId} was not found`);
  }
  if (
    workingMemory.tenant_id !== normalizedScope.tenant_id ||
    workingMemory.system_id !== normalizedScope.system_id ||
    workingMemory.workspace_id !== normalizedScope.workspace_id ||
    workingMemory.scope_id !== normalizedScope.scope_id
  ) {
    throw new Error(
      `Memory validation: working memory ${workingMemoryId} does not belong to the requested scope`,
    );
  }

  return adapter.transaction(() => {
    const knowledgeMemory = adapter.insertKnowledgeMemory({
      ...normalizedScope,
      fact: input.fact,
      fact_type: input.factType,
      source: 'promoted_from_working',
      confidence: input.confidence,
      source_working_memory_id: workingMemoryId,
    });
    adapter.markWorkingMemoryPromoted(workingMemoryId, knowledgeMemory.id);
    return knowledgeMemory;
  });
}
