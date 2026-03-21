import type {
  CompactionLog,
  ContextMonitor,
  KnowledgeMemory,
  Turn,
  WorkingMemory,
} from '../../contracts/types.js';

interface WorkingMemoryRow extends Omit<WorkingMemory, 'key_entities' | 'topic_tags'> {
  key_entities: string;
  topic_tags: string;
}

interface CompactionLogRow extends Omit<CompactionLog, 'model_call_made'> {
  model_call_made: number;
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

export function rowToKnowledgeMemory(row: KnowledgeMemory): KnowledgeMemory {
  return row;
}

export function rowToContextMonitor(row: ContextMonitor): ContextMonitor {
  return row;
}

export function rowToCompactionLog(row: CompactionLogRow): CompactionLog {
  return {
    ...row,
    model_call_made: row.model_call_made === 1,
  };
}

export type { CompactionLogRow, WorkingMemoryRow };
