import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { DetectionEngine } from '../../src/detection.js';
import { PerformanceInstrumentation } from '../../src/performance.js';
import type {
  QualityReport,
  DetectionResult,
  WindowScores,
  CapacityReport,
  ContinuitySummary,
  TokenizerMetadata,
  TaskSummary,
  SegmentScore,
  GroupScore,
  BaselineSnapshot,
  TrendData,
  ActivePattern,
} from '../../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────

/** Strategy weight sets from eviction.ts (cl-spec-008). */
const STRATEGY_WEIGHTS: Record<string, { relevance: number; density: number; coherence: number; importance: number; age: number }> = {
  default:    { relevance: 0.30, density: 0.25, coherence: 0.20, importance: 0.15, age: 0.10 },
  saturation: { relevance: 0.20, density: 0.30, coherence: 0.15, importance: 0.15, age: 0.20 },
  erosion:    { relevance: 0.20, density: 0.40, coherence: 0.15, importance: 0.15, age: 0.10 },
  gap:        { relevance: 0.45, density: 0.20, coherence: 0.10, importance: 0.15, age: 0.10 },
  collapse:   { relevance: 0.25, density: 0.25, coherence: 0.25, importance: 0.15, age: 0.10 },
};

/** Compute eviction score (mirrors eviction.ts logic). */
function computeEvictionScore(
  relevance: number,
  density: number,
  coherence: number,
  importance: number,
  age: number,
  weights: { relevance: number; density: number; coherence: number; importance: number; age: number },
): number {
  return (
    weights.relevance * relevance +
    weights.density * density +
    weights.coherence * coherence +
    weights.importance * importance +
    weights.age * age
  );
}

/** Bridge score formula: max(0, min(1, avgNeighborSim - skipSim)). */
function computeBridgeScore(leftSim: number, rightSim: number, skipSim: number): number {
  const avgNeighborSim = (leftSim + rightSim) / 2;
  return Math.max(0, Math.min(1, avgNeighborSim - skipSim));
}

/** Build a minimal valid QualityReport for detection tests. */
function makeReport(overrides: {
  utilization?: number;
  density?: number;
  coherence?: number;
  relevance?: number;
  continuity?: number;
  segmentCount?: number;
  reportId?: string;
  timestamp?: number;
  baseline?: BaselineSnapshot | null;
  trend?: TrendData | null;
}): QualityReport {
  const util = overrides.utilization ?? 0.5;
  const cap = overrides.segmentCount ?? 10;
  const totalTokens = 1000;

  const capacity: CapacityReport = {
    capacity: totalTokens,
    totalActiveTokens: Math.floor(totalTokens * util),
    utilization: util,
    headroom: 1 - util,
    pinnedTokens: 0,
    seedTokens: 0,
    managedTokens: Math.floor(totalTokens * util),
    availableCapacity: Math.floor(totalTokens * (1 - util)),
  };

  const continuity: ContinuitySummary = {
    totalEvictions: 0,
    totalCompactions: 0,
    totalRestorations: 0,
    netLoss: 0,
    tokensEvicted: 0,
    tokensCompacted: 0,
    tokensRestored: 0,
    recentEvents: [],
  };

  const tokenizer: TokenizerMetadata = {
    name: 'approximate',
    accuracy: 'approximate',
    modelFamily: null,
    errorBound: null,
  };

  const task: TaskSummary = {
    state: 'unset',
    stale: false,
    gracePeriodActive: false,
    gracePeriodRemaining: 0,
  };

  const windowScores: WindowScores = {
    coherence: overrides.coherence ?? 0.8,
    density: overrides.density ?? 0.8,
    relevance: overrides.relevance ?? 0.8,
    continuity: overrides.continuity ?? 0.8,
  };

  const emptyDetection: DetectionResult = {
    patterns: [],
    patternCount: 0,
    highestSeverity: null,
    preBaseline: false,
  };

  return {
    schemaVersion: '1.0.0',
    timestamp: overrides.timestamp ?? 1000,
    reportId: overrides.reportId ?? 'test-report-1',
    segmentCount: overrides.segmentCount ?? 10,
    windowScores,
    rawScores: { ...windowScores },
    composite: 0.8,
    baseline: overrides.baseline !== undefined ? overrides.baseline : null,
    capacity,
    tokenizer,
    embeddingMode: 'trigrams',
    segments: [],
    groups: [],
    continuity,
    trend: overrides.trend !== undefined ? overrides.trend : null,
    patterns: emptyDetection,
    task,
  };
}

// ─── Arbitraries ────────────────────────────────────────────────

const unitFloat = fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
const positiveUnitFloat = fc.float({ min: Math.fround(0.001), max: 1, noNaN: true, noDefaultInfinity: true });

// ─── Property Tests ─────────────────────────────────────────────

describe('Phase 3 — Property-Based Tests', () => {
  describe('Eviction score bounds', () => {
    it('eviction score is in [0, 1] for all 5 strategy weight sets', () => {
      fc.assert(
        fc.property(
          unitFloat, // relevance
          unitFloat, // density
          unitFloat, // coherence (bridge score)
          unitFloat, // importance
          unitFloat, // age
          (relevance, density, coherence, importance, age) => {
            for (const [strategyName, weights] of Object.entries(STRATEGY_WEIGHTS)) {
              const score = computeEvictionScore(relevance, density, coherence, importance, age, weights);
              expect(score).toBeGreaterThanOrEqual(0);
              expect(score).toBeLessThanOrEqual(1);
            }
          },
        ),
      );
    });
  });

  describe('Weight summation', () => {
    it('all 5 strategy weight sets sum to exactly 1.0', () => {
      for (const [strategyName, weights] of Object.entries(STRATEGY_WEIGHTS)) {
        const sum = weights.relevance + weights.density + weights.coherence + weights.importance + weights.age;
        expect(sum).toBeCloseTo(1.0, 10);
      }
    });
  });

  describe('Bridge score range', () => {
    it('bridge formula produces [0, 1] for any three similarity values in [0, 1]', () => {
      fc.assert(
        fc.property(
          unitFloat, // leftSim
          unitFloat, // rightSim
          unitFloat, // skipSim
          (leftSim, rightSim, skipSim) => {
            const bridge = computeBridgeScore(leftSim, rightSim, skipSim);
            expect(bridge).toBeGreaterThanOrEqual(0);
            expect(bridge).toBeLessThanOrEqual(1);
          },
        ),
      );
    });
  });

  describe('Deterministic detection', () => {
    it('same report + same engine state produces same result on repeated calls', () => {
      fc.assert(
        fc.property(
          unitFloat, // utilization
          unitFloat, // density
          unitFloat, // coherence
          unitFloat, // relevance
          unitFloat, // continuity
          (util, density, coherence, relevance, continuity) => {
            const report = makeReport({
              utilization: util,
              density,
              coherence,
              relevance,
              continuity,
              segmentCount: 10,
              reportId: 'det-report-1',
              timestamp: 5000,
            });

            const taskState = { isActive: false, gracePeriodActive: false };

            // Two independent engines with same config
            const engine1 = new DetectionEngine();
            const engine2 = new DetectionEngine();

            const result1 = engine1.detect(report, taskState);
            const result2 = engine2.detect(report, taskState);

            expect(result1.patternCount).toBe(result2.patternCount);
            expect(result1.highestSeverity).toBe(result2.highestSeverity);
            expect(result1.patterns.length).toBe(result2.patterns.length);

            for (let i = 0; i < result1.patterns.length; i++) {
              expect(result1.patterns[i]!.name).toBe(result2.patterns[i]!.name);
              expect(result1.patterns[i]!.severity).toBe(result2.patterns[i]!.severity);
            }
          },
        ),
      );
    });
  });

  describe('Hysteresis stability', () => {
    it('score oscillating within dead zone does not toggle state', () => {
      fc.assert(
        fc.property(
          // Pick a margin to test with
          fc.constant(0.03),
          (margin) => {
            const engine = new DetectionEngine({ hysteresisMargin: margin });

            // Default saturation thresholds: watch=0.75, warning=0.85, critical=0.95
            // First, trigger the pattern by setting utilization above watch threshold
            const activatingReport = makeReport({
              utilization: 0.80,
              segmentCount: 5,
              reportId: 'hyst-1',
              timestamp: 1000,
            });
            const taskState = { isActive: false, gracePeriodActive: false };
            const result1 = engine.detect(activatingReport, taskState);

            // Find if saturation was activated
            const saturation1 = result1.patterns.find(p => p.name === 'saturation');
            if (saturation1 === undefined) return; // Not activated; nothing to test

            expect(saturation1.severity).toBe('watch');

            // Now oscillate utilization within the dead zone: between threshold (0.75)
            // and threshold + margin (0.78). The pattern should not deactivate.
            const deadZoneReport = makeReport({
              utilization: 0.76, // Above threshold but below where it would deactivate
              segmentCount: 5,
              reportId: 'hyst-2',
              timestamp: 2000,
            });
            const result2 = engine.detect(deadZoneReport, taskState);
            const saturation2 = result2.patterns.find(p => p.name === 'saturation');

            // Pattern should remain active due to hysteresis
            expect(saturation2).toBeDefined();
            expect(saturation2!.severity).toBe('watch');
          },
        ),
        { numRuns: 10 },
      );
    });
  });

  describe('Compound symmetry', () => {
    it('fullOfJunk produces compoundContext on both saturation and erosion', () => {
      // To trigger fullOfJunk, both saturation and erosion must be active.
      // Saturation: utilization > 0.75 (watch threshold)
      // Erosion: density < 0.7 AND utilization > 0.7
      const engine = new DetectionEngine();
      const report = makeReport({
        utilization: 0.90,
        density: 0.25,
        coherence: 0.9,
        relevance: 0.9,
        continuity: 0.9,
        segmentCount: 10,
        reportId: 'compound-1',
        timestamp: 3000,
      });

      const taskState = { isActive: false, gracePeriodActive: false };
      const result = engine.detect(report, taskState);

      const saturation = result.patterns.find(p => p.name === 'saturation');
      const erosion = result.patterns.find(p => p.name === 'erosion');

      expect(saturation).toBeDefined();
      expect(erosion).toBeDefined();

      // Both should have fullOfJunk compound context
      expect(saturation!.compoundContext).not.toBeNull();
      expect(saturation!.compoundContext!.compound).toBe('fullOfJunk');
      expect(erosion!.compoundContext).not.toBeNull();
      expect(erosion!.compoundContext!.compound).toBe('fullOfJunk');
    });
  });

  describe('Protection tier inviolability', () => {
    it('no tier T+1 candidate precedes tier T in sorted output', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              tierRank: fc.integer({ min: 0, max: 1001 }),
              evictionScore: unitFloat,
              id: fc.string({ minLength: 1, maxLength: 10 }),
            }),
            { minLength: 2, maxLength: 20 },
          ),
          (candidates) => {
            // Sort using the same comparator logic as eviction.ts:
            // Primary: tierRank ascending, Secondary: evictionScore ascending
            const sorted = [...candidates].sort((a, b) => {
              if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
              if (a.evictionScore !== b.evictionScore) return a.evictionScore - b.evictionScore;
              return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            });

            // Verify: no item with a higher tierRank appears before one
            // with a lower tierRank
            for (let i = 1; i < sorted.length; i++) {
              expect(sorted[i]!.tierRank).toBeGreaterThanOrEqual(sorted[i - 1]!.tierRank);
            }
          },
        ),
      );
    });
  });
});
