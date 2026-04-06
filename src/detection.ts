/**
 * Detection framework — 5 base patterns, hysteresis, compounds, custom patterns,
 * suppression, threshold configuration, pattern history.
 * @see cl-spec-003
 */

import type {
  QualityReport,
  DetectionResult,
  ActivePattern,
  PatternSignature,
  RemediationHint,
  CompoundContext,
  PatternDefinition,
  Severity,
  PatternName,
  CompoundName,
  TrendDirection,
  RemediationAction,
} from './types.js';
import { ValidationError } from './errors.js';
import { RingBuffer } from './utils/ring-buffer.js';
import { deepCopy } from './utils/copy.js';

// ─── Constants ────────────────────────────────────────────────────

const BASE_PATTERN_NAMES = ['saturation', 'erosion', 'fracture', 'gap', 'collapse'] as const;
const SEVERITY_ORDER: Record<Severity, number> = { watch: 1, warning: 2, critical: 3 };
const BASE_PRIORITIES: Record<string, number> = {
  collapse: 1, saturation: 2, gap: 3, erosion: 4, fracture: 5,
};
const SCORE_HISTORY_CAPACITY = 20;
const RATE_THRESHOLD = -0.15;
const COLLAPSE_RATE_THRESHOLD = -0.10;
const ACUTE_COLLAPSE_THRESHOLD = 0.15;

// ─── Default Thresholds ───────────────────────────────────────────

interface ScoreThresholds { watch: number; warning: number; critical: number }
interface ErosionThresholds { density: ScoreThresholds; utilization: ScoreThresholds }
interface GapThresholds { relevance: ScoreThresholds; utilization: { warning: number; critical: number } }

interface AllThresholds {
  saturation: ScoreThresholds;
  erosion: ErosionThresholds;
  fracture: ScoreThresholds;
  gap: GapThresholds;
  collapse: ScoreThresholds;
}

const DEFAULT_THRESHOLDS: AllThresholds = {
  saturation: { watch: 0.75, warning: 0.85, critical: 0.95 },
  erosion: {
    density: { watch: 0.7, warning: 0.5, critical: 0.3 },
    utilization: { watch: 0.7, warning: 0.8, critical: 0.9 },
  },
  fracture: { watch: 0.6, warning: 0.4, critical: 0.2 },
  gap: {
    relevance: { watch: 0.6, warning: 0.4, critical: 0.3 },
    utilization: { warning: 0.6, critical: 0.8 },
  },
  collapse: { watch: 0.7, warning: 0.5, critical: 0.3 },
};

// ─── Per-Pattern Tracking State ───────────────────────────────────

interface TrackingState {
  active: boolean;
  severity: Severity | null;
  activatedAt: number | null;
  severitySince: number | null;
  peakSeverity: Severity | null;
  peakAt: number | null;
  reportCount: number;
  scoreHistory: RingBuffer<{ reportId: string; score: number }>;
  resolvedAt: number | null;
  consecutiveNulls: number;
}

function freshTrackingState(): TrackingState {
  return {
    active: false,
    severity: null,
    activatedAt: null,
    severitySince: null,
    peakSeverity: null,
    peakAt: null,
    reportCount: 0,
    scoreHistory: new RingBuffer(SCORE_HISTORY_CAPACITY),
    resolvedAt: null,
    consecutiveNulls: 0,
  };
}

// ─── Hysteresis Helpers ───────────────────────────────────────────

function severityRank(s: Severity): number {
  return SEVERITY_ORDER[s];
}

function elevateSeverity(s: Severity): Severity {
  if (s === 'watch') return 'warning';
  if (s === 'warning') return 'critical';
  return 'critical';
}

/** Score-based hysteresis: lower score = worse. */
function resolveScoreSeverity(
  score: number,
  prev: Severity | null,
  th: ScoreThresholds,
  margin: number,
): Severity | null {
  let raw: Severity | null = null;
  if (score < th.critical) raw = 'critical';
  else if (score < th.warning) raw = 'warning';
  else if (score < th.watch) raw = 'watch';

  if (prev === null) return raw;
  if (raw !== null) {
    if (severityRank(raw) >= severityRank(prev)) return raw;
    const prevTh = prev === 'critical' ? th.critical : prev === 'warning' ? th.warning : th.watch;
    if (score > prevTh + margin) return raw;
    return prev;
  }
  if (score > th.watch + margin) return null;
  return 'watch';
}

/** Utilization-based hysteresis: higher util = worse. */
function resolveUtilSeverity(
  util: number,
  prev: Severity | null,
  th: ScoreThresholds,
  margin: number,
): Severity | null {
  let raw: Severity | null = null;
  if (util > th.critical) raw = 'critical';
  else if (util > th.warning) raw = 'warning';
  else if (util > th.watch) raw = 'watch';

  if (prev === null) return raw;
  if (raw !== null) {
    if (severityRank(raw) >= severityRank(prev)) return raw;
    const prevTh = prev === 'critical' ? th.critical : prev === 'warning' ? th.warning : th.watch;
    if (util < prevTh - margin) return raw;
    return prev;
  }
  if (util < th.watch - margin) return null;
  return 'watch';
}

function computeTrending(history: RingBuffer<{ reportId: string; score: number }>): TrendDirection {
  if (history.size < 3) return 'stable';
  const recent = history.toArray().slice(-3);
  const d1 = recent[1]!.score - recent[0]!.score;
  const d2 = recent[2]!.score - recent[1]!.score;
  if (d1 < -0.03 && d2 < -0.03) return 'worsening';
  if (d1 > 0.03 && d2 > 0.03) return 'improving';
  return 'stable';
}

// ─── Base Pattern Evaluators ──────────────────────────────────────

interface PatternEval {
  severity: Severity | null;
  primaryScore: number;
  primaryDimension: string;
  secondaryScores: { dimension: string; value: number }[];
  utilization: number | null;
}

function evalSaturation(report: QualityReport, th: ScoreThresholds, prev: Severity | null, margin: number): PatternEval {
  const util = report.capacity.utilization;
  let severity = resolveUtilSeverity(util, prev, th, margin);

  // Rate-based early watch
  if (severity === null && report.trend !== null) {
    const projected = util + (report.trend.tokensDelta / Math.max(1, report.capacity.capacity)) * 3;
    if (projected > th.watch && util <= th.watch) severity = 'watch';
  }

  return {
    severity,
    primaryScore: util,
    primaryDimension: 'utilization',
    secondaryScores: [
      { dimension: 'headroom', value: report.capacity.headroom },
      { dimension: 'totalActiveTokens', value: report.capacity.totalActiveTokens },
    ],
    utilization: util,
  };
}

function evalErosion(report: QualityReport, th: ErosionThresholds, prev: Severity | null, margin: number): PatternEval {
  const density = report.windowScores.density ?? 1;
  const util = report.capacity.utilization;

  // Both gates must be open
  const densitySev = resolveScoreSeverity(density, prev, th.density, margin);
  const utilSev = resolveUtilSeverity(util, prev, th.utilization, margin);

  let severity: Severity | null = null;
  if (densitySev !== null && utilSev !== null) {
    // Take the minimum (both must be at least that level)
    severity = severityRank(densitySev) <= severityRank(utilSev) ? densitySev : utilSev;
  } else if (prev !== null) {
    // Check if either gate closed with margin
    if (densitySev === null && utilSev === null) severity = null;
    else if (densitySev !== null && utilSev !== null) {
      severity = severityRank(densitySev) <= severityRank(utilSev) ? densitySev : utilSev;
    }
    // If only one gate is open, check if the other just closed (margin)
    // For simplicity, both gates must be open to remain active
  }

  // Rate-based density elevation
  if (severity !== null && report.trend !== null && report.trend.densityDelta < RATE_THRESHOLD) {
    severity = elevateSeverity(severity);
  }

  return {
    severity,
    primaryScore: density,
    primaryDimension: 'density',
    secondaryScores: [{ dimension: 'utilization', value: util }],
    utilization: util,
  };
}

function evalFracture(report: QualityReport, th: ScoreThresholds, prev: Severity | null, margin: number): PatternEval {
  const coherence = report.windowScores.coherence ?? 1;
  let severity = resolveScoreSeverity(coherence, prev, th, margin);

  // Secondary cluster-count trigger (elevate only, not activate)
  if (severity !== null && report.segmentCount > 0) {
    const topicalConc = report.rawScores.coherence ?? 1;
    if (topicalConc > 0) {
      const clusterCount = Math.round(1.0 / topicalConc);
      const clusterRatio = clusterCount / report.segmentCount;
      if (clusterRatio > 0.5) severity = elevateSeverity(severity);
    }
  }

  // Rate-based elevation
  if (severity !== null && report.trend !== null && report.trend.coherenceDelta < RATE_THRESHOLD) {
    severity = elevateSeverity(severity);
  }

  return {
    severity,
    primaryScore: coherence,
    primaryDimension: 'coherence',
    secondaryScores: [],
    utilization: report.capacity.utilization,
  };
}

function evalGap(
  report: QualityReport,
  th: GapThresholds,
  prev: Severity | null,
  margin: number,
  taskActive: boolean,
  graceActive: boolean,
): PatternEval {
  // Hard prerequisite: task must be set
  if (!taskActive) {
    return { severity: null, primaryScore: 1, primaryDimension: 'relevance', secondaryScores: [], utilization: null };
  }

  const relevance = report.windowScores.relevance ?? 1;
  const util = report.capacity.utilization;

  // Evaluate severity with compound thresholds
  let severity: Severity | null = null;
  if (relevance < th.relevance.critical && util > th.utilization.critical) severity = 'critical';
  else if (relevance < th.relevance.warning && util > th.utilization.warning) severity = 'warning';
  else if (relevance < th.relevance.watch) severity = 'watch';

  // Apply hysteresis for deactivation
  if (severity === null && prev !== null) {
    if (relevance < th.relevance.watch + margin) severity = 'watch';
  }

  // Grace period cap
  if (graceActive && severity !== null && severityRank(severity) > severityRank('watch')) {
    severity = 'watch';
  }

  // Rate-based elevation (suppressed during grace)
  if (!graceActive && severity !== null && report.trend !== null && report.trend.relevanceDelta < RATE_THRESHOLD) {
    severity = elevateSeverity(severity);
  }

  return {
    severity,
    primaryScore: relevance,
    primaryDimension: 'relevance',
    secondaryScores: [{ dimension: 'utilization', value: util }],
    utilization: util,
  };
}

function evalCollapse(report: QualityReport, th: ScoreThresholds, prev: Severity | null, margin: number): PatternEval {
  const continuity = report.windowScores.continuity ?? 1;
  let severity = resolveScoreSeverity(continuity, prev, th, margin);

  // Rate-based elevation (stricter threshold)
  if (severity !== null && report.trend !== null && report.trend.continuityDelta < COLLAPSE_RATE_THRESHOLD) {
    severity = elevateSeverity(severity);
  }

  // Acute collapse trigger
  if (severity === null || severity === 'watch') {
    for (const event of report.continuity.recentEvents) {
      if (event.type === 'eviction' && event.cost > ACUTE_COLLAPSE_THRESHOLD) {
        severity = severity === null ? 'warning' : elevateSeverity(severity);
        break;
      }
    }
  }

  return {
    severity,
    primaryScore: continuity,
    primaryDimension: 'continuity',
    secondaryScores: [],
    utilization: report.capacity.utilization,
  };
}

// ─── Compounds ────────────────────────────────────────────────────

interface CompoundDef {
  name: CompoundName;
  requires: string[];
  diagnosis: string;
  remediationShift: string;
}

const COMPOUND_DEFS: CompoundDef[] = [
  { name: 'fullOfJunk', requires: ['saturation', 'erosion'], diagnosis: 'Window is full of redundant content', remediationShift: 'Prioritize deduplication over generic eviction' },
  { name: 'fullOfWrongThings', requires: ['saturation', 'gap'], diagnosis: 'Window is full but irrelevant to current task', remediationShift: 'Prioritize relevance-based eviction' },
  { name: 'scatteredAndIrrelevant', requires: ['fracture', 'gap'], diagnosis: 'Content is both disorganized and irrelevant', remediationShift: 'Consider task update or major context restructuring' },
  { name: 'lossDominates', requires: ['collapse'], diagnosis: 'Information loss from evictions dominates quality', remediationShift: 'Slow eviction rate, consider restoration' },
  { name: 'pressureLoop', requires: ['collapse', 'saturation'], diagnosis: 'Evicting to relieve pressure causes quality collapse', remediationShift: 'Increase capacity or compact rather than evict' },
  { name: 'triplePressure', requires: ['saturation', 'erosion', 'gap'], diagnosis: 'Full, redundant, and irrelevant — severe quality crisis', remediationShift: 'Aggressive deduplication + relevance-focused eviction' },
];

function detectCompounds(activeNames: Set<string>): Map<string, CompoundContext> {
  const result = new Map<string, CompoundContext>();

  for (const def of COMPOUND_DEFS) {
    if (def.requires.every(r => activeNames.has(r))) {
      const ctx: CompoundContext = {
        compound: def.name,
        coPatterns: def.requires.filter(r => activeNames.has(r)) as PatternName[],
        diagnosis: def.diagnosis,
        remediationShift: def.remediationShift,
      };
      for (const r of def.requires) {
        // Each participating pattern gets the compound context
        // If multiple compounds match, later ones overwrite (triplePressure > individual)
        result.set(r, ctx);
      }
    }
  }
  return result;
}

// ─── Remediation Helpers ──────────────────────────────────────────

function buildRemediation(patternName: string, severity: Severity): RemediationHint[] {
  const hints: RemediationHint[] = [];
  const sev = severity;

  switch (patternName) {
    case 'saturation':
      hints.push({ action: 'evict' as RemediationAction, target: 'default-tier segments', estimatedImpact: null, description: 'Evict low-value default segments to reduce utilization' });
      if (sev !== 'watch') hints.push({ action: 'compact' as RemediationAction, target: 'seed segments', estimatedImpact: null, description: 'Compact seed segments to reclaim tokens' });
      hints.push({ action: 'increaseCapacity' as RemediationAction, target: null, estimatedImpact: null, description: 'Increase token capacity if possible' });
      break;
    case 'erosion':
      hints.push({ action: 'deduplicate' as RemediationAction, target: 'high-redundancy segments', estimatedImpact: null, description: 'Remove or merge redundant content' });
      hints.push({ action: 'compact' as RemediationAction, target: 'overlapping segments', estimatedImpact: null, description: 'Compact segments with high overlap' });
      break;
    case 'fracture':
      hints.push({ action: 'reorder' as RemediationAction, target: 'low-adjacency segments', estimatedImpact: null, description: 'Reorder segments to improve topical flow' });
      hints.push({ action: 'dissolve' as RemediationAction, target: 'low-integrity groups', estimatedImpact: null, description: 'Dissolve groups with low coherence' });
      break;
    case 'gap':
      hints.push({ action: 'evict' as RemediationAction, target: 'low-relevance segments', estimatedImpact: null, description: 'Evict segments irrelevant to current task' });
      hints.push({ action: 'updateTask' as RemediationAction, target: null, estimatedImpact: null, description: 'Update task descriptor if focus has shifted' });
      break;
    case 'collapse':
      hints.push({ action: 'restore' as RemediationAction, target: 'high-value evicted segments', estimatedImpact: null, description: 'Restore recently evicted high-value segments' });
      hints.push({ action: 'slowEviction' as RemediationAction, target: null, estimatedImpact: null, description: 'Reduce eviction rate to preserve continuity' });
      break;
    default:
      break;
  }
  return hints;
}

function buildExplanation(patternName: string, severity: Severity, primaryScore: number): string {
  const sevStr = severity.toUpperCase();
  switch (patternName) {
    case 'saturation': return `[${sevStr}] Context window utilization at ${(primaryScore * 100).toFixed(0)}%`;
    case 'erosion': return `[${sevStr}] Density degraded to ${(primaryScore * 100).toFixed(0)}% — redundant content accumulating under pressure`;
    case 'fracture': return `[${sevStr}] Coherence at ${(primaryScore * 100).toFixed(0)}% — content is fragmented across topics`;
    case 'gap': return `[${sevStr}] Relevance at ${(primaryScore * 100).toFixed(0)}% — content misaligned with current task`;
    case 'collapse': return `[${sevStr}] Continuity at ${(primaryScore * 100).toFixed(0)}% — information loss from evictions`;
    default: return `[${sevStr}] Pattern ${patternName} active (score: ${primaryScore.toFixed(2)})`;
  }
}

// ─── DetectionEngine ──────────────────────────────────────────────

export interface DetectionConfig {
  thresholds?: Record<string, unknown>;
  suppressedPatterns?: string[];
  hysteresisMargin?: number;
  customPatterns?: PatternDefinition[];
}

export class DetectionEngine {
  private readonly thresholds: AllThresholds;
  private readonly suppressed: Set<string>;
  private readonly margin: number;
  private readonly tracking = new Map<string, TrackingState>();
  private readonly customPatterns: PatternDefinition[] = [];

  constructor(config?: DetectionConfig) {
    this.thresholds = config?.thresholds
      ? mergeThresholds(DEFAULT_THRESHOLDS, config.thresholds)
      : { ...DEFAULT_THRESHOLDS };
    this.suppressed = new Set(config?.suppressedPatterns ?? []);
    this.margin = config?.hysteresisMargin ?? 0.03;

    if (this.margin < 0.01 || this.margin > 0.10) {
      throw new ValidationError('Hysteresis margin must be in [0.01, 0.10]', { margin: this.margin });
    }

    // Register custom patterns from config
    if (config?.customPatterns !== undefined) {
      for (const def of config.customPatterns) {
        this.registerPattern(def);
      }
    }
  }

  registerPattern(def: PatternDefinition): void {
    if (!def.name || def.name.length === 0) {
      throw new ValidationError('Pattern name must be non-empty');
    }
    if ((BASE_PATTERN_NAMES as readonly string[]).includes(def.name)) {
      throw new ValidationError(`Pattern name collides with base pattern: ${def.name}`, { name: def.name });
    }
    if (this.customPatterns.some(p => p.name === def.name)) {
      throw new ValidationError(`Pattern name already registered: ${def.name}`, { name: def.name });
    }

    this.customPatterns.push(def);
  }

  detect(
    report: QualityReport,
    taskState: { isActive: boolean; gracePeriodActive: boolean },
  ): DetectionResult {
    if (report.segmentCount === 0) {
      return { patterns: [], patternCount: 0, highestSeverity: null, preBaseline: report.baseline === null };
    }

    const timestamp = report.timestamp;
    const activePatterns: ActivePattern[] = [];
    const activeNames = new Set<string>();

    // ── Evaluate 5 base patterns ────────────────────────────────

    const baseEvals: { name: string; eval: PatternEval }[] = [
      { name: 'saturation', eval: this.suppressed.has('saturation') ? nullEval('utilization') : evalSaturation(report, this.thresholds.saturation, this.getTrackingSeverity('saturation'), this.margin) },
      { name: 'erosion', eval: this.suppressed.has('erosion') ? nullEval('density') : evalErosion(report, this.thresholds.erosion, this.getTrackingSeverity('erosion'), this.margin) },
      { name: 'fracture', eval: this.suppressed.has('fracture') ? nullEval('coherence') : evalFracture(report, this.thresholds.fracture, this.getTrackingSeverity('fracture'), this.margin) },
      { name: 'gap', eval: this.suppressed.has('gap') ? nullEval('relevance') : evalGap(report, this.thresholds.gap, this.getTrackingSeverity('gap'), this.margin, taskState.isActive, taskState.gracePeriodActive) },
      { name: 'collapse', eval: this.suppressed.has('collapse') ? nullEval('continuity') : evalCollapse(report, this.thresholds.collapse, this.getTrackingSeverity('collapse'), this.margin) },
    ];

    for (const { name, eval: ev } of baseEvals) {
      const state = this.ensureTracking(name);
      state.scoreHistory.push({ reportId: report.reportId, score: ev.primaryScore });

      if (ev.severity !== null) {
        this.activatePattern(state, ev.severity, timestamp);
        activeNames.add(name);

        const sig: PatternSignature = {
          primaryScore: { dimension: ev.primaryDimension, value: ev.primaryScore },
          secondaryScores: ev.secondaryScores,
          utilization: ev.utilization,
          thresholdCrossed: { severity: ev.severity, threshold: getBaseThreshold(name, ev.severity, this.thresholds) },
        };

        activePatterns.push({
          name,
          severity: ev.severity,
          activatedAt: state.activatedAt!,
          currentSince: state.severitySince!,
          duration: timestamp - state.activatedAt!,
          trending: computeTrending(state.scoreHistory),
          signature: sig,
          explanation: buildExplanation(name, ev.severity, ev.primaryScore),
          remediation: buildRemediation(name, ev.severity),
          compoundContext: null,
        });
      } else {
        this.deactivatePattern(state, timestamp);
      }
    }

    // ── Evaluate custom patterns ────────────────────────────────

    for (const def of this.customPatterns) {
      if (this.suppressed.has(def.name)) continue;

      const state = this.ensureTracking(def.name);

      try {
        const reportCopy = deepCopy(report);
        const signal = def.detect(reportCopy);

        if (signal !== null) {
          state.consecutiveNulls = 0;
          const sev = def.severity(reportCopy, state.severity);
          this.activatePattern(state, sev, timestamp);
          activeNames.add(def.name);

          const sig: PatternSignature = {
            primaryScore: signal.primaryScore,
            secondaryScores: signal.secondaryScores,
            utilization: signal.utilization,
            thresholdCrossed: { severity: sev, threshold: 0 },
          };

          activePatterns.push({
            name: def.name,
            severity: sev,
            activatedAt: state.activatedAt!,
            currentSince: state.severitySince!,
            duration: timestamp - state.activatedAt!,
            trending: computeTrending(state.scoreHistory),
            signature: sig,
            explanation: def.explanation(reportCopy),
            remediation: def.remediation(reportCopy),
            compoundContext: null,
          });

          state.scoreHistory.push({ reportId: report.reportId, score: signal.primaryScore.value });
        } else {
          state.consecutiveNulls++;
          // 2-cycle deactivation for custom patterns
          if (state.consecutiveNulls >= 2) {
            this.deactivatePattern(state, timestamp);
          } else if (state.active && state.severity !== null) {
            // Maintain for 1 more cycle
            activeNames.add(def.name);
            activePatterns.push({
              name: def.name,
              severity: state.severity,
              activatedAt: state.activatedAt!,
              currentSince: state.severitySince!,
              duration: timestamp - state.activatedAt!,
              trending: computeTrending(state.scoreHistory),
              signature: { primaryScore: { dimension: 'custom', value: 0 }, secondaryScores: [], utilization: null, thresholdCrossed: { severity: state.severity, threshold: 0 } },
              explanation: `Pattern ${def.name} deactivating (1 cycle remaining)`,
              remediation: [],
              compoundContext: null,
            });
          }
        }
      } catch {
        // Fail-open: catch and swallow, treat as null signal
        state.consecutiveNulls++;
        if (state.consecutiveNulls >= 2) {
          this.deactivatePattern(state, timestamp);
        }
      }
    }

    // ── Compound detection ──────────────────────────────────────

    const compounds = detectCompounds(activeNames);
    for (const ap of activePatterns) {
      const ctx = compounds.get(ap.name as string);
      if (ctx !== undefined) {
        ap.compoundContext = ctx;
      }
    }

    // ── Sort by priority then severity ──────────────────────────

    activePatterns.sort((a, b) => {
      const prioA = this.getPatternPriority(a.name);
      const prioB = this.getPatternPriority(b.name);
      if (prioA !== prioB) return prioA - prioB;
      return severityRank(b.severity) - severityRank(a.severity);
    });

    // ── Result ──────────────────────────────────────────────────

    let highestSeverity: Severity | null = null;
    for (const ap of activePatterns) {
      if (highestSeverity === null || severityRank(ap.severity) > severityRank(highestSeverity)) {
        highestSeverity = ap.severity;
      }
    }

    return {
      patterns: activePatterns,
      patternCount: activePatterns.length,
      highestSeverity,
      preBaseline: report.baseline === null,
    };
  }

  // ── Internal Helpers ──────────────────────────────────────────

  private ensureTracking(name: string): TrackingState {
    let state = this.tracking.get(name);
    if (state === undefined) {
      state = freshTrackingState();
      this.tracking.set(name, state);
    }
    return state;
  }

  private getTrackingSeverity(name: string): Severity | null {
    return this.tracking.get(name)?.severity ?? null;
  }

  private activatePattern(state: TrackingState, severity: Severity, timestamp: number): void {
    if (!state.active) {
      state.active = true;
      state.activatedAt = timestamp;
      state.resolvedAt = null;
      state.reportCount = 0;
    }
    if (state.severity !== severity) {
      state.severitySince = timestamp;
    }
    state.severity = severity;
    state.reportCount++;
    if (state.peakSeverity === null || severityRank(severity) > severityRank(state.peakSeverity)) {
      state.peakSeverity = severity;
      state.peakAt = timestamp;
    }
    state.consecutiveNulls = 0;
  }

  private deactivatePattern(state: TrackingState, timestamp: number): void {
    if (state.active) {
      state.active = false;
      state.resolvedAt = timestamp;
    }
    state.severity = null;
  }

  private getPatternPriority(name: PatternName): number {
    if (name in BASE_PRIORITIES) return BASE_PRIORITIES[name]!;
    const custom = this.customPatterns.find(p => p.name === name);
    return custom?.priority ?? 1000;
  }
}

// ─── Utility Functions ────────────────────────────────────────────

function nullEval(dimension: string): PatternEval {
  return { severity: null, primaryScore: 1, primaryDimension: dimension, secondaryScores: [], utilization: null };
}

function getBaseThreshold(name: string, severity: Severity, th: AllThresholds): number {
  switch (name) {
    case 'saturation': return th.saturation[severity];
    case 'erosion': return th.erosion.density[severity];
    case 'fracture': return th.fracture[severity];
    case 'gap': return th.gap.relevance[severity];
    case 'collapse': return th.collapse[severity];
    default: return 0;
  }
}

function mergeThresholds(defaults: AllThresholds, overrides: Record<string, unknown>): AllThresholds {
  const result = JSON.parse(JSON.stringify(defaults)) as AllThresholds;

  for (const [pattern, value] of Object.entries(overrides)) {
    if (value === null || typeof value !== 'object') continue;
    const override = value as Record<string, unknown>;

    if (pattern === 'saturation' || pattern === 'fracture' || pattern === 'collapse') {
      const target = result[pattern] as ScoreThresholds;
      if (typeof override['watch'] === 'number') target.watch = override['watch'];
      if (typeof override['warning'] === 'number') target.warning = override['warning'];
      if (typeof override['critical'] === 'number') target.critical = override['critical'];
    } else if (pattern === 'erosion') {
      if (typeof override['density'] === 'object' && override['density'] !== null) {
        const d = override['density'] as Record<string, number>;
        if (typeof d['watch'] === 'number') result.erosion.density.watch = d['watch'];
        if (typeof d['warning'] === 'number') result.erosion.density.warning = d['warning'];
        if (typeof d['critical'] === 'number') result.erosion.density.critical = d['critical'];
      }
      if (typeof override['utilization'] === 'object' && override['utilization'] !== null) {
        const u = override['utilization'] as Record<string, number>;
        if (typeof u['watch'] === 'number') result.erosion.utilization.watch = u['watch'];
        if (typeof u['warning'] === 'number') result.erosion.utilization.warning = u['warning'];
        if (typeof u['critical'] === 'number') result.erosion.utilization.critical = u['critical'];
      }
    } else if (pattern === 'gap') {
      if (typeof override['relevance'] === 'object' && override['relevance'] !== null) {
        const r = override['relevance'] as Record<string, number>;
        if (typeof r['watch'] === 'number') result.gap.relevance.watch = r['watch'];
        if (typeof r['warning'] === 'number') result.gap.relevance.warning = r['warning'];
        if (typeof r['critical'] === 'number') result.gap.relevance.critical = r['critical'];
      }
      if (typeof override['utilization'] === 'object' && override['utilization'] !== null) {
        const u = override['utilization'] as Record<string, number>;
        if (typeof u['warning'] === 'number') result.gap.utilization.warning = u['warning'];
        if (typeof u['critical'] === 'number') result.gap.utilization.critical = u['critical'];
      }
    }
  }

  return result;
}
