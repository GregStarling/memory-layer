import type { Extractor } from '../core/extractor.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  parseExtractionResponse,
} from './prompts.js';

function formatExtractionInput(
  summary: string,
  keyEntities: string[],
  topicTags: string[],
): string {
  return [
    `Summary: ${summary}`,
    `Key entities: ${keyEntities.join(', ') || 'none'}`,
    `Topic tags: ${topicTags.join(', ') || 'none'}`,
  ].join('\n');
}

export function createClaudeExtractor(): Extractor {
  return async (summary, keyEntities, topicTags) => {
    const moduleName = '@anthropic-ai/sdk';
    let sdkModule: any;
    try {
      sdkModule = await import(moduleName);
    } catch {
      throw new Error(
        "memory-layer: install '@anthropic-ai/sdk' to use createClaudeExtractor()",
      );
    }

    const Anthropic = sdkModule.default ?? sdkModule.Anthropic ?? sdkModule;
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: formatExtractionInput(summary, keyEntities, topicTags),
        },
      ],
    });

    const text = Array.isArray(response.content)
      ? response.content.map((part: any) => part.text ?? '').join('\n')
      : String(response.content ?? '');

    return parseExtractionResponse(text);
  };
}

export function createOpenAIExtractor(): Extractor {
  return async (summary, keyEntities, topicTags) => {
    const moduleName = 'openai';
    let sdkModule: any;
    try {
      sdkModule = await import(moduleName);
    } catch {
      throw new Error("memory-layer: install 'openai' to use createOpenAIExtractor()");
    }

    const OpenAI = sdkModule.default ?? sdkModule.OpenAI ?? sdkModule;
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: formatExtractionInput(summary, keyEntities, topicTags),
        },
      ],
      response_format: { type: 'json_object' },
    });

    const text = response.choices?.[0]?.message?.content ?? '[]';
    return parseExtractionResponse(text);
  };
}
