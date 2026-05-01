# v0.2.0 Hardening Backlog

## Context

`V0_2_0_DESIGN_STRATEGY.md` (2026-04 draft) scoped 8 gaps for v0.2.0 closure. **Gap 2 (`dispose()`) shipped via Phase 6 — `cl-spec-015` + impl-spec `I-06-lifecycle.md` + 17 build tasks (T1–T17) on `feat/dispose-lifecycle`, merged into `dev` 2026-04-30.** This document is the post-Phase-6 actionable plan for the remaining 7 gaps.

**Active branch:** `feat/v0.2-hardening` (branched from `dev`).
**Methodology:** spec-driven per the project workflow. Each gap = (decisions locked) → (design spec or amendment) → (impl spec) → (build tasks) → (regression sweep) → (commit cadence one task = one commit).
**Hard floor:** 1116 tests, 39 files, 16 bench cases (Phase 6 exit). No regression at any commit.

## Status of the eight gaps

| # | Gap | Status | Where |
|---|-----|--------|-------|
| 1 | Concurrency model | **done** | `cl-spec-007` §12 (new section) + cross-refs in `cl-spec-005` §2.1, `cl-spec-006` §2.1, `cl-spec-012` Invariant 9 |
| 2 | Instance disposal (`dispose()`) | **done** | `cl-spec-015` + Phase 6 (T1–T17) |
| 3 | Fleet serialization | **done** | `cl-spec-012` §8 (new) + Invariants 10–12 + cl-spec-014 §5 amendment + impl spec `I-09-fleet-serialization.md` + `snapshot()` / `fromSnapshot()` in `src/fleet.ts` |
| 4 | OTel re-attach | **done** | `cl-spec-013` §2.1.3 (new) + Invariants 10/11 + impl spec `I-07-otel-reattach.md` + `attach()` in `src/otel.ts` |
| 5 | `assess@500` over budget | open | likely new `cl-spec-016` (option-b decision required) |
| 6 | Memory release | **done** | `cl-spec-007` §8.9 (new) + `cachesCleared` event + impl spec `I-08-memory-release.md` + LruCache.resize + `clearCaches`/`setCacheSize`/`getMemoryUsage` |
| 7 | Provider resilience | **deferred** | recommended to v0.3.0 in V0_2_0_DESIGN_STRATEGY.md |
| 8 | Runtime compatibility statement | open | one-paragraph addition to `cl-spec-009` |

## Recommended sequence

Dependency order from V0_2_0_DESIGN_STRATEGY.md, refreshed for post-Phase-6 state:

1. ~~**Gap 1 — Concurrency**~~ — **done 2026-05-01.** `cl-spec-007` §12 added; `cl-spec-005` §2.1, `cl-spec-006` §2.1, and `cl-spec-012` Invariant 9 cross-referenced. Spec-only, no code changes. 1116 tests / 39 files / typecheck clean.
2. ~~**Gap 4 — OTel re-attach**~~ — **done 2026-05-01.** `cl-spec-013` §2.1.3 (new subsection) + Invariants 10 (state scope) and 11 (single-instance binding); `impl/I-07-otel-reattach.md`; `ContextLensExporter.attach()` + gauge management refactor in `src/otel.ts`; 9 unit tests + 2 integration tests. 1116 → 1127 tests / 39 → 40 files / typecheck clean.
3. ~~**Gap 6 — Memory release**~~ — **done 2026-05-01.** `cl-spec-007` §8.9 (new section: clearCaches/setCacheSize/getMemoryUsage) + `cachesCleared` event (catalog 25 → 26) + cross-refs in `cl-spec-005` §5.5, `cl-spec-006` §5.6, `cl-spec-009` §6.5; `impl/I-08-memory-release.md`; `LruCache.resize` + per-cache setCacheSize/getEntryCount/getMaxEntries hooks (embedding adds getEntryByteEstimate); 39 new tests (38 unit + 1 integration). 1128 → 1167 tests / 40 files / typecheck clean.
4. ~~**Gap 3 — Fleet serialization**~~ — **done 2026-05-02.** `cl-spec-012` §8 (new section: 8.1 Snapshot, 8.2 Restore, 8.3 Format Versioning) + Invariants 10–12; `cl-spec-014` §5 amendment acknowledging fleet wrapping; `impl/I-09-fleet-serialization.md`; `ContextLensFleet.snapshot()` + `static fromSnapshot()` in `src/fleet.ts`; 13 unit + 3 integration tests. 1167 → 1184 tests / 40 → 41 files / typecheck clean.
5. **Gap 5 — `assess@500`** (decision lock first: option a / b / c; if b is chosen, new `cl-spec-016` similarity caching spec needed and interacts with Gap 6's new cache kind)
6. **Gap 8 — Runtime compatibility statement** (one paragraph; can land any time, ordered last because it depends on the v0.2.0 surface being settled)

Gap 7 (provider resilience) is **deferred** unless the user revives it.

## Decision locks before any spec work begins

These are open questions per V0_2_0_DESIGN_STRATEGY.md that need answers — most have a recommended default, only need a thumbs-up to proceed.

| Gap | Decision | Recommendation | Status |
|-----|----------|----------------|--------|
| 1 | Read-read overlap permitted? | **No** — strict one-in-flight contract | **applied (Gap 1 shipped)** |
| 4 | Exporter binding API: factory-once vs. mutable? | **Mutable** — `detach()`/`attach()` preserves counter/histogram continuity | confirmed (per user 2026-05-01) |
| 4 | Multi-instance fan-in on one exporter? | **No** — one-exporter-one-instance | confirmed (per user 2026-05-01) |
| 5 | Caching strategy (a tighter sampling, b incremental cache, c LSH)? | **(b) with (a) as fallback above N** | **picked (b) per user 2026-05-01** |
| 5 | `similarityCacheSize` default (if option b)? | sized for n≤200, configurable | locked-in with (b) |
| 6 | `getMemoryUsage` precision (exact vs. estimate)? | **Estimate** — cheap, advisory | confirmed (per user 2026-05-01) |
| 6 | `setCacheSize(kind, 0)` permitted? | **Yes** — disables cache, perf documented | confirmed (per user 2026-05-01) |
| 8 | Runtime statement now, verification (test matrix) later? | **Yes** — split spec from CI work | confirmed (per user 2026-05-01) |

---

## Per-gap detail

Each block below: scope, design surface, impl surface, test surface, commit estimate, dependencies, blocking decisions.

### Gap 1 — Concurrency model — DONE (2026-05-01)

**Shipped on `feat/v0.2-hardening`.** Pure spec amendment, no code changes; 1116 tests / 39 files / typecheck clean.

**What landed:**
- `cl-spec-007` §12 "Concurrency and Isolation" (new top-level section). Subsections: 12.1 strict-sequential contract (read-read overlap **not** permitted, lifecycle-method exemption), 12.2 four undefined-behavior zones (overlapping mutations, concurrent `assess()`, overlapping provider calls, re-entrant handlers), 12.3 safe patterns (mutex, actor queue, one-instance-per-context), 12.4 unsupported configs (multi-thread shared instances, `SharedArrayBuffer` content), 12.5 fleet/exporter derivation.
- §13 Invariants and §14 References renumbered (was §12/§13). Invariant 6 (Re-entrancy prohibition) updated to cross-ref §12; the buried "Single-threaded access" paragraph removed (content now lives in §12).
- TOC updated; `concurrency` tag added to frontmatter; revised date 2026-04-29 → 2026-05-01.
- `cl-spec-005` §2.1 "Thread-safe" bullet rewritten as "Thread-safe across instances" with cross-ref to cl-spec-007 §12. References table gained a cl-spec-007 row.
- `cl-spec-006` §2.1 "Pure" bullet rewritten with the same cross-ref. References table cl-spec-007 row updated.
- `cl-spec-012` Invariant 9 added: per-instance sequential access. References table cl-spec-007 row updated.

**Decision lock applied:** read-read overlap NOT permitted (recommended in this backlog § "Decision locks").

**Original scope** (kept here for historical reference):

> Promote the buried single-threaded paragraph in `cl-spec-007` §11 to a dedicated section. Enumerate undefined-behavior zones (overlapping mutations, concurrent `assess()`, overlapping provider calls, re-entrant handlers). Document safe patterns (mutex, actor queue, one-instance-per-worker). State the unsupported scope (`SharedArrayBuffer`, multi-thread shared instance). Add fleet derivation: `assessFleet` is sequential.

### Gap 3 — Fleet serialization — DONE (2026-05-02)

**Shipped on `feat/v0.2-hardening`** in 4 commits: spec amendments, impl spec, code, tests.

**What landed:**
- `cl-spec-012` §8 Fleet Serialization (new top-level section between §7 Instance Disposal Handling and the renumbered §9 Invariants). Three subsections: 8.1 Snapshot (the snapshot method, pattern-state-cache preservation, SerializedFleet shape), 8.2 Restore (fromSnapshot factory, FleetRestoreConfig with default + perLabel), 8.3 Format Versioning (independent of cl-spec-014's per-instance formatVersion and cl-spec-011's schema version). New Invariants 10 (pattern-state continuity), 11 (atomicity), 12 (version independence). Renumbered §8 Invariants → §9, §9 References → §10. Replaced the "Serialization. Fleet state is not serializable..." pseudo-paragraph with cross-refs to §8.
- `cl-spec-014` §5 amendment acknowledging the fleet wrapping path. The "External integrations" paragraph dropped "fleet registrations" from the not-serialized list since they ARE serialized by the fleet wrapper. References table gained a cl-spec-012 row.
- `impl/I-09-fleet-serialization.md` — full build plan in the I-06/I-07/I-08 format.
- `src/fleet.ts` — new FLEET_FORMAT_VERSION constant; FleetRestoreConfig interface; `snapshot(options?)` instance method (iterates registered instances in order, surfaces DisposedError verbatim per Invariant 11, captures per-instance trackingState and global fleetState); `static fromSnapshot(state, config)` factory (six-step orchestration with format-version validation, label uniqueness check, ContextLens.fromSnapshot per instance with perLabel|default RestoreConfig dispatch, register, rehydrate trackingState, restore fleetDegradedState; inner failures decorated with offending label).
- `src/types.ts` — six new types (FleetTrackingState, FleetState, SerializedFleetInstance, SerializedFleet, FleetSnapshotOptions, plus FleetRestoreConfig in fleet.ts to avoid restructuring types around RestoreConfig).
- 16 new tests (13 unit + 3 integration). Test floor 1167 → 1184. Decision lock applied: pattern-state cache preserved across restore, not reset. The first `assessFleet()` after restore is silent on the event channel for any pattern set matching the snapshot's last-known state.

**Decision locks applied (per user thumbs-up 2026-05-01):**
- Pattern-state cache preservation: yes. The fleet's per-instance diff state (`activePatterns`, `patternActivatedAt`, `lastAssessedAt`) and global `fleetDegradedState` flag are serialized and rehydrated on `fromSnapshot`. Callers wanting the fresh-fleet behavior can simply skip `fromSnapshot` and register manually.

**Original scope** (kept here for historical reference):

> `ContextLensFleet.snapshot()` / `fromSnapshot()`. Self-contained inline format embedding instance snapshots. Preserves the fleet's pattern-state cache for event-diffing continuity across restore.

### Gap 4 — OTel re-attach — DONE (2026-05-01)

**Shipped on `feat/v0.2-hardening`** in 4 commits: spec amendment, impl spec, code, tests.

**What landed:**
- `cl-spec-013` §2.1.3 (Re-attach after detach) added as a peer to §2.1.1 (Explicit disconnect) and §2.1.2 (Auto-disconnect on instance disposal). Documents the `attach(instance)` method, preconditions, state-scope table (counters/histograms preserved, gauges reset), idempotency boundary, single-instance binding, and the snapshot-then-dispose-then-`fromSnapshot()` continuation pattern with code example. Invariants 10 (state scope) and 11 (single-instance binding) added to §6. References table gained cl-spec-014 row; cl-spec-015 row updated.
- `impl/I-07-otel-reattach.md` — new impl spec following the I-06 format (preamble, module map, dependency direction, module specifications, test requirements, exit criteria). Decision locks recorded in §1; build-task structure walks through the field-shape changes, gauge management refactor, the new attach() body, and the cleaned-up disconnect/handleInstanceDisposal symmetry.
- `src/otel.ts` — gauge management refactored from `gaugeCleanup: { gauge, callback }[]` (cleared on disconnect) to `gauges: { gauge, getValue, currentCallback }[]` (preserved across cycles, callback toggles via `attachGaugeCallbacks`/`detachGaugeCallbacks`). `instance` and `integrationHandle` fields are now nullable. `disconnect()` and `handleInstanceDisposal` symmetric — both null both fields and call the new helpers. `commonAttributes` gained a defensive null guard. `subscribeAll` takes the instance as an explicit parameter so handler closures don't capture the nullable field. New `attach(instance)` method: handshake-first (only fallible step), then commit; resets gauge state via `resetGaugeState()`.
- 9 unit tests in `test/unit/otel.test.ts` (new "Re-attach (cl-spec-013 §2.1.3)" describe block) + 2 integration tests in new `test/integration/otel-reattach.test.ts`. Mock semantics adjusted so `addCallback` clears the `removed` flag (mirrors real OTel re-arm behavior). All existing 30 OTel unit tests pass unchanged.
- Pitfall: `assess()` reuses a cached report when no mutation has happened since the previous assess, and `reportGenerated` fires only on cache miss. Tests interleave a mutation between every assess (same pattern existing tests use) and the contract is documented inline.

**Decision locks applied (per user thumbs-up 2026-05-01):**
- Mutable binding API. The exporter starts attached, may detach, may re-attach. No factory-once pattern.
- No multi-instance fan-in. `attach()` on a still-connected exporter throws — `disconnect()` is the only retarget path.
- State scope: counters preserved (OTel monotonic contract), histogram preserved (distributional), gauges reset to construction-time defaults (point-in-time semantics).

**Test count:** 1116 → 1127 (+9 unit + 2 integration). Test files: 39 → 40. Typecheck clean. Benches green.

**Original scope** (kept here for historical reference):

> `ContextLensExporter.detach(instance)` already lands in Phase 6's auto-disconnect path. New: explicit `attach(instance)` to bind the exporter to a fresh instance after `fromSnapshot`. State scope on re-attach: counters kept (monotonic), histograms kept (distributional), gauges reset to new instance's first assess values.

### Gap 5 — `assess@500` budget

**Scope:** Currently ~300ms vs 50ms target at n=500 (the `assess@500 over budget` known issue from Phase 5). Three candidate paths from V0_2_0_DESIGN_STRATEGY.md; option (b) recommended.

**Decision lock required:** option (a) tighter stratified sampling, (b) incremental pairwise similarity cache, or (c) LSH/ANN. Recommended (b) with (a) as fallback above N. Locks the spec scope and cost.

**Design work** (depends on chosen option):
- If (a): amend `cl-spec-002` §5 sampling subsection only — minimal, ~1 commit
- If (b): amend `cl-spec-002` §5 with new "Incremental Similarity" subsection + amend `cl-spec-009` budget rows + **new `cl-spec-016 Similarity Caching & Sampling`** coordinating spec spanning cl-spec-002/005/009
- If (c): new spec, ~2× the surface area of (b)

**Impl work** (option b — the most likely path):
- `similarity.ts` — pairwise cache keyed on `(idA, idB, providerName)`, LRU-bounded, default sized for n≤200
- `index.ts` — invalidation hooks on segment update/replace/evict and on provider change
- Cache size config exposed via constructor + `setCacheSize` (interaction with Gap 6)

**Test work:**
- Property test: `assess()` output identical across cache-warm and cache-cold states (determinism preservation)
- Bench: `assess@500` cache-warm should drop to <50ms (matches target); cache-cold remains comparable to current
- Unit tests for cache invalidation contract

**Commits:** 1–2 design, 1 impl-spec, ~5–7 build tasks (option b).
**Dependencies:** Gap 2 (done — informs cache-clear symmetry); Gap 6 (the new cache kind needs `clearCaches` / `setCacheSize` / `getMemoryUsage` coverage).
**Decisions:** option a/b/c lock, cache size default, invalidation granularity.

### Gap 6 — Memory release — DONE (2026-05-01)

**Shipped on `feat/v0.2-hardening`** in 4 commits: spec amendments, impl spec, code, tests.

**What landed:**
- `cl-spec-007` §8.9 (new section between §8.8 Eviction Planning and §9 Lifecycle): three subsections — 8.9.1 `clearCaches(kind?)`, 8.9.2 `setCacheSize(kind, size)`, 8.9.3 `getMemoryUsage()`. Per-cache useful-range table, `size = 0` semantics, idempotency boundary, error-throw contract. New `cachesCleared` event in §10.2 with `{ kind, entriesCleared: { tokenizer, embedding, similarity } }` payload — catalog 25 → 26. New `Memory management` row in the API categories table (12 → 13). `'memory'` tag added to frontmatter.
- `cl-spec-005` §5.5 Manual Release — embedding-cache-specific cross-ref to the §8.9 surface; documents provider-bound rebuild cost on first assess after embedding-cache clear.
- `cl-spec-006` §5.6 Manual Release — token-cache-specific cross-ref; notes that segment-stored `tokenCount` survives a clearCaches('tokenizer') (count stability invariant).
- `cl-spec-009` §6.5 Manual Memory Release — replaces the v1-era "no explicit cache-clearing API" sentence with a forward pointer; documents the per-entry byte coefficients used by `getMemoryUsage` (tokenizer 100, similarity 80, embedding `dimensions × 8 + 100` in embedding mode or 8000 in trigram mode), the rebuild-cost table by kind, the `setCacheSize(kind, 0)` use case, and the four-step long-lived-session playbook. Status flipped draft → draft (amended); revised 2026-04-04 → 2026-05-01.
- `impl/I-08-memory-release.md` — full build plan in the I-06/I-07 format. Module map covers `utils/lru-cache.ts` (resize), the three cache modules (`setCacheSize`/`getEntryCount`/`getMaxEntries`; embedding adds `getEntryByteEstimate`), `events.ts` (event map), `types.ts` (CacheKind/CacheUsage/MemoryUsage), `lifecycle.ts` (READ_ONLY_METHODS 20 → 21), `index.ts` (three public methods + module-level CACHE_KINDS / SETTABLE_CACHE_KINDS sets).
- `src/utils/lru-cache.ts` — `maxSize` field becomes mutable; new `maxEntries` getter; new `resize(newMaxSize)` method that drops least-recently-used entries on shrink and returns the evicted count. LRU promotion ordering preserved across resizes.
- `src/tokenizer.ts`, `src/embedding.ts`, `src/similarity.ts` — each gains the same `setCacheSize`/`getEntryCount`/`getMaxEntries` triplet. Embedding adds `getEntryByteEstimate` for the mode-aware byte cost. The internal `cacheSize` shadow field is removed; the LruCache becomes the single source of truth for the bound. Provider-switch paths in all three modules (tokenizer §3.1, embedding setProvider/removeProvider, similarity provider switch) switch from `this.cache = new LruCache(this.cacheSize)` to `this.cache.clear()`, preserving any setCacheSize call the caller made before the switch.
- `src/index.ts` — `clearCaches(kind?)` validates kind, captures pre-clear entry counts, delegates to each cache's clearCache(), emits one cachesCleared event with the aggregated breakdown. `setCacheSize(kind, size)` rejects 'all' both at TypeScript level (Exclude<>) and runtime (defensive against `as` casts), validates non-negative integer, delegates to the named module. Does NOT emit cachesCleared even when shrinking causes evictions. `getMemoryUsage()` is pure aggregation (Tier 1, no deep copy needed). All three methods include the disposed-state guard.
- 39 new tests (38 unit + 1 integration). Test floor 1128 → 1167. Decision locks applied: estimate precision for `getMemoryUsage` and `size = 0` permitted for `setCacheSize`.

**Decision locks applied (per user thumbs-up 2026-05-01):**
- `getMemoryUsage` precision: estimate (cheap, advisory; ±20% expected error band per cl-spec-009 §6.5).
- `setCacheSize(kind, 0)` permitted: yes. Disables the named cache; documented per-cache guidance in cl-spec-007 §8.9.2.

**Pitfalls captured (from impl + tests):**
- `distinctContent` helper used in tests cycles through 10 unique topics; tests needing 30+ unique segments must suffix with the index to avoid the duplicate-detection signal silently no-opping the add.
- `ContextLens.getSegmentCount()` returns a `number`, not the `{ active, evicted, total }` object cl-spec-007 §8.5 documents. Tests must use the actual return shape; the spec/impl mismatch should be reconciled in a future amendment.
- Quality report cache is separate from the three derived caches. `clearCaches` does not invalidate it; the next `assess()` returns the cached report unless a mutation has invalidated it. Tests that want a fresh assess after clearCaches must mutate first.

**Original scope** (kept here for historical reference):

> Long-lived instances accumulate cache memory up to the configured bounds with no manual release. New methods: `clearCaches(kind?)`, `setCacheSize(kind, size)`, `getMemoryUsage()`.

### Gap 8 — Runtime compatibility statement

**Scope:** Spec-level statement that the core library is compatible with browser, Deno, Bun, and edge runtimes provided `TextEncoder` is available. OTel exporter remains Node-only.

**Design work:** Single paragraph in `cl-spec-009` (Performance Budget — already scopes runtime assumptions).

**Impl work:** None for the statement. Verification (test matrix across runtimes) is a separate CI task and can land as a follow-up.

**Test work:** None for the statement. CI matrix is a deferred chore.

**Commits:** 1 spec amendment.
**Dependencies:** None.
**Decisions:** statement-now / verification-later split (recommended).

### Gap 7 — Provider resilience (deferred)

**Recommendation per V0_2_0_DESIGN_STRATEGY.md:** defer to v0.3.0 unless a consumer hits it. Not in `specs/README.md` known-gap list.

**If revived:** circuit breaker for embedding provider (`cl-spec-005` §5 fallback subsection) + symmetric for tokenizer (`cl-spec-006` §5). New `resetEmbeddingProvider` method.

---

## Out of scope for v0.2.0

Per V0_2_0_DESIGN_STRATEGY.md "Non-goals":
- Adapter packages (tiktoken, OpenAI embeddings) — v0.3.0 per `SHIPPING.md`
- New scoring dimensions or pattern detection — design frozen in v0.1.0 review
- Persistence layer or managed storage — `snapshot`/`fromSnapshot` is the sole persistence surface
- Automatic mutation (auto-evict, auto-compact) — caller-driven invariant is load-bearing

---

## Total scope estimate

Remaining after Gaps 1, 3, 4, and 6 shipped (2026-05-01 / 02):

| Surface | Count |
|---------|------:|
| Design specs (new) | 0–1 (cl-spec-016 if Gap 5 option b) |
| Design specs (amended) | 2 remaining (cl-spec-009 for Gap 8; cl-spec-002/009 for Gap 5) |
| Impl specs (new) | 1 remaining (Gap 5 — Gap 8 is spec-only) |
| Build tasks | ~5–8 across the remaining impl spec |
| New unit + integration tests | ~10–20 cases |
| New benchmarks | 1–2 (for Gap 5 cache-warm vs. cache-cold) |
| Net remaining commits on `feat/v0.2-hardening` | ~10–15 |

Done so far on `feat/v0.2-hardening`: ~16 commits (Gap 1: 1, Gap 4: 5, Gap 6: 4, Gap 3: 4 + tracking syncs). Tests grew from 1116 (Phase 6 exit) to 1184 (current).

**Risk-weighted "ship dispose alone as v0.2.0, defer the rest to v0.2.1+v0.3.0" alternative:** still on the table per `SHIPPING.md` revision. The user picked option (2) — bundle — so this plan continues forward.

---

## Recommended next action

**Gap 5 — `assess@500` over budget.** Decision lock already applied (option (b) incremental similarity cache, with (a) tighter sampling as fallback above N). New `cl-spec-016 Similarity Caching & Sampling` coordinating spec spans cl-spec-002/005/009; amendments to those three specs to reflect the new caching contract; impl spec; ~5–7 build tasks adding pairwise-cache invalidation hooks and a `similarityCacheSize` constructor option. Property test required: `assess()` output identical across cache-warm and cache-cold states.

Remaining sequence: Gap 5 → Gap 8.

---

*context-lens v0.2.0 hardening backlog — supersedes V0_2_0_DESIGN_STRATEGY.md sequencing for the remaining 7 gaps.*
