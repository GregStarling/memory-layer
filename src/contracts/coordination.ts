import type { NormalizedMemoryScope } from './identity.js';
import type { WorkItem } from './types.js';

export type ActorKind = 'agent' | 'human' | 'system' | 'service';
export type MemoryVisibilityClass = 'private' | 'shared_collaboration' | 'workspace' | 'tenant';
export type ContextViewPolicy =
  | 'local_only'
  | 'local_plus_shared_collaboration'
  | 'operator_supervisor'
  | 'workspace_shared';
export type WorkClaimStatus = 'active' | 'released' | 'expired';
export type HandoffStatus = 'pending' | 'accepted' | 'rejected' | 'canceled' | 'expired';

export const ACTOR_KINDS: readonly ActorKind[] = ['agent', 'human', 'system', 'service'];
export const MEMORY_VISIBILITY_CLASSES: readonly MemoryVisibilityClass[] = [
  'private',
  'shared_collaboration',
  'workspace',
  'tenant',
];
export const CONTEXT_VIEW_POLICIES: readonly ContextViewPolicy[] = [
  'local_only',
  'local_plus_shared_collaboration',
  'operator_supervisor',
  'workspace_shared',
];
export const WORK_CLAIM_STATUSES: readonly WorkClaimStatus[] = [
  'active',
  'released',
  'expired',
];
export const HANDOFF_STATUSES: readonly HandoffStatus[] = [
  'pending',
  'accepted',
  'rejected',
  'canceled',
  'expired',
];

export interface ActorRef {
  actor_kind: ActorKind;
  actor_id: string;
  system_id: string | null;
  display_name: string | null;
  metadata: Record<string, unknown> | null;
}

export interface WorkClaim extends NormalizedMemoryScope {
  id: number;
  work_item_id: number;
  actor: ActorRef;
  session_id: string | null;
  claim_token: string;
  status: WorkClaimStatus;
  claimed_at: number;
  expires_at: number;
  released_at: number | null;
  release_reason: string | null;
  source_event_id: number | null;
  visibility_class: MemoryVisibilityClass;
  version: number;
}

export interface NewWorkClaimInput extends NormalizedMemoryScope {
  work_item_id: number;
  actor: ActorRef;
  session_id?: string | null;
  lease_seconds?: number;
  visibility_class: MemoryVisibilityClass;
  claimed_at?: number;
}

export interface WorkClaimQuery {
  actor?: Pick<ActorRef, 'actor_kind' | 'actor_id'>;
  includeExpired?: boolean;
  includeReleased?: boolean;
  sessionId?: string;
  visibilityClass?: MemoryVisibilityClass;
  limit?: number;
}

export interface HandoffRecord extends NormalizedMemoryScope {
  id: number;
  work_item_id: number;
  from_actor: ActorRef;
  to_actor: ActorRef;
  session_id: string | null;
  summary: string;
  context_bundle_ref: string | null;
  status: HandoffStatus;
  created_at: number;
  accepted_at: number | null;
  rejected_at: number | null;
  canceled_at: number | null;
  expires_at: number | null;
  decision_reason: string | null;
  source_event_id: number | null;
  visibility_class: MemoryVisibilityClass;
  version: number;
}

export interface NewHandoffInput extends NormalizedMemoryScope {
  work_item_id: number;
  from_actor: ActorRef;
  to_actor: ActorRef;
  session_id?: string | null;
  summary: string;
  context_bundle_ref?: string | null;
  expires_at?: number | null;
  visibility_class: MemoryVisibilityClass;
  created_at?: number;
}

export interface HandoffQuery {
  actor?: Pick<ActorRef, 'actor_kind' | 'actor_id'>;
  direction?: 'inbound' | 'outbound' | 'all';
  statuses?: HandoffStatus[];
  sessionId?: string;
  limit?: number;
}

export interface WorkItemPatch {
  title?: string;
  detail?: string | null;
  status?: WorkItem['status'];
  visibility_class?: MemoryVisibilityClass;
}

export interface CoordinationState {
  ownedClaims: WorkClaim[];
  pendingInboundHandoffs: HandoffRecord[];
  pendingOutboundHandoffs: HandoffRecord[];
  sharedWorkItems: WorkItem[];
}
