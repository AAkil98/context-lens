/**
 * Quality report — assembly, caching, lazy invalidation, trend computation.
 * @see cl-spec-002 §9
 */

import type {
  QualityReport,
  WindowScores,
  SegmentScore,
  GroupScore,
  TrendData,
  DetectionResult,
  CapacityReport,
  TokenizerMetadata,
  ProtectionLevel,
} from './types.js';
import type { SimilarityEngine } from './similarity.js';
import type { EmbeddingEngine } from './embedding.js';
import type { TaskManager } from './task.js';
import type { ContinuityTracker } from './scoring/continuity.js';
import type { BaselineManager } from './scoring/baseline.js';
import { computeCoherence } from './scoring/coherence.js';
import { computeDensity } from './scoring/density.js';
import { computeRelevance } from './scoring/relevance.js';
import { computeComposite, computeSegmentComposite } from './scoring/composite.js';
import { fnv1a } from './utils/hash.js';

// ─── Constants ────────────────────────────────────────────────────

const SCHEMA_VERSION = '1.0.0';

// ─── Segment Input ────────────────────────────────────────────────

export interface ScoringSegment {
  id: string;
  content: string;
  contentHash: number;
  tokenCount: number;
  protection: ProtectionLevel;
  importance: number;
  origin: string | null;
  tags: string[];
  groupId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AssessmentContext {
  orderedSegments: ScoringSegment[];
  groups: Map<string, string[]>;
  capacity: CapacityReport;
  tokenizerMetadata: TokenizerMetadata;
}

// ─── QualityReportAssembler ───────────────────────────────────────

export class QualityReportAssembler {
  private cachedReport: QualityReport | null = null;
  private previousReport: { reportId: string; timestamp: number; windowScores: WindowScores; composite: number | null; segmentCount: number; totalActiveTokens: number } | null = null;
  private dirty = true;
  private reportCounter = 0;

  private readonly similarity: SimilarityEngine;
  private readonly embedding: EmbeddingEngine;
  private readonly task: TaskManager;
  private readonly continuity: ContinuityTracker;
  private readonly baseline: BaselineManager;

  constructor(
    similarity: SimilarityEngine,
    embedding: EmbeddingEngine,
    task: TaskManager,
    continuity: ContinuityTracker,
    baseline: BaselineManager,
  ) {
    this.similarity = similarity;
    this.embedding = embedding;
    this.task = task;
    this.continuity = continuity;
    this.baseline = baseline;
  }

  /** Mark report cache as stale. Called on any content mutation, task change, or provider switch. */
  invalidate(): void {
    this.dirty = true;
    this.cachedReport = null;
  }

  /** Return cached report if still valid, otherwise recompute. */
  assess(ctx: AssessmentContext): QualityReport {
    if (!this.dirty && this.cachedReport !== null) {
      return this.cachedReport;
    }

    const report = this.buildReport(ctx);
    this.cachedReport = report;
    this.dirty = false;

    // Tick task grace period and staleness
    this.task.tickReport();

    // Store summary for trend computation
    this.previousReport = {
      reportId: report.reportId,
      timestamp: report.timestamp,
      windowScores: report.windowScores,
      composite: report.composite,
      segmentCount: report.segmentCount,
      totalActiveTokens: report.capacity.totalActiveTokens,
    };

    return report;
  }

  private buildReport(ctx: AssessmentContext): QualityReport {
    // Single timestamp for entire assessment (R-177)
    const assessmentTimestamp = Date.now();
    const reportId = `rpt-${++this.reportCounter}-${fnv1a(assessmentTimestamp.toString()).toString(36)}`;

    const segments = ctx.orderedSegments;
    const n = segments.length;

    // ── Mode consistency check ────────────────────────────────────
    // If embedding provider is set but any segment lacks a vector,
    // fall back to trigram mode for the whole report.
    let embeddingMode: 'embeddings' | 'trigrams';
    if (this.embedding.hasProvider() && n > 0) {
      const allHave = this.embedding.allHaveVectors(segments.map(s => s.contentHash));
      embeddingMode = allHave ? 'embeddings' : 'trigrams';
    } else {
      embeddingMode = this.embedding.hasProvider() ? 'embeddings' : 'trigrams';
    }

    // ── Coherence ─────────────────────────────────────────────────
    const coherenceResult = computeCoherence(segments, ctx.groups, this.similarity);

    // ── Density ───────────────────────────────────────────────────
    const densityResult = computeDensity(segments, this.similarity);

    // ── Relevance ─────────────────────────────────────────────────
    const currentTask = this.task.getCurrentTask();
    const taskDescHash = this.task.getCurrentDescHash();
    const relevanceResult = computeRelevance(
      segments, this.similarity, assessmentTimestamp, currentTask, taskDescHash,
    );

    // ── Continuity ────────────────────────────────────────────────
    const windowContinuity = this.continuity.getWindowContinuity();
    const continuitySummary = this.continuity.getSummary();

    // ── Raw window scores ─────────────────────────────────────────
    const rawScores: WindowScores = {
      coherence: coherenceResult.windowCoherence,
      density: densityResult.windowDensity,
      relevance: relevanceResult.windowRelevance,
      continuity: n > 0 ? windowContinuity : null,
    };

    // ── Baseline normalization ────────────────────────────────────
    const normalized = this.baseline.normalize(rawScores);
    const windowScores: WindowScores = normalized ?? rawScores;

    // ── Composite ─────────────────────────────────────────────────
    const composite = computeComposite(
      windowScores.coherence,
      windowScores.density,
      windowScores.relevance,
      windowScores.continuity,
    );

    // ── Per-segment scores ────────────────────────────────────────
    const segmentScores: SegmentScore[] = [];
    for (const seg of segments) {
      const coh = coherenceResult.perSegment.get(seg.id) ?? 0;
      const den = densityResult.perSegment.get(seg.id)?.density ?? 1;
      const rel = relevanceResult.perSegment.get(seg.id) ?? 1;
      const con = this.continuity.getSegmentContinuity(seg.id);
      const segComposite = computeSegmentComposite(coh, den, rel, con);

      const densityEntry = densityResult.perSegment.get(seg.id);

      segmentScores.push({
        segmentId: seg.id,
        coherence: coh,
        density: den,
        relevance: rel,
        continuity: con,
        composite: segComposite,
        tokenCount: seg.tokenCount,
        redundancy: densityEntry?.redundancyInfo ?? null,
        groupId: seg.groupId,
      });
    }

    // Sort by composite ascending (weakest first)
    segmentScores.sort((a, b) => a.composite - b.composite);

    // ── Per-group scores ──────────────────────────────────────────
    const groupScores: GroupScore[] = [];
    for (const [groupId, memberIds] of ctx.groups) {
      const gs = coherenceResult.groupScores.get(groupId);
      const groupCoherence = gs?.coherence ?? 0;
      const integrityWarning = gs?.integrityWarning ?? false;

      let totalTokens = 0;
      let relSum = 0;
      let denSum = 0;
      let memberCount = 0;

      for (const mid of memberIds) {
        const seg = segments.find(s => s.id === mid);
        if (seg === undefined) continue;
        memberCount++;
        totalTokens += seg.tokenCount;
        relSum += relevanceResult.perSegment.get(mid) ?? 1;
        denSum += densityResult.perSegment.get(mid)?.density ?? 1;
      }

      const meanRelevance = memberCount > 0 ? relSum / memberCount : 1;
      const meanDensity = memberCount > 0 ? denSum / memberCount : 1;

      groupScores.push({
        groupId,
        memberCount,
        totalTokens,
        groupCoherence,
        meanRelevance,
        meanDensity,
        composite: computeSegmentComposite(groupCoherence, meanDensity, meanRelevance, 1.0),
        integrityWarning,
      });
    }

    // Sort by composite ascending
    groupScores.sort((a, b) => a.composite - b.composite);

    // ── Trend ─────────────────────────────────────────────────────
    let trend: TrendData | null = null;
    if (this.previousReport !== null) {
      const prev = this.previousReport;
      trend = {
        previousReportId: prev.reportId,
        timeDelta: assessmentTimestamp - prev.timestamp,
        coherenceDelta: (windowScores.coherence ?? 0) - (prev.windowScores.coherence ?? 0),
        densityDelta: (windowScores.density ?? 0) - (prev.windowScores.density ?? 0),
        relevanceDelta: (windowScores.relevance ?? 0) - (prev.windowScores.relevance ?? 0),
        continuityDelta: (windowScores.continuity ?? 0) - (prev.windowScores.continuity ?? 0),
        compositeDelta: (composite ?? 0) - (prev.composite ?? 0),
        segmentCountDelta: n - prev.segmentCount,
        tokensDelta: ctx.capacity.totalActiveTokens - prev.totalActiveTokens,
      };
    }

    // ── Detection placeholder (Phase 3) ───────────────────────────
    const patterns: DetectionResult = {
      patterns: [],
      patternCount: 0,
      highestSeverity: null,
      preBaseline: !this.baseline.isEstablished(),
    };

    // ── Assemble ──────────────────────────────────────────────────
    return {
      schemaVersion: SCHEMA_VERSION,
      timestamp: assessmentTimestamp,
      reportId,
      segmentCount: n,
      windowScores,
      rawScores,
      composite,
      baseline: this.baseline.getSnapshot(),
      capacity: ctx.capacity,
      tokenizer: ctx.tokenizerMetadata,
      embeddingMode,
      segments: segmentScores,
      groups: groupScores,
      continuity: continuitySummary,
      trend,
      patterns,
      task: this.task.getSummary(),
    };
  }
}
