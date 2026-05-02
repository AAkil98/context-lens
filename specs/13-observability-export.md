---
id: cl-spec-013
title: Observability Export
type: design
status: complete
created: 2026-04-04
revised: 2026-05-01
authors: [Akil Abderrahim, Claude Opus 4.6, Claude Opus 4.7]
tags: [observability, opentelemetry, otel, metrics, gauges, counters, tracing, export, lifecycle, reattach]
depends_on: [cl-spec-007, cl-spec-010, cl-spec-014, cl-spec-015]
---

# Observability Export

## Table of Contents

1. Overview
2. Adapter Construction
3. Metrics
4. Events
5. Integration Patterns
6. Invariants and Constraints
7. References

---

## 1. Overview

context-lens produces quality signals — dimension scores, degradation patterns, capacity metrics, performance timings. These signals live inside the context-lens instance, accessible via `assess()` and `getDiagnostics()`. But in production systems, observability data does not stay inside the process that produced it. It flows to dashboards, alerting systems, and analytics pipelines through a shared observability infrastructure. The industry standard for that infrastructure is OpenTelemetry (OTel).

This spec defines `ContextLensExporter` — an optional adapter that translates context-lens quality signals into OpenTelemetry metrics and events. Quality dimensions become gauges. Capacity becomes a gauge. Pattern activations become log events. Assessment latency becomes a histogram. Context quality appears in existing Grafana, Datadog, or Prometheus dashboards alongside latency, error rates, and throughput — no custom ingestion pipeline required.

### Design principles

- **Optional peer dependency.** The OpenTelemetry SDK (`@opentelemetry/api`) is a peer dependency, not a direct dependency. context-lens core does not import it. Callers who do not install the OTel SDK can use context-lens without any observability export — the core library is unaffected. The adapter is a separate entry point: `import { ContextLensExporter } from 'context-lens/otel'`. Importing this entry point without the OTel SDK installed produces a clear error at import time, not a runtime crash.

- **Read-only consumer.** The adapter subscribes to context-lens events (cl-spec-007 §9) and reads quality reports. It does not call mutating methods, modify instance state, or influence quality scoring. Attaching an exporter to an instance has no effect on the instance's behavior.

- **Convention-based naming.** Metric names follow OpenTelemetry semantic conventions: lowercase, dot-separated, with a configurable prefix. Attribute names follow the `context_lens.*` namespace. This makes metrics discoverable and consistent across deployments.

- **Push on assess.** By default, metrics are updated each time `assess()` is called on the monitored instance. The adapter subscribes to quality-related events and pushes metric updates inline. There is no polling interval, no background thread, and no timer. Metric freshness matches assessment freshness.

### What the adapter is not

The adapter is not a dashboard. It produces metrics and events that a dashboard consumes. Visualization is the responsibility of the observability backend (Grafana, Datadog, etc.).

The adapter is not a logger. It does not write to stdout, a file, or a logging framework. OTel metrics and events are distinct from log lines. Callers who want log output should use the formatting utilities (cl-spec-010 §8).

---

## 2. Adapter Construction

```
new ContextLensExporter(instance: ContextLens, options: ExporterOptions)
```

Creates an exporter that monitors the given instance and produces OTel metrics.

**ExporterOptions:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `meterProvider` | OTel MeterProvider | **yes** | — | The OTel MeterProvider to use for metric creation. Typically the global provider or a custom one. |
| `label` | string | **yes** | — | Human-readable identifier for this window. Used as the `context_lens.window` attribute on all metrics. |
| `metricPrefix` | string | no | `"context_lens"` | Prefix for all metric names. |
| `emitEvents` | boolean | no | `true` | Whether to emit OTel log events for pattern activations, resolutions, and task changes. |
| `logProvider` | OTel LoggerProvider | no | `null` | OTel LoggerProvider for event emission. Required if `emitEvents` is `true`. If `emitEvents` is `true` and no `logProvider` is given, events are silently skipped. |

**Behavior:**

1. Creates an OTel Meter from the `meterProvider` with the name `context_lens`.
2. Registers all gauge, counter, and histogram instruments (section 3).
3. Subscribes to the instance's event system for quality-related events.
4. On each relevant event, updates the corresponding metrics.

Construction is synchronous. The exporter begins monitoring immediately.

### 2.1 Lifecycle

The exporter's lifecycle has two terminal paths: an explicit caller-initiated `disconnect()` and an auto-disconnect driven by the monitored instance's own `dispose()`. Both paths converge on the same end state — exporter no longer subscribed to instance events, no longer holding back-references — but they differ in event semantics.

The exporter is a **lifecycle-aware integration** of the monitored instance per cl-spec-015 §6. Construction (section 2) registers a teardown callback with the instance; the callback fires during step 3 of the instance's `dispose()` teardown sequence (cl-spec-015 §4.1). The exporter holds a back-reference to the instance and registers `on()` handlers for quality-related events; both directions of the link are torn down by either lifecycle path.

#### 2.1.1 Explicit disconnect

```
exporter.disconnect() → void
```

Unsubscribes from the instance's events, detaches the lifecycle teardown callback, and stops metric updates. The OTel instruments remain registered (OTel does not support instrument deregistration), but they stop receiving new values. Subsequent `assess()` calls on the instance do not produce metric updates.

`disconnect()` is idempotent — calling it multiple times has no additional effect. Calling it after auto-disconnect (section 2.1.2) is also a no-op.

`disconnect()` is silent on the OTel event channel — it does not emit a `context_lens.instance.disposed` event (section 4.1). The instance remains live; only the exporter's connection to it is severed.

After `disconnect()` the exporter is in the **detached state**, from which it may be re-attached to a fresh instance via `attach()` (section 2.1.3). The detached state is symmetric with the auto-disconnect end state — both leave the exporter with no live subscriptions, no back-reference, and the same set of preserved OTel instruments.

#### 2.1.2 Auto-disconnect on instance disposal

When the monitored instance's `dispose()` runs, the exporter's teardown callback is invoked synchronously during step 3 of the instance's teardown sequence (cl-spec-015 §4.1, §6.2, §6.4). Inside the callback the exporter observes:

- `instance.isDisposed === false`, `instance.isDisposing === true`
- All read-only public methods on the instance behave per their live specification — caches, ledger, and ring buffers are intact; the registry has not yet been detached
- Mutating methods throw `DisposedError` per the read-only-during-disposal rule

The callback executes the following steps in order:

1. **Flush any buffered signals derived from the instance.** Exporters that batch signals — for example, a metrics exporter that aggregates per-dimension samples and emits a histogram every interval — emit the final signal covering the just-disposed instance. After step 4 of the instance's teardown clears the accumulated state, the data needed to compute these signals is gone.
2. **Emit the `context_lens.instance.disposed` log event** (section 4.1), if `emitEvents` is `true` and a `logProvider` is configured.
3. **Detach handlers registered with the instance through `on()`.** The library detaches the registry in step 5 of teardown (cl-spec-015 §4.1), so this is not strictly required for memory release, but explicit detachment is the cleaner contract — it is self-contained on the exporter side and survives any future refactor that delays step 5.
4. **Release the back-reference to the instance.** The exporter's retained pointer is nulled so the instance's owned resources can be collected after step 4 of teardown completes.

After auto-disconnect the exporter's external state is identical to post-`disconnect()` state. Subsequent calls to `exporter.disconnect()` are no-ops.

The exporter does not call `instance.dispose()` from inside its own teardown callback. Reentrance is permitted by the lifecycle (returns immediately as a no-op via the `isDisposing` check), but the exporter has no operational reason to re-enter — it has already received the notification.

The `stateDisposed` event (cl-spec-007 §10.2, cl-spec-015 §7.1) is delivered to subscribed handlers during step 2 of teardown, *before* the exporter's teardown callback runs in step 3. An exporter that subscribes to `stateDisposed` therefore sees the disposal twice: once as an event in step 2, once as a teardown callback in step 3. Implementations must not duplicate the final-signal flush across both paths. The recommended pattern is to perform the flush in the step-3 callback and to let any step-2 `stateDisposed` handler perform only ambient work — log/trace the disposal as context, emit a metric counter, etc. The step-2 path is constrained by the read-only-during-disposal rule (cl-spec-015 §3.4) but can call read-only methods; centralizing the flush in step 3 is a guidance choice, not a hard restriction.

#### 2.1.3 Re-attach after detach

```
exporter.attach(instance: ContextLens) → void
```

A detached exporter — one that has reached the end state of either `disconnect()` (section 2.1.1) or auto-disconnect (section 2.1.2) — may be re-attached to a fresh `ContextLens` instance. This is the natural complement to the snapshot-then-dispose-then-`fromSnapshot()` continuation pattern (cl-spec-014 §3.4): the caller takes a snapshot, disposes the original instance (which auto-disconnects the exporter and emits the `context_lens.instance.disposed` log event), restores the snapshot to a new instance, and re-attaches the exporter to the new instance to continue the metric stream without rebuilding observability infrastructure.

**Preconditions:**

- The exporter must be in the detached state. Calling `attach()` on a still-connected exporter throws — the contract is single-instance binding (Invariant 11), so the caller must `disconnect()` (or wait for auto-disconnect) before re-attaching to a different instance.
- `instance` must be a live `ContextLens` instance. Already-disposed instances are rejected with `DisposedError` raised by the public method `attach` calls during the lifecycle integration handshake — same surface as construction-time rejection per Invariant 8.

**State-scope contract.** `attach()` re-establishes the connection while reusing the OTel instruments registered at construction. The instruments are not re-registered with the meter provider; the same `OTelObservableGauge`, `OTelCounter`, and `OTelHistogram` objects survive across detach/attach cycles. This is load-bearing: it preserves counter monotonicity and histogram distributional continuity for downstream consumers (Invariant 10).

The per-instrument behavior on re-attach is:

| Instrument family | Behavior on `attach()` | Rationale |
|-------------------|------------------------|-----------|
| Counters (`evictions_total`, `compactions_total`, `restorations_total`, `pattern_activations_total`, `assess_count`, `task_changes_total`) | **Preserved.** No reset. Subsequent `add()` calls accumulate against pre-detach values. | Counters are monotonic by OTel contract. Resetting them would violate that contract and break rate-derivation queries on the consumer dashboard (e.g., `rate(context_lens_evictions_total[5m])`). |
| Histogram (`assess_duration_ms`) | **Preserved.** Pre-detach observations remain in the distribution; subsequent `record()` calls add to the same instrument. | Histograms are distributional. Pre-detach observations capture genuine signal that should not be discarded. |
| Gauges (`coherence`, `density`, `relevance`, `continuity`, `composite`, `utilization`, `segment_count`, `headroom`, `pattern_count`) | **Reset.** Stored values revert to defaults; the quality-gauge "has value" guard re-arms. The first `reportGenerated` event from the newly-attached instance repopulates them. | Gauges are point-in-time observations. Pre-detach values describe the prior instance's state, not the newly-attached one. Carrying them across attach would misreport the new instance until its first assessment. |

**Re-subscription.** `attach()` re-subscribes to the new instance's events (the same set as construction-time subscription per section 2) and re-registers the lifecycle teardown callback (cl-spec-015 §6.1). After `attach()` returns, the exporter behaves identically to a freshly-constructed exporter targeting the new instance, except for the preserved counter and histogram state.

**Idempotency boundary.** `attach()` is **not** idempotent. Calling it on an already-attached exporter throws — the caller must `disconnect()` first. This contrasts with `disconnect()`, which is idempotent. The asymmetry is structural: `attach()` must commit a fresh subscription (a non-idempotent operation that changes which instance the exporter observes), whereas `disconnect()` is a destructor-style cleanup of whatever happens to be live.

**Single-instance binding.** An exporter is bound to at most one `ContextLens` instance at a time (Invariant 11). The `disconnect()`-then-`attach()` cycle is the only supported way to retarget an exporter; multi-instance fan-in — one exporter aggregating signals from multiple live instances simultaneously — is unsupported. Callers needing per-instance fan-in to a shared metric backend should construct one exporter per instance (section 5.2) and rely on the `context_lens.window` attribute for downstream aggregation.

**Snapshot-then-dispose continuation pattern.** The canonical use case (cl-spec-014 §3.4):

```
const snapshot = oldLens.snapshot()
oldLens.dispose()                         // exporter auto-disconnects; log event emitted
const newLens = ContextLens.fromSnapshot(snapshot, config)
exporter.attach(newLens)                  // re-bind; gauges reset; counters preserved
// ... continue using newLens ...
```

The metric stream resumes against `newLens` without interruption from the consumer's perspective. Counter rates and histogram distributions remain valid across the transition; gauge values reflect `newLens` from its first `assess()` onward. Dashboards built on `context_lens.window` need no re-configuration — the attribute is unchanged because the exporter's `label` did not change.

---

## 3. Metrics

### 3.1 Gauges

Updated on each `assess()` call (via the `reportGenerated` event on the instance's event system).

| Metric name | Type | Unit | Description |
|-------------|------|------|-------------|
| `{prefix}.coherence` | Gauge | `1` (dimensionless) | Window coherence score. |
| `{prefix}.density` | Gauge | `1` | Window density score. |
| `{prefix}.relevance` | Gauge | `1` | Window relevance score. |
| `{prefix}.continuity` | Gauge | `1` | Window continuity score. |
| `{prefix}.composite` | Gauge | `1` | Composite quality score. |
| `{prefix}.utilization` | Gauge | `1` | Token utilization ratio. May exceed 1.0. |
| `{prefix}.segment_count` | Gauge | `{segments}` | Active segment count. |
| `{prefix}.headroom` | Gauge | `{tokens}` | Token headroom. May be negative. |
| `{prefix}.pattern_count` | Gauge | `{patterns}` | Number of active degradation patterns. |

**Empty window handling.** When the window has zero segments, quality gauges are not updated (they retain their previous value). OTel gauges do not support `null` — the adapter does not push a 0 that would misrepresent "no data" as "zero quality." The `segment_count` gauge is updated to 0, which signals the empty state.

### 3.2 Counters

Monotonically increasing counters, updated on occurrence.

| Metric name | Type | Unit | Description |
|-------------|------|------|-------------|
| `{prefix}.evictions_total` | Counter | `{evictions}` | Cumulative segment eviction count. Incremented by each `segmentEvicted` event. |
| `{prefix}.compactions_total` | Counter | `{compactions}` | Cumulative compaction count. Incremented on `segmentCompacted` events. |
| `{prefix}.restorations_total` | Counter | `{restorations}` | Cumulative restoration count. Incremented on `segmentRestored` events. |
| `{prefix}.pattern_activations_total` | Counter | `{activations}` | Cumulative pattern activation count (base + custom). |
| `{prefix}.assess_count` | Counter | `{assessments}` | Total `assess()` calls. |
| `{prefix}.task_changes_total` | Counter | `{changes}` | Task transitions classified as changes (not refinements or same). The adapter filters `taskChanged` events by `transition.type === "change"`, excluding refinements and same-task no-ops. |

### 3.3 Histograms

Distribution metrics.

| Metric name | Type | Unit | Description |
|-------------|------|------|-------------|
| `{prefix}.assess_duration_ms` | Histogram | `ms` | `assess()` selfTime. Recorded from the performance timing infrastructure (cl-spec-009 §8). |

**Bucket boundaries:** The adapter uses the OTel default histogram buckets unless the caller configures custom boundaries on the MeterProvider. The default boundaries are suitable for the `assess()` budget: most observations fall in the 1–50ms range (cl-spec-009 §3.3).

### 3.4 Common Attributes

All metrics carry the following attributes:

| Attribute | Type | Description |
|-----------|------|-------------|
| `context_lens.window` | string | The `label` from ExporterOptions. Identifies this window in dashboards. |
| `context_lens.tokenizer` | string | Active tokenizer name. |
| `context_lens.embedding_mode` | string | `"embeddings"` or `"trigrams"`. |

These attributes are updated on each metric push. If the tokenizer or embedding mode changes during the session (via provider switch), subsequent metrics carry the new attribute values.

---

## 4. Events

When `emitEvents` is `true` and a `logProvider` is configured, the adapter emits OTel log events for significant occurrences. Events are OTel LogRecords with `severityText` and structured `body`/`attributes`.

### 4.1 Event Types

| Event name | Severity | Trigger | Attributes |
|------------|----------|---------|------------|
| `context_lens.pattern.activated` | WARN | Pattern activates or escalates | `pattern.name`, `pattern.severity`, `pattern.explanation` |
| `context_lens.pattern.resolved` | INFO | Pattern deactivates | `pattern.name`, `pattern.duration_ms`, `pattern.peak_severity` |
| `context_lens.task.changed` | INFO | Task transition (not same-task no-ops) | `task.transition_type`, `task.similarity` |
| `context_lens.capacity.warning` | WARN | Utilization exceeds 0.90 | `capacity.utilization`, `capacity.headroom` |
| `context_lens.budget.violated` | WARN | Operation exceeds performance budget | `budget.operation`, `budget.self_time_ms`, `budget.target_ms` |
| `context_lens.instance.disposed` | INFO | The monitored instance's `dispose()` runs and the exporter's teardown callback fires (section 2.1.2) | `instance.id` (matches `stateDisposed.instanceId` from cl-spec-015 §7.1), `instance.final_composite` (composite quality of the final flush, or `null`), `instance.final_utilization` (capacity utilization at flush, or `null`) |

All events carry the common attributes (section 3.4) plus `context_lens.timestamp` (epoch ms of the triggering event).

### 4.2 Event Semantics

Events are emitted inline during the context-lens event handler. When the instance emits `patternActivated`, the adapter's handler records the OTel event synchronously. This means event latency is negligible — there is no batching delay.

Event frequency is bounded by instance activity. A typical session with 50 adds, 20 evictions, and 15 assessments produces ~10–30 events. The adapter does not generate events from polling or timers.

---

## 5. Integration Patterns

### 5.1 Single Instance

The simplest setup: one context-lens instance, one exporter.

```
import { ContextLens } from 'context-lens'
import { ContextLensExporter } from 'context-lens/otel'

const lens = new ContextLens({ capacity: 128000 })
const exporter = new ContextLensExporter(lens, {
    meterProvider: metrics.getMeterProvider(),
    label: 'main-agent',
})

// Use lens normally — metrics flow to OTel automatically.
```

### 5.2 With Fleet Monitor

One exporter per instance, fleet label as an attribute.

```
import { ContextLensFleet } from 'context-lens'
import { ContextLensExporter } from 'context-lens/otel'

const fleet = new ContextLensFleet()
const exporters = []

for (const [label, instance] of agentInstances) {
    fleet.register(instance, label)
    exporters.push(new ContextLensExporter(instance, {
        meterProvider,
        label,
    }))
}

// Each instance exports its own metrics.
// Fleet-level aggregation is done by the dashboard (group by context_lens.window).
```

The fleet monitor (cl-spec-012) provides programmatic fleet-level aggregation. OTel + dashboards provide visual fleet-level aggregation. Both work — the fleet monitor is useful when the orchestrator needs to act on fleet-level signals in code; OTel is useful when a human needs to see fleet quality in a dashboard.

### 5.3 Custom Dashboards

With the metric names and attributes defined in sections 3–4, standard observability queries work:

- **Grafana/Prometheus:** `context_lens_composite{context_lens_window="agent-1"}` plots the composite quality score over time.
- **Alert rule:** `avg(context_lens_utilization) > 0.9` triggers when fleet-average utilization exceeds 90%.
- **Datadog:** Group by `context_lens.window`, display `context_lens.coherence` as a time series per agent.

No custom data pipeline is needed. The adapter produces standard OTel metrics that flow through existing collection infrastructure.

---

## 6. Invariants and Constraints

**Invariant 1: Read-only consumer.** The OTel adapter does not call segment-mutating methods or configuration-mutating methods. It subscribes to the instance's event system and reads report data from event payloads. Event handlers follow the contract defined in cl-spec-007 section 9.3.

**Invariant 2: Optional dependency.** context-lens core does not import any OTel module. The adapter is a separate entry point (`context-lens/otel`). Callers who do not install the OTel SDK can use context-lens without the adapter. The core library's bundle size, startup time, and behavior are unaffected.

**Invariant 3: No data loss on disconnect.** Disconnecting the exporter stops future metric updates but does not retroactively remove previously exported metrics. OTel metrics already sent to the backend remain in the backend's storage. `disconnect()` is a clean stop, not a rollback.

**Invariant 4: Metric naming stability.** Metric names and attribute keys are part of the adapter's public contract. Changing a metric name (e.g., renaming `context_lens.coherence` to `context_lens.quality.coherence`) is a breaking change that requires a major version bump. This ensures that dashboards and alert rules built against metric names remain valid across adapter upgrades.

**Invariant 5: Event handler safety.** The adapter's event handlers follow the same contract as any context-lens event handler (cl-spec-007 §9.3): they do not call mutating methods on the instance, they are fast (OTel metric recording is O(1)), and handler errors are caught internally — a failing OTel push does not propagate to the context-lens operation that triggered it.

**Invariant 6: No internal coupling.** The adapter depends only on the public API of `ContextLens` (cl-spec-007) and the public diagnostic structures (cl-spec-010). It does not access internal scoring state, similarity matrices, or cache internals. A conforming `ContextLens` implementation works with the adapter without modification. The lifecycle-aware integration registration (section 2.1) is part of the public API per cl-spec-015 §6.

**Invariant 7: Auto-disconnect on instance disposal.** When the monitored instance's `dispose()` runs, the exporter's teardown callback fires during step 3 of the instance's teardown sequence (cl-spec-015 §4.1) and the exporter transitions to its disconnected end state — no longer subscribed to instance events, no longer holding a back-reference. The teardown callback flushes any buffered final signal, emits the `context_lens.instance.disposed` log event (when configured), and detaches `on()` handlers. After auto-disconnect, subsequent `exporter.disconnect()` calls are no-ops (Invariant 3 idempotency extended to cover the convergent end state).

**Invariant 8: Disposed-instance rejection at construction.** Constructing a `ContextLensExporter` with an already-disposed instance throws `DisposedError` (raised by the public method the exporter calls during attachment). The exporter does not silently accept a disposed instance and never produces metrics for one.

**Invariant 9: At-most-once final flush.** The exporter performs at most one final-signal flush per monitored instance, in the step-3 teardown callback (section 2.1.2). A `stateDisposed` event handler that the exporter may register additionally must not duplicate the flush — the recommended pattern is to confine flush work to the step-3 callback and use the step-2 handler only for ambient metric updates (cl-spec-015 §6.4).

**Invariant 10: State scope on re-attach.** When `attach(instance)` is called on a detached exporter, counters and histograms are preserved (no reset; OTel monotonic and distributional contracts unbroken across detach/attach cycles), and gauge stored values are reset to defaults so the first `reportGenerated` event from the newly-attached instance repopulates them. Pre-detach gauge values are not carried into the new attachment. The OTel instruments themselves (`OTelObservableGauge`, `OTelCounter`, `OTelHistogram`) are reused, not re-created — ensuring downstream consumers see one continuous metric series across the cycle (section 2.1.3).

**Invariant 11: Single-instance binding.** An exporter is bound to at most one `ContextLens` instance at a time. `attach(instance)` on a still-connected exporter throws — the caller must `disconnect()` (or wait for auto-disconnect) before re-attaching to a different instance. Multi-instance fan-in (one exporter aggregating signals from multiple live instances simultaneously) is unsupported; callers needing per-instance fan-in to a shared backend construct one exporter per instance (section 5.2) and aggregate downstream via the `context_lens.window` attribute (section 2.1.3).

---

## 7. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-007` (API Surface) | Defines the event system the adapter subscribes to and the public methods it reads, including the lifecycle methods (`dispose`, `isDisposed`, `isDisposing`) and the `DisposedError` raised on disposed-instance method calls. |
| `cl-spec-009` (Performance Budget) | Defines the timing infrastructure whose selfTime is recorded as the `assess_duration_ms` histogram. |
| `cl-spec-010` (Report & Diagnostics) | Defines the diagnostic structures the adapter reads for metric values. |
| `cl-spec-012` (Fleet Monitor) | Defines the fleet-level aggregation that complements per-instance OTel export. |
| `cl-spec-014` (Serialization) | Defines `snapshot()` and `fromSnapshot()`. §3.4 (snapshot-then-dispose-then-`fromSnapshot()` continuation pattern) is the canonical motivating use case for the `attach()` method specified in section 2.1.3 of this spec. |
| `cl-spec-015` (Instance Lifecycle) | Defines the lifecycle-aware integration model that this spec implements. Section 2.1.2 (Auto-disconnect on instance disposal) specifies the per-exporter teardown callback contract executed during step 3 of an instance's `dispose()` teardown sequence. cl-spec-015 §6.4 enumerates the same exporter-side behavior from the lifecycle perspective. Section 2.1.3 (Re-attach after detach) reuses the same handshake when binding to a freshly-restored instance. |
| OpenTelemetry Specification | The external standard that defines metrics (gauges, counters, histograms), attributes, log events, and the MeterProvider/LoggerProvider interfaces. |

---

*context-lens -- authored by Akil Abderrahim, Claude Opus 4.6, and Claude Opus 4.7*
