import { describe, expect, it } from 'vitest';

import {
  classifyFactRelation,
  createCompositeExtractor,
  createRegexExtractor,
  getContradictionKey,
  normalizeExtractedFact,
  normalizeFactText,
} from '../core/extractor.js';
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

  it('parses wrapped extraction payloads', () => {
    expect(
      parseExtractionResponse(
        '{"items":[{"fact":"The project uses sqlite","factType":"reference","confidence":"medium"}]}',
      ),
    ).toEqual([
      {
        fact: 'The project uses sqlite',
        factType: 'reference',
        confidence: 'medium',
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

  it('supports custom domain groups for contradiction bucketing', () => {
    const normalized = normalizeExtractedFact({
      fact: 'The user prefers tmuxinator',
      factType: 'preference',
      confidence: 'high',
      domainGroups: {
        tooling: ['tmuxinator', 'overmind'],
      },
    });
    expect(normalized.slotKey).toContain('tooling');
  });

  it('extracts expanded reference and entity patterns', async () => {
    const extractor = createRegexExtractor();
    const facts = await extractor(
      'The project is built with TypeScript. The workspace is called Atlas. The system is running locally.',
      [],
      [],
    );
    expect(facts.some((fact) => fact.factType === 'reference')).toBe(true);
    expect(facts.some((fact) => fact.factType === 'entity')).toBe(true);
  });

  it('creates distinct contradiction keys for unrelated preferences', () => {
    expect(getContradictionKey('preference', 'The user prefers dark mode')).not.toBe(
      getContradictionKey('preference', 'The user prefers TypeScript'),
    );
  });

  it('classifies updates versus compatible facts', () => {
    const updateRelation = classifyFactRelation(
      normalizeExtractedFact({
        fact: 'The user prefers Vim',
        factType: 'preference',
        confidence: 'high',
      }),
      normalizeExtractedFact({
        fact: 'The user prefers Neovim',
        factType: 'preference',
        confidence: 'high',
      }),
    );
    const compatibleRelation = classifyFactRelation(
      normalizeExtractedFact({
        fact: 'The user prefers dark mode',
        factType: 'preference',
        confidence: 'high',
      }),
      normalizeExtractedFact({
        fact: 'The user prefers TypeScript',
        factType: 'preference',
        confidence: 'high',
      }),
    );

    expect(updateRelation).toBe('update');
    expect(compatibleRelation).toBe('compatible');
  });

  it('composite extractor merges and deduplicates results', async () => {
    const extractor = createCompositeExtractor(
      async () => [
        { fact: 'The user prefers Rust', factType: 'preference', confidence: 'high' as const },
      ],
      async () => [
        { fact: 'The user prefers Rust', factType: 'preference', confidence: 'high' as const },
        { fact: 'The project is built with sqlite', factType: 'reference', confidence: 'medium' as const },
      ],
    );

    const facts = await extractor('summary', [], []);
    expect(facts).toHaveLength(2);
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

  it('supports custom extractor clients', async () => {
    const extractor = createOpenAIExtractor({
      prompt: 'custom extraction prompt',
      client: {
        async generate(request) {
          expect(request.systemPrompt).toBe('custom extraction prompt');
          return '[{"fact":"The project uses sqlite","factType":"reference","confidence":"high"}]';
        },
      },
    });

    await expect(extractor('summary', [], [])).resolves.toEqual([
      {
        fact: 'The project uses sqlite',
        factType: 'reference',
        confidence: 'high',
      },
    ]);
  });
});
