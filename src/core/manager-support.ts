import { normalizeScope, type MemoryScope, type ScopeLevel } from '../contracts/identity.js';
import {
  NotImplementedError,
  ResourceNotFoundError,
  ScopeMismatchError,
  ValidationError,
} from '../contracts/errors.js';
import type { ContextViewPolicy } from '../contracts/coordination.js';
import type {
  ContextContract,
  ContextEscalationPolicy,
  ContextGovernanceSnapshot,
  ContextInvariant,
} from '../contracts/context-contract.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type {
  AssociationTargetKind,
  FactType,
  KnowledgeMemory,
  Turn,
} from '../contracts/types.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { getNativeSyncAdapter } from '../contracts/native-sync.js';
import type { MemoryManagerConfig } from './manager-config.js';

/**
 * Pure, stateless helpers shared between the MemoryManager factory
 * (`src/core/manager.ts`) and the capability namespace modules
 * (`src/core/capabilities/**`). Extracted into a neutral leaf module so the
 * capabilities can import them without reaching back into the manager's
 * closure or creating an import cycle (Phase 6.2).
 */

export function resolveAdapter(config: MemoryManagerConfig): AsyncStorageAdapter {
  if (config.asyncAdapter) {
    return config.asyncAdapter;
  }
  if (config.adapter) {
    return wrapSyncAdapter(config.adapter);
  }
  throw new ValidationError("MemoryManagerConfig requires either 'adapter' or 'asyncAdapter'");
}

export function resolveSyncAdapter(
  config: MemoryManagerConfig,
  asyncAdapter: AsyncStorageAdapter,
  operation: string,
): StorageAdapter {
  const syncAdapter = config.adapter ?? getNativeSyncAdapter(asyncAdapter);
  if (!syncAdapter) {
    throw new NotImplementedError(
      `${operation} is not available on this deployment (requires sync adapter access)`,
    );
  }
  return syncAdapter;
}

export function manualKnowledgeClassForFactType(
  factType: FactType,
): KnowledgeMemory['knowledge_class'] {
  switch (factType) {
    case 'preference':
      return 'preference';
    case 'constraint':
      return 'constraint';
    case 'decision':
      return 'procedure';
    case 'entity':
      return 'identity';
    default:
      return 'project_fact';
  }
}

export function mergeContextContract(
  base: ContextContract | undefined,
  override: ContextContract | undefined,
): ContextContract | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
    knowledgeClasses: override?.knowledgeClasses ?? base?.knowledgeClasses,
  };
}

export function mergeContextInvariants(
  base: ContextInvariant[] | undefined,
  override: ContextInvariant[] | undefined,
): ContextInvariant[] {
  const merged = [...(base ?? []), ...(override ?? [])];
  if (merged.length === 0) return [];
  const deduped = new Map<string, ContextInvariant>();
  for (const invariant of merged) {
    deduped.set(invariant.id, invariant);
  }
  return [...deduped.values()];
}

export function normalizeContextEscalationPolicy(
  policy: ContextEscalationPolicy | undefined,
): ContextGovernanceSnapshot['escalationPolicy'] {
  return {
    defaultDecision: policy?.defaultDecision ?? 'review',
    byChange: { ...(policy?.byChange ?? {}) },
    maxView: policy?.maxView,
    maxScopeLevel: policy?.maxScopeLevel,
    maxTokenBudget: policy?.maxTokenBudget,
    minimumAllowedTrustScore: policy?.minimumAllowedTrustScore,
  };
}

export function cloneContextContract(
  contract: ContextContract | null | undefined,
): ContextContract | null {
  if (!contract) return null;
  return {
    ...contract,
    knowledgeClasses: contract.knowledgeClasses ? [...contract.knowledgeClasses] : undefined,
  };
}

export function cloneContextInvariant(invariant: ContextInvariant): ContextInvariant {
  return { ...invariant };
}

export function cloneContextEscalationPolicy(
  policy: ContextGovernanceSnapshot['escalationPolicy'],
): ContextGovernanceSnapshot['escalationPolicy'] {
  return {
    ...policy,
    byChange: { ...(policy.byChange ?? {}) },
  };
}

export function viewRank(view: ContextViewPolicy | undefined): number {
  switch (view) {
    case 'operator_supervisor':
      return 4;
    case 'workspace_shared':
      return 3;
    case 'local_plus_shared_collaboration':
      return 2;
    case 'local_only':
    default:
      return 1;
  }
}

export function scopeLevelRank(level: ScopeLevel | undefined): number {
  switch (level) {
    case 'tenant':
      return 4;
    case 'system':
      return 3;
    case 'workspace':
      return 2;
    case 'scope':
    default:
      return 1;
  }
}

/**
 * Resolve an association endpoint (source or target) and verify it exists
 * and belongs to the caller's normalized scope. Throws a descriptive error
 * if the node is missing or cross-scope. This is the sole authority on
 * association ID validity; HTTP/MCP layers should NOT rely on their own
 * type checks for scope safety.
 */
export async function assertAssociationEndpointInScope(
  adapter: AsyncStorageAdapter,
  norm: ReturnType<typeof normalizeScope>,
  kind: AssociationTargetKind,
  id: number,
  role: 'source' | 'target',
): Promise<void> {
  const scopedMatch = (record: {
    tenant_id: string;
    system_id: string;
    workspace_id: string;
    collaboration_id: string;
    scope_id: string;
  }) =>
    record.tenant_id === norm.tenant_id &&
    record.system_id === norm.system_id &&
    record.workspace_id === norm.workspace_id &&
    record.collaboration_id === norm.collaboration_id &&
    record.scope_id === norm.scope_id;

  if (kind === 'knowledge') {
    const km = await adapter.getKnowledgeMemoryById(id);
    if (!km) {
      throw new ResourceNotFoundError(`addAssociation: ${role} knowledge ${id} does not exist`);
    }
    if (!scopedMatch(km)) {
      throw new ScopeMismatchError(
        `addAssociation: ${role} knowledge ${id} is not in the current scope`,
      );
    }
    return;
  }
  if (kind === 'playbook') {
    const pb = await adapter.getPlaybookById(id);
    if (!pb) {
      throw new ResourceNotFoundError(`addAssociation: ${role} playbook ${id} does not exist`);
    }
    if (!scopedMatch(pb)) {
      throw new ScopeMismatchError(
        `addAssociation: ${role} playbook ${id} is not in the current scope`,
      );
    }
    return;
  }
  if (kind === 'working_memory') {
    const wm = await adapter.getWorkingMemoryById(id);
    if (!wm) {
      throw new ResourceNotFoundError(
        `addAssociation: ${role} working_memory ${id} does not exist`,
      );
    }
    if (!scopedMatch(wm)) {
      throw new ScopeMismatchError(
        `addAssociation: ${role} working_memory ${id} is not in the current scope`,
      );
    }
    return;
  }
  if (kind === 'work_item') {
    const match = await adapter.getWorkItemById(id);
    if (!match) {
      throw new ResourceNotFoundError(
        `addAssociation: ${role} work_item ${id} does not exist in the current scope`,
      );
    }
    if (
      match.tenant_id !== norm.tenant_id ||
      match.system_id !== norm.system_id ||
      match.workspace_id !== norm.workspace_id ||
      match.collaboration_id !== norm.collaboration_id ||
      match.scope_id !== norm.scope_id
    ) {
      throw new ScopeMismatchError(
        `addAssociation: ${role} work_item ${id} does not exist in the current scope`,
      );
    }
    return;
  }
  // Exhaustiveness: AssociationTargetKind has no other members.
  throw new ValidationError(`addAssociation: unknown ${role} kind '${kind as string}'`);
}

/**
 * Merge archived and active turns by id, preserving order by turn id.
 * Partially compacted sessions have both sets; summarizing from only one
 * drops context, so callers should always pass the union through this.
 */
export function mergeTurnsById(archived: Turn[], active: Turn[]): Turn[] {
  const byId = new Map<number, Turn>();
  for (const t of archived) byId.set(t.id, t);
  for (const t of active) byId.set(t.id, t);
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

export function knowledgeMatchesScope(knowledge: KnowledgeMemory, scope: MemoryScope): boolean {
  const normalized = normalizeScope(scope);
  return (
    knowledge.tenant_id === normalized.tenant_id &&
    knowledge.system_id === normalized.system_id &&
    knowledge.workspace_id === normalized.workspace_id &&
    knowledge.collaboration_id === normalized.collaboration_id &&
    knowledge.scope_id === normalized.scope_id
  );
}

export function entityMatchesScope(
  entity: {
    tenant_id: string;
    system_id: string;
    workspace_id: string;
    collaboration_id: string;
    scope_id: string;
  },
  scope: MemoryScope,
): boolean {
  const normalized = normalizeScope(scope);
  return (
    entity.tenant_id === normalized.tenant_id &&
    entity.system_id === normalized.system_id &&
    entity.workspace_id === normalized.workspace_id &&
    entity.collaboration_id === normalized.collaboration_id &&
    entity.scope_id === normalized.scope_id
  );
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
