import { describe, expect, it } from 'vitest';

import {
  classifyFactRelation,
  createCompositeExtractor,
  createHeuristicExtractor,
  createEnhancedRegexExtractor,
  createRegexExtractor,
  extractTemporalWindow,
  getContradictionKey,
  normalizeExtractedFact,
  normalizeFactText,
} from '../core/extractor.js';
import { createClaudeExtractor, createOpenAIExtractor } from '../summarizers/extractor.js';
import { parseExtractionResponse } from '../summarizers/prompts.js';
import { ProviderUnavailableError } from '../contracts/errors.js';

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
        sourceText: null,
        rationale: null,
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
        sourceText: null,
        rationale: null,
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

  it('extracts causal, comparative, and failure-derived facts', async () => {
    const extractor = createRegexExtractor();
    const facts = await extractor(
      [
        'Because Docker slowed local feedback loops, we chose SQLite for development.',
        'TypeScript is better than JavaScript for this memory layer.',
        "Aggressive caching didn't work for deploys.",
      ].join(' '),
      [],
      [],
    );

    expect(facts.some((fact) => fact.factType === 'decision')).toBe(true);
    expect(
      facts.some(
        (fact) =>
          fact.factType === 'preference' &&
          fact.fact.toLowerCase().includes('typescript'),
      ),
    ).toBe(true);
    expect(facts.some((fact) => fact.factType === 'constraint')).toBe(true);
  });

  it('surfaces implicit preferences and repeated domain usage in enhanced mode', async () => {
    const extractor = createEnhancedRegexExtractor();
    const facts = await extractor(
      'We went with React for the dashboard and ended up using React for the admin shell. React made the system easier to ship.',
      [],
      [],
    );

    expect(
      facts.some(
        (fact) =>
          fact.factType === 'preference' &&
          fact.fact.toLowerCase().includes('react'),
      ),
    ).toBe(true);
    expect(
      facts.some(
        (fact) =>
          fact.factType === 'entity' &&
          fact.fact.toLowerCase().includes('react'),
      ),
    ).toBe(true);
  });

  it('extracts dependency and migration facts in heuristic mode', async () => {
    const extractor = createHeuristicExtractor();
    const facts = await extractor(
      'The project relies on PostgreSQL. We migrated from Redis to Postgres. Keep local-first development.',
      [],
      [],
    );

    expect(
      facts.some(
        (fact) => fact.factType === 'reference' && fact.fact.toLowerCase().includes('postgresql'),
      ),
    ).toBe(true);
    expect(
      facts.some(
        (fact) => fact.factType === 'decision' && fact.fact.toLowerCase().includes('postgres'),
      ),
    ).toBe(true);
    expect(
      facts.some(
        (fact) => fact.factType === 'constraint' && fact.fact.toLowerCase().includes('local-first'),
      ),
    ).toBe(true);
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

  it('parses negated constraints as conflicts on the same slot', () => {
    const existing = normalizeExtractedFact({
      fact: 'The system must use Docker',
      factType: 'constraint',
      confidence: 'high',
    });
    const candidate = normalizeExtractedFact({
      fact: 'The system must not use Docker',
      factType: 'constraint',
      confidence: 'high',
    });

    expect(existing.slotKey).toBe(candidate.slotKey);
    expect(existing.isNegated).toBe(false);
    expect(candidate.isNegated).toBe(true);
    expect(classifyFactRelation(existing, candidate)).toBe('conflict');
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

  it('throws a typed ProviderUnavailableError when anthropic sdk is missing', async () => {
    await expect(createClaudeExtractor()('summary', [], [])).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(createClaudeExtractor()('summary', [], [])).rejects.toThrow('@anthropic-ai/sdk');
  });

  it('throws a typed ProviderUnavailableError when openai sdk is missing', async () => {
    await expect(createOpenAIExtractor()('summary', [], [])).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(createOpenAIExtractor()('summary', [], [])).rejects.toThrow('openai');
  });

  it('surfaces malformed extraction responses as ProviderUnavailableError', () => {
    // items present but not an array -> "response must be a JSON array"
    expect(() => parseExtractionResponse('{"items":"nope"}')).toThrow(ProviderUnavailableError);
    // fact field missing -> "invalid extracted fact"
    expect(() => parseExtractionResponse('[{"factType":"preference"}]')).toThrow(
      ProviderUnavailableError,
    );
    // unknown factType -> "invalid factType"
    expect(() => parseExtractionResponse('[{"fact":"x","factType":"bogus"}]')).toThrow(
      ProviderUnavailableError,
    );
    // unknown confidence -> "invalid confidence"
    expect(() =>
      parseExtractionResponse('[{"fact":"x","factType":"preference","confidence":"low"}]'),
    ).toThrow(ProviderUnavailableError);
    // non-JSON payload -> "response did not contain JSON"
    expect(() => parseExtractionResponse('definitely not json')).toThrow(ProviderUnavailableError);
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
        sourceText: null,
        rationale: null,
      },
    ]);
  });

  describe('temporal extraction', () => {
    it('extracts valid_from from "effective March 1st, 2025"', () => {
      const result = extractTemporalWindow('effective March 1st, 2025');
      expect(result.valid_from).toBe(Math.floor(Date.UTC(2025, 2, 1) / 1000));
      expect(result.valid_until).toBeNull();
    });

    it('extracts valid_from from "starting January 15, 2026"', () => {
      const result = extractTemporalWindow('starting January 15, 2026');
      expect(result.valid_from).toBe(Math.floor(Date.UTC(2026, 0, 15) / 1000));
      expect(result.valid_until).toBeNull();
    });

    it('extracts valid_from from "as of March 2025"', () => {
      const result = extractTemporalWindow('as of March 2025');
      expect(result.valid_from).toBe(Math.floor(Date.UTC(2025, 2, 1) / 1000));
      expect(result.valid_until).toBeNull();
    });

    it('extracts valid_until from "until December 31, 2025"', () => {
      const result = extractTemporalWindow('until December 31, 2025');
      expect(result.valid_from).toBeNull();
      // End-of-day: start of next day (Jan 1 2026)
      expect(result.valid_until).toBe(Math.floor(Date.UTC(2025, 11, 31) / 1000) + 86400);
    });

    it('extracts valid_from from "as of Q3 2025"', () => {
      const result = extractTemporalWindow('as of Q3 2025');
      expect(result.valid_from).toBe(Math.floor(Date.UTC(2025, 6, 1) / 1000));
      expect(result.valid_until).toBeNull();
    });

    it('extracts valid_until for "until Q4 2025"', () => {
      const result = extractTemporalWindow('until Q4 2025');
      // Q4 ends at the last second of December
      expect(result.valid_until).toBe(Math.floor(Date.UTC(2026, 0, 1) / 1000) - 1);
    });

    it('extracts both from and until for "from March 1, 2025 until June 30, 2025"', () => {
      const result = extractTemporalWindow('from March 1, 2025 until June 30, 2025');
      expect(result.valid_from).toBe(Math.floor(Date.UTC(2025, 2, 1) / 1000));
      // End-of-day: start of next day (Jul 1 2025)
      expect(result.valid_until).toBe(Math.floor(Date.UTC(2025, 5, 30) / 1000) + 86400);
    });

    it('extracts from ISO date "effective 2025-03-01"', () => {
      const result = extractTemporalWindow('effective 2025-03-01');
      expect(result.valid_from).toBe(Math.floor(Date.UTC(2025, 2, 1) / 1000));
    });

    it('extracts range from standalone quarter "Q3 2025"', () => {
      const result = extractTemporalWindow('Q3 2025');
      expect(result.valid_from).toBe(Math.floor(Date.UTC(2025, 6, 1) / 1000));
      expect(result.valid_until).toBe(Math.floor(Date.UTC(2025, 9, 1) / 1000) - 1);
    });

    it('returns null for ambiguous relative dates', () => {
      expect(extractTemporalWindow('starting Monday')).toEqual({ valid_from: null, valid_until: null });
      expect(extractTemporalWindow('until the migration completes')).toEqual({ valid_from: null, valid_until: null });
      expect(extractTemporalWindow('next week')).toEqual({ valid_from: null, valid_until: null });
      expect(extractTemporalWindow('soon')).toEqual({ valid_from: null, valid_until: null });
    });

    it('returns null for text without temporal language', () => {
      expect(extractTemporalWindow('The user prefers dark mode')).toEqual({ valid_from: null, valid_until: null });
    });

    it('populates valid_from/valid_until on normalized extracted facts via sourceText', () => {
      const fact = normalizeExtractedFact({
        fact: 'The system must use PostgreSQL',
        factType: 'constraint',
        confidence: 'high',
        sourceText: 'effective March 1, 2025: the system must use PostgreSQL',
      });
      expect(fact.valid_from).toBe(Math.floor(Date.UTC(2025, 2, 1) / 1000));
      expect(fact.valid_until).toBeNull();
    });

    it('does not overwrite explicit valid_from/valid_until on ExtractedFact', () => {
      const explicitFrom = 1700000000;
      const fact = normalizeExtractedFact({
        fact: 'The system must use PostgreSQL',
        factType: 'constraint',
        confidence: 'high',
        sourceText: 'effective March 1, 2025: the system must use PostgreSQL',
        valid_from: explicitFrom,
      });
      expect(fact.valid_from).toBe(explicitFrom);
    });

    it('leaves valid_from/valid_until null for facts without temporal language', () => {
      const fact = normalizeExtractedFact({
        fact: 'The user prefers TypeScript',
        factType: 'preference',
        confidence: 'high',
      });
      expect(fact.valid_from).toBeNull();
      expect(fact.valid_until).toBeNull();
    });

    it('handles DMY format "1 March 2025"', () => {
      const result = extractTemporalWindow('effective 1 March 2025');
      expect(result.valid_from).toBe(Math.floor(Date.UTC(2025, 2, 1) / 1000));
    });
  });
});
