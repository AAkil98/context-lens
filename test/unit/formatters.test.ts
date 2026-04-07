import { describe, it, expect } from 'vitest';
import { formatReport, formatDiagnostics, formatPattern } from '../../src/formatters.js';
import type {
  QualityReport,
  DiagnosticSnapshot,
  ActivePattern,
  WindowScores,
  TrendData,
} from '../../src/types.js';

// ─── Mock Factories ─────────────────────────────────────────────

interface ReportOverrides {
  reportId?: string;
  timestamp?: number;
  segmentCount?: number;
  windowScores?: Partial<WindowScores>;
  composite?: number | null;
  utilization?: number;
  totalActiveTokens?: number;
  capacity?: number;
  trend?: TrendData | null;
  patterns?: QualityReport['patterns'];
  baseline?: QualityReport['baseline'];
  task?: Partial<QualityReport['task']>;
}

function makeReport(overrides: ReportOverrides = {}): QualityReport {
  const cap = overrides.capacity ?? 10000;
  const totalActiveTokens = overrides.totalActiveTokens ?? 5000;
  const utilization = overrides.utilization ?? totalActiveTokens / cap;

  return {
    schemaVersion: '1.0.0',
    timestamp: overrides.timestamp ?? 1712500000000,
    reportId: overrides.reportId ?? 'rpt-001',
    segmentCount: overrides.segmentCount ?? 10,
    windowScores: {
      coherence: overrides.windowScores?.coherence ?? 0.85,
      density: overrides.windowScores?.density ?? 0.72,
      relevance: overrides.windowScores?.relevance ?? 0.91,
      continuity: overrides.windowScores?.continuity ?? 0.68,
    },
    rawScores: {
      coherence: 0.85,
      density: 0.72,
      relevance: 0.91,
      continuity: 0.68,
    },
    composite: overrides.composite === undefined ? 0.79 : overrides.composite,
    baseline: overrides.baseline === undefined
      ? { coherence: 0.9, density: 0.9, relevance: 0.9, continuity: 0.9, capturedAt: 500, segmentCount: 5, tokenCount: 2000 }
      : overrides.baseline,
    capacity: {
      capacity: cap,
      totalActiveTokens,
      utilization,
      headroom: cap - totalActiveTokens,
      pinnedTokens: 0,
      seedTokens: 0,
      managedTokens: totalActiveTokens,
      availableCapacity: cap - totalActiveTokens,
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
    trend: overrides.trend === undefined ? null : overrides.trend,
    patterns: overrides.patterns ?? { patterns: [], patternCount: 0, highestSeverity: null, preBaseline: false },
    task: {
      state: 'active',
      stale: false,
      gracePeriodActive: false,
      gracePeriodRemaining: 0,
      ...overrides.task,
    },
  };
}

function makeActivePattern(overrides?: Partial<ActivePattern>): ActivePattern {
  return {
    name: overrides?.name ?? 'saturation',
    severity: overrides?.severity ?? 'warning',
    activatedAt: overrides?.activatedAt ?? 1000,
    currentSince: overrides?.currentSince ?? 1000,
    duration: overrides?.duration ?? 5000,
    trending: overrides?.trending ?? 'stable',
    signature: overrides?.signature ?? {
      primaryScore: { dimension: 'utilization', value: 0.92 },
      secondaryScores: [],
      utilization: 0.92,
      thresholdCrossed: { severity: 'warning', threshold: 0.85 },
    },
    explanation: overrides?.explanation ?? 'Context window is nearly full',
    remediation: overrides?.remediation ?? [
      { action: 'evict', target: null, estimatedImpact: null, description: 'Remove low-importance segments' },
    ],
    compoundContext: overrides?.compoundContext ?? null,
  };
}

function makeSnapshot(overrides?: Partial<DiagnosticSnapshot>): DiagnosticSnapshot {
  return {
    schemaVersion: '1.0.0',
    timestamp: 1712500010000,
    sessionDuration: overrides?.sessionDuration ?? 60000,
    latestReport: overrides?.latestReport === undefined ? null : overrides.latestReport,
    reportHistory: overrides?.reportHistory ?? { reports: [], rollingTrend: null },
    patternSummary: overrides?.patternSummary ?? {
      activePatterns: [],
      totalActivations: 0,
      totalResolutions: 0,
      perPattern: {},
      history: [],
    },
    timeline: overrides?.timeline ?? [],
    performance: overrides?.performance ?? {
      operationTimings: {},
      caches: {
        tokenCache: { hits: 0, misses: 0, hitRate: null, currentEntries: 0, maxEntries: 0, utilization: 0, evictions: 0 },
        embeddingCache: { hits: 0, misses: 0, hitRate: null, currentEntries: 0, maxEntries: 0, utilization: 0, evictions: 0 },
        similarityCache: { hits: 0, misses: 0, hitRate: null, currentEntries: 0, maxEntries: 0, utilization: 0, evictions: 0 },
      },
      sessionSelfTime: 0,
      sessionProviderTime: 0,
      budgetViolationCount: 0,
    },
    providers: overrides?.providers ?? {
      tokenizer: { name: 'test', accuracy: 'approximate', modelFamily: null, errorBound: null },
      embedding: null,
    },
    segmentCount: overrides?.segmentCount ?? 10,
    groupCount: overrides?.groupCount ?? 2,
    evictedCount: overrides?.evictedCount ?? 3,
    taskState: overrides?.taskState ?? {
      state: 'unset',
      currentTask: null,
      previousTask: null,
      taskSetAt: null,
      transitionCount: 0,
      changeCount: 0,
      refinementCount: 0,
      reportsSinceSet: 0,
      reportsSinceTransition: 0,
      lastTransition: null,
      stale: false,
      gracePeriodActive: false,
      gracePeriodRemaining: 0,
      transitionHistory: [],
    },
    continuityLedger: overrides?.continuityLedger ?? [],
    warnings: overrides?.warnings ?? [],
  };
}

// ─── Test Suites ────────────────────────────────────────────────

describe('formatReport', () => {
  it('includes report ID, scores at 2 decimal places, utilization, and segment count', () => {
    const report = makeReport({
      reportId: 'rpt-xyz',
      segmentCount: 15,
      windowScores: { coherence: 0.85, density: 0.72, relevance: 0.91, continuity: 0.68 },
      composite: 0.79,
      utilization: 0.5,
    });

    const output = formatReport(report);

    expect(output).toContain('rpt-xyz');
    expect(output).toContain('0.85');
    expect(output).toContain('0.72');
    expect(output).toContain('0.91');
    expect(output).toContain('0.68');
    expect(output).toContain('0.79');
    expect(output).toContain('50.0%');
    expect(output).toContain('15');
  });

  it('includes pattern names and severity when patterns are active', () => {
    const pattern = makeActivePattern({ name: 'saturation', severity: 'warning' });
    const report = makeReport({
      patterns: {
        patterns: [pattern],
        patternCount: 1,
        highestSeverity: 'warning',
        preBaseline: false,
      },
    });

    const output = formatReport(report);

    expect(output).toContain('[WARNING]');
    expect(output).toContain('saturation');
  });

  it('includes trend delta formatting when trend data is present', () => {
    const report = makeReport({
      trend: {
        previousReportId: 'rpt-prev',
        timeDelta: 5000,
        coherenceDelta: 0.05,
        densityDelta: -0.03,
        relevanceDelta: 0.0,
        continuityDelta: -0.10,
        compositeDelta: 0.02,
        segmentCountDelta: 2,
        tokensDelta: 500,
      },
    });

    const output = formatReport(report);

    expect(output).toContain('Trend');
    expect(output).toContain('+0.05');
    expect(output).toContain('-0.03');
    expect(output).toContain('stable');
    expect(output).toContain('-0.10');
  });

  it('produces output with no ANSI escape codes', () => {
    const report = makeReport();
    const output = formatReport(report);

    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\u001b');
  });

  it('produces meaningful output for an empty window (segmentCount=0)', () => {
    const report = makeReport({
      segmentCount: 0,
      totalActiveTokens: 0,
      utilization: 0,
    });

    const output = formatReport(report);

    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('0');
  });
});

describe('formatDiagnostics', () => {
  it('includes report summary, session duration, and provider info when latestReport is present', () => {
    const report = makeReport({ reportId: 'rpt-diag' });
    const snapshot = makeSnapshot({
      latestReport: report,
      sessionDuration: 125000, // 2m 5s
    });

    const output = formatDiagnostics(snapshot);

    // Report ID from the embedded report
    expect(output).toContain('rpt-diag');
    // Session duration
    expect(output).toContain('2m 5s');
    // Provider info
    expect(output).toContain('test');
    expect(output).toContain('approximate');
    expect(output).toContain('trigram mode');
  });

  it('shows "No reports generated" message when latestReport is null', () => {
    const snapshot = makeSnapshot({ latestReport: null });
    const output = formatDiagnostics(snapshot);

    expect(output).toContain('No reports generated');
  });

  it('includes segment and eviction counts', () => {
    const snapshot = makeSnapshot({
      latestReport: null,
      segmentCount: 42,
      evictedCount: 7,
    });

    const output = formatDiagnostics(snapshot);

    expect(output).toContain('42 active');
    expect(output).toContain('7 evicted');
  });
});

describe('formatPattern', () => {
  it('formats a base pattern with severity and explanation', () => {
    const pattern = makeActivePattern({
      name: 'erosion',
      severity: 'critical',
      explanation: 'Information density is very low',
    });

    const output = formatPattern(pattern);

    expect(output).toContain('[CRITICAL]');
    expect(output).toContain('erosion');
    expect(output).toContain('Information density is very low');
  });

  it('prefixes custom pattern names with "Custom: "', () => {
    const pattern = makeActivePattern({
      name: 'myCustomRule' as never,
      severity: 'watch',
      explanation: 'Custom condition detected',
    });

    const output = formatPattern(pattern);

    expect(output).toContain('Custom: myCustomRule');
    expect(output).toContain('[WATCH]');
  });

  it('is pure — same input produces same output', () => {
    const pattern = makeActivePattern({
      name: 'fracture',
      severity: 'warning',
      explanation: 'Topics are diverging',
    });

    const output1 = formatPattern(pattern);
    const output2 = formatPattern(pattern);

    expect(output1).toBe(output2);
  });

  it('includes remediation suggestion when available', () => {
    const pattern = makeActivePattern({
      remediation: [
        { action: 'compact', target: null, estimatedImpact: null, description: 'Compact redundant segments' },
      ],
    });

    const output = formatPattern(pattern);

    expect(output).toContain('Suggestion');
    expect(output).toContain('Compact redundant segments');
  });
});
