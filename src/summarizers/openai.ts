import type { Summarizer } from '../core/orchestrator.js';
import { createClientSummarizer, type StructuredGenerationClient } from './client.js';

export interface OpenAISummarizerOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  prompt?: string;
  client?: StructuredGenerationClient;
}

export function createOpenAISummarizer(
  options: OpenAISummarizerOptions = {},
): Summarizer {
  if (options.client) {
    return createClientSummarizer(options.client, options);
  }

  return async (...args) => {
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
    return createClientSummarizer(
      {
        async generate(request) {
          const response = await client.chat.completions.create({
            model: request.model ?? 'gpt-4.1-mini',
            max_tokens: request.maxTokens ?? 1024,
            messages: [
              {
                role: 'system',
                content: request.systemPrompt,
              },
              {
                role: 'user',
                content: request.userPrompt,
              },
            ],
            response_format: { type: 'json_object' },
          });

          return response.choices?.[0]?.message?.content ?? '';
        },
      },
      options,
    )(...args);
  };
}
