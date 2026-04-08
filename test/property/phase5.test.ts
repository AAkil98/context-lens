import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ContextLens, toJSON, validate } from '../../src/index.js';
import { ContextLensFleet } from '../../src/fleet.js';
import type { Segment } from '../../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────

const contentArb = fc.string({ minLength: 20, maxLength: 200 });

function distinctContentsArb(minLen: number, maxLen: number): fc.Arbitrary<string[]> {
  return fc.array(contentArb, { minLength: minLen, maxLength: maxLen })
    .map((arr) => [...new Set(arr)])
    .filter((arr) => arr.length >= minLen);
}

// ─── Property Tests ─────────────────────────────────────────────

describe('Phase 5 — Property-Based Tests', () => {
  // ── 1. Snapshot round-trip invariant ─────────────────────────

  describe('Snapshot round-trip', () => {
    it('fromSnapshot preserves segment count and content', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(2, 6),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) {
              lens.add(c);
            }
            lens.assess();

            const snap = lens.snapshot();
            const restored = ContextLens.fromSnapshot(snap);

            expect(restored.getSegmentCount()).toBe(lens.getSegmentCount());

            const origSegs = lens.listSegments();
            const restSegs = restored.listSegments();

            for (let i = 0; i < origSegs.length; i++) {
              expect(restSegs[i]!.content).toBe(origSegs[i]!.content);
              expect(restSegs[i]!.id).toBe(origSegs[i]!.id);
            }
          },
        ),
        { numRuns: 30 },
      );
    });

    it('fromSnapshot produces identical composite scores', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(3, 8),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) {
              lens.add(c);
            }
            lens.assess();

            const snap = lens.snapshot();
            const restored = ContextLens.fromSnapshot(snap);

            const origReport = lens.assess();
            const restReport = restored.assess();

            if (origReport.composite !== null && restReport.composite !== null) {
              expect(restReport.composite).toBeCloseTo(origReport.composite, 4);
            } else {
              expect(restReport.composite).toBe(origReport.composite);
            }
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // ── 2. Fleet aggregate consistency ───────────────────────────

  describe('Fleet aggregate consistency', () => {
    it('fleet aggregate mean matches manual computation', () => {
      fc.assert(
        fc.property(
          fc.array(distinctContentsArb(1, 4), { minLength: 2, maxLength: 5 }),
          (contentArrays) => {
            const fleet = new ContextLensFleet();
            const instances: ContextLens[] = [];

            for (let i = 0; i < contentArrays.length; i++) {
              const lens = new ContextLens({ capacity: 100000 });
              for (const c of contentArrays[i]!) {
                lens.add(c);
              }
              instances.push(lens);
              fleet.register(lens, `inst-${i}`);
            }

            const report = fleet.assessFleet();
            const okInstances = report.instances.filter(i => i.status === 'ok');

            if (okInstances.length >= 2) {
              // Manually compute mean utilization
              let sum = 0;
              for (const inst of okInstances) {
                sum += inst.capacity.utilization;
              }
              const expectedMean = sum / okInstances.length;

              expect(report.aggregate.utilization.mean).toBeCloseTo(expectedMean, 10);

              // Min should be <= mean <= max
              expect(report.aggregate.utilization.min).toBeLessThanOrEqual(
                report.aggregate.utilization.mean + 1e-10,
              );
              expect(report.aggregate.utilization.max).toBeGreaterThanOrEqual(
                report.aggregate.utilization.mean - 1e-10,
              );
            }
          },
        ),
        { numRuns: 20 },
      );
    });

    it('fleet ranking count matches assessed count', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          (n) => {
            const fleet = new ContextLensFleet();
            for (let i = 0; i < n; i++) {
              const lens = new ContextLens({ capacity: 100000 });
              lens.add(`Content number ${i} with enough text to form meaningful segments`);
              fleet.register(lens, `inst-${i}`);
            }

            const report = fleet.assessFleet();
            expect(report.ranking).toHaveLength(report.assessedCount);
          },
        ),
        { numRuns: 15 },
      );
    });
  });

  // ── 3. Schema validation universality ────────────────────────

  describe('Schema validation universality', () => {
    it('toJSON(assess()) always validates for any segment set', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(1, 6),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) {
              lens.add(c);
            }

            const report = lens.assess();
            const json = toJSON(report);
            const result = validate.qualityReport(json);

            expect(result.valid).toBe(true);
          },
        ),
        { numRuns: 25 },
      );
    });

    it('toJSON(getDiagnostics()) always validates', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(1, 5),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) {
              lens.add(c);
            }
            lens.assess();

            const diag = lens.getDiagnostics();
            const json = toJSON(diag);
            const result = validate.diagnosticSnapshot(json);

            expect(result.valid).toBe(true);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('toJSON(planEviction()) always validates', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(2, 6),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) {
              lens.add(c);
            }
            lens.assess();

            const plan = lens.planEviction();
            const json = toJSON(plan);
            const result = validate.evictionPlan(json);

            expect(result.valid).toBe(true);
          },
        ),
        { numRuns: 20 },
      );
    });
  });
});
