import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import { exportBundle, importBundle } from '../core/bundles.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

describe('bundles', () => {
  let adapter: StorageAdapter;
  const s = scope();

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  describe('exportBundle', () => {
    it('exports all active facts and playbooks for a scope', () => {
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'User prefers dark mode',
        fact_type: 'preference',
        knowledge_class: 'preference',
        source: 'user_stated',
        confidence: 'high',
      });
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Project uses TypeScript',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
      });
      adapter.insertPlaybook({
        ...s,
        title: 'Deploy procedure',
        description: 'How to deploy',
        instructions: 'Run npm run deploy',
      });

      const result = exportBundle(adapter, 'test-bundle', { scope: s });

      expect(result.factCount).toBe(2);
      expect(result.playbookCount).toBe(1);
      expect(result.bundle.name).toBe('test-bundle');
      expect(result.bundle.version).toBe('1.0.0');
      expect(result.bundle.facts).toHaveLength(2);
      expect(result.bundle.playbooks).toHaveLength(1);
      expect(result.bundle.exportedAt).toBeTruthy();
    });

    it('filters by knowledge class', () => {
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'User prefers dark mode',
        fact_type: 'preference',
        knowledge_class: 'preference',
        source: 'user_stated',
        confidence: 'high',
      });
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Project uses TypeScript',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
      });

      const result = exportBundle(adapter, 'prefs-only', {
        scope: s,
        knowledgeClassFilter: ['preference'],
      });

      expect(result.factCount).toBe(1);
      expect(result.bundle.facts[0].knowledge_class).toBe('preference');
    });

    it('filters by tags', () => {
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Tagged fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        tags: ['important'],
      });
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Untagged fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
      });

      const result = exportBundle(adapter, 'tagged', {
        scope: s,
        includeTags: ['important'],
      });

      expect(result.factCount).toBe(1);
      expect(result.bundle.facts[0].fact).toBe('Tagged fact');
    });

    it('exports empty bundle when no facts match', () => {
      const result = exportBundle(adapter, 'empty', { scope: s });

      expect(result.factCount).toBe(0);
      expect(result.playbookCount).toBe(0);
      expect(result.bundle.facts).toHaveLength(0);
      expect(result.bundle.playbooks).toHaveLength(0);
    });
  });

  describe('importBundle', () => {
    it('imports all facts and playbooks into target scope', () => {
      // Create facts in source scope
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Source fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
      });
      adapter.insertPlaybook({
        ...s,
        title: 'Source playbook',
        description: 'A playbook',
        instructions: 'Do stuff',
      });

      const { bundle } = exportBundle(adapter, 'transfer', { scope: s });
      const targetScope = scope({ scope_id: 'thread-2' });
      const result = importBundle(adapter, bundle, {
        conflictResolution: 'skip',
        targetScope,
      });

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.playbooksImported).toBe(1);

      const targetFacts = adapter.getActiveKnowledgeMemory(targetScope);
      expect(targetFacts).toHaveLength(1);
      expect(targetFacts[0].fact).toBe('Source fact');

      const targetPlaybooks = adapter.getActivePlaybooks(targetScope);
      expect(targetPlaybooks).toHaveLength(1);
      expect(targetPlaybooks[0].title).toBe('Source playbook');
    });

    it('skips conflicting facts with skip resolution', () => {
      const targetScope = scope({ scope_id: 'thread-2' });

      // Insert existing fact in target
      adapter.insertKnowledgeMemory({
        ...targetScope,
        fact: 'Existing version',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        normalized_fact: 'project uses typescript',
      });

      // Create bundle with conflicting fact
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Incoming version',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        normalized_fact: 'project uses typescript',
      });
      const { bundle } = exportBundle(adapter, 'conflict-test', { scope: s });

      const result = importBundle(adapter, bundle, {
        conflictResolution: 'skip',
        targetScope,
      });

      expect(result.skipped).toBe(1);
      expect(result.imported).toBe(0);

      const facts = adapter.getActiveKnowledgeMemory(targetScope);
      // Only the original should remain active
      const activeFacts = facts.filter((f) => f.knowledge_state !== 'retired');
      expect(activeFacts).toHaveLength(1);
      expect(activeFacts[0].fact).toBe('Existing version');
    });

    it('overwrites conflicting facts with overwrite resolution', () => {
      const targetScope = scope({ scope_id: 'thread-2' });

      adapter.insertKnowledgeMemory({
        ...targetScope,
        fact: 'Old fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        normalized_fact: 'project language',
      });

      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'New fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        normalized_fact: 'project language',
      });
      const { bundle } = exportBundle(adapter, 'overwrite-test', { scope: s });

      const result = importBundle(adapter, bundle, {
        conflictResolution: 'overwrite',
        targetScope,
      });

      expect(result.overwritten).toBe(1);

      const facts = adapter.getActiveKnowledgeMemory(targetScope);
      // The old one is retired, new one inserted
      expect(facts.some((f) => f.fact === 'New fact')).toBe(true);
    });

    it('uses trust_higher to pick the better fact', () => {
      const targetScope = scope({ scope_id: 'thread-2' });

      // Existing fact with high trust
      adapter.insertKnowledgeMemory({
        ...targetScope,
        fact: 'High trust fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        trust_score: 0.9,
        normalized_fact: 'same fact',
      });

      // Incoming fact with lower trust
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Low trust fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'medium',
        trust_score: 0.3,
        normalized_fact: 'same fact',
      });
      const { bundle } = exportBundle(adapter, 'trust-test', { scope: s });

      const result = importBundle(adapter, bundle, {
        conflictResolution: 'trust_higher',
        targetScope,
      });

      // Lower trust incoming should be skipped
      expect(result.skipped).toBe(1);
      expect(result.overwritten).toBe(0);

      const facts = adapter.getActiveKnowledgeMemory(targetScope);
      const active = facts.filter((f) => f.knowledge_state !== 'retired');
      expect(active).toHaveLength(1);
      expect(active[0].fact).toBe('High trust fact');
    });

    it('merges conflicting facts with merge resolution', () => {
      const targetScope = scope({ scope_id: 'thread-2' });

      adapter.insertKnowledgeMemory({
        ...targetScope,
        fact: 'Existing fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        trust_score: 0.5,
        normalized_fact: 'merge target',
      });

      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Incoming fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        trust_score: 0.8,
        normalized_fact: 'merge target',
      });
      const { bundle } = exportBundle(adapter, 'merge-test', { scope: s });

      const result = importBundle(adapter, bundle, {
        conflictResolution: 'merge',
        targetScope,
      });

      expect(result.merged).toBe(1);

      const facts = adapter.getActiveKnowledgeMemory(targetScope);
      const mergedFact = facts.find((f) => f.normalized_fact === 'merge target');
      expect(mergedFact).toBeTruthy();
      // Trust should be the max of both
      expect(mergedFact!.trust_score).toBe(0.8);
    });

    it('skips duplicate playbooks by title', () => {
      const targetScope = scope({ scope_id: 'thread-2' });

      adapter.insertPlaybook({
        ...targetScope,
        title: 'Same playbook',
        description: 'Existing',
        instructions: 'Existing instructions',
      });

      adapter.insertPlaybook({
        ...s,
        title: 'Same playbook',
        description: 'Incoming',
        instructions: 'Incoming instructions',
      });
      const { bundle } = exportBundle(adapter, 'pb-test', { scope: s });

      const result = importBundle(adapter, bundle, {
        conflictResolution: 'skip',
        targetScope,
      });

      expect(result.playbooksSkipped).toBe(1);
      expect(result.playbooksImported).toBe(0);

      const playbooks = adapter.getActivePlaybooks(targetScope);
      expect(playbooks).toHaveLength(1);
      expect(playbooks[0].description).toBe('Existing');
    });

    it('does not preserve trust when preserveTrust is false', () => {
      adapter.insertKnowledgeMemory({
        ...s,
        fact: 'Trusted fact',
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'user_stated',
        confidence: 'high',
        knowledge_state: 'trusted',
        trust_score: 0.95,
      });
      const { bundle } = exportBundle(adapter, 'no-trust', { scope: s });
      const targetScope = scope({ scope_id: 'thread-2' });

      importBundle(adapter, bundle, {
        conflictResolution: 'skip',
        targetScope,
        preserveTrust: false,
      });

      const facts = adapter.getActiveKnowledgeMemory(targetScope);
      expect(facts).toHaveLength(1);
      // Should be demoted to provisional when not preserving trust
      expect(facts[0].knowledge_state).toBe('provisional');
    });
  });
});
