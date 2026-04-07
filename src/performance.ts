/**
 * Performance instrumentation — per-operation timing, 3-way decomposition,
 * budget violation detection, sampling parameter computation.
 * @see cl-spec-009
 */

import type { OperationTimingStats, PerformanceSummary, CacheReport } from './types.js';
import { RingBuffer } from './utils/ring-buffer.js';
import { fnv1a } from './utils/hash.js';

// ─── Constants ────────────────────────────────────────────────────

const TIMING_HISTORY_CAPACITY = 200;
const SAMPLING_THRESHOLD = 200;
const DENSITY_SAMPLING_CAP = 30;
const BUDGET_REFERENCE_N = 500;

// ─── Budget Tiers ─────────────────────────────────────────────────

type BudgetTier = 1 | 2 | 3 | 4 | 5;

const TIER_BUDGETS: Record<BudgetTier, number> = {
  1: 1,     // < 1ms (queries)
  2: 5,     // < 5ms (mutations)
  3: 50,    // < 50ms at n<=500 (assessment)
  4: 100,   // < 100ms at n<=500 (planning)
  5: 200,   // proportional (batch/rare)
};

const OPERATION_TIERS: Record<string, BudgetTier> = {
  // Tier 1: queries
  getCapacity: 1,
  getSegment: 1,
  getSegmentCount: 1,
  getBaseline: 1,
  getTask: 1,
  getTaskState: 1,
  getGroup: 1,
  getDiagnostics: 1,
  getTokenizerInfo: 1,
  getEmbeddingProviderInfo: 1,
  toJSON: 1,

  // Tier 2: hot-path mutations
  add: 2,
  update: 2,
  replace: 2,
  compact: 2,
  evict: 2,
  restore: 2,
  registerPattern: 2,
  createGroup: 2,
  dissolveGroup: 2,

  // Tier 3: assessment
  assess: 3,

  // Tier 4: planning
  planEviction: 4,

  // Tier 5: batch/rare
  seed: 5,
  split: 5,
  setTask: 5,
  clearTask: 5,
  listSegments: 5,
  listGroups: 5,
  getEvictionHistory: 5,
  setCapacity: 5,
  snapshot: 5,
  fromSnapshot: 5,
  validate: 5,
  setTokenizer: 5,
  setEmbeddingProvider: 5,
};

// ─── Timing Record ────────────────────────────────────────────────

export interface TimingRecord {
  operation: string;
  selfTime: number;
  providerTime: number;
  customPatternTime: number;
  totalTime: number;
  segmentCount: number;
  cacheHits: number;
  cacheMisses: number;
  timestamp: number;
  budgetExceeded: boolean;
  budgetTarget: number;
}

// ─── Operation Context ────────────────────────────────────────────

export interface OperationContext {
  operation: string;
  segmentCount: number;
  startTime: number;
  timestamp: number;
}

// ─── Sampling Parameters ──────────────────────────────────────────

export interface SamplingParameters {
  enabled: boolean;
  topicalConcentrationSampleSize: number;
  densitySamplingCap: number;
  samplingSeed: number;
  stratifiedGroupSamples: Map<string, number>;
}

// ─── PerformanceInstrumentation ───────────────────────────────────

export class PerformanceInstrumentation {
  private readonly history = new RingBuffer<TimingRecord>(TIMING_HISTORY_CAPACITY);
  private sessionSelfTime = 0;
  private sessionProviderTime = 0;
  private totalBudgetViolations = 0;

  /**
   * Start timing an operation. Call endOperation() when done.
   * Uses performance.now() for sub-millisecond precision.
   */
  startOperation(operation: string, segmentCount: number): OperationContext {
    return {
      operation,
      segmentCount,
      startTime: performance.now(),
      timestamp: Date.now(),
    };
  }

  /**
   * End timing and record the result.
   * @returns The recorded TimingRecord (also stored in history).
   */
  endOperation(
    ctx: OperationContext,
    providerTime = 0,
    customPatternTime = 0,
    cacheHits = 0,
    cacheMisses = 0,
  ): TimingRecord {
    const endTime = performance.now();
    const totalTime = endTime - ctx.startTime;
    const selfTime = totalTime - providerTime - customPatternTime;
    const budgetTarget = this.getBudgetTarget(ctx.operation, ctx.segmentCount);
    const budgetExceeded = selfTime > budgetTarget;

    const record: TimingRecord = {
      operation: ctx.operation,
      selfTime: Math.max(0, selfTime),
      providerTime,
      customPatternTime,
      totalTime,
      segmentCount: ctx.segmentCount,
      cacheHits,
      cacheMisses,
      timestamp: ctx.timestamp,
      budgetExceeded,
      budgetTarget,
    };

    this.history.push(record);
    this.sessionSelfTime += record.selfTime;
    this.sessionProviderTime += providerTime;
    if (budgetExceeded) this.totalBudgetViolations++;

    return record;
  }

  // ── Budget Computation ──────────────────────────────────────────

  /**
   * Get the budget target for an operation at a given segment count.
   * Tiers 3 and 4 scale linearly above n=500.
   */
  getBudgetTarget(operation: string, segmentCount: number): number {
    const tier = OPERATION_TIERS[operation] ?? 5;
    const base = TIER_BUDGETS[tier];

    // Tiers 3 and 4 scale linearly with segment count above reference
    if ((tier === 3 || tier === 4) && segmentCount > BUDGET_REFERENCE_N) {
      return base * (segmentCount / BUDGET_REFERENCE_N);
    }

    return base;
  }

  // ── Sampling Parameters ─────────────────────────────────────────

  /**
   * Compute sampling parameters for the scoring modules.
   * @param segmentCount Total active segment count.
   * @param orderedSegmentIds Sorted segment IDs for seed computation.
   * @param groups Map of groupId → member count for stratified sampling.
   */
  computeSamplingParams(
    segmentCount: number,
    orderedSegmentIds: string[],
    groups?: Map<string, number>,
  ): SamplingParameters {
    const enabled = segmentCount > SAMPLING_THRESHOLD;

    if (!enabled) {
      return {
        enabled: false,
        topicalConcentrationSampleSize: segmentCount,
        densitySamplingCap: DENSITY_SAMPLING_CAP,
        samplingSeed: 0,
        stratifiedGroupSamples: new Map(),
      };
    }

    // Topical concentration sample size: min(ceil(sqrt(n) * 3), n)
    const topicalConcentrationSampleSize = Math.min(
      Math.ceil(Math.sqrt(segmentCount) * 3),
      segmentCount,
    );

    // Sampling seed: FNV-1a hash of concatenated sorted segment IDs
    const sorted = [...orderedSegmentIds].sort();
    const samplingSeed = fnv1a(sorted.join('\0'));

    // Stratified sampling for groups: ceil(m * s / n)
    const stratifiedGroupSamples = new Map<string, number>();
    if (groups !== undefined) {
      for (const [groupId, memberCount] of groups) {
        const samples = Math.ceil(memberCount * topicalConcentrationSampleSize / segmentCount);
        stratifiedGroupSamples.set(groupId, Math.min(samples, memberCount));
      }
    }

    return {
      enabled,
      topicalConcentrationSampleSize,
      densitySamplingCap: DENSITY_SAMPLING_CAP,
      samplingSeed,
      stratifiedGroupSamples,
    };
  }

  // ── Diagnostics ─────────────────────────────────────────────────

  /** Get all timing records (most recent up to 200). */
  getTimingHistory(): TimingRecord[] {
    return this.history.toArray();
  }

  /** Get per-operation statistics for diagnostics. */
  getOperationStats(): Record<string, OperationTimingStats> {
    const records = this.history.toArray();
    const byOp = new Map<string, TimingRecord[]>();

    for (const r of records) {
      let arr = byOp.get(r.operation);
      if (arr === undefined) {
        arr = [];
        byOp.set(r.operation, arr);
      }
      arr.push(r);
    }

    const result: Record<string, OperationTimingStats> = {};

    for (const [op, recs] of byOp) {
      const count = recs.length;
      let totalSelfTime = 0;
      let totalProviderTime = 0;
      let maxSelfTime = 0;
      let violations = 0;
      const selfTimes: number[] = [];

      for (const r of recs) {
        totalSelfTime += r.selfTime;
        totalProviderTime += r.providerTime;
        if (r.selfTime > maxSelfTime) maxSelfTime = r.selfTime;
        if (r.budgetExceeded) violations++;
        selfTimes.push(r.selfTime);
      }

      // P95 self time
      selfTimes.sort((a, b) => a - b);
      const p95Index = Math.ceil(count * 0.95) - 1;
      const p95SelfTime = selfTimes[Math.max(0, p95Index)] ?? 0;

      const tier = OPERATION_TIERS[op] ?? 5;
      const budgetTarget = TIER_BUDGETS[tier];

      result[op] = {
        count,
        totalSelfTime,
        totalProviderTime,
        averageSelfTime: count > 0 ? totalSelfTime / count : 0,
        maxSelfTime,
        p95SelfTime,
        budgetTarget,
        budgetViolations: violations,
        withinBudgetRate: count > 0 ? (count - violations) / count : 1,
      };
    }

    return result;
  }

  /** Assemble full performance summary for diagnostics. */
  getPerformanceSummary(caches: CacheReport): PerformanceSummary {
    return {
      operationTimings: this.getOperationStats(),
      caches,
      sessionSelfTime: this.sessionSelfTime,
      sessionProviderTime: this.sessionProviderTime,
      budgetViolationCount: this.totalBudgetViolations,
    };
  }

  /** Get the operation tier for a given operation name. */
  getOperationTier(operation: string): BudgetTier {
    return OPERATION_TIERS[operation] ?? 5;
  }
}
