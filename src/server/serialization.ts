import type { MemoryContext } from '../core/context.js';
import type { DegradedContext } from '../contracts/context-contract.js';
import type {
  TemporalStateSnapshot,
  TimelineResult,
} from '../contracts/temporal.js';
import type {
  ActorRef,
  HandoffRecord,
  WorkClaim,
} from '../contracts/coordination.js';

export const DEFAULT_DEGRADED_CONTEXT: DegradedContext = {
  isDegraded: false,
  droppedInvariantIds: [],
  droppedKnowledgeIds: [],
  droppedSummaryIds: [],
  droppedPlaybookIds: [],
  droppedAssociatedKnowledgeIds: [],
};

const DEFAULT_DIFF_MAX_EVENTS = 5000;
const MAX_DIFF_MAX_EVENTS = 20000;

export function resolveDiffEventCaps(
  defaultMaxEvents?: number,
  maxMaxEvents?: number,
): { defaultDiffMaxEvents: number; maxDiffMaxEvents: number } {
  const resolvedMax = maxMaxEvents ?? MAX_DIFF_MAX_EVENTS;
  const resolvedDefault = defaultMaxEvents ?? DEFAULT_DIFF_MAX_EVENTS;
  if (!Number.isInteger(resolvedMax) || resolvedMax < 1) {
    throw new Error('memory-layer: maxDiffMaxEvents must be a positive integer');
  }
  if (!Number.isInteger(resolvedDefault) || resolvedDefault < 1) {
    throw new Error('memory-layer: defaultDiffMaxEvents must be a positive integer');
  }
  if (resolvedDefault > resolvedMax) {
    throw new Error('memory-layer: defaultDiffMaxEvents must not exceed maxDiffMaxEvents');
  }
  return {
    defaultDiffMaxEvents: resolvedDefault,
    maxDiffMaxEvents: resolvedMax,
  };
}

export function serializeActorRef(actor: ActorRef): Record<string, unknown> {
  return {
    actor_kind: actor.actor_kind,
    actor_id: actor.actor_id,
    system_id: actor.system_id,
    display_name: actor.display_name,
    metadata: actor.metadata,
  };
}

export function serializeWorkClaim(claim: WorkClaim): Record<string, unknown> {
  return {
    id: claim.id,
    work_item_id: claim.work_item_id,
    actor: serializeActorRef(claim.actor),
    session_id: claim.session_id,
    claim_token: claim.claim_token,
    status: claim.status,
    claimed_at: claim.claimed_at,
    expires_at: claim.expires_at,
    released_at: claim.released_at,
    release_reason: claim.release_reason,
    source_event_id: claim.source_event_id,
    visibility_class: claim.visibility_class,
    version: claim.version,
  };
}

export function serializeHandoffRecord(handoff: HandoffRecord): Record<string, unknown> {
  return {
    id: handoff.id,
    work_item_id: handoff.work_item_id,
    from_actor: serializeActorRef(handoff.from_actor),
    to_actor: serializeActorRef(handoff.to_actor),
    session_id: handoff.session_id,
    summary: handoff.summary,
    context_bundle_ref: handoff.context_bundle_ref,
    status: handoff.status,
    created_at: handoff.created_at,
    accepted_at: handoff.accepted_at,
    rejected_at: handoff.rejected_at,
    canceled_at: handoff.canceled_at,
    expires_at: handoff.expires_at,
    decision_reason: handoff.decision_reason,
    source_event_id: handoff.source_event_id,
    visibility_class: handoff.visibility_class,
    version: handoff.version,
  };
}

export function serializeTimelineResult(result: TimelineResult): Record<string, unknown> {
  return {
    events: result.events,
    nextCursor: result.nextCursor,
  };
}

export function serializeContextResponse(
  context: MemoryContext,
  options: {
    includeDebug?: boolean;
    includeAssociatedKnowledge?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    currentObjective: context.currentObjective,
    sessionState: context.sessionState,
    activeTurnCount: context.activeTurns.length,
    workingMemory: context.workingMemory
      ? {
          summary: context.workingMemory.summary,
          key_entities: context.workingMemory.key_entities,
          topic_tags: context.workingMemory.topic_tags,
        }
      : null,
    relevantKnowledge: context.relevantKnowledge.map((knowledge) => ({
      id: knowledge.id,
      fact: knowledge.fact,
      fact_type: knowledge.fact_type,
      confidence: knowledge.confidence,
    })),
    activeObjectives: context.activeObjectives.map((objective) => ({
      id: objective.id,
      title: objective.title,
      status: objective.status,
      visibility_class: objective.visibility_class,
    })),
    associatedKnowledge: options.includeAssociatedKnowledge === false
      ? undefined
      : context.associatedKnowledge.map((knowledge) => ({
          id: knowledge.id,
          fact: knowledge.fact,
          fact_type: knowledge.fact_type,
          knowledge_class: knowledge.knowledge_class,
          trust_score: knowledge.trust_score,
        })),
    unresolvedWork: context.unresolvedWork,
    invariants: context.invariants?.map((invariant) => ({
      id: invariant.id,
      title: invariant.title,
      instruction: invariant.instruction,
      severity: invariant.severity,
      scope_level: invariant.scopeLevel,
    })),
    appliedContract: context.appliedContract ?? null,
    warnings: context.warnings ?? [],
    degradedContext: context.degradedContext ?? DEFAULT_DEGRADED_CONTEXT,
    coordinationState: context.coordinationState
      ? {
          ownedClaims: context.coordinationState.ownedClaims.map(serializeWorkClaim),
          pendingInboundHandoffs: context.coordinationState.pendingInboundHandoffs.map(
            serializeHandoffRecord,
          ),
          pendingOutboundHandoffs: context.coordinationState.pendingOutboundHandoffs.map(
            serializeHandoffRecord,
          ),
          sharedWorkItems: context.coordinationState.sharedWorkItems.map((item) => ({
            id: item.id,
            title: item.title,
            status: item.status,
            visibility_class: item.visibility_class,
          })),
        }
      : null,
    tokenEstimate: context.tokenEstimate,
    ...(options.includeDebug
      ? {
          debugTrace: context.debugTrace,
          knowledgeSelectionReasons: context.knowledgeSelectionReasons,
        }
      : {}),
  };
}

export function serializeTemporalState(
  state: TemporalStateSnapshot<MemoryContext>,
  options: { includeDebug?: boolean } = {},
): Record<string, unknown> {
  return {
    asOf: state.asOf,
    exact: state.exact,
    cutoverAt: state.cutoverAt,
    watermarkEventId: state.watermarkEventId,
    context: serializeContextResponse(state.context, {
      includeDebug: options.includeDebug,
    }),
    sessionState: state.sessionState,
    turns: state.turns,
    workingMemory: state.workingMemory,
    knowledge: state.knowledge,
    workItems: state.workItems,
    workClaims: state.workClaims.map(serializeWorkClaim),
    handoffs: state.handoffs.map(serializeHandoffRecord),
    coordinationState: state.coordinationState
      ? {
          ownedClaims: state.coordinationState.ownedClaims.map(serializeWorkClaim),
          pendingInboundHandoffs: state.coordinationState.pendingInboundHandoffs.map(
            serializeHandoffRecord,
          ),
          pendingOutboundHandoffs: state.coordinationState.pendingOutboundHandoffs.map(
            serializeHandoffRecord,
          ),
          sharedWorkItems: state.coordinationState.sharedWorkItems,
        }
      : null,
    associations: state.associations,
    playbooks: state.playbooks,
  };
}
