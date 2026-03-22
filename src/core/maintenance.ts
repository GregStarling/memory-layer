import type { MemoryScope } from '../contracts/identity.js';
import type { MaintenancePolicy } from '../contracts/policy.js';
import { DEFAULT_MAINTENANCE_POLICY } from '../contracts/policy.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { nowSeconds } from './validation.js';

export interface MaintenanceReport {
  expiredWorkingMemoryIds: number[];
  retiredKnowledgeIds: number[];
  deletedWorkItemIds: number[];
}

export async function runMaintenance(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  policy: MaintenancePolicy = {},
): Promise<MaintenanceReport> {
  const resolved = {
    ...DEFAULT_MAINTENANCE_POLICY,
    ...policy,
  };
  const now = nowSeconds();
  const expiredWorkingMemoryIds: number[] = [];
  const retiredKnowledgeIds: number[] = [];
  const deletedWorkItemIds: number[] = [];

  const staleWorkingMemory = await adapter.getWorkingMemoryByTimeRange(scope, {
    end_at: now - resolved.workingMemoryTtlSeconds,
  });
  for (const item of staleWorkingMemory) {
    if (item.expires_at === null || item.expires_at > now) {
      await adapter.expireWorkingMemory(item.id);
      expiredWorkingMemoryIds.push(item.id);
    }
  }

  const staleKnowledge = await adapter.getKnowledgeByTimeRange(scope, {
    end_at: now - resolved.knowledgeStaleAfterSeconds,
  });
  for (const item of staleKnowledge) {
    if (
      item.retired_at === null &&
      (item.superseded_by_id !== null || item.access_count <= resolved.minKnowledgeAccessCount)
    ) {
      await adapter.retireKnowledgeMemory(item.id, now);
      retiredKnowledgeIds.push(item.id);
    }
  }

  const activeKnowledge = await adapter.getActiveKnowledgeMemory(scope);
  if (activeKnowledge.length > resolved.maxActiveKnowledgeItems) {
    const overflow = [...activeKnowledge]
      .sort((a, b) => a.access_count - b.access_count || a.last_accessed_at - b.last_accessed_at)
      .slice(0, activeKnowledge.length - resolved.maxActiveKnowledgeItems);
    for (const item of overflow) {
      if (item.retired_at === null) {
        await adapter.retireKnowledgeMemory(item.id, now);
        retiredKnowledgeIds.push(item.id);
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
  };
}
