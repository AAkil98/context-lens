import { describe, it, expect } from 'vitest';
import { fnv1a, fnv1aHex } from '../../../src/utils/hash.js';

describe('fnv1a', () => {
  it('returns the FNV offset basis for an empty string', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
  });

  it('returns known hash for "a"', () => {
    expect(fnv1a('a')).toBe(0xe40c292c);
  });

  it('returns known hash for "hello"', () => {
    expect(fnv1a('hello')).toBe(0x4f9f2cab);
  });

  it('returns known hash for "foobar"', () => {
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('is deterministic — same input always produces same output', () => {
    const input = 'determinism-check';
    const first = fnv1a(input);
    const second = fnv1a(input);
    const third = fnv1a(input);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('produces different outputs for different inputs', () => {
    const pairs: [string, string][] = [
      ['a', 'b'],
      ['hello', 'world'],
      ['abc', 'ab'],
      ['', 'a'],
    ];
    for (const [a, b] of pairs) {
      expect(fnv1a(a)).not.toBe(fnv1a(b));
    }
  });

  it('always returns a 32-bit unsigned integer', () => {
    const inputs = ['', 'a', 'test', 'longer string with spaces'];
    for (const input of inputs) {
      const result = fnv1a(input);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(result)).toBe(true);
    }
  });
});

describe('fnv1aHex', () => {
  it('returns an 8-character hex string', () => {
    const result = fnv1aHex('test');
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('pads with leading zeros when needed', () => {
    // The empty string hash 0x811c9dc5 has 8 hex chars naturally,
    // but any hash < 0x10000000 would need padding.
    const result = fnv1aHex('');
    expect(result).toHaveLength(8);
  });

  it('matches the hex representation of fnv1a', () => {
    const inputs = ['', 'a', 'hello', 'foobar', 'some longer text'];
    for (const input of inputs) {
      const numeric = fnv1a(input);
      const hex = fnv1aHex(input);
      expect(hex).toBe(numeric.toString(16).padStart(8, '0'));
    }
  });

  it('returns "811c9dc5" for an empty string', () => {
    expect(fnv1aHex('')).toBe('811c9dc5');
  });

  it('is deterministic', () => {
    const input = 'hex-determinism';
    expect(fnv1aHex(input)).toBe(fnv1aHex(input));
  });
});
