/**
 * Type-safe synchronous event emitter with re-entrancy guard and error swallowing.
 * @see cl-spec-007 §9
 */

import type {
  Segment,
  Group,
  TaskTransition,
  ActivePattern,
  BaselineSnapshot,
  QualityReport,
  EvictionRecord,
  CompactionRecord,
  PatternName,
  Severity,
} from './types.js';

// ─── Lifecycle Event (cl-spec-015 §7.1) ───────────────────────────

/**
 * Emitted exactly once during step 2 of teardown — the final event an instance
 * ever emits. Payload is constructed once, frozen, and shared across handlers.
 * @see cl-spec-015 §7.1
 */
export type StateDisposedEvent = {
  readonly type: 'stateDisposed';
  readonly instanceId: string;
  readonly timestamp: number;
};

// ─── Event Map ────────────────────────────────────────────────────

export interface ContextLensEventMap {
  segmentAdded: { segment: Segment };
  segmentUpdated: { segment: Segment; changes: string[] };
  segmentReplaced: { segment: Segment; previousTokenCount: number };
  segmentCompacted: { segment: Segment; record: CompactionRecord };
  segmentSplit: { originalId: string; children: Segment[] };
  segmentEvicted: { record: EvictionRecord };
  segmentRestored: { segment: Segment; fidelity: number };
  groupCreated: { group: Group };
  groupDissolved: { groupId: string; memberIds: string[] };
  taskChanged: { transition: TaskTransition };
  taskCleared: Record<string, never>;
  tokenizerChanged: { oldName: string; newName: string };
  embeddingProviderChanged: { oldName: string | null; newName: string | null };
  capacityChanged: { oldCapacity: number; newCapacity: number };
  baselineCaptured: { baseline: BaselineSnapshot };
  lateSeeding: { segmentCount: number };
  pinnedCeilingWarning: { pinnedTokens: number; capacity: number; ratio: number };
  patternActivated: { pattern: ActivePattern };
  patternResolved: { name: PatternName; duration: number; peakSeverity: Severity };
  customPatternRegistered: { name: string; description: string };
  stateSnapshotted: { timestamp: number; restorable: boolean; segmentCount: number; sizeEstimate: number };
  stateRestored: { formatVersion: string; segmentCount: number; providerChanged: boolean; customPatternsRestored: number; customPatternsUnmatched: number };
  reportGenerated: { report: QualityReport };
  budgetViolation: { operation: string; selfTime: number; budgetTarget: number };
  stateDisposed: StateDisposedEvent;
}

// ─── Emitter ──────────────────────────────────────────────────────

type Handler<T> = (payload: T) => void;

export class EventEmitter<TMap> {
  private readonly handlers = new Map<keyof TMap, Set<Handler<never>>>();
  private emitting = false;

  on<E extends keyof TMap>(event: E, handler: Handler<TMap[E]>): () => void {
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);

    return () => {
      set!.delete(handler as Handler<never>);
    };
  }

  once<E extends keyof TMap>(event: E, handler: Handler<TMap[E]>): () => void {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  emit<E extends keyof TMap>(event: E, payload: TMap[E]): void {
    if (this.emitting) {
      console.warn(`[context-lens] Re-entrant emit detected for event "${String(event)}"`);
    }

    const set = this.handlers.get(event);
    if (set === undefined || set.size === 0) return;

    this.emitting = true;
    try {
      for (const handler of set) {
        try {
          (handler as Handler<TMap[E]>)(payload);
        } catch {
          // Handler errors are swallowed per spec 07 §9.3
        }
      }
    } finally {
      this.emitting = false;
    }
  }

  /**
   * Dispatch identical to `emit` except per-handler thrown values are pushed
   * onto `errorLog` instead of being swallowed. Used exclusively by the
   * teardown orchestrator for `stateDisposed` (cl-spec-015 §4.3); every
   * other event uses `emit` and retains the swallow-and-log contract of
   * cl-spec-007 §9.3.
   * @see cl-spec-015 §4.3
   */
  emitCollect<E extends keyof TMap>(event: E, payload: TMap[E], errorLog: unknown[]): void {
    if (this.emitting) {
      console.warn(`[context-lens] Re-entrant emit detected for event "${String(event)}"`);
    }

    const set = this.handlers.get(event);
    if (set === undefined || set.size === 0) return;

    this.emitting = true;
    try {
      for (const handler of set) {
        try {
          (handler as Handler<TMap[E]>)(payload);
        } catch (error) {
          errorLog.push(error);
        }
      }
    } finally {
      this.emitting = false;
    }
  }
}
