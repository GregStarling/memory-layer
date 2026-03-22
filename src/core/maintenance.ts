import type { MemoryScope } from '../contracts/identity.js';
import type { MaintenancePolicy } from '../contracts/policy.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { nowSeconds } from './validation.js';
import {
  evaluateKnowledgeLifecycle,
  getDueReverificationKnowledge,
  isTrustedCoreKnowledge,
  resolveMaintenancePolicy,
} from './knowledge-lifecycle.js';

export interface MaintenanceReport {
  expiredWorkingMemoryIds: number[];
  retiredKnowledgeIds: number[];
  deletedWorkItemIds: number[];
  reverifiedKnowledgeIds: number[];
  demotedKnowledgeIds: number[];
  expiredCandidateIds: number[];
}

export async function runMaintenance(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  policy: MaintenancePolicy = {},
): Promise<MaintenanceReport> {
  const resolved = resolveMaintenancePolicy(policy);
  const now = nowSeconds();
  const expiredWorkingMemoryIds: number[] = [];
  const retiredKnowledgeIds: number[] = [];
  const deletedWorkItemIds: number[] = [];
  const reverifiedKnowledgeIds: number[] = [];
  const demotedKnowledgeIds: number[] = [];
  const expiredCandidateIds: number[] = [];

  const staleWorkingMemory = await adapter.getWorkingMemoryByTimeRange(scope, {
    end_at: now - resolved.workingMemoryTtlSeconds,
  });
  for (const item of staleWorkingMemory) {
    if (item.expires_at === null || item.expires_at > now) {
      await adapter.expireWorkingMemory(item.id);
      expiredWorkingMemoryIds.push(item.id);
    }
  }

  const activeKnowledge = await adapter.getActiveKnowledgeMemory(scope);
  const dueReverification = getDueReverificationKnowledge(activeKnowledge, resolved, now);
  for (const item of dueReverification) {
    await adapter.updateKnowledgeMemory(item.id, {
      next_reverification_at: item.next_reverification_at ?? now,
    });
  }

  for (const item of activeKnowledge) {
    const decision = evaluateKnowledgeLifecycle(item, resolved, now);
    if (decision.demote) {
      await adapter.updateKnowledgeMemory(item.id, {
        knowledge_state: 'provisional',
        verification_status: 'unverified',
        verification_notes: 'maintenance_demoted_pending_reconfirmation',
        trust_score: Math.min(item.trust_score, 0.55),
        next_reverification_at: decision.nextReverificationAt,
      });
      demotedKnowledgeIds.push(item.id);
      continue;
    }
    if (decision.retire) {
      await adapter.retireKnowledgeMemory(item.id, now);
      retiredKnowledgeIds.push(item.id);
      continue;
    }
    if (decision.nextReverificationAt !== item.next_reverification_at) {
      await adapter.updateKnowledgeMemory(item.id, {
        next_reverification_at: decision.nextReverificationAt,
      });
    }
  }

  if (activeKnowledge.length > resolved.maxActiveKnowledgeItems) {
    const overflow = [...activeKnowledge]
      .filter((item) => !isTrustedCoreKnowledge(item))
      .sort((a, b) => a.access_count - b.access_count || a.last_accessed_at - b.last_accessed_at)
      .slice(0, activeKnowledge.length - resolved.maxActiveKnowledgeItems);
    for (const item of overflow) {
      if (item.retired_at === null) {
        await adapter.retireKnowledgeMemory(item.id, now);
        retiredKnowledgeIds.push(item.id);
      }
    }
  }

  if (resolved.consolidateKnowledge) {
    const bySlot = new Map<string, typeof activeKnowledge>();
    for (const item of activeKnowledge) {
      if (!item.slot_key) continue;
      bySlot.set(item.slot_key, [...(bySlot.get(item.slot_key) ?? []), item]);
    }
    for (const group of bySlot.values()) {
      if (group.length < 2) continue;
      const [winner, ...duplicates] = [...group].sort(
        (a, b) =>
          b.confidence_score - a.confidence_score ||
          b.access_count - a.access_count ||
          b.last_accessed_at - a.last_accessed_at,
      );
      void winner;
      for (const duplicate of duplicates) {
        if (duplicate.retired_at === null) {
          await adapter.retireKnowledgeMemory(duplicate.id, now);
          retiredKnowledgeIds.push(duplicate.id);
        }
      }
    }
  }

  const completedWorkItems = (
    await adapter.getWorkItemsByTimeRange(scope, {
      end_at: now - resolved.completedWorkItemTtlSeconds,
    })
  ).filter((item) => item.status === 'done');
  for (const item of completedWorkItems) {
    await adapter.deleteWorkItem(item.id);
    deletedWorkItemIds.push(item.id);
  }

  return {
    expiredWorkingMemoryIds,
    retiredKnowledgeIds,
    deletedWorkItemIds,
    reverifiedKnowledgeIds,
    demotedKnowledgeIds,
    expiredCandidateIds,
  };
}
