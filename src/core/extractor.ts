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
  domainGroups?: DomainGroups;
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

export type DomainGroups = Record<string, string[]>;

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

const DOMAIN_GROUPS: DomainGroups = {
  theme: ['dark', 'light'],
  editor: ['vim', 'neovim', 'emacs', 'vscode', 'cursor'],
  language: ['typescript', 'javascript', 'python', 'rust', 'go', 'java'],
  database: ['sqlite', 'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'dynamodb'],
  deployment: ['local', 'cloud', 'hosted', 'onprem', 'on-prem', 'staging', 'production', 'deploy'],
  framework: ['react', 'nextjs', 'next', 'vue', 'svelte', 'express', 'fastify', 'django', 'flask'],
  testing: ['vitest', 'jest', 'pytest', 'playwright', 'cypress'],
  packaging: ['npm', 'pnpm', 'yarn', 'docker', 'container'],
  style: ['tailwind', 'eslint', 'prettier', 'biome'],
  version_control: ['git', 'github', 'gitlab'],
  os: ['linux', 'macos', 'windows', 'ubuntu'],
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

function mergeDomainGroups(customGroups?: DomainGroups): DomainGroups {
  if (!customGroups) return DOMAIN_GROUPS;
  const merged: DomainGroups = { ...DOMAIN_GROUPS };
  for (const [group, values] of Object.entries(customGroups)) {
    merged[group] = [...new Set([...(merged[group] ?? []), ...values])];
  }
  return merged;
}

export function extractDomainToken(value: string, domainGroups: DomainGroups = DOMAIN_GROUPS): string {
  const normalized = normalizeFactValue(value);
  const tokens = normalized
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));

  for (const [group, candidates] of Object.entries(domainGroups)) {
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
  domainGroups: DomainGroups = DOMAIN_GROUPS,
): Pick<NormalizedExtractedFact, 'subject' | 'attribute' | 'value' | 'slotKey' | 'isNegated'> {
  const normalized = normalizeFactText(fact);
  const subject = inferSubject(normalized);

  if (factType === 'entity') {
    const value = normalizeFactValue(fact);
    return {
      subject: 'entity',
      attribute: 'entity_name',
      value,
      slotKey: `entity:${extractDomainToken(value, domainGroups)}`,
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
      slotKey: `${subject ?? 'user'}:preference:${extractDomainToken(value, domainGroups)}`,
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
      slotKey: `${subject ?? 'user'}:decision:${extractDomainToken(value, domainGroups)}`,
      isNegated: false,
    };
  }

  const constraintMatch = normalized.match(
    /^(?:the user |the system |the project |we )?(must not|should not|cannot|can't|must|requires?|never|avoid)\s+(.+)$/,
  );
  if (factType === 'constraint' && constraintMatch) {
    const predicate = constraintMatch[1];
    const value = normalizeFactValue(constraintMatch[2]);
    return {
      subject: subject ?? 'system',
      attribute: 'constraint',
      value,
      slotKey: `${subject ?? 'system'}:constraint:${extractDomainToken(value, domainGroups)}`,
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
      slotKey: `${subject ?? 'system'}:reference:${extractDomainToken(value, domainGroups)}`,
      isNegated: false,
    };
  }

  const fallbackValue = normalizeFactValue(fact);
  return {
    subject,
    attribute: factType,
    value: fallbackValue || null,
    slotKey: `${subject ?? 'general'}:${factType}:${extractDomainToken(fallbackValue, domainGroups)}`,
    isNegated: /\b(?:not|never|cannot|can't|must not|should not)\b/.test(normalized),
  };
}

export function normalizeExtractedFact(fact: ExtractedFact): NormalizedExtractedFact {
  const normalizedFact = normalizeFactText(fact.fact);
  const structured = inferStructuredFields(
    fact.factType,
    fact.fact,
    mergeDomainGroups(fact.domainGroups),
  );
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

function countDomainMatches(
  source: string,
  domainGroups: DomainGroups,
): Array<{ group: string; term: string; count: number }> {
  const tokens = normalizeFactText(source)
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
  const counts = new Map<string, number>();
  tokens.forEach((token) => {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  });

  const matches: Array<{ group: string; term: string; count: number }> = [];
  for (const [group, terms] of Object.entries(domainGroups)) {
    for (const term of terms) {
      const count = counts.get(term);
      if (count) {
        matches.push({ group, term, count });
      }
    }
  }
  return matches;
}

function extractImplicitPreferenceFacts(
  source: string,
  domainGroups: DomainGroups,
): ExtractedFact[] {
  const patterns = [
    /\b(?:we|the team|the project|the system)\s+(?:went with|ended up using|settled on)\s+([^.?!;]+)/gi,
    /\b([a-z0-9_-]+)\s+is better than\s+([a-z0-9_-]+)(?:\s+for\s+([^.?!;]+))?/gi,
  ];
  const facts: ExtractedFact[] = [];

  for (const match of source.matchAll(patterns[0])) {
    const value = normalizeFactValue(match[1]);
    if (!value) continue;
    facts.push({
      fact: `The system prefers ${value}`,
      factType: 'preference',
      confidence: 'medium',
      sourceText: match[0],
      domainGroups,
    });
  }

  for (const match of source.matchAll(patterns[1])) {
    const preferred = normalizeFactValue(match[1]);
    const compared = normalizeFactValue(match[2]);
    if (!preferred || !compared) continue;
    const context = match[3] ? ` for ${normalizeFactValue(match[3])}` : '';
    facts.push({
      fact: `The system prefers ${preferred} over ${compared}${context}`,
      factType: 'preference',
      confidence: 'medium',
      sourceText: match[0],
      domainGroups,
    });
  }

  return facts;
}

function extractDomainFrequencyFacts(
  source: string,
  domainGroups: DomainGroups,
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const match of countDomainMatches(source, domainGroups)) {
    if (match.count < 3) continue;
    const key = `${match.group}:${match.term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      fact: `The system uses ${match.term}`,
      factType: 'entity',
      confidence: 'medium',
      sourceText: match.term,
      domainGroups,
    });
  }
  return facts;
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

function createBaseRegexExtractor(mergedDomainGroups: DomainGroups): Extractor {
  return async (summary, keyEntities, topicTags) => {
    const combined = [summary, ...topicTags].join(' ').replace(/\n+/g, ' ');
    const facts: ExtractedFact[] = [
      ...extractMatches(
        combined,
        /\b(?:the user )?(?:prefers?|likes?|wants?|uses?|avoids?|doesn't like|does not like)\s+[^.?!;]+/gi,
        'preference',
        'medium',
      ),
      ...extractMatches(
        combined,
        /\b(?:the user |we )?(?:decided|chose|selected|switched from [^.?!;]+ to|after trying)\s+[^.?!;]+/gi,
        'decision',
        'high',
      ),
      ...extractMatches(
        combined,
        /\b(?:the user |the system |the project |we )?(?:must not|should not|cannot|can't|must|requires?|avoid|never|failed when|broke with|didn't work)\s+[^.?!;]+/gi,
        'constraint',
        'high',
      ),
      ...extractMatches(
        combined,
        /\b(?:the (?:system|project) )?(?:is|are|using|running|built with|set [^.?!;]+ to|configured [^.?!;]+ as)\s+[^.?!;]+/gi,
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
        domainGroups: mergedDomainGroups,
      })),
    ];

    return uniqFacts(facts).map((fact) => ({
      ...fact,
      domainGroups: fact.domainGroups ?? mergedDomainGroups,
    }));
  };
}

export function createEnhancedRegexExtractor(options?: { domainGroups?: DomainGroups }): Extractor {
  const mergedDomainGroups = mergeDomainGroups(options?.domainGroups);
  const baseExtractor = createBaseRegexExtractor(mergedDomainGroups);
  return async (summary, keyEntities, topicTags) => {
    const baseFacts = await baseExtractor(summary, keyEntities, topicTags);
    const combined = [summary, ...topicTags].join(' ').replace(/\n+/g, ' ');
    const enhancedFacts = [
      ...extractImplicitPreferenceFacts(combined, mergedDomainGroups),
      ...extractDomainFrequencyFacts(combined, mergedDomainGroups),
    ];

    return uniqFacts([...baseFacts, ...enhancedFacts]).map((fact) => ({
      ...fact,
      domainGroups: fact.domainGroups ?? mergedDomainGroups,
    }));
  };
}

export function createRegexExtractor(options?: {
  domainGroups?: DomainGroups;
  legacy?: boolean;
}): Extractor {
  const mergedDomainGroups = mergeDomainGroups(options?.domainGroups);
  return options?.legacy
    ? createBaseRegexExtractor(mergedDomainGroups)
    : createEnhancedRegexExtractor({ domainGroups: mergedDomainGroups });
}
