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

import { DisposedError, tagOrigin } from './errors.js';
import type { EventEmitter, ContextLensEventMap, StateDisposedEvent } from './events.js';
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

// ─── Teardown orchestrator (impl-spec I-06 §4.1.5) ─────────────────

/**
 * Runtime context passed to {@link runTeardown}. Every field is supplied by
 * the owning ContextLens instance; the orchestrator itself is stateless.
 *
 * @internal
 */
export interface TeardownContext<T = unknown> {
  /** Setter that mutates the lifecycle state on the owning instance. */
  setState: (state: LifecycleState) => void;
  /** Live event emitter — dispatched via `emitCollect` for `stateDisposed`. */
  emitter: EventEmitter<ContextLensEventMap>;
  /** Live integration registry — `invokeAll` is called in step 3. */
  integrations: IntegrationRegistry<T>;
  /** Callback that clears the instance's owned resources during step 4. */
  clearResources: () => void;
  /** Instance reference passed to integration teardown callbacks in step 3. */
  instance: T;
  /**
   * Factory that produces the frozen `stateDisposed` payload. Invoked once,
   * by the orchestrator, at the entry to step 2 — so the timestamp is
   * captured precisely at the moment the event fires.
   */
  payloadFactory: () => StateDisposedEvent;
}

/**
 * Execute the six-step teardown sequence from cl-spec-015 §4.1 in fixed order.
 * Returns the per-call disposal error log; the caller (`ContextLens.dispose`)
 * inspects it and throws `DisposalError` if non-empty.
 *
 * Steps:
 * 1. setState('disposing') — disposing flag set; mutating methods now throw.
 * 2. emitter.emitCollect('stateDisposed', payload, errorLog) — handler errors
 *    are tagged with origin='handler' before remaining in the log.
 * 3. integrations.invokeAll(instance, errorLog) — integration teardown
 *    callback errors are tagged with origin='integration'.
 * 4. clearResources() — library-internal; cannot fail.
 * 5. emitter.removeAllListeners() + integrations.clear() — registry detachment.
 * 6. setState('disposed') — single commit point.
 *
 * Library-internal steps (1, 4, 5, 6) are infallible by construction. Caller-
 * supplied callback errors in steps 2 and 3 are absorbed and aggregated; they
 * never abort teardown.
 *
 * @see cl-spec-015 §4.1, §4.3
 * @internal
 */
export function runTeardown<T>(ctx: TeardownContext<T>): unknown[] {
  const errorLog: unknown[] = [];

  // Step 1: set the disposing flag (mutating methods now throw via guardDispose).
  ctx.setState('disposing');

  // Step 2: emit stateDisposed; tag handler errors with origin='handler'.
  const handlerStart = errorLog.length;
  const payload = ctx.payloadFactory();
  ctx.emitter.emitCollect('stateDisposed', payload, errorLog);
  for (let i = handlerStart; i < errorLog.length; i++) {
    errorLog[i] = tagOrigin(errorLog[i], 'handler', i - handlerStart);
  }

  // Step 3: invoke integration teardown callbacks; tag errors with origin='integration'.
  const integrationStart = errorLog.length;
  ctx.integrations.invokeAll(ctx.instance, errorLog);
  for (let i = integrationStart; i < errorLog.length; i++) {
    errorLog[i] = tagOrigin(errorLog[i], 'integration', i - integrationStart);
  }

  // Step 4: clear instance-owned resources (library-internal; infallible).
  ctx.clearResources();

  // Step 5: detach handler registry; clear integration registry.
  ctx.emitter.removeAllListeners();
  ctx.integrations.clear();

  // Step 6: set the disposed flag — single commit point of the lifecycle.
  ctx.setState('disposed');

  return errorLog;
}
