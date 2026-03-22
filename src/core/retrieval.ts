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

export function getClassImportanceScore(knowledge: KnowledgeMemory): number {
  switch (knowledge.knowledge_class) {
    case 'identity':
      return 1;
    case 'constraint':
      return 0.95;
    case 'preference':
      return 0.85;
    case 'strategy':
      return 0.8;
    case 'procedure':
      return 0.75;
    case 'project_fact':
      return 0.6;
    case 'episodic_fact':
      return 0.4;
    case 'anti_pattern':
      return 0.45;
    default:
      return 0.5;
  }
}

export function getEvidenceDensityScore(knowledge: KnowledgeMemory): number {
  return Math.min(1, knowledge.evidence_count / 3);
}

export function getScopeRelationScore(current: MemoryScope, candidate: KnowledgeMemory): number {
  if (
    candidate.tenant_id === current.tenant_id &&
    candidate.system_id === current.system_id &&
    candidate.workspace_id === (current.workspace_id ?? 'default') &&
    candidate.scope_id === current.scope_id
  ) {
    return 1;
  }
  if (
    candidate.tenant_id === current.tenant_id &&
    candidate.system_id === current.system_id &&
    candidate.workspace_id === (current.workspace_id ?? 'default')
  ) {
    return 0.5;
  }
  if (candidate.tenant_id === current.tenant_id && candidate.system_id === current.system_id) {
    return 0.2;
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
  const classImportanceScore = getClassImportanceScore(knowledge);
  const evidenceDensityScore = getEvidenceDensityScore(knowledge);
  const objectiveLinkScore =
    input.relevanceTexts && input.relevanceTexts.length > 0
      ? overlapScore(knowledge.fact, input.relevanceTexts)
      : 0;
  const scopeRelationScore = getScopeRelationScore(input.scope, knowledge);
  const lineageScore =
    input.preferLineageMemory && knowledge.scope_id !== input.scope.scope_id
      ? getLineageScore(input.scope.scope_id, knowledge.scope_id)
      : 0;
  const localTrustedBonus =
    input.preferLocalTrusted &&
    trustScore >= 0.7 &&
    knowledge.scope_id === input.scope.scope_id
      ? 0.35
      : 0;
  const lineageBonus = input.preferLineageMemory ? lineageScore * 0.3 : 0;
  const unrelatedCrossScopePenalty =
    input.preferLineageMemory && knowledge.scope_id !== input.scope.scope_id
      ? (1 - lineageScore) * 0.35
      : 0;
  const provisionalPenalty =
    knowledge.knowledge_state === 'provisional' ? policy.provisionalPenalty : 0;

  const finalScore =
    input.lexicalScore * policy.lexicalWeight +
    input.semanticScore * policy.semanticWeight +
    input.recencyScore * policy.recencyWeight +
    trustScore * policy.trustWeight +
    classImportanceScore * policy.durabilityWeight +
    evidenceDensityScore * policy.evidenceWeight +
    objectiveLinkScore * policy.objectiveLinkWeight +
    scopeRelationScore * 0.25 +
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
  return true;
}
