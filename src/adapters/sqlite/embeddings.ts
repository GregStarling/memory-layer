import type Database from 'better-sqlite3';

import { normalizeScope, scopeValues, type MemoryScope, type ScopeLevel } from '../../contracts/identity.js';
import type {
  EmbeddingAdapter,
  EmbeddingCoverage,
  EmbeddingMetadata,
  EmbeddingQueryFilter,
  EmbeddingVector,
  SimilarEmbeddingResult,
} from '../../contracts/embedding.js';
import type { Logger } from '../../contracts/observability.js';
import { nowSeconds } from '../../core/validation.js';

const SCOPE_WHERE =
  'km.tenant_id = ? AND km.system_id = ? AND km.workspace_id = ? AND km.collaboration_id = ? AND km.scope_id = ?';
const KNOWLEDGE_SCOPE_WHERE =
  'tenant_id = ? AND system_id = ? AND workspace_id = ? AND collaboration_id = ? AND scope_id = ?';

function scopeWhereForLevel(scope: MemoryScope, level: ScopeLevel): string {
  if (level === 'tenant') return 'km.tenant_id = ?';
  if (level === 'system') return 'km.tenant_id = ? AND km.system_id = ?';
  if (level === 'workspace') return 'km.tenant_id = ? AND km.workspace_id = ?';
  return SCOPE_WHERE;
}

function scopeParamsForLevel(scope: MemoryScope, level: ScopeLevel): string[] {
  const normalized = normalizeScope(scope);
  if (level === 'tenant') return [normalized.tenant_id];
  if (level === 'system') return [normalized.tenant_id, normalized.system_id];
  if (level === 'workspace') return [normalized.tenant_id, normalized.workspace_id];
  return [...scopeValues(normalized)];
}

/**
 * F4 base-visibility predicate for the SEMANTIC cross-scope read, mirroring
 * `shared/visibility.isBaseVisible` and the SQL form in the SQLite adapter's
 * `visibilityWhereForScope`. Without it, `findSimilarCrossScope` widens by
 * scope-level only and leaks a `private`/`shared_collaboration` fact's id (and,
 * once the manager hydrates it, its fact text) to another scope via semantic
 * search. ANDed with the scope-level clause, it admits a row only if the reader
 * is permitted to see it given `km.visibility_class`. Same-tenant is already
 * guaranteed by the scope-level clause (every widening level binds
 * `km.tenant_id = ?`). NULL / unrecognized visibility_class → treated as
 * `private` (the shared helper's default branch). Params are all strings, in
 * the same order the clause references them.
 */
function visibilityWhereForScope(scope: MemoryScope): { clause: string; params: string[] } {
  const n = normalizeScope(scope);
  const clause =
    `(km.visibility_class = 'tenant'` +
    ` OR (km.visibility_class = 'workspace' AND km.workspace_id = ?)` +
    ` OR (km.visibility_class = 'shared_collaboration' AND km.workspace_id = ?` +
    ` AND km.collaboration_id <> '' AND km.collaboration_id = ?)` +
    ` OR ((km.visibility_class IS NULL OR km.visibility_class NOT IN ('tenant', 'workspace', 'shared_collaboration'))` +
    ` AND km.system_id = ? AND km.workspace_id = ? AND km.collaboration_id = ? AND km.scope_id = ?))`;
  return {
    clause,
    params: [
      n.workspace_id,
      n.workspace_id,
      n.collaboration_id,
      n.system_id,
      n.workspace_id,
      n.collaboration_id,
      n.scope_id,
    ],
  };
}

/**
 * Build the SQL fragment + params that exclude vectors whose stored metadata
 * does NOT match the active-provider filter (Phase 2.4). Mismatched vectors are
 * removed IN SQL — before any cosine comparison — so a vector from a different
 * model/dimensionality is never distance-compared against the query.
 *
 * - `dimensions`: exact match required. Legacy rows with a NULL `dimensions`
 *   (pre-versioning, dimension not derivable) count as a mismatch and are
 *   excluded, matching the manager decision ("dimensions NULL = legacy: treat
 *   as mismatch").
 * - `model`: excluded only when the filter supplies a model AND the stored
 *   model is a known value other than the filter's. Stored `'unknown'` (legacy /
 *   pre-versioning) is NOT excluded on model grounds, so pre-versioning data
 *   still surfaces when its dimensions agree. Mirrors the in-memory reference.
 */
function buildFilterClause(filter?: EmbeddingQueryFilter): { clause: string; params: unknown[] } {
  if (!filter) return { clause: '', params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.dimensions != null) {
    clauses.push('ke.dimensions IS NOT NULL AND ke.dimensions = ?');
    params.push(filter.dimensions);
  }
  if (filter.model != null && filter.model !== 'unknown') {
    clauses.push("(ke.model = 'unknown' OR ke.model = ?)");
    params.push(filter.model);
  }
  return {
    clause: clauses.length > 0 ? ` AND ${clauses.map((c) => `(${c})`).join(' AND ')}` : '',
    params,
  };
}

/**
 * Ensure the embedding table exists and carries the Phase 2.4 provenance
 * columns. As of v21 the canonical table + `model`/`dimensions` columns are a
 * real gated migration in schema.ts (createSQLiteSchema), so a v21 stamp
 * genuinely implies the columns exist. This function is now DEFENSIVE/idempotent:
 * it re-creates the table IF NOT EXISTS, adds `model` if a pre-v21 build left it
 * off, and backfills NULL `dimensions` from the stored blob length (Float32 =
 * 4 bytes per component). All operations are no-ops on a v21 database.
 */
function ensureEmbeddingSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_embeddings (
      knowledge_memory_id INTEGER PRIMARY KEY REFERENCES knowledge_memory(id) ON DELETE CASCADE,
      vector BLOB NOT NULL,
      dimensions INTEGER,
      model TEXT NOT NULL DEFAULT 'unknown',
      created_at INTEGER NOT NULL
    );
  `);
  // v21: add the model column on databases whose knowledge_embeddings table
  // predates it. Tolerate only "duplicate column" (already migrated); rethrow
  // real errors (disk full, locked, corruption).
  try {
    db.exec("ALTER TABLE knowledge_embeddings ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown'");
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? '').toLowerCase();
    if (!message.includes('duplicate column')) throw error;
  }
  // Backfill dimensions from blob length for any legacy row missing it. The
  // vector is a packed Float32Array, so dimensions = byte length / 4.
  db.exec(
    'UPDATE knowledge_embeddings SET dimensions = length(vector) / 4 WHERE dimensions IS NULL',
  );
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

function cosineSimilarity(
  a: EmbeddingVector,
  b: EmbeddingVector,
  onMismatch?: (details: { queryDimensions: number; storedDimensions: number }) => void,
): number {
  if (a.length !== b.length) {
    onMismatch?.({
      queryDimensions: a.length,
      storedDimensions: b.length,
    });
    return 0;
  }
  if (a.length === 0) return 0;

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
    storeEmbedding(knowledgeMemoryId, vector, metadata?: EmbeddingMetadata): void {
      db.prepare(
        `INSERT INTO knowledge_embeddings (knowledge_memory_id, vector, dimensions, model, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(knowledge_memory_id) DO UPDATE SET
           vector = excluded.vector,
           dimensions = excluded.dimensions,
           model = excluded.model,
           created_at = excluded.created_at`,
      ).run(
        knowledgeMemoryId,
        vectorToBuffer(vector),
        metadata?.dimensions ?? vector.length,
        metadata?.model ?? 'unknown',
        nowSeconds(),
      );
    },

    getEmbedding(knowledgeMemoryId): EmbeddingVector | null {
      const row = db
        .prepare('SELECT vector FROM knowledge_embeddings WHERE knowledge_memory_id = ?')
        .get(knowledgeMemoryId) as { vector: Buffer } | undefined;
      return row ? bufferToVector(row.vector) : null;
    },

    findSimilar(scope: MemoryScope, queryVector: EmbeddingVector, options): SimilarEmbeddingResult[] {
      // Phase 2.4: mismatched vectors are excluded IN SQL (buildFilterClause)
      // before any cosine comparison runs.
      const filter = buildFilterClause(options?.filter);
      const rows = db
        .prepare(
          `SELECT ke.knowledge_memory_id, ke.vector
           FROM knowledge_embeddings ke
           JOIN knowledge_memory km ON km.id = ke.knowledge_memory_id
           WHERE ${SCOPE_WHERE} AND km.superseded_by_id IS NULL AND km.retired_at IS NULL${filter.clause}`,
        )
        .all(...scopeValues(scope), ...filter.params) as Array<{ knowledge_memory_id: number; vector: Buffer }>;

      if (rows.length > 10_000) {
        logger?.warn('semantic search scanning large embedding set', {
          candidateCount: rows.length,
        });
      }

      const minSimilarity = options?.minSimilarity ?? 0;
      const limit = options?.limit ?? 10;
      const warnedDimensions = new Set<string>();

      return rows
        .map((row) => ({
          knowledgeMemoryId: row.knowledge_memory_id,
          similarity: cosineSimilarity(queryVector, bufferToVector(row.vector), (details) => {
            const key = `${details.queryDimensions}:${details.storedDimensions}`;
            if (warnedDimensions.has(key)) return;
            warnedDimensions.add(key);
            logger?.warn('memory.embeddings.dimension_mismatch', {
              knowledgeMemoryId: row.knowledge_memory_id,
              queryDimensions: details.queryDimensions,
              storedDimensions: details.storedDimensions,
            });
          }),
        }))
        .filter((row) => row.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    },

    findSimilarCrossScope(
      scope: MemoryScope,
      level: ScopeLevel,
      queryVector: EmbeddingVector,
      options,
    ): SimilarEmbeddingResult[] {
      const filter = buildFilterClause(options?.filter);
      // F4: base-visibility gate so private/shared_collaboration facts do not
      // leak across scope via semantic search (mirrors the lexical cross-scope fix).
      const visibility = visibilityWhereForScope(scope);
      const rows = db
        .prepare(
          `SELECT ke.knowledge_memory_id, ke.vector
           FROM knowledge_embeddings ke
           JOIN knowledge_memory km ON km.id = ke.knowledge_memory_id
           WHERE ${scopeWhereForLevel(scope, level)} AND km.superseded_by_id IS NULL AND km.retired_at IS NULL
             AND ${visibility.clause}${filter.clause}`,
        )
        .all(...scopeParamsForLevel(scope, level), ...visibility.params, ...filter.params) as Array<{
        knowledge_memory_id: number;
        vector: Buffer;
      }>;

      const minSimilarity = options?.minSimilarity ?? 0;
      const limit = options?.limit ?? 10;
      const warnedDimensions = new Set<string>();

      return rows
        .map((row) => ({
          knowledgeMemoryId: row.knowledge_memory_id,
          similarity: cosineSimilarity(queryVector, bufferToVector(row.vector), (details) => {
            const key = `${details.queryDimensions}:${details.storedDimensions}`;
            if (warnedDimensions.has(key)) return;
            warnedDimensions.add(key);
            logger?.warn('memory.embeddings.dimension_mismatch', {
              knowledgeMemoryId: row.knowledge_memory_id,
              queryDimensions: details.queryDimensions,
              storedDimensions: details.storedDimensions,
              scopeLevel: level,
            });
          }),
        }))
        .filter((row) => row.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    },

    deleteEmbedding(knowledgeMemoryId, scope): void {
      if (scope) {
        db.prepare(
          `DELETE FROM knowledge_embeddings
           WHERE knowledge_memory_id = ?
             AND knowledge_memory_id IN (
               SELECT id
               FROM knowledge_memory
               WHERE id = ? AND ${KNOWLEDGE_SCOPE_WHERE}
             )`,
        ).run(knowledgeMemoryId, knowledgeMemoryId, ...scopeValues(scope));
        return;
      }
      db.prepare('DELETE FROM knowledge_embeddings WHERE knowledge_memory_id = ?').run(knowledgeMemoryId);
    },

    getEmbeddingCoverage(scope: MemoryScope, filter: EmbeddingQueryFilter): EmbeddingCoverage {
      // Phase 2.4: report how many stored embeddings (for ACTIVE knowledge in
      // scope) match the active provider vs. mismatch. Drives the manager's
      // degraded-mode diagnostics and reembed. Computed entirely in SQL — the
      // filter clause is the same one the similarity queries use.
      const filterSql = buildFilterClause(filter);
      const totalRow = db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM knowledge_embeddings ke
           JOIN knowledge_memory km ON km.id = ke.knowledge_memory_id
           WHERE ${SCOPE_WHERE} AND km.superseded_by_id IS NULL AND km.retired_at IS NULL`,
        )
        .get(...scopeValues(scope)) as { n: number };
      const matchingRow = db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM knowledge_embeddings ke
           JOIN knowledge_memory km ON km.id = ke.knowledge_memory_id
           WHERE ${SCOPE_WHERE} AND km.superseded_by_id IS NULL AND km.retired_at IS NULL${filterSql.clause}`,
        )
        .get(...scopeValues(scope), ...filterSql.params) as { n: number };
      const total = Number(totalRow.n);
      const matching = Number(matchingRow.n);
      return { total, matching, mismatched: total - matching };
    },
  };
}
