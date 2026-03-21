import { createSessionId } from '../core/tokens.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { Turn } from '../contracts/types.js';

export function makeScope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    ...overrides,
  };
}

export function seedTurns(
  adapter: StorageAdapter,
  scope: MemoryScope,
  count: number,
  options: { contentPrefix?: string; tokenEstimate?: number; baseTime?: number } = {},
): { sessionId: string; turns: Turn[] } {
  const sessionId = createSessionId(scope);
  const turns: Turn[] = [];
  for (let i = 0; i < count; i += 1) {
    turns.push(
      adapter.insertTurn({
        ...scope,
        session_id: sessionId,
        actor: i % 2 === 0 ? 'user-1' : 'assistant-1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `${options.contentPrefix ?? 'turn'}-${i}`,
        token_estimate: options.tokenEstimate ?? 120,
        created_at: (options.baseTime ?? 1_700_000_000) + i,
      }),
    );
  }
  return { sessionId, turns };
}
