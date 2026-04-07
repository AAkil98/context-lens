/**
 * Diagnostics — incremental state maintenance, snapshot assembly,
 * report history, rolling trends, timeline, warnings.
 * @see cl-spec-010
 */

import type {
  QualityReport,
  DiagnosticSnapshot,
  ReportSummary,
  RollingTrend,
  TrendLine,
  TimelineEntry,
  TimelineEventType,
  PatternSummary,
  CacheReport,
  AnomalyFlag,
  Severity,
  Warning,
} from './types.js';
import type { EventEmitter, ContextLensEventMap } from './events.js';
import type { PerformanceInstrumentation } from './performance.js';
import type { DetectionEngine } from './detection.js';
import type { TaskManager } from './task.js';
import type { ContinuityTracker } from './scoring/continuity.js';
import type { SegmentStore } from './segment-store.js';
import type { Tokenizer } from './tokenizer.js';
import type { EmbeddingEngine } from './embedding.js';
import type { SimilarityEngine } from './similarity.js';
import { RingBuffer } from './utils/ring-buffer.js';
import { deepCopy } from './utils/copy.js';

// ─── Constants ────────────────────────────────────────────────────

const SCHEMA_VERSION = '1.0.0';
const REPORT_HISTORY_CAPACITY = 20;
const TIMELINE_CAPACITY = 200;
const MAX_WARNINGS = 50;
const ANOMALY_THRESHOLD = 0.15;
const TREND_WINDOW = 5;
const TREND_IMPROVING_THRESHOLD = 0.01;
const TREND_DEGRADING_THRESHOLD = -0.01;

// ─── Dependencies ─────────────────────────────────────────────────

export interface DiagnosticsDeps {
  emitter: EventEmitter<ContextLensEventMap>;
  perf: PerformanceInstrumentation;
  detection: DetectionEngine;
  taskManager: TaskManager;
  continuity: ContinuityTracker;
  store: SegmentStore;
  tokenizer: Tokenizer;
  embedding: EmbeddingEngine;
  similarity: SimilarityEngine;
  constructionTimestamp: number;
}

// ─── DiagnosticsManager ───────────────────────────────────────────

export class DiagnosticsManager {
  private readonly reportHistory = new RingBuffer<ReportSummary>(REPORT_HISTORY_CAPACITY);
  private readonly timeline = new RingBuffer<TimelineEntry>(TIMELINE_CAPACITY);
  private readonly warnings: Warning[] = [];
  private readonly deps: DiagnosticsDeps;
  private rollingTrend: RollingTrend | null = null;
  private latestReport: QualityReport | null = null;
  private sequence = 0;

  constructor(deps: DiagnosticsDeps) {
    this.deps = deps;
    this.subscribeToEvents();
  }

  // ── Event Subscriptions ─────────────────────────────────────────

  private subscribeToEvents(): void {
    const { emitter } = this.deps;

    emitter.on('segmentAdded', (p) => this.logTimeline('segmentAdded', { segmentId: p.segment.id }));
    emitter.on('segmentUpdated', (p) => this.logTimeline('segmentUpdated', { segmentId: p.segment.id, changes: p.changes }));
    emitter.on('segmentReplaced', (p) => this.logTimeline('segmentReplaced', { segmentId: p.segment.id, previousTokenCount: p.previousTokenCount }));
    emitter.on('segmentCompacted', (p) => this.logTimeline('segmentCompacted', { segmentId: p.segment.id, record: p.record }));
    emitter.on('segmentSplit', (p) => this.logTimeline('segmentSplit', { originalId: p.originalId, childIds: p.children.map(c => c.id) }));
    emitter.on('segmentEvicted', (p) => this.logTimeline('segmentEvicted', { segmentId: p.record.segmentId }));
    emitter.on('segmentRestored', (p) => this.logTimeline('segmentRestored', { segmentId: p.segment.id, fidelity: p.fidelity }));
    emitter.on('groupCreated', (p) => this.logTimeline('groupCreated', { groupId: p.group.groupId, memberCount: p.group.members.length }));
    emitter.on('groupDissolved', (p) => this.logTimeline('groupDissolved', { groupId: p.groupId, memberIds: p.memberIds }));
    emitter.on('taskChanged', (p) => this.logTimeline('taskSet', { transitionType: p.transition.type }));
    emitter.on('taskCleared', () => this.logTimeline('taskCleared', {}));
    emitter.on('tokenizerChanged', (p) => this.logTimeline('tokenizerChanged', { oldName: p.oldName, newName: p.newName }));
    emitter.on('embeddingProviderChanged', (p) => this.logTimeline('embeddingProviderChanged', { oldName: p.oldName, newName: p.newName }));
    emitter.on('capacityChanged', (p) => this.logTimeline('capacityChanged', { oldCapacity: p.oldCapacity, newCapacity: p.newCapacity }));
    emitter.on('reportGenerated', (p) => {
      this.latestReport = p.report;
      this.onReportGenerated(p.report);
      this.logTimeline('reportGenerated', { reportId: p.report.reportId });
    });
    emitter.on('patternActivated', (p) => this.logTimeline('patternActivated', { name: p.pattern.name, severity: p.pattern.severity }));
    emitter.on('patternResolved', (p) => this.logTimeline('patternResolved', { name: p.name, peakSeverity: p.peakSeverity, duration: p.duration }));
    emitter.on('customPatternRegistered', (p) => this.logTimeline('customPatternRegistered', { name: p.name }));
    emitter.on('baselineCaptured', () => this.logTimeline('baselineCaptured', {}));
    emitter.on('lateSeeding', (p) => this.logTimeline('lateSeeding', { segmentCount: p.segmentCount }));
    emitter.on('budgetViolation', (p) => this.logTimeline('budgetViolation', { operation: p.operation, selfTime: p.selfTime, budgetTarget: p.budgetTarget }));
  }

  // ── Timeline Logging ────────────────────────────────────────────

  private logTimeline(type: TimelineEventType, detail: Record<string, unknown>): void {
    this.timeline.push({
      timestamp: Date.now(),
      sequence: this.sequence++,
      type,
      detail,
    });
  }

  /** Log a pattern escalation/deescalation (not an API event, logged directly). */
  logPatternTransition(type: 'patternEscalated' | 'patternDeescalated', name: string, severity: Severity): void {
    this.logTimeline(type, { name, severity });
  }

  // ── Report History & Trends ─────────────────────────────────────

  private onReportGenerated(report: QualityReport): void {
    const arr = this.reportHistory.toArray();
    const prevSummary: ReportSummary | null = arr.length > 0
      ? arr[arr.length - 1]!
      : null;

    // Build anomaly flags
    const anomalies = this.detectAnomalies(report, prevSummary);

    const summary: ReportSummary = {
      reportId: report.reportId,
      timestamp: report.timestamp,
      windowScores: deepCopy(report.windowScores),
      composite: report.composite ?? 0,
      segmentCount: report.segmentCount,
      totalActiveTokens: report.capacity.totalActiveTokens,
      utilization: report.capacity.utilization,
      patternCount: report.patterns.patternCount,
      highestSeverity: report.patterns.highestSeverity,
      embeddingMode: report.embeddingMode,
      anomalies,
    };

    this.reportHistory.push(summary);
    this.rollingTrend = this.computeRollingTrend();
  }

  private detectAnomalies(report: QualityReport, prev: ReportSummary | null): AnomalyFlag[] {
    if (prev === null) return [];

    const anomalies: AnomalyFlag[] = [];
    const dimensions: Array<{ dim: AnomalyFlag['dimension']; curr: number; prev: number }> = [
      { dim: 'coherence', curr: report.windowScores.coherence ?? 0, prev: prev.windowScores.coherence ?? 0 },
      { dim: 'density', curr: report.windowScores.density ?? 0, prev: prev.windowScores.density ?? 0 },
      { dim: 'relevance', curr: report.windowScores.relevance ?? 0, prev: prev.windowScores.relevance ?? 0 },
      { dim: 'continuity', curr: report.windowScores.continuity ?? 0, prev: prev.windowScores.continuity ?? 0 },
      { dim: 'composite', curr: report.composite ?? 0, prev: prev.composite },
    ];

    for (const { dim, curr, prev: p } of dimensions) {
      const delta = curr - p;
      if (Math.abs(delta) > ANOMALY_THRESHOLD) {
        const likelyCause = this.attributeAnomaly();
        anomalies.push({ dimension: dim, delta, likelyCause });
      }
    }
    return anomalies;
  }

  private attributeAnomaly(): AnomalyFlag['likelyCause'] {
    // Check recent timeline entries for likely cause
    const entries = this.timeline.toArray();
    const recent = entries.slice(-10);

    for (const e of recent) {
      if (e.type === 'taskSet' || e.type === 'taskCleared') return 'taskChange';
      if (e.type === 'segmentEvicted') {
        // Check for bulk eviction (multiple eviction entries)
        const evictionCount = recent.filter(r => r.type === 'segmentEvicted').length;
        if (evictionCount >= 2) return 'bulkEviction';
      }
      if (e.type === 'tokenizerChanged' || e.type === 'embeddingProviderChanged') return 'providerSwitch';
      if (e.type === 'segmentAdded') {
        const addCount = recent.filter(r => r.type === 'segmentAdded').length;
        if (addCount >= 3) return 'bulkAdd';
      }
    }
    return null;
  }

  private computeRollingTrend(): RollingTrend | null {
    const summaries = this.reportHistory.toArray();
    if (summaries.length < 2) return null;

    const window = Math.min(TREND_WINDOW, summaries.length);
    const recent = summaries.slice(-window);

    return {
      window,
      coherence: this.computeTrendLine(recent, s => s.windowScores.coherence ?? 0),
      density: this.computeTrendLine(recent, s => s.windowScores.density ?? 0),
      relevance: this.computeTrendLine(recent, s => s.windowScores.relevance ?? 0),
      continuity: this.computeTrendLine(recent, s => s.windowScores.continuity ?? 0),
      composite: this.computeTrendLine(recent, s => s.composite),
    };
  }

  private computeTrendLine(summaries: ReportSummary[], extract: (s: ReportSummary) => number): TrendLine {
    const values = summaries.map(extract);
    const deltas: number[] = [];
    for (let i = 1; i < values.length; i++) {
      deltas.push(values[i]! - values[i - 1]!);
    }

    const averageRate = deltas.length > 0
      ? deltas.reduce((sum, d) => sum + d, 0) / deltas.length
      : 0;

    let direction: TrendLine['direction'] = 'stable';
    if (averageRate > TREND_IMPROVING_THRESHOLD) direction = 'improving';
    else if (averageRate < TREND_DEGRADING_THRESHOLD) direction = 'degrading';

    const current = values[values.length - 1]!;
    const windowMin = Math.min(...values);
    const windowMax = Math.max(...values);

    // Volatility: standard deviation of deltas
    let volatility = 0;
    if (deltas.length > 0) {
      const mean = averageRate;
      const variance = deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / deltas.length;
      volatility = Math.sqrt(variance);
    }

    return { direction, averageRate, current, windowMin, windowMax, volatility };
  }

  // ── Warning Accumulation ────────────────────────────────────────

  addWarning(code: string, message: string): void {
    // Deduplicate by message
    if (this.warnings.some(w => w.message === message)) return;

    if (this.warnings.length >= MAX_WARNINGS) {
      this.warnings.shift(); // Drop oldest
    }

    this.warnings.push({ code, message, timestamp: Date.now() });
  }

  // ── Snapshot Assembly ───────────────────────────────────────────

  getDiagnostics(): DiagnosticSnapshot {
    const now = Date.now();
    const { detection, taskManager, continuity, store, tokenizer, embedding, perf, constructionTimestamp } = this.deps;

    // Pattern summary from detection engine
    const trackingSnapshot = detection.getTrackingSnapshot();
    const detectionHistory = detection.getPatternHistory();
    const latestResult = this.latestReport?.patterns;
    const patternSummary: PatternSummary = {
      activePatterns: latestResult ? deepCopy(latestResult.patterns) : [],
      totalActivations: detectionHistory.filter(e => e.event === 'activated').length,
      totalResolutions: detectionHistory.filter(e => e.event === 'resolved').length,
      perPattern: deepCopy(trackingSnapshot.perPatternStats),
      history: deepCopy(detectionHistory),
    };

    // Performance summary
    const caches: CacheReport = this.buildCacheReport();
    const performance = perf.getPerformanceSummary(caches);

    // Report history
    const reports = this.reportHistory.toArray();

    return {
      schemaVersion: SCHEMA_VERSION,
      timestamp: now,
      sessionDuration: now - constructionTimestamp,
      latestReport: this.latestReport !== null ? deepCopy(this.latestReport) : null,
      reportHistory: {
        reports: deepCopy(reports),
        rollingTrend: this.rollingTrend !== null ? deepCopy(this.rollingTrend) : null,
      },
      patternSummary,
      timeline: deepCopy(this.timeline.toArray()),
      performance: deepCopy(performance),
      providers: {
        tokenizer: deepCopy(tokenizer.getInfo()),
        embedding: embedding.getProviderMetadata() !== null ? deepCopy(embedding.getProviderMetadata()!) : null,
      },
      segmentCount: store.segmentCount,
      groupCount: store.groupCount,
      evictedCount: store.evictedCount,
      taskState: deepCopy(taskManager.getState()),
      continuityLedger: deepCopy(continuity.getLedger()),
      warnings: deepCopy(this.warnings),
    };
  }

  private buildCacheReport(): CacheReport {
    // Cache metrics are approximate — modules expose what they can
    return {
      tokenCache: { hits: 0, misses: 0, hitRate: 0, currentEntries: 0, maxEntries: 0, utilization: 0, evictions: 0 },
      embeddingCache: { hits: 0, misses: 0, hitRate: 0, currentEntries: 0, maxEntries: 0, utilization: 0, evictions: 0 },
      similarityCache: {
        hits: 0, misses: 0, hitRate: 0,
        currentEntries: this.deps.similarity.cacheEntryCount,
        maxEntries: 0, utilization: 0, evictions: 0,
      },
    };
  }
}
