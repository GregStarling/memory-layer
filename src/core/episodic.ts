import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type {
  EpisodeDetailLevel,
  EpisodeRecap,
  EpisodeSearchOptions,
  EpisodeSourceReference,
  EpisodeSummary,
  ReflectOptions,
  ReflectResult,
  SearchResult,
  Turn,
  WorkingMemory,
} from '../contracts/types.js';
import type { StructuredGenerationClient } from '../summarizers/client.js';
import {
  EPISODIC_RECAP_SYSTEM_PROMPT,
  REFLECT_SYNTHESIS_SYSTEM_PROMPT,
  formatTurnsForSummarization,
} from '../summarizers/prompts.js';

export interface EpisodicDeps {
  adapter: StorageAdapter;
  scope: MemoryScope;
  client: StructuredGenerationClient;
}

interface SessionGroup {
  sessionId: string;
  turns: Turn[];
  workingMemories: WorkingMemory[];
}

function groupBySession(
  turns: SearchResult<Turn>[],
  workingMemories: WorkingMemory[],
): SessionGroup[] {
  const sessionMap = new Map<string, SessionGroup>();

  for (const { item } of turns) {
    let group = sessionMap.get(item.session_id);
    if (!group) {
      group = { sessionId: item.session_id, turns: [], workingMemories: [] };
      sessionMap.set(item.session_id, group);
    }
    group.turns.push(item);
  }

  for (const wm of workingMemories) {
    let group = sessionMap.get(wm.session_id);
    if (!group) {
      group = { sessionId: wm.session_id, turns: [], workingMemories: [] };
      sessionMap.set(wm.session_id, group);
    }
    group.workingMemories.push(wm);
  }

  return Array.from(sessionMap.values());
}

function buildSourceRefs(
  turns: Turn[],
  workingMemories: WorkingMemory[],
): EpisodeSourceReference[] {
  const sources: EpisodeSourceReference[] = [];
  for (const t of turns) {
    sources.push({
      type: 'turn',
      id: t.id,
      excerpt: t.content.length > 200 ? t.content.slice(0, 200) : t.content,
    });
  }
  for (const wm of workingMemories) {
    sources.push({
      type: 'working_memory',
      id: wm.id,
      excerpt: wm.summary.length > 200 ? wm.summary.slice(0, 200) : wm.summary,
    });
  }
  return sources;
}

function buildDetailPrompt(detailLevel: EpisodeDetailLevel): string {
  switch (detailLevel) {
    case 'abstract':
      return 'Detail level: abstract. Return only objective and outcomes. Leave actions, artifacts, and unresolvedItems as empty arrays.';
    case 'overview':
      return 'Detail level: overview. Return objective, actions, and outcomes. Leave artifacts as empty array. Include unresolvedItems if any.';
    case 'full':
      return 'Detail level: full. Return all fields fully populated including artifacts and excerpts.';
  }
}

function extractJsonPayload(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1);
  }
  throw new Error('Episodic recall: response did not contain JSON');
}

function parseRecap(text: string, sources: EpisodeSourceReference[]): EpisodeRecap {
  const raw = JSON.parse(extractJsonPayload(text));
  return {
    objective: String(raw.objective ?? ''),
    actions: Array.isArray(raw.actions) ? raw.actions.map(String) : [],
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.map(String) : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(String) : [],
    unresolvedItems: Array.isArray(raw.unresolvedItems) ? raw.unresolvedItems.map(String) : [],
    sourceType: raw.sourceType === 'declarative' ? 'declarative' : raw.sourceType === 'mixed' ? 'mixed' : 'episodic',
    sources: Array.isArray(raw.sources)
      ? raw.sources.map((s: any) => ({
          type: s.type === 'working_memory' ? 'working_memory' : s.type === 'knowledge' ? 'knowledge' : 'turn',
          id: Number(s.id),
          excerpt: s.excerpt != null ? String(s.excerpt) : null,
        }))
      : sources,
  };
}

export async function searchEpisodes(
  deps: EpisodicDeps,
  options: EpisodeSearchOptions,
): Promise<EpisodeSummary[]> {
  const { adapter, scope, client } = deps;
  const detailLevel = options.detailLevel ?? 'overview';
  const limit = options.limit ?? 10;

  const turnHits = adapter.searchTurns(scope, options.query, { limit: limit * 5 });

  // Scope working memory to sessions found in turn hits to avoid leaking unrelated sessions
  const hitSessionIds = new Set(turnHits.map((h) => h.item.session_id));
  const wmList = options.timeRange
    ? adapter.getWorkingMemoryByTimeRange(scope, options.timeRange)
        .filter((wm) => hitSessionIds.has(wm.session_id))
    : Array.from(hitSessionIds).flatMap(
        (sid) => adapter.getActiveWorkingMemory(scope, sid),
      );

  const groups = groupBySession(turnHits, wmList);
  const summaries: EpisodeSummary[] = [];

  for (const group of groups.slice(0, limit)) {
    const summary = await summarizeEpisode(deps, {
      turns: group.turns,
      workingMemories: group.workingMemories,
      sessionId: group.sessionId,
      detailLevel,
      client,
    });
    summaries.push(summary);
  }

  return summaries;
}

interface SummarizeEpisodeInput {
  turns: Turn[];
  workingMemories: WorkingMemory[];
  sessionId: string;
  detailLevel: EpisodeDetailLevel;
  client: StructuredGenerationClient;
}

export async function summarizeEpisode(
  deps: EpisodicDeps,
  input: SummarizeEpisodeInput,
): Promise<EpisodeSummary> {
  const { turns, workingMemories, sessionId, detailLevel, client } = input;
  const sources = buildSourceRefs(turns, workingMemories);

  const wmContext = workingMemories.length > 0
    ? '\n\nWorking memory summaries:\n' + workingMemories.map((wm) => `[wm:${wm.id}] ${wm.summary}`).join('\n')
    : '';

  const userPrompt = [
    buildDetailPrompt(detailLevel),
    '',
    'Conversation turns:',
    formatTurnsForSummarization(turns),
    wmContext,
    '',
    `Available source IDs: ${JSON.stringify(sources.map((s) => ({ type: s.type, id: s.id })))}`,
  ].join('\n');

  const responseText = await client.generate({
    systemPrompt: EPISODIC_RECAP_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 2048,
    expectedFormat: 'object',
  });

  const recap = parseRecap(responseText, sources);

  const turnIds = turns.map((t) => t.id);
  const start = turnIds.length > 0 ? Math.min(...turnIds) : 0;
  const end = turnIds.length > 0 ? Math.max(...turnIds) : 0;

  return {
    sessionId,
    recap,
    detailLevel,
    turnRange: { start, end },
    createdAt: Math.floor(Date.now() / 1000),
  };
}

export async function reflect(
  deps: EpisodicDeps,
  options: ReflectOptions,
): Promise<ReflectResult> {
  const { adapter, scope, client } = deps;
  const detailLevel = options.detailLevel ?? 'overview';
  const limit = options.limit ?? 10;
  const includeEpisodic = options.includeEpisodic !== false;
  const includeDeclarative = options.includeDeclarative !== false;

  const allSources: EpisodeSourceReference[] = [];
  const contextParts: string[] = [];
  let hasEpisodic = false;
  let hasDeclarative = false;

  if (includeEpisodic) {
    const turnHits = adapter.searchTurns(scope, options.query, { limit: limit * 5 });

    // Scope working memory to sessions found in turn hits to avoid leaking unrelated sessions
    const hitSessionIds = new Set(turnHits.map((h) => h.item.session_id));
    const wmList = options.timeRange
      ? adapter.getWorkingMemoryByTimeRange(scope, options.timeRange)
          .filter((wm) => hitSessionIds.has(wm.session_id))
      : Array.from(hitSessionIds).flatMap(
          (sid) => adapter.getActiveWorkingMemory(scope, sid),
        );

    if (turnHits.length > 0 || wmList.length > 0) {
      hasEpisodic = true;
      const turns = turnHits.map((h) => h.item);
      allSources.push(...buildSourceRefs(turns, wmList));

      contextParts.push('Episodic memory (conversation turns):');
      contextParts.push(formatTurnsForSummarization(turns));

      if (wmList.length > 0) {
        contextParts.push('\nWorking memory summaries:');
        for (const wm of wmList) {
          contextParts.push(`[wm:${wm.id}] ${wm.summary}`);
        }
      }
    }
  }

  if (includeDeclarative) {
    const knowledgeHits = adapter.searchKnowledge(scope, options.query, { limit });
    if (knowledgeHits.length > 0) {
      hasDeclarative = true;
      contextParts.push('\nDeclarative memory (trusted knowledge):');
      for (const hit of knowledgeHits) {
        const k = hit.item;
        allSources.push({ type: 'knowledge', id: k.id, excerpt: k.fact });
        contextParts.push(`[knowledge:${k.id}] (${k.knowledge_state}, trust=${k.trust_score}) ${k.fact}`);
      }
    }
  }

  let sourceType: 'episodic' | 'declarative' | 'mixed';
  if (hasEpisodic && hasDeclarative) {
    sourceType = 'mixed';
  } else if (hasDeclarative) {
    sourceType = 'declarative';
  } else {
    sourceType = 'episodic';
  }

  // Gather episode summaries for context
  const episodes: EpisodeSummary[] = [];
  if (includeEpisodic) {
    const episodeSummaries = await searchEpisodes(deps, {
      query: options.query,
      detailLevel,
      limit: Math.min(limit, 5),
      timeRange: options.timeRange,
    });
    episodes.push(...episodeSummaries);
  }

  const userPrompt = [
    `Query: ${options.query}`,
    buildDetailPrompt(detailLevel),
    '',
    ...contextParts,
    '',
    `Available source IDs: ${JSON.stringify(allSources.map((s) => ({ type: s.type, id: s.id })))}`,
  ].join('\n');

  const responseText = await client.generate({
    systemPrompt: REFLECT_SYNTHESIS_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 2048,
    expectedFormat: 'object',
  });

  const raw = JSON.parse(extractJsonPayload(responseText));

  return {
    synthesis: String(raw.synthesis ?? ''),
    sourceType,
    sources: Array.isArray(raw.sources)
      ? raw.sources.map((s: any) => ({
          type: s.type === 'working_memory' ? 'working_memory' : s.type === 'knowledge' ? 'knowledge' : 'turn',
          id: Number(s.id),
          excerpt: s.excerpt != null ? String(s.excerpt) : null,
        }))
      : allSources,
    episodes,
    detailLevel,
  };
}
