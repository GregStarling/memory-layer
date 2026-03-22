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
  let lastSeen = new Date(0);
  let inFlight = false;

  async function pollOnce(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const changes = await options.manager.pollForChanges(lastSeen, {
        scopeLevel: options.scopeLevel,
      });
      if (changes.length > 0) {
        const newest = Math.max(...changes.map((item) => item.created_at));
        lastSeen = new Date(newest * 1000);
        handlers.forEach((handler) => handler(changes));
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
