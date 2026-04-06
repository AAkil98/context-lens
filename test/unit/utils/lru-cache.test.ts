import { describe, it, expect } from 'vitest';
import { LruCache } from '../../../src/utils/lru-cache.js';

describe('LruCache', () => {
  describe('get / set / has', () => {
    it('returns undefined for a missing key', () => {
      const cache = new LruCache<string, number>(5);
      expect(cache.get('missing')).toBeUndefined();
    });

    it('stores and retrieves a value', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      expect(cache.get('a')).toBe(1);
    });

    it('has() returns true for existing keys and false for missing', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
    });

    it('handles multiple keys', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
    });
  });

  describe('size', () => {
    it('starts at 0', () => {
      const cache = new LruCache<string, number>(5);
      expect(cache.size).toBe(0);
    });

    it('tracks inserts', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
    });

    it('does not grow when overwriting an existing key', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      cache.set('a', 2);
      expect(cache.size).toBe(1);
    });

    it('does not exceed maxSize', () => {
      const cache = new LruCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);
      expect(cache.size).toBe(3);
    });
  });

  describe('eviction', () => {
    it('evicts the least recently used item when exceeding maxSize', () => {
      const cache = new LruCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // should evict 'a'
      expect(cache.has('a')).toBe(false);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
    });

    it('get() promotes an item to most recently used', () => {
      const cache = new LruCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a'); // promote 'a', so 'b' is now LRU
      cache.set('c', 3); // should evict 'b'
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(true);
    });

    it('set() with existing key promotes it to most recently used', () => {
      const cache = new LruCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('a', 10); // overwrite + promote 'a', 'b' is now LRU
      cache.set('c', 3); // should evict 'b'
      expect(cache.get('a')).toBe(10);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(true);
    });

    it('evicts in LRU order through a longer sequence', () => {
      const cache = new LruCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Order MRU->LRU: c, b, a

      cache.set('d', 4); // evicts 'a'
      expect(cache.has('a')).toBe(false);

      cache.set('e', 5); // evicts 'b'
      expect(cache.has('b')).toBe(false);

      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
      expect(cache.get('e')).toBe(5);
    });
  });

  describe('overwrite', () => {
    it('updates value without changing size', () => {
      const cache = new LruCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('a', 100);
      expect(cache.size).toBe(2);
      expect(cache.get('a')).toBe(100);
    });

    it('does not evict when overwriting within capacity', () => {
      const cache = new LruCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('a', 10); // overwrite, not a new entry
      expect(cache.size).toBe(2);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(true);
    });
  });

  describe('delete', () => {
    it('removes an existing key and returns true', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      expect(cache.delete('a')).toBe(true);
      expect(cache.has('a')).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('returns false for a missing key', () => {
      const cache = new LruCache<string, number>(5);
      expect(cache.delete('missing')).toBe(false);
    });

    it('reduces size', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.delete('a');
      expect(cache.size).toBe(1);
    });

    it('deleted key is no longer retrievable', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      cache.delete('a');
      expect(cache.get('a')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('empties the cache', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(false);
    });

    it('allows reuse after clearing', () => {
      const cache = new LruCache<string, number>(2);
      cache.set('a', 1);
      cache.clear();
      cache.set('b', 2);
      expect(cache.size).toBe(1);
      expect(cache.get('b')).toBe(2);
    });
  });

  describe('entries', () => {
    it('iterates in MRU to LRU order', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // MRU->LRU: c, b, a
      const result = [...cache.entries()];
      expect(result).toEqual([
        ['c', 3],
        ['b', 2],
        ['a', 1],
      ]);
    });

    it('reflects get() promotion in iteration order', () => {
      const cache = new LruCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a'); // promote 'a' to MRU
      // MRU->LRU: a, c, b
      const result = [...cache.entries()];
      expect(result).toEqual([
        ['a', 1],
        ['c', 3],
        ['b', 2],
      ]);
    });

    it('returns empty iterator for empty cache', () => {
      const cache = new LruCache<string, number>(5);
      const result = [...cache.entries()];
      expect(result).toEqual([]);
    });
  });
});
