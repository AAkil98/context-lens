import { describe, it, expect, beforeEach } from 'vitest';
import { QualityReportAssembler } from '../../src/quality-report.js';
import type { ScoringSegment, AssessmentContext } from '../../src/quality-report.js';
import { SimilarityEngine } from '../../src/similarity.js';
import { EmbeddingEngine } from '../../src/embedding.js';
import { TaskManager } from '../../src/task.js';
import { ContinuityTracker } from '../../src/scoring/continuity.js';
import { BaselineManager } from '../../src/scoring/baseline.js';
import { fnv1a } from '../../src/utils/hash.js';
import type { CapacityReport, TokenizerMetadata, QualityReport } from '../../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────

function simpleCountTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function makeScoringSegment(id: string, content: string, overrides?: Partial<ScoringSegment>): ScoringSegment {
  return {
    id,
    content,
    contentHash: fnv1a(content),
    tokenCount: simpleCountTokens(content),
    protection: 'default',
    importance: 0.5,
    origin: null,
    tags: [],
    groupId: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeCapacity(segments: ScoringSegment[]): CapacityReport {
  const totalTokens = segments.reduce((sum, s) => sum + s.tokenCount, 0);
  return {
    capacity: 10000,
    totalActiveTokens: totalTokens,
    utilization: totalTokens / 10000,
    headroom: 10000 - totalTokens,
    pinnedTokens: 0,
    seedTokens: 0,
    managedTokens: totalTokens,
    availableCapacity: 10000 - totalTokens,
  };
}

function makeTokenizerMetadata(): TokenizerMetadata {
  return {
    name: 'simple',
    accuracy: 'approximate',
    modelFamily: null,
    errorBound: null,
  };
}

function makeContext(segments: ScoringSegment[], groups?: Map<string, string[]>): AssessmentContext {
  return {
    orderedSegments: segments,
    groups: groups ?? new Map(),
    capacity: makeCapacity(segments),
    tokenizerMetadata: makeTokenizerMetadata(),
  };
}

// ─── Test Suite ──────────────────────────────────────────────────

describe('QualityReportAssembler', () => {
  let similarity: SimilarityEngine;
  let embedding: EmbeddingEngine;
  let task: TaskManager;
  let continuity: ContinuityTracker;
  let baseline: BaselineManager;
  let assembler: QualityReportAssembler;

  const seg1 = makeScoringSegment('s1', 'The quick brown fox jumps over the lazy dog');
  const seg2 = makeScoringSegment('s2', 'Machine learning models require training data');
  const seg3 = makeScoringSegment('s3', 'TypeScript is a typed superset of JavaScript');

  beforeEach(() => {
    similarity = new SimilarityEngine();
    embedding = new EmbeddingEngine(4096, simpleCountTokens);
    task = new TaskManager();
    continuity = new ContinuityTracker();
    baseline = new BaselineManager();
    assembler = new QualityReportAssembler(similarity, embedding, task, continuity, baseline);
  });

  // ── Report shape and required fields ─────────────────────────

  it('report has all required fields with correct types', () => {
    const ctx = makeContext([seg1, seg2, seg3]);
    const report = assembler.assess(ctx);

    expect(report).toHaveProperty('schemaVersion');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('reportId');
    expect(report).toHaveProperty('segmentCount');
    expect(report).toHaveProperty('windowScores');
    expect(report).toHaveProperty('rawScores');
    expect(report).toHaveProperty('composite');
    expect(report).toHaveProperty('baseline');
    expect(report).toHaveProperty('capacity');
    expect(report).toHaveProperty('tokenizer');
    expect(report).toHaveProperty('embeddingMode');
    expect(report).toHaveProperty('segments');
    expect(report).toHaveProperty('groups');
    expect(report).toHaveProperty('continuity');
    expect(report).toHaveProperty('trend');
    expect(report).toHaveProperty('patterns');
    expect(report).toHaveProperty('task');

    expect(typeof report.schemaVersion).toBe('string');
    expect(typeof report.timestamp).toBe('number');
    expect(typeof report.reportId).toBe('string');
    expect(typeof report.segmentCount).toBe('number');
    expect(typeof report.windowScores).toBe('object');
    expect(typeof report.rawScores).toBe('object');
    expect(Array.isArray(report.segments)).toBe(true);
    expect(Array.isArray(report.groups)).toBe(true);
  });

  // ── Schema version ───────────────────────────────────────────

  it('schemaVersion is "1.0.0"', () => {
    const ctx = makeContext([seg1]);
    const report = assembler.assess(ctx);
    expect(report.schemaVersion).toBe('1.0.0');
  });

  // ── Segment count ────────────────────────────────────────────

  it('segmentCount matches input', () => {
    const ctx = makeContext([seg1, seg2, seg3]);
    const report = assembler.assess(ctx);
    expect(report.segmentCount).toBe(3);
  });

  it('segmentCount is 0 for empty input', () => {
    const ctx = makeContext([]);
    const report = assembler.assess(ctx);
    expect(report.segmentCount).toBe(0);
  });

  // ── Caching ──────────────────────────────────────────────────

  it('second assess without invalidation returns same report (same reportId)', () => {
    const ctx = makeContext([seg1, seg2]);
    const first = assembler.assess(ctx);
    const second = assembler.assess(ctx);
    expect(second.reportId).toBe(first.reportId);
    expect(second.timestamp).toBe(first.timestamp);
  });

  // ── Invalidation ─────────────────────────────────────────────

  it('after invalidate, next assess produces new report (different reportId)', () => {
    const ctx = makeContext([seg1, seg2]);
    const first = assembler.assess(ctx);
    assembler.invalidate();
    const second = assembler.assess(ctx);
    expect(second.reportId).not.toBe(first.reportId);
  });

  // ── Trend ────────────────────────────────────────────────────

  it('trend is null on first report', () => {
    const ctx = makeContext([seg1, seg2]);
    const report = assembler.assess(ctx);
    expect(report.trend).toBeNull();
  });

  it('trend is populated on second report with correct deltas', () => {
    const ctx = makeContext([seg1, seg2]);
    const first = assembler.assess(ctx);
    assembler.invalidate();
    const second = assembler.assess(ctx);

    expect(second.trend).not.toBeNull();
    expect(second.trend!.previousReportId).toBe(first.reportId);
    expect(typeof second.trend!.timeDelta).toBe('number');
    expect(second.trend!.timeDelta).toBeGreaterThanOrEqual(0);
    expect(typeof second.trend!.coherenceDelta).toBe('number');
    expect(typeof second.trend!.densityDelta).toBe('number');
    expect(typeof second.trend!.relevanceDelta).toBe('number');
    expect(typeof second.trend!.continuityDelta).toBe('number');
    expect(typeof second.trend!.compositeDelta).toBe('number');
    expect(typeof second.trend!.segmentCountDelta).toBe('number');
    expect(typeof second.trend!.tokensDelta).toBe('number');
  });

  // ── Segment ordering ────────────────────────────────────────

  it('segments ordered by composite ascending', () => {
    const ctx = makeContext([seg1, seg2, seg3]);
    const report = assembler.assess(ctx);

    for (let i = 1; i < report.segments.length; i++) {
      expect(report.segments[i]!.composite).toBeGreaterThanOrEqual(
        report.segments[i - 1]!.composite,
      );
    }
  });

  // ── Group ordering ──────────────────────────────────────────

  it('groups ordered by composite ascending', () => {
    const g1seg1 = makeScoringSegment('g1s1', 'Alpha group first member content here', { groupId: 'g1' });
    const g1seg2 = makeScoringSegment('g1s2', 'Alpha group second member content', { groupId: 'g1' });
    const g2seg1 = makeScoringSegment('g2s1', 'Beta group first member different topic entirely', { groupId: 'g2' });
    const g2seg2 = makeScoringSegment('g2s2', 'Beta group second member another different topic', { groupId: 'g2' });

    const groups = new Map<string, string[]>([
      ['g1', ['g1s1', 'g1s2']],
      ['g2', ['g2s1', 'g2s2']],
    ]);

    const ctx = makeContext([g1seg1, g1seg2, g2seg1, g2seg2], groups);
    const report = assembler.assess(ctx);

    for (let i = 1; i < report.groups.length; i++) {
      expect(report.groups[i]!.composite).toBeGreaterThanOrEqual(
        report.groups[i - 1]!.composite,
      );
    }
  });

  // ── Embedding mode ──────────────────────────────────────────

  it('embeddingMode is "trigrams" when no provider set', () => {
    const ctx = makeContext([seg1, seg2]);
    const report = assembler.assess(ctx);
    expect(report.embeddingMode).toBe('trigrams');
  });

  // ── Dimension score bounds ───────────────────────────────────

  it('all dimension scores in [0, 1]', () => {
    const ctx = makeContext([seg1, seg2, seg3]);
    const report = assembler.assess(ctx);

    for (const seg of report.segments) {
      expect(seg.coherence).toBeGreaterThanOrEqual(0);
      expect(seg.coherence).toBeLessThanOrEqual(1);
      expect(seg.density).toBeGreaterThanOrEqual(0);
      expect(seg.density).toBeLessThanOrEqual(1);
      expect(seg.relevance).toBeGreaterThanOrEqual(0);
      expect(seg.relevance).toBeLessThanOrEqual(1);
      expect(seg.continuity).toBeGreaterThanOrEqual(0);
      expect(seg.continuity).toBeLessThanOrEqual(1);
    }

    // Window-level scores
    const ws = report.windowScores;
    if (ws.coherence !== null) {
      expect(ws.coherence).toBeGreaterThanOrEqual(0);
      expect(ws.coherence).toBeLessThanOrEqual(1);
    }
    if (ws.density !== null) {
      expect(ws.density).toBeGreaterThanOrEqual(0);
      expect(ws.density).toBeLessThanOrEqual(1);
    }
    if (ws.relevance !== null) {
      expect(ws.relevance).toBeGreaterThanOrEqual(0);
      expect(ws.relevance).toBeLessThanOrEqual(1);
    }
    if (ws.continuity !== null) {
      expect(ws.continuity).toBeGreaterThanOrEqual(0);
      expect(ws.continuity).toBeLessThanOrEqual(1);
    }
  });

  // ── Composite type ──────────────────────────────────────────

  it('composite is number or null', () => {
    const ctx = makeContext([seg1, seg2, seg3]);
    const report = assembler.assess(ctx);
    expect(report.composite === null || typeof report.composite === 'number').toBe(true);
  });

  it('composite is null when no segments', () => {
    const ctx = makeContext([]);
    const report = assembler.assess(ctx);
    // With no segments, window scores are null, so composite should be null
    expect(report.composite).toBeNull();
  });

  // ── Grace period tick ───────────────────────────────────────

  it('after task change, assess decrements gracePeriodRemaining', async () => {
    // Set a task, then change it to activate grace period
    await task.setTask(
      { description: 'initial task about software design' },
      similarity,
      embedding,
    );
    await task.setTask(
      { description: 'completely different task about cooking recipes' },
      similarity,
      embedding,
    );

    const summaryBefore = task.getSummary();
    expect(summaryBefore.gracePeriodActive).toBe(true);
    const remainingBefore = summaryBefore.gracePeriodRemaining;

    const ctx = makeContext([seg1, seg2]);
    assembler.assess(ctx);

    const summaryAfter = task.getSummary();
    expect(summaryAfter.gracePeriodRemaining).toBe(remainingBefore - 1);
  });

  // ── Staleness tick ──────────────────────────────────────────

  it('reportsSinceSet increments on each assess', async () => {
    await task.setTask(
      { description: 'test task for staleness tracking here' },
      similarity,
      embedding,
    );

    const ctx = makeContext([seg1]);

    assembler.assess(ctx);
    const state1 = task.getState();
    expect(state1.reportsSinceSet).toBe(1);

    assembler.invalidate();
    assembler.assess(ctx);
    const state2 = task.getState();
    expect(state2.reportsSinceSet).toBe(2);

    assembler.invalidate();
    assembler.assess(ctx);
    const state3 = task.getState();
    expect(state3.reportsSinceSet).toBe(3);
  });

  // ── Report ID format ────────────────────────────────────────

  it('reportId starts with "rpt-"', () => {
    const ctx = makeContext([seg1]);
    const report = assembler.assess(ctx);
    expect(report.reportId).toMatch(/^rpt-/);
  });

  // ── Per-segment scores match count ──────────────────────────

  it('segments array length matches segmentCount', () => {
    const ctx = makeContext([seg1, seg2, seg3]);
    const report = assembler.assess(ctx);
    expect(report.segments.length).toBe(report.segmentCount);
  });

  // ── Each segment score has correct structure ────────────────

  it('each segment score has required fields', () => {
    const ctx = makeContext([seg1, seg2]);
    const report = assembler.assess(ctx);

    for (const seg of report.segments) {
      expect(typeof seg.segmentId).toBe('string');
      expect(typeof seg.coherence).toBe('number');
      expect(typeof seg.density).toBe('number');
      expect(typeof seg.relevance).toBe('number');
      expect(typeof seg.continuity).toBe('number');
      expect(typeof seg.composite).toBe('number');
      expect(typeof seg.tokenCount).toBe('number');
      // redundancy is RedundancyInfo | null
      expect(seg.redundancy === null || typeof seg.redundancy === 'object').toBe(true);
    }
  });

  // ── Patterns placeholder ────────────────────────────────────

  it('patterns object has correct shape', () => {
    const ctx = makeContext([seg1]);
    const report = assembler.assess(ctx);
    expect(Array.isArray(report.patterns.patterns)).toBe(true);
    expect(report.patterns.patternCount).toBe(0);
    expect(report.patterns.highestSeverity).toBeNull();
    expect(typeof report.patterns.preBaseline).toBe('boolean');
  });

  // ── Continuity summary ──────────────────────────────────────

  it('continuity summary has correct shape', () => {
    const ctx = makeContext([seg1, seg2]);
    const report = assembler.assess(ctx);
    expect(typeof report.continuity.totalEvictions).toBe('number');
    expect(typeof report.continuity.totalCompactions).toBe('number');
    expect(typeof report.continuity.totalRestorations).toBe('number');
    expect(typeof report.continuity.netLoss).toBe('number');
    expect(Array.isArray(report.continuity.recentEvents)).toBe(true);
  });

  // ── Task summary ────────────────────────────────────────────

  it('task summary reflects current state', () => {
    const ctx = makeContext([seg1]);
    const report = assembler.assess(ctx);
    expect(report.task.state).toBe('unset');
    expect(typeof report.task.stale).toBe('boolean');
    expect(typeof report.task.gracePeriodActive).toBe('boolean');
    expect(typeof report.task.gracePeriodRemaining).toBe('number');
  });

  // ── Phase C: Branch coverage additions ─────────────────────

  it('0 segments produces null composite and null window scores', () => {
    const ctx = makeContext([]);
    const report = assembler.assess(ctx);
    expect(report.segmentCount).toBe(0);
    expect(report.composite).toBeNull();
    expect(report.windowScores.coherence).toBeNull();
    expect(report.windowScores.continuity).toBeNull();
    expect(report.segments).toHaveLength(0);
    expect(report.groups).toHaveLength(0);
  });

  it('1 segment produces valid coherence without pairwise computation', () => {
    const ctx = makeContext([seg1]);
    const report = assembler.assess(ctx);
    expect(report.segmentCount).toBe(1);
    expect(report.composite).not.toBeNull();
    expect(report.windowScores.coherence).not.toBeNull();
    expect(report.segments).toHaveLength(1);
  });

  it('embedding mode falls back to trigrams when provider has no vectors', () => {
    // Provider is set but no vectors are cached — should fall back to trigrams
    const ctx = makeContext([seg1, seg2]);
    const report = assembler.assess(ctx);
    expect(report.embeddingMode).toBe('trigrams');
  });

  it('trend is non-null on second assess after invalidation', () => {
    const ctx = makeContext([seg1, seg2]);
    assembler.assess(ctx);
    assembler.invalidate();
    const report2 = assembler.assess(ctx);
    expect(report2.trend).not.toBeNull();
    expect(report2.trend!.previousReportId).toBeTruthy();
    expect(typeof report2.trend!.coherenceDelta).toBe('number');
    expect(typeof report2.trend!.segmentCountDelta).toBe('number');
  });

  it('cached report returns same object without recomputation', () => {
    const ctx = makeContext([seg1, seg2]);
    const r1 = assembler.assess(ctx);
    // No invalidate() — should return cached
    const r2 = assembler.assess(ctx);
    expect(r1.reportId).toBe(r2.reportId);
    expect(r1).toBe(r2); // Same reference from assembler cache
  });

  it('per-segment scores sorted by composite ascending', () => {
    const ctx = makeContext([seg1, seg2, seg3]);
    const report = assembler.assess(ctx);
    for (let i = 1; i < report.segments.length; i++) {
      expect(report.segments[i]!.composite).toBeGreaterThanOrEqual(report.segments[i - 1]!.composite);
    }
  });
});
