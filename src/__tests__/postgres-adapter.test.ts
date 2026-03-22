import { describe, expect, it } from 'vitest';

import {
  createPostgresAdapter,
  createPostgresEmbeddingAdapter,
} from '../adapters/postgres/index.js';

describe('postgres adapter transactions', () => {
  it('pins transactional queries to a connected client', async () => {
    const rootQueries: string[] = [];
    const clientQueries: string[] = [];
    const client = {
      async query(text: string) {
        clientQueries.push(text);
        if (text.startsWith('INSERT INTO turns')) {
          return {
            rows: [
              {
                id: 1,
                tenant_id: 'acme',
                system_id: 'assistant',
                workspace_id: 'default',
                collaboration_id: '',
                scope_id: 'thread-1',
                session_id: 'session-1',
                actor: 'user',
                role: 'user',
                content: 'hello',
                priority: 1,
                token_estimate: 1,
                archived_at: null,
                compaction_log_id: null,
                created_at: 1,
                schema_version: 1,
              },
            ],
          };
        }
        return { rows: [] };
      },
      release() {},
    };
    const pool = {
      async query(text: string) {
        rootQueries.push(text);
        return { rows: [] };
      },
      async connect() {
        return client;
      },
      async end() {},
    };

    const adapter = createPostgresAdapter(pool);
    await adapter.transaction(async () => {
      await adapter.insertTurn({
        tenant_id: 'acme',
        system_id: 'assistant',
        scope_id: 'thread-1',
        session_id: 'session-1',
        actor: 'user',
        role: 'user',
        content: 'hello',
      });
    });

    expect(rootQueries).toEqual([]);
    expect(clientQueries[0]).toBe('BEGIN');
    expect(clientQueries.some((query) => query.startsWith('INSERT INTO turns'))).toBe(true);
    expect(clientQueries.at(-1)).toBe('COMMIT');
  });

  it('uses savepoints for nested transactions', async () => {
    const clientQueries: string[] = [];
    const client = {
      async query(text: string) {
        clientQueries.push(text);
        return { rows: [] };
      },
      release() {},
    };
    const pool = {
      async query() {
        return { rows: [] };
      },
      async connect() {
        return client;
      },
      async end() {},
    };

    const adapter = createPostgresAdapter(pool);
    await adapter.transaction(async () => {
      await adapter.transaction(async () => {
        await Promise.resolve();
      });
    });

    expect(clientQueries).toContain('BEGIN');
    expect(clientQueries.some((query) => query.startsWith('SAVEPOINT memory_layer_sp_'))).toBe(true);
    expect(clientQueries.some((query) => query.startsWith('RELEASE SAVEPOINT memory_layer_sp_'))).toBe(
      true,
    );
    expect(clientQueries.at(-1)).toBe('COMMIT');
  });

  it('stores and searches embeddings through pgvector queries', async () => {
    const queries: string[] = [];
    const pool = {
      async query(text: string) {
        queries.push(text);
        if (text.startsWith('INSERT INTO knowledge_embeddings')) {
          return { rows: [{ knowledge_memory_id: 5 }] };
        }
        if (text.startsWith('SELECT embedding')) {
          return { rows: [{ embedding: '[1,0,0]' }] };
        }
        if (text.includes('ORDER BY ke.embedding <=>')) {
          return { rows: [{ knowledge_memory_id: 5, similarity: 0.92 }] };
        }
        return { rows: [] };
      },
      async connect() {
        return {
          async query() {
            return { rows: [] };
          },
          release() {},
        };
      },
      async end() {},
    };

    const embeddings = createPostgresEmbeddingAdapter(pool);
    await embeddings.storeEmbedding(5, new Float32Array([1, 0, 0]));
    const stored = await embeddings.getEmbedding(5);
    const similar = await embeddings.findSimilar(
      {
        tenant_id: 'acme',
        system_id: 'assistant',
        scope_id: 'thread-1',
      },
      new Float32Array([1, 0, 0]),
      { limit: 3, minSimilarity: 0.4 },
    );

    expect(queries.some((query) => query.includes('INSERT INTO knowledge_embeddings'))).toBe(true);
    expect(queries.some((query) => query.includes('ORDER BY ke.embedding <=>'))).toBe(true);
    expect(Array.from(stored ?? [])).toEqual([1, 0, 0]);
    expect(similar[0]).toEqual({ knowledgeMemoryId: 5, similarity: 0.92 });
  });
});
