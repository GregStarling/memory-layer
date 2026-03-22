import { describe, expect, it } from 'vitest';

import { createExtractiveSummarizer } from '../summarizers/extractive.js';
import type { Turn } from '../contracts/types.js';

function makeTurn(id: number, content: string): Turn {
  return {
    id,
    session_id: 'session-1',
    tenant_id: 'acme',
    system_id: 'assistant',
    workspace_id: 'default',
    scope_id: 'thread-1',
    actor: id % 2 === 0 ? 'assistant' : 'user',
    role: id % 2 === 0 ? 'assistant' : 'user',
    content,
    token_estimate: 10,
    created_at: id,
    archived_at: null,
    compaction_log_id: null,
    schema_version: 1,
  };
}

describe('extractive summarizer', () => {
  it('returns a valid summary payload', async () => {
    const summarizer = createExtractiveSummarizer();
    const result = await summarizer([
      makeTurn(
        1,
        'The user prefers local-first tools. The project must stay auditable. Use "memory-layer".',
      ),
      makeTurn(2, 'Decision: keep SQLite for local mode and keep @repo-memory workspace sharing.'),
    ]);

    expect(result.summary).toContain('local-first');
    expect(result.key_entities).toContain('memory-layer');
    expect(result.topic_tags.length).toBeGreaterThan(0);
  });

  it('handles empty turn lists', async () => {
    const summarizer = createExtractiveSummarizer();
    await expect(summarizer([])).resolves.toEqual({
      summary: 'No conversation history yet.',
      key_entities: [],
      topic_tags: [],
    });
  });

  it('prioritizes constraints and decisions under tighter budgets', async () => {
    const summarizer = createExtractiveSummarizer({ tokenBudget: 40, maxSentences: 2 });
    const result = await summarizer([
      makeTurn(1, 'We chatted casually about tooling for a while.'),
      makeTurn(2, 'The project must stay local-first.'),
      makeTurn(3, 'We decided to keep SQLite as the default store.'),
    ]);

    expect(result.summary).toContain('must stay local-first');
    expect(result.summary).toContain('decided');
  });
});
