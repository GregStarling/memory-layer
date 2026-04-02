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
