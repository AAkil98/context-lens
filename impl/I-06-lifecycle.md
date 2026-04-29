# Phase 6 -- Instance Lifecycle (dispose)

## 1. Preamble

Phase 6 implements the explicit terminal state defined by `cl-spec-015`. Before this phase, a `ContextLens` instance can only be released by garbage collection — and in long-lived processes, the back-references held by event handlers, fleet aggregators, and OpenTelemetry exporters mean GC effectively never runs. Phase 6 adds `dispose()`, `isDisposed`, `isDisposing`, the `stateDisposed` event, two new error types, and a small integration registry that lets `ContextLensFleet` and `ContextLensExporter` participate in teardown. After Phase 6, long-lived callers can release every resource a live instance held without restarting the process.

**Design specs covered:**
- `cl-spec-015` (Instance Lifecycle) -- two-state lifecycle, `dispose()` contract, six-step teardown sequence, retry contract, post-disposal behavior, integration callbacks, providers
- `cl-spec-007` (API Surface) §9 (Lifecycle), §10.2 (`stateDisposed` event), §10.3 (handler-contract deviation), §11.1 (`DisposedError`, `DisposalError`)
- `cl-spec-012` (Fleet Monitor) §7 (Instance Disposal Handling) -- per-fleet teardown callback, `instanceDisposed` event, auto-unregister
- `cl-spec-013` (Observability Export) §2.1 (Lifecycle) -- per-exporter teardown callback, `context_lens.instance.disposed` log event
- `cl-spec-014` (Serialization) §3.4 -- snapshot-then-dispose continuation pattern

**Performance budget:** `cl-spec-009` -- `dispose()` is a one-shot operation; not part of the hot-path tiers. Target: < 10 ms for a 500-segment instance, dominated by cache and ring-buffer clearing. `isDisposed` and `isDisposing` getters are < 1 µs (Tier 1, well under the 1 ms query budget).

**Key resolutions referenced:**
- GD-01: Read-only-during-disposal rule. Mutating public methods throw `DisposedError` while `isDisposing === true`; read-only methods continue to behave per their live specification until the disposed flag is set.
- GD-02: Two getters. `isDisposed` flips on success-path completion of `dispose()`; `isDisposing` flips on entry to `dispose()` and clears on exit. Mutually exclusive.
- GD-03: Unsubscribe handle is no-op on disposed instance via the intrinsically idempotent contract (the registry is detached, so the handler is not-present, so the no-op branch fires).
- Friction #4 resolution: `stateDisposed` handlers and integration teardown callbacks are stricter than the general handler contract in cl-spec-007 §10.3 (mutations throw rather than being undefined; errors aggregate into `DisposalError` rather than swallow-and-log).

**Parent document:** `IMPLEMENTATION.md` (Phase 6 row to be added in section 5; new module appears in section 4 dependency graph).

---

## 2. Module Map

| Module | Primary design spec | Responsibility |
|--------|---------------------|----------------|
| `lifecycle.ts` | cl-spec-015 §3, §4, §6 | Lifecycle state machine, `IntegrationRegistry`, read-only-vs-mutating method classification, six-step teardown orchestrator. Internal to the package; not re-exported. |
| `errors.ts` (modified) | cl-spec-015 §7.2 | Adds `DisposedError extends Error` and `DisposalError extends AggregateError`. Both bypass `ContextLensError` per cl-spec-015 §7.2 (need native-class inheritance, particularly `AggregateError`). |
| `events.ts` (modified) | cl-spec-015 §7.1 | Adds `stateDisposed` to the event map with payload `{ type, instanceId, timestamp }`. The emitter catalog grows from 24 to 25 events. |
| `index.ts` (ContextLens, modified) | cl-spec-015 §3, §5 | Adds `dispose()`, `isDisposed`, `isDisposing`, `instanceId`. Adds the disposed-state guard to every existing public method. Owns the integration registry. |
| `fleet.ts` (modified) | cl-spec-012 §7 | `register()` attaches a teardown callback to the instance via the registry. Adds `instanceDisposed` event. Auto-unregister fires on instance disposal. |
| `otel.ts` (modified) | cl-spec-013 §2.1.2 | Constructor attaches a teardown callback. Adds `context_lens.instance.disposed` log event. `disconnect()` and auto-disconnect converge on the same end state. |

No new types module: the new types (`DisposedError`, `DisposalError`, `StateDisposedEvent`, `InstanceDisposedEvent`, OTel `instance.disposed` payload) live in their owning modules and are re-exported from the package's main entry.

---

## 3. Dependency Direction

```
                     ┌──────────────────────┐
                     │  index.ts            │  (ContextLens)
                     │  + dispose orchestr. │
                     └──────────┬───────────┘
                                │ owns
                                v
                     ┌──────────────────────┐
                     │  lifecycle.ts        │  IntegrationRegistry,
                     │                      │  read/mutate classifier,
                     │                      │  teardown step ordering
                     └──────────────────────┘
                                ^
                                │ attaches via
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
        ┌──────────┐                       ┌──────────┐
        │ fleet.ts │                       │  otel.ts │
        └──────────┘                       └──────────┘
```

`lifecycle.ts` imports only from `types.ts`, `errors.ts`, and `events.ts`. It does **not** import `index.ts`, `fleet.ts`, or `otel.ts` -- the integration registry receives anonymous callbacks; it knows nothing about the integrations that register them.

`fleet.ts` and `otel.ts` import the integration-registration entry from `index.ts` (a narrow public method on `ContextLens`) and the lifecycle types from `types.ts`. They do not import `lifecycle.ts` directly.

No upward imports. No circular imports.

---

## 4. Module Specifications

### 4.1 lifecycle.ts

The lifecycle module is internal infrastructure. It exposes no public API; `index.ts` consumes it directly.

#### 4.1.1 Types

```ts
export type IntegrationTeardown = (instance: ContextLens) => void;

export type IntegrationHandle = {
  detach(): void;
};

export type LifecycleState = 'live' | 'disposing' | 'disposed';
```

`IntegrationTeardown` is the callback invoked during step 3 of teardown. It receives the live instance (so it can perform read-only inspection per cl-spec-015 §6.2) and returns `void`. Throwing is allowed and absorbed; the disposal log accumulates the error.

`IntegrationHandle.detach` removes the callback from the registry without firing it. Used by explicit `fleet.unregister` and `exporter.disconnect` paths.

#### 4.1.2 IntegrationRegistry class

```ts
export class IntegrationRegistry {
  attach(callback: IntegrationTeardown): IntegrationHandle;
  invokeAll(instance: ContextLens, errorLog: unknown[]): void;
  clear(): void;
  get size(): number;
}
```

- **`attach`** appends the callback to an internal array, returns a handle whose `detach()` removes it. Detachment is O(N) with N = number of registered integrations; integrations attach once per instance, so N is small (typically 0–2 in practice).
- **`invokeAll`** iterates the array in registration order. Each callback runs inside `try/catch`; thrown values are pushed onto `errorLog`. Iteration does not abort on a caught error. Callbacks already detached (via their handle) before `invokeAll` runs are skipped — the registry checks each entry's `detached` flag.
- **`clear`** drops all references after iteration completes (step 3 → step 5 transition; combined with the emitter detachment, this releases all back-references the instance holds to integrations).
- **`size`** is used by the diagnostics module to surface the integration count.

The registry is single-threaded and synchronous; no concurrency guards. It is owned by exactly one `ContextLens` instance and not shared.

#### 4.1.3 Read-only method classification

```ts
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'getCapacity', 'getSegment', 'listSegments', 'getSegmentCount',
  'listGroups', 'getGroup',
  'getTask', 'getTaskState',
  'getDiagnostics', 'assess', 'planEviction', 'snapshot',
  'getEvictionHistory',
]);
```

Any public method on `ContextLens` not in this set is **mutating** — its disposed-state guard fires on `isDisposing || isDisposed`. The classification is used by the dispatch helper in §4.1.4. The set is exhaustive and frozen at module load.

`assess()` is classified as read-only despite invalidating internal caches and emitting `reportGenerated`. The rationale: from the caller's perspective, `assess()` is a query — it returns the current quality report. The cache invalidation and event emission are mechanism, not contract. During disposal, an `assess()` call from inside a `stateDisposed` handler or integration callback receives a fresh report computed from intact backing state (step 4 has not yet run); the `reportGenerated` event fires through the still-attached registry but reaches handlers in the same dispatch loop, which is consistent with how `assess()` always behaves.

#### 4.1.4 Disposed-state guard helper

```ts
export function guardDispose(
  state: LifecycleState,
  methodName: string,
  instanceId: string,
): void;
```

Throws `DisposedError` if the call is forbidden under the current lifecycle state:

- If `state === 'disposed'`: throw, regardless of method name (every public method except the three lifecycle exemptions throws post-disposal).
- If `state === 'disposing'` and `methodName` is **not** in `READ_ONLY_METHODS`: throw (mutating method called during disposal).
- Otherwise: return without throwing.

The guard is called as the first statement of every public method on `ContextLens` (except `dispose`, `isDisposed`, `isDisposing`). It runs before argument validation, before deep-copy, before any internal delegation. The performance overhead is one set membership check + two comparisons — negligible compared to the method body.

#### 4.1.5 Teardown orchestrator

```ts
export function runTeardown(ctx: TeardownContext): unknown[];
```

Where `TeardownContext` carries: the lifecycle state setter, the emitter, the integration registry, the resource-clearing callback (provided by ContextLens), the instance reference (for integration callbacks), and the instance metadata for the `stateDisposed` payload.

The orchestrator executes the six steps from cl-spec-015 §4.1 in order:

1. Set lifecycle state to `'disposing'`.
2. Build the frozen `stateDisposed` payload, dispatch it via `emitter.emitCollect('stateDisposed', payload, errorLog)` (§4.3). The emitter iterates handlers in registration order, runs each inside `try/catch`, and pushes any thrown value onto `errorLog`. Iteration does not abort on a thrown handler.
3. Invoke `integrationRegistry.invokeAll(instance, errorLog)`. Same try/catch discipline.
4. Call the resource-clearing callback (clears caches, ledger, ring buffers, segment store; nulls references). Library-internal; cannot fail.
5. Detach the emitter (clears all subscribers; subsequent `on()` calls and event emissions are no-ops). Clear the integration registry.
6. Set lifecycle state to `'disposed'`.

Returns the disposal error log. The caller (`ContextLens.dispose`) inspects it and throws `DisposalError` if non-empty.

The orchestrator is a free function, not a method on a class, so the lifecycle module remains stateless. State lives in the `ContextLens` instance that drives it.

### 4.2 errors.ts (modifications)

Add at the bottom of the existing error hierarchy, after the last `extends ContextLensError` class:

```ts
export class DisposedError extends Error {
  override readonly name = 'DisposedError';
  readonly instanceId: string;
  readonly attemptedMethod: string;
  constructor(instanceId: string, attemptedMethod: string, state: 'disposed' | 'disposing') {
    super(`ContextLens instance ${instanceId} is ${state}; cannot call ${attemptedMethod}()`);
    this.instanceId = instanceId;
    this.attemptedMethod = attemptedMethod;
  }
}

export class DisposalError extends AggregateError {
  override readonly name = 'DisposalError';
  readonly instanceId: string;
  constructor(instanceId: string, errors: unknown[]) {
    const handlerCount = errors.filter(e => isHandlerOriginTag(e)).length;
    const integrationCount = errors.length - handlerCount;
    super(
      errors,
      `ContextLens instance ${instanceId} disposed with ${errors.length} callback errors (${handlerCount} handlers, ${integrationCount} integrations)`,
    );
    this.instanceId = instanceId;
  }
}
```

`DisposalError` requires `AggregateError`, which is part of the ES2021 standard library. The package's `tsconfig.json` already targets ES2022, so no polyfill is needed.

The origin tag (handler vs integration) is attached by the teardown orchestrator before pushing onto the error log. A simple wrapping function `tagOrigin(error, origin)` returns a `{ cause: error, origin: 'handler' | 'integration', index: number }` shape that `DisposalError`'s constructor can read for the count summary while still preserving the original error in `cause`.

Both classes are re-exported from `index.ts` (the package main entry).

### 4.3 events.ts (modifications)

Add `stateDisposed` to `ContextLensEventMap`:

```ts
export type StateDisposedEvent = {
  readonly type: 'stateDisposed';
  readonly instanceId: string;
  readonly timestamp: number;
};

export type ContextLensEventMap = {
  // ... existing 24 events ...
  stateDisposed: StateDisposedEvent;
};
```

The payload object is created once per `dispose()` call (in step 1 of teardown) and `Object.freeze`-d before being passed to the emitter. Handlers receive the same frozen reference; mutation attempts produce a strict-mode `TypeError`.

The standard `emit` path swallows handler errors per cl-spec-007 §10.3. cl-spec-015 §4.3 mandates a localized deviation for `stateDisposed` — handler errors must be aggregated into `DisposalError` rather than discarded. Wrapping `emit('stateDisposed', payload)` in an outer `try/catch` does not work, because per-handler errors never propagate out of `emit`. The deviation is implemented instead as a new method on `EventEmitter`:

```ts
emitCollect<E extends keyof TMap>(
  event: E,
  payload: TMap[E],
  errorLog: unknown[],
): void
```

Behavior is identical to `emit` except the per-handler `try/catch` pushes the thrown value onto `errorLog` instead of discarding it. The re-entrancy warning is preserved. The standard `emit` method is unchanged and continues to govern every other event in the catalog. The teardown orchestrator (§4.1.5 step 2) calls `emitCollect` exclusively for `stateDisposed`; no other code path uses it.

### 4.4 ContextLens (index.ts modifications)

#### 4.4.1 New private fields

```ts
private lifecycleState: LifecycleState = 'live';
private readonly integrations = new IntegrationRegistry();
private readonly instanceId: string;
```

`instanceId` is generated once in the constructor: a short URL-safe string derived from a counter + random suffix (e.g., `cl-${counter}-${randomBase36}`). It is stable across the instance's lifetime and appears in `stateDisposed` payloads, `DisposedError` messages, and integration callback metadata.

#### 4.4.2 New public surface

```ts
get isDisposed(): boolean { return this.lifecycleState === 'disposed'; }
get isDisposing(): boolean { return this.lifecycleState === 'disposing'; }

dispose(): void { /* see §4.4.4 */ }

/** @internal */
attachIntegration(callback: IntegrationTeardown): IntegrationHandle {
  guardDispose(this.lifecycleState, 'attachIntegration', this.instanceId);
  return this.integrations.attach(callback);
}
```

`attachIntegration` is the published-but-internal entry that fleets and exporters call. It is marked `@internal` in JSDoc (excluded from the public API docs) but is exported on the runtime class so external integration packages can use it. The disposed-state guard fires on it as on any mutating method — registering with a disposed instance throws `DisposedError`. Registering during disposal also throws (guard treats `attachIntegration` as mutating).

#### 4.4.3 Disposed-state guard at every public method

Insert as the first statement of every existing public method:

```ts
public add(content: string, options?: AddOptions): Segment {
  guardDispose(this.lifecycleState, 'add', this.instanceId);
  // ... existing body ...
}
```

The guard is uniform across method categories. Read-only methods pass `'getCapacity'` etc. as the method name; the helper checks the read-only set internally. Mutating methods pass their own name; the helper rejects them when `isDisposing`.

`dispose`, `isDisposed`, and `isDisposing` do **not** call the guard — they remain valid in all states.

#### 4.4.4 dispose() implementation

```ts
public dispose(): void {
  if (this.lifecycleState === 'disposed') return;       // post-disposal no-op
  if (this.lifecycleState === 'disposing') return;      // re-entrant no-op (§3.4)

  // Build resource-clearing closure that captures all internal modules.
  const clearResources = () => {
    this.store.clear();
    this.tokenizer.clearCache();
    this.embedding.clearCache();
    this.similarity.clearCache();
    this.continuity.clear();
    this.diagnosticsManager.clear();
    this.cachedReport = null;
    this.qualityCacheValid = false;
    // Null large internal references where the type system permits.
  };

  const errorLog = runTeardown({
    setState: (s) => { this.lifecycleState = s; },
    emitter: this.emitter,
    integrations: this.integrations,
    clearResources,
    instance: this,
    instanceId: this.instanceId,
    payload: () => Object.freeze({
      type: 'stateDisposed' as const,
      instanceId: this.instanceId,
      timestamp: Date.now(),
    }),
  });

  if (errorLog.length > 0) {
    throw new DisposalError(this.instanceId, errorLog);
  }
}
```

The `clearResources` closure is built at call time so it captures the current internal references; the orchestrator invokes it during step 4. After the orchestrator returns and step 6 has set the state to `'disposed'`, the `DisposalError` (if any) is the last side effect — by the time the throw propagates, the instance is fully disposed.

Step 5 (registry detachment) is performed inside the orchestrator by calling `emitter.removeAllListeners()` (or equivalent on the existing `EventEmitter` class) and `integrations.clear()`.

### 4.5 fleet.ts (modifications)

#### 4.5.1 Registration handshake

Inside `register(instance, label)`, after the existing validation:

```ts
const handle = instance.attachIntegration((live) => {
  this.handleInstanceDisposal(label, live);
});
this.instances.set(label, {
  instance,
  handle,                   // store for explicit unregister
  // ... existing state ...
});
```

If `attachIntegration` throws (instance already disposed), the throw propagates to the caller as a `DisposedError`. The fleet does not silently ignore disposed instances.

#### 4.5.2 Explicit unregister

```ts
unregister(label: string): void {
  const state = this.instances.get(label);
  if (!state) throw new ValidationError(`Label not found: ${label}`, { label });
  state.handle.detach();   // remove from instance's integration registry
  this.instances.delete(label);
  // ... existing splice from labels array ...
}
```

`state.handle.detach()` is safe even if the instance has already been disposed: the registry has been cleared, but the handle's `detached` flag still flips and `invokeAll` would skip a re-fired entry (defensive against any future amendment).

#### 4.5.3 Auto-unregister callback

```ts
private handleInstanceDisposal(label: string, instance: ContextLens): void {
  const state = this.instances.get(label);
  if (!state) return;  // defensive: explicit unregister won the race

  // Step 1: compute final InstanceReport.
  let finalReport: InstanceReport | null = null;
  try {
    finalReport = this.assembleInstanceReport(label, instance, /* cached */ false);
  } catch {
    finalReport = null;  // assess() failure inside teardown is tolerated
  }

  // Step 2: emit instanceDisposed.
  this.emitter.emit('instanceDisposed', {
    label,
    instanceId: /* read from instance via a new public getter */ '',
    finalReport,
  });

  // Step 3: remove from tracked set.
  this.instances.delete(label);
  const idx = this.labels.indexOf(label);
  if (idx !== -1) this.labels.splice(idx, 1);

  // Step 4: drop back-reference (the local `state` variable goes out of scope).
}
```

The callback runs synchronously inside the instance's step 3. Per cl-spec-015 §6.2, mutations on the instance throw — but the fleet only reads (assess, etc.), so the throw guard does not fire. Errors thrown by `assembleInstanceReport` are caught locally; they do not bubble into the disposal error log unless they escape the inner `try`. The fleet deliberately tolerates a final-report-flush failure rather than poisoning the disposal.

#### 4.5.4 instanceDisposed event

Add to `FleetEventMap`:

```ts
instanceDisposed: { label: string; instanceId: string; finalReport: InstanceReport | null };
```

Subscribers are notified in registration order, with the same handler-error semantics as other fleet events (caught and swallowed; this is a fleet-level event, not a lifecycle-level one).

### 4.6 otel.ts (modifications)

#### 4.6.1 Constructor handshake

```ts
constructor(instance: ContextLens, options: ExporterOptions) {
  // ... existing validation, meter creation, gauge/counter registration ...
  this.subscriptions.push(/* existing on() handles */);
  this.integrationHandle = instance.attachIntegration((live) => {
    this.handleInstanceDisposal(live);
  });
  // ...
}
```

`attachIntegration` throws if the instance is disposed; the constructor lets the throw propagate.

#### 4.6.2 disconnect() refactor

```ts
disconnect(): void {
  if (this.disconnected) return;
  this.disconnected = true;
  this.subscriptions.forEach(unsub => unsub());
  this.subscriptions.length = 0;
  this.integrationHandle.detach();
  // ... drop instance reference, mark instruments inert ...
}
```

The integration handle is detached so the auto-disconnect path does not re-fire. After this, `handleInstanceDisposal` (if invoked through any other path) is also a no-op via the `disconnected` flag.

#### 4.6.3 Auto-disconnect callback

```ts
private handleInstanceDisposal(instance: ContextLens): void {
  if (this.disconnected) return;
  this.disconnected = true;

  // Step 1: flush buffered final signals.
  let finalReport: QualityReport | null = null;
  try {
    finalReport = instance.assess();
  } catch {
    finalReport = null;
  }

  // Step 2: emit context_lens.instance.disposed log event.
  if (this.emitEvents && this.logProvider !== null) {
    this.emitLogEvent('context_lens.instance.disposed', {
      'instance.id': /* via instance getter */ '',
      'instance.final_composite': finalReport?.composite ?? null,
      'instance.final_utilization': finalReport?.capacity?.utilization ?? null,
    });
  }

  // Step 3: detach handlers.
  this.subscriptions.forEach(unsub => unsub());
  this.subscriptions.length = 0;

  // Step 4: drop instance reference.
  // (Local closure capture; the field-level reference is nulled by the disconnect flag check.)
}
```

The early `if (this.disconnected) return;` handles the rare case where `disconnect()` was called from inside a `stateDisposed` handler subscribed via `on()` — the step-2 path may run before step-3, and explicit `disconnect()` from there sets the flag, causing the auto-callback in step 3 to no-op.

#### 4.6.4 instance.disposed log event

Add to the OTel log event catalog (cl-spec-013 §4.1) and the test assertions for log emission.

### 4.7 ContextLens.instanceId getter

```ts
readonly instanceId: string
```

The fourth always-valid public surface alongside `dispose`, `isDisposed`, `isDisposing` (cl-spec-007 §9.4, cl-spec-015 §2.5). Generated once in the constructor as a short URL-safe string of the form `cl-${counter}-${randomBase36}` — counter is a process-wide monotonic, randomBase36 is a 6-character random suffix from `Math.random().toString(36).slice(2, 8)`. The combination guarantees uniqueness within a process across all live and disposed instances.

The getter is exempt from the disposed-state guard. The retained-metadata footprint of a disposed instance includes the identifier (cl-spec-015 §5.2, Invariant 12) so the getter continues to return the correct value indefinitely after disposal. Implementation: the field is `readonly` on the class (assigned in the constructor) and the disposed-state guard skips reading it. No special-case logic in `guardDispose` — `instanceId` is simply not a method, so the guard never sees it.

The same value flows to the `stateDisposed` event payload (built in step 1 of teardown), `DisposedError.instanceId` (constructed by the disposed-state guard), and integration teardown callbacks (passed via the `IntegrationTeardown` callback signature, which receives the live instance and can read the getter). All four surfaces return string-equal values for the same instance.

---

## 5. Test Requirements

### Unit tests

**`lifecycle.test.ts`:**
- `IntegrationRegistry.attach` returns a handle whose `detach()` removes the entry. Detached entries are skipped by `invokeAll`.
- `IntegrationRegistry.invokeAll` runs callbacks in registration order. A throwing callback does not abort iteration; the thrown value appears in the error log; subsequent callbacks still run.
- `guardDispose` returns silently when state is `'live'`. Throws `DisposedError` for any method when state is `'disposed'`. Throws for mutating methods when state is `'disposing'`. Returns silently for read-only methods when state is `'disposing'`.
- `runTeardown` executes steps in the documented order (verified by an instrumented mock that records step entry/exit). Caller-callback errors during steps 2 and 3 are captured. Library-internal steps (1, 4, 5, 6) are infallible.
- `READ_ONLY_METHODS` set contains exactly the 13 names specified in cl-spec-015 §3.4. Mutating methods are not in the set.

**`errors.test.ts` (new tests):**
- `DisposedError.name === 'DisposedError'`. `instanceof Error` is true. `instanceId` and `attemptedMethod` carry the constructor arguments. Default message follows the specified form.
- `DisposalError.name === 'DisposalError'`. `instanceof AggregateError` is true. `errors` array contains the constructor arguments. Message reports counts.

**`events.test.ts` (new tests):**
- `stateDisposed` payload is frozen — mutation attempts throw `TypeError` in strict mode.
- The event map type accepts `stateDisposed` with the documented payload shape (compile-time check via type tests).
- `emitCollect` dispatches handlers in registration order and pushes per-handler thrown values onto the supplied `errorLog` (in the order they were caught); iteration does not abort on a thrown handler; non-throwing handlers run normally; the standard `emit` path continues to swallow errors and is unaffected.

### Integration tests

In `test/integration/lifecycle.test.ts`:

- **dispose-on-empty-instance:** Construct with capacity, no segments. Subscribe a handler. Call `dispose()`. Verify: `stateDisposed` fired exactly once, `isDisposed === true`, `isDisposing === false`. Subsequent method calls throw `DisposedError`.
- **dispose-with-state:** Seed and add segments, set task, assess. Call `dispose()`. Verify: caches cleared (assertable via `getDiagnostics` thrown post-disposal), no further events fire, `instanceId` retained for error messages.
- **idempotent-dispose:** Call `dispose()` three times in a row. Verify: only one `stateDisposed` event, no errors, the second and third calls are no-ops.
- **reentrant-dispose:** Subscribe a `stateDisposed` handler that calls `dispose()` reentrantly. Verify: no second event, no error, original call returns normally.
- **read-during-disposal:** Subscribe a `stateDisposed` handler that calls `getDiagnostics`, `assess`, `snapshot`. Verify: each call returns valid data. The handler does not throw.
- **mutate-during-disposal:** Subscribe a handler that calls `add`. Verify: `add` throws `DisposedError` with `attemptedMethod === 'add'`. The throw is caught by the disposal log; `dispose()` raises `DisposalError` with one constituent error.
- **post-disposal-throws:** After `dispose()` returns, call every public method (other than the three exemptions) on the disposed instance. Verify: each throws `DisposedError`. `isDisposed` returns `true`; `isDisposing` returns `false`; `dispose()` is a no-op.
- **unsubscribe-handle-noop-on-disposed:** Subscribe a handler, capture the unsubscribe handle, dispose the instance. Call the handle. Verify: no throw, no effect.
- **handler-error-aggregated:** Subscribe two handlers, one of which throws. Call `dispose()`. Verify: `dispose()` throws `DisposalError` with one constituent error; the second handler still ran; instance is fully disposed.
- **fleet-auto-unregister:** Register an instance with a fleet. Subscribe to fleet `instanceDisposed`. Dispose the instance. Verify: fleet event fires with correct label and final report; the instance is no longer in `listInstances()`; subsequent `assessFleet` does not include it.
- **fleet-explicit-unregister:** Register an instance, call `fleet.unregister(label)`. Verify: instance remains live; no fleet event fires; subsequent disposal of the instance does not fire `instanceDisposed` on the fleet (handle was detached).
- **otel-auto-disconnect:** Construct an exporter, dispose the instance. Verify: `context_lens.instance.disposed` log event recorded; subsequent `assess()` (impossible — would throw) does not produce metric updates; explicit `disconnect()` is a no-op.
- **otel-explicit-disconnect:** Construct an exporter, call `disconnect()`. Verify: integration handle detached; subsequent disposal of the instance does not fire the disposal log event.
- **snapshot-then-dispose-then-restore:** Add segments, snapshot, dispose, construct new instance via `fromSnapshot`. Verify: new instance is live, has the segments, has fresh `instanceId`. The disposed instance still throws on every public method.
- **provider-shutdown-ordering:** Construct with a mock async tokenizer/embedder. Dispose. Verify: provider `close()` is **not** called by `dispose()`. After dispose returns, caller invokes `await tokenizer.close()` and `await embedder.close()`; verify no library code path attempts a provider call during or after.

### Property-based tests

In `test/property/lifecycle.test.ts` (fast-check):

- **dispose-idempotent:** For any sequence of operations followed by N (≥1) `dispose()` calls, only one `stateDisposed` event fires; `isDisposed` is `true` after every call.
- **post-disposal-uniformity:** For any sequence of operations followed by `dispose()`, calling any non-exempt public method always throws `DisposedError` regardless of what method or arguments.
- **state-machine-mutual-exclusion:** Across any execution trace, `isDisposed && isDisposing` is never true.
- **read-only-classification-completeness:** For every public method on `ContextLens`, either the method is in `READ_ONLY_METHODS` or it is documented as mutating in cl-spec-015 §3.4. (Static check; fast-check arbitrary picks method names from a union.)

### Performance benchmarks

In `test/bench/lifecycle.bench.ts`:

- **dispose-empty:** dispose on an empty instance. Target: < 0.5 ms.
- **dispose-500-segments:** dispose on an instance with 500 segments and a populated baseline + history. Target: < 10 ms (dominated by cache and ring-buffer clear).
- **disposed-state-guard:** Microbenchmark `guardDispose` on the live path. Target: < 100 ns per call (the guard runs at the top of every public method; its overhead must be invisible).

---

## 6. Exit Criteria

- `lifecycle.ts` is implemented with the `IntegrationRegistry` class, `READ_ONLY_METHODS` set, `guardDispose` helper, and `runTeardown` orchestrator. It has no upward imports.
- `errors.ts` exports `DisposedError` (extends `Error`) and `DisposalError` (extends `AggregateError`) with the documented field shapes and message conventions.
- `events.ts` includes `stateDisposed` in `ContextLensEventMap` with the frozen-payload shape and `EventEmitter` exposes a new `emitCollect(event, payload, errorLog)` method that captures handler errors instead of swallowing them. The standard `emit` method is unchanged; `emitCollect` is invoked exclusively by the teardown orchestrator for `stateDisposed`.
- `ContextLens` exposes `dispose(): void`, `readonly isDisposed: boolean`, `readonly isDisposing: boolean`, and the `@internal attachIntegration` method. Every existing public method calls `guardDispose` as its first statement. The class generates a unique `instanceId` in the constructor and exposes it.
- `fleet.ts` `register` attaches a teardown callback via `attachIntegration` and stores the handle. `unregister` detaches the handle. The `instanceDisposed` event is in `FleetEventMap` and fires from the auto-unregister callback. A registered instance whose `dispose()` runs is auto-removed from the tracked set.
- `otel.ts` constructor attaches a teardown callback. `disconnect()` detaches the handle and is convergent with auto-disconnect. The `context_lens.instance.disposed` log event fires from the auto-disconnect path.
- All unit tests pass. All integration tests pass. All property-based tests pass. All benchmarks meet their targets.
- The disposed-state guard adds < 100 ns to every public method on the live path (verified by microbenchmark + before/after comparison on existing benchmarks).
- No existing test from Phases 1–5 regresses. The 977 tests at Phase 5 exit grow by the new tests in this phase; the baseline number (977) does not decrease.
- `cl-spec-007` §9, `cl-spec-012` §7, `cl-spec-013` §2.1.2, `cl-spec-014` §3.4, and `cl-spec-015` are all implemented as specified. Any deviations are documented in this spec or in a follow-up grill record.
- Public surface additions are exported from the package main entry: `ContextLens.dispose`, `ContextLens.isDisposed`, `ContextLens.isDisposing`, `DisposedError`, `DisposalError`, `StateDisposedEvent` type. `IntegrationRegistry`, `IntegrationHandle`, `IntegrationTeardown` are **not** exported (internal infrastructure).

---

*context-lens — Phase 6 implementation spec; authored by Akil Abderrahim and Claude Opus 4.7*
