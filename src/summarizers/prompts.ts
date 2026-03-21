import type { Turn } from '../contracts/types.js';
import type { ExtractedFact } from '../core/extractor.js';
import type { SummarizerOutput } from '../core/orchestrator.js';

export const SUMMARIZATION_SYSTEM_PROMPT = `You summarize AI conversation history into compact working memory.
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

export const EXTRACTION_SYSTEM_PROMPT = `You extract durable facts that should become long-term memory.
Return strict JSON array with items shaped like:
{
  "fact": "durable fact text",
  "factType": "preference | entity | decision | constraint | reference",
  "confidence": "high | medium"
}
Rules:
- Only return facts that are likely to stay useful beyond the immediate turn.
- Prefer explicit user preferences, durable project facts, important decisions, and constraints.
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
  const trimmed = text.trim();
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
  throw new Error('Memory summarizer: response did not contain JSON');
}

export function parseSummarizerResponse(text: string): SummarizerOutput {
  const payload = JSON.parse(extractJsonPayload(text)) as Partial<SummarizerOutput>;
  if (typeof payload.summary !== 'string') {
    throw new Error('Memory summarizer: missing summary');
  }
  if (!Array.isArray(payload.key_entities) || !payload.key_entities.every((item) => typeof item === 'string')) {
    throw new Error('Memory summarizer: invalid key_entities');
  }
  if (!Array.isArray(payload.topic_tags) || !payload.topic_tags.every((item) => typeof item === 'string')) {
    throw new Error('Memory summarizer: invalid topic_tags');
  }
  return {
    summary: payload.summary,
    key_entities: payload.key_entities,
    topic_tags: payload.topic_tags,
  };
}

export function parseExtractionResponse(text: string): ExtractedFact[] {
  const payload = JSON.parse(extractJsonPayload(text)) as Array<Partial<ExtractedFact>>;
  if (!Array.isArray(payload)) {
    throw new Error('Memory extractor: response must be a JSON array');
  }
  return payload
    .filter((item): item is Partial<ExtractedFact> => Boolean(item))
    .map((item) => {
      if (typeof item.fact !== 'string' || typeof item.factType !== 'string') {
        throw new Error('Memory extractor: invalid extracted fact');
      }
      return {
        fact: item.fact,
        factType: item.factType as ExtractedFact['factType'],
        confidence: (item.confidence ?? 'medium') as ExtractedFact['confidence'],
      };
    });
}
