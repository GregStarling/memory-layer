import { describe, expect, it } from 'vitest';

import { createRegexExtractor, normalizeFactText } from '../core/extractor.js';
import { createClaudeExtractor, createOpenAIExtractor } from '../summarizers/extractor.js';
import { parseExtractionResponse } from '../summarizers/prompts.js';

describe('extractors', () => {
  it('normalizes fact text for deduplication', () => {
    expect(normalizeFactText('  The User Likes Rust  ')).toBe('the user likes rust');
  });

  it('parses extraction responses', () => {
    expect(
      parseExtractionResponse(
        '[{"fact":"The user prefers rust","factType":"preference","confidence":"high"}]',
      ),
    ).toEqual([
      {
        fact: 'The user prefers rust',
        factType: 'preference',
        confidence: 'high',
      },
    ]);
  });

  it('regex extractor finds durable facts and key entities', async () => {
    const extractor = createRegexExtractor();
    const facts = await extractor(
      'The user prefers Rust. The user decided to store memory in sqlite. The user must keep this local.',
      ['SQLite', 'Rust'],
      [],
    );
    expect(facts.some((fact) => fact.factType === 'preference')).toBe(true);
    expect(facts.some((fact) => fact.factType === 'decision')).toBe(true);
    expect(facts.some((fact) => fact.factType === 'constraint')).toBe(true);
    expect(facts.some((fact) => fact.fact === 'SQLite')).toBe(true);
  });

  it('returns empty list when no durable fact exists', async () => {
    const extractor = createRegexExtractor();
    await expect(extractor('Just chatting about a transient idea.', [], [])).resolves.toEqual([]);
  });

  it('throws a clear error when anthropic sdk is missing', async () => {
    await expect(createClaudeExtractor()('summary', [], [])).rejects.toThrow('@anthropic-ai/sdk');
  });

  it('throws a clear error when openai sdk is missing', async () => {
    await expect(createOpenAIExtractor()('summary', [], [])).rejects.toThrow('openai');
  });
});
