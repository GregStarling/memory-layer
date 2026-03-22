import { normalizeScope, type MemoryScope, type NormalizedMemoryScope } from '../contracts/identity.js';
import type {
  CompactionLog,
  CompactionState,
  CompactionTrigger,
  ContextMonitorUpsert,
  EvidenceSourceType,
  FactConfidence,
  FactSource,
  FactType,
  GroundingStrength,
  KnowledgeAuditDecision,
  KnowledgeClass,
  KnowledgeState,
  NewKnowledgeCandidate,
  NewKnowledgeEvidence,
  NewCompactionLog,
  NewKnowledgeMemoryAudit,
  NewKnowledgeMemory,
  NewWorkItem,
  NewTurn,
  NewWorkingMemory,
  TimeRange,
  TurnRole,
  WorkItemKind,
  WorkItemStatus,
} from '../contracts/types.js';
import {
  COMPACTION_STATES,
  COMPACTION_TRIGGERS,
  FACT_CONFIDENCES,
  FACT_SOURCES,
  FACT_TYPES,
  EVIDENCE_SOURCE_TYPES,
  GROUNDING_STRENGTHS,
  KNOWLEDGE_AUDIT_DECISIONS,
  KNOWLEDGE_CLASSES,
  KNOWLEDGE_STATES,
  SUPPORT_POLARITIES,
  TURN_ROLES,
  WORK_ITEM_KINDS,
  WORK_ITEM_STATUSES,
} from '../contracts/types.js';

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function assertNonEmpty(value: string, name: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Memory validation: '${name}' must not be empty`);
  }
}

export function assertEnum<T>(value: T, allowed: readonly T[], name: string): void {
  if (!allowed.includes(value)) {
    throw new Error(
      `Memory validation: '${name}' must be one of [${allowed.join(', ')}], got '${value}'`,
    );
  }
}

export function assertStringArray(value: string[], name: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Memory validation: '${name}' must be an array of strings`);
  }
}

export function assertMaxEntries(value: string[], name: string, max: number): void {
  if (value.length > max) {
    throw new Error(
      `Memory validation: '${name}' must have at most ${max} entries, got ${value.length}`,
    );
  }
}

export function assertNumberRange(value: number, name: string, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(
      `Memory validation: '${name}' must be between ${min} and ${max}, got '${value}'`,
    );
  }
}

export function assertTurnRange(startId: number, endId: number): void {
  if (endId < startId) {
    throw new Error(
      `Memory validation: 'turn_id_end' (${endId}) must be >= 'turn_id_start' (${startId})`,
    );
  }
}

export function assertScope(scope: MemoryScope): NormalizedMemoryScope {
  return normalizeScope(scope);
}

export function assertTurnRole(role: TurnRole): void {
  assertEnum(role, TURN_ROLES, 'role');
}

export function assertCompactionTrigger(trigger: CompactionTrigger, name = 'compaction_trigger'): void {
  assertEnum(trigger, COMPACTION_TRIGGERS, name);
}

export function assertFactType(factType: FactType): void {
  assertEnum(factType, FACT_TYPES, 'fact_type');
}

export function assertFactSource(source: FactSource): void {
  assertEnum(source, FACT_SOURCES, 'source');
}

export function assertFactConfidence(confidence: FactConfidence): void {
  assertEnum(confidence, FACT_CONFIDENCES, 'confidence');
}

export function assertKnowledgeState(state: KnowledgeState): void {
  assertEnum(state, KNOWLEDGE_STATES, 'knowledge_state');
}

export function assertKnowledgeClass(knowledgeClass: KnowledgeClass): void {
  assertEnum(knowledgeClass, KNOWLEDGE_CLASSES, 'knowledge_class');
}

export function assertEvidenceSourceType(sourceType: EvidenceSourceType): void {
  assertEnum(sourceType, EVIDENCE_SOURCE_TYPES, 'source_type');
}

export function assertGroundingStrength(strength: GroundingStrength): void {
  assertEnum(strength, GROUNDING_STRENGTHS, 'grounding_strength');
}

export function assertSupportPolarity(polarity: 'supports' | 'contradicts'): void {
  assertEnum(polarity, SUPPORT_POLARITIES, 'support_polarity');
}

export function assertKnowledgeAuditDecision(decision: KnowledgeAuditDecision): void {
  assertEnum(decision, KNOWLEDGE_AUDIT_DECISIONS, 'decision');
}

export function assertCompactionState(state: CompactionState): void {
  assertEnum(state, COMPACTION_STATES, 'compaction_state');
}

export function assertWorkItemKind(kind: WorkItemKind): void {
  assertEnum(kind, WORK_ITEM_KINDS, 'kind');
}

export function assertWorkItemStatus(status: WorkItemStatus): void {
  assertEnum(status, WORK_ITEM_STATUSES, 'status');
}

export function validateNewTurn(input: NewTurn): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertNonEmpty(input.session_id, 'session_id');
  assertNonEmpty(input.actor, 'actor');
  assertNonEmpty(input.content, 'content');
  assertTurnRole(input.role);
  if (input.priority !== undefined) {
    assertNumberRange(input.priority, 'priority', 0, 2);
  }
  return scope;
}

export function validateNewWorkingMemory(input: NewWorkingMemory): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertNonEmpty(input.session_id, 'session_id');
  assertNonEmpty(input.summary, 'summary');
  assertCompactionTrigger(input.compaction_trigger);
  assertStringArray(input.key_entities, 'key_entities');
  assertStringArray(input.topic_tags, 'topic_tags');
  assertMaxEntries(input.topic_tags, 'topic_tags', 5);
  assertTurnRange(input.turn_id_start, input.turn_id_end);
  return scope;
}

export function validateNewKnowledgeMemory(input: NewKnowledgeMemory): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertNonEmpty(input.fact, 'fact');
  assertFactType(input.fact_type);
  assertFactSource(input.source);
  assertFactConfidence(input.confidence);
  if (input.knowledge_state !== undefined) {
    assertKnowledgeState(input.knowledge_state);
  }
  if (input.knowledge_class !== undefined) {
    assertKnowledgeClass(input.knowledge_class);
  }
  if (input.grounding_strength !== undefined) {
    assertGroundingStrength(input.grounding_strength);
  }
  return scope;
}

export function validateNewKnowledgeMemoryAudit(
  input: NewKnowledgeMemoryAudit,
): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertNonEmpty(input.fact, 'fact');
  assertFactType(input.fact_type);
  assertFactConfidence(input.confidence);
  assertKnowledgeAuditDecision(input.decision);
  return scope;
}

export function validateNewKnowledgeCandidate(input: NewKnowledgeCandidate): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertNonEmpty(input.fact, 'fact');
  assertFactType(input.fact_type);
  assertKnowledgeClass(input.knowledge_class);
  assertFactConfidence(input.confidence);
  assertGroundingStrength(input.grounding_strength ?? 'weak');
  assertKnowledgeState(input.state ?? 'candidate');
  return scope;
}

export function validateNewKnowledgeEvidence(input: NewKnowledgeEvidence): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertEvidenceSourceType(input.source_type);
  assertSupportPolarity(input.support_polarity);
  assertNonEmpty(input.excerpt, 'excerpt');
  if (input.speaker_role !== undefined && input.speaker_role !== null) {
    assertTurnRole(input.speaker_role);
  }
  return scope;
}

export function validateContextMonitorUpsert(input: ContextMonitorUpsert): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertCompactionState(input.compaction_state);
  return scope;
}

export function validateNewCompactionLog(input: NewCompactionLog): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertNonEmpty(input.session_id, 'session_id');
  assertCompactionTrigger(input.trigger_type, 'trigger_type');
  assertTurnRange(input.turn_id_start, input.turn_id_end);
  return scope;
}

export function validateTimeRange(range: TimeRange): void {
  if (
    range.start_at !== undefined &&
    range.end_at !== undefined &&
    range.end_at < range.start_at
  ) {
    throw new Error("Memory validation: 'end_at' must be >= 'start_at'");
  }
}

export function validateNewWorkItem(input: NewWorkItem): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertNonEmpty(input.title, 'title');
  assertWorkItemKind(input.kind);
  assertWorkItemStatus(input.status ?? 'open');
  return scope;
}

export function assertArchiveInput(id: number, archivedAt: number, compactionLogId: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Memory validation: 'id' must be a positive integer, got '${id}'`);
  }
  if (!Number.isInteger(archivedAt) || archivedAt <= 0) {
    throw new Error(
      `Memory validation: 'archivedAt' must be a positive integer, got '${archivedAt}'`,
    );
  }
  if (!Number.isInteger(compactionLogId) || compactionLogId <= 0) {
    throw new Error(
      `Memory validation: 'compactionLogId' must be a positive integer, got '${compactionLogId}'`,
    );
  }
}
