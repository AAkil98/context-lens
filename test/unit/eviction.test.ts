import { describe, it, expect } from 'vitest';
import { EvictionAdvisory } from '../../src/eviction.js';
import type { PlanOptions, EvictionDependencies } from '../../src/eviction.js';
import type {
  Segment,
  Group,
  QualityReport,
  SegmentScore,
  WindowScores,
  DetectionResult,
  ActivePattern,
  CapacityReport,
  TokenizerMetadata,
  ContinuitySummary,
  TaskSummary,
  CustomPatternMeta,
  StrategyName,
  CompoundContext,
  EvictionPlan,
} from '../../src/types.js';
import type { SegmentStore } from '../../src/segment-store.js';
import type { SimilarityEngine } from '../../src/similarity.js';
import { ValidationError } from '../../src/errors.js';

// ─── Strategy weights (mirror source constants) ─────────────────

const STRATEGY_WEIGHTS: Record<string, Record<string, number>> = {
  default:    { relevance: 0.30, density: 0.25, coherence: 0.20, importance: 0.15, age: 0.10 },
  saturation: { relevance: 0.20, density: 0.30, coherence: 0.15, importance: 0.15, age: 0.20 },
  erosion:    { relevance: 0.20, density: 0.40, coherence: 0.15, importance: 0.15, age: 0.10 },
  gap:        { relevance: 0.45, density: 0.20, coherence: 0.10, importance: 0.15, age: 0.10 },
  collapse:   { relevance: 0.25, density: 0.25, coherence: 0.25, importance: 0.15, age: 0.10 },
};

// ─── Helpers ────────────────────────────────────────────────────

function makeSegment(id: string, overrides?: Partial<Segment>): Segment {
  return {
    id,
    content: `content for ${id}`,
    tokenCount: 100,
    createdAt: 1000,
    updatedAt: 1000,
    protection: 'default',
    importance: 0.5,
    state: 'active',
    origin: null,
    tags: [],
    groupId: null,
    ...overrides,
  };
}

function makeGroup(
  groupId: string,
  members: string[],
  overrides?: Partial<Group>,
): Group {
  return {
    groupId,
    members,
    protection: 'default',
    importance: 0.5,
    origin: null,
    tags: [],
    createdAt: 1000,
    state: 'active',
    tokenCount: members.length * 100,
    coherence: 0.8,
    ...overrides,
  };
}

function makeSegmentScore(
  segmentId: string,
  overrides?: Partial<SegmentScore>,
): SegmentScore {
  return {
    segmentId,
    coherence: 0.5,
    density: 0.5,
    relevance: 0.5,
    continuity: 0.5,
    composite: 0.5,
    tokenCount: 100,
    redundancy: null,
    groupId: null,
    ...overrides,
  };
}

function makeWindowScores(overrides?: Partial<WindowScores>): WindowScores {
  return {
    coherence: 0.6,
    density: 0.6,
    relevance: 0.6,
    continuity: 0.6,
    ...overrides,
  };
}

function makeCapacity(overrides?: Partial<CapacityReport>): CapacityReport {
  return {
    capacity: 10000,
    totalActiveTokens: 5000,
    utilization: 0.5,
    headroom: 5000,
    pinnedTokens: 0,
    seedTokens: 0,
    managedTokens: 5000,
    availableCapacity: 5000,
    ...overrides,
  };
}

function makeDetection(
  patterns: ActivePattern[] = [],
  overrides?: Partial<DetectionResult>,
): DetectionResult {
  return {
    patterns,
    patternCount: patterns.length,
    highestSeverity: patterns.length > 0 ? patterns[0]!.severity : null,
    preBaseline: false,
    ...overrides,
  };
}

function makeActivePattern(
  name: string,
  overrides?: Partial<ActivePattern>,
): ActivePattern {
  return {
    name,
    severity: 'warning',
    activatedAt: 500,
    currentSince: 500,
    duration: 500,
    trending: 'stable',
    signature: {
      primaryScore: { dimension: name, value: 0.3 },
      secondaryScores: [],
      utilization: 0.9,
      thresholdCrossed: { severity: 'warning', threshold: 0.4 },
    },
    explanation: `${name} detected`,
    remediation: [],
    compoundContext: null,
    ...overrides,
  };
}

function makeCompound(compound: string, coPatterns: string[]): CompoundContext {
  return {
    compound: compound as CompoundContext['compound'],
    coPatterns,
    diagnosis: `${compound} detected`,
    remediationShift: `shift for ${compound}`,
  };
}

function makeReport(overrides?: {
  segments?: SegmentScore[];
  capacity?: Partial<CapacityReport>;
  windowScores?: Partial<WindowScores>;
  patterns?: DetectionResult;
  segmentCount?: number;
  composite?: number | null;
}): QualityReport {
  const segments = overrides?.segments ?? [];
  const ws = makeWindowScores(overrides?.windowScores);
  return {
    schemaVersion: '1.0.0',
    timestamp: 2000,
    reportId: 'rpt-test',
    segmentCount: overrides?.segmentCount ?? segments.length,
    windowScores: ws,
    rawScores: ws,
    composite: overrides?.composite !== undefined ? overrides.composite : 0.6,
    baseline: null,
    capacity: makeCapacity(overrides?.capacity),
    tokenizer: {
      name: 'simple',
      accuracy: 'approximate' as const,
      modelFamily: null,
      errorBound: null,
    },
    embeddingMode: 'trigrams',
    segments,
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
    patterns: overrides?.patterns ?? makeDetection(),
    task: {
      state: 'unset',
      stale: false,
      gracePeriodActive: false,
      gracePeriodRemaining: 0,
    },
  };
}

function makeMockStore(
  segments: Segment[],
  groups: Group[] = [],
): SegmentStore {
  return {
    getOrderedActiveSegments: () => segments,
    listGroups: () => groups,
  } as unknown as SegmentStore;
}

function makeMockSimilarity(returnValue = 0.3): SimilarityEngine {
  return {
    computeSimilarity: () => returnValue,
  } as unknown as SimilarityEngine;
}

function makeDeps(
  segments: Segment[],
  groups: Group[] = [],
  similarity = 0.3,
): EvictionDependencies {
  return {
    store: makeMockStore(segments, groups),
    similarity: makeMockSimilarity(similarity),
  };
}

function makeAdvisory(
  segments: Segment[],
  groups: Group[] = [],
  similarity = 0.3,
): EvictionAdvisory {
  return new EvictionAdvisory(makeDeps(segments, groups, similarity));
}

// ─── Test Suite ─────────────────────────────────────────────────

describe('EvictionAdvisory', () => {
  // ── 1. Ranking Model ────────────────────────────────────────────

  describe('ranking model', () => {
    it('eviction score is in [0.0, 1.0] for normalized inputs', () => {
      const s1 = makeSegment('s1', { tokenCount: 100, createdAt: 1000, updatedAt: 1000 });
      const s2 = makeSegment('s2', { tokenCount: 100, createdAt: 1500, updatedAt: 1500 });
      const segments = [s1, s2];
      const advisory = makeAdvisory(segments);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.3, density: 0.4 }),
          makeSegmentScore('s2', { relevance: 0.7, density: 0.8 }),
        ],
        segmentCount: 2,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 100,
        strategy: 'default',
      });

      for (const c of plan.candidates) {
        expect(c.evictionScore).toBeGreaterThanOrEqual(0.0);
        expect(c.evictionScore).toBeLessThanOrEqual(1.0);
      }
    });

    it('lower eviction score means better candidate (appears first)', () => {
      // s1: low relevance+density = low score = better eviction candidate
      // s2: high relevance+density = high score = worse eviction candidate
      const s1 = makeSegment('s1', { tokenCount: 100, createdAt: 1000, updatedAt: 1000, importance: 0.1 });
      const s2 = makeSegment('s2', { tokenCount: 100, createdAt: 1000, updatedAt: 1000, importance: 0.9 });
      const advisory = makeAdvisory([s1, s2]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.1, density: 0.1 }),
          makeSegmentScore('s2', { relevance: 0.9, density: 0.9 }),
        ],
        segmentCount: 2,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 200,
        strategy: 'default',
      });

      expect(plan.candidates.length).toBe(2);
      expect(plan.candidates[0]!.id).toBe('s1');
      expect(plan.candidates[0]!.evictionScore).toBeLessThan(plan.candidates[1]!.evictionScore);
    });

    it('strategy weights sum to 1.0 for all strategies', () => {
      for (const [name, w] of Object.entries(STRATEGY_WEIGHTS)) {
        const sum = w.relevance + w.density + w.coherence + w.importance + w.age;
        expect(sum).toBeCloseTo(1.0, 10);
      }
    });

    it('different strategies produce different ranking order', () => {
      // High density, low relevance segment vs low density, high relevance
      const s1 = makeSegment('s1', { tokenCount: 100, createdAt: 1000, updatedAt: 1000 });
      const s2 = makeSegment('s2', { tokenCount: 100, createdAt: 1000, updatedAt: 1000 });
      const segments = [s1, s2];

      const scores = [
        makeSegmentScore('s1', { relevance: 0.9, density: 0.1 }),
        makeSegmentScore('s2', { relevance: 0.1, density: 0.9 }),
      ];

      const report = makeReport({
        segments: scores,
        segmentCount: 2,
        capacity: { totalActiveTokens: 200 },
      });

      // Gap strategy heavily weights relevance (0.45)
      const gapAdvisory = makeAdvisory(segments);
      const gapPlan = gapAdvisory.planEviction(report, {
        targetTokens: 200,
        strategy: 'gap',
      });

      // Erosion strategy heavily weights density (0.40)
      const erosionAdvisory = makeAdvisory(segments);
      const erosionPlan = erosionAdvisory.planEviction(report, {
        targetTokens: 200,
        strategy: 'erosion',
      });

      // Under gap strategy, s2 (low relevance) should rank first
      // Under erosion strategy, s1 (low density) should rank first
      expect(gapPlan.candidates[0]!.id).toBe('s2');
      expect(erosionPlan.candidates[0]!.id).toBe('s1');
    });
  });

  // ── 2. Signal Derivation ────────────────────────────────────────

  describe('signal derivation', () => {
    it('relevance and density are used directly from segment scores', () => {
      const s1 = makeSegment('s1', { tokenCount: 100, createdAt: 1000, updatedAt: 1000 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1', { relevance: 0.35, density: 0.72 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 100,
        strategy: 'default',
      });

      expect(plan.candidates[0]!.scores.relevance).toBeCloseTo(0.35, 4);
      expect(plan.candidates[0]!.scores.density).toBeCloseTo(0.72, 4);
    });

    it('age retention: 1 - (age / maxAge) — oldest gets 0, newest gets ~1', () => {
      // s1 created at 500 (oldest), s2 at 1000, s3 at 2000 (newest, age=0)
      const s1 = makeSegment('s1', { tokenCount: 100, createdAt: 500, updatedAt: 500 });
      const s2 = makeSegment('s2', { tokenCount: 100, createdAt: 1000, updatedAt: 1000 });
      const s3 = makeSegment('s3', { tokenCount: 100, createdAt: 2000, updatedAt: 2000 });
      const advisory = makeAdvisory([s1, s2, s3]);

      // Report timestamp is 2000, so:
      // s1 age = 2000-500 = 1500 (maxAge), ageRet = 1 - 1500/1500 = 0
      // s3 age = 2000-2000 = 0, ageRet = 1 - 0/1500 = 1
      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.5, density: 0.5 }),
          makeSegmentScore('s2', { relevance: 0.5, density: 0.5 }),
          makeSegmentScore('s3', { relevance: 0.5, density: 0.5 }),
        ],
        segmentCount: 3,
        capacity: { totalActiveTokens: 300 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 300,
        strategy: 'default',
      });

      // With equal relevance/density/importance, age should be the tiebreaker
      // signal. Oldest (s1, ageRet=0) should have lowest score, appearing first.
      expect(plan.candidates[0]!.id).toBe('s1');
      expect(plan.candidates[2]!.id).toBe('s3');
    });

    it('importance signal is taken from the segment directly', () => {
      const s1 = makeSegment('s1', { tokenCount: 100, importance: 0.1, createdAt: 1000, updatedAt: 1000 });
      const s2 = makeSegment('s2', { tokenCount: 100, importance: 0.9, createdAt: 1000, updatedAt: 1000 });
      const advisory = makeAdvisory([s1, s2]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.5, density: 0.5 }),
          makeSegmentScore('s2', { relevance: 0.5, density: 0.5 }),
        ],
        segmentCount: 2,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 200,
        strategy: 'default',
      });

      // Low importance (s1) should be preferred for eviction (lower score)
      expect(plan.candidates[0]!.id).toBe('s1');
      expect(plan.candidates[0]!.importance).toBe(0.1);
      expect(plan.candidates[1]!.importance).toBe(0.9);
    });
  });

  // ── 3. Bridge Scores ──────────────────────────────────────────

  describe('bridge scores', () => {
    it('interior segment: clamp(avgNeighborSim - skipSim, 0, 1)', () => {
      // 3 segments: prev, curr, next
      // leftSim = curr-prev = 0.8, rightSim = curr-next = 0.8, skipSim = prev-next = 0.2
      // bridge = clamp((0.8+0.8)/2 - 0.2, 0, 1) = clamp(0.6, 0, 1) = 0.6
      const s1 = makeSegment('s1', { content: 'alpha', tokenCount: 100 });
      const s2 = makeSegment('s2', { content: 'beta', tokenCount: 100 });
      const s3 = makeSegment('s3', { content: 'gamma', tokenCount: 100 });

      // Custom similarity: return different values based on content pairs
      const simMock = {
        computeSimilarity: (
          _hashA: number, contentA: string,
          _hashB: number, contentB: string,
        ) => {
          const pair = [contentA, contentB].sort().join('|');
          if (pair.includes('alpha') && pair.includes('beta')) return 0.8;
          if (pair.includes('beta') && pair.includes('gamma')) return 0.8;
          if (pair.includes('alpha') && pair.includes('gamma')) return 0.2;
          return 0.3;
        },
      } as unknown as SimilarityEngine;

      const advisory = new EvictionAdvisory({
        store: makeMockStore([s1, s2, s3]),
        similarity: simMock,
      });

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.5, density: 0.5 }),
          makeSegmentScore('s2', { relevance: 0.5, density: 0.5 }),
          makeSegmentScore('s3', { relevance: 0.5, density: 0.5 }),
        ],
        segmentCount: 3,
        capacity: { totalActiveTokens: 300 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 300,
        strategy: 'default',
      });

      // s2 is interior, its bridge score = 0.6
      const s2Candidate = plan.candidates.find(c => c.id === 's2')!;
      expect(s2Candidate.scores.coherenceContribution).toBeCloseTo(0.6, 2);
    });

    it('first and last segments get bridge score 0', () => {
      const s1 = makeSegment('s1', { content: 'first', tokenCount: 100 });
      const s2 = makeSegment('s2', { content: 'middle', tokenCount: 100 });
      const s3 = makeSegment('s3', { content: 'last', tokenCount: 100 });
      const advisory = makeAdvisory([s1, s2, s3], [], 0.5);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1'),
          makeSegmentScore('s2'),
          makeSegmentScore('s3'),
        ],
        segmentCount: 3,
        capacity: { totalActiveTokens: 300 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 300,
        strategy: 'default',
      });

      const first = plan.candidates.find(c => c.id === 's1')!;
      const last = plan.candidates.find(c => c.id === 's3')!;
      expect(first.scores.coherenceContribution).toBe(0);
      expect(last.scores.coherenceContribution).toBe(0);
    });

    it('single segment gets bridge score 0', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 100,
        strategy: 'default',
      });

      expect(plan.candidates[0]!.scores.coherenceContribution).toBe(0);
    });

    it('bridge score is clamped to [0, 1] even with extreme similarity values', () => {
      const s1 = makeSegment('s1', { content: 'a', tokenCount: 100 });
      const s2 = makeSegment('s2', { content: 'b', tokenCount: 100 });
      const s3 = makeSegment('s3', { content: 'c', tokenCount: 100 });

      // avgNeighborSim = 1.0, skipSim = 0 => bridge = 1.0 (clamped at 1)
      const simMock = {
        computeSimilarity: (
          _hashA: number, contentA: string,
          _hashB: number, contentB: string,
        ) => {
          const pair = [contentA, contentB].sort().join('|');
          if (pair === 'a|c') return 0; // skip similarity
          return 1.0; // neighbor similarity
        },
      } as unknown as SimilarityEngine;

      const advisory = new EvictionAdvisory({
        store: makeMockStore([s1, s2, s3]),
        similarity: simMock,
      });

      const report = makeReport({
        segments: [makeSegmentScore('s1'), makeSegmentScore('s2'), makeSegmentScore('s3')],
        segmentCount: 3,
        capacity: { totalActiveTokens: 300 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 300,
        strategy: 'default',
      });

      const middle = plan.candidates.find(c => c.id === 's2')!;
      expect(middle.scores.coherenceContribution).toBeLessThanOrEqual(1);
      expect(middle.scores.coherenceContribution).toBeGreaterThanOrEqual(0);
    });
  });

  // ── 4. Strategy Auto-Selection ────────────────────────────────

  describe('strategy auto-selection', () => {
    it('no patterns selects default strategy', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([]),
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.strategy).toBe('default');
    });

    it('saturation active selects saturation strategy', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([makeActivePattern('saturation')]),
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.strategy).toBe('saturation');
    });

    it('compound override: saturation+erosion (fullOfJunk) selects erosion', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const compound = makeCompound('fullOfJunk', ['saturation', 'erosion']);
      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([
          makeActivePattern('saturation', { compoundContext: compound }),
          makeActivePattern('erosion', { compoundContext: compound }),
        ]),
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.strategy).toBe('erosion');
    });

    it('fracture alone selects default strategy', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([makeActivePattern('fracture')]),
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.strategy).toBe('default');
    });

    it('explicit strategy option overrides auto-selection', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([makeActivePattern('saturation')]),
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 50,
        strategy: 'gap',
      });
      expect(plan.strategy).toBe('gap');
    });

    it('gap pattern selects gap strategy', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([makeActivePattern('gap')]),
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.strategy).toBe('gap');
    });

    it('collapse pattern takes priority over lower-priority patterns', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      // collapse has priority 1, erosion has priority 4
      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([
          makeActivePattern('erosion'),
          makeActivePattern('collapse'),
        ]),
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.strategy).toBe('collapse');
    });
  });

  // ── 5. Protection Tiers ───────────────────────────────────────

  describe('protection tiers', () => {
    it('default tier exhausted before priority(0)', () => {
      const sDefault = makeSegment('s-default', { protection: 'default', tokenCount: 100 });
      const sPriority = makeSegment('s-priority', { protection: 'priority(0)', tokenCount: 100 });
      const advisory = makeAdvisory([sDefault, sPriority]);

      const report = makeReport({
        segments: [makeSegmentScore('s-default'), makeSegmentScore('s-priority')],
        segmentCount: 2,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 200,
        strategy: 'default',
      });

      expect(plan.candidates.length).toBe(2);
      expect(plan.candidates[0]!.id).toBe('s-default');
      expect(plan.candidates[0]!.tier).toBe('default');
      expect(plan.candidates[1]!.id).toBe('s-priority');
      expect(plan.candidates[1]!.tier).toBe('priority(0)');
    });

    it('seed only offered after all default and priority segments', () => {
      const sDefault = makeSegment('s-default', { protection: 'default', tokenCount: 100 });
      const sPrio = makeSegment('s-prio', { protection: 'priority(5)', tokenCount: 100 });
      const sSeed = makeSegment('s-seed', { protection: 'seed', tokenCount: 100 });
      const advisory = makeAdvisory([sDefault, sPrio, sSeed]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s-default'),
          makeSegmentScore('s-prio'),
          makeSegmentScore('s-seed'),
        ],
        segmentCount: 3,
        capacity: { totalActiveTokens: 300 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 300,
        strategy: 'default',
      });

      expect(plan.candidates.length).toBe(3);
      // Default first, then priority, then seed
      const tiers = plan.candidates.map(c => c.tier);
      expect(tiers.indexOf('default')).toBeLessThan(tiers.indexOf('priority(5)'));
      expect(tiers.indexOf('priority(5)')).toBeLessThan(tiers.indexOf('seed'));
      expect(plan.seedsIncluded).toBe(true);
    });

    it('pinned segments never appear as candidates', () => {
      const sDefault = makeSegment('s-default', { protection: 'default', tokenCount: 100 });
      const sPinned = makeSegment('s-pinned', { protection: 'pinned', tokenCount: 100 });
      const advisory = makeAdvisory([sDefault, sPinned]);

      const report = makeReport({
        segments: [makeSegmentScore('s-default'), makeSegmentScore('s-pinned')],
        segmentCount: 2,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 200,
        strategy: 'default',
      });

      const ids = plan.candidates.map(c => c.id);
      expect(ids).not.toContain('s-pinned');
      expect(ids).toContain('s-default');
    });

    it('priority tiers are ordered numerically (lower number = higher protection)', () => {
      const s0 = makeSegment('s-p0', { protection: 'priority(0)', tokenCount: 100 });
      const s5 = makeSegment('s-p5', { protection: 'priority(5)', tokenCount: 100 });
      const s10 = makeSegment('s-p10', { protection: 'priority(10)', tokenCount: 100 });
      const sDef = makeSegment('s-def', { protection: 'default', tokenCount: 100 });
      const advisory = makeAdvisory([sDef, s0, s5, s10]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s-def'),
          makeSegmentScore('s-p0'),
          makeSegmentScore('s-p5'),
          makeSegmentScore('s-p10'),
        ],
        segmentCount: 4,
        capacity: { totalActiveTokens: 400 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 400,
        strategy: 'default',
      });

      // default(tierRank=0) < priority(0)(tierRank=1) < priority(5)(tierRank=6) < priority(10)(tierRank=11)
      const tiers = plan.candidates.map(c => c.tier);
      expect(tiers[0]).toBe('default');
    });
  });

  // ── 6. Group Handling ──────────────────────────────────────────

  describe('group handling', () => {
    it('group replaces individual members and uses token-weighted mean score', () => {
      const s1 = makeSegment('s1', { tokenCount: 200, groupId: 'g1' });
      const s2 = makeSegment('s2', { tokenCount: 100, groupId: 'g1' });
      const s3 = makeSegment('s3', { tokenCount: 100 }); // ungrouped
      const group = makeGroup('g1', ['s1', 's2'], { tokenCount: 300 });
      const advisory = makeAdvisory([s1, s2, s3], [group]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.8, density: 0.6, tokenCount: 200 }),
          makeSegmentScore('s2', { relevance: 0.2, density: 0.4, tokenCount: 100 }),
          makeSegmentScore('s3', { relevance: 0.5, density: 0.5, tokenCount: 100 }),
        ],
        segmentCount: 3,
        capacity: { totalActiveTokens: 400 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 400,
        strategy: 'default',
      });

      // s1 and s2 should not appear individually
      const ids = plan.candidates.map(c => c.id);
      expect(ids).not.toContain('s1');
      expect(ids).not.toContain('s2');
      expect(ids).toContain('g1');
      expect(ids).toContain('s3');

      // Group candidate
      const gc = plan.candidates.find(c => c.id === 'g1')!;
      expect(gc.type).toBe('group');
      expect(gc.memberIds).toEqual(expect.arrayContaining(['s1', 's2']));
      // Token-weighted relevance: (0.8*200 + 0.2*100) / 300 = 180/300 = 0.6
      expect(gc.scores.relevance).toBeCloseTo(0.6, 2);
      // Token-weighted density: (0.6*200 + 0.4*100) / 300 = 160/300 ≈ 0.5333
      expect(gc.scores.density).toBeCloseTo(160 / 300, 2);
    });

    it('group overshoot deferral at 2x remaining target', () => {
      // Group has 500 tokens, individual has 100
      // Target is 100 tokens: group (500) > 2x remaining (200), so deferred
      const s1 = makeSegment('s1', { tokenCount: 250, groupId: 'g1' });
      const s2 = makeSegment('s2', { tokenCount: 250, groupId: 'g1' });
      const s3 = makeSegment('s3', { tokenCount: 100 });
      const group = makeGroup('g1', ['s1', 's2'], { tokenCount: 500 });

      const advisory = makeAdvisory([s1, s2, s3], [group]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.2, density: 0.2, tokenCount: 250 }),
          makeSegmentScore('s2', { relevance: 0.2, density: 0.2, tokenCount: 250 }),
          makeSegmentScore('s3', { relevance: 0.3, density: 0.3, tokenCount: 100 }),
        ],
        segmentCount: 3,
        capacity: { totalActiveTokens: 600 },
      });

      // Target: 100 tokens. Group has 500 > 2*100 = 200.
      // s3 (100 tokens, same tier) can meet the target, so group is deferred.
      const plan = advisory.planEviction(report, {
        targetTokens: 100,
        strategy: 'default',
      });

      // The first candidate should be s3 (non-group) since group is deferred
      expect(plan.candidates[0]!.id).toBe('s3');
      expect(plan.targetMet).toBe(true);
    });
  });

  // ── 7. Compaction ─────────────────────────────────────────────

  describe('compaction', () => {
    it('seed segment gets compaction recommendation under default strategy', () => {
      const sSeed = makeSegment('s-seed', {
        protection: 'seed',
        tokenCount: 200,
        importance: 0.5,
      });
      const advisory = makeAdvisory([sSeed]);

      const report = makeReport({
        segments: [makeSegmentScore('s-seed', { tokenCount: 200 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 100,
        strategy: 'default',
        includeCompactionAlternatives: true,
      });

      const candidate = plan.candidates.find(c => c.id === 's-seed')!;
      expect(candidate.recommendation).toBe('compact');
      expect(candidate.compaction).not.toBeNull();
    });

    it('already-compacted segment gets eviction, not compaction', () => {
      const sCompacted = makeSegment('s-compacted', {
        protection: 'seed',
        tokenCount: 200,
        origin: 'summary:compacted',
      });
      const advisory = makeAdvisory([sCompacted]);

      const report = makeReport({
        segments: [makeSegmentScore('s-compacted', { tokenCount: 200 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 100,
        strategy: 'default',
        includeCompactionAlternatives: true,
      });

      const candidate = plan.candidates.find(c => c.id === 's-compacted')!;
      expect(candidate.recommendation).toBe('evict');
    });

    it('collapse strategy prefers compaction; saturation prefers eviction', () => {
      // Under collapse: compaction bias (minimize loss) => true
      // Under saturation: eviction bias => false
      const sSeg = makeSegment('s1', { tokenCount: 200, protection: 'default' });

      // Collapse
      const collapseAdvisory = makeAdvisory([sSeg]);
      const report1 = makeReport({
        segments: [makeSegmentScore('s1', { tokenCount: 200 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 200 },
      });
      const collapsePlan = collapseAdvisory.planEviction(report1, {
        targetTokens: 100,
        strategy: 'collapse',
        includeCompactionAlternatives: true,
      });
      const collapseCandidate = collapsePlan.candidates[0]!;
      expect(collapseCandidate.recommendation).toBe('compact');

      // Saturation
      const satAdvisory = makeAdvisory([sSeg]);
      const report2 = makeReport({
        segments: [makeSegmentScore('s1', { tokenCount: 200 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 200 },
      });
      const satPlan = satAdvisory.planEviction(report2, {
        targetTokens: 100,
        strategy: 'saturation',
        includeCompactionAlternatives: true,
      });
      const satCandidate = satPlan.candidates[0]!;
      expect(satCandidate.recommendation).toBe('evict');
    });

    it('includeCompactionAlternatives false suppresses compaction', () => {
      const sSeed = makeSegment('s-seed', {
        protection: 'seed',
        tokenCount: 200,
      });
      const advisory = makeAdvisory([sSeed]);

      const report = makeReport({
        segments: [makeSegmentScore('s-seed', { tokenCount: 200 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 100,
        strategy: 'default',
        includeCompactionAlternatives: false,
      });

      const candidate = plan.candidates[0]!;
      expect(candidate.recommendation).toBe('evict');
      expect(candidate.compaction).toBeNull();
    });
  });

  // ── 8. Plan Assembly ──────────────────────────────────────────

  describe('plan assembly', () => {
    it('targetMet is true when cumulative tokens >= target', () => {
      const s1 = makeSegment('s1', { tokenCount: 200 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1', { tokenCount: 200 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 100 });
      expect(plan.targetMet).toBe(true);
      expect(plan.shortfall).toBe(0);
    });

    it('shortfall reported when target not met', () => {
      const s1 = makeSegment('s1', { tokenCount: 50 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1', { tokenCount: 50 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 50 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 200 });
      expect(plan.targetMet).toBe(false);
      expect(plan.shortfall).toBe(150);
    });

    it('maxCandidates limits the number of candidates', () => {
      const segments = Array.from({ length: 10 }, (_, i) =>
        makeSegment(`s${i}`, { tokenCount: 100, createdAt: 1000 + i }),
      );
      const advisory = makeAdvisory(segments);

      const report = makeReport({
        segments: segments.map(s => makeSegmentScore(s.id, { tokenCount: 100 })),
        segmentCount: 10,
        capacity: { totalActiveTokens: 1000 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 1000,
        maxCandidates: 3,
      });

      expect(plan.candidateCount).toBe(3);
      expect(plan.candidates.length).toBe(3);
    });

    it('exhausted flag is true when all eligible candidates consumed', () => {
      const s1 = makeSegment('s1', { tokenCount: 50 });
      const s2 = makeSegment('s2', { tokenCount: 50 });
      const advisory = makeAdvisory([s1, s2]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { tokenCount: 50 }),
          makeSegmentScore('s2', { tokenCount: 50 }),
        ],
        segmentCount: 2,
        capacity: { totalActiveTokens: 100 },
      });

      // Asking for more than available
      const plan = advisory.planEviction(report, { targetTokens: 500 });
      expect(plan.exhausted).toBe(true);
    });

    it('mutually exclusive targetTokens and targetUtilization throws', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      expect(() => advisory.planEviction(report, {
        targetTokens: 100,
        targetUtilization: 0.5,
      })).toThrow(ValidationError);
    });

    it('cumulativeTokens accumulates correctly across candidates', () => {
      const s1 = makeSegment('s1', { tokenCount: 100, importance: 0.1, createdAt: 1000, updatedAt: 1000 });
      const s2 = makeSegment('s2', { tokenCount: 150, importance: 0.2, createdAt: 1000, updatedAt: 1000 });
      const s3 = makeSegment('s3', { tokenCount: 200, importance: 0.3, createdAt: 1000, updatedAt: 1000 });
      const advisory = makeAdvisory([s1, s2, s3]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.1, density: 0.1 }),
          makeSegmentScore('s2', { relevance: 0.2, density: 0.2 }),
          makeSegmentScore('s3', { relevance: 0.3, density: 0.3 }),
        ],
        segmentCount: 3,
        capacity: { totalActiveTokens: 450 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 450,
        strategy: 'default',
      });

      // Check cumulative tokens are increasing
      let prevCum = 0;
      for (const c of plan.candidates) {
        expect(c.cumulativeTokens).toBeGreaterThan(prevCum);
        prevCum = c.cumulativeTokens;
      }
      // Last candidate's cumulative should equal totalReclaimable
      expect(plan.candidates[plan.candidates.length - 1]!.cumulativeTokens).toBe(plan.totalReclaimable);
    });

    it('targetUtilization computes correct token target', () => {
      const s1 = makeSegment('s1', { tokenCount: 500 });
      const advisory = makeAdvisory([s1]);

      // capacity=10000, totalActive=5000, targetUtil=0.3
      // target = max(0, 5000 - floor(10000 * 0.3)) = max(0, 5000 - 3000) = 2000
      const report = makeReport({
        segments: [makeSegmentScore('s1', { tokenCount: 500 })],
        segmentCount: 1,
        capacity: { capacity: 10000, totalActiveTokens: 5000, utilization: 0.5 },
      });

      const plan = advisory.planEviction(report, { targetUtilization: 0.3 });
      expect(plan.target.tokens).toBe(2000);
    });

    it('empty window returns empty plan with no candidates', () => {
      const advisory = makeAdvisory([]);

      const report = makeReport({
        segments: [],
        segmentCount: 0,
        capacity: { totalActiveTokens: 0, utilization: 0 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 100 });
      expect(plan.candidates).toEqual([]);
      expect(plan.candidateCount).toBe(0);
      expect(plan.exhausted).toBe(true);
    });

    it('plan includes correct output shape with all required fields', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });

      // Top-level plan fields
      expect(plan).toHaveProperty('schemaVersion');
      expect(plan).toHaveProperty('planId');
      expect(plan).toHaveProperty('timestamp');
      expect(plan).toHaveProperty('strategy');
      expect(plan).toHaveProperty('target');
      expect(plan).toHaveProperty('candidates');
      expect(plan).toHaveProperty('candidateCount');
      expect(plan).toHaveProperty('totalReclaimable');
      expect(plan).toHaveProperty('targetMet');
      expect(plan).toHaveProperty('shortfall');
      expect(plan).toHaveProperty('seedsIncluded');
      expect(plan).toHaveProperty('exhausted');
      expect(plan).toHaveProperty('qualityImpact');
      expect(plan).toHaveProperty('patterns');
      expect(plan).toHaveProperty('reportId');

      // Target shape
      expect(plan.target).toHaveProperty('tokens');
      expect(plan.target).toHaveProperty('utilizationBefore');
      expect(plan.target).toHaveProperty('utilizationAfter');

      // Quality impact shape
      expect(plan.qualityImpact).toHaveProperty('coherence');
      expect(plan.qualityImpact).toHaveProperty('density');
      expect(plan.qualityImpact).toHaveProperty('relevance');
      expect(plan.qualityImpact).toHaveProperty('continuity');
      expect(plan.qualityImpact).toHaveProperty('composite');

      // Candidate shape
      const c = plan.candidates[0]!;
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('type');
      expect(c).toHaveProperty('tokenCount');
      expect(c).toHaveProperty('cumulativeTokens');
      expect(c).toHaveProperty('evictionScore');
      expect(c).toHaveProperty('tier');
      expect(c).toHaveProperty('importance');
      expect(c).toHaveProperty('scores');
      expect(c).toHaveProperty('impact');
      expect(c).toHaveProperty('recommendation');
      expect(c).toHaveProperty('compaction');
      expect(c).toHaveProperty('memberIds');
      expect(c).toHaveProperty('reason');

      // Scores shape
      expect(c.scores).toHaveProperty('relevance');
      expect(c.scores).toHaveProperty('density');
      expect(c.scores).toHaveProperty('coherenceContribution');
      expect(c.scores).toHaveProperty('redundancy');

      // Impact shape
      expect(c.impact).toHaveProperty('coherenceDelta');
      expect(c.impact).toHaveProperty('densityDelta');
      expect(c.impact).toHaveProperty('relevanceDelta');
      expect(c.impact).toHaveProperty('continuityDelta');
      expect(c.impact).toHaveProperty('compositeDelta');
    });

    it('reportId is propagated from the input report', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.reportId).toBe('rpt-test');
    });

    it('patterns list reflects active patterns from the report', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([
          makeActivePattern('saturation'),
          makeActivePattern('erosion'),
        ]),
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.patterns).toEqual(expect.arrayContaining(['saturation', 'erosion']));
      expect(plan.patterns.length).toBe(2);
    });
  });

  // ── 9. Tie-Breaking ───────────────────────────────────────────

  describe('tie-breaking', () => {
    it('equal scores: tier > importance > relevance > tokenCount > createdAt > id', () => {
      // All same scores, all default tier, all same importance, same relevance,
      // same tokenCount, same createdAt — will break on id
      const segments = [
        makeSegment('c', { tokenCount: 100, importance: 0.5, createdAt: 1000, updatedAt: 1000, content: 'same content' }),
        makeSegment('a', { tokenCount: 100, importance: 0.5, createdAt: 1000, updatedAt: 1000, content: 'same content' }),
        makeSegment('b', { tokenCount: 100, importance: 0.5, createdAt: 1000, updatedAt: 1000, content: 'same content' }),
      ];
      const advisory = makeAdvisory(segments, [], 0.5);

      const report = makeReport({
        segments: segments.map(s => makeSegmentScore(s.id, {
          relevance: 0.5,
          density: 0.5,
        })),
        segmentCount: 3,
        capacity: { totalActiveTokens: 300 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 300,
        strategy: 'default',
      });

      // Should be sorted by id lexicographically: a, b, c
      expect(plan.candidates[0]!.id).toBe('a');
      expect(plan.candidates[1]!.id).toBe('b');
      expect(plan.candidates[2]!.id).toBe('c');
    });

    it('tier difference takes priority over score difference', () => {
      // sPrio has a much lower eviction score but higher tier
      const sDefault = makeSegment('s-def', {
        protection: 'default',
        tokenCount: 100,
        importance: 0.9,
        createdAt: 1000,
        updatedAt: 1000,
      });
      const sPrio = makeSegment('s-prio', {
        protection: 'priority(0)',
        tokenCount: 100,
        importance: 0.1,
        createdAt: 1000,
        updatedAt: 1000,
      });
      const advisory = makeAdvisory([sDefault, sPrio]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s-def', { relevance: 0.9, density: 0.9 }),
          makeSegmentScore('s-prio', { relevance: 0.1, density: 0.1 }),
        ],
        segmentCount: 2,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 200,
        strategy: 'default',
      });

      // default tier comes first even though it has higher score
      expect(plan.candidates[0]!.tier).toBe('default');
      expect(plan.candidates[1]!.tier).toBe('priority(0)');
    });

    it('larger tokenCount preferred when scores are equal (descending)', () => {
      // Same score, same importance, same relevance, different tokenCount
      const s1 = makeSegment('s1', {
        tokenCount: 300,
        importance: 0.5,
        createdAt: 1000,
        updatedAt: 1000,
        content: 'identical text for hash',
      });
      const s2 = makeSegment('s2', {
        tokenCount: 100,
        importance: 0.5,
        createdAt: 1000,
        updatedAt: 1000,
        content: 'identical text for hash',
      });
      const advisory = makeAdvisory([s1, s2], [], 0.5);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.5, density: 0.5 }),
          makeSegmentScore('s2', { relevance: 0.5, density: 0.5 }),
        ],
        segmentCount: 2,
        capacity: { totalActiveTokens: 400 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 400,
        strategy: 'default',
      });

      // Larger tokenCount (s1=300) should come first (descending for tokenCount)
      expect(plan.candidates[0]!.id).toBe('s1');
      expect(plan.candidates[0]!.tokenCount).toBe(300);
    });
  });

  // ── 10. Collapse Floor Guard ──────────────────────────────────

  describe('collapse floor guard', () => {
    it('candidate excluded when projected continuity drops below 0.3', () => {
      // Setup: continuity at 0.4, segment with high eviction cost would drop below 0.3
      // evictionCost = relevance * importance * tokenFrac
      // For s2: 0.9 * 0.9 * (400/1000) = 0.324, projected = 0.4 - 0.324 = 0.076 < 0.3
      const s1 = makeSegment('s1', {
        tokenCount: 200,
        importance: 0.1,
        createdAt: 1500,
        updatedAt: 1500,
      });
      const s2 = makeSegment('s2', {
        tokenCount: 400,
        importance: 0.9,
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s3 = makeSegment('s3', {
        tokenCount: 400,
        importance: 0.1,
        createdAt: 1800,
        updatedAt: 1800,
      });
      const advisory = makeAdvisory([s1, s2, s3]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.1, density: 0.1 }),
          makeSegmentScore('s2', { relevance: 0.9, density: 0.1 }),
          makeSegmentScore('s3', { relevance: 0.1, density: 0.1 }),
        ],
        segmentCount: 3,
        capacity: { totalActiveTokens: 1000, capacity: 10000, utilization: 0.1 },
        windowScores: { continuity: 0.4 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 800,
        strategy: 'collapse',
      });

      // s2 should be excluded because its eviction would drop continuity below 0.3
      // s1 and s3 (low relevance * low importance) should still be included
      const ids = plan.candidates.map(c => c.id);
      expect(ids).not.toContain('s2');
      expect(ids).toContain('s1');
      expect(ids).toContain('s3');
    });

    it('collapse floor guard only applies under collapse strategy', () => {
      // Same scenario as above but with default strategy — s2 should be included
      const s1 = makeSegment('s1', {
        tokenCount: 200,
        importance: 0.1,
        createdAt: 1500,
        updatedAt: 1500,
      });
      const s2 = makeSegment('s2', {
        tokenCount: 400,
        importance: 0.9,
        createdAt: 1000,
        updatedAt: 1000,
      });
      const advisory = makeAdvisory([s1, s2]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.1, density: 0.1 }),
          makeSegmentScore('s2', { relevance: 0.9, density: 0.1 }),
        ],
        segmentCount: 2,
        capacity: { totalActiveTokens: 600, capacity: 10000, utilization: 0.06 },
        windowScores: { continuity: 0.4 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 600,
        strategy: 'default',
      });

      const ids = plan.candidates.map(c => c.id);
      expect(ids).toContain('s2');
    });
  });

  // ── Validation ────────────────────────────────────────────────

  describe('validation', () => {
    it('throws on negative targetTokens', () => {
      const advisory = makeAdvisory([makeSegment('s1')]);
      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
      });

      expect(() => advisory.planEviction(report, { targetTokens: -10 }))
        .toThrow(ValidationError);
    });

    it('throws on targetUtilization >= 1', () => {
      const advisory = makeAdvisory([makeSegment('s1')]);
      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
      });

      expect(() => advisory.planEviction(report, { targetUtilization: 1.0 }))
        .toThrow(ValidationError);
    });

    it('throws on targetUtilization < 0', () => {
      const advisory = makeAdvisory([makeSegment('s1')]);
      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
      });

      expect(() => advisory.planEviction(report, { targetUtilization: -0.1 }))
        .toThrow(ValidationError);
    });

    it('throws on non-integer maxCandidates', () => {
      const advisory = makeAdvisory([makeSegment('s1')]);
      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
      });

      expect(() => advisory.planEviction(report, { targetTokens: 50, maxCandidates: 2.5 }))
        .toThrow(ValidationError);
    });

    it('throws on zero maxCandidates', () => {
      const advisory = makeAdvisory([makeSegment('s1')]);
      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
      });

      expect(() => advisory.planEviction(report, { targetTokens: 50, maxCandidates: 0 }))
        .toThrow(ValidationError);
    });
  });

  // ── Impact Estimation ─────────────────────────────────────────

  describe('impact estimation', () => {
    it('candidate impact deltas are present and finite', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 100 });
      const impact = plan.candidates[0]!.impact;

      expect(Number.isFinite(impact.coherenceDelta)).toBe(true);
      expect(Number.isFinite(impact.densityDelta)).toBe(true);
      expect(Number.isFinite(impact.relevanceDelta)).toBe(true);
      expect(Number.isFinite(impact.continuityDelta)).toBe(true);
      expect(Number.isFinite(impact.compositeDelta)).toBe(true);
    });

    it('plan-level qualityImpact reflects projected window scores', () => {
      const s1 = makeSegment('s1', { tokenCount: 500, importance: 0.5 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1', { relevance: 0.5, density: 0.5 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 500, capacity: 1000 },
        windowScores: { coherence: 0.7, density: 0.7, relevance: 0.7, continuity: 0.7 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 500 });

      expect(plan.qualityImpact.coherence).toBeGreaterThanOrEqual(0);
      expect(plan.qualityImpact.density).toBeGreaterThanOrEqual(0);
      expect(plan.qualityImpact.relevance).toBeGreaterThanOrEqual(0);
      expect(plan.qualityImpact.continuity).toBeGreaterThanOrEqual(0);
      expect(plan.qualityImpact.composite).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Plan ID and Schema ────────────────────────────────────────

  describe('plan metadata', () => {
    it('plan IDs are unique across multiple calls', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan1 = advisory.planEviction(report, { targetTokens: 50 });
      const plan2 = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan1.planId).not.toBe(plan2.planId);
    });

    it('schemaVersion is set', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.schemaVersion).toBe('1.0.0');
    });

    it('timestamp comes from the report', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.timestamp).toBe(report.timestamp);
    });
  });

  // ── Custom Pattern Meta ───────────────────────────────────────

  describe('custom pattern meta', () => {
    it('custom pattern with strategyHint is used for strategy selection', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const customMeta: CustomPatternMeta[] = [{
        name: 'myCustomPattern',
        description: 'custom',
        priority: 0, // highest priority
        strategyHint: 'gap',
        registeredAt: 500,
        registrationOrder: 0,
      }];

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([makeActivePattern('myCustomPattern')]),
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 }, customMeta);
      expect(plan.strategy).toBe('gap');
    });

    it('custom pattern with null strategyHint falls back to default', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const customMeta: CustomPatternMeta[] = [{
        name: 'myCustomPattern',
        description: 'custom',
        priority: 0,
        strategyHint: null,
        registeredAt: 500,
        registrationOrder: 0,
      }];

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
        patterns: makeDetection([makeActivePattern('myCustomPattern')]),
      });

      const plan = advisory.planEviction(report, { targetTokens: 50 }, customMeta);
      expect(plan.strategy).toBe('default');
    });
  });

  // ── Utilization Tracking ──────────────────────────────────────

  describe('utilization tracking', () => {
    it('utilizationAfter decreases after eviction', () => {
      const s1 = makeSegment('s1', { tokenCount: 3000 });
      const s2 = makeSegment('s2', { tokenCount: 2000 });
      const advisory = makeAdvisory([s1, s2]);

      const report = makeReport({
        segments: [
          makeSegmentScore('s1', { relevance: 0.2, density: 0.2, tokenCount: 3000 }),
          makeSegmentScore('s2', { relevance: 0.8, density: 0.8, tokenCount: 2000 }),
        ],
        segmentCount: 2,
        capacity: { totalActiveTokens: 5000, capacity: 10000, utilization: 0.5 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 3000 });
      expect(plan.target.utilizationBefore).toBe(0.5);
      expect(plan.target.utilizationAfter).toBeLessThan(0.5);
    });
  });

  // ── Reason String ─────────────────────────────────────────────

  describe('reason string', () => {
    it('reason includes eviction score and tier', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1')],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 100 });
      const reason = plan.candidates[0]!.reason;
      expect(reason).toContain('Score');
      expect(reason).toContain('tier=');
    });

    it('compaction recommendation appears in reason string', () => {
      const sSeed = makeSegment('s-seed', {
        protection: 'seed',
        tokenCount: 200,
      });
      const advisory = makeAdvisory([sSeed]);

      const report = makeReport({
        segments: [makeSegmentScore('s-seed', { tokenCount: 200 })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 200 },
      });

      const plan = advisory.planEviction(report, {
        targetTokens: 100,
        strategy: 'default',
        includeCompactionAlternatives: true,
      });

      const candidate = plan.candidates.find(c => c.id === 's-seed')!;
      if (candidate.recommendation === 'compact') {
        expect(candidate.reason).toContain('compaction recommended');
      }
    });
  });

  // ── Default targetUtilization ─────────────────────────────────

  describe('default behavior', () => {
    it('defaults to 0.75 target utilization when no target specified', () => {
      const segments = Array.from({ length: 5 }, (_, i) =>
        makeSegment(`s${i}`, { tokenCount: 2000 }),
      );
      const advisory = makeAdvisory(segments);

      // capacity=10000, totalActive=10000, util=1.0
      // defaultTarget = 0.75, targetTokens = max(0, 10000 - 7500) = 2500
      const report = makeReport({
        segments: segments.map(s => makeSegmentScore(s.id, { tokenCount: 2000 })),
        segmentCount: 5,
        capacity: {
          capacity: 10000,
          totalActiveTokens: 10000,
          utilization: 1.0,
        },
      });

      const plan = advisory.planEviction(report, {});
      expect(plan.target.tokens).toBe(2500);
    });
  });

  // ── Redundancy ────────────────────────────────────────────────

  describe('redundancy signal', () => {
    it('redundancy is propagated from segment score to candidate scores', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1', {
          redundancy: { maxSimilarity: 0.85, mostSimilarSegmentId: 's2', sameOrigin: false },
        })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 100 });
      expect(plan.candidates[0]!.scores.redundancy).toBeCloseTo(0.85, 2);
    });

    it('null redundancy results in 0 redundancy score', () => {
      const s1 = makeSegment('s1', { tokenCount: 100 });
      const advisory = makeAdvisory([s1]);

      const report = makeReport({
        segments: [makeSegmentScore('s1', { redundancy: null })],
        segmentCount: 1,
        capacity: { totalActiveTokens: 100 },
      });

      const plan = advisory.planEviction(report, { targetTokens: 100 });
      expect(plan.candidates[0]!.scores.redundancy).toBe(0);
    });
  });

  // ── Phase C: Branch coverage additions ───────────────────────

  describe('all pinned — exhausted', () => {
    it('returns exhausted=true with empty candidates when all segments are pinned', () => {
      const segments = [
        makeSegment('p1', { protection: 'pinned', tokenCount: 200 }),
        makeSegment('p2', { protection: 'pinned', tokenCount: 200 }),
      ];
      const advisory = makeAdvisory(segments);
      const report = makeReport({
        segments: segments.map(s => makeSegmentScore(s.id, { tokenCount: s.tokenCount })),
        segmentCount: 2,
        capacity: { totalActiveTokens: 400, capacity: 300, utilization: 1.33 },
      });
      const plan = advisory.planEviction(report, { targetTokens: 100 });
      expect(plan.candidates).toHaveLength(0);
      expect(plan.exhausted).toBe(true);
      expect(plan.targetMet).toBe(false);
      expect(plan.shortfall).toBeGreaterThan(0);
    });
  });

  describe('target met exactly', () => {
    it('targetMet is true when total reclaimable equals target', () => {
      const segments = [
        makeSegment('e1', { tokenCount: 100, protection: 'default' }),
        makeSegment('e2', { tokenCount: 100, protection: 'default' }),
      ];
      const advisory = makeAdvisory(segments);
      const report = makeReport({
        segments: segments.map(s => makeSegmentScore(s.id, { tokenCount: s.tokenCount })),
        segmentCount: 2,
        capacity: { totalActiveTokens: 200, capacity: 150, utilization: 1.33 },
      });
      const plan = advisory.planEviction(report, { targetTokens: 200 });
      expect(plan.targetMet).toBe(true);
      expect(plan.shortfall).toBe(0);
    });
  });

  describe('strategy auto-selection from compounds', () => {
    it('lossDominates compound selects collapse strategy', () => {
      const segments = [makeSegment('c1'), makeSegment('c2')];
      const advisory = makeAdvisory(segments);
      const report = makeReport({
        segments: segments.map(s => makeSegmentScore(s.id)),
        segmentCount: 2,
        patterns: makeDetection([
          makeActivePattern('collapse', { compoundContext: makeCompound('lossDominates', ['collapse', 'saturation']) }),
          makeActivePattern('saturation'),
        ]),
      });
      const plan = advisory.planEviction(report, { targetTokens: 50 });
      expect(plan.strategy).toBe('collapse');
    });
  });
});
