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
export type CompactionState =
  | 'idle'
  | 'soft_triggered'
  | 'hard_triggered'
  | 'compacting';

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
export const COMPACTION_STATES: readonly CompactionState[] = [
  'idle',
  'soft_triggered',
  'hard_triggered',
  'compacting',
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
  source: FactSource;
  confidence: FactConfidence;
  source_working_memory_id: number | null;
  superseded_by_id: number | null;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  schema_version: number;
}

export interface NewKnowledgeMemory extends MemoryScope {
  fact: string;
  fact_type: FactType;
  source: FactSource;
  confidence: FactConfidence;
  source_working_memory_id?: number | null;
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
