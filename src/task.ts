/**
 * Task identity — descriptor model, validation, normalization, transitions,
 * grace period, staleness, history.
 * @see cl-spec-004
 */

import type {
  TaskDescriptor,
  TaskTransition,
  TaskState,
  TaskSummary,
  TransitionEntry,
  TransitionType,
} from './types.js';
import { ValidationError } from './errors.js';
import type { SimilarityEngine } from './similarity.js';
import type { EmbeddingEngine } from './embedding.js';
import { fnv1a } from './utils/hash.js';
import { RingBuffer } from './utils/ring-buffer.js';
import { deepCopy } from './utils/copy.js';

// ─── Constants ────────────────────────────────────────────────────

const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_KEYWORDS = 50;
const GRACE_PERIOD_REPORTS = 2;
const STALENESS_THRESHOLD = 5;
const HISTORY_CAPACITY = 20;
const DESCRIPTION_TRUNCATE = 200;

// ─── Validation & Normalization ───────────────────────────────────

function validateDescriptor(desc: TaskDescriptor): void {
  if (typeof desc.description !== 'string' || desc.description.trim().length === 0) {
    throw new ValidationError('Task description must be a non-empty string');
  }
  if (desc.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `Task description exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
      { length: desc.description.length },
    );
  }
  if (desc.keywords !== undefined) {
    for (const kw of desc.keywords) {
      if (typeof kw !== 'string' || kw.length === 0) {
        throw new ValidationError('Keywords must be non-empty strings');
      }
    }
  }
  if (desc.relatedOrigins !== undefined) {
    for (const o of desc.relatedOrigins) {
      if (typeof o !== 'string' || o.length === 0) {
        throw new ValidationError('Related origins must be non-empty strings');
      }
    }
  }
  if (desc.relatedTags !== undefined) {
    for (const t of desc.relatedTags) {
      if (typeof t !== 'string' || t.length === 0) {
        throw new ValidationError('Related tags must be non-empty strings');
      }
    }
  }
}

function normalizeDescriptor(desc: TaskDescriptor): TaskDescriptor {
  const description = desc.description.trim().replace(/\s+/g, ' ');

  // Case-insensitive dedup keywords, keep first occurrence casing
  let keywords: string[] | undefined;
  if (desc.keywords !== undefined && desc.keywords.length > 0) {
    const seen = new Set<string>();
    keywords = [];
    for (const kw of desc.keywords) {
      const lower = kw.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        keywords.push(kw);
      }
    }
    if (keywords.length > MAX_KEYWORDS) {
      throw new ValidationError(
        `Too many keywords after dedup: ${keywords.length} > ${MAX_KEYWORDS}`,
        { count: keywords.length },
      );
    }
    keywords.sort();
  }

  // Case-sensitive dedup + sort for origins and tags
  let relatedOrigins: string[] | undefined;
  if (desc.relatedOrigins !== undefined && desc.relatedOrigins.length > 0) {
    relatedOrigins = [...new Set(desc.relatedOrigins)].sort();
  }

  let relatedTags: string[] | undefined;
  if (desc.relatedTags !== undefined && desc.relatedTags.length > 0) {
    relatedTags = [...new Set(desc.relatedTags)].sort();
  }

  const result: TaskDescriptor = { description };
  if (keywords !== undefined) result.keywords = keywords;
  if (relatedOrigins !== undefined) result.relatedOrigins = relatedOrigins;
  if (relatedTags !== undefined) result.relatedTags = relatedTags;
  return result;
}

function descriptorsEqual(a: TaskDescriptor, b: TaskDescriptor): boolean {
  if (a.description !== b.description) return false;
  if (!arraysEqual(a.keywords, b.keywords)) return false;
  if (!arraysEqual(a.relatedOrigins, b.relatedOrigins)) return false;
  if (!arraysEqual(a.relatedTags, b.relatedTags)) return false;
  return true;
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function truncateDesc(desc: string): string {
  return desc.length <= DESCRIPTION_TRUNCATE
    ? desc
    : desc.substring(0, DESCRIPTION_TRUNCATE);
}

// ─── TaskManager ──────────────────────────────────────────────────

export class TaskManager {
  private currentTask: TaskDescriptor | null = null;
  private previousTask: TaskDescriptor | null = null;
  private taskSetAt: number | null = null;
  private transitionCount = 0;
  private changeCount = 0;
  private refinementCount = 0;
  private reportsSinceSet = 0;
  private reportsSinceTransition = 0;
  private lastTransition: TaskTransition | null = null;
  private gracePeriodActive = false;
  private gracePeriodRemaining = 0;
  private readonly history = new RingBuffer<TransitionEntry>(HISTORY_CAPACITY);
  private readonly refinementThreshold: number;

  // Content hash of current task description (for similarity)
  private currentDescHash: number | null = null;

  constructor(refinementThreshold = 0.7) {
    if (refinementThreshold < 0.1 || refinementThreshold > 0.95) {
      throw new ValidationError(
        'Refinement threshold must be in [0.1, 0.95]',
        { refinementThreshold },
      );
    }
    this.refinementThreshold = refinementThreshold;
  }

  /**
   * Set the current task. Returns the transition classification.
   * Optionally embeds the description via the embedding engine.
   */
  async setTask(
    descriptor: TaskDescriptor,
    similarity: SimilarityEngine,
    embedding: EmbeddingEngine | null,
  ): Promise<TaskTransition> {
    validateDescriptor(descriptor);
    const normalized = normalizeDescriptor(descriptor);
    const now = Date.now();
    const descHash = fnv1a(normalized.description);

    let type: TransitionType;
    let sim: number | undefined;

    if (this.currentTask === null) {
      // First task
      type = 'new';
    } else if (descriptorsEqual(this.currentTask, normalized)) {
      // Same task — reset staleness only
      type = 'same';
      this.reportsSinceSet = 0;
      this.reportsSinceTransition = 0;

      const transition: TaskTransition = {
        type,
        previousTask: deepCopy(this.currentTask),
      };
      this.lastTransition = transition;
      this.transitionCount++;
      return transition;
    } else if (this.currentTask.description === normalized.description) {
      // Same description, different metadata → refinement
      type = 'refinement';
      sim = 1.0;
    } else {
      // Compute description similarity
      sim = similarity.computeSimilarity(
        this.currentDescHash!,
        this.currentTask.description,
        descHash,
        normalized.description,
      );
      type = sim >= this.refinementThreshold ? 'refinement' : 'change';
    }

    // Build transition
    const transition: TaskTransition = {
      type,
      previousTask: this.currentTask !== null ? deepCopy(this.currentTask) : null,
    };
    if (sim !== undefined) {
      transition.similarity = sim;
    }

    // Record in history (same-task already returned above)
    const entry: TransitionEntry = {
      type: type as 'new' | 'refinement' | 'change',
      timestamp: now,
    };
    if (sim !== undefined) entry.similarity = sim;
    if (this.currentTask !== null) {
      entry.previousDescription = truncateDesc(this.currentTask.description);
    }
    entry.newDescription = truncateDesc(normalized.description);
    this.history.push(entry);

    // Update state
    this.previousTask = this.currentTask;
    this.currentTask = deepCopy(normalized);
    this.currentDescHash = descHash;
    this.taskSetAt = now;
    this.transitionCount++;
    this.reportsSinceSet = 0;
    this.reportsSinceTransition = 0;
    this.lastTransition = transition;

    if (type === 'change') {
      this.changeCount++;
      // Activate/restart grace period
      this.gracePeriodActive = true;
      this.gracePeriodRemaining = GRACE_PERIOD_REPORTS;
    } else if (type === 'refinement') {
      this.refinementCount++;
      // Refinement does NOT activate grace, does NOT cancel active grace
    }
    // 'new' does not activate grace period

    // Prepare (embed/trigram) the task description
    if (embedding !== null && (type === 'new' || type === 'change' || type === 'refinement')) {
      await embedding.prepare(descHash, normalized.description);
    }

    return transition;
  }

  /**
   * Clear the current task. Returns to 'unset' state.
   */
  clearTask(): TaskTransition {
    const transition: TaskTransition = {
      type: 'clear',
      previousTask: this.currentTask !== null ? deepCopy(this.currentTask) : null,
    };

    if (this.currentTask !== null) {
      const entry: TransitionEntry = {
        type: 'clear',
        timestamp: Date.now(),
      };
      entry.previousDescription = truncateDesc(this.currentTask.description);
      this.history.push(entry);
    }

    this.previousTask = this.currentTask;
    this.currentTask = null;
    this.currentDescHash = null;
    this.taskSetAt = null;
    this.transitionCount++;
    this.reportsSinceSet = 0;
    this.reportsSinceTransition = 0;
    this.lastTransition = transition;
    this.gracePeriodActive = false;
    this.gracePeriodRemaining = 0;

    return transition;
  }

  /**
   * Called on each quality report. Ticks grace period and staleness.
   */
  tickReport(): void {
    this.reportsSinceSet++;
    this.reportsSinceTransition++;

    if (this.gracePeriodActive) {
      this.gracePeriodRemaining--;
      if (this.gracePeriodRemaining <= 0) {
        this.gracePeriodActive = false;
        this.gracePeriodRemaining = 0;
      }
    }
  }

  // ── Queries ─────────────────────────────────────────────────────

  getCurrentTask(): TaskDescriptor | null {
    return this.currentTask !== null ? deepCopy(this.currentTask) : null;
  }

  getCurrentDescHash(): number | null {
    return this.currentDescHash;
  }

  getState(): TaskState {
    return {
      state: this.currentTask !== null ? 'active' : 'unset',
      currentTask: this.currentTask !== null ? deepCopy(this.currentTask) : null,
      previousTask: this.previousTask !== null ? deepCopy(this.previousTask) : null,
      taskSetAt: this.taskSetAt,
      transitionCount: this.transitionCount,
      changeCount: this.changeCount,
      refinementCount: this.refinementCount,
      reportsSinceSet: this.reportsSinceSet,
      reportsSinceTransition: this.reportsSinceTransition,
      lastTransition: this.lastTransition,
      stale: this.currentTask !== null && this.reportsSinceSet >= STALENESS_THRESHOLD,
      gracePeriodActive: this.gracePeriodActive,
      gracePeriodRemaining: this.gracePeriodRemaining,
      transitionHistory: this.history.toArray(),
    };
  }

  getSummary(): TaskSummary {
    return {
      state: this.currentTask !== null ? 'active' : 'unset',
      stale: this.currentTask !== null && this.reportsSinceSet >= STALENESS_THRESHOLD,
      gracePeriodActive: this.gracePeriodActive,
      gracePeriodRemaining: this.gracePeriodRemaining,
    };
  }

  isStale(): boolean {
    return this.currentTask !== null && this.reportsSinceSet >= STALENESS_THRESHOLD;
  }

  isActive(): boolean {
    return this.currentTask !== null;
  }
}
