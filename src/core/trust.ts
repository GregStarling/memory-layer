import type { ExtractionPolicy } from '../contracts/policy.js';
import type {
  KnowledgeCandidate,
  KnowledgeConflict,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeTrustAssessment,
} from '../contracts/types.js';

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function contradictionPenalty(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.75) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

export function computeContradictionScore(evidence: KnowledgeEvidence[]): number {
  const supporting = evidence.filter((item) => item.support_polarity === 'supports');
  const contradicting = evidence.filter((item) => item.support_polarity === 'contradicts');
  if (supporting.length === 0 && contradicting.length === 0) return 0;
  const supportWeight = supporting.reduce((sum, item) => sum + item.explicitness_score, 0);
  const contradictionWeight = contradicting.reduce((sum, item) => sum + item.explicitness_score, 0);
  const total = supportWeight + contradictionWeight;
  return total <= 0 ? 0 : contradictionWeight / total;
}

export function assessCandidateTrust(input: {
  candidate: KnowledgeCandidate;
  evidence: KnowledgeEvidence[];
  policy: Required<ExtractionPolicy>;
  existingKnowledge?: KnowledgeMemory | null;
  relation?: KnowledgeConflict['relation'] | 'created';
}): KnowledgeTrustAssessment {
  const { candidate, evidence, policy } = input;
  const relation = input.relation ?? 'created';
  const supporting = evidence.filter((item) => item.support_polarity === 'supports');
  const contradicting = evidence.filter((item) => item.support_polarity === 'contradicts');
  const assistantSupport = supporting.filter((item) => item.source_type === 'assistant_turn').length;
  const toolSupport = supporting.filter((item) =>
    ['tool_output', 'execution_result', 'human_feedback'].includes(item.source_type),
  ).length;
  const explicitSupport = supporting.filter((item) => item.is_explicit).length;
  const protectedSingleSourceSupport = supporting.some((item) =>
    ['user_turn', 'system_turn', 'human_feedback', 'tool_output'].includes(item.source_type),
  );
  const successSupport = supporting.filter((item) => item.outcome === 'success').length;
  const failureSupport = supporting.filter((item) => item.outcome === 'failure').length;
  const contradictionScore = computeContradictionScore(evidence);
  const reasons: string[] = [];

  let trustScore = candidate.trust_score;
  if (policy.requireGroundingForTrusted && supporting.length === 0) {
    trustScore -= 0.35;
    reasons.push('no_raw_turn_grounding');
  }
  if (assistantSupport > 0) {
    trustScore -= policy.assistantClaimPenalty * assistantSupport;
    reasons.push('assistant_claim_penalty');
  }
  if (toolSupport > 0) {
    trustScore += policy.toolEvidenceBoost * toolSupport;
    reasons.push('tool_or_feedback_evidence');
  }
  if (explicitSupport > 0) {
    trustScore += policy.explicitStatementBoost * explicitSupport;
    reasons.push('explicit_support');
  }
  if (successSupport > 0) {
    trustScore += policy.executionSuccessBoost * successSupport;
    reasons.push('successful_outcome_support');
  }
  if (failureSupport > 0) {
    trustScore -= policy.executionFailurePenalty * failureSupport;
    reasons.push('failure_outcome_penalty');
  }
  trustScore -= contradictionScore * 0.5;
  if (contradictionScore > 0) {
    reasons.push('contradictory_evidence_present');
  }

  trustScore = clamp(trustScore);

  if (contradictionScore >= policy.contradictionDisputeThreshold) {
    return {
      trust_score: trustScore,
      state: 'disputed',
      decision: input.existingKnowledge ? 'mark_disputed' : 'reject_candidate',
      reasons,
    };
  }

  if (
    (supporting.length >= policy.minimumEvidenceCountForTrusted ||
      ((candidate.knowledge_class === 'constraint' || candidate.knowledge_class === 'identity') &&
        protectedSingleSourceSupport &&
        explicitSupport > 0 &&
        contradicting.length === 0 &&
        relation !== 'conflict' &&
        relation !== 'update')) &&
    trustScore >= policy.trustPromotionThreshold
  ) {
    return {
      trust_score: trustScore,
      state: 'trusted',
      decision:
        input.relation === 'update' || input.relation === 'conflict'
          ? 'supersede_existing'
          : 'promote_candidate',
      reasons,
    };
  }

  if (trustScore >= policy.trustProvisionalThreshold && supporting.length > 0) {
    return {
      trust_score: trustScore,
      state: 'provisional',
      decision: 'keep_provisional',
      reasons,
    };
  }

  return {
    trust_score: trustScore,
    state: 'candidate',
    decision: 'reject_candidate',
    reasons,
  };
}

export function assessKnowledgeReverification(input: {
  knowledge: KnowledgeMemory;
  evidence: KnowledgeEvidence[];
  policy: Required<ExtractionPolicy>;
}): KnowledgeTrustAssessment {
  const contradictionScore = computeContradictionScore(input.evidence);
  const explicitness = average(input.evidence.map((item) => item.explicitness_score));
  const baseCandidate: KnowledgeCandidate = {
    id: input.knowledge.id,
    tenant_id: input.knowledge.tenant_id,
    system_id: input.knowledge.system_id,
    workspace_id: input.knowledge.workspace_id,
    scope_id: input.knowledge.scope_id,
    working_memory_id: input.knowledge.source_working_memory_id ?? 0,
    fact: input.knowledge.fact,
    fact_type: input.knowledge.fact_type,
    knowledge_class: input.knowledge.knowledge_class,
    normalized_fact: input.knowledge.normalized_fact ?? input.knowledge.fact.toLowerCase(),
    slot_key: input.knowledge.slot_key,
    confidence: input.knowledge.confidence,
    source_summary: true,
    source_turns: input.evidence.some((item) => item.support_polarity === 'supports'),
    grounding_strength: input.knowledge.grounding_strength,
    evidence_count: input.evidence.filter((item) => item.support_polarity === 'supports').length,
    trust_score: clamp(input.knowledge.trust_score + explicitness * 0.1 - contradictionScore * 0.25),
    state: input.knowledge.knowledge_state === 'provisional' ? 'provisional' : 'candidate',
    created_at: input.knowledge.created_at,
    promoted_knowledge_id: input.knowledge.id,
  };
  return assessCandidateTrust({
    candidate: baseCandidate,
    evidence: input.evidence,
    policy: input.policy,
    existingKnowledge: input.knowledge,
    relation: 'created',
  });
}

export function buildKnowledgeConflict(input: {
  existing: KnowledgeMemory;
  candidateId: number | null;
  relation: KnowledgeConflict['relation'];
  contradictionScore: number;
  policy: Required<ExtractionPolicy>;
}): KnowledgeConflict {
  const severity = contradictionPenalty(input.contradictionScore);
  return {
    existing_knowledge_id: input.existing.id,
    candidate_id: input.candidateId,
    relation: input.relation,
    severity,
    resolution:
      input.relation === 'update'
        ? 'supersede'
        : input.contradictionScore >= input.policy.contradictionDisputeThreshold
          ? 'dispute'
          : 'ignore',
  };
}
