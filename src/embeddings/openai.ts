import type { EmbeddingGenerator, EmbeddingVector } from '../contracts/embedding.js';
import { ProviderUnavailableError } from '../contracts/errors.js';
import {
  batchedGenerate,
  createCachedEmbeddingGenerator,
  withRetry,
} from './resilience.js';

export interface OpenAIEmbeddingOptions {
  /** API key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Defaults to 'text-embedding-3-small'. */
  model?: string;
  /** Optional dimensions override (for models that support it). */
  dimensions?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  batchSize?: number;
  cacheSize?: number;
}

/**
 * Creates an EmbeddingGenerator that calls the OpenAI embeddings API.
 * Requires the `openai` package as an optional peer dependency.
 *
 * ```typescript
 * import { createOpenAIEmbeddingGenerator } from 'memory-layer/embeddings/openai';
 *
 * const generator = createOpenAIEmbeddingGenerator();
 * const vectors = await generator(['hello world']);
 * ```
 */
export function createOpenAIEmbeddingGenerator(
  options?: OpenAIEmbeddingOptions,
): EmbeddingGenerator {
  const model = options?.model ?? 'text-embedding-3-small';
  const dimensions = options?.dimensions;

  let clientPromise: Promise<unknown> | null = null;

  async function getClient(): Promise<unknown> {
    if (!clientPromise) {
      clientPromise = (async () => {
        try {
          const moduleName = 'openai';
          const mod = await import(moduleName);
          const OpenAI = mod.default ?? mod;
          return new OpenAI({ apiKey: options?.apiKey });
        } catch (error) {
          throw new ProviderUnavailableError(
            'memory-layer: OpenAI embedding generator requires the "openai" package. ' +
              'Install it with: npm install openai',
            { cause: error },
          );
        }
      })();
    }
    return clientPromise;
  }

  const baseGenerator: EmbeddingGenerator = async (texts: string[]): Promise<EmbeddingVector[]> => {
    if (texts.length === 0) return [];

    const client = await getClient() as {
      embeddings: {
        create(params: {
          model: string;
          input: string[];
          dimensions?: number;
        }): Promise<{
          data: Array<{ embedding: number[] }>;
        }>;
      };
    };

    const response = await client.embeddings.create({
      model,
      input: texts,
      ...(dimensions ? { dimensions } : {}),
    });

    return response.data.map(
      (item) => new Float32Array(item.embedding),
    );
  };

  const cachedGenerator = createCachedEmbeddingGenerator(
    baseGenerator,
    options?.cacheSize ?? 256,
  );

  return async (texts: string[]): Promise<EmbeddingVector[]> =>
    withRetry(
      () => batchedGenerate(cachedGenerator, texts, options?.batchSize ?? 32),
      options?.maxRetries ?? 2,
      options?.retryDelayMs ?? 250,
    );
}
