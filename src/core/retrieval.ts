import type { MemoryScope } from '../contracts/identity.js';
import type { ContextPolicy } from '../contracts/policy.js';
import type { KnowledgeMemory, SearchOptions } from '../contracts/types.js';

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 1);
}

function overlapScore(source: string, targets: string[]): number {
  const sourceTokens = new Set(tokenize(source));
  if (sourceTokens.size === 0) return 0;
  const targetTokens = new Set(targets.flatMap((target) => tokenize(target)));
  if (targetTokens.size === 0) return 0;
  let matches = 0;
  for (const token of sourceTokens) {
    if (targetTokens.has(token)) matches += 1;
  }
  return matches / sourceTokens.size;
}

const DEFAULT_CLASS_IMPORTANCE: Record<KnowledgeMemory['knowledge_class'], number> = {
  identity: 1,
  constraint: 0.95,
  preference: 0.85,
  strategy: 0.8,
  procedure: 0.75,
  project_fact: 0.6,
  episodic_fact: 0.4,
  anti_pattern: 0.45,
};

export function getClassImportanceScore(
  knowledge: KnowledgeMemory,
  policy?: Pick<Required<ContextPolicy>, 'classImportanceOverrides'>,
): number {
  const override = policy?.classImportanceOverrides?.[knowledge.knowledge_class];
  if (override != null) {
    return override;
  }
  return DEFAULT_CLASS_IMPORTANCE[knowledge.knowledge_class] ?? 0.5;
}

export function getEvidenceDensityScore(
  knowledge: KnowledgeMemory,
  policy: Pick<Required<ContextPolicy>, 'evidenceSaturationCount'>,
): number {
  return Math.min(1, knowledge.evidence_count / Math.max(1, policy.evidenceSaturationCount));
}

export function getScopeRelationScore(
  current: MemoryScope,
  candidate: KnowledgeMemory,
  policy: Pick<
    Required<ContextPolicy>,
    'collaborationScopeScore' | 'systemScopeScore' | 'tenantScopeScore'
  >,
): number {
  const currentWorkspaceId = current.workspace_id ?? 'default';
  const currentCollaborationId = current.collaboration_id ?? '';
  if (
    candidate.tenant_id === current.tenant_id &&
    candidate.system_id === current.system_id &&
    candidate.workspace_id === currentWorkspaceId &&
    candidate.collaboration_id === currentCollaborationId &&
    candidate.scope_id === current.scope_id
  ) {
    return 1;
  }
  if (
    candidate.tenant_id === current.tenant_id &&
    currentCollaborationId.length > 0 &&
    candidate.collaboration_id === currentCollaborationId
  ) {
    return policy.collaborationScopeScore;
  }
  if (candidate.tenant_id === current.tenant_id && candidate.system_id === current.system_id) {
    return policy.systemScopeScore;
  }
  if (candidate.tenant_id === current.tenant_id) {
    return policy.tenantScopeScore;
  }
  return 0;
}

export function getLineageScore(currentScopeId: string, candidateScopeId: string): number {
  if (currentScopeId === candidateScopeId) return 1;
  const split = (value: string) => value.split(/[/:>|]/g).filter(Boolean);
  const currentParts = split(currentScopeId);
  const candidateParts = split(candidateScopeId);
  let shared = 0;
  while (
    shared < currentParts.length &&
    shared < candidateParts.length &&
    currentParts[shared] === candidateParts[shared]
  ) {
    shared += 1;
  }
  if (shared === 0) return 0;
  return shared / Math.max(currentParts.length, candidateParts.length);
}

/**
 * Blend the retrieval signals into a single ranking score.
 *
 * `lexicalScore` and `semanticScore` are expected in [0,1], higher = better, so
 * the weighted blend is comparable across storage backends (Phase 3.2 P2). The
 * lexical dimension is fed from `SearchResult.rank`, which every adapter now
 * normalizes to (0,1] via the shared rank normalizers / `scoreLexical`; before
 * Phase 3 the SQLite adapter clamped every lexical hit to a constant 1.0, which
 * made this dimension carry no ranking signal. No rescaling is applied here — the
 * (0,1] contract is upheld at the adapter boundary.
 */
export function rankKnowledge(input: {
  knowledge: KnowledgeMemory;
  lexicalScore: number;
  semanticScore: number;
  recencyScore: number;
  importanceScore: number;
  policy: Required<ContextPolicy>;
  scope: MemoryScope;
  relevanceTexts?: string[];
  preferLocalTrusted?: boolean;
  preferLineageMemory?: boolean;
}): {
  finalScore: number;
  trustScore: number;
  classImportanceScore: number;
  evidenceDensityScore: number;
  objectiveLinkScore: number;
  scopeRelationScore: number;
  lineageScore: number;
} {
  const { knowledge, policy } = input;
  const trustScore = knowledge.trust_score ?? 0;
  const classImportanceScore = getClassImportanceScore(knowledge, policy);
  const evidenceDensityScore = getEvidenceDensityScore(knowledge, policy);
  const objectiveLinkScore =
    input.relevanceTexts && input.relevanceTexts.length > 0
      ? overlapScore(knowledge.fact, input.relevanceTexts)
      : 0;
  const scopeRelationScore = getScopeRelationScore(input.scope, knowledge, policy);
  const lineageScore =
    input.preferLineageMemory && knowledge.scope_id !== input.scope.scope_id
      ? getLineageScore(input.scope.scope_id, knowledge.scope_id)
      : 0;
  const localTrustedBonus =
    input.preferLocalTrusted &&
    trustScore >= policy.localTrustedThreshold &&
    knowledge.scope_id === input.scope.scope_id
      ? policy.localTrustedBonus
      : 0;
  const lineageBonus = input.preferLineageMemory ? lineageScore * policy.lineageWeight : 0;
  const unrelatedCrossScopePenalty =
    input.preferLineageMemory && knowledge.scope_id !== input.scope.scope_id
      ? (1 - lineageScore) * policy.unrelatedLineagePenalty
      : 0;
  const provisionalPenalty =
    knowledge.knowledge_state === 'provisional' ? policy.provisionalPenalty : 0;

  const finalScore =
    input.lexicalScore * policy.lexicalWeight +
    input.semanticScore * policy.semanticWeight +
    input.recencyScore * policy.recencyWeight +
    input.importanceScore * policy.importanceWeight +
    trustScore * policy.trustWeight +
    classImportanceScore * policy.durabilityWeight +
    evidenceDensityScore * policy.evidenceWeight +
    objectiveLinkScore * policy.objectiveLinkWeight +
    scopeRelationScore * policy.scopeRelationWeight +
    localTrustedBonus +
    lineageBonus -
    unrelatedCrossScopePenalty -
    knowledge.contradiction_score * policy.contradictionPenalty -
    provisionalPenalty;

  return {
    finalScore,
    trustScore,
    classImportanceScore,
    evidenceDensityScore,
    objectiveLinkScore,
    scopeRelationScore,
    lineageScore,
  };
}

export function matchesKnowledgeSearchOptions(
  knowledge: KnowledgeMemory,
  options?: SearchOptions,
): boolean {
  if (!options) return true;
  if (!options.includeProvisional && knowledge.knowledge_state === 'provisional') {
    return false;
  }
  if (!options.includeDisputed && knowledge.knowledge_state === 'disputed') {
    return false;
  }
  if (options.minimumTrustScore != null && knowledge.trust_score < options.minimumTrustScore) {
    return false;
  }
  if (options.knowledgeStates && options.knowledgeStates.length > 0) {
    if (!options.knowledgeStates.includes(knowledge.knowledge_state)) {
      return false;
    }
  }
  if (options.knowledgeClasses && options.knowledgeClasses.length > 0) {
    if (!options.knowledgeClasses.includes(knowledge.knowledge_class)) {
      return false;
    }
  }
  if (options.tags && options.tags.length > 0) {
    if (!options.tags.some((tag) => knowledge.tags.includes(tag))) {
      return false;
    }
  }
  return true;
}
