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
| 3 | Fleet serialization | open | extend `cl-spec-012` §8–§10 |
| 4 | OTel re-attach | **done** | `cl-spec-013` §2.1.3 (new) + Invariants 10/11 + impl spec `I-07-otel-reattach.md` + `attach()` in `src/otel.ts` |
| 5 | `assess@500` over budget | open | likely new `cl-spec-016` (option-b decision required) |
| 6 | Memory release | open | amendments to `cl-spec-005`/`006`/`007`/`009` |
| 7 | Provider resilience | **deferred** | recommended to v0.3.0 in V0_2_0_DESIGN_STRATEGY.md |
| 8 | Runtime compatibility statement | open | one-paragraph addition to `cl-spec-009` |

## Recommended sequence

Dependency order from V0_2_0_DESIGN_STRATEGY.md, refreshed for post-Phase-6 state:

1. ~~**Gap 1 — Concurrency**~~ — **done 2026-05-01.** `cl-spec-007` §12 added; `cl-spec-005` §2.1, `cl-spec-006` §2.1, and `cl-spec-012` Invariant 9 cross-referenced. Spec-only, no code changes. 1116 tests / 39 files / typecheck clean.
2. ~~**Gap 4 — OTel re-attach**~~ — **done 2026-05-01.** `cl-spec-013` §2.1.3 (new subsection) + Invariants 10 (state scope) and 11 (single-instance binding); `impl/I-07-otel-reattach.md`; `ContextLensExporter.attach()` + gauge management refactor in `src/otel.ts`; 9 unit tests + 2 integration tests. 1116 → 1127 tests / 39 → 40 files / typecheck clean.
3. **Gap 6 — Memory release** (`clearCaches`/`setCacheSize`/`getMemoryUsage`; cache teardown symmetry with `dispose()` already exists in T8's `clear()` shims)
4. **Gap 3 — Fleet serialization** (requires Gap 2's dispose semantics — already done)
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

Remaining after Gaps 1 and 4 shipped (2026-05-01):

| Surface | Count |
|---------|------:|
| Design specs (new) | 0–1 (cl-spec-016 if Gap 5 option b) |
| Design specs (amended) | 4 remaining (cl-spec-005/006/007/009 for Gap 6; cl-spec-009 for Gap 8; cl-spec-012/014 for Gap 3; cl-spec-002/009 for Gap 5) |
| Impl specs (new) | 3 remaining (Gap 3, Gap 5, Gap 6 — Gap 8 is spec-only) |
| Build tasks | ~17–25 across the three remaining impl specs |
| New unit + integration tests | ~30–55 cases |
| New benchmarks | 1–2 (for Gap 5 cache-warm vs. cache-cold) |
| Net remaining commits on `feat/v0.2-hardening` | ~25–35 |

Done so far on `feat/v0.2-hardening`: 6 commits (Gap 1: 1, Gap 4: 4 + tracking sync from prior turn). Tests grew from 1116 (Phase 6 exit) to 1127 (current).

**Risk-weighted "ship dispose alone as v0.2.0, defer the rest to v0.2.1+v0.3.0" alternative:** still on the table per `SHIPPING.md` revision. The user picked option (2) — bundle — so this plan continues forward.

---

## Recommended next action

**Gap 6 — Memory release.** With the dispose-time `clear()` shims already in place from Phase 6, the surface delta is small: new `clearCaches(kind?)`, `setCacheSize(kind, size)`, `getMemoryUsage()` methods on `ContextLens`; `cachesCleared` event (catalog 25 → 26); spec amendments to `cl-spec-005`/`006`/`007`/`009`. ~5–7 build tasks per the original plan.

Remaining sequence: Gap 6 → Gap 3 → Gap 5 → Gap 8.

---

*context-lens v0.2.0 hardening backlog — supersedes V0_2_0_DESIGN_STRATEGY.md sequencing for the remaining 7 gaps.*
