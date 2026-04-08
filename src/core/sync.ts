import type { ScopeLevel } from '../contracts/identity.js';
import type { KnowledgeMemory } from '../contracts/types.js';
import type { MemoryManager } from './manager.js';

export function createMemorySync(options: {
  manager: MemoryManager;
  scopeLevel?: ScopeLevel;
  pollIntervalMs?: number;
}) {
  const handlers = new Set<(knowledge: KnowledgeMemory[]) => void>();
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastCursorPromise: Promise<string> | null = null;
  let lastCursor: string | null = null;
  let inFlight = false;

  async function pollOnce(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      if (!lastCursorPromise) {
        lastCursorPromise = options.manager.resolveChangeStreamCursor();
      }
      lastCursor ??= await lastCursorPromise;
      const page = await options.manager.listKnowledgeChanges({
        cursor: lastCursor,
        scopeLevel: options.scopeLevel,
      });
      lastCursor = page.nextCursor;
      if (page.changes.length > 0) {
        handlers.forEach((handler) => handler(page.changes.map((change) => change.knowledge)));
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    onKnowledgeChange(handler: (knowledge: KnowledgeMemory[]) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    startPolling() {
      if (timer) return;
      timer = setInterval(() => {
        void pollOnce();
      }, pollIntervalMs);
      void pollOnce();
    },
    stopPolling() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
