import { randomBytes } from 'crypto';

import type { MemoryScope } from '../contracts/identity.js';
import { normalizeScope } from '../contracts/identity.js';

const TOKEN_MULTIPLIER = 1.15;
const CHARS_PER_TOKEN = 4;
const MODEL_CHAR_RATIOS: Array<{ match: RegExp; charsPerToken: number }> = [
  { match: /gpt-4|gpt-5|o1|o3|o4/i, charsPerToken: 3.3 },
  { match: /claude/i, charsPerToken: 3.5 },
  { match: /llama|mistral|mixtral/i, charsPerToken: 3.7 },
];

export type TokenEstimator = (text: string) => number;
const defaultTokenEstimator = createCharacterRatioTokenEstimator();

export function createCharacterRatioTokenEstimator(
  charsPerToken = CHARS_PER_TOKEN,
  multiplier = TOKEN_MULTIPLIER,
): TokenEstimator {
  return (text) => {
    if (text.length === 0) return 0;
    return Math.max(1, Math.ceil((text.length / charsPerToken) * multiplier));
  };
}

export function createModelTokenEstimator(model?: string): TokenEstimator {
  if (!model) {
    return createCharacterRatioTokenEstimator();
  }

  const resolved =
    MODEL_CHAR_RATIOS.find((entry) => entry.match.test(model))?.charsPerToken ?? CHARS_PER_TOKEN;
  return createCharacterRatioTokenEstimator(resolved);
}

export async function createTiktokenEstimator(model?: string): Promise<TokenEstimator> {
  try {
    const moduleName = 'tiktoken';
    const tiktokenModule: any = await import(moduleName);
    const encodingForModel =
      tiktokenModule.encoding_for_model ??
      tiktokenModule.encodingForModel ??
      tiktokenModule.getEncodingForModel;
    const getEncoding =
      tiktokenModule.get_encoding ?? tiktokenModule.getEncoding;
    const encoding =
      (typeof encodingForModel === 'function' && model
        ? encodingForModel(model)
        : undefined) ??
      (typeof getEncoding === 'function' ? getEncoding('cl100k_base') : undefined);

    if (!encoding || typeof encoding.encode !== 'function') {
      return createModelTokenEstimator(model);
    }

    return (text) => {
      if (text.length === 0) return 0;
      return Math.max(1, encoding.encode(text).length);
    };
  } catch {
    return createModelTokenEstimator(model);
  }
}

export function estimateTokens(text: string): number {
  return defaultTokenEstimator(text);
}

export function createSessionId(scope: MemoryScope): string {
  normalizeScope(scope);
  const date = new Date().toISOString().slice(0, 10);
  const rand = randomBytes(4).toString('hex');
  return ['session', date, rand].join('_');
}
