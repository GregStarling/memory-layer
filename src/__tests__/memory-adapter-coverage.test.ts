import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryAdapter } from '../adapters/memory/index.js';
import type { ActorRef } from '../contracts/coordination.js';
import { ConflictError } from '../contracts/errors.js';
import {
  normalizeScope,
  type MemoryScope,
} from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { UniqueConstraintError } from '../contracts/storage.js';
import { createSessionId } from '../core/tokens.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

function actor(actorId: string, actorKind: ActorRef['actor_kind'] = 'agent'): ActorRef {
  return {
    actor_kind: actorKind,
    actor_id: actorId,
    system_id: 'assistant',
    display_name: actorId,
    metadata: { team: 'memory' },
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('in-memory adapter coverage', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    adapter = createInMemoryAdapter();
  });

  afterEach(() => {
    adapter.close();
    vi.useRealTimers();
  });

  it('covers turns and working-memory lifecycle helpers', () => {
    const memoryScope = scope();
    const sessionId = createSessionId(memoryScope);
    const turns = adapter.insertTurns([
      {
        ...memoryScope,
        session_id: sessionId,
        actor: 'user-1',
        role: 'user',
        content: 'first turn',
        created_at: 100,
      },
      {
        ...memoryScope,
        session_id: sessionId,
        actor: 'assistant-1',
        role: 'assistant',
        content: 'second turn',
        created_at: 101,
      },
      {
        ...memoryScope,
        session_id: sessionId,
        actor: 'user-1',
        role: 'user',
        content: 'third turn',
        created_at: 102,
      },
    ]);

    expect(turns).toHaveLength(3);
    expect(adapter.getTurnById(turns[1].id)?.content).toBe('second turn');
    expect(adapter.getActiveTurnsPaginated(memoryScope, { limit: 2 })).toEqual({
      items: [turns[0], turns[1]],
      hasMore: true,
      nextCursor: turns[1].id,
    });

    adapter.archiveTurn(turns[0].id, 150, 7);
    expect(adapter.getActiveTurns(memoryScope, sessionId).map((turn) => turn.id)).toEqual([
      turns[1].id,
      turns[2].id,
    ]);
    expect(adapter.getArchivedTurnRange(sessionId, 1, 3, memoryScope).map((turn) => turn.id)).toEqual([
      turns[0].id,
    ]);

    const workingOne = adapter.insertWorkingMemory({
      ...memoryScope,
      session_id: sessionId,
      summary: 'Initial summary',
      key_entities: ['parser'],
      topic_tags: ['coverage'],
      turn_id_start: turns[0].id,
      turn_id_end: turns[1].id,
      turn_count: 2,
      compaction_trigger: 'manual',
      expires_at: nowSeconds() + 120,
    });
    vi.advanceTimersByTime(1000);
    const workingTwo = adapter.insertWorkingMemory({
      ...memoryScope,
      session_id: sessionId,
      summary: 'Latest summary',
      key_entities: ['adapter'],
      topic_tags: ['memory'],
      turn_id_start: turns[1].id,
      turn_id_end: turns[2].id,
      turn_count: 2,
      compaction_trigger: 'soft',
      expires_at: nowSeconds() + 300,
    });

    expect(adapter.getWorkingMemoryById(workingOne.id)?.summary).toBe('Initial summary');
    expect(adapter.getExistingWorkingMemoryIds([workingOne.id, 999, workingTwo.id, workingOne.id])).toEqual([
      workingOne.id,
      workingTwo.id,
    ]);
    expect(adapter.getWorkingMemoryBySession(sessionId, memoryScope).map((item) => item.id)).toEqual([
      workingOne.id,
      workingTwo.id,
    ]);
    expect(adapter.getActiveWorkingMemory(memoryScope, sessionId).map((item) => item.id)).toEqual([
      workingOne.id,
      workingTwo.id,
    ]);
    expect(adapter.getLatestWorkingMemory(memoryScope, sessionId)?.id).toBe(workingTwo.id);
    expect(
      adapter.getWorkingMemoryByTimeRange(memoryScope, {
        start_at: workingOne.created_at,
        end_at: workingTwo.created_at,
      }).map((item) => item.id),
    ).toEqual([workingOne.id, workingTwo.id]);

    adapter.markWorkingMemoryPromoted(workingOne.id, 55);
    expect(adapter.getWorkingMemoryById(workingOne.id)?.promoted_to_knowledge_id).toBe(55);

    adapter.expireWorkingMemory(workingTwo.id);
    expect(adapter.getWorkingMemoryById(workingTwo.id)?.expires_at).toBe(nowSeconds());

    const eventTypes = adapter
      .getMemoryEventsBySession(memoryScope, sessionId, { limit: 20 })
      .events.map((event) => event.event_type);
    expect(eventTypes).toContain('turn.archived');
    expect(eventTypes).toContain('working_memory.promoted');
    expect(eventTypes).toContain('working_memory.expired');
  });

  it('covers knowledge candidates, audits, and knowledge lifecycle helpers', () => {
    const localScope = scope();
    const workspaceA = scope({ workspace_id: 'shared', scope_id: 'thread-a' });
    const workspaceB = scope({ workspace_id: 'shared', scope_id: 'thread-b', system_id: 'reviewer' });
    const sessionId = createSessionId(localScope);
    const turn = adapter.insertTurn({
      ...localScope,
      session_id: sessionId,
      actor: 'user-1',
      role: 'user',
      content: 'Use sqlite for local development',
      created_at: 100,
    });
    const working = adapter.insertWorkingMemory({
      ...localScope,
      session_id: sessionId,
      summary: 'SQLite guidance',
      key_entities: ['sqlite'],
      topic_tags: ['database'],
      turn_id_start: turn.id,
      turn_id_end: turn.id,
      turn_count: 1,
      compaction_trigger: 'manual',
    });

    const [localKnowledge, provisionalKnowledge] = adapter.insertKnowledgeMemories([
      {
        ...localScope,
        fact: 'Use sqlite for local development',
        fact_type: 'reference',
        source: 'manual',
        confidence: 'high',
        trust_score: 0.95,
        knowledge_class: 'project_fact',
      },
      {
        ...localScope,
        fact: 'A provisional reminder',
        fact_type: 'decision',
        source: 'manual',
        confidence: 'medium',
        trust_score: 0.4,
        knowledge_state: 'provisional',
        knowledge_class: 'strategy',
      },
    ]);
    vi.advanceTimersByTime(1000);
    const workspaceKnowledge = adapter.insertKnowledgeMemory({
      ...workspaceA,
      visibility_class: 'workspace',
      fact: 'Shared workspace fact',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.8,
      knowledge_class: 'project_fact',
    });
    vi.advanceTimersByTime(1000);
    const supersededKnowledge = adapter.insertKnowledgeMemory({
      ...localScope,
      fact: 'Legacy deployment rule',
      fact_type: 'decision',
      source: 'manual',
      confidence: 'high',
      knowledge_class: 'procedure',
    });
    const replacementKnowledge = adapter.insertKnowledgeMemory({
      ...localScope,
      fact: 'Current deployment rule',
      fact_type: 'decision',
      source: 'manual',
      confidence: 'high',
      knowledge_class: 'procedure',
    });
    adapter.supersedeKnowledgeMemory(supersededKnowledge.id, replacementKnowledge.id);

    const candidate = adapter.insertKnowledgeCandidates([
      {
        ...localScope,
        working_memory_id: working.id,
        fact: 'Use sqlite for local development',
        fact_type: 'reference',
        knowledge_class: 'project_fact',
        normalized_fact: 'use sqlite for local development',
        confidence: 'high',
        evidence_count: 1,
        trust_score: 0.7,
      },
    ])[0];

    const evidenceBatch = adapter.insertKnowledgeEvidenceBatch([
      {
        ...localScope,
        knowledge_candidate_id: candidate.id,
        working_memory_id: working.id,
        turn_id: turn.id,
        source_type: 'user_turn',
        support_polarity: 'supports',
        speaker_role: 'user',
        actor: 'user-1',
        excerpt: 'Use sqlite for local development',
        is_explicit: true,
        explicitness_score: 1,
      },
      {
        ...localScope,
        knowledge_memory_id: localKnowledge.id,
        working_memory_id: working.id,
        turn_id: turn.id,
        source_type: 'manual',
        support_polarity: 'supports',
        excerpt: 'SQLite is the local default',
      },
    ]);
    const promoted = adapter.promoteKnowledgeCandidate(candidate.id, {
      ...localScope,
      fact: candidate.fact,
      fact_type: candidate.fact_type,
      knowledge_class: candidate.knowledge_class,
      knowledge_state: 'trusted',
      normalized_fact: candidate.normalized_fact,
      source: 'promoted_from_working',
      confidence: candidate.confidence,
      grounding_strength: 'strong',
      evidence_count: 2,
      trust_score: 0.85,
      source_working_memory_id: working.id,
      source_turn_ids: [turn.id],
    });

    expect(adapter.getKnowledgeCandidateById(candidate.id)?.promoted_knowledge_id).toBe(promoted.id);
    expect(adapter.listKnowledgeCandidates(localScope, { state: ['provisional'] }).map((item) => item.id)).toEqual([
      candidate.id,
    ]);
    expect(adapter.listKnowledgeEvidenceForCandidate(candidate.id).map((item) => item.id)).toEqual([
      evidenceBatch[0].id,
    ]);
    expect(adapter.listKnowledgeEvidenceForKnowledge(localKnowledge.id).map((item) => item.id)).toEqual([
      evidenceBatch[1].id,
    ]);

    expect(adapter.getExistingKnowledgeMemoryIds([promoted.id, 404, localKnowledge.id, promoted.id])).toEqual([
      promoted.id,
      localKnowledge.id,
    ]);
    expect(adapter.getActiveKnowledgeMemory(localScope).map((item) => item.id)).toEqual(
      expect.arrayContaining([localKnowledge.id, provisionalKnowledge.id, replacementKnowledge.id, promoted.id]),
    );
    expect(adapter.getActiveKnowledgeMemory(localScope).map((item) => item.id)).not.toContain(supersededKnowledge.id);
    expect(adapter.getActiveKnowledgeMemoryPaginated(localScope, { limit: 2 })).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(Number),
    });
    expect(
      adapter
        .getActiveKnowledgeCrossScope(workspaceB, 'workspace')
        .map((item) => item.id),
    ).toContain(workspaceKnowledge.id);
    expect(
      adapter.getKnowledgeSince(workspaceB, 'workspace', workspaceKnowledge.created_at).map((item) => item.id),
    ).toContain(workspaceKnowledge.id);
    expect(
      adapter.searchKnowledge(localScope, 'sqlite', {
        includeProvisional: true,
        minimumTrustScore: 0.5,
        knowledgeStates: ['trusted', 'provisional'],
        knowledgeClasses: ['project_fact', 'strategy'],
      }).map((entry) => entry.item.id),
    ).toEqual(expect.arrayContaining([localKnowledge.id, promoted.id]));
    expect(
      adapter.searchKnowledgeCrossScope(workspaceB, 'workspace', 'shared workspace', {
        knowledgeClasses: ['project_fact'],
      })[0]?.item.id,
    ).toBe(workspaceKnowledge.id);
    expect(
      adapter
        .getKnowledgeByTimeRange(localScope, { start_at: localKnowledge.created_at, end_at: promoted.created_at })
        .map((item) => item.id),
    ).toContain(promoted.id);

    const firstAudit = adapter.insertKnowledgeMemoryAudit({
      ...localScope,
      working_memory_id: working.id,
      fact: 'Use sqlite for local development',
      fact_type: 'reference',
      confidence: 'high',
      decision: 'created',
      created_knowledge_id: localKnowledge.id,
      detail: 'Initial audit',
      created_at: 120,
    });
    const secondAudit = adapter.insertKnowledgeMemoryAudit({
      ...localScope,
      working_memory_id: working.id,
      fact: 'Use sqlite for local development',
      fact_type: 'reference',
      confidence: 'high',
      decision: 'updated',
      related_knowledge_id: promoted.id,
      detail: 'Follow-up audit',
      created_at: 121,
    });
    expect(adapter.getRecentKnowledgeMemoryAudits(localScope, 1)[0]?.id).toBe(secondAudit.id);
    expect(adapter.getKnowledgeMemoryAuditsForKnowledge(localScope, promoted.id, 5)[0]?.id).toBe(secondAudit.id);
    expect(adapter.getKnowledgeMemoryAuditsForKnowledge(localScope, localKnowledge.id, 5)[0]?.id).toBe(firstAudit.id);

    vi.advanceTimersByTime(1000);
    const updated = adapter.updateKnowledgeMemory(localKnowledge.id, {
      verification_status: 'verified',
      verification_notes: 'checked in docs',
      trust_score: 0.99,
      successful_use_count: 3,
      failed_use_count: 1,
      last_confirmed_at: nowSeconds(),
      confirmation_count: 4,
      contradiction_score: 0.1,
    });
    expect(updated).toMatchObject({
      verification_status: 'verified',
      trust_score: 0.99,
      successful_use_count: 3,
      failed_use_count: 1,
      confirmation_count: 4,
    });

    const accessCountBefore = adapter.getKnowledgeMemoryById(localKnowledge.id)?.access_count ?? 0;
    adapter.touchKnowledgeMemory(localKnowledge.id);
    adapter.touchKnowledgeMemories([workspaceKnowledge.id, workspaceKnowledge.id, 0, -1]);
    expect(adapter.getKnowledgeMemoryById(localKnowledge.id)?.access_count).toBe(accessCountBefore + 1);
    expect(adapter.getKnowledgeMemoryById(workspaceKnowledge.id)?.access_count).toBe(2);

    adapter.retireKnowledgeMemory(promoted.id, 500);
    expect(adapter.getKnowledgeMemoryById(promoted.id)?.retired_at).toBe(500);
    expect(adapter.getKnowledgeMemoryById(supersededKnowledge.id)).toMatchObject({
      superseded_by_id: replacementKnowledge.id,
      knowledge_state: 'superseded',
    });
  });

  it('covers work-item versioning, claims, expiration, and deletion', () => {
    const localScope = scope();
    const workspaceLocal = scope({ workspace_id: 'shared', scope_id: 'mine' });
    const workspacePeer = scope({ workspace_id: 'shared', scope_id: 'peer', system_id: 'reviewer' });
    const sessionId = createSessionId(localScope);
    const alice = actor('alice');
    const bob = actor('bob');

    const localItem = adapter.insertWorkItem({
      ...localScope,
      session_id: sessionId,
      kind: 'objective',
      title: 'Ship parser coverage',
      created_at: 100,
    });
    const crossScopeItem = adapter.insertWorkItem({
      ...workspacePeer,
      session_id: 'peer-session',
      visibility_class: 'workspace',
      kind: 'unresolved_work',
      title: 'Shared blocker',
      status: 'blocked',
      created_at: 110,
    });
    const doneItem = adapter.insertWorkItem({
      ...localScope,
      session_id: sessionId,
      kind: 'constraint',
      title: 'Already done',
      status: 'done',
      created_at: 120,
    });

    const cloned = adapter.getWorkItemById(localItem.id);
    expect(cloned).not.toBeNull();
    if (cloned) {
      cloned.title = 'mutated';
    }
    expect(adapter.getWorkItemById(localItem.id)?.title).toBe('Ship parser coverage');
    expect(adapter.getExistingWorkItemIds([crossScopeItem.id, 404, localItem.id, crossScopeItem.id])).toEqual([
      crossScopeItem.id,
      localItem.id,
    ]);
    expect(adapter.getActiveWorkItems(localScope).map((item) => item.id)).toEqual([localItem.id]);
    expect(adapter.getActiveWorkItemsCrossScope(workspaceLocal, 'workspace').map((item) => item.id)).toContain(
      crossScopeItem.id,
    );
    expect(
      adapter
        .getWorkItemsByTimeRange(localScope, { start_at: 99, end_at: 105 })
        .map((item) => item.id),
    ).toEqual([localItem.id]);
    expect(
      adapter
        .getWorkItemsByTimeRangeCrossScope(workspaceLocal, 'workspace', { start_at: 109, end_at: 111 })
        .map((item) => item.id),
    ).toEqual([crossScopeItem.id]);

    adapter.updateWorkItemStatus(localItem.id, 'in_progress');
    expect(adapter.getWorkItemById(localItem.id)?.status).toBe('in_progress');
    expect(() =>
      adapter.updateWorkItem(localItem.id, { title: 'Wrong version' }, { expectedVersion: 1 }),
    ).toThrow(ConflictError);

    const visibilityUpdate = adapter.updateWorkItem(
      localItem.id,
      { visibility_class: 'shared_collaboration' },
      { expectedVersion: 2 },
    );
    expect(visibilityUpdate?.visibility_class).toBe('shared_collaboration');

    const finalUpdate = adapter.updateWorkItem(
      localItem.id,
      { title: 'Ship parser coverage now', detail: 'Needs release checks', status: 'blocked' },
      { expectedVersion: 3 },
    );
    expect(finalUpdate).toMatchObject({
      title: 'Ship parser coverage now',
      detail: 'Needs release checks',
      status: 'blocked',
    });

    expect(() =>
      adapter.claimWorkItem({
        ...localScope,
        work_item_id: doneItem.id,
        actor: alice,
        visibility_class: 'private',
      }),
    ).toThrow(ConflictError);

    const claimedAt = nowSeconds();
    const claim = adapter.claimWorkItem({
      ...localScope,
      work_item_id: localItem.id,
      actor: alice,
      session_id: sessionId,
      visibility_class: 'private',
      lease_seconds: 60,
      claimed_at: claimedAt,
    });
    const autoRenewed = adapter.claimWorkItem({
      ...localScope,
      work_item_id: localItem.id,
      actor: alice,
      session_id: sessionId,
      visibility_class: 'private',
      lease_seconds: 30,
      claimed_at: claimedAt + 5,
    });
    expect(autoRenewed.id).toBe(claim.id);
    expect(autoRenewed.expires_at).toBeGreaterThan(claim.expires_at);

    expect(() => adapter.renewWorkClaim(claim.id, bob, 30)).toThrow(ConflictError);
    const renewed = adapter.renewWorkClaim(claim.id, alice, 45);
    expect(renewed?.expires_at).toBeGreaterThan(autoRenewed.expires_at);
    expect(() => adapter.releaseWorkClaim(claim.id, bob, 'nope')).toThrow(ConflictError);
    expect(adapter.releaseWorkClaim(claim.id, alice, 'done')?.status).toBe('released');

    const expiringItem = adapter.insertWorkItem({
      ...localScope,
      session_id: sessionId,
      kind: 'objective',
      title: 'Expiring claim',
      created_at: 130,
    });
    const expiringClaim = adapter.claimWorkItem({
      ...localScope,
      work_item_id: expiringItem.id,
      actor: alice,
      session_id: sessionId,
      visibility_class: 'private',
      lease_seconds: 1,
      claimed_at: nowSeconds() - 10,
    });
    expect(adapter.getActiveWorkClaim(expiringItem.id)).toBeNull();
    expect(
      adapter.listWorkClaims(localScope, { includeExpired: true, includeReleased: true }).find((item) => item.id === expiringClaim.id),
    ).toMatchObject({
      status: 'expired',
      release_reason: 'expired',
    });

    const crossScopeClaim = adapter.claimWorkItem({
      ...workspacePeer,
      work_item_id: crossScopeItem.id,
      actor: bob,
      session_id: 'peer-session',
      visibility_class: 'workspace',
      lease_seconds: 30,
      claimed_at: 300,
    });
    expect(
      adapter.listWorkClaims(localScope, { includeExpired: true, includeReleased: true }).map((item) => item.id),
    ).toEqual(expect.arrayContaining([claim.id, expiringClaim.id]));
    expect(
      adapter
        .listWorkClaimsCrossScope(workspaceLocal, 'workspace', {
          includeExpired: true,
          includeReleased: true,
          actor: { actor_kind: bob.actor_kind, actor_id: bob.actor_id },
          visibilityClass: 'workspace',
          sessionId: 'peer-session',
        })
        .map((item) => item.id),
    ).toEqual([crossScopeClaim.id]);

    adapter.deleteWorkItem(localItem.id);
    expect(adapter.getWorkItemById(localItem.id)).toBeNull();
    const eventTypes = adapter
      .getMemoryEventsByEntity(localScope, 'work_item', String(localItem.id), { limit: 20 })
      .events.map((event) => event.event_type);
    expect(eventTypes).toContain('work_item.visibility_changed');
    expect(eventTypes).toContain('work_item.deleted');
  });

  it('covers handoffs, context monitors, compaction logs, playbooks, associations, and projections', () => {
    const localScope = scope();
    const workspaceLocal = scope({ workspace_id: 'shared', scope_id: 'mine' });
    const workspacePeer = scope({ workspace_id: 'shared', scope_id: 'peer', system_id: 'reviewer' });
    const sessionId = createSessionId(localScope);
    const fromActor = actor('from-agent');
    const toActor = actor('to-agent');
    const outsider = actor('outsider');

    const transferableItem = adapter.insertWorkItem({
      ...localScope,
      session_id: sessionId,
      kind: 'objective',
      title: 'Transfer ownership',
    });
    adapter.claimWorkItem({
      ...localScope,
      work_item_id: transferableItem.id,
      actor: fromActor,
      session_id: sessionId,
      visibility_class: 'shared_collaboration',
      lease_seconds: 120,
      claimed_at: 500,
    });

    const acceptedHandoff = adapter.createHandoff({
      ...localScope,
      work_item_id: transferableItem.id,
      from_actor: fromActor,
      to_actor: toActor,
      session_id: sessionId,
      summary: 'Take over release work',
      visibility_class: 'shared_collaboration',
      expires_at: nowSeconds() + 300,
      created_at: nowSeconds(),
    });
    expect(
      adapter.listHandoffs(localScope, {
        actor: { actor_kind: toActor.actor_kind, actor_id: toActor.actor_id },
        direction: 'inbound',
        statuses: ['pending'],
        sessionId,
      }).map((item) => item.id),
    ).toEqual([acceptedHandoff.id]);
    expect(() => adapter.acceptHandoff(acceptedHandoff.id, outsider, 'steal')).toThrow(ConflictError);
    expect(adapter.acceptHandoff(acceptedHandoff.id, toActor, 'picked up')?.status).toBe('accepted');
    expect(adapter.getActiveWorkClaim(transferableItem.id)?.actor.actor_id).toBe(toActor.actor_id);

    const rejectedItem = adapter.insertWorkItem({
      ...localScope,
      session_id: sessionId,
      kind: 'unresolved_work',
      title: 'Reject this handoff',
    });
    const rejectedHandoff = adapter.createHandoff({
      ...localScope,
      work_item_id: rejectedItem.id,
      from_actor: fromActor,
      to_actor: toActor,
      session_id: sessionId,
      summary: 'Please reject',
      visibility_class: 'private',
      created_at: nowSeconds(),
    });
    expect(adapter.rejectHandoff(rejectedHandoff.id, toActor, 'too busy')?.status).toBe('rejected');

    const canceledItem = adapter.insertWorkItem({
      ...localScope,
      session_id: sessionId,
      kind: 'constraint',
      title: 'Cancel this handoff',
    });
    const canceledHandoff = adapter.createHandoff({
      ...localScope,
      work_item_id: canceledItem.id,
      from_actor: fromActor,
      to_actor: toActor,
      session_id: sessionId,
      summary: 'Will cancel',
      visibility_class: 'private',
      created_at: nowSeconds(),
    });
    expect(adapter.cancelHandoff(canceledHandoff.id, fromActor, 'not needed')?.status).toBe('canceled');

    const expiredItem = adapter.insertWorkItem({
      ...workspacePeer,
      session_id: 'peer-session',
      kind: 'objective',
      title: 'Expired handoff item',
    });
    const expiredHandoff = adapter.createHandoff({
      ...workspacePeer,
      work_item_id: expiredItem.id,
      from_actor: fromActor,
      to_actor: toActor,
      session_id: 'peer-session',
      summary: 'Too late',
      visibility_class: 'workspace',
      expires_at: nowSeconds() - 1,
      created_at: nowSeconds() - 10,
    });
    expect(adapter.acceptHandoff(expiredHandoff.id, toActor, 'late')).toBeNull();
    expect(
      adapter
        .listHandoffsCrossScope(workspaceLocal, 'workspace', {
          actor: { actor_kind: toActor.actor_kind, actor_id: toActor.actor_id },
          statuses: ['expired'],
        })
        .map((item) => item.id),
    ).toContain(expiredHandoff.id);

    const createdMonitor = adapter.upsertContextMonitor({
      ...localScope,
      compaction_state: 'idle',
      active_turn_count: 2,
      active_token_estimate: 120,
      compaction_score: 0.1,
    });
    const updatedMonitor = adapter.upsertContextMonitor({
      ...localScope,
      compaction_state: 'soft_triggered',
      last_compaction_at: 700,
      active_turn_count: 4,
      active_token_estimate: 250,
      compaction_score: 0.9,
    });
    expect(createdMonitor.id).toBe(updatedMonitor.id);
    expect(adapter.getContextMonitor(localScope)).toMatchObject({
      compaction_state: 'soft_triggered',
      active_turn_count: 4,
    });

    const compactionLog = adapter.insertCompactionLog({
      ...localScope,
      session_id: sessionId,
      trigger_type: 'hard',
      turn_id_start: 1,
      turn_id_end: 4,
      turns_compacted: 4,
      tokens_compacted_estimate: 500,
      working_memory_id: 1,
      active_turn_count_before: 4,
      active_turn_count_after: 1,
      duration_ms: 250,
      model_call_made: false,
      error: 'dry run',
      created_at: 710,
    });
    expect(adapter.getCompactionLogById(compactionLog.id)?.error).toBe('dry run');
    expect(adapter.getRecentCompactionLogs(localScope, 1)[0]?.id).toBe(compactionLog.id);

    const playbook = adapter.insertPlaybook({
      ...localScope,
      title: 'Deploy service',
      description: 'Deployment procedure',
      instructions: 'Run deploy.sh',
      references: ['README.md'],
      templates: ['release.md'],
      scripts: ['deploy.sh'],
      assets: ['logo.svg'],
      tags: ['deploy'],
      status: 'active',
      source_session_id: sessionId,
      created_at: 720,
    });
    const archivedPlaybook = adapter.insertPlaybook({
      ...workspacePeer,
      visibility_class: 'workspace',
      title: 'Shared archived guide',
      description: 'Shared guide',
      instructions: 'Read docs',
      status: 'archived',
      created_at: 721,
    });
    expect(adapter.getPlaybookById(playbook.id)?.title).toBe('Deploy service');
    expect(adapter.getExistingPlaybookIds([playbook.id, 404, archivedPlaybook.id])).toEqual([
      playbook.id,
      archivedPlaybook.id,
    ]);
    expect(adapter.getActivePlaybooks(localScope).map((item) => item.id)).toEqual([playbook.id]);
    expect(
      adapter
        .getActivePlaybooksCrossScope(workspaceLocal, 'workspace')
        .map((item) => item.id),
    ).not.toContain(archivedPlaybook.id);
    expect(adapter.searchPlaybooks(localScope, 'deploy service')[0]?.item.id).toBe(playbook.id);
    expect(
      adapter.searchPlaybooksCrossScope(workspaceLocal, 'workspace', 'shared guide', { activeOnly: false })[0]?.item.id,
    ).toBe(archivedPlaybook.id);

    const updatedPlaybook = adapter.updatePlaybook(playbook.id, {
      title: 'Deploy service safely',
      description: 'Updated procedure',
      instructions: 'Run checks then deploy',
      tags: ['deploy', 'safe'],
    });
    expect(updatedPlaybook?.title).toBe('Deploy service safely');
    adapter.recordPlaybookUse(playbook.id);
    expect(adapter.getPlaybookById(playbook.id)?.use_count).toBe(1);
    const revision = adapter.insertPlaybookRevision({
      ...localScope,
      playbook_id: playbook.id,
      instructions: 'Original instructions',
      revision_reason: 'clarified steps',
      source_session_id: sessionId,
      created_at: 730,
    });
    expect(adapter.getPlaybookRevisions(playbook.id)[0]).toMatchObject({ id: revision.id });
    expect(() =>
      adapter.insertPlaybookRevision({
        ...localScope,
        playbook_id: 999,
        instructions: 'missing',
        revision_reason: 'missing',
      }),
    ).toThrow('Playbook 999 not found');

    const association = adapter.insertAssociation({
      ...localScope,
      source_kind: 'playbook',
      source_id: playbook.id,
      target_kind: 'work_item',
      target_id: transferableItem.id,
      association_type: 'applies_to',
      confidence: 0.9,
    });
    expect(() =>
      adapter.insertAssociation({
        ...localScope,
        source_kind: 'playbook',
        source_id: playbook.id,
        target_kind: 'work_item',
        target_id: transferableItem.id,
        association_type: 'applies_to',
      }),
    ).toThrow(UniqueConstraintError);
    expect(adapter.getAssociationById(association.id)?.association_type).toBe('applies_to');
    expect(adapter.getAssociationsFrom('playbook', playbook.id, localScope).map((item) => item.id)).toEqual([
      association.id,
    ]);
    expect(adapter.getAssociationsTo('work_item', transferableItem.id, localScope).map((item) => item.id)).toEqual([
      association.id,
    ]);
    expect(adapter.listAssociations(localScope).map((item) => item.id)).toEqual([association.id]);
    adapter.deleteAssociation(association.id);
    expect(adapter.getAssociationById(association.id)).toBeNull();

    const manualEvent = adapter.insertMemoryEvent({
      ...localScope,
      session_id: sessionId,
      entity_kind: 'session_state',
      entity_id: sessionId,
      event_type: 'session_state.seeded',
      payload: { after: { seeded: true } },
      created_at: 740,
    });
    expect(adapter.listMemoryEvents(localScope, { limit: 1 }).nextCursor).not.toBeNull();
    expect(
      adapter
        .listMemoryEvents(localScope, { cursor: manualEvent.event_id, limit: 50 })
        .events.every((event) => Number(event.event_id) > Number(manualEvent.event_id)),
    ).toBe(true);
    expect(
      adapter
        .listMemoryEventsCrossScope(workspaceLocal, 'workspace', { limit: 100 })
        .events.some((event) => event.entity_kind === 'handoff'),
    ).toBe(true);

    const sessionState = adapter.upsertSessionState({
      ...normalizeScope(localScope),
      session_id: sessionId,
      currentObjective: 'Raise coverage',
      blockers: ['time'],
      assumptions: ['tests stay deterministic'],
      pendingDecisions: ['publish'],
      activeTools: ['vitest'],
      recentOutputs: ['coverage report'],
      updatedAt: 750,
      source_event_id: manualEvent.event_id,
    });
    expect(adapter.getSessionState(localScope, sessionId)).toEqual(sessionState);

    const updatedWatermark = adapter.upsertTemporalWatermark({
      projection_name: 'custom',
      last_event_id: 99,
      updated_at: 751,
      cutover_at: 700,
      metadata: { source: 'test' },
    });
    expect(updatedWatermark.last_event_id).toBe('99');
    expect(adapter.getTemporalWatermark('custom')).toEqual(updatedWatermark);
    expect(adapter.transaction(() => 'committed')).toBe('committed');
  });
});
