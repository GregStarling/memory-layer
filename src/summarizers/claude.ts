import type { Summarizer } from '../core/orchestrator.js';
import {
  formatTurnsForSummarization,
  parseSummarizerResponse,
  SUMMARIZATION_SYSTEM_PROMPT,
} from './prompts.js';

export interface ClaudeSummarizerOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export function createClaudeSummarizer(
  options: ClaudeSummarizerOptions = {},
): Summarizer {
  return async (turns) => {
    const moduleName = '@anthropic-ai/sdk';
    let sdkModule: any;
    try {
      sdkModule = await import(moduleName);
    } catch {
      throw new Error(
        "memory-layer: install '@anthropic-ai/sdk' to use createClaudeSummarizer()",
      );
    }

    const Anthropic = sdkModule.default ?? sdkModule.Anthropic ?? sdkModule;
    const client = new Anthropic({
      apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });

    const response = await client.messages.create({
      model: options.model ?? 'claude-sonnet-4-20250514',
      max_tokens: options.maxTokens ?? 1024,
      system: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: formatTurnsForSummarization(turns),
        },
      ],
    });

    const text = Array.isArray(response.content)
      ? response.content.map((part: any) => part.text ?? '').join('\n')
      : String(response.content ?? '');

    return parseSummarizerResponse(text);
  };
}
