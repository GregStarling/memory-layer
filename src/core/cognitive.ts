import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type {
  CognitiveMemoryItem,
  CognitiveMemoryType,
  CognitiveSearchOptions,
  CognitiveSearchResult,
} from '../contracts/cognitive.js';
import {
  mapKnowledgeClassToCognitive,
  mapCognitiveToKnowledgeClasses,
} from '../contracts/cognitive.js';
import type {
  KnowledgeMemory,
  SearchOptions,
  SearchResult,
  WorkingMemory,
} from '../contracts/types.js';

export interface CognitiveGrouped {
  byType: Record<CognitiveMemoryType, CognitiveSearchResult[]>;
  all: CognitiveSearchResult[];
}

function knowledgeToCognitiveItem(km: KnowledgeMemory): CognitiveMemoryItem {
  return {
    id: km.id,
    type: mapKnowledgeClassToCognitive(km.knowledge_class),
    fact: km.fact,
    trustScore: km.trust_score,
    knowledgeClass: km.knowledge_class,
    createdAt: km.created_at,
    lastAccessedAt: km.last_accessed_at,
  };
}

function workingMemoryToCognitiveItem(wm: WorkingMemory): CognitiveMemoryItem {
  return {
    id: wm.id,
    type: 'working',
    fact: wm.summary,
    trustScore: 1,
    knowledgeClass: 'project_fact',
    createdAt: wm.created_at,
    lastAccessedAt: wm.created_at,
  };
}

function groupByType(results: CognitiveSearchResult[]): Record<CognitiveMemoryType, CognitiveSearchResult[]> {
  const grouped: Record<CognitiveMemoryType, CognitiveSearchResult[]> = {
    episodic: [],
    semantic: [],
    procedural: [],
    working: [],
  };
  for (const r of results) {
    grouped[r.item.type].push(r);
  }
  return grouped;
}

export function searchCognitive(
  adapter: StorageAdapter,
  scope: MemoryScope,
  options: CognitiveSearchOptions,
): CognitiveGrouped {
  const limit = options.limit ?? 20;
  const requestedTypes = options.types ?? (['episodic', 'semantic', 'procedural', 'working'] as CognitiveMemoryType[]);

  const all: CognitiveSearchResult[] = [];
  let rank = 0;

  // Semantic and procedural: search knowledge memory
  const knowledgeTypes = requestedTypes.filter((t) => t === 'semantic' || t === 'procedural');
  if (knowledgeTypes.length > 0) {
    const knowledgeClasses = knowledgeTypes.flatMap(mapCognitiveToKnowledgeClasses);
    const searchOpts: SearchOptions = {
      limit,
      activeOnly: options.activeOnly ?? true,
      minimumTrustScore: options.minimumTrustScore,
      knowledgeClasses: knowledgeClasses.length > 0 ? knowledgeClasses : undefined,
    };

    const hits: SearchResult<KnowledgeMemory>[] = adapter.searchKnowledge(scope, options.query, searchOpts);
    for (const hit of hits) {
      all.push({
        item: knowledgeToCognitiveItem(hit.item),
        rank: hit.rank ?? rank++,
      });
    }
  }

  // Working: search active working memory
  if (requestedTypes.includes('working')) {
    const wmList = adapter.getActiveWorkingMemory(scope);
    for (const wm of wmList) {
      // Basic relevance filter: check if query terms appear in summary
      const queryLower = options.query.toLowerCase();
      if (wm.summary.toLowerCase().includes(queryLower) ||
          wm.topic_tags.some((t) => t.toLowerCase().includes(queryLower)) ||
          wm.key_entities.some((e) => e.toLowerCase().includes(queryLower))) {
        all.push({
          item: workingMemoryToCognitiveItem(wm),
          rank: rank++,
        });
      }
    }
  }

  // Episodic: search turns and map to cognitive items
  if (requestedTypes.includes('episodic')) {
    const turnHits = adapter.searchTurns(scope, options.query, { limit });
    for (const hit of turnHits) {
      const turn = hit.item;
      all.push({
        item: {
          id: turn.id,
          type: 'episodic',
          fact: turn.content,
          trustScore: 1,
          knowledgeClass: 'episodic_fact',
          createdAt: turn.created_at,
          lastAccessedAt: turn.created_at,
        },
        rank: hit.rank ?? rank++,
      });
    }
  }

  // Sort by rank, then trim to limit
  all.sort((a, b) => a.rank - b.rank);
  const trimmed = all.slice(0, limit);

  return {
    byType: groupByType(trimmed),
    all: trimmed,
  };
}
