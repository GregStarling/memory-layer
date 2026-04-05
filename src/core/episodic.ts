import type { MemoryScope } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
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
import { emitMemoryEvent, type TelemetryOptions } from './telemetry.js';

export interface EpisodicDeps {
  adapter: AsyncStorageAdapter;
  scope: MemoryScope;
  client: StructuredGenerationClient;
  /**
   * Optional telemetry hook. When provided, episodic operations emit
   * observability events for rejected LLM source references so operators
   * can correlate model-side drift over time.
   */
  telemetry?: TelemetryOptions;
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

/**
 * Return true if a unix-seconds timestamp falls within the inclusive
 * [start_at, end_at] window. Missing bounds mean open-ended on that side.
 */
function inTimeRange(
  createdAt: number,
  range: { start_at?: number; end_at?: number } | undefined,
): boolean {
  if (!range) return true;
  if (range.start_at != null && createdAt < range.start_at) return false;
  if (range.end_at != null && createdAt > range.end_at) return false;
  return true;
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

interface SourceValidationResult {
  sources: EpisodeSourceReference[];
  /** Number of LLM-supplied refs dropped as unknown/hallucinated/malformed. */
  rejectedCount: number;
  /**
   * True when the LLM supplied an array but zero entries matched advertised
   * sources, so we fell back to server-derived sources. Signals stronger
   * drift than partial rejection.
   */
  fellBackToServerSources: boolean;
}

/**
 * Validate LLM-supplied source references against the set of sources
 * actually provided to the model. Returns only the matching entries;
 * unknown/hallucinated refs are dropped. If the validated set is empty,
 * returns the server-derived sources so callers always see a grounded list.
 */
function validateLlmSources(
  rawSources: unknown,
  advertised: EpisodeSourceReference[],
): SourceValidationResult {
  if (!Array.isArray(rawSources)) {
    return { sources: advertised, rejectedCount: 0, fellBackToServerSources: false };
  }

  const allowed = new Map<string, EpisodeSourceReference>();
  for (const s of advertised) {
    allowed.set(`${s.type}:${s.id}`, s);
  }

  const validated: EpisodeSourceReference[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;
  for (const candidate of rawSources) {
    if (!candidate || typeof candidate !== 'object') { rejectedCount++; continue; }
    const c = candidate as { type?: unknown; id?: unknown; excerpt?: unknown };
    const type =
      c.type === 'working_memory' ? 'working_memory' : c.type === 'knowledge' ? 'knowledge' : c.type === 'turn' ? 'turn' : null;
    if (!type) { rejectedCount++; continue; }
    if (typeof c.id !== 'number' || !Number.isInteger(c.id) || Number.isNaN(c.id)) { rejectedCount++; continue; }
    const key = `${type}:${c.id}`;
    if (!allowed.has(key)) { rejectedCount++; continue; }
    if (seen.has(key)) { rejectedCount++; continue; }
    seen.add(key);
    // Prefer the server-side excerpt (ground truth) over the model's.
    const grounded = allowed.get(key)!;
    validated.push({
      type: grounded.type,
      id: grounded.id,
      excerpt: grounded.excerpt,
    });
  }

  if (validated.length === 0) {
    return { sources: advertised, rejectedCount, fellBackToServerSources: true };
  }
  return { sources: validated, rejectedCount, fellBackToServerSources: false };
}

/**
 * Emit an observability signal when LLM source validation rejected any refs.
 * Operators can use this to correlate source hallucination rates across
 * models and alert on sudden regressions.
 */
function emitSourceValidationEvent(
  deps: EpisodicDeps,
  stage: 'recap' | 'reflect',
  result: SourceValidationResult,
  advertisedCount: number,
): void {
  if (result.rejectedCount === 0 && !result.fellBackToServerSources) return;
  emitMemoryEvent('manager', deps.scope, deps.telemetry, 0, {
    action: 'episodic_source_validation',
    stage,
    rejectedCount: result.rejectedCount,
    advertisedCount,
    fellBackToServerSources: result.fellBackToServerSources,
  });
}

function parseRecap(
  deps: EpisodicDeps,
  text: string,
  sources: EpisodeSourceReference[],
): EpisodeRecap {
  const raw = JSON.parse(extractJsonPayload(text));
  const validation = validateLlmSources(raw.sources, sources);
  emitSourceValidationEvent(deps, 'recap', validation, sources.length);
  return {
    objective: String(raw.objective ?? ''),
    actions: Array.isArray(raw.actions) ? raw.actions.map(String) : [],
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.map(String) : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(String) : [],
    unresolvedItems: Array.isArray(raw.unresolvedItems) ? raw.unresolvedItems.map(String) : [],
    sourceType: raw.sourceType === 'declarative' ? 'declarative' : raw.sourceType === 'mixed' ? 'mixed' : 'episodic',
    sources: validation.sources,
  };
}

export async function searchEpisodes(
  deps: EpisodicDeps,
  options: EpisodeSearchOptions,
): Promise<EpisodeSummary[]> {
  const { adapter, scope, client } = deps;
  const detailLevel = options.detailLevel ?? 'overview';
  const limit = options.limit ?? 10;

  // Search turns by query, then filter by the requested time window if any.
  // The underlying adapter FTS API has no time bound, so the filter is
  // applied post-query. The query is the primary relevance signal; the time
  // window only narrows the result set it applies to.
  const rawTurnHits = await adapter.searchTurns(scope, options.query, { limit: limit * 5 });
  const turnHits = options.timeRange
    ? rawTurnHits.filter((h) => inTimeRange(h.item.created_at, options.timeRange))
    : rawTurnHits;

  // Gather working memory — scope to sessions with query-matching turn hits.
  const hitSessionIds = new Set(turnHits.map((h) => h.item.session_id));
  const wmPromises = Array.from(hitSessionIds).map(
    (sid) => adapter.getWorkingMemoryBySession(sid, scope),
  );
  let wmList: WorkingMemory[] = (await Promise.all(wmPromises)).flat();

  // Additionally pull compacted sessions whose working-memory SUMMARY matches
  // the query. When a timeRange is set, restrict the candidate pool to the
  // window via getWorkingMemoryByTimeRange; otherwise scan active WM. In both
  // paths we still require a query match so unrelated sessions in the window
  // do not leak through.
  const queryLower = options.query.toLowerCase();
  const candidateWm = options.timeRange
    ? await adapter.getWorkingMemoryByTimeRange(scope, options.timeRange)
    : await adapter.getActiveWorkingMemory(scope);
  for (const wm of candidateWm) {
    if (!hitSessionIds.has(wm.session_id) && wm.summary.toLowerCase().includes(queryLower)) {
      hitSessionIds.add(wm.session_id);
      wmList.push(wm);
    }
  }

  // Ensure every WM we hand to the summarizer is within the window when set.
  if (options.timeRange) {
    wmList = wmList.filter((wm) => inTimeRange(wm.created_at, options.timeRange));
  }

  const groups = groupBySession(turnHits, wmList);
  const summaries: EpisodeSummary[] = [];

  for (const group of groups.slice(0, limit)) {
    // Partially compacted sessions have both archived and active turns;
    // summarizing from only one drops earlier context. Always merge both
    // sets (deduped by turn id) so recaps cover the full session history.
    let turns = group.turns;
    if (group.workingMemories.length > 0) {
      const minStart = Math.min(...group.workingMemories.map((wm) => wm.turn_id_start));
      const maxEnd = Math.max(...group.workingMemories.map((wm) => wm.turn_id_end));
      const archived = await adapter.getArchivedTurnRange(group.sessionId, minStart, maxEnd, scope);
      if (archived.length > 0) {
        const byId = new Map<number, Turn>();
        for (const t of archived) byId.set(t.id, t);
        for (const t of turns) byId.set(t.id, t);
        turns = Array.from(byId.values()).sort((a, b) => a.id - b.id);
      }
    }

    const summary = await summarizeEpisode(deps, {
      turns,
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

  const recap = parseRecap(deps, responseText, sources);

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
    const rawTurnHits = await adapter.searchTurns(scope, options.query, { limit: limit * 5 });
    const turnHits = options.timeRange
      ? rawTurnHits.filter((h) => inTimeRange(h.item.created_at, options.timeRange))
      : rawTurnHits;

    // Start WM set scoped to sessions with query-matching turn hits.
    const hitSessionIds = new Set(turnHits.map((h) => h.item.session_id));
    const wmPromises = Array.from(hitSessionIds).map(
      (sid) => adapter.getWorkingMemoryBySession(sid, scope),
    );
    let wmList: WorkingMemory[] = (await Promise.all(wmPromises)).flat();

    // Also pull compacted sessions whose WM SUMMARY matches the query.
    // When a timeRange is set, restrict the candidate pool to the window;
    // otherwise scan active WM. In both paths we still require a query
    // match so unrelated sessions do not leak into the reflection.
    const queryLower = options.query.toLowerCase();
    const candidateWm = options.timeRange
      ? await adapter.getWorkingMemoryByTimeRange(scope, options.timeRange)
      : await adapter.getActiveWorkingMemory(scope);
    for (const wm of candidateWm) {
      if (!hitSessionIds.has(wm.session_id) && wm.summary.toLowerCase().includes(queryLower)) {
        hitSessionIds.add(wm.session_id);
        wmList.push(wm);
      }
    }

    // Keep only WM inside the window when time-bounded.
    if (options.timeRange) {
      wmList = wmList.filter((wm) => inTimeRange(wm.created_at, options.timeRange));
    }

    if (turnHits.length > 0 || wmList.length > 0) {
      hasEpisodic = true;
      const turns = turnHits.map((h) => h.item);
      allSources.push(...buildSourceRefs(turns, wmList));

      if (turns.length > 0) {
        contextParts.push('Episodic memory (conversation turns):');
        contextParts.push(formatTurnsForSummarization(turns));
      }

      if (wmList.length > 0) {
        contextParts.push('\nWorking memory summaries:');
        for (const wm of wmList) {
          contextParts.push(`[wm:${wm.id}] ${wm.summary}`);
        }
      }
    }
  }

  if (includeDeclarative) {
    const knowledgeHits = await adapter.searchKnowledge(scope, options.query, { limit });
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
  const validation = validateLlmSources(raw.sources, allSources);
  emitSourceValidationEvent(deps, 'reflect', validation, allSources.length);

  return {
    synthesis: String(raw.synthesis ?? ''),
    sourceType,
    sources: validation.sources,
    episodes,
    detailLevel,
  };
}
