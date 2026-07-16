import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenAIEmbeddingGenerator } from '../embeddings/openai.js';
import { createVoyageEmbeddingGenerator } from '../embeddings/voyage.js';
import { ProviderUnavailableError } from '../contracts/errors.js';

describe('embedding provider error paths', () => {
  it('surfaces a typed ProviderUnavailableError when the openai package is absent', async () => {
    // The `openai` package is an unmet optional peer dependency in this repo,
    // so the dynamic import inside the generator fails.
    const generator = createOpenAIEmbeddingGenerator({ maxRetries: 0 });
    await expect(generator(['hello world'])).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(generator(['hello world'])).rejects.toThrow('openai');
  });

  describe('voyage', () => {
    let savedKey: string | undefined;

    beforeEach(() => {
      savedKey = process.env.VOYAGE_API_KEY;
      delete process.env.VOYAGE_API_KEY;
    });

    afterEach(() => {
      if (savedKey === undefined) {
        delete process.env.VOYAGE_API_KEY;
      } else {
        process.env.VOYAGE_API_KEY = savedKey;
      }
      vi.restoreAllMocks();
    });

    it('surfaces a typed ProviderUnavailableError when no API key is configured', async () => {
      const generator = createVoyageEmbeddingGenerator({ maxRetries: 0 });
      await expect(generator(['hello world'])).rejects.toBeInstanceOf(ProviderUnavailableError);
      await expect(generator(['hello world'])).rejects.toThrow('API key');
    });

    it('surfaces a typed ProviderUnavailableError when the Voyage API returns non-OK', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('upstream boom', { status: 503 }),
      );
      const generator = createVoyageEmbeddingGenerator({
        apiKey: 'test-key',
        maxRetries: 0,
      });
      await expect(generator(['hello world'])).rejects.toBeInstanceOf(ProviderUnavailableError);
      await expect(generator(['hello world'])).rejects.toThrow('Voyage API error 503');
    });
  });
});
