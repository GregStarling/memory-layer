import { normalizeScope, type MemoryScope, type NormalizedMemoryScope } from '../contracts/identity.js';
import type {
  CompactionLog,
  CompactionState,
  CompactionTrigger,
  ContextMonitorUpsert,
  FactConfidence,
  FactSource,
  FactType,
  NewCompactionLog,
  NewKnowledgeMemory,
  NewTurn,
  NewWorkingMemory,
  TurnRole,
} from '../contracts/types.js';
import {
  COMPACTION_STATES,
  COMPACTION_TRIGGERS,
  FACT_CONFIDENCES,
  FACT_SOURCES,
  FACT_TYPES,
  TURN_ROLES,
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

export function assertCompactionState(state: CompactionState): void {
  assertEnum(state, COMPACTION_STATES, 'compaction_state');
}

export function validateNewTurn(input: NewTurn): NormalizedMemoryScope {
  const scope = assertScope(input);
  assertNonEmpty(input.session_id, 'session_id');
  assertNonEmpty(input.actor, 'actor');
  assertNonEmpty(input.content, 'content');
  assertTurnRole(input.role);
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
