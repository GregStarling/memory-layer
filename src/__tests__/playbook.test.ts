import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StructuredGenerationClient } from '../summarizers/client.js';
import {
  createPlaybookFromTask,
  revisePlaybook,
  findRelevantPlaybooks,
} from '../core/playbook.js';

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

function createMockClient(): StructuredGenerationClient {
  return {
    async generate() {
      return JSON.stringify({
        instructions: '1. Run npm test\n2. Check coverage\n3. Fix failing tests',
        references: ['package.json', 'vitest.config.ts'],
        templates: ['test-template.ts'],
        scripts: ['npm run test:coverage'],
      });
    },
  };
}

describe('playbook core', () => {
  let adapter: StorageAdapter;
  let asyncAdapter: AsyncStorageAdapter;
  const s = scope();

  beforeEach(() => {
    adapter = createSQLiteAdapter(':memory:');
    asyncAdapter = wrapSyncAdapter(adapter);
    // Seed some turns for the session
    adapter.insertTurn({
      ...s,
      session_id: 'sess-1',
      actor: 'user',
      role: 'user',
      content: 'Run the test suite and fix failures',
      token_estimate: 10,
      created_at: Math.floor(Date.now() / 1000) - 300,
    });
    adapter.insertTurn({
      ...s,
      session_id: 'sess-1',
      actor: 'assistant',
      role: 'assistant',
      content: 'I ran npm test, found 3 failures, and fixed them all.',
      token_estimate: 15,
      created_at: Math.floor(Date.now() / 1000) - 200,
    });
  });

  afterEach(() => {
    adapter.close();
  });

  describe('createPlaybookFromTask', () => {
    it('creates a playbook from session context', async () => {
      const client = createMockClient();
      const playbook = await createPlaybookFromTask(
        { adapter: asyncAdapter, scope: s, client },
        {
          title: 'Fix failing tests',
          description: 'Run test suite and fix all failures',
          sessionId: 'sess-1',
          tags: ['testing', 'ci'],
        },
      );

      expect(playbook.id).toBeGreaterThan(0);
      expect(playbook.title).toBe('Fix failing tests');
      expect(playbook.description).toBe('Run test suite and fix all failures');
      expect(playbook.instructions).toContain('npm test');
      expect(playbook.references).toContain('package.json');
      expect(playbook.templates).toContain('test-template.ts');
      expect(playbook.scripts).toContain('npm run test:coverage');
      expect(playbook.tags).toEqual(['testing', 'ci']);
      expect(playbook.status).toBe('active');
      expect(playbook.source_session_id).toBe('sess-1');
    });

    it('handles empty session gracefully', async () => {
      const client = createMockClient();
      const playbook = await createPlaybookFromTask(
        { adapter: asyncAdapter, scope: s, client },
        {
          title: 'Empty session playbook',
          description: 'No turns available',
          sessionId: 'nonexistent-session',
        },
      );

      expect(playbook.id).toBeGreaterThan(0);
      expect(playbook.instructions).toBeTruthy();
    });
  });

  describe('revisePlaybook', () => {
    it('stores old instructions as revision and updates playbook', async () => {
      // Create initial playbook
      const playbook = adapter.insertPlaybook({
        ...s,
        title: 'Deploy procedure',
        description: 'How to deploy',
        instructions: 'Step 1: Build. Step 2: Push.',
        status: 'active',
      });

      const result = await revisePlaybook(
        asyncAdapter,
        s,
        playbook.id,
        'Step 1: Build. Step 2: Test. Step 3: Push.',
        'Added test step before push',
        'sess-2',
      );

      // Revision should contain OLD instructions
      expect(result.revision.instructions).toBe('Step 1: Build. Step 2: Push.');
      expect(result.revision.revision_reason).toBe('Added test step before push');
      expect(result.revision.source_session_id).toBe('sess-2');

      // Playbook should have NEW instructions
      expect(result.playbook.instructions).toBe('Step 1: Build. Step 2: Test. Step 3: Push.');
    });

    it('rejects revision of playbook from different scope', async () => {
      const playbook = adapter.insertPlaybook({
        ...s,
        title: 'Scoped playbook',
        description: 'Belongs to thread-1',
        instructions: 'Original',
        status: 'active',
      });

      const otherScope = scope({ scope_id: 'thread-2' });
      await expect(
        revisePlaybook(asyncAdapter, otherScope, playbook.id, 'Hijacked', 'xss'),
      ).rejects.toThrow('does not belong');
    });

    it('throws for nonexistent playbook', async () => {
      await expect(
        revisePlaybook(asyncAdapter, s, 9999, 'new', 'reason'),
      ).rejects.toThrow('not found');
    });

    it('increments revision count', async () => {
      const playbook = adapter.insertPlaybook({
        ...s,
        title: 'Revisable',
        description: 'Will be revised',
        instructions: 'v1',
        status: 'active',
      });

      await revisePlaybook(asyncAdapter, s, playbook.id, 'v2', 'first revision');
      await revisePlaybook(asyncAdapter, s, playbook.id, 'v3', 'second revision');

      const revisions = await asyncAdapter.getPlaybookRevisions(playbook.id);
      expect(revisions.length).toBe(2);
      // Most recent revision first: v2 was stored when v3 replaced it, v1 was stored when v2 replaced it
      // But both revisions have similar created_at timestamps, so check both exist
      const revisionInstructions = revisions.map((r) => r.instructions).sort();
      expect(revisionInstructions).toEqual(['v1', 'v2']);
    });
  });

  describe('findRelevantPlaybooks', () => {
    it('finds playbooks matching query', async () => {
      adapter.insertPlaybook({
        ...s,
        title: 'Deploy to production',
        description: 'Production deployment procedure',
        instructions: 'Run deploy.sh',
        status: 'active',
      });
      adapter.insertPlaybook({
        ...s,
        title: 'Run tests',
        description: 'Testing procedure',
        instructions: 'Run npm test',
        status: 'active',
      });

      const results = await findRelevantPlaybooks(asyncAdapter, s, 'deploy');
      expect(results.length).toBe(1);
      expect(results[0].item.title).toBe('Deploy to production');
    });

    it('excludes archived playbooks by default', async () => {
      adapter.insertPlaybook({
        ...s,
        title: 'Old deploy process',
        description: 'Deprecated',
        instructions: 'Old way',
        status: 'archived',
      });

      const results = await findRelevantPlaybooks(asyncAdapter, s, 'deploy');
      expect(results.length).toBe(0);
    });

    it('respects limit option', async () => {
      for (let i = 0; i < 5; i++) {
        adapter.insertPlaybook({
          ...s,
          title: `Playbook ${i} about testing`,
          description: 'Testing related',
          instructions: 'Test instructions',
          status: 'active',
        });
      }

      const results = await findRelevantPlaybooks(asyncAdapter, s, 'testing', { limit: 2 });
      expect(results.length).toBe(2);
    });

    it('returns empty for no matches', async () => {
      adapter.insertPlaybook({
        ...s,
        title: 'Deploy',
        description: 'Deploy stuff',
        instructions: 'Deploy instructions',
        status: 'active',
      });

      const results = await findRelevantPlaybooks(asyncAdapter, s, 'nonexistent-query-xyz');
      expect(results.length).toBe(0);
    });
  });
});
