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
      scope_id: 'thread-1',
      fact: 'The project uses sqlite',
      fact_type: 'reference' as const,
      fact_subject: 'project',
      fact_attribute: 'reference',
      fact_value: 'sqlite',
      normalized_fact: 'the project uses sqlite',
      slot_key: 'project:reference:database',
      is_negated: false,
      source: 'manual' as const,
      confidence: 'high' as const,
      confidence_score: 0.92,
      verification_status: 'verified' as const,
      verification_notes: 'Confirmed by repeated usage',
      source_working_memory_id: null,
      source_turn_ids: [1, 2],
      superseded_by_id: null,
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
    relevantKnowledge,
    durableKnowledge: relevantKnowledge,
    recentSummaries: [],
    currentObjective: 'Ship the memory layer',
    activeObjectives: [],
    activeState: ['topic:memory'],
    unresolvedWork: ['Need to add prompt formatter'],
    knowledgeSelectionReasons: [],
    tokenEstimate: 100,
  };
}

describe('formatter helpers', () => {
  it('formats context into prompt text', () => {
    const text = formatContextForPrompt(makeContext());
    expect(text).toContain('Current Objective');
    expect(text).toContain('Ship the memory layer');
  });

  it('formats bootstrap prompt text', () => {
    const text = formatBootstrapForPrompt({
      currentObjective: 'Resume the memory project',
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
  });
});
