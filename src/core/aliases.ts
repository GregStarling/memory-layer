import type { AliasMap, AliasCandidate } from '../contracts/aliases.js';
import type { KnowledgeMemory } from '../contracts/types.js';
import type { NormalizedExtractedFact } from './extractor.js';
import { normalizeFactText } from './extractor.js';

export interface AliasResolution {
  original: string;
  canonical: string;
}

export interface AliasResolveResult {
  facts: NormalizedExtractedFact[];
  resolutions: AliasResolution[];
}

/**
 * Build a reverse lookup from alias variants to their canonical name.
 * All keys are lowercased for case-insensitive matching.
 */
export function buildReverseLookup(aliasMap: AliasMap): Map<string, string> {
  const reverse = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(aliasMap)) {
    reverse.set(canonical.toLowerCase(), canonical);
    for (const alias of aliases) {
      reverse.set(alias.toLowerCase(), canonical);
    }
  }
  return reverse;
}

/**
 * Resolve a single entity name against the alias map.
 * Returns the canonical name if found, otherwise the original.
 */
export function resolveEntityName(
  name: string,
  reverseLookup: Map<string, string>,
): string {
  return reverseLookup.get(name.toLowerCase()) ?? name;
}

/**
 * Replace alias occurrences in a fact string with their canonical names.
 * Returns the updated string and any resolutions that were applied.
 */
function resolveFactText(
  text: string,
  reverseLookup: Map<string, string>,
): { text: string; resolutions: AliasResolution[] } {
  const resolutions: AliasResolution[] = [];

  // Sort aliases by length (longest first) to avoid partial replacement
  const aliases = [...reverseLookup.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );

  let result = text;
  for (const [alias, canonical] of aliases) {
    // Skip identity mappings (canonical → canonical)
    if (alias === canonical.toLowerCase()) continue;
    // Use adaptive word boundaries: \b only when the alias edge is a word char
    const escaped = escapeRegExp(alias);
    const start = /^\w/.test(alias) ? '\\b' : '(?<![\\w])';
    const end = /\w$/.test(alias) ? '\\b' : '(?![\\w])';
    const pattern = new RegExp(`${start}${escaped}${end}`, 'gi');
    const before = result;
    result = result.replace(pattern, canonical);
    if (result !== before) {
      resolutions.push({ original: alias, canonical });
    }
  }

  return { text: result, resolutions };
}

/**
 * Apply alias resolution to extracted facts before deduplication.
 * Replaces alias variants with canonical names in fact text, subject, and value fields.
 */
export function resolveAliases(
  facts: NormalizedExtractedFact[],
  aliasMap: AliasMap | undefined,
): AliasResolveResult {
  if (!aliasMap || Object.keys(aliasMap).length === 0) {
    return { facts, resolutions: [] };
  }

  const reverseLookup = buildReverseLookup(aliasMap);
  const allResolutions: AliasResolution[] = [];

  const resolved = facts.map((fact) => {
    const factResult = resolveFactText(fact.fact, reverseLookup);
    const normalizedResult = resolveFactText(fact.normalizedFact, reverseLookup);

    const resolvedSubject = fact.subject
      ? resolveEntityName(fact.subject, reverseLookup)
      : fact.subject;
    const resolvedValue = fact.value
      ? resolveFactText(fact.value, reverseLookup)
      : null;

    allResolutions.push(
      ...factResult.resolutions,
      ...normalizedResult.resolutions,
      ...(resolvedValue?.resolutions ?? []),
    );

    // Re-normalize after alias replacement to maintain dedup consistency
    const resolvedNormalized = normalizeFactText(normalizedResult.text);

    // Preserve slotKey format by replacing alias tokens within existing key
    let resolvedSlotKey = fact.slotKey;
    if (fact.slotKey) {
      const slotResult = resolveFactText(fact.slotKey, reverseLookup);
      resolvedSlotKey = normalizeFactText(slotResult.text);
    }

    return {
      ...fact,
      fact: factResult.text,
      normalizedFact: resolvedNormalized,
      subject: resolvedSubject,
      value: resolvedValue?.text ?? fact.value,
      slotKey: resolvedSlotKey,
    };
  });

  // Deduplicate resolutions
  const seen = new Set<string>();
  const uniqueResolutions = allResolutions.filter((r) => {
    const key = `${r.original}:${r.canonical}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { facts: resolved, resolutions: uniqueResolutions };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Incremental alias discovery ---

/** Default similarity threshold: conservative to minimize false positives. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

/**
 * Compute normalized string similarity between two strings using
 * Levenshtein distance. Returns a value between 0.0 (no similarity)
 * and 1.0 (identical after normalization).
 */
export function normalizedStringSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1.0;
  if (na.length === 0 || nb.length === 0) return 0.0;

  const maxLen = Math.max(na.length, nb.length);
  const dist = levenshteinDistance(na, nb);
  return 1 - dist / maxLen;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use single-row optimization
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,     // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * Choose a canonical name from two entity strings.
 * Prefers the longer, more descriptive form. Ties break alphabetically.
 */
function chooseSuggestedCanonical(a: string, b: string): string {
  if (a.length !== b.length) return a.length > b.length ? a : b;
  return a.toLowerCase() < b.toLowerCase() ? a : b;
}

/**
 * Extract distinct entity names from knowledge facts.
 * Uses fact_subject, fact_value, and entity-type facts.
 */
function collectEntityNames(knowledge: KnowledgeMemory[]): string[] {
  const names = new Set<string>();
  for (const km of knowledge) {
    if (km.fact_type === 'entity' && km.fact_value) {
      names.add(km.fact_value);
    }
    if (km.knowledge_class === 'identity' && km.fact_value) {
      names.add(km.fact_value);
    }
    if (km.fact_subject && km.fact_subject !== 'user' && km.fact_subject !== 'system' && km.fact_subject !== 'entity') {
      names.add(km.fact_subject);
    }
  }
  return [...names];
}

export interface DiscoverAliasCandidatesOptions {
  /** Minimum similarity score to surface a pair (0.0–1.0). Default: 0.85 */
  threshold?: number;
  /** Maximum candidates to return. Default: 20 */
  maxCandidates?: number;
  /** Existing alias map to skip already-known pairs. */
  existingAliases?: AliasMap;
}

/**
 * Compare entity names across knowledge facts using normalized string
 * similarity. Returns high-similarity pairs as AliasCandidate suggestions
 * for operator confirmation. All candidates have `confirmed: false`.
 *
 * Conservative threshold (default 0.85) minimizes false positives.
 */
export function discoverAliasCandidates(
  knowledge: KnowledgeMemory[],
  options: DiscoverAliasCandidatesOptions = {},
): AliasCandidate[] {
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const maxCandidates = options.maxCandidates ?? 20;

  const entityNames = collectEntityNames(knowledge);
  if (entityNames.length < 2) return [];

  // Build set of already-known alias pairs for exclusion
  const knownPairs = new Set<string>();
  if (options.existingAliases) {
    const reverse = buildReverseLookup(options.existingAliases);
    for (const [alias, canonical] of reverse) {
      knownPairs.add(pairKey(alias, canonical.toLowerCase()));
    }
  }

  const candidates: AliasCandidate[] = [];

  for (let i = 0; i < entityNames.length; i++) {
    for (let j = i + 1; j < entityNames.length; j++) {
      const a = entityNames[i];
      const b = entityNames[j];

      // Skip identical (after normalization)
      if (a.toLowerCase() === b.toLowerCase()) continue;

      // Skip already-known alias pairs
      if (knownPairs.has(pairKey(a.toLowerCase(), b.toLowerCase()))) continue;

      const similarity = normalizedStringSimilarity(a, b);
      if (similarity >= threshold) {
        candidates.push({
          entity1: a,
          entity2: b,
          similarity,
          suggestedCanonical: chooseSuggestedCanonical(a, b),
          confirmed: false,
        });
      }
    }
  }

  // Sort by similarity descending, take top N
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, maxCandidates);
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}
