---
id: cl-spec-015
title: Instance Lifecycle
type: design
status: complete
created: 2026-04-24
revised: 2026-04-29
authors: [Akil Abderrahim, Claude Opus 4.7]
tags: [lifecycle, dispose, teardown, terminal-state, disposal, cleanup, resource-management]
depends_on: [cl-spec-007, cl-spec-012, cl-spec-013, cl-spec-014]
---

# Instance Lifecycle

## Table of Contents

1. Overview
2. Lifecycle States
3. The dispose Method
4. Teardown Sequence
5. Post-Dispose Behavior
6. External Integrations
7. Events and Errors
8. Invariants and Constraints
9. References

---

## 1. Overview

A context-lens instance accumulates resources across a session: token caches (cl-spec-006 §5), embedding caches (cl-spec-005 §5), similarity caches, the continuity ledger (cl-spec-002 §6), report and timeline ring buffers (cl-spec-010), event handler closures (cl-spec-007 §9), fleet registrations (cl-spec-012), and OpenTelemetry exporter subscriptions (cl-spec-013). cl-spec-007 §11 previously asserted that these resources "are released when the instance is garbage collected", and for short-lived sessions that is sufficient. For long-lived callers — monitoring daemons, multi-agent orchestrators, server processes handling rolling contexts — garbage collection is the wrong disposal signal. Event handlers hold strong references to the instance; the instance holds strong references to caches and history buffers; external integrations (fleets, exporters) hold their own strong references to the instance. GC never runs until every such reference drops, and in practice that means never within the process's useful life. The observable consequences are memory growth that cannot be shed without restart, fleet reports that include stale instances, and exporter subscriptions that fire on replaced contexts.

This spec introduces an explicit terminal state for context-lens instances and the operation that transitions to it: `dispose()`. Disposal releases every resource the instance owns, unsubscribes every observer the instance itself registered, and notifies every external integration that was holding a back-reference. After disposal the instance is terminal — every public operation except `dispose()`, `isDisposed`, `isDisposing`, and `instanceId` throws `DisposedError`. No operation returns the instance to live state. Callers who need to continue monitoring a context window must construct a new instance (and, if state preservation matters, call `snapshot()` before disposal and `fromSnapshot()` after).

### Resolution of the "no explicit disposal" invariant

cl-spec-007 §11 formerly stated:

> context-lens instances require no explicit disposal. All resources (caches, history buffers, event handlers) are released when the instance is garbage collected.

This spec supersedes that statement. The invariant is inverted: long-lived callers **must** call `dispose()` to release resources, and short-lived callers **may** call it to release resources earlier than GC would. The full method catalog, error model, and event system documented in cl-spec-007 are extended (not replaced) by the behavior defined here — the public method catalog gains `dispose()`, `isDisposed`, `isDisposing`, and `instanceId` (sections 2.5, 3.1); every other public method gains a post-disposal behavior (section 5); the error hierarchy gains `DisposedError` and `DisposalError` (section 7.2); and the event list gains `stateDisposed` (section 7.1).

### What disposal is

- **Explicit.** The caller calls `dispose()` when they are done with the instance. The library does not auto-dispose on any condition — not on error, not on capacity overflow, not on process signal.
- **Terminal.** A disposed instance cannot be reactivated. There is no `undispose`, no resurrect, no lazy restart.
- **Idempotent.** Calling `dispose()` on an already-disposed instance is a no-op. It does not throw, does not re-emit events, does not re-run teardown.
- **Synchronous.** `dispose()` completes before returning. There is no pending state, no background cleanup, no async teardown.
- **Atomic.** Teardown either runs to completion or leaves the instance in its live state. Partial disposal is not an observable state — see section 4 for the failure model.

### What disposal is not

Disposal is not garbage-collection control. The host runtime decides when the instance object itself is collected; `dispose()` only releases the resources the instance was holding. After `dispose()`, the instance object may still be referenced by caller code — that is fine, but calls to it throw.

Disposal is not a reset. There is no way to clear state and continue using the same instance. Once disposed, the instance is done. Callers who want a clean slate construct a new instance with the same configuration.

Disposal is not async. The teardown operations (cache clears, handler removal, fleet callbacks, exporter detach) are all synchronous. Providers (tokenizer, embedding) are released by reference drop, not by awaiting any shutdown hook. If a provider has its own lifecycle (network pools, workers, child processes), the caller is responsible for shutting it down after disposal — the library does not invoke provider teardown hooks.

Disposal is not silent. `dispose()` emits a `stateDisposed` event **before** the event handler registry is torn down, so subscribers receive one final notification. This is the only event that fires during disposal.

---

## 2. Lifecycle States

An instance occupies exactly one of two states across its in-memory lifetime: **live** or **disposed**. The model is two-valued by design — there is no "initializing", no "suspended", no exposed "disposing-in-progress". Every observation made by caller code, by event subscribers, by fleet aggregators (cl-spec-012), or by exporter sinks (cl-spec-013) sees one state or the other, never an intermediate.

### 2.1 Live

The default state. An instance is live from the moment its constructor returns (cl-spec-007 §3) until `dispose()` succeeds.

While live:

- Every public method documented in cl-spec-007 §6–§9 behaves per its specification.
- All caches (token, embedding, similarity), the continuity ledger, the report and timeline ring buffers, and the event handler registry are mutable and queryable.
- Event subscribers registered via `on()` (cl-spec-007 §9) receive every emitted event.
- External integrations treat the instance as an active source: fleets include it in aggregated reports (cl-spec-012), exporters forward its events as OpenTelemetry signals (cl-spec-013).
- The instance holds strong references to its owned resources and to any back-references it registered with external integrations.

### 2.2 Disposed

The terminal state. An instance enters disposed when `dispose()` completes successfully and remains disposed for the remainder of its existence in memory.

While disposed:

- Every public method except `dispose()`, `isDisposed`, `isDisposing`, and `instanceId` throws `DisposedError` (section 7.2).
- Caches, ledger, and ring buffers are cleared and dereferenced — internal references are released so the host runtime can collect them once the caller drops their handle to the instance.
- Every handler previously registered through `on()` is removed from the registry, after the final `stateDisposed` event has been delivered.
- External integrations have been notified (section 6) and the instance is unsubscribed from any callback it registered with them.
- The instance retains only the minimal metadata required to identify itself in subsequent `DisposedError` messages (section 7.2).

### 2.3 Transitions

The lifecycle graph has exactly three arcs:

| From | To | Trigger | Observable effect |
|------|----|---------|-------------------|
| (none) | live | `new ContextLens(...)` returns | Instance is usable. |
| live | disposed | `dispose()` completes successfully | Final `stateDisposed` event emitted; subsequent calls (other than `dispose`, `isDisposed`, `isDisposing`, and `instanceId`) throw `DisposedError`. |
| disposed | disposed | `dispose()` called again | No-op. No event, no teardown, no error. |

Two transitions are explicitly absent and will not be added:

- **Disposed → Live.** Reactivation is not supported. A caller that needs to resume monitoring constructs a new instance. When state preservation is required, the live instance must be `snapshot()`-ed (cl-spec-014) before disposal and the snapshot rehydrated via `fromSnapshot()` into a fresh instance — the original instance does not return.
- **Live → Live (reset).** There is no operation that clears accumulated state in place. Callers who want a clean slate dispose and reconstruct.

A failed `dispose()` does not produce a transition: the instance remains live and the failure surfaces as a thrown error from `dispose()` itself. The error model and the conditions under which teardown can fail are specified in section 4.

### 2.4 Atomicity of the live → disposed transition

The transition is atomic with respect to caller observation. `dispose()` runs synchronously on JavaScript's single-threaded runtime; no other caller code interleaves with it; and teardown either runs every step to completion (transitioning to disposed) or raises and leaves the instance live with every resource still held. Section 4 specifies the ordering and failure model that uphold this — including the requirement that any teardown step which has already run is either no-op-on-rerun or reversible, so that a retried `dispose()` can complete.

The implication for callers: the question "is this instance disposed?" always has a definite answer at any inspection point. A handler firing during the final `stateDisposed` notification sees `isDisposed === false` and `isDisposing === true` — the canonical observation made during the in-flight teardown. Every observation after `dispose()` returns successfully, including ones from handlers registered too late to receive `stateDisposed`, sees `isDisposed === true` and `isDisposing === false`.

### 2.5 Querying the state

This spec adds three read-only getters to the public API:

```ts
readonly isDisposed: boolean
readonly isDisposing: boolean
readonly instanceId: string
```

`isDisposed` returns `true` once the live → disposed transition has completed (the disposed flag set in step 6 of teardown, §4.1) and `false` otherwise. `isDisposing` returns `true` while a `dispose()` call is on the stack — between step 1 (the disposing flag set) and the originating call's return (success or, in future amendments, failure) — and `false` otherwise. `instanceId` returns the instance's stable identifier — the same string carried by the `stateDisposed` event payload (§7.1), by `DisposedError` messages (§7.2), and by integration teardown notifications (§6.2). It is generated once at construction and never changes. All three getters never throw; alongside `dispose()` itself, they are the four operations that remain valid in all lifecycle states.

`isDisposed` and `isDisposing` are mutually exclusive at any inspection point: at most one is true, and both are false during normal live operation. The two-state lifecycle (§2.1, §2.2) is preserved — `isDisposing` exposes a transient observable on the live → disposed transition, not a third state in the lifecycle graph. `instanceId` is constant across all states; it is metadata, not lifecycle state.

`isDisposed` is the predicate for "is this instance terminal?" — used to decide whether to invoke methods that need post-disposal recovery semantics. `isDisposing` is the predicate for "should I avoid mutating methods right now?" — used by handlers and integration callbacks running during teardown to gate their own mutation calls. `instanceId` is the correlation key for cross-cutting observability — fleet aggregators (cl-spec-012), OpenTelemetry exporters (cl-spec-013), logs, traces, and caller-side telemetry all use it to tie events on the same instance together across systems. Library-internal code uses the two flag getters: every mutating public method's throw guard fires on `isDisposing || isDisposed`; every read-only public method's throw guard fires on `isDisposed` only (the read-only-during-disposal rule, §3.4). No mirror getter `isLive` is provided — `!isDisposed && !isDisposing` is unambiguous.

---

## 3. The dispose Method

### 3.1 Signature

`dispose()` is added to the public `ContextLens` API as a parameterless instance method:

```ts
dispose(): void
```

It takes no arguments, returns no value, and never returns a `Promise`. The synchronous return type is load-bearing — it forbids implementations from awaiting any external lifecycle hook during teardown (see §3.5).

### 3.2 Calling contract

`dispose()` is callable from any state. Its observable behavior is determined by the instance's state at the moment of the call:

| State at call | Behavior |
|---------------|----------|
| live | Run the teardown sequence (section 4); on success, transition to disposed and return; on failure, leave the instance live and throw. |
| disposing (internal, see §3.4) | Return immediately. No nested teardown. |
| disposed | Return immediately. No event, no teardown, no error. |

The caller is not required to check `isDisposed` before calling `dispose()`. Idempotency makes the unconditional call safe — common patterns such as `try { ... } finally { lens.dispose(); }` are correct even if disposal has already happened on an earlier code path.

### 3.3 Idempotency

`dispose()` is idempotent. The first successful call transitions the instance to disposed and runs every teardown step exactly once. Every subsequent call returns immediately without re-emitting `stateDisposed`, without re-invoking external integration callbacks (section 6), and without re-touching caches that have already been cleared.

The implementation upholds idempotency by inspecting the instance's state at the start of every call:

- If both `isDisposing` and `isDisposed` are `false`, the instance is **live**: set the disposing flag (so `isDisposing` returns `true`) and proceed to teardown.
- If `isDisposing` is `true`, a teardown sequence is already in progress on the same call stack (§3.4): return immediately.
- If `isDisposed` is `true`, the instance is already terminal: return immediately.

The disposing flag is exposed via `isDisposing` (§2.5) so handlers and integration callbacks can gate their own mutations against the in-flight `dispose()` call. The disposed flag is exposed via `isDisposed` for the post-disposal probe. The lifecycle graph itself remains two-valued (§2): `isDisposing` is a transient observable on the live → disposed transition, not a third lifecycle state.

### 3.4 Reentrance

A `stateDisposed` event handler runs synchronously inside the `dispose()` call stack — events in cl-spec-007 §9 are dispatched in-process, not queued. If such a handler calls `dispose()` on the same instance, the reentrant call observes `isDisposing === true` (§2.5) and returns immediately. It does not re-enter teardown, does not re-emit `stateDisposed`, and does not throw.

The same protection applies to any teardown step that, by way of an external integration callback (section 6), causes the integration to call back into `dispose()`. The library does not depend on such callback chains in its own integrations, but it tolerates them when a caller-installed integration does so.

#### Read-only-during-disposal rule

While disposal is in progress — between step 1 (disposing flag set) and step 6 (disposed flag set) — the instance is **read-only**. Library-internal throw guards at the top of every public method dispatch on this rule:

- **Read-only public methods** (`getCapacity`, `getSegment`, `listSegments`, `getSegmentCount`, `listGroups`, `getGroup`, `getTask`, `getTaskState`, `getDiagnostics`, `assess`, `planEviction`, `snapshot`, `getEvictionHistory`) gate on `isDisposed` only. They behave per their live specification while `isDisposing === true` because their backing state is intact (step 4 has not yet run).
- **Mutating public methods** (`add`, `update`, `replace`, `compact`, `split`, `evict`, `restore`, `seed`, `createGroup`, `dissolveGroup`, `setTask`, `clearTask`, `setTokenizer`, `setEmbeddingProvider`, `registerPattern`, `on`) gate on `isDisposing || isDisposed`. They throw `DisposedError` (§7.2) while disposal is in progress.

The rule is uniform across step-2 `stateDisposed` handlers and step-3 integration teardown callbacks (§6.2) — there is no asymmetry between the two callback categories. Both run before step 4 with intact backing state, both see `isDisposing === true`, and both observe the same read/mutate split.

#### What handlers of `stateDisposed` may safely do

- Read `isDisposed` (returns `false` until the originating `dispose()` returns — see §2.4) and `isDisposing` (returns `true` for the duration of the call).
- Call any read-only public method on the instance — the instance's last live state is intact and may be inspected.
- Re-call `dispose()` (no-op, as described above).
- Perform external work: log the disposal, emit metrics, release handles to other systems, notify a parent supervisor.

#### What handlers must not do

- Call any mutating public method on the same instance. The throw guard fires on `isDisposing` and the call raises `DisposedError`. Even if the throw were absent, the mutation's effects on internal state would be destroyed by step 4, while the events fired through the still-attached registry would reach subscribers as notifications of a mutation that never durably happened.
- Re-register handlers via `on()`. `on()` is itself a mutating method and throws under the rule above; even if it succeeded, the handler registry is torn down in step 5 and any newly-registered handler would be removed without ever firing.

These constraints apply only to handlers running during the disposal of *this* instance. Handlers attached to a different `ContextLens` instance, or unrelated callbacks, are unaffected.

#### Deviation from the general handler contract

The mutation-throw rule during `stateDisposed` is **stricter than the general handler contract** documented in cl-spec-007 §9.3. The general contract is "handlers must not call methods on the same instance; behavior is undefined if they do." `stateDisposed` upgrades "undefined" to "throws `DisposedError`" because disposal is a one-shot terminal lifecycle event — silently allowing mutations to corrupt the teardown sequence is unacceptable for a transition that cannot be re-run. The same reasoning motivates the error-aggregation deviation in §4.3, where `stateDisposed` handler errors are surfaced via `DisposalError` rather than swallowed-and-logged per the general contract.

### 3.5 Synchronicity

`dispose()` is fully synchronous. It returns to the caller only after every teardown step has completed (success path) or after raising the failure (error path). There is no `Promise<void>` return type, no internal `await`, and no background work scheduled during disposal.

The synchronous contract has two consequences callers must understand:

- **Provider teardown is the caller's responsibility.** If the tokenizer or embedding provider (cl-spec-007) holds external resources — network connection pools, worker threads, subprocess handles — the caller must shut those down after `dispose()` returns. The library never `await`s a provider shutdown hook, because doing so would force `dispose()` to be async, and async disposal in turn would force every caller of every method to reason about an "is this instance still being torn down?" race. The library elects to push provider shutdown to the caller rather than absorb that complexity. Section 6 documents the recommended caller pattern.
- **Microtasks scheduled during teardown run after `dispose()` returns.** Any handler that schedules a microtask (`queueMicrotask`, `Promise.resolve().then(...)`) during `stateDisposed` has that microtask drained on the same turn of the event loop, after `dispose()` returns and the instance is fully disposed. Callbacks deferred this way must not call back into the instance — by the time they run, every public method except `dispose()`, `isDisposed`, `isDisposing`, and `instanceId` will throw `DisposedError`.

### 3.6 Return value and error path

On the success path, `dispose()` returns `void`. The successful return carries no information beyond "disposal is complete"; callers who want post-disposal proof read `isDisposed`, which becomes `true` precisely when `dispose()` returns successfully.

On the failure path, `dispose()` throws. The thrown error is propagated to the caller of `dispose()` directly, not delivered via the event system. This is intentional: a teardown failure is a programmer-visible defect (section 4 specifies the conditions under which it can occur), and event-based delivery would risk the failure being silently swallowed by a handler that itself errors. The error type and the rollback semantics that preserve the instance's live state on failure are specified in section 4.

### 3.7 Operational summary

`dispose()` performs the following high-level work, in the order given. The detailed sequence — step ordering, per-step failure model, rollback semantics, and the contract that each teardown step must satisfy — is the subject of section 4.

1. Mark the instance as disposing (`isDisposing` returns `true`; mutating methods now throw `DisposedError` per §3.4).
2. Emit the `stateDisposed` event to every subscriber currently in the registry.
3. Notify external integrations (fleet aggregators, OpenTelemetry exporters) that the instance is going away, so they can drop their back-references.
4. Clear and dereference internal caches, the continuity ledger, and the report and timeline ring buffers.
5. Detach the event handler registry.
6. Mark the instance as disposed (`isDisposing` returns `false`, `isDisposed` returns `true`); subsequent calls to any public method except `dispose()`, `isDisposed`, `isDisposing`, and `instanceId` throw `DisposedError`.

The order matters: subscribers must receive `stateDisposed` while the registry is still intact (step 5 follows step 2), and external integrations must learn of the disposal before the instance's owned resources are cleared (step 3 precedes step 4) so they do not observe a half-dismantled instance through their own back-references. Section 4 explains why each ordering constraint exists and how it is enforced.

---

## 4. Teardown Sequence

`dispose()` runs the six-step sequence introduced in §3.7. The sequence is fixed: every successful disposal executes the same steps in the same order. This section gives the precise contract for each step (§4.1), justifies the ordering (§4.2), specifies the failure model and the aggregation policy for caller-supplied callback errors (§4.3), and reaffirms the live → disposed atomicity invariant from §2.4 in terms of per-step retry properties (§4.4).

Three invariants drive the sequence's design. First, every event subscriber registered when `dispose()` was called receives the final `stateDisposed` notification (§7.1). Second, every external integration holding a back-reference to the instance learns of the disposal before the instance's owned resources are cleared, so no integration ever observes a half-dismantled instance through its own back-reference. Third, the live → disposed transition is atomic with respect to caller observation per §2.4 — caller-supplied callback failures are absorbed without leaving library-internal state in an intermediate condition.

### 4.1 Step inventory

| # | Step | Library state | Caller-supplied code | Fallible |
|---|------|---------------|----------------------|----------|
| 1 | Set the disposing flag. `isDisposing` (§2.5) returns `true` from this point until step 6 completes (success path) or, in future fallible-step amendments, the rollback path clears the flag. Mutating public methods now throw `DisposedError` per the read-only-during-disposal rule (§3.4). | Lifecycle flag (write). | — | No |
| 2 | Emit `stateDisposed` (§7.1) to every handler in the registry, in registration order. | Event registry (read). | Each registered handler runs as a side effect. | Yes — handler may throw |
| 3 | Notify external integrations — fleet aggregators (cl-spec-012) and OpenTelemetry exporters (cl-spec-013) — that the instance is going away, and unsubscribe from any callbacks the instance registered with them. The per-integration callback contract is specified in section 6. | Integration tables (read-write). | Integration teardown callbacks run as a side effect. | Yes — callback may throw |
| 4 | Clear and dereference the instance's owned resources: the segment store, the continuity ledger (cl-spec-002 §6), the token cache (cl-spec-006 §5), the embedding cache (cl-spec-005 §5), the similarity cache, and the report and timeline ring buffers (cl-spec-010). Internal references to these structures are nulled so the host runtime can collect them once the caller drops the instance handle. From this point onward, read-only methods that depend on cleared state would observe empty results — but step 6 has not yet flipped the disposed flag, so the throw guard still uses the during-disposal rule. | Owned data structures (clear and null). | — | No |
| 5 | Detach the event handler registry. Discard every entry, including any handler that re-registered itself during step 2 (§3.4). | Registry (clear and null). | — | No |
| 6 | Clear the disposing flag and set the disposed flag. `isDisposing` returns `false` and `isDisposed` (§2.5) returns `true`. `instanceId` continues to return its constant value. Subsequent calls to any public method other than `dispose()`, `isDisposed`, `isDisposing`, and `instanceId` throw `DisposedError` (§7.2). | Lifecycle flags (write). | — | No |

Steps 1, 4, 5, and 6 are library-internal: they execute deterministic primitive operations on data the library exclusively owns (flag assignment, `Map.clear()`, array reset, reference nulling) and have no execution path that fails under the JavaScript runtime guarantees the library depends on. Steps 2 and 3 dispatch into caller-supplied code (event handlers) or integration code (fleet and exporter callbacks) and inherit that code's failure surface; their error handling is the subject of §4.3.

### 4.2 Ordering constraints

The total order in §4.1 is uniquely determined by the following adjacency constraints:

- **Step 1 before step 2.** The disposing flag must be set before any handler runs. A handler that re-enters `dispose()` (§3.4) must observe the flag and return immediately; otherwise a reentrant call would emit `stateDisposed` a second time, violating the once-only contract of §3.3.
- **Step 2 before step 5.** Handlers cannot receive the final `stateDisposed` if the registry has already been detached. Step 2 reads the live registry to dispatch; step 5 then discards it.
- **Step 3 before step 4.** External integration teardown callbacks may query the instance through their back-references while running — a fleet aggregator may compute a final aggregated report covering the just-disposed instance, or an OpenTelemetry exporter may flush a final signal derived from the instance's accumulated reports. If owned resources had already been cleared, those callbacks would observe an empty cache, ledger, and ring buffers and would mis-report the instance's last live state. Notifying integrations first lets them read the live state, then detach.
- **Step 4 before step 5.** The registry remains intact through cache clearing so that any internal operation performed in step 4 has a registry to dispatch into. Step 4 emits no events as currently specified, but the ordering is conservative against any future amendment that adds an internal emission during resource clearing — for example, a remediation event when a cleared cache had unflushed entries.
- **Step 5 before step 6.** The disposed flag is the single commit point. Detaching the registry (step 5) is the final library-internal side effect that runs while the instance is still in disposing state; only after step 5 returns does step 6 mark the instance terminal. This ordering ensures that `isDisposed` flipping from `false` to `true` is the last observable side effect of disposal.
- **Step 6 last.** §2.5 specifies that `isDisposed` flips to `true` precisely when `dispose()` completes successfully. No teardown step can run after step 6, because every observation of the instance from that point onward sees the terminal state.

### 4.3 Failure model

**Library-internal steps cannot fail.** Steps 1, 4, 5, and 6 mutate library-owned state through primitive operations whose failure modes are not reachable in normal operation: a flag assignment cannot throw, `Map.clear()` does not invoke caller code, and detaching a registry is a single-pointer reset. The library invokes no caller-supplied logic in these steps, so they have no observable failure surface.

**Caller-supplied callbacks may throw.** Steps 2 and 3 dispatch into code the library does not own — event handlers registered through `on()` (cl-spec-007 §9), and integration teardown callbacks registered with fleets (cl-spec-012) or exporters (cl-spec-013). A throwing handler or callback is a defect in caller-supplied code, not a library failure. The library catches and reports it.

The error-aggregation policy below is **a deliberate deviation from the general handler contract in cl-spec-007 §9.3**, which specifies that handler errors are "caught, logged (if a logger is configured), and swallowed." For non-disposal events the library upholds that contract — observer bugs do not break context-lens operations. Disposal is the exception. The `stateDisposed` notification is the last event the instance ever emits and integration teardown callbacks are the last opportunity to interact with the live state; errors raised in either path carry diagnostic signal that the caller cannot recover from any other source. Surfacing them via `DisposalError` (rather than logging-and-swallowing) preserves the resource-release guarantee — disposal still completes — while making the constituent errors visible.

The library's handling of such errors is uniform across both steps. At the start of every `dispose()` call, the library initializes a per-call **disposal error log** — an internal list scoped to this disposal. Each handler (step 2) and each integration callback (step 3) is invoked inside a `try/catch`; a thrown error is caught, wrapped if necessary to preserve the originating callback's identity, and appended to the log. Iteration does not abort on a caught error: every entry is invoked exactly once, in the order it was registered, regardless of how many earlier entries threw. After steps 2 and 3 finish their iterations, the library proceeds unconditionally to steps 4–6. After step 6 sets the disposed flag, the library inspects the log: if empty, `dispose()` returns normally; if non-empty, `dispose()` throws a `DisposalError` (§7.2) that wraps the collected errors via `AggregateError` semantics, exposing them through the standard `.errors` array.

The outcome of a `dispose()` call with errored callbacks is therefore two-phase:

- **Disposal completes.** The instance transitions to disposed. `isDisposed` returns `true`. Every owned resource has been released. The handler registry has been detached. Every external integration has been notified.
- **The thrown `DisposalError` is informational.** It identifies the handlers or integration callbacks that misbehaved during teardown. The instance is irrevocably disposed regardless of whether the caller catches or rethrows.

This model preserves the resource-release guarantee that motivates `dispose()` in the first place. A misbehaving handler cannot prevent the cache and ledger from being cleared, cannot prevent the registry from being detached, and cannot pin the instance in a half-live state. The cost is borne by the caller: callers who want to detect handler misbehavior must inspect the thrown error; callers who do not care can call `dispose()` from a `finally` block and let the error propagate.

A `DisposalError` is distinct from a `DisposedError`. The former is raised at most once, by the `dispose()` call that performed teardown, only when caller-supplied callbacks errored during that call. The latter is raised on every public-method call after disposal, regardless of how disposal completed. Section 7.2 specifies both error types in full.

### 4.4 Atomicity and the retry contract

§2.4 binds the live → disposed transition to atomicity with respect to caller observation: teardown either runs every step to completion (transitioning to disposed) or raises and leaves the instance live with every resource still held. The current sequence upholds this trivially. Caller-supplied callback errors (§4.3) are absorbed by the `try/catch` discipline and the resulting `DisposalError` is raised after the disposed flag has been set, so the instance has already transitioned by the time the caller sees that error — atomicity is preserved because no internal step is left in a partial state. Library-internal step failures are unreachable, since every state-mutating step (1, 4, 5, 6) is infallible by construction.

The invariant is nonetheless binding on any future amendment that introduces a fallible library-internal step. Such an amendment must satisfy two conditions, jointly the **retry contract** of §2.4:

- **The completed prefix must be retryable.** Every step that ran before the failing step must be no-op-on-rerun or reversible, so that a subsequent `dispose()` call (which observes the live state, since the failing step never let step 6 set the disposed flag) can proceed past the completed prefix without double-effect. The current steps satisfy this by inspection:
  - Step 1 (set disposing flag): reversible — clearing the flag returns the instance to live observable state. On rerun, the flag is re-set; the rerun pathway is identical to the first attempt.
  - Step 4 (clear resources): no-op-on-rerun — clearing already-cleared structures is a no-op. Resource contents are not recoverable on rollback, but the live → disposed contract does not promise that callers can read previously-live state through a half-disposed handle.
  - Step 5 (detach registry): no-op-on-rerun — detaching an already-detached registry is a no-op.
  - Step 6 (set disposed flag): only runs after every other step succeeds, so it is never reached on a failure path.
- **Failure must abort strictly before step 6.** The disposed flag is the single commit point of the lifecycle. A fallible internal step that ran after step 6 would have no defined rollback semantics, since the instance would already be terminal. Future amendments must therefore place fallible internal logic strictly before step 6 in the sequence.

External side effects from the failing-attempt prefix — handler invocations from step 2, integration notifications from step 3 — cannot be reversed. Today this is moot because no post-step-3 internal failure mode exists, so handler and integration callbacks are invoked at-most-once across the lifetime of the instance. A future amendment that introduces a post-step-3 fallible internal step would shift this to at-least-once on the retry path, and would need to document that change at the integration boundary.

Caller-supplied callback errors do not trigger the retry path. They are absorbed by step 2 and step 3 per §4.3; the instance still transitions to disposed on the first call, and a retried `dispose()` is a no-op per §3.3.

---

## 5. Post-Dispose Behavior

`dispose()` returns; the instance is terminal. From this point until the host runtime collects the instance object, every observation made on it follows the rules specified in this section. The disposed state is uniform — it does not matter which step in §4.1 last ran, what the instance contained before disposal, or how long ago disposal happened. Callers see the same behavior whether the instance was disposed seconds or hours ago, and whether it previously held one segment or ten thousand.

Section 5.1 specifies how public methods dispatch on a disposed instance. Section 5.2 enumerates the state the instance retains and the state it has released. Section 5.3 describes the memory-release model and the caller's role in garbage collection, including the boundary between library-managed and caller-managed resources. Section 5.4 specifies the continuation patterns available to callers who need to keep monitoring the same context window after disposing the instance.

### 5.1 Public method dispatch

Every public method on the instance except `dispose()`, `isDisposed`, `isDisposing`, and `instanceId` throws `DisposedError` (§7.2) when invoked on a disposed instance. The rule is uniform across all method categories: queries, mutations, assessments, planning, subscription, persistence. A `getCapacity()` call that would have returned a number on the live instance throws on the disposed one. An `add()` call that would have failed validation on the live instance throws. A `snapshot()` call (cl-spec-014) that would have produced a serializable description of the instance's accumulated state throws — there is no accumulated state left to snapshot. The throw is unconditional and synchronous: the disposed-state guard runs at the top of every public method, ahead of argument validation, cache lookups, and any side effect.

The post-disposal rule contrasts with the during-disposal rule (§3.4). While `isDisposing === true`, read-only methods behave per their live specification because their backing state is intact; only mutating methods throw. Once the disposed flag is set in step 6 of teardown, that backing state has been cleared in step 4, so reads have nothing to return — they throw alongside the mutations.

The four methods that remain valid post-disposal:

- **`dispose()`** — calling it on a disposed instance is a no-op per §3.3. It does not throw, does not emit `stateDisposed`, and does not re-run teardown.
- **`isDisposed`** — returns `true`. The getter never throws.
- **`isDisposing`** — returns `false`. The getter never throws. Together with `isDisposed`, the two flag getters are the predicates external integrations and caller-supplied health checks use to decide whether to invoke other methods (§2.5).
- **`instanceId`** — returns the instance's stable identifier, the same value it returned during the live and disposing phases. The getter never throws. It is the correlation key for cross-system telemetry that may need to reference the disposed instance after the fact (audit logs that enumerate disposed instances by id, post-mortem trace assembly, etc.).

Unsubscribe handles returned by `on()` (cl-spec-007 §9) before disposal remain callable afterward. Calling such a handle on a disposed instance is a no-op. The justification is not that the handle is somehow exempt from the disposed-state guard — it is that the unsubscribe handle's contract is **intrinsically idempotent**: it removes the registered handler if it is still registered, otherwise it is a no-op. Disposal makes the handler not-present (the registry was detached in step 5 of teardown), so the no-op branch fires by construction. This is the unsubscribe contract executing normally on a state where the handler is gone, not an exception to the disposed-state guard.

Read methods do not share this property — they have no natural no-op return value, so they have to throw post-disposal. The split between unsubscribe (no-op) and reads (throw) is principled, not asymmetric.

`DisposedError` carries enough information to identify the affected instance and the called method that triggered the throw. The full structure of the error type — its class hierarchy, the fields it exposes, and how it relates to other errors raised by the API — is specified in §7.2.

### 5.2 Retained state

A disposed instance retains only the metadata required to:

1. Answer subsequent `isDisposed` and `isDisposing` queries, via the lifecycle flags maintained in step 6 of teardown (§4.1).
2. Answer subsequent `instanceId` queries — the identifier is constant and survives disposal as part of the retained metadata.
3. Identify itself in `DisposedError` messages raised by post-disposal method calls (§7.2).

Everything else has been cleared and dereferenced in step 4 of teardown: the segment store, the continuity ledger (cl-spec-002 §6), the token cache (cl-spec-006 §5), the embedding cache (cl-spec-005 §5), the similarity cache, and the report and timeline ring buffers (cl-spec-010). The handler registry has been detached in step 5. External integration back-references have been removed in step 3.

The retained-metadata footprint is small and constant-sized: a flag and an identifier suitable for `DisposedError` messages. It does not grow with the instance's pre-disposal state — a disposed instance that previously held 10,000 segments occupies the same per-instance footprint as one that previously held 10. Callers who hold many disposed-instance handles pay an O(1) cost per handle, plus whatever the JavaScript runtime requires to represent the object itself.

Specifically not retained:

- **Configuration.** The constructor's config object — including the tokenizer and embedding provider references — is released along with the rest of the instance's owned references in step 4. Callers who plan to construct a replacement instance are responsible for retaining the config themselves, typically by holding a reference outside the disposed instance's scope.
- **Integration handles.** References to fleet aggregators (cl-spec-012) and OpenTelemetry exporters (cl-spec-013) were removed in step 3. The disposed instance does not know which integrations were attached and cannot enumerate them.
- **Snapshot data.** `snapshot()` (cl-spec-014) is no longer callable on the instance (§5.1). Callers who want snapshot-and-resume semantics must capture the snapshot before invoking `dispose()`.

### 5.3 Memory release and garbage collection

Disposal nulls the library's strong references to owned data structures (step 4 of teardown, §4.1) so the JavaScript runtime can collect them once no caller-held reference remains. For callers that do not hold direct references to internal structures, cache, ledger, and ring-buffer memory becomes eligible for collection at the moment `dispose()` returns.

The instance object itself is not collected by `dispose()`. Garbage collection of the instance is governed by the caller's handle: `dispose()` cannot null the caller's variable; it can only release what the instance owns internally. Callers who construct many short-lived instances should drop their handles after disposal — for example, by reassigning `lens = null` after `lens.dispose()` — to prevent disposed-instance objects from accumulating in long-lived process memory. Each retained disposed-instance handle costs the constant-sized metadata of §5.2 plus the JavaScript runtime's representation of the object; the cost is small but not zero.

Provider teardown is outside the disposal contract. If the tokenizer or embedding provider supplied to the constructor holds external resources — network connection pools, worker threads, subprocess handles — those resources are not released by `dispose()`. The library never `await`s a provider shutdown hook (§3.5); the caller must invoke any provider-specific teardown after `dispose()` returns. Section 6 documents the recommended pattern, including the ordering between disposal and provider shutdown.

The boundary across the three management regimes is therefore:

- **Library-managed.** Caches, ledger, ring buffers, segment store, registry, integration back-references. Released synchronously by `dispose()` itself.
- **Runtime-managed.** The instance object, plus any dereferenced internal structure that no live reference still pins. Released by the JavaScript runtime once the caller drops every reference.
- **Caller-managed.** The tokenizer and embedding provider, plus any other resources the caller passed to the constructor. The caller decides when and how to shut these down; `dispose()` does not invoke them.

### 5.4 Continuation after disposal

A disposed instance cannot be reactivated (§2.3). Callers who need to keep monitoring the same context window after disposing the instance must construct a new instance. Two patterns exist, distinguished by whether pre-disposal state is preserved.

**Reset-style continuation.** Construct a fresh instance with the same configuration. The new instance starts empty: no segments, no continuity ledger, no quality history, no event subscribers. This is appropriate when the caller wanted a clean slate — the closest analogue to a reset operation, which §2.3 explicitly excludes from the live instance's API.

**Snapshot-style continuation.** Before disposal, call `snapshot()` (cl-spec-014) on the live instance to capture its state as a serializable value. After disposal, pass the snapshot to the static `ContextLens.fromSnapshot(...)` factory to construct a new instance pre-populated with the captured state:

```ts
const snap = oldLens.snapshot();
oldLens.dispose();
const newLens = ContextLens.fromSnapshot(snap, { tokenizer, embedder });
```

The new instance from `fromSnapshot` is independent of the disposed one. They share no state, no registry, no integration attachments — the snapshot is pure data, with no live references. Event subscribers and integration registrations that were attached to the disposed instance must be re-attached to the new instance if the caller wants them to observe ongoing activity on the new context window.

`snapshot()` cannot be called on a disposed instance (§5.1), so the snapshot-style pattern requires that the caller capture the snapshot before invoking `dispose()`. There is no recovery path if disposal happens first — the data needed to reconstruct the instance has already been cleared in step 4 of teardown. Callers who anticipate possible continuation should adopt a "snapshot, then dispose" idiom by default; the cost of an unneeded snapshot is one allocation that the caller can discard.

---

## 6. External Integrations

context-lens recognizes two categories of code that interact with a live instance and must be considered when the instance is disposed: **lifecycle-aware integrations** and **providers**. The two are governed by different teardown contracts. Lifecycle-aware integrations register with the instance through a published library API, are notified during step 3 of teardown (§4.1), and have a uniform callback contract (§6.2). Providers are caller-owned dependencies that the library consumes through a defined interface but whose lifecycle the library does not manage; their shutdown is the caller's responsibility (§6.5).

This section defines the integration model (§6.1), specifies the teardown callback contract that applies to every lifecycle-aware integration (§6.2), describes the disposal-time behavior of fleet aggregators (§6.3) and OpenTelemetry exporters (§6.4) per their per-spec contracts, and specifies the recommended caller pattern for shutting down providers in concert with disposal (§6.5).

### 6.1 The integration model

A **lifecycle-aware integration** is a component that registers with an instance through a published library API and, in doing so, gives the library the means to notify it when the instance is disposed. The two integrations recognized by this spec are fleet aggregators (cl-spec-012) and OpenTelemetry exporters (cl-spec-013). The integration relationship is bidirectional: the integration holds a back-reference to the instance, and the instance may have registered callbacks with the integration in turn (for example, an exporter that subscribes to events through `on()`, or a fleet that the instance pushes assessments to). Step 3 of teardown tears down both directions of the link — the instance notifies the integration, and the instance unsubscribes from any callbacks it registered with the integration.

A **provider** is a dependency that the caller passes to the constructor — most prominently the tokenizer and embedding provider (cl-spec-007) — and that the library consumes through a defined interface. Providers are not registered as integrations, the library does not track them in any teardown structure, and the library never invokes a provider lifecycle hook. Provider lifecycle is fully caller-owned. §6.5 specifies the recommended pattern for interleaving provider shutdown with disposal.

The distinction is the registration handshake. An integration that the library does not know about cannot be notified by step 3, regardless of whether it holds a back-reference to the instance. Callers who build their own integrations on top of context-lens have two paths:

- **Wrap or interpose on a recognized integration.** Build the custom logic on top of a fleet (cl-spec-012) or an exporter (cl-spec-013), so that the custom code is reached through the recognized integration's teardown callback.
- **Listen for `stateDisposed` via `on()`.** Subscribe a handler to the `stateDisposed` event (§7.1) and perform teardown work inside it. The handler-based path imposes the read-only-during-disposal rule of §3.4: the handler may call read-only public methods to inspect the instance's last live state, but any mutating method call throws `DisposedError`, and any deferred work the handler schedules via microtask is forbidden from calling back into the instance (§3.5).

Custom code that takes neither path is invisible to the lifecycle and will not be notified of disposal.

### 6.2 The teardown callback contract

Every lifecycle-aware integration registers a teardown callback with the instance at attachment time. The exact registration API is integration-specific — cl-spec-012 specifies how a fleet attaches, cl-spec-013 specifies how an exporter attaches — but the callback's contract during disposal is uniform across integrations and is specified here.

The library invokes each teardown callback synchronously during step 3 of teardown (§4.1). Every registered callback is invoked exactly once per disposal. Invocation order across integrations is deterministic but is not part of the public contract — callers must not depend on a particular fleet being notified before a particular exporter, or vice versa.

Inside the callback, the integration sees:

- `isDisposed === false` and `isDisposing === true`. The disposed flag is not set until step 6, and integration callbacks run in step 3. This is consistent with §2.4's rule that `isDisposed` flips precisely when `dispose()` returns successfully, and §2.5's rule that `isDisposing` is true for the duration of the in-flight `dispose()` call.
- Read-only public methods on the instance behave per their live specification. Step 4 (resource clearing) has not yet run, so the cache, ledger, segment store, and ring buffers are intact. Step 5 (registry detachment) has not yet run either. The integration may therefore read the instance's last live state in full — `getDiagnostics()`, `assess()`, `snapshot()`, `getEvictionHistory()`, and any other query method are valid. Mutating methods throw `DisposedError` because the throw guard fires on `isDisposing` (§3.4); the same read-only-during-disposal rule applies uniformly to step-2 `stateDisposed` handlers and step-3 integration callbacks.

The integration must:

- **Drop its back-reference to the instance.** After step 3 returns, the library will clear its own owned resources (step 4); the integration must release its hold on the instance to allow the runtime to collect those resources once the caller drops their handle.
- **Detach any callbacks it registered with the instance through `on()` or other registration APIs.** The library detaches the handler registry in step 5, so explicit detachment is not strictly required for memory release, but it is the cleaner contract — it is self-contained on the integration side and survives any future refactor that delays step 5. Note that `on()` itself is mutating and would throw if called from inside the teardown callback; existing unsubscribe handles, captured at attachment time, remain callable and act as no-ops once the registry is detached (§5.1).
- **Complete any deferred work that depends on the instance's live state before returning from the callback** — flush a pending aggregated report, emit a final OpenTelemetry signal, persist a checkpoint. After step 4 has run, this work is no longer possible because the data needed to do it has been cleared.

The integration must not:

- **Mutate the instance.** `add()`, `update()`, `evict()`, and other mutating methods throw `DisposedError` per the read-only-during-disposal rule (§3.4). Even if the throw were absent, the mutation's effects on internal state would be destroyed by step 4, and the events fired through the still-attached registry would reach subscribers as notifications of mutations that never durably happened.
- **Re-attach itself or any other integration to this instance.** The instance is committed to disposing. The library does not specify whether late re-attachments survive teardown (the iteration over registered integrations is taken at the start of step 3), so re-attachment is at best wasteful and at worst leaks an integration through to the disposed state. (Re-attachment APIs are themselves mutating and would throw under the during-disposal rule, but integrations registered through paths that bypass the public API surface — for example, direct manipulation of integration tables — could attempt re-attachment outside the throw guard's reach.)
- **Throw to abort disposal.** Errors thrown by a teardown callback are caught and aggregated per §4.3; they do not abort teardown. Disposal completes regardless of how many callbacks throw.

A callback that throws is added to the per-call disposal error log (§4.3). After step 6, those errors surface to the caller of `dispose()` as the constituent errors of a `DisposalError` (§7.2). The callback itself receives no library-mediated indication that it threw — error reporting is exclusively the caller's view of `dispose()`'s outcome.

### 6.3 Fleet aggregators

A fleet (cl-spec-012) aggregates reports across multiple `ContextLens` instances; it holds a back-reference to each attached instance and observes their assessments to compute fleet-level summaries. When an attached instance is disposed, the fleet's teardown callback receives the notification described in §6.2.

The fleet's expected behavior on receipt:

1. **Compute and emit any final aggregated report that includes the just-disposed instance.** This is the fleet's last opportunity to read the instance's accumulated state. Aggregations that are scheduled or batched — for example, a fleet that emits aggregated reports every N assessments and has not reached the next threshold — should be flushed for the disposed instance specifically. The fleet may amortize the flush across the remaining attached instances or emit a one-off report attributing the partial aggregate to the disposed instance, per the cl-spec-012 aggregation contract.
2. **Remove the instance from the fleet's tracked-instances set.** Subsequent fleet-level operations — reports, queries, broadcasts — must not include the disposed instance. The removal is unconditional: it happens whether or not the final report emission succeeded, so a flush failure does not pin a disposed instance in the fleet's tracking structures.
3. **Release the back-reference.** Once the instance is removed from the tracked set, the fleet's own retained pointer to the instance is dropped so the runtime can collect the instance's owned resources after step 4 of teardown completes.

The fleet does not call back into `dispose()` on the same instance from inside its callback. Reentrance is permitted by the lifecycle (§3.4) and would be a no-op, but the fleet has no operational reason to re-enter — it has already received the notification.

If the caller had configured the fleet to detect "missing" instances by polling `isDisposed` rather than receiving callbacks, that polling continues to work after disposal: `isDisposed` returns `true` once `dispose()` completes (§2.5). The callback path is the recommended mechanism because it permits the final-report flush; the polling path is a fallback for callers who defer fleet-side cleanup to a separate scan.

### 6.4 OpenTelemetry exporters

An OpenTelemetry exporter (cl-spec-013) translates an instance's events and assessments into OpenTelemetry signals — typically spans for assessments, metrics for quality dimensions, and structured logs for state transitions. The exporter holds a back-reference to the instance and registers handlers with the instance through `on()` to subscribe to events as they emit.

The exporter's expected behavior on receipt of the teardown notification (§6.2):

1. **Flush any buffered signals derived from the instance.** Exporters that batch signals — for example, a metrics exporter that aggregates per-dimension samples and emits a histogram every interval — should emit the final signal covering the just-disposed instance during the callback. After step 4 of teardown clears the instance's accumulated state, the data needed to compute these signals is gone.
2. **Detach any handlers registered with the instance through `on()`.** The library detaches the registry in step 5 (§4.1), so this is not strictly required for correctness, but explicit detachment by the exporter is the cleanest contract — it is self-contained on the exporter side and survives any future refactor that delays step 5.
3. **Release the back-reference to the instance.** As with fleets, the back-reference must be dropped to allow the runtime to collect the instance's owned resources.

The `stateDisposed` event (§7.1) is delivered to subscribed handlers during step 2 of teardown — before the exporter's teardown callback runs in step 3. An exporter that subscribes to `stateDisposed` therefore sees the disposal twice: once as an event in step 2, once as a teardown callback in step 3. Implementations must not duplicate the final-signal flush across both paths. The recommended pattern is to do the flush in the step 3 callback (where §6.2 governs) and to let any step 2 `stateDisposed` handler perform only ambient work — log or trace the disposal, emit metrics about handler count, etc. Both step 2 and step 3 share the same read-only-during-disposal rule (§3.4), so either could in principle invoke read-only methods to compute the flush; the step-3 path is preferred because §6.2 explicitly contracts the "flush before resources clear" expectation, and centralizing the flush avoids accidental duplication.

### 6.5 Providers

The tokenizer and embedding provider passed to the constructor (cl-spec-007) are not lifecycle-aware integrations. The library does not register a teardown callback with them, does not call any "shutdown" method on them during `dispose()`, and does not consider them part of step 3. Providers are caller-owned dependencies; the caller decides when and how they are released.

This is a deliberate choice. Per §3.5, `dispose()` is synchronous, and many providers have asynchronous shutdown hooks (network pool drains, worker thread terminations, subprocess waits) that would force an `await` inside teardown. Async disposal would in turn require every public method to reason about an "is this instance still being torn down?" race; the library elects to keep `dispose()` synchronous and push provider shutdown to the caller.

The recommended caller pattern interleaves the synchronous `dispose()` with asynchronous provider shutdowns:

```ts
const tokenizer = await createTokenizer(...);
const embedder = await createEmbedder(...);
const lens = new ContextLens({ tokenizer, embedder, ... });
try {
  // ... use lens ...
} finally {
  lens.dispose();
  await tokenizer.close?.();
  await embedder.close?.();
}
```

Two ordering invariants justify the structure:

- **`lens.dispose()` runs before provider shutdown.** Disposal nulls the library's strong references to the providers (step 4 of teardown, §4.1) and detaches every handler that might invoke them (step 5). After `dispose()` returns, no library code path can invoke a provider, even reentrantly. Provider shutdown is therefore safe — there is no risk of a late library-internal call hitting a half-shut-down provider. The reverse order (shut down providers first, then dispose) is unsafe: a `stateDisposed` handler firing during step 2 might invoke a tokenizer or embedder that has already been shut down, and the resulting error would surface as a `DisposalError` (§4.3) attributable to the caller's misordering.
- **Provider shutdowns are awaited; `lens.dispose()` is not.** `dispose()` is synchronous and returns `void`; `await lens.dispose()` would await a non-promise (a no-op in JavaScript) but would mislead readers about the operation's nature. Providers that expose a `close()` or `shutdown()` method as a `Promise` are awaited explicitly so the `finally` block does not return until provider cleanup has actually completed.

Callers that do not own the provider — for example, a long-lived process that shares a single tokenizer across many short-lived instances — should omit the provider shutdown from the per-instance `finally` block and instead shut down the shared providers at process exit. The pattern is the same on the disposal side: `dispose()` releases the library's grip on the providers; whether the caller subsequently shuts them down is a caller-level decision the library does not constrain.

---

## 7. Events and Errors

This spec extends the cl-spec-007 event catalog (§9) and the cl-spec-007 error hierarchy with one event and two error types. Section 7.1 specifies the `stateDisposed` event — added to the event catalog and emitted exactly once per instance, during step 2 of teardown. Section 7.2 specifies `DisposedError` (raised on every public-method call against a disposed instance) and `DisposalError` (raised by `dispose()` when caller-supplied callbacks errored during teardown). The two error types describe orthogonal failure modes and are distinguished at runtime by their class identities and `name` fields.

### 7.1 The stateDisposed event

This spec adds a single event to the catalog specified by cl-spec-007 §9: `stateDisposed`. The event signals that an instance has begun teardown and gives subscribers a final synchronous opportunity to react before the instance becomes terminal. It is emitted exactly once across an instance's lifetime, and it is the last event the instance ever emits. Adding `stateDisposed` brings the cl-spec-007 §9.2 catalog to 25 events.

The payload is a frozen object:

```ts
type StateDisposedEvent = {
  readonly type: 'stateDisposed';
  readonly instanceId: string;
  readonly timestamp: number;
};
```

`type` is the event discriminator, consistent with the convention of cl-spec-007 §9. `instanceId` identifies the instance being disposed; it matches the identifier carried by `DisposedError` (§7.2) and by external integration teardown notifications (§6.2), so callers can correlate the three across logs, traces, and aggregated reports. `timestamp` is captured at the start of the originating `dispose()` call, before any teardown step runs, and is reported as milliseconds since the UNIX epoch.

The payload is constructed once per disposal and delivered as the same frozen reference to every handler. Mutations of the payload are forbidden — the fields are primitive immutable values, and the object is frozen — and a handler that attempts to mutate the payload encounters a `TypeError` from the runtime's strict-mode handling of frozen objects.

`stateDisposed` is dispatched during step 2 of teardown (§4.1). The dispatch is synchronous and in-process, in registration order across the handler registry, with each handler running to completion before the next is invoked. The library does not return from step 2 until every handler has been called. A handler that throws does not interrupt the iteration; the throw is caught and aggregated per §4.3.

Handlers running during the notification observe `isDisposed === false` and `isDisposing === true` (§2.5) and operate under the read-only-during-disposal rule of §3.4. In summary: they may read both getters, may call any read-only public method (the instance's last live state is intact), may re-call `dispose()` (which is a no-op), and may perform external work; they must not call mutating public methods (the throw guard fires on `isDisposing` and `DisposedError` is raised) — including `on()`, which is itself mutating. A handler that schedules a microtask during the notification has the microtask drained on the same turn of the event loop after `dispose()` returns; per §3.5, by the time the microtask runs, every public method except `dispose()`, `isDisposed`, and `isDisposing` throws `DisposedError`.

The exactly-once guarantee is preserved across re-entry. A handler that re-calls `dispose()` triggers the no-op path of §3.3 — no second `stateDisposed` is emitted, even if the handler's implementation is unaware that disposal is already in progress. Subsequent `dispose()` calls on the already-disposed instance similarly do not re-emit. A handler that re-registers itself during step 2 in violation of §3.4 is removed by step 5 and never receives a second notification across any subsequent call. Across the lifetime of the instance, the handler registry collectively observes `stateDisposed` exactly once.

### 7.2 Error types

The lifecycle introduces two error types into the cl-spec-007 error hierarchy: `DisposedError`, raised on every public-method call against a disposed instance, and `DisposalError`, raised by `dispose()` itself when caller-supplied callbacks errored during teardown. The two errors describe orthogonal failure modes — one is observed by callers of any public method, the other only by callers of `dispose()` — and they cannot be confused for one another at runtime: their `name` fields are distinct, their inheritance chains differ, and they carry different fields. Callers distinguish them with `instanceof` checks.

**DisposedError.** Raised by the disposed-state guard at the top of every public method (other than `dispose()`, `isDisposed`, and `isDisposing`) under either of two conditions:

- **Post-disposal.** The method is invoked on a disposed instance (`isDisposed === true`). All public methods other than the three exceptions listed above throw, regardless of category.
- **During-disposal mutation.** A mutating method (the list in §3.4) is invoked while disposal is in progress (`isDisposing === true`). Read-only methods do not throw under this condition — they execute normally until step 4 of teardown clears their backing state, after which the post-disposal condition takes over.

The error is synchronous and is thrown before any side effect of the called method — no argument validation runs, no cache lookup happens, no event is emitted.

```ts
class DisposedError extends Error {
  readonly name: 'DisposedError';
  readonly instanceId: string;
  readonly attemptedMethod: string;
}
```

`instanceId` identifies the affected instance; it matches the identifier carried by the `stateDisposed` event payload (§7.1) and by integration teardown notifications (§6.2). `attemptedMethod` is the camelCase name of the public method that was invoked — `'add'`, `'getCapacity'`, `'snapshot'`, and so on. The default message conveys the instance state and the attempted method — `ContextLens instance ${instanceId} is disposed; cannot call ${attemptedMethod}()` for the post-disposal condition, or `ContextLens instance ${instanceId} is disposing; cannot call ${attemptedMethod}()` for the during-disposal mutation condition. The error class is identical in both cases — callers that need to differentiate the conditions inspect `isDisposed` and `isDisposing` on the affected instance from inside their `catch` block, or rely on the message text. Implementations may augment the message but must preserve the identifying information.

The retained metadata that backs `DisposedError` post-disposal is exactly what its fields carry: the instance identifier and, indirectly through the call site, the method that was attempted. During-disposal throws use the same error shape; the only difference is the message text and the values of `isDisposed`/`isDisposing` at the moment of the throw. The library does not differentiate by elapsed time — every post-disposal call sees the identical error type and structure.

**DisposalError.** Raised by `dispose()` itself, exactly once per disposal, only when one or more caller-supplied callbacks (handlers in step 2 or integration teardown callbacks in step 3) threw during the call. It is not raised by an error-free disposal, and it is not raised by subsequent `dispose()` calls on the already-disposed instance — those return as no-ops per §3.3.

```ts
class DisposalError extends AggregateError {
  readonly name: 'DisposalError';
  readonly instanceId: string;
  // `errors` is inherited from AggregateError and carries the per-callback errors.
}
```

`instanceId` identifies the instance whose disposal raised the error. `errors` is the standard `AggregateError` property: an array of the values caught during steps 2 and 3, in the order they were caught — handlers from step 2 first (in registration order), then integration callbacks from step 3 (in the deterministic but unspecified integration order from §6.2). Each entry preserves the original thrown value. The library may wrap entries to attach origin metadata — whether the thrower was a handler or an integration callback, and the index of the registration in its respective list — and when the wrap is present, the original error is exposed through the standard `cause` property of the wrapping error.

The default message summarizes the count and origin of the constituent errors — for example, `ContextLens instance ${instanceId} disposed with 3 callback errors (2 handlers, 1 integration)`. The instance is fully disposed at the moment the error is thrown (§4.3); the message is informational and does not signal incomplete teardown. A caller that wishes to suppress `DisposalError` because they consider the constituent errors recoverable may catch and inspect it; the disposal has already completed, so swallowing the error has no effect on the lifecycle.

**Distinguishing the two.** `DisposalError` and `DisposedError` differ in three ways:

- **Origin.** `DisposalError` is raised by `dispose()` only. `DisposedError` is raised by every public method other than `dispose()` and `isDisposed`.
- **Multiplicity.** `DisposalError` is raised at most once across an instance's lifetime. `DisposedError` is raised on every post-disposal method call.
- **Cardinality.** `DisposalError` aggregates a list of constituent errors via the `AggregateError` interface. `DisposedError` reports a single condition with a fixed shape.

Callers use them differently. A `try { ... } finally { lens.dispose(); }` block needs only to allow `DisposalError` to propagate, or catch it for diagnostics. A `try { lens.add(...); } catch (e) { if (e instanceof DisposedError) ... }` block uses `DisposedError` as a control-flow signal that the instance is gone. The two patterns coexist in the same code path without ambiguity because the runtime types are distinct, and a single `catch` block that handles both can dispatch on `instanceof` to apply the appropriate response.

Neither error is delivered through the event system. Per §3.6, `dispose()` reports failure by throwing rather than by emitting a "disposal-failed" event, on the grounds that an event-based delivery could be silently swallowed by another handler and the failure information lost. `DisposedError` is similarly raised synchronously rather than through the event system because the failure is local to the failing method call — the caller of that method, not unrelated subscribers, is the audience that needs to react.

---

## 8. Invariants and Constraints

**Invariant 1: Two-state lifecycle.** An instance occupies exactly one of two states across its in-memory lifetime: live or disposed. There is no observable intermediate state — no "initializing", no "suspended", no exposed "disposing-in-progress". Every observation made by caller code, by event subscribers, by fleet aggregators (cl-spec-012), or by exporter sinks (cl-spec-013) sees one state or the other (§2).

**Invariant 2: No reactivation.** A disposed instance cannot be returned to the live state. There is no `undispose`, no resurrect, no lazy restart. A caller that needs to resume monitoring constructs a new instance; when state preservation matters, the live instance is `snapshot()`-ed (cl-spec-014) before disposal and the snapshot rehydrated via `fromSnapshot()` into a fresh instance (§2.3, §5.4).

**Invariant 3: No reset.** There is no operation that clears accumulated state in place. The lifecycle has no live → live transition; callers who want a clean slate dispose and reconstruct (§2.3).

**Invariant 4: isDisposed and isDisposing flip atomicity.** `isDisposed` flips from `false` to `true` precisely when `dispose()` returns successfully (step 6 of teardown, §4.1). `isDisposing` flips from `false` to `true` at the start of teardown (step 1) and back to `false` when `dispose()` returns — alongside `isDisposed` becoming `true` on the success path, or alone on the failure path (future fallible-step amendments). The two flags are mutually exclusive at any inspection point; both are false during normal live operation. No caller observes a partial transition. A handler firing during the `stateDisposed` notification sees `isDisposed === false` and `isDisposing === true`; every observation after `dispose()` returns successfully sees `isDisposed === true` and `isDisposing === false` (§2.4, §2.5).

**Invariant 5: dispose() idempotency.** `dispose()` is callable from any state. The first successful call performs every teardown step exactly once; subsequent calls return as no-ops without re-emitting events, re-invoking integration callbacks, re-throwing prior errors, or re-clearing already-cleared resources. Reentrant calls during teardown — including from inside a `stateDisposed` handler — observe `isDisposing === true` and return immediately (§3.2, §3.3, §3.4).

**Invariant 6: dispose() synchronicity.** `dispose()` is fully synchronous. It returns to the caller only after every teardown step has completed. There is no `Promise<void>` return type, no internal `await`, no background work scheduled during disposal. Provider shutdown hooks with their own asynchronous lifecycle (network pool drains, worker terminations, subprocess waits) are the caller's responsibility to invoke after `dispose()` returns (§3.5, §6.5).

**Invariant 7: stateDisposed exactly-once emission.** The `stateDisposed` event is emitted exactly once across an instance's lifetime, during step 2 of teardown, in registration order across the handler registry. It is the last event the instance ever emits. Reentry from a handler that re-calls `dispose()` triggers the no-op path; subsequent `dispose()` calls do not re-emit; a handler that re-registers itself during step 2 is removed by step 5 and never receives a second notification (§4.1, §7.1).

**Invariant 8: Teardown step ordering.** The teardown sequence has six fixed steps in fixed order: set the disposing flag, emit `stateDisposed`, notify external integrations, clear owned resources, detach the handler registry, set the disposed flag. The total order is uniquely determined by the constraints in §4.2 — handlers receive `stateDisposed` over a still-attached registry, integrations read live state before resources are cleared, and the disposed flag is the final commit point (§4.1, §4.2).

**Invariant 9: Step 6 single commit point.** Setting the disposed flag (step 6) is the single commit point of the lifecycle. No teardown step may run after it. Any future amendment that introduces a fallible library-internal step must place that step strictly before step 6; the rollback-to-live contract of §2.4 applies only on failure paths that abort before step 6 has run (§4.4).

**Invariant 10: Caller-callback errors do not abort teardown.** Errors thrown by `stateDisposed` handlers (step 2) and by integration teardown callbacks (step 3) are caught, aggregated into a per-call disposal error log, and surfaced as a single `DisposalError` after step 6. They never abort teardown, never roll back the live → disposed transition, and never cause a step to be skipped. Disposal completes regardless of how many callbacks throw; the instance is fully disposed at the moment `DisposalError` is raised (§4.3, §6.2, §7.2).

**Invariant 11: DisposedError gates the disposed-state and during-disposal-mutation guards.** Every public method on a disposed instance other than `dispose()`, `isDisposed`, `isDisposing`, and `instanceId` throws `DisposedError`. The post-disposal throw is uniform across all method categories — queries, mutations, assessments, planning, subscription, persistence — because backing state has been cleared in step 4 of teardown. Additionally, mutating public methods invoked during disposal (between step 1 and step 6, while `isDisposing === true`) throw `DisposedError`; read-only methods continue to behave per their live specification during disposal because their backing state is intact. Both throws are synchronous and occur before any side effect of the called method — no argument validation, no cache lookup, no event emission (§3.4, §5.1, §7.2).

**Invariant 12: Constant-sized retained metadata.** A disposed instance retains only the metadata needed to answer subsequent `isDisposed`, `isDisposing`, and `instanceId` queries and to identify itself in `DisposedError` messages — two flags and an identifier. The retained-metadata footprint is constant regardless of the instance's pre-disposal size: a disposed instance that previously held 10,000 segments occupies the same per-instance footprint as one that previously held 10 (§5.2).

**Invariant 13: Provider lifecycle is caller-managed.** Tokenizer (cl-spec-006) and embedding (cl-spec-005) providers passed to the constructor are not lifecycle-aware integrations. The library does not register a teardown callback with them, does not call any "shutdown" method on them during `dispose()`, and does not consider them part of step 3. Provider lifecycle is fully caller-owned; the recommended pattern is to call `dispose()` first (releasing the library's references) and then await any provider shutdown hooks (§3.5, §6.5).

**Invariant 14: Integration callbacks exactly once.** Each lifecycle-aware integration registered with the instance — fleet aggregators (cl-spec-012), OpenTelemetry exporters (cl-spec-013) — receives its teardown callback exactly once per disposal, during step 3, with `isDisposed === false`, `isDisposing === true`, and the instance's read-only API available. Within the callback, the integration must drop its back-reference, detach any callbacks it registered with the instance, and complete deferred work that depends on live state; it must not invoke mutating methods (they throw `DisposedError` per the read-only-during-disposal rule), re-attach, or expect throws to abort disposal (§6.2, §6.3, §6.4).

**Invariant 15: Stable instanceId across all states.** `instanceId` is generated once at construction and returns the same string value throughout the instance's existence in memory — across `live`, `disposing`, and `disposed` states. The getter never throws. The value matches the identifier carried by `stateDisposed` event payloads (§7.1), `DisposedError` (§7.2), and integration teardown notifications (§6.2), making `instanceId` the canonical correlation key for telemetry that needs to tie events on the same instance together (§2.5).

---

## 9. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-001` (Segment Model) | Defines the segment store cleared during step 4 of teardown (§4.1, §5.2). |
| `cl-spec-002` (Quality Model) | Defines the continuity ledger cleared during step 4 of teardown (§4.1, §5.2). |
| `cl-spec-005` (Embedding Strategy) | Defines the embedding cache cleared during step 4 of teardown and the embedding provider whose lifecycle is caller-managed (§4.1, §6.5, Invariant 13). |
| `cl-spec-006` (Tokenization Strategy) | Defines the token cache cleared during step 4 of teardown and the tokenizer whose lifecycle is caller-managed (§4.1, §6.5, Invariant 13). |
| `cl-spec-007` (API Surface) | The public API extended by this spec. Adds `dispose()`, `isDisposed`, and `isDisposing` to the method catalog (§2.5, §3, §5.1); `stateDisposed` to the event catalog of cl-spec-007 §9 (§7.1, bringing the catalog to 25 events); and `DisposedError` and `DisposalError` to the error hierarchy (§7.2). The `stateDisposed` handler contract is documented as a deliberate deviation from the general handler contract in cl-spec-007 §9.3 — mutations throw rather than being undefined, and handler errors are aggregated rather than swallowed (§3.4, §4.3). Supersedes the "no explicit disposal" invariant previously stated in cl-spec-007 §11 (§1). |
| `cl-spec-010` (Report & Diagnostics) | Defines the report and timeline ring buffers cleared during step 4 of teardown (§4.1, §5.2). |
| `cl-spec-012` (Fleet Monitor) | Defines fleet aggregators as a lifecycle-aware integration. This spec specifies the per-fleet teardown callback contract executed during step 3 of teardown (§6.3). |
| `cl-spec-013` (Observability Export) | Defines OpenTelemetry exporters as a lifecycle-aware integration. This spec specifies the per-exporter teardown callback contract executed during step 3 of teardown (§6.4). |
| `cl-spec-014` (Serialization) | Defines `snapshot()` and `fromSnapshot()`. The continuation patterns of §5.4 use these to preserve state across disposal — `snapshot()` captures the live instance's state before `dispose()`, and `fromSnapshot()` rehydrates a fresh instance after. |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.7*
