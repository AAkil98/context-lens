# Seed Context — context-lens

## What is this project?

context-lens is a standalone open-source library that monitors and measures context window quality for LLM applications. The core insight: everyone managing context windows truncates blind using token count as the only signal. Context has *quality* — coherence, density, relevance, continuity — and quality degrades in predictable, detectable ways long before the window fills up.

## Origin

Extracted from the MADA-OS specification corpus. Brainstorm session: `../mada-journal/sessions/mada/brainstorm_20260324_context-lens.md`. That file contains the full exploration: four quality dimensions, five degradation patterns, API shape options, target users, competitive landscape, MVP scope, and technical architecture sketch. Read it for deep context.

## Spec-driven workflow

This project follows the spec-driven development workflow defined in `../mada-journal/sessions/mada/brainstorm_20260322_claude-template-standardization.md`. The sequence: design specs (scaffold + write section-by-section + review) → implementation specs (phased) → code. We are in the design spec phase.

## Current state

**Spec 1 (Segment Model) is complete:** `specs/01-segment-model.md`

Key decisions made in Spec 1:
- A segment is a caller-defined unit of semantic meaning — context-lens does not impose granularity
- Dual ID strategy: caller-assigned (preferred) or auto-generated via content hash (enables deduplication)
- No role field. Origin tag (freeform string) captures provenance instead
- Importance: continuous 0.0–1.0 priority weight
- Groups: first-class, with aggregate properties and atomic eviction
- 4-tier protection model: `pinned` (absolute) > `seed` (foundational, compactable) > `priority(n)` (ranked 0–999) > `default`
- 8 lifecycle operations: seed, add, update, replace, compact, split, evict, restore
- Soft capacity enforcement — context-lens reports, caller decides

**Spec 6 (Tokenization Strategy) is complete:** `specs/06-tokenization-strategy.md`

Key decisions made in Spec 6:
- Provider abstraction: one method (`count`), optional `countBatch`, metadata (name, accuracy, modelFamily, errorBound)
- Default provider: character-class heuristic, ±10%, model-agnostic, zero dependencies
- Exact counting via adapter pattern: tiktoken adapter for OpenAI, generic adapter for anything else
- Token counts cached with LRU (keyed on content hash + provider name, default 4096 entries)
- Capacity is required — no default, caller must declare window size
- Provider switching triggers full recount of all active segments
- context-lens counts content tokens only — framing tokens are the caller's responsibility

Lifecycle amendment (2026-04-29) — cl-spec-015 cross-reference: §6.3 gained a "Provider lifecycle is caller-managed" paragraph; new Invariant 14a (Caller-owned provider lifecycle); §9 references gained cl-spec-015 entry. No behavioral change — formalizes the existing boundary that `dispose()` does not invoke provider shutdown hooks.

**Spec 2 (Quality Model) is complete:** `specs/02-quality-model.md`

Key decisions made in Spec 2:
- Four dimensions scored independently: coherence, density, relevance, continuity
- No LLM calls — all scoring from structural signals (similarity, token counts, metadata, timestamps)
- Similarity via embeddings (optional, cl-spec-005) or Jaccard character trigrams (dependency-free fallback)
- Coherence: adjacency similarity (0.6 weight) + topical concentration via clustering (0.4 weight) + group integrity
- Density: information ratio = 1 - max redundancy to non-adjacent segments; token-weighted window aggregation
- Relevance: caller-provided task descriptor (`setTask`); content similarity + keyword boost + metadata signals (origin, tags, importance, recency); no task = all segments score 1.0
- Continuity: cumulative loss ledger tracking eviction cost, compaction cost, restoration fidelity; net loss normalized against total information value
- Quality baseline captured after seeds, before first add; immutable; all window scores normalized relative to baseline
- Composite: weighted geometric mean (one collapsed dimension → composite zero); for human consumption, not eviction decisions
- Quality reports: on-demand snapshots with per-segment scores, group scores, continuity summary, trend deltas; cached with lazy invalidation

**Spec 3 (Degradation Patterns) is complete (amended):** `specs/03-degradation-patterns.md`

Key decisions made in Spec 3:
- Five named patterns: Saturation (capacity), Erosion (density + utilization compound), Fracture (coherence), Gap (relevance + task), Collapse (continuity)
- Three severity levels: watch, warning, critical — with hysteresis (0.03 margin) to prevent flicker
- Patterns are diagnostic, not prescriptive — they name problems and suggest remediation, they do not modify the window
- Detection is a thin classification layer on quality scores — no additional computation, same performance budget
- Six causal chains (Pressure→Loss, Pressure→Dilution, Shift→Drift, etc.) with upstream vigilance annotations
- Six named compound patterns (fullOfJunk, fullOfWrongThings, scatteredAndIrrelevant, lossDominates, pressureLoop, triplePressure)
- Fixed priority ordering: Collapse > Saturation > Gap > Erosion > Fracture (advisory, not prescriptive)
- Configurable thresholds (per-pattern, per-severity) and pattern suppression (total skip, not hide)
- 16 invariants (10 base + 6 custom pattern) including determinism, side-effect freedom, in-budget detection, name uniqueness, fail-open detection, uniform output shape

Amendment (§10 Custom Pattern Registration):
- OQ-009 resolved: custom patterns receive full QualityReport (public, schema'd, more powerful than simplified view)
- PatternDefinition contract: name, description, detect, severity, explanation, remediation (required); strategyHint, priority (optional)
- Registration at construction (customPatterns config) and runtime (registerPattern). Append-only in v1
- Framework wraps custom patterns with hysteresis (two-cycle deactivation for boolean signals)
- Fail-open error handling: throwing detect → warning + skip, other patterns unaffected
- StrategyHint maps to existing eviction strategy weights for custom-pattern-driven auto-selection
- v1 limitations: no compound participation, no threshold overrides via framework, no unregisterPattern

**Spec 4 (Task Identity) is complete:** `specs/04-task-identity.md`

Key decisions made in Spec 4:
- Task descriptor: description (required, max 2000 chars), keywords (max 50), relatedOrigins, relatedTags. Validated, normalized (whitespace collapse, case-insensitive keyword dedup, sorted arrays), immutable after set (defensive copy).
- Three-way transition classification: same task (no-op), refinement (similarity > 0.7, invalidate scores, no grace period), change (similarity ≤ 0.7, invalidate scores, activate grace period). Description similarity drives classification; metadata-only changes are always refinements.
- Two-state lifecycle: UNSET (relevance=1.0, gap suppressed) and ACTIVE. Five transitions. Four operations: setTask, clearTask, getTask, getTaskState.
- Grace period: 2 quality reports after task change, caps gap severity at watch. Not configurable. Restarts on new change, survives refinements.
- Staleness: flag at 5 reports without setTask. Advisory only — no effect on scoring. Consumed by gap remediation hints.
- Transition history: ring buffer of 20 entries with type, timestamp, similarity, truncated descriptions.
- Preparation: embedding or trigram, synchronous within setTask, cached until next setTask.
- All consumers (quality model, detection framework, eviction advisory, diagnostics) are read-only — only setTask/clearTask modify task state.
- 12 invariants including caller ownership, defensive setTask, synchronous invalidation, deterministic classification, segment independence.

**Spec 5 (Embedding Strategy) is complete:** `specs/05-embedding-strategy.md`

Key decisions made in Spec 5:
- OQ-005 resolved: no bundled model. Adapter interface + optional adapters. Zero-config = trigrams.
- Provider interface: `embed(text) → number[]` (required, async allowed), `embedBatch` (optional), metadata (name, dimensions, modelFamily, maxInputTokens). Deterministic, stateless, thread-safe.
- Built-in providers: no-provider default (trigram mode), OpenAI adapter (text-embedding-3-small/large, retry on 429, batch chunking), generic adapter (wraps any function, validated at construction).
- One provider per instance. Registration at construction or via `setEmbeddingProvider`. Null removes provider (trigram downgrade). Same-name = no-op.
- Embedding lifecycle: segment content + task description embedded; keywords/metadata not embedded. Embedding completed within triggering lifecycle operation. Batch optimization for seed. Cache-aware batching.
- Embedding cache: keyed on (contentHash, providerName), LRU-bounded (default 4096), separate from similarity cache. No time-based expiration.
- Provider switch: 5-step invalidation cascade (clear embedding cache, invalidate similarity cache, invalidate quality scores, recompute all segments, recompute task). Atomic. Rollback to trigrams on mid-way failure.
- Fallback: individual failures propagate (no silent per-call fallback). Report-level trigram fallback on persistent failure. Mode consistency enforced per report. No cross-mode score comparison.
- 11 invariants including single provider, mode consistency, fallback always available, lifecycle-synchronous embedding, caller-owned provider lifecycle (added 2026-04-29 to acknowledge cl-spec-015 boundary).

Lifecycle amendment (2026-04-29) — cl-spec-015 cross-reference: §3.4 gained a "Provider lifecycle is caller-managed" paragraph; new Invariant 11 (Caller-owned provider lifecycle); §9 references gained cl-spec-015 entry. No behavioral change — formalizes the existing boundary that `dispose()` does not invoke provider shutdown hooks.

**Spec 7 (API Surface) is complete:** `specs/07-api-surface.md`

Key decisions made in Spec 7:
- OQ-008 resolved: stateful API. Each instance owns segments, scores, caches, history. Stateless rejected (continuity, patterns, caching, baseline all need lifecycle awareness).
- One instance, one window. No shared state between instances.
- Caller-driven mutations — context-lens never auto-evicts, auto-compacts, or auto-reorders.
- Constructor: `new ContextLens({ capacity })`. Capacity required, no default. Optional: tokenizer, embeddingProvider, thresholds, suppression, cache sizes, customPatterns.
- 8 segment operations exposed: `seed` (batch), `add`, `update`, `replace`, `compact`, `split`, `evict`, `restore`. All atomic.
- Group operations: `createGroup`, `dissolveGroup`, `getGroup`, `listGroups`.
- Task operations: `setTask` (returns TaskTransition with classification), `clearTask`, `getTask`, `getTaskState`.
- Central method: `assess()` → QualityReport (scores, patterns, capacity, trend, segments, groups, continuity).
- Pattern registration: `registerPattern(definition)` for runtime custom pattern registration.
- Serialization: `toJSON()` produces schema-conforming plain objects with `schemaVersion`. Static `schemas` and `validate` exports.
- Provider management: `setTokenizer`, `setEmbeddingProvider` with full invalidation cascades.
- Inspection: `getCapacity`, `getSegment`, `listSegments` (with filtering), `getSegmentCount`, `getEvictionHistory`.
- Event system: 20 events (19 original + customPatternRegistered), synchronous observer, no re-entrancy allowed.
- Error model: 12 typed errors extending ContextLensError. Atomic failure guarantee. Defensive copies on input and output.
- Progressive disclosure: minimal usage is construct + add + assess. Everything else opt-in.

Amendment complete: `snapshot()`/`fromSnapshot()` added after cl-spec-014 (Serialization) was drafted. 22 events total (19 original + customPatternRegistered + stateSnapshotted + stateRestored).

Further amendment during implementation: `reportGenerated` and `budgetViolation` added. 24 events total.

Lifecycle amendment (2026-04-29) — cl-spec-015 integration:
- New §9 "Lifecycle" section added (between Capacity/Inspection and Event System). Documents `dispose()`, `isDisposed`, `isDisposing`, `instanceId` with cross-references to cl-spec-015 for the full contract.
- §10.2 events catalog grew from 24 to 25: added `stateDisposed`.
- §10.3 handler contract gained a paragraph documenting the deliberate deviation for `stateDisposed` handlers — read-only-during-disposal rule, errors aggregated into `DisposalError`. The deviation is justified on disposal's one-shot terminal nature.
- §11.1 error hierarchy: `DisposedError` and `DisposalError` added as native-Error and AggregateError subclasses respectively (do not extend `ContextLensError` — see cl-spec-015 §7.2 for rationale).
- §12 invariants: the prior "Instance lifecycle" paragraph that asserted "no explicit disposal required" is replaced — long-lived callers must now `dispose()`, short-lived callers may.
- Sections renumbered: Event System §9 → §10, Error Model §10 → §11, Invariants §11 → §12, References §12 → §13. TOC updated. Internal cross-references updated.
- Post-grill addendum (during impl-spec drafting): §9.4 added for the `instanceId` getter (fourth always-valid public surface, alongside `dispose`, `isDisposed`, `isDisposing`). Disposed-state-guard exemption list updated wherever it appears in §1, §9, §11.3, §12.
- Status flipped from `draft (amended)` to `complete`.

**Spec 8 (Eviction Advisory) is draft (amended):** `specs/08-eviction-advisory.md`

Key decisions made in Spec 8:
- Five-signal eviction score: relevance retention (0.30), information loss (0.25), coherence contribution (0.20), importance (0.15), age retention (0.10). Weighted arithmetic mean, not geometric — no single zero forces score to zero.
- Strategy-adjusted weights: saturation (token-focused), erosion (redundancy-focused), gap (relevance-focused), collapse (coherence-preserving). No fracture strategy — fracture's remedy is restructuring, not eviction.
- Auto-selection: compound patterns override priority-based fallback (e.g., fullOfJunk → erosion over saturation). Phase 1 collect, phase 2 compound check, phase 3 priority fallback.
- Protection tier ordering is inviolable: default < priority(n) ascending < seed < pinned (never). Tiers are walls, not weights.
- Seeds: compaction recommended before eviction. Already-compacted seeds go straight to eviction.
- Groups: atomic candidates with token-weighted eviction scores. Overshoot penalty defers large groups (>2x remaining target) in favor of individual candidates when possible.
- Bridge score for coherence impact: avgNeighborSimilarity - skipSimilarity, clamped to [0, 1]. Uses skip-similarity computed on demand during planEviction.
- Compaction recommendations: default 0.5 target compression ratio. Advisory does not generate summaries — caller provides them.
- Collapse strategy: compaction over eviction bias, continuity floor guard (excludes candidates that would deepen collapse past critical threshold).
- Plans are snapshots — no live connection to instance. Caller responsible for replanning after mutations.
- 12 invariants including read-only consumer, deterministic planning, no content access, no LLM calls.

**Spec 9 (Performance Budget) is draft:** `specs/09-performance-budget.md`

Key decisions made in Spec 9:
- OQ-007 resolved: five budget tiers, not one number. Queries <1ms, hot-path mutations <5ms, assessment <50ms, planning <100ms, batch/rare proportional — all at n≤500 excluding provider latency
- Budget scope: context-lens computation only (selfTime). Provider latency (tokenizer, embedding) measured and reported but not budgeted — caller's choice and responsibility
- Two quadratic bottlenecks: topical concentration clustering O(n^2) and density redundancy scanning O(n^2). Managed by sampling at n > 200 and similarity caching
- Sampling: stratified random subset s = ceil(sqrt(n) * 3) for topical concentration; cached-first 30-sample-per-segment for density. Keeps worst-case at O(n^1.5) instead of O(n^2)
- Sampling is deterministic (seed derived from segment set, not wall-clock). Preserves scoring contracts — same formulas, same bounds, same invariants
- Memory dominated by embedding cache: 6–100MB depending on dimensions and cache size. Similarity cache default 16,384 entries (~1.3MB)
- Per-operation timing with selfTime/providerTime decomposition. Budget violations are advisory — reported, never enforced
- 10 invariants including deterministic sampling, cache correctness over performance, bounded memory, O(1) aggregates, measurement overhead negligible

**Spec 10 (Report & Diagnostics) is draft (amended):** `specs/10-report-diagnostics.md`

Key decisions made in Spec 10:
- getDiagnostics() → DiagnosticSnapshot: single-call observability surface, Tier 1 (<1ms), read-only, no computation trigger
- Report history: 20-entry ring buffer of summaries, rolling 5-report trend analysis (direction/averageRate/volatility per dimension), score anomaly detection (>0.15 delta with likely-cause attribution from timeline)
- Pattern history: 50-entry ring buffer with per-pattern lifecycle tracking (activation count, total active time, peak severity, recurrence count), compound context linked; custom patterns tracked identically
- Session timeline: 200-entry ring buffer, 21 event types covering mutations, task changes, pattern transitions, provider changes, budget violations. Ordered by (timestamp, sequence). Correlation backbone for all diagnostics.
- Performance diagnostics: per-operation timing aggregation (count, avg/max/p95 selfTime, budget violations), cache metrics for all three caches (hit rate, utilization, evictions)
- Provider diagnostics: tokenizer + embedding metadata, switch count/history, mismatch detection
- Formatting: formatReport, formatDiagnostics, formatPattern (plain-text, pure functions, no ANSI/color) + toJSON() for JSON output (cl-spec-011 conforming)
- Warning accumulation: 50-entry deduplicated list (provider mismatch, pinned ceiling, late seeding, zero vector, approximate capacity)
- 10 invariants including read-only diagnostics, cheap assembly, snapshot isolation, bounded history, incremental maintenance, diagnostic completeness

**Spec 11 (Report Schema) is draft:** `specs/11-report-schema.md`

Key decisions made in Spec 11:
- OQ-010 resolved: independent schema versioning (semver, decoupled from library version)
- schemaVersion field on all three top-level outputs (QualityReport, DiagnosticSnapshot, EvictionPlan)
- Three self-contained JSON Schema files (draft 2020-12), one per output type, shared types inlined as $defs
- ~35 shared type definitions organized by domain (quality, capacity, detection, task, eviction, diagnostics, provider)
- 10 enum definitions (Severity, PatternName, Trend, TrendDirection, StrategyName, TimelineEventType, TaskLifecycleState, TransitionType, CompoundName, RemediationAction)
- Serialization conventions: timestamps as epoch-ms numbers, enums as strings, null for unavailable/not-applicable/undefined, no circular references, arrays maintain defined ordering
- Additive-only evolution within major version; consumers must ignore unknown fields (forward compatibility)
- Reference implementation ships schema files, static exports, toJSON() utilities, and validation functions
- 10 invariants including schema conformance, version consistency, self-containment, forward compatibility, deterministic serialization

**Spec 14 (Serialization) is complete:** `specs/14-serialization.md`

Key decisions made in Spec 14:
- OQ-012 resolved: one method, one format, one option — `snapshot({ includeContent })` for full or lightweight snapshots
- Full snapshot includes: segments (content + metadata + position), groups, task state, baseline, continuity ledger, pattern tracking state (hysteresis), pattern history, timeline, report history, warnings, config, custom pattern metadata, provider metadata
- NOT serialized: provider instances, caches, computed scores, event handlers, custom pattern functions
- Lightweight snapshot (`includeContent: false`): same format, content null, `restorable: false`, ~10x smaller (~100KB vs ~1.1MB for 500 segments)
- `fromSnapshot(state, config)` static factory: atomic restore, provider change detection, custom pattern matching by name, quality score invalidation on first assess()
- Format versioning: "context-lens-snapshot-v1", independent of schema version, forward+backward compatible
- 10 invariants including snapshot equivalence, round-trip fidelity, atomic restore, content completeness, snapshot governed by lifecycle gates, restored instance is live and independent

Lifecycle amendment (2026-04-29) — cl-spec-015 integration:
- §1 Overview: snapshot-then-dispose-then-fromSnapshot listed as the fourth motivating use case (state-preserving continuation across disposal).
- §3.2 Snapshot Is Read-Only: notes that `snapshot()` is governed by the read-only-during-disposal rule — works during `isDisposing === true`, throws `DisposedError` post-disposal.
- New §3.4 Snapshot-then-dispose continuation: documents the canonical pattern with code example. Snapshot must precede `dispose()`; no recovery path post-disposal.
- §5.5 Restored Instance Behavior expanded with lifecycle-state paragraph: restored instance is always live, has fresh `instanceId`, source's disposal status does not propagate.
- New invariants 9 and 10: snapshot governed by lifecycle gates; restored instance is live and independent.
- Status flipped from `draft` to `complete`.

**Spec 12 (Fleet Monitor) is complete:** `specs/12-fleet-monitor.md`

Key decisions made in Spec 12:
- OQ-011 resolved: fresh assessment by default (`assessFleet()` calls `assess()` on each instance), cached mode opt-in via `{ cached: true }`
- ContextLensFleet class: register/unregister instances by label, assessFleet → FleetReport
- FleetReport: per-instance reports, fleet-wide aggregates (mean/min/max/stddev per dimension), degradation hotspots (sorted by severity), comparative ranking (composite ascending), fleet capacity overview
- Fleet events: instanceDegraded, instanceRecovered, instanceDisposed (added in lifecycle amendment), fleetDegraded (configurable threshold), fleetRecovered
- Fail-open: one failing instance doesn't break fleet assessment
- Read-only consumer: fleet calls assess/getCapacity/getSegmentCount, never mutates instances
- 8 invariants including read-only consumer, instance independence, fail-open assessment, auto-unregister on disposal, disposed-instance rejection at registration

Lifecycle amendment (2026-04-29) — cl-spec-015 integration:
- Fleet declared a lifecycle-aware integration of every registered instance (cl-spec-015 §6).
- New §7 Instance Disposal Handling: teardown callback behavior, constraints inside callback, auto-unregister vs explicit unregister, polling fallback.
- New event `instanceDisposed { label, instanceId, finalReport }` fired during step 3 of an instance's teardown — independent of fleet's cached/fresh mode.
- §3.1 register: documents the lifecycle integration handshake, throws `DisposedError` on already-disposed instances.
- §3.2 unregister: distinguishes explicit unregister (silent) from auto-unregister (emits `instanceDisposed`).
- Sections renumbered: Invariants §7 → §8, References §8 → §9. TOC updated.
- Status flipped from `draft` to `complete`.

**Spec 13 (Observability Export) is complete:** `specs/13-observability-export.md`

Key decisions made in Spec 13:
- ContextLensExporter: optional OTel peer dependency, separate entry point (context-lens/otel), read-only consumer
- 9 gauges (quality dimensions, utilization, segment count, headroom, pattern count), 6 counters (evictions, compactions, restorations, pattern activations, assessments, task changes), 1 histogram (assess duration)
- 6 OTel log event types: pattern activated/resolved, task changed, capacity warning, budget violation, instance disposed (added in lifecycle amendment)
- Common attributes: window label, tokenizer name, embedding mode
- Push on assess: metrics updated inline on each assess() via event subscription, no polling
- Convention-based naming: `context_lens.*` prefix, OTel semantic conventions
- 9 invariants including read-only consumer, optional dependency, metric naming stability, auto-disconnect on instance disposal, disposed-instance rejection at construction, at-most-once final flush

Lifecycle amendment (2026-04-29) — cl-spec-015 integration:
- Exporter declared a lifecycle-aware integration of the monitored instance (cl-spec-015 §6).
- §2.1 Lifecycle expanded with two subsections: §2.1.1 Explicit disconnect (`disconnect()`), §2.1.2 Auto-disconnect on instance disposal (teardown callback during step 3 of `dispose()`).
- New event `context_lens.instance.disposed` added to §4.1 with attributes `instance.id`, `instance.final_composite`, `instance.final_utilization`.
- Recommended pattern documented: do the final-signal flush in the step-3 callback, not in a `stateDisposed` step-2 handler — avoids duplicate flush.
- Status flipped from `draft` to `complete`.

**Spec 15 (Instance Lifecycle) is complete (post-grill):** `specs/15-instance-lifecycle.md`

Key decisions made in Spec 15:
- Two-state lifecycle: live and disposed. No intermediate state, no reactivation, no reset. Callers needing state preservation use `snapshot()` (cl-spec-014) before disposal and `fromSnapshot()` after — original instance does not return.
- `dispose(): void` added: parameterless, fully synchronous, idempotent. Reentrant calls during teardown return immediately via internal disposing flag. `isDisposed` getter added — never throws, flips precisely when dispose() returns successfully; canonical state probe.
- Six-step teardown in fixed order: set disposing flag → emit stateDisposed → notify external integrations → clear owned resources → detach handler registry → set disposed flag. Step 6 is the single commit point. Total order uniquely determined by adjacency constraints (handlers receive event over still-attached registry; integrations read live state before resources clear; disposed flag flips last).
- Atomicity: live → disposed is atomic with respect to caller observation. Library-internal steps (1, 4, 5, 6) infallible by construction. Retry contract specified for any future fallible internal step — completed prefix must be no-op-on-rerun or reversible, failure must abort strictly before step 6.
- Caller-supplied callback errors (stateDisposed handlers in step 2, integration teardown callbacks in step 3) caught, aggregated into a per-call disposal error log, surfaced as a single `DisposalError` after step 6. Never abort teardown — disposal completes regardless of how many callbacks throw.
- `stateDisposed` event added to cl-spec-007 §9 catalog. Emitted exactly once per instance during step 2 — last event the instance ever emits. Payload: `{ type, instanceId, timestamp }`, frozen and shared across handlers.
- Two new error types: `DisposedError` (extends Error; raised on every public method except dispose/isDisposed post-disposal; synchronous, before any side effect; carries instanceId + attemptedMethod) and `DisposalError` (extends AggregateError; raised at most once per instance, only when callbacks errored during disposal; instance is fully disposed when raised).
- Lifecycle-aware integrations (fleets cl-spec-012, OTel exporters cl-spec-013) receive teardown callback in step 3 with `isDisposed === false` and full read access to live state. Must drop back-reference, detach own handlers, complete deferred work (final aggregated report, final OTel signal flush); must not mutate, re-attach, or throw to abort.
- Providers (tokenizer cl-spec-006, embedder cl-spec-005) are caller-managed — not notified by `dispose()`, not part of step 3. Synchronous `dispose()` deliberately excludes async provider hooks. Recommended pattern: `dispose()` first (releases library's references so no library code can re-invoke a provider), then await provider shutdowns.
- Supersedes the "no explicit disposal" invariant from cl-spec-007 §11. Long-lived callers (monitoring daemons, multi-agent orchestrators, server processes handling rolling contexts) must dispose; short-lived may dispose to release resources earlier than GC. Retained metadata after disposal is constant-sized (just a flag + instanceId for DisposedError messages) — does not grow with pre-disposal state.
- 15 numbered invariants covering state machine, dispose contract, teardown atomicity, post-disposal access, events and errors, integrations/providers, and stable identity (`instanceId`).

Grill outcomes (2026-04-29) — three decisions applied to the spec; status flipped to `complete`:
- **GD-01: Read-only-during-disposal rule.** Resolved §3.4 vs §6.2 asymmetry. Between step 1 and step 6, read-only methods behave per live spec; mutating methods throw `DisposedError`. Same rule applies uniformly to step-2 handlers and step-3 integration callbacks. The wrong "caches non-deterministic" rationale in §3.4 was replaced.
- **GD-02: `isDisposing` getter added.** Sibling to `isDisposed`. True while `dispose()` is on the stack, false otherwise. Mutually exclusive with `isDisposed`. Lifecycle graph stays two-state — `isDisposing` is a transient observable, not a third state. Library-internal mutation gate now fires on `isDisposing || isDisposed`.
- **GD-03: Unsubscribe handle no-op rejustified.** Closure pattern verified in cl-spec-007 §9.1 (`on()` returns `Unsubscribe`). Old "not a public method" rationale dropped; replaced with "intrinsically idempotent contract" framing — disposal makes the handler not-present, so the no-op branch fires by construction.
- Friction #4 also resolved: documented the deviation from cl-spec-007 §9.3's general handler contract (mutations throw vs undefined behavior; handler errors aggregated via `DisposalError` vs swallowed-and-logged) in §3.4 and §4.3.
- Post-grill addendum (during impl-spec drafting): `instanceId: string` added as a fourth always-valid public surface. Generated once at construction, returned unchanged across live/disposing/disposed states, never throws. Same value as the `stateDisposed` event payload, `DisposedError.instanceId`, and integration teardown notifications. Canonical correlation key for cross-system telemetry. Documented in cl-spec-015 §2.5 and Invariant 15, and in cl-spec-007 §9.4. Adds one slot to the disposed-state-guard exemption list across both specs.
- `revised:` frontmatter updated to 2026-04-29.

## Current state

**v0.1.0 shipped to npm 2026-04-09. v0.2.0 Phase 6 (instance lifecycle / `dispose()`) complete and merged into `dev` 2026-04-30. Active branch `feat/v0.2-hardening` carries the remaining v0.2.0 hardening backlog. Gaps 1 (concurrency, spec-only) and 4 (OTel re-attach) shipped 2026-05-01. 4 open gaps remain (Gap 3, 5, 6, 8); Gap 7 deferred to v0.3.0. Test floor 1116 → 1127.**

v0.1.0 baseline:
- 33/33 build tasks done across 5 phases (~10,200 source LOC, ~15,500 test LOC)
- 977 tests passing across 36 test files + 12 performance benchmarks; all typechecks clean
- Published as `@madahub/context-lens` on npm

v0.2.0 Phase 6 (delivered, merged into `dev` via merge commit `0c35bf5`):
- cl-spec-015 (Instance Lifecycle) added; cl-spec-005/006/007/012/013/014 amended for cross-cutting integration
- 17 build tasks (T1–T17) completed on `feat/dispose-lifecycle`; branch preserved on origin for archaeology
- Net surface additions: `dispose()`, `isDisposed`/`isDisposing` getters, stable `instanceId` (cl-N-xxxxxx format), `stateDisposed` event (catalog 24 → 25), `DisposedError` (extends Error) + `DisposalError` (extends AggregateError); fleet `instanceDisposed` event with auto-unregister; OTel `context_lens.instance.disposed` log event with auto-disconnect; snapshot-then-dispose-then-fromSnapshot continuation pattern documented
- Internal: `lifecycle.ts` module (IntegrationRegistry, READ_ONLY_METHODS audited at 20 names, guardDispose, runTeardown six-step orchestrator); 38 disposed-state guards on the public surface (~100 ns live-path overhead per call, microbenchmarked)
- Test growth: 977 → 1116 (+139). Files: 36 → 39. Benchmarks: 12 → 16 cases. Hard floor (977) held at every commit.
- Bench results: dispose-empty 9.7 µs (target <0.5 ms ✓), guardDispose ~100 ns (target <100 ns ✓), dispose-500 ~450 ms dominated by construction (vitest bench can't separate setup from timed body; documented as regression sentinel)

Key Phase 6 implementation decisions (recorded in `IMPL_JOURNAL.md` per-task notes):
- **Lifecycle types in `types.ts` (T5).** Deviation from impl-spec §4.1.1 to satisfy the §3 dependency direction (fleet/otel must import lifecycle types without importing `lifecycle.ts`).
- **Generic `IntegrationRegistry<T>` (T5).** So `lifecycle.ts` doesn't import `ContextLens`. `index.ts` instantiates `new IntegrationRegistry<ContextLens>()`.
- **Flag-based detach (T5).** `invokeAll` skips entries with `detached: true`. Detach is O(1); registry is safe against detach-during-iteration.
- **READ_ONLY_METHODS audited to 20 names (T6).** 12 from cl-spec-015 §3.4 + reconciled `getEvictionHistory → getEvictedSegments` + 7 audit-added (`getTokenizerInfo`, `getEmbeddingProviderInfo`, `getBaseline`, `getConstructionTimestamp`, `getConfig`, `getPerformance`, `getDetection`).
- **`tagOrigin(error, origin, index)` signature (T3).** Explicit index parameter; orchestrator (T7) tracks index externally via `errorLog.length` deltas before/after each `emitCollect` and `invokeAll`.
- **`instanceId` is `public readonly` (T9).** Impl-spec §4.4.1 example said `private readonly` but §4.7 ("fourth always-valid public surface") wins. Format: `cl-${++INSTANCE_COUNTER}-${Math.random().toString(36).slice(2, 8)}`.
- **`clearResources` closure scope (T11)** = exactly the impl-spec §4.4.4 list (six audited modules from T8 + `cachedReport`/`qualityCacheValid` resets); deliberately NOT `taskManager`/`detection`/`perf`/`baseline`/`evictionAdvisory`/`reportAssembler` — they're unreachable post-disposal anyway.
- **Property test confirms cl-spec-015 GD-02 mutual exclusion empirically.** `(isDisposed && isDisposing)` is observed at four points per run (before dispose, inside `stateDisposed` handler, inside integration teardown callback, after dispose) — never true at any point.

v0.2.0 hardening backlog (drafted on `feat/v0.2-hardening`, commit `f32822f`):
- `V0_2_0_BACKLOG.md` — actionable plan covering the remaining 7 gaps from `V0_2_0_DESIGN_STRATEGY.md`
- Gap 2 (dispose) — done (Phase 6). Gap 1 (concurrency) — **done 2026-05-01** (spec-only amendment to `cl-spec-007` §12 + cross-refs in `cl-spec-005`/`006`/`012`). Gap 4 (OTel re-attach) — **done 2026-05-01** (`cl-spec-013` §2.1.3 + Invariants 10/11; `impl/I-07-otel-reattach.md`; `ContextLensExporter.attach()` + gauge management refactor; 9 unit + 2 integration tests). Gaps 3, 5, 6, 8 — open. Gap 7 (provider resilience) — deferred to v0.3.0
- Decision locks confirmed 2026-05-01: read-read overlap not permitted (Gap 1, applied); mutable exporter binding (Gap 4, applied); no multi-instance fan-in on exporter (Gap 4, applied); Gap 5 option (b) incremental similarity cache picked, with (a) tighter sampling as fallback above N; estimate `getMemoryUsage` (Gap 6); `setCacheSize(kind, 0)` permitted (Gap 6); runtime statement-now-CI-later split (Gap 8)
- Recommended next sequence (post-Gap-4): Gap 6 (memory release) → Gap 3 (fleet serialization) → Gap 5 (assess@500 perf, new `cl-spec-016`) → Gap 8 (runtime compat statement)
- Total remaining scope (4 open gaps): ~25–35 commits, ~17–25 build tasks, ~30–55 new tests, 4 spec amendments + 1 new spec (`cl-spec-016` for Gap 5 option b), 3 new impl specs

### What's built

| Phase | Status | Modules |
|-------|--------|---------|
| 1 — Foundation | **Complete** | types, errors, events, utils (hash, LRU, ring buffer, copy), segment-store, tokenizer |
| 2 — Scoring Engine | **Complete** | similarity, embedding, task, coherence/density/relevance/continuity scorers, baseline, composite, quality-report |
| 3 — Detection & Advisory | **Complete** | detection (5 patterns, hysteresis, compounds, custom registration, fail-open, history), eviction (5-signal ranking, tiers, strategies, compaction), performance (timing, budgets, sampling) |
| 4 — Public API & Diagnostics | **Complete** | ContextLens class (constructor, 8 segment ops, 4 group ops, task ops, assess, planEviction, provider mgmt, capacity), diagnostics (history, trends, timeline, warnings), formatters (3 pure functions) |
| 5 — Enrichments | **Complete** | schemas (JSON Schema draft 2020-12, toJSON, validate), serialization (snapshot/fromSnapshot, format versioning, provider change detection), fleet (ContextLensFleet, assessFleet, aggregation, fleet events), OTel (ContextLensExporter, 9 gauges, 6 counters, 1 histogram, 5 log events) |
| 6 — Instance Lifecycle (v0.2.0) | **Complete (T1–T17)** | `lifecycle.ts` (IntegrationRegistry, READ_ONLY_METHODS, guardDispose, runTeardown), `errors.ts` (DisposedError + DisposalError + tagOrigin/isHandlerOriginTag helpers), `events.ts` (stateDisposed event → 25 events, emitCollect, removeAllListeners), `types.ts` (Lifecycle Domain), internal `clear()` shims (tokenizer, continuity, diagnostics, segment-store), `index.ts` (instanceId, isDisposed, isDisposing, attachIntegration, dispose() body, 38 guards), fleet auto-unregister with instanceDisposed event, OTel auto-disconnect with context_lens.instance.disposed log event |

### Test coverage

Phase 5 exit (v0.1.0 baseline): **977 tests** across 36 test files + 12 benchmarks.

Phase 6 exit (v0.2.0 dispose, merged into `dev` 2026-04-30): **1116 tests** across 39 test files + 16 benchmark cases. Net additions in Phase 6: new `test/unit/lifecycle.test.ts` (41 cases), new `test/integration/lifecycle.test.ts` (15 flows from impl-spec §5), new `test/property/lifecycle.test.ts` (4 fast-check properties + 3 sanity checks), new `test/bench/lifecycle.bench.ts` (4 cases — `dispose-empty`, `dispose-500`, two `guardDispose` variants); +15 in `errors.test.ts`, +21 in `events.test.ts`, +29 in `context-lens.test.ts`, +10 in `fleet.test.ts`, +8 in `otel.test.ts`, +10 across `tokenizer`/`continuity`/`diagnostics`/`segment-store`. Hard floor (977) held at every commit through T11–T17.

### Key architecture decisions made during implementation

- SegmentStore handles validation, protection checks, atomicity, token counting, and event emission internally — ContextLens is a thin orchestration layer adding embedding prep, continuity tracking, baseline capture, cache invalidation, and defensive copies
- Detection engine records PatternHistoryEntry events internally; ContextLens reads the history diff after each detect() to fire public pattern events
- Diagnostics module subscribes to the event emitter at construction and maintains state incrementally — getDiagnostics() is pure assembly, no recomputation
- Quality cache uses dual invalidation: outer `qualityCacheValid` flag + inner `reportAssembler.invalidate()`, both called on every mutation
- All async methods: setTask (embeds descriptor), setEmbeddingProvider (re-embeds all segments). Everything else is synchronous
- Fleet module (`fleet.ts`) defines its own `FleetEventMap` and uses the shared `EventEmitter` class. Read-only consumer of `ContextLens` public API
- OTel module (`otel.ts`) defines minimal structural-typing interfaces for `@opentelemetry/api` types, avoiding tight coupling to specific OTel versions
- Schema module (`schemas/`) builds JSON Schema objects programmatically using shared `$defs`. The `validate.ts` implements a lightweight JSON Schema draft 2020-12 subset validator with zero dependencies

### Known issues

| Issue | Severity | Notes |
|-------|----------|-------|
| Baseline not wired | Low | `BaselineManager.notifyAdd()` never called from `captureBaseline()`. Scores work correctly without it (raw scores used). Fix before v0.1.0. |
| assess@500 over budget | Low | O(n^2) similarity at 500 segments takes ~300ms vs 50ms budget. Sampling mitigates in practice. v0.2.0 hardening backlog Gap 5. |

## What's next

**Resume on `feat/v0.2-hardening` (origin/feat/v0.2-hardening). Open `V0_2_0_BACKLOG.md` for the canonical plan with per-gap scope, decision locks, and commit estimates.**

Active branch state: `feat/v0.2-hardening` is 6 commits ahead of `dev` — `f32822f` (backlog plan), `a350538` (Gap 1 spec amendment), `6ccdbd2` (Gap 4 spec amendment), `ce8e1b9` (Gap 4 impl spec `I-07`), `22e0123` (Gap 4 code: `attach()` + gauge refactor), `069cf01` (Gap 4 tests). Plus the upcoming tracking-sync commit. `dev` carries Phase 6 (merge `0c35bf5`) plus the 4 post-v0.1.0 chore commits previously only on `main`. `main` unchanged. `feat/dispose-lifecycle` preserved on origin for archaeology.

**All 8 decision locks confirmed 2026-05-01.** Locks for Gaps 1 and 4 are applied (those gaps shipped). Locks for Gaps 5, 6, 8 are confirmed and ready. No remaining decisions block spec work on the open gaps.

**Recommended next task on this branch:** Gap 6 (memory release — `clearCaches`/`setCacheSize`/`getMemoryUsage` on `ContextLens`, `cachesCleared` event). Spec amendments to `cl-spec-005`/`006`/`007`/`009`; ~5–7 build tasks. Then sequence: Gap 3 (fleet serialization) → Gap 5 (assess@500 perf, new `cl-spec-016` for option (b) incremental similarity cache) → Gap 8 (runtime compat statement, single paragraph).

Each gap follows the spec-driven workflow: design spec or amendment → impl spec → coding tasks → regression sweep → commit cadence (one task = one commit, clean tree between each, hard floor now 1127 tests).

See `SHIPPING.md` for the v0.2.0 / v0.3.0 release plan (revised 2026-04-30 to reflect Phase 6 completion and the bundle-vs-cut decision).

## Design review history

### Review progress

**Phase 1 — Internal Consistency (Pass 1): COMPLETE (2026-04-05)**

All 14 specs reviewed for internal consistency (section references, table/prose agreement, invariant numbering, TOC, frontmatter). ~100 findings identified and fixed across 7 batches in dependency order. Key resolutions:

- **7 blockers resolved:** protectionRelevance formula rewritten (spec 02), serialization carve-outs added to specs 03/04, setTask returns TaskTransition (spec 04→07 reconciled), saturation eviction weights fixed to sum to 1.0 (spec 08), TransitionType unified to 5-value enum, TaskLifecycleState standardized to lowercase
- **TaskState reconciled:** canonical 14-field type adopted across specs 04, 07, 11. Field names harmonized (`currentTask`, `previousTask`, `gracePeriodActive`, `gracePeriodRemaining`, `transitionHistory`, `lastTransition`, `stale`)
- **QualityReport expanded:** field renamed to `continuity` (not `continuityLedger`), four fields added to spec 02 (`rawScores`, `embeddingMode`, `patterns`, `task`)
- **API catalog completed:** `getDiagnostics`, `planEviction`, formatting utilities added to spec 07. Two new events (`reportGenerated`, `budgetViolation`) added. API categories updated from 7 to 11.
- **Timeline reconciled:** 5 missing event types added to specs 10/11. Timeline documented as superset of API events.
- **14 wrong section references corrected** (spec 08 renumbering after §5.3 amendment, spec 04→01 refs)
- **All frontmatter statuses updated** (specs 01–06 now `complete`, amended specs annotated)

Findings and details: `REVIEW_FINDINGS.md`

**Phase 2 — Cross-Cutting Analysis (Passes 2–5): COMPLETE (2026-04-05)**

Four sweeps executed across 14 specs. 26 findings (R-165 through R-190). Key results:

- **1 blocker found:** recency/age formulas use wall-clock time while invariants claim determinism (R-177). Proposed fix: use `report.timestamp` instead of `current time`.
- **32 types verified consistent** across defining and consuming specs. Only field-level issues: Segment/Group `state` fields missing from spec 01 core tables (R-170, R-172), and number/integer convention drift (R-174/R-175).
- **5 invariant chains traced:** Determinism chain breaks at recency formulas. Atomic-vs-fail-open compatible. Read-only consumers compatible under narrow definition (needs explicit wording). Snapshot isolation fully compatible. Performance budget + custom patterns need timing carve-out.
- **API surface 12/12 checks pass.** All public operations, 24 events, 13 error types present in spec 07.
- **5 coverage gaps documented:** no instance disposal, concurrency undefined, memory release unguided, fleet serialization unsupported, OTel exporter not re-attached after restore.
- **4 decisions resolved:** recency uses assessmentTimestamp, customPatternTime added as third timing category, read-only consumer definition standardized, number/integer convention noted in spec 11.

**Phase 3 — Deliverables: COMPLETE (2026-04-05)**

- 32 amendments applied across 12 specs in dependency order
- Type reconciliation table: 36 types, 7 reconciled, 29 verified consistent, 0 remaining discrepancies
- All blockers resolved (8 total across Phases 1–2). All types reconciled. API surface complete. Invariant chains verified.
- **Sign-off: the design spec corpus is internally consistent and ready for implementation spec writing.**

**Findings and details:** `REVIEW_FINDINGS.md` — all findings across Phases 1–3 with resolutions, amendment log, type reconciliation table, and sign-off.

### Implementation specs

**Implementation specs: COMPLETE (2026-04-06)**

5 documents, 2,161 lines total, covering 5 build phases and ~30 modules:

- `IMPLEMENTATION.md` — strategy document (tech stack: TypeScript/tsup/vitest, single package with sub-path exports, zero runtime deps for core) + Phase 1 inline (foundation: types, errors, events, utils, segment-store, tokenizer)
- `impl/I-02-scoring-engine.md` — Phase 2: similarity engine, embedding subsystem, task identity, 4 dimension scorers, baseline, composite, quality report assembly (10 modules, most complex phase)
- `impl/I-03-detection-advisory.md` — Phase 3: detection framework (5 base patterns, 6 compounds, custom registration), eviction advisory (5-signal ranking, 4 strategies), performance instrumentation (3 modules)
- `impl/I-04-api-integration.md` — Phase 4: ContextLens class (integration layer), diagnostics, formatters (3 modules)
- `impl/I-05-enrichments.md` — Phase 5: JSON Schema, serialization, fleet monitor, OTel export (4 modules, all optional)
- `impl/I-06-lifecycle.md` — Phase 6 (v0.2.0): `dispose()`, `isDisposed`/`isDisposing`, `stateDisposed` event, `DisposedError`/`DisposalError`, `IntegrationRegistry`, fleet auto-unregister, OTel auto-disconnect. New module `lifecycle.ts` plus modifications to `errors`, `events`, `index`, `fleet`, `otel`.

Key technology decisions: TypeScript strict mode, tsup for ESM+CJS dual build, vitest + fast-check for testing (unit, integration, property-based, benchmarks), `@opentelemetry/api` as sole peer dep (OTel entry point only).

## Files to read on pickup

Resuming v0.2.0 hardening on `feat/v0.2-hardening`:

1. `V0_2_0_BACKLOG.md` — **canonical post-Phase-6 plan** for the remaining 7 v0.2.0 gaps. Read this first. Contains per-gap scope, decision locks, dependency order, and commit estimates.
2. `V0_2_0_DESIGN_STRATEGY.md` — the original 8-gap design analysis (2026-04 draft) that the backlog supersedes for sequencing. Useful for the deeper rationale on each gap and for the "Open questions" subsections per gap.
3. `IMPL_JOURNAL.md` — Phase 6 task tracker (T1–T17 all done). Read for per-task notes, deviations, decision rationale, and commit hashes — useful when the v0.2 hardening work touches modules Phase 6 introduced.
4. `SHIPPING.md` — v0.2.0 release plan, revised 2026-04-30. Currently flags the bundle-vs-cut question (ship dispose alone as v0.2.0 vs. bundle the rest); user picked bundle.
5. `CHANGELOG.md` — v0.2.0 entry (above the v0.1.0 entry) lists every Phase 6 surface addition.

Branch and remote state:
- `feat/v0.2-hardening` (active) — 1 commit ahead of `dev` (the backlog plan `f32822f`)
- `dev` — Phase 6 merged via `0c35bf5`; pushed to origin
- `feat/dispose-lifecycle` — preserved on origin for archaeology (final commit `b565e3a`)
- `main` unchanged (`614089c`)

Phase 6 reference (everything that landed):
- `specs/15-instance-lifecycle.md` — design spec; source of truth for behavior
- `impl/I-06-lifecycle.md` — Phase 6 build plan (570 lines, amended in T2 + T6 with `emitCollect` contract and audited 20-name READ_ONLY_METHODS set)
- `src/lifecycle.ts` — IntegrationRegistry, READ_ONLY_METHODS, guardDispose, runTeardown
- `src/errors.ts` — DisposedError, DisposalError, tagOrigin/isHandlerOriginTag
- `src/events.ts` — stateDisposed event, emitCollect, removeAllListeners
- `src/index.ts` — dispose() body, instanceId, isDisposed/isDisposing getters, attachIntegration, 38 guards on the public surface
- `src/fleet.ts` — register handshake, unregister handle detach, handleInstanceDisposal callback, instanceDisposed event
- `src/otel.ts` — constructor handshake, disconnect refactor, handleInstanceDisposal with context_lens.instance.disposed log

Specs/design references (authoritative behavioral source):
- `specs/01-segment-model.md` through `specs/15-instance-lifecycle.md` — design specs
- `specs/README.md` — index + the original "Open questions and known gaps" list that drove `V0_2_0_DESIGN_STRATEGY.md`
- `IMPLEMENTATION.md` — strategy document; §5 Phase 6 row marked complete
- `impl/I-02-scoring-engine.md` through `impl/I-06-lifecycle.md` — per-phase impl specs

**Archived:** `REVIEW.md` and `REVIEW_FINDINGS.md` exported to `../archive/context-lens-REVIEW.md` and `../archive/context-lens-REVIEW_FINDINGS.md`
**Removed:** `IMPL_JOURNAL.md` (build tracker, superseded — all 33 tasks done) and `TEST_STRATEGY.md` (testing uplift plan, superseded — all 5 phases complete)
