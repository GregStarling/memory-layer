import type { EmbeddingGenerator, EmbeddingVector } from '../contracts/embedding.js';
import {
  batchedGenerate,
  createCachedEmbeddingGenerator,
  withRetry,
} from './resilience.js';

export interface VoyageEmbeddingOptions {
  /** Voyage API key. Defaults to VOYAGE_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Defaults to 'voyage-3-lite'. */
  model?: string;
  /** API base URL. Defaults to 'https://api.voyageai.com/v1'. */
  baseUrl?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  batchSize?: number;
  cacheSize?: number;
}

/**
 * Creates an EmbeddingGenerator that calls the Voyage AI embeddings API.
 * Voyage is Anthropic's recommended embedding provider.
 *
 * This generator uses raw HTTP (no SDK dependency) to minimize installation footprint.
 *
 * ```typescript
 * import { createVoyageEmbeddingGenerator } from 'memory-layer/embeddings/voyage';
 *
 * const generator = createVoyageEmbeddingGenerator({
 *   apiKey: process.env.VOYAGE_API_KEY,
 * });
 * const vectors = await generator(['hello world']);
 * ```
 */
export function createVoyageEmbeddingGenerator(
  options?: VoyageEmbeddingOptions,
): EmbeddingGenerator {
  const model = options?.model ?? 'voyage-3-lite';
  const baseUrl = options?.baseUrl ?? 'https://api.voyageai.com/v1';

  function getApiKey(): string {
    const key = options?.apiKey ?? process.env.VOYAGE_API_KEY;
    if (!key) {
      throw new Error(
        'memory-layer: Voyage embedding generator requires an API key. ' +
          'Set VOYAGE_API_KEY env var or pass apiKey option.',
      );
    }
    return key;
  }

  const baseGenerator: EmbeddingGenerator = async (texts: string[]): Promise<EmbeddingVector[]> => {
    if (texts.length === 0) return [];

    const apiKey = getApiKey();
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `memory-layer: Voyage API error ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map(
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
