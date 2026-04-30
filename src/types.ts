/**
 * context-lens — Shared type definitions
 *
 * All reconciled types from the design review, organized by domain.
 * @see cl-spec-001 through cl-spec-014
 */

// ─── Segment Domain ───────────────────────────────────────────────
// @see cl-spec-001

export type ProtectionLevel =
  | 'pinned'
  | 'seed'
  | 'default'
  | `priority(${number})`;

export type SegmentState = 'active' | 'evicted';

export type GroupState = 'active' | 'dissolved';

export interface Segment {
  id: string;
  content: string;
  tokenCount: number;
  createdAt: number;
  updatedAt: number;
  protection: ProtectionLevel;
  importance: number;
  state: SegmentState;
  origin: string | null;
  tags: string[];
  groupId: string | null;
}

export interface Group {
  groupId: string;
  members: string[];
  protection: ProtectionLevel;
  importance: number;
  origin: string | null;
  tags: string[];
  createdAt: number;
  state: GroupState;
  tokenCount: number;
  coherence: number;
}

export interface EvictionRecord {
  segmentId: string;
  tokenCount: number;
  importance: number;
  protection: ProtectionLevel;
  reason: string;
  timestamp: number;
}

export interface CompactionRecord {
  originalTokenCount: number;
  compactedTokenCount: number;
  compressionRatio: number;
  timestamp: number;
}

// ─── Capacity Domain ──────────────────────────────────────────────
// @see cl-spec-006

export interface CapacityReport {
  capacity: number;
  totalActiveTokens: number;
  utilization: number;
  headroom: number;
  pinnedTokens: number;
  seedTokens: number;
  managedTokens: number;
  availableCapacity: number;
}

export interface TokenizerMetadata {
  name: string;
  accuracy: 'exact' | 'approximate';
  modelFamily: string | null;
  errorBound: number | null;
}

// ─── Provider Domain ──────────────────────────────────────────────
// @see cl-spec-005, cl-spec-006

export interface TokenizerProvider {
  count(content: string): number;
  countBatch?(contents: string[]): number[];
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]> | number[];
  embedBatch?(texts: string[]): Promise<number[][]> | number[][];
}

export interface EmbeddingProviderMetadata {
  name: string;
  dimensions: number;
  modelFamily: string | null;
  maxInputTokens: number | null;
}

// ─── Task Domain ──────────────────────────────────────────────────
// @see cl-spec-004

export type TaskLifecycleState = 'unset' | 'active';

export type TransitionType = 'new' | 'refinement' | 'change' | 'same' | 'clear';

export interface TaskDescriptor {
  description: string;
  keywords?: string[];
  relatedOrigins?: string[];
  relatedTags?: string[];
}

export interface TaskTransition {
  type: TransitionType;
  similarity?: number;
  previousTask: TaskDescriptor | null;
}

export interface TransitionEntry {
  type: 'new' | 'refinement' | 'change' | 'clear';
  timestamp: number;
  similarity?: number;
  previousDescription?: string;
  newDescription?: string;
}

export interface TaskState {
  state: TaskLifecycleState;
  currentTask: TaskDescriptor | null;
  previousTask: TaskDescriptor | null;
  taskSetAt: number | null;
  transitionCount: number;
  changeCount: number;
  refinementCount: number;
  reportsSinceSet: number;
  reportsSinceTransition: number;
  lastTransition: TaskTransition | null;
  stale: boolean;
  gracePeriodActive: boolean;
  gracePeriodRemaining: number;
  transitionHistory: TransitionEntry[];
}

export interface TaskSummary {
  state: TaskLifecycleState;
  stale: boolean;
  gracePeriodActive: boolean;
  gracePeriodRemaining: number;
}

// ─── Quality Domain ───────────────────────────────────────────────
// @see cl-spec-002

export interface WindowScores {
  coherence: number | null;
  density: number | null;
  relevance: number | null;
  continuity: number | null;
}

export interface RedundancyInfo {
  maxSimilarity: number;
  mostSimilarSegmentId: string;
  sameOrigin: boolean;
}

export interface SegmentScore {
  segmentId: string;
  coherence: number;
  density: number;
  relevance: number;
  continuity: number;
  composite: number;
  tokenCount: number;
  redundancy: RedundancyInfo | null;
  groupId: string | null;
}

export interface GroupScore {
  groupId: string;
  memberCount: number;
  totalTokens: number;
  groupCoherence: number;
  meanRelevance: number;
  meanDensity: number;
  composite: number;
  integrityWarning: boolean;
}

export interface BaselineSnapshot {
  coherence: number;
  density: number;
  relevance: number;
  continuity: number;
  capturedAt: number;
  segmentCount: number;
  tokenCount: number;
}

export interface ContinuityEvent {
  type: 'eviction' | 'compaction' | 'restoration';
  segmentId: string;
  timestamp: number;
  tokensBefore: number;
  tokensAfter: number;
  cost: number;
  fidelity: number | null;
}

export interface ContinuitySummary {
  totalEvictions: number;
  totalCompactions: number;
  totalRestorations: number;
  netLoss: number;
  tokensEvicted: number;
  tokensCompacted: number;
  tokensRestored: number;
  recentEvents: ContinuityEvent[];
}

export interface TrendData {
  previousReportId: string;
  timeDelta: number;
  coherenceDelta: number;
  densityDelta: number;
  relevanceDelta: number;
  continuityDelta: number;
  compositeDelta: number;
  segmentCountDelta: number;
  tokensDelta: number;
}

/** @see cl-spec-002 §5, cl-spec-011 */
export interface QualityReport {
  schemaVersion: string;
  timestamp: number;
  reportId: string;
  segmentCount: number;
  windowScores: WindowScores;
  rawScores: WindowScores;
  composite: number | null;
  baseline: BaselineSnapshot | null;
  capacity: CapacityReport;
  tokenizer: TokenizerMetadata;
  embeddingMode: 'embeddings' | 'trigrams';
  segments: SegmentScore[];
  groups: GroupScore[];
  continuity: ContinuitySummary;
  trend: TrendData | null;
  patterns: DetectionResult;
  task: TaskSummary;
}

// ─── Detection Domain ─────────────────────────────────────────────
// @see cl-spec-003

export type Severity = 'watch' | 'warning' | 'critical';

export type PatternName =
  | 'saturation'
  | 'erosion'
  | 'fracture'
  | 'gap'
  | 'collapse'
  | (string & {});

export type CompoundName =
  | 'fullOfJunk'
  | 'fullOfWrongThings'
  | 'scatteredAndIrrelevant'
  | 'lossDominates'
  | 'pressureLoop'
  | 'triplePressure';

export type TrendDirection = 'worsening' | 'stable' | 'improving';

export interface PatternSignature {
  primaryScore: { dimension: string; value: number };
  secondaryScores: { dimension: string; value: number }[];
  utilization: number | null;
  thresholdCrossed: { severity: Severity; threshold: number };
}

export interface RemediationHint {
  action: RemediationAction;
  target: string | null;
  estimatedImpact: string | null;
  description: string;
}

export interface CompoundContext {
  compound: CompoundName;
  coPatterns: PatternName[];
  diagnosis: string;
  remediationShift: string;
}

export interface ActivePattern {
  name: PatternName;
  severity: Severity;
  activatedAt: number;
  currentSince: number;
  duration: number;
  trending: TrendDirection;
  signature: PatternSignature;
  explanation: string;
  remediation: RemediationHint[];
  compoundContext: CompoundContext | null;
}

export interface DetectionResult {
  patterns: ActivePattern[];
  patternCount: number;
  highestSeverity: Severity | null;
  preBaseline: boolean;
}

export interface PatternSignal {
  primaryScore: { dimension: string; value: number };
  secondaryScores: { dimension: string; value: number }[];
  utilization: number | null;
}

export interface PatternDefinition {
  name: string;
  description: string;
  detect: (report: QualityReport) => PatternSignal | null;
  severity: (report: QualityReport, previous: Severity | null) => Severity;
  explanation: (report: QualityReport) => string;
  remediation: (report: QualityReport) => RemediationHint[];
  strategyHint?: StrategyName;
  priority?: number;
}

// ─── Eviction Domain ──────────────────────────────────────────────
// @see cl-spec-008

export type StrategyName =
  | 'auto'
  | 'default'
  | 'saturation'
  | 'erosion'
  | 'gap'
  | 'collapse';

export type RemediationAction =
  | 'evict'
  | 'compact'
  | 'deduplicate'
  | 'reorder'
  | 'restore'
  | 'updateTask'
  | 'increaseCapacity'
  | 'slowEviction'
  | 'restart'
  | 'dissolve';

export interface CandidateScores {
  relevance: number;
  density: number;
  coherenceContribution: number;
  redundancy: number;
}

export interface CandidateImpact {
  coherenceDelta: number;
  densityDelta: number;
  relevanceDelta: number;
  continuityDelta: number;
  compositeDelta: number;
}

export interface CompactionRecommendation {
  segmentId: string;
  currentTokens: number;
  estimatedTargetTokens: number;
  estimatedSavings: number;
  compressionRatio: number;
  continuityCost: number;
  reason: string;
}

export interface EvictionCandidate {
  id: string;
  type: 'segment' | 'group';
  tokenCount: number;
  cumulativeTokens: number;
  evictionScore: number;
  tier: string;
  importance: number;
  scores: CandidateScores;
  impact: CandidateImpact;
  recommendation: 'evict' | 'compact';
  compaction: CompactionRecommendation | CompactionRecommendation[] | null;
  memberIds: string[] | null;
  reason: string;
}

export interface PlanTarget {
  tokens: number;
  utilizationBefore: number;
  utilizationAfter: number;
}

export interface ProjectedQualityImpact {
  coherence: number;
  density: number;
  relevance: number;
  continuity: number;
  composite: number;
}

/** @see cl-spec-008, cl-spec-011 */
export interface EvictionPlan {
  schemaVersion: string;
  planId: string;
  timestamp: number;
  strategy: StrategyName;
  target: PlanTarget;
  candidates: EvictionCandidate[];
  candidateCount: number;
  totalReclaimable: number;
  targetMet: boolean;
  shortfall: number;
  seedsIncluded: boolean;
  exhausted: boolean;
  qualityImpact: ProjectedQualityImpact;
  patterns: PatternName[];
  reportId: string;
}

// ─── Diagnostics Domain ───────────────────────────────────────────
// @see cl-spec-010

export type TimelineEventType =
  | 'segmentAdded'
  | 'segmentUpdated'
  | 'segmentReplaced'
  | 'segmentCompacted'
  | 'segmentSplit'
  | 'segmentEvicted'
  | 'segmentRestored'
  | 'groupCreated'
  | 'groupDissolved'
  | 'taskSet'
  | 'taskCleared'
  | 'baselineCaptured'
  | 'reportGenerated'
  | 'patternActivated'
  | 'patternEscalated'
  | 'patternDeescalated'
  | 'patternResolved'
  | 'tokenizerChanged'
  | 'embeddingProviderChanged'
  | 'capacityChanged'
  | 'budgetViolation'
  | 'customPatternRegistered'
  | 'stateSnapshotted'
  | 'stateRestored'
  | 'lateSeeding'
  | 'pinnedCeilingWarning';

export interface TimelineEntry {
  timestamp: number;
  sequence: number;
  type: TimelineEventType;
  detail: Record<string, unknown>;
}

export interface AnomalyFlag {
  dimension: 'coherence' | 'density' | 'relevance' | 'continuity' | 'composite';
  delta: number;
  likelyCause: 'taskChange' | 'bulkEviction' | 'providerSwitch' | 'bulkAdd' | null;
}

export interface ReportSummary {
  reportId: string;
  timestamp: number;
  windowScores: WindowScores;
  composite: number;
  segmentCount: number;
  totalActiveTokens: number;
  utilization: number;
  patternCount: number;
  highestSeverity: Severity | null;
  embeddingMode: 'embeddings' | 'trigrams';
  anomalies: AnomalyFlag[];
}

export interface TrendLine {
  direction: 'improving' | 'stable' | 'degrading';
  averageRate: number;
  current: number;
  windowMin: number;
  windowMax: number;
  volatility: number;
}

export interface RollingTrend {
  window: number;
  coherence: TrendLine;
  density: TrendLine;
  relevance: TrendLine;
  continuity: TrendLine;
  composite: TrendLine;
}

export interface PatternStats {
  activationCount: number;
  totalActiveTime: number;
  peakSeverity: Severity;
  currentState: 'active' | 'inactive';
  currentSeverity: Severity | null;
  lastActivation: number | null;
  lastResolution: number | null;
  recurrenceCount: number;
}

export interface PatternHistoryEntry {
  name: PatternName;
  event: 'activated' | 'escalated' | 'deescalated' | 'resolved';
  severity: Severity;
  timestamp: number;
  reportId: string;
  score: number;
  compoundContext: string | null;
}

export interface PatternSummary {
  activePatterns: ActivePattern[];
  totalActivations: number;
  totalResolutions: number;
  perPattern: Record<string, PatternStats>;
  history: PatternHistoryEntry[];
}

export interface OperationTimingStats {
  count: number;
  totalSelfTime: number;
  totalProviderTime: number;
  averageSelfTime: number;
  maxSelfTime: number;
  p95SelfTime: number;
  budgetTarget: number;
  budgetViolations: number;
  withinBudgetRate: number;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number | null;
  currentEntries: number;
  maxEntries: number;
  utilization: number;
  evictions: number;
}

export interface CacheReport {
  tokenCache: CacheMetrics;
  embeddingCache: CacheMetrics;
  similarityCache: CacheMetrics;
}

export interface PerformanceSummary {
  operationTimings: Record<string, OperationTimingStats>;
  caches: CacheReport;
  sessionSelfTime: number;
  sessionProviderTime: number;
  budgetViolationCount: number;
}

export interface ReportHistorySummary {
  reports: ReportSummary[];
  rollingTrend: RollingTrend | null;
}

export interface ProviderSummary {
  tokenizer: TokenizerMetadata;
  embedding: EmbeddingProviderMetadata | null;
}

export interface Warning {
  code: string;
  message: string;
  timestamp: number;
}

/** @see cl-spec-010 */
export interface DiagnosticSnapshot {
  schemaVersion: string;
  timestamp: number;
  sessionDuration: number;
  latestReport: QualityReport | null;
  reportHistory: ReportHistorySummary;
  patternSummary: PatternSummary;
  timeline: TimelineEntry[];
  performance: PerformanceSummary;
  providers: ProviderSummary;
  segmentCount: number;
  groupCount: number;
  evictedCount: number;
  taskState: TaskState;
  continuityLedger: ContinuityEvent[];
  warnings: Warning[];
}

// ─── Serialization Domain ─────────────────────────────────────────
// @see cl-spec-014

export interface SerializedConfig {
  capacity: number;
  retainEvictedContent: boolean;
  pinnedCeilingRatio: number;
  patternThresholds: Record<string, unknown> | null;
  suppressedPatterns: string[];
  hysteresisMargin: number;
  tokenCacheSize: number;
  embeddingCacheSize: number;
}

export interface ProviderMetadataSnapshot {
  tokenizer: {
    name: string;
    accuracy: string;
    modelFamily: string | null;
    errorBound: number | null;
  };
  embedding: {
    name: string;
    dimensions: number;
    modelFamily: string | null;
  } | null;
}

export interface SerializedSegment {
  id: string;
  content: string | null;
  tokenCount: number;
  createdAt: number;
  updatedAt: number;
  protection: string;
  importance: number;
  origin: string | null;
  tags: string[];
  groupId: string | null;
  state: string;
  position: number;
}

export interface SerializedGroup {
  groupId: string;
  members: string[];
  protection: string;
  importance: number;
  origin: string | null;
  tags: string[];
  state: string;
  createdAt: number;
}

export interface PatternTrackingState {
  name: string;
  state: 'active' | 'resolved';
  activatedAt: number | null;
  currentSeverity: Severity | null;
  severitySince: number | null;
  peakSeverity: Severity | null;
  peakAt: number | null;
  reportCount: number;
  scoreHistory: { reportId: string; score: number }[];
  consecutiveNulls: number;
  resolvedAt: number | null;
}

export interface PatternTrackingSnapshot {
  perPattern: Record<string, PatternTrackingState>;
  history: PatternHistoryEntry[];
  perPatternStats: Record<string, PatternStats>;
}

export interface CustomPatternMeta {
  name: string;
  description: string;
  priority: number;
  strategyHint: string | null;
  registeredAt: number;
  registrationOrder: number;
}

export interface ContinuityCounters {
  totalEvictionLoss: number;
  totalCompactionLoss: number;
  totalRecovery: number;
  totalInformationValue: number;
  totalTokensEverSeen: number;
  segmentContinuity: Record<string, number>;
}

/** @see cl-spec-014 */
export interface SerializedState {
  formatVersion: string;
  schemaVersion: string;
  timestamp: number;
  restorable: boolean;
  instanceId: string;
  sessionStartedAt: number;
  sessionDuration: number;
  config: SerializedConfig;
  providerMetadata: ProviderMetadataSnapshot;
  segments: SerializedSegment[];
  groups: SerializedGroup[];
  taskState: TaskState;
  baseline: BaselineSnapshot | null;
  continuityLedger: ContinuityEvent[];
  continuityCounters: ContinuityCounters;
  patternTracking: PatternTrackingSnapshot;
  timeline: TimelineEntry[];
  reportHistory: ReportSummary[];
  rollingTrend: RollingTrend | null;
  warnings: Warning[];
  customPatternMetadata: CustomPatternMeta[];
  assessCount: number;
  mutationCount: number;
}

// ─── Fleet Domain ─────────────────────────────────────────────────
// @see cl-spec-012

export interface InstanceReport {
  label: string;
  status: 'ok' | 'no-report' | 'error';
  error: string | null;
  report: QualityReport | null;
  capacity: CapacityReport;
}

export interface AggregateStat {
  mean: number;
  min: number;
  max: number;
  minInstance: string;
  maxInstance: string;
  stddev: number;
}

export interface FleetAggregate {
  coherence: AggregateStat;
  density: AggregateStat;
  relevance: AggregateStat;
  continuity: AggregateStat;
  composite: AggregateStat;
  utilization: AggregateStat;
}

export interface Hotspot {
  label: string;
  highestSeverity: Severity;
  patternCount: number;
  patterns: string[];
  composite: number;
}

export interface RankedInstance {
  label: string;
  composite: number | null;
  rank: number;
}

export interface FleetCapacity {
  totalCapacity: number;
  totalActiveTokens: number;
  fleetUtilization: number;
  overCapacityCount: number;
  highUtilizationCount: number;
}

/** @see cl-spec-012 */
export interface FleetReport {
  schemaVersion: string;
  timestamp: number;
  instanceCount: number;
  assessedCount: number;
  failedInstances: number;
  cached: boolean;
  instances: InstanceReport[];
  aggregate: FleetAggregate;
  hotspots: Hotspot[];
  ranking: RankedInstance[];
  capacityOverview: FleetCapacity;
}

// ─── Lifecycle Domain ─────────────────────────────────────────────
// @see cl-spec-015

/**
 * Two-state lifecycle from cl-spec-015 §2 plus the transient `disposing`
 * observable from §2.5. The lifecycle graph is two-valued; `disposing` is a
 * during-teardown probe, not a third state.
 */
export type LifecycleState = 'live' | 'disposing' | 'disposed';

/**
 * Teardown callback registered by lifecycle-aware integrations (fleet,
 * exporter). Invoked synchronously during step 3 of teardown with the live
 * instance; throwing is permitted and absorbed into the disposal error log.
 * @see cl-spec-015 §6.2
 */
export type IntegrationTeardown<T = unknown> = (instance: T) => void;

/**
 * Handle returned by `attachIntegration`. Calling `detach()` removes the
 * teardown callback from the instance's integration registry without firing
 * it. Idempotent — repeated calls are no-ops.
 * @see cl-spec-015 §6.2
 */
export interface IntegrationHandle {
  detach(): void;
}
