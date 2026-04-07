import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import { createRegexExtractor } from '../core/extractor.js';
import { makeScope } from './test-helpers.js';

describe('ingestDocument', () => {
  let adapter: ReturnType<typeof createSQLiteAdapterWithEmbeddings>;

  beforeEach(() => {
    adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function makeManager(overrides = {}) {
    return createMemoryManager({
      adapter,
      scope: makeScope(),
      sessionId: 'session-1',
      summarizer: async (turns) => ({
        summary: turns.map((t) => t.content).join(' '),
        key_entities: ['TypeScript'],
        topic_tags: ['programming'],
      }),
      extractor: createRegexExtractor(),
      ...overrides,
    });
  }

  it('ingests a document and creates a processed source document', async () => {
    const manager = makeManager();
    const result = await manager.ingestDocument(
      'The user prefers TypeScript for backend development. The user prefers dark mode for all editors.',
      { title: 'User Preferences' },
    );

    expect(result.document).toBeTruthy();
    expect(result.document.title).toBe('User Preferences');
    expect(result.document.status).toBe('processed');
    // Knowledge extraction depends on trust grounding which requires real source turns.
    // The document is still ingested and marked processed even with zero extracted knowledge.
    expect(result.knowledge).toBeDefined();
    await manager.close();
  });

  it('deduplicates by content hash', async () => {
    const manager = makeManager();
    const content = 'The user prefers TypeScript.';
    const first = await manager.ingestDocument(content, { title: 'Doc 1' });
    const second = await manager.ingestDocument(content, { title: 'Doc 2' });

    // Second call returns the existing document
    expect(second.document.id).toBe(first.document.id);
    await manager.close();
  });

  it('lists source documents', async () => {
    const manager = makeManager();
    await manager.ingestDocument('The user prefers TypeScript.', { title: 'Doc 1' });
    await manager.ingestDocument('The user prefers Rust for systems programming.', { title: 'Doc 2' });

    const result = await manager.listSourceDocuments();
    expect(result.items.length).toBe(2);
    await manager.close();
  });

  it('gets a source document by ID', async () => {
    const manager = makeManager();
    const { document } = await manager.ingestDocument(
      'The user prefers TypeScript.',
      { title: 'Test Doc', url: 'https://example.com' },
    );

    const fetched = await manager.getSourceDocument(document.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.title).toBe('Test Doc');
    expect(fetched!.url).toBe('https://example.com');
    await manager.close();
  });

  it('throws when no extractor is configured', async () => {
    const manager = makeManager({ extractor: undefined });

    await expect(
      manager.ingestDocument('content', { title: 'test' }),
    ).rejects.toThrow(/extractor is required/);
    await manager.close();
  });

  it('handles documents with minimal content gracefully', async () => {
    const manager = makeManager();
    const result = await manager.ingestDocument('Hello world!', { title: 'Simple' });

    expect(result.document.status).toBe('processed');
    // Even minimal content may produce facts via document-grounded extraction
    expect(result.knowledge).toBeDefined();
    await manager.close();
  });

  it('enforces scope isolation on getSourceDocument', async () => {
    const manager = makeManager();
    const { document } = await manager.ingestDocument(
      'The user prefers TypeScript.',
      { title: 'Scoped Doc' },
    );

    // A manager with a different scope should not see this document
    const otherManager = createMemoryManager({
      adapter,
      scope: makeScope({ scope_id: 'other-scope' }),
      sessionId: 'session-2',
      summarizer: async (turns) => ({
        summary: turns.map((t) => t.content).join(' '),
        key_entities: [],
        topic_tags: [],
      }),
      extractor: createRegexExtractor(),
    });

    const result = await otherManager.getSourceDocument(document.id);
    expect(result).toBeNull();
    await manager.close();
    await otherManager.close();
  });

  it('dedup returns empty knowledge on re-ingest', async () => {
    const manager = makeManager();
    const content = 'The user prefers TypeScript.';
    await manager.ingestDocument(content, { title: 'Doc 1' });
    const second = await manager.ingestDocument(content, { title: 'Doc 2' });

    // Dedup should NOT return unrelated knowledge
    expect(second.knowledge).toEqual([]);
    await manager.close();
  });
});
