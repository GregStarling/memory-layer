import type { MemoryScope } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type {
  CognitiveMemoryItem,
  CognitiveMemoryType,
  CognitiveSearchHit,
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

function knowledgeToCognitiveItem(km: KnowledgeMemory): CognitiveMemoryItem {
  return {
    id: km.id,
    type: mapKnowledgeClassToCognitive(km.knowledge_class),
    fact: km.fact,
    createdAt: km.created_at,
    lastAccessedAt: km.last_accessed_at,
    metadata: {
      trustScore: km.trust_score,
      knowledgeClass: km.knowledge_class,
      knowledgeState: km.knowledge_state,
    },
  };
}

function workingMemoryToCognitiveItem(wm: WorkingMemory): CognitiveMemoryItem {
  return {
    id: wm.id,
    type: 'working',
    fact: wm.summary,
    createdAt: wm.created_at,
    lastAccessedAt: wm.created_at,
    metadata: {
      trustScore: 1,
      knowledgeClass: 'project_fact',
    },
  };
}

function groupByType(results: CognitiveSearchHit[]): Record<CognitiveMemoryType, CognitiveSearchHit[]> {
  const grouped: Record<CognitiveMemoryType, CognitiveSearchHit[]> = {
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

function computeWorkingMemoryRank(wm: WorkingMemory, query: string): number {
  const queryLower = query.toLowerCase();
  let score = 0;
  const summaryLower = wm.summary.toLowerCase();
  if (summaryLower.includes(queryLower)) score += 1.0;
  const tagMatches = wm.topic_tags.filter((t) => t.toLowerCase().includes(queryLower)).length;
  score += tagMatches * 0.3;
  const entityMatches = wm.key_entities.filter((e) => e.toLowerCase().includes(queryLower)).length;
  score += entityMatches * 0.3;
  return score;
}

export async function searchCognitive(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  options: CognitiveSearchOptions,
): Promise<CognitiveSearchResult> {
  const limit = options.limit ?? 20;
  const activeOnly = options.activeOnly ?? true;
  const requestedTypes = options.types ?? (['episodic', 'semantic', 'procedural', 'working'] as CognitiveMemoryType[]);

  const all: CognitiveSearchHit[] = [];

  // Semantic and procedural: search knowledge memory
  const knowledgeTypes = requestedTypes.filter((t) => t === 'semantic' || t === 'procedural');
  if (knowledgeTypes.length > 0) {
    const knowledgeClasses = knowledgeTypes.flatMap(mapCognitiveToKnowledgeClasses);
    const searchOpts: SearchOptions = {
      limit,
      activeOnly,
      minimumTrustScore: options.minimumTrustScore,
      knowledgeClasses: knowledgeClasses.length > 0 ? knowledgeClasses : undefined,
    };

    const hits: SearchResult<KnowledgeMemory>[] = await adapter.searchKnowledge(scope, options.query, searchOpts);
    for (const hit of hits) {
      all.push({
        item: knowledgeToCognitiveItem(hit.item),
        rank: hit.rank ?? 0,
      });
    }
  }

  // Working: search working memory with computed relevance scores
  if (requestedTypes.includes('working')) {
    const wmList = activeOnly
      ? await adapter.getActiveWorkingMemory(scope)
      : await adapter.getWorkingMemoryByTimeRange(scope, { start_at: 0, end_at: Math.floor(Date.now() / 1000) });
    for (const wm of wmList) {
      const score = computeWorkingMemoryRank(wm, options.query);
      if (score > 0) {
        all.push({
          item: workingMemoryToCognitiveItem(wm),
          rank: score,
        });
      }
    }
  }

  // Episodic: search turns and map to cognitive items
  if (requestedTypes.includes('episodic')) {
    const turnHits = await adapter.searchTurns(scope, options.query, { limit, activeOnly });
    for (const hit of turnHits) {
      const turn = hit.item;
      all.push({
        item: {
          id: turn.id,
          type: 'episodic',
          fact: turn.content,
          createdAt: turn.created_at,
          lastAccessedAt: turn.created_at,
          metadata: {
            trustScore: 1,
            knowledgeClass: 'episodic_fact',
          },
        },
        rank: hit.rank ?? 0,
      });
    }
  }

  // Sort descending by rank (higher = more relevant), then trim to limit
  all.sort((a, b) => b.rank - a.rank);
  const trimmed = all.slice(0, limit);

  return {
    byType: groupByType(trimmed),
    all: trimmed,
  };
}
