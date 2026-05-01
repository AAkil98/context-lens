import { describe, it, expect } from 'vitest';
import {
  computeTrigrams,
  jaccardSimilarity,
  cosineSimilarity,
  SimilarityEngine,
} from '../../src/similarity.js';
import type { EmbeddingLookup } from '../../src/similarity.js';

// ─── computeTrigrams ─────────────────────────────────────────────

describe('computeTrigrams', () => {
  it('"hello" produces {"hel","ell","llo"}', () => {
    const result = computeTrigrams('hello');
    expect(result).toEqual(new Set(['hel', 'ell', 'llo']));
  });

  it('empty string returns empty set', () => {
    expect(computeTrigrams('')).toEqual(new Set());
  });

  it('string shorter than 3 chars returns empty set', () => {
    expect(computeTrigrams('ab')).toEqual(new Set());
  });

  it('exactly 3 chars returns one trigram', () => {
    expect(computeTrigrams('abc')).toEqual(new Set(['abc']));
  });

  it('is case-insensitive', () => {
    const upper = computeTrigrams('HELLO');
    const lower = computeTrigrams('hello');
    expect(upper).toEqual(lower);
  });

  it('handles unicode text', () => {
    const result = computeTrigrams('\u00e9t\u00e9');
    // "été" lowercased is "été" → trigrams: "été"
    expect(result.size).toBeGreaterThan(0);
    // Check that the set contains a 3-char substring from the lowercased input
    for (const tri of result) {
      expect(tri.length).toBe(3);
    }
  });

  it('handles mixed-case unicode', () => {
    const a = computeTrigrams('\u00c9T\u00c9S');
    const b = computeTrigrams('\u00e9t\u00e9s');
    expect(a).toEqual(b);
  });
});

// ─── jaccardSimilarity ──────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('identical sets return 1.0', () => {
    const s = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(s, s)).toBe(1.0);
  });

  it('disjoint sets return 0.0', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    expect(jaccardSimilarity(a, b)).toBe(0.0);
  });

  it('known overlap returns correct ratio', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection = {b, c} = 2, union = {a, b, c, d} = 4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5, 10);
  });

  it('is symmetric: jaccard(a, b) === jaccard(b, a)', () => {
    const a = new Set(['x', 'y', 'z']);
    const b = new Set(['y', 'z', 'w']);
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });

  it('both empty returns 1.0', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1.0);
  });

  it('one empty, one non-empty returns 0.0', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0.0);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0.0);
  });

  it('superset/subset gives correct ratio', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['a', 'b', 'c']);
    // intersection = 2, union = 3
    expect(jaccardSimilarity(a, b)).toBeCloseTo(2 / 3, 10);
  });
});

// ─── cosineSimilarity ───────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('identical vectors return 1.0', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 10);
  });

  it('orthogonal vectors return 0.0', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 10);
  });

  it('zero vector returns 0.0', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0.0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0.0);
  });

  it('both zero vectors return 0.0', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0.0);
  });

  it('parallel but scaled vectors return 1.0', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1.0, 10);
  });

  it('anti-parallel vectors return -1.0', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 10);
  });
});

// ─── SimilarityEngine ───────────────────────────────────────────

describe('SimilarityEngine', () => {
  it('cache hit on second call returns same result', () => {
    const engine = new SimilarityEngine();
    const first = engine.computeSimilarity(1, 'hello world', 2, 'world hello');
    const second = engine.computeSimilarity(1, 'hello world', 2, 'world hello');
    expect(second).toBe(first);
    expect(engine.cacheEntryCount).toBe(1);
  });

  it('ordered-key symmetry: (a,b) === (b,a)', () => {
    const engine = new SimilarityEngine();
    const ab = engine.computeSimilarity(10, 'foo bar', 20, 'baz qux');
    const ba = engine.computeSimilarity(20, 'baz qux', 10, 'foo bar');
    expect(ba).toBe(ab);
    // Only one cache entry because the ordered key is the same
    expect(engine.cacheEntryCount).toBe(1);
  });

  it('invalidateContentHash removes entries involving that hash', () => {
    const engine = new SimilarityEngine();
    engine.computeSimilarity(1, 'aaa bbb', 2, 'ccc ddd');
    engine.computeSimilarity(1, 'aaa bbb', 3, 'eee fff');
    engine.computeSimilarity(2, 'ccc ddd', 3, 'eee fff');
    expect(engine.cacheEntryCount).toBe(3);

    engine.invalidateContentHash(1);
    // Only the pair (2,3) should survive
    expect(engine.cacheEntryCount).toBe(1);
  });

  it('clearCache resets all entries', () => {
    const engine = new SimilarityEngine();
    engine.computeSimilarity(1, 'text a', 2, 'text b');
    engine.computeSimilarity(3, 'text c', 4, 'text d');
    expect(engine.cacheEntryCount).toBe(2);

    engine.clearCache();
    expect(engine.cacheEntryCount).toBe(0);
  });

  it('dispatches to cosine when EmbeddingLookup returns vectors', () => {
    const engine = new SimilarityEngine();
    const vectors = new Map<number, number[]>([
      [1, [1, 0, 0]],
      [2, [0, 1, 0]],
    ]);
    const lookup: EmbeddingLookup = { getVector: (hash) => vectors.get(hash) };
    engine.setEmbeddingLookup(lookup);

    const score = engine.computeSimilarity(1, 'ignored', 2, 'ignored');
    // Orthogonal vectors => cosine = 0.0
    expect(score).toBeCloseTo(0.0, 10);
  });

  it('falls back to Jaccard when EmbeddingLookup returns undefined for one hash', () => {
    const engine = new SimilarityEngine();
    const vectors = new Map<number, number[]>([
      [1, [1, 0, 0]],
      // hash 2 intentionally missing
    ]);
    const lookup: EmbeddingLookup = { getVector: (hash) => vectors.get(hash) };
    engine.setEmbeddingLookup(lookup);

    // Both texts share trigrams, so Jaccard should be > 0
    const score = engine.computeSimilarity(1, 'hello world', 2, 'hello world');
    expect(score).toBe(1.0);
  });

  it('uses Jaccard when no EmbeddingLookup is set', () => {
    const engine = new SimilarityEngine();
    // No lookup set, so trigram/Jaccard mode
    const score = engine.computeSimilarity(1, 'hello world', 2, 'hello world');
    // Same trigrams => Jaccard = 1.0
    expect(score).toBe(1.0);
  });

  it('same content (same hash + same text) returns 1.0 immediately', () => {
    const engine = new SimilarityEngine();
    const score = engine.computeSimilarity(42, 'identical', 42, 'identical');
    expect(score).toBe(1.0);
    // No cache entry needed for identity shortcut
    expect(engine.cacheEntryCount).toBe(0);
  });

  it('setEmbeddingLookup(null) reverts to Jaccard mode', () => {
    const engine = new SimilarityEngine();
    const vectors = new Map<number, number[]>([
      [1, [1, 0, 0]],
      [2, [0, 1, 0]],
    ]);
    engine.setEmbeddingLookup({ getVector: (hash) => vectors.get(hash) });
    engine.setEmbeddingLookup(null);

    // Now in Jaccard mode; text-based similarity
    const score = engine.computeSimilarity(1, 'hello world', 2, 'hello world');
    expect(score).toBe(1.0);
  });

  it('cosine result is clamped to [0, 1]', () => {
    const engine = new SimilarityEngine();
    // Anti-parallel vectors would normally produce -1.0
    const vectors = new Map<number, number[]>([
      [1, [1, 0]],
      [2, [-1, 0]],
    ]);
    engine.setEmbeddingLookup({ getVector: (hash) => vectors.get(hash) });

    const score = engine.computeSimilarity(1, 'x', 2, 'y');
    // Clamped to 0
    expect(score).toBe(0);
  });

  it('respects custom cache size', () => {
    const engine = new SimilarityEngine(2);
    engine.computeSimilarity(1, 'aaa', 2, 'bbb');
    engine.computeSimilarity(3, 'ccc', 4, 'ddd');
    engine.computeSimilarity(5, 'eee', 6, 'fff');
    // Cache size is 2, so the oldest entry was evicted
    expect(engine.cacheEntryCount).toBe(2);
  });

  // ── Memory management hooks (cl-spec-007 §8.9) ─────────────

  describe('Memory management hooks', () => {
    it('getEntryCount + getMaxEntries reflect cache state', () => {
      const engine = new SimilarityEngine(10);
      expect(engine.getEntryCount()).toBe(0);
      expect(engine.getMaxEntries()).toBe(10);

      engine.computeSimilarity(1, 'aaa', 2, 'bbb');
      engine.computeSimilarity(3, 'ccc', 4, 'ddd');
      expect(engine.getEntryCount()).toBe(2);
    });

    it('setCacheSize shrinks and returns evicted count', () => {
      const engine = new SimilarityEngine(10);
      for (let i = 1; i <= 5; i++) {
        engine.computeSimilarity(i, `c${i}a`, i + 100, `c${i}b`);
      }
      expect(engine.getEntryCount()).toBe(5);

      const evicted = engine.setCacheSize(2);
      expect(evicted).toBe(3);
      expect(engine.getEntryCount()).toBe(2);
      expect(engine.getMaxEntries()).toBe(2);
    });

    it('setCacheSize(0) drops all entries', () => {
      const engine = new SimilarityEngine(10);
      engine.computeSimilarity(1, 'aaa', 2, 'bbb');
      engine.setCacheSize(0);
      expect(engine.getEntryCount()).toBe(0);
      expect(engine.getMaxEntries()).toBe(0);
    });
  });
});
