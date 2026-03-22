import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { runMaintenance } from '../core/maintenance.js';
import { makeScope } from './test-helpers.js';

describe('knowledge lifecycle by class', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
  });

  afterEach(() => {
    adapter.close();
    vi.useRealTimers();
  });

  it('keeps trusted identity memory while expiring weak provisional memory', async () => {
    const scope = makeScope();
    const identity = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'The assistant identity is Memory Layer.',
      fact_type: 'entity',
      knowledge_state: 'trusted',
      knowledge_class: 'identity',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.95,
      verification_status: 'verified',
      last_confirmed_at: Math.floor(Date.now() / 1000),
      confirmation_count: 2,
    });
    const provisional = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'One-off note about a temporary branch.',
      fact_type: 'reference',
      knowledge_state: 'provisional',
      knowledge_class: 'episodic_fact',
      source: 'manual',
      confidence: 'medium',
      trust_score: 0.5,
    });

    vi.setSystemTime(new Date('2024-02-20T00:00:00Z'));
    const report = await runMaintenance(asyncAdapter, scope, {
      provisionalRetentionDays: 14,
      knowledgeStaleAfterSeconds: Number.MAX_SAFE_INTEGER,
      maxActiveKnowledgeItems: 20,
    });

    expect(report.retiredKnowledgeIds).toContain(provisional.id);
    expect(report.retiredKnowledgeIds).not.toContain(identity.id);
    expect(adapter.getKnowledgeMemoryById(identity.id)?.retired_at).toBeNull();
  });

  it('keeps validated strategies and anti-patterns longer than weak episodic facts', async () => {
    const scope = makeScope();
    const strategy = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Use smaller batches for migrations.',
      fact_type: 'decision',
      knowledge_state: 'trusted',
      knowledge_class: 'strategy',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
      successful_use_count: 3,
      last_confirmed_at: Math.floor(Date.now() / 1000),
      confirmation_count: 1,
    });
    const antiPattern = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Do not enable aggressive caching during deploys.',
      fact_type: 'decision',
      knowledge_state: 'trusted',
      knowledge_class: 'anti_pattern',
      source: 'manual',
      confidence: 'high',
      trust_score: 0.9,
      failed_use_count: 3,
      last_confirmed_at: Math.floor(Date.now() / 1000),
      confirmation_count: 1,
    });
    const episodic = adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Yesterday the user mentioned a green sidebar.',
      fact_type: 'reference',
      knowledge_state: 'trusted',
      knowledge_class: 'episodic_fact',
      source: 'manual',
      confidence: 'medium',
      trust_score: 0.45,
    });

    vi.setSystemTime(new Date('2024-03-20T00:00:00Z'));
    const report = await runMaintenance(asyncAdapter, scope, {
      knowledgeStaleAfterSeconds: Number.MAX_SAFE_INTEGER,
      maxActiveKnowledgeItems: 20,
      minKnowledgeAccessCount: 1,
    });

    expect(report.retiredKnowledgeIds).toContain(episodic.id);
    expect(report.retiredKnowledgeIds).not.toContain(strategy.id);
    expect(report.retiredKnowledgeIds).not.toContain(antiPattern.id);
  });
});
