/**
 * Continuity tracker — eviction/compaction cost, restoration fidelity,
 * cumulative ledger, net loss, per-segment and window-level continuity.
 * @see cl-spec-002 §6
 */

import type { ContinuityEvent, ContinuitySummary } from '../types.js';
import { RingBuffer } from '../utils/ring-buffer.js';

// ─── Constants ────────────────────────────────────────────────────

const RECENT_EVENTS_CAPACITY = 10;

// ─── Ledger Entry Types ───────────────────────────────────────────

interface EvictionEntry {
  type: 'eviction';
  segmentId: string;
  cost: number;
  tokenCount: number;
  importance: number;
  relevanceAtEviction: number;
  totalActiveTokensAtEviction: number;
  timestamp: number;
  restored: boolean;
  restorationFidelity: number | null;
}

interface CompactionEntry {
  type: 'compaction';
  segmentId: string;
  cost: number;
  originalTokenCount: number;
  compactedTokenCount: number;
  importance: number;
  redundancy: number;
  timestamp: number;
}

interface RestorationEntry {
  type: 'restoration';
  segmentId: string;
  fidelity: number;
  timestamp: number;
  evictionCostRecovered: number;
}

type LedgerEntry = EvictionEntry | CompactionEntry | RestorationEntry;

// ─── ContinuityTracker ───────────────────────────────────────────

export class ContinuityTracker {
  private readonly ledger: LedgerEntry[] = [];
  private readonly recentEvents = new RingBuffer<ContinuityEvent>(RECENT_EVENTS_CAPACITY);

  // Per-segment continuity overrides (restored or compacted segments)
  private readonly segmentContinuity = new Map<string, number>();

  // Cumulative accumulators
  private totalEvictionLoss = 0;
  private totalCompactionLoss = 0;
  private totalRecovery = 0;

  // Total information ever seen (for window-level denominator)
  private totalInformationValue = 0;
  private totalTokensEverSeen = 0;

  // ── Record Events ─────────────────────────────────────────────

  /**
   * Record an eviction event.
   * @param relevanceAtEviction The segment's relevance score at eviction time.
   * @param totalActiveTokens Total active tokens at the moment of eviction.
   */
  recordEviction(
    segmentId: string,
    tokenCount: number,
    importance: number,
    relevanceAtEviction: number,
    totalActiveTokens: number,
    timestamp: number,
  ): number {
    const tokenFraction = totalActiveTokens > 0 ? tokenCount / totalActiveTokens : 0;
    const cost = relevanceAtEviction * importance * tokenFraction;

    const entry: EvictionEntry = {
      type: 'eviction',
      segmentId,
      cost,
      tokenCount,
      importance,
      relevanceAtEviction,
      totalActiveTokensAtEviction: totalActiveTokens,
      timestamp,
      restored: false,
      restorationFidelity: null,
    };

    this.ledger.push(entry);
    this.totalEvictionLoss += cost;

    this.recentEvents.push({
      type: 'eviction',
      segmentId,
      timestamp,
      tokensBefore: tokenCount,
      tokensAfter: 0,
      cost,
      fidelity: null,
    });

    return cost;
  }

  /**
   * Record a compaction event.
   * @param redundancy The segment's redundancy score (from density scorer).
   */
  recordCompaction(
    segmentId: string,
    originalTokenCount: number,
    compactedTokenCount: number,
    importance: number,
    redundancy: number,
    timestamp: number,
  ): number {
    const compressionRatio = 1.0 - compactedTokenCount / originalTokenCount;
    const cost = compressionRatio * importance * (1.0 - redundancy);

    const entry: CompactionEntry = {
      type: 'compaction',
      segmentId,
      cost,
      originalTokenCount,
      compactedTokenCount,
      importance,
      redundancy,
      timestamp,
    };

    this.ledger.push(entry);
    this.totalCompactionLoss += cost;

    // Compacted segment continuity = 1.0 - cost
    this.segmentContinuity.set(segmentId, Math.max(0, 1.0 - cost));

    this.recentEvents.push({
      type: 'compaction',
      segmentId,
      timestamp,
      tokensBefore: originalTokenCount,
      tokensAfter: compactedTokenCount,
      cost,
      fidelity: null,
    });

    return cost;
  }

  /**
   * Record a restoration event.
   * @param relevanceAfterRestore The segment's relevance after restoration.
   */
  recordRestoration(
    segmentId: string,
    tokenCount: number,
    relevanceAfterRestore: number,
    timestamp: number,
  ): number {
    // Find the original eviction entry
    let evictionEntry: EvictionEntry | undefined;
    for (let i = this.ledger.length - 1; i >= 0; i--) {
      const e = this.ledger[i]!;
      if (e.type === 'eviction' && e.segmentId === segmentId && !e.restored) {
        evictionEntry = e;
        break;
      }
    }

    let fidelity: number;
    let recovered: number;

    if (evictionEntry !== undefined) {
      fidelity = evictionEntry.relevanceAtEviction > 0
        ? Math.min(1.0, relevanceAfterRestore / evictionEntry.relevanceAtEviction)
        : 1.0;
      recovered = evictionEntry.cost * fidelity;
      evictionEntry.restored = true;
      evictionEntry.restorationFidelity = fidelity;
    } else {
      // No matching eviction found — assume full fidelity
      fidelity = 1.0;
      recovered = 0;
    }

    this.totalRecovery += recovered;
    this.segmentContinuity.set(segmentId, fidelity);

    const entry: RestorationEntry = {
      type: 'restoration',
      segmentId,
      fidelity,
      timestamp,
      evictionCostRecovered: recovered,
    };
    this.ledger.push(entry);

    this.recentEvents.push({
      type: 'restoration',
      segmentId,
      timestamp,
      tokensBefore: 0,
      tokensAfter: tokenCount,
      cost: 0,
      fidelity,
    });

    return fidelity;
  }

  /**
   * Track total information value (called when segments become active).
   */
  trackSegmentInfo(importance: number, tokenCount: number): void {
    this.totalInformationValue += importance * tokenCount;
    this.totalTokensEverSeen += tokenCount;
  }

  // ── Scoring ───────────────────────────────────────────────────

  /**
   * Get per-segment continuity score.
   * Never-evicted/never-compacted segments return 1.0.
   */
  getSegmentContinuity(segmentId: string): number {
    return this.segmentContinuity.get(segmentId) ?? 1.0;
  }

  /**
   * Compute window-level continuity.
   * windowContinuity = 1.0 - (netLoss / totalInformationValue), clamped [0, 1].
   */
  getWindowContinuity(): number {
    const netLoss = Math.max(0, this.totalEvictionLoss + this.totalCompactionLoss - this.totalRecovery);
    const normalization = this.totalTokensEverSeen > 0
      ? this.totalInformationValue / this.totalTokensEverSeen
      : 1.0;

    if (normalization <= 0) return 1.0;
    return Math.max(0, Math.min(1, 1.0 - netLoss / normalization));
  }

  // ── Summary ───────────────────────────────────────────────────

  getSummary(): ContinuitySummary {
    let totalEvictions = 0;
    let totalCompactions = 0;
    let totalRestorations = 0;
    let tokensEvicted = 0;
    let tokensCompacted = 0;
    let tokensRestored = 0;

    for (const entry of this.ledger) {
      if (entry.type === 'eviction') {
        totalEvictions++;
        tokensEvicted += entry.tokenCount;
      } else if (entry.type === 'compaction') {
        totalCompactions++;
        tokensCompacted += entry.originalTokenCount - entry.compactedTokenCount;
      } else {
        totalRestorations++;
        // tokensRestored derived from restoration events
        const re = this.recentEvents.toArray().find(
          e => e.type === 'restoration' && e.segmentId === entry.segmentId,
        );
        if (re !== undefined) tokensRestored += re.tokensAfter;
      }
    }

    const netLoss = Math.max(0, this.totalEvictionLoss + this.totalCompactionLoss - this.totalRecovery);

    return {
      totalEvictions,
      totalCompactions,
      totalRestorations,
      netLoss,
      tokensEvicted,
      tokensCompacted,
      tokensRestored,
      recentEvents: this.recentEvents.toArray(),
    };
  }

  getLedger(): ContinuityEvent[] {
    return this.recentEvents.toArray();
  }

  /** @internal Used by fromSnapshot to get internal counters. */
  _getCounters(): { totalEvictionLoss: number; totalCompactionLoss: number; totalRecovery: number; totalInformationValue: number; totalTokensEverSeen: number; segmentContinuity: Record<string, number> } {
    const segCont: Record<string, number> = {};
    for (const [id, val] of this.segmentContinuity) {
      segCont[id] = val;
    }
    return {
      totalEvictionLoss: this.totalEvictionLoss,
      totalCompactionLoss: this.totalCompactionLoss,
      totalRecovery: this.totalRecovery,
      totalInformationValue: this.totalInformationValue,
      totalTokensEverSeen: this.totalTokensEverSeen,
      segmentContinuity: segCont,
    };
  }

  /** @internal Used by fromSnapshot to restore continuity state. */
  _restoreFromSnapshot(
    events: ContinuityEvent[],
    counters: { totalEvictionLoss: number; totalCompactionLoss: number; totalRecovery: number; totalInformationValue: number; totalTokensEverSeen: number; segmentContinuity: Record<string, number> },
  ): void {
    this.totalEvictionLoss = counters.totalEvictionLoss;
    this.totalCompactionLoss = counters.totalCompactionLoss;
    this.totalRecovery = counters.totalRecovery;
    this.totalInformationValue = counters.totalInformationValue;
    this.totalTokensEverSeen = counters.totalTokensEverSeen;
    this.segmentContinuity.clear();
    for (const [id, val] of Object.entries(counters.segmentContinuity)) {
      this.segmentContinuity.set(id, val);
    }
    for (const e of events) {
      this.recentEvents.push({ ...e });
    }
  }
}
