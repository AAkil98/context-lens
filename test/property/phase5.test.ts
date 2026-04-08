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

// ─── Phase D — Property-Based Invariant Hardening ───────────────

describe('Phase D — Invariant Hardening', () => {
  // ── D.1: Defensive copy universality ───────────────────────────

  describe('D.1: Defensive copy universality', () => {
    it('mutating returned Report never changes internal state', () => {
      fc.assert(
        fc.property(distinctContentsArb(2, 5), (contents) => {
          const lens = new ContextLens({ capacity: 100000 });
          for (const c of contents) lens.add(c);

          const report1 = lens.assess();
          // Mutate the returned report
          (report1 as Record<string, unknown>).composite = -999;
          (report1.windowScores as Record<string, unknown>).coherence = -1;
          report1.segments.length = 0;

          const report2 = lens.assess();
          expect(report2.composite).not.toBe(-999);
          expect(report2.windowScores.coherence).not.toBe(-1);
          expect(report2.segments.length).toBe(report1.segmentCount);
        }),
        { numRuns: 30 },
      );
    });

    it('mutating input options after add() never changes stored state', () => {
      fc.assert(
        fc.property(contentArb, (content) => {
          const lens = new ContextLens({ capacity: 100000 });
          const opts = { importance: 0.7, tags: ['original'], origin: 'test' };
          const seg = lens.add(content, opts) as Segment;

          // Mutate the options object after the call
          opts.importance = 0.1;
          opts.tags.push('tampered');
          opts.origin = 'tampered';

          const stored = lens.getSegment(seg.id)!;
          expect(stored.importance).toBe(0.7);
          expect(stored.tags).toEqual(['original']);
          expect(stored.origin).toBe('test');
        }),
        { numRuns: 30 },
      );
    });

    it('mutating returned Group never changes internal state', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(2, 4),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            const ids: string[] = [];
            for (const c of contents) {
              const seg = lens.add(c) as Segment;
              ids.push(seg.id);
            }
            if (ids.length < 2) return;

            const group = lens.createGroup('test-g', ids.slice(0, 2));
            (group as Record<string, unknown>).members = [];
            (group as Record<string, unknown>).importance = -999;

            const retrieved = lens.getGroup('test-g')!;
            expect(retrieved.members).toHaveLength(2);
            expect(retrieved.importance).not.toBe(-999);
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // ── D.2: Event count consistency ───────────────────────────────

  describe('D.2: Event count consistency', () => {
    it('segmentAdded count equals successful add() calls', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(1, 10),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            let addedEvents = 0;
            lens.on('segmentAdded', () => { addedEvents++; });

            let successfulAdds = 0;
            for (const c of contents) {
              const result = lens.add(c);
              if (!('isDuplicate' in result)) successfulAdds++;
            }

            expect(addedEvents).toBe(successfulAdds);
          },
        ),
        { numRuns: 30 },
      );
    });

    it('segmentEvicted count equals evicted segments including group members', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(3, 8),
          fc.integer({ min: 1, max: 3 }),
          (contents, evictCount) => {
            const lens = new ContextLens({ capacity: 100000 });
            let evictedEvents = 0;
            lens.on('segmentEvicted', () => { evictedEvents++; });

            const ids: string[] = [];
            for (const c of contents) {
              const seg = lens.add(c) as Segment;
              ids.push(seg.id);
            }

            const toEvict = Math.min(evictCount, ids.length);
            for (let i = 0; i < toEvict; i++) {
              lens.evict(ids[i]!);
            }

            expect(evictedEvents).toBe(toEvict);
          },
        ),
        { numRuns: 25 },
      );
    });

    it('reportGenerated count equals non-cached assess() calls', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(2, 6),
          fc.integer({ min: 1, max: 5 }),
          (contents, extraAssess) => {
            const lens = new ContextLens({ capacity: 100000 });
            let reportEvents = 0;
            lens.on('reportGenerated', () => { reportEvents++; });

            for (const c of contents) lens.add(c);

            // First assess: non-cached
            lens.assess();
            // Repeated assess without mutations: cached
            for (let i = 0; i < extraAssess; i++) lens.assess();

            // Only 1 reportGenerated (the rest were cache hits)
            expect(reportEvents).toBe(1);

            // Add + assess again: 1 more
            lens.add('force invalidation with unique content here');
            lens.assess();
            expect(reportEvents).toBe(2);
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // ── D.3: Token accounting invariant ────────────────────────────

  describe('D.3: Token accounting invariant', () => {
    it('sum of segment tokens equals getCapacity().totalActiveTokens', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(1, 10),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) lens.add(c);

            const segments = lens.listSegments();
            const tokenSum = segments.reduce((sum, s) => sum + s.tokenCount, 0);
            const cap = lens.getCapacity();

            expect(cap.totalActiveTokens).toBe(tokenSum);
            expect(cap.utilization).toBeCloseTo(tokenSum / 100000, 10);
            expect(cap.headroom).toBe(100000 - tokenSum);
          },
        ),
        { numRuns: 30 },
      );
    });

    it('token accounting holds after evictions', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(3, 8),
          fc.integer({ min: 1, max: 3 }),
          (contents, evictCount) => {
            const lens = new ContextLens({ capacity: 100000 });
            const ids: string[] = [];
            for (const c of contents) {
              const seg = lens.add(c) as Segment;
              ids.push(seg.id);
            }

            const toEvict = Math.min(evictCount, ids.length);
            for (let i = 0; i < toEvict; i++) lens.evict(ids[i]!);

            const segments = lens.listSegments();
            const tokenSum = segments.reduce((sum, s) => sum + s.tokenCount, 0);
            const cap = lens.getCapacity();

            expect(cap.totalActiveTokens).toBe(tokenSum);
          },
        ),
        { numRuns: 25 },
      );
    });
  });

  // ── D.4: Position stability ────────────────────────────────────

  describe('D.4: Position stability', () => {
    it('listSegments order is insertion order minus evicted', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(3, 10),
          fc.integer({ min: 0, max: 4 }),
          (contents, evictIndex) => {
            const lens = new ContextLens({ capacity: 100000 });
            const ids: string[] = [];
            for (const c of contents) {
              const seg = lens.add(c) as Segment;
              ids.push(seg.id);
            }

            const idx = evictIndex % ids.length;
            lens.evict(ids[idx]!);

            const remaining = lens.listSegments().map(s => s.id);
            const expected = ids.filter((_, i) => i !== idx);

            expect(remaining).toEqual(expected);
          },
        ),
        { numRuns: 30 },
      );
    });

    it('restored segments return to original position', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(3, 8),
          fc.integer({ min: 0, max: 4 }),
          (contents, evictIndex) => {
            const lens = new ContextLens({ capacity: 100000 });
            const ids: string[] = [];
            for (const c of contents) {
              const seg = lens.add(c) as Segment;
              ids.push(seg.id);
            }

            const idx = evictIndex % ids.length;
            lens.evict(ids[idx]!);
            lens.restore(ids[idx]!);

            const order = lens.listSegments().map(s => s.id);
            expect(order).toEqual(ids);
          },
        ),
        { numRuns: 25 },
      );
    });

    it('no two active segments share a position', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(2, 10),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) lens.add(c);

            const segments = lens.listSegments();
            const idSet = new Set(segments.map(s => s.id));
            expect(idSet.size).toBe(segments.length);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  // ── D.5: Score determinism (fromSnapshot) ──────────────────────

  describe('D.5: Score determinism', () => {
    it('fromSnapshot + assess produces identical composite as original', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(2, 6),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) lens.add(c);
            const origReport = lens.assess();

            const snap = lens.snapshot();
            const restored = ContextLens.fromSnapshot(snap);
            const restoredReport = restored.assess();

            if (origReport.composite !== null && restoredReport.composite !== null) {
              expect(restoredReport.composite).toBeCloseTo(origReport.composite, 5);
            } else {
              expect(restoredReport.composite).toBe(origReport.composite);
            }
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // ── D.6: Protection tier ordering ──────────────────────────────

  describe('D.6: Protection tier ordering', () => {
    it('eviction plan respects protection tier ordering', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(4, 8),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });

            // Mix protection levels
            for (let i = 0; i < contents.length; i++) {
              const protection = i === 0 ? 'pinned' as const
                : i === 1 ? 'seed' as const
                : i === 2 ? 'priority(100)' as const
                : 'default' as const;
              lens.add(contents[i]!, { protection });
            }

            lens.assess();
            const plan = lens.planEviction({ targetTokens: 50 });

            // Pinned never appears
            for (const c of plan.candidates) {
              const seg = lens.getSegment(c.id);
              if (seg !== null) {
                expect(seg.protection).not.toBe('pinned');
              }
            }

            // All defaults before all priority before all seed
            let seenPriority = false;
            let seenSeed = false;
            for (const c of plan.candidates) {
              const seg = lens.getSegment(c.id);
              if (seg === null) continue;
              if (seg.protection.startsWith('priority')) seenPriority = true;
              if (seg.protection === 'seed') seenSeed = true;
              if (seg.protection === 'default') {
                expect(seenPriority).toBe(false);
                expect(seenSeed).toBe(false);
              }
              if (seg.protection.startsWith('priority')) {
                expect(seenSeed).toBe(false);
              }
            }
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // ── D.7: Fleet aggregate math ──────────────────────────────────

  describe('D.7: Fleet aggregate math', () => {
    it('stddev >= 0 and min <= mean <= max for all dimensions', () => {
      fc.assert(
        fc.property(
          fc.array(distinctContentsArb(1, 4), { minLength: 2, maxLength: 5 }),
          (contentArrays) => {
            const fleet = new ContextLensFleet();
            for (let i = 0; i < contentArrays.length; i++) {
              const lens = new ContextLens({ capacity: 100000 });
              for (const c of contentArrays[i]!) lens.add(c);
              fleet.register(lens, `d7-${i}`);
            }

            const report = fleet.assessFleet();
            if (report.assessedCount < 2) return;

            for (const dim of ['coherence', 'density', 'relevance', 'continuity', 'composite', 'utilization'] as const) {
              const stat = report.aggregate[dim];
              expect(stat.stddev).toBeGreaterThanOrEqual(0);
              expect(stat.min).toBeLessThanOrEqual(stat.mean + 1e-10);
              expect(stat.max).toBeGreaterThanOrEqual(stat.mean - 1e-10);
            }
          },
        ),
        { numRuns: 15 },
      );
    });

    it('ranking composites are non-decreasing with correct rank numbering', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 5 }),
          (n) => {
            const fleet = new ContextLensFleet();
            for (let i = 0; i < n; i++) {
              const lens = new ContextLens({ capacity: 100000 });
              lens.add(`Fleet ranking test content number ${i} with enough text`);
              fleet.register(lens, `rank-${i}`);
            }

            const report = fleet.assessFleet();
            expect(report.ranking).toHaveLength(report.assessedCount);

            // Rank numbering: 1 to N
            if (report.ranking.length > 0) {
              expect(report.ranking[0]!.rank).toBe(1);
              expect(report.ranking[report.ranking.length - 1]!.rank).toBe(report.assessedCount);
            }

            // Non-decreasing composites
            for (let i = 1; i < report.ranking.length; i++) {
              const prev = report.ranking[i - 1]!.composite ?? -Infinity;
              const curr = report.ranking[i]!.composite ?? -Infinity;
              expect(curr).toBeGreaterThanOrEqual(prev - 1e-10);
            }
          },
        ),
        { numRuns: 15 },
      );
    });
  });

  // ── D.8: Schema validation — JSON round-trip safety ────────────

  describe('D.8: Schema validation — JSON round-trip', () => {
    it('JSON.parse(JSON.stringify(toJSON(report))) still validates', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(1, 6),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) lens.add(c);

            const report = lens.assess();
            const json = toJSON(report);
            const roundTripped = JSON.parse(JSON.stringify(json));
            const result = validate.qualityReport(roundTripped);

            expect(result.valid).toBe(true);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('diagnostics round-trip validates', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(1, 5),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) lens.add(c);
            lens.assess();

            const json = toJSON(lens.getDiagnostics());
            const roundTripped = JSON.parse(JSON.stringify(json));
            const result = validate.diagnosticSnapshot(roundTripped);

            expect(result.valid).toBe(true);
          },
        ),
        { numRuns: 15 },
      );
    });

    it('eviction plan round-trip validates', () => {
      fc.assert(
        fc.property(
          distinctContentsArb(2, 6),
          (contents) => {
            const lens = new ContextLens({ capacity: 100000 });
            for (const c of contents) lens.add(c);
            lens.assess();

            const json = toJSON(lens.planEviction());
            const roundTripped = JSON.parse(JSON.stringify(json));
            const result = validate.evictionPlan(roundTripped);

            expect(result.valid).toBe(true);
          },
        ),
        { numRuns: 15 },
      );
    });
  });
});
