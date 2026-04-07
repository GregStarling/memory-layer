import type { MemoryScope, NormalizedMemoryScope } from './identity.js';
import type { MemoryVisibilityClass } from './coordination.js';

export type TurnRole = 'user' | 'assistant' | 'system';
export type CompactionTrigger = 'soft' | 'hard' | 'session_gap' | 'manual';
export type FactType =
  | 'preference'
  | 'entity'
  | 'decision'
  | 'constraint'
  | 'reference';
export type FactSource = 'user_stated' | 'promoted_from_working' | 'manual';
export type FactConfidence = 'high' | 'medium' | 'low';
export type VerificationStatus = 'unverified' | 'corroborated' | 'verified' | 'tool_verified';
export type KnowledgeRelation = 'duplicate' | 'compatible' | 'update' | 'conflict';
export type KnowledgeState =
  | 'candidate'
  | 'provisional'
  | 'trusted'
  | 'disputed'
  | 'superseded'
  | 'retired';
export type KnowledgeClass =
  | 'identity'
  | 'preference'
  | 'constraint'
  | 'procedure'
  | 'strategy'
  | 'anti_pattern'
  | 'project_fact'
  | 'episodic_fact';
export type EvidenceSourceType =
  | 'user_turn'
  | 'assistant_turn'
  | 'system_turn'
  | 'tool_output'
  | 'execution_result'
  | 'human_feedback'
  | 'working_memory_summary'
  | 'manual'
  | 'imported';
export type SupportPolarity = 'supports' | 'contradicts';
export type GroundingStrength = 'weak' | 'moderate' | 'strong' | 'tool_verified';
export type KnowledgeDecision =
  | 'promote_candidate'
  | 'keep_provisional'
  | 'reject_candidate'
  | 'mark_disputed'
  | 'supersede_existing';
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
export type EpisodeDetailLevel = 'abstract' | 'overview' | 'full';
export type PlaybookStatus = 'draft' | 'active' | 'deprecated' | 'archived';
export type AssociationType =
  | 'related_to'
  | 'supports'
  | 'contradicts'
  | 'supersedes'
  | 'depends_on'
  | 'solves'
  | 'applies_to'
  | 'derived_from';
export type AssociationTargetKind = 'knowledge' | 'playbook' | 'working_memory' | 'work_item';

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
export const FACT_CONFIDENCES: readonly FactConfidence[] = ['high', 'medium', 'low'];
export const KNOWLEDGE_STATES: readonly KnowledgeState[] = [
  'candidate',
  'provisional',
  'trusted',
  'disputed',
  'superseded',
  'retired',
];
export const KNOWLEDGE_CLASSES: readonly KnowledgeClass[] = [
  'identity',
  'preference',
  'constraint',
  'procedure',
  'strategy',
  'anti_pattern',
  'project_fact',
  'episodic_fact',
];
export const EVIDENCE_SOURCE_TYPES: readonly EvidenceSourceType[] = [
  'user_turn',
  'assistant_turn',
  'system_turn',
  'tool_output',
  'execution_result',
  'human_feedback',
  'working_memory_summary',
  'manual',
  'imported',
];
export const SUPPORT_POLARITIES: readonly SupportPolarity[] = ['supports', 'contradicts'];
export const GROUNDING_STRENGTHS: readonly GroundingStrength[] = [
  'weak',
  'moderate',
  'strong',
  'tool_verified',
];
export const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  'unverified',
  'corroborated',
  'verified',
  'tool_verified',
];
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
export const EPISODE_DETAIL_LEVELS: readonly EpisodeDetailLevel[] = [
  'abstract',
  'overview',
  'full',
];
export const PLAYBOOK_STATUSES: readonly PlaybookStatus[] = [
  'draft',
  'active',
  'deprecated',
  'archived',
];
export const ASSOCIATION_TYPES: readonly AssociationType[] = [
  'related_to',
  'supports',
  'contradicts',
  'supersedes',
  'depends_on',
  'solves',
  'applies_to',
  'derived_from',
];
export const ASSOCIATION_TARGET_KINDS: readonly AssociationTargetKind[] = [
  'knowledge',
  'playbook',
  'working_memory',
  'work_item',
];

export interface Turn extends NormalizedMemoryScope {
  id: number;
  session_id: string;
  actor: string;
  role: TurnRole;
  content: string;
  priority: number;
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
  priority?: number;
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
  episode_recap: EpisodeRecap | null;
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
  episode_recap?: EpisodeRecap | null;
}

export interface KnowledgeMemory extends NormalizedMemoryScope {
  id: number;
  visibility_class: MemoryVisibilityClass;
  fact: string;
  fact_type: FactType;
  knowledge_state: KnowledgeState;
  knowledge_class: KnowledgeClass;
  fact_subject: string | null;
  fact_attribute: string | null;
  fact_value: string | null;
  normalized_fact: string | null;
  slot_key: string | null;
  is_negated: boolean;
  source: FactSource;
  confidence: FactConfidence;
  confidence_score: number;
  grounding_strength: GroundingStrength;
  evidence_count: number;
  trust_score: number;
  verification_status: VerificationStatus;
  verification_notes: string | null;
  last_verified_at: number | null;
  next_reverification_at: number | null;
  last_confirmed_at: number | null;
  confirmation_count: number;
  source_system_id: string | null;
  source_scope_id: string | null;
  source_collaboration_id: string | null;
  source_working_memory_id: number | null;
  source_turn_ids: number[];
  successful_use_count: number;
  failed_use_count: number;
  disputed_at: number | null;
  dispute_reason: string | null;
  contradiction_score: number;
  superseded_at: number | null;
  superseded_by_id: number | null;
  retired_at: number | null;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  schema_version: number;
}

export interface NewKnowledgeMemory extends MemoryScope {
  visibility_class?: MemoryVisibilityClass;
  fact: string;
  fact_type: FactType;
  knowledge_state?: KnowledgeState;
  knowledge_class?: KnowledgeClass;
  fact_subject?: string | null;
  fact_attribute?: string | null;
  fact_value?: string | null;
  normalized_fact?: string | null;
  slot_key?: string | null;
  is_negated?: boolean;
  source: FactSource;
  confidence: FactConfidence;
  confidence_score?: number;
  grounding_strength?: GroundingStrength;
  evidence_count?: number;
  trust_score?: number;
  verification_status?: VerificationStatus;
  verification_notes?: string | null;
  last_verified_at?: number | null;
  next_reverification_at?: number | null;
  last_confirmed_at?: number | null;
  confirmation_count?: number;
  source_system_id?: string | null;
  source_scope_id?: string | null;
  source_collaboration_id?: string | null;
  source_working_memory_id?: number | null;
  source_turn_ids?: number[];
  successful_use_count?: number;
  failed_use_count?: number;
  disputed_at?: number | null;
  dispute_reason?: string | null;
  contradiction_score?: number;
  superseded_at?: number | null;
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
  confidence_score: number;
  verification_status: VerificationStatus;
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
  confidence_score?: number;
  verification_status?: VerificationStatus;
  source_text?: string | null;
  decision: KnowledgeAuditDecision;
  created_knowledge_id?: number | null;
  related_knowledge_id?: number | null;
  detail?: string | null;
  created_at?: number;
}

export interface KnowledgeCandidate extends NormalizedMemoryScope {
  id: number;
  working_memory_id: number;
  fact: string;
  fact_type: FactType;
  knowledge_class: KnowledgeClass;
  normalized_fact: string;
  slot_key: string | null;
  confidence: FactConfidence;
  source_summary: boolean;
  source_turns: boolean;
  grounding_strength: GroundingStrength;
  evidence_count: number;
  trust_score: number;
  state: 'candidate' | 'provisional';
  created_at: number;
  promoted_knowledge_id: number | null;
}

export interface NewKnowledgeCandidate extends MemoryScope {
  working_memory_id: number;
  fact: string;
  fact_type: FactType;
  knowledge_class: KnowledgeClass;
  normalized_fact: string;
  slot_key?: string | null;
  confidence: FactConfidence;
  source_summary?: boolean;
  source_turns?: boolean;
  grounding_strength?: GroundingStrength;
  evidence_count?: number;
  trust_score?: number;
  state?: 'candidate' | 'provisional';
  created_at?: number;
  promoted_knowledge_id?: number | null;
}

export interface KnowledgeEvidence extends NormalizedMemoryScope {
  id: number;
  knowledge_memory_id: number | null;
  knowledge_candidate_id: number | null;
  working_memory_id: number | null;
  turn_id: number | null;
  source_type: EvidenceSourceType;
  support_polarity: SupportPolarity;
  speaker_role: TurnRole | null;
  actor: string | null;
  excerpt: string;
  start_offset: number | null;
  end_offset: number | null;
  is_explicit: boolean;
  explicitness_score: number;
  outcome: 'success' | 'failure' | 'neutral' | null;
  created_at: number;
}

export interface NewKnowledgeEvidence extends MemoryScope {
  knowledge_memory_id?: number | null;
  knowledge_candidate_id?: number | null;
  working_memory_id?: number | null;
  turn_id?: number | null;
  source_type: EvidenceSourceType;
  support_polarity: SupportPolarity;
  speaker_role?: TurnRole | null;
  actor?: string | null;
  excerpt: string;
  start_offset?: number | null;
  end_offset?: number | null;
  is_explicit?: boolean;
  explicitness_score?: number;
  outcome?: 'success' | 'failure' | 'neutral' | null;
  created_at?: number;
}

export type SourceDocumentStatus = 'pending' | 'processed' | 'failed';

export interface SourceDocument extends NormalizedMemoryScope {
  id: number;
  title: string;
  content_hash: string;
  mime_type: string;
  url: string | null;
  metadata: Record<string, string>;
  status: SourceDocumentStatus;
  fact_count: number;
  token_estimate: number;
  created_at: number;
  processed_at: number | null;
}

export interface NewSourceDocument extends MemoryScope {
  title: string;
  content_hash: string;
  mime_type?: string;
  url?: string | null;
  metadata?: Record<string, string>;
  status?: SourceDocumentStatus;
  token_estimate?: number;
}

export interface KnowledgeTrustAssessment {
  trust_score: number;
  state: KnowledgeState;
  decision: KnowledgeDecision;
  reasons: string[];
}

export interface KnowledgeConflict {
  existing_knowledge_id: number;
  candidate_id: number | null;
  relation: 'duplicate' | 'update' | 'conflict' | 'compatible';
  severity: 'low' | 'medium' | 'high';
  resolution: 'ignore' | 'dispute' | 'supersede';
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
  includeProvisional?: boolean;
  includeDisputed?: boolean;
  minimumTrustScore?: number;
  knowledgeStates?: KnowledgeState[];
  knowledgeClasses?: KnowledgeClass[];
  preferLocalTrusted?: boolean;
  preferLineageMemory?: boolean;
}

export interface SearchResult<T> {
  item: T;
  rank: number;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  cursor?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: number | null;
}

export interface TimeRange {
  start_at?: number;
  end_at?: number;
}

export interface WorkItem extends NormalizedMemoryScope {
  id: number;
  session_id: string | null;
  visibility_class: MemoryVisibilityClass;
  kind: WorkItemKind;
  title: string;
  detail: string | null;
  status: WorkItemStatus;
  source_working_memory_id: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface NewWorkItem extends MemoryScope {
  session_id?: string | null;
  visibility_class?: MemoryVisibilityClass;
  kind: WorkItemKind;
  title: string;
  detail?: string | null;
  status?: WorkItemStatus;
  source_working_memory_id?: number | null;
  created_at?: number;
}

export interface EpisodeSourceReference {
  type: 'turn' | 'working_memory' | 'knowledge';
  id: number;
  excerpt: string | null;
}

export interface EpisodeRecap {
  objective: string;
  actions: string[];
  outcomes: string[];
  artifacts: string[];
  unresolvedItems: string[];
  sourceType: 'episodic' | 'declarative' | 'mixed';
  sources: EpisodeSourceReference[];
}

export interface EpisodeSearchOptions {
  query: string;
  detailLevel?: EpisodeDetailLevel;
  limit?: number;
  timeRange?: TimeRange;
}

export interface EpisodeSummary {
  sessionId: string;
  recap: EpisodeRecap;
  detailLevel: EpisodeDetailLevel;
  turnRange: { start: number; end: number };
  createdAt: number;
}

export interface ReflectOptions {
  query: string;
  detailLevel?: EpisodeDetailLevel;
  includeEpisodic?: boolean;
  includeDeclarative?: boolean;
  limit?: number;
  timeRange?: TimeRange;
}

export interface ReflectResult {
  synthesis: string;
  sourceType: 'episodic' | 'declarative' | 'mixed';
  sources: EpisodeSourceReference[];
  episodes: EpisodeSummary[];
  detailLevel: EpisodeDetailLevel;
}

export interface Playbook extends NormalizedMemoryScope {
  id: number;
  visibility_class: MemoryVisibilityClass;
  title: string;
  description: string;
  instructions: string;
  references: string[];
  templates: string[];
  scripts: string[];
  assets: string[];
  tags: string[];
  status: PlaybookStatus;
  source_session_id: string | null;
  source_working_memory_id: number | null;
  revision_count: number;
  last_used_at: number | null;
  use_count: number;
  created_at: number;
  updated_at: number;
  schema_version: number;
}

export interface NewPlaybook extends MemoryScope {
  visibility_class?: MemoryVisibilityClass;
  title: string;
  description: string;
  instructions: string;
  references?: string[];
  templates?: string[];
  scripts?: string[];
  assets?: string[];
  tags?: string[];
  status?: PlaybookStatus;
  source_session_id?: string | null;
  source_working_memory_id?: number | null;
  created_at?: number;
}

export interface PlaybookRevision extends NormalizedMemoryScope {
  id: number;
  playbook_id: number;
  instructions: string;
  revision_reason: string;
  source_session_id: string | null;
  created_at: number;
}

export interface NewPlaybookRevision extends MemoryScope {
  playbook_id: number;
  instructions: string;
  revision_reason: string;
  source_session_id?: string | null;
  created_at?: number;
}

export interface Association extends NormalizedMemoryScope {
  id: number;
  visibility_class: MemoryVisibilityClass;
  source_kind: AssociationTargetKind;
  source_id: number;
  target_kind: AssociationTargetKind;
  target_id: number;
  association_type: AssociationType;
  confidence: number;
  auto_generated: boolean;
  created_at: number;
}

export interface NewAssociation extends MemoryScope {
  visibility_class?: MemoryVisibilityClass;
  source_kind: AssociationTargetKind;
  source_id: number;
  target_kind: AssociationTargetKind;
  target_id: number;
  association_type: AssociationType;
  confidence?: number;
  auto_generated?: boolean;
  created_at?: number;
}
