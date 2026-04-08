import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { exportAsMarkdown } from '../core/markdown-export.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';

const scope: MemoryScope = {
  tenant_id: 'test',
  system_id: 'test',
  scope_id: 'export-validity',
};

describe('markdown export — validity windows', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createInMemoryAdapter();
  });

  it('renders validity window for facts with valid_from and valid_until', async () => {
    const from = Math.floor(new Date('2026-01-01').getTime() / 1000);
    const until = Math.floor(new Date('2026-06-30').getTime() / 1000);
    adapter.insertKnowledgeMemory({
      ...scope, fact: 'Promo pricing active', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      valid_from: from, valid_until: until,
    });

    const asyncAdapter = wrapSyncAdapter(adapter);
    const result = await exportAsMarkdown(asyncAdapter, scope, { includeTrustMetadata: true });
    const content = [...result.files.values()].join('\n');
    expect(content).toContain('Promo pricing active');
    expect(content).toContain('valid:');
    expect(content).toContain('2026-01-01');
    expect(content).toContain('2026-06-30');
  });

  it('renders valid_until only when valid_from is absent', async () => {
    const until = Math.floor(new Date('2026-09-30').getTime() / 1000);
    adapter.insertKnowledgeMemory({
      ...scope, fact: 'Deadline approaching', fact_type: 'constraint',
      knowledge_class: 'constraint', source: 'user_stated', confidence: 'high',
      valid_until: until,
    });

    const asyncAdapter = wrapSyncAdapter(adapter);
    const result = await exportAsMarkdown(asyncAdapter, scope);
    const content = [...result.files.values()].join('\n');
    expect(content).toContain('Deadline approaching');
    expect(content).toContain('valid until:');
    expect(content).toContain('2026-09-30');
  });

  it('renders valid_from only when valid_until is absent', async () => {
    const from = Math.floor(new Date('2026-04-01').getTime() / 1000);
    adapter.insertKnowledgeMemory({
      ...scope, fact: 'New policy starts', fact_type: 'constraint',
      knowledge_class: 'constraint', source: 'user_stated', confidence: 'high',
      valid_from: from,
    });

    const asyncAdapter = wrapSyncAdapter(adapter);
    const result = await exportAsMarkdown(asyncAdapter, scope);
    const content = [...result.files.values()].join('\n');
    expect(content).toContain('New policy starts');
    expect(content).toContain('valid from:');
    expect(content).toContain('2026-04-01');
  });

  it('does not add validity metadata for facts without windows', async () => {
    adapter.insertKnowledgeMemory({
      ...scope, fact: 'Timeless fact', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
    });

    const asyncAdapter = wrapSyncAdapter(adapter);
    const result = await exportAsMarkdown(asyncAdapter, scope);
    const content = [...result.files.values()].join('\n');
    expect(content).toContain('Timeless fact');
    expect(content).not.toContain('valid:');
    expect(content).not.toContain('valid from:');
    expect(content).not.toContain('valid until:');
  });

  it('sanitizes source document URLs before rendering markdown links', async () => {
    adapter.insertSourceDocument({
      ...scope,
      title: 'Injected link',
      content_hash: 'hash-1',
      url: 'https://example.com/docs](evil.com)',
      metadata: {},
    });

    const asyncAdapter = wrapSyncAdapter(adapter);
    const result = await exportAsMarkdown(asyncAdapter, scope, { includeSourceDocuments: true });
    const sources = result.files.get('sources.md') ?? '';
    expect(sources).toContain('[link](https://example.com/docs%5D%28evil.com%29)');
    expect(sources).not.toContain('[link](https://example.com/docs](evil.com))');
  });
});
