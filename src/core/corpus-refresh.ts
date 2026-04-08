import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { SourceDocument, KnowledgeMemory } from '../contracts/types.js';

/**
 * Descriptor for a document whose content may have changed.
 * Callers provide the current content hash so the refresh engine can
 * compare it against the stored hash from the last ingestion.
 */
export interface DocumentDescriptor {
  /** Title used to match the stored document. */
  title: string;
  /** SHA-256 hash of the document's current content. */
  contentHash: string;
  /** New content to re-ingest when the document has changed. */
  content?: string;
}

/**
 * Callback invoked for each changed document that needs re-ingestion.
 * Receives the document and its new content, returns newly extracted facts.
 */
export type ReIngestCallback = (
  document: SourceDocument,
  content: string,
) => KnowledgeMemory[];

/**
 * Result of a corpus refresh operation.
 */
export interface RefreshResult {
  /** Documents whose content hash has not changed — left untouched. */
  unchanged: SourceDocument[];
  /** Documents whose content hash changed — reset to pending, facts invalidated. */
  changed: SourceDocument[];
  /** Number of knowledge facts marked for re-extraction. */
  invalidatedFactCount: number;
  /** Number of facts created from re-ingestion of changed documents. */
  reIngestedFactCount: number;
}

interface InvalidatedFactSnapshot {
  id: number;
  knowledge_state: KnowledgeMemory['knowledge_state'];
}

/**
 * Incrementally refresh a document corpus.
 *
 * Compares current content hashes (from `documents`) against stored
 * hashes from previous ingestion. Documents whose hash has changed are
 * reset to `pending` so the caller can re-ingest them. Knowledge facts
 * linked to changed documents are marked for re-extraction by setting
 * their `knowledge_state` to `candidate`.
 *
 * When a `reIngest` callback is provided and the descriptor includes
 * `content`, changed documents are immediately re-ingested.
 *
 * Unchanged documents and their facts are left untouched.
 */
export function refreshDocuments(
  adapter: StorageAdapter,
  scope: MemoryScope,
  documents: DocumentDescriptor[],
  reIngest?: ReIngestCallback,
): RefreshResult {
  const unchanged: SourceDocument[] = [];
  const changed: SourceDocument[] = [];
  let invalidatedFactCount = 0;
  let reIngestedFactCount = 0;

  // Load all stored documents for this scope
  const stored = collectAllDocuments(adapter, scope);
  const storedByTitle = new Map<string, SourceDocument>();
  for (const doc of stored) {
    storedByTitle.set(doc.title, doc);
  }

  for (const descriptor of documents) {
    const existing = storedByTitle.get(descriptor.title);
    if (!existing) {
      // New document — not previously ingested, skip (caller should use ingestDocument)
      continue;
    }

    if (existing.content_hash === descriptor.contentHash) {
      unchanged.push(existing);
      continue;
    }

    // Content changed — reset document to pending for re-ingestion
    const updated = adapter.updateSourceDocument(existing.id, {
      status: 'pending',
      processed_at: null,
    });
    if (updated) {
      changed.push(updated);
    }

    // Invalidate facts linked to this document
    const invalidatedFacts = invalidateDocumentFacts(adapter, scope, existing);
    invalidatedFactCount += invalidatedFacts.length;

    // Re-ingest if callback and content provided
    if (reIngest && descriptor.content) {
      try {
        const newFacts = reIngest(updated ?? existing, descriptor.content);
        reIngestedFactCount += newFacts.length;

        // Update document metadata after successful re-ingestion
        adapter.updateSourceDocument(existing.id, {
          status: 'processed',
          fact_count: newFacts.length,
          processed_at: Math.floor(Date.now() / 1000),
        });
      } catch (error) {
        adapter.updateSourceDocument(existing.id, {
          status: existing.status,
          fact_count: existing.fact_count,
          processed_at: existing.processed_at,
        });
        restoreInvalidatedFacts(adapter, invalidatedFacts);
        throw error;
      }
    }
  }

  return { unchanged, changed, invalidatedFactCount, reIngestedFactCount };
}

/**
 * Collect all source documents for a scope across pagination.
 */
function collectAllDocuments(adapter: StorageAdapter, scope: MemoryScope): SourceDocument[] {
  const all: SourceDocument[] = [];
  let cursor: number | null | undefined;
  for (;;) {
    const page = adapter.listSourceDocuments(scope, {
      limit: 100,
      ...(cursor != null ? { cursor } : {}),
    });
    all.push(...page.items);
    if (!page.hasMore) break;
    cursor = page.nextCursor ?? undefined;
  }
  return all;
}

/**
 * Mark knowledge facts linked to a changed document for re-extraction.
 *
 * Uses two strategies to identify linked facts:
 * 1. Facts with `source = 'manual'` whose `created_at` falls between
 *    the document's `created_at` and `processed_at` (time-window heuristic).
 * 2. Facts whose `source_working_memory_id` references a working memory
 *    created during the document's processing window.
 *
 * Linked facts have their `knowledge_state` set to `'candidate'` so
 * downstream pipelines know to re-extract them.
 */
function invalidateDocumentFacts(
  adapter: StorageAdapter,
  scope: MemoryScope,
  document: SourceDocument,
): InvalidatedFactSnapshot[] {
  if (!document.processed_at) return [];

  const active = adapter.getActiveKnowledgeMemory(scope);
  const invalidatedFacts = new Map<number, InvalidatedFactSnapshot>();

  for (const fact of active) {
    // Strategy 1: time-window heuristic for manual-source facts
    if (
      fact.source === 'manual' &&
      fact.created_at >= document.created_at &&
      fact.created_at <= document.processed_at
    ) {
      invalidatedFacts.set(fact.id, { id: fact.id, knowledge_state: fact.knowledge_state });
    }

    // Strategy 2: facts promoted from working memory created during doc processing
    if (
      fact.source === 'promoted_from_working' &&
      fact.source_working_memory_id != null &&
      fact.created_at >= document.created_at &&
      fact.created_at <= document.processed_at
    ) {
      invalidatedFacts.set(fact.id, { id: fact.id, knowledge_state: fact.knowledge_state });
    }
  }

  for (const invalidated of invalidatedFacts.values()) {
    adapter.updateKnowledgeMemory(invalidated.id, {
      knowledge_state: 'candidate',
    });
  }

  return [...invalidatedFacts.values()];
}

function restoreInvalidatedFacts(
  adapter: StorageAdapter,
  invalidatedFacts: InvalidatedFactSnapshot[],
): void {
  for (const invalidated of invalidatedFacts) {
    adapter.updateKnowledgeMemory(invalidated.id, {
      knowledge_state: invalidated.knowledge_state,
    });
  }
}
