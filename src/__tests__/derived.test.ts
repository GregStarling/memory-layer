import { afterEach, describe, expect, it } from 'vitest';

import {
  derive,
  registerDerivationHandler,
  resetDerivationHandlers,
} from '../core/derived.js';
import { createInMemoryAdapter } from '../adapters/memory/index.js';
import type { KnowledgeReflectionResult } from '../contracts/reflection.js';
import type { KnowledgeMemory } from '../contracts/types.js';

function makeKnowledge(overrides: Partial<KnowledgeMemory>): KnowledgeMemory {
  return {
    id: 1,
    tenant_id: 'test',
    system_id: 'test',
    workspace_id: 'test',
    collaboration_id: null,
    scope_id: 'test',
    fact: 'test fact',
    fact_type: 'reference',
    knowledge_state: 'trusted',
    knowledge_class: 'project_fact',
    fact_subject: null,
    fact_attribute: null,
    fact_value: null,
    normalized_fact: null,
    slot_key: null,
    is_negated: false,
    source: 'promoted_from_working',
    confidence: 'high',
    confidence_score: 0.9,
    grounding_strength: 'strong',
    evidence_count: 2,
    trust_score: 0.9,
    verification_status: 'verified',
    verification_notes: null,
    last_verified_at: null,
    source_working_memory_id: 1,
    source_turn_ids: [],
    contradiction_score: 0,
    dispute_reason: null,
    superseded_by_id: null,
    retired_at: null,
    valid_from: null,
    valid_until: null,
    rationale: null,
    tags: [],
    created_at: Date.now() / 1000,
    updated_at: Date.now() / 1000,
    ...overrides,
  };
}

function makeReflectionResult(overrides: Partial<KnowledgeReflectionResult> = {}): KnowledgeReflectionResult {
  return {
    newFacts: [],
    patternsFound: [],
    sessionsAnalyzed: 5,
    sourceMemoryIds: [1, 2, 3],
    ...overrides,
  };
}

afterEach(() => {
  resetDerivationHandlers();
});

describe('derive', () => {
  describe('playbook_candidate', () => {
    it('produces playbook candidate from recurring reflection pattern', () => {
      const result = derive(
        makeReflectionResult({
          patternsFound: [
            {
              name: 'recurring_deploy',
              description: 'Subject "deploy" appears in 5 knowledge facts',
              occurrences: 5,
              relatedFactIndices: [],
            },
          ],
        }),
        [],
        { outputTypes: ['playbook_candidate'] },
      );

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].type).toBe('playbook_candidate');
      expect(result[0].content).toContain('recurring_deploy');
      expect(result[0].confidence).toBeGreaterThan(0);
      expect(result[0].sourceKnowledgeIds.length).toBeGreaterThan(0);
      expect(result[0].rationale).toContain('recurs');
    });

    it('produces playbook candidate from clustered procedure knowledge', () => {
      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Deploy to staging first', knowledge_class: 'procedure', fact_subject: 'deploy' }),
        makeKnowledge({ id: 2, fact: 'Run smoke tests after deploy', knowledge_class: 'procedure', fact_subject: 'deploy' }),
        makeKnowledge({ id: 3, fact: 'Promote to production after green', knowledge_class: 'procedure', fact_subject: 'deploy' }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['playbook_candidate'],
      });

      expect(result.some((o) => o.type === 'playbook_candidate')).toBe(true);
      const candidate = result.find((o) => o.content.includes('deploy'));
      expect(candidate).toBeDefined();
      expect(candidate!.sourceKnowledgeIds).toEqual(expect.arrayContaining([1, 2, 3]));
    });

    it('skips patterns with fewer than 3 occurrences', () => {
      const result = derive(
        makeReflectionResult({
          patternsFound: [
            { name: 'rare_pattern', description: 'Rare', occurrences: 2, relatedFactIndices: [] },
          ],
        }),
        [],
        { outputTypes: ['playbook_candidate'] },
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('coding_rule', () => {
    it('produces coding rule from corroborated constraints', () => {
      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Must use strict mode', knowledge_class: 'constraint', fact_subject: 'typescript', evidence_count: 3 }),
        makeKnowledge({ id: 2, fact: 'Must enable noImplicitAny', knowledge_class: 'constraint', fact_subject: 'typescript', evidence_count: 2 }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['coding_rule'],
      });

      expect(result.some((o) => o.type === 'coding_rule')).toBe(true);
      const rule = result.find((o) => o.content.includes('typescript'));
      expect(rule).toBeDefined();
      expect(rule!.sourceKnowledgeIds).toEqual(expect.arrayContaining([1, 2]));
    });

    it('produces individual coding rule from high-trust constraint', () => {
      const knowledge = [
        makeKnowledge({
          id: 10,
          fact: 'Never commit secrets to git',
          knowledge_class: 'constraint',
          fact_subject: 'security',
          evidence_count: 4,
          trust_score: 0.95,
        }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['coding_rule'],
      });

      expect(result.some((o) => o.type === 'coding_rule' && o.content.includes('secrets'))).toBe(true);
    });

    it('skips constraints with insufficient evidence', () => {
      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Weak constraint', knowledge_class: 'constraint', evidence_count: 1 }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['coding_rule'],
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('anti_pattern', () => {
    it('produces anti-pattern from negated constraint', () => {
      const knowledge = [
        makeKnowledge({
          id: 1,
          fact: 'Must not use eval()',
          knowledge_class: 'constraint',
          is_negated: true,
          trust_score: 0.85,
        }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['anti_pattern'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('anti_pattern');
      expect(result[0].content).toContain('eval()');
      expect(result[0].sourceKnowledgeIds).toEqual([1]);
    });

    it('produces anti-pattern from disputed knowledge with high contradiction', () => {
      const knowledge = [
        makeKnowledge({
          id: 2,
          fact: 'Cache everything aggressively',
          knowledge_state: 'disputed',
          contradiction_score: 0.8,
          dispute_reason: 'Caused stale data issues',
        }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['anti_pattern'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('Disputed');
      expect(result[0].content).toContain('stale data');
    });

    it('skips disputed facts with low contradiction score', () => {
      const knowledge = [
        makeKnowledge({
          id: 2,
          fact: 'Minor dispute',
          knowledge_state: 'disputed',
          contradiction_score: 0.3,
        }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['anti_pattern'],
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('project_summary', () => {
    it('produces summary from trusted knowledge across classes', () => {
      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Uses TypeScript', knowledge_class: 'project_fact', trust_score: 0.9 }),
        makeKnowledge({ id: 2, fact: 'Prefers dark mode', knowledge_class: 'preference', trust_score: 0.85 }),
        makeKnowledge({ id: 3, fact: 'Must use ESLint', knowledge_class: 'constraint', trust_score: 0.8 }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['project_summary'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('project_summary');
      expect(result[0].content).toContain('TypeScript');
      expect(result[0].content).toContain('dark mode');
      expect(result[0].content).toContain('ESLint');
      expect(result[0].sourceKnowledgeIds.length).toBe(3);
    });

    it('skips summary when fewer than 3 trusted facts', () => {
      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Fact 1', trust_score: 0.8 }),
        makeKnowledge({ id: 2, fact: 'Fact 2', trust_score: 0.8 }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['project_summary'],
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('options and extensibility', () => {
    it('filters output types via options', () => {
      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Must not use eval', knowledge_class: 'constraint', is_negated: true }),
        makeKnowledge({ id: 2, fact: 'Uses TypeScript', trust_score: 0.9 }),
        makeKnowledge({ id: 3, fact: 'Uses ESLint', trust_score: 0.9 }),
        makeKnowledge({ id: 4, fact: 'Uses Prettier', trust_score: 0.9 }),
      ];

      const antiOnly = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['anti_pattern'],
      });
      expect(antiOnly.every((o) => o.type === 'anti_pattern')).toBe(true);
    });

    it('respects maxOutputs limit', () => {
      const knowledge = Array.from({ length: 10 }, (_, i) =>
        makeKnowledge({
          id: i + 1,
          fact: `Must not do thing ${i}`,
          knowledge_class: 'constraint',
          is_negated: true,
          trust_score: 0.9,
        }),
      );

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['anti_pattern'],
        maxOutputs: 3,
      });

      expect(result.length).toBeLessThanOrEqual(3);
    });

    it('deduplicates identical outputs before applying maxOutputs', () => {
      registerDerivationHandler('anti_pattern', () => [
        {
          type: 'anti_pattern',
          content: 'Duplicate output',
          confidence: 0.9,
          sourceKnowledgeIds: [1],
          rationale: 'first',
        },
        {
          type: 'anti_pattern',
          content: 'duplicate output',
          confidence: 0.8,
          sourceKnowledgeIds: [2],
          rationale: 'second',
        },
      ]);

      const result = derive(makeReflectionResult(), [], {
        outputTypes: ['anti_pattern'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Duplicate output');
    });

    it('rejects non-positive maxOutputs', () => {
      expect(() => derive(makeReflectionResult(), [], { maxOutputs: 0 })).toThrow(/maxOutputs/);
    });

    it('sorts outputs by confidence descending', () => {
      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Low trust anti-pattern', knowledge_class: 'constraint', is_negated: true, trust_score: 0.5 }),
        makeKnowledge({ id: 2, fact: 'High trust anti-pattern', knowledge_class: 'constraint', is_negated: true, trust_score: 0.95 }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['anti_pattern'],
      });

      expect(result.length).toBe(2);
      expect(result[0].confidence).toBeGreaterThanOrEqual(result[1].confidence);
    });

    it('runs all output types by default', () => {
      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Must not use eval', knowledge_class: 'constraint', is_negated: true }),
        makeKnowledge({ id: 2, fact: 'Uses TypeScript', trust_score: 0.9 }),
        makeKnowledge({ id: 3, fact: 'Uses ESLint', trust_score: 0.9 }),
        makeKnowledge({ id: 4, fact: 'Uses Prettier', trust_score: 0.9 }),
      ];

      const result = derive(makeReflectionResult(), knowledge);
      // Should include at least anti_pattern and project_summary
      const types = new Set(result.map((o) => o.type));
      expect(types.size).toBeGreaterThanOrEqual(2);
    });

    it('supports custom derivation handlers', () => {
      registerDerivationHandler('custom_type', (input) => [
        {
          type: 'playbook_candidate',
          content: 'Custom derived output',
          confidence: 0.99,
          sourceKnowledgeIds: [42],
          rationale: 'Custom handler test',
        },
      ]);

      const result = derive(makeReflectionResult(), [], {
        outputTypes: ['custom_type'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Custom derived output');
      expect(result[0].confidence).toBe(0.99);
    });

    it('custom handler overrides built-in for same type', () => {
      registerDerivationHandler('anti_pattern', () => [
        {
          type: 'anti_pattern',
          content: 'Custom anti-pattern',
          confidence: 1.0,
          sourceKnowledgeIds: [],
          rationale: 'Override',
        },
      ]);

      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Negated', knowledge_class: 'constraint', is_negated: true }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['anti_pattern'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Custom anti-pattern');
    });

    it('all outputs carry provenance back to source knowledge IDs', () => {
      const knowledge = [
        makeKnowledge({ id: 7, fact: 'Must not mutate state', knowledge_class: 'constraint', is_negated: true }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['anti_pattern'],
      });

      expect(result.length).toBeGreaterThan(0);
      for (const output of result) {
        expect(output.sourceKnowledgeIds.length).toBeGreaterThan(0);
      }
    });

    it('returns empty array when no matching knowledge exists', () => {
      const result = derive(makeReflectionResult(), []);
      expect(result).toEqual([]);
    });

    it('materializes outputs as candidate-state knowledge into trust pipeline', () => {
      const adapter = createInMemoryAdapter();
      const scope = { tenant_id: 'test', system_id: 'test', scope_id: 'derive-materialize' };

      const knowledge = [
        makeKnowledge({ id: 1, fact: 'Must not mutate state', knowledge_class: 'constraint', is_negated: true }),
      ];

      const result = derive(makeReflectionResult(), knowledge, {
        outputTypes: ['anti_pattern'],
      }, { adapter, scope });

      expect(result.length).toBeGreaterThan(0);

      // Verify candidates were inserted into the adapter
      const allKnowledge = adapter.getActiveKnowledgeMemory(scope);
      const candidates = allKnowledge.filter((k: KnowledgeMemory) => k.knowledge_state === 'candidate');
      expect(candidates.length).toBe(result.length);
      for (const candidate of candidates) {
        expect(candidate.knowledge_state).toBe('candidate');
        expect(candidate.trust_score).toBe(0);
        // Derivation type preserved via fact_subject
        expect(candidate.fact_subject).toMatch(/^derived:/);
        // Source knowledge IDs preserved via source_turn_ids
        expect(Array.isArray(candidate.source_turn_ids)).toBe(true);
      }
    });
  });
});
