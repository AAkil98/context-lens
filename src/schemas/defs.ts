/**
 * Shared JSON Schema type definitions for context-lens output types.
 * Each definition maps to a reconciled type from types.ts.
 * @see cl-spec-011 §6
 */

// ── Helpers ──────────────────────────────────────────────────────

type S = Record<string, unknown>;

function nullable(schema: S): S {
  return { oneOf: [schema, { type: 'null' }] };
}

function ref(name: string): S {
  return { $ref: `#/$defs/${name}` };
}

function obj(properties: Record<string, S>, required: string[]): S {
  return { type: 'object', properties, required, additionalProperties: true };
}

const str: S = { type: 'string' };
const num: S = { type: 'number' };
const int: S = { type: 'integer' };
const bool: S = { type: 'boolean' };
const score: S = { type: 'number', minimum: 0, maximum: 1 };

function arr(items: S): S {
  return { type: 'array', items };
}

function strEnum(...values: string[]): S {
  return { type: 'string', enum: values };
}

// ── Enum Definitions ─────────────────────────────────────────────
// @see cl-spec-011 §7

export const SEVERITY_ENUM = ['watch', 'warning', 'critical'] as const;
export const PATTERN_NAME_ENUM = ['saturation', 'erosion', 'fracture', 'gap', 'collapse'] as const;
export const TREND_ENUM = ['worsening', 'stable', 'improving'] as const;
export const TREND_DIRECTION_ENUM = ['improving', 'stable', 'degrading'] as const;
export const STRATEGY_NAME_ENUM = ['auto', 'default', 'saturation', 'erosion', 'gap', 'collapse'] as const;
export const COMPOUND_NAME_ENUM = ['fullOfJunk', 'fullOfWrongThings', 'scatteredAndIrrelevant', 'lossDominates', 'pressureLoop', 'triplePressure'] as const;
export const REMEDIATION_ACTION_ENUM = ['evict', 'compact', 'deduplicate', 'reorder', 'restore', 'updateTask', 'increaseCapacity', 'slowEviction', 'restart', 'dissolve'] as const;
export const TASK_LIFECYCLE_ENUM = ['unset', 'active'] as const;
export const TRANSITION_TYPE_ENUM = ['new', 'refinement', 'change', 'same', 'clear'] as const;
export const EMBEDDING_MODE_ENUM = ['embeddings', 'trigrams'] as const;

export const TIMELINE_EVENT_TYPE_ENUM = [
  'segmentAdded', 'segmentUpdated', 'segmentReplaced', 'segmentCompacted',
  'segmentSplit', 'segmentEvicted', 'segmentRestored',
  'groupCreated', 'groupDissolved',
  'taskSet', 'taskCleared',
  'baselineCaptured', 'reportGenerated',
  'patternActivated', 'patternEscalated', 'patternDeescalated', 'patternResolved',
  'tokenizerChanged', 'embeddingProviderChanged', 'capacityChanged',
  'budgetViolation', 'customPatternRegistered',
  'stateSnapshotted', 'stateRestored',
  'lateSeeding', 'pinnedCeilingWarning',
] as const;

// ── Shared $defs ─────────────────────────────────────────────────

/** All shared type definitions keyed by name. */
export function allDefs(): Record<string, S> {
  return {
    // ── Quality Types ──────────────────────────────────────────
    WindowScores: obj({
      coherence: nullable(score),
      density: nullable(score),
      relevance: nullable(score),
      continuity: nullable(score),
    }, ['coherence', 'density', 'relevance', 'continuity']),

    BaselineSnapshot: obj({
      coherence: score,
      density: score,
      relevance: score,
      continuity: score,
      capturedAt: num,
      segmentCount: { type: 'integer', minimum: 1 },
      tokenCount: { type: 'integer', minimum: 1 },
    }, ['coherence', 'density', 'relevance', 'continuity', 'capturedAt', 'segmentCount', 'tokenCount']),

    SegmentScore: obj({
      segmentId: str,
      coherence: score,
      density: score,
      relevance: score,
      continuity: score,
      composite: score,
      tokenCount: { type: 'integer', minimum: 0 },
      redundancy: nullable(ref('RedundancyInfo')),
      groupId: nullable(str),
    }, ['segmentId', 'coherence', 'density', 'relevance', 'continuity', 'composite', 'tokenCount', 'redundancy', 'groupId']),

    RedundancyInfo: obj({
      maxSimilarity: score,
      mostSimilarSegmentId: str,
      sameOrigin: bool,
    }, ['maxSimilarity', 'mostSimilarSegmentId', 'sameOrigin']),

    GroupScore: obj({
      groupId: str,
      memberCount: { type: 'integer', minimum: 1 },
      totalTokens: { type: 'integer', minimum: 0 },
      groupCoherence: score,
      meanRelevance: score,
      meanDensity: score,
      composite: score,
      integrityWarning: bool,
    }, ['groupId', 'memberCount', 'totalTokens', 'groupCoherence', 'meanRelevance', 'meanDensity', 'composite', 'integrityWarning']),

    ContinuitySummary: obj({
      totalEvictions: { type: 'integer', minimum: 0 },
      totalCompactions: { type: 'integer', minimum: 0 },
      totalRestorations: { type: 'integer', minimum: 0 },
      netLoss: score,
      tokensEvicted: { type: 'integer', minimum: 0 },
      tokensCompacted: { type: 'integer', minimum: 0 },
      tokensRestored: { type: 'integer', minimum: 0 },
      recentEvents: arr(ref('ContinuityEvent')),
    }, ['totalEvictions', 'totalCompactions', 'totalRestorations', 'netLoss', 'tokensEvicted', 'tokensCompacted', 'tokensRestored', 'recentEvents']),

    ContinuityEvent: obj({
      type: strEnum('eviction', 'compaction', 'restoration'),
      segmentId: str,
      timestamp: num,
      tokensBefore: { type: 'integer', minimum: 0 },
      tokensAfter: { type: 'integer', minimum: 0 },
      cost: score,
      fidelity: nullable(score),
    }, ['type', 'segmentId', 'timestamp', 'tokensBefore', 'tokensAfter', 'cost', 'fidelity']),

    TrendData: obj({
      previousReportId: str,
      timeDelta: num,
      coherenceDelta: num,
      densityDelta: num,
      relevanceDelta: num,
      continuityDelta: num,
      compositeDelta: num,
      segmentCountDelta: int,
      tokensDelta: int,
    }, ['previousReportId', 'timeDelta', 'coherenceDelta', 'densityDelta', 'relevanceDelta', 'continuityDelta', 'compositeDelta', 'segmentCountDelta', 'tokensDelta']),

    // ── Capacity Types ─────────────────────────────────────────
    CapacityReport: obj({
      capacity: { type: 'integer', minimum: 1 },
      totalActiveTokens: { type: 'integer', minimum: 0 },
      utilization: { type: 'number', minimum: 0 },
      headroom: int,
      pinnedTokens: { type: 'integer', minimum: 0 },
      seedTokens: { type: 'integer', minimum: 0 },
      managedTokens: { type: 'integer', minimum: 0 },
      availableCapacity: { type: 'integer', minimum: 0 },
    }, ['capacity', 'totalActiveTokens', 'utilization', 'headroom', 'pinnedTokens', 'seedTokens', 'managedTokens', 'availableCapacity']),

    TokenizerMetadata: obj({
      name: str,
      accuracy: strEnum('exact', 'approximate'),
      modelFamily: nullable(str),
      errorBound: nullable(num),
    }, ['name', 'accuracy', 'modelFamily', 'errorBound']),

    // ── Detection Types ────────────────────────────────────────
    DetectionResult: obj({
      patterns: arr(ref('ActivePattern')),
      patternCount: { type: 'integer', minimum: 0 },
      highestSeverity: nullable(strEnum(...SEVERITY_ENUM)),
      preBaseline: bool,
    }, ['patterns', 'patternCount', 'highestSeverity', 'preBaseline']),

    ActivePattern: obj({
      name: str, // PatternName — string (allows custom names)
      severity: strEnum(...SEVERITY_ENUM),
      activatedAt: num,
      currentSince: num,
      duration: { type: 'number', minimum: 0 },
      trending: strEnum(...TREND_ENUM),
      signature: ref('PatternSignature'),
      explanation: str,
      remediation: arr(ref('RemediationHint')),
      compoundContext: nullable(ref('CompoundContext')),
    }, ['name', 'severity', 'activatedAt', 'currentSince', 'duration', 'trending', 'signature', 'explanation', 'remediation', 'compoundContext']),

    PatternSignature: obj({
      primaryScore: ref('ScoreRef'),
      secondaryScores: arr(ref('ScoreRef')),
      utilization: nullable(num),
      thresholdCrossed: ref('ThresholdRef'),
    }, ['primaryScore', 'secondaryScores', 'utilization', 'thresholdCrossed']),

    ScoreRef: obj({
      dimension: str,
      value: num,
    }, ['dimension', 'value']),

    ThresholdRef: obj({
      severity: strEnum(...SEVERITY_ENUM),
      threshold: num,
    }, ['severity', 'threshold']),

    RemediationHint: obj({
      action: strEnum(...REMEDIATION_ACTION_ENUM),
      target: nullable(str),
      estimatedImpact: nullable(str),
      description: str,
    }, ['action', 'target', 'estimatedImpact', 'description']),

    CompoundContext: obj({
      compound: strEnum(...COMPOUND_NAME_ENUM),
      coPatterns: { type: 'array', items: str, minItems: 1 },
      diagnosis: str,
      remediationShift: str,
    }, ['compound', 'coPatterns', 'diagnosis', 'remediationShift']),

    // ── Task Types ─────────────────────────────────────────────
    TaskSummary: obj({
      state: strEnum(...TASK_LIFECYCLE_ENUM),
      stale: bool,
      gracePeriodActive: bool,
      gracePeriodRemaining: int,
    }, ['state', 'stale', 'gracePeriodActive', 'gracePeriodRemaining']),

    TaskDescriptor: obj({
      description: str,
      keywords: arr(str),
      relatedOrigins: arr(str),
      relatedTags: arr(str),
    }, ['description', 'keywords', 'relatedOrigins', 'relatedTags']),

    TaskTransition: obj({
      type: strEnum(...TRANSITION_TYPE_ENUM),
      similarity: nullable(num),
      previousTask: nullable(ref('TaskDescriptor')),
    }, ['type', 'similarity', 'previousTask']),

    TransitionEntry: obj({
      type: strEnum('new', 'refinement', 'change', 'clear'),
      timestamp: num,
      similarity: nullable(num),
      previousDescription: nullable(str),
      newDescription: nullable(str),
    }, ['type', 'timestamp', 'similarity', 'previousDescription', 'newDescription']),

    TaskState: obj({
      state: strEnum(...TASK_LIFECYCLE_ENUM),
      currentTask: nullable(ref('TaskDescriptor')),
      previousTask: nullable(ref('TaskDescriptor')),
      taskSetAt: nullable(num),
      transitionCount: { type: 'integer', minimum: 0 },
      changeCount: { type: 'integer', minimum: 0 },
      refinementCount: { type: 'integer', minimum: 0 },
      reportsSinceSet: { type: 'integer', minimum: 0 },
      reportsSinceTransition: { type: 'integer', minimum: 0 },
      lastTransition: nullable(ref('TaskTransition')),
      stale: bool,
      gracePeriodActive: bool,
      gracePeriodRemaining: int,
      transitionHistory: arr(ref('TransitionEntry')),
    }, ['state', 'currentTask', 'previousTask', 'taskSetAt', 'transitionCount', 'changeCount', 'refinementCount', 'reportsSinceSet', 'reportsSinceTransition', 'lastTransition', 'stale', 'gracePeriodActive', 'gracePeriodRemaining', 'transitionHistory']),

    // ── Eviction Types ─────────────────────────────────────────
    PlanTarget: obj({
      tokens: { type: 'integer', minimum: 0 },
      utilizationBefore: { type: 'number', minimum: 0 },
      utilizationAfter: { type: 'number', minimum: 0 },
    }, ['tokens', 'utilizationBefore', 'utilizationAfter']),

    EvictionCandidate: obj({
      id: str,
      type: strEnum('segment', 'group'),
      tokenCount: { type: 'integer', minimum: 0 },
      cumulativeTokens: { type: 'integer', minimum: 0 },
      evictionScore: score,
      tier: str,
      importance: score,
      scores: ref('CandidateScores'),
      impact: ref('CandidateImpact'),
      recommendation: strEnum('evict', 'compact'),
      compaction: {
        oneOf: [
          ref('CompactionRecommendation'),
          arr(ref('CompactionRecommendation')),
          { type: 'null' },
        ],
      },
      memberIds: nullable(arr(str)),
      reason: str,
    }, ['id', 'type', 'tokenCount', 'cumulativeTokens', 'evictionScore', 'tier', 'importance', 'scores', 'impact', 'recommendation', 'compaction', 'memberIds', 'reason']),

    CandidateScores: obj({
      relevance: score,
      density: score,
      coherenceContribution: score,
      redundancy: score,
    }, ['relevance', 'density', 'coherenceContribution', 'redundancy']),

    CandidateImpact: obj({
      coherenceDelta: num,
      densityDelta: num,
      relevanceDelta: num,
      continuityDelta: num,
      compositeDelta: num,
    }, ['coherenceDelta', 'densityDelta', 'relevanceDelta', 'continuityDelta', 'compositeDelta']),

    ProjectedQualityImpact: obj({
      coherence: score,
      density: score,
      relevance: score,
      continuity: score,
      composite: score,
    }, ['coherence', 'density', 'relevance', 'continuity', 'composite']),

    CompactionRecommendation: obj({
      segmentId: str,
      currentTokens: { type: 'integer', minimum: 1 },
      estimatedTargetTokens: { type: 'integer', minimum: 1 },
      estimatedSavings: { type: 'integer', minimum: 1 },
      compressionRatio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      continuityCost: score,
      reason: str,
    }, ['segmentId', 'currentTokens', 'estimatedTargetTokens', 'estimatedSavings', 'compressionRatio', 'continuityCost', 'reason']),

    // ── Diagnostic Types ───────────────────────────────────────
    ReportHistorySummary: obj({
      reports: arr(ref('ReportSummary')),
      rollingTrend: nullable(ref('RollingTrend')),
    }, ['reports', 'rollingTrend']),

    ReportSummary: obj({
      reportId: str,
      timestamp: num,
      windowScores: ref('WindowScores'),
      composite: nullable(score),
      segmentCount: { type: 'integer', minimum: 0 },
      totalActiveTokens: { type: 'integer', minimum: 0 },
      utilization: { type: 'number', minimum: 0 },
      patternCount: { type: 'integer', minimum: 0 },
      highestSeverity: nullable(strEnum(...SEVERITY_ENUM)),
      embeddingMode: strEnum(...EMBEDDING_MODE_ENUM),
      anomalies: arr(ref('AnomalyFlag')),
    }, ['reportId', 'timestamp', 'windowScores', 'composite', 'segmentCount', 'totalActiveTokens', 'utilization', 'patternCount', 'highestSeverity', 'embeddingMode', 'anomalies']),

    AnomalyFlag: obj({
      dimension: strEnum('coherence', 'density', 'relevance', 'continuity', 'composite'),
      delta: num,
      likelyCause: nullable(strEnum('taskChange', 'bulkEviction', 'providerSwitch', 'bulkAdd')),
    }, ['dimension', 'delta', 'likelyCause']),

    RollingTrend: obj({
      window: int,
      coherence: ref('TrendLine'),
      density: ref('TrendLine'),
      relevance: ref('TrendLine'),
      continuity: ref('TrendLine'),
      composite: ref('TrendLine'),
    }, ['window', 'coherence', 'density', 'relevance', 'continuity', 'composite']),

    TrendLine: obj({
      direction: strEnum(...TREND_DIRECTION_ENUM),
      averageRate: num,
      current: num,
      windowMin: num,
      windowMax: num,
      volatility: { type: 'number', minimum: 0 },
    }, ['direction', 'averageRate', 'current', 'windowMin', 'windowMax', 'volatility']),

    PatternSummary: obj({
      activePatterns: arr(ref('ActivePattern')),
      totalActivations: { type: 'integer', minimum: 0 },
      totalResolutions: { type: 'integer', minimum: 0 },
      perPattern: { type: 'object', additionalProperties: ref('PatternStats') },
      history: arr(ref('PatternHistoryEntry')),
    }, ['activePatterns', 'totalActivations', 'totalResolutions', 'perPattern', 'history']),

    PatternStats: obj({
      activationCount: { type: 'integer', minimum: 0 },
      totalActiveTime: { type: 'number', minimum: 0 },
      peakSeverity: strEnum(...SEVERITY_ENUM),
      currentState: strEnum('active', 'inactive'),
      currentSeverity: nullable(strEnum(...SEVERITY_ENUM)),
      lastActivation: nullable(num),
      lastResolution: nullable(num),
      recurrenceCount: { type: 'integer', minimum: 0 },
    }, ['activationCount', 'totalActiveTime', 'peakSeverity', 'currentState', 'currentSeverity', 'lastActivation', 'lastResolution', 'recurrenceCount']),

    PatternHistoryEntry: obj({
      name: str,
      event: strEnum('activated', 'escalated', 'deescalated', 'resolved'),
      severity: strEnum(...SEVERITY_ENUM),
      timestamp: num,
      reportId: str,
      score: num,
      compoundContext: nullable(str),
    }, ['name', 'event', 'severity', 'timestamp', 'reportId', 'score', 'compoundContext']),

    TimelineEntry: obj({
      timestamp: num,
      sequence: { type: 'integer', minimum: 0 },
      type: str, // Open string — 26 known values, custom events possible
      detail: { type: 'object', additionalProperties: true },
    }, ['timestamp', 'sequence', 'type', 'detail']),

    PerformanceSummary: obj({
      operationTimings: { type: 'object', additionalProperties: ref('OperationTimingStats') },
      caches: ref('CacheReport'),
      sessionSelfTime: { type: 'number', minimum: 0 },
      sessionProviderTime: { type: 'number', minimum: 0 },
      budgetViolationCount: { type: 'integer', minimum: 0 },
    }, ['operationTimings', 'caches', 'sessionSelfTime', 'sessionProviderTime', 'budgetViolationCount']),

    OperationTimingStats: obj({
      count: { type: 'integer', minimum: 0 },
      totalSelfTime: { type: 'number', minimum: 0 },
      totalProviderTime: { type: 'number', minimum: 0 },
      averageSelfTime: { type: 'number', minimum: 0 },
      maxSelfTime: { type: 'number', minimum: 0 },
      p95SelfTime: { type: 'number', minimum: 0 },
      budgetTarget: { type: 'number', minimum: 0 },
      budgetViolations: { type: 'integer', minimum: 0 },
      withinBudgetRate: score,
    }, ['count', 'totalSelfTime', 'totalProviderTime', 'averageSelfTime', 'maxSelfTime', 'p95SelfTime', 'budgetTarget', 'budgetViolations', 'withinBudgetRate']),

    CacheReport: obj({
      tokenCache: ref('CacheMetrics'),
      embeddingCache: ref('CacheMetrics'),
      similarityCache: ref('CacheMetrics'),
    }, ['tokenCache', 'embeddingCache', 'similarityCache']),

    CacheMetrics: obj({
      hits: { type: 'integer', minimum: 0 },
      misses: { type: 'integer', minimum: 0 },
      hitRate: nullable(score),
      currentEntries: { type: 'integer', minimum: 0 },
      maxEntries: { type: 'integer', minimum: 0 },
      utilization: { type: 'number', minimum: 0 },
      evictions: { type: 'integer', minimum: 0 },
    }, ['hits', 'misses', 'hitRate', 'currentEntries', 'maxEntries', 'utilization', 'evictions']),

    ProviderSummary: obj({
      tokenizer: ref('TokenizerMetadata'),
      embedding: nullable(ref('EmbeddingProviderMetadata')),
    }, ['tokenizer', 'embedding']),

    EmbeddingProviderMetadata: obj({
      name: str,
      dimensions: { type: 'integer', minimum: 1 },
      modelFamily: nullable(str),
      maxInputTokens: nullable(int),
    }, ['name', 'dimensions', 'modelFamily', 'maxInputTokens']),

    Warning: obj({
      code: str,
      message: str,
      timestamp: num,
    }, ['code', 'message', 'timestamp']),
  };
}

/**
 * Returns a subset of $defs by name.
 * Follows $ref chains to include transitive dependencies.
 */
export function pickDefs(names: string[]): Record<string, S> {
  const all = allDefs();
  const result: Record<string, S> = {};
  const queue = [...names];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const name = queue.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const def = all[name];
    if (def === undefined) continue;
    result[name] = def;

    // Scan for $ref dependencies
    const json = JSON.stringify(def);
    const refPattern = /"\$ref":"#\/\$defs\/([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = refPattern.exec(json)) !== null) {
      if (!visited.has(match[1]!)) {
        queue.push(match[1]!);
      }
    }
  }
  return result;
}
