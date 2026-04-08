import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { KnowledgeMemory, WorkingMemory, Playbook } from '../contracts/types.js';
import type { Extractor, ExtractedFact } from '../core/extractor.js';
import { reflectOnKnowledge, resetRateLimits } from '../core/reflection.js';

function scope(): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
  };
}

function makeKnowledge(overrides: Partial<KnowledgeMemory> & { id: number; fact: string }): KnowledgeMemory {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    workspace_id: 'default',
    collaboration_id: 'default',
    scope_id: 'thread-1',
    visibility_class: 'private',
    fact_type: 'entity',
    knowledge_state: 'trusted',
    knowledge_class: 'project_fact',
    fact_subject: null,
    fact_attribute: null,
    fact_value: null,
    normalized_fact: overrides.fact.toLowerCase(),
    slot_key: null,
    is_negated: false,
    source: 'user_stated',
    confidence: 'high',
    confidence_score: 0.9,
    grounding_strength: 'strong',
    evidence_count: 1,
    trust_score: 0.9,
    verification_status: 'unverified',
    source_working_memory_id: null,
    source_turn_ids: [],
    created_at: 1000,
    updated_at: 1000,
    retired_at: null,
    valid_from: null,
    valid_until: null,
    rationale: null,
    tags: [],
    schema_version: 1,
    ...overrides,
  };
}

function makeWorkingMemory(overrides: Partial<WorkingMemory> & { id: number; summary: string }): WorkingMemory {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    workspace_id: 'default',
    collaboration_id: 'default',
    scope_id: 'thread-1',
    session_id: 'sess-1',
    key_entities: [],
    topic_tags: [],
    turn_id_start: 1,
    turn_id_end: 5,
    turn_count: 5,
    compaction_trigger: 'soft',
    created_at: 1000,
    expires_at: null,
    episode_recap: null,
    schema_version: 1,
    ...overrides,
  };
}

function createMockAdapter(
  knowledge: KnowledgeMemory[] = [],
  workingMemories: WorkingMemory[] = [],
  playbooks: Playbook[] = [],
): AsyncStorageAdapter {
  return {
    getActiveKnowledgeMemory: vi.fn().mockResolvedValue(knowledge),
    getActiveWorkingMemory: vi.fn().mockResolvedValue(workingMemories),
    getActivePlaybooks: vi.fn().mockResolvedValue(playbooks),
  } as unknown as AsyncStorageAdapter;
}

function createMockExtractor(facts: ExtractedFact[] = []): Extractor {
  return vi.fn().mockResolvedValue(facts);
}

describe('reflectOnKnowledge', () => {
  const s = scope();

  beforeEach(() => {
    resetRateLimits();
  });

  afterEach(() => {
    resetRateLimits();
  });

  it('returns empty result when no source material exists', async () => {
    const adapter = createMockAdapter();
    const result = await reflectOnKnowledge(adapter, s);

    expect(result.newFacts).toHaveLength(0);
    expect(result.patternsFound).toHaveLength(0);
    expect(result.sessionsAnalyzed).toBe(0);
    expect(result.sourceMemoryIds).toHaveLength(0);
  });

  it('extracts new facts from working memory summaries and knowledge', async () => {
    const km = makeKnowledge({ id: 1, fact: 'User prefers TypeScript' });
    const wm = makeWorkingMemory({
      id: 10,
      summary: 'User always uses dark mode and prefers functional programming patterns',
      key_entities: ['TypeScript'],
      topic_tags: ['programming'],
    });

    const mockFacts: ExtractedFact[] = [
      { fact: 'User prefers functional programming', factType: 'preference', confidence: 'high' },
      { fact: 'User always uses dark mode', factType: 'preference', confidence: 'medium' },
    ];
    const extractor = createMockExtractor(mockFacts);
    const adapter = createMockAdapter([km], [wm]);

    const result = await reflectOnKnowledge(adapter, s, {}, extractor);

    expect(result.newFacts.length).toBeGreaterThanOrEqual(1);
    expect(result.sessionsAnalyzed).toBe(1);
    expect(result.sourceMemoryIds).toEqual([1]);

    // All reflection facts should have correct metadata
    for (const fact of result.newFacts) {
      expect(fact.knowledgeState).toBe('provisional');
      expect(fact.evidenceSource).toBe('reflection');
      expect(fact.groundingStrength).toBe('weak');
    }
  });

  it('deduplicates against existing knowledge', async () => {
    const km = makeKnowledge({
      id: 1,
      fact: 'User prefers TypeScript',
      normalized_fact: 'user prefers typescript',
    });
    const wm = makeWorkingMemory({
      id: 10,
      summary: 'User prefers TypeScript and uses React',
    });

    // Extractor returns a fact that matches existing knowledge
    const mockFacts: ExtractedFact[] = [
      { fact: 'User prefers TypeScript', factType: 'preference', confidence: 'high' },
      { fact: 'User uses React', factType: 'entity', confidence: 'medium' },
    ];
    const extractor = createMockExtractor(mockFacts);
    const adapter = createMockAdapter([km], [wm]);

    const result = await reflectOnKnowledge(adapter, s, {}, extractor);

    // The duplicate should be filtered out
    const factTexts = result.newFacts.map((f) => f.fact);
    expect(factTexts).not.toContain('User prefers TypeScript');
  });

  it('respects maxFacts option', async () => {
    const wm = makeWorkingMemory({
      id: 10,
      summary: 'Many topics discussed',
    });

    const mockFacts: ExtractedFact[] = [
      { fact: 'Fact one', factType: 'entity', confidence: 'high' },
      { fact: 'Fact two', factType: 'entity', confidence: 'high' },
      { fact: 'Fact three', factType: 'entity', confidence: 'high' },
      { fact: 'Fact four', factType: 'entity', confidence: 'high' },
      { fact: 'Fact five', factType: 'entity', confidence: 'high' },
    ];
    const extractor = createMockExtractor(mockFacts);
    const adapter = createMockAdapter([], [wm]);

    const result = await reflectOnKnowledge(adapter, s, { maxFacts: 2 }, extractor);

    expect(result.newFacts.length).toBeLessThanOrEqual(2);
  });

  it('reflection facts have lower initial trust than extraction', async () => {
    const wm = makeWorkingMemory({
      id: 10,
      summary: 'User prefers dark mode',
    });
    const mockFacts: ExtractedFact[] = [
      { fact: 'User prefers dark mode', factType: 'preference', confidence: 'high' },
    ];
    const extractor = createMockExtractor(mockFacts);
    const adapter = createMockAdapter([], [wm]);

    const result = await reflectOnKnowledge(adapter, s, {}, extractor);

    expect(result.newFacts.length).toBeGreaterThanOrEqual(1);
    // Even high-confidence reflection facts get a lower confidence score
    // than extraction (which would typically be 0.9+)
    expect(result.newFacts[0].confidenceScore).toBeLessThanOrEqual(0.7);
    expect(result.newFacts[0].knowledgeState).toBe('provisional');
  });

  it('includes playbook context when includePlaybooks is true', async () => {
    const wm = makeWorkingMemory({ id: 10, summary: 'Working on deployment' });
    const mockFacts: ExtractedFact[] = [
      { fact: 'Team uses blue-green deployment strategy', factType: 'decision', confidence: 'high' },
    ];
    const extractor = createMockExtractor(mockFacts) as ReturnType<typeof vi.fn>;
    const adapter = createMockAdapter([], [wm], [
      {
        id: 1,
        tenant_id: 'acme',
        system_id: 'assistant',
        workspace_id: 'default',
        collaboration_id: 'default',
        scope_id: 'thread-1',
        title: 'Deploy Procedure',
        description: 'Blue-green deployment with canary checks',
        instructions: 'Step 1: deploy canary',
        references: [],
        templates: [],
        scripts: [],
        assets: [],
        tags: ['deployment'],
        rationale: null,
        status: 'active',
        source_session_id: null,
        source_working_memory_id: null,
        revision_count: 0,
        last_used_at: null,
        use_count: 0,
        created_at: 1000,
        updated_at: 1000,
        schema_version: 1,
      },
    ]);

    const result = await reflectOnKnowledge(adapter, s, { includePlaybooks: true }, extractor);

    // Extractor should have been called with combined text including playbook
    const calledWith = extractor.mock.calls[0][0] as string;
    expect(calledWith).toContain('Deploy Procedure');
    expect(calledWith).toContain('Blue-green deployment');
    expect(result.newFacts.length).toBeGreaterThanOrEqual(1);
  });

  it('skips playbooks when includePlaybooks is false', async () => {
    const wm = makeWorkingMemory({ id: 10, summary: 'Working' });
    const extractor = createMockExtractor([]) as ReturnType<typeof vi.fn>;
    const adapter = createMockAdapter([], [wm]);

    await reflectOnKnowledge(adapter, s, { includePlaybooks: false }, extractor);

    // getActivePlaybooks should not have been called
    expect(adapter.getActivePlaybooks).not.toHaveBeenCalled();
  });

  it('rate limits repeated calls with the same key', async () => {
    const wm = makeWorkingMemory({ id: 10, summary: 'Some work' });
    const mockFacts: ExtractedFact[] = [
      { fact: 'A new fact', factType: 'entity', confidence: 'medium' },
    ];
    const extractor = createMockExtractor(mockFacts);
    const adapter = createMockAdapter([], [wm]);

    // First call should work
    const first = await reflectOnKnowledge(adapter, s, { rateLimitKey: 'test-key' }, extractor);
    expect(first.newFacts.length).toBeGreaterThanOrEqual(1);

    // Second call with same key should be rate-limited
    const second = await reflectOnKnowledge(adapter, s, { rateLimitKey: 'test-key' }, extractor);
    expect(second.newFacts).toHaveLength(0);
    expect(second.sessionsAnalyzed).toBe(0);
  });

  it('allows calls with different rate limit keys', async () => {
    const wm = makeWorkingMemory({ id: 10, summary: 'Some work' });
    const mockFacts: ExtractedFact[] = [
      { fact: 'A new fact', factType: 'entity', confidence: 'medium' },
    ];
    const extractor = createMockExtractor(mockFacts);
    const adapter = createMockAdapter([], [wm]);

    const first = await reflectOnKnowledge(adapter, s, { rateLimitKey: 'key-a' }, extractor);
    expect(first.newFacts.length).toBeGreaterThanOrEqual(1);

    // Different key should not be rate-limited
    const second = await reflectOnKnowledge(adapter, s, { rateLimitKey: 'key-b' }, extractor);
    expect(second.newFacts.length).toBeGreaterThanOrEqual(1);
  });

  it('detects patterns from recurring subjects', async () => {
    const knowledge = [
      makeKnowledge({ id: 1, fact: 'User prefers React', fact_subject: 'react' }),
      makeKnowledge({ id: 2, fact: 'React component structure', fact_subject: 'react' }),
      makeKnowledge({ id: 3, fact: 'React state management', fact_subject: 'react' }),
    ];
    const wm = makeWorkingMemory({ id: 10, summary: 'Discussing React patterns' });
    const mockFacts: ExtractedFact[] = [
      { fact: 'React hooks are preferred over class components', factType: 'preference', confidence: 'high' },
    ];
    const extractor = createMockExtractor(mockFacts);
    const adapter = createMockAdapter(knowledge, [wm]);

    const result = await reflectOnKnowledge(adapter, s, {}, extractor);

    // Should detect 'react' as a recurring pattern
    expect(result.patternsFound.length).toBeGreaterThanOrEqual(1);
    const reactPattern = result.patternsFound.find((p) => p.name.includes('react'));
    expect(reactPattern).toBeDefined();
    expect(reactPattern!.occurrences).toBe(3);
  });

  it('maps fact types to correct knowledge classes', async () => {
    const wm = makeWorkingMemory({ id: 10, summary: 'Various types' });
    const mockFacts: ExtractedFact[] = [
      { fact: 'User prefers dark mode', factType: 'preference', confidence: 'high' },
      { fact: 'TypeScript is the main language', factType: 'entity', confidence: 'high' },
      { fact: 'Must use approved libraries', factType: 'constraint', confidence: 'high' },
      { fact: 'Decided to use monorepo', factType: 'decision', confidence: 'medium' },
    ];
    const extractor = createMockExtractor(mockFacts);
    const adapter = createMockAdapter([], [wm]);

    const result = await reflectOnKnowledge(adapter, s, {}, extractor);

    const classMap = new Map(result.newFacts.map((f) => [f.factType, f.knowledgeClass]));
    expect(classMap.get('preference')).toBe('preference');
    expect(classMap.get('entity')).toBe('identity');
    expect(classMap.get('constraint')).toBe('constraint');
    expect(classMap.get('decision')).toBe('procedure');
  });

  it('assigns correct confidence scores by confidence level', async () => {
    const wm = makeWorkingMemory({ id: 10, summary: 'Confidence tests' });
    const mockFacts: ExtractedFact[] = [
      { fact: 'High confidence fact', factType: 'entity', confidence: 'high' },
      { fact: 'Medium confidence fact', factType: 'entity', confidence: 'medium' },
      { fact: 'Low confidence fact', factType: 'entity', confidence: 'low' },
    ];
    const extractor = createMockExtractor(mockFacts);
    const adapter = createMockAdapter([], [wm]);

    const result = await reflectOnKnowledge(adapter, s, {}, extractor);

    const byConfidence = new Map(result.newFacts.map((f) => [f.confidence, f.confidenceScore]));
    expect(byConfidence.get('high')).toBe(0.7);
    expect(byConfidence.get('medium')).toBe(0.5);
    expect(byConfidence.get('low')).toBe(0.3);
  });
});
