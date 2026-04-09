import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../../src/utils/ring-buffer.js';

describe('RingBuffer', () => {
  describe('push and size', () => {
    it('starts with size 0', () => {
      const buf = new RingBuffer<number>(5);
      expect(buf.size).toBe(0);
    });

    it('increments size on push', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(1);
      expect(buf.size).toBe(1);
      buf.push(2);
      expect(buf.size).toBe(2);
    });

    it('size does not exceed capacity', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      expect(buf.size).toBe(3);
    });
  });

  describe('toArray', () => {
    it('returns items in insertion order (oldest first)', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      expect(buf.toArray()).toEqual([10, 20, 30]);
    });

    it('returns empty array for empty buffer', () => {
      const buf = new RingBuffer<number>(3);
      expect(buf.toArray()).toEqual([]);
    });

    it('reflects eviction — oldest items removed on overflow', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4); // evicts 1
      expect(buf.toArray()).toEqual([2, 3, 4]);
    });

    it('handles multiple overflows correctly', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4); // evicts 1
      buf.push(5); // evicts 2
      expect(buf.toArray()).toEqual([3, 4, 5]);
    });
  });

  describe('overflow and wrapping', () => {
    it('evicts oldest items on overflow', () => {
      const buf = new RingBuffer<string>(2);
      buf.push('a');
      buf.push('b');
      buf.push('c'); // evicts 'a'
      expect(buf.toArray()).toEqual(['b', 'c']);
      expect(buf.size).toBe(2);
    });

    it('wraps around capacity multiple times', () => {
      const buf = new RingBuffer<number>(3);
      // Push 9 items into a buffer of capacity 3 (3 full wraps)
      for (let i = 1; i <= 9; i++) {
        buf.push(i);
      }
      expect(buf.size).toBe(3);
      expect(buf.toArray()).toEqual([7, 8, 9]);
    });

    it('handles capacity of 1', () => {
      const buf = new RingBuffer<number>(1);
      buf.push(10);
      expect(buf.toArray()).toEqual([10]);
      buf.push(20);
      expect(buf.toArray()).toEqual([20]);
      expect(buf.size).toBe(1);
    });
  });

  describe('get', () => {
    it('retrieves items by logical index', () => {
      const buf = new RingBuffer<string>(5);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      expect(buf.get(0)).toBe('a');
      expect(buf.get(1)).toBe('b');
      expect(buf.get(2)).toBe('c');
    });

    it('returns correct items after overflow', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4); // evicts 1, buffer is now [2, 3, 4]
      expect(buf.get(0)).toBe(2);
      expect(buf.get(1)).toBe(3);
      expect(buf.get(2)).toBe(4);
    });

    it('returns undefined for negative index', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(1);
      expect(buf.get(-1)).toBeUndefined();
    });

    it('returns undefined for index equal to size', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      expect(buf.get(2)).toBeUndefined();
    });

    it('returns undefined for index beyond size', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(1);
      expect(buf.get(10)).toBeUndefined();
    });

    it('returns undefined on empty buffer', () => {
      const buf = new RingBuffer<number>(5);
      expect(buf.get(0)).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('resets size to 0', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.clear();
      expect(buf.size).toBe(0);
    });

    it('returns empty array after clear', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.clear();
      expect(buf.toArray()).toEqual([]);
    });

    it('get returns undefined after clear', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(1);
      buf.clear();
      expect(buf.get(0)).toBeUndefined();
    });

    it('allows reuse after clear', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.clear();
      buf.push(10);
      buf.push(20);
      expect(buf.size).toBe(2);
      expect(buf.toArray()).toEqual([10, 20]);
    });

    it('wrapping works correctly after clear', () => {
      const buf = new RingBuffer<number>(2);
      buf.push(1);
      buf.push(2);
      buf.push(3); // wrap once
      buf.clear();
      buf.push(10);
      buf.push(20);
      buf.push(30); // wrap again after clear
      expect(buf.toArray()).toEqual([20, 30]);
    });
  });
});
