import type { MemoryScope } from '../contracts/identity.js';
import { normalizeScope } from '../contracts/identity.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type { ConflictStrategy, ExtractionPolicy } from '../contracts/policy.js';
import { DEFAULT_EXTRACTION_POLICY } from '../contracts/policy.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type {
  CompactionTrigger,
  FactConfidence,
  FactType,
  KnowledgeMemory,
  KnowledgeRelation,
  Turn,
  WorkingMemory,
} from '../contracts/types.js';
import {
  assertCompactionTrigger,
  assertFactConfidence,
  assertFactType,
  assertFactType as assertExtractedFactType,
  assertNonEmpty,
  assertStringArray,
  assertMaxEntries,
  nowSeconds,
} from './validation.js';
import {
  classifyFactRelation,
  normalizeFactText,
  normalizeExtractedFact,
  normalizeKnowledgeMemory,
  type Extractor,
  type NormalizedExtractedFact,
} from './extractor.js';
import { emitMemoryEvent } from './telemetry.js';

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

interface WorkflowTelemetry {
  logger?: Logger;
  onEvent?: EventHook;
}

function resolveExtractionPolicy(
  policy?: ExtractionPolicy,
): Required<ExtractionPolicy> {
  return {
    ...DEFAULT_EXTRACTION_POLICY,
    ...policy,
  };
}

function confidenceScore(confidence: FactConfidence): number {
  return confidence === 'high' ? 2 : 1;
}

function meetsConfidenceThreshold(
  confidence: FactConfidence,
  minimum: FactConfidence,
): boolean {
  return confidenceScore(confidence) >= confidenceScore(minimum);
}

function buildKnowledgeInput(
  scope: ReturnType<typeof normalizeScope>,
  workingMemoryId: number,
  fact: NormalizedExtractedFact,
) {
  return {
    ...scope,
    fact: fact.fact,
    fact_type: fact.factType,
    fact_subject: fact.subject,
    fact_attribute: fact.attribute,
    fact_value: fact.value,
    normalized_fact: fact.normalizedFact,
    slot_key: fact.slotKey,
    is_negated: fact.isNegated,
    source: 'promoted_from_working' as const,
    confidence: fact.confidence,
    source_working_memory_id: workingMemoryId,
  };
}

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

export async function commitCompaction(
  adapter: AsyncStorageAdapter,
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
    logger?: Logger;
    onEvent?: EventHook;
  },
): Promise<CompactionResult> {
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

  return adapter.transaction(async () => {
    const workingMemory = await adapter.insertWorkingMemory({
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

    const compactionLog = await adapter.insertCompactionLog({
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
      await adapter.archiveTurn(turn.id, archivedAt, compactionLog.id);
    }

    const result = {
      workingMemory,
      compactionLog,
      archivedTurnIds: turnsToArchive.map((turn) => turn.id),
    };

    emitMemoryEvent('compaction', normalizedScope, input, input.durationMs, {
      trigger: input.trigger,
      archivedTurnCount: turnsToArchive.length,
      activeTurnCountBefore: input.activeTurnCountBefore,
      activeTurnCountAfter: input.activeTurnCountAfter,
      workingMemoryId: workingMemory.id,
      compactionLogId: compactionLog.id,
    });

    return result;
  });
}

export async function compactTurns(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  sessionId: string,
  turnsToCompact: Turn[],
  summarize: Summarizer,
  trigger: CompactionTrigger,
  retainedTurnCount: number,
  telemetry?: WorkflowTelemetry,
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
    ...telemetry,
  });
}

export async function promoteToKnowledge(
  adapter: AsyncStorageAdapter,
  workingMemoryId: number,
  input: {
    scope: MemoryScope;
    fact: string;
    factType: FactType;
    confidence: FactConfidence;
    logger?: Logger;
    onEvent?: EventHook;
  },
): Promise<KnowledgeMemory> {
  assertNonEmpty(input.fact, 'fact');
  assertFactType(input.factType);
  assertFactConfidence(input.confidence);

  const normalizedScope = normalizeScope(input.scope);
  const workingMemory = await adapter.getWorkingMemoryById(workingMemoryId);
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

  return adapter.transaction(async () => {
    const knowledgeMemory = await adapter.insertKnowledgeMemory({
      ...normalizedScope,
      fact: input.fact,
      fact_type: input.factType,
      source: 'promoted_from_working',
      confidence: input.confidence,
      source_working_memory_id: workingMemoryId,
    });
    await adapter.markWorkingMemoryPromoted(workingMemoryId, knowledgeMemory.id);
    emitMemoryEvent('promotion', normalizedScope, input, 0, {
      workingMemoryId,
      knowledgeMemoryId: knowledgeMemory.id,
      factType: input.factType,
    });
    return knowledgeMemory;
  });
}

export async function extractKnowledge(
  adapter: AsyncStorageAdapter,
  workingMemoryId: number,
  scope: MemoryScope,
  extractor: Extractor,
  options?: {
    logger?: Logger;
    onEvent?: EventHook;
    policy?: ExtractionPolicy;
  },
): Promise<KnowledgeMemory[]> {
  const startedAt = Date.now();
  const normalizedScope = normalizeScope(scope);
  const policy = resolveExtractionPolicy(options?.policy);
  const workingMemory = await adapter.getWorkingMemoryById(workingMemoryId);
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

  const extracted = (await extractor(
    workingMemory.summary,
    workingMemory.key_entities,
    workingMemory.topic_tags,
  ))
    .slice(0, policy.maxFactsPerExtraction)
    .map(normalizeExtractedFact);

  const activeKnowledge = await adapter.getActiveKnowledgeMemory(normalizedScope);
  const duplicateLookup = new Map(
    activeKnowledge.map((fact) => [normalizeFactText(fact.fact), fact]),
  );
  const normalizedKnowledge = activeKnowledge.map((fact) => ({
    memory: fact,
    normalized: normalizeKnowledgeMemory(fact),
  }));

  const created: KnowledgeMemory[] = [];

  for (const fact of extracted) {
    assertNonEmpty(fact.fact, 'fact');
    assertExtractedFactType(fact.factType);
    assertFactConfidence(fact.confidence);

    if (!meetsConfidenceThreshold(fact.confidence, policy.minConfidenceForPromotion)) {
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: fact.confidence,
        source_text: fact.sourceText ?? fact.fact,
        decision: 'skipped_low_confidence',
        detail: `Below minimum confidence threshold '${policy.minConfidenceForPromotion}'`,
      });
      continue;
    }

    const normalizedFact = normalizeFactText(fact.fact);
    const duplicate = duplicateLookup.get(normalizedFact);
    if (policy.deduplicateFacts && duplicate) {
      if (policy.touchDuplicates) {
        await adapter.touchKnowledgeMemory(duplicate.id);
      }
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: fact.confidence,
        source_text: fact.sourceText ?? fact.fact,
        decision: 'duplicate',
        related_knowledge_id: duplicate.id,
        detail: 'Exact normalized fact already exists',
      });
      continue;
    }

    let strongestRelation: {
      relation: KnowledgeRelation | 'created';
      related: KnowledgeMemory | null;
    } = { relation: 'created', related: null };
    for (const existing of normalizedKnowledge) {
      const relation = classifyFactRelation(existing.normalized, fact);
      if (relation === 'duplicate') {
        strongestRelation = { relation, related: existing.memory };
        break;
      }
      if (relation === 'conflict') {
        strongestRelation = { relation, related: existing.memory };
      } else if (
        relation === 'update' &&
        strongestRelation.relation !== 'conflict'
      ) {
        strongestRelation = { relation, related: existing.memory };
      } else if (
        relation === 'compatible' &&
        strongestRelation.related === null
      ) {
        strongestRelation = { relation, related: existing.memory };
      }
    }

    if (strongestRelation.relation === 'duplicate' && strongestRelation.related) {
      if (policy.touchDuplicates) {
        await adapter.touchKnowledgeMemory(strongestRelation.related.id);
      }
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: fact.confidence,
        source_text: fact.sourceText ?? fact.fact,
        decision: 'duplicate',
        related_knowledge_id: strongestRelation.related.id,
        detail: 'Structured relation classified as duplicate',
      });
      continue;
    }

    if (
      strongestRelation.relation === 'conflict' &&
      policy.conflictStrategy === 'skip' &&
      strongestRelation.related
    ) {
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: fact.confidence,
        source_text: fact.sourceText ?? fact.fact,
        decision: 'conflict',
        related_knowledge_id: strongestRelation.related.id,
        detail: 'Conflict strategy skipped promotion',
      });
      continue;
    }

    const createdFact = await adapter.transaction(async () => {
      const knowledge = await adapter.insertKnowledgeMemory(
        buildKnowledgeInput(normalizedScope, workingMemoryId, fact),
      );

      if (
        strongestRelation.related &&
        (strongestRelation.relation === 'update' ||
          (strongestRelation.relation === 'conflict' &&
            policy.conflictStrategy === 'supersede'))
      ) {
        await adapter.supersedeKnowledgeMemory(strongestRelation.related.id, knowledge.id);
      }

      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: fact.confidence,
        source_text: fact.sourceText ?? fact.fact,
        decision:
          strongestRelation.relation === 'update'
            ? 'updated'
            : strongestRelation.relation === 'conflict'
              ? 'conflict'
              : strongestRelation.relation === 'compatible'
                ? 'compatible'
                : 'created',
        created_knowledge_id: knowledge.id,
        related_knowledge_id: strongestRelation.related?.id ?? null,
        detail:
          strongestRelation.relation === 'conflict'
            ? `Conflict strategy '${policy.conflictStrategy}'`
            : strongestRelation.relation === 'update'
              ? 'Superseded prior related knowledge'
              : strongestRelation.relation === 'compatible'
                ? 'Created alongside compatible related knowledge'
                : 'Created new knowledge memory',
      });

      return knowledge;
    });

    duplicateLookup.set(normalizedFact, createdFact);
    normalizedKnowledge.push({
      memory: createdFact,
      normalized: normalizeKnowledgeMemory(createdFact),
    });
    created.push(createdFact);
  }

  emitMemoryEvent('extraction', normalizedScope, options, Date.now() - startedAt, {
    workingMemoryId,
    extractedCount: extracted.length,
    createdCount: created.length,
  });

  return created;
}
