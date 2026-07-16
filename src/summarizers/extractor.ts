import { ProviderUnavailableError } from '../contracts/errors.js';
import type { Extractor } from '../core/extractor.js';
import { createClientExtractor, type StructuredGenerationClient } from './client.js';

export interface ProviderExtractorOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  prompt?: string;
  client?: StructuredGenerationClient;
}

export function createClaudeExtractor(options: ProviderExtractorOptions = {}): Extractor {
  if (options.client) {
    return createClientExtractor(options.client, options);
  }

  return async (...args) => {
    const moduleName = '@anthropic-ai/sdk';
    let sdkModule: any;
    try {
      sdkModule = await import(moduleName);
    } catch (error) {
      throw new ProviderUnavailableError(
        "memory-layer: install '@anthropic-ai/sdk' to use createClaudeExtractor()",
        { cause: error },
      );
    }

    const Anthropic = sdkModule.default ?? sdkModule.Anthropic ?? sdkModule;
    const client = new Anthropic({
      apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    return createClientExtractor(
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

export function createOpenAIExtractor(options: ProviderExtractorOptions = {}): Extractor {
  if (options.client) {
    return createClientExtractor(options.client, options);
  }

  return async (...args) => {
    const moduleName = 'openai';
    let sdkModule: any;
    try {
      sdkModule = await import(moduleName);
    } catch (error) {
      throw new ProviderUnavailableError(
        "memory-layer: install 'openai' to use createOpenAIExtractor()",
        { cause: error },
      );
    }

    const OpenAI = sdkModule.default ?? sdkModule.OpenAI ?? sdkModule;
    const client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    });
    return createClientExtractor(
      {
        async generate(request) {
          const response = await client.chat.completions.create({
            model: request.model ?? 'gpt-4.1-mini',
            max_tokens: request.maxTokens ?? 1024,
            messages: [
              { role: 'system', content: request.systemPrompt },
              {
                role: 'user',
                content: request.userPrompt,
              },
            ],
            response_format: { type: 'json_object' },
          });

          return response.choices?.[0]?.message?.content ?? '[]';
        },
      },
      options,
    )(...args);
  };
}

