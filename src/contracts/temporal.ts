import type { NormalizedMemoryScope } from './identity.js';
import type {
  CoordinationState,
  HandoffRecord,
  MemoryVisibilityClass,
  WorkClaim,
} from './coordination.js';
import type {
  Association,
  KnowledgeMemory,
  Playbook,
  Turn,
  WorkItem,
  WorkingMemory,
} from './types.js';
import type { SessionState } from './session-state.js';

export type MemoryEventEntityKind =
  | 'turn'
  | 'working_memory'
  | 'knowledge_memory'
  | 'work_item'
  | 'association'
  | 'playbook'
  | 'playbook_revision'
  | 'session_state'
  | 'work_claim'
  | 'handoff';

export type MemoryEventType =
  | 'turn.created'
  | 'turn.archived'
  | 'turn.seeded'
  | 'working_memory.created'
  | 'working_memory.expired'
  | 'working_memory.promoted'
  | 'working_memory.seeded'
  | 'knowledge.created'
  | 'knowledge.updated'
  | 'knowledge.touched'
  | 'knowledge.retired'
  | 'knowledge.superseded'
  | 'knowledge.seeded'
  | 'work_item.created'
  | 'work_item.status_changed'
  | 'work_item.updated'
  | 'work_item.visibility_changed'
  | 'work_item.deleted'
  | 'work_item.seeded'
  | 'association.created'
  | 'association.visibility_changed'
  | 'association.deleted'
  | 'association.seeded'
  | 'playbook.created'
  | 'playbook.updated'
  | 'playbook.visibility_changed'
  | 'playbook.used'
  | 'playbook.seeded'
  | 'playbook.revised'
  | 'knowledge.visibility_changed'
  | 'work_claim.claimed'
  | 'work_claim.renewed'
  | 'work_claim.released'
  | 'work_claim.expired'
  | 'handoff.created'
  | 'handoff.accepted'
  | 'handoff.rejected'
  | 'handoff.canceled'
  | 'handoff.expired'
  | 'session_state.updated'
  | 'session_state.seeded';

export interface MemoryEventRecord extends NormalizedMemoryScope {
  event_id: number;
  session_id: string | null;
  actor_id: string | null;
  actor_kind: string | null;
  actor_system_id: string | null;
  actor_display_name: string | null;
  actor_metadata: Record<string, unknown> | null;
  entity_kind: MemoryEventEntityKind;
  entity_id: string;
  event_type: MemoryEventType;
  payload: Record<string, unknown>;
  causation_id: string | null;
  correlation_id: string | null;
  created_at: number;
}

export interface NewMemoryEventRecord extends NormalizedMemoryScope {
  session_id?: string | null;
  actor_id?: string | null;
  actor_kind?: string | null;
  actor_system_id?: string | null;
  actor_display_name?: string | null;
  actor_metadata?: Record<string, unknown> | null;
  entity_kind: MemoryEventEntityKind;
  entity_id: string;
  event_type: MemoryEventType;
  payload: Record<string, unknown>;
  causation_id?: string | null;
  correlation_id?: string | null;
  created_at?: number;
}

export interface MemoryEventQuery {
  sessionId?: string;
  entityKind?: MemoryEventEntityKind;
  entityId?: string;
  visibilityClass?: MemoryVisibilityClass;
  startAt?: number;
  endAt?: number;
  limit?: number;
  cursor?: number;
}

export type ChangeStreamEvent = MemoryEventRecord;

export interface SessionStateProjection extends NormalizedMemoryScope, SessionState {
  session_id: string;
  source_event_id: number | null;
}

export interface NewSessionStateProjection extends NormalizedMemoryScope, SessionState {
  session_id: string;
  source_event_id?: number | null;
}

export interface TemporalProjectionWatermark {
  projection_name: string;
  last_event_id: number;
  updated_at: number;
  cutover_at: number | null;
  metadata: Record<string, unknown> | null;
}

export interface NewTemporalProjectionWatermark {
  projection_name: string;
  last_event_id: number;
  updated_at?: number;
  cutover_at?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface TimelineResult {
  events: MemoryEventRecord[];
  nextCursor: number | null;
}

export interface TemporalStateSnapshot<TContext = unknown> {
  asOf: number;
  exact: boolean;
  cutoverAt: number | null;
  watermarkEventId: number | null;
  context: TContext;
  sessionState: SessionState | null;
  turns: Turn[];
  workingMemory: WorkingMemory[];
  knowledge: KnowledgeMemory[];
  workItems: WorkItem[];
  workClaims: WorkClaim[];
  handoffs: HandoffRecord[];
  coordinationState: CoordinationState | null;
  associations: Association[];
  playbooks: Playbook[];
}

export interface TemporalStateDiff {
  from: number;
  to: number;
  exact: boolean;
  cutoverAt: number | null;
  watermarkRange: {
    fromEventId: number | null;
    toEventId: number | null;
  };
  events: MemoryEventRecord[];
  summary: {
    totalEvents: number;
    byEntityKind: Partial<Record<MemoryEventEntityKind, number>>;
    byEventType: Partial<Record<MemoryEventType, number>>;
  };
}
