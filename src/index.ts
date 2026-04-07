/**
 * ContextLens — public API surface for context window quality monitoring.
 * @see cl-spec-007
 */

import type {
  Segment,
  Group,
  ProtectionLevel,
  TokenizerProvider,
  EmbeddingProvider,
  EmbeddingProviderMetadata,
  CapacityReport,
  QualityReport,
  EvictionRecord,
  PatternDefinition,
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
import { EvictionAdvisory } from './eviction.js';
import { PerformanceInstrumentation } from './performance.js';
import { ContinuityTracker } from './scoring/continuity.js';
import { BaselineManager } from './scoring/baseline.js';
import { deepCopy } from './utils/copy.js';
import { fnv1a } from './utils/hash.js';

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

  // ── Instance state ──────────────────────────────────────────
  private readonly constructionTimestamp: number;
  private readonly configSnapshot: ContextLensConfig;
  private capacity: number;
  private qualityCacheValid = false;
  private cachedReport: QualityReport | null = null;
  private seeded = false;
  private hasAdds = false;

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

    // Step 14: Set up embedding provider if provided
    if (config.embeddingProvider != null) {
      // Synchronous setup — actual embedding prep happens lazily
      // Provider is set but embeddings are computed on demand during assess()
    }
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

  /** Batch insert seed segments. Protection defaults to 'seed'. */
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
    return results;
  }

  /** Add a single segment. Returns Segment on success, DuplicateSignal on auto-ID collision. */
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

    // Prepare embedding
    const hash = fnv1a(content);
    this.embedding.prepare(hash, content).catch(() => { /* fail-silent */ });

    return deepCopy(result);
  }

  /** Update segment metadata and/or content in place. */
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
    return deepCopy(result);
  }

  /** Replace segment content entirely. */
  replace(id: string, newContent: string, options?: Partial<Pick<AddOptions, 'importance' | 'origin' | 'tags'>>): Segment {
    const opts = options !== undefined ? deepCopy(options) : undefined;
    const result = this.store.replace(id, newContent, opts);

    // Recompute embedding
    const hash = fnv1a(newContent);
    this.embedding.prepare(hash, newContent).catch(() => { /* fail-silent */ });
    this.similarity.invalidateContentHash(hash);

    this.qualityCacheValid = false;
    return deepCopy(result);
  }

  /** Compact segment by replacing with shorter summary. */
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
    return deepCopy(result);
  }

  /** Split a segment into multiple children via user-provided function. */
  split(id: string, splitFn: (content: string) => string[]): Segment[] {
    const results = this.store.split(id, splitFn);

    // Prepare embeddings for children
    for (const child of results) {
      const hash = fnv1a(child.content);
      this.embedding.prepare(hash, child.content).catch(() => { /* fail-silent */ });
    }

    this.qualityCacheValid = false;
    return results.map(s => deepCopy(s));
  }

  /** Evict a segment (or entire group if grouped). */
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
    const copied = records.map(r => deepCopy(r));
    return copied.length === 1 ? copied[0]! : copied;
  }

  /** Restore an evicted segment (or entire group). */
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
    const copied = results.map(s => deepCopy(s));
    return copied.length === 1 ? copied[0]! : copied;
  }

  // ── Group Operations ────────────────────────────────────────────

  /** Create a group from existing active segments. */
  createGroup(groupId: string, segmentIds: string[], options?: CreateGroupOptions): Group {
    const opts = options !== undefined ? deepCopy(options) : undefined;
    const result = this.store.createGroup(groupId, segmentIds, opts);
    return deepCopy(result);
  }

  /** Dissolve a group, keeping members as individual segments. */
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

  /** Subscribe to an event. Returns unsubscribe function. */
  on<E extends keyof ContextLensEventMap>(
    event: E,
    handler: (payload: ContextLensEventMap[E]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  // ── Internal Accessors (expanded in Task 4.2) ───────────────────

  /** @internal Expose internals for Task 4.2 wiring — will be replaced with public methods. */
  _getInternals() {
    return {
      detection: this.detection,
      evictionAdvisory: this.evictionAdvisory,
      perf: this.perf,
      constructionTimestamp: this.constructionTimestamp,
      configSnapshot: this.configSnapshot,
      qualityCacheValid: this.qualityCacheValid,
      cachedReport: this.cachedReport,
    };
  }

  // ── Internal Helpers ────────────────────────────────────────────

  private computeCapacity(): CapacityReport {
    return this.tokenizer.computeCapacity(
      this.capacity,
      this.store.getActiveSegmentIterator(),
    );
  }

  private captureBaseline(): void {
    // Build a quick assessment context to get raw scores for baseline
    const segments = this.store.getOrderedActiveSegments();
    if (segments.length === 0) return;

    const capacity = this.computeCapacity();
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

    const ctx: AssessmentContext = {
      orderedSegments: scoringSegments,
      groups,
      capacity,
      tokenizerMetadata: this.tokenizer.getInfo(),
    };

    // This triggers baseline capture inside the assembler
    const report = this.reportAssembler.assess(ctx);
    if (report.baseline !== null) {
      this.emitter.emit('baselineCaptured', { baseline: deepCopy(report.baseline) });
    }
    this.cachedReport = report;
    this.qualityCacheValid = true;
  }
}
