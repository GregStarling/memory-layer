import type {
  CompactionLog,
  ContextMonitor,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  Turn,
  WorkItem,
  WorkingMemory,
} from '../../contracts/types.js';

interface WorkingMemoryRow extends Omit<WorkingMemory, 'key_entities' | 'topic_tags'> {
  key_entities: string;
  topic_tags: string;
}

interface CompactionLogRow extends Omit<CompactionLog, 'model_call_made'> {
  model_call_made: number;
}

interface KnowledgeMemoryRow extends Omit<KnowledgeMemory, 'is_negated'> {
  is_negated: number;
}

interface KnowledgeMemoryAuditRow extends Omit<KnowledgeMemoryAudit, 'is_negated'> {
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

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToTurn(row: Turn): Turn {
  return row;
}

export function rowToWorkingMemory(row: WorkingMemoryRow): WorkingMemory {
  return {
    ...row,
    key_entities: parseJsonArray(row.key_entities),
    topic_tags: parseJsonArray(row.topic_tags),
  };
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToKnowledgeMemory(row: KnowledgeMemoryRow): KnowledgeMemory {
  return {
    ...row,
    is_negated: row.is_negated === 1,
  };
}

export function rowToKnowledgeMemoryAudit(row: KnowledgeMemoryAuditRow): KnowledgeMemoryAudit {
  return {
    ...row,
    is_negated: row.is_negated === 1,
  };
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToContextMonitor(row: ContextMonitor): ContextMonitor {
  return row;
}

/** Identity — exists so all row types pass through a mapper consistently. */
export function rowToWorkItem(row: WorkItem): WorkItem {
  return row;
}

export function rowToCompactionLog(row: CompactionLogRow): CompactionLog {
  return {
    ...row,
    model_call_made: row.model_call_made === 1,
  };
}

export type { CompactionLogRow, KnowledgeMemoryAuditRow, KnowledgeMemoryRow, WorkingMemoryRow };
