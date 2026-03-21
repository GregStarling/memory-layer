import { randomBytes } from 'crypto';

import type { MemoryScope } from '../contracts/identity.js';
import { normalizeScope } from '../contracts/identity.js';

const TOKEN_MULTIPLIER = 1.15;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil((text.length / CHARS_PER_TOKEN) * TOKEN_MULTIPLIER));
}

export function createSessionId(scope: MemoryScope): string {
  const normalized = normalizeScope(scope);
  const date = new Date().toISOString().slice(0, 10);
  const rand = randomBytes(4).toString('hex');
  return [
    normalized.tenant_id,
    normalized.system_id,
    normalized.workspace_id,
    normalized.scope_id,
    date,
    rand,
  ].join('_');
}
