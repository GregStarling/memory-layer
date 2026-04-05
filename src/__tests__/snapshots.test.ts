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
    activeObjectives: [],
    activeState: ['topic:snapshots'],
    unresolvedWork: ['Keep output stable'],
    knowledgeSelectionReasons: [],
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
        "memory_search",
        "memory_search_cross_scope",
        "memory_learn_fact",
        "memory_track_work",
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
      ]
    `);
    await handler.close();
  });
});
