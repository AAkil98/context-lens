import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ContextLens } from '../../src/index.js';
import type { Segment } from '../../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeLens(): ContextLens {
  return new ContextLens({ capacity: 100000 });
}

/** Content arbitrary: non-empty, long enough to be meaningful. */
const contentArb = fc.string({ minLength: 10, maxLength: 200 });

/** Distinct content arbitrary: produces an array of unique strings. */
function distinctContentsArb(minLen: number, maxLen: number): fc.Arbitrary<string[]> {
  return fc.array(contentArb, { minLength: minLen, maxLength: maxLen })
    .map((arr) => [...new Set(arr)])
    .filter((arr) => arr.length >= minLen);
}

// ─── Property Tests ─────────────────────────────────────────────

describe('Phase 4 — Property-Based Tests', () => {
  // ── 1. Defensive copy isolation ─────────────────────────────

  describe('Defensive copy isolation', () => {
    it('mutations to retrieved segment do not affect stored state', () => {
      fc.assert(
        fc.property(contentArb, (content) => {
          const lens = makeLens();
          const seg = lens.add(content) as Segment;
          const id = seg.id;

          const retrieved1 = lens.getSegment(id);
          expect(retrieved1).not.toBeNull();

          // Mutate all mutable fields on the returned copy
          const mutable = retrieved1 as Record<string, unknown>;
          mutable.content = 'MUTATED';
          mutable.importance = -999;
          mutable.tags = ['tampered'];
          mutable.origin = 'tampered-origin';

          // Retrieve again — values must be unchanged
          const retrieved2 = lens.getSegment(id)!;
          expect(retrieved2.content).toBe(content);
          expect(retrieved2.importance).not.toBe(-999);
          expect(retrieved2.tags).not.toContain('tampered');
          expect(retrieved2.origin).not.toBe('tampered-origin');
        }),
        { numRuns: 50 },
      );
    });
  });

  // ── 2. Assess determinism ───────────────────────────────────

  describe('Assess determinism', () => {
    it('same state with no mutations between produces same reportId and scores', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(2, 8),
          (contents) => {
            const lens = makeLens();
            lens.seed(contents.map((c) => ({ content: c })));

            const report1 = lens.assess();
            const report2 = lens.assess();

            // Cache hit: same reportId
            expect(report1.reportId).toBe(report2.reportId);

            // Same window scores
            expect(report1.windowScores.coherence).toBe(report2.windowScores.coherence);
            expect(report1.windowScores.density).toBe(report2.windowScores.density);
            expect(report1.windowScores.relevance).toBe(report2.windowScores.relevance);
            expect(report1.windowScores.continuity).toBe(report2.windowScores.continuity);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  // ── 3. Report history bounds ────────────────────────────────

  describe('Report history bounds', () => {
    it('diagnostics report history never exceeds 20 entries', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 30 }),
          (assessCount) => {
            const lens = makeLens();
            lens.seed([{ content: 'Initial seed content for report history test' }]);

            for (let i = 0; i < assessCount; i++) {
              // Add a segment to invalidate cache before each assess
              lens.add(`Report history iteration segment number ${i} with unique content`);
              lens.assess();
            }

            const diag = lens.getDiagnostics();
            expect(diag.reportHistory.reports.length).toBeLessThanOrEqual(20);
            expect(diag.reportHistory.reports.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // ── 4. Diagnostic completeness ──────────────────────────────

  describe('Diagnostic completeness', () => {
    it('getDiagnostics returns valid fields after any sequence of seed/add/assess', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(1, 5),
          distinctContentsArb(1, 5),
          fc.boolean(),
          (seedContents, addContents, shouldAssess) => {
            const lens = makeLens();

            lens.seed(seedContents.map((c) => ({ content: c })));

            for (const c of addContents) {
              lens.add(c);
            }

            if (shouldAssess) {
              lens.assess();
            }

            const diag = lens.getDiagnostics();

            expect(diag.schemaVersion).toBeTruthy();
            expect(diag.timestamp).toBeGreaterThan(0);
            expect(diag.sessionDuration).toBeGreaterThanOrEqual(0);
            expect(diag.segmentCount).toBeGreaterThanOrEqual(0);

            // Segment count should match seeded + added (minus any duplicates)
            expect(diag.segmentCount).toBeLessThanOrEqual(
              seedContents.length + addContents.length,
            );
          },
        ),
        { numRuns: 30 },
      );
    });
  });
});
