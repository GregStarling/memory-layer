import type { ScopeLevel } from '../../contracts/identity.js';
import type { MemoryContext } from '../context.js';
import type { SessionBootstrap } from '../formatter.js';
import type { Profile } from '../../contracts/profile.js';
import type { CompactionLog, ContextMonitor, KnowledgeMemory } from '../../contracts/types.js';
import type {
  MemoryEventEntityKind,
  MemoryEventRecord,
  TemporalId,
  TemporalIdInput,
  TemporalStateDiff,
  TemporalStateSnapshot,
  TimelineResult,
} from '../../contracts/temporal.js';
import type { TemporalQueryOptions, FactsAtResult } from '../../contracts/temporal-query.js';
import { buildProfileFromKnowledge } from '../profile.js';
import {
  createTemporalReplayAdapter,
  getFactsAt,
  listAllMemoryEvents,
  listAllMemoryEventsBounded,
} from '../temporal.js';
import { delay } from '../manager-support.js';
import type { CapabilityContext } from './context.js';
import type { ContextQueryOptions, KnowledgeChangeResult } from '../manager-types.js';

/**
 * Temporal namespace (Phase 6.2): point-in-time state reconstruction, the
 * event timeline, diffs, change feeds, snapshots, and monitor/compaction
 * observability reads.
 */
export interface TemporalCapability {
  getContextAt(
    asOf: number,
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<MemoryContext>;
  getStateAt(
    asOf: number,
    options?: {
      relevanceQuery?: string;
      view?: ContextQueryOptions['view'];
      viewer?: ContextQueryOptions['viewer'];
      includeCoordinationState?: boolean;
      contract?: ContextQueryOptions['contract'];
      invariants?: ContextQueryOptions['invariants'];
    },
  ): Promise<TemporalStateSnapshot<MemoryContext>>;
  getTimeline(options?: {
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    startAt?: number;
    endAt?: number;
    limit?: number;
    cursor?: TemporalIdInput;
  }): Promise<TimelineResult>;
  diffState(
    from: number,
    to: number,
    options?: {
      sessionId?: string;
      entityKind?: MemoryEventEntityKind;
      entityId?: string;
      maxEvents?: number;
    },
  ): Promise<TemporalStateDiff>;
  listMemoryEvents(options?: {
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    startAt?: number;
    endAt?: number;
    limit?: number;
    cursor?: TemporalIdInput;
  }): Promise<TimelineResult>;
  getSessionBootstrapAt(
    asOf: number,
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<SessionBootstrap>;
  captureSnapshot(
    relevanceQuery?: string,
    options?: ContextQueryOptions,
  ): Promise<{
    bootstrap: SessionBootstrap;
    context: MemoryContext;
    frozenAt: number;
    watermarkEventId: string | null;
    profile: Profile | null;
  }>;
  streamChanges(options?: {
    cursor?: TemporalIdInput;
    sessionId?: string;
    entityKind?: MemoryEventEntityKind;
    entityId?: string;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  }): AsyncIterable<MemoryEventRecord>;
  resolveChangeStreamCursor(cursor?: TemporalIdInput): Promise<TemporalId>;
  listKnowledgeChanges(options?: {
    cursor?: TemporalIdInput;
    since?: Date;
    scopeLevel?: ScopeLevel;
    limit?: number;
  }): Promise<KnowledgeChangeResult>;
  pollForChanges(since: Date, options?: { scopeLevel?: ScopeLevel }): Promise<KnowledgeMemory[]>;
  getFactsAt(
    timestamp: number,
    options?: Partial<Omit<TemporalQueryOptions, 'timestamp' | 'scope'>>,
  ): Promise<FactsAtResult>;
  getContextMonitor(): Promise<ContextMonitor | null>;
  getRecentCompactionLogs(limit?: number): Promise<CompactionLog[]>;
}

export function createTemporalCapability(ctx: CapabilityContext): TemporalCapability {
  const {
    asyncAdapter,
    config,
    buildReplayedContext,
    getContextInternal,
    collectKnowledgeForProfile,
    buildSessionBootstrapPayload,
    filterTemporalStateForContext,
    collectBestEffortTemporalState,
    getTemporalCutoverAt,
    resolveChangeStreamCursorInternal,
    listKnowledgeChangesInternal,
  } = ctx;

  return {
    async getContextAt(asOf, relevanceQuery, options) {
      return (await buildReplayedContext(asOf, relevanceQuery, options)).context;
    },

    async getStateAt(asOf, options) {
      const replay = await buildReplayedContext(asOf, options?.relevanceQuery, options);
      const replayed = replay.exact
        ? filterTemporalStateForContext(replay.state!, options)
        : await collectBestEffortTemporalState(asOf, options);
      return {
        asOf,
        exact: replay.exact,
        cutoverAt: replay.cutoverAt,
        watermarkEventId: replay.watermarkEventId,
        context: replay.context,
        sessionState: replay.context.sessionState,
        turns: replayed.turns,
        workingMemory: replayed.workingMemory,
        knowledge: replayed.knowledge,
        workItems: replayed.workItems,
        workClaims: replayed.workClaims,
        handoffs: replayed.handoffs,
        coordinationState: replay.context.coordinationState,
        associations: replayed.associations,
        playbooks: replayed.playbooks,
      };
    },

    async getTimeline(options) {
      return asyncAdapter.listMemoryEvents(config.scope, {
        sessionId: options?.sessionId,
        entityKind: options?.entityKind,
        entityId: options?.entityId,
        startAt: options?.startAt,
        endAt: options?.endAt,
        limit: options?.limit,
        cursor: options?.cursor,
      });
    },

    async diffState(from, to, options) {
      const cutoverAt = await getTemporalCutoverAt();
      const eventQuery = {
        sessionId: options?.sessionId,
        entityKind: options?.entityKind,
        entityId: options?.entityId,
        startAt: from + 1,
        endAt: to,
        limit: 500,
      };
      const events =
        options?.maxEvents != null
          ? await listAllMemoryEventsBounded(asyncAdapter, config.scope, options.maxEvents, eventQuery)
          : await listAllMemoryEvents(asyncAdapter, config.scope, eventQuery);
      const byEntityKind: Partial<Record<MemoryEventEntityKind, number>> = {};
      const byEventType: Partial<Record<MemoryEventRecord['event_type'], number>> = {};
      for (const event of events) {
        byEntityKind[event.entity_kind] = (byEntityKind[event.entity_kind] ?? 0) + 1;
        byEventType[event.event_type] = (byEventType[event.event_type] ?? 0) + 1;
      }
      return {
        from,
        to,
        exact: cutoverAt != null && from >= cutoverAt && to >= cutoverAt,
        cutoverAt,
        watermarkRange: {
          fromEventId: events[0]?.event_id ?? null,
          toEventId: events[events.length - 1]?.event_id ?? null,
        },
        events,
        summary: {
          totalEvents: events.length,
          byEntityKind,
          byEventType,
        },
      };
    },

    async listMemoryEvents(options) {
      const timeline = await asyncAdapter.listMemoryEvents(config.scope, {
        sessionId: options?.sessionId,
        entityKind: options?.entityKind,
        entityId: options?.entityId,
        startAt: options?.startAt,
        endAt: options?.endAt,
        limit: options?.limit,
        cursor: options?.cursor,
      });
      return {
        events: [...timeline.events].reverse(),
        nextCursor: timeline.nextCursor,
      };
    },

    async getSessionBootstrapAt(asOf, relevanceQuery, options) {
      const replay = await buildReplayedContext(asOf, relevanceQuery, options);
      const profile =
        replay.exact && replay.state
          ? buildProfileFromKnowledge(
              await collectKnowledgeForProfile(
                createTemporalReplayAdapter(replay.state, asOf),
                options,
                asOf,
              ),
            )
          : buildProfileFromKnowledge(await collectKnowledgeForProfile(asyncAdapter, options, asOf));
      return buildSessionBootstrapPayload(replay.context, profile);
    },

    async captureSnapshot(relevanceQuery, options) {
      const frozenAt = Math.floor(Date.now() / 1000);
      const watermark = await asyncAdapter.getTemporalWatermark('temporal');
      if (!watermark || watermark.last_event_id === '0') {
        const [context, profile] = await Promise.all([
          getContextInternal(relevanceQuery, undefined, options),
          collectKnowledgeForProfile(asyncAdapter, options).then((knowledge) =>
            buildProfileFromKnowledge(knowledge),
          ),
        ]);
        return {
          bootstrap: buildSessionBootstrapPayload(context, profile),
          context,
          frozenAt,
          watermarkEventId: null,
          profile,
        };
      }

      const replay = await buildReplayedContext(
        watermark.updated_at,
        relevanceQuery,
        options,
        {
          throughEventId: watermark.last_event_id,
        },
      );
      const profile =
        replay.exact && replay.state
          ? buildProfileFromKnowledge(
              await collectKnowledgeForProfile(
                createTemporalReplayAdapter(replay.state, watermark.updated_at),
                options,
                watermark.updated_at,
              ),
            )
          : buildProfileFromKnowledge(
              await collectKnowledgeForProfile(asyncAdapter, options, watermark.updated_at),
            );
      return {
        bootstrap: buildSessionBootstrapPayload(replay.context, profile),
        context: replay.context,
        frozenAt,
        watermarkEventId: replay.exact ? watermark.last_event_id : null,
        profile,
      };
    },

    async *streamChanges(options) {
      let cursor = await resolveChangeStreamCursorInternal(options?.cursor);
      while (!options?.signal?.aborted) {
        const page = await asyncAdapter.listMemoryEvents(config.scope, {
          cursor,
          sessionId: options?.sessionId,
          entityKind: options?.entityKind,
          entityId: options?.entityId,
          limit: 100,
        });
        for (const event of page.events) {
          cursor = event.event_id;
          yield event;
        }
        if (options?.signal?.aborted) break;
        await delay(options?.pollIntervalMs ?? 250);
      }
    },

    async resolveChangeStreamCursor(cursor) {
      return resolveChangeStreamCursorInternal(cursor);
    },

    async listKnowledgeChanges(options) {
      return listKnowledgeChangesInternal(options);
    },

    async pollForChanges(since, options) {
      const result = await listKnowledgeChangesInternal({
        since,
        scopeLevel: options?.scopeLevel,
        limit: 500,
      });
      const latestByKnowledgeId = new Map<number, KnowledgeMemory>();
      for (const change of result.changes) {
        latestByKnowledgeId.delete(change.knowledge.id);
        latestByKnowledgeId.set(change.knowledge.id, change.knowledge);
      }
      return [...latestByKnowledgeId.values()];
    },

    async getFactsAt(timestamp, options) {
      const queryOptions: TemporalQueryOptions = {
        timestamp,
        scope: config.scope,
        knowledgeClass: options?.knowledgeClass,
        fallbackToReplay: options?.fallbackToReplay ?? true,
      };
      const getContextAtFn = async (asOf: number) =>
        (await buildReplayedContext(asOf)).context;
      return getFactsAt(asyncAdapter, getContextAtFn, queryOptions);
    },

    async getContextMonitor() {
      return asyncAdapter.getContextMonitor(config.scope);
    },

    async getRecentCompactionLogs(limit) {
      return asyncAdapter.getRecentCompactionLogs(config.scope, limit ?? 10);
    },
  };
}
