import { describe, it, expect } from 'vitest';
import { extractRationale } from '../core/extractor.js';

describe('extractRationale', () => {
  it('extracts rationale from "because" clause', () => {
    const result = extractRationale('We use TypeScript because it provides type safety and better tooling support');
    expect(result).toBe('it provides type safety and better tooling support');
  });

  it('extracts rationale from "in order to" clause', () => {
    const result = extractRationale('We cache responses in order to reduce latency for repeated queries');
    expect(result).toBe('reduce latency for repeated queries');
  });

  it('extracts rationale from "this ensures" clause', () => {
    const result = extractRationale('Run migrations first. This ensures the database schema is up to date before deployment');
    expect(result).toBe('the database schema is up to date before deployment');
  });

  it('extracts rationale from "to prevent" clause', () => {
    const result = extractRationale('We validate inputs to prevent SQL injection attacks on the database');
    expect(result).toBe('SQL injection attacks on the database');
  });

  it('extracts rationale from "due to" clause', () => {
    const result = extractRationale('The service was migrated to Rust due to the need for lower memory usage and higher throughput');
    expect(result).toBe('the need for lower memory usage and higher throughput');
  });

  it('returns null for text without causal language', () => {
    expect(extractRationale('The server runs on port 8080')).toBeNull();
    expect(extractRationale('Deploy to production every Monday')).toBeNull();
  });

  it('returns null for empty or missing text', () => {
    expect(extractRationale('')).toBeNull();
  });

  it('rejects vague fragments like "because of this"', () => {
    expect(extractRationale('It failed because of this')).toBeNull();
  });

  it('rejects "due to that issue"', () => {
    expect(extractRationale('We stopped due to that')).toBeNull();
  });

  it('rejects very short rationale matches', () => {
    expect(extractRationale('because ok')).toBeNull();
  });

  it('rejects matches with fewer than 4 words', () => {
    expect(extractRationale('We did this because of reasons')).toBeNull();
  });

  it('does not match "since" (excluded as too often temporal)', () => {
    expect(extractRationale('Since Monday the server has been running fine')).toBeNull();
    expect(extractRationale('We refactored since the old code was unmaintainable and hard to test')).toBeNull();
  });

  it('extracts rationale from "so that" clause', () => {
    const result = extractRationale('We added retry logic so that transient network failures do not crash the pipeline');
    expect(result).toBe('transient network failures do not crash the pipeline');
  });

  it('extracts rationale from "the reason is" clause', () => {
    const result = extractRationale('The reason is that the database connection pool was exhausted under heavy load');
    expect(result).toBe('that the database connection pool was exhausted under heavy load');
  });
});
