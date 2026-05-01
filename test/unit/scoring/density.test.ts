import { describe, it, expect } from 'vitest';
import {
  computeDensity,
  densitySampleCap,
  type DensitySegment,
} from '../../../src/scoring/density.js';
import { SimilarityEngine } from '../../../src/similarity.js';
import { fnv1a } from '../../../src/utils/hash.js';

function makeSeg(
  id: string,
  content: string,
  origin: string | null = null,
  tokenCount?: number,
): DensitySegment {
  return {
    id,
    content,
    contentHash: fnv1a(content),
    tokenCount: tokenCount ?? content.length,
    origin,
  };
}

function makeSim(): SimilarityEngine {
  return new SimilarityEngine();
}

describe('computeDensity', () => {
  // ── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty array returns windowDensity null', () => {
      const result = computeDensity([], makeSim());
      expect(result.windowDensity).toBeNull();
      expect(result.perSegment.size).toBe(0);
    });

    it('single segment returns density 1.0', () => {
      const seg = makeSeg(
        's1',
        'the quick brown fox jumps over the lazy dog near the river',
      );
      const result = computeDensity([seg], makeSim());
      const r = result.perSegment.get('s1')!;
      expect(r.density).toBe(1.0);
      expect(r.redundancy).toBe(0.0);
      expect(r.redundancyInfo).toBeNull();
      expect(r.tokenWaste).toBe(0);
      expect(result.windowDensity).toBe(1.0);
    });
  });

  // ── Identical segments ─────────────────────────────────────────

  describe('identical (duplicate) segments', () => {
    it('two identical non-adjacent segments produce density 0.0 for both', () => {
      const sim = makeSim();
      const content =
        'the quick brown fox jumps over the lazy dog near the river bank';
      // Three segments: s1, spacer, s2 (s2 is identical to s1 but non-adjacent)
      const s1 = makeSeg('s1', content);
      const spacer = makeSeg(
        'spacer',
        'quantum mechanics explores subatomic particles and wave functions deeply',
      );
      const s2 = makeSeg('s2', content);
      const result = computeDensity([s1, spacer, s2], sim);

      // s1 and s2 are identical and non-adjacent → redundancy 1.0 for both
      expect(result.perSegment.get('s1')!.redundancy).toBe(1.0);
      expect(result.perSegment.get('s1')!.density).toBe(0.0);
      expect(result.perSegment.get('s2')!.redundancy).toBe(1.0);
      expect(result.perSegment.get('s2')!.density).toBe(0.0);
    });
  });

  // ── Unrelated segments ─────────────────────────────────────────

  describe('unrelated segments', () => {
    it('unrelated non-adjacent segments produce density near 1.0', () => {
      const sim = makeSim();
      const s1 = makeSeg(
        's1',
        'the quick brown fox jumps over the lazy dog near the river bank',
      );
      const s2 = makeSeg(
        's2',
        'quantum mechanics explores subatomic particles and wave functions deeply',
      );
      const s3 = makeSeg(
        's3',
        'classical music composers from the baroque period created masterworks',
      );
      const result = computeDensity([s1, s2, s3], sim);

      // Each is distinct enough from non-adjacent peers
      expect(result.perSegment.get('s1')!.density).toBeGreaterThan(0.7);
      expect(result.perSegment.get('s3')!.density).toBeGreaterThan(0.7);
    });
  });

  // ── Adjacency exclusion ────────────────────────────────────────

  describe('adjacency exclusion', () => {
    it('adjacent similar segments are NOT counted as redundant', () => {
      const sim = makeSim();
      // Middle segment is similar to both neighbors but adjacent to both
      const s1 = makeSeg(
        's1',
        'user authentication login session token management security access control',
      );
      const s2 = makeSeg(
        's2',
        'user authentication session verification token management security checks',
      );
      const s3 = makeSeg(
        's3',
        'user authentication login session expiry management security audit trail',
      );
      const result = computeDensity([s1, s2, s3], sim);

      // s2 is adjacent to both s1 and s3 so neither counts as redundant for s2
      // s1 and s3 are non-adjacent to each other and similar
      // For s2, the only non-adjacent comparisons are none (both s1 and s3 are adjacent)
      // So s2 should have low redundancy
      const s2Result = result.perSegment.get('s2')!;
      expect(s2Result.redundancy).toBeLessThan(0.5);
    });

    it('non-adjacent identical segments are detected as redundant despite similar neighbors', () => {
      const sim = makeSim();
      const content =
        'user authentication login session token management and security access control measures';
      const s1 = makeSeg('s1', content);
      const s2 = makeSeg(
        's2',
        'quantum physics wave function collapse during observation of particles in a vacuum',
      );
      const s3 = makeSeg('s3', content);
      const result = computeDensity([s1, s2, s3], sim);

      // s1 and s3 are non-adjacent and identical → redundancy 1.0
      expect(result.perSegment.get('s1')!.redundancy).toBe(1.0);
      expect(result.perSegment.get('s3')!.redundancy).toBe(1.0);
    });
  });

  // ── Origin annotation ─────────────────────────────────────────

  describe('origin annotation', () => {
    it('annotates redundancy > 0.5 with sameOrigin true when origins match', () => {
      const sim = makeSim();
      const content =
        'the quick brown fox jumps over the lazy dog near the river bank';
      const s1 = makeSeg('s1', content, 'file-a');
      const spacer = makeSeg(
        'spacer',
        'quantum mechanics explores subatomic particles and wave functions deeply',
      );
      const s2 = makeSeg('s2', content, 'file-a');
      const result = computeDensity([s1, spacer, s2], sim);

      const info = result.perSegment.get('s1')!.redundancyInfo;
      expect(info).not.toBeNull();
      expect(info!.sameOrigin).toBe(true);
      expect(info!.maxSimilarity).toBe(1.0);
    });

    it('annotates redundancy > 0.5 with sameOrigin false when origins differ', () => {
      const sim = makeSim();
      const content =
        'the quick brown fox jumps over the lazy dog near the river bank';
      const s1 = makeSeg('s1', content, 'file-a');
      const spacer = makeSeg(
        'spacer',
        'quantum mechanics explores subatomic particles and wave functions deeply',
      );
      const s2 = makeSeg('s2', content, 'file-b');
      const result = computeDensity([s1, spacer, s2], sim);

      const info = result.perSegment.get('s1')!.redundancyInfo;
      expect(info).not.toBeNull();
      expect(info!.sameOrigin).toBe(false);
    });

    it('does not annotate when redundancy <= 0.5', () => {
      const sim = makeSim();
      const s1 = makeSeg(
        's1',
        'the quick brown fox jumps over the lazy dog near the river bank',
        'file-a',
      );
      const s2 = makeSeg(
        's2',
        'quantum mechanics explores subatomic particles and wave functions deeply',
        'file-a',
      );
      const s3 = makeSeg(
        's3',
        'classical music composers from the baroque period created masterworks and operas',
        'file-a',
      );
      const result = computeDensity([s1, s2, s3], sim);

      // s1's non-adjacent peer is s3 which is unrelated
      expect(result.perSegment.get('s1')!.redundancyInfo).toBeNull();
    });
  });

  // ── Token waste ────────────────────────────────────────────────

  describe('token waste', () => {
    it('tokenWaste = tokenCount * redundancy', () => {
      const sim = makeSim();
      const content =
        'the quick brown fox jumps over the lazy dog near the river bank';
      const s1 = makeSeg('s1', content, null, 100);
      const spacer = makeSeg(
        'spacer',
        'quantum mechanics explores subatomic particles and wave functions deeply',
        null,
        80,
      );
      const s2 = makeSeg('s2', content, null, 100);
      const result = computeDensity([s1, spacer, s2], sim);

      const r = result.perSegment.get('s1')!;
      // tokenWaste is computed inside computeDensity as seg.tokenCount * redundancy
      // For s1: tokenCount=100, redundancy=1.0, so tokenWaste = 100
      expect(r.tokenWaste).toBeCloseTo(100 * r.redundancy, 10);
      expect(r.tokenWaste).toBe(100);
    });
  });

  // ── Window density ─────────────────────────────────────────────

  describe('window density', () => {
    it('is a token-weighted mean of per-segment densities', () => {
      const sim = makeSim();
      const s1 = makeSeg(
        's1',
        'the quick brown fox jumps over the lazy dog near the river bank',
        null,
        50,
      );
      const s2 = makeSeg(
        's2',
        'quantum mechanics explores subatomic particles and wave functions deeply',
        null,
        100,
      );
      const result = computeDensity([s1, s2], sim);

      const d1 = result.perSegment.get('s1')!.density;
      const d2 = result.perSegment.get('s2')!.density;
      const expected = (d1 * 50 + d2 * 100) / 150;
      expect(result.windowDensity).toBeCloseTo(expected, 10);
    });
  });

  // ── Adaptive sampling (cl-spec-016 §3.1) ──────────────────────

  describe('densitySampleCap step function', () => {
    it('returns 30 at and below n=300', () => {
      expect(densitySampleCap(0)).toBe(30);
      expect(densitySampleCap(1)).toBe(30);
      expect(densitySampleCap(200)).toBe(30);
      expect(densitySampleCap(300)).toBe(30);
    });

    it('returns 15 between n=301 and n=500', () => {
      expect(densitySampleCap(301)).toBe(15);
      expect(densitySampleCap(400)).toBe(15);
      expect(densitySampleCap(500)).toBe(15);
    });

    it('returns 10 above n=500', () => {
      expect(densitySampleCap(501)).toBe(10);
      expect(densitySampleCap(1000)).toBe(10);
      expect(densitySampleCap(10000)).toBe(10);
    });

    it('is monotonically non-increasing in n (Invariant 6)', () => {
      let prev = densitySampleCap(0);
      for (let n = 0; n <= 1000; n += 50) {
        const cur = densitySampleCap(n);
        expect(cur).toBeLessThanOrEqual(prev);
        prev = cur;
      }
    });
  });
});
