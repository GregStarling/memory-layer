import type { EmbeddingGenerator, EmbeddingVector } from '../contracts/embedding.js';

export interface OpenAIEmbeddingOptions {
  /** API key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Defaults to 'text-embedding-3-small'. */
  model?: string;
  /** Optional dimensions override (for models that support it). */
  dimensions?: number;
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
        } catch {
          throw new Error(
            'memory-layer: OpenAI embedding generator requires the "openai" package. ' +
              'Install it with: npm install openai',
          );
        }
      })();
    }
    return clientPromise;
  }

  return async (texts: string[]): Promise<EmbeddingVector[]> => {
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
}
