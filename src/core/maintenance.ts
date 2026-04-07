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
  deletedAssociationIds: number[];
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
  const deletedAssociationIds: number[] = [];
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

  const candidateMaxAgeDays = 30;
  const candidateOlderThan = now - candidateMaxAgeDays * 24 * 60 * 60;
  const deletedCandidateIds = await adapter.deleteExpiredKnowledgeCandidates(scope, candidateOlderThan);
  expiredCandidateIds.push(...deletedCandidateIds);

  const associations = await adapter.listAssociations(scope);
  const existenceCache = new Map<string, boolean>();

  async function primeExistenceCache(
    kind: 'knowledge' | 'work_item' | 'playbook' | 'working_memory',
    ids: number[],
  ): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return;
    }

    const existingIds =
      kind === 'knowledge'
        ? await adapter.getExistingKnowledgeMemoryIds?.(uniqueIds)
        : kind === 'work_item'
          ? await adapter.getExistingWorkItemIds?.(uniqueIds)
          : kind === 'playbook'
            ? await adapter.getExistingPlaybookIds?.(uniqueIds)
            : await adapter.getExistingWorkingMemoryIds?.(uniqueIds);
    if (!existingIds) {
      return;
    }

    const existingSet = new Set(existingIds);
    for (const id of uniqueIds) {
      existenceCache.set(`${kind}:${id}`, existingSet.has(id));
    }
  }

  async function entityExists(
    kind: 'knowledge' | 'work_item' | 'playbook' | 'working_memory',
    id: number,
  ): Promise<boolean> {
    const cacheKey = `${kind}:${id}`;
    if (existenceCache.has(cacheKey)) {
      return existenceCache.get(cacheKey)!;
    }
    const exists =
      kind === 'knowledge'
        ? (await adapter.getKnowledgeMemoryById(id)) != null
        : kind === 'work_item'
          ? (await adapter.getWorkItemById(id)) != null
          : kind === 'playbook'
            ? (await adapter.getPlaybookById(id)) != null
            : (await adapter.getWorkingMemoryById(id)) != null;
    existenceCache.set(cacheKey, exists);
    return exists;
  }

  const idsByKind = {
    knowledge: new Set<number>(),
    work_item: new Set<number>(),
    playbook: new Set<number>(),
    working_memory: new Set<number>(),
  };
  for (const association of associations) {
    idsByKind[association.source_kind].add(association.source_id);
    idsByKind[association.target_kind].add(association.target_id);
  }
  await Promise.all([
    primeExistenceCache('knowledge', [...idsByKind.knowledge]),
    primeExistenceCache('work_item', [...idsByKind.work_item]),
    primeExistenceCache('playbook', [...idsByKind.playbook]),
    primeExistenceCache('working_memory', [...idsByKind.working_memory]),
  ]);

  for (const association of associations) {
    const sourceExists =
      association.source_kind === 'knowledge'
        ? await entityExists('knowledge', association.source_id)
        : association.source_kind === 'work_item'
          ? await entityExists('work_item', association.source_id)
          : association.source_kind === 'playbook'
            ? await entityExists('playbook', association.source_id)
            : await entityExists('working_memory', association.source_id);
    const targetExists =
      association.target_kind === 'knowledge'
        ? await entityExists('knowledge', association.target_id)
        : association.target_kind === 'work_item'
          ? await entityExists('work_item', association.target_id)
          : association.target_kind === 'playbook'
            ? await entityExists('playbook', association.target_id)
            : await entityExists('working_memory', association.target_id);
    if (!sourceExists || !targetExists) {
      await adapter.deleteAssociation(association.id);
      deletedAssociationIds.push(association.id);
    }
  }

  return {
    expiredWorkingMemoryIds,
    retiredKnowledgeIds,
    deletedWorkItemIds,
    deletedAssociationIds,
    reverifiedKnowledgeIds,
    demotedKnowledgeIds,
    expiredCandidateIds,
  };
}
