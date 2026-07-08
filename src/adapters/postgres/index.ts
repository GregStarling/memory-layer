import { AsyncLocalStorage } from 'node:async_hooks';

import type { AsyncStorageAdapter } from '../../contracts/async-storage.js';
import { UniqueConstraintError } from '../../contracts/storage.js';
import { ConflictError, ValidationError } from '../../contracts/errors.js';
import type {
  ActorRef,
  HandoffQuery,
  HandoffRecord,
  NewHandoffInput,
  NewWorkClaimInput,
  WorkClaim,
  WorkClaimQuery,
  WorkItemPatch,
} from '../../contracts/coordination.js';
import type {
  TemporalId,
  MemoryEventEntityKind,
  MemoryEventQuery,
  MemoryEventRecord,
  NewMemoryEventRecord,
  NewSessionStateProjection,
  NewTemporalProjectionWatermark,
  SessionStateProjection,
  TemporalProjectionWatermark,
  TimelineResult,
} from '../../contracts/temporal.js';
import { compareTemporalIds, normalizeTemporalId } from '../../contracts/temporal.js';
import type {
  EmbeddingAdapter,
  EmbeddingCoverage,
  EmbeddingQueryFilter,
  EmbeddingVector,
  SimilarEmbeddingResult,
} from '../../contracts/embedding.js';
import type { MemoryScope, ScopeLevel } from '../../contracts/identity.js';
import { normalizeScope, widenScope } from '../../contracts/identity.js';
import type { EventHook, Logger } from '../../contracts/observability.js';
import type {
  Association,
  AssociationTargetKind,
  CompactionLog,
  ContextMonitor,
  ContextMonitorUpsert,
  KnowledgeCandidate,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  NewAssociation,
  NewCompactionLog,
  NewKnowledgeCandidate,
  NewKnowledgeEvidence,
  NewKnowledgeMemory,
  NewKnowledgeMemoryAudit,
  NewPlaybook,
  NewPlaybookRevision,
  NewSourceDocument,
  NewWorkItem,
  NewTurn,
  NewWorkingMemory,
  Playbook,
  PlaybookRevision,
  PaginationOptions,
  PaginatedResult,
  SearchOptions,
  SearchResult,
  SourceDocument,
  SourceDocumentStatus,
  TimeRange,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../../contracts/types.js';
import { matchesKnowledgeSearchOptions } from '../../core/retrieval.js';
import { estimateTokens } from '../../core/tokens.js';

export interface PostgresAdapterOptions {
  logger?: Logger;
  onEvent?: EventHook;
  ownsPool?: boolean;
}

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  connect(): Promise<PgClient & { release(): void }>;
  end(): Promise<void>;
}

interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

function scopeParams(scope: MemoryScope): unknown[] {
  const n = normalizeScope(scope);
  return [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id];
}

function scopeWhere(prefix = '', startIndex = 1): string {
  const p = prefix ? `${prefix}.` : '';
  const i = startIndex;
  return `${p}tenant_id = $${i} AND ${p}system_id = $${i + 1} AND ${p}workspace_id = $${i + 2} AND ${p}collaboration_id = $${i + 3} AND ${p}scope_id = $${i + 4}`;
}

function wideScopeWhere(scope: MemoryScope, level: ScopeLevel, prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  switch (level) {
    case 'tenant':
      return `${p}tenant_id = $1`;
    case 'system':
      return `${p}tenant_id = $1 AND ${p}system_id = $2`;
    case 'workspace':
      return `${p}tenant_id = $1 AND ${p}workspace_id = $2`;
    default:
      return scopeWhere(prefix);
  }
}

function wideScopeParams(scope: MemoryScope, level: ScopeLevel): unknown[] {
  const n = normalizeScope(scope);
  switch (level) {
    case 'tenant':
      return [n.tenant_id];
    case 'system':
      return [n.tenant_id, n.system_id];
    case 'workspace':
      return [n.tenant_id, n.workspace_id];
    default:
      return scopeParams(scope);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function mapSourceDocumentRow(row: Record<string, unknown>): SourceDocument {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id ?? ''),
    system_id: String(row.system_id ?? ''),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id ?? ''),
    title: String(row.title),
    content_hash: String(row.content_hash),
    mime_type: String(row.mime_type ?? 'text/plain'),
    url: row.url != null ? String(row.url) : null,
    metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata as Record<string, string> : {},
    status: String(row.status ?? 'pending') as SourceDocumentStatus,
    fact_count: Number(row.fact_count ?? 0),
    token_estimate: Number(row.token_estimate ?? 0),
    created_at: Number(row.created_at),
    processed_at: row.processed_at != null ? Number(row.processed_at) : null,
  };
}

function vectorToLiteral(vector: EmbeddingVector): string {
  return `[${Array.from(vector, (value) => (Number.isFinite(value) ? value : 0)).join(',')}]`;
}

/**
 * Build the distance expression and WHERE clauses shared by findSimilar /
 * findSimilarCrossScope (Phase 2.4). Mutates `params` in place (pushing any
 * bound values it needs) and returns:
 *  - `distExpr`: the cosine-distance expression to use in SELECT/WHERE/ORDER BY.
 *    When the concrete dimension is known it casts BOTH operands to `vector(N)`
 *    so the expression is textually identical to the partial HNSW index
 *    expression `((embedding::vector(N)) vector_cosine_ops) WHERE dimensions = N`
 *    — the planner only uses the per-dimension HNSW index when the ORDER BY
 *    expression matches the index expression exactly. Without a dimension it
 *    falls back to the bare column (correct, but a sequential scan).
 *  - `extraClauses`: dimension / model filters (Phase 2.4 / D2).
 */
function buildSimilarityClauses(
  filter: EmbeddingQueryFilter | undefined,
  vectorParam: number,
  params: unknown[],
  prefix: string,
): { distExpr: string; extraClauses: string[] } {
  const rawDim = filter?.dimensions;
  const typedDim = rawDim != null && Number.isInteger(rawDim) && rawDim > 0 ? rawDim : null;
  const distExpr =
    typedDim != null
      ? `(${prefix}.embedding::vector(${typedDim})) <=> $${vectorParam}::vector(${typedDim})`
      : `${prefix}.embedding <=> $${vectorParam}::vector`;
  const extraClauses: string[] = [];
  if (rawDim != null) {
    if (typedDim != null) {
      // Inline the dimension as a literal so it matches the partial index
      // predicate `WHERE dimensions = N` exactly; a bound $-parameter would not,
      // and the planner would skip the partial index.
      extraClauses.push(`${prefix}.dimensions = ${typedDim}`);
    } else {
      params.push(rawDim);
      extraClauses.push(`${prefix}.dimensions = $${params.length}`);
    }
  }
  // D2: filter by model ONLY when the active model is known. The manager already
  // omits model from the filter when the active model is 'unknown'; the explicit
  // `!== 'unknown'` guard hardens the adapter against a passed-through 'unknown'.
  // Stored 'unknown' vectors are never excluded on model grounds so
  // pre-versioning data still surfaces when dimensions agree (mirrors the
  // memory/sqlite matchesFilter rule: skip model filtering when either side is
  // 'unknown').
  if (filter?.model != null && filter.model !== 'unknown') {
    params.push(filter.model);
    extraClauses.push(`(${prefix}.model = $${params.length} OR ${prefix}.model = 'unknown')`);
  }
  return { distExpr, extraClauses };
}

function parseVectorValue(value: unknown): EmbeddingVector | null {
  if (value == null) return null;
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) {
    return new Float32Array(value.map((entry) => Number(entry)));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const normalized = trimmed
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .replace(/^\{/, '')
      .replace(/\}$/, '');
    if (normalized.length === 0) {
      return new Float32Array();
    }
    return new Float32Array(
      normalized
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => Number(entry)),
    );
  }
  return null;
}

// Phase 0.4: resolve search-option defaults locally so Postgres matches the
// SQLite/memory semantics (notably activeOnly defaults to true; treating
// undefined as false silently returned superseded/retired records).
// Kept in exact sync with resolveSearchOptions in src/adapters/sqlite/index.ts.
// TODO(Phase 3.1): extract to a shared adapter kernel module instead of duplicating.
function resolveSearchOptions(options?: SearchOptions): Required<SearchOptions> {
  return {
    limit: options?.limit ?? 10,
    activeOnly: options?.activeOnly ?? true,
    includeProvisional: options?.includeProvisional ?? false,
    includeDisputed: options?.includeDisputed ?? false,
    minimumTrustScore: options?.minimumTrustScore ?? 0,
    knowledgeStates: options?.knowledgeStates ?? [],
    knowledgeClasses: options?.knowledgeClasses ?? [],
    tags: options?.tags ?? [],
    preferLocalTrusted: options?.preferLocalTrusted ?? false,
    preferLineageMemory: options?.preferLineageMemory ?? false,
  };
}

function resolvePaginationOptions(options?: PaginationOptions): Required<PaginationOptions> {
  return {
    limit: options?.limit ?? 25,
    offset: options?.offset ?? 0,
    cursor: options?.cursor ?? 0,
  };
}

function mapTurn(row: Record<string, unknown>): Turn {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: String(row.session_id),
    actor: String(row.actor),
    role: row.role as Turn['role'],
    content: String(row.content),
    priority: Number(row.priority ?? 1),
    token_estimate: Number(row.token_estimate),
    archived_at: row.archived_at != null ? Number(row.archived_at) : null,
    compaction_log_id: row.compaction_log_id != null ? Number(row.compaction_log_id) : null,
    created_at: Number(row.created_at),
    schema_version: Number(row.schema_version ?? 1),
  };
}

function mapWorkingMemory(row: Record<string, unknown>): WorkingMemory {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: String(row.session_id),
    summary: String(row.summary),
    key_entities: Array.isArray(row.key_entities) ? row.key_entities : JSON.parse(String(row.key_entities ?? '[]')),
    topic_tags: Array.isArray(row.topic_tags) ? row.topic_tags : JSON.parse(String(row.topic_tags ?? '[]')),
    turn_id_start: Number(row.turn_id_start),
    turn_id_end: Number(row.turn_id_end),
    turn_count: Number(row.turn_count),
    compaction_trigger: row.compaction_trigger as WorkingMemory['compaction_trigger'],
    expires_at: row.expires_at != null ? Number(row.expires_at) : null,
    promoted_to_knowledge_id: row.promoted_to_knowledge_id != null ? Number(row.promoted_to_knowledge_id) : null,
    episode_recap: row.episode_recap != null ? (typeof row.episode_recap === 'string' ? JSON.parse(row.episode_recap) : row.episode_recap) as WorkingMemory['episode_recap'] : null,
    created_at: Number(row.created_at),
    schema_version: Number(row.schema_version ?? 1),
  };
}

function mapKnowledgeMemory(row: Record<string, unknown>): KnowledgeMemory {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    visibility_class: (row.visibility_class as KnowledgeMemory['visibility_class']) ?? 'private',
    fact: String(row.fact),
    fact_type: row.fact_type as KnowledgeMemory['fact_type'],
    knowledge_state: (row.knowledge_state as KnowledgeMemory['knowledge_state']) ?? 'trusted',
    knowledge_class: (row.knowledge_class as KnowledgeMemory['knowledge_class']) ?? 'project_fact',
    fact_subject: row.fact_subject != null ? String(row.fact_subject) : null,
    fact_attribute: row.fact_attribute != null ? String(row.fact_attribute) : null,
    fact_value: row.fact_value != null ? String(row.fact_value) : null,
    normalized_fact: row.normalized_fact != null ? String(row.normalized_fact) : null,
    slot_key: row.slot_key != null ? String(row.slot_key) : null,
    is_negated: Boolean(row.is_negated),
    source: row.source as KnowledgeMemory['source'],
    confidence: row.confidence as KnowledgeMemory['confidence'],
    confidence_score: Number(row.confidence_score ?? 0.5),
    grounding_strength:
      (row.grounding_strength as KnowledgeMemory['grounding_strength']) ?? 'moderate',
    evidence_count: Number(row.evidence_count ?? 0),
    trust_score: Number(row.trust_score ?? 0.5),
    verification_status: (row.verification_status as KnowledgeMemory['verification_status']) ?? 'unverified',
    verification_notes: row.verification_notes != null ? String(row.verification_notes) : null,
    last_verified_at: row.last_verified_at != null ? Number(row.last_verified_at) : null,
    next_reverification_at:
      row.next_reverification_at != null ? Number(row.next_reverification_at) : null,
    last_confirmed_at: row.last_confirmed_at != null ? Number(row.last_confirmed_at) : null,
    confirmation_count: Number(row.confirmation_count ?? 0),
    source_system_id: row.source_system_id != null ? String(row.source_system_id) : null,
    source_scope_id: row.source_scope_id != null ? String(row.source_scope_id) : null,
    source_collaboration_id:
      row.source_collaboration_id != null ? String(row.source_collaboration_id) : null,
    source_working_memory_id: row.source_working_memory_id != null ? Number(row.source_working_memory_id) : null,
    source_turn_ids: Array.isArray(row.source_turn_ids)
      ? row.source_turn_ids.map((value) => Number(value))
      : [],
    successful_use_count: Number(row.successful_use_count ?? 0),
    failed_use_count: Number(row.failed_use_count ?? 0),
    disputed_at: row.disputed_at != null ? Number(row.disputed_at) : null,
    dispute_reason: row.dispute_reason != null ? String(row.dispute_reason) : null,
    contradiction_score: Number(row.contradiction_score ?? 0),
    superseded_at: row.superseded_at != null ? Number(row.superseded_at) : null,
    superseded_by_id: row.superseded_by_id != null ? Number(row.superseded_by_id) : null,
    retired_at: row.retired_at != null ? Number(row.retired_at) : null,
    valid_from: row.valid_from != null ? Number(row.valid_from) : null,
    valid_until: row.valid_until != null ? Number(row.valid_until) : null,
    rationale: row.rationale != null ? String(row.rationale) : null,
    tags: Array.isArray(row.tags) ? row.tags.map((v) => String(v)) : parseJsonStringArray(row.tags),
    access_count: Number(row.access_count ?? 0),
    last_accessed_at: Number(row.last_accessed_at ?? 0),
    created_at: Number(row.created_at),
    schema_version: Number(row.schema_version ?? 1),
  };
}

function mapWorkItem(row: Record<string, unknown>): WorkItem {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: row.session_id != null ? String(row.session_id) : null,
    visibility_class: (row.visibility_class as WorkItem['visibility_class']) ?? 'private',
    title: String(row.title),
    kind: row.kind as WorkItem['kind'],
    status: row.status as WorkItem['status'],
    detail: row.detail != null ? String(row.detail) : null,
    source_working_memory_id: row.source_working_memory_id != null ? Number(row.source_working_memory_id) : null,
    version: Number(row.version ?? 1),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch { return []; }
  }
  return [];
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function serializeActorMetadata(
  actor: ActorRef,
): [string, string, string | null, string | null, string | null] {
  return [
    actor.actor_kind,
    actor.actor_id,
    actor.system_id ?? null,
    actor.display_name ?? null,
    actor.metadata ? JSON.stringify(actor.metadata) : null,
  ];
}

function parseActorRef(
  row: Record<string, unknown>,
  prefix: 'actor' | 'from_actor' | 'to_actor',
): ActorRef {
  const base = `${prefix}_`;
  return {
    actor_kind: String(row[`${base}kind`]) as ActorRef['actor_kind'],
    actor_id: String(row[`${base}id`]),
    system_id: row[`${base}system_id`] != null ? String(row[`${base}system_id`]) : null,
    display_name:
      row[`${base}display_name`] != null ? String(row[`${base}display_name`]) : null,
    metadata: parseJsonObject(row[`${base}metadata`]) ?? null,
  };
}

function sameActor(actor: Pick<ActorRef, 'actor_kind' | 'actor_id'>, other: Pick<ActorRef, 'actor_kind' | 'actor_id'>): boolean {
  return actor.actor_kind === other.actor_kind && actor.actor_id === other.actor_id;
}

function mapPlaybook(row: Record<string, unknown>): Playbook {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    visibility_class: (row.visibility_class as Playbook['visibility_class']) ?? 'private',
    title: String(row.title),
    description: String(row.description),
    instructions: String(row.instructions),
    references: parseJsonStringArray(row.references_json),
    templates: parseJsonStringArray(row.templates),
    scripts: parseJsonStringArray(row.scripts),
    assets: parseJsonStringArray(row.assets),
    tags: parseJsonStringArray(row.tags),
    rationale: row.rationale != null ? String(row.rationale) : null,
    status: row.status as Playbook['status'],
    source_session_id: row.source_session_id != null ? String(row.source_session_id) : null,
    source_working_memory_id: row.source_working_memory_id != null ? Number(row.source_working_memory_id) : null,
    revision_count: Number(row.revision_count ?? 0),
    last_used_at: row.last_used_at != null ? Number(row.last_used_at) : null,
    use_count: Number(row.use_count ?? 0),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    schema_version: Number(row.schema_version ?? 1),
  };
}

function mapPlaybookRevision(row: Record<string, unknown>): PlaybookRevision {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    playbook_id: Number(row.playbook_id),
    instructions: String(row.instructions),
    revision_reason: String(row.revision_reason),
    source_session_id: row.source_session_id != null ? String(row.source_session_id) : null,
    created_at: Number(row.created_at),
  };
}

function mapAssociation(row: Record<string, unknown>): Association {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    visibility_class: (row.visibility_class as Association['visibility_class']) ?? 'private',
    source_kind: row.source_kind as AssociationTargetKind,
    source_id: Number(row.source_id),
    target_kind: row.target_kind as AssociationTargetKind,
    target_id: Number(row.target_id),
    association_type: row.association_type as Association['association_type'],
    provenance: (row.provenance as Association['provenance']) ?? 'inferred',
    confidence: row.confidence != null ? Number(row.confidence) : 0.8,
    auto_generated: Boolean(row.auto_generated),
    created_at: Number(row.created_at),
  };
}

function mapWorkClaim(row: Record<string, unknown>): WorkClaim {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    work_item_id: Number(row.work_item_id),
    actor: parseActorRef(row, 'actor'),
    session_id: row.session_id != null ? String(row.session_id) : null,
    claim_token: String(row.claim_token),
    status: row.status as WorkClaim['status'],
    claimed_at: Number(row.claimed_at),
    expires_at: Number(row.expires_at),
    released_at: row.released_at != null ? Number(row.released_at) : null,
    release_reason: row.release_reason != null ? String(row.release_reason) : null,
    source_event_id: row.source_event_id != null ? String(row.source_event_id) : null,
    visibility_class: row.visibility_class as WorkClaim['visibility_class'],
    version: Number(row.version ?? 1),
  };
}

// Phase 2.5: read paths compute EFFECTIVE claim status without writing.
function isClaimExpired(claim: WorkClaim, now: number): boolean {
  return claim.status === 'active' && claim.expires_at <= now;
}

/**
 * Effective view of a claim at `now` WITHOUT mutating stored state (Phase 2.5).
 * A read that observes an active-but-expired claim returns a copy whose status
 * is `expired`; the underlying row is left untouched — durable expiry happens
 * only in claim/renew/release and `expireStaleClaims` (the reaper). Mirrors the
 * in-memory reference `effectiveClaim`.
 */
function effectiveClaim(claim: WorkClaim, now: number): WorkClaim {
  if (!isClaimExpired(claim, now)) return claim;
  return {
    ...claim,
    status: 'expired',
    released_at: claim.released_at ?? now,
    release_reason: claim.release_reason ?? 'expired',
  };
}

function isHandoffExpired(handoff: HandoffRecord, now: number): boolean {
  return handoff.status === 'pending' && handoff.expires_at != null && handoff.expires_at <= now;
}

/**
 * Effective view of a handoff at `now` WITHOUT mutating stored state (Phase 2.5,
 * D5 — handoff analogue of {@link effectiveClaim}). A read that observes a
 * pending-but-expired handoff returns a copy whose status is `expired`; the
 * underlying row is left untouched — durable expiry happens only in
 * accept/reject/cancel and `expireStaleHandoffs` (the reaper). Mirrors the
 * in-memory reference `effectiveHandoff`.
 */
function effectiveHandoff(handoff: HandoffRecord, now: number): HandoffRecord {
  if (!isHandoffExpired(handoff, now)) return handoff;
  return {
    ...handoff,
    status: 'expired',
    decision_reason: handoff.decision_reason ?? 'expired',
  };
}

function mapHandoff(row: Record<string, unknown>): HandoffRecord {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    work_item_id: Number(row.work_item_id),
    from_actor: parseActorRef(row, 'from_actor'),
    to_actor: parseActorRef(row, 'to_actor'),
    session_id: row.session_id != null ? String(row.session_id) : null,
    summary: String(row.summary),
    context_bundle_ref: row.context_bundle_ref != null ? String(row.context_bundle_ref) : null,
    status: row.status as HandoffRecord['status'],
    created_at: Number(row.created_at),
    accepted_at: row.accepted_at != null ? Number(row.accepted_at) : null,
    rejected_at: row.rejected_at != null ? Number(row.rejected_at) : null,
    canceled_at: row.canceled_at != null ? Number(row.canceled_at) : null,
    expires_at: row.expires_at != null ? Number(row.expires_at) : null,
    decision_reason: row.decision_reason != null ? String(row.decision_reason) : null,
    source_event_id: row.source_event_id != null ? String(row.source_event_id) : null,
    visibility_class: row.visibility_class as HandoffRecord['visibility_class'],
    version: Number(row.version ?? 1),
  };
}

function mapContextMonitor(row: Record<string, unknown>): ContextMonitor {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    compaction_state: row.compaction_state as ContextMonitor['compaction_state'],
    active_turn_count: Number(row.active_turn_count),
    active_token_estimate: Number(row.active_token_estimate),
    compaction_score: Number(row.compaction_score),
    last_compaction_at: row.last_compaction_at != null ? Number(row.last_compaction_at) : null,
    updated_at: Number(row.updated_at),
  };
}

function mapCompactionLog(row: Record<string, unknown>): CompactionLog {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: String(row.session_id),
    trigger_type: row.trigger_type as CompactionLog['trigger_type'],
    turn_id_start: Number(row.turn_id_start),
    turn_id_end: Number(row.turn_id_end),
    turns_compacted: Number(row.turns_compacted),
    tokens_compacted_estimate: Number(row.tokens_compacted_estimate),
    working_memory_id: Number(row.working_memory_id),
    active_turn_count_before: Number(row.active_turn_count_before),
    active_turn_count_after: Number(row.active_turn_count_after),
    duration_ms: Number(row.duration_ms),
    model_call_made: Boolean(row.model_call_made),
    created_at: Number(row.created_at),
  };
}

function mapKnowledgeMemoryAudit(row: Record<string, unknown>): KnowledgeMemoryAudit {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    working_memory_id: Number(row.working_memory_id),
    fact: String(row.fact),
    fact_type: row.fact_type as KnowledgeMemoryAudit['fact_type'],
    fact_subject: row.fact_subject != null ? String(row.fact_subject) : null,
    fact_attribute: row.fact_attribute != null ? String(row.fact_attribute) : null,
    fact_value: row.fact_value != null ? String(row.fact_value) : null,
    normalized_fact: row.normalized_fact != null ? String(row.normalized_fact) : null,
    slot_key: row.slot_key != null ? String(row.slot_key) : null,
    is_negated: Boolean(row.is_negated),
    confidence: row.confidence as KnowledgeMemoryAudit['confidence'],
    confidence_score: Number(row.confidence_score ?? 0.5),
    verification_status:
      (row.verification_status as KnowledgeMemoryAudit['verification_status']) ?? 'unverified',
    source_text: String(row.source_text),
    decision: row.decision as KnowledgeMemoryAudit['decision'],
    detail: row.detail != null ? String(row.detail) : null,
    related_knowledge_id: row.related_knowledge_id != null ? Number(row.related_knowledge_id) : null,
    created_knowledge_id: row.created_knowledge_id != null ? Number(row.created_knowledge_id) : null,
    created_at: Number(row.created_at),
  };
}

function mapKnowledgeCandidate(row: Record<string, unknown>): KnowledgeCandidate {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    working_memory_id: Number(row.working_memory_id),
    fact: String(row.fact),
    fact_type: row.fact_type as KnowledgeCandidate['fact_type'],
    knowledge_class: row.knowledge_class as KnowledgeCandidate['knowledge_class'],
    normalized_fact: String(row.normalized_fact),
    slot_key: row.slot_key != null ? String(row.slot_key) : null,
    confidence: row.confidence as KnowledgeCandidate['confidence'],
    source_summary: Boolean(row.source_summary),
    source_turns: Boolean(row.source_turns),
    grounding_strength: row.grounding_strength as KnowledgeCandidate['grounding_strength'],
    evidence_count: Number(row.evidence_count ?? 0),
    trust_score: Number(row.trust_score ?? 0),
    state: row.state as KnowledgeCandidate['state'],
    created_at: Number(row.created_at),
    promoted_knowledge_id:
      row.promoted_knowledge_id != null ? Number(row.promoted_knowledge_id) : null,
  };
}

function mapKnowledgeEvidenceRow(row: Record<string, unknown>): KnowledgeEvidence {
  return {
    id: Number(row.id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    knowledge_memory_id: row.knowledge_memory_id != null ? Number(row.knowledge_memory_id) : null,
    knowledge_candidate_id:
      row.knowledge_candidate_id != null ? Number(row.knowledge_candidate_id) : null,
    working_memory_id: row.working_memory_id != null ? Number(row.working_memory_id) : null,
    turn_id: row.turn_id != null ? Number(row.turn_id) : null,
    source_type: row.source_type as KnowledgeEvidence['source_type'],
    support_polarity: row.support_polarity as KnowledgeEvidence['support_polarity'],
    speaker_role:
      row.speaker_role != null ? (row.speaker_role as KnowledgeEvidence['speaker_role']) : null,
    actor: row.actor != null ? String(row.actor) : null,
    excerpt: String(row.excerpt),
    start_offset: row.start_offset != null ? Number(row.start_offset) : null,
    end_offset: row.end_offset != null ? Number(row.end_offset) : null,
    is_explicit: Boolean(row.is_explicit),
    explicitness_score: Number(row.explicitness_score ?? 0),
    outcome: row.outcome != null ? (row.outcome as KnowledgeEvidence['outcome']) : null,
    created_at: Number(row.created_at),
  };
}

function mapMemoryEventRecord(row: Record<string, unknown>): MemoryEventRecord {
  return {
    event_id: String(row.event_id),
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: row.session_id != null ? String(row.session_id) : null,
    actor_id: row.actor_id != null ? String(row.actor_id) : null,
    actor_kind: row.actor_kind != null ? String(row.actor_kind) : null,
    actor_system_id: row.actor_system_id != null ? String(row.actor_system_id) : null,
    actor_display_name: row.actor_display_name != null ? String(row.actor_display_name) : null,
    actor_metadata: parseJsonObject(row.actor_metadata) ?? null,
    entity_kind: row.entity_kind as MemoryEventEntityKind,
    entity_id: String(row.entity_id),
    event_type: row.event_type as MemoryEventRecord['event_type'],
    payload: parseJsonObject(row.payload) ?? {},
    causation_id: row.causation_id != null ? String(row.causation_id) : null,
    correlation_id: row.correlation_id != null ? String(row.correlation_id) : null,
    created_at: Number(row.created_at),
  };
}

function mapSessionStateProjection(row: Record<string, unknown>): SessionStateProjection {
  return {
    tenant_id: String(row.tenant_id),
    system_id: String(row.system_id),
    workspace_id: String(row.workspace_id ?? ''),
    collaboration_id: String(row.collaboration_id ?? ''),
    scope_id: String(row.scope_id),
    session_id: String(row.session_id),
    currentObjective: row.current_objective != null ? String(row.current_objective) : null,
    blockers: parseJsonStringArray(row.blockers),
    assumptions: parseJsonStringArray(row.assumptions),
    pendingDecisions: parseJsonStringArray(row.pending_decisions),
    activeTools: parseJsonStringArray(row.active_tools),
    recentOutputs: parseJsonStringArray(row.recent_outputs),
    updatedAt: Number(row.updated_at),
    source_event_id: row.source_event_id != null ? String(row.source_event_id) : null,
  };
}

function mapTemporalProjectionWatermark(
  row: Record<string, unknown>,
): TemporalProjectionWatermark {
  return {
    projection_name: String(row.projection_name),
    last_event_id: String(row.last_event_id),
    updated_at: Number(row.updated_at),
    cutover_at: row.cutover_at != null ? Number(row.cutover_at) : null,
    metadata: parseJsonObject(row.metadata),
  };
}

/**
 * Creates a PostgreSQL-backed AsyncStorageAdapter.
 *
 * Requires the `pg` package as an optional peer dependency.
 *
 * ```typescript
 * import { createPostgresAdapter } from 'memory-layer/adapters/postgres';
 * import pg from 'pg';
 *
 * const pool = new pg.Pool({ connectionString: 'postgresql://...' });
 * const adapter = createPostgresAdapter(pool);
 * ```
 */
export function createPostgresAdapter(
  pool: PgPool,
  options?: PostgresAdapterOptions,
): AsyncStorageAdapter {
  const now = nowSeconds;
  const txStorage = new AsyncLocalStorage<{
    client: PgClient & { release(): void };
    savepointCounter: number;
  }>();
  const rootPool = pool;
  const rootQuery = rootPool.query.bind(rootPool);
  const scopedQuery = ((text: string, values?: unknown[]) => {
    const context = txStorage.getStore();
    return context ? context.client.query(text, values) : rootQuery(text, values);
  }) as PgPool['query'];
  pool = new Proxy(rootPool, {
    get(target, prop, receiver) {
      if (prop === 'query') return scopedQuery;
      return Reflect.get(target, prop, receiver);
    },
  }) as PgPool;
  let temporalInitPromise: Promise<void> | null = null;

  function resolveEventQuery(query?: MemoryEventQuery): {
    sessionId: string;
    entityKind: MemoryEventEntityKind | null;
    entityId: string;
    startAt: number;
    endAt: number;
    limit: number;
    cursor: TemporalId | null;
  } {
    return {
      sessionId: query?.sessionId ?? '',
      entityKind: query?.entityKind ?? null,
      entityId: query?.entityId ?? '',
      startAt: query?.startAt ?? Number.NEGATIVE_INFINITY,
      endAt: query?.endAt ?? Number.POSITIVE_INFINITY,
      limit: query?.limit ?? 100,
      cursor: query?.cursor != null ? normalizeTemporalId(query.cursor) : null,
    };
  }

  async function getExistingIds(
    table: 'working_memory' | 'knowledge_memory' | 'work_items' | 'playbooks',
    ids: number[],
  ): Promise<number[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return [];
    }
    const { rows } = await pool.query(`SELECT id FROM ${table} WHERE id = ANY($1::int[])`, [
      uniqueIds,
    ]);
    const existing = new Set(rows.map((row) => Number(row.id)));
    return uniqueIds.filter((id) => existing.has(id));
  }

  async function ensureTemporalCutover(): Promise<void> {
    if (!temporalInitPromise) {
      temporalInitPromise = (async () => {
        const current = await readTemporalWatermark('temporal');
        if (current?.cutover_at != null) return;
        const cutoverAt = now();
        await writeTemporalWatermark({
          projection_name: 'temporal',
          last_event_id: current?.last_event_id ?? '0',
          updated_at: cutoverAt,
          cutover_at: cutoverAt,
          metadata: current?.metadata ?? null,
        });
      })();
    }
    return temporalInitPromise;
  }

  async function readTemporalWatermark(
    projectionName = 'temporal',
  ): Promise<TemporalProjectionWatermark | null> {
    const { rows } = await pool.query(
      'SELECT * FROM projection_watermarks WHERE projection_name = $1',
      [projectionName],
    );
    return rows[0] ? mapTemporalProjectionWatermark(rows[0]) : null;
  }

  async function writeTemporalWatermark(
    input: NewTemporalProjectionWatermark,
  ): Promise<TemporalProjectionWatermark> {
    const lastEventId = normalizeTemporalId(input.last_event_id);
    const updatedAt = input.updated_at ?? now();
    const { rows } = await pool.query(
      `INSERT INTO projection_watermarks
        (projection_name, last_event_id, updated_at, cutover_at, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (projection_name) DO UPDATE SET
         last_event_id = EXCLUDED.last_event_id,
         updated_at = EXCLUDED.updated_at,
         cutover_at = EXCLUDED.cutover_at,
         metadata = EXCLUDED.metadata
       RETURNING *`,
      [
        input.projection_name,
        lastEventId,
        updatedAt,
        input.cutover_at ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
    if (rows[0]) {
      return mapTemporalProjectionWatermark(rows[0]);
    }
      return {
      projection_name: input.projection_name,
      last_event_id: lastEventId,
      updated_at: updatedAt,
      cutover_at: input.cutover_at ?? null,
      metadata: input.metadata ?? null,
    };
  }

  async function insertMemoryEventInternal(
    input: NewMemoryEventRecord,
  ): Promise<MemoryEventRecord> {
    await ensureTemporalCutover();
    const normalized = normalizeScope(input);
    const createdAt = input.created_at ?? now();
    const previousWatermark = await readTemporalWatermark('temporal');
    const { rows } = await pool.query(
      `INSERT INTO memory_event_log
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id, actor_id,
         actor_kind, actor_system_id, actor_display_name, actor_metadata,
         entity_kind, entity_id, event_type, payload, causation_id, correlation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15::jsonb, $16, $17, $18)
       RETURNING *`,
      [
        normalized.tenant_id,
        normalized.system_id,
        normalized.workspace_id,
        normalized.collaboration_id,
        normalized.scope_id,
        input.session_id ?? null,
        input.actor_id ?? null,
        input.actor_kind ?? null,
        input.actor_system_id ?? null,
        input.actor_display_name ?? null,
        input.actor_metadata ? JSON.stringify(input.actor_metadata) : null,
        input.entity_kind,
        input.entity_id,
        input.event_type,
        JSON.stringify(input.payload ?? {}),
        input.causation_id ?? null,
        input.correlation_id ?? null,
        createdAt,
      ],
    );
    const record = rows[0]
      ? mapMemoryEventRecord(rows[0])
      : {
          event_id: normalizeTemporalId(
            BigInt(previousWatermark?.last_event_id ?? '0') + 1n,
          ),
          tenant_id: normalized.tenant_id,
          system_id: normalized.system_id,
          workspace_id: normalized.workspace_id,
          collaboration_id: normalized.collaboration_id,
          scope_id: normalized.scope_id,
          session_id: input.session_id ?? null,
          actor_id: input.actor_id ?? null,
          actor_kind: input.actor_kind ?? null,
          actor_system_id: input.actor_system_id ?? null,
          actor_display_name: input.actor_display_name ?? null,
          actor_metadata: input.actor_metadata ?? null,
          entity_kind: input.entity_kind,
          entity_id: input.entity_id,
          event_type: input.event_type,
          payload: input.payload ?? {},
          causation_id: input.causation_id ?? null,
          correlation_id: input.correlation_id ?? null,
          created_at: createdAt,
        };
    await writeTemporalWatermark({
      projection_name: 'temporal',
      last_event_id: record.event_id,
      updated_at: createdAt,
      cutover_at: previousWatermark?.cutover_at ?? createdAt,
      metadata: previousWatermark?.metadata ?? null,
    });
    return record;
  }

  async function insertMemoryEventsBatchInternal(
    inputs: NewMemoryEventRecord[],
  ): Promise<MemoryEventRecord[]> {
    if (inputs.length === 0) return [];
    await ensureTemporalCutover();
    const previousWatermark = await readTemporalWatermark('temporal');
    const values: string[] = [];
    const params: unknown[] = [];
    let nextParam = 1;
    for (const input of inputs) {
      const normalized = normalizeScope(input);
      const createdAt = input.created_at ?? now();
      values.push(
        `($${nextParam}, $${nextParam + 1}, $${nextParam + 2}, $${nextParam + 3}, $${nextParam + 4}, $${nextParam + 5}, $${nextParam + 6}, $${nextParam + 7}, $${nextParam + 8}, $${nextParam + 9}, $${nextParam + 10}::jsonb, $${nextParam + 11}, $${nextParam + 12}, $${nextParam + 13}, $${nextParam + 14}::jsonb, $${nextParam + 15}, $${nextParam + 16}, $${nextParam + 17})`,
      );
      params.push(
        normalized.tenant_id,
        normalized.system_id,
        normalized.workspace_id,
        normalized.collaboration_id,
        normalized.scope_id,
        input.session_id ?? null,
        input.actor_id ?? null,
        input.actor_kind ?? null,
        input.actor_system_id ?? null,
        input.actor_display_name ?? null,
        input.actor_metadata ? JSON.stringify(input.actor_metadata) : null,
        input.entity_kind,
        input.entity_id,
        input.event_type,
        JSON.stringify(input.payload ?? {}),
        input.causation_id ?? null,
        input.correlation_id ?? null,
        createdAt,
      );
      nextParam += 18;
    }
    const { rows } = await pool.query(
      `INSERT INTO memory_event_log
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id, actor_id,
         actor_kind, actor_system_id, actor_display_name, actor_metadata,
         entity_kind, entity_id, event_type, payload, causation_id, correlation_id, created_at)
       VALUES ${values.join(', ')}
       RETURNING *`,
      params,
    );
    const records = rows
      .map(mapMemoryEventRecord)
      .sort((a, b) => a.created_at - b.created_at || compareTemporalIds(a.event_id, b.event_id));
    const lastRecord = records[records.length - 1];
    if (lastRecord) {
      await writeTemporalWatermark({
        projection_name: 'temporal',
        last_event_id: lastRecord.event_id,
        updated_at: lastRecord.created_at,
        cutover_at: previousWatermark?.cutover_at ?? lastRecord.created_at,
        metadata: previousWatermark?.metadata ?? null,
      });
    }
    return records;
  }

  async function listScopedMemoryEvents(
    scope: MemoryScope,
    query?: MemoryEventQuery,
  ): Promise<TimelineResult> {
    await ensureTemporalCutover();
    const resolved = resolveEventQuery(query);
    // created_at bounds are optional: an unbounded query resolves startAt/endAt to
    // ±Infinity (fine for the JS/SQLite adapters, but Postgres rejects binding a
    // non-finite value to the INTEGER created_at column — 22P02). Only emit a bound
    // clause when the bound is finite.
    const params: unknown[] = [...scopeParams(scope)];
    const clauses = [`${scopeWhere()}`];
    if (Number.isFinite(resolved.startAt)) {
      params.push(resolved.startAt);
      clauses.push(`created_at >= $${params.length}`);
    }
    if (Number.isFinite(resolved.endAt)) {
      params.push(resolved.endAt);
      clauses.push(`created_at <= $${params.length}`);
    }
    let nextParam = params.length + 1;
    if (resolved.cursor != null && compareTemporalIds(resolved.cursor, '0') > 0) {
      clauses.push(`event_id > $${nextParam}::bigint`);
      params.push(resolved.cursor);
      nextParam += 1;
    }
    if (resolved.sessionId) {
      clauses.push(`session_id = $${nextParam}`);
      params.push(resolved.sessionId);
      nextParam += 1;
    }
    if (resolved.entityKind) {
      clauses.push(`entity_kind = $${nextParam}`);
      params.push(resolved.entityKind);
      nextParam += 1;
    }
    if (resolved.entityId) {
      clauses.push(`entity_id = $${nextParam}`);
      params.push(resolved.entityId);
      nextParam += 1;
    }
    params.push(resolved.limit + 1);
    const { rows } = await pool.query(
      // Phase 2.3: ordering is event_id ASC ALONE. event_id is an append-only
      // BIGSERIAL assigned in the same transaction as the mutation, so it is the
      // true causal order. created_at is display metadata (may be caller-supplied
      // or backdated) and must NEVER be an ORDER BY key — pairing it with the
      // `event_id > cursor` pagination cursor caused skips/repeats when rows had
      // backdated timestamps.
      `SELECT * FROM memory_event_log
       WHERE ${clauses.join(' AND ')}
       ORDER BY event_id ASC
       LIMIT $${nextParam}`,
      params,
    );
    const items = rows.slice(0, resolved.limit).map(mapMemoryEventRecord);
    return {
      events: items,
      nextCursor: rows.length > resolved.limit ? items[items.length - 1]?.event_id ?? null : null,
    };
  }

  async function listScopedMemoryEventsCrossScope(
    scope: MemoryScope,
    level: ScopeLevel,
    query?: MemoryEventQuery,
  ): Promise<TimelineResult> {
    await ensureTemporalCutover();
    const resolved = resolveEventQuery(query);
    // See listScopedMemoryEvents: omit non-finite created_at bounds (Postgres 22P02).
    const params: unknown[] = [...wideScopeParams(scope, level)];
    const clauses = [`${wideScopeWhere(scope, level)}`];
    if (Number.isFinite(resolved.startAt)) {
      params.push(resolved.startAt);
      clauses.push(`created_at >= $${params.length}`);
    }
    if (Number.isFinite(resolved.endAt)) {
      params.push(resolved.endAt);
      clauses.push(`created_at <= $${params.length}`);
    }
    let nextParam = params.length + 1;
    if (resolved.cursor != null && compareTemporalIds(resolved.cursor, '0') > 0) {
      clauses.push(`event_id > $${nextParam}::bigint`);
      params.push(resolved.cursor);
      nextParam += 1;
    }
    if (resolved.sessionId) {
      clauses.push(`session_id = $${nextParam}`);
      params.push(resolved.sessionId);
      nextParam += 1;
    }
    if (resolved.entityKind) {
      clauses.push(`entity_kind = $${nextParam}`);
      params.push(resolved.entityKind);
      nextParam += 1;
    }
    if (resolved.entityId) {
      clauses.push(`entity_id = $${nextParam}`);
      params.push(resolved.entityId);
      nextParam += 1;
    }
    params.push(resolved.limit + 1);
    const { rows } = await pool.query(
      // Phase 2.3: event_id ASC alone (see listScopedMemoryEvents).
      `SELECT * FROM memory_event_log
       WHERE ${clauses.join(' AND ')}
       ORDER BY event_id ASC
       LIMIT $${nextParam}`,
      params,
    );
    const items = rows.slice(0, resolved.limit).map(mapMemoryEventRecord);
    return {
      events: items,
      nextCursor: rows.length > resolved.limit ? items[items.length - 1]?.event_id ?? null : null,
    };
  }

  async function readSessionStateProjection(
    scope: MemoryScope,
    sessionId: string,
  ): Promise<SessionStateProjection | null> {
    const { rows } = await pool.query(
      `SELECT * FROM session_state_current WHERE ${scopeWhere()} AND session_id = $6`,
      [...scopeParams(scope), sessionId],
    );
    return rows[0] ? mapSessionStateProjection(rows[0]) : null;
  }

  async function writeSessionStateProjection(
    input: NewSessionStateProjection,
  ): Promise<SessionStateProjection> {
    const normalized = normalizeScope(input);
    const { rows } = await pool.query(
      `INSERT INTO session_state_current
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id,
         current_objective, blockers, assumptions, pending_decisions, active_tools, recent_outputs,
         updated_at, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
       ON CONFLICT (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id) DO UPDATE SET
         current_objective = EXCLUDED.current_objective,
         blockers = EXCLUDED.blockers,
         assumptions = EXCLUDED.assumptions,
         pending_decisions = EXCLUDED.pending_decisions,
         active_tools = EXCLUDED.active_tools,
         recent_outputs = EXCLUDED.recent_outputs,
         updated_at = EXCLUDED.updated_at,
         source_event_id = EXCLUDED.source_event_id
       RETURNING *`,
      [
        normalized.tenant_id,
        normalized.system_id,
        normalized.workspace_id,
        normalized.collaboration_id,
        normalized.scope_id,
        input.session_id,
        input.currentObjective,
        JSON.stringify(input.blockers),
        JSON.stringify(input.assumptions),
        JSON.stringify(input.pendingDecisions),
        JSON.stringify(input.activeTools),
        JSON.stringify(input.recentOutputs),
        input.updatedAt,
        input.source_event_id != null ? normalizeTemporalId(input.source_event_id) : null,
      ],
    );
    return mapSessionStateProjection(rows[0]);
  }

  async function expireClaimRecord(
    row: Record<string, unknown>,
    expiredAt = now(),
  ): Promise<WorkClaim | null> {
    // Phase 0.2 (race fix): the UPDATE is self-guarding. Under concurrency a
    // stale caller may still hold a pre-SELECT snapshot showing an
    // active-but-expired claim after another racer has already expired or
    // re-claimed the row. The status/expiry guard makes rowCount the authority:
    // 0 affected rows means someone else already handled it — treat as
    // already-expired and do NOT emit a (bogus) work_claim.expired event.
    const { rows, rowCount } = await pool.query(
      `UPDATE work_claims_current
       SET status = 'expired', released_at = $2, release_reason = 'expired', version = COALESCE(version, 1) + 1
       WHERE id = $1 AND status = 'active' AND expires_at <= $2
       RETURNING *`,
      [Number(row.id), expiredAt],
    );
    if (rowCount === 0 || !rows[0]) {
      return null;
    }
    const expired = mapWorkClaim(rows[0]);
    await insertMemoryEventInternal({
      ...normalizeScope(expired),
      session_id: expired.session_id,
      actor_id: expired.actor.actor_id,
      actor_kind: expired.actor.actor_kind,
      actor_system_id: expired.actor.system_id,
      actor_display_name: expired.actor.display_name,
      actor_metadata: expired.actor.metadata,
      entity_kind: 'work_claim',
      entity_id: String(expired.id),
      event_type: 'work_claim.expired',
      payload: { after: expired },
      created_at: expiredAt,
    });
    return expired;
  }

  async function expireHandoffRecord(
    row: Record<string, unknown>,
    expiredAt = now(),
  ): Promise<HandoffRecord | null> {
    // Phase 2.5 (D5) race fix: the UPDATE is self-guarding, mirroring
    // expireClaimRecord. The prior `WHERE id = $1` (only) flipped the row and
    // emitted handoff.expired UNCONDITIONALLY, so two concurrent readers (the
    // old write-on-read listHandoffs) or a reaper racing accept/reject/cancel
    // could each emit a duplicate handoff.expired for the same handoff. The
    // status/expiry guard makes rowCount the authority: 0 affected rows means
    // someone else already handled it — return null and emit NOTHING.
    const { rows, rowCount } = await pool.query(
      `UPDATE handoff_records
       SET status = 'expired', decision_reason = COALESCE(decision_reason, 'expired'), version = COALESCE(version, 1) + 1
       WHERE id = $1 AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $2
       RETURNING *`,
      [Number(row.id), expiredAt],
    );
    if (rowCount === 0 || !rows[0]) {
      return null;
    }
    const expired = mapHandoff(rows[0]);
    await insertMemoryEventInternal({
      ...normalizeScope(expired),
      session_id: expired.session_id,
      actor_id: expired.to_actor.actor_id,
      actor_kind: expired.to_actor.actor_kind,
      actor_system_id: expired.to_actor.system_id,
      actor_display_name: expired.to_actor.display_name,
      actor_metadata: expired.to_actor.metadata,
      entity_kind: 'handoff',
      entity_id: String(expired.id),
      event_type: 'handoff.expired',
      payload: { after: expired },
      created_at: expiredAt,
    });
    return expired;
  }

  async function getAnyClaimRowByWorkItem(workItemId: number): Promise<Record<string, unknown> | null> {
    const { rows } = await pool.query(
      'SELECT * FROM work_claims_current WHERE work_item_id = $1 ORDER BY id DESC LIMIT 1',
      [workItemId],
    );
    return rows[0] ?? null;
  }

  return {
    async insertTurn(input: NewTurn): Promise<Turn> {
      // Phase 2.1: row-write + event-write share ONE connection inside a
      // BEGIN/COMMIT (this.transaction reuses the ambient tx client when nested,
      // otherwise opens a fresh single-connection transaction). This closes the
      // pooled-connection split where the two statements could land on different
      // physical connections and half-commit.
      return this.transaction(async () => {
        const n = normalizeScope(input);
        const createdAt = now();
        const tokenEst = input.token_estimate ?? estimateTokens(input.content);
        const { rows } = await pool.query(
          `INSERT INTO turns (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id, actor, role, content, priority, token_estimate, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id, input.session_id, input.actor, input.role, input.content, input.priority ?? (input.role === 'system' ? 1.5 : 1), tokenEst, createdAt],
        );
        const turn = mapTurn(rows[0]);
        await insertMemoryEventInternal({
          ...n,
          session_id: turn.session_id,
          actor_id: turn.actor,
          entity_kind: 'turn',
          entity_id: String(turn.id),
          event_type: 'turn.created',
          payload: {
            after: turn,
          },
          created_at: createdAt,
        });
        return turn;
      });
    },

    async insertTurns(inputs) {
      return this.transaction(async () => {
        const inserted: Turn[] = [];
        for (const input of inputs) {
          inserted.push(await this.insertTurn(input));
        }
        return inserted;
      });
    },

    async getTurnById(id) {
      const { rows } = await pool.query('SELECT * FROM turns WHERE id = $1', [id]);
      return rows[0] ? mapTurn(rows[0]) : null;
    },

    async getActiveTurns(scope, sessionId) {
      const params = sessionId ? [...scopeParams(scope), sessionId] : scopeParams(scope);
      const { rows } = await pool.query(
        `SELECT * FROM turns WHERE ${scopeWhere()} AND status = 'active'${sessionId ? ' AND session_id = $6' : ''} ORDER BY id ASC`,
        params,
      );
      return rows.map(mapTurn);
    },

    async getActiveTurnsPaginated(scope, options): Promise<PaginatedResult<Turn>> {
      const resolved = resolvePaginationOptions(options);
      const params = [...scopeParams(scope)];
      let query = `SELECT * FROM turns WHERE ${scopeWhere()} AND status = 'active'`;
      if (resolved.cursor > 0) {
        params.push(resolved.cursor);
        query += ` AND id > $${params.length}`;
      }
      query += ' ORDER BY id ASC';
      params.push(resolved.limit + 1);
      query += ` LIMIT $${params.length}`;
      if (resolved.cursor === 0) {
        params.push(resolved.offset);
        query += ` OFFSET $${params.length}`;
      }
      const { rows } = await pool.query(query, params);
      const items = rows.slice(0, resolved.limit).map(mapTurn);
      return {
        items,
        hasMore: rows.length > resolved.limit,
        nextCursor: rows.length > resolved.limit ? items[items.length - 1]?.id ?? null : null,
      };
    },

    async getTurnsByTimeRange(scope, range) {
      const params = scopeParams(scope);
      let query = `SELECT * FROM turns WHERE ${scopeWhere()}`;
      if (range.start_at != null) {
        params.push(range.start_at);
        query += ` AND created_at >= $${params.length}`;
      }
      if (range.end_at != null) {
        params.push(range.end_at);
        query += ` AND created_at <= $${params.length}`;
      }
      query += ' ORDER BY id ASC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapTurn);
    },

    async searchTurns(scope, queryText, searchOptions) {
      // scopeParams occupies $1..$5. queryText binds at $6 and limit at $7.
      const resolved = resolveSearchOptions(searchOptions);
      const params = scopeParams(scope);
      const limit = resolved.limit;
      params.push(queryText, limit);
      const activeClause = resolved.activeOnly ? ` AND status = 'active'` : '';
      const { rows } = await pool.query(
        `SELECT *, ts_rank(search_vector, plainto_tsquery('english', $6)) AS rank
         FROM turns
         WHERE ${scopeWhere()} ${activeClause}
           AND search_vector @@ plainto_tsquery('english', $6)
         ORDER BY rank DESC
         LIMIT $7`,
        params,
      );
      return rows.map((row) => ({
        item: mapTurn(row),
        rank: Number(row.rank),
      }));
    },

    async archiveTurn(id, archivedAt, compactionLogId) {
      // Phase 2.1: atomic row-update + event (single connection, BEGIN/COMMIT).
      await this.transaction(async () => {
        const before = await this.getTurnById(id);
        await pool.query(
          `UPDATE turns SET status = 'archived', archived_at = $2, compaction_log_id = $3 WHERE id = $1`,
          [id, archivedAt, compactionLogId],
        );
        const after = await this.getTurnById(id);
        if (before && after) {
          await insertMemoryEventInternal({
            ...normalizeScope(after),
            session_id: after.session_id,
            actor_id: after.actor,
            entity_kind: 'turn',
            entity_id: String(after.id),
            event_type: 'turn.archived',
            payload: {
              before,
              after,
              patch: {
                archived_at: archivedAt,
                compaction_log_id: compactionLogId,
              },
            },
            created_at: archivedAt,
          });
        }
      });
    },

    async getArchivedTurnRange(sessionId, startId, endId, scope) {
      const n = normalizeScope(scope);
      const params: unknown[] = [
        sessionId,
        startId,
        endId,
        n.tenant_id,
        n.system_id,
        n.workspace_id,
        n.collaboration_id,
        n.scope_id,
      ];
      let query =
        `SELECT * FROM turns WHERE session_id = $1 AND id >= $2 AND id <= $3 AND status = 'archived'` +
        ` AND tenant_id = $4 AND system_id = $5 AND workspace_id = $6 AND collaboration_id = $7 AND scope_id = $8`;
      query += ' ORDER BY id ASC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapTurn);
    },

    async insertWorkingMemory(input) {
      // Phase 2.1: atomic row + event.
      return this.transaction(async () => {
        const n = normalizeScope(input);
        const createdAt = now();
        const { rows } = await pool.query(
          `INSERT INTO working_memory (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id, summary, key_entities, topic_tags, turn_id_start, turn_id_end, turn_count, compaction_trigger, created_at, episode_recap)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING *`,
          [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id, input.session_id, input.summary,
           JSON.stringify(input.key_entities), JSON.stringify(input.topic_tags),
           input.turn_id_start, input.turn_id_end, input.turn_count, input.compaction_trigger, createdAt,
           input.episode_recap ? JSON.stringify(input.episode_recap) : null],
        );
        const workingMemory = mapWorkingMemory(rows[0]);
        await insertMemoryEventInternal({
          ...n,
          session_id: workingMemory.session_id,
          entity_kind: 'working_memory',
          entity_id: String(workingMemory.id),
          event_type: 'working_memory.created',
          payload: {
            after: workingMemory,
          },
          created_at: createdAt,
        });
        return workingMemory;
      });
    },

    async getWorkingMemoryById(id) {
      const { rows } = await pool.query('SELECT * FROM working_memory WHERE id = $1', [id]);
      return rows[0] ? mapWorkingMemory(rows[0]) : null;
    },

    async getExistingWorkingMemoryIds(ids) {
      return getExistingIds('working_memory', ids);
    },

    async getWorkingMemoryBySession(sessionId, scope) {
      const params = [sessionId, ...scopeParams(scope)];
      const { rows } = await pool.query(
        `SELECT * FROM working_memory WHERE session_id = $1 AND tenant_id = $2 AND system_id = $3 AND workspace_id = $4 AND collaboration_id = $5 AND scope_id = $6 ORDER BY id DESC`,
        params,
      );
      return rows.map(mapWorkingMemory);
    },

    async getActiveWorkingMemory(scope, sessionId) {
      const params = sessionId ? [...scopeParams(scope), sessionId] : scopeParams(scope);
      const { rows } = await pool.query(
        `SELECT * FROM working_memory WHERE ${scopeWhere()} AND status = 'active'${sessionId ? ' AND session_id = $6' : ''} ORDER BY id DESC`,
        params,
      );
      return rows.map(mapWorkingMemory);
    },

    async getLatestWorkingMemory(scope, sessionId) {
      const params = sessionId ? [...scopeParams(scope), sessionId] : scopeParams(scope);
      const { rows } = await pool.query(
        `SELECT * FROM working_memory WHERE ${scopeWhere()} AND status = 'active'${sessionId ? ' AND session_id = $6' : ''} ORDER BY id DESC LIMIT 1`,
        params,
      );
      return rows[0] ? mapWorkingMemory(rows[0]) : null;
    },

    async getWorkingMemoryByTimeRange(scope, range) {
      const params = scopeParams(scope);
      let query = `SELECT * FROM working_memory WHERE ${scopeWhere()}`;
      if (range.start_at != null) {
        params.push(range.start_at);
        query += ` AND created_at >= $${params.length}`;
      }
      if (range.end_at != null) {
        params.push(range.end_at);
        query += ` AND created_at <= $${params.length}`;
      }
      query += ' ORDER BY id DESC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapWorkingMemory);
    },

    async expireWorkingMemory(id) {
      // Phase 2.1: atomic row-update + event.
      await this.transaction(async () => {
        const before = await this.getWorkingMemoryById(id);
        const expiredAt = now();
        await pool.query(`UPDATE working_memory SET status = 'expired', expires_at = $2 WHERE id = $1`, [id, expiredAt]);
        const after = await this.getWorkingMemoryById(id);
        if (before && after) {
          await insertMemoryEventInternal({
            ...normalizeScope(after),
            session_id: after.session_id,
            entity_kind: 'working_memory',
            entity_id: String(after.id),
            event_type: 'working_memory.expired',
            payload: {
              before,
              after,
              patch: {
                expires_at: expiredAt,
              },
            },
            created_at: expiredAt,
          });
        }
      });
    },

    async markWorkingMemoryPromoted(id, knowledgeMemoryId) {
      // Phase 2.1: atomic row-update + event.
      await this.transaction(async () => {
        const before = await this.getWorkingMemoryById(id);
        await pool.query(`UPDATE working_memory SET promoted_to_knowledge_id = $2 WHERE id = $1`, [id, knowledgeMemoryId]);
        const after = await this.getWorkingMemoryById(id);
        if (before && after) {
          await insertMemoryEventInternal({
            ...normalizeScope(after),
            session_id: after.session_id,
            entity_kind: 'working_memory',
            entity_id: String(after.id),
            event_type: 'working_memory.promoted',
            payload: {
              before,
              after,
              refs: {
                knowledge_memory_id: knowledgeMemoryId,
              },
            },
            created_at: now(),
          });
        }
      });
    },

    async insertKnowledgeMemory(input) {
      // Phase 2.1: atomic row + event.
      return this.transaction(async () => {
        const n = normalizeScope(input);
        const createdAt = now();
        const { rows } = await pool.query(
          `INSERT INTO knowledge_memory (tenant_id, system_id, workspace_id, collaboration_id, scope_id, fact, fact_type, knowledge_state, knowledge_class, fact_subject, fact_attribute, fact_value, normalized_fact, slot_key, is_negated, source, confidence, confidence_score, grounding_strength, evidence_count, trust_score, verification_status, verification_notes, last_verified_at, next_reverification_at, last_confirmed_at, confirmation_count, source_system_id, source_scope_id, source_collaboration_id, source_working_memory_id, source_turn_ids, successful_use_count, failed_use_count, disputed_at, dispute_reason, contradiction_score, superseded_at, retired_at, valid_from, valid_until, rationale, tags, created_at, last_accessed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $44)
           RETURNING *`,
          [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id, input.fact, input.fact_type,
           input.knowledge_state ?? 'trusted', input.knowledge_class ?? 'project_fact',
           input.fact_subject ?? null, input.fact_attribute ?? null, input.fact_value ?? null,
           input.normalized_fact ?? null, input.slot_key ?? null, input.is_negated ?? false,
           input.source, input.confidence ?? 'medium', input.confidence_score ?? 0.5,
           input.grounding_strength ?? 'moderate',
           input.evidence_count ?? Math.max(1, (input.source_turn_ids ?? []).length),
           input.trust_score ?? (input.confidence_score ?? 0.5),
           input.verification_status ?? 'unverified', input.verification_notes ?? null,
           input.last_verified_at ?? null, input.next_reverification_at ?? null,
           input.last_confirmed_at ?? null, input.confirmation_count ?? 0,
           input.source_system_id ?? n.system_id, input.source_scope_id ?? n.scope_id,
           input.source_collaboration_id ?? n.collaboration_id,
           input.source_working_memory_id ?? null, JSON.stringify(input.source_turn_ids ?? []),
           input.successful_use_count ?? 0, input.failed_use_count ?? 0,
           input.disputed_at ?? null, input.dispute_reason ?? null, input.contradiction_score ?? 0,
           input.superseded_at ?? null, input.retired_at ?? null,
           input.valid_from ?? null, input.valid_until ?? null, input.rationale ?? null,
           JSON.stringify(input.tags ?? []), createdAt],
        );
        const knowledge = mapKnowledgeMemory(rows[0]);
        await insertMemoryEventInternal({
          ...n,
          entity_kind: 'knowledge_memory',
          entity_id: String(knowledge.id),
          event_type: 'knowledge.created',
          payload: {
            after: knowledge,
          },
          created_at: createdAt,
        });
        return knowledge;
      });
    },

    async insertKnowledgeMemories(inputs) {
      return this.transaction(async () => {
        const inserted: KnowledgeMemory[] = [];
        for (const input of inputs) {
          inserted.push(await this.insertKnowledgeMemory(input));
        }
        return inserted;
      });
    },

    async insertKnowledgeCandidate(input: NewKnowledgeCandidate): Promise<KnowledgeCandidate> {
      // Phase 2.2: candidate lifecycle is now audited. Row + event are atomic.
      return this.transaction(async () => {
        const n = normalizeScope(input);
        const createdAt = input.created_at ?? now();
        const { rows } = await pool.query(
          `INSERT INTO knowledge_candidate
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, working_memory_id, fact, fact_type,
             knowledge_class, normalized_fact, slot_key, confidence, source_summary, source_turns,
             grounding_strength, evidence_count, trust_score, state, promoted_knowledge_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
           RETURNING *`,
          [
            n.tenant_id,
            n.system_id,
            n.workspace_id,
            n.collaboration_id,
            n.scope_id,
            input.working_memory_id,
            input.fact,
            input.fact_type,
            input.knowledge_class,
            input.normalized_fact,
            input.slot_key ?? null,
            input.confidence,
            input.source_summary ?? false,
            input.source_turns ?? true,
            input.grounding_strength ?? 'weak',
            input.evidence_count ?? 0,
            input.trust_score ?? 0,
            input.state ?? 'candidate',
            input.promoted_knowledge_id ?? null,
            createdAt,
          ],
        );
        const candidate = mapKnowledgeCandidate(rows[0]);
        await insertMemoryEventInternal({
          ...n,
          entity_kind: 'knowledge_candidate',
          entity_id: String(candidate.id),
          event_type: 'knowledge_candidate.created',
          payload: {
            after: candidate,
          },
          created_at: candidate.created_at,
        });
        return candidate;
      });
    },

    async insertKnowledgeCandidates(inputs): Promise<KnowledgeCandidate[]> {
      return this.transaction(async () => {
        const inserted: KnowledgeCandidate[] = [];
        for (const input of inputs) {
          inserted.push(await this.insertKnowledgeCandidate(input));
        }
        return inserted;
      });
    },

    async getKnowledgeCandidateById(id): Promise<KnowledgeCandidate | null> {
      const { rows } = await pool.query('SELECT * FROM knowledge_candidate WHERE id = $1', [id]);
      if (!rows[0]) return null;
      return mapKnowledgeCandidate(rows[0]);
    },

    async listKnowledgeCandidates(scope, options): Promise<KnowledgeCandidate[]> {
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_candidate WHERE ${scopeWhere()} ORDER BY created_at DESC, id DESC`,
        scopeParams(scope),
      );
      return rows
        .map(mapKnowledgeCandidate)
        .filter((item) => !options?.state || options.state.includes(item.state));
    },

    async insertKnowledgeEvidence(input: NewKnowledgeEvidence): Promise<KnowledgeEvidence> {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO knowledge_evidence
          (tenant_id, system_id, workspace_id, collaboration_id, scope_id, knowledge_memory_id, knowledge_candidate_id,
           working_memory_id, turn_id, source_type, support_polarity, speaker_role, actor, excerpt,
           start_offset, end_offset, is_explicit, explicitness_score, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING *`,
        [
          n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id,
          input.knowledge_memory_id ?? null, input.knowledge_candidate_id ?? null,
          input.working_memory_id ?? null, input.turn_id ?? null, input.source_type, input.support_polarity,
          input.speaker_role ?? null, input.actor ?? null, input.excerpt, input.start_offset ?? null,
          input.end_offset ?? null, input.is_explicit ?? false, input.explicitness_score ?? 0,
          input.outcome ?? null, input.created_at ?? now(),
        ],
      );
      return mapKnowledgeEvidenceRow(rows[0]);
    },

    async insertKnowledgeEvidenceBatch(inputs): Promise<KnowledgeEvidence[]> {
      return this.transaction(async () => {
        const inserted: KnowledgeEvidence[] = [];
        for (const input of inputs) {
          inserted.push(await this.insertKnowledgeEvidence(input));
        }
        return inserted;
      });
    },

    async listKnowledgeEvidenceForKnowledge(knowledgeId): Promise<KnowledgeEvidence[]> {
      const { rows } = await pool.query(
        'SELECT * FROM knowledge_evidence WHERE knowledge_memory_id = $1 ORDER BY created_at DESC, id DESC',
        [knowledgeId],
      );
      return rows.map(mapKnowledgeEvidenceRow);
    },

    async listKnowledgeEvidenceForCandidate(candidateId): Promise<KnowledgeEvidence[]> {
      const { rows } = await pool.query(
        'SELECT * FROM knowledge_evidence WHERE knowledge_candidate_id = $1 ORDER BY created_at DESC, id DESC',
        [candidateId],
      );
      return rows.map(mapKnowledgeEvidenceRow);
    },

    async promoteKnowledgeCandidate(candidateId, input): Promise<KnowledgeMemory> {
      // Phase 2.2: candidate flip + knowledge insert + BOTH events are one
      // transaction. A throw anywhere (e.g. knowledge validation) rolls the
      // whole thing back — no orphaned knowledge row, no dangling candidate
      // flip. insertKnowledgeMemory opens a nested SAVEPOINT (ambient client),
      // so it commits/rolls back with this outer transaction.
      return this.transaction(async () => {
        // Phase 2.4 (minor) lock-order fix: acquire the candidate row lock FIRST,
        // BEFORE insertKnowledgeMemory touches the shared projection_watermarks
        // 'temporal' row via its event write. deleteExpiredKnowledgeCandidates
        // locks the candidate (DELETE) then the watermark; without FOR UPDATE
        // here, promotion locked the watermark (inside the knowledge event) then
        // the candidate — the opposite order — so the two could deadlock (ABBA)
        // on (candidate, watermark). Locking the candidate first makes BOTH paths
        // acquire candidate-before-watermark, a consistent global order.
        // NOTE(follow-up, post-4.3.0): every primitive still funnels its event
        // write through the single 'temporal' watermark row, which serializes all
        // concurrent event writers on one hot row. That is a throughput limit,
        // not a correctness bug; removing it needs a watermark redesign (e.g. a
        // sequence or per-scope watermark) that is out of scope for this MINOR.
        const { rows: beforeRows } = await pool.query(
          'SELECT * FROM knowledge_candidate WHERE id = $1 FOR UPDATE',
          [candidateId],
        );
        const before = beforeRows[0] ? mapKnowledgeCandidate(beforeRows[0]) : null;
        const knowledge = await this.insertKnowledgeMemory(input);
        const { rows: afterRows } = await pool.query(
          'UPDATE knowledge_candidate SET promoted_knowledge_id = $1, state = $2 WHERE id = $3 RETURNING *',
          [knowledge.id, 'provisional', candidateId],
        );
        if (afterRows[0]) {
          const after = mapKnowledgeCandidate(afterRows[0]);
          await insertMemoryEventInternal({
            ...normalizeScope(after),
            entity_kind: 'knowledge_candidate',
            entity_id: String(after.id),
            event_type: 'knowledge_candidate.promoted',
            payload: {
              before,
              after,
              refs: {
                knowledge_memory_id: knowledge.id,
              },
            },
            created_at: now(),
          });
        }
        return knowledge;
      });
    },

    async deleteExpiredKnowledgeCandidates(scope, olderThan): Promise<number[]> {
      // Phase 2.2: expiry is audited; delete + events are atomic.
      return this.transaction(async () => {
        const n = normalizeScope(scope);
        const { rows } = await pool.query(
          `DELETE FROM knowledge_candidate
           WHERE ${scopeWhere()} AND promoted_knowledge_id IS NULL AND created_at < $6
           RETURNING *`,
          [...scopeParams(n), olderThan],
        );
        const expired = rows.map(mapKnowledgeCandidate);
        for (const candidate of expired) {
          await insertMemoryEventInternal({
            ...normalizeScope(candidate),
            entity_kind: 'knowledge_candidate',
            entity_id: String(candidate.id),
            event_type: 'knowledge_candidate.expired',
            payload: {
              before: candidate,
            },
            created_at: now(),
          });
        }
        return expired.map((candidate) => candidate.id);
      });
    },

    async getKnowledgeMemoryById(id) {
      const { rows } = await pool.query('SELECT * FROM knowledge_memory WHERE id = $1', [id]);
      return rows[0] ? mapKnowledgeMemory(rows[0]) : null;
    },

    async getExistingKnowledgeMemoryIds(ids) {
      return getExistingIds('knowledge_memory', ids);
    },

    async getActiveKnowledgeMemory(scope) {
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory WHERE ${scopeWhere()} AND superseded_by_id IS NULL AND retired_at IS NULL ORDER BY last_accessed_at DESC`,
        scopeParams(scope),
      );
      return rows.map(mapKnowledgeMemory);
    },

    async getActiveKnowledgeMemoryPaginated(
      scope,
      options,
    ): Promise<PaginatedResult<KnowledgeMemory>> {
      const resolved = resolvePaginationOptions(options);
      const params = [...scopeParams(scope)];
      let query =
        `SELECT * FROM knowledge_memory WHERE ${scopeWhere()} AND superseded_by_id IS NULL AND retired_at IS NULL`;
      if (resolved.cursor > 0) {
        params.push(resolved.cursor);
        query += ` AND id > $${params.length}`;
      }
      query += ' ORDER BY id ASC';
      params.push(resolved.limit + 1);
      query += ` LIMIT $${params.length}`;
      if (resolved.cursor === 0) {
        params.push(resolved.offset);
        query += ` OFFSET $${params.length}`;
      }
      const { rows } = await pool.query(query, params);
      const items = rows.slice(0, resolved.limit).map(mapKnowledgeMemory);
      return {
        items,
        hasMore: rows.length > resolved.limit,
        nextCursor: rows.length > resolved.limit ? items[items.length - 1]?.id ?? null : null,
      };
    },

    async getActiveKnowledgeCrossScope(scope, level) {
      const params = wideScopeParams(scope, level);
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory WHERE ${wideScopeWhere(scope, level)} AND superseded_by_id IS NULL AND retired_at IS NULL ORDER BY last_accessed_at DESC`,
        params,
      );
      return rows.map(mapKnowledgeMemory);
    },

    async getKnowledgeSince(scope, level, since) {
      const params = [...wideScopeParams(scope, level), since];
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory
         WHERE ${wideScopeWhere(scope, level)}
           AND created_at >= $${params.length}
           AND superseded_by_id IS NULL
           AND retired_at IS NULL
         ORDER BY created_at ASC, id ASC`,
        params,
      );
      return rows.map(mapKnowledgeMemory);
    },

    async getKnowledgeByTimeRange(scope, range) {
      const params = scopeParams(scope);
      let query = `SELECT * FROM knowledge_memory WHERE ${scopeWhere()}`;
      if (range.start_at != null) {
        params.push(range.start_at);
        query += ` AND created_at >= $${params.length}`;
      }
      if (range.end_at != null) {
        params.push(range.end_at);
        query += ` AND created_at <= $${params.length}`;
      }
      query += ' ORDER BY id DESC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapKnowledgeMemory);
    },

    async searchKnowledge(scope, queryText, searchOptions) {
      // scopeParams occupies $1..$5. queryText binds at $6 and limit at $7.
      const resolved = resolveSearchOptions(searchOptions);
      const params = scopeParams(scope);
      const limit = resolved.limit;
      const activeClause = resolved.activeOnly ? ' AND superseded_by_id IS NULL AND retired_at IS NULL' : '';
      params.push(queryText, limit);
      const { rows } = await pool.query(
        `SELECT *, ts_rank(search_vector, plainto_tsquery('english', $6)) AS rank
         FROM knowledge_memory
         WHERE ${scopeWhere()} ${activeClause}
           AND search_vector @@ plainto_tsquery('english', $6)
         ORDER BY rank DESC
         LIMIT $7`,
        params,
      );
      return rows
        .map((row) => ({
          item: mapKnowledgeMemory(row),
          rank: Number(row.rank),
        }))
        .filter((result) => matchesKnowledgeSearchOptions(result.item, resolved))
        .slice(0, limit);
    },

    async searchKnowledgeCrossScope(scope, level, queryText, searchOptions) {
      const resolved = resolveSearchOptions(searchOptions);
      const params = wideScopeParams(scope, level);
      const limit = resolved.limit;
      const activeClause = resolved.activeOnly ? ' AND superseded_by_id IS NULL AND retired_at IS NULL' : '';
      const paramOffset = params.length;
      params.push(queryText, limit);
      const { rows } = await pool.query(
        `SELECT *, ts_rank(search_vector, plainto_tsquery('english', $${paramOffset + 1})) AS rank
         FROM knowledge_memory
         WHERE ${wideScopeWhere(scope, level)} ${activeClause}
           AND search_vector @@ plainto_tsquery('english', $${paramOffset + 1})
         ORDER BY rank DESC
         LIMIT $${paramOffset + 2}`,
        params,
      );
      return rows
        .map((row) => ({
          item: mapKnowledgeMemory(row),
          rank: Number(row.rank),
        }))
        .filter((result) => matchesKnowledgeSearchOptions(result.item, resolved))
        .slice(0, limit);
    },

    async insertKnowledgeMemoryAudit(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO knowledge_memory_audit (tenant_id, system_id, workspace_id, collaboration_id, scope_id, working_memory_id, fact, fact_type, fact_subject, fact_attribute, fact_value, normalized_fact, slot_key, is_negated, confidence, confidence_score, verification_status, source_text, decision, detail, related_knowledge_id, created_knowledge_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id, input.working_memory_id,
         input.fact, input.fact_type, input.fact_subject ?? null, input.fact_attribute ?? null,
         input.fact_value ?? null, input.normalized_fact ?? null, input.slot_key ?? null,
         input.is_negated ?? false, input.confidence, input.confidence_score ?? 0.5,
         input.verification_status ?? 'unverified', input.source_text, input.decision,
         input.detail ?? null, input.related_knowledge_id ?? null, input.created_knowledge_id ?? null, now()],
      );
      return mapKnowledgeMemoryAudit(rows[0]);
    },

    async getRecentKnowledgeMemoryAudits(scope, limit = 20) {
      const params = [...scopeParams(scope), limit];
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory_audit WHERE ${scopeWhere()} ORDER BY id DESC LIMIT $6`,
        params,
      );
      return rows.map(mapKnowledgeMemoryAudit);
    },

    async getKnowledgeMemoryAuditsForKnowledge(scope, knowledgeId, limit = 20) {
      const params = [...scopeParams(scope), knowledgeId, knowledgeId, limit];
      const { rows } = await pool.query(
        `SELECT * FROM knowledge_memory_audit
         WHERE ${scopeWhere()}
           AND (created_knowledge_id = $6 OR related_knowledge_id = $7)
         ORDER BY id DESC
         LIMIT $8`,
        params,
      );
      return rows.map(mapKnowledgeMemoryAudit);
    },

    async updateKnowledgeMemory(id, patch) {
      // Phase 2.1: atomic row-update + event.
      return this.transaction(async () => {
      const before = await this.getKnowledgeMemoryById(id);
      const assignments: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown) => {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      };
      if (patch.knowledge_state !== undefined) push('knowledge_state', patch.knowledge_state);
      if (patch.knowledge_class !== undefined) push('knowledge_class', patch.knowledge_class);
      if (patch.trust_score !== undefined) push('trust_score', patch.trust_score);
      if (patch.verification_status !== undefined) push('verification_status', patch.verification_status);
      if (patch.verification_notes !== undefined) push('verification_notes', patch.verification_notes);
      if (patch.last_verified_at !== undefined) push('last_verified_at', patch.last_verified_at);
      if (patch.next_reverification_at !== undefined) {
        push('next_reverification_at', patch.next_reverification_at);
      }
      if (patch.last_confirmed_at !== undefined) push('last_confirmed_at', patch.last_confirmed_at);
      if (patch.confirmation_count !== undefined) push('confirmation_count', patch.confirmation_count);
      if (patch.disputed_at !== undefined) push('disputed_at', patch.disputed_at);
      if (patch.dispute_reason !== undefined) push('dispute_reason', patch.dispute_reason);
      if (patch.contradiction_score !== undefined) push('contradiction_score', patch.contradiction_score);
      if (patch.superseded_at !== undefined) push('superseded_at', patch.superseded_at);
      if (patch.successful_use_count !== undefined) push('successful_use_count', patch.successful_use_count);
      if (patch.failed_use_count !== undefined) push('failed_use_count', patch.failed_use_count);
      if (assignments.length === 0) {
        return this.getKnowledgeMemoryById(id);
      }
      values.push(id);
      const { rows } = await pool.query(
        `UPDATE knowledge_memory SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values,
      );
      const after = rows[0] ? mapKnowledgeMemory(rows[0]) : null;
      if (before && after) {
        await insertMemoryEventInternal({
          ...normalizeScope(after),
          entity_kind: 'knowledge_memory',
          entity_id: String(after.id),
          event_type: 'knowledge.updated',
          payload: {
            before,
            after,
            patch,
          },
          created_at: now(),
        });
      }
      return after;
      });
    },

    async touchKnowledgeMemory(id) {
      // Phase 2.1: atomic row-update + event.
      await this.transaction(async () => {
        const before = await this.getKnowledgeMemoryById(id);
        const touchedAt = now();
        await pool.query(
          `UPDATE knowledge_memory SET access_count = access_count + 1, last_accessed_at = $2 WHERE id = $1`,
          [id, touchedAt],
        );
        const after = await this.getKnowledgeMemoryById(id);
        if (before && after) {
          await insertMemoryEventInternal({
            ...normalizeScope(after),
            entity_kind: 'knowledge_memory',
            entity_id: String(after.id),
            event_type: 'knowledge.touched',
            payload: {
              before,
              after,
              patch: {
                last_accessed_at: touchedAt,
                access_count: after.access_count,
              },
            },
            created_at: touchedAt,
          });
        }
      });
    },

    async touchKnowledgeMemories(ids: number[]) {
      // Phase 2.1: atomic batch row-update + batch events.
      await this.transaction(async () => {
      const uniqueIds = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
      if (uniqueIds.length === 0) return;
      const { rows: beforeRows } = await pool.query(
        'SELECT * FROM knowledge_memory WHERE id = ANY($1::int[])',
        [uniqueIds],
      );
      if (beforeRows.length === 0) return;
      const touchedAt = now();
      const before = beforeRows.map(mapKnowledgeMemory);
      const { rows: afterRows } = await pool.query(
        `UPDATE knowledge_memory
         SET access_count = access_count + 1, last_accessed_at = $2
         WHERE id = ANY($1::int[])
         RETURNING *`,
        [uniqueIds, touchedAt],
      );
      const afterById = new Map(
        afterRows.map((row) => {
          const mapped = mapKnowledgeMemory(row);
          return [mapped.id, mapped] as const;
        }),
      );
      await insertMemoryEventsBatchInternal(
        before.flatMap((item) => {
          const after = afterById.get(item.id);
          if (!after) return [];
          return [{
            ...normalizeScope(after),
            entity_kind: 'knowledge_memory' as const,
            entity_id: String(after.id),
            event_type: 'knowledge.touched' as const,
            payload: {
              before: item,
              after,
              patch: {
                last_accessed_at: touchedAt,
                access_count: after.access_count,
              },
            },
            created_at: touchedAt,
          }];
        }),
      );
      });
    },

    async retireKnowledgeMemory(id, retiredAt) {
      // Phase 2.1: atomic row-update + event.
      await this.transaction(async () => {
        const before = await this.getKnowledgeMemoryById(id);
        const effectiveRetiredAt = retiredAt ?? now();
        await pool.query(
          `UPDATE knowledge_memory SET retired_at = $2 WHERE id = $1`,
          [id, effectiveRetiredAt],
        );
        const after = await this.getKnowledgeMemoryById(id);
        if (before && after) {
          await insertMemoryEventInternal({
            ...normalizeScope(after),
            entity_kind: 'knowledge_memory',
            entity_id: String(after.id),
            event_type: 'knowledge.retired',
            payload: {
              before,
              after,
              patch: {
                retired_at: effectiveRetiredAt,
              },
            },
            created_at: effectiveRetiredAt,
          });
        }
      });
    },

    async supersedeKnowledgeMemory(oldId, newId) {
      // Phase 2.1: atomic row-update + event.
      await this.transaction(async () => {
        const before = await this.getKnowledgeMemoryById(oldId);
        const supersededAt = now();
        await pool.query(
          `UPDATE knowledge_memory
           SET superseded_by_id = $2, superseded_at = $3, knowledge_state = 'superseded', retired_at = $3
           WHERE id = $1`,
          [oldId, newId, supersededAt],
        );
        const after = await this.getKnowledgeMemoryById(oldId);
        if (before && after) {
          await insertMemoryEventInternal({
            ...normalizeScope(after),
            entity_kind: 'knowledge_memory',
            entity_id: String(after.id),
            event_type: 'knowledge.superseded',
            payload: {
              before,
              after,
              refs: {
                new_id: newId,
              },
            },
            created_at: supersededAt,
          });
        }
      });
    },

    async insertWorkItem(input) {
      // Phase 2.1: atomic row + event.
      return this.transaction(async () => {
        const n = normalizeScope(input);
        const createdAt = now();
        const { rows } = await pool.query(
          `INSERT INTO work_items (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id, title, kind, status, detail, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           RETURNING *`,
          [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id, input.session_id,
           input.title, input.kind ?? 'objective', input.status ?? 'open', input.detail ?? null, createdAt],
        );
        const workItem = mapWorkItem(rows[0]);
        await insertMemoryEventInternal({
          ...n,
          session_id: workItem.session_id,
          entity_kind: 'work_item',
          entity_id: String(workItem.id),
          event_type: 'work_item.created',
          payload: {
            after: workItem,
          },
          created_at: createdAt,
        });
        return workItem;
      });
    },

    async getActiveWorkItems(scope) {
      const { rows } = await pool.query(
        `SELECT * FROM work_items WHERE ${scopeWhere()} AND status != 'done' ORDER BY id DESC`,
        scopeParams(scope),
      );
      return rows.map(mapWorkItem);
    },

    async getWorkItemById(id) {
      const { rows } = await pool.query('SELECT * FROM work_items WHERE id = $1', [id]);
      return rows[0] ? mapWorkItem(rows[0]) : null;
    },

    async getExistingWorkItemIds(ids) {
      return getExistingIds('work_items', ids);
    },

    async getActiveWorkItemsCrossScope(scope, level) {
      const { rows } = await pool.query(
        `SELECT * FROM work_items WHERE ${wideScopeWhere(scope, level)} AND status != 'done' ORDER BY id DESC`,
        wideScopeParams(scope, level),
      );
      return rows.map(mapWorkItem);
    },

    async getWorkItemsByTimeRange(scope, range) {
      const params = scopeParams(scope);
      let query = `SELECT * FROM work_items WHERE ${scopeWhere()}`;
      if (range.start_at != null) {
        params.push(range.start_at);
        query += ` AND created_at >= $${params.length}`;
      }
      if (range.end_at != null) {
        params.push(range.end_at);
        query += ` AND created_at <= $${params.length}`;
      }
      query += ' ORDER BY id DESC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapWorkItem);
    },

    async getWorkItemsByTimeRangeCrossScope(scope, level, range) {
      const params = wideScopeParams(scope, level);
      let query = `SELECT * FROM work_items WHERE ${wideScopeWhere(scope, level)}`;
      if (range.start_at != null) {
        params.push(range.start_at);
        query += ` AND created_at >= $${params.length}`;
      }
      if (range.end_at != null) {
        params.push(range.end_at);
        query += ` AND created_at <= $${params.length}`;
      }
      query += ' ORDER BY id DESC';
      const { rows } = await pool.query(query, params);
      return rows.map(mapWorkItem);
    },

    async updateWorkItemStatus(id, status) {
      // Phase 2.1: atomic row-update + event.
      await this.transaction(async () => {
        const { rows: beforeRows } = await pool.query('SELECT * FROM work_items WHERE id = $1', [id]);
        const updatedAt = now();
        await pool.query(
          `UPDATE work_items SET status = $2, version = COALESCE(version, 1) + 1, updated_at = $3 WHERE id = $1`,
          [id, status, updatedAt],
        );
        const { rows: afterRows } = await pool.query('SELECT * FROM work_items WHERE id = $1', [id]);
        if (beforeRows[0] && afterRows[0]) {
          const before = mapWorkItem(beforeRows[0]);
          const after = mapWorkItem(afterRows[0]);
          await insertMemoryEventInternal({
            ...normalizeScope(after),
            session_id: after.session_id,
            entity_kind: 'work_item',
            entity_id: String(after.id),
            event_type: 'work_item.status_changed',
            payload: {
              before,
              after,
              patch: {
                status,
                updated_at: updatedAt,
              },
            },
            created_at: updatedAt,
          });
        }
      });
    },

    async updateWorkItem(id, patch: WorkItemPatch, options?: { expectedVersion?: number }) {
      // Phase 2.1: atomic row-update + event. The optimistic-lock guard lives in
      // the UPDATE's WHERE (Phase 0.7); wrapping in a transaction makes the
      // conditional row-update and its event commit together, and a ConflictError
      // throw rolls back cleanly.
      return this.transaction(async () => {
      const { rows: beforeRows } = await pool.query('SELECT * FROM work_items WHERE id = $1', [id]);
      if (!beforeRows[0]) return null;
      const before = mapWorkItem(beforeRows[0]);
      const updatedAt = now();
      const nextTitle = patch.title ?? before.title;
      const nextDetail = patch.detail !== undefined ? patch.detail : before.detail;
      const nextStatus = patch.status ?? before.status;
      const nextVisibility = patch.visibility_class ?? before.visibility_class;
      // Phase 0.7: the version guard lives in the UPDATE's WHERE clause so
      // concurrent updaters race atomically; rowCount is the authority.
      // The pre-SELECT is retained only to compute patch fields and enrich the
      // error message — it is not the concurrency guard.
      const expectedVersion = options?.expectedVersion;
      const { rows: afterRows, rowCount } = await pool.query(
        `UPDATE work_items
         SET title = $2, detail = $3, status = $4, visibility_class = $5, version = COALESCE(version, 1) + 1, updated_at = $6
         WHERE id = $1${expectedVersion != null ? ' AND COALESCE(version, 1) = $7' : ''}
         RETURNING *`,
        expectedVersion != null
          ? [id, nextTitle, nextDetail, nextStatus, nextVisibility, updatedAt, expectedVersion]
          : [id, nextTitle, nextDetail, nextStatus, nextVisibility, updatedAt],
      );
      if (rowCount === 0 || !afterRows[0]) {
        // No row was updated. If the caller supplied expectedVersion this is a
        // genuine optimistic-lock conflict; otherwise the row was deleted
        // concurrently after the pre-SELECT and the contract expects null.
        if (expectedVersion != null) {
          // Don't report the stale pre-SELECT version as authoritative: the row
          // may have been re-versioned or deleted concurrently. Word the
          // message so it does not claim a specific current version.
          throw new ConflictError(
            `Work item ${id} version mismatch (expected version ${expectedVersion}; the item was modified concurrently)`,
          );
        }
        return null;
      }
      const after = mapWorkItem(afterRows[0]);
      await insertMemoryEventInternal({
        ...normalizeScope(after),
        session_id: after.session_id,
        entity_kind: 'work_item',
        entity_id: String(after.id),
        event_type:
          patch.visibility_class !== undefined &&
          patch.title === undefined &&
          patch.detail === undefined &&
          patch.status === undefined
            ? 'work_item.visibility_changed'
            : 'work_item.updated',
        payload: { before, after, patch },
        created_at: updatedAt,
      });
      return after;
      });
    },

    async deleteWorkItem(id) {
      // Phase 2.1: atomic row-delete + event.
      await this.transaction(async () => {
        const { rows } = await pool.query('SELECT * FROM work_items WHERE id = $1', [id]);
        await pool.query('DELETE FROM work_items WHERE id = $1', [id]);
        if (rows[0]) {
          const workItem = mapWorkItem(rows[0]);
          await insertMemoryEventInternal({
            ...normalizeScope(workItem),
            session_id: workItem.session_id,
            entity_kind: 'work_item',
            entity_id: String(workItem.id),
            event_type: 'work_item.deleted',
            payload: {
              before: workItem,
            },
            created_at: now(),
          });
        }
      });
    },

    async claimWorkItem(input: NewWorkClaimInput): Promise<WorkClaim> {
      return this.transaction(async () => {
        const { rows: workItemRows } = await pool.query('SELECT * FROM work_items WHERE id = $1', [
          input.work_item_id,
        ]);
        if (!workItemRows[0]) {
          throw new ConflictError(`Work item ${input.work_item_id} does not exist`);
        }
        const workItem = mapWorkItem(workItemRows[0]);
        if (workItem.status === 'done') {
          throw new ConflictError(`Work item ${input.work_item_id} is done`);
        }

        const claimedAt = input.claimed_at ?? now();
        const existingRow = await getAnyClaimRowByWorkItem(input.work_item_id);
        if (existingRow) {
          const existing = mapWorkClaim(existingRow);
          if (existing.status === 'active' && existing.expires_at <= claimedAt) {
            await expireClaimRecord(existingRow, claimedAt);
          } else if (existing.status === 'active') {
            if (!sameActor(existing.actor, input.actor)) {
              throw new ConflictError(`Work item ${input.work_item_id} is already claimed`);
            }
            return (await this.renewWorkClaim(existing.id, input.actor, input.lease_seconds ?? 300))!;
          }
        }

        const normalized = normalizeScope(input);
        const actorParts = serializeActorMetadata(input.actor);
        const claimToken = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const expiresAt = claimedAt + (input.lease_seconds ?? 300);
        // Phase 0.2: the upsert is self-guarding. Under READ COMMITTED the
        // ON CONFLICT DO UPDATE re-reads the latest committed row under a row
        // lock, so only a claim whose current row is non-active OR already
        // expired can be overwritten. rowCount is the authority: 0 affected
        // rows means a live foreign claim won the race → ConflictError. The
        // pre-SELECT above is used only to enrich the error message.
        const { rows, rowCount } = await pool.query(
          `INSERT INTO work_claims_current
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, work_item_id, session_id,
             actor_kind, actor_id, actor_system_id, actor_display_name, actor_metadata,
             claim_token, status, claimed_at, expires_at, released_at, release_reason, source_event_id, visibility_class, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, 'active', $14, $15, NULL, NULL, NULL, $16, 1)
           ON CONFLICT (work_item_id) DO UPDATE SET
             tenant_id = EXCLUDED.tenant_id,
             system_id = EXCLUDED.system_id,
             workspace_id = EXCLUDED.workspace_id,
             collaboration_id = EXCLUDED.collaboration_id,
             scope_id = EXCLUDED.scope_id,
             session_id = EXCLUDED.session_id,
             actor_kind = EXCLUDED.actor_kind,
             actor_id = EXCLUDED.actor_id,
             actor_system_id = EXCLUDED.actor_system_id,
             actor_display_name = EXCLUDED.actor_display_name,
             actor_metadata = EXCLUDED.actor_metadata,
             claim_token = EXCLUDED.claim_token,
             status = 'active',
             claimed_at = EXCLUDED.claimed_at,
             expires_at = EXCLUDED.expires_at,
             released_at = NULL,
             release_reason = NULL,
             source_event_id = NULL,
             visibility_class = EXCLUDED.visibility_class,
             version = COALESCE(work_claims_current.version, 1) + 1
           WHERE work_claims_current.status <> 'active'
              OR work_claims_current.expires_at <= EXCLUDED.claimed_at
           RETURNING *`,
          [
            normalized.tenant_id,
            normalized.system_id,
            normalized.workspace_id,
            normalized.collaboration_id,
            normalized.scope_id,
            input.work_item_id,
            input.session_id ?? null,
            actorParts[0],
            actorParts[1],
            actorParts[2],
            actorParts[3],
            actorParts[4],
            claimToken,
            claimedAt,
            expiresAt,
            input.visibility_class,
          ],
        );
        if (rowCount === 0 || !rows[0]) {
          throw new ConflictError(`Work item ${input.work_item_id} is already claimed`);
        }
        const claim = mapWorkClaim(rows[0]);
        const event = await insertMemoryEventInternal({
          ...normalizeScope(claim),
          session_id: claim.session_id,
          actor_id: claim.actor.actor_id,
          actor_kind: claim.actor.actor_kind,
          actor_system_id: claim.actor.system_id,
          actor_display_name: claim.actor.display_name,
          actor_metadata: claim.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(claim.id),
          event_type: 'work_claim.claimed',
          payload: { after: claim },
          created_at: claimedAt,
        });
        await pool.query('UPDATE work_claims_current SET source_event_id = $2 WHERE id = $1', [
          claim.id,
          event.event_id,
        ]);
        return { ...claim, source_event_id: event.event_id };
      });
    },

    async renewWorkClaim(claimId: number, actor: ActorRef, leaseSeconds = 300): Promise<WorkClaim | null> {
      return this.transaction(async () => {
        const { rows: beforeRows } = await pool.query('SELECT * FROM work_claims_current WHERE id = $1', [claimId]);
        if (!beforeRows[0]) return null;
        const claim = mapWorkClaim(beforeRows[0]);
        if (!sameActor(claim.actor, actor)) {
          throw new ConflictError(`Claim ${claimId} is owned by another actor`);
        }
        const currentNow = now();
        if (claim.status !== 'active') {
          throw new ConflictError(`Claim ${claimId} is no longer active`);
        }
        if (claim.expires_at <= currentNow) {
          await expireClaimRecord(beforeRows[0], currentNow);
          return null;
        }
        const { rows } = await pool.query(
          `UPDATE work_claims_current
           SET expires_at = $2, version = COALESCE(version, 1) + 1
           WHERE id = $1
           RETURNING *`,
          [claimId, Math.max(claim.expires_at, currentNow) + leaseSeconds],
        );
        const after = mapWorkClaim(rows[0]);
        const event = await insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: after.actor.actor_id,
          actor_kind: after.actor.actor_kind,
          actor_system_id: after.actor.system_id,
          actor_display_name: after.actor.display_name,
          actor_metadata: after.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(after.id),
          event_type: 'work_claim.renewed',
          payload: { before: claim, after },
          created_at: currentNow,
        });
        await pool.query('UPDATE work_claims_current SET source_event_id = $2 WHERE id = $1', [
          after.id,
          event.event_id,
        ]);
        return { ...after, source_event_id: event.event_id };
      });
    },

    async releaseWorkClaim(claimId: number, actor: ActorRef, reason?: string): Promise<WorkClaim | null> {
      return this.transaction(async () => {
        const { rows: beforeRows } = await pool.query('SELECT * FROM work_claims_current WHERE id = $1', [claimId]);
        if (!beforeRows[0]) return null;
        const claim = mapWorkClaim(beforeRows[0]);
        if (!sameActor(claim.actor, actor)) {
          throw new ConflictError(`Claim ${claimId} is owned by another actor`);
        }
        if (claim.status !== 'active') {
          throw new ConflictError(`Claim ${claimId} is no longer active`);
        }
        const releasedAt = now();
        const { rows } = await pool.query(
          `UPDATE work_claims_current
           SET status = 'released', released_at = $2, release_reason = $3, version = COALESCE(version, 1) + 1
           WHERE id = $1
           RETURNING *`,
          [claimId, releasedAt, reason ?? null],
        );
        const after = mapWorkClaim(rows[0]);
        const event = await insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: after.actor.actor_id,
          actor_kind: after.actor.actor_kind,
          actor_system_id: after.actor.system_id,
          actor_display_name: after.actor.display_name,
          actor_metadata: after.actor.metadata,
          entity_kind: 'work_claim',
          entity_id: String(after.id),
          event_type: 'work_claim.released',
          payload: { before: claim, after },
          created_at: releasedAt,
        });
        await pool.query('UPDATE work_claims_current SET source_event_id = $2 WHERE id = $1', [
          after.id,
          event.event_id,
        ]);
        return { ...after, source_event_id: event.event_id };
      });
    },

    async getWorkClaimById(claimId: number): Promise<WorkClaim | null> {
      // Phase 2.5 (D6): by-id reads apply the same effective-status computation
      // as the list paths, so an active-but-expired claim reads as `expired`
      // consistently across read paths (without writing).
      const { rows } = await pool.query('SELECT * FROM work_claims_current WHERE id = $1', [claimId]);
      if (!rows[0]) return null;
      return effectiveClaim(mapWorkClaim(rows[0]), now());
    },

    async getActiveWorkClaim(workItemId: number): Promise<WorkClaim | null> {
      // Phase 2.5: read path computes effective status without writing. An
      // active-but-expired claim reads as no active claim; the row is expired
      // durably only by claim/renew/release or the expireStaleClaims reaper.
      const existingRow = await getAnyClaimRowByWorkItem(workItemId);
      if (!existingRow) return null;
      const claim = effectiveClaim(mapWorkClaim(existingRow), now());
      return claim.status === 'active' ? claim : null;
    },

    async listWorkClaims(scope: MemoryScope, options?: WorkClaimQuery): Promise<WorkClaim[]> {
      // Phase 2.5: reads never write. Effective status is computed against `now`;
      // durable expiry is the reaper's (expireStaleClaims) job.
      const currentNow = now();
      const { rows } = await pool.query(
        `SELECT * FROM work_claims_current WHERE ${scopeWhere()} ORDER BY claimed_at DESC`,
        scopeParams(scope),
      );
      const claims = rows.map((row) => effectiveClaim(mapWorkClaim(row), currentNow));
      return claims.filter((claim) => {
        if (!options?.includeExpired && claim.status === 'expired') return false;
        if (!options?.includeReleased && claim.status === 'released') return false;
        if (options?.sessionId && claim.session_id !== options.sessionId) return false;
        if (options?.visibilityClass && claim.visibility_class !== options.visibilityClass) return false;
        if (options?.actor && !sameActor(claim.actor, options.actor)) return false;
        return true;
      });
    },

    async listWorkClaimsCrossScope(
      scope: MemoryScope,
      level: ScopeLevel,
      options?: WorkClaimQuery,
    ): Promise<WorkClaim[]> {
      // Phase 2.5: reads never write (see listWorkClaims).
      const currentNow = now();
      const levelParams = wideScopeParams(scope, level);
      const { rows } = await pool.query(
        `SELECT * FROM work_claims_current WHERE ${wideScopeWhere(scope, level)} ORDER BY claimed_at DESC`,
        levelParams,
      );
      const claims = rows.map((row) => effectiveClaim(mapWorkClaim(row), currentNow));
      return claims.filter((claim) => {
        if (!options?.includeExpired && claim.status === 'expired') return false;
        if (!options?.includeReleased && claim.status === 'released') return false;
        if (options?.sessionId && claim.session_id !== options.sessionId) return false;
        if (options?.visibilityClass && claim.visibility_class !== options.visibilityClass) return false;
        if (options?.actor && !sameActor(claim.actor, options.actor)) return false;
        return true;
      });
    },

    async expireStaleClaims(scope: MemoryScope, currentNow: number): Promise<number[]> {
      // Phase 2.5 reaper. Race-safe on two axes:
      //  1. The candidate SELECT runs INSIDE the transaction with FOR UPDATE
      //     SKIP LOCKED, so two concurrent reapers partition the stale rows
      //     rather than both grabbing the same ones.
      //  2. expireClaimRecord's UPDATE is self-guarding
      //     (WHERE status='active' AND expires_at<=now, rowCount authority): if a
      //     racing claimWorkItem re-activated a row between SELECT and UPDATE it
      //     affects 0 rows and emits NO event.
      // Together these guarantee exactly one work_claim.expired per genuine
      // expiry and exactly one winner against a concurrent reclaim.
      return this.transaction(async () => {
        const { rows: expiredRows } = await pool.query(
          `SELECT * FROM work_claims_current
           WHERE ${scopeWhere()} AND status = 'active' AND expires_at <= $6
           FOR UPDATE SKIP LOCKED`,
          [...scopeParams(scope), currentNow],
        );
        const expiredIds: number[] = [];
        for (const row of expiredRows) {
          const expired = await expireClaimRecord(row, currentNow);
          if (expired) expiredIds.push(expired.id);
        }
        return expiredIds;
      });
    },

    async expireStaleHandoffs(scope: MemoryScope, currentNow: number): Promise<number[]> {
      // Phase 2.5 reaper (D5), handoff analogue of expireStaleClaims. Race-safe
      // on the same two axes:
      //  1. The candidate SELECT runs INSIDE the transaction with FOR UPDATE
      //     SKIP LOCKED, so two concurrent reapers partition the stale rows.
      //  2. expireHandoffRecord's UPDATE is self-guarding
      //     (WHERE status='pending' AND expires_at<=now, rowCount authority): if
      //     a racing accept/reject/cancel changed the row between SELECT and
      //     UPDATE it affects 0 rows and emits NO event.
      // Together these guarantee exactly one handoff.expired per genuine expiry.
      return this.transaction(async () => {
        const { rows: expiredRows } = await pool.query(
          `SELECT * FROM handoff_records
           WHERE ${scopeWhere()} AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $6
           FOR UPDATE SKIP LOCKED`,
          [...scopeParams(scope), currentNow],
        );
        const expiredIds: number[] = [];
        for (const row of expiredRows) {
          const expired = await expireHandoffRecord(row, currentNow);
          if (expired) expiredIds.push(expired.id);
        }
        return expiredIds;
      });
    },

    async createHandoff(input: NewHandoffInput): Promise<HandoffRecord> {
      return this.transaction(async () => {
        const normalized = normalizeScope(input);
        const createdAt = input.created_at ?? now();
        const fromParts = serializeActorMetadata(input.from_actor);
        const toParts = serializeActorMetadata(input.to_actor);
        const { rows } = await pool.query(
          `INSERT INTO handoff_records
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, work_item_id, session_id,
             from_actor_kind, from_actor_id, from_actor_system_id, from_actor_display_name, from_actor_metadata,
             to_actor_kind, to_actor_id, to_actor_system_id, to_actor_display_name, to_actor_metadata,
             summary, context_bundle_ref, status, created_at, expires_at, visibility_class, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   $8, $9, $10, $11, $12::jsonb,
                   $13, $14, $15, $16, $17::jsonb,
                   $18, $19, 'pending', $20, $21, $22, 1)
           RETURNING *`,
          [
            normalized.tenant_id,
            normalized.system_id,
            normalized.workspace_id,
            normalized.collaboration_id,
            normalized.scope_id,
            input.work_item_id,
            input.session_id ?? null,
            fromParts[0],
            fromParts[1],
            fromParts[2],
            fromParts[3],
            fromParts[4],
            toParts[0],
            toParts[1],
            toParts[2],
            toParts[3],
            toParts[4],
            input.summary,
            input.context_bundle_ref ?? null,
            createdAt,
            input.expires_at ?? null,
            input.visibility_class,
          ],
        );
        const handoff = mapHandoff(rows[0]);
        const event = await insertMemoryEventInternal({
          ...normalizeScope(handoff),
          session_id: handoff.session_id,
          actor_id: handoff.from_actor.actor_id,
          actor_kind: handoff.from_actor.actor_kind,
          actor_system_id: handoff.from_actor.system_id,
          actor_display_name: handoff.from_actor.display_name,
          actor_metadata: handoff.from_actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(handoff.id),
          event_type: 'handoff.created',
          payload: { after: handoff },
          created_at: createdAt,
        });
        await pool.query('UPDATE handoff_records SET source_event_id = $2 WHERE id = $1', [
          handoff.id,
          event.event_id,
        ]);
        return { ...handoff, source_event_id: event.event_id };
      });
    },

    async getHandoffById(handoffId: number): Promise<HandoffRecord | null> {
      // Phase 2.5 (D6): by-id reads apply the same effective-status computation
      // as listHandoffs, so a pending-but-expired handoff reads as `expired`
      // consistently across read paths (without writing).
      const { rows } = await pool.query('SELECT * FROM handoff_records WHERE id = $1', [handoffId]);
      if (!rows[0]) return null;
      return effectiveHandoff(mapHandoff(rows[0]), now());
    },

    async acceptHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null> {
      return this.transaction(async () => {
        const { rows: handoffRows } = await pool.query('SELECT * FROM handoff_records WHERE id = $1', [handoffId]);
        if (!handoffRows[0]) return null;
        const handoff = mapHandoff(handoffRows[0]);
        if (!sameActor(handoff.to_actor, actor)) {
          throw new ConflictError(`Handoff ${handoffId} is assigned to another actor`);
        }
        const acceptedAt = now();
        if (handoff.status !== 'pending') {
          throw new ConflictError(`Handoff ${handoffId} is no longer pending`);
        }
        if (handoff.expires_at != null && handoff.expires_at <= acceptedAt) {
          await expireHandoffRecord(handoffRows[0], acceptedAt);
          return null;
        }
        const activeClaim = await this.getActiveWorkClaim(handoff.work_item_id);
        if (activeClaim && !sameActor(activeClaim.actor, handoff.from_actor)) {
          throw new ConflictError(`Work item ${handoff.work_item_id} has another active owner`);
        }
        if (activeClaim) {
          await this.releaseWorkClaim(activeClaim.id, handoff.from_actor, 'handoff_accepted');
        }
        await this.claimWorkItem({
          ...normalizeScope(handoff),
          work_item_id: handoff.work_item_id,
          actor,
          session_id: handoff.session_id,
          visibility_class: handoff.visibility_class,
        });
        const { rows } = await pool.query(
          `UPDATE handoff_records
           SET status = 'accepted', accepted_at = $2, decision_reason = $3, version = COALESCE(version, 1) + 1
           WHERE id = $1
           RETURNING *`,
          [handoffId, acceptedAt, reason ?? null],
        );
        const after = mapHandoff(rows[0]);
        const event = await insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: actor.actor_id,
          actor_kind: actor.actor_kind,
          actor_system_id: actor.system_id,
          actor_display_name: actor.display_name,
          actor_metadata: actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(after.id),
          event_type: 'handoff.accepted',
          payload: { before: handoff, after },
          created_at: acceptedAt,
        });
        await pool.query('UPDATE handoff_records SET source_event_id = $2 WHERE id = $1', [
          after.id,
          event.event_id,
        ]);
        return { ...after, source_event_id: event.event_id };
      });
    },

    async rejectHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null> {
      return this.transaction(async () => {
        const { rows: handoffRows } = await pool.query('SELECT * FROM handoff_records WHERE id = $1', [handoffId]);
        if (!handoffRows[0]) return null;
        const handoff = mapHandoff(handoffRows[0]);
        if (!sameActor(handoff.to_actor, actor)) {
          throw new ConflictError(`Handoff ${handoffId} is assigned to another actor`);
        }
        const rejectedAt = now();
        if (handoff.status !== 'pending') {
          throw new ConflictError(`Handoff ${handoffId} is no longer pending`);
        }
        if (handoff.expires_at != null && handoff.expires_at <= rejectedAt) {
          await expireHandoffRecord(handoffRows[0], rejectedAt);
          return null;
        }
        const { rows } = await pool.query(
          `UPDATE handoff_records
           SET status = 'rejected', rejected_at = $2, decision_reason = $3, version = COALESCE(version, 1) + 1
           WHERE id = $1
           RETURNING *`,
          [handoffId, rejectedAt, reason ?? null],
        );
        const after = mapHandoff(rows[0]);
        const event = await insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: actor.actor_id,
          actor_kind: actor.actor_kind,
          actor_system_id: actor.system_id,
          actor_display_name: actor.display_name,
          actor_metadata: actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(after.id),
          event_type: 'handoff.rejected',
          payload: { before: handoff, after },
          created_at: rejectedAt,
        });
        await pool.query('UPDATE handoff_records SET source_event_id = $2 WHERE id = $1', [
          after.id,
          event.event_id,
        ]);
        return { ...after, source_event_id: event.event_id };
      });
    },

    async cancelHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null> {
      return this.transaction(async () => {
        const { rows: handoffRows } = await pool.query('SELECT * FROM handoff_records WHERE id = $1', [handoffId]);
        if (!handoffRows[0]) return null;
        const handoff = mapHandoff(handoffRows[0]);
        if (!sameActor(handoff.from_actor, actor)) {
          throw new ConflictError(`Handoff ${handoffId} was created by another actor`);
        }
        const canceledAt = now();
        if (handoff.status !== 'pending') {
          throw new ConflictError(`Handoff ${handoffId} is no longer pending`);
        }
        if (handoff.expires_at != null && handoff.expires_at <= canceledAt) {
          await expireHandoffRecord(handoffRows[0], canceledAt);
          return null;
        }
        const { rows } = await pool.query(
          `UPDATE handoff_records
           SET status = 'canceled', canceled_at = $2, decision_reason = $3, version = COALESCE(version, 1) + 1
           WHERE id = $1
           RETURNING *`,
          [handoffId, canceledAt, reason ?? null],
        );
        const after = mapHandoff(rows[0]);
        const event = await insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.session_id,
          actor_id: actor.actor_id,
          actor_kind: actor.actor_kind,
          actor_system_id: actor.system_id,
          actor_display_name: actor.display_name,
          actor_metadata: actor.metadata,
          entity_kind: 'handoff',
          entity_id: String(after.id),
          event_type: 'handoff.canceled',
          payload: { before: handoff, after },
          created_at: canceledAt,
        });
        await pool.query('UPDATE handoff_records SET source_event_id = $2 WHERE id = $1', [
          after.id,
          event.event_id,
        ]);
        return { ...after, source_event_id: event.event_id };
      });
    },

    async listHandoffs(scope: MemoryScope, options?: HandoffQuery): Promise<HandoffRecord[]> {
      // D5: reads never write. Effective status is computed against `now`;
      // durable expiry is the reaper's (expireStaleHandoffs) job. Two concurrent
      // list calls on an expired handoff therefore emit ZERO handoff.expired.
      const currentNow = now();
      const { rows } = await pool.query(
        `SELECT * FROM handoff_records WHERE ${scopeWhere()} ORDER BY created_at DESC`,
        scopeParams(scope),
      );
      const handoffs = rows.map((row) => effectiveHandoff(mapHandoff(row), currentNow));
      return handoffs.filter((handoff) => {
        if (options?.sessionId && handoff.session_id !== options.sessionId) return false;
        if (options?.statuses && !options.statuses.includes(handoff.status)) return false;
        if (options?.actor) {
          if (options.direction === 'inbound') return sameActor(handoff.to_actor, options.actor);
          if (options.direction === 'outbound') return sameActor(handoff.from_actor, options.actor);
          return sameActor(handoff.to_actor, options.actor) || sameActor(handoff.from_actor, options.actor);
        }
        return true;
      }).slice(0, options?.limit ?? handoffs.length);
    },

    async listHandoffsCrossScope(
      scope: MemoryScope,
      level: ScopeLevel,
      options?: HandoffQuery,
    ): Promise<HandoffRecord[]> {
      // D5: reads never write (see listHandoffs).
      const currentNow = now();
      const levelParams = wideScopeParams(scope, level);
      const { rows } = await pool.query(
        `SELECT * FROM handoff_records WHERE ${wideScopeWhere(scope, level)} ORDER BY created_at DESC`,
        levelParams,
      );
      const handoffs = rows.map((row) => effectiveHandoff(mapHandoff(row), currentNow));
      return handoffs.filter((handoff) => {
        if (options?.sessionId && handoff.session_id !== options.sessionId) return false;
        if (options?.statuses && !options.statuses.includes(handoff.status)) return false;
        if (options?.actor) {
          if (options.direction === 'inbound') return sameActor(handoff.to_actor, options.actor);
          if (options.direction === 'outbound') return sameActor(handoff.from_actor, options.actor);
          return sameActor(handoff.to_actor, options.actor) || sameActor(handoff.from_actor, options.actor);
        }
        return true;
      }).slice(0, options?.limit ?? handoffs.length);
    },

    async upsertContextMonitor(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO context_monitor (tenant_id, system_id, workspace_id, collaboration_id, scope_id, compaction_state, active_turn_count, active_token_estimate, compaction_score, last_compaction_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, system_id, workspace_id, collaboration_id, scope_id)
         DO UPDATE SET compaction_state = $6, active_turn_count = $7, active_token_estimate = $8, compaction_score = $9, last_compaction_at = COALESCE($10, context_monitor.last_compaction_at), updated_at = $11
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id,
         input.compaction_state, input.active_turn_count, input.active_token_estimate,
         input.compaction_score, input.last_compaction_at ?? null, now()],
      );
      return mapContextMonitor(rows[0]);
    },

    async getContextMonitor(scope) {
      const { rows } = await pool.query(
        `SELECT * FROM context_monitor WHERE ${scopeWhere()}`,
        scopeParams(scope),
      );
      return rows[0] ? mapContextMonitor(rows[0]) : null;
    },

    async insertCompactionLog(input) {
      const n = normalizeScope(input);
      const { rows } = await pool.query(
        `INSERT INTO compaction_log (tenant_id, system_id, workspace_id, collaboration_id, scope_id, session_id, trigger_type, turn_id_start, turn_id_end, turns_compacted, tokens_compacted_estimate, working_memory_id, active_turn_count_before, active_turn_count_after, duration_ms, model_call_made, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id, input.session_id,
         input.trigger_type, input.turn_id_start, input.turn_id_end,
         input.turns_compacted, input.tokens_compacted_estimate, input.working_memory_id,
         input.active_turn_count_before, input.active_turn_count_after,
         input.duration_ms, input.model_call_made, now()],
      );
      return mapCompactionLog(rows[0]);
    },

    async getCompactionLogById(id) {
      const { rows } = await pool.query('SELECT * FROM compaction_log WHERE id = $1', [id]);
      return rows[0] ? mapCompactionLog(rows[0]) : null;
    },

    async getRecentCompactionLogs(scope, limit = 10) {
      const params = [...scopeParams(scope), limit];
      const { rows } = await pool.query(
        `SELECT * FROM compaction_log WHERE ${scopeWhere()} ORDER BY id DESC LIMIT $6`,
        params,
      );
      return rows.map(mapCompactionLog);
    },

    async insertPlaybook(input) {
      // Phase 2.1: atomic row + event.
      return this.transaction(async () => {
        const n = normalizeScope(input);
        const createdAt = input.created_at ?? now();
        const { rows } = await pool.query(
          `INSERT INTO playbooks (tenant_id, system_id, workspace_id, collaboration_id, scope_id, title, description, instructions,
             references_json, templates, scripts, assets, tags, rationale, status, source_session_id, source_working_memory_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)
           RETURNING *`,
          [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id,
           input.title, input.description, input.instructions,
           JSON.stringify(input.references ?? []), JSON.stringify(input.templates ?? []),
           JSON.stringify(input.scripts ?? []), JSON.stringify(input.assets ?? []),
           JSON.stringify(input.tags ?? []), input.rationale ?? null, input.status ?? 'draft',
           input.source_session_id ?? null, input.source_working_memory_id ?? null, createdAt],
        );
        const playbook = mapPlaybook(rows[0]);
        await insertMemoryEventInternal({
          ...n,
          session_id: playbook.source_session_id,
          entity_kind: 'playbook',
          entity_id: String(playbook.id),
          event_type: 'playbook.created',
          payload: {
            after: playbook,
          },
          created_at: createdAt,
        });
        return playbook;
      });
    },
    async getPlaybookById(id) {
      const { rows } = await pool.query('SELECT * FROM playbooks WHERE id = $1', [id]);
      return rows[0] ? mapPlaybook(rows[0]) : null;
    },

    async getExistingPlaybookIds(ids) {
      return getExistingIds('playbooks', ids);
    },
    async getActivePlaybooks(scope) {
      const { rows } = await pool.query(
        `SELECT * FROM playbooks WHERE ${scopeWhere()} AND status IN ('draft', 'active') ORDER BY id DESC`,
        scopeParams(scope),
      );
      return rows.map(mapPlaybook);
    },
    async getActivePlaybooksCrossScope(scope, level) {
      const { rows } = await pool.query(
        `SELECT * FROM playbooks
         WHERE ${wideScopeWhere(scope, level)} AND status IN ('draft', 'active')
         ORDER BY id DESC`,
        wideScopeParams(scope, level),
      );
      return rows.map(mapPlaybook);
    },
    async searchPlaybooks(scope, query, options) {
      const limit = options?.limit ?? 20;
      const activeOnly = options?.activeOnly ?? true;
      const statusFilter = activeOnly
        ? `AND status NOT IN ('archived', 'deprecated')`
        : '';
      const { rows } = await pool.query(
        `SELECT *, ts_rank(search_vector, plainto_tsquery('english', $6)) AS rank
         FROM playbooks WHERE ${scopeWhere()} ${statusFilter}
         AND search_vector @@ plainto_tsquery('english', $6)
         ORDER BY rank DESC LIMIT $7`,
        [...scopeParams(scope), query, limit],
      );
      return rows.map((row: Record<string, unknown>, index: number) => ({
        item: mapPlaybook(row),
        rank: Number(row.rank ?? index),
      }));
    },
    async searchPlaybooksCrossScope(scope, level, query, options) {
      const limit = options?.limit ?? 20;
      const activeOnly = options?.activeOnly ?? true;
      const scopeClause = wideScopeWhere(scope, level);
      const statusFilter = activeOnly
        ? `AND status NOT IN ('archived', 'deprecated')`
        : '';
      const baseParams = wideScopeParams(scope, level);
      const queryIndex = baseParams.length + 1;
      const limitIndex = baseParams.length + 2;
      const { rows } = await pool.query(
        `SELECT *, ts_rank(search_vector, plainto_tsquery('english', $${queryIndex})) AS rank
         FROM playbooks WHERE ${scopeClause} ${statusFilter}
         AND search_vector @@ plainto_tsquery('english', $${queryIndex})
         ORDER BY rank DESC LIMIT $${limitIndex}`,
        [...baseParams, query, limit],
      );
      return rows.map((row: Record<string, unknown>, index: number) => ({
        item: mapPlaybook(row),
        rank: Number(row.rank ?? index),
      }));
    },
    async updatePlaybook(id, patch) {
      // Phase 2.1: atomic row-update + event.
      return this.transaction(async () => {
      const before = await this.getPlaybookById(id);
      const sets: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      if (patch.title != null) { sets.push(`title = $${idx++}`); values.push(patch.title); }
      if (patch.description != null) { sets.push(`description = $${idx++}`); values.push(patch.description); }
      if (patch.instructions != null) { sets.push(`instructions = $${idx++}`); values.push(patch.instructions); }
      if (patch.references != null) { sets.push(`references_json = $${idx++}`); values.push(JSON.stringify(patch.references)); }
      if (patch.templates != null) { sets.push(`templates = $${idx++}`); values.push(JSON.stringify(patch.templates)); }
      if (patch.scripts != null) { sets.push(`scripts = $${idx++}`); values.push(JSON.stringify(patch.scripts)); }
      if (patch.assets != null) { sets.push(`assets = $${idx++}`); values.push(JSON.stringify(patch.assets)); }
      if (patch.tags != null) { sets.push(`tags = $${idx++}`); values.push(JSON.stringify(patch.tags)); }
      if (patch.rationale !== undefined) { sets.push(`rationale = $${idx++}`); values.push(patch.rationale); }
      if (patch.status != null) { sets.push(`status = $${idx++}`); values.push(patch.status); }
      if (sets.length === 0) return this.getPlaybookById(id);
      sets.push(`updated_at = $${idx++}`);
      values.push(now());
      values.push(id);
      const { rows } = await pool.query(
        `UPDATE playbooks SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
        values,
      );
      const after = rows[0] ? mapPlaybook(rows[0]) : null;
      if (before && after) {
        await insertMemoryEventInternal({
          ...normalizeScope(after),
          session_id: after.source_session_id,
          entity_kind: 'playbook',
          entity_id: String(after.id),
          event_type: 'playbook.updated',
          payload: {
            before,
            after,
            patch,
          },
          created_at: after.updated_at,
        });
      }
      return after;
      });
    },
    async recordPlaybookUse(id) {
      // Phase 2.1: atomic row-update + event.
      await this.transaction(async () => {
        const before = await this.getPlaybookById(id);
        const usedAt = now();
        await pool.query(
          'UPDATE playbooks SET use_count = use_count + 1, last_used_at = $1 WHERE id = $2',
          [usedAt, id],
        );
        const after = await this.getPlaybookById(id);
        if (before && after) {
          await insertMemoryEventInternal({
            ...normalizeScope(after),
            session_id: after.source_session_id,
            entity_kind: 'playbook',
            entity_id: String(after.id),
            event_type: 'playbook.used',
            payload: {
              before,
              after,
              refs: {
                use_count: after.use_count,
              },
            },
            created_at: usedAt,
          });
        }
      });
    },
    async insertPlaybookRevision(input) {
      // Phase 2.1: revision insert + playbook counter bump + event are atomic.
      return this.transaction(async () => {
        const playbook = await this.getPlaybookById(input.playbook_id);
        if (!playbook) {
          throw new Error(`Playbook ${input.playbook_id} not found`);
        }
        const createdAt = input.created_at ?? now();
        const { rows } = await pool.query(
          `INSERT INTO playbook_revisions (tenant_id, system_id, workspace_id, collaboration_id, scope_id, playbook_id, instructions, revision_reason, source_session_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [playbook.tenant_id, playbook.system_id, playbook.workspace_id, playbook.collaboration_id, playbook.scope_id,
           input.playbook_id, input.instructions, input.revision_reason,
           input.source_session_id ?? null, createdAt],
        );
        // D1: a revision mutates the parent playbook (revision_count, updated_at).
        // Bump both and capture the after-image so we can emit a playbook
        // after-snapshot below — foldTemporalState only folds the `playbook`
        // entity kind, not `playbook_revision`, so replay needs this event to
        // reconstruct the bumped revision_count/updated_at.
        const { rows: playbookRows } = await pool.query(
          'UPDATE playbooks SET revision_count = revision_count + 1, updated_at = $2 WHERE id = $1 RETURNING *',
          [input.playbook_id, createdAt],
        );
        const revision = mapPlaybookRevision(rows[0]);
        const updatedPlaybook = mapPlaybook(playbookRows[0]);
        await insertMemoryEventInternal({
          ...normalizeScope(revision),
          session_id: revision.source_session_id,
          entity_kind: 'playbook_revision',
          entity_id: String(revision.id),
          event_type: 'playbook.revised',
          payload: {
            after: revision,
            refs: {
              playbook_id: revision.playbook_id,
            },
          },
          created_at: revision.created_at,
        });
        // D1: playbook after-snapshot (event_id-ordered AFTER playbook.revised).
        await insertMemoryEventInternal({
          ...normalizeScope(updatedPlaybook),
          session_id: updatedPlaybook.source_session_id,
          entity_kind: 'playbook',
          entity_id: String(updatedPlaybook.id),
          event_type: 'playbook.updated',
          payload: {
            after: updatedPlaybook,
            refs: {
              revision_id: revision.id,
              revision_count: updatedPlaybook.revision_count,
            },
          },
          created_at: updatedPlaybook.updated_at,
        });
        return revision;
      });
    },
    async getPlaybookRevisions(playbookId) {
      const { rows } = await pool.query(
        'SELECT * FROM playbook_revisions WHERE playbook_id = $1 ORDER BY created_at DESC',
        [playbookId],
      );
      return rows.map(mapPlaybookRevision);
    },

    async insertAssociation(input) {
      // Phase 2.1: atomic row + event. A unique-violation aborts before any
      // event is written; the transaction rolls back either way.
      const n = normalizeScope(input);
      try {
        return await this.transaction(async () => {
          const { rows } = await pool.query(
            `INSERT INTO associations
              (tenant_id, system_id, workspace_id, collaboration_id, scope_id,
               source_kind, source_id, target_kind, target_id, association_type, provenance, confidence, auto_generated, visibility_class, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             RETURNING *`,
            [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id,
             input.source_kind, input.source_id, input.target_kind, input.target_id,
             input.association_type, input.provenance ?? 'inferred', input.confidence ?? 0.8,
             input.auto_generated ?? false, input.visibility_class ?? 'private',
             input.created_at ?? now()],
          );
          const association = mapAssociation(rows[0]);
          await insertMemoryEventInternal({
            ...n,
            entity_kind: 'association',
            entity_id: String(association.id),
            event_type: 'association.created',
            payload: {
              after: association,
            },
            created_at: association.created_at,
          });
          return association;
        });
      } catch (err) {
        // Postgres unique_violation is SQLSTATE 23505.
        if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
          throw new UniqueConstraintError(
            `Association already exists: ${input.source_kind}:${input.source_id} -> ${input.target_kind}:${input.target_id} (${input.association_type})`,
            err,
          );
        }
        throw err;
      }
    },
    async getAssociationById(id) {
      const { rows } = await pool.query('SELECT * FROM associations WHERE id = $1', [id]);
      if (rows.length === 0) return null;
      return mapAssociation(rows[0]);
    },
    async getAssociationsFrom(kind, id, scope) {
      const n = normalizeScope(scope);
      const { rows } = await pool.query(
        `SELECT * FROM associations WHERE source_kind = $1 AND source_id = $2
         AND tenant_id = $3 AND system_id = $4 AND workspace_id = $5 AND collaboration_id = $6 AND scope_id = $7
         ORDER BY id DESC`,
        [kind, id, n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id],
      );
      return rows.map(mapAssociation);
    },
    async getAssociationsTo(kind, id, scope) {
      const n = normalizeScope(scope);
      const { rows } = await pool.query(
        `SELECT * FROM associations WHERE target_kind = $1 AND target_id = $2
         AND tenant_id = $3 AND system_id = $4 AND workspace_id = $5 AND collaboration_id = $6 AND scope_id = $7
         ORDER BY id DESC`,
        [kind, id, n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id],
      );
      return rows.map(mapAssociation);
    },
    async listAssociations(scope) {
      const n = normalizeScope(scope);
      const { rows } = await pool.query(
        `SELECT * FROM associations
         WHERE tenant_id = $1 AND system_id = $2 AND workspace_id = $3 AND collaboration_id = $4 AND scope_id = $5
         ORDER BY id DESC`,
        [n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id],
      );
      return rows.map(mapAssociation);
    },
    async deleteAssociation(id) {
      // Phase 2.1: atomic row-delete + event.
      await this.transaction(async () => {
        const before = await this.getAssociationById(id);
        await pool.query('DELETE FROM associations WHERE id = $1', [id]);
        if (before) {
          await insertMemoryEventInternal({
            ...normalizeScope(before),
            entity_kind: 'association',
            entity_id: String(before.id),
            event_type: 'association.deleted',
            payload: {
              before,
            },
            created_at: now(),
          });
        }
      });
    },

    async insertMemoryEvent(input) {
      return insertMemoryEventInternal(input);
    },

    async listMemoryEvents(scope, query) {
      return listScopedMemoryEvents(scope, query);
    },

    async listMemoryEventsCrossScope(scope, level, query) {
      return listScopedMemoryEventsCrossScope(scope, level, query);
    },

    async getMemoryEventsByEntity(scope, entityKind, entityId, query) {
      return listScopedMemoryEvents(scope, {
        ...query,
        entityKind,
        entityId,
      });
    },

    async getMemoryEventsBySession(scope, sessionId, query) {
      return listScopedMemoryEvents(scope, {
        ...query,
        sessionId,
      });
    },

    async getSessionState(scope, sessionId) {
      return readSessionStateProjection(scope, sessionId);
    },

    async upsertSessionState(input) {
      // Phase 2.1: atomic projection upsert + event.
      return this.transaction(async () => {
        const projection = await writeSessionStateProjection(input);
        await insertMemoryEventInternal({
          ...normalizeScope(projection),
          session_id: projection.session_id,
          entity_kind: 'session_state',
          entity_id: projection.session_id,
          event_type: 'session_state.updated',
          payload: {
            after: projection,
          },
          created_at: projection.updatedAt,
        });
        return projection;
      });
    },

    async getTemporalWatermark(projectionName) {
      return readTemporalWatermark(projectionName);
    },

    async upsertTemporalWatermark(input) {
      return writeTemporalWatermark(input);
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      const existing = txStorage.getStore();
      if (existing) {
        const savepoint = `memory_layer_sp_${existing.savepointCounter++}`;
        await existing.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await fn();
          await existing.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          try {
            await existing.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          } finally {
            await existing.client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
          }
          throw error;
        }
      }

      const client = await pool.connect();
      const context = { client, savepointCounter: 0 };
      await client.query('BEGIN');
      try {
        const result = await txStorage.run(context, fn);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async insertSourceDocument(input: NewSourceDocument): Promise<SourceDocument> {
      // Phase 2.2: source-document ingestion is audited; row + event atomic.
      return this.transaction(async () => {
        const n = normalizeScope(input);
        const createdAt = nowSeconds();
        const { rows } = await pool.query(
          `INSERT INTO source_documents
            (tenant_id, system_id, workspace_id, collaboration_id, scope_id, title, content_hash,
             mime_type, url, metadata, status, fact_count, token_estimate, created_at, processed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING *`,
          [
            n.tenant_id, n.system_id, n.workspace_id, n.collaboration_id, n.scope_id,
            input.title, input.content_hash, input.mime_type ?? 'text/plain',
            input.url ?? null, JSON.stringify(input.metadata ?? {}),
            input.status ?? 'pending', 0, input.token_estimate ?? 0,
            createdAt, null,
          ],
        );
        const doc = mapSourceDocumentRow(rows[0]);
        await insertMemoryEventInternal({
          ...n,
          entity_kind: 'source_document',
          entity_id: String(doc.id),
          event_type: 'source_document.created',
          payload: {
            after: doc,
          },
          created_at: doc.created_at,
        });
        return doc;
      });
    },

    async getSourceDocumentById(id: number): Promise<SourceDocument | null> {
      const { rows } = await pool.query('SELECT * FROM source_documents WHERE id = $1', [id]);
      return rows.length > 0 ? mapSourceDocumentRow(rows[0]) : null;
    },

    async getSourceDocumentByHash(contentHash: string, scope: MemoryScope): Promise<SourceDocument | null> {
      const n = normalizeScope(scope);
      const { rows } = await pool.query(
        `SELECT * FROM source_documents WHERE content_hash = $1 AND tenant_id = $2 AND system_id = $3 AND workspace_id = $4 AND collaboration_id = $5 AND scope_id = $6 LIMIT 1`,
        [contentHash, n.tenant_id, n.system_id, n.workspace_id ?? '', n.collaboration_id ?? '', n.scope_id],
      );
      return rows.length > 0 ? mapSourceDocumentRow(rows[0]) : null;
    },

    async listSourceDocuments(scope: MemoryScope, opts?: PaginationOptions): Promise<PaginatedResult<SourceDocument>> {
      const n = normalizeScope(scope);
      const limit = opts?.limit ?? 50;
      const cursor = typeof opts?.cursor === 'number' ? opts.cursor : undefined;
      const baseWhere = `tenant_id = $1 AND system_id = $2 AND workspace_id = $3 AND collaboration_id = $4 AND scope_id = $5`;
      const where = cursor != null ? `${baseWhere} AND id < $6` : baseWhere;
      const params: unknown[] = [n.tenant_id, n.system_id, n.workspace_id ?? '', n.collaboration_id ?? '', n.scope_id];
      if (cursor != null) params.push(cursor);
      const { rows } = await pool.query(
        `SELECT * FROM source_documents WHERE ${where} ORDER BY id DESC LIMIT $${params.length + 1}`,
        [...params, limit + 1],
      );
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(mapSourceDocumentRow);
      return { items, hasMore, nextCursor: hasMore && items.length > 0 ? items[items.length - 1].id : null };
    },

    async updateSourceDocument(id: number, patch: { status?: SourceDocumentStatus; fact_count?: number; processed_at?: number | null }): Promise<SourceDocument | null> {
      // Phase 2.2: source-document update is audited; row + event atomic.
      return this.transaction(async () => {
        const setClauses: string[] = [];
        const values: unknown[] = [id];
        let pi = 2;
        if (patch.status !== undefined) { setClauses.push(`status = $${pi++}`); values.push(patch.status); }
        if (patch.fact_count !== undefined) { setClauses.push(`fact_count = $${pi++}`); values.push(patch.fact_count); }
        if (patch.processed_at !== undefined) { setClauses.push(`processed_at = $${pi++}`); values.push(patch.processed_at); }
        if (setClauses.length === 0) return this.getSourceDocumentById(id);
        const beforeRow = await this.getSourceDocumentById(id);
        const { rows } = await pool.query(`UPDATE source_documents SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`, values);
        if (rows.length === 0) return null;
        const after = mapSourceDocumentRow(rows[0]);
        await insertMemoryEventInternal({
          ...normalizeScope(after),
          entity_kind: 'source_document',
          entity_id: String(after.id),
          event_type: 'source_document.updated',
          payload: {
            before: beforeRow,
            after,
            patch,
          },
          created_at: nowSeconds(),
        });
        return after;
      });
    },

    async getScopeConfig(scope: MemoryScope, key: string): Promise<string | null> {
      const { rows } = await pool.query(
        `SELECT config_value
         FROM scope_config
         WHERE ${scopeWhere()} AND config_key = $6
         LIMIT 1`,
        [...scopeParams(scope), key],
      );
      return rows[0] ? String(rows[0].config_value) : null;
    },

    async setScopeConfig(scope: MemoryScope, key: string, value: string): Promise<void> {
      const normalized = normalizeScope(scope);
      const now = nowSeconds();
      await pool.query(
        `INSERT INTO scope_config (
           tenant_id,
           system_id,
           workspace_id,
           collaboration_id,
           scope_id,
           config_key,
           config_value,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, system_id, workspace_id, collaboration_id, scope_id, config_key)
         DO UPDATE SET
           config_value = EXCLUDED.config_value,
           updated_at = EXCLUDED.updated_at`,
        [
          normalized.tenant_id,
          normalized.system_id,
          normalized.workspace_id,
          normalized.collaboration_id,
          normalized.scope_id,
          key,
          value,
          now,
          now,
        ],
      );
    },

    async close() {
      if (options?.ownsPool !== false) {
        await rootPool.end();
      }
    },
  };
}

export function createPostgresEmbeddingAdapter(
  pool: PgPool,
  options?: PostgresAdapterOptions,
): EmbeddingAdapter {
  // Phase 2.4: track which per-dimension HNSW indexes we have already ensured
  // this process, so the CREATE INDEX round-trip only runs the first time a
  // given dimension appears. This is a fast-path optimisation; correctness does
  // not depend on it (CREATE INDEX IF NOT EXISTS is idempotent and the DB is the
  // source of truth across processes).
  const ensuredHnswDimensions = new Set<number>();

  // A distinct 64-bit advisory-lock key per dimension so two concurrent
  // storeEmbedding calls that both introduce the same new dimension serialise
  // their CREATE INDEX rather than racing (CONCURRENTLY is not used, so the
  // plain CREATE takes an exclusive lock; the advisory lock avoids one waiter
  // erroring on a duplicate-relation race window). A fixed namespace prefix
  // keeps the key from colliding with unrelated advisory locks.
  const HNSW_ADVISORY_NAMESPACE = 0x656d6248; // 'embH'

  async function ensureHnswIndexForDimension(dimensions: number): Promise<void> {
    if (!Number.isInteger(dimensions) || dimensions <= 0) return;
    if (ensuredHnswDimensions.has(dimensions)) return;
    const indexName = `emb_hnsw_${dimensions}`;
    try {
      // Phase 2.4 fix: pg_advisory_lock is SESSION-level, so the lock and unlock
      // MUST run on the same physical connection. Previously these were three
      // separate pool.query calls that could each land on a DIFFERENT pooled
      // connection, leaking a session lock on the connection that acquired it
      // (the unlock ran on another connection and was a no-op) and hanging later
      // writers. Acquire ONE client for lock+create+unlock and release it in a
      // finally so the whole critical section is pinned to that connection.
      const client = await pool.connect();
      try {
        // Advisory lock scoped to (namespace, dimensions).
        await client.query('SELECT pg_advisory_lock($1, $2)', [HNSW_ADVISORY_NAMESPACE, dimensions]);
        try {
          // The index name and vector(N) cast are derived from a validated
          // integer dimension, so there is no injection surface. IF NOT EXISTS
          // makes this idempotent; the advisory lock removes the concurrent-
          // create race.
          await client.query(
            `CREATE INDEX IF NOT EXISTS ${indexName}
               ON knowledge_embeddings
               USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops)
               WHERE dimensions = ${dimensions}`,
          );
          ensuredHnswDimensions.add(dimensions);
        } finally {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [HNSW_ADVISORY_NAMESPACE, dimensions]);
        }
      } finally {
        client.release();
      }
    } catch (err) {
      // Never let index maintenance fail a write: the row is already stored and
      // similarity queries fall back to a sequential scan (still correct, just
      // slower) if the index cannot be built (e.g. pgvector missing, or a
      // duplicate-create raced past IF NOT EXISTS). Log and continue.
      options?.logger?.warn?.(
        `memory-layer: could not ensure HNSW index ${indexName} (dimensions=${dimensions}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    async storeEmbedding(knowledgeMemoryId, vector, metadata): Promise<void> {
      const model = metadata?.model ?? 'unknown';
      // Phase 2.4 (minor) fix: the `dimensions` column is the sole key for the
      // partial HNSW index and the `vector(N)` casts in findSimilar, so it MUST
      // equal the actual stored vector length. Deriving it from a caller-supplied
      // metadata.dimensions let a lying value diverge from the real vector and
      // reintroduce the "different vector dimensions" cast error at query time.
      // We derive dimensions from vector.length and reject a contradicting
      // metadata.dimensions rather than silently trusting it.
      const dimensions = vector.length;
      if (metadata?.dimensions != null && metadata.dimensions !== dimensions) {
        throw new ValidationError(
          `memory-layer: embedding metadata.dimensions (${metadata.dimensions}) does not match vector length (${dimensions})`,
        );
      }
      const { rows } = await pool.query(
        `INSERT INTO knowledge_embeddings (
           knowledge_memory_id,
           tenant_id,
           system_id,
           workspace_id,
           collaboration_id,
           scope_id,
           embedding,
           model,
           dimensions,
           created_at
         )
         SELECT
           km.id,
           km.tenant_id,
           km.system_id,
           km.workspace_id,
           km.collaboration_id,
           km.scope_id,
           $2::vector,
           $3,
           $4,
           $5
         FROM knowledge_memory km
         WHERE km.id = $1
         ON CONFLICT (knowledge_memory_id) DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id,
           system_id = EXCLUDED.system_id,
           workspace_id = EXCLUDED.workspace_id,
           collaboration_id = EXCLUDED.collaboration_id,
           scope_id = EXCLUDED.scope_id,
           embedding = EXCLUDED.embedding,
           model = EXCLUDED.model,
           dimensions = EXCLUDED.dimensions,
           created_at = EXCLUDED.created_at
         RETURNING knowledge_memory_id`,
        [knowledgeMemoryId, vectorToLiteral(vector), model, dimensions, nowSeconds()],
      );
      if (!rows[0]) {
        throw new Error(`memory-layer: cannot store embedding for missing knowledge ${knowledgeMemoryId}`);
      }
      // Lazily ensure the partial HNSW index for this dimension exists. Done
      // after the row is committed so a failing index build never loses data.
      await ensureHnswIndexForDimension(dimensions);
    },

    async getEmbedding(knowledgeMemoryId): Promise<EmbeddingVector | null> {
      const { rows } = await pool.query(
        'SELECT embedding FROM knowledge_embeddings WHERE knowledge_memory_id = $1',
        [knowledgeMemoryId],
      );
      return rows[0] ? parseVectorValue(rows[0].embedding) : null;
    },

    async findSimilar(
      scope: MemoryScope,
      queryVector: EmbeddingVector,
      options,
    ): Promise<SimilarEmbeddingResult[]> {
      // Phase 2.4: exclude dimension-mismatched (and, when known, model-
      // mismatched) vectors in SQL BEFORE the <=> operator ever runs, so a
      // mixed-dimension table can never surface the "different vector
      // dimensions" runtime error. When no filter is supplied we fall back to
      // legacy behaviour (compare all vectors).
      const filter = options?.filter;
      const params: unknown[] = [...scopeParams(scope), vectorToLiteral(queryVector)];
      const minSimilarity = options?.minSimilarity ?? 0;
      const limit = options?.limit ?? 10;
      const vectorParam = params.length; // last pushed = the query vector
      const { distExpr, extraClauses } = buildSimilarityClauses(filter, vectorParam, params, 'ke');
      params.push(minSimilarity);
      const minSimilarityParam = params.length;
      params.push(limit);
      const limitParam = params.length;
      const { rows } = await pool.query(
        `SELECT ke.knowledge_memory_id, 1 - (${distExpr}) AS similarity
         FROM knowledge_embeddings ke
         JOIN knowledge_memory km ON km.id = ke.knowledge_memory_id
         WHERE ${scopeWhere('ke')}
           AND km.superseded_by_id IS NULL
           AND km.retired_at IS NULL${extraClauses.length ? '\n           AND ' + extraClauses.join('\n           AND ') : ''}
           AND 1 - (${distExpr}) >= $${minSimilarityParam}
         ORDER BY ${distExpr} ASC
         LIMIT $${limitParam}`,
        params,
      );
      return rows.map((row) => ({
        knowledgeMemoryId: Number(row.knowledge_memory_id),
        similarity: Number(row.similarity),
      }));
    },

    async findSimilarCrossScope(
      scope: MemoryScope,
      level: ScopeLevel,
      queryVector: EmbeddingVector,
      options,
    ): Promise<SimilarEmbeddingResult[]> {
      const filter = options?.filter;
      const params: unknown[] = [...wideScopeParams(scope, level), vectorToLiteral(queryVector)];
      const minSimilarity = options?.minSimilarity ?? 0;
      const limit = options?.limit ?? 10;
      const vectorParam = params.length; // last pushed = the query vector
      const { distExpr, extraClauses } = buildSimilarityClauses(filter, vectorParam, params, 'ke');
      params.push(minSimilarity);
      const minSimilarityParam = params.length;
      params.push(limit);
      const limitParam = params.length;
      const { rows } = await pool.query(
        `SELECT ke.knowledge_memory_id, 1 - (${distExpr}) AS similarity
         FROM knowledge_embeddings ke
         JOIN knowledge_memory km ON km.id = ke.knowledge_memory_id
         WHERE ${wideScopeWhere(scope, level, 'ke')}
           AND km.superseded_by_id IS NULL
           AND km.retired_at IS NULL${extraClauses.length ? '\n           AND ' + extraClauses.join('\n           AND ') : ''}
           AND 1 - (${distExpr}) >= $${minSimilarityParam}
         ORDER BY ${distExpr} ASC
         LIMIT $${limitParam}`,
        params,
      );
      return rows.map((row) => ({
        knowledgeMemoryId: Number(row.knowledge_memory_id),
        similarity: Number(row.similarity),
      }));
    },

    async getEmbeddingCoverage(scope, filter): Promise<EmbeddingCoverage> {
      // Count active-knowledge embeddings in scope, and how many match the
      // active provider filter (same predicate as findSimilar, minus the
      // distance operator). Mirrors the in-memory reference.
      const params: unknown[] = [...scopeParams(scope)];
      const matchClauses: string[] = [];
      if (filter?.dimensions != null) {
        params.push(filter.dimensions);
        matchClauses.push(`ke.dimensions = $${params.length}`);
      }
      if (filter?.model != null && filter.model !== 'unknown') {
        // D2: only when the active model is known (see buildSimilarityClauses).
        params.push(filter.model);
        matchClauses.push(`(ke.model = $${params.length} OR ke.model = 'unknown')`);
      }
      const matchExpr = matchClauses.length ? matchClauses.join(' AND ') : 'TRUE';
      const { rows } = await pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE ${matchExpr})::int AS matching
         FROM knowledge_embeddings ke
         JOIN knowledge_memory km ON km.id = ke.knowledge_memory_id
         WHERE ${scopeWhere('ke')}
           AND km.superseded_by_id IS NULL
           AND km.retired_at IS NULL`,
        params,
      );
      const total = Number(rows[0]?.total ?? 0);
      const matching = Number(rows[0]?.matching ?? 0);
      return { total, matching, mismatched: total - matching };
    },

    async deleteEmbedding(knowledgeMemoryId, scope): Promise<void> {
      if (scope) {
        // Params are [id, ...scope]: $1 is the id, scope binds at $2..$6.
        await pool.query(
          `DELETE FROM knowledge_embeddings ke
           USING knowledge_memory km
           WHERE ke.knowledge_memory_id = $1
             AND km.id = ke.knowledge_memory_id
             AND km.id = $1
             AND ${scopeWhere('km', 2)}`,
          [knowledgeMemoryId, ...scopeParams(scope)],
        );
        return;
      }
      await pool.query('DELETE FROM knowledge_embeddings WHERE knowledge_memory_id = $1', [knowledgeMemoryId]);
    },
  };
}
