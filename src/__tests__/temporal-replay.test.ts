import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { ActorRef } from '../contracts/coordination.js';
import { ValidationError } from '../contracts/errors.js';
import {
  normalizeScope,
  type MemoryScope,
} from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { MemoryEventRecord } from '../contracts/temporal.js';
import { createSessionId } from '../core/tokens.js';
import {
  createTemporalReplayAdapter,
  foldTemporalState,
  listAllMemoryEvents,
  listAllMemoryEventsBounded,
  listAllMemoryEventsCrossScope,
  listAllMemoryEventsCrossScopeBounded,
  normalizeHandoffAt,
  normalizeReplayedTemporalState,
  normalizeWorkClaimAt,
} from '../core/temporal.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

function actor(actorId: string): ActorRef {
  return {
    actor_kind: 'agent',
    actor_id: actorId,
    system_id: 'assistant',
    display_name: actorId,
    metadata: null,
  };
}

describe('temporal replay helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accumulates paginated events and enforces max-event bounds', async () => {
    const events: MemoryEventRecord[] = [
      {
        ...normalizeScope(scope()),
        event_id: '1',
        session_id: 'sess-1',
        actor_id: null,
        actor_kind: null,
        actor_system_id: null,
        actor_display_name: null,
        actor_metadata: null,
        entity_kind: 'turn',
        entity_id: '1',
        event_type: 'turn.created',
        payload: { after: { id: 1 } },
        causation_id: null,
        correlation_id: null,
        created_at: 100,
      },
      {
        ...normalizeScope(scope()),
        event_id: '2',
        session_id: 'sess-1',
        actor_id: null,
        actor_kind: null,
        actor_system_id: null,
        actor_display_name: null,
        actor_metadata: null,
        entity_kind: 'turn',
        entity_id: '2',
        event_type: 'turn.created',
        payload: { after: { id: 2 } },
        causation_id: null,
        correlation_id: null,
        created_at: 101,
      },
      {
        ...normalizeScope(scope({ workspace_id: 'shared', scope_id: 'other' })),
        event_id: '3',
        session_id: 'sess-2',
        actor_id: null,
        actor_kind: null,
        actor_system_id: null,
        actor_display_name: null,
        actor_metadata: null,
        entity_kind: 'work_item',
        entity_id: '3',
        event_type: 'work_item.created',
        payload: { after: { id: 3 } },
        causation_id: null,
        correlation_id: null,
        created_at: 102,
      },
    ];

    const asyncAdapter = {
      listMemoryEvents: vi.fn(async (_scope, query) => {
        const cursor = query?.cursor == null ? 0 : Number(query.cursor);
        const page = events.filter((event) => Number(event.event_id) > cursor).slice(0, 2);
        return {
          events: page,
          nextCursor: page.length === 2 ? page[1].event_id : null,
        };
      }),
      listMemoryEventsCrossScope: vi.fn(async (_scope, _level, query) => {
        const cursor = query?.cursor == null ? 0 : Number(query.cursor);
        const page = events.filter((event) => Number(event.event_id) > cursor).slice(0, 2);
        return {
          events: page,
          nextCursor: page.length === 2 ? page[1].event_id : null,
        };
      }),
    } satisfies Pick<AsyncStorageAdapter, 'listMemoryEvents' | 'listMemoryEventsCrossScope'>;

    await expect(listAllMemoryEvents(asyncAdapter as AsyncStorageAdapter, scope())).resolves.toHaveLength(3);
    await expect(listAllMemoryEventsCrossScope(asyncAdapter as AsyncStorageAdapter, scope(), 'workspace')).resolves.toHaveLength(3);
    await expect(
      listAllMemoryEventsBounded(asyncAdapter as AsyncStorageAdapter, scope(), 2),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      listAllMemoryEventsCrossScopeBounded(asyncAdapter as AsyncStorageAdapter, scope(), 'workspace', 2),
    ).rejects.toThrow('event range exceeds maximum of 2');
  });

  it('folds temporal state, filters by session, and normalizes expired coordination records', () => {
    const baseScope = normalizeScope(scope());
    const otherScope = normalizeScope(scope({ workspace_id: 'shared', scope_id: 'other' }));
    const folded = foldTemporalState(
      [
        {
          ...baseScope,
          event_id: '1',
          session_id: 'sess-1',
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'turn',
          entity_id: '1',
          event_type: 'turn.created',
          payload: {
            after: {
              ...baseScope,
              id: 1,
              session_id: 'sess-1',
              actor: 'user',
              role: 'user',
              content: 'first turn',
              priority: 1,
              token_estimate: 4,
              created_at: 100,
              archived_at: null,
              compaction_log_id: null,
              schema_version: 1,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 100,
        },
        {
          ...otherScope,
          event_id: '2',
          session_id: 'sess-2',
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'turn',
          entity_id: '2',
          event_type: 'turn.created',
          payload: {
            after: {
              ...otherScope,
              id: 2,
              session_id: 'sess-2',
              actor: 'assistant',
              role: 'assistant',
              content: 'other turn',
              priority: 1,
              token_estimate: 4,
              created_at: 101,
              archived_at: null,
              compaction_log_id: null,
              schema_version: 1,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 101,
        },
        {
          ...baseScope,
          event_id: '3',
          session_id: 'sess-1',
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'working_memory',
          entity_id: '1',
          event_type: 'working_memory.created',
          payload: {
            after: {
              ...baseScope,
              id: 1,
              session_id: 'sess-1',
              summary: 'summary',
              key_entities: [],
              topic_tags: [],
              turn_id_start: 1,
              turn_id_end: 1,
              turn_count: 1,
              compaction_trigger: 'manual',
              created_at: 102,
              expires_at: 103,
              promoted_to_knowledge_id: null,
              episode_recap: null,
              schema_version: 1,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 102,
        },
        {
          ...baseScope,
          event_id: '4',
          session_id: null,
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'knowledge_memory',
          entity_id: '1',
          event_type: 'knowledge.created',
          payload: {
            after: {
              ...baseScope,
              id: 1,
              visibility_class: 'private',
              fact: 'local fact',
              fact_type: 'reference',
              knowledge_state: 'trusted',
              knowledge_class: 'project_fact',
              fact_subject: null,
              fact_attribute: null,
              fact_value: null,
              normalized_fact: null,
              slot_key: null,
              is_negated: false,
              source: 'manual',
              confidence: 'high',
              confidence_score: 0.9,
              grounding_strength: 'moderate',
              evidence_count: 1,
              trust_score: 0.9,
              verification_status: 'verified',
              verification_notes: null,
              last_verified_at: null,
              next_reverification_at: null,
              last_confirmed_at: null,
              confirmation_count: 0,
              source_system_id: 'assistant',
              source_scope_id: 'thread-1',
              source_collaboration_id: '',
              source_working_memory_id: null,
              source_turn_ids: [],
              successful_use_count: 0,
              failed_use_count: 0,
              disputed_at: null,
              dispute_reason: null,
              contradiction_score: 0,
              superseded_at: null,
              superseded_by_id: null,
              retired_at: null,
              created_at: 103,
              last_accessed_at: 103,
              access_count: 1,
              schema_version: 1,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 103,
        },
        {
          ...baseScope,
          event_id: '5',
          session_id: 'sess-1',
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'work_item',
          entity_id: '1',
          event_type: 'work_item.created',
          payload: {
            after: {
              ...baseScope,
              id: 1,
              session_id: 'sess-1',
              visibility_class: 'private',
              kind: 'objective',
              title: 'ship it',
              detail: null,
              status: 'open',
              source_working_memory_id: null,
              version: 1,
              created_at: 104,
              updated_at: 104,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 104,
        },
        {
          ...baseScope,
          event_id: '6',
          session_id: 'sess-1',
          actor_id: 'alice',
          actor_kind: 'agent',
          actor_system_id: 'assistant',
          actor_display_name: 'alice',
          actor_metadata: null,
          entity_kind: 'work_claim',
          entity_id: '1',
          event_type: 'work_claim.claimed',
          payload: {
            after: {
              ...baseScope,
              id: 1,
              work_item_id: 1,
              actor: actor('alice'),
              session_id: 'sess-1',
              claim_token: 'claim-1',
              status: 'active',
              claimed_at: 105,
              expires_at: 106,
              released_at: null,
              release_reason: null,
              source_event_id: null,
              visibility_class: 'private',
              version: 1,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 105,
        },
        {
          ...baseScope,
          event_id: '7',
          session_id: 'sess-1',
          actor_id: 'alice',
          actor_kind: 'agent',
          actor_system_id: 'assistant',
          actor_display_name: 'alice',
          actor_metadata: null,
          entity_kind: 'handoff',
          entity_id: '1',
          event_type: 'handoff.created',
          payload: {
            after: {
              ...baseScope,
              id: 1,
              work_item_id: 1,
              from_actor: actor('alice'),
              to_actor: actor('bob'),
              session_id: 'sess-1',
              summary: 'handoff',
              context_bundle_ref: null,
              status: 'pending',
              created_at: 105,
              accepted_at: null,
              rejected_at: null,
              canceled_at: null,
              expires_at: 106,
              decision_reason: null,
              source_event_id: null,
              visibility_class: 'private',
              version: 1,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 105,
        },
        {
          ...baseScope,
          event_id: '8',
          session_id: null,
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'association',
          entity_id: '1',
          event_type: 'association.created',
          payload: {
            after: {
              ...baseScope,
              id: 1,
              visibility_class: 'private',
              source_kind: 'knowledge',
              source_id: 1,
              target_kind: 'work_item',
              target_id: 1,
              association_type: 'supports',
              confidence: 0.8,
              auto_generated: false,
              created_at: 105,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 105,
        },
        {
          ...baseScope,
          event_id: '9',
          session_id: null,
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'playbook',
          entity_id: '1',
          event_type: 'playbook.created',
          payload: {
            after: {
              ...baseScope,
              id: 1,
              visibility_class: 'private',
              title: 'Deploy',
              description: 'deploy safely',
              instructions: 'run checks',
              references: [],
              templates: [],
              scripts: [],
              assets: [],
              tags: [],
              status: 'active',
              source_session_id: 'sess-1',
              source_working_memory_id: null,
              revision_count: 0,
              last_used_at: null,
              use_count: 0,
              created_at: 105,
              updated_at: 105,
              schema_version: 1,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 105,
        },
        {
          ...baseScope,
          event_id: '10',
          session_id: 'sess-1',
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'session_state',
          entity_id: 'sess-1',
          event_type: 'session_state.updated',
          payload: {
            after: {
              ...baseScope,
              session_id: 'sess-1',
              currentObjective: 'Ship',
              blockers: ['time'],
              assumptions: [],
              pendingDecisions: [],
              activeTools: [],
              recentOutputs: [],
              updatedAt: 106,
              source_event_id: '9',
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 106,
        },
        {
          ...baseScope,
          event_id: '11',
          session_id: 'sess-1',
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'work_item',
          entity_id: '1',
          event_type: 'work_item.deleted',
          payload: {
            before: {
              id: 1,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 107,
        },
        {
          ...baseScope,
          event_id: '12',
          session_id: null,
          actor_id: null,
          actor_kind: null,
          actor_system_id: null,
          actor_display_name: null,
          actor_metadata: null,
          entity_kind: 'association',
          entity_id: '1',
          event_type: 'association.deleted',
          payload: {
            before: {
              id: 1,
            },
          },
          causation_id: null,
          correlation_id: null,
          created_at: 108,
        },
      ],
      { sessionId: 'sess-1' },
    );

    expect(folded.turns).toHaveLength(1);
    expect(folded.workingMemory).toHaveLength(1);
    expect(folded.knowledge).toHaveLength(1);
    expect(folded.workItems).toHaveLength(0);
    expect(folded.associations).toHaveLength(0);
    expect(folded.playbooks).toHaveLength(1);
    expect(folded.sessionStates).toHaveLength(1);
    expect(folded.watermarkEventId).toBe('12');

    const normalized = normalizeReplayedTemporalState(folded, 200);
    expect(normalized.workClaims[0]?.status).toBe('expired');
    expect(normalized.handoffs[0]?.status).toBe('expired');
    expect(normalizeWorkClaimAt(normalized.workClaims[0], 200).release_reason).toBe('expired');
    expect(normalizeHandoffAt(normalized.handoffs[0], 200).decision_reason).toBe('expired');
  });

  it('replays historical reads and rejects write operations', async () => {
    let syncAdapter: StorageAdapter;
    let asyncAdapter: AsyncStorageAdapter;
    const localScope = scope({ workspace_id: 'shared' });
    const workspaceLocal = scope({ workspace_id: 'shared', scope_id: 'mine' });
    const workspacePeer = scope({ workspace_id: 'shared', scope_id: 'peer', system_id: 'reviewer' });
    const sessionId = createSessionId(localScope);

    syncAdapter = createInMemoryAdapter();
    asyncAdapter = wrapSyncAdapter(syncAdapter);

    const activeTurn = syncAdapter.insertTurn({
      ...localScope,
      session_id: sessionId,
      actor: 'user',
      role: 'user',
      content: 'deploy checklist',
      created_at: 100,
    });
    const archivedTurn = syncAdapter.insertTurn({
      ...localScope,
      session_id: sessionId,
      actor: 'assistant',
      role: 'assistant',
      content: 'old archived turn',
      created_at: 101,
    });
    syncAdapter.archiveTurn(archivedTurn.id, 150, 1);

    const expiredWorking = syncAdapter.insertWorkingMemory({
      ...localScope,
      session_id: sessionId,
      summary: 'expired wm',
      key_entities: ['old'],
      topic_tags: [],
      turn_id_start: activeTurn.id,
      turn_id_end: archivedTurn.id,
      turn_count: 2,
      compaction_trigger: 'manual',
      expires_at: 150,
    });
    const activeWorking = syncAdapter.insertWorkingMemory({
      ...localScope,
      session_id: sessionId,
      summary: 'active wm',
      key_entities: ['deploy'],
      topic_tags: [],
      turn_id_start: activeTurn.id,
      turn_id_end: activeTurn.id,
      turn_count: 1,
      compaction_trigger: 'soft',
      expires_at: 500,
    });
    const localKnowledge = syncAdapter.insertKnowledgeMemory({
      ...localScope,
      fact: 'deploy service safely',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
      knowledge_class: 'project_fact',
    });
    const workspaceKnowledge = syncAdapter.insertKnowledgeMemory({
      ...workspacePeer,
      visibility_class: 'workspace',
      fact: 'shared deployment fact',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
      knowledge_class: 'project_fact',
    });
    const localWorkItem = syncAdapter.insertWorkItem({
      ...localScope,
      session_id: sessionId,
      kind: 'objective',
      title: 'Ship replay',
      created_at: 100,
    });
    const crossScopeWorkItem = syncAdapter.insertWorkItem({
      ...workspacePeer,
      session_id: 'peer-session',
      visibility_class: 'workspace',
      kind: 'unresolved_work',
      title: 'Shared blocker',
      status: 'blocked',
      created_at: 101,
    });
    const releasedClaim = syncAdapter.claimWorkItem({
      ...localScope,
      work_item_id: localWorkItem.id,
      actor: actor('alice'),
      session_id: sessionId,
      visibility_class: 'private',
      lease_seconds: 30,
      claimed_at: 100,
    });
    syncAdapter.releaseWorkClaim(releasedClaim.id, actor('alice'), 'done');
    const expiredClaim = syncAdapter.claimWorkItem({
      ...workspacePeer,
      work_item_id: crossScopeWorkItem.id,
      actor: actor('bob'),
      session_id: 'peer-session',
      visibility_class: 'workspace',
      lease_seconds: 1,
      claimed_at: 100,
    });
    const acceptedPlaybook = syncAdapter.insertPlaybook({
      ...localScope,
      title: 'Deploy playbook',
      description: 'deploy service safely',
      instructions: 'run checks',
      status: 'active',
      created_at: 100,
    });
    const workspacePlaybook = syncAdapter.insertPlaybook({
      ...workspacePeer,
      visibility_class: 'workspace',
      title: 'Shared playbook',
      description: 'shared guide',
      instructions: 'follow the guide',
      status: 'draft',
      created_at: 101,
    });
    const association = syncAdapter.insertAssociation({
      ...localScope,
      source_kind: 'knowledge',
      source_id: localKnowledge.id,
      target_kind: 'work_item',
      target_id: localWorkItem.id,
      association_type: 'supports',
    });
    syncAdapter.upsertSessionState({
      ...normalizeScope(localScope),
      session_id: sessionId,
      currentObjective: 'Replay',
      blockers: ['time'],
      assumptions: [],
      pendingDecisions: [],
      activeTools: ['vitest'],
      recentOutputs: ['coverage'],
      updatedAt: 120,
    });
    const pendingHandoff = syncAdapter.createHandoff({
      ...workspacePeer,
      work_item_id: crossScopeWorkItem.id,
      from_actor: actor('alice'),
      to_actor: actor('bob'),
      session_id: 'peer-session',
      summary: 'shared handoff',
      visibility_class: 'workspace',
      expires_at: 101,
      created_at: 100,
    });

    // F4: cross-scope event reads apply the base visibility gate, so the replay
    // state must be reconstructed from a scope that legitimately SEES the seeded
    // rows. localScope owns the private local rows (visible to itself) and shares
    // the workspace with the peer's workspace-class rows, so a workspace-level
    // cross-scope read from localScope captures the full seeded set. The private
    // local rows are then still correctly EXCLUDED from cross-scope reads issued
    // by workspaceLocal (a different scope_id) below.
    const replayState = foldTemporalState(
      await listAllMemoryEventsCrossScope(asyncAdapter, localScope, 'workspace'),
    );
    const replay = createTemporalReplayAdapter(replayState, 200);

    await expect(replay.getTurnById(activeTurn.id)).resolves.toMatchObject({ id: activeTurn.id });
    await expect(replay.getActiveTurns(localScope, sessionId)).resolves.toHaveLength(1);
    await expect(replay.searchTurns(localScope, 'deploy')).resolves.toHaveLength(1);
    await expect(replay.getArchivedTurnRange(sessionId, 1, 99, localScope)).resolves.toHaveLength(1);

    await expect(replay.getWorkingMemoryById(activeWorking.id)).resolves.toMatchObject({ id: activeWorking.id });
    await expect(replay.getWorkingMemoryBySession(sessionId, localScope)).resolves.toHaveLength(2);
    await expect(replay.getActiveWorkingMemory(localScope, sessionId)).resolves.toHaveLength(1);
    await expect(replay.getLatestWorkingMemory(localScope, sessionId)).resolves.toMatchObject({ id: activeWorking.id });
    await expect(
      replay.getWorkingMemoryByTimeRange(localScope, {
        start_at: expiredWorking.created_at,
        end_at: activeWorking.created_at,
      }),
    ).resolves.toHaveLength(2);

    await expect(replay.getKnowledgeMemoryById(localKnowledge.id)).resolves.toMatchObject({ id: localKnowledge.id });
    await expect(replay.getActiveKnowledgeMemory(localScope)).resolves.toHaveLength(1);
    // F4: workspaceLocal (scope_id 'mine') sees only the peer's WORKSPACE-class
    // fact; the local PRIVATE fact (scope_id 'thread-1') is correctly excluded.
    await expect(replay.getActiveKnowledgeCrossScope(workspaceLocal, 'workspace')).resolves.toHaveLength(1);
    await expect(
      replay.getKnowledgeSince(workspaceLocal, 'workspace', workspaceKnowledge.created_at),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workspaceKnowledge.id })]),
    );
    await expect(
      replay.getKnowledgeByTimeRange(localScope, {
        start_at: localKnowledge.created_at,
        end_at: localKnowledge.created_at,
      }),
    ).resolves.toHaveLength(1);
    await expect(replay.searchKnowledge(localScope, 'deploy')).resolves.toHaveLength(1);
    await expect(replay.searchKnowledgeCrossScope(workspaceLocal, 'workspace', 'shared deployment')).resolves.toHaveLength(1);

    await expect(replay.getWorkItemById(localWorkItem.id)).resolves.toMatchObject({ id: localWorkItem.id });
    await expect(replay.getActiveWorkItems(localScope)).resolves.toHaveLength(1);
    // F4: only the peer's workspace-class work item surfaces cross-scope to
    // workspaceLocal; the local private work item is excluded.
    await expect(replay.getActiveWorkItemsCrossScope(workspaceLocal, 'workspace')).resolves.toHaveLength(1);
    await expect(replay.getWorkItemsByTimeRange(localScope, { start_at: 0, end_at: 500 })).resolves.toHaveLength(1);
    await expect(replay.getWorkItemsByTimeRangeCrossScope(workspaceLocal, 'workspace', { start_at: 0, end_at: 500 })).resolves.toHaveLength(1);

    await expect(replay.getActiveWorkClaim(crossScopeWorkItem.id)).resolves.toBeNull();
    await expect(
      replay.listWorkClaims(workspacePeer, {
        includeExpired: true,
        includeReleased: true,
        sessionId: 'peer-session',
      }),
    ).resolves.toMatchObject([{ id: expiredClaim.id, status: 'expired' }]);
    // F4: the released local claim is private (scope 'thread-1') and excluded
    // from workspaceLocal's cross-scope view; only the peer's workspace-class
    // expired claim surfaces.
    await expect(
      replay.listWorkClaimsCrossScope(workspaceLocal, 'workspace', {
        includeExpired: true,
        includeReleased: true,
      }),
    ).resolves.toHaveLength(1);

    await expect(
      replay.listHandoffs(workspacePeer, {
        statuses: ['expired'],
        actor: { actor_kind: 'agent', actor_id: 'bob' },
      }),
    ).resolves.toMatchObject([{ id: pendingHandoff.id, status: 'expired' }]);
    await expect(
      replay.listHandoffsCrossScope(workspaceLocal, 'workspace', {
        statuses: ['expired'],
      }),
    ).resolves.toHaveLength(1);

    await expect(replay.getPlaybookById(acceptedPlaybook.id)).resolves.toMatchObject({ id: acceptedPlaybook.id });
    await expect(replay.getActivePlaybooks(localScope)).resolves.toHaveLength(1);
    // F4: only the peer's workspace-class playbook surfaces cross-scope; the
    // local private playbook is excluded.
    await expect(replay.getActivePlaybooksCrossScope(workspaceLocal, 'workspace')).resolves.toHaveLength(1);
    await expect(replay.searchPlaybooks(localScope, 'deploy playbook')).resolves.toHaveLength(1);
    await expect(replay.searchPlaybooksCrossScope(workspaceLocal, 'workspace', 'shared guide')).resolves.toHaveLength(1);

    await expect(replay.getAssociationById(association.id)).resolves.toMatchObject({ id: association.id });
    await expect(replay.getAssociationsFrom('knowledge', localKnowledge.id, localScope)).resolves.toHaveLength(1);
    await expect(replay.getAssociationsTo('work_item', localWorkItem.id, localScope)).resolves.toHaveLength(1);
    await expect(replay.listAssociations(localScope)).resolves.toHaveLength(1);

    await expect(replay.getSessionState(localScope, sessionId)).resolves.toMatchObject({ session_id: sessionId });
    await expect(
      replay.upsertSessionState({
        ...normalizeScope(localScope),
        session_id: 'new-session',
        currentObjective: 'Resume',
        blockers: [],
        assumptions: [],
        pendingDecisions: [],
        activeTools: [],
        recentOutputs: [],
        updatedAt: 300,
      }),
    ).resolves.toMatchObject({
      session_id: 'new-session',
      source_event_id: replayState.watermarkEventId,
    });
    await expect(replay.getTemporalWatermark()).resolves.toMatchObject({
      last_event_id: replayState.watermarkEventId,
    });
    await expect(replay.transaction(async () => 'ok')).resolves.toBe('ok');
    await expect(replay.close()).resolves.toBeUndefined();
    await expect(replay.getKnowledgeCandidateById(1)).resolves.toBeNull();
    await expect(replay.listKnowledgeCandidates(localScope)).resolves.toEqual([]);
    await expect(replay.listKnowledgeEvidenceForKnowledge(localKnowledge.id)).resolves.toEqual([]);
    await expect(replay.listKnowledgeEvidenceForCandidate(1)).resolves.toEqual([]);
    await expect(replay.getRecentKnowledgeMemoryAudits(localScope)).resolves.toEqual([]);
    await expect(replay.getKnowledgeMemoryAuditsForKnowledge(localScope, localKnowledge.id)).resolves.toEqual([]);
    await expect(replay.touchKnowledgeMemory(localKnowledge.id)).resolves.toBeUndefined();
    await expect(replay.touchKnowledgeMemories([localKnowledge.id])).resolves.toBeUndefined();
    await expect(replay.getContextMonitor(localScope)).resolves.toBeNull();
    await expect(replay.getCompactionLogById(1)).resolves.toBeNull();
    await expect(replay.getRecentCompactionLogs(localScope)).resolves.toEqual([]);
    await expect(replay.getPlaybookRevisions(acceptedPlaybook.id)).resolves.toEqual([]);

    const unsupportedSyncCalls = [
      () =>
        replay.insertTurn({
          ...localScope,
          session_id: sessionId,
          actor: 'user',
          role: 'user',
          content: 'nope',
        }),
      () => replay.insertTurns([]),
      () => replay.archiveTurn(activeTurn.id, 200, 1),
      () =>
        replay.insertWorkingMemory({
          ...localScope,
          session_id: sessionId,
          summary: 'x',
          key_entities: [],
          topic_tags: [],
          turn_id_start: 1,
          turn_id_end: 1,
          turn_count: 1,
          compaction_trigger: 'manual',
        }),
      () => replay.expireWorkingMemory(expiredWorking.id),
      () => replay.markWorkingMemoryPromoted(activeWorking.id, 1),
      () =>
        replay.insertKnowledgeMemory({
          ...localScope,
          fact: 'x',
          fact_type: 'reference',
          source: 'manual',
          confidence: 'high',
        }),
      () => replay.insertKnowledgeMemories([]),
      () => replay.insertKnowledgeCandidate({
        ...localScope,
        working_memory_id: activeWorking.id,
        fact: 'x',
        fact_type: 'reference',
        knowledge_class: 'project_fact',
        normalized_fact: 'x',
        confidence: 'high',
      }),
      () => replay.insertKnowledgeCandidates([]),
      () =>
        replay.insertKnowledgeEvidence({
          ...localScope,
          source_type: 'manual',
          support_polarity: 'supports',
          excerpt: 'x',
        }),
      () => replay.insertKnowledgeEvidenceBatch([]),
      () =>
        replay.insertKnowledgeMemoryAudit({
          ...localScope,
          fact: 'x',
          fact_type: 'reference',
          confidence: 'high',
          decision: 'created',
        }),
      () => replay.retireKnowledgeMemory(localKnowledge.id),
      () => replay.supersedeKnowledgeMemory(localKnowledge.id, workspaceKnowledge.id),
      () =>
        replay.insertWorkItem({
          ...localScope,
          kind: 'objective',
          title: 'x',
        }),
      () => replay.updateWorkItemStatus(localWorkItem.id, 'done'),
      () => replay.deleteWorkItem(localWorkItem.id),
      () => replay.upsertContextMonitor({
        ...localScope,
        compaction_state: 'idle',
        active_turn_count: 1,
        active_token_estimate: 1,
        compaction_score: 0,
      }),
      () => replay.insertCompactionLog({
        ...localScope,
        session_id: sessionId,
        trigger_type: 'manual',
        turn_id_start: 1,
        turn_id_end: 1,
        turns_compacted: 1,
        tokens_compacted_estimate: 1,
        working_memory_id: activeWorking.id,
        active_turn_count_before: 1,
        active_turn_count_after: 1,
        duration_ms: 1,
      }),
      () => replay.insertPlaybook({
        ...localScope,
        title: 'x',
        description: 'x',
        instructions: 'x',
      }),
      () => replay.updatePlaybook(acceptedPlaybook.id, { title: 'x' }),
      () => replay.recordPlaybookUse(acceptedPlaybook.id),
      () =>
        replay.insertPlaybookRevision({
          ...localScope,
          playbook_id: acceptedPlaybook.id,
          instructions: 'x',
          revision_reason: 'x',
        }),
      () =>
        replay.insertAssociation({
          ...localScope,
          source_kind: 'knowledge',
          source_id: localKnowledge.id,
          target_kind: 'playbook',
          target_id: acceptedPlaybook.id,
          association_type: 'related_to',
        }),
      () => replay.deleteAssociation(association.id),
      () =>
        replay.insertMemoryEvent({
          ...normalizeScope(localScope),
          entity_kind: 'turn',
          entity_id: '1',
          event_type: 'turn.created',
          payload: {},
        }),
      () => replay.upsertTemporalWatermark({ projection_name: 'temporal', last_event_id: '1' }),
    ];
    for (const call of unsupportedSyncCalls) {
      expect(call).toThrow('Temporal replay adapter does not support');
    }

    await expect(replay.getActiveTurnsPaginated(localScope, { limit: 1 })).rejects.toThrow(
      'Temporal replay adapter does not support getActiveTurnsPaginated',
    );
    await expect(replay.listMemoryEvents(localScope)).rejects.toThrow(
      'Temporal replay adapter does not support listMemoryEvents',
    );
    await expect(replay.listMemoryEventsCrossScope(localScope, 'scope')).rejects.toThrow(
      'Temporal replay adapter does not support listMemoryEventsCrossScope',
    );
    await expect(replay.getMemoryEventsByEntity(localScope, 'turn', '1')).rejects.toThrow(
      'Temporal replay adapter does not support getMemoryEventsByEntity',
    );
    await expect(replay.getMemoryEventsBySession(localScope, sessionId)).rejects.toThrow(
      'Temporal replay adapter does not support getMemoryEventsBySession',
    );
    await expect(
      replay.updateWorkItem(localWorkItem.id, { title: 'x' }),
    ).rejects.toThrow('Temporal replay adapter does not support updateWorkItem');
    await expect(
      replay.claimWorkItem({
        ...localScope,
        work_item_id: localWorkItem.id,
        actor: actor('alice'),
        visibility_class: 'private',
      }),
    ).rejects.toThrow('Temporal replay adapter does not support claimWorkItem');
    await expect(replay.renewWorkClaim(expiredClaim.id, actor('bob'))).rejects.toThrow(
      'Temporal replay adapter does not support renewWorkClaim',
    );
    await expect(replay.releaseWorkClaim(expiredClaim.id, actor('bob'))).rejects.toThrow(
      'Temporal replay adapter does not support releaseWorkClaim',
    );
    await expect(
      replay.createHandoff({
        ...localScope,
        work_item_id: localWorkItem.id,
        from_actor: actor('alice'),
        to_actor: actor('bob'),
        summary: 'x',
        visibility_class: 'private',
      }),
    ).rejects.toThrow('Temporal replay adapter does not support createHandoff');
    await expect(replay.acceptHandoff(pendingHandoff.id, actor('bob'))).rejects.toThrow(
      'Temporal replay adapter does not support acceptHandoff',
    );
    await expect(replay.rejectHandoff(pendingHandoff.id, actor('bob'))).rejects.toThrow(
      'Temporal replay adapter does not support rejectHandoff',
    );
    await expect(replay.cancelHandoff(pendingHandoff.id, actor('alice'))).rejects.toThrow(
      'Temporal replay adapter does not support cancelHandoff',
    );

    syncAdapter.close();
  });
});
