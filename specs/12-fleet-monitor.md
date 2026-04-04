---
id: cl-spec-012
title: Fleet Monitor
type: design
status: draft
created: 2026-04-04
revised: 2026-04-04
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [fleet, multi-instance, aggregation, monitoring, multi-agent, orchestration]
depends_on: [cl-spec-007, cl-spec-011]
---

# Fleet Monitor

## Table of Contents

1. Overview
2. Fleet Construction
3. Instance Registration
4. Fleet Assessment
5. Fleet Report
6. Fleet Events
7. Invariants and Constraints
8. References

---

## 1. Overview

context-lens monitors one context window per instance (cl-spec-007, one instance, one window). In multi-agent systems, the orchestrator manages N agents, each with its own context window and its own context-lens instance. The orchestrator needs to answer cross-window questions that no single instance can: Which windows are healthy? Which are degrading? How does quality compare across agents? Is there a fleet-wide pattern — are all agents experiencing saturation simultaneously?

The fleet monitor answers these questions. `ContextLensFleet` is a lightweight aggregator that holds references to multiple context-lens instances, queries them on demand, and assembles a fleet-level quality report. It is a **consumer** of the existing public API — it calls `assess()` and `getCapacity()` on each instance, reads the results, and aggregates. It does not modify instances, share state between them, or require any API additions to the core library.

### Resolution of OQ-011: Fresh Assessment by Default

**Decision:** `assessFleet()` calls `assess()` on each registered instance by default.

The alternative — reading the latest cached report — was considered and rejected as the default:

- **Consistency.** The fleet's value is comparable quality data across all instances at the same moment. Cached reports may be from different points in time — one instance was assessed 2 seconds ago, another 30 seconds ago. Comparing them is misleading. Fresh assessment ensures all reports are from the same `assessFleet()` call.
- **Completeness.** An instance that has never been assessed has no cached report. With cached-only mode, that instance would appear as "no data" in the fleet report. Fresh assessment ensures every registered instance has a report.
- **Simplicity.** The caller calls `assessFleet()` and gets complete, current data. No need to reason about cache freshness or pre-assess instances.

**Cached mode is opt-in:** `assessFleet({ cached: true })` reads the latest cached report from each instance. Useful when the caller is already assessing instances on their own cadence and wants a cheap fleet-level view without triggering N additional assessments. Instances with no cached report appear with `report: null` in the fleet result.

**Performance:** Fresh assessment is O(N) in instances, where each `assess()` has its own budget (cl-spec-009). For 10 instances with 500 segments each, `assessFleet()` takes ~500ms. The fleet does not parallelize assessment — instances are assessed sequentially. Callers with many instances who need lower latency can use cached mode or assess subsets.

### What the fleet is not

The fleet is not a coordinator. It does not decide which instances to evict from, does not propagate task changes across agents, and does not balance load between windows. It observes. The orchestrator that created the fleet is responsible for acting on the fleet report.

The fleet is not a shared context. Instances registered with the fleet remain independent. They do not exchange segments, share embeddings, or merge quality scores. The fleet reads each instance's state individually and combines the results.

---

## 2. Fleet Construction

```
new ContextLensFleet(options?: FleetOptions)
```

Creates an empty fleet monitor. Instances are added via `register()`.

**FleetOptions:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `degradationThreshold` | number (0.0–1.0) | no | `0.5` | Fraction of instances with active patterns that triggers the `fleetDegraded` event (section 6.2). |

Construction is synchronous and cheap. The fleet starts with zero instances.

---

## 3. Instance Registration

### 3.1 register

```
register(instance: ContextLens, label: string) → void
```

Adds a context-lens instance to the fleet under the given label. The label is a human-readable identifier for this instance — typically the agent name, workspace ID, or window purpose.

**Preconditions:**
- `label` must be a non-empty string. Throws `ValidationError`.
- `label` must not already be registered. Throws `DuplicateIdError`.
- `instance` must be a valid `ContextLens` instance. Throws `ValidationError`.

An instance can be registered with multiple fleets under different labels. The fleet holds a reference — it does not take ownership. The caller remains responsible for the instance's lifecycle (mutations, assessment cadence, disposal).

### 3.2 unregister

```
unregister(label: string) → void
```

Removes an instance from the fleet. The instance is not affected — only the fleet's reference is removed.

**Preconditions:**
- `label` must be registered. Throws `ValidationError` if not found.

After unregistration, the instance does not appear in subsequent fleet reports or events.

### 3.3 listInstances

```
listInstances() → InstanceInfo[]
```

Returns information about all registered instances.

**InstanceInfo:**

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | The registration label. |
| `segmentCount` | integer | Current active segment count (from `getSegmentCount()`). |
| `capacity` | integer | Configured capacity. |
| `utilization` | number | Current utilization. |
| `lastAssessedAt` | number or null | Timestamp of the instance's most recent quality report. `null` if never assessed. |

`listInstances()` does not trigger assessment — it reads lightweight metadata from each instance.

### 3.4 get

```
get(label: string) → ContextLens | null
```

Returns the instance registered under the given label, or `null` if not found. This allows the orchestrator to reach through the fleet to a specific instance for direct operations.

---

## 4. Fleet Assessment

### 4.1 assessFleet

```
assessFleet(options?: FleetAssessOptions) → FleetReport
```

Queries all registered instances and assembles a fleet-level quality report.

**FleetAssessOptions:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `cached` | boolean | no | `false` | If `true`, reads each instance's latest cached report instead of calling `assess()`. Instances with no cached report appear with `report: null`. |

**Behavior:**

1. For each registered instance, in registration order:
   a. If `cached` is `false`: call `instance.assess()` to get a fresh QualityReport.
   b. If `cached` is `true`: read the latest cached report (may be `null`).
   c. Call `instance.getCapacity()` for current capacity metrics.
2. Aggregate per-instance results into fleet-level summaries (section 5).
3. Detect fleet-level conditions (degradation hotspots, comparative ranking).
4. Assemble and return the `FleetReport`.

**Error handling:** If an instance's `assess()` throws, the fleet catches the error, records the instance as `{ status: "error", error: message }` in the fleet report, and continues with the remaining instances. One failing instance does not prevent fleet assessment. The fleet report includes a `failedInstances` count so the caller knows the aggregates are partial.

### 4.2 assessInstance

```
assessInstance(label: string, options?: { cached?: boolean }) → InstanceReport
```

Assesses a single registered instance and returns its per-instance report (the same structure that appears in the fleet report's `instances` array). Useful when the caller wants to drill into one instance without the cost of assessing the entire fleet.

---

## 5. Fleet Report

### 5.1 FleetReport Structure

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | string | Schema version (cl-spec-011 convention). |
| `timestamp` | number | When the fleet report was assembled (epoch ms). |
| `instanceCount` | integer | Total registered instances. |
| `assessedCount` | integer | Instances successfully assessed (excludes failed and null-report instances). |
| `failedInstances` | integer | Instances where `assess()` threw. |
| `cached` | boolean | Whether cached mode was used. |
| `instances` | InstanceReport[] | Per-instance reports, ordered by registration order. |
| `aggregate` | FleetAggregate | Fleet-wide quality aggregates (section 5.3). |
| `hotspots` | Hotspot[] | Instances with active patterns, sorted by severity then pattern count (section 5.4). |
| `ranking` | RankedInstance[] | Instances ranked by composite score, ascending (weakest first). |
| `capacityOverview` | FleetCapacity | Fleet-wide capacity summary (section 5.5). |

### 5.2 InstanceReport

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Registration label. |
| `status` | string | `"ok"`, `"no-report"` (cached mode, no cached report), or `"error"` (assess threw). |
| `error` | string or null | Error message if `status` is `"error"`. |
| `report` | QualityReport or null | The instance's quality report. `null` if `status` is not `"ok"`. |
| `capacity` | CapacityReport | Current capacity metrics. |

### 5.3 FleetAggregate

Fleet-wide averages, minimums, and maximums across all successfully assessed instances.

| Field | Type | Description |
|-------|------|-------------|
| `coherence` | AggregateStat | Fleet coherence stats. |
| `density` | AggregateStat | Fleet density stats. |
| `relevance` | AggregateStat | Fleet relevance stats. |
| `continuity` | AggregateStat | Fleet continuity stats. |
| `composite` | AggregateStat | Fleet composite stats. |
| `utilization` | AggregateStat | Fleet utilization stats. |

**AggregateStat:**

| Field | Type | Description |
|-------|------|-------------|
| `mean` | number | Average across assessed instances. |
| `min` | number | Minimum value. |
| `max` | number | Maximum value. |
| `minInstance` | string | Label of the instance with the minimum value. |
| `maxInstance` | string | Label of the instance with the maximum value. |
| `stddev` | number | Standard deviation. Indicates quality dispersion across the fleet. |

Aggregates are computed only from instances with `status: "ok"`. Failed and no-report instances are excluded.

### 5.4 Hotspots

**Hotspot:**

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Instance label. |
| `highestSeverity` | Severity | Highest active pattern severity. |
| `patternCount` | integer | Number of active patterns. |
| `patterns` | string[] | Names of active patterns. |
| `composite` | number | Composite score. |

Hotspots are instances with at least one active degradation pattern. Sorted by `highestSeverity` descending (critical first), then `patternCount` descending, then `composite` ascending (worst quality first).

A fleet with no hotspots has all instances healthy (no active patterns). This is the ideal state. The `hotspots` array being non-empty is the fleet-level signal that something needs attention.

### 5.5 FleetCapacity

| Field | Type | Description |
|-------|------|-------------|
| `totalCapacity` | integer | Sum of all instance capacities. |
| `totalActiveTokens` | integer | Sum of all instance active token counts. |
| `fleetUtilization` | number | `totalActiveTokens / totalCapacity`. |
| `overCapacityCount` | integer | Instances with utilization > 1.0. |
| `highUtilizationCount` | integer | Instances with utilization > 0.85. |

### 5.6 RankedInstance

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Instance label. |
| `composite` | number or null | Composite score. `null` if zero segments. |
| `rank` | integer | 1 = weakest, N = strongest. |

Ranking is ascending by composite — the weakest instance is rank 1. Ties are broken by utilization (higher utilization = worse = lower rank number). Instances with `null` composite (empty windows) are ranked last.

---

## 6. Fleet Events

The fleet emits its own events, separate from the events emitted by individual instances.

### 6.1 Subscribing

```
fleet.on(event: FleetEventName, handler: (payload) → void) → Unsubscribe
```

Same subscription model as the core event system (cl-spec-007 §9.1). Returns an unsubscribe function. Handler errors are caught and swallowed.

### 6.2 Events

| Event | Payload | Emitted when |
|-------|---------|-------------|
| `instanceDegraded` | `{ label, pattern: ActivePattern }` | Any registered instance activates a new pattern (detected during `assessFleet`). |
| `instanceRecovered` | `{ label, pattern: string, duration: number }` | A previously active pattern on a registered instance resolves (detected during `assessFleet`). |
| `fleetDegraded` | `{ degradedCount, totalCount, ratio, hotspots: Hotspot[] }` | The fraction of instances with active patterns exceeds the `degradationThreshold` (section 2). |
| `fleetRecovered` | `{ degradedCount, totalCount, ratio }` | The fraction of instances with active patterns drops below the `degradationThreshold` after a `fleetDegraded` event. |

**Detection mechanism.** Fleet events are detected by comparing the current `assessFleet()` result against the previous one. The fleet maintains a lightweight previous-state cache: per-instance `highestSeverity` and active pattern names. On each `assessFleet()`, the fleet diffs the current pattern state against the previous state and emits events for changes.

`instanceDegraded` and `instanceRecovered` fire for each pattern state change. `fleetDegraded` and `fleetRecovered` fire based on the threshold ratio. Hysteresis is not applied at the fleet level — pattern-level hysteresis on each instance (cl-spec-003 §9.3) provides sufficient stability. Fleet events are derived from stable per-instance signals.

**Cached mode.** Fleet events are not emitted when `assessFleet({ cached: true })` is used, because cached reports may not reflect state changes. Events are only emitted when fresh assessment provides reliable diffs.

---

## 7. Invariants and Constraints

**Invariant 1: Read-only consumer.** The fleet does not modify any registered instance. It calls `assess()` (which computes and caches but does not modify segments), `getCapacity()`, and `getSegmentCount()` — all read operations. It does not call `add`, `evict`, `setTask`, or any mutating method. Registering an instance with a fleet has no effect on the instance's behavior.

**Invariant 2: Instance independence.** Registered instances do not share state through the fleet. The fleet aggregates data from instances but does not propagate data between them. An assessment of instance A cannot affect instance B. Cross-instance comparisons in the fleet report are derived from independent assessments.

**Invariant 3: Fail-open assessment.** If one instance's `assess()` throws, the fleet continues assessing the remaining instances. The fleet report includes the failed instance with `status: "error"`. Aggregates and rankings exclude failed instances. One broken instance does not break fleet monitoring.

**Invariant 4: Registration order stability.** The `instances` array in the fleet report follows registration order. The ranking array follows composite score order. These orderings are stable across calls — the same fleet with the same instance scores produces the same report ordering.

**Invariant 5: Event consistency.** Fleet events are emitted only during `assessFleet()` calls with `cached: false`. The event payloads reflect the current assessment, not stale data. `fleetDegraded` is emitted at most once per sustained degradation period — it does not re-fire on each `assessFleet()` while the condition persists. `fleetRecovered` fires when the condition clears.

**Invariant 6: No internal state dependency.** The fleet depends only on the public API of `ContextLens` (cl-spec-007). It does not access internal state, private methods, or implementation details. A conforming `ContextLens` implementation with the same public API would work with the fleet without modification.

---

## 8. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-007` (API Surface) | Defines the public API that the fleet consumes: `assess()`, `getCapacity()`, `getSegmentCount()`, `getDiagnostics()`. The fleet is a consumer of this API. |
| `cl-spec-003` (Degradation Patterns) | Defines the pattern detection results that the fleet aggregates into hotspots and fleet-level degradation events. |
| `cl-spec-011` (Report Schema) | Defines schema conventions followed by the FleetReport. The fleet report extends the schema vocabulary with fleet-specific types (FleetAggregate, Hotspot, FleetCapacity). |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.6*
