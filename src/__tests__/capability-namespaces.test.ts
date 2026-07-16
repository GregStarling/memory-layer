import { describe, expect, it, vi } from 'vitest';

import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { createMemoryManager, type MemoryManagerConfig } from '../core/manager.js';
import { estimateTokens } from '../core/tokens.js';
import { createCircuitBreaker } from '../core/circuit-breaker.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { CapabilityContext, TemporalContextState } from '../core/capabilities/context.js';
import { createCoordinationCapability } from '../core/capabilities/coordination.js';
import { createGovernanceCapability } from '../core/capabilities/governance.js';
import { createTemporalCapability } from '../core/capabilities/temporal.js';
import { createPlaybooksCapability } from '../core/capabilities/playbooks.js';
import { createCurationCapability } from '../core/capabilities/curation.js';
import { createGraphCapability } from '../core/capabilities/graph.js';
import { makeScope } from './test-helpers.js';

/**
 * Phase 6.2 facade split. Two properties per capability namespace:
 *  1. Isolation — the capability constructs and runs standalone from just a
 *     storage adapter + explicit context (no full MemoryManager required).
 *  2. Equivalence — the flat @deprecated shim delegates to its namespace twin
 *     and returns identical results (the D-BREAK back-compat proof).
 */

const trivialSummarizer = async () => ({
  summary: 'summary',
  key_entities: [] as string[],
  topic_tags: [] as string[],
});

function makeConfig(): { config: MemoryManagerConfig; asyncAdapter: AsyncStorageAdapter } {
  const memory = createInMemoryAdapter();
  const config: MemoryManagerConfig = {
    adapter: memory,
    scope: makeScope(),
    sessionId: 'session-ns',
    summarizer: trivialSummarizer,
  };
  return { config, asyncAdapter: wrapSyncAdapter(memory) };
}

const EMPTY_TEMPORAL_STATE: TemporalContextState = {
  turns: [],
  workingMemory: [],
  knowledge: [],
  workItems: [],
  workClaims: [],
  handoffs: [],
  associations: [],
  playbooks: [],
};

/**
 * A minimal CapabilityContext for isolation tests: real base (adapter/config)
 * plus stub internal services. Capabilities under test exercise methods that
 * touch only the adapter, proving they need nothing from the manager closure.
 */
function stubContext(config: MemoryManagerConfig, asyncAdapter: AsyncStorageAdapter): CapabilityContext {
  return {
    asyncAdapter,
    config,
    onEvent: () => {},
    tokenEstimator: estimateTokens,
    circuitBreakers: {
      summarizer: createCircuitBreaker(),
      extractor: createCircuitBreaker(),
      embeddings: createCircuitBreaker(),
    },
    activeEmbeddingModel: 'unknown',
    emitKnowledgeChange: () => {},
    emitDegradation: () => {},
    maybeEmbedKnowledge: async () => {},
    refreshSessionStateProjection: async () => {},
    getContextInternal: async () => {
      throw new Error('stub getContextInternal');
    },
    buildReplayedContext: async () => {
      throw new Error('stub buildReplayedContext');
    },
    collectKnowledgeForProfile: async () => [],
    buildSessionBootstrapPayload: () => ({}) as never,
    filterTemporalStateForContext: (state) => state,
    collectBestEffortTemporalState: async () => EMPTY_TEMPORAL_STATE,
    getTemporalCutoverAt: async () => null,
    resolveChangeStreamCursorInternal: async () => '0',
    listKnowledgeChangesInternal: async () => ({ changes: [], nextCursor: '0' }),
  };
}

describe('capability namespaces — independent construction (isolation)', () => {
  it('coordination constructs from an adapter and tracks/lists work items', async () => {
    const { config, asyncAdapter } = makeConfig();
    const coordination = createCoordinationCapability({
      asyncAdapter,
      config,
      refreshSessionStateProjection: async () => {},
    });
    const item = await coordination.trackWorkItem('isolated objective');
    expect(item.title).toBe('isolated objective');
    const claims = await coordination.listWorkClaims();
    expect(Array.isArray(claims)).toBe(true);
  });

  it('governance constructs and round-trips a context contract through its own cache', async () => {
    const { config, asyncAdapter } = makeConfig();
    const { namespace } = createGovernanceCapability({ asyncAdapter, config });
    await namespace.putContextContract('strict', { view: 'local_only' });
    const snapshot = await namespace.getContextGovernance();
    expect(snapshot.contracts.strict).toBeDefined();
    expect(snapshot.contracts.strict.view).toBe('local_only');
  });

  it('playbooks constructs and creates/lists a playbook', async () => {
    const { config, asyncAdapter } = makeConfig();
    const playbooks = createPlaybooksCapability({ asyncAdapter, config });
    const created = await playbooks.createPlaybook({
      title: 'iso playbook',
      description: 'd',
      instructions: 'do the thing',
    });
    const fetched = await playbooks.getPlaybook(created.id);
    expect(fetched?.title).toBe('iso playbook');
    expect(await playbooks.listPlaybooks()).toHaveLength(1);
  });

  it('graph constructs and reads associations for an entity', async () => {
    const { config, asyncAdapter } = makeConfig();
    const graph = createGraphCapability({ asyncAdapter, config });
    const associations = await graph.getAssociations('knowledge', 1);
    expect(associations).toEqual({ from: [], to: [] });
  });

  it('temporal constructs from an explicit context and reads the timeline', async () => {
    const { config, asyncAdapter } = makeConfig();
    const temporal = createTemporalCapability(stubContext(config, asyncAdapter));
    const timeline = await temporal.getTimeline();
    expect(Array.isArray(timeline.events)).toBe(true);
    expect(await temporal.getContextMonitor()).toBeNull();
  });

  it('curation constructs from an explicit context, owns its cache, and lists knowledge', async () => {
    const { config, asyncAdapter } = makeConfig();
    const curation = createCurationCapability(stubContext(config, asyncAdapter));
    const page = await curation.namespace.listKnowledge();
    expect(Array.isArray(page.items)).toBe(true);
    // The maintenance cache lives inside the curation module (item 3): with no
    // recorded maintenance the summary auto-populates with undefined inputs.
    const before = await curation.namespace.getCurationSummary();
    expect(before).toBeDefined();
  });
});

describe('capability namespaces — flat shim ⇆ namespace equivalence (D-BREAK)', () => {
  it('exposes all six namespaces on the manager', () => {
    const { config } = makeConfig();
    const manager = createMemoryManager(config);
    for (const ns of ['coordination', 'governance', 'temporal', 'playbooks', 'curation', 'graph'] as const) {
      expect(typeof manager[ns]).toBe('object');
    }
  });

  it('coordination: flat listWorkClaims delegates to the namespace twin', async () => {
    const { config } = makeConfig();
    const manager = createMemoryManager(config);
    await manager.trackWorkItem('shared objective');
    const spy = vi.spyOn(manager.coordination, 'listWorkClaims');
    const viaFlat = await manager.listWorkClaims();
    expect(spy).toHaveBeenCalledTimes(1);
    const viaNamespace = await manager.coordination.listWorkClaims();
    expect(viaFlat).toEqual(viaNamespace);
  });

  it('governance: flat getContextGovernance === namespace getContextGovernance', async () => {
    const { config } = makeConfig();
    const manager = createMemoryManager(config);
    await manager.governance.putContextContract('c1', { view: 'workspace_shared' });
    const viaFlat = await manager.getContextGovernance();
    const viaNamespace = await manager.governance.getContextGovernance();
    expect(viaFlat).toEqual(viaNamespace);
    expect(viaFlat.contracts.c1.view).toBe('workspace_shared');
  });

  it('temporal: flat getTimeline delegates and matches the namespace twin', async () => {
    const { config } = makeConfig();
    const manager = createMemoryManager(config);
    await manager.processExchange('hello', 'hi there');
    const spy = vi.spyOn(manager.temporal, 'getTimeline');
    const viaFlat = await manager.getTimeline();
    expect(spy).toHaveBeenCalledTimes(1);
    const viaNamespace = await manager.temporal.getTimeline();
    expect(viaFlat.events.length).toBe(viaNamespace.events.length);
  });

  it('playbooks: flat listPlaybooks === namespace listPlaybooks', async () => {
    const { config } = makeConfig();
    const manager = createMemoryManager(config);
    await manager.playbooks.createPlaybook({ title: 'p', description: 'd', instructions: 'i' });
    expect(await manager.listPlaybooks()).toEqual(await manager.playbooks.listPlaybooks());
  });

  it('curation: flat learnFact result surfaces through both flat and namespace listKnowledge', async () => {
    const { config } = makeConfig();
    const manager = createMemoryManager(config);
    await manager.learnFact('the sky is blue', 'entity');
    const viaFlat = await manager.listKnowledge();
    const viaNamespace = await manager.curation.listKnowledge();
    expect(viaFlat).toEqual(viaNamespace);
    expect(viaFlat.items.length).toBe(1);
  });

  it('graph: flat getAssociations === namespace getAssociations', async () => {
    const { config } = makeConfig();
    const manager = createMemoryManager(config);
    const km = await manager.learnFact('graph fact', 'entity');
    expect(await manager.getAssociations('knowledge', km.id)).toEqual(
      await manager.graph.getAssociations('knowledge', km.id),
    );
  });

  it('curation reverify shim preserves `this` binding of runReverification', async () => {
    const { config } = makeConfig();
    const manager = createMemoryManager(config);
    // runReverification internally calls this.reverifyKnowledge; the flat shim
    // must invoke it as a method on the namespace so `this` resolves.
    const result = await manager.runReverification();
    expect(result).toEqual({ reverifiedKnowledgeIds: [], demotedKnowledgeIds: [] });
  });
});
