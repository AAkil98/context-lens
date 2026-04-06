# Phase 5 -- Enrichments

## 1. Preamble

Phase 5 introduces four optional, independently shippable features that consume the public API established in Phase 4. Each enrichment is a read-only consumer of the `ContextLens` class -- none of them access internal modules, modify instance state, or require changes to the core library. They can be shipped incrementally: a release with only `schema` and `serialization` is useful; `fleet` and `otel` can follow separately.

All four enrichments are structurally similar: they wrap or extend existing public surface without altering it. The core library's bundle size, startup time, and correctness are unaffected by their presence or absence.

**Design specs covered:**
- `cl-spec-011` (Report Schema) -- JSON Schema files, shared type definitions, serialization conventions, validation, schema versioning
- `cl-spec-012` (Fleet Monitor) -- ContextLensFleet class, fleet assessment, fleet report, fleet events
- `cl-spec-013` (Observability Export) -- ContextLensExporter class, OTel metrics, OTel events, peer dependency on @opentelemetry/api
- `cl-spec-014` (Serialization) -- snapshot/fromSnapshot, included/excluded state, format versioning, provider change detection, custom pattern restoration

**Key resolutions referenced:**
- R-189: Fleet state is not serializable (documented limitation)
- R-190: OTel exporter and fleet registrations are not restored after fromSnapshot() -- caller must manually re-attach
- OQ-010: Schema versions are independent of library versions (cl-spec-011 SS2)
- OQ-011: assessFleet() calls assess() on each instance by default (cl-spec-012 SS4)
- OQ-012: Two snapshot modes (full/lightweight) via a single method with includeContent option (cl-spec-014 SS6)

**Parent document:** `IMPLEMENTATION.md` (section 5, Phase 5 row; section 4, dependency graph)

---

## 2. Module Map

| Module | File(s) | Primary design spec | Responsibility |
|--------|---------|-------------------|----------------|
| `schema` | `schemas/index.ts`, `schemas/*.json` | cl-spec-011 | JSON Schema files (draft 2020-12) for the three output types, static schema exports, toJSON() conversion, validate() function |
| `serialization` | `serialization.ts` | cl-spec-014 | snapshot() state capture, fromSnapshot() restoration, format versioning, provider change detection, custom pattern matching |
| `fleet` | `fleet.ts` | cl-spec-012 | ContextLensFleet class, instance registration, fleet assessment, fleet report aggregation, fleet events |
| `otel` | `otel.ts` | cl-spec-013 | ContextLensExporter class, OTel gauge/counter/histogram instruments, OTel log events, event subscription lifecycle |

---

## 3. Shared Concerns

### 3.1 Sub-path exports

`fleet` and `otel` are separate entry points, not part of the main `context-lens` import. The package.json exports map (defined in IMPLEMENTATION.md SS3) routes them:

- `context-lens` resolves to `index.ts` (the ContextLens class, types, errors, formatters, schemas, serialization)
- `context-lens/fleet` resolves to `fleet.ts` (ContextLensFleet)
- `context-lens/otel` resolves to `otel.ts` (ContextLensExporter)
- `context-lens/schemas` resolves to `schemas/index.ts` (static schema objects)

Each sub-path entry point produces its own bundle output (ESM + CJS via tsup). The sub-path modules import from the main `context-lens` package using the public API -- they do not reach into `src/` internals. Tree-shaking works: a caller who never imports `context-lens/otel` never loads the OTel adapter code.

### 3.2 Optional dependencies

`@opentelemetry/api` is declared as a peer dependency with `"optional": true` in package.json. It is required only by the `context-lens/otel` entry point. Importing `context-lens/otel` without the OTel SDK installed produces a clear error at import time (module resolution failure), not a deferred runtime crash.

The core library, `context-lens/fleet`, and `context-lens/schemas` have zero runtime dependencies.

### 3.3 Testing with mocked core

All enrichment tests interact with the public `ContextLens` API, not with internal modules. Test instances are constructed normally, populated with test segments, and passed to enrichment modules. No internal state is inspected or mocked -- if the public API contract holds, enrichments work correctly.

For the OTel adapter, tests mock the `@opentelemetry/api` MeterProvider and LoggerProvider interfaces. The mocks record metric updates and events, which the tests assert against. No real OTel SDK is required in the test suite.

For the fleet monitor, tests create multiple ContextLens instances, register them with a fleet, and verify the fleet report's aggregated values against independently computed expectations.

### 3.4 Schema versioning

Schema versions are independent of the library version (cl-spec-011 SS2, resolution OQ-010). The schema version follows semver: MAJOR.MINOR.PATCH. Within a major version, changes are additive only -- new optional fields, new enum values. No removals, no type changes.

The snapshot format version (`"context-lens-snapshot-v1"`) is also independent of both the library version and the schema version (cl-spec-014 SS7). The snapshot format describes the shape of serialized state; the schema version describes the shape of output objects. They evolve on different cadences.

### 3.5 Enrichment independence after fromSnapshot()

Fleet registrations and OTel exporter subscriptions are not serialized or restored (R-189, R-190). After calling `fromSnapshot()`, the restored instance's event system starts with no subscribers. The caller must:

1. Re-register the instance with any fleet via `fleet.register(restoredInstance, label)`.
2. Re-create any OTel exporter via `new ContextLensExporter(restoredInstance, options)`.

This is documented in the serialization module's restored-instance behavior and in the fleet/otel modules' lifecycle documentation. It is not an error or a missing feature -- it follows from the principle that event handlers and external references are not serializable.

---

## 4. Module Specifications

### 4.1 schema

The schema module provides JSON Schema definitions for the three output types (`QualityReport`, `DiagnosticSnapshot`, `EvictionPlan`), a conversion utility that produces schema-conforming plain objects, and a validation utility that checks plain objects against schemas.

#### 4.1.1 JSON Schema files

Three JSON Schema files (draft 2020-12) live in `schemas/`:

| File | Root type | Source |
|------|-----------|--------|
| `quality-report.json` | QualityReport | cl-spec-011 SS3 |
| `diagnostic-snapshot.json` | DiagnosticSnapshot | cl-spec-011 SS4 |
| `eviction-plan.json` | EvictionPlan | cl-spec-011 SS5 |

Each file is self-contained -- all shared type definitions are inlined as `$defs` within the file. No external `$ref` resolution is required. A consumer can validate output using a single schema file and any draft 2020-12 compliant validator, with no network access and no additional files.

The ~35 shared type definitions from cl-spec-011 SS6 (WindowScores, BaselineSnapshot, SegmentScore, CapacityReport, DetectionResult, ActivePattern, TaskSummary, ContinuitySummary, TrendData, etc.) appear as `$defs` in each file. Duplication across files is intentional and acceptable -- the definitions are generated from cl-spec-011, not hand-maintained.

#### 4.1.2 Serialization conventions

All schema-conforming output follows the conventions from cl-spec-011 SS8:

- **Timestamps** are epoch-millisecond numbers (IEEE 754 double), not ISO 8601 strings.
- **Scores** are IEEE 754 doubles, no more than 6 significant digits after the decimal point. Scores that are mathematically exact (0.0, 1.0) may serialize as integers.
- **Enums** are lowercase or camelCase strings matching the values defined in cl-spec-011 SS7.
- **Null** indicates not-yet-available, not-applicable, or undefined-value. Only fields explicitly marked nullable in the spec may be null.
- **Arrays** are never null. Empty arrays (not null) represent "no items."
- **No circular references.** The entire output tree is a DAG. `JSON.stringify` on the output of `toJSON` never throws a circular reference error.

#### 4.1.3 Static schema exports

The `schemas/index.ts` module exports the three schema objects and the current schema version string. These are static exports -- they do not require a ContextLens instance. They are available at `context-lens/schemas` or via the main `context-lens` import.

#### 4.1.4 toJSON utility

`toJSON()` converts typed output objects (QualityReport, DiagnosticSnapshot, EvictionPlan) to schema-conforming plain JavaScript objects. It strips non-serializable state (provider references, internal flags) and sets the `schemaVersion` field automatically. The result can be passed directly to `JSON.stringify`.

This is a separate function, not reliance on `JSON.stringify` on raw internal objects, because internal TypeScript objects may contain non-serializable state that does not belong in the schema output (cl-spec-011 SS9.3).

#### 4.1.5 validate utility

`validate()` checks a plain object against the corresponding schema. It returns `{ valid: boolean, errors: ValidationError[] }`. The validator uses a JSON Schema validation library internally. Validation scope is structural (correct fields, correct types, required fields present, enum values in range, numeric constraints met). Semantic validation (e.g., that utilization equals totalActiveTokens / capacity) is the reference implementation's responsibility, not the schema's.

Three entry points: `validate.qualityReport(obj)`, `validate.diagnosticSnapshot(obj)`, `validate.evictionPlan(obj)`.

---

### 4.2 serialization

The serialization module implements `snapshot()` and `fromSnapshot()` on the ContextLens class. Unlike fleet and otel, serialization accesses internal instance state -- it reads private fields to assemble the snapshot and writes them during restore. It is implemented in `serialization.ts` and wired into the ContextLens class as instance and static methods.

#### 4.2.1 snapshot(options?)

Produces a complete, self-contained `SerializedState` object capturing the instance's state at the moment of the call. The result is a plain JSON-safe object -- no class instances, no circular references, no platform-specific types.

**Included state (from cl-spec-014 SS2.1):**
- All segments (active + evicted with retained content): content, metadata, protection, group membership, position order, token counts
- All groups: structure, membership, aggregate properties
- Task state: current descriptor, lifecycle state, transition history, grace period, staleness counters
- Quality baseline: captured scores and metadata
- Continuity ledger: full eviction/compaction/restoration history
- Pattern tracking state: per-pattern active/inactive state, severity, hysteresis state, consecutive report counts, score histories
- Pattern history: per-pattern stats and the 50-entry history ring buffer
- Session timeline: the 200-entry event ring buffer
- Report history: the 20-entry report summary ring buffer and rolling trend state
- Warnings: accumulated warning list
- Configuration: all config values (capacity, retainEvictedContent, pinnedCeilingRatio, patternThresholds, suppressedPatterns, hysteresisMargin, tokenCacheSize, embeddingCacheSize)
- Custom pattern metadata: name, description, priority, strategyHint, registeredAt, registrationOrder (functions excluded)
- Provider metadata: tokenizer name/accuracy/modelFamily/errorBound, embedding provider name/dimensions/modelFamily
- Session counters: assessCount, mutationCount

**Excluded state (from cl-spec-014 SS2.2):**
- Provider instances (tokenizer, embedding) -- not JSON-serializable, re-provided on restore
- Caches (token count, embedding, similarity) -- derived data, rebuilt on use after restore; embedding cache alone can be 6-100MB
- Computed quality scores -- recomputed on first assess() after restore to avoid consistency risk with changed providers
- Event handlers -- closures, not serializable, re-registered by caller
- Custom pattern functions (detect, severity, explanation, remediation) -- functions, not serializable, re-provided on restore
- Performance metrics -- session-specific, reset on restore

**includeContent option.** When `includeContent` is `false`, all segment content fields are set to `null` and the snapshot's `restorable` flag is set to `false`. The resulting lightweight snapshot is ~10x smaller (dominated by timeline and history buffers rather than segment content). Useful for analytics export and cross-network transport where content may be sensitive or unnecessary. `fromSnapshot` rejects lightweight snapshots with a clear error.

**Performance.** Snapshot production is O(n) in segments. It reads existing state and copies it -- no quality computation, no provider calls, no cache operations. Under 10ms for 500 segments.

**Events.** Emits `stateSnapshotted` with `{ timestamp, restorable, segmentCount, sizeEstimate }`.

#### 4.2.2 fromSnapshot(state, config?)

Static factory method on `ContextLens` that creates a fully functional instance from a serialized snapshot.

**RestoreConfig** allows the caller to override: `capacity` (may differ from snapshot's), `tokenizer` (must be re-provided), `embeddingProvider` (must be re-provided), `customPatterns` (re-provided with functions). All other configuration fields are restored from the snapshot.

**Restore sequence (from cl-spec-014 SS5.2):**

1. Validate format version. Reject unrecognized versions with `ConfigurationError`.
2. Create instance with merged config (snapshot config + RestoreConfig overrides). Starts empty.
3. Restore segments in position order. Active and evicted segments restored to their respective states.
4. Restore groups with membership and metadata.
5. Restore task state: descriptor, lifecycle, transition history, grace period, staleness counters.
6. Restore baseline (if present in snapshot). Baseline is an immutable historical record, not recomputed.
7. Restore continuity ledger.
8. Restore pattern tracking state: per-pattern hysteresis, severity, activation timestamps, history.
9. Restore diagnostics: timeline, report history, rolling trends, warnings.
10. Re-register custom patterns by matching provided `customPatterns` to snapshot metadata by name. Matched patterns get their tracking state restored. Unmatched snapshot patterns emit a warning. Patterns in `customPatterns` but not in snapshot start fresh.
11. Detect provider changes by comparing snapshot provider metadata against restore-time providers. Different tokenizer name triggers full recount (all segments). Different embedding provider name triggers full re-embedding.
12. Invalidate all quality scores. Caches are empty. First `assess()` recomputes everything.
13. Emit `stateRestored` event.

**Atomicity.** If any step fails, the partially-constructed instance is discarded and an error is thrown. No half-restored instance is returned.

**Provider change detection (cl-spec-014 SS5.3).** Tokenizer change (different name) triggers O(n) recount of all segments. Embedding provider change (different name, or mode switch between embeddings and trigrams) triggers full re-embedding. Same-name providers trust the snapshot's cached token counts; embeddings rebuild lazily on first assess().

**Custom pattern restoration (cl-spec-014 SS5.4).** Matching is by name. When a pattern appears in both the snapshot metadata and the provided `customPatterns`, the pattern is registered with the caller's function definitions but the snapshot's tracking state (hysteresis, history) is restored. Priority and strategyHint come from the caller's definition, not the snapshot -- the caller may have updated them.

**Post-restore behavior.** The restored instance is indistinguishable from one built incrementally. All operations work normally. Timeline and history continue from where the snapshot left off. `getDiagnostics().latestReport` is null until the first `assess()`.

#### 4.2.3 Format versioning

The format version is `"context-lens-snapshot-v1"`. It is distinct from the schema version and the library version. Forward compatibility: unknown fields are silently ignored. Backward compatibility: the implementation maintains a deserializer for each published format version, filling new fields with defaults on migration.

---

### 4.3 fleet

The fleet module provides `ContextLensFleet` -- a lightweight aggregator that holds references to multiple ContextLens instances, queries them on demand, and assembles fleet-level quality reports. It is a sub-path export at `context-lens/fleet`.

#### 4.3.1 Construction and registration

`ContextLensFleet` is constructed with an optional `degradationThreshold` (default 0.5) -- the fraction of instances with active patterns that triggers `fleetDegraded` events.

**register(instance, label):** Adds an instance under a unique label. Label must be non-empty and unique within the fleet. The fleet holds a reference, not ownership -- the caller remains responsible for the instance's lifecycle.

**unregister(label):** Removes the reference. The instance is not affected.

**listInstances():** Returns lightweight metadata for all registered instances (label, segmentCount, capacity, utilization, lastAssessedAt). Does not trigger assessment -- reads from each instance's public inspection methods.

**get(label):** Returns the instance reference, or null if not found.

An instance can be registered with multiple fleets under different labels. The fleet does not propagate state between instances.

#### 4.3.2 Fleet assessment

**assessFleet(options?):** The central method. Queries all registered instances and assembles a `FleetReport`.

By default (`cached: false`), calls `assess()` on each instance in registration order to get fresh, comparable reports. This ensures all reports are from the same `assessFleet()` call -- no stale data, no timing skew between instances (resolution OQ-011).

With `cached: true`, reads each instance's latest cached report. Instances with no cached report appear with `report: null`. Useful when the caller is already assessing instances on their own cadence. Fleet events are not emitted in cached mode.

**Error handling.** If one instance's `assess()` throws, the fleet catches the error, records the instance as `{ status: "error", error: message }`, and continues with remaining instances. Aggregates and rankings exclude failed instances. The fleet report includes `failedInstances` count. One broken instance does not break fleet monitoring.

**assessInstance(label, options?):** Assesses a single instance and returns its per-instance report. Cheaper than full fleet assessment when drilling into one instance.

#### 4.3.3 FleetReport

The fleet report contains:

- **Per-instance reports** (`instances` array, registration order): label, status ("ok" / "no-report" / "error"), the instance's QualityReport (or null), and capacity metrics.
- **Fleet aggregates** (`aggregate`): per-dimension statistics (mean, min, max, stddev, minInstance, maxInstance) for coherence, density, relevance, continuity, composite, and utilization. Computed only from instances with status "ok".
- **Hotspots** (`hotspots`): instances with at least one active degradation pattern, sorted by highestSeverity descending (critical first), then patternCount descending, then composite ascending (worst quality first). An empty hotspots array means all instances are healthy.
- **Ranking** (`ranking`): instances ranked by composite score ascending (weakest = rank 1). Ties broken by utilization (higher utilization = worse = lower rank). Instances with null composite (empty windows) ranked last.
- **Capacity overview** (`capacityOverview`): totalCapacity, totalActiveTokens, fleetUtilization, overCapacityCount (utilization > 1.0), highUtilizationCount (utilization > 0.85).

#### 4.3.4 Fleet events

The fleet emits its own events, separate from per-instance events. Same subscription model as the core (`fleet.on(event, handler)` returns an unsubscribe function).

| Event | Emitted when |
|-------|-------------|
| `instanceDegraded` | A registered instance activates a new pattern (detected during assessFleet) |
| `instanceRecovered` | A previously active pattern on a registered instance resolves |
| `fleetDegraded` | Fraction of instances with active patterns exceeds degradationThreshold |
| `fleetRecovered` | Fraction drops below threshold after a fleetDegraded event |

Detection works by diffing the current assessFleet() result against the previous one. The fleet maintains a lightweight previous-state cache: per-instance highestSeverity and active pattern names. Events fire only during fresh assessment (`cached: false`). `fleetDegraded` fires at most once per sustained degradation period -- it does not re-fire while the condition persists.

#### 4.3.5 Invariants

**Read-only consumer.** The fleet calls `assess()`, `getCapacity()`, and `getSegmentCount()` -- all non-mutating. It never calls segment-mutating or config-mutating methods.

**Instance independence.** Registered instances do not share state through the fleet. Assessment of instance A cannot affect instance B.

**Fail-open.** One failing instance does not break fleet assessment or event detection.

**Registration order stability.** The `instances` array follows registration order. Rankings follow composite score order. Both orderings are stable across calls.

**Not serializable (R-189).** The fleet holds instance references, not instance state. To persist and restore a fleet: serialize individual instances via `snapshot()`, restore via `fromSnapshot()`, re-register with a new fleet.

---

### 4.4 otel

The OTel module provides `ContextLensExporter` -- an adapter that translates context-lens quality signals into OpenTelemetry metrics and events. It is a sub-path export at `context-lens/otel`. The `@opentelemetry/api` package is a peer dependency.

#### 4.4.1 Construction and lifecycle

`ContextLensExporter` wraps a single ContextLens instance. Construction requires a `meterProvider` (OTel MeterProvider) and a `label` (window identifier). Optional: `metricPrefix` (default `"context_lens"`), `emitEvents` (default `true`), `logProvider` (OTel LoggerProvider for events).

On construction, the exporter creates an OTel Meter, registers all instruments (gauges, counters, histogram), and subscribes to the instance's event system for quality-related events. Monitoring begins immediately.

**disconnect():** Unsubscribes from the instance's events and stops metric updates. Idempotent. OTel instruments remain registered (OTel does not support instrument deregistration), but they stop receiving new values. Previously exported metrics remain in the backend's storage.

#### 4.4.2 Metrics

All metrics carry three common attributes: `context_lens.window` (the label), `context_lens.tokenizer` (active tokenizer name), `context_lens.embedding_mode` (`"embeddings"` or `"trigrams"`). Attributes are updated on each push.

**9 gauges** (updated on each assess(), via `reportGenerated` event):

| Metric | Unit | Description |
|--------|------|-------------|
| `{prefix}.coherence` | 1 | Window coherence score |
| `{prefix}.density` | 1 | Window density score |
| `{prefix}.relevance` | 1 | Window relevance score |
| `{prefix}.continuity` | 1 | Window continuity score |
| `{prefix}.composite` | 1 | Composite quality score |
| `{prefix}.utilization` | 1 | Token utilization ratio |
| `{prefix}.segment_count` | segments | Active segment count |
| `{prefix}.headroom` | tokens | Token headroom |
| `{prefix}.pattern_count` | patterns | Active degradation pattern count |

When the window has zero segments, quality gauges are not updated (they retain their previous value, avoiding a misleading 0). The `segment_count` gauge is updated to 0 to signal the empty state.

**6 counters** (monotonically increasing, updated on occurrence):

| Metric | Trigger |
|--------|---------|
| `{prefix}.evictions_total` | segmentEvicted event |
| `{prefix}.compactions_total` | segmentCompacted event |
| `{prefix}.restorations_total` | segmentRestored event |
| `{prefix}.pattern_activations_total` | patternActivated event (base + custom) |
| `{prefix}.assess_count` | reportGenerated event |
| `{prefix}.task_changes_total` | taskChanged event where transition.type is "change" (excludes refinements and same-task) |

**1 histogram:**

| Metric | Unit | Description |
|--------|------|-------------|
| `{prefix}.assess_duration_ms` | ms | assess() selfTime from performance timing |

Uses OTel default histogram buckets unless the caller configures custom boundaries on the MeterProvider.

#### 4.4.3 Events

When `emitEvents` is `true` and a `logProvider` is configured, the adapter emits OTel LogRecords. If `emitEvents` is `true` but no `logProvider` is given, events are silently skipped.

**5 event types:**

| Event | Severity | Trigger |
|-------|----------|---------|
| `context_lens.pattern.activated` | WARN | Pattern activates or escalates |
| `context_lens.pattern.resolved` | INFO | Pattern deactivates |
| `context_lens.task.changed` | INFO | Task transition (not same-task no-ops) |
| `context_lens.capacity.warning` | WARN | Utilization exceeds 0.90 |
| `context_lens.budget.violated` | WARN | Operation exceeds performance budget |

All events carry the common attributes plus `context_lens.timestamp`. Events are emitted inline during the context-lens event handler -- no batching, no polling.

#### 4.4.4 Invariants

**Read-only consumer.** The adapter subscribes to events and reads report data from event payloads. It does not call mutating methods.

**Optional dependency.** The core library does not import any OTel module. Callers who do not install the OTel SDK use context-lens without the adapter. Bundle size and startup time are unaffected.

**Metric naming stability.** Metric names and attribute keys are part of the adapter's public contract. Renaming a metric is a breaking change requiring a major version bump.

**Handler safety.** The adapter's event handlers are fast (OTel metric recording is O(1)). Handler errors are caught internally -- a failing OTel push does not propagate to the context-lens operation that triggered it.

**Not restored after fromSnapshot() (R-190).** The caller must create a new exporter and attach it to the restored instance.

---

## 5. Test Requirements

### Unit tests

**`schema.test.ts`:**
- Each of the three JSON Schema files is valid draft 2020-12 (parseable by the validator library).
- `toJSON()` on a QualityReport, DiagnosticSnapshot, and EvictionPlan produces objects that validate against their respective schemas. Test with: empty-window report (null composite, null scores), multi-segment report with active patterns, report with all nullable fields null, report with all nullable fields populated.
- `validate.qualityReport()` accepts conforming objects and rejects malformed objects (missing required field, wrong type, out-of-range enum value, out-of-range numeric constraint). Same for diagnosticSnapshot and evictionPlan.
- Schema version field is present and matches the current schema version string.
- Shared `$defs` are consistent across all three schema files (same type name = same definition).

**`serialization.test.ts`:**
- **Round-trip fidelity.** Construct instance, seed segments, add segments, set task, assess twice, evict one. Call `snapshot()`. Call `fromSnapshot()` with same providers. Call `assess()` on both. Verify identical scores, pattern states, and composite.
- **Lightweight snapshot.** Call `snapshot({ includeContent: false })`. Verify `restorable` is false. Verify all segment content is null. Verify `fromSnapshot()` rejects it with ConfigurationError.
- **Provider change detection.** Snapshot with tokenizer A. Restore with tokenizer B (different name). Verify all segments recounted. Snapshot with embedding provider X. Restore with provider Y. Verify full re-embedding triggered.
- **Custom pattern restoration.** Register custom pattern "myPattern". Snapshot. Restore with the same pattern provided in customPatterns. Verify tracking state (hysteresis, history) restored. Restore without providing the pattern. Verify warning emitted. Restore with a new pattern not in snapshot. Verify it starts fresh.
- **Format version validation.** Tamper with `formatVersion` in serialized state. Verify `fromSnapshot()` throws ConfigurationError.
- **Atomic restore failure.** Provide corrupted segment data in snapshot. Verify `fromSnapshot()` throws and does not return a partial instance.
- **Post-restore behavior.** Verify restored instance's event system has no subscribers. Verify getDiagnostics().latestReport is null. Verify timeline continues from snapshot's highest sequence number.
- **Excluded state.** Verify caches are empty after restore (first operations repopulate). Verify performance metrics are reset.

**`fleet.test.ts`:**
- **Registration.** Register, unregister, listInstances, get. Duplicate label throws DuplicateIdError. Empty label throws ValidationError.
- **Fleet assessment.** Register 3 instances with different quality states. Call assessFleet(). Verify per-instance reports, aggregates (mean/min/max/stddev computed correctly), hotspots (sorted by severity then count then composite), ranking (weakest first, ties by utilization), capacity overview.
- **Cached mode.** Assess one instance manually. Call assessFleet({ cached: true }). Verify the manually-assessed instance has a report; others without prior assessment have null reports.
- **Fail-open.** Configure one instance to throw on assess() (e.g., corrupted internal state). Call assessFleet(). Verify: failed instance has status "error", other instances assessed normally, aggregates exclude the failed instance, failedInstances count is 1.
- **Fleet events.** Verify instanceDegraded fires when a pattern activates. Verify instanceRecovered fires when a pattern resolves. Verify fleetDegraded fires when degraded fraction exceeds threshold. Verify fleetRecovered fires when fraction drops below threshold. Verify no events in cached mode.
- **Read-only verification.** Before and after assessFleet(), verify segment counts and task states on all instances are unchanged.

**`otel.test.ts`:**
- **Gauge updates.** Create exporter with mock MeterProvider. Add segments. Assess. Verify all 9 gauges updated with correct values from the report.
- **Counter increments.** Evict a segment. Verify evictions_total incremented. Compact a segment. Verify compactions_total incremented. Assess. Verify assess_count incremented.
- **Histogram recording.** Assess. Verify assess_duration_ms recorded with a positive value.
- **Event emission.** Configure mock LoggerProvider. Trigger pattern activation. Verify context_lens.pattern.activated event emitted with correct attributes. Trigger task change. Verify context_lens.task.changed emitted.
- **Empty window.** Assess with zero segments. Verify quality gauges not updated (previous values retained). Verify segment_count gauge set to 0.
- **disconnect().** Call disconnect. Assess again. Verify no new metric updates. Verify disconnect is idempotent.
- **No logProvider.** Set emitEvents: true but provide no logProvider. Verify events silently skipped, no errors.
- **Common attributes.** Verify all metrics carry context_lens.window, context_lens.tokenizer, context_lens.embedding_mode attributes.

### Integration tests

**Schema round-trip via ContextLens.** Full flow: construct, seed, add, set task, assess, getDiagnostics, planEviction. Pass each output through toJSON(). Validate against schema. Parse back. Verify key fields survive the round-trip.

**Serialization across provider switch.** Construct with approximate tokenizer and trigram mode. Populate. Snapshot. Restore with mock exact tokenizer and mock embedding provider. Assess on both original (continued) and restored. Verify scores differ (different providers) but both are valid reports.

**Fleet + OTel combined.** Register 3 instances with a fleet. Attach OTel exporters to each. Call assessFleet(). Verify fleet report and verify OTel metrics updated for all 3 instances. Verify fleet events and OTel events fire in the correct order.

### Property-based tests

- **Snapshot round-trip invariant.** For any sequence of operations, `fromSnapshot(instance.snapshot(), sameConfig)` produces an instance where `assess()` yields identical scores.
- **Fleet aggregate consistency.** For any set of instance reports, fleet aggregates (mean, min, max, stddev) match independently computed values.
- **Schema validation universality.** For any sequence of operations followed by assess()/getDiagnostics()/planEviction(), `toJSON()` output validates against the corresponding schema.

---

## 6. Exit Criteria

All of the following must be true to complete Phase 5:

- Three JSON Schema files (`quality-report.json`, `diagnostic-snapshot.json`, `eviction-plan.json`) are generated, valid draft 2020-12, self-contained (no external $ref), and include all ~35 shared type definitions as $defs.
- `toJSON()` produces schema-conforming output for all three output types, including edge cases (empty window, null baseline, no patterns, all nullable fields).
- `validate()` correctly accepts conforming objects and rejects non-conforming objects for all three schemas.
- `snapshot()` captures all included state (cl-spec-014 SS2.1) and excludes all excluded state (cl-spec-014 SS2.2). Lightweight mode sets all content to null and restorable to false.
- `fromSnapshot()` restores a fully functional instance that satisfies the round-trip fidelity invariant: identical assess() scores given identical providers. Atomic failure on invalid input.
- Provider change detection works: different tokenizer name triggers recount, different embedding provider triggers re-embedding.
- Custom pattern restoration matches by name, restores tracking state for matched patterns, warns for unmatched, starts fresh for new.
- `ContextLensFleet` registers/unregisters instances, produces correct fleet reports with aggregates/hotspots/ranking/capacity, emits fleet events, handles failing instances gracefully.
- `ContextLensExporter` produces all 9 gauges, 6 counters, 1 histogram, and 5 event types with correct values and attributes. disconnect() stops updates cleanly.
- Sub-path exports (`context-lens/fleet`, `context-lens/otel`, `context-lens/schemas`) resolve correctly in both ESM and CJS.
- `@opentelemetry/api` is a peer dependency. The core library and fleet module have zero runtime dependencies.
- All enrichments access only the public API of ContextLens (except serialization, which accesses internal state through the class methods it implements).
- No modifications to Phase 1-4 modules except adding serialization-related methods to the ContextLens class.
- All unit, integration, and property-based tests from section 5 pass.
