import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import { getProfile, classifyProfileSection } from '../core/profile.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'user-1',
    ...overrides,
  };
}

describe('profile materializer', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;
  const s = scope();

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);

    // Seed knowledge across sections
    adapter.insertKnowledgeMemory({
      ...s,
      fact: 'User is a senior backend engineer',
      fact_type: 'entity',
      knowledge_class: 'identity',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.9,
    });
    adapter.insertKnowledgeMemory({
      ...s,
      fact: 'User prefers dark mode',
      fact_type: 'preference',
      knowledge_class: 'preference',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.8,
    });
    adapter.insertKnowledgeMemory({
      ...s,
      fact: 'User prefers concise response style',
      fact_type: 'preference',
      knowledge_class: 'preference',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.85,
    });
    adapter.insertKnowledgeMemory({
      ...s,
      fact: 'Never deploy on Fridays',
      fact_type: 'constraint',
      knowledge_class: 'constraint',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.95,
    });
    adapter.insertKnowledgeMemory({
      ...s,
      fact: 'Run lint before committing',
      fact_type: 'decision',
      knowledge_class: 'procedure',
      source: 'user_stated',
      confidence: 'high',
      trust_score: 0.7,
    });
  });

  afterEach(() => {
    adapter.close();
  });

  describe('classifyProfileSection', () => {
    it('maps identity class to identity section', () => {
      expect(classifyProfileSection('identity', 'User is an engineer')).toBe('identity');
    });

    it('maps constraint class to constraints section', () => {
      expect(classifyProfileSection('constraint', 'No deploys on Friday')).toBe('constraints');
    });

    it('maps procedure to workflows section', () => {
      expect(classifyProfileSection('procedure', 'Run tests first')).toBe('workflows');
    });

    it('maps strategy to workflows section', () => {
      expect(classifyProfileSection('strategy', 'Use feature flags')).toBe('workflows');
    });

    it('maps preference to preferences by default', () => {
      expect(classifyProfileSection('preference', 'Prefers dark mode')).toBe('preferences');
    });

    it('maps communication-related preferences to communication section', () => {
      expect(classifyProfileSection('preference', 'User prefers concise response style')).toBe('communication');
      expect(classifyProfileSection('preference', 'Use terse tone')).toBe('communication');
      expect(classifyProfileSection('preference', 'Always use markdown format')).toBe('communication');
    });
  });

  describe('getProfile', () => {
    it('returns a structured profile with all sections populated', async () => {
      const profile = await getProfile(asyncAdapter, s);

      expect(profile.view).toBe('user');
      expect(profile.sections.identity.length).toBe(1);
      expect(profile.sections.identity[0].fact).toContain('senior backend');
      expect(profile.sections.preferences.length).toBe(1);
      expect(profile.sections.communication.length).toBe(1);
      expect(profile.sections.communication[0].fact).toContain('concise');
      expect(profile.sections.constraints.length).toBe(1);
      expect(profile.sections.workflows.length).toBe(1);
      expect(profile.generatedAt).toBeGreaterThan(0);
    });

    it('queries at scope level for user view', async () => {
      const profile = await getProfile(asyncAdapter, s, { view: 'user' });
      // All 5 seeded facts are at the same scope, so all should appear
      const totalEntries = Object.values(profile.sections).flat().length;
      expect(totalEntries).toBe(5);
    });

    it('queries at system level for operator view', async () => {
      // Add knowledge at a different scope_id but same system_id
      adapter.insertKnowledgeMemory({
        ...s,
        scope_id: 'user-2',
        fact: 'System requires auth tokens',
        fact_type: 'constraint',
        knowledge_class: 'constraint',
        source: 'user_stated',
        confidence: 'high',
        trust_score: 0.9,
        // P6: shared across the workspace so it surfaces to the operator
        // (system-level) view from another scope_id; default 'private' would not.
        visibility_class: 'workspace',
      });

      const profile = await getProfile(asyncAdapter, s, { view: 'operator' });
      const constraints = profile.sections.constraints;
      // Should see constraints from both scope_ids
      expect(constraints.length).toBeGreaterThanOrEqual(2);
    });

    it('queries at workspace level for workspace view', async () => {
      adapter.insertKnowledgeMemory({
        ...s,
        scope_id: 'user-3',
        fact: 'Workspace uses monorepo layout',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        trust_score: 0.8,
        // P6: workspace-visible so it surfaces to the workspace-level view from
        // another scope_id; a default 'private' fact would stay in its scope.
        visibility_class: 'workspace',
      });

      const profile = await getProfile(asyncAdapter, s, { view: 'workspace' });
      const totalEntries = Object.values(profile.sections).flat().length;
      expect(totalEntries).toBeGreaterThanOrEqual(6);
    });

    it('excludes disputed knowledge by default', async () => {
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Disputed fact about deployment',
        fact_type: 'decision',
        knowledge_class: 'procedure',
        knowledge_state: 'disputed',
        source: 'user_stated',
        confidence: 'medium',
        trust_score: 0.3,
      });

      const profile = await getProfile(asyncAdapter, s);
      const allFacts = Object.values(profile.sections).flat().map((e) => e.fact);
      expect(allFacts).not.toContain('Disputed fact about deployment');
    });

    it('includes disputed knowledge when requested', async () => {
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Disputed fact about testing',
        fact_type: 'decision',
        knowledge_class: 'procedure',
        knowledge_state: 'disputed',
        source: 'user_stated',
        confidence: 'medium',
        trust_score: 0.3,
      });

      const profile = await getProfile(asyncAdapter, s, { includeDisputed: true });
      const allFacts = Object.values(profile.sections).flat().map((e) => e.fact);
      expect(allFacts).toContain('Disputed fact about testing');
    });

    it('excludes retired knowledge', async () => {
      const km = adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Old fact that was retired',
        fact_type: 'entity',
        knowledge_class: 'identity',
        source: 'user_stated',
        confidence: 'high',
        trust_score: 0.9,
      });
      adapter.retireKnowledgeMemory(km.id);

      const profile = await getProfile(asyncAdapter, s);
      const allFacts = Object.values(profile.sections).flat().map((e) => e.fact);
      expect(allFacts).not.toContain('Old fact that was retired');
    });

    it('filters by minimum trust score', async () => {
      const profile = await getProfile(asyncAdapter, s, { minimumTrustScore: 0.85 });
      const allEntries = Object.values(profile.sections).flat();
      for (const entry of allEntries) {
        expect(entry.trustScore).toBeGreaterThanOrEqual(0.85);
      }
    });

    it('filters by requested sections', async () => {
      const profile = await getProfile(asyncAdapter, s, {
        sections: ['identity', 'constraints'],
      });
      expect(profile.sections.identity.length).toBeGreaterThan(0);
      expect(profile.sections.constraints.length).toBeGreaterThan(0);
      expect(profile.sections.preferences.length).toBe(0);
      expect(profile.sections.communication.length).toBe(0);
      expect(profile.sections.workflows.length).toBe(0);
    });

    it('sorts entries by trust score descending', async () => {
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Low trust preference',
        fact_type: 'preference',
        knowledge_class: 'preference',
        source: 'user_stated',
        confidence: 'medium',
        trust_score: 0.3,
      });

      const profile = await getProfile(asyncAdapter, s);
      const prefs = profile.sections.preferences;
      for (let i = 1; i < prefs.length; i++) {
        expect(prefs[i - 1].trustScore).toBeGreaterThanOrEqual(prefs[i].trustScore);
      }
    });

    it('includes provenance metadata in entries', async () => {
      const profile = await getProfile(asyncAdapter, s);
      const entry = profile.sections.identity[0];
      expect(entry.knowledgeId).toBeGreaterThan(0);
      expect(typeof entry.trustScore).toBe('number');
      expect(typeof entry.knowledgeState).toBe('string');
      expect(typeof entry.confidence).toBe('string');
    });
  });
});
