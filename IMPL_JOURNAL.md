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
| T4 | `events.ts` — add `StateDisposedEvent` type, `stateDisposed` map entry, `emitCollect` method on `EventEmitter`; re-export type | pending | `src/events.ts`, `src/index.ts`, `test/unit/events.test.ts` | — |
| T5 | `lifecycle.ts` — types (`IntegrationTeardown`, `IntegrationHandle`, `LifecycleState`) and `IntegrationRegistry` class | pending | `src/lifecycle.ts` (new), `test/unit/lifecycle.test.ts` (new) | — |
| T6 | `lifecycle.ts` — `READ_ONLY_METHODS` audit + `guardDispose` helper. Reconcile spec's 13 names with actual `ContextLens` surface (incl. `getEvictionHistory` vs `getEvictedSegments`; classify `getTokenizerInfo`, `getEmbeddingProviderInfo`, `getBaseline`, `getConstructionTimestamp`, `getConfig`, `getPerformance`, `getDetection`) | pending | `src/lifecycle.ts`, `test/unit/lifecycle.test.ts` | — |
| T7 | `lifecycle.ts` — `runTeardown(ctx)` orchestrator (six steps, `emitCollect` + `IntegrationRegistry.invokeAll`) | pending | `src/lifecycle.ts`, `test/unit/lifecycle.test.ts` | — |
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

## Test baseline

| Phase | Tests | Files | Benchmarks |
|------:|------:|------:|-----------:|
| 5 (v0.1.0) exit | 977 | 36 | 12 |
| 6 (v0.2.0) target | ~1,090 | 39 | 15 |

Hard floor through every task in this phase: **977** (no regression).
Target additions: ~89 unit + 15 integration + 4 property + 3 bench = ~111 new test cases.

---

*context-lens — Phase 6 task tracker. See `impl/I-06-lifecycle.md` for the implementation spec and `specs/15-instance-lifecycle.md` for the design spec.*
