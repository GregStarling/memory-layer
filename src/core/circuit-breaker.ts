export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export interface CircuitBreaker {
  readonly state: CircuitState;
  execute<T>(run: () => Promise<T>): Promise<T>;
}

export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  const failureThreshold = options.failureThreshold ?? 3;
  const resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
  let state: CircuitState = 'closed';
  let failures = 0;
  let openedAt = 0;

  function canProbe(): boolean {
    return state === 'open' && Date.now() - openedAt >= resetTimeoutMs;
  }

  return {
    get state() {
      return canProbe() ? 'half_open' : state;
    },

    async execute<T>(run: () => Promise<T>): Promise<T> {
      if (state === 'open' && !canProbe()) {
        throw new Error('Circuit breaker is open');
      }
      if (canProbe()) {
        state = 'half_open';
      }

      try {
        const result = await run();
        failures = 0;
        state = 'closed';
        return result;
      } catch (error) {
        failures += 1;
        if (failures >= failureThreshold || state === 'half_open') {
          state = 'open';
          openedAt = Date.now();
        }
        throw error;
      }
    },
  };
}
