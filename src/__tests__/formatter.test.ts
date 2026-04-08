import { describe, expect, it } from 'vitest';

import {
  formatBootstrapForPrompt,
  formatContextAsMessages,
  formatContextForPrompt,
} from '../core/formatter.js';
import type { MemoryContext } from '../core/context.js';

function makeContext(): MemoryContext {
  const relevantKnowledge = [
    {
      id: 1,
      tenant_id: 'acme',
      system_id: 'assistant',
      workspace_id: 'default',
      collaboration_id: '',
      scope_id: 'thread-1',
      fact: 'The project uses sqlite',
      fact_type: 'reference' as const,
      knowledge_state: 'trusted' as const,
      knowledge_class: 'project_fact' as const,
      fact_subject: 'project',
      fact_attribute: 'reference',
      fact_value: 'sqlite',
      normalized_fact: 'the project uses sqlite',
      slot_key: 'project:reference:database',
      is_negated: false,
      source: 'manual' as const,
      confidence: 'high' as const,
      confidence_score: 0.92,
      grounding_strength: 'strong' as const,
      evidence_count: 2,
      trust_score: 0.92,
      verification_status: 'verified' as const,
      verification_notes: 'Confirmed by repeated usage',
      last_verified_at: 1,
      source_working_memory_id: null,
      source_turn_ids: [1, 2],
      successful_use_count: 0,
      failed_use_count: 0,
      disputed_at: null,
      dispute_reason: null,
      contradiction_score: 0,
      superseded_at: null,
      superseded_by_id: null,
      retired_at: null,
      created_at: 1,
      last_accessed_at: 1,
      access_count: 1,
      schema_version: 1,
    },
  ];

  return {
    mode: 'coding',
    activeTurns: [],
    workingMemory: null,
    trustedCoreMemory: relevantKnowledge,
    taskRelevantKnowledge: [],
    provisionalKnowledge: [],
    disputedKnowledge: [],
    relevantKnowledge,
    durableKnowledge: relevantKnowledge,
    recentSummaries: [],
    currentObjective: 'Ship the memory layer',
    sessionState: {
      currentObjective: 'Ship the memory layer',
      blockers: ['Need to add prompt formatter'],
      assumptions: [],
      pendingDecisions: [],
      activeTools: [],
      recentOutputs: [],
      updatedAt: 1,
    },
    activeObjectives: [],
    activeState: ['topic:memory'],
    associatedKnowledge: [],
    invariants: [],
    warnings: [],
    degradedContext: {
      isDegraded: false,
      droppedInvariantIds: [],
      droppedKnowledgeIds: [],
      droppedSummaryIds: [],
      droppedPlaybookIds: [],
      droppedAssociatedKnowledgeIds: [],
    },
    unresolvedWork: ['Need to add prompt formatter'],
    knowledgeSelectionReasons: [],
    debugTrace: {
      scope: {
        normalizedScope: {
          tenant_id: 'acme',
          system_id: 'assistant',
          workspace_id: 'default',
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
        initialTokenEstimate: 100,
        finalTokenEstimate: 100,
        droppedInvariantIds: [],
        droppedTurnIds: [],
        droppedSummaryIds: [],
        droppedPlaybookIds: [],
        droppedAssociatedKnowledgeIds: [],
        droppedKnowledgeIds: [],
      },
    },
    tokenEstimate: 100,
  };
}

describe('formatter helpers', () => {
  it('formats context into prompt text', () => {
    const text = formatContextForPrompt(makeContext());
    expect(text).toContain('Trusted Core Memory');
    expect(text).toContain('Ship the memory layer');
  });

  it('formats bootstrap prompt text', () => {
    const text = formatBootstrapForPrompt({
      currentObjective: 'Resume the memory project',
      sessionState: makeContext().sessionState,
      workingMemory: null,
      relevantKnowledge: makeContext().relevantKnowledge,
      recentSummaries: [],
      activeObjectives: [],
      unresolvedWork: ['Review retrieval quality'],
    });
    expect(text).toContain('Bootstrap Objective');
    expect(text).toContain('Resume the memory project');
  });

  it('renders system message payloads', () => {
    const messages = formatContextAsMessages(makeContext(), { includeCitations: true });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('[memory:1]');
  });

  it('can include trust metadata in formatted knowledge', () => {
    const text = formatContextForPrompt(makeContext(), { includeTrustMetadata: true });
    expect(text).toContain('confidence=high');
    expect(text).toContain('status=verified');
    expect(text).toContain('state=trusted');
  });

  it('renders injected safety invariants in the prompt', () => {
    const context = makeContext();
    context.invariants = [
      {
        id: 'prod-data',
        title: 'Production data safety',
        instruction: 'Never delete production data without explicit approval.',
        severity: 'critical',
        scopeLevel: 'workspace',
      },
    ];

    const text = formatContextForPrompt(context);
    expect(text).toContain('Safety Invariants');
    expect(text).toContain('Production data safety');
    expect(text).toContain('Never delete production data without explicit approval.');
  });

  it('renders context warnings when the context is degraded', () => {
    const context = makeContext();
    context.warnings = [
      {
        code: 'invariants_trimmed',
        severity: 'warning',
        message: 'Some lower-priority invariants were omitted to fit the token budget.',
      },
    ];
    context.degradedContext = {
      isDegraded: true,
      droppedInvariantIds: ['style'],
      droppedKnowledgeIds: [],
      droppedSummaryIds: [],
      droppedPlaybookIds: [],
      droppedAssociatedKnowledgeIds: [],
    };

    const text = formatContextForPrompt(context);
    expect(text).toContain('Context Warnings');
    expect(text).toContain('Some lower-priority invariants were omitted');
  });

  it('appends temporal qualifier for fact with valid_from', () => {
    const ctx = makeContext();
    // epoch for 2025-03-01 UTC
    const march1 = Math.floor(Date.UTC(2025, 2, 1) / 1000);
    (ctx.trustedCoreMemory[0] as Record<string, unknown>).valid_from = march1;
    (ctx.trustedCoreMemory[0] as Record<string, unknown>).valid_until = null;
    const text = formatContextForPrompt(ctx);
    expect(text).toContain('In effect starting 2025-03-01');
  });

  it('appends temporal qualifier for fact with valid_until', () => {
    const ctx = makeContext();
    const dec31 = Math.floor(Date.UTC(2025, 11, 31) / 1000);
    (ctx.trustedCoreMemory[0] as Record<string, unknown>).valid_from = null;
    (ctx.trustedCoreMemory[0] as Record<string, unknown>).valid_until = dec31;
    const text = formatContextForPrompt(ctx);
    expect(text).toContain('Valid until 2025-12-31');
  });

  it('appends temporal qualifier for fact with both valid_from and valid_until', () => {
    const ctx = makeContext();
    const march1 = Math.floor(Date.UTC(2025, 2, 1) / 1000);
    const june30 = Math.floor(Date.UTC(2025, 5, 30) / 1000);
    (ctx.trustedCoreMemory[0] as Record<string, unknown>).valid_from = march1;
    (ctx.trustedCoreMemory[0] as Record<string, unknown>).valid_until = june30;
    const text = formatContextForPrompt(ctx);
    expect(text).toContain('Valid 2025-03-01');
    expect(text).toContain('2025-06-30');
  });

  it('does not append temporal qualifier when both are null', () => {
    const ctx = makeContext();
    (ctx.trustedCoreMemory[0] as Record<string, unknown>).valid_from = null;
    (ctx.trustedCoreMemory[0] as Record<string, unknown>).valid_until = null;
    const text = formatContextForPrompt(ctx);
    expect(text).not.toContain('Valid until');
    expect(text).not.toContain('In effect');
    // Fact should render without brackets (no other options enabled)
    expect(text).toContain('- The project uses sqlite');
    expect(text).not.toContain('[');
  });
});
