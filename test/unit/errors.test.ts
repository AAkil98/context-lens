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
