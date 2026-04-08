import type {
  MemoryEventRecord,
  SessionStateProjection,
  TemporalProjectionWatermark,
} from '../../contracts/temporal.js';
import type {
  Association,
  CompactionLog,
  ContextMonitor,
  KnowledgeCandidate,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  Playbook,
  PlaybookRevision,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../../contracts/types.js';

interface WorkingMemoryRow extends Omit<WorkingMemory, 'key_entities' | 'topic_tags' | 'episode_recap'> {
  key_entities: string;
  topic_tags: string;
  episode_recap: string | null;
}

interface CompactionLogRow extends Omit<CompactionLog, 'model_call_made'> {
  model_call_made: number;
}

interface KnowledgeMemoryRow
  extends Omit<KnowledgeMemory, 'is_negated' | 'source_turn_ids' | 'visibility_class' | 'tags'> {
  is_negated: number;
  source_turn_ids: string;
  visibility_class?: KnowledgeMemory['visibility_class'];
  tags: string;
}

interface KnowledgeCandidateRow extends Omit<KnowledgeCandidate, 'source_summary' | 'source_turns'> {
  source_summary: number;
  source_turns: number;
}

interface KnowledgeEvidenceRow extends Omit<KnowledgeEvidence, 'is_explicit'> {
  is_explicit: number;
}

interface KnowledgeMemoryAuditRow
  extends Omit<KnowledgeMemoryAudit, 'is_negated'> {
  is_negated: number;
}

interface MemoryEventRow
  extends Omit<
    MemoryEventRecord,
    'payload' | 'actor_kind' | 'actor_system_id' | 'actor_display_name' | 'actor_metadata'
  > {
  payload: string;
  actor_kind?: string | null;
  actor_system_id?: string | null;
  actor_display_name?: string | null;
  actor_metadata?: string | null;
}

interface SessionStateProjectionRow
  extends Omit<
    SessionStateProjection,
    'blockers' | 'assumptions' | 'pendingDecisions' | 'activeTools' | 'recentOutputs'
  > {
  blockers: string;
  assumptions: string;
  pending_decisions: string;
  active_tools: string;
  recent_outputs: string;
}

interface TemporalProjectionWatermarkRow extends Omit<TemporalProjectionWatermark, 'metadata'> {
  metadata: string | null;
}

function parseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeLegacyCollaborationId(value: string | null | undefined): string {
  const resolved = value ?? '';
  return resolved === 'default' ? '' : resolved;
}

function normalizeOptionalLegacyCollaborationId(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  return normalizeLegacyCollaborationId(value);
}

export function serializeStringArray(values: string[]): string {
  return JSON.stringify(values);
}

export function serializeNumberArray(values: number[]): string {
  return JSON.stringify(values);
}

export function serializeObject(value: Record<string, unknown> | null): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseJsonNumberArray(json: string): number[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value) => Number.isInteger(value)).map((value) => Number(value))
      : [];
  } catch {
    return [];
  }
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToTurn(row: Turn): Turn {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
  };
}

export function rowToWorkingMemory(row: WorkingMemoryRow): WorkingMemory {
  let episodeRecap = null;
  if (row.episode_recap) {
    try {
      episodeRecap = JSON.parse(row.episode_recap);
    } catch {
      episodeRecap = null;
    }
  }
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    key_entities: parseJsonArray(row.key_entities),
    topic_tags: parseJsonArray(row.topic_tags),
    episode_recap: episodeRecap,
  };
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToKnowledgeMemory(row: KnowledgeMemoryRow): KnowledgeMemory {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    source_collaboration_id:
      normalizeOptionalLegacyCollaborationId(row.source_collaboration_id) ??
      normalizeLegacyCollaborationId(row.collaboration_id),
    visibility_class: row.visibility_class ?? 'private',
    is_negated: row.is_negated === 1,
    source_turn_ids: parseJsonNumberArray(row.source_turn_ids),
    valid_from: row.valid_from ?? null,
    valid_until: row.valid_until ?? null,
    rationale: row.rationale ?? null,
    tags: parseJsonArray(row.tags ?? '[]'),
  };
}

export function rowToKnowledgeCandidate(row: KnowledgeCandidateRow): KnowledgeCandidate {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    source_summary: row.source_summary === 1,
    source_turns: row.source_turns === 1,
  };
}

export function rowToKnowledgeEvidence(row: KnowledgeEvidenceRow): KnowledgeEvidence {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    is_explicit: row.is_explicit === 1,
  };
}

export function rowToKnowledgeMemoryAudit(row: KnowledgeMemoryAuditRow): KnowledgeMemoryAudit {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    is_negated: row.is_negated === 1,
  };
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToContextMonitor(row: ContextMonitor): ContextMonitor {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
  };
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToWorkItem(row: WorkItem): WorkItem {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    visibility_class: row.visibility_class ?? 'private',
    version: row.version ?? 1,
  };
}

export function rowToCompactionLog(row: CompactionLogRow): CompactionLog {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    model_call_made: row.model_call_made === 1,
  };
}

interface PlaybookRow extends Omit<Playbook, 'references' | 'templates' | 'scripts' | 'assets' | 'tags' | 'episode_recap'> {
  references_json: string;
  templates: string;
  scripts: string;
  assets: string;
  tags: string;
}

export function rowToPlaybook(row: PlaybookRow): Playbook {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    visibility_class: row.visibility_class ?? 'private',
    rationale: row.rationale ?? null,
    references: parseJsonArray(row.references_json),
    templates: parseJsonArray(row.templates),
    scripts: parseJsonArray(row.scripts),
    assets: parseJsonArray(row.assets),
    tags: parseJsonArray(row.tags),
  };
}

export function rowToPlaybookRevision(row: PlaybookRevision): PlaybookRevision {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
  };
}

export function rowToMemoryEvent(row: MemoryEventRow): MemoryEventRecord {
  return {
    ...row,
    event_id: String(row.event_id),
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    session_id: row.session_id ?? null,
    actor_id: row.actor_id ?? null,
    actor_kind: row.actor_kind ?? null,
    actor_system_id: row.actor_system_id ?? null,
    actor_display_name: row.actor_display_name ?? null,
    actor_metadata: parseJsonObject(row.actor_metadata ?? null),
    payload: parseJsonObject(row.payload) ?? {},
  };
}

export function rowToSessionStateProjection(row: SessionStateProjectionRow): SessionStateProjection {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    blockers: parseJsonArray(row.blockers),
    assumptions: parseJsonArray(row.assumptions),
    pendingDecisions: parseJsonArray(row.pending_decisions),
    activeTools: parseJsonArray(row.active_tools),
    recentOutputs: parseJsonArray(row.recent_outputs),
    source_event_id: row.source_event_id != null ? String(row.source_event_id) : null,
  };
}

export function rowToAssociation(row: Association): Association {
  return {
    ...row,
    collaboration_id: normalizeLegacyCollaborationId(row.collaboration_id),
    visibility_class: row.visibility_class ?? 'private',
    provenance: row.provenance ?? 'inferred',
    confidence: row.confidence ?? 0.8,
  };
}

export function rowToTemporalProjectionWatermark(
  row: TemporalProjectionWatermarkRow,
): TemporalProjectionWatermark {
  return {
    ...row,
    last_event_id: String(row.last_event_id),
    metadata: parseJsonObject(row.metadata),
  };
}

export type { CompactionLogRow, KnowledgeMemoryAuditRow, KnowledgeMemoryRow, PlaybookRow, WorkingMemoryRow };
export type { KnowledgeCandidateRow, KnowledgeEvidenceRow };
export type { MemoryEventRow, SessionStateProjectionRow, TemporalProjectionWatermarkRow };
