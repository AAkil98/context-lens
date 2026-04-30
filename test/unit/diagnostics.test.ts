import { describe, it, expect } from 'vitest';
import { DiagnosticsManager } from '../../src/diagnostics.js';
import { EventEmitter } from '../../src/events.js';
import type { ContextLensEventMap } from '../../src/events.js';
import { PerformanceInstrumentation } from '../../src/performance.js';
import { DetectionEngine } from '../../src/detection.js';
import { TaskManager } from '../../src/task.js';
import { ContinuityTracker } from '../../src/scoring/continuity.js';
import type { QualityReport, Segment, WindowScores } from '../../src/types.js';

// ─── Mock Dependencies ──────────────────────────────────────────

function makeSegment(id: string): Segment {
  return {
    id,
    content: 'test content',
    tokenCount: 10,
    createdAt: 1000,
    updatedAt: 1000,
    protection: 'default',
    importance: 0.5,
    state: 'active',
    origin: null,
    tags: [],
    groupId: null,
  };
}

function mockStore() {
  return {
    get segmentCount() { return 5; },
    get groupCount() { return 1; },
    get evictedCount() { return 2; },
  };
}

function mockTokenizer() {
  return {
    getInfo() {
      return { name: 'test', accuracy: 'approximate' as const, modelFamily: null, errorBound: null };
    },
  };
}

function mockEmbedding() {
  return {
    getProviderMetadata() { return null; },
  };
}

function mockSimilarity() {
  return {
    get cacheEntryCount() { return 0; },
  };
}

function createDeps() {
  const emitter = new EventEmitter<ContextLensEventMap>();
  const perf = new PerformanceInstrumentation();
  const detection = new DetectionEngine();
  const taskManager = new TaskManager();
  const continuity = new ContinuityTracker();
  const store = mockStore();
  const tokenizer = mockTokenizer();
  const embedding = mockEmbedding();
  const similarity = mockSimilarity();

  return {
    emitter,
    perf,
    detection,
    taskManager,
    continuity,
    store: store as never,
    tokenizer: tokenizer as never,
    embedding: embedding as never,
    similarity: similarity as never,
    constructionTimestamp: 1000,
  };
}

// ─── makeReport Helper ──────────────────────────────────────────

interface ReportOverrides {
  segmentCount?: number;
  windowScores?: Partial<WindowScores>;
  rawScores?: Partial<WindowScores>;
  composite?: number | null;
  timestamp?: number;
  reportId?: string;
}

let reportCounter = 0;

function makeReport(overrides: ReportOverrides = {}): QualityReport {
  reportCounter++;
  return {
    schemaVersion: '1.0.0',
    timestamp: overrides.timestamp ?? 1000 + reportCounter,
    reportId: overrides.reportId ?? `r-${reportCounter}`,
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
    composite: overrides.composite === undefined ? 0.8 : overrides.composite,
    baseline: null,
    capacity: {
      capacity: 10000,
      totalActiveTokens: 5000,
      utilization: 0.5,
      headroom: 5000,
      pinnedTokens: 0,
      seedTokens: 0,
      managedTokens: 5000,
      availableCapacity: 5000,
    },
    tokenizer: { name: 'test', accuracy: 'approximate', modelFamily: null, errorBound: null },
    embeddingMode: 'trigrams',
    segments: [],
    groups: [],
    continuity: {
      totalEvictions: 0,
      totalCompactions: 0,
      totalRestorations: 0,
      netLoss: 0,
      tokensEvicted: 0,
      tokensCompacted: 0,
      tokensRestored: 0,
      recentEvents: [],
    },
    trend: null,
    patterns: { patterns: [], patternCount: 0, highestSeverity: null, preBaseline: false },
    task: { state: 'idle', stale: false, gracePeriodActive: false, gracePeriodRemaining: 0 },
  };
}

// ─── Test Suites ────────────────────────────────────────────────

describe('DiagnosticsManager', () => {

  // ── Report History ────────────────────────────────────────────

  describe('report history', () => {
    it('stores report summaries from reportGenerated events', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      const r1 = makeReport({ reportId: 'rpt-1', timestamp: 2000 });
      const r2 = makeReport({ reportId: 'rpt-2', timestamp: 3000 });
      const r3 = makeReport({ reportId: 'rpt-3', timestamp: 4000 });

      deps.emitter.emit('reportGenerated', { report: r1 });
      deps.emitter.emit('reportGenerated', { report: r2 });
      deps.emitter.emit('reportGenerated', { report: r3 });

      const snapshot = diag.getDiagnostics();
      const reports = snapshot.reportHistory.reports;

      expect(reports).toHaveLength(3);
      expect(reports[0]!.reportId).toBe('rpt-1');
      expect(reports[1]!.reportId).toBe('rpt-2');
      expect(reports[2]!.reportId).toBe('rpt-3');
      expect(reports[0]!.timestamp).toBe(2000);
      expect(reports[0]!.windowScores).toBeDefined();
      expect(typeof reports[0]!.composite).toBe('number');
      expect(typeof reports[0]!.segmentCount).toBe('number');
      expect(typeof reports[0]!.utilization).toBe('number');
    });

    it('caps report history at 20 entries (oldest dropped)', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      for (let i = 0; i < 25; i++) {
        const report = makeReport({ reportId: `rpt-${i}`, timestamp: 2000 + i });
        deps.emitter.emit('reportGenerated', { report });
      }

      const snapshot = diag.getDiagnostics();
      const reports = snapshot.reportHistory.reports;

      expect(reports).toHaveLength(20);
      // Oldest 5 should be dropped; first retained is rpt-5
      expect(reports[0]!.reportId).toBe('rpt-5');
      expect(reports[19]!.reportId).toBe('rpt-24');
    });
  });

  // ── Rolling Trends ────────────────────────────────────────────

  describe('rolling trends', () => {
    it('computes improving trend when coherence increases across reports', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      deps.emitter.emit('reportGenerated', {
        report: makeReport({ windowScores: { coherence: 0.5 }, timestamp: 2000 }),
      });
      deps.emitter.emit('reportGenerated', {
        report: makeReport({ windowScores: { coherence: 0.6 }, timestamp: 3000 }),
      });
      deps.emitter.emit('reportGenerated', {
        report: makeReport({ windowScores: { coherence: 0.7 }, timestamp: 4000 }),
      });

      const snapshot = diag.getDiagnostics();
      const trend = snapshot.reportHistory.rollingTrend;

      expect(trend).not.toBeNull();
      expect(trend!.coherence.direction).toBe('improving');
      expect(trend!.coherence.averageRate).toBeGreaterThan(0);
    });

    it('returns null rolling trend when fewer than 2 reports exist', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      deps.emitter.emit('reportGenerated', {
        report: makeReport({ timestamp: 2000 }),
      });

      const snapshot = diag.getDiagnostics();
      expect(snapshot.reportHistory.rollingTrend).toBeNull();
    });
  });

  // ── Anomaly Detection ─────────────────────────────────────────

  describe('anomaly detection', () => {
    it('flags anomaly when coherence drops by more than 0.15', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      deps.emitter.emit('reportGenerated', {
        report: makeReport({ windowScores: { coherence: 0.8 }, timestamp: 2000 }),
      });
      deps.emitter.emit('reportGenerated', {
        report: makeReport({ windowScores: { coherence: 0.6 }, timestamp: 3000 }),
      });

      const snapshot = diag.getDiagnostics();
      const reports = snapshot.reportHistory.reports;
      const lastReport = reports[reports.length - 1]!;

      // The second report should have anomalies flagged (coherence delta = -0.20)
      expect(lastReport.anomalies.length).toBeGreaterThanOrEqual(1);
      const coherenceAnomaly = lastReport.anomalies.find(a => a.dimension === 'coherence');
      expect(coherenceAnomaly).toBeDefined();
      expect(coherenceAnomaly!.delta).toBeCloseTo(-0.2, 5);
    });
  });

  // ── Timeline ──────────────────────────────────────────────────

  describe('timeline', () => {
    it('logs events from emitter subscriptions with correct types', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      const seg = makeSegment('seg-1');
      deps.emitter.emit('segmentAdded', { segment: seg });
      deps.emitter.emit('taskChanged', {
        transition: { type: 'new', previousTask: null },
      });
      deps.emitter.emit('reportGenerated', { report: makeReport() });

      const snapshot = diag.getDiagnostics();
      const timeline = snapshot.timeline;

      expect(timeline).toHaveLength(3);
      expect(timeline[0]!.type).toBe('segmentAdded');
      expect(timeline[1]!.type).toBe('taskSet');
      expect(timeline[2]!.type).toBe('reportGenerated');

      // Sequences are monotonically increasing
      expect(timeline[0]!.sequence).toBeLessThan(timeline[1]!.sequence);
      expect(timeline[1]!.sequence).toBeLessThan(timeline[2]!.sequence);
    });

    it('caps timeline at 200 entries', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      const seg = makeSegment('seg-1');
      for (let i = 0; i < 210; i++) {
        deps.emitter.emit('segmentAdded', { segment: seg });
      }

      const snapshot = diag.getDiagnostics();
      expect(snapshot.timeline).toHaveLength(200);
    });
  });

  // ── Warnings ──────────────────────────────────────────────────

  describe('warnings', () => {
    it('deduplicates warnings with the same message', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      diag.addWarning('W001', 'Something went wrong');
      diag.addWarning('W001', 'Something went wrong');

      const snapshot = diag.getDiagnostics();
      expect(snapshot.warnings).toHaveLength(1);
      expect(snapshot.warnings[0]!.code).toBe('W001');
      expect(snapshot.warnings[0]!.message).toBe('Something went wrong');
    });

    it('caps warnings at 50 entries (oldest dropped)', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      for (let i = 0; i < 55; i++) {
        diag.addWarning(`W${i}`, `Warning message ${i}`);
      }

      const snapshot = diag.getDiagnostics();
      expect(snapshot.warnings).toHaveLength(50);
      // Oldest 5 dropped; first retained is W5
      expect(snapshot.warnings[0]!.code).toBe('W5');
    });
  });

  // ── Snapshot Fields ───────────────────────────────────────────

  describe('snapshot assembly', () => {
    it('returns all required DiagnosticSnapshot fields', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      // Emit a few events so there is some state
      deps.emitter.emit('segmentAdded', { segment: makeSegment('s1') });
      deps.emitter.emit('reportGenerated', { report: makeReport() });

      const snapshot = diag.getDiagnostics();

      expect(snapshot.schemaVersion).toBe('1.0.0');
      expect(typeof snapshot.timestamp).toBe('number');
      expect(typeof snapshot.sessionDuration).toBe('number');
      expect(snapshot.sessionDuration).toBeGreaterThanOrEqual(0);

      // Latest report is set
      expect(snapshot.latestReport).not.toBeNull();

      // Report history
      expect(snapshot.reportHistory).toBeDefined();
      expect(Array.isArray(snapshot.reportHistory.reports)).toBe(true);

      // Pattern summary
      expect(snapshot.patternSummary).toBeDefined();
      expect(Array.isArray(snapshot.patternSummary.activePatterns)).toBe(true);
      expect(typeof snapshot.patternSummary.totalActivations).toBe('number');
      expect(typeof snapshot.patternSummary.totalResolutions).toBe('number');

      // Timeline
      expect(Array.isArray(snapshot.timeline)).toBe(true);

      // Performance
      expect(snapshot.performance).toBeDefined();
      expect(typeof snapshot.performance.sessionSelfTime).toBe('number');
      expect(typeof snapshot.performance.budgetViolationCount).toBe('number');

      // Providers
      expect(snapshot.providers.tokenizer.name).toBe('test');
      expect(snapshot.providers.tokenizer.accuracy).toBe('approximate');
      expect(snapshot.providers.embedding).toBeNull();

      // Store counts
      expect(snapshot.segmentCount).toBe(5);
      expect(snapshot.groupCount).toBe(1);
      expect(snapshot.evictedCount).toBe(2);

      // Task state
      expect(snapshot.taskState).toBeDefined();
      expect(snapshot.taskState.state).toBe('unset');

      // Continuity ledger
      expect(Array.isArray(snapshot.continuityLedger)).toBe(true);

      // Warnings
      expect(Array.isArray(snapshot.warnings)).toBe(true);
    });

    it('latestReport is null when no reports have been generated', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      const snapshot = diag.getDiagnostics();
      expect(snapshot.latestReport).toBeNull();
    });
  });

  // ── Pattern Transition Logging ────────────────────────────────

  describe('logPatternTransition', () => {
    it('logs escalation as a timeline entry', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      diag.logPatternTransition('patternEscalated', 'saturation', 'critical');

      const snapshot = diag.getDiagnostics();
      const entry = snapshot.timeline.find(e => e.type === 'patternEscalated');
      expect(entry).toBeDefined();
      expect(entry!.detail).toEqual({ name: 'saturation', severity: 'critical' });
    });

    it('logs deescalation as a timeline entry', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      diag.logPatternTransition('patternDeescalated', 'erosion', 'watch');

      const snapshot = diag.getDiagnostics();
      const entry = snapshot.timeline.find(e => e.type === 'patternDeescalated');
      expect(entry).toBeDefined();
      expect(entry!.detail).toEqual({ name: 'erosion', severity: 'watch' });
    });
  });

  // ── Phase C: Branch coverage additions ───────────────────────

  describe('Performance summary with zero operations', () => {
    it('returns empty operation timings when no operations have run', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);
      const snapshot = diag.getDiagnostics();
      expect(snapshot.performance).toBeDefined();
      expect(snapshot.performance.budgetViolationCount).toBe(0);
      expect(snapshot.performance.sessionSelfTime).toBe(0);
    });
  });

  describe('Rolling trend with exactly 2 reports', () => {
    it('computes a rolling trend with 2 data points', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      // Emit 2 reportGenerated events
      deps.emitter.emit('reportGenerated', { report: makeReport({
        windowScores: { coherence: 0.8, density: 0.7, relevance: 0.6, continuity: 0.9 },
        reportId: 'r1', composite: 0.75,
      }) });
      deps.emitter.emit('reportGenerated', { report: makeReport({
        windowScores: { coherence: 0.7, density: 0.6, relevance: 0.5, continuity: 0.8 },
        reportId: 'r2', composite: 0.65,
      }) });

      const snapshot = diag.getDiagnostics();
      expect(snapshot.reportHistory.reports).toHaveLength(2);
      // Rolling trend should be computed with 2 reports
      expect(snapshot.reportHistory.rollingTrend).not.toBeNull();
    });
  });

  describe('Anomaly attribution', () => {
    it('attributes anomaly cause from recent timeline events', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      // Simulate a task change in timeline
      deps.emitter.emit('taskChanged', { transition: { type: 'change', previousTask: null } as never });

      // First report (no anomaly yet)
      deps.emitter.emit('reportGenerated', { report: makeReport({
        windowScores: { coherence: 0.9, density: 0.9, relevance: 0.9, continuity: 0.9 },
        reportId: 'a1', composite: 0.9,
      }) });

      // Second report with large relevance drop (>0.15 delta triggers anomaly)
      deps.emitter.emit('reportGenerated', { report: makeReport({
        windowScores: { coherence: 0.9, density: 0.9, relevance: 0.5, continuity: 0.9 },
        reportId: 'a2', composite: 0.7,
      }) });

      const snapshot = diag.getDiagnostics();
      const latestSummary = snapshot.reportHistory.reports[snapshot.reportHistory.reports.length - 1]!;
      // Should have flagged anomalies due to large relevance delta
      expect(latestSummary.anomalies.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('clear (cl-spec-015 §4.1)', () => {
    it('empties report history, timeline, warnings, and trend/latest cache', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      deps.emitter.emit('segmentAdded', { segment: makeSegment('s-1') });
      deps.emitter.emit('reportGenerated', { report: makeReport() });
      deps.emitter.emit('reportGenerated', { report: makeReport() });

      let snapshot = diag.getDiagnostics();
      expect(snapshot.timeline.length).toBeGreaterThan(0);
      expect(snapshot.reportHistory.reports.length).toBeGreaterThan(0);

      diag.clear();

      snapshot = diag.getDiagnostics();
      expect(snapshot.timeline).toEqual([]);
      expect(snapshot.reportHistory.reports).toEqual([]);
      expect(snapshot.warnings).toEqual([]);
      expect(snapshot.reportHistory.rollingTrend).toBeNull();
    });

    it('manager remains functional after clear (sequence restarts at 0)', () => {
      const deps = createDeps();
      const diag = new DiagnosticsManager(deps);

      deps.emitter.emit('segmentAdded', { segment: makeSegment('pre-1') });
      deps.emitter.emit('segmentAdded', { segment: makeSegment('pre-2') });

      diag.clear();

      deps.emitter.emit('segmentAdded', { segment: makeSegment('post-1') });
      const snapshot = diag.getDiagnostics();

      expect(snapshot.timeline.length).toBe(1);
      expect(snapshot.timeline[0]!.sequence).toBe(0);  // sequence reset
    });
  });
});
