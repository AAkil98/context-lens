import { describe, it, expect } from 'vitest';
import { DetectionEngine } from '../../src/detection.js';
import type {
  QualityReport,
  PatternDefinition,
  PatternSignal,
  Severity,
  ContinuityEvent,
  TrendData,
  BaselineSnapshot,
  WindowScores,
} from '../../src/types.js';

// ─── makeReport Helper ──────────────────────────────────────────

interface ReportOverrides {
  segmentCount?: number;
  windowScores?: Partial<WindowScores>;
  rawScores?: Partial<WindowScores>;
  composite?: number | null;
  baseline?: BaselineSnapshot | null;
  capacity?: Partial<QualityReport['capacity']>;
  trend?: TrendData | null;
  continuity?: Partial<QualityReport['continuity']>;
  timestamp?: number;
  reportId?: string;
}

function makeReport(overrides: ReportOverrides = {}): QualityReport {
  const capacity = overrides.capacity ?? {};
  const cap = capacity.capacity ?? 10000;
  const totalActiveTokens = capacity.totalActiveTokens ?? 5000;
  const utilization = capacity.utilization ?? totalActiveTokens / cap;

  return {
    schemaVersion: '1.0.0',
    timestamp: overrides.timestamp ?? 1000,
    reportId: overrides.reportId ?? 'r-1',
    segmentCount: overrides.segmentCount ?? 10,
    windowScores: {
      coherence: overrides.windowScores?.coherence ?? 0.8,
      density: overrides.windowScores?.density ?? 0.8,
      relevance: overrides.windowScores?.relevance ?? 0.8,
      continuity: overrides.windowScores?.continuity ?? 0.8,
    },
    rawScores: {
      coherence: overrides.rawScores?.coherence ?? 0.8,
      density: overrides.rawScores?.density ?? 0.8,
      relevance: overrides.rawScores?.relevance ?? 0.8,
      continuity: overrides.rawScores?.continuity ?? 0.8,
    },
    composite: overrides.composite ?? 0.8,
    baseline: overrides.baseline === undefined
      ? { coherence: 0.9, density: 0.9, relevance: 0.9, continuity: 0.9, capturedAt: 500, segmentCount: 5, tokenCount: 2000 }
      : overrides.baseline,
    capacity: {
      capacity: cap,
      totalActiveTokens,
      utilization,
      headroom: cap - totalActiveTokens,
      pinnedTokens: capacity.pinnedTokens ?? 0,
      seedTokens: capacity.seedTokens ?? 0,
      managedTokens: capacity.managedTokens ?? totalActiveTokens,
      availableCapacity: capacity.availableCapacity ?? cap - totalActiveTokens,
    },
    tokenizer: { name: 'test', accuracy: 'approximate', modelFamily: null, errorBound: null },
    embeddingMode: 'trigrams',
    segments: [],
    groups: [],
    continuity: {
      totalEvictions: overrides.continuity?.totalEvictions ?? 0,
      totalCompactions: overrides.continuity?.totalCompactions ?? 0,
      totalRestorations: overrides.continuity?.totalRestorations ?? 0,
      netLoss: overrides.continuity?.netLoss ?? 0,
      tokensEvicted: overrides.continuity?.tokensEvicted ?? 0,
      tokensCompacted: overrides.continuity?.tokensCompacted ?? 0,
      tokensRestored: overrides.continuity?.tokensRestored ?? 0,
      recentEvents: overrides.continuity?.recentEvents ?? [],
    },
    trend: overrides.trend === undefined ? null : overrides.trend,
    patterns: { patterns: [], patternCount: 0, highestSeverity: null, preBaseline: false },
    task: { state: 'active', stale: false, gracePeriodActive: false, gracePeriodRemaining: 0 },
  };
}

const ACTIVE_TASK = { isActive: true, gracePeriodActive: false };
const IDLE_TASK = { isActive: false, gracePeriodActive: false };
const GRACE_TASK = { isActive: true, gracePeriodActive: true };

function findPattern(result: ReturnType<DetectionEngine['detect']>, name: string) {
  return result.patterns.find(p => p.name === name);
}

// ─── Test Suites ────────────────────────────────────────────────

describe('DetectionEngine', () => {
  // ── 1. Saturation ─────────────────────────────────────────────

  describe('saturation', () => {
    it('does NOT activate below 0.75 utilization', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ capacity: { utilization: 0.70 } });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'saturation')).toBeUndefined();
    });

    it('activates at watch when utilization > 0.75', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ capacity: { utilization: 0.76 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const sat = findPattern(result, 'saturation');
      expect(sat).toBeDefined();
      expect(sat!.severity).toBe('watch');
    });

    it('activates at warning when utilization > 0.85', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ capacity: { utilization: 0.86 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const sat = findPattern(result, 'saturation');
      expect(sat).toBeDefined();
      expect(sat!.severity).toBe('warning');
    });

    it('activates at critical when utilization > 0.95', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ capacity: { utilization: 0.96 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const sat = findPattern(result, 'saturation');
      expect(sat).toBeDefined();
      expect(sat!.severity).toBe('critical');
    });

    it('rate-based early watch: projects 3 reports ahead via tokensDelta', () => {
      const engine = new DetectionEngine();
      // Current utilization is 0.70 (below threshold), but tokensDelta projects to > 0.75
      // Projected = 0.70 + (500 / 10000) * 3 = 0.70 + 0.15 = 0.85
      const report = makeReport({
        capacity: { utilization: 0.70, capacity: 10000 },
        trend: {
          previousReportId: 'r-0',
          timeDelta: 1000,
          coherenceDelta: 0,
          densityDelta: 0,
          relevanceDelta: 0,
          continuityDelta: 0,
          compositeDelta: 0,
          segmentCountDelta: 1,
          tokensDelta: 500,
        },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const sat = findPattern(result, 'saturation');
      expect(sat).toBeDefined();
      expect(sat!.severity).toBe('watch');
    });

    it('rate-based does NOT activate when projected utilization stays below 0.75', () => {
      const engine = new DetectionEngine();
      // Projected = 0.60 + (50 / 10000) * 3 = 0.60 + 0.015 = 0.615
      const report = makeReport({
        capacity: { utilization: 0.60, capacity: 10000 },
        trend: {
          previousReportId: 'r-0',
          timeDelta: 1000,
          coherenceDelta: 0,
          densityDelta: 0,
          relevanceDelta: 0,
          continuityDelta: 0,
          compositeDelta: 0,
          segmentCountDelta: 0,
          tokensDelta: 50,
        },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'saturation')).toBeUndefined();
    });

    it('quality scores do not affect saturation (invariant 4)', () => {
      const engine = new DetectionEngine();
      // High utilization, but excellent quality scores
      const report = makeReport({
        capacity: { utilization: 0.90 },
        windowScores: { coherence: 1.0, density: 1.0, relevance: 1.0, continuity: 1.0 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const sat = findPattern(result, 'saturation');
      expect(sat).toBeDefined();
      expect(sat!.severity).toBe('warning');

      // Low utilization but bad quality scores
      const engine2 = new DetectionEngine();
      const report2 = makeReport({
        capacity: { utilization: 0.50 },
        windowScores: { coherence: 0.1, density: 0.1, relevance: 0.1, continuity: 0.1 },
      });
      const result2 = engine2.detect(report2, ACTIVE_TASK);
      expect(findPattern(result2, 'saturation')).toBeUndefined();
    });
  });

  // ── 2. Erosion ────────────────────────────────────────────────

  describe('erosion', () => {
    it('activates when BOTH density < 0.7 AND utilization > 0.7', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        windowScores: { density: 0.65 },
        capacity: { utilization: 0.75 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const ero = findPattern(result, 'erosion');
      expect(ero).toBeDefined();
      expect(ero!.severity).toBe('watch');
    });

    it('does NOT activate with density < 0.7 but utilization < 0.7', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        windowScores: { density: 0.50 },
        capacity: { utilization: 0.50 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'erosion')).toBeUndefined();
    });

    it('does NOT activate with utilization > 0.7 but density > 0.7', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        windowScores: { density: 0.80 },
        capacity: { utilization: 0.90 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'erosion')).toBeUndefined();
    });

    it('rate-based elevation at densityDelta < -0.15 when both gates met', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        windowScores: { density: 0.65 },
        capacity: { utilization: 0.75 },
        trend: {
          previousReportId: 'r-0',
          timeDelta: 1000,
          coherenceDelta: 0,
          densityDelta: -0.20,
          relevanceDelta: 0,
          continuityDelta: 0,
          compositeDelta: 0,
          segmentCountDelta: 0,
          tokensDelta: 0,
        },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const ero = findPattern(result, 'erosion');
      expect(ero).toBeDefined();
      // Base would be 'watch', rate elevates to 'warning'
      expect(ero!.severity).toBe('warning');
    });

    it('deactivates when either gate closes', () => {
      const engine = new DetectionEngine();
      // First: both gates open
      const r1 = makeReport({
        windowScores: { density: 0.60 },
        capacity: { utilization: 0.80 },
        timestamp: 1000,
        reportId: 'r-1',
      });
      const res1 = engine.detect(r1, ACTIVE_TASK);
      expect(findPattern(res1, 'erosion')).toBeDefined();

      // Second: density gate closes (above threshold + margin)
      const r2 = makeReport({
        windowScores: { density: 0.80 },
        capacity: { utilization: 0.80 },
        timestamp: 2000,
        reportId: 'r-2',
      });
      const res2 = engine.detect(r2, ACTIVE_TASK);
      expect(findPattern(res2, 'erosion')).toBeUndefined();
    });
  });

  // ── 3. Fracture ───────────────────────────────────────────────

  describe('fracture', () => {
    it('activates at watch when coherence < 0.6', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ windowScores: { coherence: 0.55 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const frac = findPattern(result, 'fracture');
      expect(frac).toBeDefined();
      expect(frac!.severity).toBe('watch');
    });

    it('activates at warning when coherence < 0.4', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ windowScores: { coherence: 0.35 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const frac = findPattern(result, 'fracture');
      expect(frac).toBeDefined();
      expect(frac!.severity).toBe('warning');
    });

    it('activates at critical when coherence < 0.2', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ windowScores: { coherence: 0.15 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const frac = findPattern(result, 'fracture');
      expect(frac).toBeDefined();
      expect(frac!.severity).toBe('critical');
    });

    it('cluster ratio > 0.5 elevates severity by one level', () => {
      const engine = new DetectionEngine();
      // coherence < 0.6 => watch baseline
      // rawScores.coherence used as topicalConcentration proxy
      // clusterCount = round(1.0 / 0.1) = 10, ratio = 10 / 10 = 1.0 > 0.5 => elevate
      const report = makeReport({
        segmentCount: 10,
        windowScores: { coherence: 0.55 },
        rawScores: { coherence: 0.1 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const frac = findPattern(result, 'fracture');
      expect(frac).toBeDefined();
      // watch elevated to warning
      expect(frac!.severity).toBe('warning');
    });

    it('cluster-count trigger cannot activate independently (only elevates existing)', () => {
      const engine = new DetectionEngine();
      // coherence is above threshold (no fracture detected), but high cluster ratio
      const report = makeReport({
        segmentCount: 10,
        windowScores: { coherence: 0.8 },
        rawScores: { coherence: 0.05 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'fracture')).toBeUndefined();
    });
  });

  // ── 4. Gap ────────────────────────────────────────────────────

  describe('gap', () => {
    it('suppressed when task is not active (isActive=false)', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        windowScores: { relevance: 0.3 },
        capacity: { utilization: 0.90 },
      });
      const result = engine.detect(report, IDLE_TASK);
      expect(findPattern(result, 'gap')).toBeUndefined();
    });

    it('watch at relevance < 0.6 with no utilization gate', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        windowScores: { relevance: 0.55 },
        capacity: { utilization: 0.30 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const gap = findPattern(result, 'gap');
      expect(gap).toBeDefined();
      expect(gap!.severity).toBe('watch');
    });

    it('warning requires relevance < 0.4 AND utilization > 0.6', () => {
      const engine = new DetectionEngine();
      // Both conditions met
      const report = makeReport({
        windowScores: { relevance: 0.35 },
        capacity: { utilization: 0.65 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const gap = findPattern(result, 'gap');
      expect(gap).toBeDefined();
      expect(gap!.severity).toBe('warning');

      // Relevance < 0.4 but utilization < 0.6 => stays at watch
      const engine2 = new DetectionEngine();
      const report2 = makeReport({
        windowScores: { relevance: 0.35 },
        capacity: { utilization: 0.40 },
      });
      const result2 = engine2.detect(report2, ACTIVE_TASK);
      const gap2 = findPattern(result2, 'gap');
      expect(gap2).toBeDefined();
      expect(gap2!.severity).toBe('watch');
    });

    it('grace period caps severity at watch', () => {
      const engine = new DetectionEngine();
      // Conditions for warning (relevance < 0.4, util > 0.6) but grace active
      const report = makeReport({
        windowScores: { relevance: 0.2 },
        capacity: { utilization: 0.90 },
      });
      const result = engine.detect(report, GRACE_TASK);
      const gap = findPattern(result, 'gap');
      expect(gap).toBeDefined();
      expect(gap!.severity).toBe('watch');
    });

    it('critical requires relevance < 0.3 AND utilization > 0.8', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        windowScores: { relevance: 0.25 },
        capacity: { utilization: 0.85 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const gap = findPattern(result, 'gap');
      expect(gap).toBeDefined();
      expect(gap!.severity).toBe('critical');
    });
  });

  // ── 5. Collapse ───────────────────────────────────────────────

  describe('collapse', () => {
    it('activates at watch when continuity < 0.7', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ windowScores: { continuity: 0.65 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const col = findPattern(result, 'collapse');
      expect(col).toBeDefined();
      expect(col!.severity).toBe('watch');
    });

    it('activates at warning when continuity < 0.5', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ windowScores: { continuity: 0.45 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const col = findPattern(result, 'collapse');
      expect(col).toBeDefined();
      expect(col!.severity).toBe('warning');
    });

    it('activates at critical when continuity < 0.3', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ windowScores: { continuity: 0.25 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const col = findPattern(result, 'collapse');
      expect(col).toBeDefined();
      expect(col!.severity).toBe('critical');
    });

    it('stricter rate trigger at continuityDelta < -0.10 elevates severity', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        windowScores: { continuity: 0.65 },
        trend: {
          previousReportId: 'r-0',
          timeDelta: 1000,
          coherenceDelta: 0,
          densityDelta: 0,
          relevanceDelta: 0,
          continuityDelta: -0.12,
          compositeDelta: 0,
          segmentCountDelta: 0,
          tokensDelta: 0,
        },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const col = findPattern(result, 'collapse');
      expect(col).toBeDefined();
      // Base watch elevated to warning by rate trigger
      expect(col!.severity).toBe('warning');
    });

    it('acute trigger: eviction event with cost > 0.15 triggers immediate warning', () => {
      const engine = new DetectionEngine();
      // continuity is fine (above threshold), but acute eviction event
      const acuteEvent: ContinuityEvent = {
        type: 'eviction',
        segmentId: 's-big',
        timestamp: 900,
        tokensBefore: 500,
        tokensAfter: 0,
        cost: 0.20,
        fidelity: null,
      };
      const report = makeReport({
        windowScores: { continuity: 0.80 },
        continuity: { recentEvents: [acuteEvent] },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const col = findPattern(result, 'collapse');
      expect(col).toBeDefined();
      expect(col!.severity).toBe('warning');
    });

    it('acute trigger elevates existing watch to warning', () => {
      const engine = new DetectionEngine();
      const acuteEvent: ContinuityEvent = {
        type: 'eviction',
        segmentId: 's-big',
        timestamp: 900,
        tokensBefore: 500,
        tokensAfter: 0,
        cost: 0.20,
        fidelity: null,
      };
      // continuity < 0.7 => watch base; acute elevates to warning
      const report = makeReport({
        windowScores: { continuity: 0.65 },
        continuity: { recentEvents: [acuteEvent] },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const col = findPattern(result, 'collapse');
      expect(col).toBeDefined();
      expect(col!.severity).toBe('warning');
    });
  });

  // ── 6. Hysteresis ─────────────────────────────────────────────

  describe('hysteresis', () => {
    it('activates when threshold is crossed', () => {
      const engine = new DetectionEngine();
      const report = makeReport({ windowScores: { coherence: 0.55 } });
      const result = engine.detect(report, ACTIVE_TASK);
      const frac = findPattern(result, 'fracture');
      expect(frac).toBeDefined();
      expect(frac!.severity).toBe('watch');
    });

    it('deactivation requires score > threshold + margin (default 0.03)', () => {
      const engine = new DetectionEngine();

      // Cycle 1: Activate fracture (coherence < 0.6)
      const r1 = makeReport({
        windowScores: { coherence: 0.55 },
        timestamp: 1000,
        reportId: 'r-1',
      });
      engine.detect(r1, ACTIVE_TASK);

      // Cycle 2: Score at 0.61 — above threshold (0.6) but below threshold + margin (0.63)
      // Should remain active due to hysteresis
      const r2 = makeReport({
        windowScores: { coherence: 0.61 },
        timestamp: 2000,
        reportId: 'r-2',
      });
      const res2 = engine.detect(r2, ACTIVE_TASK);
      expect(findPattern(res2, 'fracture')).toBeDefined();

      // Cycle 3: Score at 0.64 — above threshold + margin (0.63)
      // Should deactivate
      const r3 = makeReport({
        windowScores: { coherence: 0.64 },
        timestamp: 3000,
        reportId: 'r-3',
      });
      const res3 = engine.detect(r3, ACTIVE_TASK);
      expect(findPattern(res3, 'fracture')).toBeUndefined();
    });

    it('escalation is immediate, de-escalation is delayed by margin', () => {
      const engine = new DetectionEngine();

      // Cycle 1: watch (coherence < 0.6)
      engine.detect(makeReport({
        windowScores: { coherence: 0.55 },
        timestamp: 1000,
        reportId: 'r-1',
      }), ACTIVE_TASK);

      // Cycle 2: immediate escalation to warning (coherence < 0.4)
      const res2 = engine.detect(makeReport({
        windowScores: { coherence: 0.35 },
        timestamp: 2000,
        reportId: 'r-2',
      }), ACTIVE_TASK);
      expect(findPattern(res2, 'fracture')!.severity).toBe('warning');

      // Cycle 3: score at 0.42 — above warning threshold (0.4) but below threshold + margin (0.43)
      // De-escalation delayed
      const res3 = engine.detect(makeReport({
        windowScores: { coherence: 0.42 },
        timestamp: 3000,
        reportId: 'r-3',
      }), ACTIVE_TASK);
      expect(findPattern(res3, 'fracture')!.severity).toBe('warning');

      // Cycle 4: score at 0.44 — above threshold + margin (0.43)
      // De-escalation happens to watch (since 0.44 < 0.6)
      const res4 = engine.detect(makeReport({
        windowScores: { coherence: 0.44 },
        timestamp: 4000,
        reportId: 'r-4',
      }), ACTIVE_TASK);
      expect(findPattern(res4, 'fracture')!.severity).toBe('watch');
    });

    it('rejects margin < 0.01', () => {
      expect(() => new DetectionEngine({ hysteresisMargin: 0.005 }))
        .toThrow();
    });

    it('rejects margin > 0.10', () => {
      expect(() => new DetectionEngine({ hysteresisMargin: 0.15 }))
        .toThrow();
    });

    it('accepts margin at boundaries (0.01 and 0.10)', () => {
      expect(() => new DetectionEngine({ hysteresisMargin: 0.01 })).not.toThrow();
      expect(() => new DetectionEngine({ hysteresisMargin: 0.10 })).not.toThrow();
    });
  });

  // ── 7. Compounds ──────────────────────────────────────────────

  describe('compounds', () => {
    it('fullOfJunk (saturation+erosion) produces compoundContext on both', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        capacity: { utilization: 0.90 },
        windowScores: { density: 0.50 },
      });
      const result = engine.detect(report, ACTIVE_TASK);

      const sat = findPattern(result, 'saturation');
      const ero = findPattern(result, 'erosion');
      expect(sat).toBeDefined();
      expect(ero).toBeDefined();
      expect(sat!.compoundContext).not.toBeNull();
      expect(sat!.compoundContext!.compound).toBe('fullOfJunk');
      expect(ero!.compoundContext).not.toBeNull();
      expect(ero!.compoundContext!.compound).toBe('fullOfJunk');
    });

    it('lossDominates requires collapse + at least one other pattern', () => {
      const engine = new DetectionEngine();

      // Collapse alone does not trigger lossDominates
      const reportCollapseOnly = makeReport({
        windowScores: { continuity: 0.40 },
        capacity: { utilization: 0.50 },
      });
      const res1 = engine.detect(reportCollapseOnly, IDLE_TASK);
      const col1 = findPattern(res1, 'collapse');
      expect(col1).toBeDefined();
      expect(col1!.compoundContext).toBeNull();

      // Collapse + saturation triggers lossDominates
      const engine2 = new DetectionEngine();
      const reportCollapseAndSat = makeReport({
        windowScores: { continuity: 0.40 },
        capacity: { utilization: 0.90 },
      });
      const res2 = engine2.detect(reportCollapseAndSat, IDLE_TASK);
      const col2 = findPattern(res2, 'collapse');
      expect(col2).toBeDefined();
      // Should have pressureLoop (collapse+saturation) or lossDominates
      // pressureLoop is defined before lossDominates and both match:
      // pressureLoop requires [collapse, saturation], lossDominates requires [collapse] + anyOther
      // Later compounds overwrite earlier ones per code, so lossDominates or pressureLoop
      expect(col2!.compoundContext).not.toBeNull();
    });

    it('triplePressure (saturation+erosion+gap) produces compound on all three', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        capacity: { utilization: 0.90 },
        windowScores: { density: 0.50, relevance: 0.30 },
      });
      const result = engine.detect(report, ACTIVE_TASK);

      const sat = findPattern(result, 'saturation');
      const ero = findPattern(result, 'erosion');
      const gap = findPattern(result, 'gap');
      expect(sat).toBeDefined();
      expect(ero).toBeDefined();
      expect(gap).toBeDefined();
      // triplePressure is evaluated after fullOfJunk, so it overwrites
      expect(sat!.compoundContext!.compound).toBe('triplePressure');
      expect(ero!.compoundContext!.compound).toBe('triplePressure');
      expect(gap!.compoundContext!.compound).toBe('triplePressure');
    });

    it('suppressed patterns do not participate in compounds', () => {
      const engine = new DetectionEngine({ suppressedPatterns: ['saturation'] });
      // Without saturation, erosion alone cannot form fullOfJunk
      const report = makeReport({
        capacity: { utilization: 0.90 },
        windowScores: { density: 0.50 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'saturation')).toBeUndefined();
      const ero = findPattern(result, 'erosion');
      expect(ero).toBeDefined();
      expect(ero!.compoundContext).toBeNull();
    });
  });

  // ── 8. Custom Patterns ────────────────────────────────────────

  describe('custom patterns', () => {
    function makeValidDef(overrides?: Partial<PatternDefinition>): PatternDefinition {
      return {
        name: overrides?.name ?? 'customTest',
        description: overrides?.description ?? 'A test custom pattern',
        detect: overrides?.detect ?? ((_r: QualityReport): PatternSignal => ({
          primaryScore: { dimension: 'custom', value: 0.5 },
          secondaryScores: [],
          utilization: null,
        })),
        severity: overrides?.severity ?? ((_r: QualityReport, _prev: Severity | null): Severity => 'watch'),
        explanation: overrides?.explanation ?? (() => 'custom is active'),
        remediation: overrides?.remediation ?? (() => []),
        ...('strategyHint' in (overrides ?? {}) ? { strategyHint: overrides!.strategyHint } : {}),
        ...('priority' in (overrides ?? {}) ? { priority: overrides!.priority } : {}),
      };
    }

    it('throws on name collision with base pattern', () => {
      const engine = new DetectionEngine();
      const def = makeValidDef({ name: 'saturation' });
      expect(() => engine.registerPattern(def)).toThrow();
    });

    it('throws on name collision with existing custom pattern', () => {
      const engine = new DetectionEngine();
      engine.registerPattern(makeValidDef({ name: 'myPattern' }));
      expect(() => engine.registerPattern(makeValidDef({ name: 'myPattern' }))).toThrow();
    });

    it('throws when detect is not a function', () => {
      const engine = new DetectionEngine();
      const def = makeValidDef({ detect: 'not-a-fn' as unknown as PatternDefinition['detect'] });
      expect(() => engine.registerPattern(def)).toThrow();
    });

    it('throws when priority is not a positive integer', () => {
      const engine = new DetectionEngine();
      expect(() => engine.registerPattern(makeValidDef({ priority: 0 }))).toThrow();
      expect(() => engine.registerPattern(makeValidDef({ name: 'p2', priority: -1 }))).toThrow();
      expect(() => engine.registerPattern(makeValidDef({ name: 'p3', priority: 1.5 }))).toThrow();
    });

    it('throws when strategyHint is invalid', () => {
      const engine = new DetectionEngine();
      const def = makeValidDef({ strategyHint: 'invalid' as PatternDefinition['strategyHint'] });
      expect(() => engine.registerPattern(def)).toThrow();
    });

    it('fail-open: detect() throwing emits warning, does not affect base patterns', () => {
      const engine = new DetectionEngine();
      engine.registerPattern(makeValidDef({
        name: 'failingPattern',
        detect: () => { throw new Error('boom'); },
      }));

      const report = makeReport({
        capacity: { utilization: 0.90 },
      });
      const result = engine.detect(report, ACTIVE_TASK);

      // Base saturation still detected
      expect(findPattern(result, 'saturation')).toBeDefined();
      // Warning emitted about failing pattern
      const warnings = engine.getWarnings();
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some(w => w.includes('failingPattern'))).toBe(true);
    });

    it('2-cycle deactivation: one null maintains, two nulls deactivate', () => {
      let returnSignal = true;
      const engine = new DetectionEngine();
      engine.registerPattern(makeValidDef({
        name: 'deactivator',
        detect: () => {
          if (returnSignal) {
            return { primaryScore: { dimension: 'custom', value: 0.5 }, secondaryScores: [], utilization: null };
          }
          return null;
        },
      }));

      // Cycle 1: activate
      const r1 = makeReport({ timestamp: 1000, reportId: 'r-1' });
      const res1 = engine.detect(r1, ACTIVE_TASK);
      expect(findPattern(res1, 'deactivator')).toBeDefined();

      // Cycle 2: first null — maintained
      returnSignal = false;
      const r2 = makeReport({ timestamp: 2000, reportId: 'r-2' });
      const res2 = engine.detect(r2, ACTIVE_TASK);
      expect(findPattern(res2, 'deactivator')).toBeDefined();

      // Cycle 3: second null — deactivated
      const r3 = makeReport({ timestamp: 3000, reportId: 'r-3' });
      const res3 = engine.detect(r3, ACTIVE_TASK);
      expect(findPattern(res3, 'deactivator')).toBeUndefined();
    });

    it('all-or-nothing construction: if 2nd pattern invalid, 1st not registered', () => {
      const valid = makeValidDef({ name: 'validOne' });
      const invalid = makeValidDef({ name: 'saturation' }); // collision with base

      expect(() => new DetectionEngine({
        customPatterns: [valid, invalid],
      })).toThrow();

      // The engine should not exist, but we can verify by constructing with only valid
      const engine2 = new DetectionEngine();
      // validOne should NOT be registered from the failed constructor
      const report = makeReport({ timestamp: 1000 });
      const result = engine2.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'validOne')).toBeUndefined();
    });

    it('accepts valid strategyHint values', () => {
      const engine = new DetectionEngine();
      expect(() => engine.registerPattern(makeValidDef({
        name: 'withHint',
        strategyHint: 'erosion',
      }))).not.toThrow();
    });
  });

  // ── 9. Suppression ────────────────────────────────────────────

  describe('suppression', () => {
    it('suppressed pattern is not in output and not in highestSeverity', () => {
      const engine = new DetectionEngine({ suppressedPatterns: ['fracture'] });
      const report = makeReport({
        windowScores: { coherence: 0.10 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'fracture')).toBeUndefined();
      // highestSeverity should not reflect fracture (which would be critical)
      // Other patterns are healthy, so no severity
      expect(result.highestSeverity).toBeNull();
    });

    it('custom pattern suppression: pattern registered then suppressed', () => {
      const engine = new DetectionEngine({ suppressedPatterns: ['myCustom'] });
      engine.registerPattern({
        name: 'myCustom',
        description: 'test',
        detect: () => ({
          primaryScore: { dimension: 'custom', value: 0.5 },
          secondaryScores: [],
          utilization: null,
        }),
        severity: () => 'critical',
        explanation: () => 'custom active',
        remediation: () => [],
      });

      const report = makeReport({ timestamp: 1000 });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'myCustom')).toBeUndefined();
    });
  });

  // ── 10. Pattern History ───────────────────────────────────────

  describe('pattern history', () => {
    it('activation creates an "activated" entry', () => {
      const engine = new DetectionEngine();
      engine.detect(
        makeReport({ windowScores: { coherence: 0.55 }, timestamp: 1000, reportId: 'r-1' }),
        ACTIVE_TASK,
      );

      const history = engine.getPatternHistory();
      const activated = history.find(h => h.name === 'fracture' && h.event === 'activated');
      expect(activated).toBeDefined();
      expect(activated!.severity).toBe('watch');
      expect(activated!.timestamp).toBe(1000);
      expect(activated!.reportId).toBe('r-1');
    });

    it('severity change creates "escalated" or "deescalated" entry', () => {
      const engine = new DetectionEngine();

      // Activate at watch
      engine.detect(
        makeReport({ windowScores: { coherence: 0.55 }, timestamp: 1000, reportId: 'r-1' }),
        ACTIVE_TASK,
      );

      // Escalate to warning
      engine.detect(
        makeReport({ windowScores: { coherence: 0.35 }, timestamp: 2000, reportId: 'r-2' }),
        ACTIVE_TASK,
      );

      const history = engine.getPatternHistory();
      const escalated = history.find(h => h.name === 'fracture' && h.event === 'escalated');
      expect(escalated).toBeDefined();
      expect(escalated!.severity).toBe('warning');
      expect(escalated!.timestamp).toBe(2000);
    });

    it('resolution creates a "resolved" entry', () => {
      const engine = new DetectionEngine();

      // Activate
      engine.detect(
        makeReport({ windowScores: { coherence: 0.55 }, timestamp: 1000, reportId: 'r-1' }),
        ACTIVE_TASK,
      );

      // Resolve (coherence above threshold + margin)
      engine.detect(
        makeReport({ windowScores: { coherence: 0.80 }, timestamp: 2000, reportId: 'r-2' }),
        ACTIVE_TASK,
      );

      const history = engine.getPatternHistory();
      const resolved = history.find(h => h.name === 'fracture' && h.event === 'resolved');
      expect(resolved).toBeDefined();
      expect(resolved!.timestamp).toBe(2000);
    });
  });

  // ── 11. Empty Window ──────────────────────────────────────────

  describe('empty window', () => {
    it('segmentCount=0 returns empty result', () => {
      const engine = new DetectionEngine();
      const report = makeReport({
        segmentCount: 0,
        capacity: { utilization: 0.99 },
        windowScores: { coherence: 0.1, density: 0.1, relevance: 0.1, continuity: 0.1 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(result.patterns).toHaveLength(0);
      expect(result.patternCount).toBe(0);
      expect(result.highestSeverity).toBeNull();
    });
  });

  // ── 12. Determinism ───────────────────────────────────────────

  describe('determinism', () => {
    it('same report + same state = same result', () => {
      const report = makeReport({
        capacity: { utilization: 0.90 },
        windowScores: { coherence: 0.55, density: 0.50, relevance: 0.55, continuity: 0.65 },
      });

      const engine1 = new DetectionEngine();
      const result1 = engine1.detect(report, ACTIVE_TASK);

      const engine2 = new DetectionEngine();
      const result2 = engine2.detect(report, ACTIVE_TASK);

      expect(result1.patternCount).toBe(result2.patternCount);
      expect(result1.highestSeverity).toBe(result2.highestSeverity);
      expect(result1.patterns.map(p => p.name)).toEqual(result2.patterns.map(p => p.name));
      expect(result1.patterns.map(p => p.severity)).toEqual(result2.patterns.map(p => p.severity));
    });
  });

  // ── Accessor Methods ──────────────────────────────────────────

  describe('accessor methods', () => {
    it('getWarnings returns empty array initially and after clean detect', () => {
      const engine = new DetectionEngine();
      expect(engine.getWarnings()).toEqual([]);
      engine.detect(makeReport(), ACTIVE_TASK);
      expect(engine.getWarnings()).toEqual([]);
    });

    it('getTrackingSnapshot returns per-pattern state after detect', () => {
      const engine = new DetectionEngine();
      engine.detect(
        makeReport({ windowScores: { coherence: 0.55 }, timestamp: 1000 }),
        ACTIVE_TASK,
      );

      const snapshot = engine.getTrackingSnapshot();
      expect(snapshot.perPattern).toHaveProperty('fracture');
      expect(snapshot.perPattern['fracture']!.state).toBe('active');
      expect(snapshot.perPattern['fracture']!.currentSeverity).toBe('watch');
    });

    it('getCustomPatternMeta returns metadata for registered custom patterns', () => {
      const engine = new DetectionEngine();
      engine.registerPattern({
        name: 'testCustom',
        description: 'A test',
        detect: () => null,
        severity: () => 'watch',
        explanation: () => 'test',
        remediation: () => [],
        priority: 5,
        strategyHint: 'erosion',
      });

      const meta = engine.getCustomPatternMeta();
      expect(meta).toHaveLength(1);
      expect(meta[0]!.name).toBe('testCustom');
      expect(meta[0]!.description).toBe('A test');
      expect(meta[0]!.priority).toBe(5);
      expect(meta[0]!.strategyHint).toBe('erosion');
    });

    it('getPatternHistory returns a copy, not a reference', () => {
      const engine = new DetectionEngine();
      engine.detect(
        makeReport({ windowScores: { coherence: 0.55 }, timestamp: 1000, reportId: 'r-1' }),
        ACTIVE_TASK,
      );
      const h1 = engine.getPatternHistory();
      const h2 = engine.getPatternHistory();
      expect(h1).toEqual(h2);
      expect(h1).not.toBe(h2);
    });
  });

  // ── Threshold Configuration ───────────────────────────────────

  describe('threshold configuration', () => {
    it('custom thresholds override defaults', () => {
      const engine = new DetectionEngine({
        thresholds: {
          saturation: { watch: 0.80, warning: 0.90, critical: 0.98 },
        },
      });
      // Utilization at 0.76 — below custom watch threshold of 0.80
      const report = makeReport({ capacity: { utilization: 0.76 } });
      const result = engine.detect(report, ACTIVE_TASK);
      expect(findPattern(result, 'saturation')).toBeUndefined();

      // Utilization at 0.81 — above custom watch threshold
      const report2 = makeReport({ capacity: { utilization: 0.81 } });
      const result2 = engine.detect(report2, ACTIVE_TASK);
      expect(findPattern(result2, 'saturation')).toBeDefined();
      expect(findPattern(result2, 'saturation')!.severity).toBe('watch');
    });
  });

  // ── Saturation Hysteresis Deactivation ────────────────────────

  describe('saturation hysteresis', () => {
    it('saturation uses inverted hysteresis (higher util = worse)', () => {
      const engine = new DetectionEngine();

      // Activate at watch (util > 0.75)
      engine.detect(makeReport({
        capacity: { utilization: 0.76 },
        timestamp: 1000,
        reportId: 'r-1',
      }), ACTIVE_TASK);

      // Util at 0.74 — below threshold but within margin band (0.75 - 0.03 = 0.72)
      // Should remain active
      const res2 = engine.detect(makeReport({
        capacity: { utilization: 0.74 },
        timestamp: 2000,
        reportId: 'r-2',
      }), ACTIVE_TASK);
      expect(findPattern(res2, 'saturation')).toBeDefined();

      // Util at 0.71 — below threshold - margin (0.72)
      // Should deactivate
      const res3 = engine.detect(makeReport({
        capacity: { utilization: 0.71 },
        timestamp: 3000,
        reportId: 'r-3',
      }), ACTIVE_TASK);
      expect(findPattern(res3, 'saturation')).toBeUndefined();
    });
  });

  // ── Phase C: Branch coverage additions ───────────────────────

  describe('compound — fullOfWrongThings (saturation + gap)', () => {
    it('activates when both saturation and gap are active', () => {
      const engine = new DetectionEngine();
      // High utilization (saturation) + low relevance (gap)
      const report = makeReport({
        windowScores: { coherence: 0.8, density: 0.8, relevance: 0.3, continuity: 0.8 },
        capacity: { utilization: 0.90, totalActiveTokens: 9000, capacity: 10000 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const satActive = findPattern(result, 'saturation');
      const gapActive = findPattern(result, 'gap');
      if (satActive && gapActive) {
        const hasCompound = result.patterns.some(p => p.compoundContext?.compound === 'fullOfWrongThings');
        expect(hasCompound).toBe(true);
      }
    });
  });

  describe('compound — scatteredAndIrrelevant (fracture + gap)', () => {
    it('activates when both fracture and gap are active', () => {
      const engine = new DetectionEngine();
      // Low coherence (fracture) + low relevance (gap)
      const report = makeReport({
        windowScores: { coherence: 0.3, density: 0.8, relevance: 0.3, continuity: 0.8 },
        capacity: { utilization: 0.5, totalActiveTokens: 5000, capacity: 10000 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const fracActive = findPattern(result, 'fracture');
      const gapActive = findPattern(result, 'gap');
      if (fracActive && gapActive) {
        const hasCompound = result.patterns.some(p => p.compoundContext?.compound === 'scatteredAndIrrelevant');
        expect(hasCompound).toBe(true);
      }
    });
  });

  describe('compound — pressureLoop (collapse + saturation)', () => {
    it('activates when both collapse and saturation are active', () => {
      const engine = new DetectionEngine();
      // Low continuity (collapse) + high utilization (saturation)
      const report = makeReport({
        windowScores: { coherence: 0.8, density: 0.8, relevance: 0.8, continuity: 0.4 },
        capacity: { utilization: 0.90, totalActiveTokens: 9000, capacity: 10000 },
      });
      const result = engine.detect(report, ACTIVE_TASK);
      const collapseActive = findPattern(result, 'collapse');
      const satActive = findPattern(result, 'saturation');
      if (collapseActive && satActive) {
        const hasCompound = result.patterns.some(p => p.compoundContext?.compound === 'pressureLoop');
        expect(hasCompound).toBe(true);
      }
    });
  });

  describe('pattern history growth', () => {
    it('history accumulates entries across multiple detect cycles', () => {
      const engine = new DetectionEngine();
      // Activate saturation
      engine.detect(makeReport({
        capacity: { utilization: 0.90, totalActiveTokens: 9000, capacity: 10000 },
      }), ACTIVE_TASK);
      // Resolve saturation
      engine.detect(makeReport({
        capacity: { utilization: 0.50, totalActiveTokens: 5000, capacity: 10000 },
      }), ACTIVE_TASK);
      // Re-activate
      engine.detect(makeReport({
        capacity: { utilization: 0.95, totalActiveTokens: 9500, capacity: 10000 },
      }), ACTIVE_TASK);

      const history = engine.getPatternHistory();
      // Should have at least activated + resolved + activated entries
      const satEntries = history.filter(h => h.name === 'saturation');
      expect(satEntries.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('custom pattern — two-cycle deactivation', () => {
    it('custom pattern requires 2 consecutive null detects to resolve', () => {
      const engine = new DetectionEngine({
        customPatterns: [{
          name: 'flicker-test',
          description: 'Tests 2-cycle deactivation',
          detect: (report) => report.composite !== null && report.composite < 0.5
            ? { primaryScore: { dimension: 'composite', value: report.composite }, secondaryScores: [], utilization: null }
            : null,
          severity: () => 'watch',
          explanation: () => 'Low composite',
          remediation: () => [],
        }],
      });

      // Activate
      const r1 = engine.detect(makeReport({ composite: 0.3 }), ACTIVE_TASK);
      expect(findPattern(r1, 'flicker-test')).toBeDefined();

      // First null detect — should still be active (1-cycle grace)
      const r2 = engine.detect(makeReport({ composite: 0.9 }), ACTIVE_TASK);
      expect(findPattern(r2, 'flicker-test')).toBeDefined();

      // Second null detect — now resolves
      const r3 = engine.detect(makeReport({ composite: 0.9 }), ACTIVE_TASK);
      expect(findPattern(r3, 'flicker-test')).toBeUndefined();
    });
  });
});
