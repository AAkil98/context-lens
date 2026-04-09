import { describe, it, expect } from 'vitest';
import {
  PerformanceInstrumentation,
  type TimingRecord,
  type OperationContext,
  type SamplingParameters,
} from '../../src/performance.js';
import { fnv1a } from '../../src/utils/hash.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeCtx(
  operation: string,
  segmentCount: number,
  startTime: number,
  timestamp = 1000,
): OperationContext {
  return { operation, segmentCount, startTime, timestamp };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('PerformanceInstrumentation', () => {
  describe('Timing harness', () => {
    it('records operation name and timestamp', () => {
      const perf = new PerformanceInstrumentation();
      const ctx = perf.startOperation('assess', 10);

      expect(ctx.operation).toBe('assess');
      expect(ctx.segmentCount).toBe(10);
      expect(typeof ctx.timestamp).toBe('number');
      expect(typeof ctx.startTime).toBe('number');

      const record = perf.endOperation(ctx);
      expect(record.operation).toBe('assess');
      expect(record.timestamp).toBe(ctx.timestamp);
      expect(record.segmentCount).toBe(10);
    });

    it('selfTime = totalTime - providerTime - customPatternTime', () => {
      const perf = new PerformanceInstrumentation();
      const ctx = perf.startOperation('assess', 50);

      // Simulate elapsed time by manipulating the context
      const providerTime = 2;
      const customPatternTime = 1;
      const record = perf.endOperation(ctx, providerTime, customPatternTime);

      // selfTime should be totalTime minus the two deductions
      // Due to Math.max(0, ...), selfTime is non-negative
      const expectedSelfTime = Math.max(0, record.totalTime - providerTime - customPatternTime);
      expect(record.selfTime).toBe(expectedSelfTime);
    });

    it('selfTime is non-negative even with rounding', () => {
      const perf = new PerformanceInstrumentation();
      const ctx = perf.startOperation('add', 5);

      // Provide provider + custom times that could exceed totalTime
      const record = perf.endOperation(ctx, 1000, 1000);
      expect(record.selfTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('3-way decomposition', () => {
    it('providerTime accumulated from param', () => {
      const perf = new PerformanceInstrumentation();
      const ctx = perf.startOperation('assess', 100);
      const record = perf.endOperation(ctx, 7.5, 0);

      expect(record.providerTime).toBe(7.5);
      expect(record.customPatternTime).toBe(0);
      expect(record.totalTime).toBeGreaterThanOrEqual(0);
      // selfTime is clamped to 0 when providerTime exceeds totalTime,
      // so the decomposition holds as: selfTime >= 0 and providerTime is recorded as-is
      expect(record.selfTime).toBeGreaterThanOrEqual(0);
    });

    it('customPatternTime accumulated from param', () => {
      const perf = new PerformanceInstrumentation();
      const ctx = perf.startOperation('assess', 100);
      const record = perf.endOperation(ctx, 0, 3.2);

      expect(record.customPatternTime).toBe(3.2);
      expect(record.providerTime).toBe(0);
      expect(record.totalTime).toBeGreaterThanOrEqual(0);
      // selfTime is clamped to 0 when customPatternTime exceeds totalTime
      expect(record.selfTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Budget violation', () => {
    it('Tier 1 operations: budget 1ms', () => {
      const perf = new PerformanceInstrumentation();
      const budget = perf.getBudgetTarget('getCapacity', 100);
      expect(budget).toBe(1);
    });

    it('Tier 3: budget 50ms at n<=500', () => {
      const perf = new PerformanceInstrumentation();

      expect(perf.getBudgetTarget('assess', 100)).toBe(50);
      expect(perf.getBudgetTarget('assess', 500)).toBe(50);
    });

    it('Linear extrapolation: Tier 3 at n=1000 -> budget 100ms', () => {
      const perf = new PerformanceInstrumentation();
      const budget = perf.getBudgetTarget('assess', 1000);
      // 50 * (1000 / 500) = 100
      expect(budget).toBe(100);
    });

    it('budgetExceeded flag set correctly', () => {
      const perf = new PerformanceInstrumentation();

      // Tier 1 budget is 1ms. With a very fast operation the selfTime should
      // be well under 1ms, so budgetExceeded should be false.
      const ctx1 = perf.startOperation('getCapacity', 10);
      const record1 = perf.endOperation(ctx1);
      // selfTime is tiny (sub-ms), so budget should not be exceeded
      expect(record1.budgetTarget).toBe(1);
      expect(typeof record1.budgetExceeded).toBe('boolean');

      // Force a budget violation by providing high providerTime that does NOT
      // count toward selfTime. The selfTime is the wall-clock minus provider
      // and custom times. To force selfTime > budget, we'd need to actually
      // block, but we can verify the flag logic by checking consistency:
      // budgetExceeded === (selfTime > budgetTarget)
      // Since selfTime was clamped via Math.max(0, ...), we check the raw.
      const rawSelfTime = record1.totalTime - record1.providerTime - record1.customPatternTime;
      expect(record1.budgetExceeded).toBe(rawSelfTime > record1.budgetTarget);
    });
  });

  describe('Sampling parameters', () => {
    it('disabled at n <= 200', () => {
      const perf = new PerformanceInstrumentation();

      const params100 = perf.computeSamplingParams(100, ['a', 'b']);
      expect(params100.enabled).toBe(false);
      expect(params100.topicalConcentrationSampleSize).toBe(100);

      const params200 = perf.computeSamplingParams(200, Array.from({ length: 200 }, (_, i) => `seg-${i}`));
      expect(params200.enabled).toBe(false);
      expect(params200.topicalConcentrationSampleSize).toBe(200);
    });

    it('sample size = min(ceil(sqrt(n) * 3), n) at n > 200', () => {
      const perf = new PerformanceInstrumentation();
      const n = 400;
      const ids = Array.from({ length: n }, (_, i) => `seg-${i}`);
      const params = perf.computeSamplingParams(n, ids);

      expect(params.enabled).toBe(true);
      const expected = Math.min(Math.ceil(Math.sqrt(n) * 3), n);
      expect(params.topicalConcentrationSampleSize).toBe(expected);
      // ceil(sqrt(400) * 3) = ceil(20 * 3) = 60
      expect(expected).toBe(60);
    });

    it('density cap = 30 and stratified group sampling: ceil(m * s / n)', () => {
      const perf = new PerformanceInstrumentation();
      const n = 400;
      const ids = Array.from({ length: n }, (_, i) => `seg-${i}`);
      const groups = new Map<string, number>([
        ['groupA', 100],
        ['groupB', 50],
      ]);

      const params = perf.computeSamplingParams(n, ids, groups);

      expect(params.densitySamplingCap).toBe(30);

      // s = topicalConcentrationSampleSize = 60
      const s = params.topicalConcentrationSampleSize;
      // groupA: ceil(100 * 60 / 400) = ceil(15) = 15
      expect(params.stratifiedGroupSamples.get('groupA')).toBe(Math.ceil(100 * s / n));
      // groupB: ceil(50 * 60 / 400) = ceil(7.5) = 8
      expect(params.stratifiedGroupSamples.get('groupB')).toBe(Math.ceil(50 * s / n));
    });

    it('seed is deterministic FNV-1a of sorted IDs', () => {
      const perf = new PerformanceInstrumentation();
      const ids = ['seg-c', 'seg-a', 'seg-b'];
      const n = 300;

      const params1 = perf.computeSamplingParams(n, ids);
      const params2 = perf.computeSamplingParams(n, ['seg-b', 'seg-c', 'seg-a']);

      // Both should produce the same seed since they sort to the same order
      expect(params1.samplingSeed).toBe(params2.samplingSeed);

      // Verify it matches the expected FNV-1a value
      const sorted = [...ids].sort();
      const expectedSeed = fnv1a(sorted.join('\0'));
      expect(params1.samplingSeed).toBe(expectedSeed);
    });
  });

  describe('Timing history', () => {
    it('ring buffer caps at 200 entries', () => {
      const perf = new PerformanceInstrumentation();

      for (let i = 0; i < 250; i++) {
        const ctx = perf.startOperation('add', i);
        perf.endOperation(ctx);
      }

      const history = perf.getTimingHistory();
      expect(history.length).toBe(200);
    });

    it('empty returns empty array', () => {
      const perf = new PerformanceInstrumentation();
      const history = perf.getTimingHistory();
      expect(history).toEqual([]);
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('Operation-to-tier mapping', () => {
    it('verifies key operations map to correct tiers', () => {
      const perf = new PerformanceInstrumentation();

      expect(perf.getOperationTier('getCapacity')).toBe(1);
      expect(perf.getOperationTier('add')).toBe(2);
      expect(perf.getOperationTier('assess')).toBe(3);
      expect(perf.getOperationTier('planEviction')).toBe(4);
      expect(perf.getOperationTier('seed')).toBe(5);

      // Unknown operations default to tier 5
      expect(perf.getOperationTier('unknownOp')).toBe(5);
    });
  });

  // ── Phase C: Branch coverage additions ───────────────────────

  describe('P95 with few samples', () => {
    it('computes P95 correctly with only 2 samples', () => {
      const perf = new PerformanceInstrumentation();

      // Record 2 operations with known selfTimes
      const ctx1 = perf.startOperation('assess', 10);
      // Simulate fast operation
      perf.endOperation(ctx1, 0, 0, 0, 0);

      const ctx2 = perf.startOperation('assess', 10);
      perf.endOperation(ctx2, 0, 0, 0, 0);

      const stats = perf.getOperationStats();
      expect(stats['assess']).toBeDefined();
      expect(stats['assess']!.count).toBe(2);
      expect(stats['assess']!.p95SelfTime).toBeGreaterThanOrEqual(0);
    });

    it('computes P95 with a single sample', () => {
      const perf = new PerformanceInstrumentation();
      const ctx = perf.startOperation('add', 5);
      perf.endOperation(ctx, 0, 0, 0, 0);

      const stats = perf.getOperationStats();
      expect(stats['add']!.count).toBe(1);
      expect(stats['add']!.p95SelfTime).toBeGreaterThanOrEqual(0);
      // With 1 sample, p95 = that sample
      expect(stats['add']!.p95SelfTime).toBe(stats['add']!.maxSelfTime);
    });
  });

  describe('getPerformanceSummary', () => {
    it('assembles full summary with session totals', () => {
      const perf = new PerformanceInstrumentation();

      const ctx = perf.startOperation('assess', 10);
      perf.endOperation(ctx, 1, 0.5, 2, 3);

      const caches = {
        tokenCache: { hits: 0, misses: 0, hitRate: null, currentEntries: 0, maxEntries: 0, utilization: 0, evictions: 0 },
        embeddingCache: { hits: 0, misses: 0, hitRate: null, currentEntries: 0, maxEntries: 0, utilization: 0, evictions: 0 },
        similarityCache: { hits: 0, misses: 0, hitRate: null, currentEntries: 0, maxEntries: 0, utilization: 0, evictions: 0 },
      };

      const summary = perf.getPerformanceSummary(caches);
      expect(summary.operationTimings).toBeDefined();
      expect(summary.caches).toBe(caches);
      expect(summary.sessionSelfTime).toBeGreaterThanOrEqual(0);
      expect(summary.sessionProviderTime).toBeGreaterThanOrEqual(0);
      expect(typeof summary.budgetViolationCount).toBe('number');
    });
  });
});
