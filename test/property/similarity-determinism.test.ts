/**
 * Property-based tests for cl-spec-016 Invariant 1 (cache-warm vs cache-cold
 * output equality).
 *
 * The contract: for any two instances with identical state, the assess() output
 * is numerically identical regardless of similarity cache state. The cache is a
 * memoization layer, never a different scoring path. This holds across:
 *   - any segment count and content distribution
 *   - any similarityCacheSize setting (default, large, minimal, zero)
 *   - any combination of pre-assess mutations
 *
 * @see cl-spec-016 §4, §7 Invariants 1 and 2
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ContextLens } from '../../src/index.js';
import type { QualityReport } from '../../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────

function distinctContent(index: number): string {
  const topics = [
    'The quick brown fox jumps over the lazy dog near the riverbank during sunrise',
    'Quantum computing leverages superposition and entanglement to solve problems',
    'Photosynthesis converts carbon dioxide and water into glucose and oxygen',
    'Medieval castle architecture included moats drawbridges and thick stone walls',
    'Machine learning algorithms train on large datasets to recognize patterns',
    'Ocean currents distribute heat around the globe affecting weather and climate',
    'Renaissance artists developed perspective techniques that transformed painting',
    'Distributed systems require consensus protocols to maintain data consistency',
    'Volcanic eruptions release magma gases and ash into the atmosphere over time',
    'Functional programming emphasizes immutable data and pure declarative logic',
  ];
  return `${topics[index % topics.length]!} (segment ${index})`;
}

/**
 * Assert two reports have numerically identical scores, ignoring fields that
 * legitimately differ (timestamp, assessmentTimestamp).
 */
function assertScoreEquality(a: QualityReport, b: QualityReport): void {
  expect(a.windowScores.coherence).toBeCloseTo(b.windowScores.coherence ?? 0, 10);
  expect(a.windowScores.density).toBeCloseTo(b.windowScores.density ?? 0, 10);
  expect(a.windowScores.relevance).toBeCloseTo(b.windowScores.relevance ?? 0, 10);
  expect(a.windowScores.continuity).toBeCloseTo(b.windowScores.continuity ?? 0, 10);
  if (a.composite !== null && b.composite !== null) {
    expect(a.composite).toBeCloseTo(b.composite, 10);
  } else {
    expect(a.composite).toBe(b.composite);
  }
  expect(a.segmentCount).toBe(b.segmentCount);
  expect(a.patterns.patterns.length).toBe(b.patterns.patterns.length);
}

// ─── Property tests ─────────────────────────────────────────────

describe('cl-spec-016 Invariant 1 — cache-warm vs cache-cold determinism', () => {
  it('repeated assess() with mutations between produces identical scores when caches differ', () => {
    fc.assert(
      fc.property(
        // Number of initial segments
        fc.integer({ min: 5, max: 50 }),
        // Number of additional segments to introduce mutation cycles
        fc.integer({ min: 0, max: 10 }),
        (initialCount, additionalCount) => {
          const a = new ContextLens({ capacity: 200000, similarityCacheSize: 65536 });
          const b = new ContextLens({ capacity: 200000, similarityCacheSize: 65536 });

          // Build identical state on both instances.
          for (let i = 0; i < initialCount; i++) {
            const content = distinctContent(i);
            a.add(content);
            b.add(content);
          }
          a.assess(); b.assess();

          // Warm A's cache by repeated assess+mutate cycles.
          for (let k = 0; k < additionalCount; k++) {
            const content = distinctContent(initialCount + k);
            a.add(content);
            b.add(content);
            a.assess();
            // B does NOT assess between mutations — its cache stays cold-er.
          }

          // Now clear B's similarity cache to force the cold path.
          b.clearCaches('similarity');

          // Final assess on both. Force cache invalidation on B by adding
          // and removing nothing — but we DO need to invalidate the report
          // cache to trigger a fresh assess. Use add+evict to net-zero.
          const sentinel = `sentinel-content-${Date.now()}-${Math.random()}`;
          const segA = a.add(sentinel);
          const segB = b.add(sentinel);
          if ('id' in segA && 'id' in segB) {
            a.evict(segA.id);
            b.evict(segB.id);
          }

          const reportA = a.assess();
          const reportB = b.assess();

          assertScoreEquality(reportA, reportB);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('cache-disabled and cache-default produce identical scores', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 30 }),
        (count) => {
          const a = new ContextLens({ capacity: 100000, similarityCacheSize: 0 });
          const b = new ContextLens({ capacity: 100000 }); // default cache

          for (let i = 0; i < count; i++) {
            const content = distinctContent(i);
            a.add(content);
            b.add(content);
          }

          const reportA = a.assess();
          const reportB = b.assess();

          assertScoreEquality(reportA, reportB);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('different cache sizes (16, 4096, 65536) produce identical scores at n=20', () => {
    const sizes = [16, 4096, 65536];
    const lenses = sizes.map(s => new ContextLens({ capacity: 100000, similarityCacheSize: s }));

    for (let i = 0; i < 20; i++) {
      const content = distinctContent(i);
      for (const lens of lenses) lens.add(content);
    }

    const reports = lenses.map(l => l.assess());
    for (let i = 1; i < reports.length; i++) {
      assertScoreEquality(reports[0]!, reports[i]!);
    }
  });
});
