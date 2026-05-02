/**
 * context-lens — Error hierarchy
 *
 * Base class + 12 typed subclasses. Each subclass has a fixed code constant.
 * @see cl-spec-007 §10
 */

export class ContextLensError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ContextLensError';
    this.code = code;
    this.details = details;
  }
}

export class ConfigurationError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_CONFIG', message, details);
    this.name = 'ConfigurationError';
  }
}

export class ValidationError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_ARGUMENT', message, details);
    this.name = 'ValidationError';
  }
}

export class SegmentNotFoundError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('SEGMENT_NOT_FOUND', message, details);
    this.name = 'SegmentNotFoundError';
  }
}

export class GroupNotFoundError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('GROUP_NOT_FOUND', message, details);
    this.name = 'GroupNotFoundError';
  }
}

export class DuplicateIdError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('DUPLICATE_ID', message, details);
    this.name = 'DuplicateIdError';
  }
}

export class InvalidStateError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_STATE', message, details);
    this.name = 'InvalidStateError';
  }
}

export class ProtectionError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('PROTECTION_VIOLATION', message, details);
    this.name = 'ProtectionError';
  }
}

export class MembershipError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('MEMBERSHIP_VIOLATION', message, details);
    this.name = 'MembershipError';
  }
}

export class CompactionError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COMPACTION_NOT_SHORTER', message, details);
    this.name = 'CompactionError';
  }
}

export class SplitError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('SPLIT_INVALID_OUTPUT', message, details);
    this.name = 'SplitError';
  }
}

export class RestoreError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('RESTORE_MISSING_CONTENT', message, details);
    this.name = 'RestoreError';
  }
}

export class ProviderError extends ContextLensError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('PROVIDER_ERROR', message, details);
    this.name = 'ProviderError';
  }
}

// ─── Lifecycle errors (cl-spec-015 §7.2) ───────────────────────────────
//
// DisposedError and DisposalError deliberately bypass ContextLensError to
// inherit native classes — DisposedError extends Error, DisposalError extends
// AggregateError so constituent errors are exposed through the standard
// `errors` array.

export type OriginTag = 'handler' | 'integration';

export interface OriginTaggedError {
  readonly cause: unknown;
  readonly origin: OriginTag;
  readonly index: number;
}

/** @internal */
export function tagOrigin(error: unknown, origin: OriginTag, index: number): OriginTaggedError {
  return { cause: error, origin, index };
}

/** @internal */
export function isHandlerOriginTag(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<OriginTaggedError>;
  return v.origin === 'handler' && typeof v.index === 'number';
}

/**
 * Raised by the disposed-state guard at the top of every public method on a
 * disposed instance, and by the mutating-method guard while disposal is in
 * progress. Carries the instance identifier and the method that was attempted.
 * @see cl-spec-015 §7.2
 */
export class DisposedError extends Error {
  readonly instanceId: string;
  readonly attemptedMethod: string;

  constructor(instanceId: string, attemptedMethod: string, state: 'disposed' | 'disposing') {
    super(`ContextLens instance ${instanceId} is ${state}; cannot call ${attemptedMethod}()`);
    this.name = 'DisposedError';
    this.instanceId = instanceId;
    this.attemptedMethod = attemptedMethod;
  }
}

/**
 * Raised at most once per disposal, by `dispose()` itself, when one or more
 * caller-supplied callbacks (handlers in step 2 or integration teardown
 * callbacks in step 3) threw during teardown. The instance is fully disposed
 * when this error is thrown — DisposalError is informational, not a rollback.
 * Constituent errors are exposed through `AggregateError.errors`.
 * @see cl-spec-015 §7.2
 */
export class DisposalError extends AggregateError {
  readonly instanceId: string;

  constructor(instanceId: string, errors: unknown[]) {
    const handlerCount = errors.filter(isHandlerOriginTag).length;
    const integrationCount = errors.length - handlerCount;
    super(
      errors,
      `ContextLens instance ${instanceId} disposed with ${errors.length} callback errors (${handlerCount} handlers, ${integrationCount} integrations)`,
    );
    this.name = 'DisposalError';
    this.instanceId = instanceId;
  }
}
