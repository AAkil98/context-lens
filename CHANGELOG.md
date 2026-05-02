# Changelog

## 0.2.0 — Instance lifecycle and hardening (2026-05-02)

This release bundles Phase 6 (instance lifecycle / `dispose()`) with six v0.2.0 hardening improvements covering concurrency, memory release, fleet serialization, OTel re-attach, performance, and runtime compatibility. Gap 7 (provider resilience) is deliberately deferred to v0.3.0 — the rationale is captured in `V0_2_0_BACKLOG.md` and `SEED_CONTEXT.md`. Test floor grew from 977 (v0.1.0) to 1199 (+222). `assess @ 500` benchmark improved from ~341 ms to ~9.2 ms (~37×).

### Features — Instance lifecycle (Phase 6)

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

### Internal additions visible on the type surface — Phase 6

- `LifecycleState`, `IntegrationTeardown<T>`, `IntegrationHandle` exported from `types.ts` (transitively via the main entry's `export type * from './types.js'`). Required to live in `types.ts` to satisfy the dependency-direction rule (fleet/otel cannot import from `lifecycle.ts`). The class `IntegrationRegistry` and the `runTeardown` orchestrator stay strictly internal.
- `ContextLens.attachIntegration(callback)` — `@internal`-marked entry point used by `ContextLensFleet` and `ContextLensExporter`; accessible to external integration packages that want to participate in the disposal sequence.

### Features — Concurrency and Isolation (Gap 1)

- **`cl-spec-007` §12 Concurrency and Isolation** — promoted the buried "Single-threaded access" paragraph into a dedicated section. Documents the strict-sequential per-instance contract (read-read overlap **not** permitted), four undefined-behavior zones (overlapping mutations, concurrent `assess()`, overlapping provider calls, re-entrant handlers), three safe access patterns (mutex / actor queue / one-instance-per-context), and two unsupported configurations (multi-thread shared instances, `SharedArrayBuffer`-backed segment content).
- Spec-only change. Cross-references threaded through `cl-spec-005` §2.1, `cl-spec-006` §2.1, `cl-spec-012` Invariant 9 to make the per-instance contract visible to provider and fleet authors.

### Features — OTel re-attach (Gap 4)

- **`ContextLensExporter.attach(instance)`** — re-attach a detached exporter to a fresh `ContextLens` instance after `disconnect()` or auto-disconnect. Throws on attach-while-attached; throws `DisposedError` on attach-to-disposed.
- **State-scope contract on re-attach:** counters preserved (OTel monotonic guarantee), histogram preserved (distributional continuity), gauges reset to construction-time defaults (point-in-time semantics — first `reportGenerated` from the new instance repopulates). The OTel instruments themselves (`OTelObservableGauge`, `OTelCounter`, `OTelHistogram`) are reused, not re-created — downstream consumers see one continuous metric series across the cycle.
- **Single-instance binding** — an exporter is bound to at most one instance at a time. `disconnect() → attach(B)` is the only retarget path; multi-instance fan-in is unsupported.
- Canonical use case: snapshot-then-dispose-then-`fromSnapshot`-then-`attach` — the exporter follows the snapshot across disposal without dashboard re-configuration.

### Features — Memory release (Gap 6)

- **`ContextLens.clearCaches(kind?)`** — empties one or more derived caches (`'tokenizer'` | `'embedding'` | `'similarity'` | `'all'`). The segment store, baseline, continuity ledger, pattern history, report history, and other history buffers are untouched — `clearCaches` is purely a memoization-layer primitive.
- **`ContextLens.setCacheSize(kind, size)`** — runtime resize of a single cache's maximum-entry capacity. `size = 0` permitted (disables the cache; every `set` is immediately evicted). Atomic from the caller's perspective. Does NOT emit `cachesCleared` even when shrinking causes evictions.
- **`ContextLens.getMemoryUsage()`** — returns `{ tokenizer, embedding, similarity, totalEstimatedBytes }`. Per-cache `entries` / `maxEntries` / `estimatedBytes`. Tier 1 (<1 ms). Estimate uses fixed bytes-per-entry coefficients (cl-spec-009 §6.5.1) — typical ±20 % error band; exact accounting is not portably available in JavaScript.
- **`cachesCleared` event** — fires from `clearCaches()` only. Payload `{ kind, entriesCleared: { tokenizer, embedding, similarity } }`. Catalog grew from 25 events (after `stateDisposed`) to 26.
- **`LruCache.resize(newMaxSize)`** — utility added for runtime resize. Drops least-recently-used entries on shrink, returns evicted count. `LruCache.maxEntries` getter exposed.

### Features — Fleet serialization (Gap 3)

- **`ContextLensFleet.prototype.snapshot(options?)`** — captures a self-contained `SerializedFleet`. Embeds one `ContextLens.snapshot` per registered instance verbatim. `includeContent` propagates per cl-spec-014 §6 (lightweight = not restorable). Surfaces `DisposedError` verbatim if any registered instance is disposed without prior `unregister`.
- **`static ContextLensFleet.fromSnapshot(state, config)`** — reconstructs a fully-functional fleet. `FleetRestoreConfig` shape: `{ default: RestoreConfig (required), perLabel?: Record<string, RestoreConfig> }`. Per-label override exists for heterogeneous fleets (different agents using different embedding providers, capacities, custom patterns).
- **Pattern-state cache preservation across restore** — the fleet's per-instance diff state (`activePatterns`, `patternActivatedAt`, `lastAssessedAt`) and global `fleetDegradedState` flag are serialized and rehydrated. The first `assessFleet()` after restore is **silent** on the event channel for any pattern set matching the snapshot's last-known state — preserves event-diffing continuity.
- **Format versioning** — `"context-lens-fleet-snapshot-v1"`. Independent of the per-instance `formatVersion` (cl-spec-014 §7) and the schema version (cl-spec-011 §6) — three independent version axes evolving at three independent rates.
- **Atomicity** — failure at any restore step abandons the partial fleet (no auto-dispose; the spec is explicit because disposal involves caller-managed provider shutdown).

### Features — Performance (Gap 5)

- **Adaptive density sampling** — fixed `UNCACHED_SAMPLE_CAP = 30` replaced with `densitySampleCap(n)` step function: 30 ≤ 300 → 15 ≤ 500 → 10. At n = 500 this halves density's per-`assess()` work (15,000 → 7,500 similarity computations). Topical concentration's `sqrt(n) × 3` formula unchanged (already sub-linear).
- **`similarityCacheSize` constructor option** — defaults to `clamp(sqrt(capacity / 200) × 16384, 16384, 65536)` per cl-spec-016 §2.1. At typical 128k capacity the default is 65,536 entries (was 16,384) — fits the full pairwise working set at n = 500 without LRU thrash. Setting to 0 disables the cache.
- **Snapshot/restore of cache size** — `SerializedConfig.similarityCacheSize` carries the configured size across `snapshot()` / `fromSnapshot()`. Forward-compat: snapshots from v0.1.0 / earlier v0.2.0 dev builds without the field fall back to the default formula on restore.
- **Cache-warm/cache-cold determinism (Invariant 1)** — the load-bearing guarantee: the similarity cache is a memoization layer, never a different scoring path. `assess()` outputs are numerically identical regardless of cache state. Property-tested over 50+ fast-check runs.
- **Bench: `assess @ 500` ~341 ms → ~9.2 ms (~37×).** Both adaptive sampling and the larger default cache contribute; the cache size matters more (the working set at n = 500 is ~10K pairs, comfortably fitting the new default but barely fitting the old one).

### Features — Runtime compatibility statement (Gap 8)

- **`cl-spec-009` §1.1 Runtime Compatibility** — declares the core `context-lens` package compatible with any single-threaded JavaScript runtime exposing `TextEncoder`: Node.js (≥18), Deno, Bun, modern browsers (Chromium, Firefox, Safari recent stable), and edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy). No `node:` scheme imports, no Buffer / file-system / process-model assumptions.
- The OTel exporter (`context-lens/otel`, cl-spec-013) is the only runtime-restricted entry point — Node-leaning by virtue of the OTel SDK ecosystem. Browser and edge callers should consume metrics directly via `getDiagnostics()` (cl-spec-010).
- CI matrix-level verification across runtimes is a deferred follow-up — v0.2.0 ships compatibility intent; matrix-level coverage will land alongside or after release.

### Architecture and quality additions

- New design specs: `cl-spec-015` (Instance Lifecycle, Phase 6), `cl-spec-016` (Similarity Caching & Sampling, Gap 5).
- Amended design specs: `cl-spec-002`, `cl-spec-005`, `cl-spec-006`, `cl-spec-007`, `cl-spec-009`, `cl-spec-012`, `cl-spec-013`, `cl-spec-014`.
- New impl specs: `I-06` (lifecycle), `I-07` (otel re-attach), `I-08` (memory release), `I-09` (fleet serialization), `I-10` (similarity caching).
- Test floor: 977 → 1199 (+222 tests, +6 test files). New: `test/integration/lifecycle.test.ts`, `test/integration/otel-reattach.test.ts`, `test/integration/fleet.test.ts`, `test/property/lifecycle.test.ts`, `test/property/similarity-determinism.test.ts`, plus expansions across existing `test/unit/*`.
- Performance benchmarks: 12 → 16 cases. Lifecycle benches added (`dispose-empty`, `dispose-500`, two `guardDispose` variants).

### Deferred to v0.3.0

- **Gap 7 (Provider resilience)** — circuit breaker for embedding/tokenizer providers; new `resetEmbeddingProvider` method. Deferred because (1) cl-spec-005 / cl-spec-006 explicitly delegate retry to the provider, and a circuit breaker would invert that boundary; (2) without consumer failure-mode reports, threshold/backoff parameters are guesses; (3) the lifecycle integration registry shipped in Phase 6 is a clean substrate for landing this later. Will re-open in v0.3.0 or whenever a consumer hits provider flakiness in production.

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
