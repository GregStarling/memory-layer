import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createPostgresAdapter,
  createPostgresEmbeddingAdapter,
} from '../adapters/postgres/index.js';

describe('postgres adapter transactions', () => {
  function loadSchemaSql(): string {
    return readFileSync(new URL('../adapters/postgres/schema.sql', import.meta.url), 'utf8');
  }

  it('keeps fresh schema parity for low confidence facts and boolean candidate flags', () => {
    const schemaSql = loadSchemaSql();

    expect(schemaSql).toMatch(/confidence IN \('high', 'medium', 'low'\)/);
    expect(schemaSql).toMatch(/source_summary BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(schemaSql).toMatch(/source_turns BOOLEAN NOT NULL DEFAULT TRUE/);
    expect(schemaSql).toMatch(/ALTER COLUMN source_summary TYPE BOOLEAN USING/);
    expect(schemaSql).toMatch(/ALTER COLUMN source_turns TYPE BOOLEAN USING/);
  });

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

  it('passes through low-confidence facts and boolean candidate source flags', async () => {
    const writes: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        writes.push({ text, values });
        if (text.startsWith('INSERT INTO knowledge_memory')) {
          return {
            rows: [
              {
                id: 1,
                tenant_id: 'acme',
                system_id: 'assistant',
                workspace_id: 'default',
                collaboration_id: '',
                scope_id: 'thread-1',
                fact: 'Low confidence note',
                fact_type: 'reference',
                knowledge_state: 'trusted',
                knowledge_class: 'project_fact',
                fact_subject: null,
                fact_attribute: null,
                fact_value: null,
                normalized_fact: null,
                slot_key: null,
                is_negated: false,
                source: 'manual',
                confidence: 'low',
                confidence_score: 0.2,
                grounding_strength: 'weak',
                evidence_count: 1,
                trust_score: 0.2,
                verification_status: 'unverified',
                verification_notes: null,
                last_verified_at: null,
                next_reverification_at: null,
                last_confirmed_at: null,
                confirmation_count: 0,
                source_system_id: 'assistant',
                source_scope_id: 'thread-1',
                source_collaboration_id: '',
                source_working_memory_id: null,
                source_turn_ids: [],
                successful_use_count: 0,
                failed_use_count: 0,
                disputed_at: null,
                dispute_reason: null,
                contradiction_score: 0,
                superseded_at: null,
                superseded_by_id: null,
                retired_at: null,
                access_count: 1,
                last_accessed_at: 1,
                created_at: 1,
                schema_version: 1,
              },
            ],
          };
        }
        if (text.startsWith('INSERT INTO knowledge_candidate')) {
          return {
            rows: [
              {
                id: 2,
                tenant_id: 'acme',
                system_id: 'assistant',
                workspace_id: 'default',
                collaboration_id: '',
                scope_id: 'thread-1',
                working_memory_id: 7,
                fact: 'Candidate note',
                fact_type: 'reference',
                knowledge_class: 'project_fact',
                normalized_fact: 'candidate note',
                slot_key: null,
                confidence: 'low',
                source_summary: true,
                source_turns: false,
                grounding_strength: 'weak',
                evidence_count: 0,
                trust_score: 0,
                state: 'candidate',
                promoted_knowledge_id: null,
                created_at: 1,
              },
            ],
          };
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

    const adapter = createPostgresAdapter(pool);
    const knowledge = await adapter.insertKnowledgeMemory({
      tenant_id: 'acme',
      system_id: 'assistant',
      scope_id: 'thread-1',
      fact: 'Low confidence note',
      fact_type: 'reference',
      source: 'manual',
      confidence: 'low',
    });
    const candidate = await adapter.insertKnowledgeCandidate({
      tenant_id: 'acme',
      system_id: 'assistant',
      scope_id: 'thread-1',
      working_memory_id: 7,
      fact: 'Candidate note',
      fact_type: 'reference',
      knowledge_class: 'project_fact',
      normalized_fact: 'candidate note',
      confidence: 'low',
      source_summary: true,
      source_turns: false,
    });

    const knowledgeInsert = writes.find((entry) => entry.text.startsWith('INSERT INTO knowledge_memory'));
    const candidateInsert = writes.find((entry) => entry.text.startsWith('INSERT INTO knowledge_candidate'));

    expect(knowledge.confidence).toBe('low');
    expect(candidate.source_summary).toBe(true);
    expect(candidate.source_turns).toBe(false);
    expect(knowledgeInsert?.values?.[16]).toBe('low');
    expect(candidateInsert?.values?.[12]).toBe(true);
    expect(candidateInsert?.values?.[13]).toBe(false);
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
