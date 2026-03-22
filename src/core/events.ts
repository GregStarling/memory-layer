import type { EventHook, MemoryEvent, MemoryEventType } from '../contracts/observability.js';

export interface MemoryEventEmitter {
  emit(event: MemoryEvent): void;
  on(type: MemoryEventType, handler: EventHook): () => void;
  off(type: MemoryEventType, handler: EventHook): void;
}

export function createMemoryEventEmitter(): MemoryEventEmitter {
  const handlers = new Map<MemoryEventType, Set<EventHook>>();

  return {
    emit(event) {
      const listeners = handlers.get(event.type);
      if (!listeners) return;
      for (const handler of listeners) {
        handler(event);
      }
    },

    on(type, handler) {
      const listeners = handlers.get(type) ?? new Set<EventHook>();
      listeners.add(handler);
      handlers.set(type, listeners);
      return () => {
        listeners.delete(handler);
      };
    },

    off(type, handler) {
      handlers.get(type)?.delete(handler);
    },
  };
}
