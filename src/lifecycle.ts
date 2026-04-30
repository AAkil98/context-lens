/**
 * Internal lifecycle infrastructure for cl-spec-015.
 *
 * Owns the IntegrationRegistry, the read-only-method classification, and the
 * disposed-state guard. Imports only types/errors/events — does not import
 * index.ts, fleet.ts, or otel.ts (the registry receives anonymous callbacks;
 * it knows nothing about the integrations that register them).
 *
 * @see cl-spec-015 §3, §4, §6
 * @internal
 */

import { DisposedError } from './errors.js';
import type { IntegrationTeardown, IntegrationHandle, LifecycleState } from './types.js';

interface IntegrationEntry<T> {
  readonly callback: IntegrationTeardown<T>;
  detached: boolean;
}

/**
 * Per-instance registry of integration teardown callbacks. Single-threaded
 * and synchronous; owned by exactly one ContextLens instance and not shared.
 *
 * Detach is flag-based, not splice-based — invokeAll skips entries whose flag
 * is set. This keeps detach O(1) and makes the registry safe against
 * detach-during-iteration if a teardown callback unhooks a sibling
 * integration before the sibling's callback runs.
 *
 * @see cl-spec-015 §4.1, §6.2
 */
export class IntegrationRegistry<T = unknown> {
  private readonly entries: IntegrationEntry<T>[] = [];

  attach(callback: IntegrationTeardown<T>): IntegrationHandle {
    const entry: IntegrationEntry<T> = { callback, detached: false };
    this.entries.push(entry);
    return {
      detach: () => { entry.detached = true; },
    };
  }

  invokeAll(instance: T, errorLog: unknown[]): void {
    for (const entry of this.entries) {
      if (entry.detached) continue;
      try {
        entry.callback(instance);
      } catch (error) {
        errorLog.push(error);
      }
    }
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** Number of attached, non-detached integrations. */
  get size(): number {
    let count = 0;
    for (const entry of this.entries) {
      if (!entry.detached) count++;
    }
    return count;
  }
}

// ─── Read-only method classification (impl-spec I-06 §4.1.3) ──────

/**
 * Public methods on ContextLens whose disposed-state guard fires only on
 * `state === 'disposed'`. Mutating methods (everything not in this set)
 * additionally throw while `state === 'disposing'`.
 *
 * 20 names: 12 unchanged from cl-spec-015 §3.4, the `getEvictionHistory →
 * getEvictedSegments` reconciliation, and 7 audit-added entries from the
 * concrete v0.1.0 public surface (impl-spec I-06 §4.1.3).
 *
 * @see cl-spec-015 §3.4
 * @internal
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  // From cl-spec-015 §3.4 (12 unchanged + 1 reconciled)
  'getCapacity',
  'getSegment',
  'listSegments',
  'getSegmentCount',
  'listGroups',
  'getGroup',
  'getTask',
  'getTaskState',
  'getDiagnostics',
  'assess',
  'planEviction',
  'snapshot',
  'getEvictedSegments',  // reconciled: spec says `getEvictionHistory`, code uses `getEvictedSegments`
  // Audit additions (T6)
  'getTokenizerInfo',
  'getEmbeddingProviderInfo',
  'getBaseline',
  'getConstructionTimestamp',
  'getConfig',
  'getPerformance',
  'getDetection',
]);

// ─── Disposed-state guard (impl-spec I-06 §4.1.4) ──────────────────

/**
 * Throws `DisposedError` if the call is forbidden under the current lifecycle
 * state. Called as the first statement of every public method on ContextLens
 * (except the four always-valid surfaces `dispose`, `isDisposed`,
 * `isDisposing`, `instanceId`).
 *
 * Behavior:
 * - `state === 'disposed'`: throws regardless of method name.
 * - `state === 'disposing'` and method not in `READ_ONLY_METHODS`: throws.
 * - Otherwise: returns.
 *
 * @see cl-spec-015 §3.4, §5.1
 * @internal
 */
export function guardDispose(
  state: LifecycleState,
  methodName: string,
  instanceId: string,
): void {
  if (state === 'disposed') {
    throw new DisposedError(instanceId, methodName, 'disposed');
  }
  if (state === 'disposing' && !READ_ONLY_METHODS.has(methodName)) {
    throw new DisposedError(instanceId, methodName, 'disposing');
  }
}
