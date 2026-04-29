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
- 10 invariants including single provider, mode consistency, fallback always available, lifecycle-synchronous embedding.

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
- New §9 "Lifecycle" section added (between Capacity/Inspection and Event System). Documents `dispose()`, `isDisposed`, `isDisposing` with cross-references to cl-spec-015 for the full contract.
- §10.2 events catalog grew from 24 to 25: added `stateDisposed`.
- §10.3 handler contract gained a paragraph documenting the deliberate deviation for `stateDisposed` handlers — read-only-during-disposal rule, errors aggregated into `DisposalError`. The deviation is justified on disposal's one-shot terminal nature.
- §11.1 error hierarchy: `DisposedError` and `DisposalError` added as native-Error and AggregateError subclasses respectively (do not extend `ContextLensError` — see cl-spec-015 §7.2 for rationale).
- §12 invariants: the prior "Instance lifecycle" paragraph that asserted "no explicit disposal required" is replaced — long-lived callers must now `dispose()`, short-lived callers may.
- Sections renumbered: Event System §9 → §10, Error Model §10 → §11, Invariants §11 → §12, References §12 → §13. TOC updated. Internal cross-references updated.
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

**Spec 14 (Serialization) is draft:** `specs/14-serialization.md`

Key decisions made in Spec 14:
- OQ-012 resolved: one method, one format, one option — `snapshot({ includeContent })` for full or lightweight snapshots
- Full snapshot includes: segments (content + metadata + position), groups, task state, baseline, continuity ledger, pattern tracking state (hysteresis), pattern history, timeline, report history, warnings, config, custom pattern metadata, provider metadata
- NOT serialized: provider instances, caches, computed scores, event handlers, custom pattern functions
- Lightweight snapshot (`includeContent: false`): same format, content null, `restorable: false`, ~10x smaller (~100KB vs ~1.1MB for 500 segments)
- `fromSnapshot(state, config)` static factory: atomic restore, provider change detection, custom pattern matching by name, quality score invalidation on first assess()
- Format versioning: "context-lens-snapshot-v1", independent of schema version, forward+backward compatible
- 8 invariants including snapshot equivalence, round-trip fidelity, atomic restore, content completeness

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

**Spec 13 (Observability Export) is draft:** `specs/13-observability-export.md`

Key decisions made in Spec 13:
- ContextLensExporter: optional OTel peer dependency, separate entry point (context-lens/otel), read-only consumer
- 9 gauges (quality dimensions, utilization, segment count, headroom, pattern count), 6 counters (evictions, compactions, restorations, pattern activations, assessments, task changes), 1 histogram (assess duration)
- 5 OTel log event types: pattern activated/resolved, task changed, capacity warning, budget violation
- Common attributes: window label, tokenizer name, embedding mode
- Push on assess: metrics updated inline on each assess() via event subscription, no polling
- Convention-based naming: `context_lens.*` prefix, OTel semantic conventions
- 6 invariants including read-only consumer, optional dependency, metric naming stability

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
- 14 numbered invariants covering state machine, dispose contract, teardown atomicity, post-disposal access, events and errors, and integrations/providers.

Grill outcomes (2026-04-29) — three decisions applied to the spec; status flipped to `complete`:
- **GD-01: Read-only-during-disposal rule.** Resolved §3.4 vs §6.2 asymmetry. Between step 1 and step 6, read-only methods behave per live spec; mutating methods throw `DisposedError`. Same rule applies uniformly to step-2 handlers and step-3 integration callbacks. The wrong "caches non-deterministic" rationale in §3.4 was replaced.
- **GD-02: `isDisposing` getter added.** Sibling to `isDisposed`. True while `dispose()` is on the stack, false otherwise. Mutually exclusive with `isDisposed`. Lifecycle graph stays two-state — `isDisposing` is a transient observable, not a third state. Library-internal mutation gate now fires on `isDisposing || isDisposed`.
- **GD-03: Unsubscribe handle no-op rejustified.** Closure pattern verified in cl-spec-007 §9.1 (`on()` returns `Unsubscribe`). Old "not a public method" rationale dropped; replaced with "intrinsically idempotent contract" framing — disposal makes the handler not-present, so the no-op branch fires by construction.
- Friction #4 also resolved: documented the deviation from cl-spec-007 §9.3's general handler contract (mutations throw vs undefined behavior; handler errors aggregated via `DisposalError` vs swallowed-and-logged) in §3.4 and §4.3.
- `revised:` frontmatter updated to 2026-04-29.

## Current state

**Implementation and testing complete. Ready for packaging and v0.1.0 publish.**

- 33/33 build tasks done across 5 phases
- 977 tests passing across 36 test files + 12 performance benchmarks
- All typechecks clean
- Report assembler cache bug fixed (was not invalidating on segment mutations)
- ~10,200 source LOC, ~15,500 test LOC

### What's built

| Phase | Status | Modules |
|-------|--------|---------|
| 1 — Foundation | **Complete** | types, errors, events, utils (hash, LRU, ring buffer, copy), segment-store, tokenizer |
| 2 — Scoring Engine | **Complete** | similarity, embedding, task, coherence/density/relevance/continuity scorers, baseline, composite, quality-report |
| 3 — Detection & Advisory | **Complete** | detection (5 patterns, hysteresis, compounds, custom registration, fail-open, history), eviction (5-signal ranking, tiers, strategies, compaction), performance (timing, budgets, sampling) |
| 4 — Public API & Diagnostics | **Complete** | ContextLens class (constructor, 8 segment ops, 4 group ops, task ops, assess, planEviction, provider mgmt, capacity), diagnostics (history, trends, timeline, warnings), formatters (3 pure functions) |
| 5 — Enrichments | **Complete** | schemas (JSON Schema draft 2020-12, toJSON, validate), serialization (snapshot/fromSnapshot, format versioning, provider change detection), fleet (ContextLensFleet, assessFleet, aggregation, fleet events), OTel (ContextLensExporter, 9 gauges, 6 counters, 1 histogram, 5 log events) |

### Test coverage

| Layer | Files | Tests |
|-------|------:|------:|
| Unit | 23 | 758 |
| Integration | 2 | 21 |
| End-to-end | 1 | 7 |
| Property-based | 5 | 60 |
| Benchmarks | 1 | 12 |

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
| assess@500 over budget | Low | O(n^2) similarity at 500 segments takes ~300ms vs 50ms budget. Sampling mitigates in practice. |
| No dispose method | Info | Event handlers and caches persist until GC. Design spec drafted (cl-spec-015); implementation pending for v0.2.0. |

## What's next

**Shipping.** See `SHIPPING.md` for the full pre-publish checklist, known issues, and release plan (v0.1.0 through v0.3.0).

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

Key technology decisions: TypeScript strict mode, tsup for ESM+CJS dual build, vitest + fast-check for testing (unit, integration, property-based, benchmarks), `@opentelemetry/api` as sole peer dep (OTel entry point only).

## Files to read on pickup

1. `SHIPPING.md` — pre-publish checklist, known issues, release plan (v0.1.0–v0.3.0)
2. `IMPLEMENTATION.md` — implementation strategy, tech stack, package structure, dependency graph, Phase 1 inline
3. `impl/I-02-scoring-engine.md` through `impl/I-05-enrichments.md` — per-phase implementation specs
4. `specs/01-segment-model.md` through `specs/14-serialization.md` — 14 design specs (authoritative behavioral reference)

**Archived:** `REVIEW.md` and `REVIEW_FINDINGS.md` exported to `../archive/context-lens-REVIEW.md` and `../archive/context-lens-REVIEW_FINDINGS.md`
**Removed:** `IMPL_JOURNAL.md` (build tracker, superseded — all 33 tasks done) and `TEST_STRATEGY.md` (testing uplift plan, superseded — all 5 phases complete)
