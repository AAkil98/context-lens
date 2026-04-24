# context-lens — v0.2.0 Design Strategy

## Context

v0.1.0 is shipped: 977 tests passing, 14 design specs reviewed, implementation complete across five phases. The design corpus is internally consistent, but `specs/README.md` publishes an honest list of six open questions and known gaps. `SHIPPING.md` pencils a v0.2.0 scope without resolving them at the design level, and `NEXT_FEATURE.md` picks a single next feature (`dispose()`) but does not address the other five.

This document scopes the work needed to close every gap at the design-spec level before any `src/` change. The methodology is design-first: design specs, then impl specs, then code. No gap is considered closed until its design contract is stated and reviewed.

## Gaps addressed

The six items in `specs/README.md` "Open questions and known gaps":

1. Concurrency model is undefined.
2. No instance disposal (`dispose()`).
3. Fleet serialization is unsupported.
4. OTel exporter is not re-attached on restore.
5. `assess()` exceeds the 50ms budget at n=500 on the raw path.
6. No memory-release guidance for long-lived instances.

Plus two items surfaced during this exercise that sit adjacent to the README gaps:

7. Provider resilience (circuit breaker / repeated-failure behavior) is implicit.
8. Browser/edge runtime compatibility is not stated at the spec level.

## Summary

| # | Gap | Primary spec surface | New spec? |
|---|-----|----------------------|-----------|
| 1 | Concurrency | `cl-spec-007` §11 → dedicated subsection; cross-refs in `cl-spec-012`, `cl-spec-005`, `cl-spec-006` | No |
| 2 | No `dispose()` | **New `cl-spec-015 Instance Lifecycle`** + amendments to `cl-spec-007`, `cl-spec-012`, `cl-spec-013`, `cl-spec-014`, `cl-spec-010` | Yes |
| 3 | Fleet serialization | Extend `cl-spec-012` (new §8–§10); one-paragraph amendment to `cl-spec-014` §5 | No |
| 4 | OTel re-attach | Extend `cl-spec-013` with "Lifecycle Coordination" section | No |
| 5 | `assess@500` over budget | Amend `cl-spec-002` §5 + `cl-spec-009`; likely **new `cl-spec-016 Similarity Caching & Sampling`** | Likely yes |
| 6 | Memory release | Amend `cl-spec-005` §5, `cl-spec-006` §5, `cl-spec-009` (new "Memory Budget" section); new methods in `cl-spec-007` §7/§8 | No |
| 7 | Provider resilience | Amend `cl-spec-005` §5 (fallback subsection) and `cl-spec-006` §5 | No |
| 8 | Runtime compatibility | Short statement in `cl-spec-009` | No |

Net new specs: two (`cl-spec-015`, `cl-spec-016`). Amendments span seven existing specs.

---

## Gap 1 — Concurrency model

### Current state

`cl-spec-007` §11 contains a single paragraph under "Instance lifecycle" headings:

> Single-threaded access. context-lens assumes single-threaded, sequential access. Concurrent calls from multiple async contexts produce undefined behavior. Callers in async environments must serialize access to each instance.

This is buried in the invariants dump, not framed as a contract, and does not enumerate failure modes.

### What changes

Promote to a dedicated subsection in `cl-spec-007` (proposed placement: new `§11.2 Concurrency and Isolation`, or split out into a new `§12`). Content:

- **Contract:** at most one in-flight operation per instance, including reads. `async` is permitted if the caller awaits between calls.
- **Undefined-behavior zones:** overlapping mutations (segment collection corruption), concurrent `assess()` (cache corruption), overlapping provider calls during `setEmbeddingProvider`, re-entrant calls from event handlers (already prohibited in §9.3).
- **Safe patterns:** mutex around the instance reference, actor-style queue, one instance per worker thread.
- **Unsupported:** `SharedArrayBuffer`, multiple threads touching the same instance.
- **Fleet implication:** `assessFleet` is sequential by design (`cl-spec-012` §4.1) — state this as a derived guarantee.

### Cross-spec amendments

- `cl-spec-012` §7 Invariants: add "Fleet operations inherit the single-instance-access rule. `assessFleet` serializes instance assessments; the caller must still serialize fleet-level operations (e.g., `register` overlapping with `assessFleet`)."
- `cl-spec-005` §2 and `cl-spec-006` §2: one-liner that the instance invokes provider methods sequentially (relevant for adapters with connection pools or rate limits).

### Open questions

- **Read-read overlap.** Today `assess()` mutates caches on read. A strict "no overlapping reads" contract matches implementation; a relaxed "non-mutating reads may overlap" contract is more ergonomic but requires audit. **Recommended:** strict — one in-flight operation, period.

### New spec

No. Section expansion in `cl-spec-007` is sufficient.

---

## Gap 2 — Instance disposal

### Current state

No `dispose()` method. `cl-spec-007` §11 contains a paragraph that asserts the opposite contract from what `dispose()` introduces:

> context-lens instances require no explicit disposal. All resources … are released when the instance is garbage collected.

Adding `dispose()` **inverts** this statement. It also introduces a terminal state, a new event, a new error class, a fleet back-pointer, and post-disposal behavior for every public method.

### What changes

**New `cl-spec-015 Instance Lifecycle`** covering:

- State machine: `live` → `disposed` (terminal; no resurrection).
- `dispose()` contract: idempotent, atomic, synchronous.
- Teardown order: provider release → cache clear (token, embedding, similarity) → event handler removal → fleet auto-unregister → OTel exporter detach → continuity ledger freeze.
- Per-method post-dispose behavior table: every public method on `ContextLens` classified as throws / no-op / idempotent-read.
- Interactions with `cl-spec-012`, `cl-spec-013`, `cl-spec-014`.

### Cross-spec amendments

- `cl-spec-007` §1 (API categories): add a "Lifecycle" row listing `dispose()`. §9.2: new `stateDisposed` event (the library moves from 24 to 25 events — `CLAUDE.md` header updates). §10.1–§10.2: new `DisposedError` class and `INSTANCE_DISPOSED` code. §11: rewrite the "Instance lifecycle" paragraph to cross-ref `cl-spec-015`; qualify the "Atomic mutations" invariant with "…or the instance is disposed".
- `cl-spec-012` §3.1 Registration: the instance now holds a set of fleets-it-is-registered-with for auto-unregistration. State this as a new invariant in §7 ("Fleet holds a reference to the instance; the instance holds a set of fleet back-pointers for dispose-time callback only"). Clarify that the §7 Invariant 1 "Read-only consumer" applies to fleet → instance; the instance → fleet back-edge exists solely for `unregister` on dispose.
- `cl-spec-013`: new section on exporter detach during dispose (see Gap 4).
- `cl-spec-014` §3 (snapshot): `snapshot()` on a disposed instance throws `DisposedError`. §5 (restore): `fromSnapshot()` always yields a `live` instance; disposal state is not serialized.
- `cl-spec-010` §5 Timeline: new timeline entry type for disposal; clarify timeline is frozen (not cleared) after dispose — preserved for post-mortem inspection? Decision needed (see open questions).

### Open questions

- **Post-dispose read behavior.** Three options: (a) throw on every public call except `dispose()` itself; (b) allow idempotent reads (`toJSON`, `getDiagnostics`, `snapshot`) to return the last known state; (c) allow all non-mutating reads. **Recommended:** (a) — simplest mental model, matches "terminal state" framing. If diagnostic access post-dispose is desired, take a snapshot before `dispose()`.
- **Error class vs. code.** New `DisposedError` (cleaner catch blocks, discoverable) vs. extending `InvalidStateError` with a new code (fewer types). **Recommended:** new class.
- **Fleet back-pointer storage.** `WeakRef<Fleet>` set (GC-friendly; the instance does not keep the fleet alive) vs. strong `Set<Fleet>` (explicit). **Recommended:** strong — the instance is the subject being disposed, and explicit fleet unregistration is the desired behavior.
- **Timeline retention after dispose.** Freeze and keep (readable via last snapshot only) vs. discard immediately. **Recommended:** freeze — the timeline is the audit trail; destroying it is surprising.

### New spec

Yes — `cl-spec-015 Instance Lifecycle`.

---

## Gap 3 — Fleet serialization

### Current state

`ContextLens.snapshot()` exists per-instance (`cl-spec-014`). `ContextLensFleet` has no snapshot equivalent. `cl-spec-014` §8 Invariants explicitly states "Fleet state is not serializable".

### What changes

Extend `cl-spec-012` with three new sections:

- **§8 Fleet Snapshot:** `fleet.snapshot(options?) → SerializedFleet`. Structure includes fleet-level config (`degradationThreshold`), per-label instance snapshots (inline), previous-state cache (for event diffing continuity across restore), format version.
- **§9 Fleet Restore:** `ContextLensFleet.fromSnapshot(state, config) → ContextLensFleet`. `FleetRestoreConfig` takes a per-label map of `RestoreConfig` plus an optional default for labels not explicitly configured.
- **§10 Fleet Format Versioning:** follows `cl-spec-014` §7 pattern. Fleet format version independent of instance format version and schema version.

One-paragraph amendment to `cl-spec-014` §5 documenting that fleet snapshots embed instance snapshots verbatim and that restoring a fleet invokes `ContextLens.fromSnapshot` per label.

Remove "Fleet state is not serializable" from `cl-spec-014` §8 and `cl-spec-012` §7. Replace with the positive contract.

### Open questions

- **Inline vs. manifest.** Inline (all instance data embedded) is self-contained but large (1.1MB × N). Manifest (fleet stores instance snapshot IDs, caller persists instance snapshots separately) keeps the fleet snapshot small but breaks self-containment. **Recommended:** inline, with the existing `SnapshotOptions.includeContent` option propagating to instances so lightweight fleet snapshots are achievable.
- **Previous-state cache preservation.** The fleet's pattern-state cache (`cl-spec-012` §6.2) drives event diffing. On restore: preserve (continuity of `instanceDegraded`/`instanceRecovered` events across the boundary) or reset (clean slate, next `assessFleet` emits all currently-active patterns as new activations). **Recommended:** preserve — mirrors per-instance pattern tracking preservation in `cl-spec-014` §4.6.
- **Label collisions.** Labels are fleet-local; no collision with a different process's fleet. Document this explicitly.
- **Disposed instances in a snapshot.** A disposed instance cannot be snapshotted (Gap 2 decision). The fleet must skip or reject on encountering one. **Recommended:** reject at `fleet.snapshot()` — surface the error rather than produce a silent partial snapshot. Caller must `unregister` disposed instances first.

### New spec

No — fits within `cl-spec-012`.

---

## Gap 4 — OTel exporter re-attachment

### Current state

`cl-spec-013` defines `ContextLensExporter` as an event-subscription adapter. The exporter is bound to an instance at construction. `fromSnapshot()` produces a new instance, so the caller must construct a new exporter, losing counter/histogram continuity.

### What changes

New section in `cl-spec-013` titled "Lifecycle Coordination":

- **Detach on dispose:** when the bound instance is disposed, the exporter unsubscribes and enters a detached state.
- **Attach after restore:** the exporter supports `detach()` and `attach(instance)`. Counters, histograms, and log event state are preserved across detach/attach (OTel convention: counters are monotonic per-process, not per-subject).
- **API shape:** `new ContextLensExporter(config)` constructs in detached state; `exporter.attach(instance)` binds; `exporter.detach()` unbinds. Current `new ContextLensExporter(instance, config)` is either deprecated or kept as a convenience that calls `attach` internally.

### Open questions

- **Binding API shape.** Two options: (a) factory/once — exporter is tied to one instance for life, caller constructs a new exporter after restore, state is lost. (b) mutable binding — `detach()`/`attach()` supported, state preserved. **Recommended:** (b). The practical value of closing this gap is metric continuity; (a) does not deliver that.
- **Multiple attach.** Can one exporter bind to multiple instances (fan-in)? **Recommended:** no — one exporter, one instance, simpler semantics. Fan-in is what the fleet exporter (if later built) would cover.
- **State scope on re-attach.** Counters kept (monotonic), histograms kept (distributional), gauges reset to the new instance's current value on first assessment. Document explicitly.

### New spec

No — amendment to `cl-spec-013`.

---

## Gap 5 — `assess()` budget at n=500

### Current state

`SHIPPING.md` §5: "O(n²) similarity at 500 segments takes ~300ms vs 50ms budget. Sampling mitigates this in practice but the raw path exceeds spec." `cl-spec-009` Assessment tier target: <50ms at n≤500.

### What changes

Three candidate directions. One must be picked before spec work begins:

| Option | Accuracy | Determinism | Engineering risk | Spec home |
|--------|----------|-------------|------------------|-----------|
| (a) Tighter stratified sampling | Drops at n≥500 | Deterministic (seeded) | Low — tune existing logic | `cl-spec-002` §5 amendment |
| (b) Incremental pairwise similarity cache | No loss | Deterministic | High — touches `similarity.ts`, mutation path, invalidation invariants | New spec likely warranted |
| (c) LSH / approximate nearest neighbor | Bounded loss | Non-deterministic without seeded random projections | Medium — new subsystem, embedding-only | New spec definitely warranted |

**Recommended:** (b) with (a) as a fallback above some threshold N. Preserves determinism (a core library invariant), loses no accuracy, 10× win on steady-state. (c) breaks determinism without payoff that (b) cannot deliver.

If (b) is chosen:

- Amend `cl-spec-002` §5 with a new subsection "Incremental Similarity": cache keyed by `(segmentId, segmentId, providerName)`, invalidated on segment `update`/`replace`/`evict` and on provider change, bounded size with LRU eviction, degrades to recompute on miss.
- Amend `cl-spec-009`: update the `assess@500` row to reflect cache-warm vs. cache-cold budgets; add a property-test note that `assess()` output must be identical across cache states.
- **New `cl-spec-016 Similarity Caching & Sampling`**: the mutation/invalidation contract crosses `cl-spec-002` (semantics), `cl-spec-005` (embedding cache interaction), and `cl-spec-009` (budget). Three-spec touch warrants its own coordinating spec, same as Gap 2.

### Open questions

- **Which option.** Commit before writing the spec. See recommendation above.
- **Cache upper bound.** O(n²) in worst case. 10k entries covers n≤150 fully; beyond that, cache plus sampling. **Recommended:** configurable `similarityCacheSize` with a default sized for the 80% case (n≤200).
- **Determinism under partial cache hits.** Non-trivial property: same input state must produce same output regardless of which pairs are cached. Requires careful design of sampling + cache interaction. Worth a dedicated property test.
- **Interaction with Gap 6.** The similarity cache is a new memory consumer. `cl-spec-009` memory budget and `cl-spec-005`/`cl-spec-006` cache-clear APIs must cover it.

### New spec

Likely yes — `cl-spec-016 Similarity Caching & Sampling` — contingent on option (b) being adopted.

---

## Gap 6 — Memory release

### Current state

`cl-spec-005` and `cl-spec-006` define LRU-bounded caches with construction-time sizing. No runtime resize, no manual clear, no memory inspection API. Long-lived instances accumulate memory up to the cache bounds but cannot shed it without reconstruction.

### What changes

Amendments:

- `cl-spec-005` §5 (embedding cache): new subsection "Manual Release" covering `clearCaches`, runtime resize semantics, memory estimate.
- `cl-spec-006` §5 (token cache): symmetric addition.
- `cl-spec-009`: new "Memory Budget" section with worst-case bytes per cache at configured size, total cap, long-lived-instance guidance.
- `cl-spec-007` §7 (Provider Management) or §8 (Capacity and Inspection): three new methods:
  - `clearCaches(kind?: 'token' | 'embedding' | 'similarity' | 'all')` — synchronous. Emits `cachesCleared` event.
  - `setCacheSize(kind, size)` — runtime resize. Drops entries if shrinking.
  - `getMemoryUsage() → { tokenCache, embeddingCache, similarityCache, estimatedTotalBytes }` — cheap estimate.

### Interaction with other gaps

- **Gap 2 (dispose):** `dispose()` performs the terminal form of `clearCaches('all')` plus event handler removal plus provider release. `cl-spec-015` references this symmetry.
- **Gap 5 (incremental similarity):** if adopted, the similarity cache becomes a new cache kind that `clearCaches` and `setCacheSize` must cover.

### Open questions

- **`getMemoryUsage` precision.** Exact byte counts require serialization (expensive on a read path); estimates suffice for capacity planning. **Recommended:** estimate. Document that it is approximate and not stable across runtime versions.
- **`setCacheSize(kind, 0)` semantics.** Effectively disables the cache. **Recommended:** permit, document the performance impact.
- **Event on clear.** `cachesCleared` event fired from `clearCaches` is useful for observability. Add to `cl-spec-007` §9.2 (moves event count from 24 → 25 → 26 depending on whether this lands before or after Gap 2).

### New spec

No.

---

## Gap 7 — Provider resilience

### Current state

`cl-spec-005` §5 (embedding) covers trigram fallback on single-call failure but not repeated-failure behavior. `cl-spec-006` (tokenization) has no defined behavior for repeated tokenizer errors.

### What changes

Amendments:

- `cl-spec-005` §5 Fallback: add a subsection on repeated-failure behavior. Options: per-call fallback only (current, implicit) vs. circuit breaker (N consecutive failures → mode switch to trigram for M operations or until manual reset). **Recommended:** explicit circuit breaker with configurable thresholds; sticky mode switch with a `resetEmbeddingProvider` method.
- `cl-spec-006` §5: symmetric treatment for tokenizer failures, with fallback to the built-in approximate tokenizer.

### Open questions

- Is this v0.2.0 scope or can it slip? Not in `specs/README.md` gap list; raised here as adjacent. **Recommended:** defer to v0.3.0 unless a consumer hits it.

### New spec

No.

---

## Gap 8 — Runtime compatibility

### Current state

`SHIPPING.md` §6 flags browser/edge runtime compatibility as untested. No spec-level statement.

### What changes

Short statement in `cl-spec-009` (Performance Budget already scopes runtime assumptions): the core library uses no Node-specific APIs in the hot path and is compatible with browser, Deno, Bun, and edge runtimes (Workers, Vercel Edge, Cloudflare Workers) provided `TextEncoder` is available. OTel exporter (`cl-spec-013`) remains Node-only due to the OTel SDK runtime footprint.

### Open questions

- Verification. A spec statement is cheap; validating it across runtimes is not. **Recommended:** statement goes in v0.2.0 spec; verification (test matrix) follows as a v0.2.0 or v0.3.0 CI task.

### New spec

No.

---

## Sequencing

Dependency graph:

```
Gap 1 (Concurrency)        ───────►  independent; low coupling
Gap 2 (Dispose)            ───────►  unlocks 3, 4, 6
Gap 3 (Fleet serialization) ──────►  depends on 2 (disposed instances in snapshot)
Gap 4 (OTel re-attach)     ───────►  depends on 2 (detach on dispose)
Gap 5 (assess@500)         ───────►  affects 6 (new cache kind if option b adopted)
Gap 6 (memory release)     ───────►  builds on 2 (cache teardown symmetry)
Gap 7 (provider resilience) ──────►  independent; deferrable
Gap 8 (runtime compat)     ───────►  independent; deferrable
```

Proposed order, one atomic commit per spec change per the project's workflow convention:

1. **Gap 2 — `cl-spec-015` + amendments.** Widest blast radius. ~4 commits (new spec, `cl-spec-007` amendment, `cl-spec-012`+`cl-spec-013`+`cl-spec-014` bundled amendments, `cl-spec-010` amendment).
2. **Gap 1 — Concurrency subsection.** Clean, separable. ~1 commit.
3. **Gap 4 — OTel re-attach.** Builds on dispose symmetry. ~1 commit.
4. **Gap 6 — Memory release.** Builds on dispose cache teardown. ~2 commits (spec amendments, then `cl-spec-007` API methods).
5. **Gap 3 — Fleet serialization.** Needs dispose semantics settled. ~1 commit.
6. **Gap 5 — `assess@500`.** Option a/b/c decision first; then new `cl-spec-016` if (b). ~1–2 commits.
7. **Gap 8 — Runtime compatibility statement.** ~1 commit.
8. **Gap 7 — Provider resilience.** Optional; defer to v0.3.0 unless requested.

All design work completes before any `src/` change. Impl specs (`impl/I-06-lifecycle.md`, `impl/I-07-*.md`, etc.) and code follow on a per-gap basis once each design is merged.

## Checkpoints

Before starting `cl-spec-015`, the following decisions are locked (see open questions under each gap):

- Gap 2: post-dispose read behavior is "throw on everything except `dispose()` itself".
- Gap 2: new `DisposedError` class.
- Gap 2: strong `Set<Fleet>` back-pointer, not `WeakRef`.
- Gap 2: timeline is frozen on dispose, not cleared.

Before starting `cl-spec-016`, the Gap 5 option (a / b / c) is picked. Current recommendation: (b).

Before starting Gap 4 spec work, the exporter binding API is picked. Current recommendation: mutable binding with `detach()`/`attach()`.

## Non-goals for v0.2.0

- Adapter packages (tiktoken, OpenAI embeddings). v0.3.0 per `SHIPPING.md`.
- New scoring dimensions or pattern detection. Design frozen in v0.1.0 review.
- Persistence layer or managed storage. `snapshot()`/`fromSnapshot()` remain the only persistence surface.
- Automatic mutation (auto-evict, auto-compact). The caller-driven invariant is load-bearing.

## Proposed next step

Proceed with Gap 2 as the first spec task: draft `cl-spec-015 Instance Lifecycle`. Checkpoints above are the inputs; the four recommended defaults stand unless revised. Each subsequent gap opens with its own decision lock before spec work begins.

---

*context-lens v0.2.0 design strategy -- authored by AAkil98*
