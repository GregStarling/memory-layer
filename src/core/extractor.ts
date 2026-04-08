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
  valid_from?: number | null;
  valid_until?: number | null;
  rationale?: string | null;
}

export interface NormalizedExtractedFact extends ExtractedFact {
  subject: string | null;
  attribute: string | null;
  value: string | null;
  normalizedFact: string;
  slotKey: string | null;
  isNegated: boolean;
  valid_from: number | null;
  valid_until: number | null;
  rationale: string | null;
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

// --- Temporal extraction helpers ---

const MONTH_NAMES: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseMonthName(name: string): number | null {
  return MONTH_NAMES[name.toLowerCase()] ?? null;
}

function epochSeconds(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month, day) / 1000);
}

function quarterStart(year: number, quarter: number): number {
  return epochSeconds(year, (quarter - 1) * 3, 1);
}

function quarterEnd(year: number, quarter: number): number {
  const nextMonth = quarter * 3;
  return epochSeconds(year, nextMonth, 1) - 1;
}

function monthEnd(year: number, month: number): number {
  return epochSeconds(year, month + 1, 1) - 1;
}

interface TemporalWindow {
  valid_from: number | null;
  valid_until: number | null;
}

// Full date: "March 1, 2025", "March 1st, 2025", "1 March 2025", "2025-03-01"
const FULL_DATE_MDY = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i;
const FULL_DATE_DMY = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec),?\s+(\d{4})\b/i;
const FULL_DATE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;

// Quarter + year: "Q3 2025", "Q1 2026"
const QUARTER_YEAR = /\bQ([1-4])\s+(\d{4})\b/i;

// Month + year: "March 2025", "Jan 2026"
const MONTH_YEAR = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})\b/i;

// Temporal markers that indicate start or end
const START_MARKERS = /\b(?:starting|as\s+of|effective|beginning|from)\s+/i;
const END_MARKERS = /\b(?:until|through|by|before|ending)\s+/i;

function tryParseFullDate(text: string): number | null {
  let m = text.match(FULL_DATE_MDY);
  if (m) {
    const month = parseMonthName(m[1]);
    if (month == null) return null;
    return epochSeconds(parseInt(m[3], 10), month, parseInt(m[2], 10));
  }
  m = text.match(FULL_DATE_DMY);
  if (m) {
    const month = parseMonthName(m[2]);
    if (month == null) return null;
    return epochSeconds(parseInt(m[3], 10), month, parseInt(m[1], 10));
  }
  m = text.match(FULL_DATE_ISO);
  if (m) {
    return epochSeconds(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }
  return null;
}

function tryParseQuarter(text: string): { start: number; end: number } | null {
  const m = text.match(QUARTER_YEAR);
  if (!m) return null;
  const quarter = parseInt(m[1], 10);
  const year = parseInt(m[2], 10);
  return { start: quarterStart(year, quarter), end: quarterEnd(year, quarter) };
}

function tryParseMonthYear(text: string): { start: number; end: number } | null {
  const m = text.match(MONTH_YEAR);
  if (!m) return null;
  const month = parseMonthName(m[1]);
  if (month == null) return null;
  const year = parseInt(m[2], 10);
  return { start: epochSeconds(year, month, 1), end: monthEnd(year, month) };
}

/**
 * Extract unambiguous temporal validity windows from source text.
 * Conservative: only populates when text contains absolute, resolvable dates.
 * Ambiguous references (relative dates like "Monday", "next week", open-ended
 * phrases like "until the migration completes") are left as null.
 */
export function extractTemporalWindow(text: string): TemporalWindow {
  const result: TemporalWindow = { valid_from: null, valid_until: null };
  if (!text) return result;

  // Check for start-marker + date
  const startMarkerMatch = text.match(START_MARKERS);
  if (startMarkerMatch) {
    const afterMarker = text.slice(startMarkerMatch.index! + startMarkerMatch[0].length);
    const date = tryParseFullDate(afterMarker);
    if (date != null) {
      result.valid_from = date;
    } else {
      const q = tryParseQuarter(afterMarker);
      if (q) {
        result.valid_from = q.start;
      } else {
        const my = tryParseMonthYear(afterMarker);
        if (my) {
          result.valid_from = my.start;
        }
      }
    }
  }

  // Check for end-marker + date
  const endMarkerMatch = text.match(END_MARKERS);
  if (endMarkerMatch) {
    const afterMarker = text.slice(endMarkerMatch.index! + endMarkerMatch[0].length);
    const date = tryParseFullDate(afterMarker);
    if (date != null) {
      // Advance to end of the named day (start of next day) so the full day is included
      result.valid_until = date + 86400;
    } else {
      const q = tryParseQuarter(afterMarker);
      if (q) {
        result.valid_until = q.end;
      } else {
        const my = tryParseMonthYear(afterMarker);
        if (my) {
          result.valid_until = my.end;
        }
      }
    }
  }

  // If no markers matched, try standalone absolute dates as valid_from
  if (result.valid_from == null && result.valid_until == null) {
    // Only if the text has an "effective" style context (standalone date next to fact)
    // Try quarter ranges: "as of Q3 2025" was already caught above,
    // but "Q3 2025" alone without marker → treat as valid_from..valid_until range
    const q = tryParseQuarter(text);
    if (q) {
      result.valid_from = q.start;
      result.valid_until = q.end;
      return result;
    }
  }

  return result;
}

// --- Rationale extraction helpers ---

/**
 * Causal language patterns that indicate reasoning.
 * Conservative: only matches clear, unambiguous causal language.
 */
const CAUSAL_PATTERNS: RegExp[] = [
  /\bbecause\s+(.+?)(?:\.|$)/i,
  /\bin order to\s+(.+?)(?:\.|$)/i,
  /\bthe reason (?:is|was|being)\s+(.+?)(?:\.|$)/i,
  /\bthis ensures?\s+(.+?)(?:\.|$)/i,
  /\bso that\s+(.+?)(?:\.|$)/i,
  /\bto (?:ensure|prevent|avoid|guarantee|maintain)\s+(.+?)(?:\.|$)/i,
  // Note: 'since' deliberately excluded — too often temporal rather than causal
  /\bdue to\s+(.+?)(?:\.|$)/i,
];

/**
 * Extract rationale from source text by detecting causal language patterns.
 * Conservative: only populates when text clearly explains reasoning.
 * Returns the first matched rationale clause, or null if none found.
 */
export function extractRationale(text: string): string | null {
  if (!text) return null;

  for (const pattern of CAUSAL_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const rationale = match[1].trim();
      // Skip very short or very long matches (likely noise)
      if (rationale.length < 10 || rationale.length > 500) continue;
      // Require at least 4 words to filter out vague fragments like "of this" or "that issue"
      const wordCount = rationale.split(/\s+/).filter((w) => w.length > 0).length;
      if (wordCount < 4) continue;
      return rationale;
    }
  }

  return null;
}

export function normalizeExtractedFact(fact: ExtractedFact): NormalizedExtractedFact {
  const normalizedFact = normalizeFactText(fact.fact);
  const structured = inferStructuredFields(
    fact.factType,
    fact.fact,
    mergeDomainGroups(fact.domainGroups),
  );
  const temporal = extractTemporalWindow(fact.sourceText ?? fact.fact);
  return {
    ...fact,
    sourceText: fact.sourceText ?? fact.fact,
    subject: structured.subject,
    attribute: structured.attribute,
    value: structured.value,
    normalizedFact,
    slotKey: structured.slotKey,
    isNegated: structured.isNegated,
    valid_from: fact.valid_from ?? temporal.valid_from,
    valid_until: fact.valid_until ?? temporal.valid_until,
    rationale: fact.rationale ?? extractRationale(fact.sourceText ?? fact.fact),
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
    valid_from: memory.valid_from ?? fallback.valid_from,
    valid_until: memory.valid_until ?? fallback.valid_until,
    rationale: memory.rationale ?? fallback.rationale,
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

function extractHeuristicFacts(source: string, domainGroups: DomainGroups): ExtractedFact[] {
  const patterns: Array<{
    pattern: RegExp;
    build: (match: RegExpMatchArray) => ExtractedFact | null;
  }> = [
    {
      pattern:
        /\b(?:the system|the project|the workspace|we)\s+(?:relies on|depends on|is backed by|is powered by|integrates with)\s+([^.?!;]+)/gi,
      build: (match) => {
        const value = normalizeFactValue(match[1]);
        if (!value) return null;
        return {
          fact: `The system uses ${value}`,
          factType: 'reference',
          confidence: 'high',
          sourceText: match[0],
          domainGroups,
        };
      },
    },
    {
      pattern:
        /\b(?:we|the team|the project)\s+(?:migrated from|moved from|replaced)\s+([a-z0-9_.-]+)\s+(?:to|with)\s+([a-z0-9_.-]+)\b/gi,
      build: (match) => {
        const fromValue = normalizeFactValue(match[1]);
        const toValue = normalizeFactValue(match[2]);
        if (!fromValue || !toValue) return null;
        return {
          fact: `The system prefers ${toValue} over ${fromValue}`,
          factType: 'decision',
          confidence: 'high',
          sourceText: match[0],
          domainGroups,
        };
      },
    },
    {
      pattern:
        /\b(?:keep|stay|remain)\s+([a-z0-9_-]+(?:\s+[a-z0-9_-]+){0,3})\b/gi,
      build: (match) => {
        const value = normalizeFactValue(match[1]);
        if (!value || value.length < 4) return null;
        return {
          fact: `The system must remain ${value}`,
          factType: 'constraint',
          confidence: 'medium',
          sourceText: match[0],
          domainGroups,
        };
      },
    },
    {
      pattern:
        /\b([a-z0-9_.-]+)\s+(?:gives us|gives the system|delivers|provides)\s+(?:better|faster|safer|more reliable)\s+([^.?!;]+)/gi,
      build: (match) => {
        const value = normalizeFactValue(match[1]);
        const context = normalizeFactValue(match[2]);
        if (!value) return null;
        return {
          fact: `The system prefers ${value}${context ? ` for ${context}` : ''}`,
          factType: 'preference',
          confidence: 'medium',
          sourceText: match[0],
          domainGroups,
        };
      },
    },
  ];

  const facts: ExtractedFact[] = [];
  for (const { pattern, build } of patterns) {
    for (const match of source.matchAll(pattern)) {
      const fact = build(match);
      if (fact) {
        facts.push(fact);
      }
    }
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
      ...extractHeuristicFacts(combined, mergedDomainGroups),
      ...extractImplicitPreferenceFacts(combined, mergedDomainGroups),
      ...extractDomainFrequencyFacts(combined, mergedDomainGroups),
    ];

    return uniqFacts([...baseFacts, ...enhancedFacts]).map((fact) => ({
      ...fact,
      domainGroups: fact.domainGroups ?? mergedDomainGroups,
    }));
  };
}

export function createHeuristicExtractor(options?: { domainGroups?: DomainGroups }): Extractor {
  const mergedDomainGroups = mergeDomainGroups(options?.domainGroups);
  return async (summary, keyEntities, topicTags) => {
    const combined = [summary, ...topicTags, ...keyEntities].join(' ').replace(/\n+/g, ' ');
    return uniqFacts([
      ...extractHeuristicFacts(combined, mergedDomainGroups),
      ...extractImplicitPreferenceFacts(combined, mergedDomainGroups),
      ...extractDomainFrequencyFacts(combined, mergedDomainGroups),
    ]).map((fact) => ({
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
