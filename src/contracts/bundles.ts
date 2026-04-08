import type { MemoryScope } from './identity.js';
import type { KnowledgeClass, KnowledgeMemory, Playbook } from './types.js';

export interface MemoryBundle {
  name: string;
  version: string;
  facts: KnowledgeMemory[];
  playbooks: Playbook[];
  metadata: Record<string, unknown>;
  exportedAt: string;
}

export interface BundleExportOptions {
  scope: MemoryScope;
  includeTags?: string[];
  knowledgeClassFilter?: KnowledgeClass[];
}

export type BundleConflictResolution = 'skip' | 'overwrite' | 'merge' | 'trust_higher';

export interface BundleImportOptions {
  conflictResolution: BundleConflictResolution;
  targetScope: MemoryScope;
  preserveTrust?: boolean;
}
