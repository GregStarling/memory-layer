import { describe, expect, it } from 'vitest';

import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import { listAllMemoryEvents } from '../core/temporal.js';

describe('temporal pagination safety', () => {
  it('throws when an event cursor does not advance', async () => {
    const adapter = {
      listMemoryEvents: async () => ({
        events: [
          {
            event_id: '1',
            tenant_id: 'acme',
            system_id: 'assistant',
            workspace_id: 'shared',
            collaboration_id: '',
            scope_id: 'thread-1',
            session_id: null,
            actor_id: null,
            actor_kind: null,
            actor_system_id: null,
            actor_display_name: null,
            actor_metadata: null,
            entity_kind: 'knowledge_memory',
            entity_id: '1',
            event_type: 'knowledge.created',
            payload: {},
            causation_id: null,
            correlation_id: null,
            created_at: 1,
          },
        ],
        nextCursor: '1',
      }),
    } as unknown as AsyncStorageAdapter;

    const scope: MemoryScope = {
      tenant_id: 'acme',
      system_id: 'assistant',
      workspace_id: 'shared',
      scope_id: 'thread-1',
    };

    await expect(listAllMemoryEvents(adapter, scope, { cursor: '1' })).rejects.toThrow(
      'cursor did not advance',
    );
  });
});
