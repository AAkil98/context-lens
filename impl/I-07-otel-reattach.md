# Phase 7 — OTel Re-attach (Gap 4 of v0.2.0 hardening)

## 1. Preamble

The auto-disconnect path shipped in Phase 6 (cl-spec-013 §2.1.2) leaves a `ContextLensExporter` in a detached end state with no path back to a live instance. This phase implements the complementary `attach(instance)` surface specified by cl-spec-013 §2.1.3 — added in the 2026-05-01 amendment for Gap 4 of v0.2.0 hardening. The motivating use case is the snapshot-then-dispose-then-`fromSnapshot()` continuation pattern (cl-spec-014 §3.4): a long-lived OTel exporter survives instance disposal, follows the snapshot to a fresh instance, and resumes its metric stream without dashboard re-configuration.

**Design specs covered:**
- `cl-spec-013` (Observability Export) §2.1.3 (Re-attach after detach), Invariants 10 (state scope) and 11 (single-instance binding)
- `cl-spec-014` (Serialization) §3.4 — canonical motivating use case
- `cl-spec-015` (Instance Lifecycle) §6.1 — the lifecycle integration handshake reused on re-attach

**Performance budget:** `cl-spec-009` — `attach()` is a one-shot operation. Target: < 5 ms for the resubscribe + handshake. No hot-path impact on the live exporter (the re-attach guard adds at most one nullable check per gauge callback, which is already implicit via the `disconnected` flag).

**Key resolutions referenced (per V0_2_0_BACKLOG.md decision locks confirmed 2026-05-01):**
- Mutable binding API. The exporter is constructed with one instance, may detach, and may then be retargeted via `attach(newInstance)`. No factory pattern.
- No multi-instance fan-in. An exporter is bound to ≤ 1 instance at a time. `attach()` on a connected exporter throws.
- State scope: counters preserved (monotonic OTel contract), histogram preserved (distributional), gauges reset (point-in-time). Stored gauge values revert to defaults; first `reportGenerated` from the new instance repopulates.

**Parent document:** `IMPLEMENTATION.md` — Phase 7 row to be added as a v0.2.0 hardening entry.

---

## 2. Module Map

| Module | Primary design spec | Responsibility |
|--------|---------------------|----------------|
| `otel.ts` (modified) | cl-spec-013 §2.1.3 | Adds `attach(instance: ContextLens)`. Gauge management refactored so callbacks survive detach/attach cycles. Stored gauge values reset on attach. Disconnected-flag semantics generalized: `disconnect()` and auto-disconnect both transition to "detached" rather than "terminal", and a successful `attach()` clears the flag. |

No new modules. No changes to `lifecycle.ts`, `index.ts`, `fleet.ts`, `events.ts`, `errors.ts`, or `types.ts`. The integration registry already supports re-attach by accepting fresh callbacks; the exporter just needs to call `attachIntegration` again on the new instance.

---

## 3. Dependency Direction

Unchanged from Phase 6:

```
                     ┌──────────────────────┐
                     │  index.ts            │  (ContextLens)
                     └──────────┬───────────┘
                                │ owns
                                v
                     ┌──────────────────────┐
                     │  lifecycle.ts        │  IntegrationRegistry
                     └──────────────────────┘
                                ^
                                │ attaches via
                                │
                          ┌──────────┐
                          │  otel.ts │
                          └──────────┘
```

`otel.ts` continues to import only from `index.ts` (the `attachIntegration` public method) and `types.ts` (lifecycle and quality-report types). No new imports.

---

## 4. Module Specifications

### 4.1 otel.ts (modifications)

#### 4.1.1 Field-shape changes

The `instance` field becomes nullable:

```ts
private instance: ContextLens | null;
```

A null `instance` is the detached state. Replaces the current `private readonly instance: ContextLens` because the exporter now legitimately survives without a bound instance.

The `integrationHandle` field becomes mutable:

```ts
private integrationHandle: IntegrationHandle | null;
```

Set to non-null while connected, null while detached. Replaces the current `private readonly integrationHandle: IntegrationHandle`.

The `disconnected` flag remains, but its semantics become "currently detached" rather than "terminally disconnected." It clears on a successful `attach()`.

#### 4.1.2 Gauge management refactor

The current `gaugeCleanup` array stores `{ gauge, callback }` pairs and is cleared (length set to 0) on disconnect. To support re-attach, gauge identity must persist across cycles while the callback can be removed and re-added.

New shape:

```ts
private readonly gauges: Array<{
  gauge: OTelObservableGauge;
  description: string;
  unit: string;
  getValue: () => number | null;
  currentCallback: ((result: OTelObservableResult) => void) | null;
}> = [];
```

Each entry retains the gauge object and a value-producer closure for life. The `currentCallback` field tracks whichever callback is currently attached to OTel; it is set when a callback is registered via `gauge.addCallback` and nulled when removed via `gauge.removeCallback`.

Two helpers:

```ts
private attachGaugeCallbacks(): void
private detachGaugeCallbacks(): void
```

`attachGaugeCallbacks` iterates `this.gauges`, constructs a fresh callback for each entry that wraps `getValue` plus the `disconnected` guard plus the `commonAttributes()` lookup, calls `gauge.addCallback(callback)`, and stores the callback in `currentCallback`. `detachGaugeCallbacks` is symmetric — for each entry with a non-null `currentCallback`, calls `gauge.removeCallback(callback)` and sets the field to null.

Construction populates `this.gauges` (one entry per gauge name from cl-spec-013 §3.1) and then calls `attachGaugeCallbacks` once. `disconnect()` and `handleInstanceDisposal` call `detachGaugeCallbacks`. `attach(instance)` calls `attachGaugeCallbacks`.

The OTel instruments (the `OTelObservableGauge`, `OTelCounter`, `OTelHistogram` objects) are created exactly once per exporter — at construction. They survive every detach/attach cycle, satisfying Invariant 10's "instruments reused, not re-created" requirement and ensuring downstream consumers see one continuous metric series across the cycle.

#### 4.1.3 attach(instance) method

```ts
/**
 * Re-attach a detached exporter to a fresh ContextLens instance.
 *
 * Preconditions: exporter must be in the detached state (after `disconnect()`
 * or auto-disconnect on the previous instance's `dispose()`); instance must be
 * live. Throws `Error` (not a typed exporter error) if attempted on a still-
 * connected exporter; throws `DisposedError` (raised by `attachIntegration`)
 * if the instance is already disposed.
 *
 * State scope: counters and histograms are preserved (no reset; OTel monotonic
 * and distributional contracts unbroken). Gauge stored values are reset to
 * defaults; the first `reportGenerated` event from the newly-attached instance
 * repopulates them.
 *
 * @see cl-spec-013 §2.1.3
 */
attach(instance: ContextLens): void {
  if (!this.disconnected) {
    throw new Error(
      'ContextLensExporter.attach: exporter is currently attached. ' +
      'Call disconnect() before attaching to a new instance.',
    );
  }

  // Validate via the lifecycle handshake — throws DisposedError if disposed.
  // We do this BEFORE any state mutation so the exporter remains in a clean
  // detached state on failure (no partial attachment).
  const handle = instance.attachIntegration((live) => {
    this.handleInstanceDisposal(live);
  });

  // Commit point — past here we are attached.
  this.instance = instance;
  this.integrationHandle = handle;
  this.disconnected = false;

  // Reset gauge stored values so the new instance's first reportGenerated
  // repopulates them. Counters and histogram are deliberately untouched.
  this.resetGaugeState();

  // Re-register gauge callbacks and event subscriptions.
  this.attachGaugeCallbacks();
  this.subscribeAll();
}
```

The order matters: the integration handshake runs first because it is the only fallible step. If `attachIntegration` throws (instance already disposed), no state has changed — the exporter is still detached and the caller can decide whether to retry with a different instance. If the handshake succeeds, the remaining steps are infallible (memory writes and synchronous OTel calls).

#### 4.1.4 resetGaugeState helper

```ts
private resetGaugeState(): void {
  this.storedCoherence = 0;
  this.storedDensity = 0;
  this.storedRelevance = 0;
  this.storedContinuity = 0;
  this.storedComposite = 0;
  this.storedUtilization = 0;
  this.storedSegmentCount = 0;
  this.storedHeadroom = 0;
  this.storedPatternCount = 0;
  this.hasQualityValues = false;
}
```

Mirror of the construction-time field initializers. Quality gauges (`coherence`, `density`, `relevance`, `continuity`, `composite`) are guarded by `hasQualityValues` so the OTel callback returns null until the new instance's first `reportGenerated`. Capacity gauges (`utilization`, `segment_count`, `headroom`, `pattern_count`) revert to 0 — they have no "no value" sentinel because OTel observable gauges cannot represent absent observations gracefully, and 0 is a defensible default for an empty window. Both populate from the first `reportGenerated`.

#### 4.1.5 disconnect() refactor

`disconnect()` already exists but currently uses `gaugeCleanup` and treats the flag as terminal. Update:

```ts
disconnect(): void {
  if (this.disconnected) return;
  this.disconnected = true;

  // Detach lifecycle integration handle (silences future auto-disconnect).
  if (this.integrationHandle !== null) {
    this.integrationHandle.detach();
    this.integrationHandle = null;
  }

  this.detachGaugeCallbacks();
  this.cleanupSubscriptions();

  // Drop instance reference so the disposed instance can be GC'd.
  // Do NOT null `this.instance` if the integration teardown is currently
  // executing — `commonAttributes()` may run again before the instance
  // returns to its terminal state. (See handleInstanceDisposal below.)
  this.instance = null;
}
```

Idempotency unchanged. The first call commits; subsequent calls early-return on the `disconnected` check.

#### 4.1.6 handleInstanceDisposal refactor

The auto-disconnect callback already exists. Update to use the new gauge-detach helper and to release `this.instance`:

```ts
private handleInstanceDisposal(instance: ContextLens): void {
  if (this.disconnected) return;
  this.disconnected = true;

  // Step 1: final flush (one read-only assess on the disposing instance).
  let finalReport: QualityReport | null = null;
  try {
    finalReport = instance.assess();
  } catch {
    finalReport = null;
  }

  // Step 2: emit context_lens.instance.disposed.
  if (this.emitEvents && this.logger) {
    const attrs: OTelAttributes = { 'instance.id': instance.instanceId };
    if (finalReport !== null) {
      if (finalReport.composite !== null) {
        attrs['instance.final_composite'] = finalReport.composite;
      }
      attrs['instance.final_utilization'] = finalReport.capacity.utilization;
    }
    this.log('context_lens.instance.disposed', SEV_INFO, attrs);
  }

  // Step 3: detach gauge callbacks + event subscriptions.
  this.detachGaugeCallbacks();
  this.cleanupSubscriptions();

  // Step 4: drop reference. integrationHandle is auto-detached by the
  // registry's invokeAll loop after this callback returns.
  this.integrationHandle = null;
  this.instance = null;
}
```

The `integrationHandle = null` assignment is bookkeeping — the IntegrationRegistry has already removed this entry from its array as part of `invokeAll`, so the handle's `detach()` is a no-op even if called.

#### 4.1.7 commonAttributes guard

`commonAttributes()` reads `this.instance.getTokenizerInfo()` and `this.instance.getEmbeddingProviderInfo()`. With nullable `instance`, this method must guard:

```ts
private commonAttributes(): OTelAttributes {
  if (this.instance === null) {
    // Detached exporter — return base attributes only. In practice this is
    // unreachable from gauge callbacks (the disconnected flag short-circuits)
    // and from event subscriptions (cleaned up on detach). Defensive guard
    // covers any future caller that bypasses both paths.
    return { 'context_lens.window': this.label };
  }
  const embeddingInfo = this.instance.getEmbeddingProviderInfo();
  return {
    'context_lens.window': this.label,
    'context_lens.tokenizer': this.instance.getTokenizerInfo().name,
    'context_lens.embedding_mode': embeddingInfo !== null ? 'embeddings' : 'trigrams',
  };
}
```

The guard exists for completeness — every reachable caller of `commonAttributes` already short-circuits on `disconnected`, so the null path is defensive against future refactors that introduce a code path bypassing the disconnected check. Tests cover both branches.

#### 4.1.8 Subscription cleanup unchanged

`cleanupSubscriptions()` keeps its existing behavior (iterates `this.unsubscribers`, calls each, sets length to 0). It is reused as-is by both `disconnect()` and `handleInstanceDisposal`.

`subscribeAll()` is unchanged in body. It is called once at construction and again from `attach()`. The bodies of the individual handlers all check `this.disconnected` and short-circuit if set, so even if a subscription somehow survives detach (e.g., due to a future refactor adding a deferred handler), the gate remains correct.

---

## 5. Test Requirements

### Unit tests

In `test/unit/otel.test.ts` (existing file, expanded):

- **attach-on-detached-resets-gauges:** Construct, attach to instance A, simulate one assess (populating stored gauges), call `disconnect()`. Construct a fresh instance B. Call `attach(B)`. Verify: `storedCoherence === 0`, `hasQualityValues === false`, all capacity gauge fields are 0.
- **attach-preserves-counters:** Subscribe a counter-receiving stub. Trigger eviction events on instance A (counter increments). Disconnect. Construct instance B. Attach. Trigger eviction events on B. Verify: the counter sees the cumulative count from both instances on the same `OTelCounter` object (counter.add called with same instrument across cycle).
- **attach-preserves-histogram:** Same pattern with `assess_duration_ms`. After disconnect-then-attach, new `record()` calls hit the same histogram instrument as pre-disconnect.
- **attach-on-connected-throws:** Construct exporter on instance A (connected). Call `attach(B)`. Verify: throws `Error` with message naming the precondition; exporter remains attached to A; A's events still produce metric updates.
- **attach-on-disposed-throws-DisposedError:** Construct exporter on instance A. `disconnect()`. Construct instance B. Dispose B. Call `exporter.attach(B)`. Verify: throws `DisposedError`; exporter remains in detached state; subsequent `attach(C)` to a live C succeeds.
- **attach-resubscribes-events:** After attach, trigger `reportGenerated` on the new instance. Verify gauge stored values populate; counter increments fire on subsequent events.
- **attach-rebinds-lifecycle:** After attach, dispose the new instance. Verify the auto-disconnect path fires (`context_lens.instance.disposed` log event emitted with the new instance's `instanceId`).
- **disconnect-attach-disconnect-cycle:** Three cycles in a row. Verify counter accumulates monotonically across all three; gauges reset after each attach; no resource leak (gauge callback count stable per cycle).

### Integration tests

In `test/integration/otel-reattach.test.ts` (new file):

- **snapshot-dispose-fromSnapshot-attach:** Construct lens A with embedding provider. Add 50 segments, set task, assess. Construct exporter, observe metrics flowing. Call `lens.snapshot()`. Call `lens.dispose()` — verify `context_lens.instance.disposed` log event recorded. Call `ContextLens.fromSnapshot(snapshot, config)` to get lens B. Call `exporter.attach(lensB)`. Mutate lens B (add segments, evict, assess). Verify: counter values include both pre-snapshot and post-restore activity; gauges reflect lens B's current state; histogram contains observations from both instances.
- **fleet-and-otel-cohabit-on-reattach:** Register lens A with a fleet and bind an exporter. Snapshot, dispose lens A. Verify: fleet emits `instanceDisposed`, exporter emits `context_lens.instance.disposed`. Register lens B (from `fromSnapshot`) with the fleet under the same label, attach exporter to lens B. Verify: both integrations work normally on lens B.

### Property-based tests

None planned for Phase 7. The state machine is small (connected ↔ detached, with fresh-instance attach as the only transition into connected) and fully covered by the unit tests above. Adding a fast-check property would be ceremonial.

### Performance benchmarks

Not in scope. `attach()` is a one-shot operation outside the hot-path tiers. The gauge management refactor adds zero overhead on the live path (the per-callback closure pattern is already in use).

---

## 6. Exit Criteria

- `otel.ts` exposes `attach(instance: ContextLens): void` with the documented contract. The method throws on attach-while-attached and on attach-to-disposed.
- The `gauges` field stores gauge identity across detach/attach cycles. `attachGaugeCallbacks` and `detachGaugeCallbacks` toggle callbacks without re-creating the instruments.
- `instance` and `integrationHandle` fields are nullable; `commonAttributes` defends the null path.
- Counters and the histogram are preserved across cycles — verified by unit tests asserting same-instrument accumulation.
- Gauge stored values reset on attach — verified by unit tests asserting zero-then-repopulate.
- Disconnected-flag semantics generalized: `disconnect()` and `handleInstanceDisposal` set it; successful `attach()` clears it.
- All existing tests pass. New tests added per section 5. Hard floor 1116 tests grows by the new test count; baseline does not regress.
- `cl-spec-013` §2.1.3 is fully implemented as specified. Any deviations documented in this spec or in a follow-up grill record.
- Public API surface gains exactly one method (`ContextLensExporter.prototype.attach`). No other surface additions.

---

*context-lens implementation spec — Phase 7 (v0.2.0 Gap 4)*
