# IMPL_JOURNAL — v0.2.0 Phase 6

Active phase: **Phase 6 — Instance Lifecycle (`dispose`)**.
Branch: `feat/dispose-lifecycle`.
Released: pending. v0.1.0 baseline shipped to npm 2026-04-09.

## Source documents

- `impl/I-06-lifecycle.md` — Phase 6 implementation spec (module map, signatures, test requirements, exit criteria)
- `specs/15-instance-lifecycle.md` — design spec (cl-spec-015, post-grill, complete)
- `specs/07-api-surface.md` §9, §10.2, §10.3, §11.1 — API surface amendments
- `specs/12-fleet-monitor.md` §7 — fleet auto-unregister contract
- `specs/13-observability-export.md` §2.1 — exporter auto-disconnect contract
- `specs/14-serialization.md` §3.4 — snapshot-then-dispose continuation
- `IMPLEMENTATION.md` §5 — Phase 6 row
- `SEED_CONTEXT.md` — full project history

## Workflow rules

- **One task = one commit.** No bundling. The working tree is clean between every task.
- **Tests bolted onto the same task as the code they cover.** A module change ships with its unit-test diff in the same commit. Cross-cutting test layers (integration, property-based, benchmarks) get dedicated tasks.
- **Hard gate before commit:** `npm test` (no regression from the running baseline), `npm run typecheck`, `npm run build`. If any of the three is red, the task is not done.
- **Spec drives code.** Spec amendments (T2) precede the implementation tasks they govern.
- **Atomic activation.** T9–T11 each leave the codebase building and tests green even though the dispose path isn't fully wired yet — the lifecycle plumbing lights up incrementally and is silent until T11 turns the key.
- **Hard ordering:** T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17. T8 is independent of T3–T7 in principle but slotted before T11 because T11's `clearResources` closure depends on the audited `clear()` methods.

## Tasks

| # | Task | Status | Files | Commit |
|---|------|--------|-------|--------|
| T1 | Create `IMPL_JOURNAL.md` (this file) | done | `IMPL_JOURNAL.md` | (this commit) |
| T2 | Amend `impl/I-06-lifecycle.md` — specify `emitCollect` for `stateDisposed` dispatch | done | `impl/I-06-lifecycle.md` | `0e379d6` |
| T3 | `errors.ts` — add `DisposedError`, `DisposalError`, `tagOrigin` helper; re-export from `index.ts` | done | `src/errors.ts`, `src/index.ts`, `test/unit/errors.test.ts` | (this commit) |
| T4 | `events.ts` — add `StateDisposedEvent` type, `stateDisposed` map entry, `emitCollect` method on `EventEmitter`; re-export type | done | `src/events.ts`, `src/index.ts`, `test/unit/events.test.ts` | (this commit) |
| T5 | `lifecycle.ts` — types (`IntegrationTeardown`, `IntegrationHandle`, `LifecycleState`) and `IntegrationRegistry` class | done | `src/types.ts`, `src/lifecycle.ts` (new), `test/unit/lifecycle.test.ts` (new) | (this commit) |
| T6 | `lifecycle.ts` — `READ_ONLY_METHODS` audit + `guardDispose` helper. Reconcile spec's 13 names with actual `ContextLens` surface (incl. `getEvictionHistory` vs `getEvictedSegments`; classify `getTokenizerInfo`, `getEmbeddingProviderInfo`, `getBaseline`, `getConstructionTimestamp`, `getConfig`, `getPerformance`, `getDetection`) | done | `impl/I-06-lifecycle.md`, `src/lifecycle.ts`, `test/unit/lifecycle.test.ts` | (this commit) |
| T7 | `lifecycle.ts` — `runTeardown(ctx)` orchestrator (six steps, `emitCollect` + `IntegrationRegistry.invokeAll`) | done | `src/events.ts`, `src/lifecycle.ts`, `test/unit/events.test.ts`, `test/unit/lifecycle.test.ts` | (this commit) |
| T8 | Internal `clear()` audit — verify/add `tokenizer.clearCache`, `embedding.clearCache`, `similarity.clearCache`, `continuity.clear`, `diagnosticsManager.clear`, `store.clear` | pending | `src/{tokenizer,embedding,similarity,scoring/continuity,diagnostics,segment-store}.ts` + corresponding tests | — |
| T9 | `index.ts` — `instanceId` field + getter, `lifecycleState` field + `isDisposed`/`isDisposing` getters, `attachIntegration` (no `dispose` body, no per-method guards yet) | pending | `src/index.ts`, `test/unit/context-lens.test.ts` | — |
| T10 | `index.ts` — wire `guardDispose` as the first statement of every existing public method (mechanical, all-or-nothing) | pending | `src/index.ts`, `test/unit/context-lens.test.ts` | — |
| T11 | `index.ts` — `dispose()` body, `clearResources` closure, `runTeardown` wiring, `DisposalError` rethrow | pending | `src/index.ts`, `test/unit/context-lens.test.ts` | — |
| T12 | `fleet.ts` — registration handshake via `attachIntegration`, store handle, `unregister` detaches, `instanceDisposed` event, `handleInstanceDisposal` callback | pending | `src/fleet.ts`, `test/unit/fleet.test.ts` | — |
| T13 | `otel.ts` — constructor handshake, `disconnect` refactor, `handleInstanceDisposal` (final-signal flush + `context_lens.instance.disposed` log), idempotency between paths | pending | `src/otel.ts`, `test/unit/otel.test.ts` | — |
| T14 | `test/integration/lifecycle.test.ts` — 15 flows from impl-spec §5 | pending | `test/integration/lifecycle.test.ts` (new) | — |
| T15 | `test/property/lifecycle.test.ts` — 4 fast-check properties (idempotent, post-disposal-uniformity, mutual-exclusion, classification-completeness) | pending | `test/property/lifecycle.test.ts` (new) | — |
| T16 | `test/bench/lifecycle.bench.ts` — 3 microbenchmarks (`dispose-empty <0.5 ms`, `dispose-500 <10 ms`, `guardDispose <100 ns`); confirm hot-path tiers don't regress | pending | `test/bench/lifecycle.bench.ts` (new) | — |
| T17 | Public exports audit, `IMPLEMENTATION.md` row → done, `CHANGELOG.md` for v0.2.0, full regression sweep | pending | `src/index.ts`, `IMPLEMENTATION.md`, `CHANGELOG.md`, `IMPL_JOURNAL.md` | — |

## Per-task notes

### T2 (done — `0e379d6`)
- Replaced the "emitter requires no changes" line in §4.3 with a contract for `emitCollect(event, payload, errorLog)` on `EventEmitter`.
- Wrapping `emit` in an outer `try/catch` does not work because the existing emitter swallows handler errors per-handler; they never propagate.
- Updated §4.1.5 step 2 (orchestrator dispatches via `emitCollect`), §4.3 (new method signature + rationale), §5 events test bullet, §6 exit criteria.
- No other code change; this was a documentation correction discovered during the planning audit.

### T1 (done — this commit)
- Tracker created for Phase 6 / v0.2.0.
- 17-task plan recorded; T1 + T2 closed, T3–T17 pending.
- Test baseline noted (977 from Phase 5 exit).

### T3 (done — this commit)
- `DisposedError extends Error` and `DisposalError extends AggregateError` landed; both bypass `ContextLensError` per cl-spec-015 §7.2 (need native-class inheritance).
- Internal helpers `tagOrigin(error, origin, index)` and `isHandlerOriginTag(value)` added. Resolved the spec inconsistency between the documented `tagOrigin(error, origin)` signature and the `{ cause, origin, index }` return shape in favor of an explicit `index` parameter — orchestrator tracks index externally.
- Both error classes re-exported from package main entry; helpers stay internal (lifecycle.ts will import directly).
- Tests: 88 → 103 in `errors.test.ts` (+15 cases: 5 DisposedError, 6 DisposalError, 4 helper). Full suite: 977 → 992. Typecheck + build clean.

### T4 (done — this commit)
- `StateDisposedEvent` type added at the top of `events.ts` with frozen-shape comment referencing cl-spec-015 §7.1. Map entry `stateDisposed: StateDisposedEvent` appended; catalog count moves from 24 → 25 events.
- `EventEmitter.emitCollect(event, payload, errorLog)` method added — identical to `emit` except per-handler thrown values are pushed onto `errorLog` instead of swallowed. Re-entrancy warning preserved. Standard `emit` path is unchanged and continues to govern every other event.
- `StateDisposedEvent` re-exported from package main entry (alongside the existing `ContextLensEventMap` re-export).
- Tests: 11 → 18 in `events.test.ts` (+7 cases: 5 `emitCollect` covering registration-order dispatch, throw-then-continue iteration, no-op-with-no-handlers, append-without-disturbing-prior-entries, no-effect-on-`emit`-swallow; +2 `stateDisposed` wiring covering map-accepts-payload-shape and frozen-payload mutation rejection). Full suite: 992 → 999. Typecheck + build clean.

### T5 (done — this commit)
- New `Lifecycle Domain` section at the bottom of `types.ts` exporting `LifecycleState`, `IntegrationTeardown<T>`, `IntegrationHandle`. Deliberate deviation from impl-spec §4.1.1 (which colocated these types with the class in `lifecycle.ts`): the §3 dependency-direction rule says fleet/otel import lifecycle types from `types.ts`, and §3 also forbids fleet/otel from importing `lifecycle.ts` directly. Putting the types in `types.ts` is the only layout that satisfies both — the class stays internal in `lifecycle.ts`, the types are public via `types.ts`.
- `IntegrationTeardown` is parameterized as `<T = unknown>` so `lifecycle.ts` can express the teardown signature without importing `ContextLens` (which would create an upward import). `index.ts` will instantiate the registry as `IntegrationRegistry<ContextLens>` in T9.
- New `src/lifecycle.ts` exports the `IntegrationRegistry<T>` class. Detach is flag-based, not splice-based — `invokeAll` skips entries whose `detached` flag is set. Reconciles the impl-spec's two descriptions of detach (the "O(N) removal" line and the "checks each entry's detached flag" line) by treating the flag as load-bearing; it also makes the registry safe against detach-during-iteration when a teardown callback unhooks a sibling integration's handle before the sibling's callback runs (covered by a dedicated test case).
- `size` returns the count of non-detached entries (live integrations) — more useful for diagnostics than total array length.
- Tests: new `test/unit/lifecycle.test.ts` with 14 cases across `attach`, `invokeAll`, `detach`, and `clear`. Covers ordering, throw-collection-with-continued-iteration, detach-then-skip, detach-during-iteration, idempotent detach, append-without-disturbing-prior-entries, post-clear behavior. Full suite: 999 → 1013. Typecheck + build clean.

### T6 (done — this commit)
- **READ_ONLY_METHODS audit.** Enumerated every public method/getter on the v0.1.0 `ContextLens` class against cl-spec-015 §3.4. Final set has 20 names: 12 unchanged from §3.4, 1 reconciled (`getEvictionHistory → getEvictedSegments`), 7 audit-added (`getTokenizerInfo`, `getEmbeddingProviderInfo`, `getBaseline`, `getConstructionTimestamp`, `getConfig`, `getPerformance`, `getDetection`).
- **Naming finding.** cl-spec-015 §3.4 and cl-spec-007 §6.5 both say `getEvictionHistory`; the v0.1.0 code provides `getEvictedSegments` (returning `Segment[]`, not `EvictionRecord[]`). Treated as the same logical method for classification — naming/return-type reconciliation is out of T6 scope (separate concern, would need a v0.2.0 spec amendment or a method rename). Recorded the spec name as a non-member for clarity.
- **`getPerformance` / `getDetection` rationale.** Both return references to internal modules rather than deep copies. Classified as read-only because the call itself does not mutate; the returned reference exposes a mutable internal but is unaffected by step 4 (the caller's hold on the reference survives, the library's internal pointer goes away). Conservative classification — could be revisited if these methods are reclassified as `@internal` in the future.
- **`guardDispose` helper.** Implements the rule from cl-spec-015 §3.4: throws `DisposedError` when `state === 'disposed'` (any method); throws when `state === 'disposing'` and method is not in READ_ONLY_METHODS; returns silently otherwise. Constructs the error with the appropriate state token so the message reads either "is disposed; cannot call X()" or "is disposing; cannot call X()".
- **Spec amendment.** Updated `impl/I-06-lifecycle.md` §4.1.3 (audit results paragraph + 20-name code block), §4.1.4 (three → four lifecycle exemptions; added `instanceId` per the post-grill addendum from cl-spec-015 §2.5), and §5 (test bullet for the audited set). cl-spec-015 itself is unchanged — it remains the authoritative design-spec list of 13 names; the impl spec records the impl-side reconciliation.
- Tests: 14 → 28 in `lifecycle.test.ts` (+14: 6 READ_ONLY_METHODS — required-12-from-spec, getEvictionHistory/getEvictedSegments reconciliation, audit-added-7, mutating-not-in-set, exemptions-not-in-set, exact-size-20; +8 guardDispose — live-pass-any, disposed-throw-any, disposing-throw-mutating, disposing-pass-readonly, error-fields, both message states, unknown-method-treated-as-mutating). Full suite: 1013 → 1027. Typecheck + build clean.

### T7 (done — this commit)
- **`runTeardown(ctx)` orchestrator** added to `lifecycle.ts`. Stateless free function (per impl-spec §4.1.5: "state lives in the ContextLens instance that drives it"). Executes the six steps from cl-spec-015 §4.1 in fixed order: setState('disposing') → emitCollect('stateDisposed') → integrations.invokeAll → clearResources → emitter.removeAllListeners + integrations.clear → setState('disposed').
- **`TeardownContext<T>` interface** is the orchestrator's input shape. Carries the state setter, live emitter, live registry, resource-clearing closure, instance reference, and a `payloadFactory` callback. Factory invoked once at step 2 entry so the timestamp is captured precisely at event-fire moment (callers don't pre-build the payload, avoiding stale timestamps if `dispose()` is called from a queue).
- **Error tagging.** After `emitCollect` returns, the orchestrator walks the appended entries (using `errorLog.length` deltas) and wraps each with `tagOrigin(error, 'handler', index)`. Same pattern after `invokeAll` with `'integration'`. Indices are origin-relative — handler indices restart at 0 for the integration tag block. This is the pattern T3 anticipated; the index parameter on `tagOrigin` is now exercised end-to-end.
- **Prerequisite added: `EventEmitter.removeAllListeners()`.** Step 5 of teardown needs a way to detach all subscribers; the existing emitter only had `on/once/emit/emitCollect`. Added a one-liner that clears the internal handler map. Idempotent. The emitter remains functional for new subscriptions afterward — disposal of subscribers is a no-op for the emitter's intrinsic state, just removes the references.
- Tests: 28 → 41 in `lifecycle.test.ts` (+13 runTeardown cases — 3 step-ordering, 3 step-2 dispatch incl. payload freezing and origin='handler' tagging, 2 step-3 invocation incl. origin='integration' tagging, 2 step-5 detachment, 3 error-aggregation incl. mixed handler+integration ordering and origin-relative indices); 18 → 21 in `events.test.ts` (+3 removeAllListeners — multi-event detach, idempotency, post-detach functionality). Full suite: 1027 → 1043. Typecheck + build clean.

## Test baseline

| Phase | Tests | Files | Benchmarks |
|------:|------:|------:|-----------:|
| 5 (v0.1.0) exit | 977 | 36 | 12 |
| 6 (v0.2.0) target | ~1,090 | 39 | 15 |

Hard floor through every task in this phase: **977** (no regression).
Target additions: ~89 unit + 15 integration + 4 property + 3 bench = ~111 new test cases.

---

*context-lens — Phase 6 task tracker. See `impl/I-06-lifecycle.md` for the implementation spec and `specs/15-instance-lifecycle.md` for the design spec.*
