import { describe, expect, it } from 'vitest';

import {
  buildReverseLookup,
  resolveEntityName,
  resolveAliases,
  normalizedStringSimilarity,
  discoverAliasCandidates,
} from '../core/aliases.js';
import { normalizeExtractedFact } from '../core/extractor.js';
import type { AliasMap } from '../contracts/aliases.js';
import type { KnowledgeMemory } from '../contracts/types.js';

const aliasMap: AliasMap = {
  TypeScript: ['ts', 'TS', 'typescript'],
  PostgreSQL: ['postgres', 'pg', 'Postgres'],
  'Visual Studio Code': ['vscode', 'VS Code', 'VSCode'],
};

describe('buildReverseLookup', () => {
  it('maps all aliases and canonical names to canonical', () => {
    const lookup = buildReverseLookup(aliasMap);
    expect(lookup.get('ts')).toBe('TypeScript');
    expect(lookup.get('typescript')).toBe('TypeScript');
    expect(lookup.get('postgres')).toBe('PostgreSQL');
    expect(lookup.get('pg')).toBe('PostgreSQL');
    expect(lookup.get('vscode')).toBe('Visual Studio Code');
    expect(lookup.get('vs code')).toBe('Visual Studio Code');
    // Canonical names themselves map back
    expect(lookup.get('postgresql')).toBe('PostgreSQL');
  });

  it('returns empty map for empty alias map', () => {
    expect(buildReverseLookup({}).size).toBe(0);
  });
});

describe('resolveEntityName', () => {
  const lookup = buildReverseLookup(aliasMap);

  it('resolves known alias to canonical', () => {
    expect(resolveEntityName('pg', lookup)).toBe('PostgreSQL');
    expect(resolveEntityName('TS', lookup)).toBe('TypeScript');
  });

  it('returns original for unknown name', () => {
    expect(resolveEntityName('Rust', lookup)).toBe('Rust');
  });

  it('is case-insensitive', () => {
    expect(resolveEntityName('POSTGRES', lookup)).toBe('PostgreSQL');
    expect(resolveEntityName('vScode', lookup)).toBe('Visual Studio Code');
  });
});

describe('resolveAliases', () => {
  function makeFact(text: string) {
    return normalizeExtractedFact({
      fact: text,
      factType: 'preference',
      confidence: 'high',
    });
  }

  it('replaces aliases with canonical names in facts', () => {
    const facts = [makeFact('The user prefers ts over python')];
    const result = resolveAliases(facts, aliasMap);
    expect(result.facts[0].fact).toContain('TypeScript');
    expect(result.resolutions.length).toBeGreaterThan(0);
    expect(result.resolutions.some((r) => r.canonical === 'TypeScript')).toBe(true);
  });

  it('replaces multiple aliases in a single fact', () => {
    const facts = [makeFact('Uses postgres with vscode')];
    const result = resolveAliases(facts, aliasMap);
    expect(result.facts[0].fact).toContain('PostgreSQL');
    expect(result.facts[0].fact).toContain('Visual Studio Code');
  });

  it('passes through unchanged when no aliases match', () => {
    const facts = [makeFact('The user likes Rust')];
    const result = resolveAliases(facts, aliasMap);
    expect(result.facts[0].fact).toBe('The user likes Rust');
    expect(result.resolutions).toHaveLength(0);
  });

  it('returns facts unchanged when aliasMap is undefined', () => {
    const facts = [makeFact('Uses ts daily')];
    const result = resolveAliases(facts, undefined);
    expect(result.facts).toBe(facts); // Same reference
    expect(result.resolutions).toHaveLength(0);
  });

  it('returns facts unchanged when aliasMap is empty', () => {
    const facts = [makeFact('Uses ts daily')];
    const result = resolveAliases(facts, {});
    expect(result.facts).toBe(facts);
    expect(result.resolutions).toHaveLength(0);
  });

  it('deduplicates resolutions', () => {
    const facts = [
      makeFact('Uses ts for backend'),
      makeFact('Prefers ts for frontend too'),
    ];
    const result = resolveAliases(facts, aliasMap);
    const tsResolutions = result.resolutions.filter((r) => r.canonical === 'TypeScript');
    expect(tsResolutions).toHaveLength(1);
  });

  it('updates normalizedFact field', () => {
    const facts = [makeFact('The user prefers postgres')];
    const result = resolveAliases(facts, aliasMap);
    expect(result.facts[0].normalizedFact.toLowerCase()).toContain('postgresql');
  });

  it('resolves subject field via alias map', () => {
    const fact = normalizeExtractedFact({
      fact: 'postgres is the primary database',
      factType: 'reference',
      confidence: 'high',
    });
    // If subject happens to be an alias, it should resolve
    const result = resolveAliases([fact], aliasMap);
    expect(result.facts).toHaveLength(1);
  });
});

describe('normalizedStringSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(normalizedStringSimilarity('PostgreSQL', 'PostgreSQL')).toBe(1.0);
  });

  it('returns 1.0 for case-different identical strings', () => {
    expect(normalizedStringSimilarity('postgresql', 'PostgreSQL')).toBe(1.0);
  });

  it('returns high similarity for minor typos', () => {
    const sim = normalizedStringSimilarity('PostgreSQL', 'PostreSQL');
    expect(sim).toBeGreaterThan(0.8);
  });

  it('returns low similarity for unrelated strings', () => {
    const sim = normalizedStringSimilarity('PostgreSQL', 'React');
    expect(sim).toBeLessThan(0.3);
  });

  it('returns 0.0 when one string is empty', () => {
    expect(normalizedStringSimilarity('', 'PostgreSQL')).toBe(0.0);
    expect(normalizedStringSimilarity('PostgreSQL', '')).toBe(0.0);
  });

  it('detects high similarity for abbreviation-like pairs', () => {
    // "typescript" vs "typescritp" (typo)
    const sim = normalizedStringSimilarity('typescript', 'typescritp');
    expect(sim).toBeGreaterThanOrEqual(0.8);
  });
});

describe('discoverAliasCandidates', () => {
  function makeKnowledgeMemory(overrides: Partial<KnowledgeMemory>): KnowledgeMemory {
    return {
      id: 1,
      tenant_id: 'test',
      system_id: 'test',
      workspace_id: 'test',
      collaboration_id: null,
      scope_id: 'test',
      fact: 'test fact',
      fact_type: 'entity',
      knowledge_state: 'trusted',
      knowledge_class: 'identity',
      fact_subject: null,
      fact_attribute: null,
      fact_value: null,
      normalized_fact: null,
      slot_key: null,
      is_negated: false,
      source: 'promoted_from_working',
      confidence: 'high',
      confidence_score: 0.9,
      grounding_strength: 'strong',
      evidence_count: 2,
      trust_score: 0.9,
      verification_status: 'verified',
      verification_notes: null,
      last_verified_at: null,
      source_working_memory_id: 1,
      source_turn_ids: [],
      contradiction_score: 0,
      dispute_reason: null,
      superseded_by_id: null,
      retired_at: null,
      valid_from: null,
      valid_until: null,
      rationale: null,
      tags: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
      ...overrides,
    };
  }

  it('discovers high-similarity entity pairs', () => {
    const knowledge = [
      makeKnowledgeMemory({ id: 1, fact_value: 'PostgreSQL', fact_type: 'entity' }),
      makeKnowledgeMemory({ id: 2, fact_value: 'PostreSQL', fact_type: 'entity' }),
    ];
    const candidates = discoverAliasCandidates(knowledge);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].entity1).toBe('PostgreSQL');
    expect(candidates[0].entity2).toBe('PostreSQL');
    expect(candidates[0].similarity).toBeGreaterThan(0.85);
    expect(candidates[0].confirmed).toBe(false);
  });

  it('returns empty for dissimilar entities', () => {
    const knowledge = [
      makeKnowledgeMemory({ id: 1, fact_value: 'PostgreSQL', fact_type: 'entity' }),
      makeKnowledgeMemory({ id: 2, fact_value: 'React', fact_type: 'entity' }),
    ];
    const candidates = discoverAliasCandidates(knowledge);
    expect(candidates).toHaveLength(0);
  });

  it('excludes already-known alias pairs', () => {
    const knowledge = [
      makeKnowledgeMemory({ id: 1, fact_value: 'PostgreSQL', fact_type: 'entity' }),
      makeKnowledgeMemory({ id: 2, fact_value: 'PostreSQL', fact_type: 'entity' }),
    ];
    const candidates = discoverAliasCandidates(knowledge, {
      existingAliases: { PostgreSQL: ['PostreSQL'] },
    });
    expect(candidates).toHaveLength(0);
  });

  it('returns empty for fewer than 2 entities', () => {
    const knowledge = [
      makeKnowledgeMemory({ id: 1, fact_value: 'PostgreSQL', fact_type: 'entity' }),
    ];
    expect(discoverAliasCandidates(knowledge)).toHaveLength(0);
  });

  it('respects custom threshold', () => {
    const knowledge = [
      makeKnowledgeMemory({ id: 1, fact_value: 'PostgreSQL', fact_type: 'entity' }),
      makeKnowledgeMemory({ id: 2, fact_value: 'PostreSQL', fact_type: 'entity' }),
    ];
    // Very high threshold should reject
    const strict = discoverAliasCandidates(knowledge, { threshold: 0.99 });
    expect(strict).toHaveLength(0);
  });

  it('respects maxCandidates limit', () => {
    const knowledge = [
      makeKnowledgeMemory({ id: 1, fact_value: 'PostgreSQL', fact_type: 'entity' }),
      makeKnowledgeMemory({ id: 2, fact_value: 'PostreSQL', fact_type: 'entity' }),
      makeKnowledgeMemory({ id: 3, fact_value: 'Postgressql', fact_type: 'entity' }),
    ];
    const candidates = discoverAliasCandidates(knowledge, { maxCandidates: 1 });
    expect(candidates.length).toBeLessThanOrEqual(1);
  });

  it('suggests longer name as canonical', () => {
    const knowledge = [
      makeKnowledgeMemory({ id: 1, fact_value: 'PostgreSQL', fact_type: 'entity' }),
      makeKnowledgeMemory({ id: 2, fact_value: 'PostreSQL', fact_type: 'entity' }),
    ];
    const candidates = discoverAliasCandidates(knowledge);
    expect(candidates[0].suggestedCanonical).toBe('PostgreSQL');
  });

  it('collects entity names from fact_subject too', () => {
    const knowledge = [
      makeKnowledgeMemory({ id: 1, fact_subject: 'PostgreSQL', fact_value: null, fact_type: 'reference' }),
      makeKnowledgeMemory({ id: 2, fact_subject: 'PostreSQL', fact_value: null, fact_type: 'reference' }),
    ];
    const candidates = discoverAliasCandidates(knowledge);
    expect(candidates).toHaveLength(1);
  });

  it('all candidates have confirmed: false', () => {
    const knowledge = [
      makeKnowledgeMemory({ id: 1, fact_value: 'PostgreSQL', fact_type: 'entity' }),
      makeKnowledgeMemory({ id: 2, fact_value: 'PostreSQL', fact_type: 'entity' }),
      makeKnowledgeMemory({ id: 3, fact_value: 'Postgressql', fact_type: 'entity' }),
    ];
    const candidates = discoverAliasCandidates(knowledge);
    expect(candidates.every((c) => c.confirmed === false)).toBe(true);
  });
});
