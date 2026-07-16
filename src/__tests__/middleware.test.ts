import { describe, expect, it, vi } from 'vitest';

import { createMemory } from '../composition/quick.js';
import { wrapWithMemory } from '../integrations/middleware.js';

describe('memory middleware', () => {
  it('records both user and assistant turns and injects context', async () => {
    const memory = createMemory({
      adapter: 'memory',
      autoCompact: false,
    });
    const handler = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      expect(messages.some((message) => message.role === 'system')).toBe(true);
      return 'stored reply';
    });

    const wrapped = wrapWithMemory(handler, memory);
    const result = await wrapped([{ role: 'user', content: 'Remember local-first behavior.' }]);
    const recall = await memory.recall({ start_at: 0 });

    expect(result).toBe('stored reply');
    expect(recall.turns).toHaveLength(2);
    await memory.close();
  });

  it('does not record an assistant turn if the handler throws', async () => {
    const memory = createMemory({
      adapter: 'memory',
      autoCompact: false,
    });
    const wrapped = wrapWithMemory(async () => {
      throw new Error('boom');
    }, memory);

    await expect(wrapped([{ role: 'user', content: 'Fail this call.' }])).rejects.toThrow('boom');
    expect((await memory.recall({ start_at: 0 })).turns).toHaveLength(1);
    await memory.close();
  });
});
