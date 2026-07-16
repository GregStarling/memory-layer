import type { KnowledgeClass } from './types.js';

/**
 * External cognitive memory taxonomy.
 * Maps the richer internal KnowledgeClass model to a simpler public-facing
 * four-type cognitive taxonomy (episodic, semantic, procedural, working).
 */

export type CognitiveMemoryType = 'episodic' | 'semantic' | 'procedural' | 'working';

export interface CognitiveMemoryItem {
  id: number;
  type: CognitiveMemoryType;
  fact: string;
  createdAt: number;
  lastAccessedAt: number;
  metadata: {
    trustScore: number;
    knowledgeClass: KnowledgeClass;
    knowledgeState?: string;
  };
}

export interface CognitiveSearchOptions {
  query: string;
  types?: CognitiveMemoryType[];
  limit?: number;
  minimumTrustScore?: number;
  activeOnly?: boolean;
}

export interface CognitiveSearchHit {
  item: CognitiveMemoryItem;
  rank: number;
}

export interface CognitiveSearchResult {
  byType: Record<CognitiveMemoryType, CognitiveSearchHit[]>;
  all: CognitiveSearchHit[];
}

// -- Mapping functions --

const knowledgeClassToCognitive: Record<KnowledgeClass, CognitiveMemoryType> = {
  identity: 'semantic',
  preference: 'semantic',
  constraint: 'semantic',
  project_fact: 'semantic',
  episodic_fact: 'semantic',
  strategy: 'semantic',
  anti_pattern: 'semantic',
  procedure: 'procedural',
};

/**
 * Reverse view: which knowledge classes back each cognitive type.
 *
 * Only `semantic` and `procedural` are backed by the canonical
 * {@link KnowledgeClass} model, so only those two carry class lists.
 * `episodic` and `working` are deliberately empty — they are NOT sourced
 * from knowledge classes at all:
 *   - `episodic` is backed by raw conversational turns (see
 *     `searchCognitive` in `core/cognitive.ts`, which queries `searchTurns`).
 *   - `working` is backed by working-memory summaries (`getActiveWorkingMemory`).
 * The empty arrays are load-bearing, not dead: `mapCognitiveToKnowledgeClasses`
 * is total over `CognitiveMemoryType` and must return `[]` for these two to
 * signal "no knowledge class maps here; resolve from the non-knowledge source."
 * Note the intentional asymmetry with `knowledgeClassToCognitive`, where the
 * `episodic_fact` knowledge class maps to `semantic` (it is a durable fact
 * about an episode, distinct from the raw-turn `episodic` cognitive view).
 */
const cognitiveToKnowledgeClasses: Record<CognitiveMemoryType, KnowledgeClass[]> = {
  episodic: [],
  semantic: ['identity', 'preference', 'constraint', 'project_fact', 'episodic_fact', 'strategy', 'anti_pattern'],
  procedural: ['procedure'],
  working: [],
};

export function mapKnowledgeClassToCognitive(knowledgeClass: KnowledgeClass): CognitiveMemoryType {
  return knowledgeClassToCognitive[knowledgeClass];
}

export function mapCognitiveToKnowledgeClasses(type: CognitiveMemoryType): KnowledgeClass[] {
  return cognitiveToKnowledgeClasses[type];
}
