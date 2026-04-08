import { normalizeScope, type MemoryScope } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { getNativeSyncAdapter } from '../adapters/sync-to-async.js';
import {
  ConflictError,
  ResourceNotFoundError,
  ScopeMismatchError,
} from '../contracts/errors.js';
import type {
  Playbook,
  PlaybookRevision,
  SearchOptions,
  SearchResult,
  Turn,
  WorkingMemory,
} from '../contracts/types.js';
import type { StructuredGenerationClient } from '../summarizers/client.js';
import { formatTurnsForSummarization } from '../summarizers/prompts.js';

export interface PlaybookDeps {
  adapter: AsyncStorageAdapter;
  scope: MemoryScope;
  client: StructuredGenerationClient;
}

export interface CreatePlaybookFromTaskInput {
  title: string;
  description: string;
  sessionId: string;
  tags?: string[];
  rationale?: string | null;
  sourceWorkingMemoryId?: number | null;
}

const PLAYBOOK_SYSTEM_PROMPT = `You extract reusable procedural instructions from a completed task.
Return strict JSON matching this shape:
{
  "instructions": "step-by-step instructions for repeating this task",
  "references": ["files, commands, URLs, or tools referenced"],
  "templates": ["reusable templates or patterns identified"],
  "scripts": ["commands or scripts used"],
  "rationale": "why this procedure works (only when reasoning is clearly present), or null"
}
Rules:
- instructions should be a clear, numbered step-by-step procedure.
- Focus on what made the task succeed and what to watch out for.
- References should be specific (file paths, URLs, command names).
- Templates should be reusable patterns, not one-off details.
- Scripts should be exact commands that could be re-run.
- Only populate rationale when the task context clearly explains reasoning.
- Return JSON only.`;

function extractJsonPayload(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const exactCandidate = extractBalancedJson(trimmed);
  if (exactCandidate) {
    return exactCandidate;
  }
  throw new Error('Playbook: response did not contain JSON');
}

function extractBalancedJson(text: string): string | null {
  let startIndex = -1;
  let opening = '';
  let closing = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{' || text[i] === '[') {
      startIndex = i;
      opening = text[i];
      closing = opening === '{' ? '}' : ']';
      break;
    }
  }
  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opening) {
      depth += 1;
      continue;
    }
    if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

interface PlaybookExtraction {
  instructions: string;
  references: string[];
  templates: string[];
  scripts: string[];
  rationale: string | null;
}

function parsePlaybookExtraction(text: string): PlaybookExtraction {
  const raw = JSON.parse(extractJsonPayload(text));
  const instructions = String(raw.instructions ?? '').trim();
  if (!instructions) {
    throw new Error('Playbook: LLM response did not contain instructions');
  }
  return {
    instructions,
    references: Array.isArray(raw.references) ? raw.references.filter((r: unknown) => typeof r === 'string' && r.trim()).map(String) : [],
    templates: Array.isArray(raw.templates) ? raw.templates.filter((t: unknown) => typeof t === 'string' && t.trim()).map(String) : [],
    scripts: Array.isArray(raw.scripts) ? raw.scripts.filter((s: unknown) => typeof s === 'string' && s.trim()).map(String) : [],
    rationale: typeof raw.rationale === 'string' && raw.rationale.trim() ? raw.rationale.trim() : null,
  };
}

/**
 * Creates a playbook from a completed task by gathering session context
 * and summarizing it into structured, reusable instructions.
 */
export async function createPlaybookFromTask(
  deps: PlaybookDeps,
  input: CreatePlaybookFromTaskInput,
): Promise<Playbook> {
  const { adapter, scope, client } = deps;

  // Gather session context — include both active and compacted/archived turns
  const activeTurns = await adapter.getActiveTurns(scope, input.sessionId);
  const allSessionWm = await adapter.getWorkingMemoryBySession(input.sessionId, scope);
  let turns = activeTurns;
  // Also fetch archived turns from compacted ranges to capture full session history
  if (allSessionWm.length > 0) {
    const minStart = Math.min(...allSessionWm.map((wm) => wm.turn_id_start));
    const maxEnd = Math.max(...allSessionWm.map((wm) => wm.turn_id_end));
    const archivedTurns = await adapter.getArchivedTurnRange(input.sessionId, minStart, maxEnd, scope);
    // Merge active + archived, deduplicate by ID, sort chronologically
    const turnMap = new Map(turns.map((t) => [t.id, t]));
    for (const t of archivedTurns) {
      if (!turnMap.has(t.id)) turnMap.set(t.id, t);
    }
    turns = Array.from(turnMap.values()).sort((a, b) => a.created_at - b.created_at);
  }
  const workingMemories = allSessionWm;

  const contextParts: string[] = [];
  if (turns.length > 0) {
    contextParts.push('Conversation turns:');
    contextParts.push(formatTurnsForSummarization(turns));
  }
  if (workingMemories.length > 0) {
    contextParts.push('\nWorking memory summaries:');
    for (const wm of workingMemories) {
      contextParts.push(`[wm:${wm.id}] ${wm.summary}`);
    }
  }

  const userPrompt = [
    `Task: ${input.title}`,
    `Description: ${input.description}`,
    '',
    ...contextParts,
  ].join('\n');

  const responseText = await client.generate({
    systemPrompt: PLAYBOOK_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 2048,
    expectedFormat: 'object',
  });

  const extraction = parsePlaybookExtraction(responseText);

  return adapter.insertPlaybook({
    ...scope,
    title: input.title,
    description: input.description,
    instructions: extraction.instructions,
    references: extraction.references,
    templates: extraction.templates,
    scripts: extraction.scripts,
    tags: input.tags,
    rationale: input.rationale ?? extraction.rationale ?? null,
    status: 'active',
    source_session_id: input.sessionId,
    source_working_memory_id: input.sourceWorkingMemoryId ?? null,
  });
}

/**
 * Revises a playbook by storing the old instructions as a revision
 * and updating the playbook with new instructions.
 */
export async function revisePlaybook(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  playbookId: number,
  newInstructions: string,
  revisionReason: string,
  sourceSessionId?: string | null,
): Promise<{ playbook: Playbook; revision: PlaybookRevision }> {
  // Use native sync adapter transaction for true rollback when available (SQLite)
  const syncAdapter = getNativeSyncAdapter(adapter);
  if (syncAdapter) {
    return syncAdapter.transaction(() => {
      const existing = syncAdapter.getPlaybookById(playbookId);
      if (!existing) {
        throw new ResourceNotFoundError(`Playbook ${playbookId} not found`);
      }
      const norm = normalizeScope(scope);
      if (
        existing.tenant_id !== norm.tenant_id ||
        existing.system_id !== norm.system_id ||
        existing.workspace_id !== norm.workspace_id ||
        existing.collaboration_id !== norm.collaboration_id ||
        existing.scope_id !== norm.scope_id
      ) {
        throw new ScopeMismatchError(`Playbook ${playbookId} does not belong to the requested scope`);
      }
      const revision = syncAdapter.insertPlaybookRevision({
        ...scope,
        playbook_id: playbookId,
        instructions: existing.instructions,
        revision_reason: revisionReason,
        source_session_id: sourceSessionId ?? null,
      });
      const updated = syncAdapter.updatePlaybook(playbookId, {
        instructions: newInstructions,
      });
      if (!updated) {
        throw new ConflictError(`Failed to update playbook ${playbookId}`);
      }
      return { playbook: updated, revision };
    });
  }

  // Async path for Postgres and other async adapters
  return adapter.transaction(async () => {
    const existing = await adapter.getPlaybookById(playbookId);
    if (!existing) {
      throw new ResourceNotFoundError(`Playbook ${playbookId} not found`);
    }

    // Scope safety: verify the playbook belongs to the caller's scope
    const norm = normalizeScope(scope);
    if (
      existing.tenant_id !== norm.tenant_id ||
      existing.system_id !== norm.system_id ||
      existing.workspace_id !== norm.workspace_id ||
      existing.collaboration_id !== norm.collaboration_id ||
      existing.scope_id !== norm.scope_id
    ) {
      throw new ScopeMismatchError(`Playbook ${playbookId} does not belong to the requested scope`);
    }

    // Store current instructions as a revision
    const revision = await adapter.insertPlaybookRevision({
      ...scope,
      playbook_id: playbookId,
      instructions: existing.instructions,
      revision_reason: revisionReason,
      source_session_id: sourceSessionId ?? null,
    });

    // Update playbook with new instructions
    const updated = await adapter.updatePlaybook(playbookId, {
      instructions: newInstructions,
    });

    if (!updated) {
      throw new ConflictError(`Failed to update playbook ${playbookId}`);
    }

    return { playbook: updated, revision };
  });
}

/**
 * Finds playbooks relevant to a query using full-text search
 * with relevance ranking.
 */
export async function findRelevantPlaybooks(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult<Playbook>[]> {
  return adapter.searchPlaybooks(scope, query, options);
}
