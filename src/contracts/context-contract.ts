import type { ContextViewPolicy } from './coordination.js';
import type { ScopeLevel } from './identity.js';
import type { KnowledgeClass } from './types.js';

export type ContextInvariantSeverity = 'critical' | 'important' | 'advisory';

export const CONTEXT_INVARIANT_SEVERITIES: readonly ContextInvariantSeverity[] = [
  'critical',
  'important',
  'advisory',
];

export interface ContextInvariant {
  id: string;
  title: string;
  instruction: string;
  /** Higher-severity invariants are preserved first when context must be trimmed. */
  severity?: ContextInvariantSeverity;
  /** More local invariants outrank broader ones when non-critical invariants compete for budget. */
  scopeLevel?: ScopeLevel;
}

export interface ContextContract {
  name?: string;
  view?: ContextViewPolicy;
  crossScopeLevel?: ScopeLevel;
  tokenBudget?: number;
  maxKnowledgeItems?: number;
  maxRecentSummaries?: number;
  knowledgeClasses?: KnowledgeClass[];
  minimumTrustScore?: number;
  includeCoordinationState?: boolean;
}

export type ContextContractReference = string | ContextContract;

export interface AppliedContextContract {
  name?: string;
  view?: ContextViewPolicy;
  crossScopeLevel?: ScopeLevel;
  tokenBudget: number;
  maxKnowledgeItems: number;
  maxRecentSummaries: number;
  knowledgeClasses: KnowledgeClass[] | null;
  minimumTrustScore: number | null;
  includeCoordinationState: boolean;
}
