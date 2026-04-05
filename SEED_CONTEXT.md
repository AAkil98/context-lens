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

**Spec 7 (API Surface) is draft (amended, minor amendment remaining):** `specs/07-api-surface.md`

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

**Spec 12 (Fleet Monitor) is draft:** `specs/12-fleet-monitor.md`

Key decisions made in Spec 12:
- OQ-011 resolved: fresh assessment by default (`assessFleet()` calls `assess()` on each instance), cached mode opt-in via `{ cached: true }`
- ContextLensFleet class: register/unregister instances by label, assessFleet → FleetReport
- FleetReport: per-instance reports, fleet-wide aggregates (mean/min/max/stddev per dimension), degradation hotspots (sorted by severity), comparative ranking (composite ascending), fleet capacity overview
- Fleet events: instanceDegraded, instanceRecovered, fleetDegraded (configurable threshold), fleetRecovered
- Fail-open: one failing instance doesn't break fleet assessment
- Read-only consumer: fleet calls assess/getCapacity/getSegmentCount, never mutates instances
- 6 invariants including read-only consumer, instance independence, fail-open assessment

**Spec 13 (Observability Export) is draft:** `specs/13-observability-export.md`

Key decisions made in Spec 13:
- ContextLensExporter: optional OTel peer dependency, separate entry point (context-lens/otel), read-only consumer
- 9 gauges (quality dimensions, utilization, segment count, headroom, pattern count), 6 counters (evictions, compactions, restorations, pattern activations, assessments, task changes), 1 histogram (assess duration)
- 5 OTel log event types: pattern activated/resolved, task changed, capacity warning, budget violation
- Common attributes: window label, tokenizer name, embedding mode
- Push on assess: metrics updated inline on each assess() via event subscription, no polling
- Convention-based naming: `context_lens.*` prefix, OTel semantic conventions
- 6 invariants including read-only consumer, optional dependency, metric naming stability

## What's next

**Design spec review is COMPLETE. All 14 specs reviewed, reconciled, and amended. Ready for implementation specs.**

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

## Files to read on pickup

1. `REVIEW.md` — review guide with execution plan, spec inventory, dependency graph, architectural decisions, session log
2. `REVIEW_FINDINGS.md` — all findings (Phases 1–3) with resolutions, amendment log, type reconciliation table, sign-off
3. `specs/01-segment-model.md` — completed Spec 1 (the foundation)
3. `specs/06-tokenization-strategy.md` — completed Spec 6 (token counting, provider abstraction, caching)
4. `specs/02-quality-model.md` — completed Spec 2 (four quality dimensions, scoring mechanics, baseline, reports)
5. `specs/03-degradation-patterns.md` — completed Spec 3, amended (five degradation patterns, detection framework, pattern interactions, custom pattern registration §10)
6. `specs/04-task-identity.md` — completed Spec 4 (task descriptor model, lifecycle, transitions, preparation, integration, invariants)
7. `specs/05-embedding-strategy.md` — completed Spec 5 (embedding provider abstraction, caching, fallback)
8. `specs/07-api-surface.md` — draft Spec 7, amended (public API, constructor, all operations, events, errors, registerPattern, snapshot/fromSnapshot, toJSON/schemas/validate)
9. `specs/08-eviction-advisory.md` — draft Spec 8, amended (eviction ranking, strategies, group handling, custom pattern strategyHint)
10. `specs/09-performance-budget.md` — draft Spec 9 (budget tiers, complexity analysis, sampling strategies, memory budget, provider separation, measurement)
11. `specs/10-report-diagnostics.md` — draft Spec 10, amended (diagnostic snapshot, report history, pattern history, session timeline, custom pattern accommodation §4.4, JSON formatting §8.4)
12. `specs/11-report-schema.md` — draft Spec 11 (JSON Schema for all output types, schema versioning, serialization conventions, validation)
13. `specs/12-fleet-monitor.md` — draft Spec 12 (multi-instance fleet monitoring, fleet assessment, aggregation, fleet events)
14. `specs/13-observability-export.md` — draft Spec 13 (OpenTelemetry adapter, metrics, events, integration patterns)
15. `specs/14-serialization.md` — draft Spec 14 (state snapshots, restore, lightweight export, format versioning)
16. `../mada-journal/sessions/mada/brainstorm_20260324_context-lens.md` — origin brainstorm (read if you need deeper context on API shape or embedding strategy)
17. `../mada-journal/sessions/mada/brainstorm_20260404_context-lens-protocol-elevation.md` — enrichment brainstorm (sections 12–14 contain the integration strategy for specs 011–014 and all amendments)
