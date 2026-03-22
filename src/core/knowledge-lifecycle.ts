import type { MaintenancePolicy } from '../contracts/policy.js';
import { DEFAULT_MAINTENANCE_POLICY } from '../contracts/policy.js';
import type { KnowledgeMemory } from '../contracts/types.js';

export interface LifecycleDecision {
  retire: boolean;
  demote: boolean;
  nextReverificationAt: number | null;
}

function daysToSeconds(days: number): number {
  return Math.max(0, Math.floor(days * 24 * 60 * 60));
}

export function resolveMaintenancePolicy(policy?: MaintenancePolicy): Required<MaintenancePolicy> {
  return {
    ...DEFAULT_MAINTENANCE_POLICY,
    ...policy,
    classRetentionOverrides: {
      ...DEFAULT_MAINTENANCE_POLICY.classRetentionOverrides,
      ...(policy?.classRetentionOverrides ?? {}),
    },
  };
}

export function isTrustedCoreKnowledge(knowledge: KnowledgeMemory): boolean {
  return (
    knowledge.knowledge_state === 'trusted' &&
    ['identity', 'preference', 'constraint'].includes(knowledge.knowledge_class)
  );
}

function outcomeRetentionBonusDays(knowledge: KnowledgeMemory): number {
  if (knowledge.knowledge_class === 'strategy') {
    return Math.min(180, knowledge.successful_use_count * 30);
  }
  if (knowledge.knowledge_class === 'anti_pattern') {
    return Math.min(365, knowledge.failed_use_count * 45);
  }
  if (knowledge.knowledge_class === 'procedure') {
    return Math.min(90, knowledge.successful_use_count * 15);
  }
  return 0;
}

export function getKnowledgeRetentionDays(
  knowledge: KnowledgeMemory,
  policy: Required<MaintenancePolicy>,
): number {
  if (knowledge.knowledge_state === 'provisional') {
    return policy.provisionalRetentionDays;
  }
  if (knowledge.knowledge_state === 'disputed') {
    return policy.disputedRetentionDays;
  }
  if (isTrustedCoreKnowledge(knowledge)) {
    return Math.max(
      policy.trustedCoreRetentionDays,
      policy.classRetentionOverrides[knowledge.knowledge_class] ?? policy.trustedCoreRetentionDays,
    );
  }
  return (
    (policy.classRetentionOverrides[knowledge.knowledge_class] ?? policy.knowledgeStaleAfterSeconds / 86400) +
    outcomeRetentionBonusDays(knowledge)
  );
}

export function getLifecycleReferenceTime(knowledge: KnowledgeMemory): number {
  return Math.max(
    knowledge.last_confirmed_at ?? 0,
    knowledge.last_verified_at ?? 0,
    knowledge.last_accessed_at ?? 0,
    knowledge.created_at,
  );
}

export function computeNextReverificationAt(
  knowledge: KnowledgeMemory,
  policy: Required<MaintenancePolicy>,
): number | null {
  if (knowledge.knowledge_state === 'retired' || knowledge.knowledge_state === 'superseded') {
    return null;
  }
  const cadence = isTrustedCoreKnowledge(knowledge)
    ? daysToSeconds(policy.trustedCoreRetentionDays)
    : daysToSeconds(policy.reverificationCadenceDays);
  const anchor =
    knowledge.last_confirmed_at ??
    knowledge.last_verified_at ??
    knowledge.created_at;
  return anchor + cadence;
}

export function evaluateKnowledgeLifecycle(
  knowledge: KnowledgeMemory,
  policy: Required<MaintenancePolicy>,
  now: number,
): LifecycleDecision {
  const retentionSeconds = daysToSeconds(getKnowledgeRetentionDays(knowledge, policy));
  const ageSeconds = Math.max(0, now - getLifecycleReferenceTime(knowledge));
  const dueAt = computeNextReverificationAt(knowledge, policy);

  if (knowledge.knowledge_state === 'provisional') {
    return {
      retire: ageSeconds > retentionSeconds && knowledge.access_count <= policy.minKnowledgeAccessCount,
      demote: false,
      nextReverificationAt: dueAt,
    };
  }

  if (knowledge.knowledge_state === 'disputed') {
    return {
      retire: ageSeconds > retentionSeconds && knowledge.access_count <= policy.minKnowledgeAccessCount,
      demote: false,
      nextReverificationAt: dueAt,
    };
  }

  const staleAndWeak = ageSeconds > retentionSeconds && knowledge.access_count <= policy.minKnowledgeAccessCount;
  const shouldDemoteProjectFact =
    knowledge.knowledge_state === 'trusted' &&
    knowledge.knowledge_class === 'project_fact' &&
    policy.requireReconfirmationForProjectFacts &&
    dueAt !== null &&
    dueAt <= now &&
    knowledge.confirmation_count === 0;

  return {
    retire:
      !isTrustedCoreKnowledge(knowledge) &&
      !shouldDemoteProjectFact &&
      staleAndWeak &&
      ['project_fact', 'episodic_fact', 'procedure'].includes(knowledge.knowledge_class),
    demote: shouldDemoteProjectFact,
    nextReverificationAt: dueAt,
  };
}

export function getDueReverificationKnowledge(
  knowledge: KnowledgeMemory[],
  policy: Required<MaintenancePolicy>,
  now: number,
): KnowledgeMemory[] {
  return knowledge
    .filter((item) => {
      const dueAt = item.next_reverification_at ?? computeNextReverificationAt(item, policy);
      return dueAt !== null && dueAt <= now && item.retired_at === null && item.superseded_by_id === null;
    })
    .sort(
      (a, b) =>
        (a.next_reverification_at ?? computeNextReverificationAt(a, policy) ?? Number.MAX_SAFE_INTEGER) -
          (b.next_reverification_at ?? computeNextReverificationAt(b, policy) ?? Number.MAX_SAFE_INTEGER) ||
        a.created_at - b.created_at,
    );
}
