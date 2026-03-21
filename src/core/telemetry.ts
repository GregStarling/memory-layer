import { normalizeScope, type MemoryScope } from '../contracts/identity.js';
import type { EventHook, Logger, MemoryEvent } from '../contracts/observability.js';

export interface TelemetryOptions {
  logger?: Logger;
  onEvent?: EventHook;
}

export function emitMemoryEvent(
  type: MemoryEvent['type'],
  scope: MemoryScope,
  options: TelemetryOptions | undefined,
  durationMs: number,
  meta: Record<string, unknown> = {},
): void {
  const normalizedScope = normalizeScope(scope);
  const event: MemoryEvent = {
    type,
    scope: normalizedScope,
    timestamp: Date.now(),
    durationMs,
    meta,
  };

  options?.onEvent?.(event);
  options?.logger?.debug(`memory.${type}`, event.meta);
}
