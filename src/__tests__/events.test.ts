import { describe, expect, it, vi } from 'vitest';

import { createMemoryEventEmitter } from '../core/events.js';

describe('memory event emitter', () => {
  it('subscribes and unsubscribes by event type', () => {
    const emitter = createMemoryEventEmitter();
    const handler = vi.fn();
    const unsubscribe = emitter.on('manager', handler);

    emitter.emit({
      type: 'manager',
      scope: {
        tenant_id: 'acme',
        system_id: 'assistant',
        workspace_id: 'default',
        scope_id: 'thread-1',
      },
      timestamp: Date.now(),
      durationMs: 0,
      meta: { action: 'process_turn' },
    });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    emitter.emit({
      type: 'manager',
      scope: {
        tenant_id: 'acme',
        system_id: 'assistant',
        workspace_id: 'default',
        scope_id: 'thread-1',
      },
      timestamp: Date.now(),
      durationMs: 0,
      meta: { action: 'process_turn' },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
