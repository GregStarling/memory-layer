import { ProviderUnavailableError } from '../contracts/errors.js';
import type { Summarizer } from '../core/orchestrator.js';
import { createClientSummarizer, type StructuredGenerationClient } from './client.js';

export interface ClaudeSummarizerOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  prompt?: string;
  client?: StructuredGenerationClient;
}

export function createClaudeSummarizer(
  options: ClaudeSummarizerOptions = {},
): Summarizer {
  if (options.client) {
    return createClientSummarizer(options.client, options);
  }

  return async (...args) => {
    const moduleName = '@anthropic-ai/sdk';
    let sdkModule: any;
    try {
      sdkModule = await import(moduleName);
    } catch (error) {
      throw new ProviderUnavailableError(
        "memory-layer: install '@anthropic-ai/sdk' to use createClaudeSummarizer()",
        { cause: error },
      );
    }

    const Anthropic = sdkModule.default ?? sdkModule.Anthropic ?? sdkModule;
    const client = new Anthropic({
      apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    return createClientSummarizer(
      {
        async generate(request) {
          const response = await client.messages.create({
            model: request.model ?? 'claude-sonnet-4-20250514',
            max_tokens: request.maxTokens ?? 1024,
            system: request.systemPrompt,
            messages: [
              {
                role: 'user',
                content: request.userPrompt,
              },
            ],
          });

          return Array.isArray(response.content)
            ? response.content.map((part: any) => part.text ?? '').join('\n')
            : String(response.content ?? '');
        },
      },
      options,
    )(...args);
  };
}
