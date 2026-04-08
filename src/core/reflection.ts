import type { MemoryScope } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { KnowledgeMemory, FactType, KnowledgeClass } from '../contracts/types.js';
import type {
  ReflectOnKnowledgeOptions,
  KnowledgeReflectionResult,
  ReflectionFact,
  ReflectionPattern,
} from '../contracts/reflection.js';
import {
  createEnhancedRegexExtractor,
  normalizeExtractedFact,
  type Extractor,
  type NormalizedExtractedFact,
} from './extractor.js';
import { discoverAliasCandidates, type DiscoverAliasCandidatesOptions } from './aliases.js';

/** Minimum interval (ms) between reflections for the same rate-limit key. */
const DEFAULT_RATE_LIMIT_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 1_024;

/** In-memory rate-limit tracker keyed by rateLimitKey. */
const rateLimitTimestamps = new Map<string, number>();

function pruneRateLimitTimestamps(now: number): void {
  for (const [key, timestamp] of rateLimitTimestamps) {
    if (now - timestamp >= DEFAULT_RATE_LIMIT_MS) {
      rateLimitTimestamps.delete(key);
    }
  }

  while (rateLimitTimestamps.size > MAX_RATE_LIMIT_ENTRIES) {
    const oldestKey = rateLimitTimestamps.keys().next().value;
    if (oldestKey == null) break;
    rateLimitTimestamps.delete(oldestKey);
  }
}

/**
 * Map extracted fact types to knowledge classes.
 * Mirrors orchestrator logic but allows reflection-specific overrides.
 */
function mapFactTypeToKnowledgeClass(factType: FactType): KnowledgeClass {
  if (factType === 'entity') return 'identity';
  if (factType === 'preference') return 'preference';
  if (factType === 'constraint') return 'constraint';
  if (factType === 'decision') return 'procedure';
  return 'project_fact';
}

/**
 * Detect recurring patterns across knowledge facts by clustering on
 * shared subjects and knowledge classes.
 */
function detectPatterns(
  knowledge: KnowledgeMemory[],
  newFacts: ReflectionFact[],
): ReflectionPattern[] {
  const subjectClusters = new Map<string, { count: number; factIndices: number[] }>();

  for (const km of knowledge) {
    const key = (km.fact_subject ?? 'unknown').toLowerCase();
    const entry = subjectClusters.get(key) ?? { count: 0, factIndices: [] };
    entry.count++;
    subjectClusters.set(key, entry);
  }

  // Link new facts to existing clusters
  for (let i = 0; i < newFacts.length; i++) {
    const factLower = newFacts[i].fact.toLowerCase();
    for (const [subject, entry] of subjectClusters) {
      if (subject !== 'unknown' && factLower.includes(subject)) {
        entry.factIndices.push(i);
      }
    }
  }

  const patterns: ReflectionPattern[] = [];
  for (const [subject, entry] of subjectClusters) {
    if (entry.count >= 3) {
      patterns.push({
        name: `recurring_${subject}`,
        description: `Subject "${subject}" appears in ${entry.count} knowledge facts`,
        occurrences: entry.count,
        relatedFactIndices: entry.factIndices,
      });
    }
  }

  return patterns;
}

/**
 * Deduplicate extracted facts against existing active knowledge.
 * Returns only facts whose normalized text does not already exist.
 */
function deduplicateAgainstExisting(
  extracted: NormalizedExtractedFact[],
  existing: KnowledgeMemory[],
): NormalizedExtractedFact[] {
  const existingNormalized = new Set(
    existing
      .map((km) => km.normalized_fact)
      .filter((n): n is string => n != null),
  );
  const existingSlotKeys = new Set(
    existing
      .map((km) => km.slot_key)
      .filter((s): s is string => s != null),
  );

  return extracted.filter((fact) => {
    if (existingNormalized.has(fact.normalizedFact)) return false;
    if (fact.slotKey && existingSlotKeys.has(fact.slotKey)) return false;
    return true;
  });
}

/**
 * Reflect on knowledge by reading recent working memory summaries, active
 * knowledge, and active playbooks. Runs the extractor over combined text
 * to find recurring themes, implicit constraints, emerging strategies,
 * and cross-session connections.
 *
 * Produces new knowledge tagged source='reflection' with provisional trust.
 * Clearly separated from the episodic reflect() API which synthesises
 * existing memories rather than inferring new facts.
 */
export async function reflectOnKnowledge(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  options: ReflectOnKnowledgeOptions = {},
  extractor?: Extractor,
): Promise<KnowledgeReflectionResult> {
  const now = Date.now();
  pruneRateLimitTimestamps(now);

  // Rate limiting
  if (options.rateLimitKey) {
    const lastRun = rateLimitTimestamps.get(options.rateLimitKey);
    if (lastRun && now - lastRun < DEFAULT_RATE_LIMIT_MS) {
      return {
        newFacts: [],
        patternsFound: [],
        sessionsAnalyzed: 0,
        sourceMemoryIds: [],
      };
    }
  }

  const maxFacts = options.maxFacts ?? 10;
  const includePlaybooks = options.includePlaybooks ?? true;
  const extract = extractor ?? createEnhancedRegexExtractor();
  // Use options.scope when provided, falling back to the positional scope parameter
  const effectiveScope = options.scope ?? scope;

  // Gather source material
  const [activeKnowledge, workingMemories, playbooks] = await Promise.all([
    adapter.getActiveKnowledgeMemory(effectiveScope),
    adapter.getActiveWorkingMemory(effectiveScope),
    includePlaybooks ? adapter.getActivePlaybooks(effectiveScope) : Promise.resolve([]),
  ]);

  const sourceMemoryIds = activeKnowledge.map((km) => km.id);

  // Build combined text for the extractor
  const summaryParts: string[] = [];
  const keyEntities: string[] = [];
  const topicTags: string[] = [];

  // Add working memory summaries (most recent first, limited to avoid overwhelming)
  const recentSummaries = workingMemories
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 20);

  for (const wm of recentSummaries) {
    summaryParts.push(wm.summary);
    keyEntities.push(...wm.key_entities);
    topicTags.push(...wm.topic_tags);
  }

  // Add active knowledge facts as context
  for (const km of activeKnowledge) {
    summaryParts.push(km.fact);
  }

  // Add playbook context
  if (includePlaybooks) {
    for (const pb of playbooks) {
      summaryParts.push(`${pb.title}: ${pb.description}`);
      topicTags.push(...pb.tags);
    }
  }

  if (summaryParts.length === 0) {
    return {
      newFacts: [],
      patternsFound: [],
      sessionsAnalyzed: recentSummaries.length,
      sourceMemoryIds,
    };
  }

  // Deduplicate entities and tags
  const uniqueEntities = [...new Set(keyEntities)];
  const uniqueTags = [...new Set(topicTags)];

  // Run extractor over combined text
  const combinedSummary = summaryParts.join('\n');
  const extracted = await extract(combinedSummary, uniqueEntities, uniqueTags);

  // Normalize and deduplicate against existing knowledge
  const normalized = extracted.map(normalizeExtractedFact);
  const novel = deduplicateAgainstExisting(normalized, activeKnowledge);

  // Convert to ReflectionFacts, capped at maxFacts
  const newFacts: ReflectionFact[] = novel.slice(0, maxFacts).map((fact) => ({
    fact: fact.fact,
    factType: fact.factType,
    knowledgeClass: mapFactTypeToKnowledgeClass(fact.factType),
    knowledgeState: 'provisional' as const,
    confidence: fact.confidence,
    confidenceScore: fact.confidence === 'high' ? 0.7 : fact.confidence === 'medium' ? 0.5 : 0.3,
    groundingStrength: 'weak' as const,
    evidenceSource: 'reflection' as const,
    sourceMemoryIds,
  }));

  // Detect patterns across existing knowledge
  const patternsFound = detectPatterns(activeKnowledge, newFacts);

  // Discover potential alias candidates from entity name similarity
  const aliasCandidates = discoverAliasCandidates(activeKnowledge, {
    existingAliases: options.existingAliases,
  });

  // Update rate limit timestamp
  if (options.rateLimitKey) {
    rateLimitTimestamps.delete(options.rateLimitKey);
    rateLimitTimestamps.set(options.rateLimitKey, now);
  }

  return {
    newFacts,
    patternsFound,
    sessionsAnalyzed: recentSummaries.length,
    sourceMemoryIds,
    aliasCandidates: aliasCandidates.length > 0 ? aliasCandidates : undefined,
  };
}

/**
 * Exposed for testing: reset the in-memory rate-limit tracker.
 */
export function resetRateLimits(): void {
  rateLimitTimestamps.clear();
}
