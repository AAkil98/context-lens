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
