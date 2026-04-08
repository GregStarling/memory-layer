import type { NormalizedMemoryScope } from './identity.js';
import type {
  FactType,
  KnowledgeClass,
  KnowledgeState,
  FactConfidence,
  GroundingStrength,
  EvidenceSourceType,
} from './types.js';
import type { AliasCandidate } from './aliases.js';

/**
 * Options for the knowledge-reflection engine.
 */
export interface ReflectOnKnowledgeOptions {
  /** Scope to reflect over. */
  scope?: NormalizedMemoryScope;
  /** Maximum number of new facts to produce. */
  maxFacts?: number;
  /** Whether to include playbook-derived patterns. */
  includePlaybooks?: boolean;
  /** Key used for rate-limiting reflection calls. */
  rateLimitKey?: string;
  /** Existing alias map; known pairs are excluded from alias discovery. */
  existingAliases?: import('./aliases.js').AliasMap;
}

/**
 * A new fact produced by the reflection engine.
 * Always carries evidence source 'reflection' and provisional trust.
 */
export interface ReflectionFact {
  fact: string;
  factType: FactType;
  knowledgeClass: KnowledgeClass;
  knowledgeState: Extract<KnowledgeState, 'provisional'>;
  confidence: FactConfidence;
  confidenceScore: number;
  groundingStrength: GroundingStrength;
  /** Evidence source is always 'reflection' for reflection-produced facts. */
  evidenceSource: Extract<EvidenceSourceType, 'reflection'>;
  /** IDs of source memories that informed this fact. */
  sourceMemoryIds: number[];
}

/**
 * A pattern detected during knowledge reflection.
 */
export interface ReflectionPattern {
  name: string;
  description: string;
  occurrences: number;
  relatedFactIndices: number[];
}

/**
 * Result returned by the knowledge-reflection engine.
 */
export interface KnowledgeReflectionResult {
  /** Newly inferred facts, each tagged with source='reflection'. */
  newFacts: ReflectionFact[];
  /** Patterns found across the analysed knowledge base. */
  patternsFound: ReflectionPattern[];
  /** Number of sessions analysed during reflection. */
  sessionsAnalyzed: number;
  /** IDs of source memories that contributed to this reflection. */
  sourceMemoryIds: number[];
  /** High-similarity entity pairs discovered as potential alias merge candidates. */
  aliasCandidates?: AliasCandidate[];
}
