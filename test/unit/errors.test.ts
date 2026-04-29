import { describe, it, expect } from 'vitest';
import {
  ContextLensError,
  ConfigurationError,
  ValidationError,
  SegmentNotFoundError,
  GroupNotFoundError,
  DuplicateIdError,
  InvalidStateError,
  ProtectionError,
  MembershipError,
  CompactionError,
  SplitError,
  RestoreError,
  ProviderError,
  DisposedError,
  DisposalError,
  tagOrigin,
  isHandlerOriginTag,
} from '../../src/errors.js';

const subclasses = [
  { Cls: ConfigurationError, code: 'INVALID_CONFIG', name: 'ConfigurationError' },
  { Cls: ValidationError, code: 'INVALID_ARGUMENT', name: 'ValidationError' },
  { Cls: SegmentNotFoundError, code: 'SEGMENT_NOT_FOUND', name: 'SegmentNotFoundError' },
  { Cls: GroupNotFoundError, code: 'GROUP_NOT_FOUND', name: 'GroupNotFoundError' },
  { Cls: DuplicateIdError, code: 'DUPLICATE_ID', name: 'DuplicateIdError' },
  { Cls: InvalidStateError, code: 'INVALID_STATE', name: 'InvalidStateError' },
  { Cls: ProtectionError, code: 'PROTECTION_VIOLATION', name: 'ProtectionError' },
  { Cls: MembershipError, code: 'MEMBERSHIP_VIOLATION', name: 'MembershipError' },
  { Cls: CompactionError, code: 'COMPACTION_NOT_SHORTER', name: 'CompactionError' },
  { Cls: SplitError, code: 'SPLIT_INVALID_OUTPUT', name: 'SplitError' },
  { Cls: RestoreError, code: 'RESTORE_MISSING_CONTENT', name: 'RestoreError' },
  { Cls: ProviderError, code: 'PROVIDER_ERROR', name: 'ProviderError' },
] as const;

describe('ContextLensError (base)', () => {
  it('extends Error', () => {
    const err = new ContextLensError('TEST_CODE', 'base message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ContextLensError);
  });

  it('sets code, message, and name', () => {
    const err = new ContextLensError('TEST_CODE', 'base message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('base message');
    expect(err.name).toBe('ContextLensError');
  });

  it('details is undefined when not provided', () => {
    const err = new ContextLensError('X', 'msg');
    expect(err.details).toBeUndefined();
  });

  it('details is the provided record when given', () => {
    const details = { key: 'value', count: 42 };
    const err = new ContextLensError('X', 'msg', details);
    expect(err.details).toEqual({ key: 'value', count: 42 });
  });
});

describe.each(subclasses)('$name', ({ Cls, code, name }) => {
  it('extends both Error and ContextLensError', () => {
    const err = new Cls('test message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ContextLensError);
    expect(err).toBeInstanceOf(Cls);
  });

  it(`has fixed code "${code}"`, () => {
    const err = new Cls('test message');
    expect(err.code).toBe(code);
  });

  it(`has name "${name}"`, () => {
    const err = new Cls('test message');
    expect(err.name).toBe(name);
  });

  it('passes message through', () => {
    const err = new Cls('specific failure reason');
    expect(err.message).toBe('specific failure reason');
  });

  it('details is undefined when not provided', () => {
    const err = new Cls('msg');
    expect(err.details).toBeUndefined();
  });

  it('details is the provided record when given', () => {
    const details = { segmentId: 'seg-1', extra: true };
    const err = new Cls('msg', details);
    expect(err.details).toEqual({ segmentId: 'seg-1', extra: true });
  });

  it('passes instanceof checks for ContextLensError and own class', () => {
    const err = new Cls('msg');
    expect(err instanceof ContextLensError).toBe(true);
    expect(err instanceof Cls).toBe(true);
  });
});

// ─── Lifecycle errors (cl-spec-015 §7.2) ─────────────────────────

describe('DisposedError', () => {
  it('extends Error and DisposedError, but not ContextLensError', () => {
    const err = new DisposedError('cl-1-abc123', 'add', 'disposed');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DisposedError);
    expect(err).not.toBeInstanceOf(ContextLensError);
  });

  it('has name "DisposedError"', () => {
    const err = new DisposedError('cl-1-abc123', 'add', 'disposed');
    expect(err.name).toBe('DisposedError');
  });

  it('carries instanceId and attemptedMethod from constructor', () => {
    const err = new DisposedError('cl-42-xyz789', 'evict', 'disposed');
    expect(err.instanceId).toBe('cl-42-xyz789');
    expect(err.attemptedMethod).toBe('evict');
  });

  it('formats message for the disposed state', () => {
    const err = new DisposedError('cl-1-abc123', 'add', 'disposed');
    expect(err.message).toBe('ContextLens instance cl-1-abc123 is disposed; cannot call add()');
  });

  it('formats message for the disposing state', () => {
    const err = new DisposedError('cl-1-abc123', 'add', 'disposing');
    expect(err.message).toBe('ContextLens instance cl-1-abc123 is disposing; cannot call add()');
  });
});

describe('DisposalError', () => {
  it('extends AggregateError and DisposalError, but not ContextLensError', () => {
    const err = new DisposalError('cl-1-abc123', [new Error('boom')]);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AggregateError);
    expect(err).toBeInstanceOf(DisposalError);
    expect(err).not.toBeInstanceOf(ContextLensError);
  });

  it('has name "DisposalError"', () => {
    const err = new DisposalError('cl-1-abc123', []);
    expect(err.name).toBe('DisposalError');
  });

  it('exposes constituent errors via AggregateError.errors', () => {
    const e1 = new Error('first');
    const e2 = new Error('second');
    const err = new DisposalError('cl-1-abc123', [e1, e2]);
    expect(err.errors).toHaveLength(2);
    expect(err.errors[0]).toBe(e1);
    expect(err.errors[1]).toBe(e2);
  });

  it('carries instanceId from constructor', () => {
    const err = new DisposalError('cl-99-zzz000', []);
    expect(err.instanceId).toBe('cl-99-zzz000');
  });

  it('counts tagged handlers vs integrations in the default message', () => {
    const e1 = tagOrigin(new Error('h1'), 'handler', 0);
    const e2 = tagOrigin(new Error('h2'), 'handler', 1);
    const e3 = tagOrigin(new Error('i1'), 'integration', 0);
    const err = new DisposalError('cl-1-abc123', [e1, e2, e3]);
    expect(err.message).toBe(
      'ContextLens instance cl-1-abc123 disposed with 3 callback errors (2 handlers, 1 integrations)',
    );
  });

  it('reports zero handlers when only untagged errors are present', () => {
    const err = new DisposalError('cl-1-abc123', [new Error('untagged')]);
    expect(err.message).toContain('1 callback errors (0 handlers, 1 integrations)');
  });
});

describe('tagOrigin / isHandlerOriginTag', () => {
  it('tagOrigin returns the documented shape', () => {
    const cause = new Error('boom');
    const tagged = tagOrigin(cause, 'handler', 3);
    expect(tagged.cause).toBe(cause);
    expect(tagged.origin).toBe('handler');
    expect(tagged.index).toBe(3);
  });

  it('isHandlerOriginTag is true for handler-origin tags', () => {
    expect(isHandlerOriginTag(tagOrigin(new Error(), 'handler', 0))).toBe(true);
  });

  it('isHandlerOriginTag is false for integration-origin tags', () => {
    expect(isHandlerOriginTag(tagOrigin(new Error(), 'integration', 0))).toBe(false);
  });

  it('isHandlerOriginTag is false for non-tagged values', () => {
    expect(isHandlerOriginTag(new Error('plain'))).toBe(false);
    expect(isHandlerOriginTag(null)).toBe(false);
    expect(isHandlerOriginTag(undefined)).toBe(false);
    expect(isHandlerOriginTag('string')).toBe(false);
    expect(isHandlerOriginTag({ origin: 'handler' })).toBe(false);  // missing index
  });
});
