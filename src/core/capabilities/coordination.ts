import { normalizeScope } from '../../contracts/identity.js';
import { ScopeMismatchError } from '../../contracts/errors.js';
import type { ActorRef, HandoffRecord, WorkClaim, WorkItemPatch } from '../../contracts/coordination.js';
import type { WorkItem } from '../../contracts/types.js';
import { entityMatchesScope } from '../manager-support.js';
import type { CapabilityContext } from './context.js';

/**
 * Coordination namespace (Phase 6.2): multi-agent work items, leases/claims,
 * and handoffs. Every method scopes its target to the manager's scope before
 * delegating to the storage adapter.
 */
export interface CoordinationCapability {
  trackWorkItem(
    title: string,
    kind?: WorkItem['kind'],
    status?: WorkItem['status'],
    detail?: string,
    options?: { visibilityClass?: WorkItem['visibility_class'] },
  ): Promise<WorkItem>;
  updateWorkItem(
    id: number,
    patch: WorkItemPatch,
    options?: { expectedVersion?: number },
  ): Promise<WorkItem | null>;
  claimWorkItem(input: {
    workItemId: number;
    actor: ActorRef;
    leaseSeconds?: number;
  }): Promise<WorkClaim>;
  renewWorkClaim(
    claimId: number,
    actor: ActorRef,
    leaseSeconds?: number,
  ): Promise<WorkClaim | null>;
  releaseWorkClaim(claimId: number, actor: ActorRef, reason?: string): Promise<WorkClaim | null>;
  listWorkClaims(options?: {
    actor?: Pick<ActorRef, 'actor_kind' | 'actor_id'>;
    sessionId?: string;
  }): Promise<WorkClaim[]>;
  handoffWorkItem(input: {
    workItemId: number;
    fromActor: ActorRef;
    toActor: ActorRef;
    summary: string;
    contextBundleRef?: string | null;
    expiresAt?: number | null;
  }): Promise<HandoffRecord>;
  acceptHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  rejectHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  cancelHandoff(handoffId: number, actor: ActorRef, reason?: string): Promise<HandoffRecord | null>;
  listPendingHandoffs(options?: {
    actor?: Pick<ActorRef, 'actor_kind' | 'actor_id'>;
    direction?: 'inbound' | 'outbound' | 'all';
  }): Promise<HandoffRecord[]>;
}

export type CoordinationContext = Pick<
  CapabilityContext,
  'asyncAdapter' | 'config' | 'refreshSessionStateProjection'
>;

export function createCoordinationCapability(ctx: CoordinationContext): CoordinationCapability {
  const { asyncAdapter, config, refreshSessionStateProjection } = ctx;

  return {
    async trackWorkItem(title, kind = 'objective', status = 'open', detail, options) {
      const workItem = await asyncAdapter.insertWorkItem({
        ...config.scope,
        session_id: config.sessionId,
        visibility_class: options?.visibilityClass ?? 'private',
        title: config.redactText ? config.redactText({ kind: 'work_item', text: title }) : title,
        kind,
        status,
        detail:
          detail && config.redactText
            ? config.redactText({ kind: 'work_item', text: detail })
            : detail,
      });
      await refreshSessionStateProjection();
      return workItem;
    },

    async updateWorkItem(id, patch, options) {
      const existing = await asyncAdapter.getWorkItemById(id);
      if (!existing) {
        return null;
      }
      if (!entityMatchesScope(existing, config.scope)) {
        throw new ScopeMismatchError(`Work item ${id} does not belong to the current scope`);
      }
      const workItem = await asyncAdapter.updateWorkItem(id, patch, options);
      await refreshSessionStateProjection();
      return workItem;
    },

    async claimWorkItem(input) {
      const workItem = await asyncAdapter.getWorkItemById(input.workItemId);
      if (workItem && !entityMatchesScope(workItem, config.scope)) {
        throw new ScopeMismatchError(`Work item ${input.workItemId} does not belong to the current scope`);
      }
      return asyncAdapter.claimWorkItem({
        ...normalizeScope(config.scope),
        work_item_id: input.workItemId,
        actor: input.actor,
        session_id: config.sessionId,
        lease_seconds: input.leaseSeconds,
        visibility_class: workItem?.visibility_class ?? 'private',
      });
    },

    async renewWorkClaim(claimId, actor, leaseSeconds) {
      const claim = await asyncAdapter.getWorkClaimById(claimId);
      if (claim && !entityMatchesScope(claim, config.scope)) {
        throw new ScopeMismatchError(`Work claim ${claimId} does not belong to the current scope`);
      }
      return asyncAdapter.renewWorkClaim(claimId, actor, leaseSeconds);
    },

    async releaseWorkClaim(claimId, actor, reason) {
      const claim = await asyncAdapter.getWorkClaimById(claimId);
      if (claim && !entityMatchesScope(claim, config.scope)) {
        throw new ScopeMismatchError(`Work claim ${claimId} does not belong to the current scope`);
      }
      return asyncAdapter.releaseWorkClaim(claimId, actor, reason);
    },

    async listWorkClaims(options) {
      return asyncAdapter.listWorkClaims(config.scope, {
        actor: options?.actor,
        sessionId: options?.sessionId,
      });
    },

    async handoffWorkItem(input) {
      const workItem = await asyncAdapter.getWorkItemById(input.workItemId);
      if (workItem && !entityMatchesScope(workItem, config.scope)) {
        throw new ScopeMismatchError(`Work item ${input.workItemId} does not belong to the current scope`);
      }
      return asyncAdapter.createHandoff({
        ...normalizeScope(config.scope),
        work_item_id: input.workItemId,
        from_actor: input.fromActor,
        to_actor: input.toActor,
        session_id: config.sessionId,
        summary: input.summary,
        context_bundle_ref: input.contextBundleRef ?? null,
        expires_at: input.expiresAt ?? null,
        visibility_class: workItem?.visibility_class ?? 'private',
      });
    },

    async acceptHandoff(handoffId, actor, reason) {
      const handoff = await asyncAdapter.getHandoffById(handoffId);
      if (handoff && !entityMatchesScope(handoff, config.scope)) {
        throw new ScopeMismatchError(`Handoff ${handoffId} does not belong to the current scope`);
      }
      return asyncAdapter.acceptHandoff(handoffId, actor, reason);
    },

    async rejectHandoff(handoffId, actor, reason) {
      const handoff = await asyncAdapter.getHandoffById(handoffId);
      if (handoff && !entityMatchesScope(handoff, config.scope)) {
        throw new ScopeMismatchError(`Handoff ${handoffId} does not belong to the current scope`);
      }
      return asyncAdapter.rejectHandoff(handoffId, actor, reason);
    },

    async cancelHandoff(handoffId, actor, reason) {
      const handoff = await asyncAdapter.getHandoffById(handoffId);
      if (handoff && !entityMatchesScope(handoff, config.scope)) {
        throw new ScopeMismatchError(`Handoff ${handoffId} does not belong to the current scope`);
      }
      return asyncAdapter.cancelHandoff(handoffId, actor, reason);
    },

    async listPendingHandoffs(options) {
      return asyncAdapter.listHandoffs(config.scope, {
        actor: options?.actor,
        direction: options?.direction,
        statuses: ['pending'],
      });
    },
  };
}
