import type {
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

interface KnowledgeMemoryRow extends Omit<KnowledgeMemory, 'is_negated' | 'source_turn_ids'> {
  is_negated: number;
  source_turn_ids: string;
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

function parseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function serializeStringArray(values: string[]): string {
  return JSON.stringify(values);
}

export function serializeNumberArray(values: number[]): string {
  return JSON.stringify(values);
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
    collaboration_id: row.collaboration_id ?? row.workspace_id,
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
    collaboration_id: row.collaboration_id ?? row.workspace_id,
    key_entities: parseJsonArray(row.key_entities),
    topic_tags: parseJsonArray(row.topic_tags),
    episode_recap: episodeRecap,
  };
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToKnowledgeMemory(row: KnowledgeMemoryRow): KnowledgeMemory {
  return {
    ...row,
    collaboration_id: row.collaboration_id ?? row.workspace_id,
    source_collaboration_id:
      row.source_collaboration_id ?? row.collaboration_id ?? row.workspace_id ?? null,
    is_negated: row.is_negated === 1,
    source_turn_ids: parseJsonNumberArray(row.source_turn_ids),
  };
}

export function rowToKnowledgeCandidate(row: KnowledgeCandidateRow): KnowledgeCandidate {
  return {
    ...row,
    collaboration_id: row.collaboration_id ?? row.workspace_id,
    source_summary: row.source_summary === 1,
    source_turns: row.source_turns === 1,
  };
}

export function rowToKnowledgeEvidence(row: KnowledgeEvidenceRow): KnowledgeEvidence {
  return {
    ...row,
    collaboration_id: row.collaboration_id ?? row.workspace_id,
    is_explicit: row.is_explicit === 1,
  };
}

export function rowToKnowledgeMemoryAudit(row: KnowledgeMemoryAuditRow): KnowledgeMemoryAudit {
  return {
    ...row,
    collaboration_id: row.collaboration_id ?? row.workspace_id,
    is_negated: row.is_negated === 1,
  };
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToContextMonitor(row: ContextMonitor): ContextMonitor {
  return {
    ...row,
    collaboration_id: row.collaboration_id ?? row.workspace_id,
  };
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToWorkItem(row: WorkItem): WorkItem {
  return {
    ...row,
    collaboration_id: row.collaboration_id ?? row.workspace_id,
  };
}

export function rowToCompactionLog(row: CompactionLogRow): CompactionLog {
  return {
    ...row,
    collaboration_id: row.collaboration_id ?? row.workspace_id,
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
    collaboration_id: row.collaboration_id ?? row.workspace_id,
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
    collaboration_id: row.collaboration_id ?? row.workspace_id,
  };
}

export type { CompactionLogRow, KnowledgeMemoryAuditRow, KnowledgeMemoryRow, PlaybookRow, WorkingMemoryRow };
export type { KnowledgeCandidateRow, KnowledgeEvidenceRow };
