import type {
  FactConfidence,
  FactType,
  KnowledgeMemory,
  KnowledgeRelation,
} from '../contracts/types.js';

export interface ExtractedFact {
  fact: string;
  factType: FactType;
  confidence: FactConfidence;
  sourceText?: string | null;
}

export interface NormalizedExtractedFact extends ExtractedFact {
  subject: string | null;
  attribute: string | null;
  value: string | null;
  normalizedFact: string;
  slotKey: string | null;
  isNegated: boolean;
}

export type Extractor = (
  summary: string,
  keyEntities: string[],
  topicTags: string[],
) => Promise<ExtractedFact[]>;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'be',
  'for',
  'is',
  'of',
  'the',
  'this',
  'that',
  'to',
  'with',
]);

const DOMAIN_GROUPS: Record<string, string[]> = {
  theme: ['dark', 'light'],
  editor: ['vim', 'neovim', 'emacs', 'vscode', 'cursor'],
  language: ['typescript', 'javascript', 'python', 'rust', 'go', 'java'],
  database: ['sqlite', 'postgres', 'postgresql', 'mysql'],
  deployment: ['local', 'cloud', 'hosted', 'onprem', 'on-prem'],
};

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
  return fact
    .trim()
    .replace(/[.?!;:,]+$/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizeFactValue(value: string): string {
  return normalizeFactText(value).replace(/^(?:the|a|an)\s+/g, '');
}

export function extractDomainToken(value: string): string {
  const normalized = normalizeFactValue(value);
  const tokens = normalized
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));

  for (const [group, candidates] of Object.entries(DOMAIN_GROUPS)) {
    if (tokens.some((token) => candidates.includes(token))) {
      return group;
    }
  }

  return tokens.slice(0, 2).join('_') || normalized || 'general';
}

function inferSubject(text: string): string | null {
  const normalized = normalizeFactText(text);
  if (normalized.startsWith('the user ') || normalized.startsWith('user ')) return 'user';
  if (normalized.startsWith('the system ') || normalized.startsWith('system ')) return 'system';
  if (normalized.startsWith('the project ') || normalized.startsWith('project ')) return 'project';
  if (normalized.startsWith('the workspace ') || normalized.startsWith('workspace ')) return 'workspace';
  return 'user';
}

function inferStructuredFields(
  factType: FactType,
  fact: string,
): Pick<NormalizedExtractedFact, 'subject' | 'attribute' | 'value' | 'slotKey' | 'isNegated'> {
  const normalized = normalizeFactText(fact);
  const subject = inferSubject(normalized);

  if (factType === 'entity') {
    const value = normalizeFactValue(fact);
    return {
      subject: 'entity',
      attribute: 'entity_name',
      value,
      slotKey: `entity:${extractDomainToken(value)}`,
      isNegated: false,
    };
  }

  const preferenceMatch = normalized.match(
    /^(?:the user )?(prefers?|likes?|wants?|uses?|avoids?|doesn't like|does not like)\s+(.+)$/,
  );
  if (factType === 'preference' && preferenceMatch) {
    const predicate = preferenceMatch[1];
    const value = normalizeFactValue(preferenceMatch[2]);
    return {
      subject: subject ?? 'user',
      attribute: predicate.includes('avoid') || predicate.includes("doesn't")
        ? 'preference_avoid'
        : 'preference',
      value,
      slotKey: `${subject ?? 'user'}:preference:${extractDomainToken(value)}`,
      isNegated: predicate.includes('avoid') || predicate.includes("doesn't"),
    };
  }

  const decisionMatch = normalized.match(/^(?:the user |we )?(?:decided|chose|selected)\s+(.+)$/);
  if (factType === 'decision' && decisionMatch) {
    const value = normalizeFactValue(decisionMatch[1]);
    return {
      subject: subject ?? 'user',
      attribute: 'decision',
      value,
      slotKey: `${subject ?? 'user'}:decision:${extractDomainToken(value)}`,
      isNegated: false,
    };
  }

  const constraintMatch = normalized.match(
    /^(?:the user |the system |the project |we )?(must|must not|cannot|can't|requires?|should not|never|avoid)\s+(.+)$/,
  );
  if (factType === 'constraint' && constraintMatch) {
    const predicate = constraintMatch[1];
    const value = normalizeFactValue(constraintMatch[2]);
    return {
      subject: subject ?? 'system',
      attribute: 'constraint',
      value,
      slotKey: `${subject ?? 'system'}:constraint:${extractDomainToken(value)}`,
      isNegated:
        predicate.includes('not') || predicate.includes("can't") || predicate.includes('cannot'),
    };
  }

  const referenceMatch = normalized.match(
    /^(?:the (?:system|project) )?(?:is|are|using|running|built with|named|called)\s+(.+)$/,
  );
  if (factType === 'reference' && referenceMatch) {
    const value = normalizeFactValue(referenceMatch[1]);
    return {
      subject: subject ?? 'system',
      attribute: 'reference',
      value,
      slotKey: `${subject ?? 'system'}:reference:${extractDomainToken(value)}`,
      isNegated: false,
    };
  }

  const fallbackValue = normalizeFactValue(fact);
  return {
    subject,
    attribute: factType,
    value: fallbackValue || null,
    slotKey: `${subject ?? 'general'}:${factType}:${extractDomainToken(fallbackValue)}`,
    isNegated: /\b(?:not|never|cannot|can't|must not|should not)\b/.test(normalized),
  };
}

export function normalizeExtractedFact(fact: ExtractedFact): NormalizedExtractedFact {
  const normalizedFact = normalizeFactText(fact.fact);
  const structured = inferStructuredFields(fact.factType, fact.fact);
  return {
    ...fact,
    sourceText: fact.sourceText ?? fact.fact,
    subject: structured.subject,
    attribute: structured.attribute,
    value: structured.value,
    normalizedFact,
    slotKey: structured.slotKey,
    isNegated: structured.isNegated,
  };
}

export function normalizeKnowledgeMemory(memory: KnowledgeMemory): NormalizedExtractedFact {
  const fallback = normalizeExtractedFact({
    fact: memory.fact,
    factType: memory.fact_type,
    confidence: memory.confidence,
    sourceText: memory.fact,
  });

  return {
    fact: memory.fact,
    factType: memory.fact_type,
    confidence: memory.confidence,
    sourceText: memory.fact,
    subject: memory.fact_subject ?? fallback.subject,
    attribute: memory.fact_attribute ?? fallback.attribute,
    value: memory.fact_value ?? fallback.value,
    normalizedFact: memory.normalized_fact ?? fallback.normalizedFact,
    slotKey: memory.slot_key ?? fallback.slotKey,
    isNegated: memory.is_negated,
  };
}

export function classifyFactRelation(
  existing: NormalizedExtractedFact,
  candidate: NormalizedExtractedFact,
): KnowledgeRelation {
  if (existing.normalizedFact === candidate.normalizedFact) {
    return 'duplicate';
  }

  if (
    existing.slotKey &&
    candidate.slotKey &&
    existing.slotKey === candidate.slotKey &&
    existing.subject === candidate.subject &&
    existing.attribute === candidate.attribute
  ) {
    if (existing.value === candidate.value && existing.isNegated === candidate.isNegated) {
      return 'duplicate';
    }

    if (existing.isNegated !== candidate.isNegated) {
      return 'conflict';
    }

    if (candidate.factType === 'constraint') {
      return 'conflict';
    }

    return 'update';
  }

  return 'compatible';
}

export function getContradictionKey(factType: FactType, fact: string): string | null {
  return normalizeExtractedFact({
    fact,
    factType,
    confidence: 'medium',
  }).slotKey;
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
    matches.push({ fact, factType, confidence, sourceText: fact });
  }
  return matches;
}

export function createCompositeExtractor(primary: Extractor, fallback: Extractor): Extractor {
  return async (summary, keyEntities, topicTags) => {
    const [primaryFacts, fallbackFacts] = await Promise.all([
      primary(summary, keyEntities, topicTags),
      fallback(summary, keyEntities, topicTags),
    ]);
    return uniqFacts([...primaryFacts, ...fallbackFacts]);
  };
}

export function createRegexExtractor(): Extractor {
  return async (summary, keyEntities) => {
    const combined = summary.replace(/\n+/g, ' ');
    const facts: ExtractedFact[] = [
      ...extractMatches(
        combined,
        /\b(?:the user )?(?:prefers?|likes?|wants?|uses?|avoids?|doesn't like|does not like)\s+[^.?!;]+/gi,
        'preference',
        'medium',
      ),
      ...extractMatches(
        combined,
        /\b(?:the user |we )?(?:decided|chose|selected)\s+[^.?!;]+/gi,
        'decision',
        'high',
      ),
      ...extractMatches(
        combined,
        /\b(?:the user |the system |the project |we )?(?:must|must not|cannot|can't|requires?|should not|avoid|never)\s+[^.?!;]+/gi,
        'constraint',
        'high',
      ),
      ...extractMatches(
        combined,
        /\b(?:the (?:system|project) )?(?:is|are|using|running|built with)\s+[^.?!;]+/gi,
        'reference',
        'medium',
      ),
      ...extractMatches(
        combined,
        /\b(?:the (?:system|project|workspace) )?(?:named|called)\s+[^.?!;]+/gi,
        'entity',
        'medium',
      ),
      ...keyEntities.map((entity) => ({
        fact: entity,
        factType: 'entity' as const,
        confidence: 'medium' as const,
        sourceText: entity,
      })),
    ];

    return uniqFacts(facts);
  };
}
