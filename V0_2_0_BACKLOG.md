# v0.2.0 Hardening Backlog

## Context

`V0_2_0_DESIGN_STRATEGY.md` (2026-04 draft) scoped 8 gaps for v0.2.0 closure. **Gap 2 (`dispose()`) shipped via Phase 6 — `cl-spec-015` + impl-spec `I-06-lifecycle.md` + 17 build tasks (T1–T17) on `feat/dispose-lifecycle`, merged into `dev` 2026-04-30.** This document is the post-Phase-6 actionable plan for the remaining 7 gaps.

**Active branch:** `feat/v0.2-hardening` (branched from `dev`).
**Methodology:** spec-driven per the project workflow. Each gap = (decisions locked) → (design spec or amendment) → (impl spec) → (build tasks) → (regression sweep) → (commit cadence one task = one commit).
**Hard floor:** 1116 tests, 39 files, 16 bench cases (Phase 6 exit). No regression at any commit.

## Status of the eight gaps

| # | Gap | Status | Where |
|---|-----|--------|-------|
| 1 | Concurrency model | open | `cl-spec-007` §11 expansion |
| 2 | Instance disposal (`dispose()`) | **done** | `cl-spec-015` + Phase 6 (T1–T17) |
| 3 | Fleet serialization | open | extend `cl-spec-012` §8–§10 |
| 4 | OTel re-attach | open | extend `cl-spec-013` |
| 5 | `assess@500` over budget | open | likely new `cl-spec-016` (option-b decision required) |
| 6 | Memory release | open | amendments to `cl-spec-005`/`006`/`007`/`009` |
| 7 | Provider resilience | **deferred** | recommended to v0.3.0 in V0_2_0_DESIGN_STRATEGY.md |
| 8 | Runtime compatibility statement | open | one-paragraph addition to `cl-spec-009` |

## Recommended sequence

Dependency order from V0_2_0_DESIGN_STRATEGY.md, refreshed for post-Phase-6 state:

1. **Gap 1 — Concurrency** (independent, low coupling, no dependencies on remaining gaps)
2. **Gap 4 — OTel re-attach** (builds on dispose's `detach()`/integration registry already in code)
3. **Gap 6 — Memory release** (`clearCaches`/`setCacheSize`/`getMemoryUsage`; cache teardown symmetry with `dispose()` already exists in T8's `clear()` shims)
4. **Gap 3 — Fleet serialization** (requires Gap 2's dispose semantics — already done)
5. **Gap 5 — `assess@500`** (decision lock first: option a / b / c; if b is chosen, new `cl-spec-016` similarity caching spec needed and interacts with Gap 6's new cache kind)
6. **Gap 8 — Runtime compatibility statement** (one paragraph; can land any time, ordered last because it depends on the v0.2.0 surface being settled)

Gap 7 (provider resilience) is **deferred** unless the user revives it.

## Decision locks before any spec work begins

These are open questions per V0_2_0_DESIGN_STRATEGY.md that need answers — most have a recommended default, only need a thumbs-up to proceed.

| Gap | Decision | Recommendation | Status |
|-----|----------|----------------|--------|
| 1 | Read-read overlap permitted? | **No** — strict one-in-flight contract | needs confirm |
| 4 | Exporter binding API: factory-once vs. mutable? | **Mutable** — `detach()`/`attach()` preserves counter/histogram continuity | needs confirm |
| 4 | Multi-instance fan-in on one exporter? | **No** — one-exporter-one-instance | needs confirm |
| 5 | Caching strategy (a tighter sampling, b incremental cache, c LSH)? | **(b) with (a) as fallback above N** | **needs explicit pick** |
| 5 | `similarityCacheSize` default (if option b)? | sized for n≤200, configurable | depends on b |
| 6 | `getMemoryUsage` precision (exact vs. estimate)? | **Estimate** — cheap, advisory | needs confirm |
| 6 | `setCacheSize(kind, 0)` permitted? | **Yes** — disables cache, perf documented | needs confirm |
| 8 | Runtime statement now, verification (test matrix) later? | **Yes** — split spec from CI work | needs confirm |

---

## Per-gap detail

Each block below: scope, design surface, impl surface, test surface, commit estimate, dependencies, blocking decisions.

### Gap 1 — Concurrency model

**Scope:** Promote the buried single-threaded paragraph in `cl-spec-007` §11 to a dedicated section. Enumerate undefined-behavior zones (overlapping mutations, concurrent `assess()`, overlapping provider calls, re-entrant handlers). Document safe patterns (mutex, actor queue, one-instance-per-worker). State the unsupported scope (`SharedArrayBuffer`, multi-thread shared instance). Add fleet derivation: `assessFleet` is sequential.

**Design work** (`cl-spec-007` amendment):
- New §11.2 "Concurrency and Isolation" (or split out as new §12)
- One-liner cross-refs in `cl-spec-005` §2 and `cl-spec-006` §2 (sequential provider invocation)
- `cl-spec-012` §8 invariant: fleet inherits the rule; caller serializes fleet-level ops

**Impl work:** None — pure documentation. The contract already matches the implementation.

**Test work:** None. (Optional: add a property-based test that asserts re-entrant emit is detected — the warning already exists from the v0.1.0 emitter.)

**Commits:** 1 spec amendment commit.
**Dependencies:** None.
**Decisions:** read-read overlap question.

### Gap 3 — Fleet serialization

**Scope:** `ContextLensFleet.snapshot()` / `fromSnapshot()`. Self-contained inline format embedding instance snapshots. Preserves the fleet's pattern-state cache for event-diffing continuity across restore.

**Design work** (`cl-spec-012` extensions + `cl-spec-014` amendment):
- New §8 Fleet Snapshot — `SerializedFleet` shape, format version, includeContent propagation
- New §9 Fleet Restore — `FleetRestoreConfig` with per-label `RestoreConfig` map + default
- New §10 Fleet Format Versioning — independent of instance + schema versions
- `cl-spec-014` §5 amendment: fleet snapshots embed instance snapshots verbatim
- `cl-spec-014` §8 + `cl-spec-012` §8: drop "Fleet state is not serializable", replace with positive contract

**Impl work** (~3 modules touched):
- `fleet.ts` — add `snapshot()` and static `fromSnapshot()`
- `serialization.ts` — extend with fleet helpers (or fleet has its own format)
- `schemas/` — JSON Schema for `SerializedFleet`

**Test work:** ~10 unit + ~3 integration cases (round-trip, includeContent variants, disposed-instance rejection at snapshot, label-collision behavior, pattern-state-cache preservation across restore).

**Commits:** 1 design (spec amendments bundled), 1 impl-spec, ~4–6 build tasks.
**Dependencies:** Gap 2 (done) — disposed instances reject at `fleet.snapshot()`.
**Decisions:** preserve vs. reset pattern-state-cache (recommend preserve).

### Gap 4 — OTel re-attach

**Scope:** `ContextLensExporter.detach(instance)` already lands in Phase 6's auto-disconnect path (T13, `disconnect()`). New: explicit `attach(instance)` to bind the exporter to a fresh instance after `fromSnapshot`. State scope on re-attach: counters kept (monotonic), histograms kept (distributional), gauges reset to new instance's first assess values.

**Design work** (`cl-spec-013` extension):
- New section "Lifecycle Coordination" — explicit detach/attach semantics, state-scope contract
- API shape: keep current `new ContextLensExporter(instance, options)` constructor; add `detach()` (already exists per Phase 6) and `attach(instance)` methods
- Cross-ref `cl-spec-014` §3.4 (snapshot-then-dispose-then-restore continuation pattern from Phase 6) — natural use case

**Impl work** (`otel.ts`):
- New `attach(instance)` method on `ContextLensExporter`
- Validate state: `attach` only valid on a detached exporter (after `disconnect()` or `handleInstanceDisposal`); throws otherwise
- Re-subscribe to instance events; re-call `instance.attachIntegration(...)` for the new instance's lifecycle hook
- Internal-state preservation: reset gauge "stored" values to defaults so first reportGenerated repopulates

**Test work:** ~6–8 unit + 1 integration case (snapshot → dispose → fromSnapshot → attach → continue metric stream; counter monotonicity preserved across re-attach).

**Commits:** 1 spec amendment, 1 impl-spec, ~3–4 build tasks.
**Dependencies:** Gap 2 (done).
**Decisions:** binding API shape (mutable), multi-instance fan-in (no), state scope on re-attach (counters/histograms keep, gauges reset).

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

### Gap 6 — Memory release

**Scope:** Long-lived instances accumulate cache memory up to the configured bounds with no manual release. New methods: `clearCaches(kind?)`, `setCacheSize(kind, size)`, `getMemoryUsage()`.

**Design work** (amendments to `cl-spec-005`/`006`/`007`/`009`):
- `cl-spec-005` §5 + `cl-spec-006` §5: "Manual Release" subsection
- `cl-spec-009`: new "Memory Budget" section — worst-case bytes per cache, total cap, long-lived guidance
- `cl-spec-007` §7 or §8: three new methods documented
- `cl-spec-007` §9.2: new `cachesCleared` event (catalog 25 → 26)

**Impl work** (`index.ts` + cache modules):
- `clearCaches(kind?)` — reuses Phase 6's `clearCache()` shims on tokenizer / embedding / similarity / continuity / diagnostics. New thin wrapper at the public API.
- `setCacheSize(kind, size)` — runtime resize via the existing `LruCache` class (likely needs a new `resize` method on `LruCache` — small unit work)
- `getMemoryUsage()` — estimate function summing cache `size` × estimated bytes-per-entry; returns object with breakdown
- New `cachesCleared` event wired through emitter

**Test work:** ~10 unit + 1 integration case (clear-then-rebuild, resize-shrink-drops-entries, memory-usage-monotonically-decreases-after-clear, cachesCleared event payload).

**Commits:** 1 spec, 1 impl-spec, ~5–7 build tasks.
**Dependencies:** Gap 2 (done) — `dispose()` is the terminal `clearCaches('all')` form. Gap 5 (if option b) — adds a fourth cache kind (similarity) to the kind enum.
**Decisions:** `getMemoryUsage` precision (estimate), `setCacheSize(kind, 0)` semantics (permit, document perf cost).

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

If all six remaining gaps land in v0.2.0:

| Surface | Count |
|---------|------:|
| Design specs (new) | 0–1 (cl-spec-016 if Gap 5 option b) |
| Design specs (amended) | 5 (cl-spec-005, 006, 007, 009, 012, 013, 014) |
| Impl specs (new) | 4 (one per Gap 3, 4, 5, 6 — Gaps 1 and 8 are spec-only) |
| Build tasks | ~25–35 across the four impl specs |
| New unit + integration tests | ~50–80 cases |
| New benchmarks | 1–2 (for Gap 5 cache-warm vs. cache-cold) |
| Net commits on `feat/v0.2-hardening` | ~40–55 |

**Risk-weighted "ship dispose alone as v0.2.0, defer the rest to v0.2.1+v0.3.0" alternative:** still on the table per `SHIPPING.md` revision. The user picked option (2) — bundle — so this plan continues forward.

---

## Recommended next action

**Confirm the decision locks above (especially Gap 5 a/b/c — it's the only one without a default that closes the spec scope).** Once confirmed, the first commit on this branch is the Gap 1 concurrency amendment to `cl-spec-007` — smallest blast radius, no dependencies, exercises the new spec-amendment cadence on the new branch.

After Gap 1 lands, sequence: Gap 4 → Gap 6 → Gap 3 → Gap 5 → Gap 8.

---

*context-lens v0.2.0 hardening backlog — supersedes V0_2_0_DESIGN_STRATEGY.md sequencing for the remaining 7 gaps.*
