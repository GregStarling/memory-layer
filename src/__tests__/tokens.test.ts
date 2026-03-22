import { describe, expect, it } from 'vitest';

import {
  createModelTokenEstimator,
  createTiktokenEstimator,
  estimateTokens,
} from '../core/tokens.js';

describe('token estimators', () => {
  it('keeps legacy estimateTokens behavior intact', () => {
    expect(estimateTokens('a'.repeat(100))).toBe(29);
  });

  it('uses model-specific ratios', () => {
    const gptEstimator = createModelTokenEstimator('gpt-5');
    const claudeEstimator = createModelTokenEstimator('claude-sonnet');

    expect(gptEstimator('a'.repeat(100))).not.toBe(claudeEstimator('a'.repeat(100)));
  });

  it('falls back gracefully when tiktoken is unavailable', async () => {
    const estimator = await createTiktokenEstimator('gpt-5');
    expect(estimator('hello world')).toBeGreaterThan(0);
  });
});
