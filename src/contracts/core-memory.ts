import type { KnowledgeClass, KnowledgeMemory, Playbook, WorkItem } from './types.js';

/** Overflow strategy when the token budget is exceeded. */
export type OverflowStrategy = 'truncate' | 'prioritize' | 'error';

/** Policy controlling when to regenerate the core memory bundle. */
export type RefreshPolicy = 'always' | 'stale' | 'manual';

export interface CoreMemoryBundle {
  /** Identity facts (who the agent is, role, name). */
  identity: KnowledgeMemory[];
  /** Hard constraints and rules. */
  constraints: KnowledgeMemory[];
  /** Norms, preferences, and soft guidelines. */
  norms: KnowledgeMemory[];
  /** Active work items. */
  workItems: WorkItem[];
  /** Top-ranked playbook, if any. */
  topPlaybook: Playbook | null;
  /** Estimated token count for the serialized bundle. */
  tokenEstimate: number;
  /** Timestamp (epoch seconds) when this bundle was generated. */
  generatedAt: number;
}

export interface CoreMemoryOptions {
  /** Maximum token budget for the bundle. @default 1500 */
  tokenBudget?: number;
  /** Restrict to specific knowledge classes. */
  includeClasses?: KnowledgeClass[];
  /** When to regenerate the bundle. @default 'stale' */
  refreshPolicy?: RefreshPolicy;
  /** What to do when the bundle exceeds the token budget. @default 'truncate' */
  overflowStrategy?: OverflowStrategy;
}
