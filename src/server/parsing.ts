import { normalizeTemporalId } from '../contracts/temporal.js';

type ParseFailure = (message: string) => never;

interface NumberParseOptions {
  name: string;
  integer?: boolean;
  min?: number;
  max?: number;
}

function coerceNumber(
  value: unknown,
  options: NumberParseOptions,
  fail: ParseFailure,
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    fail(`Invalid field: ${options.name}`);
  }
  if (options.integer && !Number.isInteger(parsed)) {
    fail(`Invalid field: ${options.name}`);
  }
  if (options.min != null && parsed < options.min) {
    fail(`Invalid field: ${options.name}`);
  }
  if (options.max != null && parsed > options.max) {
    fail(`Invalid field: ${options.name}`);
  }
  return parsed;
}

export function parseOptionalFiniteNumber(
  value: unknown,
  options: NumberParseOptions,
  fail: ParseFailure,
): number | undefined {
  return coerceNumber(value, options, fail);
}

export function parseOptionalFiniteInteger(
  value: unknown,
  options: NumberParseOptions,
  fail: ParseFailure,
): number | undefined {
  return coerceNumber(value, { ...options, integer: true }, fail);
}

export function parseOptionalTemporalIdValue(
  value: unknown,
  name: string,
  fail: ParseFailure,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  try {
    return normalizeTemporalId(value as string | number | bigint);
  } catch {
    fail(`Invalid field: ${name}`);
  }
}
