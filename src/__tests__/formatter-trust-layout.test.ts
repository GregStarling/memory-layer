import { describe, expect, it } from 'vitest';

import { formatContextForPrompt } from '../core/formatter.js';
import type { MemoryContext } from '../core/context.js';

function makeContext(): MemoryContext {
  const trusted = {
    id: 1,
    tenant_id: 'acme',
    system_id: 'assistant',
    workspace_id: 'default',
    collaboration_id: '',
    scope_id: 'thread-1',
    fact: 'The system must stay local-first.',
    fact_type: 'constraint' as const,
    knowledge_state: 'trusted' as const,
    knowledge_class: 'constraint' as const,
    fact_subject: null,
    fact_attribute: null,
    fact_value: null,
    normalized_fact: 'the system must stay local first',
    slot_key: 'system:constraint:local_first',
    is_negated: false,
    source: 'manual' as const,
    confidence: 'high' as const,
    confidence_score: 0.95,
    grounding_strength: 'strong' as const,
    evidence_count: 2,
    trust_score: 0.95,
    verification_status: 'verified' as const,
    verification_notes: null,
    last_verified_at: 1,
    source_working_memory_id: null,
    source_turn_ids: [1],
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
  };
  const provisional = { ...trusted, id: 2, fact: 'Retry with smaller batches.', knowledge_state: 'provisional' as const, knowledge_class: 'strategy' as const };
  const disputed = { ...trusted, id: 3, fact: 'Always use Docker.', knowledge_state: 'disputed' as const, disputed_at: 2, dispute_reason: 'contradicted', contradiction_score: 1 };
  return {
    mode: 'coding',
    activeTurns: [],
    workingMemory: null,
    trustedCoreMemory: [trusted],
    taskRelevantKnowledge: [],
    provisionalKnowledge: [provisional],
    disputedKnowledge: [disputed],
    relevantKnowledge: [trusted],
    durableKnowledge: [trusted],
    recentSummaries: [],
    currentObjective: 'Ship trust-aware prompts',
    sessionState: {
      currentObjective: 'Ship trust-aware prompts',
      blockers: [],
      assumptions: [],
      pendingDecisions: [],
      activeTools: [],
      recentOutputs: [],
      updatedAt: 1,
    },
    activeObjectives: [],
    activeState: [],
    associatedKnowledge: [],
    unresolvedWork: [],
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

describe('formatter trust layout', () => {
  it('shows trusted and task-relevant sections by default', () => {
    const text = formatContextForPrompt(makeContext());
    expect(text).toContain('Trusted Core Memory');
    expect(text).toContain('Task Relevant Knowledge');
    expect(text).not.toContain('Provisional Knowledge');
    expect(text).not.toContain('Disputed Knowledge');
  });

  it('can include provisional and disputed sections when requested', () => {
    const text = formatContextForPrompt(makeContext(), {
      includeProvisionalKnowledge: true,
      includeDisputedKnowledge: true,
      includeTrustMetadata: true,
      includeEvidenceMarkers: true,
    });
    expect(text).toContain('Provisional Knowledge');
    expect(text).toContain('Disputed Knowledge');
    expect(text).toContain('evidence=2');
    expect(text).toContain('state=trusted');
  });
});
