import type { FactConfidence, FactType } from '../contracts/types.js';

export interface ExtractedFact {
  fact: string;
  factType: FactType;
  confidence: FactConfidence;
}

export type Extractor = (
  summary: string,
  keyEntities: string[],
  topicTags: string[],
) => Promise<ExtractedFact[]>;

function uniqFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const seen = new Set<string>();
  const results: ExtractedFact[] = [];

  for (const fact of facts) {
    const normalized = normalizeFactText(fact.fact);
    const key = `${fact.factType}:${normalized}`;
    if (normalized.length === 0 || seen.has(key)) continue;
    seen.add(key);
    results.push({
      ...fact,
      fact: fact.fact.trim(),
    });
  }

  return results;
}

export function normalizeFactText(fact: string): string {
  return fact.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getContradictionKey(factType: FactType, fact: string): string | null {
  const normalized = normalizeFactText(fact);
  const preferenceMatch = normalized.match(/^(?:the user )?(?:prefers?|likes?|wants?|uses?)\s+(.+)$/);
  if (factType === 'preference' && preferenceMatch) {
    return 'preference:user';
  }

  const decisionMatch = normalized.match(/^(?:the user )?(?:decided|chose)\s+(.+)$/);
  if (factType === 'decision' && decisionMatch) {
    return 'decision:user';
  }

  const constraintMatch = normalized.match(
    /^(?:the user )?(?:must|cannot|can't|requires?)\s+(.+)$/,
  );
  if (factType === 'constraint' && constraintMatch) {
    return 'constraint:user';
  }

  return null;
}

function extractMatches(
  source: string,
  pattern: RegExp,
  factType: FactType,
  confidence: FactConfidence,
): ExtractedFact[] {
  const matches: ExtractedFact[] = [];
  for (const match of source.matchAll(pattern)) {
    const fact = match[0].trim();
    if (fact.length === 0) continue;
    matches.push({ fact, factType, confidence });
  }
  return matches;
}

export function createRegexExtractor(): Extractor {
  return async (summary, keyEntities) => {
    const combined = summary.replace(/\n+/g, ' ');
    const facts: ExtractedFact[] = [
      ...extractMatches(
        combined,
        /\b(?:the user )?(?:prefers?|likes?|wants?|uses?)\s+[^.?!;]+/gi,
        'preference',
        'medium',
      ),
      ...extractMatches(
        combined,
        /\b(?:the user )?(?:decided|chose)\s+[^.?!;]+/gi,
        'decision',
        'high',
      ),
      ...extractMatches(
        combined,
        /\b(?:the user )?(?:must|cannot|can't|requires?)\s+[^.?!;]+/gi,
        'constraint',
        'high',
      ),
      ...keyEntities.map((entity) => ({
        fact: entity,
        factType: 'entity' as const,
        confidence: 'medium' as const,
      })),
    ];

    return uniqFacts(facts);
  };
}
