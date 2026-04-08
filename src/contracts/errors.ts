export type MemoryErrorCode =
  | 'validation_error'
  | 'resource_not_found'
  | 'scope_mismatch'
  | 'conflict'
  | 'provider_unavailable'
  | 'not_implemented';

export interface MemoryErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class MemoryDomainError extends Error {
  readonly code: MemoryErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: MemoryErrorCode,
    status: number,
    options: MemoryErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = options.details;
  }
}

export class ValidationError extends MemoryDomainError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, 'validation_error', 400, options);
  }
}

export class ResourceNotFoundError extends MemoryDomainError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, 'resource_not_found', 404, options);
  }
}

export class ScopeMismatchError extends MemoryDomainError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, 'scope_mismatch', 404, options);
  }
}

export class ConflictError extends MemoryDomainError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, 'conflict', 409, options);
  }
}

export class ProviderUnavailableError extends MemoryDomainError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, 'provider_unavailable', 503, options);
  }
}

export class NotImplementedError extends MemoryDomainError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, 'not_implemented', 501, options);
  }
}

export function isMemoryDomainError(error: unknown): error is MemoryDomainError {
  return error instanceof MemoryDomainError;
}
