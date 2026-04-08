import { describe, expect, it } from 'vitest';

import { formatContextForPrompt } from '../core/formatter.js';
import { createMcpServerHandler } from '../server/mcp-server.js';
import type { MemoryContext } from '../core/context.js';

function makeSnapshotContext(): MemoryContext {
  return {
    mode: 'coding',
    activeTurns: [],
    workingMemory: null,
    trustedCoreMemory: [],
    taskRelevantKnowledge: [],
    provisionalKnowledge: [],
    disputedKnowledge: [],
    relevantKnowledge: [],
    durableKnowledge: [],
    recentSummaries: [],
    currentObjective: 'Ship snapshots',
    sessionState: {
      currentObjective: 'Ship snapshots',
      blockers: ['Keep output stable'],
      assumptions: [],
      pendingDecisions: [],
      activeTools: [],
      recentOutputs: [],
      updatedAt: 42,
    },
    activeObjectives: [],
    activeState: ['topic:snapshots'],
    associatedKnowledge: [],
    unresolvedWork: ['Keep output stable'],
    knowledgeSelectionReasons: [],
    debugTrace: {
      scope: {
        normalizedScope: {
          tenant_id: 'default',
          system_id: 'default',
          workspace_id: '',
          collaboration_id: '',
          scope_id: 'thread-1',
        },
        scopeSource: 'local',
        scopeLevel: 'scope',
        asOf: null,
      },
      selectedKnowledge: [],
      excludedKnowledge: [],
      associationExpansion: {
        seedKnowledgeIds: [],
        candidateKnowledgeIds: [],
        includedKnowledgeIds: [],
        truncatedKnowledgeIds: [],
        maxSeedKnowledgeItems: 8,
        maxAssociatedKnowledgeItems: 12,
      },
      tokenTrimming: {
        initialTokenEstimate: 42,
        finalTokenEstimate: 42,
        droppedInvariantIds: [],
        droppedTurnIds: [],
        droppedSummaryIds: [],
        droppedPlaybookIds: [],
        droppedAssociatedKnowledgeIds: [],
        droppedKnowledgeIds: [],
      },
    },
    tokenEstimate: 42,
  };
}

describe('stable snapshots', () => {
  it('keeps prompt formatting stable', () => {
    expect(formatContextForPrompt(makeSnapshotContext())).toMatchInlineSnapshot(`
      "Mode:
      coding

      Current Objective:
      Ship snapshots

      Session State:
      Objective: Ship snapshots
      Blockers: Keep output stable
      Assumptions: None
      Pending Decisions: None
      Active Tools: None
      Recent Outputs: None

      Active State:
      - topic:snapshots

      Active Objectives:
      - None

      Trusted Core Memory:
      - None

      Task Relevant Knowledge:
      - None

      Unresolved Work:
      - Keep output stable

      Recent Summaries:
      - None

      Relevant Playbooks:
      - None"
    `);
  });

  it('keeps MCP tool names stable', async () => {
    const handler = createMcpServerHandler();
    expect(handler.tools.map((tool) => tool.name)).toMatchInlineSnapshot(`
      [
        "memory_store_turn",
        "memory_store_exchange",
        "memory_get_context",
        "memory_get_state_at",
        "memory_request_context",
        "memory_get_context_config",
        "memory_set_default_context_contract",
        "memory_put_context_contract",
        "memory_delete_context_contract",
        "memory_put_context_invariant",
        "memory_delete_context_invariant",
        "memory_set_context_escalation_policy",
        "memory_get_timeline",
        "memory_diff_state",
        "memory_list_events",
        "memory_search",
        "memory_search_cross_scope",
        "memory_learn_fact",
        "memory_track_work",
        "memory_update_work_item",
        "memory_claim_work_item",
        "memory_renew_work_claim",
        "memory_release_work_claim",
        "memory_list_work_claims",
        "memory_handoff_work_item",
        "memory_accept_handoff",
        "memory_reject_handoff",
        "memory_cancel_handoff",
        "memory_list_pending_handoffs",
        "memory_stream_changes",
        "memory_force_compact",
        "memory_get_health",
        "memory_run_maintenance",
        "memory_search_episodes",
        "memory_summarize_episode",
        "memory_reflect",
        "memory_search_cognitive",
        "memory_get_profile",
        "memory_create_playbook",
        "memory_search_playbooks",
        "memory_revise_playbook",
        "memory_create_playbook_from_task",
        "memory_use_playbook",
        "memory_get_associations",
        "memory_add_association",
        "memory_remove_association",
        "memory_snapshot",
        "memory_discover",
        "memory_get_report",
        "memory_get_facts_at",
        "memory_reflect_knowledge",
        "memory_derive",
        "memory_get_curation",
        "memory_get_core_memory",
        "memory_set_aliases",
        "memory_get_aliases",
        "memory_get_alias_candidates",
        "memory_set_ontology",
        "memory_get_ontology",
        "memory_export_bundle",
        "memory_import_bundle",
        "memory_refresh_documents",
      ]
    `);
    await handler.close();
  });
});
