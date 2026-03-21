import { describe, expect, it } from 'vitest';

import { createClaudeSummarizer } from '../summarizers/claude.js';
import { createOpenAISummarizer } from '../summarizers/openai.js';
import {
  formatTurnsForSummarization,
  parseSummarizerResponse,
  SUMMARIZATION_SYSTEM_PROMPT,
} from '../summarizers/prompts.js';
import type { Turn } from '../contracts/types.js';

function makeTurn(content: string): Turn {
  return {
    id: 1,
    session_id: 's1',
    tenant_id: 'acme',
    system_id: 'assistant',
    workspace_id: 'default',
    scope_id: 'thread-1',
    actor: 'user-1',
    role: 'user',
    content,
    token_estimate: 10,
    created_at: 1,
    archived_at: null,
    compaction_log_id: null,
    schema_version: 1,
  };
}

describe('summarizer helpers', () => {
  it('formats turns for summarization', () => {
    expect(formatTurnsForSummarization([makeTurn('hello')])).toContain('[user] user-1: hello');
  });

  it('parses summarizer JSON responses', () => {
    expect(
      parseSummarizerResponse(
        '{"summary":"short","key_entities":["memory"],"topic_tags":["context"]}',
      ),
    ).toEqual({
      summary: 'short',
      key_entities: ['memory'],
      topic_tags: ['context'],
    });
  });

  it('exposes a non-empty system prompt', () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT.length).toBeGreaterThan(20);
  });

  it('throws a clear error when anthropic sdk is missing', async () => {
    await expect(createClaudeSummarizer()([makeTurn('hello')])).rejects.toThrow(
      "@anthropic-ai/sdk",
    );
  });

  it('throws a clear error when openai sdk is missing', async () => {
    await expect(createOpenAISummarizer()([makeTurn('hello')])).rejects.toThrow('openai');
  });
});
