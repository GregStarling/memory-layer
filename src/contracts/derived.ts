import type { MemoryScope } from './identity.js';

export type BuiltInDerivedOutputType =
  | 'playbook_candidate'
  | 'coding_rule'
  | 'anti_pattern'
  | 'project_summary';

/**
 * Output type for derivation. Accepts built-in types and custom string
 * types registered via registerDerivationHandler().
 */
export type DerivedOutputType = BuiltInDerivedOutputType | (string & {});

export interface DerivedOutput {
  type: DerivedOutputType;
  content: string;
  confidence: number;
  sourceKnowledgeIds: number[];
  rationale: string;
}

export interface DeriveOptions {
  outputTypes?: DerivedOutputType[];
  scope?: MemoryScope;
  maxOutputs?: number;
}
