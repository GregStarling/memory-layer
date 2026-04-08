import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { refreshDocuments } from '../core/corpus-refresh.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';

const scope: MemoryScope = {
  tenant_id: 'test',
  system_id: 'test',
  scope_id: 'refresh-test',
};

describe('corpus-refresh', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createInMemoryAdapter();
  });

  function ingestFakeDocument(title: string, hash: string, factTexts: string[]) {
    const now = Math.floor(Date.now() / 1000);
    const doc = adapter.insertSourceDocument({
      ...scope,
      title,
      content_hash: hash,
      token_estimate: 100,
    });
    const facts = factTexts.map((fact) =>
      adapter.insertKnowledgeMemory({
        ...scope,
        fact,
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        source: 'manual',
        confidence: 'high',
        created_at: now,
        last_accessed_at: now,
      }),
    );
    adapter.updateSourceDocument(doc.id, {
      status: 'processed',
      fact_count: facts.length,
      processed_at: now + 1,
    });
    return { doc, facts };
  }

  it('detects unchanged documents and leaves them untouched', () => {
    const { doc } = ingestFakeDocument('doc1.md', 'hash-aaa', ['Fact from doc1']);

    const result = refreshDocuments(adapter, scope, [
      { title: 'doc1.md', contentHash: 'hash-aaa' },
    ]);

    expect(result.unchanged.length).toBe(1);
    expect(result.unchanged[0].id).toBe(doc.id);
    expect(result.changed.length).toBe(0);
    expect(result.invalidatedFactCount).toBe(0);

    // Fact should still be trusted
    const facts = adapter.getActiveKnowledgeMemory(scope);
    expect(facts.length).toBe(1);
    expect(facts[0].knowledge_state).toBe('trusted');
  });

  it('detects changed documents and resets them to pending', () => {
    ingestFakeDocument('doc1.md', 'hash-aaa', ['Fact from doc1']);

    const result = refreshDocuments(adapter, scope, [
      { title: 'doc1.md', contentHash: 'hash-bbb' },
    ]);

    expect(result.unchanged.length).toBe(0);
    expect(result.changed.length).toBe(1);
    expect(result.changed[0].status).toBe('pending');
    expect(result.changed[0].processed_at).toBeNull();
  });

  it('marks facts from changed documents for re-extraction', () => {
    ingestFakeDocument('doc1.md', 'hash-aaa', ['Fact A', 'Fact B']);

    const result = refreshDocuments(adapter, scope, [
      { title: 'doc1.md', contentHash: 'hash-changed' },
    ]);

    expect(result.invalidatedFactCount).toBe(2);

    // Facts should now be candidates, not active (getActiveKnowledgeMemory
    // returns only non-superseded, non-retired facts regardless of state,
    // so check the state directly)
    const km1 = adapter.getKnowledgeMemoryById(1);
    const km2 = adapter.getKnowledgeMemoryById(2);
    expect(km1!.knowledge_state).toBe('candidate');
    expect(km2!.knowledge_state).toBe('candidate');
  });

  it('leaves facts from unchanged documents untouched', () => {
    // unchanged doc ingested much earlier (simulated via user_stated source for its fact
    // so the fact isn't in the manual-source pool that refresh invalidates)
    const { doc: unchangedDoc } = ingestFakeDocument('unchanged.md', 'hash-same', []);
    // Insert a user-stated fact that should never be invalidated
    const now = Math.floor(Date.now() / 1000);
    adapter.insertKnowledgeMemory({ ...scope, fact: 'Stable fact', fact_type: 'preference', knowledge_class: 'preference', source: 'user_stated', confidence: 'high', created_at: now, last_accessed_at: now });

    // Changed doc with a manual fact
    const { doc: changedDoc } = ingestFakeDocument('changed.md', 'hash-old', ['Volatile fact']);

    const result = refreshDocuments(adapter, scope, [
      { title: 'unchanged.md', contentHash: 'hash-same' },
      { title: 'changed.md', contentHash: 'hash-new' },
    ]);

    expect(result.unchanged.length).toBe(1);
    expect(result.changed.length).toBe(1);
    expect(result.invalidatedFactCount).toBe(1);

    // The stable fact should still be trusted
    const allFacts = adapter.getActiveKnowledgeMemory(scope);
    const stableFact = allFacts.find((f) => f.fact === 'Stable fact');
    expect(stableFact).toBeDefined();
    expect(stableFact!.knowledge_state).toBe('trusted');
  });

  it('skips documents not previously ingested', () => {
    const result = refreshDocuments(adapter, scope, [
      { title: 'brand-new.md', contentHash: 'hash-new' },
    ]);

    expect(result.unchanged.length).toBe(0);
    expect(result.changed.length).toBe(0);
    expect(result.invalidatedFactCount).toBe(0);
  });

  it('handles empty document list', () => {
    ingestFakeDocument('existing.md', 'hash-aaa', ['Some fact']);

    const result = refreshDocuments(adapter, scope, []);

    expect(result.unchanged.length).toBe(0);
    expect(result.changed.length).toBe(0);
    expect(result.invalidatedFactCount).toBe(0);

    // Existing fact untouched
    const facts = adapter.getActiveKnowledgeMemory(scope);
    expect(facts[0].knowledge_state).toBe('trusted');
  });

  it('does not invalidate non-manual facts in the time window', () => {
    const now = Math.floor(Date.now() / 1000);

    // Create a document
    const doc = adapter.insertSourceDocument({
      ...scope,
      title: 'doc.md',
      content_hash: 'hash-old',
      token_estimate: 50,
    });

    // Create a manual fact (from document) and a user_stated fact (not from document)
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'Manual fact from doc',
      fact_type: 'entity',
      knowledge_class: 'project_fact',
      source: 'manual',
      confidence: 'high',
      created_at: now,
      last_accessed_at: now,
    });
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: 'User stated fact',
      fact_type: 'preference',
      knowledge_class: 'preference',
      source: 'user_stated',
      confidence: 'high',
      created_at: now,
      last_accessed_at: now,
    });

    adapter.updateSourceDocument(doc.id, {
      status: 'processed',
      fact_count: 1,
      processed_at: now + 1,
    });

    const result = refreshDocuments(adapter, scope, [
      { title: 'doc.md', contentHash: 'hash-new' },
    ]);

    // Only the manual fact should be invalidated
    expect(result.invalidatedFactCount).toBe(1);

    const userFact = adapter.getActiveKnowledgeMemory(scope).find(
      (f) => f.fact === 'User stated fact',
    );
    expect(userFact).toBeDefined();
    expect(userFact!.knowledge_state).toBe('trusted');
  });

  it('handles documents that were never processed (no processed_at)', () => {
    // Insert a pending document that was never processed
    adapter.insertSourceDocument({
      ...scope,
      title: 'pending.md',
      content_hash: 'hash-pending',
      token_estimate: 50,
    });

    const result = refreshDocuments(adapter, scope, [
      { title: 'pending.md', contentHash: 'hash-different' },
    ]);

    // Document changed but no facts to invalidate (never processed)
    expect(result.changed.length).toBe(1);
    expect(result.invalidatedFactCount).toBe(0);
  });

  it('rolls back document state and invalidated facts when re-ingest fails', () => {
    const { doc, facts } = ingestFakeDocument('doc1.md', 'hash-aaa', ['Fact A', 'Fact B']);

    expect(() =>
      refreshDocuments(
        adapter,
        scope,
        [{ title: 'doc1.md', contentHash: 'hash-new', content: 'updated content' }],
        () => {
          throw new Error('re-ingest failed');
        },
      ),
    ).toThrow(/re-ingest failed/);

    const restored = adapter.getSourceDocumentById(doc.id);
    expect(restored?.status).toBe('processed');
    expect(restored?.fact_count).toBe(facts.length);
    expect(restored?.processed_at).not.toBeNull();

    for (const fact of facts) {
      expect(adapter.getKnowledgeMemoryById(fact.id)?.knowledge_state).toBe('trusted');
    }
  });
});
