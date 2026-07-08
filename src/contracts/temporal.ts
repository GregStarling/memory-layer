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

/**
 * # Temporal replay contract
 *
 * The event log (`memory_event_log`) is an append-only, monotonically-numbered
 * record of state mutations. `foldTemporalState` / `getStateAt(T)` reconstruct
 * historical state by folding events in a single canonical order.
 *
 * ## Ordering guarantee
 *
 * Events are ordered by `event_id` ASC **alone**. `event_id` is an append-only
 * AUTOINCREMENT (SQLite) / BIGSERIAL (Postgres) / monotonic counter (in-memory)
 * assigned at insert time inside the same transaction as the mutation, so it is
 * the true causal order of writes.
 *
 * `created_at` is display/metadata only. It MAY be caller-supplied or backdated
 * (imports, seeds, backfills) and is therefore NEVER an `ORDER BY` key for
 * pagination or replay. Pagination cursors are `event_id > ?`.
 *
 * ## Replayable entity kinds
 *
 * These entity kinds emit a full `payload.after` snapshot on every mutation and
 * are reconstructed exactly by fold into `ReplayedTemporalState` /
 * `TemporalStateSnapshot`:
 *   - `turn`, `working_memory`, `knowledge_memory`, `work_item`,
 *     `association`, `playbook`, `session_state`, `work_claim`, `handoff`
 *
 * `work_claim` and `handoff` additionally have their *effective* status
 * computed against the replay `asOf` (a claim whose `expires_at <= asOf` reads
 * as `expired` even if the log has no explicit expiry event for that instant —
 * see `normalizeReplayedTemporalState`).
 *
 * ## Audited-but-not-replayable entity kinds
 *
 * These emit events for audit/observability but are NOT folded into a distinct
 * replayed collection (they are configuration overlays, derived side-artifacts,
 * or child records whose effect is already captured on a replayable parent):
 *   - `playbook_revision` — a revision emits `playbook.revised` (audit) AND,
 *     since it mutates the parent playbook, a `playbook.updated` after-snapshot
 *     (D1). Fold reconstructs the parent `playbook` (incl. its bumped
 *     `revision_count`/`updated_at`) from that snapshot; there is no separate
 *     replayed `playbookRevisions` collection.
 *   - `knowledge_candidate` — lifecycle audit; the promoted `knowledge_memory`
 *     is the replayable artifact.
 *   - `source_document` — ingestion audit; extracted `knowledge_memory` rows
 *     are the replayable artifacts.
 *   - `context_contract`, `context_invariant`, `context_escalation_policy` —
 *     governance overlay; authoritative state is the governance projection
 *     (`getGovernanceState`), which is a last-writer-wins config store, not an
 *     event fold.
 *
 * ## Entities entirely outside the event log
 *
 * `knowledge_evidence`, `knowledge_memory_audit`, `compaction_log`,
 * `context_monitor`, `scope_config`, and `temporal_projection_watermark` are
 * not part of temporal replay at all.
 *
 * ## Forward/backward compatibility
 *
 * `foldTemporalState` ignores entity kinds and event types it does not
 * recognise, so old logs replay under new code and logs containing
 * newly-added event types replay under code that predates them. Never remove or
 * repurpose an existing `MemoryEventType` string.
 */
export type TemporalId = string;
export type TemporalIdInput = string | number | bigint;

export function normalizeTemporalId(value: TemporalIdInput): TemporalId {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('Temporal ids must be non-negative');
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error('Temporal ids must be non-negative integers');
    }
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('Temporal ids must be decimal strings');
    }
    return BigInt(trimmed).toString();
  }
  throw new Error('Temporal ids must be strings, numbers, or bigints');
}

export function compareTemporalIds(left: TemporalIdInput, right: TemporalIdInput): number {
  const a = BigInt(normalizeTemporalId(left));
  const b = BigInt(normalizeTemporalId(right));
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export type MemoryEventEntityKind =
  | 'turn'
  | 'working_memory'
  | 'knowledge_memory'
  | 'knowledge_candidate'
  | 'work_item'
  | 'association'
  | 'playbook'
  | 'playbook_revision'
  | 'session_state'
  | 'work_claim'
  | 'handoff'
  | 'source_document'
  | 'context_contract'
  | 'context_invariant'
  | 'context_escalation_policy';

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
  | 'session_state.seeded'
  // Knowledge-candidate lifecycle (Phase 2.2).
  | 'knowledge_candidate.created'
  | 'knowledge_candidate.promoted'
  | 'knowledge_candidate.expired'
  // Source-document lifecycle (Phase 2.2).
  | 'source_document.created'
  | 'source_document.updated'
  // Governance upserts (Phase 2.2). Contracts, invariants, and escalation
  // policies are configuration overlays; these events are an audit trail, not
  // a temporal-replay source (see "Temporal replay contract" below).
  | 'context_contract.set'
  | 'context_contract.deleted'
  | 'context_invariant.set'
  | 'context_invariant.deleted'
  | 'context_escalation_policy.set';

export interface MemoryEventRecord extends NormalizedMemoryScope {
  event_id: TemporalId;
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
  cursor?: TemporalIdInput;
}

export type ChangeStreamEvent = MemoryEventRecord;

export interface SessionStateProjection extends NormalizedMemoryScope, SessionState {
  session_id: string;
  source_event_id: TemporalId | null;
}

export interface NewSessionStateProjection extends NormalizedMemoryScope, SessionState {
  session_id: string;
  source_event_id?: TemporalIdInput | null;
}

export interface TemporalProjectionWatermark {
  projection_name: string;
  last_event_id: TemporalId;
  updated_at: number;
  cutover_at: number | null;
  metadata: Record<string, unknown> | null;
}

export interface NewTemporalProjectionWatermark {
  projection_name: string;
  last_event_id: TemporalIdInput;
  updated_at?: number;
  cutover_at?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface TimelineResult {
  events: MemoryEventRecord[];
  nextCursor: TemporalId | null;
}

export interface TemporalStateSnapshot<TContext = unknown> {
  asOf: number;
  exact: boolean;
  cutoverAt: number | null;
  watermarkEventId: TemporalId | null;
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
    fromEventId: TemporalId | null;
    toEventId: TemporalId | null;
  };
  events: MemoryEventRecord[];
  summary: {
    totalEvents: number;
    byEntityKind: Partial<Record<MemoryEventEntityKind, number>>;
    byEventType: Partial<Record<MemoryEventType, number>>;
  };
}
