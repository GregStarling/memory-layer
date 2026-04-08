import { describe, expect, it } from 'vitest';

import { getCurationSummary, type CurationInput } from '../core/curation.js';
import type { MaintenanceReport } from '../core/maintenance.js';
import type { KnowledgeReflectionResult } from '../contracts/reflection.js';
import type { DerivedOutput } from '../contracts/derived.js';
import type { CurationAction } from '../contracts/curation.js';

function makeMaintenanceReport(overrides: Partial<MaintenanceReport> = {}): MaintenanceReport {
  return {
    expiredWorkingMemoryIds: [],
    retiredKnowledgeIds: [],
    deletedWorkItemIds: [],
    deletedAssociationIds: [],
    reverifiedKnowledgeIds: [],
    demotedKnowledgeIds: [],
    expiredCandidateIds: [],
    ...overrides,
  };
}

function makeReflectionResult(overrides: Partial<KnowledgeReflectionResult> = {}): KnowledgeReflectionResult {
  return {
    newFacts: [],
    patternsFound: [],
    sessionsAnalyzed: 0,
    sourceMemoryIds: [],
    ...overrides,
  };
}

const ts = 1700000000;

describe('getCurationSummary', () => {
  describe('maintenance-only mode', () => {
    it('returns empty actions when no input provided', () => {
      const summary = getCurationSummary({});
      expect(summary.actions).toEqual([]);
      expect(summary.maintenanceRef).toBeUndefined();
      expect(summary.reflectionRef).toBeUndefined();
    });

    it('converts retired knowledge into curation actions', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport({ retiredKnowledgeIds: [1, 2, 3] }),
        maintenanceTimestamp: ts,
      });

      const retired = summary.actions.filter((a) => a.actionType === 'retired');
      expect(retired).toHaveLength(1);
      expect(retired[0].affectedEntities).toEqual(['knowledge:1', 'knowledge:2', 'knowledge:3']);
      expect(retired[0].source).toBe('maintenance');
      expect(retired[0].timestamp).toBe(ts);
      expect(summary.maintenanceRef).toBe('MaintenanceReport');
    });

    it('converts expired working memory into curation actions', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport({ expiredWorkingMemoryIds: [10, 20] }),
        maintenanceTimestamp: ts,
      });

      const expired = summary.actions.filter(
        (a) => a.actionType === 'expired' && a.affectedEntities[0].startsWith('working_memory:'),
      );
      expect(expired).toHaveLength(1);
      expect(expired[0].explanation).toContain('2');
    });

    it('converts demoted knowledge into curation actions', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport({ demotedKnowledgeIds: [5] }),
        maintenanceTimestamp: ts,
      });

      const demoted = summary.actions.filter((a) => a.actionType === 'demoted');
      expect(demoted).toHaveLength(1);
      expect(demoted[0].affectedEntities).toEqual(['knowledge:5']);
    });

    it('converts expired candidates into curation actions', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport({ expiredCandidateIds: [7, 8] }),
        maintenanceTimestamp: ts,
      });

      const expired = summary.actions.filter(
        (a) => a.affectedEntities.some((e) => e.startsWith('candidate:')),
      );
      expect(expired).toHaveLength(1);
    });

    it('converts deleted work items and associations', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport({
          deletedWorkItemIds: [100],
          deletedAssociationIds: [200, 201],
        }),
        maintenanceTimestamp: ts,
      });

      expect(summary.actions.length).toBe(2);
      expect(summary.actions.some((a) => a.affectedEntities.includes('work_item:100'))).toBe(true);
      expect(summary.actions.some((a) => a.affectedEntities.includes('association:200'))).toBe(true);
    });

    it('converts reverified knowledge into curation actions', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport({
          reverifiedKnowledgeIds: [10, 11, 12],
        }),
        maintenanceTimestamp: ts,
      });

      expect(summary.actions.length).toBe(1);
      expect(summary.actions[0].actionType).toBe('reverified');
      expect(summary.actions[0].affectedEntities).toEqual([
        'knowledge:10',
        'knowledge:11',
        'knowledge:12',
      ]);
      expect(summary.actions[0].explanation).toContain('3');
      expect(summary.actions[0].source).toBe('maintenance');
    });

    it('skips empty maintenance categories', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport(),
        maintenanceTimestamp: ts,
      });

      expect(summary.actions).toHaveLength(0);
      expect(summary.maintenanceRef).toBe('MaintenanceReport');
    });
  });

  describe('reflection source', () => {
    it('converts new reflection facts into curation actions', () => {
      const summary = getCurationSummary({
        reflection: makeReflectionResult({
          newFacts: [
            {
              fact: 'The system uses PostgreSQL',
              factType: 'reference',
              knowledgeClass: 'project_fact',
              knowledgeState: 'provisional',
              confidence: 'medium',
              confidenceScore: 0.5,
              groundingStrength: 'weak',
              evidenceSource: 'reflection',
              sourceMemoryIds: [1],
            },
          ],
          sessionsAnalyzed: 10,
        }),
        reflectionTimestamp: ts,
      });

      const reflected = summary.actions.filter((a) => a.actionType === 'reflected');
      expect(reflected.length).toBeGreaterThanOrEqual(1);
      expect(reflected[0].source).toBe('reflection');
      expect(reflected[0].explanation).toContain('1 new provisional fact');
      expect(summary.reflectionRef).toBe('KnowledgeReflectionResult');
    });

    it('converts reflection patterns into curation actions', () => {
      const summary = getCurationSummary({
        reflection: makeReflectionResult({
          patternsFound: [
            { name: 'recurring_deploy', description: 'Deploy pattern', occurrences: 5, relatedFactIndices: [] },
          ],
        }),
        reflectionTimestamp: ts,
      });

      const reflected = summary.actions.filter(
        (a) => a.actionType === 'reflected' && a.affectedEntities.includes('recurring_deploy'),
      );
      expect(reflected).toHaveLength(1);
    });

    it('converts alias candidates into merged actions', () => {
      const summary = getCurationSummary({
        reflection: makeReflectionResult({
          aliasCandidates: [
            { entity1: 'PostgreSQL', entity2: 'Postgres', similarity: 0.9, suggestedCanonical: 'PostgreSQL', confirmed: false },
          ],
        }),
        reflectionTimestamp: ts,
      });

      const merged = summary.actions.filter((a) => a.actionType === 'merged');
      expect(merged).toHaveLength(1);
      expect(merged[0].affectedEntities[0]).toContain('PostgreSQL');
      expect(merged[0].affectedEntities[0]).toContain('Postgres');
    });
  });

  describe('derived pipeline source', () => {
    it('converts derived outputs into curation actions grouped by type', () => {
      const derived: DerivedOutput[] = [
        { type: 'anti_pattern', content: 'Avoid eval()', confidence: 0.8, sourceKnowledgeIds: [1], rationale: 'test' },
        { type: 'anti_pattern', content: 'Avoid innerHTML', confidence: 0.7, sourceKnowledgeIds: [2], rationale: 'test' },
        { type: 'coding_rule', content: 'Use strict mode', confidence: 0.9, sourceKnowledgeIds: [3], rationale: 'test' },
      ];

      const summary = getCurationSummary({ derived, derivedTimestamp: ts });

      const derivedActions = summary.actions.filter((a) => a.source === 'derived_pipeline');
      expect(derivedActions).toHaveLength(2); // 2 groups: anti_pattern, coding_rule
      expect(derivedActions.some((a) => a.explanation.includes('anti pattern'))).toBe(true);
      expect(derivedActions.some((a) => a.explanation.includes('coding rule'))).toBe(true);
    });

    it('skips empty derived outputs', () => {
      const summary = getCurationSummary({ derived: [], derivedTimestamp: ts });
      expect(summary.actions).toHaveLength(0);
    });
  });

  describe('ontology source', () => {
    it('passes through ontology actions directly', () => {
      const ontologyActions: CurationAction[] = [
        {
          actionType: 'merged',
          affectedEntities: ['PostgreSQL', 'Postgres'],
          explanation: 'Merged alias pair.',
          timestamp: ts,
          source: 'ontology',
        },
      ];

      const summary = getCurationSummary({ ontologyActions });

      expect(summary.actions).toHaveLength(1);
      expect(summary.actions[0].source).toBe('ontology');
      expect(summary.actions[0].actionType).toBe('merged');
    });
  });

  describe('aggregation across sources', () => {
    it('aggregates actions from all sources into a single timeline', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport({ retiredKnowledgeIds: [1] }),
        maintenanceTimestamp: ts,
        reflection: makeReflectionResult({
          newFacts: [{
            fact: 'New fact',
            factType: 'reference',
            knowledgeClass: 'project_fact',
            knowledgeState: 'provisional',
            confidence: 'medium',
            confidenceScore: 0.5,
            groundingStrength: 'weak',
            evidenceSource: 'reflection',
            sourceMemoryIds: [],
          }],
          sessionsAnalyzed: 3,
        }),
        reflectionTimestamp: ts + 10,
        derived: [
          { type: 'coding_rule', content: 'Use strict', confidence: 0.9, sourceKnowledgeIds: [2], rationale: 'test' },
        ],
        derivedTimestamp: ts + 20,
        ontologyActions: [{
          actionType: 'merged',
          affectedEntities: ['A', 'B'],
          explanation: 'Merged.',
          timestamp: ts + 30,
          source: 'ontology',
        }],
      });

      const sources = new Set(summary.actions.map((a) => a.source));
      expect(sources.has('maintenance')).toBe(true);
      expect(sources.has('reflection')).toBe(true);
      expect(sources.has('derived_pipeline')).toBe(true);
      expect(sources.has('ontology')).toBe(true);
      expect(summary.maintenanceRef).toBe('MaintenanceReport');
      expect(summary.reflectionRef).toBe('KnowledgeReflectionResult');
    });

    it('sorts actions by timestamp descending', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport({ retiredKnowledgeIds: [1] }),
        maintenanceTimestamp: ts,
        derived: [
          { type: 'coding_rule', content: 'Rule', confidence: 0.9, sourceKnowledgeIds: [2], rationale: 'test' },
        ],
        derivedTimestamp: ts + 100,
      });

      expect(summary.actions.length).toBe(2);
      expect(summary.actions[0].timestamp).toBeGreaterThanOrEqual(summary.actions[1].timestamp);
    });
  });

  describe('filtering options', () => {
    it('filters by since timestamp', () => {
      const summary = getCurationSummary(
        {
          maintenance: makeMaintenanceReport({ retiredKnowledgeIds: [1] }),
          maintenanceTimestamp: ts,
          derived: [
            { type: 'coding_rule', content: 'Rule', confidence: 0.9, sourceKnowledgeIds: [2], rationale: 'test' },
          ],
          derivedTimestamp: ts + 100,
        },
        { since: ts + 50 },
      );

      expect(summary.actions).toHaveLength(1);
      expect(summary.actions[0].source).toBe('derived_pipeline');
    });

    it('filters by action types', () => {
      const summary = getCurationSummary(
        {
          maintenance: makeMaintenanceReport({
            retiredKnowledgeIds: [1],
            demotedKnowledgeIds: [2],
          }),
          maintenanceTimestamp: ts,
        },
        { actionTypes: ['retired'] },
      );

      expect(summary.actions).toHaveLength(1);
      expect(summary.actions[0].actionType).toBe('retired');
    });

    it('respects limit option', () => {
      const summary = getCurationSummary(
        {
          maintenance: makeMaintenanceReport({
            retiredKnowledgeIds: [1],
            demotedKnowledgeIds: [2],
            expiredWorkingMemoryIds: [3],
            expiredCandidateIds: [4],
            deletedWorkItemIds: [5],
          }),
          maintenanceTimestamp: ts,
        },
        { limit: 2 },
      );

      expect(summary.actions.length).toBeLessThanOrEqual(2);
    });
  });

  describe('period computation', () => {
    it('computes period from action timestamps', () => {
      const summary = getCurationSummary({
        maintenance: makeMaintenanceReport({ retiredKnowledgeIds: [1] }),
        maintenanceTimestamp: ts,
        derived: [
          { type: 'coding_rule', content: 'Rule', confidence: 0.9, sourceKnowledgeIds: [2], rationale: 'test' },
        ],
        derivedTimestamp: ts + 500,
      });

      expect(summary.period.start).toBe(ts);
      expect(summary.period.end).toBe(ts + 500);
    });

    it('uses since as period start when no actions exist', () => {
      const summary = getCurationSummary({}, { since: ts });
      expect(summary.period.start).toBe(ts);
    });
  });
});
