import { ProviderUnavailableError } from '../contracts/errors.js';
import type { Turn } from '../contracts/types.js';
import type { ExtractedFact } from '../core/extractor.js';
import type { SummarizerOutput } from '../core/orchestrator.js';

export const SUMMARIZATION_PROMPT_VERSION = 'v2';
export const EXTRACTION_PROMPT_VERSION = 'v2';

export const SUMMARIZATION_SYSTEM_PROMPT = `Prompt version: ${SUMMARIZATION_PROMPT_VERSION}
You summarize AI conversation history into compact working memory.
Return strict JSON with this shape:
{
  "summary": "short factual summary",
  "key_entities": ["important people, systems, files, projects, concepts"],
  "topic_tags": ["up to five short topic tags"]
}
Rules:
- Preserve important constraints, decisions, preferences, and unresolved work.
- Keep the summary concise and factual.
- key_entities must be short strings.
- topic_tags must contain at most 5 strings.
- Return JSON only.`;

export const EXTRACTION_SYSTEM_PROMPT = `Prompt version: ${EXTRACTION_PROMPT_VERSION}
You extract durable facts that should become long-term memory.
Return strict JSON array with items shaped like:
{
  "fact": "durable fact text",
  "factType": "preference | entity | decision | constraint | reference",
  "confidence": "high | medium",
  "sourceText": "verbatim excerpt that supports this fact, or null",
  "rationale": "why this fact holds (only when text clearly explains reasoning), or null"
}
Rules:
- Only return facts that are likely to stay useful beyond the immediate turn.
- Prefer explicit user preferences, durable project facts, important decisions, and constraints.
- Only populate rationale when the source text clearly explains reasoning (e.g. 'because...', 'in order to...').
- Return JSON only.`;

export const EPISODIC_RECAP_PROMPT_VERSION = 'v1';
export const REFLECT_SYNTHESIS_PROMPT_VERSION = 'v1';

export const EPISODIC_RECAP_SYSTEM_PROMPT = `Prompt version: ${EPISODIC_RECAP_PROMPT_VERSION}
You produce structured episodic recaps from conversation history.
Return strict JSON matching this shape:
{
  "objective": "what the user or agent was trying to accomplish",
  "actions": ["key actions taken during the episode"],
  "outcomes": ["results and conclusions reached"],
  "artifacts": ["files, commands, URLs, tools, or artifacts referenced"],
  "unresolvedItems": ["open questions, unfinished work, or blockers"],
  "sourceType": "episodic | declarative | mixed",
  "sources": [{"type": "turn | working_memory | knowledge", "id": 0, "excerpt": "relevant excerpt or null"}]
}
Rules:
- Focus on factual, query-relevant information from the provided turns.
- objective should be a single concise sentence.
- actions and outcomes should be ordered chronologically.
- artifacts should include specific file paths, commands, URLs, or named artifacts.
- unresolvedItems should only include genuinely open items, not completed work.
- sourceType must be "episodic" if sources are only turns, "declarative" if only knowledge, or "mixed" if both.
- sources must reference actual source IDs from the provided context.
- Return JSON only.`;

export const REFLECT_SYNTHESIS_SYSTEM_PROMPT = `Prompt version: ${REFLECT_SYNTHESIS_PROMPT_VERSION}
You synthesize information across multiple memory sources to answer a query.
Return strict JSON matching this shape:
{
  "synthesis": "a coherent answer synthesizing all relevant memory",
  "sourceType": "episodic | declarative | mixed",
  "sources": [{"type": "turn | working_memory | knowledge", "id": 0, "excerpt": "relevant excerpt or null"}],
  "episodes": [],
  "detailLevel": "abstract | overview | full"
}
Rules:
- synthesis should directly address the query by combining evidence from episodic, declarative, and procedural memory.
- Clearly attribute claims to their sources within the synthesis text.
- sourceType must reflect which memory types contributed: "episodic" for turns/episodes only, "declarative" for knowledge facts only, "mixed" when both are used.
- sources must reference actual source IDs from the provided context.
- episodes should contain any relevant episode summaries used in the synthesis; leave empty if none.
- detailLevel must match the requested detail level from the query context.
- When sources conflict, note the conflict and indicate which source has higher trust.
- Return JSON only.`;

export function formatTurnsForSummarization(turns: Turn[]): string {
  return turns
    .map(
      (turn) =>
        `[${turn.role}] ${turn.actor}: ${turn.content}`,
    )
    .join('\n');
}

function extractJsonPayload(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  if (trimmed.startsWith('[')) {
    return trimmed;
  }

  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');

  if (objectStart !== -1 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1);
  }
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return text.slice(arrayStart, arrayEnd + 1);
  }
  throw new ProviderUnavailableError('Memory summarizer: response did not contain JSON');
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(extractJsonPayload(text)) as T;
  } catch (error) {
    throw new ProviderUnavailableError(
      `Memory summarizer: failed to parse JSON response (${String(error)})`,
      { cause: error },
    );
  }
}

export function parseSummarizerResponse(text: string): SummarizerOutput {
  const payload = parseJson<Partial<SummarizerOutput>>(text);
  if (typeof payload.summary !== 'string') {
    throw new ProviderUnavailableError('Memory summarizer: missing summary');
  }
  if (!Array.isArray(payload.key_entities) || !payload.key_entities.every((item) => typeof item === 'string')) {
    throw new ProviderUnavailableError('Memory summarizer: invalid key_entities');
  }
  if (!Array.isArray(payload.topic_tags) || !payload.topic_tags.every((item) => typeof item === 'string')) {
    throw new ProviderUnavailableError('Memory summarizer: invalid topic_tags');
  }
  return {
    summary: payload.summary,
    key_entities: payload.key_entities,
    topic_tags: payload.topic_tags,
  };
}

export function parseExtractionResponse(text: string): ExtractedFact[] {
  const parsed = parseJson<Array<Partial<ExtractedFact>> | { items?: Array<Partial<ExtractedFact>>; facts?: Array<Partial<ExtractedFact>> }>(text);
  const payload = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.facts ?? [];
  if (!Array.isArray(payload)) {
    throw new ProviderUnavailableError('Memory extractor: response must be a JSON array');
  }
  return payload
    .filter((item): item is Partial<ExtractedFact> => Boolean(item))
    .map((item) => {
      if (typeof item.fact !== 'string' || typeof item.factType !== 'string') {
        throw new ProviderUnavailableError('Memory extractor: invalid extracted fact');
      }
      if (!['preference', 'entity', 'decision', 'constraint', 'reference'].includes(item.factType)) {
        throw new ProviderUnavailableError(`Memory extractor: invalid factType '${item.factType}'`);
      }
      if (item.confidence && !['high', 'medium'].includes(item.confidence)) {
        throw new ProviderUnavailableError(`Memory extractor: invalid confidence '${item.confidence}'`);
      }
      return {
        fact: item.fact,
        factType: item.factType as ExtractedFact['factType'],
        confidence: (item.confidence ?? 'medium') as ExtractedFact['confidence'],
        sourceText: typeof item.sourceText === 'string' ? item.sourceText : null,
        rationale: typeof item.rationale === 'string' ? item.rationale : null,
      };
    });
}
