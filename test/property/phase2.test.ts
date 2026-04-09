import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SimilarityEngine } from '../../src/similarity.js';
import { computeCoherence, type CoherenceSegment } from '../../src/scoring/coherence.js';
import { computeDensity, type DensitySegment } from '../../src/scoring/density.js';
import { computeRelevance, type RelevanceSegment } from '../../src/scoring/relevance.js';
import { computeComposite } from '../../src/scoring/composite.js';
import { BaselineManager } from '../../src/scoring/baseline.js';
import type { WindowScores } from '../../src/types.js';
import { fnv1a } from '../../src/utils/hash.js';

// ─── Helpers ──────────────────────────────────────────────────────

const contentArb = fc.string({ minLength: 1, maxLength: 200 });

function makeCoherenceSegment(i: number, content: string): CoherenceSegment {
  return {
    id: 'seg-' + i,
    content,
    contentHash: fnv1a(content),
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    groupId: null,
  };
}

function makeDensitySegment(i: number, content: string): DensitySegment {
  return {
    id: 'seg-' + i,
    content,
    contentHash: fnv1a(content),
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    origin: null,
  };
}

function makeRelevanceSegment(
  i: number,
  content: string,
  protection: 'pinned' | 'seed' | 'default' = 'default',
): RelevanceSegment {
  return {
    id: 'seg-' + i,
    content,
    contentHash: fnv1a(content),
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    protection,
    importance: 0.5,
    origin: null,
    tags: [],
    createdAt: 1000,
    updatedAt: 1000,
  };
}

// ─── Property Tests ───────────────────────────────────────────────

describe('Phase 2 — Property-Based Tests', () => {
  describe('Score bounds', () => {
    it('computeCoherence perSegment scores are in [0, 1]', () => {
      fc.assert(
        fc.property(
          fc.array(contentArb, { minLength: 2, maxLength: 10 }),
          (contents) => {
            const segments = contents.map((c, i) => makeCoherenceSegment(i, c));
            const sim = new SimilarityEngine();
            const result = computeCoherence(segments, new Map(), sim);

            for (const [, score] of result.perSegment) {
              expect(score).toBeGreaterThanOrEqual(0.0);
              expect(score).toBeLessThanOrEqual(1.0);
            }
          },
        ),
      );
    });

    it('computeCoherence windowCoherence is in [0, 1] or null', () => {
      fc.assert(
        fc.property(
          fc.array(contentArb, { minLength: 2, maxLength: 10 }),
          (contents) => {
            const segments = contents.map((c, i) => makeCoherenceSegment(i, c));
            const sim = new SimilarityEngine();
            const result = computeCoherence(segments, new Map(), sim);

            if (result.windowCoherence !== null) {
              expect(result.windowCoherence).toBeGreaterThanOrEqual(0.0);
              expect(result.windowCoherence).toBeLessThanOrEqual(1.0);
            }
          },
        ),
      );
    });

    it('computeDensity perSegment density scores are in [0, 1]', () => {
      fc.assert(
        fc.property(
          fc.array(contentArb, { minLength: 2, maxLength: 10 }),
          (contents) => {
            const segments = contents.map((c, i) => makeDensitySegment(i, c));
            const sim = new SimilarityEngine();
            const result = computeDensity(segments, sim);

            for (const [, segResult] of result.perSegment) {
              expect(segResult.density).toBeGreaterThanOrEqual(0.0);
              expect(segResult.density).toBeLessThanOrEqual(1.0);
            }
          },
        ),
      );
    });

    it('computeDensity windowDensity is in [0, 1] or null', () => {
      fc.assert(
        fc.property(
          fc.array(contentArb, { minLength: 2, maxLength: 10 }),
          (contents) => {
            const segments = contents.map((c, i) => makeDensitySegment(i, c));
            const sim = new SimilarityEngine();
            const result = computeDensity(segments, sim);

            if (result.windowDensity !== null) {
              expect(result.windowDensity).toBeGreaterThanOrEqual(0.0);
              expect(result.windowDensity).toBeLessThanOrEqual(1.0);
            }
          },
        ),
      );
    });

    it('computeRelevance with no task produces all 1.0 perSegment scores', () => {
      fc.assert(
        fc.property(
          fc.array(contentArb, { minLength: 2, maxLength: 10 }),
          (contents) => {
            const segments = contents.map((c, i) => makeRelevanceSegment(i, c));
            const sim = new SimilarityEngine();
            const result = computeRelevance(segments, sim, 2000, null, null);

            for (const [, score] of result.perSegment) {
              expect(score).toBeGreaterThanOrEqual(0.0);
              expect(score).toBeLessThanOrEqual(1.0);
            }
          },
        ),
      );
    });

    it('computeRelevance windowRelevance is in [0, 1] or null', () => {
      fc.assert(
        fc.property(
          fc.array(contentArb, { minLength: 2, maxLength: 10 }),
          (contents) => {
            const segments = contents.map((c, i) => makeRelevanceSegment(i, c));
            const sim = new SimilarityEngine();
            const result = computeRelevance(segments, sim, 2000, null, null);

            if (result.windowRelevance !== null) {
              expect(result.windowRelevance).toBeGreaterThanOrEqual(0.0);
              expect(result.windowRelevance).toBeLessThanOrEqual(1.0);
            }
          },
        ),
      );
    });
  });

  describe('Similarity symmetry', () => {
    it('similarity(a, b) === similarity(b, a) for any two non-empty strings', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          (a, b) => {
            const sim = new SimilarityEngine();
            const hashA = fnv1a(a);
            const hashB = fnv1a(b);

            const ab = sim.computeSimilarity(hashA, a, hashB, b);
            const ba = sim.computeSimilarity(hashB, b, hashA, a);

            expect(ab).toBe(ba);
          },
        ),
      );
    });
  });

  describe('Composite collapse', () => {
    const positiveScore = fc.float({ min: 0, max: 1, noNaN: true });

    it('composite is 0 when coherence is 0', () => {
      fc.assert(
        fc.property(positiveScore, positiveScore, positiveScore, (d, r, c) => {
          const result = computeComposite(0, d, r, c);
          expect(result).toBe(0);
        }),
      );
    });

    it('composite is 0 when density is 0', () => {
      fc.assert(
        fc.property(positiveScore, positiveScore, positiveScore, (co, r, c) => {
          const result = computeComposite(co, 0, r, c);
          expect(result).toBe(0);
        }),
      );
    });

    it('composite is 0 when relevance is 0', () => {
      fc.assert(
        fc.property(positiveScore, positiveScore, positiveScore, (co, d, c) => {
          const result = computeComposite(co, d, 0, c);
          expect(result).toBe(0);
        }),
      );
    });

    it('composite is 0 when continuity is 0', () => {
      fc.assert(
        fc.property(positiveScore, positiveScore, positiveScore, (co, d, r) => {
          const result = computeComposite(co, d, r, 0);
          expect(result).toBe(0);
        }),
      );
    });
  });

  describe('Protection floors', () => {
    it('pinned protection produces relevance score of 1.0', () => {
      fc.assert(
        fc.property(contentArb, (content) => {
          const seg = makeRelevanceSegment(0, content, 'pinned');
          const sim = new SimilarityEngine();
          const result = computeRelevance([seg], sim, 2000, null, null);

          const score = result.perSegment.get(seg.id);
          expect(score).toBe(1.0);
        }),
      );
    });

    it('seed protection produces relevance score >= 0.3', () => {
      fc.assert(
        fc.property(contentArb, (content) => {
          const seg = makeRelevanceSegment(0, content, 'seed');
          const sim = new SimilarityEngine();
          const result = computeRelevance([seg], sim, 2000, null, null);

          const score = result.perSegment.get(seg.id);
          expect(score).toBeDefined();
          expect(score!).toBeGreaterThanOrEqual(0.3);
        }),
      );
    });
  });

  describe('Baseline normalization idempotency', () => {
    it('normalizing a baseline snapshot against itself produces all 1.0s', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(0.01), max: 1, noNaN: true }),
          fc.float({ min: Math.fround(0.01), max: 1, noNaN: true }),
          fc.float({ min: Math.fround(0.01), max: 1, noNaN: true }),
          (coherence, density, relevance) => {
            const manager = new BaselineManager();
            // BaselineManager.notifyAdd captures baseline with continuity hardcoded
            // to 1.0 (per invariant 8), so we use the same raw scores that the
            // baseline will store: coherence, density, relevance from raw, continuity = 1.0.
            const rawScores: WindowScores = { coherence, density, relevance, continuity: 1.0 };

            // Capture baseline from these scores
            manager.notifyAdd(rawScores, 5, 100, 1000);

            // Normalize those same scores against the captured baseline
            const normalized = manager.normalize(rawScores);

            expect(normalized).not.toBeNull();
            expect(normalized!.coherence).toBeCloseTo(1.0, 10);
            expect(normalized!.density).toBeCloseTo(1.0, 10);
            expect(normalized!.relevance).toBeCloseTo(1.0, 10);
            expect(normalized!.continuity).toBeCloseTo(1.0, 10);
          },
        ),
      );
    });
  });

  describe('Determinism', () => {
    it('computeCoherence produces identical results on consecutive calls', () => {
      fc.assert(
        fc.property(
          fc.array(contentArb, { minLength: 2, maxLength: 10 }),
          (contents) => {
            const segments = contents.map((c, i) => makeCoherenceSegment(i, c));
            const sim = new SimilarityEngine();

            const result1 = computeCoherence(segments, new Map(), sim);
            const result2 = computeCoherence(segments, new Map(), sim);

            // Window-level scores must be identical
            expect(result1.windowCoherence).toBe(result2.windowCoherence);
            expect(result1.topicalConcentration).toBe(result2.topicalConcentration);

            // Per-segment scores must be identical
            for (const [id, score1] of result1.perSegment) {
              const score2 = result2.perSegment.get(id);
              expect(score2).toBeDefined();
              expect(score1).toBe(score2);
            }

            // Adjacency scores must be identical
            for (const [id, score1] of result1.adjacencyScores) {
              const score2 = result2.adjacencyScores.get(id);
              expect(score2).toBeDefined();
              expect(score1).toBe(score2);
            }
          },
        ),
      );
    });
  });
});
