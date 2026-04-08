import type { ContextViewPolicy } from './coordination.js';
import type { ScopeLevel } from './identity.js';
import type { KnowledgeClass } from './types.js';

export type ContextInvariantSeverity = 'critical' | 'important' | 'advisory';
export type ContextWarningSeverity = 'info' | 'warning';
export type ContextWarningCode =
  | 'contract_filtered'
  | 'token_budget_trimmed'
  | 'invariants_trimmed';
export type ContextEscalationChange =
  | 'broaden_view'
  | 'widen_scope'
  | 'lower_minimum_trust'
  | 'broaden_knowledge_classes'
  | 'include_coordination_state'
  | 'increase_token_budget';
export type ContextEscalationRuleDecision = 'allow' | 'review' | 'deny';
export type ContextEscalationDecision = 'approved' | 'requires_approval' | 'denied';
export type ContextRequestReason =
  | 'blocked'
  | 'missing_constraint'
  | 'missing_procedure'
  | 'missing_workspace_context'
  | 'need_coordination_state'
  | 'need_higher_budget'
  | 'other';

export const CONTEXT_INVARIANT_SEVERITIES: readonly ContextInvariantSeverity[] = [
  'critical',
  'important',
  'advisory',
];
export const CONTEXT_WARNING_SEVERITIES: readonly ContextWarningSeverity[] = ['info', 'warning'];
export const CONTEXT_WARNING_CODES: readonly ContextWarningCode[] = [
  'contract_filtered',
  'token_budget_trimmed',
  'invariants_trimmed',
];
export const CONTEXT_ESCALATION_CHANGE_KINDS: readonly ContextEscalationChange[] = [
  'broaden_view',
  'widen_scope',
  'lower_minimum_trust',
  'broaden_knowledge_classes',
  'include_coordination_state',
  'increase_token_budget',
];
export const CONTEXT_ESCALATION_RULE_DECISIONS: readonly ContextEscalationRuleDecision[] = [
  'allow',
  'review',
  'deny',
];
export const CONTEXT_ESCALATION_DECISIONS: readonly ContextEscalationDecision[] = [
  'approved',
  'requires_approval',
  'denied',
];
export const CONTEXT_REQUEST_REASONS: readonly ContextRequestReason[] = [
  'blocked',
  'missing_constraint',
  'missing_procedure',
  'missing_workspace_context',
  'need_coordination_state',
  'need_higher_budget',
  'other',
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

export interface ContextEscalationPolicy {
  defaultDecision?: ContextEscalationRuleDecision;
  byChange?: Partial<Record<ContextEscalationChange, ContextEscalationRuleDecision>>;
  maxView?: ContextViewPolicy;
  maxScopeLevel?: ScopeLevel;
  maxTokenBudget?: number;
  minimumAllowedTrustScore?: number;
}

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

export interface ContextWarning {
  code: ContextWarningCode;
  severity: ContextWarningSeverity;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface DegradedContext {
  isDegraded: boolean;
  droppedInvariantIds: string[];
  droppedKnowledgeIds: number[];
  droppedSummaryIds: number[];
  droppedPlaybookIds: number[];
  droppedAssociatedKnowledgeIds: number[];
}

export interface ContextRequest {
  reason: ContextRequestReason;
  note?: string;
  contract?: ContextContract;
}

export interface ContextRequestResolution {
  requestId: string;
  requestedAt: number;
  reason: ContextRequestReason;
  note: string | null;
  currentContract: AppliedContextContract | null;
  proposedContract: AppliedContextContract;
  proposedContractInput: ContextContract;
  changeKinds: ContextEscalationChange[];
  decision: ContextEscalationDecision;
  requiresEscalation: boolean;
  rationale: string[];
  warnings: ContextWarning[];
}

export interface PersistedGovernanceState {
  defaultContract: ContextContract | null;
  namedContracts: Record<string, ContextContract>;
  invariants: ContextInvariant[];
  escalationPolicy: ContextEscalationPolicy | null;
}

export interface ContextGovernanceSnapshot {
  defaultContract: ContextContract | null;
  contracts: Record<string, ContextContract>;
  invariants: ContextInvariant[];
  escalationPolicy: Required<Pick<ContextEscalationPolicy, 'defaultDecision'>> &
    Omit<ContextEscalationPolicy, 'defaultDecision'>;
}
