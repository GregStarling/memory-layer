import { describe, expect, it } from 'vitest';

import { createClaudeSummarizer } from '../summarizers/claude.js';
import { createOpenAISummarizer } from '../summarizers/openai.js';
import {
  formatTurnsForSummarization,
  parseSummarizerResponse,
  SUMMARIZATION_PROMPT_VERSION,
  SUMMARIZATION_SYSTEM_PROMPT,
} from '../summarizers/prompts.js';
import { ProviderUnavailableError } from '../contracts/errors.js';
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

  it('recovers JSON from fenced output', () => {
    expect(
      parseSummarizerResponse(
        '```json\n{"summary":"short","key_entities":["memory"],"topic_tags":["context"]}\n```',
      ),
    ).toEqual({
      summary: 'short',
      key_entities: ['memory'],
      topic_tags: ['context'],
    });
  });

  it('exposes a non-empty system prompt', () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT.length).toBeGreaterThan(20);
    expect(SUMMARIZATION_SYSTEM_PROMPT).toContain(SUMMARIZATION_PROMPT_VERSION);
  });

  it('supports custom structured clients', async () => {
    const summarizer = createOpenAISummarizer({
      prompt: 'custom prompt',
      client: {
        async generate(request) {
          expect(request.systemPrompt).toBe('custom prompt');
          return '{"summary":"custom","key_entities":["sdk"],"topic_tags":["tests"]}';
        },
      },
    });

    await expect(summarizer([makeTurn('hello')])).resolves.toEqual({
      summary: 'custom',
      key_entities: ['sdk'],
      topic_tags: ['tests'],
    });
  });

  it('throws a typed ProviderUnavailableError when anthropic sdk is missing', async () => {
    await expect(createClaudeSummarizer()([makeTurn('hello')])).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(createClaudeSummarizer()([makeTurn('hello')])).rejects.toThrow(
      '@anthropic-ai/sdk',
    );
  });

  it('throws a typed ProviderUnavailableError when openai sdk is missing', async () => {
    await expect(createOpenAISummarizer()([makeTurn('hello')])).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(createOpenAISummarizer()([makeTurn('hello')])).rejects.toThrow('openai');
  });

  it('surfaces malformed provider responses as ProviderUnavailableError', () => {
    expect(() => parseSummarizerResponse('not json at all')).toThrow(ProviderUnavailableError);
    expect(() => parseSummarizerResponse('{"key_entities":[],"topic_tags":[]}')).toThrow(
      ProviderUnavailableError,
    );
    expect(() =>
      parseSummarizerResponse('{"summary":"ok","key_entities":"bad","topic_tags":[]}'),
    ).toThrow(ProviderUnavailableError);
  });
});
