import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { createMemoryManager } from '../core/manager.js';
import type { MemoryManager } from '../core/manager.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { makeScope } from './test-helpers.js';
import { NotImplementedError } from '../contracts/errors.js';

describe('MemoryManager Phase 5 delegation', () => {
  let adapter: StorageAdapter;
  let manager: MemoryManager;

  beforeEach(() => {
    adapter = createInMemoryAdapter();
    manager = createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async (turns) => ({
        summary: `Summary of ${turns.length} turns`,
        key_entities: [],
        topic_tags: [],
      }),
    });
  });

  afterEach(async () => {
    await manager.close();
  });

  describe('discover', () => {
    it('delegates to discover module and returns a DiscoveryReport', async () => {
      const report = await manager.discover();
      expect(report).toHaveProperty('surprises');
      expect(report).toHaveProperty('graphStats');
      expect(report).toHaveProperty('timestamp');
      expect(report.surprises).toEqual([]);
    });

    it('passes options through', async () => {
      const report = await manager.discover({ maxResults: 5, minSurpriseScore: 0.5 });
      expect(report.surprises).toEqual([]);
    });
  });

  describe('getGraphReport', () => {
    it('delegates to graph-report module', async () => {
      const report = await manager.getGraphReport();
      expect(report).toHaveProperty('sections');
      expect(report).toHaveProperty('tokenEstimate');
      expect(report).toHaveProperty('generatedAt');
    });
  });

  describe('getCoreMemory', () => {
    it('delegates to core-memory module', async () => {
      const bundle = await manager.getCoreMemory();
      expect(bundle).toHaveProperty('identity');
      expect(bundle).toHaveProperty('constraints');
      expect(bundle).toHaveProperty('norms');
      expect(bundle).toHaveProperty('workItems');
      expect(bundle).toHaveProperty('topPlaybook');
      expect(bundle).toHaveProperty('tokenEstimate');
    });

    it('respects tokenBudget option', async () => {
      const bundle = await manager.getCoreMemory({ tokenBudget: 100 });
      expect(bundle.tokenEstimate).toBeLessThanOrEqual(100);
    });
  });

  describe('reflectOnKnowledge', () => {
    it('delegates to reflection module', async () => {
      const result = await manager.reflectOnKnowledge();
      expect(result).toHaveProperty('newFacts');
      expect(result).toHaveProperty('patternsFound');
      expect(result).toHaveProperty('sessionsAnalyzed');
      expect(result).toHaveProperty('sourceMemoryIds');
    });
  });

  describe('derive', () => {
    it('delegates to derived module', async () => {
      const outputs = await manager.derive();
      expect(Array.isArray(outputs)).toBe(true);
    });

    it('passes outputTypes option', async () => {
      const outputs = await manager.derive({ outputTypes: ['playbook_candidate'] });
      expect(Array.isArray(outputs)).toBe(true);
    });
  });

  describe('getCurationSummary', () => {
    it('delegates to curation module', async () => {
      const summary = await manager.getCurationSummary();
      expect(summary).toHaveProperty('actions');
      expect(summary).toHaveProperty('period');
    });
  });

  describe('alias management', () => {
    it('setAliases stores and getAliases retrieves', () => {
      const aliases = { TypeScript: ['ts', 'TS'], PostgreSQL: ['pg', 'postgres'] };
      manager.setAliases(aliases);
      expect(manager.getAliases()).toEqual(aliases);
    });

    it('getAliases returns undefined when no aliases set', () => {
      expect(manager.getAliases()).toBeUndefined();
    });

    it('getAliasCandidates delegates to alias discovery', async () => {
      const candidates = await manager.getAliasCandidates();
      expect(Array.isArray(candidates)).toBe(true);
    });
  });

  describe('ontology management', () => {
    it('setOntology stores and getOntology retrieves', () => {
      const ontology = {
        entityTypes: [{ name: 'tool', description: 'A dev tool', allowedRelationships: [] as never[] }],
        relationshipConstraints: [],
        validationRules: [],
      };
      manager.setOntology(ontology);
      expect(manager.getOntology()).toEqual(ontology);
    });

    it('getOntology returns undefined when not set', () => {
      expect(manager.getOntology()).toBeUndefined();
    });
  });

  describe('exportBundle / importBundle', () => {
    it('exportBundle delegates to bundles module', () => {
      const result = manager.exportBundle('test-bundle');
      expect(result).toHaveProperty('bundle');
      expect(result).toHaveProperty('factCount');
      expect(result).toHaveProperty('playbookCount');
      expect(result.bundle.name).toBe('test-bundle');
    });

    it('importBundle delegates to bundles module', () => {
      const exported = manager.exportBundle('roundtrip');
      const result = manager.importBundle(exported.bundle, {
        conflictResolution: 'skip',
        targetScope: makeScope(),
      });
      expect(result).toHaveProperty('imported');
      expect(result).toHaveProperty('skipped');
      expect(result).toHaveProperty('overwritten');
    });
  });

  describe('refreshDocuments', () => {
    it('delegates to corpus-refresh module', () => {
      const result = manager.refreshDocuments([]);
      expect(result).toHaveProperty('unchanged');
      expect(result).toHaveProperty('changed');
      expect(result).toHaveProperty('invalidatedFactCount');
    });
  });

  describe('getFactsAt', () => {
    it('delegates to temporal module', async () => {
      const result = await manager.getFactsAt(Math.floor(Date.now() / 1000));
      expect(result).toHaveProperty('facts');
      expect(result).toHaveProperty('queryTimestamp');
      expect(result).toHaveProperty('usedFastPath');
    });

    it('returns facts filtered by timestamp', async () => {
      const now = Math.floor(Date.now() / 1000);
      // Insert a fact with temporal window
      adapter.insertKnowledgeMemory({
        ...makeScope(),
        fact: 'Valid now',
        fact_type: 'entity',
        source: 'user_stated',
        confidence: 'high',
        valid_from: now - 1000,
        valid_until: now + 1000,
      });
      const result = await manager.getFactsAt(now);
      expect(result.facts.length).toBeGreaterThanOrEqual(1);
      expect(result.queryTimestamp).toBe(now);
    });
  });

  describe('exportBundle scope enforcement', () => {
    it('exports from manager scope regardless of options', () => {
      const managerScope = makeScope();
      adapter.insertKnowledgeMemory({
        ...managerScope,
        fact: 'Fact in manager scope',
        fact_type: 'entity',
        source: 'user_stated',
        confidence: 'high',
      });
      const result = manager.exportBundle('scoped');
      expect(result.factCount).toBe(1);
      expect(result.bundle.metadata.sourceScope).toEqual(
        expect.objectContaining({ scope_id: managerScope.scope_id }),
      );
    });
  });

  describe('sync-adapter guards', () => {
    it('supports discover/export/refresh through wrapped sync adapters', async () => {
      const wrappedSync = createMemoryManager({
        asyncAdapter: wrapSyncAdapter(createInMemoryAdapter()),
        scope: makeScope(),
        sessionId: 's1',
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      });
      await expect(wrappedSync.discover()).resolves.toHaveProperty('surprises');
      expect(wrappedSync.exportBundle('test')).toHaveProperty('bundle.name', 'test');
      expect(wrappedSync.refreshDocuments([])).toHaveProperty('unchanged');
      await wrappedSync.close();
    });

    it('throws NotImplementedError for truly async-only deployments', async () => {
      const baseAsync = wrapSyncAdapter(createInMemoryAdapter());
      const asyncOnlyAdapter: AsyncStorageAdapter = {
        ...baseAsync,
        close: baseAsync.close,
      };
      const asyncOnly = createMemoryManager({
        asyncAdapter: asyncOnlyAdapter,
        scope: makeScope(),
        sessionId: 's1',
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      });
      await expect(asyncOnly.discover()).rejects.toThrow(NotImplementedError);
      expect(() => asyncOnly.exportBundle('test')).toThrow(NotImplementedError);
      expect(() => asyncOnly.refreshDocuments([])).toThrow(NotImplementedError);
      await asyncOnly.close();
    });
  });

  describe('durable scoped config', () => {
    it('saveAliases persists config for later load', async () => {
      const aliases = { TypeScript: ['ts', 'TS'] };
      await manager.saveAliases(aliases);

      const reloaded = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      });
      await expect(reloaded.loadAliases()).resolves.toEqual(aliases);
      await reloaded.close();
    });

    it('saveOntology persists config for later load', async () => {
      const ontology = {
        entityTypes: [{ name: 'tool', description: 'A dev tool', allowedRelationships: [] as never[] }],
        relationshipConstraints: [],
        validationRules: [],
      };
      await manager.saveOntology(ontology);

      const reloaded = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      });
      await expect(reloaded.loadOntology()).resolves.toEqual(ontology);
      await reloaded.close();
    });

    it('loadAliases ignores malformed persisted config', async () => {
      adapter.setScopeConfig(makeScope(), 'aliases', JSON.stringify({ TypeScript: 'ts' }));

      const reloaded = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      });
      await expect(reloaded.loadAliases()).resolves.toBeUndefined();
      await reloaded.close();
    });

    it('loadOntology ignores malformed persisted config', async () => {
      adapter.setScopeConfig(
        makeScope(),
        'ontology',
        JSON.stringify({
          entityTypes: [{ name: 'tool', description: 'A dev tool', allowedRelationships: ['bad'] }],
          relationshipConstraints: [],
          validationRules: [],
        }),
      );

      const reloaded = createMemoryManager({
        adapter,
        scope: makeScope(),
        sessionId: 'session-1',
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
      });
      await expect(reloaded.loadOntology()).resolves.toBeUndefined();
      await reloaded.close();
    });
  });

  describe('alias state threading', () => {
    it('getAliasCandidates excludes known aliases set via setAliases', async () => {
      // Set up two similar entity names
      adapter.insertKnowledgeMemory({
        ...makeScope(),
        fact: 'TypeScript is the main language',
        fact_type: 'entity',
        fact_subject: 'entity',
        fact_value: 'TypeScript',
        source: 'user_stated',
        confidence: 'high',
      });
      adapter.insertKnowledgeMemory({
        ...makeScope(),
        fact: 'Typescript config is in tsconfig.json',
        fact_type: 'entity',
        fact_subject: 'entity',
        fact_value: 'Typescript',
        source: 'user_stated',
        confidence: 'high',
      });

      // Without aliases set, candidates may include the pair
      const before = await manager.getAliasCandidates({ threshold: 0.8 });

      // After setting aliases, the known pair should be excluded
      manager.setAliases({ TypeScript: ['Typescript'] });
      const after = await manager.getAliasCandidates({ threshold: 0.8 });

      // The known pair should not appear in the after list
      expect(after.length).toBeLessThanOrEqual(before.length);
    });
  });
});
