import type Database from 'better-sqlite3';

import { scopeValues, type MemoryScope } from '../../contracts/identity.js';
import type { EmbeddingAdapter, EmbeddingVector, SimilarEmbeddingResult } from '../../contracts/embedding.js';
import type { Logger } from '../../contracts/observability.js';
import { nowSeconds } from '../../core/validation.js';

const SCOPE_WHERE = 'km.tenant_id = ? AND km.system_id = ? AND km.workspace_id = ? AND km.scope_id = ?';

function ensureEmbeddingSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_embeddings (
      knowledge_memory_id INTEGER PRIMARY KEY REFERENCES knowledge_memory(id) ON DELETE CASCADE,
      vector BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

function vectorToBuffer(vector: EmbeddingVector): Buffer {
  return Buffer.from(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

function bufferToVector(buffer: Buffer): EmbeddingVector {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  return new Float32Array(arrayBuffer);
}

function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function createSQLiteEmbeddingAdapter(
  db: Database.Database,
  logger?: Logger,
): EmbeddingAdapter {
  ensureEmbeddingSchema(db);

  return {
    storeEmbedding(knowledgeMemoryId, vector): void {
      db.prepare(
        `INSERT INTO knowledge_embeddings (knowledge_memory_id, vector, dimensions, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(knowledge_memory_id) DO UPDATE SET
           vector = excluded.vector,
           dimensions = excluded.dimensions,
           created_at = excluded.created_at`,
      ).run(knowledgeMemoryId, vectorToBuffer(vector), vector.length, nowSeconds());
    },

    getEmbedding(knowledgeMemoryId): EmbeddingVector | null {
      const row = db
        .prepare('SELECT vector FROM knowledge_embeddings WHERE knowledge_memory_id = ?')
        .get(knowledgeMemoryId) as { vector: Buffer } | undefined;
      return row ? bufferToVector(row.vector) : null;
    },

    findSimilar(scope: MemoryScope, queryVector: EmbeddingVector, options): SimilarEmbeddingResult[] {
      const rows = db
        .prepare(
          `SELECT ke.knowledge_memory_id, ke.vector
           FROM knowledge_embeddings ke
           JOIN knowledge_memory km ON km.id = ke.knowledge_memory_id
           WHERE ${SCOPE_WHERE} AND km.superseded_by_id IS NULL`,
        )
        .all(...scopeValues(scope)) as Array<{ knowledge_memory_id: number; vector: Buffer }>;

      if (rows.length > 10_000) {
        logger?.warn('semantic search scanning large embedding set', {
          candidateCount: rows.length,
        });
      }

      const minSimilarity = options?.minSimilarity ?? 0;
      const limit = options?.limit ?? 10;

      return rows
        .map((row) => ({
          knowledgeMemoryId: row.knowledge_memory_id,
          similarity: cosineSimilarity(queryVector, bufferToVector(row.vector)),
        }))
        .filter((row) => row.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    },

    deleteEmbedding(knowledgeMemoryId): void {
      db.prepare('DELETE FROM knowledge_embeddings WHERE knowledge_memory_id = ?').run(
        knowledgeMemoryId,
      );
    },
  };
}
