import type { NormalizedMemoryScope } from './identity.js';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export type MemoryEventType =
  | 'compaction'
  | 'promotion'
  | 'extraction'
  | 'knowledge_change'
  | 'search'
  | 'context_assembly'
  | 'semantic_search'
  | 'manager';

export interface MemoryEvent {
  type: MemoryEventType;
  scope: NormalizedMemoryScope;
  timestamp: number;
  durationMs: number;
  meta: Record<string, unknown>;
}

export type EventHook = (event: MemoryEvent) => void;
