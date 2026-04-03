import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StructuredGenerationClient } from '../summarizers/client.js';
import { searchEpisodes, summarizeEpisode, reflect } from '../core/episodic.js';
import type { Turn, WorkingMemory } from '../contracts/types.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function createMockClient(response: Record<string, unknown>): StructuredGenerationClient {
  return {
    async generate() {
      return JSON.stringify(response);
    },
  };
}

describe('episodic recall', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;
  const s = scope();

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
    // Seed turns
    adapter.insertTurn({
      ...s,
      session_id: 'sess-1',
      actor: 'user',
      role: 'user',
      content: 'Deploy the API to staging',
      token_estimate: 10,
      created_at: nowSec() - 300,
    });
    adapter.insertTurn({
      ...s,
      session_id: 'sess-1',
      actor: 'assistant',
      role: 'assistant',
      content: 'I deployed the API to staging. All health checks pass.',
      token_estimate: 15,
      created_at: nowSec() - 200,
    });
    adapter.insertTurn({
      ...s,
      session_id: 'sess-1',
      actor: 'user',
      role: 'user',
      content: 'Now run the integration tests',
      token_estimate: 10,
      created_at: nowSec() - 100,
    });
    // Seed working memory
    adapter.insertWorkingMemory({
      ...s,
      session_id: 'sess-1',
      summary: 'User deployed API to staging and requested integration tests.',
      key_entities: ['API', 'staging'],
      topic_tags: ['deployment'],
      turn_id_start: 1,
      turn_id_end: 3,
      turn_count: 3,
      compaction_trigger: 'soft',
    });
    // Seed knowledge
    adapter.insertKnowledgeMemory({
      ...s,
      fact: 'The staging API runs on port 8080',
      fact_type: 'entity',
      source: 'user_stated',
      confidence: 'high',
    });
  });

  afterEach(() => {
    adapter.close();
  });

  describe('searchEpisodes', () => {
    it('groups results by session and returns EpisodeSummary', async () => {
      const client = createMockClient({
        objective: 'Deploy API to staging',
        actions: ['deployed API', 'ran health checks'],
        outcomes: ['health checks passed'],
        artifacts: ['staging-endpoint'],
        unresolvedItems: ['integration tests pending'],
        sourceType: 'episodic',
        sources: [{ type: 'turn', id: 1, excerpt: 'Deploy the API' }],
      });

      const results = await searchEpisodes(
        { adapter: asyncAdapter, scope: s, client },
        { query: 'deploy', detailLevel: 'overview' },
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      const first = results[0];
      expect(first.sessionId).toBe('sess-1');
      expect(first.detailLevel).toBe('overview');
      expect(first.recap.objective).toBe('Deploy API to staging');
      expect(first.recap.sourceType).toBe('episodic');
      expect(first.recap.sources.length).toBeGreaterThanOrEqual(1);
      expect(first.turnRange.start).toBeGreaterThan(0);
      expect(first.turnRange.end).toBeGreaterThanOrEqual(first.turnRange.start);
    });

    it('preserves source references back to turn IDs', async () => {
      const client = createMockClient({
        objective: 'Deploy',
        actions: [],
        outcomes: [],
        artifacts: [],
        unresolvedItems: [],
        sourceType: 'episodic',
        sources: [
          { type: 'turn', id: 1, excerpt: 'Deploy the API' },
          { type: 'working_memory', id: 1, excerpt: 'summary' },
        ],
      });

      const results = await searchEpisodes(
        { adapter: asyncAdapter, scope: s, client },
        { query: 'deploy' },
      );

      const sources = results[0].recap.sources;
      expect(sources.some((s) => s.type === 'turn')).toBe(true);
      expect(sources.some((s) => s.type === 'working_memory')).toBe(true);
      for (const src of sources) {
        expect(typeof src.id).toBe('number');
      }
    });
  });

  describe('summarizeEpisode', () => {
    it('supports abstract detail level — only objective and outcomes', async () => {
      const client = createMockClient({
        objective: 'Deploy API',
        actions: [],
        outcomes: ['deployed successfully'],
        artifacts: [],
        unresolvedItems: [],
        sourceType: 'episodic',
        sources: [{ type: 'turn', id: 1, excerpt: null }],
      });

      const turns = adapter.getActiveTurns(s, 'sess-1');
      const wm = adapter.getActiveWorkingMemory(s, 'sess-1');

      const result = await summarizeEpisode(
        { adapter: asyncAdapter, scope: s, client },
        {
          turns,
          workingMemories: wm,
          sessionId: 'sess-1',
          detailLevel: 'abstract',
          client,
        },
      );

      expect(result.detailLevel).toBe('abstract');
      expect(result.recap.objective).toBe('Deploy API');
      expect(result.recap.outcomes).toEqual(['deployed successfully']);
    });

    it('supports overview detail level — adds actions', async () => {
      const client = createMockClient({
        objective: 'Deploy API',
        actions: ['deployed to staging', 'ran health checks'],
        outcomes: ['all checks passed'],
        artifacts: [],
        unresolvedItems: ['integration tests'],
        sourceType: 'episodic',
        sources: [{ type: 'turn', id: 1, excerpt: null }],
      });

      const turns = adapter.getActiveTurns(s, 'sess-1');

      const result = await summarizeEpisode(
        { adapter: asyncAdapter, scope: s, client },
        {
          turns,
          workingMemories: [],
          sessionId: 'sess-1',
          detailLevel: 'overview',
          client,
        },
      );

      expect(result.detailLevel).toBe('overview');
      expect(result.recap.actions.length).toBeGreaterThan(0);
      expect(result.recap.unresolvedItems.length).toBeGreaterThan(0);
    });

    it('supports full detail level — includes artifacts and excerpts', async () => {
      const client = createMockClient({
        objective: 'Deploy API to staging',
        actions: ['deployed to staging', 'verified health checks'],
        outcomes: ['deployment succeeded'],
        artifacts: ['staging-endpoint', '/api/health'],
        unresolvedItems: ['run integration tests'],
        sourceType: 'episodic',
        sources: [
          { type: 'turn', id: 1, excerpt: 'Deploy the API to staging' },
          { type: 'turn', id: 2, excerpt: 'I deployed the API to staging' },
        ],
      });

      const turns = adapter.getActiveTurns(s, 'sess-1');
      const wm = adapter.getActiveWorkingMemory(s, 'sess-1');

      const result = await summarizeEpisode(
        { adapter: asyncAdapter, scope: s, client },
        {
          turns,
          workingMemories: wm,
          sessionId: 'sess-1',
          detailLevel: 'full',
          client,
        },
      );

      expect(result.detailLevel).toBe('full');
      expect(result.recap.artifacts.length).toBeGreaterThan(0);
      expect(result.recap.sources.some((s) => s.excerpt !== null)).toBe(true);
    });
  });

  describe('reflect', () => {
    it('gathers episodic + declarative knowledge and reports sourceType accurately', async () => {
      const client: StructuredGenerationClient = {
        async generate(req) {
          // searchEpisodes also calls generate, so we need to handle both prompts
          if (req.systemPrompt.includes('episodic recaps')) {
            return JSON.stringify({
              objective: 'Deploy API',
              actions: [],
              outcomes: [],
              artifacts: [],
              unresolvedItems: [],
              sourceType: 'episodic',
              sources: [{ type: 'turn', id: 1, excerpt: null }],
            });
          }
          return JSON.stringify({
            synthesis: 'The API was deployed to staging on port 8080. Health checks passed.',
            sourceType: 'mixed',
            sources: [
              { type: 'turn', id: 1, excerpt: 'Deploy the API' },
              { type: 'knowledge', id: 1, excerpt: 'port 8080' },
            ],
            episodes: [],
            detailLevel: 'overview',
          });
        },
      };

      const result = await reflect(
        { adapter: asyncAdapter, scope: s, client },
        { query: 'staging', includeEpisodic: true, includeDeclarative: true },
      );

      expect(result.sourceType).toBe('mixed');
      expect(result.synthesis).toContain('8080');
      expect(result.sources.some((s) => s.type === 'turn')).toBe(true);
      expect(result.sources.some((s) => s.type === 'knowledge')).toBe(true);
      expect(result.detailLevel).toBe('overview');
    });

    it('reports episodic sourceType when only episodic data is queried', async () => {
      const client: StructuredGenerationClient = {
        async generate(req) {
          if (req.systemPrompt.includes('episodic recaps')) {
            return JSON.stringify({
              objective: 'Deploy',
              actions: [],
              outcomes: [],
              artifacts: [],
              unresolvedItems: [],
              sourceType: 'episodic',
              sources: [],
            });
          }
          return JSON.stringify({
            synthesis: 'Deployed the API to staging.',
            sourceType: 'episodic',
            sources: [{ type: 'turn', id: 1, excerpt: null }],
            episodes: [],
            detailLevel: 'overview',
          });
        },
      };

      const result = await reflect(
        { adapter: asyncAdapter, scope: s, client },
        { query: 'deploy', includeEpisodic: true, includeDeclarative: false },
      );

      expect(result.sourceType).toBe('episodic');
    });

    it('reports declarative sourceType when only knowledge is queried', async () => {
      const client: StructuredGenerationClient = {
        async generate() {
          return JSON.stringify({
            synthesis: 'The staging API runs on port 8080.',
            sourceType: 'declarative',
            sources: [{ type: 'knowledge', id: 1, excerpt: 'port 8080' }],
            episodes: [],
            detailLevel: 'overview',
          });
        },
      };

      const result = await reflect(
        { adapter: asyncAdapter, scope: s, client },
        { query: 'port', includeEpisodic: false, includeDeclarative: true },
      );

      expect(result.sourceType).toBe('declarative');
    });

    it('includes episode summaries in the result', async () => {
      const client: StructuredGenerationClient = {
        async generate(req) {
          if (req.systemPrompt.includes('episodic recaps')) {
            return JSON.stringify({
              objective: 'Deploy API',
              actions: ['deployed'],
              outcomes: ['success'],
              artifacts: [],
              unresolvedItems: [],
              sourceType: 'episodic',
              sources: [{ type: 'turn', id: 1, excerpt: null }],
            });
          }
          return JSON.stringify({
            synthesis: 'The API was deployed.',
            sourceType: 'episodic',
            sources: [{ type: 'turn', id: 1, excerpt: null }],
            episodes: [],
            detailLevel: 'overview',
          });
        },
      };

      const result = await reflect(
        { adapter: asyncAdapter, scope: s, client },
        { query: 'deploy' },
      );

      expect(result.episodes.length).toBeGreaterThanOrEqual(1);
      expect(result.episodes[0].recap.objective).toBe('Deploy API');
    });

    it('never silently promotes episode summaries to trusted knowledge', async () => {
      const client = createMockClient({
        objective: 'Deploy',
        actions: [],
        outcomes: [],
        artifacts: [],
        unresolvedItems: [],
        sourceType: 'episodic',
        sources: [],
      });

      const knowledgeBefore = adapter.getActiveKnowledgeMemory(s);

      await searchEpisodes(
        { adapter: asyncAdapter, scope: s, client },
        { query: 'deploy' },
      );

      const knowledgeAfter = adapter.getActiveKnowledgeMemory(s);
      expect(knowledgeAfter.length).toBe(knowledgeBefore.length);
    });
  });
});
