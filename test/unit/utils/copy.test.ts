import { describe, it, expect } from 'vitest';
import { deepCopy } from '../../../src/utils/copy.js';

describe('deepCopy', () => {
  describe('primitives', () => {
    it('passes through numbers', () => {
      expect(deepCopy(42)).toBe(42);
      expect(deepCopy(0)).toBe(0);
      expect(deepCopy(-3.14)).toBe(-3.14);
    });

    it('passes through strings', () => {
      expect(deepCopy('hello')).toBe('hello');
      expect(deepCopy('')).toBe('');
    });

    it('passes through booleans', () => {
      expect(deepCopy(true)).toBe(true);
      expect(deepCopy(false)).toBe(false);
    });

    it('passes through null', () => {
      expect(deepCopy(null)).toBeNull();
    });

    it('passes through undefined', () => {
      expect(deepCopy(undefined)).toBeUndefined();
    });
  });

  describe('plain objects', () => {
    it('copies a flat object', () => {
      const original = { a: 1, b: 'two', c: true };
      const copy = deepCopy(original);
      expect(copy).toEqual(original);
      expect(copy).not.toBe(original);
    });

    it('modifying the copy does not affect the original', () => {
      const original = { x: 10, y: 20 };
      const copy = deepCopy(original);
      copy.x = 999;
      expect(original.x).toBe(10);
    });

    it('copies an empty object', () => {
      const original = {};
      const copy = deepCopy(original);
      expect(copy).toEqual({});
      expect(copy).not.toBe(original);
    });
  });

  describe('arrays', () => {
    it('copies a flat array', () => {
      const original = [1, 2, 3];
      const copy = deepCopy(original);
      expect(copy).toEqual([1, 2, 3]);
      expect(copy).not.toBe(original);
    });

    it('modifying the copy does not affect the original', () => {
      const original = [10, 20, 30];
      const copy = deepCopy(original);
      copy[0] = 999;
      expect(original[0]).toBe(10);
    });

    it('copies an empty array', () => {
      const original: number[] = [];
      const copy = deepCopy(original);
      expect(copy).toEqual([]);
      expect(copy).not.toBe(original);
    });
  });

  describe('nested structures', () => {
    it('deep copies nested objects', () => {
      const original = { a: { b: { c: 42 } } };
      const copy = deepCopy(original);
      expect(copy).toEqual(original);
      expect(copy.a).not.toBe(original.a);
      expect(copy.a.b).not.toBe(original.a.b);
    });

    it('modifying deeply nested copy does not affect original', () => {
      const original = { a: { b: { c: 42 } } };
      const copy = deepCopy(original);
      copy.a.b.c = 999;
      expect(original.a.b.c).toBe(42);
    });

    it('deep copies arrays within objects', () => {
      const original = { items: [1, 2, 3], meta: { tags: ['a', 'b'] } };
      const copy = deepCopy(original);
      expect(copy).toEqual(original);
      expect(copy.items).not.toBe(original.items);
      expect(copy.meta.tags).not.toBe(original.meta.tags);
    });

    it('deep copies objects within arrays', () => {
      const original = [{ id: 1 }, { id: 2 }];
      const copy = deepCopy(original);
      expect(copy).toEqual(original);
      expect(copy[0]).not.toBe(original[0]);
      expect(copy[1]).not.toBe(original[1]);
    });
  });

  describe('Date instances', () => {
    it('copies a Date to a new Date with the same time', () => {
      const original = new Date('2025-06-15T12:00:00Z');
      const copy = deepCopy(original);
      expect(copy).toBeInstanceOf(Date);
      expect(copy.getTime()).toBe(original.getTime());
      expect(copy).not.toBe(original);
    });

    it('modifying the copy does not affect the original', () => {
      const original = new Date('2025-01-01T00:00:00Z');
      const copy = deepCopy(original);
      copy.setFullYear(2000);
      expect(original.getFullYear()).toBe(2025);
    });
  });

  describe('Map instances', () => {
    it('copies a Map', () => {
      const original = new Map<string, number>([['a', 1], ['b', 2]]);
      const copy = deepCopy(original);
      expect(copy).toBeInstanceOf(Map);
      expect(copy).not.toBe(original);
      expect(copy.get('a')).toBe(1);
      expect(copy.get('b')).toBe(2);
      expect(copy.size).toBe(2);
    });

    it('deep copies Map values', () => {
      const original = new Map<string, { x: number }>([['key', { x: 10 }]]);
      const copy = deepCopy(original);
      copy.get('key')!.x = 999;
      expect(original.get('key')!.x).toBe(10);
    });

    it('copies an empty Map', () => {
      const original = new Map();
      const copy = deepCopy(original);
      expect(copy).toBeInstanceOf(Map);
      expect(copy).not.toBe(original);
      expect(copy.size).toBe(0);
    });
  });

  describe('Set instances', () => {
    it('copies a Set', () => {
      const original = new Set([1, 2, 3]);
      const copy = deepCopy(original);
      expect(copy).toBeInstanceOf(Set);
      expect(copy).not.toBe(original);
      expect(copy.size).toBe(3);
      expect(copy.has(1)).toBe(true);
      expect(copy.has(2)).toBe(true);
      expect(copy.has(3)).toBe(true);
    });

    it('deep copies Set members that are objects', () => {
      const obj = { x: 10 };
      const original = new Set([obj]);
      const copy = deepCopy(original);
      const copyMember = [...copy][0] as { x: number };
      copyMember.x = 999;
      expect(obj.x).toBe(10);
    });

    it('copies an empty Set', () => {
      const original = new Set();
      const copy = deepCopy(original);
      expect(copy).toBeInstanceOf(Set);
      expect(copy).not.toBe(original);
      expect(copy.size).toBe(0);
    });
  });
});
