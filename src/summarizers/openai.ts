import type { Summarizer } from '../core/orchestrator.js';
import {
  formatTurnsForSummarization,
  parseSummarizerResponse,
  SUMMARIZATION_SYSTEM_PROMPT,
} from './prompts.js';

export interface OpenAISummarizerOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export function createOpenAISummarizer(
  options: OpenAISummarizerOptions = {},
): Summarizer {
  return async (turns) => {
    const moduleName = 'openai';
    let sdkModule: any;
    try {
      sdkModule = await import(moduleName);
    } catch {
      throw new Error("memory-layer: install 'openai' to use createOpenAISummarizer()");
    }

    const OpenAI = sdkModule.default ?? sdkModule.OpenAI ?? sdkModule;
    const client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    });

    const response = await client.chat.completions.create({
      model: options.model ?? 'gpt-4.1-mini',
      max_tokens: options.maxTokens ?? 1024,
      messages: [
        {
          role: 'system',
          content: SUMMARIZATION_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: formatTurnsForSummarization(turns),
        },
      ],
      response_format: { type: 'json_object' },
    });

    const text = response.choices?.[0]?.message?.content ?? '';
    return parseSummarizerResponse(text);
  };
}
