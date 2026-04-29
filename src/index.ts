/**
 * ContextLens — public API surface for context window quality monitoring.
 * @see cl-spec-007
 */

import type {
  Segment,
  Group,
  ProtectionLevel,
  TokenizerProvider,
  TokenizerMetadata,
  EmbeddingProvider,
  EmbeddingProviderMetadata,
  CapacityReport,
  QualityReport,
  EvictionRecord,
  EvictionPlan,
  PatternDefinition,
  TaskDescriptor,
  TaskTransition,
  TaskState,
  BaselineSnapshot,
  SerializedState,
  SerializedConfig,
} from './types.js';
import {
  ConfigurationError,
  ValidationError,
} from './errors.js';
import { EventEmitter, type ContextLensEventMap } from './events.js';
import { Tokenizer } from './tokenizer.js';
import { SegmentStore, type AddOptions, type UpdateChanges, type RestoreOptions, type CreateGroupOptions, type DuplicateSignal } from './segment-store.js';
import { EmbeddingEngine } from './embedding.js';
import { SimilarityEngine } from './similarity.js';
import { TaskManager } from './task.js';
import { QualityReportAssembler, type ScoringSegment, type AssessmentContext } from './quality-report.js';
import { DetectionEngine, type DetectionConfig } from './detection.js';
import { EvictionAdvisory, type PlanOptions } from './eviction.js';
import { PerformanceInstrumentation } from './performance.js';
import { ContinuityTracker } from './scoring/continuity.js';
import { BaselineManager } from './scoring/baseline.js';
import { DiagnosticsManager } from './diagnostics.js';
import { deepCopy } from './utils/copy.js';
import { fnv1a } from './utils/hash.js';
import type { DiagnosticSnapshot } from './types.js';

// ─── Config ───────────────────────────────────────────────────────

export interface ContextLensConfig {
  capacity: number;
  tokenizer?: TokenizerProvider | 'approximate';
  embeddingProvider?: EmbeddingProvider | null;
  embeddingProviderMetadata?: EmbeddingProviderMetadata;
  retainEvictedContent?: boolean;
  pinnedCeilingRatio?: number;
  patternThresholds?: Record<string, unknown>;
  suppressedPatterns?: string[];
  hysteresisMargin?: number;
  tokenCacheSize?: number;
  embeddingCacheSize?: number;
  customPatterns?: PatternDefinition[];
}

export interface SeedInput {
  content: string;
  id?: string;
  importance?: number;
  protection?: ProtectionLevel;
  origin?: string;
  tags?: string[];
  groupId?: string;
}

// ─── ContextLens ──────────────────────────────────────────────────

export class ContextLens {
  // ── Private module instances ─────────────────────────────────
  private readonly emitter: EventEmitter<ContextLensEventMap>;
  private readonly tokenizer: Tokenizer;
  private readonly store: SegmentStore;
  private readonly embedding: EmbeddingEngine;
  private readonly similarity: SimilarityEngine;
  private readonly taskManager: TaskManager;
  private readonly continuity: ContinuityTracker;
  private readonly baseline: BaselineManager;
  private readonly reportAssembler: QualityReportAssembler;
  private readonly detection: DetectionEngine;
  private readonly evictionAdvisory: EvictionAdvisory;
  private readonly perf: PerformanceInstrumentation;
  private readonly diagnosticsManager: DiagnosticsManager;

  // ── Instance state ──────────────────────────────────────────
  private readonly constructionTimestamp: number;
  private readonly configSnapshot: ContextLensConfig;
  private capacity: number;
  private qualityCacheValid = false;
  private cachedReport: QualityReport | null = null;
  private seeded = false;
  private hasAdds = false;

  /**
   * Create a new ContextLens instance for monitoring a single context window.
   * @param config - Configuration with required `capacity` (token budget) and optional providers.
   * @throws {ConfigurationError} If capacity is missing or invalid.
   * @see cl-spec-007 §4
   */
  constructor(config: ContextLensConfig) {
    // Step 1: Validate config
    this.validateConfig(config);

    // Step 2: Deep-copy config
    this.configSnapshot = deepCopy(config);
    this.capacity = config.capacity;

    // Step 3: Capture construction timestamp
    this.constructionTimestamp = Date.now();

    // Step 4: Create event emitter
    this.emitter = new EventEmitter<ContextLensEventMap>();

    // Step 5: Create tokenizer
    this.tokenizer = new Tokenizer(
      config.tokenizer ?? 'approximate',
      undefined,
      config.tokenCacheSize ?? 4096,
    );

    // Step 6: Create segment store
    this.store = new SegmentStore(
      this.tokenizer,
      this.emitter,
      config.retainEvictedContent ?? true,
    );

    // Step 7: Create embedding engine
    this.embedding = new EmbeddingEngine(
      config.embeddingCacheSize ?? 4096,
      (content: string) => this.tokenizer.count(content),
    );

    // Step 8: Create similarity engine
    this.similarity = new SimilarityEngine();
    this.similarity.setEmbeddingLookup(this.embedding);

    // Step 9: Create task manager
    this.taskManager = new TaskManager();

    // Step 10: Create scoring/report modules
    this.continuity = new ContinuityTracker();
    this.baseline = new BaselineManager();
    this.reportAssembler = new QualityReportAssembler(
      this.similarity,
      this.embedding,
      this.taskManager,
      this.continuity,
      this.baseline,
    );

    // Step 11: Create detection engine
    const detectionConfig: DetectionConfig = {};
    if (config.patternThresholds != null) detectionConfig.thresholds = config.patternThresholds;
    if (config.suppressedPatterns != null) detectionConfig.suppressedPatterns = config.suppressedPatterns;
    if (config.hysteresisMargin != null) detectionConfig.hysteresisMargin = config.hysteresisMargin;
    if (config.customPatterns != null) detectionConfig.customPatterns = config.customPatterns;
    this.detection = new DetectionEngine(detectionConfig);

    // Step 12: Create eviction advisory
    this.evictionAdvisory = new EvictionAdvisory({
      store: this.store,
      similarity: this.similarity,
    });

    // Step 13: Create performance module
    this.perf = new PerformanceInstrumentation();

    // Step 14: Create diagnostics module
    this.diagnosticsManager = new DiagnosticsManager({
      emitter: this.emitter,
      perf: this.perf,
      detection: this.detection,
      taskManager: this.taskManager,
      continuity: this.continuity,
      store: this.store,
      tokenizer: this.tokenizer,
      embedding: this.embedding,
      similarity: this.similarity,
      constructionTimestamp: this.constructionTimestamp,
    });
  }

  // ── Config Validation ───────────────────────────────────────────

  private validateConfig(config: ContextLensConfig): void {
    if (config.capacity === undefined || config.capacity === null) {
      throw new ConfigurationError('capacity is required');
    }
    if (!Number.isInteger(config.capacity) || config.capacity <= 0) {
      throw new ConfigurationError('capacity must be a positive integer', { capacity: config.capacity });
    }

    if (config.pinnedCeilingRatio !== undefined) {
      if (config.pinnedCeilingRatio <= 0 || config.pinnedCeilingRatio > 1) {
        throw new ConfigurationError('pinnedCeilingRatio must be in (0.0, 1.0]', { pinnedCeilingRatio: config.pinnedCeilingRatio });
      }
    }

    if (config.tokenCacheSize !== undefined) {
      if (!Number.isInteger(config.tokenCacheSize) || config.tokenCacheSize <= 0) {
        throw new ConfigurationError('tokenCacheSize must be a positive integer', { tokenCacheSize: config.tokenCacheSize });
      }
    }

    if (config.embeddingCacheSize !== undefined) {
      if (!Number.isInteger(config.embeddingCacheSize) || config.embeddingCacheSize <= 0) {
        throw new ConfigurationError('embeddingCacheSize must be a positive integer', { embeddingCacheSize: config.embeddingCacheSize });
      }
    }

    if (config.retainEvictedContent !== undefined && typeof config.retainEvictedContent !== 'boolean') {
      throw new ConfigurationError('retainEvictedContent must be a boolean');
    }
  }

  // ── Segment Operations ──────────────────────────────────────────

  /**
   * Batch insert seed segments. Protection defaults to 'seed'.
   * Triggers baseline capture on the next `add()` call.
   * @throws {ValidationError} If any segment has empty content or duplicate content hash.
   * @see cl-spec-007 §5.1
   */
  seed(segments: SeedInput[]): Segment[] {
    if (segments.length === 0) return [];

    // Defensive copy
    const inputs = deepCopy(segments);

    // Late seeding warning
    if (this.hasAdds) {
      this.emitter.emit('lateSeeding', { segmentCount: this.store.segmentCount });
    }

    this.baseline.notifySeed();

    const results: Segment[] = [];

    for (const input of inputs) {
      if (!input.content || input.content.length === 0) {
        throw new ValidationError('Seed segment content must be non-empty');
      }

      const addOpts: AddOptions = {
        importance: input.importance ?? 0.5,
        protection: input.protection ?? 'seed',
      };
      if (input.id != null) addOpts.id = input.id;
      if (input.origin != null) addOpts.origin = input.origin;
      if (input.tags != null) addOpts.tags = input.tags;
      if (input.groupId != null) addOpts.groupId = input.groupId;
      const result = this.store.add(input.content, addOpts);

      if ('isDuplicate' in result) {
        throw new ValidationError(`Duplicate content in seed batch`, { existingId: result.existingId });
      }

      // Prepare embedding
      const hash = fnv1a(input.content);
      this.embedding.prepare(hash, input.content).catch(() => { /* fail-silent during seed */ });

      results.push(deepCopy(result));
    }

    this.seeded = true;
    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    return results;
  }

  /**
   * Add a single segment. Returns a {@link DuplicateSignal} instead of throwing on auto-ID collision.
   * On the first add after seed, captures the quality baseline.
   * @see cl-spec-007 §5.1
   */
  add(content: string, options?: AddOptions): Segment | DuplicateSignal {
    const opts = options !== undefined ? deepCopy(options) : undefined;

    // First add after seed: capture baseline
    if (!this.hasAdds && this.seeded) {
      this.captureBaseline();
    }

    const result = this.store.add(content, opts);

    if ('isDuplicate' in result) {
      return deepCopy(result);
    }

    this.hasAdds = true;
    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();

    // Prepare embedding
    const hash = fnv1a(content);
    this.embedding.prepare(hash, content).catch(() => { /* fail-silent */ });

    return deepCopy(result);
  }

  /**
   * Update segment metadata and/or content in place.
   * @throws {SegmentNotFoundError} If the segment does not exist.
   * @see cl-spec-007 §5.1
   */
  update(id: string, changes: UpdateChanges): Segment {
    const changesCopy = deepCopy(changes);
    const result = this.store.update(id, changesCopy);

    if (changesCopy.content !== undefined) {
      // Recompute embedding for new content
      const hash = fnv1a(changesCopy.content);
      this.embedding.prepare(hash, changesCopy.content).catch(() => { /* fail-silent */ });
      this.similarity.invalidateContentHash(fnv1a(changesCopy.content));
    }

    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    return deepCopy(result);
  }

  /**
   * Replace segment content entirely, preserving the segment ID.
   * @throws {SegmentNotFoundError} If the segment does not exist.
   * @see cl-spec-007 §5.1
   */
  replace(id: string, newContent: string, options?: Partial<Pick<AddOptions, 'importance' | 'origin' | 'tags'>>): Segment {
    const opts = options !== undefined ? deepCopy(options) : undefined;
    const result = this.store.replace(id, newContent, opts);

    // Recompute embedding
    const hash = fnv1a(newContent);
    this.embedding.prepare(hash, newContent).catch(() => { /* fail-silent */ });
    this.similarity.invalidateContentHash(hash);

    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    return deepCopy(result);
  }

  /**
   * Compact a segment by replacing its content with a caller-provided summary.
   * Records a compaction event in the continuity ledger.
   * @throws {CompactionError} If the summary is longer than the original.
   * @see cl-spec-007 §5.1
   */
  compact(id: string, summary: string): Segment {
    const seg = this.store.getSegment(id);
    const prevTokenCount = seg?.tokenCount ?? 0;

    const result = this.store.compact(id, summary);

    // Recompute embedding
    const hash = fnv1a(summary);
    this.embedding.prepare(hash, summary).catch(() => { /* fail-silent */ });
    this.similarity.invalidateContentHash(hash);

    // Record compaction in continuity ledger
    const redundancy = 0; // Approximate — exact redundancy not available pre-assess
    this.continuity.recordCompaction(
      id,
      prevTokenCount,
      result.tokenCount,
      result.importance,
      redundancy,
      Date.now(),
    );

    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    return deepCopy(result);
  }

  /**
   * Split a segment into multiple children via a caller-provided function.
   * The original segment is removed; children inherit its protection and group.
   * @throws {SplitError} If splitFn returns fewer than 2 parts or empty parts.
   * @see cl-spec-007 §5.1
   */
  split(id: string, splitFn: (content: string) => string[]): Segment[] {
    const results = this.store.split(id, splitFn);

    // Prepare embeddings for children
    for (const child of results) {
      const hash = fnv1a(child.content);
      this.embedding.prepare(hash, child.content).catch(() => { /* fail-silent */ });
    }

    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    return results.map(s => deepCopy(s));
  }

  /**
   * Evict a segment (or its entire group atomically if grouped).
   * Records eviction cost in the continuity ledger.
   * @returns Single record for ungrouped, array for group eviction.
   * @throws {SegmentNotFoundError} If the segment does not exist.
   * @throws {ProtectionError} If the segment is pinned.
   * @see cl-spec-007 §5.1
   */
  evict(id: string, reason?: string): EvictionRecord | EvictionRecord[] {
    const records = this.store.evict(id, reason);

    // Record each eviction in continuity ledger
    const totalActiveTokens = this.computeCapacity().totalActiveTokens;
    for (const rec of records) {
      this.continuity.recordEviction(
        rec.segmentId,
        rec.tokenCount,
        rec.importance,
        1.0, // relevance at eviction — approximate, exact not available pre-assess
        totalActiveTokens + rec.tokenCount, // tokens before this eviction
        rec.timestamp,
      );
    }

    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    const copied = records.map(r => deepCopy(r));
    return copied.length === 1 ? copied[0]! : copied;
  }

  /**
   * Restore an evicted segment (or its entire group).
   * Records restoration fidelity in the continuity ledger.
   * @throws {RestoreError} If the segment is not evicted or content was not retained.
   * @see cl-spec-007 §5.1
   */
  restore(id: string, options?: RestoreOptions): Segment | Segment[] {
    const opts = options !== undefined ? deepCopy(options) : undefined;
    const results = this.store.restore(id, opts);

    // Prepare embeddings for restored segments
    for (const seg of results) {
      const hash = fnv1a(seg.content);
      this.embedding.prepare(hash, seg.content).catch(() => { /* fail-silent */ });

      // Record restoration in continuity
      this.continuity.recordRestoration(
        seg.id,
        seg.tokenCount,
        1.0, // relevance — approximate
        Date.now(),
      );
    }

    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    const copied = results.map(s => deepCopy(s));
    return copied.length === 1 ? copied[0]! : copied;
  }

  // ── Group Operations ────────────────────────────────────────────

  /**
   * Create a group from existing active segments. Groups evict and restore atomically.
   * @throws {DuplicateIdError} If the groupId is already in use.
   * @see cl-spec-007 §5.2
   */
  createGroup(groupId: string, segmentIds: string[], options?: CreateGroupOptions): Group {
    const opts = options !== undefined ? deepCopy(options) : undefined;
    const result = this.store.createGroup(groupId, segmentIds, opts);
    return deepCopy(result);
  }

  /**
   * Dissolve a group, keeping members as individual segments.
   * @throws {ValidationError} If the group does not exist.
   * @see cl-spec-007 §5.2
   */
  dissolveGroup(groupId: string): Segment[] {
    const group = this.store.getGroup(groupId);
    if (group === undefined) {
      throw new ValidationError(`Group not found: ${groupId}`);
    }
    const memberIds = [...group.members];
    this.store.dissolveGroup(groupId);
    return memberIds.map(id => deepCopy(this.store.getSegment(id)!));
  }

  /** Get a group by ID. Returns null if not found. */
  getGroup(groupId: string): Group | null {
    const group = this.store.getGroup(groupId);
    return group !== undefined ? deepCopy(group) : null;
  }

  /** List all active groups. */
  listGroups(): Group[] {
    return this.store.listGroups().map(g => deepCopy(g));
  }

  // ── Read Methods ────────────────────────────────────────────────

  /** Get a segment by ID (active or evicted). Returns null if not found. */
  getSegment(id: string): Segment | null {
    const seg = this.store.getSegment(id);
    return seg !== undefined ? deepCopy(seg) : null;
  }

  /** Get count of active segments. */
  getSegmentCount(): number {
    return this.store.segmentCount;
  }

  /** List all active segments in order. */
  listSegments(): Segment[] {
    return this.store.getOrderedActiveSegments().map(s => deepCopy(s));
  }

  /** Get current capacity metrics. */
  getCapacity(): CapacityReport {
    return deepCopy(this.computeCapacity());
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * @see cl-spec-007 §9
   */
  on<E extends keyof ContextLensEventMap>(
    event: E,
    handler: (payload: ContextLensEventMap[E]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  // ── Assessment ──────────────────────────────────────────────────

  /**
   * Assess context window quality. Returns a cached report if no mutations since the last call.
   * Runs all four dimension scorers, detection, and trend analysis.
   * @see cl-spec-007 §6
   * @see cl-spec-002 (quality model)
   * @see cl-spec-003 (degradation patterns)
   */
  assess(): QualityReport {
    // Step 1: Check cache
    if (this.qualityCacheValid && this.cachedReport !== null) {
      return deepCopy(this.cachedReport);
    }

    // Step 2: Build AssessmentContext
    const ctx = this.buildAssessmentContext();

    // Step 3: Delegate to quality-report module
    const report = this.reportAssembler.assess(ctx);

    // Step 4: Run detection
    const historyLenBefore = this.detection.getPatternHistory().length;
    const taskSummary = this.taskManager.getSummary();
    const detectionResult = this.detection.detect(report, {
      isActive: this.taskManager.isActive(),
      gracePeriodActive: taskSummary.gracePeriodActive,
    });
    report.patterns = detectionResult;

    // Step 5: Fire pattern events for transitions in this cycle
    const fullHistory = this.detection.getPatternHistory();
    for (let i = historyLenBefore; i < fullHistory.length; i++) {
      const entry = fullHistory[i]!;
      if (entry.event === 'activated' || entry.event === 'escalated') {
        const ap = detectionResult.patterns.find(p => p.name === entry.name);
        if (ap) {
          this.emitter.emit('patternActivated', { pattern: deepCopy(ap) });
        }
      } else if (entry.event === 'resolved') {
        const snapshot = this.detection.getTrackingSnapshot();
        const stats = snapshot.perPatternStats[entry.name];
        this.emitter.emit('patternResolved', {
          name: entry.name,
          duration: stats?.totalActiveTime ?? 0,
          peakSeverity: stats?.peakSeverity ?? entry.severity,
        });
      }
    }

    // Step 6: Cache
    this.cachedReport = report;
    this.qualityCacheValid = true;

    // Step 7: Tick task grace period / staleness
    this.taskManager.tickReport();

    // Step 8: Fire reportGenerated
    this.emitter.emit('reportGenerated', { report: deepCopy(report) });

    return deepCopy(report);
  }

  // ── Eviction Planning ───────────────────────────────────────────

  /**
   * Generate an advisory eviction plan. Calls {@link assess} if no cached report exists.
   * Plans are snapshots — the caller must re-plan after executing mutations.
   * @see cl-spec-008
   */
  planEviction(options?: PlanOptions): EvictionPlan {
    // Ensure a report exists
    if (this.cachedReport === null) {
      this.assess();
    }

    const plan = this.evictionAdvisory.planEviction(
      this.cachedReport!,
      options,
      this.detection.getCustomPatternMeta(),
    );

    return deepCopy(plan);
  }

  // ── Task Operations ─────────────────────────────────────────────

  /**
   * Set or update the task descriptor. Classifies the transition as 'new', 'refinement',
   * 'change', or 'same'. Invalidates relevance scores on non-same transitions.
   * @returns Transition details including classification and similarity.
   * @see cl-spec-004
   */
  async setTask(descriptor: TaskDescriptor): Promise<TaskTransition> {
    const desc = deepCopy(descriptor);
    const transition = await this.taskManager.setTask(desc, this.similarity, this.embedding);

    // "same" transitions don't invalidate or fire events
    if (transition.type === 'same') {
      return deepCopy(transition);
    }

    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    this.emitter.emit('taskChanged', { transition: deepCopy(transition) });
    return deepCopy(transition);
  }

  /** Clear the current task. */
  clearTask(): void {
    if (!this.taskManager.isActive()) return;

    this.taskManager.clearTask();
    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    this.emitter.emit('taskCleared', {});
  }

  /** Get the current task descriptor, or null. */
  getTask(): TaskDescriptor | null {
    const task = this.taskManager.getCurrentTask();
    return task !== null ? deepCopy(task) : null;
  }

  /** Get full task lifecycle state. */
  getTaskState(): TaskState {
    return deepCopy(this.taskManager.getState());
  }

  // ── Provider Management ─────────────────────────────────────────

  /**
   * Switch the tokenizer provider. Triggers a full recount of all active segments.
   * @see cl-spec-006
   */
  setTokenizer(provider: TokenizerProvider | 'approximate', metadata?: TokenizerMetadata): void {
    const result = this.tokenizer.switchProvider(provider, metadata, {
      getActiveSegments: () => this.store.getActiveSegmentIterator(),
      setSegmentTokenCount: (id: string, tokenCount: number) => {
        this.store.setSegmentTokenCount(id, tokenCount);
      },
    });

    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    this.emitter.emit('tokenizerChanged', result);
  }

  /**
   * Switch or remove the embedding provider. Triggers a full re-embed of all segments
   * and invalidates the similarity cache. Pass `null` to downgrade to trigram mode.
   * @see cl-spec-005
   */
  async setEmbeddingProvider(
    provider: EmbeddingProvider | null,
    metadata?: EmbeddingProviderMetadata,
  ): Promise<void> {
    if (provider === null) {
      const result = this.embedding.removeProvider(() => {
        this.similarity.clearCache();
      });
      this.qualityCacheValid = false;
      this.reportAssembler.invalidate();
      this.emitter.emit('embeddingProviderChanged', { oldName: result.oldName, newName: null });
      return;
    }

    const result = await this.embedding.setProvider(
      provider,
      metadata!,
      this.getActiveContentIterable(),
      () => { this.similarity.clearCache(); },
    );
    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    this.emitter.emit('embeddingProviderChanged', { oldName: result.oldName, newName: result.newName });
  }

  /** Get tokenizer info. */
  getTokenizerInfo(): TokenizerMetadata {
    return deepCopy(this.tokenizer.getInfo());
  }

  /** Get embedding provider info, or null if in trigram mode. */
  getEmbeddingProviderInfo(): EmbeddingProviderMetadata | null {
    const meta = this.embedding.getProviderMetadata();
    return meta !== null ? deepCopy(meta) : null;
  }

  // ── Capacity Management ─────────────────────────────────────────

  /** Update the token capacity. */
  setCapacity(newCapacity: number): void {
    if (!Number.isInteger(newCapacity) || newCapacity <= 0) {
      throw new ValidationError('Capacity must be a positive integer', { capacity: newCapacity });
    }
    const oldCapacity = this.capacity;
    this.capacity = newCapacity;
    this.qualityCacheValid = false;
    this.reportAssembler.invalidate();
    this.emitter.emit('capacityChanged', { oldCapacity, newCapacity });
  }

  // ── Pattern Registration ────────────────────────────────────────

  /**
   * Register a custom detection pattern at runtime. Custom patterns receive the full
   * {@link QualityReport} and participate in hysteresis like built-in patterns.
   * @throws {DuplicateIdError} If a pattern with the same name is already registered.
   * @see cl-spec-003 §10
   */
  registerPattern(definition: PatternDefinition): void {
    const def = deepCopy(definition);
    this.detection.registerPattern(def);
    this.emitter.emit('customPatternRegistered', { name: def.name, description: def.description });
  }

  // ── Inspection ──────────────────────────────────────────────────

  /** Get the quality baseline snapshot, or null if not captured. */
  getBaseline(): BaselineSnapshot | null {
    const snap = this.baseline.getSnapshot();
    return snap !== null ? deepCopy(snap) : null;
  }

  /**
   * Get full diagnostic snapshot. Tier 1 (< 1ms) — assembles pre-maintained state
   * including report history, pattern stats, timeline, cache metrics, and warnings.
   * @see cl-spec-010
   */
  getDiagnostics(): DiagnosticSnapshot {
    return this.diagnosticsManager.getDiagnostics();
  }

  /** Get the session start timestamp. */
  getConstructionTimestamp(): number {
    return this.constructionTimestamp;
  }

  /** Get the config used to construct this instance. */
  getConfig(): ContextLensConfig {
    return deepCopy(this.configSnapshot);
  }

  /** Get evicted segments. */
  getEvictedSegments(): Segment[] {
    return this.store.getEvictedSegments().map(s => deepCopy(s));
  }

  /** Get performance instrumentation module (for diagnostics). */
  getPerformance(): PerformanceInstrumentation {
    return this.perf;
  }

  /** Get detection engine (for diagnostics). */
  getDetection(): DetectionEngine {
    return this.detection;
  }

  // ── Internal Helpers ────────────────────────────────────────────

  private computeCapacity(): CapacityReport {
    return this.tokenizer.computeCapacity(
      this.capacity,
      this.store.getActiveSegmentIterator(),
    );
  }

  private buildAssessmentContext(): AssessmentContext {
    const segments = this.store.getOrderedActiveSegments();
    const scoringSegments: ScoringSegment[] = segments.map(s => ({
      id: s.id,
      content: s.content,
      contentHash: fnv1a(s.content),
      tokenCount: s.tokenCount,
      protection: s.protection,
      importance: s.importance,
      origin: s.origin,
      tags: s.tags,
      groupId: s.groupId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    const groups = new Map<string, string[]>();
    for (const g of this.store.listGroups()) {
      groups.set(g.groupId, [...g.members]);
    }

    return {
      orderedSegments: scoringSegments,
      groups,
      capacity: this.computeCapacity(),
      tokenizerMetadata: this.tokenizer.getInfo(),
    };
  }

  private captureBaseline(): void {
    const segments = this.store.getOrderedActiveSegments();
    if (segments.length === 0) return;

    // Assess to get raw scores, then wire up baseline
    const ctx = this.buildAssessmentContext();
    const preReport = this.reportAssembler.assess(ctx);
    this.baseline.notifyAdd(
      preReport.rawScores,
      preReport.segmentCount,
      ctx.capacity.totalActiveTokens,
      preReport.timestamp,
    );

    // Re-assess with baseline established so the report includes normalized scores
    this.reportAssembler.invalidate();
    const report = this.reportAssembler.assess(this.buildAssessmentContext());
    if (report.baseline !== null) {
      this.emitter.emit('baselineCaptured', { baseline: deepCopy(report.baseline) });
    }
    this.cachedReport = report;
    this.qualityCacheValid = true;
  }

  private getActiveContentIterable(): Iterable<{ hash: number; content: string }> {
    const segments = this.store.getOrderedActiveSegments();
    return segments.map(s => ({ hash: fnv1a(s.content), content: s.content }));
  }

  // ── Serialization ──────────────────────────────────────────────

  /**
   * Capture a complete, self-contained snapshot of instance state.
   * @see cl-spec-014
   */
  snapshot(options?: { includeContent?: boolean }): SerializedState {
    const includeContent = options?.includeContent ?? true;
    const now = Date.now();
    const restorable = includeContent;

    // Segments: active + evicted, with position
    const activeSegments = this.store.getOrderedActiveSegments();
    const evictedSegments = this.store.getEvictedSegments();
    const segments = [...activeSegments, ...evictedSegments].map((s, _i) => ({
      id: s.id,
      content: includeContent ? s.content : null,
      tokenCount: s.tokenCount,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      protection: s.protection as string,
      importance: s.importance,
      origin: s.origin,
      tags: [...s.tags],
      groupId: s.groupId,
      state: s.state as string,
      // Position: active segments have natural order; evicted get high positions
      position: 0, // Will be set below
    }));
    // Set positions: use ordered active first, then evicted
    for (let i = 0; i < activeSegments.length; i++) {
      segments[i]!.position = i;
    }
    for (let i = 0; i < evictedSegments.length; i++) {
      segments[activeSegments.length + i]!.position = activeSegments.length + i;
    }

    // Groups
    const groups = this.store.listGroups().map(g => ({
      groupId: g.groupId,
      members: [...g.members],
      protection: g.protection as string,
      importance: g.importance,
      origin: g.origin,
      tags: [...g.tags],
      state: g.state as string,
      createdAt: g.createdAt,
    }));

    // Config
    const config: SerializedConfig = {
      capacity: this.capacity,
      retainEvictedContent: this.configSnapshot.retainEvictedContent ?? true,
      pinnedCeilingRatio: this.configSnapshot.pinnedCeilingRatio ?? 0.5,
      patternThresholds: this.configSnapshot.patternThresholds ?? null,
      suppressedPatterns: this.configSnapshot.suppressedPatterns ?? [],
      hysteresisMargin: this.configSnapshot.hysteresisMargin ?? 0.03,
      tokenCacheSize: this.configSnapshot.tokenCacheSize ?? 4096,
      embeddingCacheSize: this.configSnapshot.embeddingCacheSize ?? 4096,
    };

    // Provider metadata
    const tokenizerInfo = this.tokenizer.getInfo();
    const embeddingMeta = this.embedding.getProviderMetadata();
    const providerMetadata = {
      tokenizer: {
        name: tokenizerInfo.name,
        accuracy: tokenizerInfo.accuracy,
        modelFamily: tokenizerInfo.modelFamily,
        errorBound: tokenizerInfo.errorBound,
      },
      embedding: embeddingMeta !== null ? {
        name: embeddingMeta.name,
        dimensions: embeddingMeta.dimensions,
        modelFamily: embeddingMeta.modelFamily,
      } : null,
    };

    // Diagnostics
    const diag = this.diagnosticsManager.getDiagnostics();
    const maxSequence = diag.timeline.length > 0
      ? Math.max(...diag.timeline.map(t => t.sequence))
      : 0;

    const state: SerializedState = {
      formatVersion: FORMAT_VERSION,
      schemaVersion: '1.0.0',
      timestamp: now,
      restorable,
      instanceId: `cl-${now}-${Math.random().toString(36).slice(2, 8)}`,
      sessionStartedAt: this.constructionTimestamp,
      sessionDuration: now - this.constructionTimestamp,
      config,
      providerMetadata,
      segments,
      groups,
      taskState: deepCopy(this.taskManager.getState()),
      baseline: this.baseline.getSnapshot(),
      continuityLedger: deepCopy(this.continuity.getLedger()),
      continuityCounters: deepCopy(this.continuity._getCounters()),
      patternTracking: deepCopy(this.detection.getTrackingSnapshot()),
      timeline: deepCopy(diag.timeline),
      reportHistory: deepCopy(diag.reportHistory.reports),
      rollingTrend: diag.reportHistory.rollingTrend !== null ? deepCopy(diag.reportHistory.rollingTrend) : null,
      warnings: deepCopy(diag.warnings),
      customPatternMetadata: deepCopy(this.detection.getCustomPatternMeta()),
      assessCount: diag.reportHistory.reports.length,
      mutationCount: maxSequence,
    };

    this.emitter.emit('stateSnapshotted', {
      timestamp: now,
      restorable,
      segmentCount: activeSegments.length,
      sizeEstimate: JSON.stringify(state).length,
    });

    return state;
  }

  /**
   * Create a fully functional instance from a serialized snapshot.
   * @see cl-spec-014
   */
  static fromSnapshot(state: SerializedState, restoreConfig?: RestoreConfig): ContextLens {
    // Step 1: Validate format version
    if (state.formatVersion !== FORMAT_VERSION) {
      throw new ConfigurationError(
        `Unsupported snapshot format: ${state.formatVersion}. Expected: ${FORMAT_VERSION}`,
        { formatVersion: state.formatVersion },
      );
    }

    // Step 2: Validate restorable
    if (!state.restorable) {
      throw new ConfigurationError(
        'Cannot restore from a lightweight snapshot (includeContent: false)',
        { restorable: false },
      );
    }

    // Step 3: Merge config
    const mergedConfig: ContextLensConfig = {
      capacity: restoreConfig?.capacity ?? state.config.capacity,
      tokenizer: restoreConfig?.tokenizer ?? 'approximate',
      retainEvictedContent: state.config.retainEvictedContent,
      pinnedCeilingRatio: state.config.pinnedCeilingRatio,
      hysteresisMargin: state.config.hysteresisMargin,
      tokenCacheSize: state.config.tokenCacheSize,
      embeddingCacheSize: state.config.embeddingCacheSize,
    };
    if (restoreConfig?.embeddingProvider !== undefined) {
      mergedConfig.embeddingProvider = restoreConfig.embeddingProvider;
    }
    if (restoreConfig?.embeddingProviderMetadata !== undefined) {
      mergedConfig.embeddingProviderMetadata = restoreConfig.embeddingProviderMetadata;
    }
    if (state.config.patternThresholds !== null) {
      mergedConfig.patternThresholds = state.config.patternThresholds;
    }
    if (state.config.suppressedPatterns.length > 0) {
      mergedConfig.suppressedPatterns = state.config.suppressedPatterns;
    }
    if (restoreConfig?.customPatterns !== undefined) {
      mergedConfig.customPatterns = restoreConfig.customPatterns;
    }

    // Step 4: Create instance
    const instance = new ContextLens(mergedConfig);

    // Step 5: Restore segments and groups
    instance.store._restoreFromSnapshot(state.segments, state.groups);

    // Step 6: Restore task state
    instance.taskManager._restoreFromSnapshot(state.taskState);

    // Step 7: Restore baseline
    if (state.baseline !== null) {
      instance.baseline.restoreSnapshot(state.baseline);
    }

    // Step 8: Restore continuity
    instance.continuity._restoreFromSnapshot(
      state.continuityLedger,
      state.continuityCounters,
    );

    // Step 9: Restore detection tracking
    instance.detection._restoreFromSnapshot(state.patternTracking);

    // Step 10: Restore diagnostics
    const maxSequence = state.timeline.length > 0
      ? Math.max(...state.timeline.map(t => t.sequence))
      : 0;
    instance.diagnosticsManager._restoreFromSnapshot({
      timeline: state.timeline,
      reportHistory: state.reportHistory,
      rollingTrend: state.rollingTrend,
      warnings: state.warnings,
      sequence: maxSequence + 1,
    });

    // Step 11: Set internal flags
    instance.seeded = true;
    instance.hasAdds = true;
    instance.qualityCacheValid = false;
    instance.cachedReport = null;

    // Step 12: Provider change detection
    const currentTokenizerInfo = instance.tokenizer.getInfo();
    if (currentTokenizerInfo.name !== state.providerMetadata.tokenizer.name) {
      // Different tokenizer — recount all segments
      for (const seg of instance.store.getActiveSegmentIterator()) {
        const newCount = instance.tokenizer.count(seg.content);
        instance.store.setSegmentTokenCount(seg.id, newCount);
      }
    }

    // Embedding provider change detection
    const currentEmbeddingMeta = instance.embedding.getProviderMetadata();
    const snapshotEmbeddingName = state.providerMetadata.embedding?.name ?? null;
    const currentEmbeddingName = currentEmbeddingMeta?.name ?? null;
    if (currentEmbeddingName !== snapshotEmbeddingName) {
      // Different embedding provider — embeddings rebuild lazily on first assess()
      instance.similarity.clearCache();
    }

    // Step 13: Emit stateRestored
    const currentTokInfo = instance.tokenizer.getInfo();
    const curEmbMeta = instance.embedding.getProviderMetadata();
    const providerChanged =
      currentTokInfo.name !== state.providerMetadata.tokenizer.name ||
      (curEmbMeta?.name ?? null) !== (state.providerMetadata.embedding?.name ?? null);
    const customPatternsRestored = restoreConfig?.customPatterns
      ? restoreConfig.customPatterns.filter(p => state.customPatternMetadata.some(m => m.name === p.name)).length
      : 0;
    const customPatternsUnmatched = state.customPatternMetadata
      .filter(m => !restoreConfig?.customPatterns?.some(p => p.name === m.name)).length;

    instance.emitter.emit('stateRestored', {
      formatVersion: state.formatVersion,
      segmentCount: instance.store.segmentCount,
      providerChanged,
      customPatternsRestored,
      customPatternsUnmatched,
    });

    return instance;
  }
}

// ─── Serialization Constants ─────────────────────────────────────

const FORMAT_VERSION = 'context-lens-snapshot-v1';

// ─── RestoreConfig ───────────────────────────────────────────────

export interface RestoreConfig {
  capacity?: number;
  tokenizer?: TokenizerProvider | 'approximate';
  embeddingProvider?: EmbeddingProvider | null;
  embeddingProviderMetadata?: EmbeddingProviderMetadata;
  customPatterns?: PatternDefinition[];
}

// ─── Re-exports ─────────────────────────────────────────────────

// All shared types — consumers need these to type method params and return values
export type * from './types.js';

// Error classes — consumers need these for instanceof checks
export {
  ContextLensError,
  ConfigurationError,
  ValidationError,
  SegmentNotFoundError,
  GroupNotFoundError,
  DuplicateIdError,
  InvalidStateError,
  ProtectionError,
  MembershipError,
  CompactionError,
  SplitError,
  RestoreError,
  ProviderError,
  DisposedError,
  DisposalError,
} from './errors.js';

// Event map type — consumers need this for typed event handlers
export type { ContextLensEventMap } from './events.js';

// Types from internal modules used in public method signatures
export type { AddOptions, UpdateChanges, RestoreOptions, CreateGroupOptions, DuplicateSignal } from './segment-store.js';
export type { PlanOptions } from './eviction.js';

// Schema utilities
export { schemas, toJSON, validate, SCHEMA_VERSION } from './schemas/index.js';
export type { ValidationResult, ValidationError as SchemaValidationError } from './schemas/index.js';
