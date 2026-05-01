---
id: cl-spec-012
title: Fleet Monitor
type: design
status: complete
created: 2026-04-04
revised: 2026-05-02
authors: [Akil Abderrahim, Claude Opus 4.6, Claude Opus 4.7]
tags: [fleet, multi-instance, aggregation, monitoring, multi-agent, orchestration, lifecycle, concurrency, serialization]
depends_on: [cl-spec-007, cl-spec-011, cl-spec-014, cl-spec-015]
---

# Fleet Monitor

## Table of Contents

1. Overview
2. Fleet Construction
3. Instance Registration
4. Fleet Assessment
5. Fleet Report
6. Fleet Events
7. Instance Disposal Handling
8. Fleet Serialization
9. Invariants and Constraints
10. References

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

Registration also establishes the fleet as a **lifecycle-aware integration** of the instance per cl-spec-015 §6. The fleet attaches a teardown callback to the instance; when the instance is disposed (via `dispose()`), the callback fires during step 3 of teardown and the fleet auto-unregisters the instance per the contract specified in section 7. The bidirectional link — fleet holds back-reference to instance, instance holds teardown callback to fleet — is torn down atomically by `dispose()`. The exact registration handshake is internal; from the caller's perspective, `fleet.register(instance, label)` is sufficient to set up both directions.

Registering an already-disposed instance throws `DisposedError` (cl-spec-015 §7.2): the fleet calls a public method on the instance during attachment, and post-disposal calls throw. Callers should not retain handles to disposed instances for fleet registration.

### 3.2 unregister

```
unregister(label: string) → void
```

Removes an instance from the fleet. The instance is not affected — only the fleet's reference is removed and the fleet's teardown callback is detached.

**Preconditions:**
- `label` must be registered. Throws `ValidationError` if not found.

After unregistration, the instance does not appear in subsequent fleet reports or events. Explicit `unregister()` is independent of the auto-unregister path triggered by instance disposal (section 7) — both paths converge on the same end state (instance removed from tracked set, back-references dropped) but explicit unregister leaves the instance live, while auto-unregister is driven by the instance's own disposal.

### 3.3 listInstances

```
listInstances() → InstanceInfo[]
```

Returns information about all registered instances.

**InstanceInfo:**

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | The registration label. |
| `segmentCount` | integer | Current active segment count (from `getSegmentCount().active`). |
| `capacity` | integer | Configured capacity (from `getCapacity().capacity`). |
| `utilization` | number | Current utilization (from `getCapacity().utilization`). |
| `lastAssessedAt` | number or null | Timestamp of the most recent `assessFleet()` or `assessInstance()` call for this instance. Null if this instance has never been assessed through the fleet. |

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
| `instanceDisposed` | `{ label, instanceId: string, finalReport: InstanceReport \| null }` | A registered instance's `dispose()` runs and the fleet's teardown callback fires (section 7). `finalReport` is the final aggregated InstanceReport for the disposed instance, or `null` if the fleet had no live state to flush. Fired before the instance is removed from the tracked set. |
| `fleetDegraded` | `{ degradedCount, totalCount, ratio, hotspots: Hotspot[] }` | The fraction of instances with active patterns exceeds the `degradationThreshold` (section 2). |
| `fleetRecovered` | `{ degradedCount, totalCount, ratio }` | The fraction of instances with active patterns drops below the `degradationThreshold` after a `fleetDegraded` event. |

**Detection mechanism.** Fleet events are detected by comparing the current `assessFleet()` result against the previous one. The fleet maintains a lightweight previous-state cache: per-instance `highestSeverity` and active pattern names. On each `assessFleet()`, the fleet diffs the current pattern state against the previous state and emits events for changes.

`instanceDegraded` and `instanceRecovered` fire for each pattern state change. `fleetDegraded` and `fleetRecovered` fire based on the threshold ratio. Hysteresis is not applied at the fleet level — pattern-level hysteresis on each instance (cl-spec-003 §9.3) provides sufficient stability. Fleet events are derived from stable per-instance signals.

**Cached mode.** Fleet events are not emitted when `assessFleet({ cached: true })` is used, because cached reports may not reflect state changes. Events are only emitted when fresh assessment provides reliable diffs. The `instanceDisposed` event is the exception — it is driven by the instance's disposal, not by `assessFleet`, so it fires regardless of whether the fleet is in cached or fresh mode.

---

## 7. Instance Disposal Handling

The fleet is a **lifecycle-aware integration** of every registered instance, per cl-spec-015 §6. When a registered instance is disposed (the caller invokes `instance.dispose()`), the fleet receives a teardown callback during step 3 of the instance's teardown sequence (cl-spec-015 §4.1). This section specifies the callback's behavior, the resulting state changes, and the relationship between explicit `unregister()` and auto-unregister-on-disposal.

### 7.1 Teardown callback behavior

When an instance's `dispose()` runs, the fleet's teardown callback is invoked synchronously, in step 3 of the instance's teardown. Inside the callback the fleet observes (per cl-spec-015 §6.2):

- `instance.isDisposed === false`
- `instance.isDisposing === true`
- All read-only public methods on the instance behave per their live specification (`getDiagnostics`, `assess`, `snapshot`, etc.). Mutating methods throw `DisposedError`.
- Step 4 of the instance's teardown (resource clearing) has not yet run — caches, ledger, and ring buffers are intact.

The fleet's callback executes the following steps in order:

1. **Compute and emit a final aggregated InstanceReport for the just-disposed instance.** This is the fleet's last opportunity to read the instance's accumulated state. The fleet may invoke `instance.assess()` (if the fleet has not already assessed the instance during the current `assessFleet()` call) or read the latest cached report. The result is packaged as the `finalReport` field of the `instanceDisposed` event payload. If the instance was never assessed through the fleet and the fleet does not invoke a final `assess()`, `finalReport` is `null`.
2. **Emit the `instanceDisposed` event** (section 6.2) with the `label`, the instance's `instanceId` (matching the `stateDisposed` event payload from cl-spec-015 §7.1), and the `finalReport`.
3. **Remove the instance from the fleet's tracked-instances set.** Subsequent `assessFleet()`, `listInstances()`, `get()`, and event emissions must not include the disposed instance. The removal is unconditional — it happens whether or not step 1 succeeded, so a flush failure does not pin a disposed instance in the fleet's tracking structures.
4. **Drop the back-reference to the instance.** The fleet's retained pointer is nulled so the instance's owned resources can be collected after step 4 of teardown completes.

### 7.2 Constraints inside the callback

The fleet must not, during the teardown callback (cl-spec-015 §6.2):

- Mutate the instance — `add()`, `update()`, `evict()`, etc. throw `DisposedError` per the read-only-during-disposal rule. The fleet has no operational reason to mutate, but the rule applies regardless.
- Re-attach itself or any other integration to the instance.
- Throw to abort disposal. Errors thrown by the callback are caught, aggregated into the per-call disposal error log, and surfaced to the caller of `dispose()` as a `DisposalError` (cl-spec-015 §4.3, §7.2). The instance still transitions to disposed regardless of how many fleet callbacks throw.
- Call back into `instance.dispose()` from the callback. Reentrance is permitted by the lifecycle (returns immediately as a no-op via the `isDisposing` check), but the fleet has no operational reason to re-enter — it has already received the notification.

### 7.3 Auto-unregister vs explicit unregister

The fleet exposes two paths for removing an instance from its tracked set:

| Path | Trigger | Effect on instance | Effect on fleet |
|------|---------|-------------------|----------------|
| `fleet.unregister(label)` | Explicit caller call | Instance remains live | Fleet drops back-reference, detaches teardown callback. No `instanceDisposed` event. |
| Instance disposal | `instance.dispose()` runs | Instance transitions to disposed | Fleet's teardown callback fires, emits `instanceDisposed`, drops back-reference. |

The two paths converge on the same fleet-side end state (instance removed from tracked set, back-references dropped). They differ in event semantics — explicit `unregister()` is silent on the fleet event channel; auto-unregister fires `instanceDisposed`. Callers who want the fleet to emit a final report on instance shutdown should rely on disposal rather than calling `unregister()` first.

### 7.4 Polling fallback

If the caller has not registered fleet events and instead detects "missing" instances by polling `instance.isDisposed` on registered instances, that path continues to work after the auto-unregister: `instance.isDisposed` returns `true` once `dispose()` returns successfully (cl-spec-015 §2.5). The polling path is a fallback for callers who defer fleet-side cleanup to a separate scan; the callback path is the recommended mechanism because it permits the final-report flush.

---

## 8. Fleet Serialization

A `ContextLensFleet` can be serialized to a self-contained snapshot and restored on a new fleet instance. This complements the per-instance `snapshot()` / `fromSnapshot()` pattern (cl-spec-014) by capturing fleet-level state — registration order, fleet options, and the per-instance pattern-state cache used for event diffing — alongside the embedded instance snapshots. The motivating use case is the same as for instance serialization: persist the working state of an entire monitored deployment, then continue from that state on a fresh process or after an instance dispose / restore cycle.

This section supersedes the v0.1.0 carve-out that "fleet state is not serializable" (formerly carried in §9 as a paragraph). With Gap 6 of v0.2.0 hardening shipped, fleet state has a concrete positive contract.

### 8.1 Snapshot

```
fleet.snapshot(options?: { includeContent?: boolean }) → SerializedFleet
```

Produces a fleet-level snapshot. The `includeContent` option propagates to every embedded instance snapshot per cl-spec-014 §6 — full snapshots (`includeContent: true`, the default) are restorable; lightweight snapshots (`includeContent: false`) capture metadata and history but not segment content, are ~10× smaller, and are not restorable.

**Behavior:**

1. Iterate every registered instance in registration order. Calling each instance's `snapshot(options)` produces a `SerializedState` (cl-spec-014 §4). The fleet does not modify the snapshot — it embeds the result verbatim.
2. Capture fleet-level state: construction-time options, the `fleetDegradedState` flag, and per-instance pattern tracking state (active pattern names, activation timestamps, last-assessed-at). This is the data the fleet uses to detect transitions on the next `assessFleet()`; preserving it across a restore prevents spurious `instanceDegraded` events for already-active patterns (Invariant 9, "pattern-state continuity").
3. Wrap the embedded snapshots and fleet-level state into a `SerializedFleet` object (section 8.1.2).
4. Return the wrapper.

**Throws:** `DisposedError` if any registered instance is in the disposed state at the time of capture. The fleet calls `instance.snapshot()` per instance; cl-spec-014 §3 specifies that the instance's `snapshot()` throws `DisposedError` post-disposal. The fleet does not catch this error — fleet snapshot is all-or-nothing. Callers needing to skip disposed instances must `unregister` them first.

The fleet itself has no lifecycle (no dispose); `fleet.snapshot()` is always permitted on the fleet object regardless of which integrations are attached. The disposed-state guard is per-instance.

#### 8.1.1 Pattern-state-cache preservation

The fleet's event detection (§6.2) is diff-based: each `assessFleet()` compares the current per-instance pattern set against the cached previous set and emits `instanceDegraded` for new activations and `instanceRecovered` for resolutions. If the fleet's cache is reset on restore, the first `assessFleet()` after restore would emit `instanceDegraded` for every already-active pattern — a flood of false positives that breaks any caller dashboarding off these events.

The serialized fleet snapshot **preserves** the pattern-state cache. A `SerializedFleet` includes:

- Per-instance `activePatterns: string[]` (last-known pattern names)
- Per-instance `patternActivatedAt: Record<string, number>` (per-pattern activation timestamp)
- Per-instance `lastAssessedAt: number | null` (last fleet assessment timestamp)
- Fleet-level `fleetDegradedState: boolean` (current degradation state for `fleetDegraded`/`fleetRecovered` diffing)

On `fromSnapshot`, the fleet rehydrates these fields exactly. The first `assessFleet()` after restore is silent on the event channel for any pattern set that matches the snapshot's last-known state — only genuine transitions (new activations, new resolutions) emit events.

If the caller wants the post-restore fleet to behave as if no prior state existed (e.g., to re-emit `instanceDegraded` for everything currently degraded), they can simply construct a fresh `ContextLensFleet`, register the restored instances manually, and skip `fromSnapshot`. This is a deliberate tradeoff: preservation is the default because event-diffing continuity is the more common need.

#### 8.1.2 SerializedFleet shape

| Field | Type | Description |
|-------|------|-------------|
| `formatVersion` | string | `"context-lens-fleet-snapshot-v1"`. Independent of the per-instance `formatVersion` (cl-spec-014 §7) and the schema version (cl-spec-011). |
| `timestamp` | number | Epoch-ms wall-clock at the time of capture. |
| `fleetOptions` | object | `{ degradationThreshold: number }` — captured for restore. |
| `instances` | array | Ordered list of `{ label, snapshot, trackingState }` entries. `snapshot` is a `SerializedState` per cl-spec-014 §4. `trackingState` carries the per-instance fleet-level diffing fields (section 8.1.1). |
| `fleetState` | object | `{ fleetDegradedState: boolean }` — global diffing flag for `fleetDegraded`/`fleetRecovered`. |

Order matters: the `instances` array is written in the fleet's registration order (the same order `listInstances()` returns) and restored in that order. Ranking, hotspot ordering, and `assessFleet().instances[]` ordering depend on registration order being stable across restore (Invariant 4).

### 8.2 Restore

```
ContextLensFleet.fromSnapshot(state: SerializedFleet, config: FleetRestoreConfig) → ContextLensFleet
```

Static factory that reconstructs a fully functional fleet from a `SerializedFleet`. Equivalent to: construct a fresh fleet with the captured `fleetOptions`, `fromSnapshot` each instance with its corresponding `RestoreConfig`, register each restored instance under its original label, then rehydrate the fleet's pattern-state cache.

**FleetRestoreConfig:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `default` | `RestoreConfig` | **Yes** | The `RestoreConfig` (cl-spec-014 §5.1) to use when no per-label entry applies. Provides tokenizer, embedding provider, and any custom patterns common to all instances. |
| `perLabel` | `Record<string, RestoreConfig>` | No | Optional per-label overrides. If present and a label is in the map, that entry's `RestoreConfig` is used for that instance instead of `default`. Labels in `perLabel` that do not appear in the snapshot are ignored. |

The per-label map exists because fleets in production typically run heterogeneous workloads — different agents may use different embedding providers, custom patterns, or capacities. Forcing one shared config across the entire fleet would require the caller to either constrain provider choice at construction time or handle per-label config externally.

**Behavior:**

1. Validate `formatVersion`. Throws `ConfigurationError` if the version is unrecognized (no fallback, no guess — same posture as cl-spec-014 §7).
2. Validate `config.default` is non-null. Throws `ValidationError` otherwise.
3. Construct a fresh `ContextLensFleet` with `state.fleetOptions`. The new fleet has no registered instances.
4. For each entry in `state.instances` (in order):
   a. Resolve the `RestoreConfig`: `config.perLabel[label]` if present, else `config.default`.
   b. Call `ContextLens.fromSnapshot(entry.snapshot, restoreConfig)` to produce a live instance.
   c. Call `fleet.register(restoredInstance, label)`. This re-establishes the lifecycle integration handshake (§3.1) and adds the instance to the tracked set. `fleet.register` validates that the instance is live (cl-spec-015 §6.2); since `fromSnapshot` always returns a live instance (cl-spec-014 §5.5), this check passes.
   d. Rehydrate the per-instance tracking state from `entry.trackingState`: restore `activePatterns`, `patternActivatedAt`, `lastAssessedAt`.
5. Set `fleet.fleetDegradedState` from `state.fleetState.fleetDegradedState`.
6. Return the fully-restored fleet.

**Atomicity.** If any step fails (e.g., one instance's `fromSnapshot` throws because its snapshot is malformed or its `RestoreConfig` is incompatible), the entire restore fails — no partially-restored fleet is returned, and any successfully-restored instances are abandoned (the caller must `dispose()` them if desired; the spec does not auto-dispose because the caller may want to inspect them). This matches cl-spec-014 §5.4 atomicity for instance restore.

**Throws:**
- `ConfigurationError` — unrecognized `formatVersion`.
- `ValidationError` — missing `default` config; duplicate label in `instances` array; malformed `trackingState`.
- Any error thrown by an inner `ContextLens.fromSnapshot` propagates verbatim. The error message includes the offending label for caller diagnosis.

### 8.3 Format Versioning

Fleet snapshots carry their own `formatVersion` (`"context-lens-fleet-snapshot-v1"`), independent of:

- The per-instance `formatVersion` (`"context-lens-snapshot-v1"`, cl-spec-014 §7) — embedded instance snapshots evolve under cl-spec-014's versioning policy.
- The schema version (cl-spec-011 §6) — applies to `QualityReport`, `DiagnosticSnapshot`, `EvictionPlan`; not to `SerializedFleet`.

Three independent version axes evolve at three independent rates. A fleet snapshot at v1 may embed instance snapshots at any per-instance format version the cl-spec-014 evolution policy permits; the fleet wrapper is decoupled from the instance content.

Future fleet-format changes follow the same evolution policy as cl-spec-014 §7:

- Additive changes (new fields, new optional metadata) within a major version. Old consumers ignore unknown fields.
- Breaking changes (renamed or removed fields, semantic shifts) require a major version bump (`-v2`).
- Backward-compat deprecation cycles are at the implementation's discretion; the spec is not prescriptive.

The version is the only field a `fromSnapshot` consumer must check before doing structural work — `fromSnapshot` validates first, then parses. An unrecognized version produces a `ConfigurationError` with the offending value in the error details (Invariant 8).

---

## 9. Invariants and Constraints

**Invariant 1: Read-only consumer.** The fleet monitor does not call segment-mutating methods or configuration-mutating methods on registered instances. It calls `assess()` (or uses cached reports), `getCapacity()`, and `getSegmentCount()` — all of which are non-mutating reads or cache-updating computations.

**Invariant 2: Instance independence.** Registered instances do not share state through the fleet. The fleet aggregates data from instances but does not propagate data between them. An assessment of instance A cannot affect instance B. Cross-instance comparisons in the fleet report are derived from independent assessments.

**Invariant 3: Fail-open assessment.** If one instance's `assess()` throws, the fleet continues assessing the remaining instances. The fleet report includes the failed instance with `status: "error"`. Aggregates and rankings exclude failed instances. One broken instance does not break fleet monitoring.

**Invariant 4: Registration order stability.** The `instances` array in the fleet report follows registration order. The ranking array follows composite score order. These orderings are stable across calls — the same fleet with the same instance scores produces the same report ordering.

**Invariant 5: Event consistency.** Fleet events are emitted only during `assessFleet()` calls with `cached: false`. The event payloads reflect the current assessment, not stale data. `fleetDegraded` is emitted at most once per sustained degradation period — it does not re-fire on each `assessFleet()` while the condition persists. `fleetRecovered` fires when the condition clears.

**Invariant 6: No internal state dependency.** The fleet depends only on the public API of `ContextLens` (cl-spec-007). It does not access internal state, private methods, or implementation details. A conforming `ContextLens` implementation with the same public API would work with the fleet without modification. The lifecycle-aware integration registration (section 7) is part of the public API per cl-spec-015 §6.

**Invariant 7: Auto-unregister on disposal.** A registered instance whose `dispose()` runs (cl-spec-015) is automatically removed from the fleet's tracked set during step 3 of the instance's teardown. After the instance's `dispose()` returns, the fleet does not include the instance in any subsequent `assessFleet`, `listInstances`, `get`, or event emission. The fleet emits exactly one `instanceDisposed` event per auto-unregister (section 6.2). Explicit `unregister(label)` and auto-unregister produce the same fleet-side end state but differ in event semantics (section 7.3).

**Invariant 8: Disposed-instance rejection at registration.** `fleet.register(instance, label)` rejects already-disposed instances with `DisposedError` (raised by the instance's public method that the fleet calls during attachment). The fleet does not silently accept a disposed instance and never emits events for one.

**Invariant 9: Per-instance sequential access.** The strict-sequential contract from cl-spec-007 §12 applies to every registered instance individually. `assessFleet()` invokes `assess()` on each instance sequentially (§1), so the fleet itself never violates the contract. Distinct instances in the fleet may still be mutated concurrently from different async contexts — the fleet does not coordinate across-instance concurrency, and instance independence (Invariant 2) makes that pattern safe. Callers needing parallel per-instance assessment (e.g., many instances in flight at once) must implement that themselves while observing the per-instance sequential contract on each.

**Invariant 10: Pattern-state continuity across serialization.** A fleet restored via `fromSnapshot` rehydrates its per-instance pattern tracking state (§8.1.1). The first `assessFleet()` after restore is silent on the event channel for any pattern set that matches the snapshot's last-known state — only genuine transitions emit events. This preserves event-diffing continuity across the snapshot/restore boundary; callers who want to re-emit `instanceDegraded` for everything currently degraded should bypass `fromSnapshot` and register manually instead.

**Invariant 11: Fleet snapshot atomicity.** `fleet.snapshot()` is all-or-nothing. If any registered instance's `snapshot()` fails (e.g., the instance has been disposed without prior `unregister`), the fleet's snapshot call propagates the underlying error and produces no partial output. `fromSnapshot` is symmetric — a failure at any instance restoration step abandons the partially-restored fleet (the spec does not auto-dispose successfully-restored instances; the caller must clean up if desired).

**Invariant 12: Fleet snapshot version independence.** The fleet snapshot's `formatVersion` (`"context-lens-fleet-snapshot-v1"`) is independent of the per-instance `formatVersion` (cl-spec-014 §7) and the schema version (cl-spec-011 §6). The fleet wrapper evolves at its own rate; embedded instance snapshots evolve under cl-spec-014's rules; report/diagnostic schemas evolve under cl-spec-011's rules. `fromSnapshot` validates each axis independently.

---

## 10. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-007` (API Surface) | Defines the public API that the fleet consumes: `assess()`, `getCapacity()`, `getSegmentCount()`, the lifecycle methods (`dispose`, `isDisposed`, `isDisposing`), and the `DisposedError` raised on disposed-instance method calls. §12 defines the strict-sequential per-instance invocation contract that the fleet inherits (Invariant 9). The fleet is a consumer of this API. |
| `cl-spec-003` (Degradation Patterns) | Defines the pattern detection results that the fleet aggregates into hotspots and fleet-level degradation events. |
| `cl-spec-011` (Report Schema) | Defines schema conventions followed by the FleetReport. The fleet report extends the schema vocabulary with fleet-specific types (FleetAggregate, Hotspot, FleetCapacity). |
| `cl-spec-014` (Serialization) | Defines per-instance `snapshot()` and `fromSnapshot()`. Section 8 of this spec wraps that contract — a `SerializedFleet` embeds one `SerializedState` (cl-spec-014 §4) per registered instance verbatim. The fleet's restore propagates a `RestoreConfig` (cl-spec-014 §5.1) per label via the `FleetRestoreConfig` shape (§8.2). |
| `cl-spec-015` (Instance Lifecycle) | Defines the lifecycle-aware integration model that this spec implements. Section 7 (Instance Disposal Handling) specifies the per-fleet teardown callback contract executed during step 3 of an instance's `dispose()` teardown sequence. cl-spec-015 §6.3 enumerates the same fleet-side behavior from the lifecycle perspective. cl-spec-014 §3 governs the post-disposal rejection that propagates to `fleet.snapshot()` (Invariant 11). |

---

*context-lens -- authored by Akil Abderrahim, Claude Opus 4.6, and Claude Opus 4.7*
