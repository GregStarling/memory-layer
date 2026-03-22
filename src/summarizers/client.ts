import type { Extractor } from '../core/extractor.js';
import type { Summarizer } from '../core/orchestrator.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  formatTurnsForSummarization,
  parseExtractionResponse,
  parseSummarizerResponse,
  SUMMARIZATION_SYSTEM_PROMPT,
} from './prompts.js';

export interface StructuredGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  maxTokens?: number;
  expectedFormat: 'object' | 'array';
}

export interface StructuredGenerationClient {
  generate(request: StructuredGenerationRequest): Promise<string>;
}

export function createClientSummarizer(
  client: StructuredGenerationClient,
  options?: { model?: string; maxTokens?: number; prompt?: string },
): Summarizer {
  return async (turns) =>
    parseSummarizerResponse(
      await client.generate({
        systemPrompt: options?.prompt ?? SUMMARIZATION_SYSTEM_PROMPT,
        userPrompt: formatTurnsForSummarization(turns),
        model: options?.model,
        maxTokens: options?.maxTokens,
        expectedFormat: 'object',
      }),
    );
}

export function createClientExtractor(
  client: StructuredGenerationClient,
  options?: { model?: string; maxTokens?: number; prompt?: string },
): Extractor {
  return async (summary, keyEntities, topicTags) =>
    parseExtractionResponse(
      await client.generate({
        systemPrompt: options?.prompt ?? EXTRACTION_SYSTEM_PROMPT,
        userPrompt: [
          `Summary: ${summary}`,
          `Key entities: ${keyEntities.join(', ') || 'none'}`,
          `Topic tags: ${topicTags.join(', ') || 'none'}`,
        ].join('\n'),
        model: options?.model,
        maxTokens: options?.maxTokens,
        expectedFormat: 'array',
      }),
    );
}
