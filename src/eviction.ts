/**
 * Eviction advisory — 5-signal ranking, protection tiers, strategies,
 * auto-selection, group handling, bridge score, compaction, plan assembly.
 * @see cl-spec-008
 */

import type {
  QualityReport,
  EvictionPlan,
  EvictionCandidate,
  CandidateScores,
  CandidateImpact,
  CompactionRecommendation,
  ProjectedQualityImpact,
  Segment,
  Group,
  SegmentScore,
  StrategyName,
  CustomPatternMeta,
  ProtectionLevel,
} from './types.js';
import type { SegmentStore } from './segment-store.js';
import type { SimilarityEngine } from './similarity.js';
import { ValidationError } from './errors.js';
import { fnv1a } from './utils/hash.js';
import { computeComposite } from './scoring/composite.js';

// ─── Constants ────────────────────────────────────────────────────

const SCHEMA_VERSION = '1.0.0';
const DEFAULT_TARGET_UTILIZATION = 0.75;
const MAX_CANDIDATES_DEFAULT = 50;
const COMPRESSION_RATIO = 0.5;
const MIN_SAVINGS_RATIO = 0.20;
const SCORE_BAND_THRESHOLD = 0.05;
const SCORE_PRECISION = 4;
const GAP_COHERENCE_CAP = 0.3;
const COLLAPSE_CONTINUITY_FLOOR = 0.3;
const GROUP_OVERSHOOT_FACTOR = 2.0;
const LOW_COHERENCE_THRESHOLD = 0.3;
const HIGH_REDUNDANCY = 0.8;
const MODERATE_REDUNDANCY_LO = 0.5;
const MODERATE_REDUNDANCY_HI = 0.8;

// ─── Strategy Weights ─────────────────────────────────────────────

interface SignalWeights {
  relevance: number;
  density: number;
  coherence: number;
  importance: number;
  age: number;
}

const STRATEGY_WEIGHTS: Record<string, SignalWeights> = {
  default:    { relevance: 0.30, density: 0.25, coherence: 0.20, importance: 0.15, age: 0.10 },
  saturation: { relevance: 0.20, density: 0.30, coherence: 0.15, importance: 0.15, age: 0.20 },
  erosion:    { relevance: 0.20, density: 0.40, coherence: 0.15, importance: 0.15, age: 0.10 },
  gap:        { relevance: 0.45, density: 0.20, coherence: 0.10, importance: 0.15, age: 0.10 },
  collapse:   { relevance: 0.25, density: 0.25, coherence: 0.25, importance: 0.15, age: 0.10 },
};

// Compound → strategy mapping for auto-selection
const COMPOUND_STRATEGY: Record<string, StrategyName> = {
  fullOfJunk: 'erosion',
  fullOfWrongThings: 'gap',
  scatteredAndIrrelevant: 'gap',
  lossDominates: 'collapse',
  pressureLoop: 'collapse',
  triplePressure: 'gap',
};

// Base pattern → strategy mapping
const PATTERN_STRATEGY: Record<string, StrategyName> = {
  collapse: 'collapse',
  saturation: 'saturation',
  gap: 'gap',
  erosion: 'erosion',
  fracture: 'default',
};

// Base pattern priority (same as detection module)
const BASE_PRIORITIES: Record<string, number> = {
  collapse: 1, saturation: 2, gap: 3, erosion: 4, fracture: 5,
};

// ─── Public Interface ─────────────────────────────────────────────

export interface PlanOptions {
  targetTokens?: number;
  targetUtilization?: number;
  strategy?: StrategyName;
  maxCandidates?: number;
  includeCompactionAlternatives?: boolean;
}

export interface EvictionDependencies {
  store: SegmentStore;
  similarity: SimilarityEngine;
}

// ─── Internal Types ───────────────────────────────────────────────

interface InternalCandidate {
  id: string;
  type: 'segment' | 'group';
  segmentIds: string[];         // For groups: all member IDs; for segments: [id]
  tokenCount: number;
  tierRank: number;
  tier: string;
  importance: number;
  relevance: number;
  density: number;
  bridgeScore: number;
  ageRetention: number;
  evictionScore: number;
  createdAt: number;
  origin: string | null;
  memberIds: string[] | null;
  groupCoherence: number | null; // For dissolution hint
  redundancy: number;
}

// ─── Tier Helpers ─────────────────────────────────────────────────

function tierRank(protection: ProtectionLevel): number {
  if (protection === 'pinned') return Infinity;
  if (protection === 'seed') return 1001;
  if (protection === 'default') return 0;
  const match = protection.match(/^priority\((\d+)\)$/);
  if (match) return 1 + parseInt(match[1]!, 10);
  return 0;
}

function tierLabel(protection: ProtectionLevel): string {
  if (protection === 'seed') return 'seed';
  if (protection === 'default') return 'default';
  const match = protection.match(/^priority\((\d+)\)$/);
  if (match) return `priority(${match[1]})`;
  return 'default';
}

/** Effective protection = max of group-level and strongest member-level. */
function effectiveProtection(group: Group, members: Segment[]): ProtectionLevel {
  let best = group.protection;
  let bestRank = tierRank(best);
  for (const m of members) {
    const r = tierRank(m.protection);
    if (r > bestRank) {
      bestRank = r;
      best = m.protection;
    }
  }
  return best;
}

// ─── Strategy Resolution ──────────────────────────────────────────

function resolveStrategy(
  report: QualityReport,
  requested: StrategyName | undefined,
  customMeta: CustomPatternMeta[],
): StrategyName {
  if (requested !== undefined && requested !== 'auto') return requested;

  const detection = report.patterns;
  if (detection.patternCount === 0) return 'default';

  // Phase 2: Check compound patterns among active patterns
  // Find the compound with the most participating patterns; tie-break by highest-priority participant
  let bestCompound: string | null = null;
  let bestCount = 0;
  let bestPriority = Infinity;

  for (const ap of detection.patterns) {
    if (ap.compoundContext !== null) {
      const compound = ap.compoundContext.compound;
      const count = ap.compoundContext.coPatterns.length;
      const prio = BASE_PRIORITIES[ap.name] ?? 1000;

      if (count > bestCount || (count === bestCount && prio < bestPriority)) {
        bestCompound = compound;
        bestCount = count;
        bestPriority = prio;
      }
    }
  }

  if (bestCompound !== null && bestCompound in COMPOUND_STRATEGY) {
    return COMPOUND_STRATEGY[bestCompound]!;
  }

  // Phase 3: Select by highest-priority active pattern
  let highestPrio = Infinity;
  let strategy: StrategyName = 'default';

  for (const ap of detection.patterns) {
    const prio = BASE_PRIORITIES[ap.name] ?? getCustomPriority(ap.name, customMeta);
    if (prio < highestPrio) {
      highestPrio = prio;
      if (ap.name in PATTERN_STRATEGY) {
        strategy = PATTERN_STRATEGY[ap.name]!;
      } else {
        // Custom pattern: use strategyHint
        const meta = customMeta.find(m => m.name === ap.name);
        strategy = resolveCustomHint(meta?.strategyHint ?? null);
      }
    }
  }

  return strategy;
}

function getCustomPriority(name: string, customMeta: CustomPatternMeta[]): number {
  const meta = customMeta.find(m => m.name === name);
  return meta?.priority ?? 1000;
}

function resolveCustomHint(hint: string | null): StrategyName {
  if (hint === 'saturation') return 'saturation';
  if (hint === 'erosion') return 'erosion';
  if (hint === 'gap') return 'gap';
  if (hint === 'collapse') return 'collapse';
  return 'default';
}

// ─── Bridge Score ─────────────────────────────────────────────────

function computeBridgeScores(
  orderedSegments: Segment[],
  similarity: SimilarityEngine,
): Map<string, number> {
  const scores = new Map<string, number>();
  const n = orderedSegments.length;

  if (n === 0) return scores;

  // Precompute hashes
  const hashes = new Map<string, number>();
  for (const seg of orderedSegments) {
    hashes.set(seg.id, fnv1a(seg.content));
  }

  // First and last get 0
  scores.set(orderedSegments[0]!.id, 0);
  if (n > 1) scores.set(orderedSegments[n - 1]!.id, 0);

  // Interior segments
  for (let i = 1; i < n - 1; i++) {
    const prev = orderedSegments[i - 1]!;
    const curr = orderedSegments[i]!;
    const next = orderedSegments[i + 1]!;

    const leftSim = similarity.computeSimilarity(
      hashes.get(prev.id)!, prev.content,
      hashes.get(curr.id)!, curr.content,
    );
    const rightSim = similarity.computeSimilarity(
      hashes.get(curr.id)!, curr.content,
      hashes.get(next.id)!, next.content,
    );
    const skipSim = similarity.computeSimilarity(
      hashes.get(prev.id)!, prev.content,
      hashes.get(next.id)!, next.content,
    );

    const avgNeighborSim = (leftSim + rightSim) / 2;
    scores.set(curr.id, Math.max(0, Math.min(1, avgNeighborSim - skipSim)));
  }

  return scores;
}

/** For contiguous groups: use boundary segments' bridge score. */
function computeGroupBridgeScore(
  _group: Group,
  members: Segment[],
  orderedIds: string[],
  bridgeScores: Map<string, number>,
  similarity: SimilarityEngine,
  segmentMap: Map<string, Segment>,
): number {
  if (members.length === 0) return 0;

  // Check contiguity
  const positions = members.map(m => orderedIds.indexOf(m.id)).sort((a, b) => a - b);
  const contiguous = positions.every((pos, i) =>
    i === 0 || pos === positions[i - 1]! + 1,
  );

  if (!contiguous) {
    // Non-contiguous: max of member bridge scores
    let max = 0;
    for (const m of members) {
      max = Math.max(max, bridgeScores.get(m.id) ?? 0);
    }
    return max;
  }

  // Contiguous: single-segment formula on boundary segments
  const firstPos = positions[0]!;
  const lastPos = positions[positions.length - 1]!;

  // If group spans first or last position, bridge score is 0
  if (firstPos === 0 || lastPos === orderedIds.length - 1) return 0;

  const prevId = orderedIds[firstPos - 1]!;
  const nextId = orderedIds[lastPos + 1]!;
  const prevSeg = segmentMap.get(prevId)!;
  const nextSeg = segmentMap.get(nextId)!;
  const firstSeg = segmentMap.get(orderedIds[firstPos]!)!;
  const lastSeg = segmentMap.get(orderedIds[lastPos]!)!;

  const leftSim = similarity.computeSimilarity(
    fnv1a(prevSeg.content), prevSeg.content,
    fnv1a(firstSeg.content), firstSeg.content,
  );
  const rightSim = similarity.computeSimilarity(
    fnv1a(lastSeg.content), lastSeg.content,
    fnv1a(nextSeg.content), nextSeg.content,
  );
  const skipSim = similarity.computeSimilarity(
    fnv1a(prevSeg.content), prevSeg.content,
    fnv1a(nextSeg.content), nextSeg.content,
  );

  const avgNeighborSim = (leftSim + rightSim) / 2;
  return Math.max(0, Math.min(1, avgNeighborSim - skipSim));
}

// ─── Eviction Score ───────────────────────────────────────────────

function computeEvictionScore(
  relevance: number,
  density: number,
  bridgeScore: number,
  importance: number,
  ageRetention: number,
  weights: SignalWeights,
): number {
  return (
    weights.relevance * relevance +
    weights.density * density +
    weights.coherence * bridgeScore +
    weights.importance * importance +
    weights.age * ageRetention
  );
}

function roundScore(score: number): number {
  const factor = Math.pow(10, SCORE_PRECISION);
  return Math.round(score * factor) / factor;
}

// ─── Tie-Breaking ─────────────────────────────────────────────────

/** Deterministic tie-breaking cascade (cl-spec-008 §2.5). */
function compareCandidates(a: InternalCandidate, b: InternalCandidate): number {
  // Primary: tier rank ascending
  if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  // Secondary: eviction score ascending (lower = better candidate)
  const scoreA = roundScore(a.evictionScore);
  const scoreB = roundScore(b.evictionScore);
  if (scoreA !== scoreB) return scoreA - scoreB;
  // Tie-breaking cascade:
  // 1. Importance ascending
  if (a.importance !== b.importance) return a.importance - b.importance;
  // 2. Relevance ascending
  if (a.relevance !== b.relevance) return a.relevance - b.relevance;
  // 3. Token count descending (prefer larger)
  if (a.tokenCount !== b.tokenCount) return b.tokenCount - a.tokenCount;
  // 4. Creation timestamp ascending (older first)
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  // 5. ID lexicographic ascending
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ─── Impact Estimation ────────────────────────────────────────────

function estimateCandidateImpact(
  candidate: InternalCandidate,
  report: QualityReport,
): CandidateImpact {
  const totalTokens = report.capacity.totalActiveTokens;
  const n = report.segmentCount;
  if (totalTokens === 0 || n === 0) {
    return { coherenceDelta: 0, densityDelta: 0, relevanceDelta: 0, continuityDelta: 0, compositeDelta: 0 };
  }

  const tokenFrac = candidate.tokenCount / totalTokens;

  // Coherence delta: approximate based on bridge score
  // Removing a high-bridge segment hurts coherence proportionally
  const coherenceDelta = -candidate.bridgeScore * tokenFrac;

  // Density delta: removing a low-density segment improves density
  // Removing a high-density (unique) segment doesn't help
  const densityDelta = (1 - candidate.density) * tokenFrac;

  // Relevance delta: removing a relevant segment hurts; removing irrelevant helps
  const avgRelevance = report.windowScores.relevance ?? 0.5;
  const relevanceDelta = candidate.relevance < avgRelevance
    ? tokenFrac * (avgRelevance - candidate.relevance) / Math.max(1, n)
    : -tokenFrac * (candidate.relevance - avgRelevance) / Math.max(1, n);

  // Continuity delta: exact from eviction cost formula (cl-spec-002 §6.2)
  const continuityDelta = -(candidate.relevance * candidate.importance * tokenFrac);

  // Composite delta: approximate from dimension deltas
  const ws = report.windowScores;
  const projectedCoherence = Math.max(0, (ws.coherence ?? 0.5) + coherenceDelta);
  const projectedDensity = Math.min(1, Math.max(0, (ws.density ?? 0.5) + densityDelta));
  const projectedRelevance = Math.max(0, (ws.relevance ?? 0.5) + relevanceDelta);
  const projectedContinuity = Math.max(0, (ws.continuity ?? 0.5) + continuityDelta);
  const projectedComposite = computeComposite(projectedCoherence, projectedDensity, projectedRelevance, projectedContinuity) ?? 0;
  const currentComposite = report.composite ?? 0;
  const compositeDelta = projectedComposite - currentComposite;

  return { coherenceDelta, densityDelta, relevanceDelta, continuityDelta, compositeDelta };
}

function estimatePlanImpact(
  candidates: InternalCandidate[],
  report: QualityReport,
): ProjectedQualityImpact {
  const ws = report.windowScores;
  let coherence = ws.coherence ?? 0.5;
  let density = ws.density ?? 0.5;
  let relevance = ws.relevance ?? 0.5;
  let continuity = ws.continuity ?? 0.5;

  const totalTokens = report.capacity.totalActiveTokens;
  const n = report.segmentCount;

  for (const c of candidates) {
    if (totalTokens === 0 || n === 0) break;
    const tokenFrac = c.tokenCount / totalTokens;
    coherence = Math.max(0, coherence - c.bridgeScore * tokenFrac);
    density = Math.min(1, Math.max(0, density + (1 - c.density) * tokenFrac));
    const avgRel = relevance;
    relevance = Math.max(0, c.relevance < avgRel
      ? relevance + tokenFrac * (avgRel - c.relevance) / Math.max(1, n)
      : relevance - tokenFrac * (c.relevance - avgRel) / Math.max(1, n));
    continuity = Math.max(0, continuity - c.relevance * c.importance * tokenFrac);
  }

  const composite = computeComposite(coherence, density, relevance, continuity) ?? 0;
  return { coherence, density, relevance, continuity, composite };
}

// ─── Compaction ───────────────────────────────────────────────────

function shouldRecommendCompaction(
  candidate: InternalCandidate,
  strategy: StrategyName,
  includeCompaction: boolean,
): boolean {
  if (!includeCompaction) return false;

  // Already compacted
  if (candidate.origin === 'summary:compacted') return false;

  const savings = Math.ceil(candidate.tokenCount * COMPRESSION_RATIO);
  const savingsRatio = savings / candidate.tokenCount;
  if (savingsRatio < MIN_SAVINGS_RATIO) return false;

  // Strategy-specific biases
  switch (strategy) {
    case 'saturation':
      // Eviction bias — prefer certain reclamation
      return false;
    case 'collapse':
      // Compaction bias — minimize loss
      return true;
    case 'erosion':
      // Compaction for moderate redundancy
      return candidate.redundancy >= MODERATE_REDUNDANCY_LO && candidate.redundancy < MODERATE_REDUNDANCY_HI;
    default:
      // Seed segments always get compaction recommendation if not already compacted
      return candidate.tier === 'seed';
  }
}

function buildCompactionRecommendation(
  segmentId: string,
  tokenCount: number,
  importance: number,
  redundancy: number,
): CompactionRecommendation {
  const estimatedTargetTokens = Math.ceil(tokenCount * COMPRESSION_RATIO);
  const estimatedSavings = tokenCount - estimatedTargetTokens;
  const compressionRatio = estimatedTargetTokens / tokenCount;
  const continuityCost = (1 - compressionRatio) * importance * (1 - redundancy);

  return {
    segmentId,
    currentTokens: tokenCount,
    estimatedTargetTokens,
    estimatedSavings,
    compressionRatio,
    continuityCost,
    reason: `Compact to ~${estimatedTargetTokens} tokens (save ~${estimatedSavings}), continuity cost ${continuityCost.toFixed(3)}`,
  };
}

function buildGroupCompactionRecommendations(
  candidate: InternalCandidate,
  segmentScoreMap: Map<string, SegmentScore>,
  segmentMap: Map<string, Segment>,
): CompactionRecommendation[] {
  const recs: CompactionRecommendation[] = [];
  for (const sid of candidate.segmentIds) {
    const seg = segmentMap.get(sid);
    if (!seg) continue;
    if (seg.origin === 'summary:compacted') continue;
    const ss = segmentScoreMap.get(sid);
    const redundancy = ss?.redundancy?.maxSimilarity ?? 0;
    recs.push(buildCompactionRecommendation(sid, seg.tokenCount, seg.importance, redundancy));
  }
  return recs;
}

// ─── Reason Builder ───────────────────────────────────────────────

function buildReason(
  candidate: InternalCandidate,
  strategy: StrategyName,
  recommendation: 'evict' | 'compact',
): string {
  const parts: string[] = [];
  parts.push(`Score ${candidate.evictionScore.toFixed(4)}`);
  parts.push(`tier=${candidate.tier}`);

  if (recommendation === 'compact') {
    parts.push('compaction recommended');
  }

  if (strategy === 'gap' && candidate.relevance < GAP_COHERENCE_CAP) {
    parts.push('low relevance (coherence contribution capped)');
  }
  if (strategy === 'erosion' && candidate.redundancy > HIGH_REDUNDANCY) {
    parts.push('near-duplicate');
  }
  if (strategy === 'collapse') {
    const evCost = candidate.relevance * candidate.importance * 0.01; // approximate
    parts.push(`eviction cost ~${evCost.toFixed(3)}`);
  }

  if (candidate.type === 'group' && candidate.groupCoherence !== null && candidate.groupCoherence < LOW_COHERENCE_THRESHOLD) {
    parts.push(`low internal coherence (${candidate.groupCoherence.toFixed(2)}) — consider dissolving`);
  }

  return parts.join('; ');
}

// ─── EvictionAdvisory ─────────────────────────────────────────────

export class EvictionAdvisory {
  private planCounter = 0;

  constructor(private readonly deps: EvictionDependencies) {}

  planEviction(
    report: QualityReport,
    options?: PlanOptions,
    customPatternMeta?: CustomPatternMeta[],
  ): EvictionPlan {
    const opts = options ?? {};
    const maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES_DEFAULT;
    const includeCompaction = opts.includeCompactionAlternatives ?? true;

    // ── Validate options ────────────────────────────────────────
    if (opts.targetTokens !== undefined && opts.targetUtilization !== undefined) {
      throw new ValidationError('targetTokens and targetUtilization are mutually exclusive');
    }
    if (opts.targetTokens !== undefined && opts.targetTokens <= 0) {
      throw new ValidationError('targetTokens must be positive', { targetTokens: opts.targetTokens });
    }
    if (opts.targetUtilization !== undefined) {
      if (opts.targetUtilization < 0 || opts.targetUtilization >= 1) {
        throw new ValidationError('targetUtilization must be in [0.0, 1.0)', { targetUtilization: opts.targetUtilization });
      }
    }
    if (maxCandidates <= 0 || !Number.isInteger(maxCandidates)) {
      throw new ValidationError('maxCandidates must be a positive integer', { maxCandidates });
    }

    // ── Plan metadata ───────────────────────────────────────────
    const timestamp = report.timestamp;
    const planId = `plan-${++this.planCounter}-${fnv1a(timestamp.toString()).toString(36)}`;

    // ── Resolve strategy ────────────────────────────────────────
    const strategy = resolveStrategy(report, opts.strategy, customPatternMeta ?? []);

    // ── Compute reclamation target ──────────────────────────────
    const cap = report.capacity;
    let targetTokens: number;
    if (opts.targetTokens !== undefined) {
      targetTokens = opts.targetTokens;
    } else {
      const targetUtil = opts.targetUtilization ?? DEFAULT_TARGET_UTILIZATION;
      targetTokens = Math.max(0, cap.totalActiveTokens - Math.floor(cap.capacity * targetUtil));
    }

    // ── Empty or zero-target fast path ──────────────────────────
    if (report.segmentCount === 0 || targetTokens <= 0) {
      return this.emptyPlan(planId, timestamp, strategy, cap, report, targetTokens);
    }

    // ── Gather segments and build maps ──────────────────────────
    const store = this.deps.store;
    const orderedSegments = store.getOrderedActiveSegments();
    const orderedIds = orderedSegments.map(s => s.id);
    const segmentMap = new Map<string, Segment>();
    for (const s of orderedSegments) segmentMap.set(s.id, s);

    const segmentScoreMap = new Map<string, SegmentScore>();
    for (const ss of report.segments) segmentScoreMap.set(ss.segmentId, ss);

    // ── Compute bridge scores ───────────────────────────────────
    const bridgeScores = computeBridgeScores(orderedSegments, this.deps.similarity);

    // ── Compute max age for age retention ───────────────────────
    let maxAge = 0;
    for (const seg of orderedSegments) {
      const age = timestamp - Math.max(seg.createdAt, seg.updatedAt);
      if (age > maxAge) maxAge = age;
    }
    if (maxAge === 0) maxAge = 1; // Avoid division by zero

    // ── Build candidates ────────────────────────────────────────
    const weights = STRATEGY_WEIGHTS[strategy] ?? STRATEGY_WEIGHTS['default']!;
    const groupedSegmentIds = new Set<string>();
    const candidates: InternalCandidate[] = [];
    const groups = store.listGroups().filter(g => g.state === 'active');

    // Process groups first
    for (const group of groups) {
      const members = group.members
        .map(id => segmentMap.get(id))
        .filter((s): s is Segment => s !== undefined && s.state === 'active');

      if (members.length === 0) continue;

      const protection = effectiveProtection(group, members);
      if (protection === 'pinned') continue;

      for (const m of members) groupedSegmentIds.add(m.id);

      // Token-weighted mean of member scores
      let totalTokens = 0;
      let wRel = 0, wDen = 0, wBridge = 0, wImp = 0, wAge = 0, wRedundancy = 0;
      let earliestCreated = Infinity;

      for (const m of members) {
        const ss = segmentScoreMap.get(m.id);
        const rel = ss?.relevance ?? 1;
        const den = ss?.density ?? 1;
        const bridge = bridgeScores.get(m.id) ?? 0;
        const imp = m.importance;
        const age = timestamp - Math.max(m.createdAt, m.updatedAt);
        const ageRet = 1 - (age / maxAge);
        const red = ss?.redundancy?.maxSimilarity ?? 0;

        wRel += rel * m.tokenCount;
        wDen += den * m.tokenCount;
        wBridge += bridge * m.tokenCount;
        wImp += imp * m.tokenCount;
        wAge += ageRet * m.tokenCount;
        wRedundancy += red * m.tokenCount;
        totalTokens += m.tokenCount;
        if (m.createdAt < earliestCreated) earliestCreated = m.createdAt;
      }

      if (totalTokens === 0) continue;

      const avgRel = wRel / totalTokens;
      const avgDen = wDen / totalTokens;
      const groupBridge = computeGroupBridgeScore(
        group, members, orderedIds, bridgeScores, this.deps.similarity, segmentMap,
      );
      const avgImp = wImp / totalTokens;
      const avgAge = wAge / totalTokens;
      const avgRedundancy = wRedundancy / totalTokens;

      let coherenceForScore = groupBridge;
      if (strategy === 'gap' && avgRel < GAP_COHERENCE_CAP) {
        coherenceForScore = Math.min(coherenceForScore, GAP_COHERENCE_CAP);
      }

      const score = computeEvictionScore(avgRel, avgDen, coherenceForScore, avgImp, avgAge, weights);

      candidates.push({
        id: group.groupId,
        type: 'group',
        segmentIds: members.map(m => m.id),
        tokenCount: totalTokens,
        tierRank: tierRank(protection),
        tier: tierLabel(protection),
        importance: group.importance,
        relevance: avgRel,
        density: avgDen,
        bridgeScore: groupBridge,
        ageRetention: avgAge,
        evictionScore: score,
        createdAt: earliestCreated,
        origin: group.origin,
        memberIds: members.map(m => m.id),
        groupCoherence: group.coherence,
        redundancy: avgRedundancy,
      });
    }

    // Process individual (ungrouped) segments
    for (const seg of orderedSegments) {
      if (groupedSegmentIds.has(seg.id)) continue;
      if (seg.protection === 'pinned') continue;

      const ss = segmentScoreMap.get(seg.id);
      const rel = ss?.relevance ?? 1;
      const den = ss?.density ?? 1;
      const bridge = bridgeScores.get(seg.id) ?? 0;
      const imp = seg.importance;
      const age = timestamp - Math.max(seg.createdAt, seg.updatedAt);
      const ageRet = 1 - (age / maxAge);
      const redundancy = ss?.redundancy?.maxSimilarity ?? 0;

      let coherenceForScore = bridge;
      if (strategy === 'gap' && rel < GAP_COHERENCE_CAP) {
        coherenceForScore = Math.min(coherenceForScore, GAP_COHERENCE_CAP);
      }

      const score = computeEvictionScore(rel, den, coherenceForScore, imp, ageRet, weights);

      candidates.push({
        id: seg.id,
        type: 'segment',
        segmentIds: [seg.id],
        tokenCount: seg.tokenCount,
        tierRank: tierRank(seg.protection),
        tier: tierLabel(seg.protection),
        importance: seg.importance,
        relevance: rel,
        density: den,
        bridgeScore: bridge,
        ageRetention: ageRet,
        evictionScore: score,
        createdAt: seg.createdAt,
        origin: seg.origin,
        memberIds: null,
        groupCoherence: null,
        redundancy,
      });
    }

    // ── Saturation tie-breaking: token-size within 0.05 bands ───
    if (strategy === 'saturation') {
      candidates.sort((a, b) => {
        if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
        const sA = roundScore(a.evictionScore);
        const sB = roundScore(b.evictionScore);
        if (Math.abs(sA - sB) <= SCORE_BAND_THRESHOLD) {
          // Within band: prefer higher token count
          if (a.tokenCount !== b.tokenCount) return b.tokenCount - a.tokenCount;
        }
        return compareCandidates(a, b);
      });
    } else {
      candidates.sort(compareCandidates);
    }

    // ── Collapse continuity floor guard ─────────────────────────
    let cumulativeContinuityLoss = 0;
    const currentContinuity = report.windowScores.continuity ?? 1;
    const excludedByFloor = new Set<string>();

    if (strategy === 'collapse') {
      for (const c of candidates) {
        const tokenFrac = report.capacity.totalActiveTokens > 0
          ? c.tokenCount / report.capacity.totalActiveTokens : 0;
        const evCost = c.relevance * c.importance * tokenFrac;
        if (currentContinuity - cumulativeContinuityLoss - evCost < COLLAPSE_CONTINUITY_FLOOR) {
          excludedByFloor.add(c.id);
        } else {
          cumulativeContinuityLoss += evCost;
        }
      }
    }

    // ── Walk candidates and accumulate ──────────────────────────
    let reclaimedTokens = 0;
    let seedsIncluded = false;
    const includedCandidates: InternalCandidate[] = [];

    for (const c of candidates) {
      if (reclaimedTokens >= targetTokens) break;
      if (includedCandidates.length >= maxCandidates) break;
      if (excludedByFloor.has(c.id)) continue;

      // Group overshoot deferral
      if (c.type === 'group') {
        const remaining = targetTokens - reclaimedTokens;
        if (c.tokenCount > remaining * GROUP_OVERSHOOT_FACTOR) {
          // Check if enough non-group candidates in same tier can meet target
          const sameNonGroup = candidates.filter(x =>
            x.type === 'segment' &&
            x.tierRank === c.tierRank &&
            !excludedByFloor.has(x.id) &&
            !includedCandidates.some(inc => inc.id === x.id),
          );
          const sameNonGroupTokens = sameNonGroup.reduce((sum, x) => sum + x.tokenCount, 0);
          if (sameNonGroupTokens >= remaining) continue; // defer group
        }
      }

      includedCandidates.push(c);
      reclaimedTokens += c.tokenCount;
      if (c.tier === 'seed') seedsIncluded = true;
    }

    // ── Build output candidates ─────────────────────────────────
    let cumTokens = 0;
    const outputCandidates: EvictionCandidate[] = [];

    for (const c of includedCandidates) {
      cumTokens += c.tokenCount;

      const scores: CandidateScores = {
        relevance: c.relevance,
        density: c.density,
        coherenceContribution: c.bridgeScore,
        redundancy: c.redundancy,
      };

      const impact = estimateCandidateImpact(c, report);

      const recommendation: 'evict' | 'compact' =
        shouldRecommendCompaction(c, strategy, includeCompaction)
          ? 'compact'
          : 'evict';

      let compaction: CompactionRecommendation | CompactionRecommendation[] | null = null;
      if (recommendation === 'compact') {
        if (c.type === 'group') {
          const recs = buildGroupCompactionRecommendations(c, segmentScoreMap, segmentMap);
          compaction = recs.length > 0 ? recs : null;
          // If all members already compacted, revert to eviction
          if (recs.length === 0) {
            // compaction stays null, recommendation already defaulted
          }
        } else {
          compaction = buildCompactionRecommendation(c.id, c.tokenCount, c.importance, c.redundancy);
        }
      }

      const finalRecommendation = (recommendation === 'compact' && compaction === null) ? 'evict' : recommendation;
      const reason = buildReason(c, strategy, finalRecommendation);

      outputCandidates.push({
        id: c.id,
        type: c.type,
        tokenCount: c.tokenCount,
        cumulativeTokens: cumTokens,
        evictionScore: roundScore(c.evictionScore),
        tier: c.tier,
        importance: c.importance,
        scores,
        impact,
        recommendation: finalRecommendation,
        compaction: finalRecommendation === 'compact' ? compaction : null,
        memberIds: c.memberIds,
        reason,
      });
    }

    // ── Plan-level quality impact ───────────────────────────────
    const qualityImpact = estimatePlanImpact(includedCandidates, report);

    // ── Assemble plan ───────────────────────────────────────────
    const utilizationAfter = cap.capacity > 0
      ? Math.max(0, (cap.totalActiveTokens - reclaimedTokens) / cap.capacity)
      : 0;

    const targetMet = reclaimedTokens >= targetTokens;
    const exhausted = includedCandidates.length === candidates.filter(c => !excludedByFloor.has(c.id)).length;

    return {
      schemaVersion: SCHEMA_VERSION,
      planId,
      timestamp,
      strategy,
      target: {
        tokens: targetTokens,
        utilizationBefore: cap.utilization,
        utilizationAfter,
      },
      candidates: outputCandidates,
      candidateCount: outputCandidates.length,
      totalReclaimable: reclaimedTokens,
      targetMet,
      shortfall: targetMet ? 0 : targetTokens - reclaimedTokens,
      seedsIncluded,
      exhausted,
      qualityImpact,
      patterns: report.patterns.patterns.map(p => p.name),
      reportId: report.reportId,
    };
  }

  // ── Empty Plan Helper ───────────────────────────────────────────

  private emptyPlan(
    planId: string,
    timestamp: number,
    strategy: StrategyName,
    cap: QualityReport['capacity'],
    report: QualityReport,
    targetTokens: number,
  ): EvictionPlan {
    const ws = report.windowScores;
    return {
      schemaVersion: SCHEMA_VERSION,
      planId,
      timestamp,
      strategy,
      target: {
        tokens: Math.max(0, targetTokens),
        utilizationBefore: cap.utilization,
        utilizationAfter: cap.utilization,
      },
      candidates: [],
      candidateCount: 0,
      totalReclaimable: 0,
      targetMet: targetTokens <= 0,
      shortfall: Math.max(0, targetTokens),
      seedsIncluded: false,
      exhausted: true,
      qualityImpact: {
        coherence: ws.coherence ?? 0,
        density: ws.density ?? 0,
        relevance: ws.relevance ?? 0,
        continuity: ws.continuity ?? 0,
        composite: report.composite ?? 0,
      },
      patterns: report.patterns.patterns.map(p => p.name),
      reportId: report.reportId,
    };
  }
}
