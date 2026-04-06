/**
 * Baseline — capture trigger, snapshot, score normalization.
 * @see cl-spec-002 §7
 */

import type { BaselineSnapshot, WindowScores } from '../types.js';

export class BaselineManager {
  private snapshot: BaselineSnapshot | null = null;
  private hasSeeded = false;
  private hasAdded = false;

  /**
   * Notify that a seed operation occurred. Baseline capture deferred
   * until the first add.
   */
  notifySeed(): void {
    this.hasSeeded = true;
  }

  /**
   * Notify that an add operation is about to occur. If this is the
   * first add, captures the baseline from current raw scores.
   * Returns true if baseline was captured on this call.
   */
  notifyAdd(
    rawScores: WindowScores,
    segmentCount: number,
    tokenCount: number,
    timestamp: number,
  ): boolean {
    if (this.hasAdded && !this.isLateSeeding()) return false;

    this.hasAdded = true;

    // Capture baseline from current state (before the add takes effect)
    this.snapshot = {
      coherence: rawScores.coherence ?? 1.0,
      density: rawScores.density ?? 1.0,
      relevance: rawScores.relevance ?? 1.0,
      continuity: 1.0, // Always 1.0 per invariant 8
      capturedAt: timestamp,
      segmentCount,
      tokenCount,
    };

    return true;
  }

  /**
   * Force a re-baseline (e.g., on late seeding).
   */
  rebaseline(
    rawScores: WindowScores,
    segmentCount: number,
    tokenCount: number,
    timestamp: number,
  ): void {
    this.snapshot = {
      coherence: rawScores.coherence ?? 1.0,
      density: rawScores.density ?? 1.0,
      relevance: rawScores.relevance ?? 1.0,
      continuity: 1.0,
      capturedAt: timestamp,
      segmentCount,
      tokenCount,
    };
  }

  /**
   * Check if a late seeding is occurring (seeds after adds).
   */
  isLateSeeding(): boolean {
    return this.hasAdded && this.hasSeeded;
  }

  /**
   * Whether a baseline has been captured.
   */
  isEstablished(): boolean {
    return this.snapshot !== null;
  }

  getSnapshot(): BaselineSnapshot | null {
    return this.snapshot !== null ? { ...this.snapshot } : null;
  }

  /**
   * Normalize raw window scores against the baseline.
   * Returns null if baseline not yet established.
   * Each dimension: clamp(raw / baseline, 0, 1).
   */
  normalize(raw: WindowScores): WindowScores | null {
    if (this.snapshot === null) return null;

    return {
      coherence: raw.coherence !== null
        ? clampNorm(raw.coherence, this.snapshot.coherence)
        : null,
      density: raw.density !== null
        ? clampNorm(raw.density, this.snapshot.density)
        : null,
      relevance: raw.relevance !== null
        ? clampNorm(raw.relevance, this.snapshot.relevance)
        : null,
      continuity: raw.continuity !== null
        ? clampNorm(raw.continuity, this.snapshot.continuity)
        : null,
    };
  }

  /**
   * Restore from a serialized snapshot.
   */
  restoreSnapshot(snapshot: BaselineSnapshot): void {
    this.snapshot = { ...snapshot };
    this.hasSeeded = true;
    this.hasAdded = true;
  }
}

function clampNorm(current: number, baseline: number): number {
  if (baseline <= 0) return current > 0 ? 1.0 : 0.0;
  return Math.max(0, Math.min(1, current / baseline));
}
