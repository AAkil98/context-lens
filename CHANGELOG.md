# Changelog

## 0.2.0 — Instance lifecycle

### Features

- **`dispose()` method on `ContextLens`** — explicit, synchronous, parameterless terminal-state transition. Idempotent (subsequent calls return silently) and reentrant-safe (a `stateDisposed` handler that calls `dispose()` again returns immediately). Six-step teardown in fixed order: set disposing flag → emit `stateDisposed` → notify integrations → clear owned resources → detach event registry → set disposed flag. Long-lived callers (monitoring daemons, multi-agent orchestrators, server processes handling rolling contexts) should now `dispose()` rather than rely on garbage collection.
- **Lifecycle getters** — `isDisposed: boolean` (true once `dispose()` has completed successfully), `isDisposing: boolean` (true while a `dispose()` call is on the stack). Mutually exclusive at every observable moment. Both are always-valid public surfaces — never throw, regardless of state.
- **Stable `instanceId: string`** — process-unique identifier of the form `cl-N-xxxxxx` generated at construction. Returned unchanged across live, disposing, and disposed states; flows to `stateDisposed` event payloads, `DisposedError` messages, and integration teardown notifications. Canonical correlation key for cross-system telemetry.
- **`stateDisposed` event** — emitted exactly once per instance during step 2 of teardown, the last event the instance ever fires. Frozen payload `{ type, instanceId, timestamp }`. Handlers may call read-only methods on the live instance (`getCapacity`, `assess`, `snapshot`, etc.); mutating-method calls throw `DisposedError`. Handler errors are aggregated into `DisposalError` rather than swallowed (deviation from the standard handler contract, justified by the one-shot terminal nature of disposal).
- **`DisposedError`** — extends `Error`. Raised by every public method except the four lifecycle exemptions when called on a disposed instance, and by mutating methods called during disposal. Carries `instanceId` and `attemptedMethod` for diagnostics.
- **`DisposalError`** — extends `AggregateError`. Raised at most once per disposal, by `dispose()` itself, when one or more callbacks (handlers in step 2 or integration teardown callbacks in step 3) threw. Constituent errors are exposed through the standard `errors` array, each tagged `{ cause, origin: 'handler' | 'integration', index }`. The instance is fully disposed when this error is thrown — disposal is never rolled back.
- **Fleet auto-unregister** — `ContextLensFleet.register(instance, label)` now performs a lifecycle integration handshake; if the instance is later disposed, it auto-unregisters and the fleet emits a new `instanceDisposed { label, instanceId, finalReport }` event. Explicit `fleet.unregister(label)` is silent (no event). `register()` throws `DisposedError` if the instance is already disposed.
- **OTel auto-disconnect** — `ContextLensExporter` constructor performs the same handshake; instance disposal triggers a final `instance.assess()` and emits a new `context_lens.instance.disposed` log event with `instance.id`, `instance.final_composite`, `instance.final_utilization`. Convergent end state with explicit `disconnect()`. Constructor throws `DisposedError` if the instance is already disposed.
- **Snapshot-then-dispose continuation** — `snapshot()` is governed by the read-only-during-disposal rule, so it works during `isDisposing === true` and throws `DisposedError` post-disposal. Canonical pattern for state-preserving handoff: `const snap = lens.snapshot(); lens.dispose(); const fresh = ContextLens.fromSnapshot(snap, config);`. The restored instance is always live, has a fresh `instanceId`, and is independent of the disposed source.

### Architecture

- New internal module `lifecycle.ts` (`IntegrationRegistry`, `READ_ONLY_METHODS`, `guardDispose`, `runTeardown`). Imports only types/errors/events — no upward dependencies.
- 38 disposed-state guards added — the first statement of every existing public method on `ContextLens`. Live-path overhead is ~100 ns per call (microbenchmarked).
- Provider lifecycle remains caller-managed — `dispose()` does **not** invoke tokenizer or embedder shutdown hooks. Recommended order: `dispose()` first (releases the library's references so no library code can re-invoke a provider), then await provider shutdowns.

### Tests and quality

- 1116 tests across 39 test files (+139 from v0.1.0's 977) — 4 unit-test deltas (lifecycle, errors, events, context-lens), one new fleet `Lifecycle integration` describe block (+10), one new OTel `Lifecycle integration` describe block (+8), one new `test/integration/lifecycle.test.ts` (15 flows from impl-spec §5), one new `test/property/lifecycle.test.ts` (4 fast-check properties + 3 sanity checks)
- 15 performance benchmarks (+3): `dispose-empty`, `dispose-500`, `guardDispose` live-path
- All Phase 1–5 budgets unaffected — the 100 ns guard cost is invisible against any tier
- `cl-spec-015` design spec added; `cl-spec-005`, `cl-spec-006`, `cl-spec-007`, `cl-spec-012`, `cl-spec-013`, `cl-spec-014` amended for cross-cutting integration

### Internal additions visible on the type surface

- `LifecycleState`, `IntegrationTeardown<T>`, `IntegrationHandle` exported from `types.ts` (transitively via the main entry's `export type * from './types.js'`). Required to live in `types.ts` to satisfy the dependency-direction rule (fleet/otel cannot import from `lifecycle.ts`). The class `IntegrationRegistry` and the `runTeardown` orchestrator stay strictly internal.
- `ContextLens.attachIntegration(callback)` — `@internal`-marked entry point used by `ContextLensFleet` and `ContextLensExporter`; accessible to external integration packages that want to participate in the disposal sequence.

## 0.1.0 — Initial release

### Features

- **Segment model** — seed, add, update, replace, compact, split, evict, restore. Caller-assigned or content-hash IDs. Four-tier protection (pinned > seed > priority(n) > default). Groups with atomic eviction.
- **Quality scoring** — four dimensions (coherence, density, relevance, continuity) scored from structural signals. No LLM calls. Similarity via Jaccard character trigrams (zero-config) or embeddings (optional provider).
- **Degradation detection** — five named patterns (saturation, erosion, fracture, gap, collapse). Three severity levels with hysteresis. Six compound patterns. Custom pattern registration.
- **Task identity** — task descriptor drives relevance scoring. Three-way transition classification (new, refinement, change). Grace period after task changes.
- **Eviction advisory** — five-signal weighted ranking with strategy auto-selection from active patterns. Protection tiers enforced as walls. Group-aware with overshoot penalty.
- **Quality baseline** — captured on first add after seed. All scores normalized relative to initial state.
- **Diagnostics** — report history, pattern stats, session timeline, cache metrics, warnings. Tier 1 (< 1ms) assembly.
- **Serialization** — `snapshot()` / `fromSnapshot()` for full state capture and restore. Format versioning. Provider change detection on restore.
- **Fleet monitoring** (`context-lens/fleet`) — aggregate quality across instances. Hotspots, ranking, capacity overview. Fleet-level degradation events.
- **OTel export** (`context-lens/otel`) — 9 gauges, 6 counters, 1 histogram, 5 log event types. Optional `@opentelemetry/api` peer dependency.
- **Report schema** (`context-lens/schemas`) — JSON Schema (draft 2020-12) for QualityReport, DiagnosticSnapshot, EvictionPlan. Validation utilities.

### Architecture

- Zero runtime dependencies for core
- ESM + CJS dual build
- TypeScript strict mode with full type exports
- 977 tests (unit, integration, e2e, property-based) + 12 performance benchmarks
