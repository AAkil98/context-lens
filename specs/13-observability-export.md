---
id: cl-spec-013
title: Observability Export
type: design
status: draft
created: 2026-04-04
revised: 2026-04-04
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [observability, opentelemetry, otel, metrics, gauges, counters, tracing, export]
depends_on: [cl-spec-007, cl-spec-010]
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

```
exporter.disconnect() → void
```

Unsubscribes from the instance's events and stops metric updates. The OTel instruments remain registered (OTel does not support instrument deregistration), but they stop receiving new values. Subsequent `assess()` calls on the instance do not produce metric updates.

`disconnect()` is idempotent — calling it multiple times has no additional effect.

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

**Invariant 6: No internal coupling.** The adapter depends only on the public API of `ContextLens` (cl-spec-007) and the public diagnostic structures (cl-spec-010). It does not access internal scoring state, similarity matrices, or cache internals. A conforming `ContextLens` implementation works with the adapter without modification.

---

## 7. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-007` (API Surface) | Defines the event system the adapter subscribes to and the public methods it reads. |
| `cl-spec-009` (Performance Budget) | Defines the timing infrastructure whose selfTime is recorded as the `assess_duration_ms` histogram. |
| `cl-spec-010` (Report & Diagnostics) | Defines the diagnostic structures the adapter reads for metric values. |
| `cl-spec-012` (Fleet Monitor) | Defines the fleet-level aggregation that complements per-instance OTel export. |
| OpenTelemetry Specification | The external standard that defines metrics (gauges, counters, histograms), attributes, log events, and the MeterProvider/LoggerProvider interfaces. |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.6*
