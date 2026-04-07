import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { createMemoryManager } from '../core/manager.js';
import { createRegexExtractor } from '../core/extractor.js';
import { makeScope } from './test-helpers.js';

describe('exportAsMarkdown', () => {
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
        key_entities: [],
        topic_tags: [],
      }),
      extractor: createRegexExtractor(),
      ...overrides,
    });
  }

  it('empty knowledge store produces minimal index.md', async () => {
    const manager = makeManager();
    const result = await manager.exportAsMarkdown();

    expect(result.files.has('index.md')).toBe(true);
    expect(result.stats.totalFacts).toBe(0);
    expect(result.stats.totalFiles).toBe(1);
    expect(result.files.get('index.md')).toContain('# Knowledge Base');
    expect(result.files.get('index.md')).toContain('**Total facts**: 0');
    await manager.close();
  });

  it('multiple knowledge classes produce correct files', async () => {
    const manager = makeManager();

    await manager.learnFact('The user prefers TypeScript', 'preference', 'high');
    await manager.learnFact('Always use ESLint', 'constraint', 'high');
    await manager.learnFact('The user is named Alice', 'entity', 'high');

    const result = await manager.exportAsMarkdown();

    expect(result.stats.totalFacts).toBe(3);
    // Should have index.md plus one file per knowledge class
    expect(result.files.has('index.md')).toBe(true);
    expect(result.stats.totalFiles).toBeGreaterThanOrEqual(2);

    // Index should have summary and contents
    const index = result.files.get('index.md')!;
    expect(index).toContain('# Knowledge Base');
    expect(index).toContain('**Total facts**: 3');
    expect(index).toContain('## Contents');

    // At least one group file should contain fact text
    const allContent = [...result.files.values()].join('\n');
    expect(allContent).toContain('TypeScript');
    expect(allContent).toContain('ESLint');
    expect(allContent).toContain('Alice');

    await manager.close();
  });

  it('trust metadata inclusion', async () => {
    const manager = makeManager();

    await manager.learnFact('The user prefers dark mode', 'preference', 'high');

    const withMeta = await manager.exportAsMarkdown({ includeTrustMetadata: true });
    const allContent = [...withMeta.files.values()].join('\n');
    expect(allContent).toContain('trust:');
    expect(allContent).toContain('state:');
    expect(allContent).toContain('evidence:');

    const withoutMeta = await manager.exportAsMarkdown({ includeTrustMetadata: false });
    const allContentNoMeta = [...withoutMeta.files.values()].join('\n');
    expect(allContentNoMeta).not.toContain('trust:');

    await manager.close();
  });

  it('changelog generation', async () => {
    const manager = makeManager();

    await manager.processTurn('user', 'I prefer dark mode.');
    await manager.processTurn('assistant', 'Noted, you prefer dark mode.');

    const result = await manager.exportAsMarkdown({ includeChangelog: true });
    expect(result.files.has('changelog.md')).toBe(true);

    const changelog = result.files.get('changelog.md')!;
    expect(changelog).toContain('# Changelog');

    await manager.close();
  });

  it('source documents page', async () => {
    const manager = makeManager();

    await manager.ingestDocument('The user likes TypeScript.', {
      title: 'User Preferences',
      url: 'https://example.com/prefs',
    });

    const result = await manager.exportAsMarkdown({ includeSourceDocuments: true });
    expect(result.files.has('sources.md')).toBe(true);

    const sources = result.files.get('sources.md')!;
    expect(sources).toContain('# Source Documents');
    expect(sources).toContain('User Preferences');

    await manager.close();
  });

  it('flat groupBy puts all facts in one file', async () => {
    const manager = makeManager();

    await manager.learnFact('Fact one', 'preference', 'high');
    await manager.learnFact('Fact two', 'constraint', 'high');

    const result = await manager.exportAsMarkdown({ groupBy: 'flat' });
    // Should have index.md + all.md
    expect(result.files.has('all.md')).toBe(true);
    const allFile = result.files.get('all.md')!;
    expect(allFile).toContain('Fact one');
    expect(allFile).toContain('Fact two');

    await manager.close();
  });
});
