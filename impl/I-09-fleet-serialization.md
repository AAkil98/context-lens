# Phase 9 — Fleet Serialization (Gap 3 of v0.2.0 hardening)

## 1. Preamble

Phase 9 implements the `ContextLensFleet.snapshot()` / `ContextLensFleet.fromSnapshot()` surface specified by cl-spec-012 §8 (added in the 2026-05-02 amendment for Gap 3 of v0.2.0 hardening). The motivating use case is the same as for instance serialization: persist the working state of an entire monitored deployment, then continue from that state on a fresh process or after a per-instance dispose / restore cycle. Wraps the existing `ContextLens.snapshot` / `ContextLens.fromSnapshot` (cl-spec-014) without changing their contract.

**Design specs covered:**
- `cl-spec-012` (Fleet Monitor) §8 (Fleet Serialization) — Snapshot, Restore, Format Versioning subsections; Invariants 10–12
- `cl-spec-014` (Serialization) §5 amendment — fleet wrapping acknowledgment

**Performance budget:** `cl-spec-009` — `fleet.snapshot()` is O(N) in registered instances where each `instance.snapshot()` cost is per cl-spec-014 §3 (~O(n) in segments + history sizes). `fleet.fromSnapshot` is symmetric. Neither is on the hot path; the budget is the per-instance batch tier (cl-spec-009 §3.5 — proportional to N × per-instance budget).

**Key resolutions referenced (per V0_2_0_BACKLOG.md decision locks confirmed 2026-05-01):**
- Pattern-state cache preserved across restore (Invariant 10). The fleet's per-instance diff state (`activePatterns`, `patternActivatedAt`, `lastAssessedAt`) and global `fleetDegradedState` flag are serialized alongside the embedded instance snapshots and rehydrated on `fromSnapshot`. The first `assessFleet()` after restore is silent on the event channel for any pattern set matching the snapshot's last-known state.
- Per-label `RestoreConfig` map with `default` fallback. Production fleets typically run heterogeneous workloads — different agents may use different embedding providers, custom patterns, or capacities. Forcing one shared config across the fleet would either constrain provider choice at construction time or push per-label config handling onto the caller. The `FleetRestoreConfig.perLabel` map permits per-instance overrides without external dispatch.

**Parent document:** `IMPLEMENTATION.md` — Phase 9 row to be added as a v0.2.0 hardening entry alongside Phases 6 (dispose), 7 (OTel re-attach), and 8 (memory release).

---

## 2. Module Map

| Module | Primary design spec | Responsibility |
|--------|---------------------|----------------|
| `fleet.ts` (modified) | cl-spec-012 §8 | Adds `snapshot(options?)` instance method and `static fromSnapshot(state, config)` factory. Adds `getInternalState()` private accessor (or inlined logic) so `snapshot()` can read the per-instance tracking state and the global `fleetDegradedState` flag without exposing them to consumers. |
| `types.ts` (modified) | cl-spec-012 §8.1.2, §8.2 | Adds `SerializedFleet`, `SerializedFleetInstance` (one entry of the `instances[]` array), `FleetTrackingState` (per-instance diff state), `FleetState` (fleet-level diff state), `FleetRestoreConfig`, `FleetSnapshotOptions`. Re-exported from package main entry. |

No new modules. `fleet.ts` already imports `ContextLens` (the import for `attachIntegration`); the snapshot/restore methods reuse that import. The `RestoreConfig` shape is already defined in `index.ts` and re-exported; `FleetRestoreConfig` references it.

---

## 3. Dependency Direction

Unchanged. `fleet.ts` is a consumer of `ContextLens.snapshot` and `ContextLens.fromSnapshot`; no new imports.

```
                     ┌──────────────────────┐
                     │  index.ts (ContextLens)│
                     │  + snapshot           │
                     │  + fromSnapshot       │
                     └──────────┬───────────┘
                                │
                                v consumed by
                     ┌──────────────────────┐
                     │  fleet.ts            │
                     │  + snapshot          │
                     │  + fromSnapshot      │
                     └──────────────────────┘
```

`fleet.ts` does not import `lifecycle.ts` or any new module. The fleet's `register()` already calls `instance.attachIntegration` (Phase 6); that path is reused on restore.

---

## 4. Module Specifications

### 4.1 types.ts (additions)

```ts
// ─── Fleet Serialization Domain (cl-spec-012 §8) ──────────────────

/**
 * Per-instance fleet-level diff state captured in a fleet snapshot.
 * Mirrors the runtime InstanceState minus the references that cannot
 * be serialized (`instance`, `handle`).
 *
 * @see cl-spec-012 §8.1.1
 */
export interface FleetTrackingState {
  /** Names of patterns that were active on this instance at snapshot time. */
  activePatterns: string[];
  /** Per-pattern activation timestamps for duration computation on resolve. */
  patternActivatedAt: Record<string, number>;
  /** Wall-clock at the most recent fresh assessment of this instance through the fleet. Null if never assessed via the fleet. */
  lastAssessedAt: number | null;
}

/**
 * Fleet-level diff state captured in a fleet snapshot.
 * @see cl-spec-012 §8.1.2
 */
export interface FleetState {
  /** Whether the fleet is in fleetDegraded state for fleetDegraded/fleetRecovered diffing. */
  fleetDegradedState: boolean;
}

/**
 * One entry in {@link SerializedFleet.instances}.
 * @see cl-spec-012 §8.1.2
 */
export interface SerializedFleetInstance {
  label: string;
  snapshot: SerializedState;
  trackingState: FleetTrackingState;
}

/**
 * Self-contained snapshot of a {@link ContextLensFleet}. Embeds one
 * {@link SerializedState} per registered instance verbatim, plus the fleet's
 * pattern-state cache and global diff flag.
 *
 * Format version is independent of {@link SerializedState.formatVersion}
 * (cl-spec-014 §7) and the schema version (cl-spec-011 §6).
 *
 * @see cl-spec-012 §8
 */
export interface SerializedFleet {
  formatVersion: 'context-lens-fleet-snapshot-v1';
  timestamp: number;
  fleetOptions: { degradationThreshold: number };
  instances: SerializedFleetInstance[];
  fleetState: FleetState;
}

/**
 * Configuration for {@link ContextLensFleet.fromSnapshot}. Provides a default
 * {@link RestoreConfig} applied to every instance, plus optional per-label
 * overrides for heterogeneous fleet deployments.
 *
 * @see cl-spec-012 §8.2
 */
export interface FleetRestoreConfig {
  /** Required default RestoreConfig — applied when no perLabel entry matches. */
  default: RestoreConfig;
  /** Optional per-label overrides. Labels not in the snapshot are ignored. */
  perLabel?: Record<string, RestoreConfig>;
}

/**
 * Options for {@link ContextLensFleet.snapshot}.
 * @see cl-spec-012 §8.1
 */
export interface FleetSnapshotOptions {
  /**
   * If false, every embedded instance snapshot is lightweight (content: null,
   * restorable: false) per cl-spec-014 §6. Default true.
   */
  includeContent?: boolean;
}
```

`RestoreConfig` is imported from the package main entry where it is defined (cl-spec-014 §5.1). It declares the per-instance tokenizer, embedding provider, custom patterns, and capacity overrides.

### 4.2 fleet.ts (modifications)

#### 4.2.1 Constants

```ts
const FLEET_FORMAT_VERSION = 'context-lens-fleet-snapshot-v1';
```

Added near the existing `SCHEMA_VERSION` and `DEFAULT_DEGRADATION_THRESHOLD` constants. Independent of any other version axis.

#### 4.2.2 snapshot method

```ts
/**
 * Capture a self-contained snapshot of fleet state. Embeds one
 * ContextLens.snapshot per registered instance verbatim and preserves the
 * fleet's per-instance pattern-state cache for event-diffing continuity
 * across restore (cl-spec-012 §8.1.1).
 *
 * @param options.includeContent — propagates to every instance snapshot per
 *   cl-spec-014 §6. Default true (full snapshots, restorable).
 * @returns A SerializedFleet wrapper.
 * @throws DisposedError — surfaced verbatim if any registered instance has
 *   been disposed without prior unregister.
 * @see cl-spec-012 §8.1
 */
snapshot(options?: FleetSnapshotOptions): SerializedFleet {
  const includeContent = options?.includeContent ?? true;
  const now = Date.now();

  const instances: SerializedFleetInstance[] = [];
  for (const label of this.labels) {
    const state = this.instances.get(label)!;
    // instance.snapshot throws DisposedError if the instance is disposed —
    // surface verbatim per Invariant 11 (atomicity).
    const instanceSnapshot = state.instance.snapshot({ includeContent });
    instances.push({
      label,
      snapshot: instanceSnapshot,
      trackingState: {
        activePatterns: [...state.activePatterns],
        patternActivatedAt: Object.fromEntries(state.patternActivatedAt),
        lastAssessedAt: state.lastAssessedAt,
      },
    });
  }

  return {
    formatVersion: FLEET_FORMAT_VERSION,
    timestamp: now,
    fleetOptions: { degradationThreshold: this.degradationThreshold },
    instances,
    fleetState: { fleetDegradedState: this.fleetDegradedState },
  };
}
```

The method is synchronous because `ContextLens.snapshot` is synchronous (cl-spec-014 §3.2). Single-threaded contract per cl-spec-007 §12 holds — the fleet does not coordinate across-instance concurrency, but each per-instance `snapshot()` is itself sequential.

#### 4.2.3 fromSnapshot static factory

```ts
/**
 * Reconstruct a fully-functional fleet from a SerializedFleet. Wraps
 * ContextLens.fromSnapshot for each member and re-establishes registration
 * plus the lifecycle integration handshake atomically.
 *
 * @param state The SerializedFleet produced by a previous snapshot() call.
 * @param config FleetRestoreConfig with default + optional perLabel overrides.
 * @returns A live ContextLensFleet with all instances registered, tracking
 *   state rehydrated, and fleet-level diff flag restored.
 * @throws ConfigurationError — unrecognized formatVersion.
 * @throws ValidationError — missing default config; duplicate label in
 *   instances array; malformed trackingState.
 * @throws Any error thrown by an inner ContextLens.fromSnapshot — propagates
 *   verbatim, with the offending label prepended to the message.
 * @see cl-spec-012 §8.2
 */
static fromSnapshot(state: SerializedFleet, config: FleetRestoreConfig): ContextLensFleet {
  // Step 1: validate format version.
  if (state.formatVersion !== FLEET_FORMAT_VERSION) {
    throw new ConfigurationError(
      `Unsupported fleet snapshot format: ${state.formatVersion}. Expected: ${FLEET_FORMAT_VERSION}`,
      { formatVersion: state.formatVersion },
    );
  }

  // Step 2: validate config.
  if (config == null || config.default == null) {
    throw new ValidationError('FleetRestoreConfig.default is required', {});
  }

  // Step 3: validate label uniqueness in the snapshot itself (defensive).
  const seen = new Set<string>();
  for (const entry of state.instances) {
    if (seen.has(entry.label)) {
      throw new ValidationError(`Duplicate label in fleet snapshot: ${entry.label}`, { label: entry.label });
    }
    seen.add(entry.label);
  }

  // Step 4: construct fresh fleet.
  const fleet = new ContextLensFleet(state.fleetOptions);

  // Step 5: restore each instance, register, and rehydrate tracking state.
  for (const entry of state.instances) {
    const restoreConfig = config.perLabel?.[entry.label] ?? config.default;
    let restored: ContextLens;
    try {
      restored = ContextLens.fromSnapshot(entry.snapshot, restoreConfig);
    } catch (err) {
      // Decorate with the offending label, preserve the original cause.
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigurationError(
        `Fleet restore failed at instance "${entry.label}": ${message}`,
        { label: entry.label, cause: err },
      );
    }

    // register() reattaches the lifecycle integration handshake.
    fleet.register(restored, entry.label);

    // Rehydrate per-instance tracking state.
    const trackedState = fleet.instances.get(entry.label)!;
    trackedState.activePatterns = new Set(entry.trackingState.activePatterns);
    trackedState.patternActivatedAt = new Map(Object.entries(entry.trackingState.patternActivatedAt));
    trackedState.lastAssessedAt = entry.trackingState.lastAssessedAt;
  }

  // Step 6: restore fleet-level diff flag.
  fleet.fleetDegradedState = state.fleetState.fleetDegradedState;

  return fleet;
}
```

`fleet.instances` and `fleet.fleetDegradedState` are private fields on `ContextLensFleet`. `fromSnapshot` is a static method on the same class — TypeScript permits private-field access from static methods on the same class. No accessor needed.

`ContextLens` is imported once at the top of `fleet.ts` (already present for `attachIntegration` typing); the static `fromSnapshot` call uses the same import.

#### 4.2.4 Atomicity note

Step 5's loop is iterative, not transactional. If iteration fails on the kth instance after k-1 successful restores, the k-1 already-restored instances are abandoned (registered with the partial fleet, which is then thrown away by the caller). The spec is explicit (cl-spec-012 §8.2 + Invariant 11):

> The spec does not auto-dispose successfully-restored instances; the caller must clean up if desired.

We do not attempt to dispose the partial-restored instances inside the catch — disposing requires the caller's context and may involve provider shutdown they are responsible for. The ConfigurationError carries the offending label so the caller can correlate.

A future iteration may add a `bestEffort: boolean` option to `FleetRestoreConfig` for partial restore semantics, but v0.2.0 keeps the strict atomic posture.

### 4.3 Re-exports

`FleetSnapshotOptions`, `SerializedFleet`, `SerializedFleetInstance`, `FleetTrackingState`, `FleetState`, and `FleetRestoreConfig` are exported from `types.ts` and re-exported from the package main entry alongside the existing fleet types (`InstanceReport`, `FleetAggregate`, etc.).

---

## 5. Test Requirements

### Unit tests

In `test/unit/fleet.test.ts` (existing, expanded):

- **Snapshot shape:** `fleet.snapshot()` returns the documented `SerializedFleet` shape — `formatVersion === 'context-lens-fleet-snapshot-v1'`, registration-ordered `instances[]`, captured `fleetOptions`, and `fleetState` with `fleetDegradedState`.
- **Empty fleet snapshot:** A fleet with no registered instances snapshots cleanly. `instances` is `[]`; `fleetState.fleetDegradedState` is `false`.
- **Lightweight snapshot propagation:** `fleet.snapshot({ includeContent: false })` produces embedded snapshots with `content: null` and `restorable: false` on every instance.
- **Disposed instance rejection:** Register an instance, dispose it before unregister (the fleet auto-unregisters on dispose, but a race scenario is constructed via mocking). `fleet.snapshot()` propagates the `DisposedError` per Invariant 11.
- **Round-trip — minimal fleet:** Construct a fleet, register two instances with content, take a full snapshot, restore via `fromSnapshot` with a default `RestoreConfig`. Verify the restored fleet has the same labels in the same order, the same instance count, and the same `fleetDegradedState`.
- **Round-trip — full state:** Same pattern with adds, evictions, an active pattern, a non-trivial `lastAssessedAt`. Verify pattern-state cache is preserved (asserted by reading the per-instance state via the fleet's existing inspection methods or by the post-restore event behavior in the integration suite).
- **Format version mismatch:** `fromSnapshot({ ...state, formatVersion: 'foo' }, config)` throws `ConfigurationError` with the offending value in `details`.
- **Missing config.default:** `fromSnapshot(state, {} as FleetRestoreConfig)` throws `ValidationError`.
- **Duplicate label in snapshot:** Hand-crafted `state` with two entries sharing a label triggers `ValidationError` before any `ContextLens.fromSnapshot` runs.
- **Per-label config dispatch:** Restore with `perLabel` map covering one label and `default` covering the rest. Verify that the named instance was restored with the per-label config (verified indirectly via behavior or by mocking `ContextLens.fromSnapshot`).
- **Inner failure decoration:** A malformed instance snapshot (e.g., `restorable: false` for a full restore) causes `ContextLens.fromSnapshot` to throw inside the loop. The fleet's `fromSnapshot` re-throws with the offending label prepended.
- **fleetOptions preservation:** `degradationThreshold` from the snapshot wins over any constructor default. A fleet built with `{ degradationThreshold: 0.7 }`, snapshotted, restored produces a fleet with `degradationThreshold: 0.7`.

### Integration tests

In `test/integration/fleet.test.ts` (new file):

- **Pattern-state continuity across restore:** Build a fleet, register two instances, drive one into a critical pattern via segment additions that trigger saturation. Run `assessFleet()` to populate the diff state and emit `instanceDegraded`. Snapshot the fleet, restore on a new instance via `fromSnapshot`. Subscribe to `instanceDegraded` on the restored fleet. Run `assessFleet()` immediately. Assert: zero `instanceDegraded` events fire (the cached state matches; no spurious re-fire). Then mutate to add a second pattern; assert `instanceDegraded` fires for the new one only.
- **Snapshot-then-dispose-then-fromSnapshot continuation (fleet variant):** Build a fleet, register an instance, mutate, assess. Snapshot the fleet. Dispose all instances (auto-unregister fires). Restore the fleet via `fromSnapshot`. Verify the new fleet has the original labels and the restored instances are independent live ContextLens instances with fresh `instanceId`s.
- **Heterogeneous restore via perLabel config:** Build a fleet with two instances, each using a different (mocked) embedding provider. Snapshot. Restore with `perLabel` mapping each label to its own `RestoreConfig`. Verify each restored instance has the correct provider metadata.

### Property-based tests

None planned. The state space (registration order, per-instance pattern set, fleetDegradedState) is enumerable; the unit tests exhaust the meaningful combinations. Adding fast-check would be ceremonial.

### Performance benchmarks

Optional. `fleet.snapshot()` is O(N × instance.snapshot cost); the per-instance budget is set in cl-spec-009 and inherited. Adding a fleet-specific bench would be useful when N grows large; v0.2.0 ships without one and adds it if a regression is suspected.

---

## 6. Exit Criteria

- `ContextLensFleet.prototype.snapshot(options?)` exists with the documented signature and shape. Lightweight (`includeContent: false`) propagation works end-to-end.
- `ContextLensFleet.fromSnapshot(state, config)` static factory exists. Validates format version, validates config, constructs fresh fleet, restores each instance, registers, rehydrates per-instance tracking, restores fleet-level diff flag.
- Atomicity preserved on inner failure: a `ContextLens.fromSnapshot` throw inside the loop propagates as a `ConfigurationError` with offending label decoration; partial state is abandoned (no auto-dispose).
- Pattern-state cache preserved across restore (Invariant 10); first `assessFleet()` after restore emits no `instanceDegraded` events for already-active patterns.
- New types (`SerializedFleet`, `SerializedFleetInstance`, `FleetTrackingState`, `FleetState`, `FleetRestoreConfig`, `FleetSnapshotOptions`) defined in `types.ts` and re-exported from the main entry.
- All existing tests pass (1167 hard floor). New tests added per section 5; expected count growth ~12–15 unit tests + 3 integration tests.
- `cl-spec-012` §8 and the cl-spec-014 §5 amendment are fully implemented as specified. Any deviations documented in this spec or in a follow-up grill record.
- Public API surface gains exactly two methods (`fleet.snapshot`, `ContextLensFleet.fromSnapshot`), six types, and one constant (`FLEET_FORMAT_VERSION` — internal, not re-exported). No other surface additions.

---

*context-lens implementation spec — Phase 9 (v0.2.0 Gap 3)*
