import type { MemoryScope, NormalizedMemoryScope } from './identity.js';

export type TurnRole = 'user' | 'assistant' | 'system';
export type CompactionTrigger = 'soft' | 'hard' | 'session_gap' | 'manual';
export type FactType =
  | 'preference'
  | 'entity'
  | 'decision'
  | 'constraint'
  | 'reference';
export type FactSource = 'user_stated' | 'promoted_from_working' | 'manual';
export type FactConfidence = 'high' | 'medium';
export type KnowledgeRelation = 'duplicate' | 'compatible' | 'update' | 'conflict';
export type KnowledgeAuditDecision =
  | 'created'
  | 'duplicate'
  | 'compatible'
  | 'updated'
  | 'conflict'
  | 'skipped_low_confidence';
export type CompactionState =
  | 'idle'
  | 'soft_triggered'
  | 'hard_triggered'
  | 'compacting';
export type WorkItemKind = 'objective' | 'unresolved_work' | 'constraint';
export type WorkItemStatus = 'open' | 'in_progress' | 'blocked' | 'done';

export const TURN_ROLES: readonly TurnRole[] = ['user', 'assistant', 'system'];
export const COMPACTION_TRIGGERS: readonly CompactionTrigger[] = [
  'soft',
  'hard',
  'session_gap',
  'manual',
];
export const FACT_TYPES: readonly FactType[] = [
  'preference',
  'entity',
  'decision',
  'constraint',
  'reference',
];
export const FACT_SOURCES: readonly FactSource[] = [
  'user_stated',
  'promoted_from_working',
  'manual',
];
export const FACT_CONFIDENCES: readonly FactConfidence[] = ['high', 'medium'];
export const KNOWLEDGE_RELATIONS: readonly KnowledgeRelation[] = [
  'duplicate',
  'compatible',
  'update',
  'conflict',
];
export const KNOWLEDGE_AUDIT_DECISIONS: readonly KnowledgeAuditDecision[] = [
  'created',
  'duplicate',
  'compatible',
  'updated',
  'conflict',
  'skipped_low_confidence',
];
export const COMPACTION_STATES: readonly CompactionState[] = [
  'idle',
  'soft_triggered',
  'hard_triggered',
  'compacting',
];
export const WORK_ITEM_KINDS: readonly WorkItemKind[] = [
  'objective',
  'unresolved_work',
  'constraint',
];
export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'done',
];

export interface Turn extends NormalizedMemoryScope {
  id: number;
  session_id: string;
  actor: string;
  role: TurnRole;
  content: string;
  token_estimate: number;
  created_at: number;
  archived_at: number | null;
  compaction_log_id: number | null;
  schema_version: number;
}

export interface NewTurn extends MemoryScope {
  session_id: string;
  actor: string;
  role: TurnRole;
  content: string;
  token_estimate?: number;
  created_at?: number;
}

export interface WorkingMemory extends NormalizedMemoryScope {
  id: number;
  session_id: string;
  summary: string;
  key_entities: string[];
  topic_tags: string[];
  turn_id_start: number;
  turn_id_end: number;
  turn_count: number;
  compaction_trigger: CompactionTrigger;
  created_at: number;
  expires_at: number | null;
  promoted_to_knowledge_id: number | null;
  schema_version: number;
}

export interface NewWorkingMemory extends MemoryScope {
  session_id: string;
  summary: string;
  key_entities: string[];
  topic_tags: string[];
  turn_id_start: number;
  turn_id_end: number;
  turn_count: number;
  compaction_trigger: CompactionTrigger;
  expires_at?: number | null;
}

export interface KnowledgeMemory extends NormalizedMemoryScope {
  id: number;
  fact: string;
  fact_type: FactType;
  fact_subject: string | null;
  fact_attribute: string | null;
  fact_value: string | null;
  normalized_fact: string | null;
  slot_key: string | null;
  is_negated: boolean;
  source: FactSource;
  confidence: FactConfidence;
  source_working_memory_id: number | null;
  superseded_by_id: number | null;
  retired_at: number | null;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  schema_version: number;
}

export interface NewKnowledgeMemory extends MemoryScope {
  fact: string;
  fact_type: FactType;
  fact_subject?: string | null;
  fact_attribute?: string | null;
  fact_value?: string | null;
  normalized_fact?: string | null;
  slot_key?: string | null;
  is_negated?: boolean;
  source: FactSource;
  confidence: FactConfidence;
  source_working_memory_id?: number | null;
  retired_at?: number | null;
}

export interface KnowledgeMemoryAudit extends NormalizedMemoryScope {
  id: number;
  working_memory_id: number | null;
  fact: string;
  fact_type: FactType;
  fact_subject: string | null;
  fact_attribute: string | null;
  fact_value: string | null;
  normalized_fact: string | null;
  slot_key: string | null;
  is_negated: boolean;
  confidence: FactConfidence;
  source_text: string | null;
  decision: KnowledgeAuditDecision;
  created_knowledge_id: number | null;
  related_knowledge_id: number | null;
  detail: string | null;
  created_at: number;
}

export interface NewKnowledgeMemoryAudit extends MemoryScope {
  working_memory_id?: number | null;
  fact: string;
  fact_type: FactType;
  fact_subject?: string | null;
  fact_attribute?: string | null;
  fact_value?: string | null;
  normalized_fact?: string | null;
  slot_key?: string | null;
  is_negated?: boolean;
  confidence: FactConfidence;
  source_text?: string | null;
  decision: KnowledgeAuditDecision;
  created_knowledge_id?: number | null;
  related_knowledge_id?: number | null;
  detail?: string | null;
  created_at?: number;
}

export interface ContextMonitor extends NormalizedMemoryScope {
  id: number;
  compaction_state: CompactionState;
  last_compaction_at: number | null;
  active_turn_count: number;
  active_token_estimate: number;
  compaction_score: number;
  updated_at: number;
}

export interface ContextMonitorUpsert extends MemoryScope {
  compaction_state: CompactionState;
  last_compaction_at?: number | null;
  active_turn_count: number;
  active_token_estimate: number;
  compaction_score: number;
}

export interface CompactionLog extends NormalizedMemoryScope {
  id: number;
  session_id: string;
  trigger_type: CompactionTrigger;
  turn_id_start: number;
  turn_id_end: number;
  turns_compacted: number;
  tokens_compacted_estimate: number;
  working_memory_id: number;
  active_turn_count_before: number;
  active_turn_count_after: number;
  duration_ms: number;
  model_call_made: boolean;
  error?: string | null;
  created_at: number;
}

export interface NewCompactionLog extends MemoryScope {
  session_id: string;
  trigger_type: CompactionTrigger;
  turn_id_start: number;
  turn_id_end: number;
  turns_compacted: number;
  tokens_compacted_estimate: number;
  working_memory_id: number;
  active_turn_count_before: number;
  active_turn_count_after: number;
  duration_ms: number;
  model_call_made?: boolean;
  error?: string | null;
  created_at?: number;
}

export interface SearchOptions {
  limit?: number;
  activeOnly?: boolean;
}

export interface SearchResult<T> {
  item: T;
  rank: number;
}

export interface TimeRange {
  start_at?: number;
  end_at?: number;
}

export interface WorkItem extends NormalizedMemoryScope {
  id: number;
  session_id: string | null;
  kind: WorkItemKind;
  title: string;
  detail: string | null;
  status: WorkItemStatus;
  source_working_memory_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface NewWorkItem extends MemoryScope {
  session_id?: string | null;
  kind: WorkItemKind;
  title: string;
  detail?: string | null;
  status?: WorkItemStatus;
  source_working_memory_id?: number | null;
  created_at?: number;
}
