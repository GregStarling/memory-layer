import { describe, expect, it } from 'vitest';

import { createCircuitBreaker } from '../core/circuit-breaker.js';

describe('circuit breaker', () => {
  it('opens after repeated failures and rejects until reset timeout elapses', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 10 });

    await expect(breaker.execute(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(breaker.execute(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(breaker.execute(async () => 'ok')).rejects.toThrow('Circuit breaker is open');
  });
});
