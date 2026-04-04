# context-lens — Design Spec Review Guide

## Scope

14 design specs, 5 amendments, 12 resolved open questions. This document organizes the review process — what to check, in what order, and what cross-cutting concerns to verify. The review validates internal consistency within each spec, type and invariant compatibility across specs, and coverage completeness before moving to implementation specs.

---

## Spec Inventory

### Core specs (1–10)

| # | Title | Status | File | Depends on | Amended |
|---|-------|--------|------|------------|---------|
| 1 | Segment Model | complete | `01-segment-model.md` | — | no |
| 2 | Quality Model | complete | `02-quality-model.md` | 1 | no |
| 3 | Degradation Patterns | complete | `03-degradation-patterns.md` | 2 | yes — §10 Custom Pattern Registration |
| 4 | Task Identity | complete | `04-task-identity.md` | 2 | no |
| 5 | Embedding Strategy | complete | `05-embedding-strategy.md` | 2 | no |
| 6 | Tokenization Strategy | complete | `06-tokenization-strategy.md` | 1 | no |
| 7 | API Surface | draft | `07-api-surface.md` | 1–6 | yes — §6.3–6.5 (registerPattern, serialization, snapshot/fromSnapshot), config, events |
| 8 | Eviction Advisory | draft | `08-eviction-advisory.md` | 2, 3, 7 | yes — §5.3 custom pattern strategyHint |
| 9 | Performance Budget | draft | `09-performance-budget.md` | 5, 6, 7 | no |
| 10 | Report & Diagnostics | draft | `10-report-diagnostics.md` | 3, 7, 8 | yes — §4.4 custom patterns, §8.4 JSON formatting |

### Enrichment specs (11–14)

| # | Title | Status | File | Depends on |
|---|-------|--------|------|------------|
| 11 | Report Schema | draft | `11-report-schema.md` | 2, 3, 7, 8, 10 |
| 12 | Fleet Monitor | draft | `12-fleet-monitor.md` | 7, 11 |
| 13 | Observability Export | draft | `13-observability-export.md` | 7, 10 |
| 14 | Serialization | draft | `14-serialization.md` | 7, 11 |

---

## Dependency Graph

```
Layer 0 (foundations):  01-Segment ──────────────────────────────────────────
                           │                                                 │
Layer 1 (scoring):      02-Quality ──────────────────────────  06-Tokenization
                         │  │  │                                       │
Layer 2 (analysis):   03-Degradation  04-Task  05-Embedding            │
                         │    │    │      │        │                   │
Layer 3 (surface):    07-API Surface ←────────────────────────────────┘
                       │    │    │    │
Layer 4 (consumers): 08-Eviction  09-Performance
                       │                │
Layer 5 (diagnostics): 10-Report & Diagnostics
                       │
Layer 6 (enrichments): 11-Schema  12-Fleet  13-OTel  14-Serialization
```

### Review order (bottom-up)

1. **Spec 1** (Segment Model) — foundation, no dependencies
2. **Spec 6** (Tokenization) — depends only on 1
3. **Spec 2** (Quality Model) — depends on 1
4. **Specs 3, 4, 5** (Degradation, Task, Embedding) — depend on 2, can review in parallel
5. **Spec 7** (API Surface) — integrates 1–6, most cross-references
6. **Specs 8, 9** (Eviction, Performance) — depend on 7
7. **Spec 10** (Report & Diagnostics) — depends on 3, 7, 8
8. **Specs 11, 12, 13, 14** (enrichments) — depend on 7/10/11, can review in parallel

---

## Review Passes

### Pass 1 — Per-Spec Internal Consistency

For each spec, verify:

- [ ] **Section references are correct.** Internal cross-references (e.g., "section 3.2") point to the right content after amendments and renumbering.
- [ ] **Table fields match prose.** Field names, types, and descriptions in tables are consistent with the surrounding prose.
- [ ] **Invariant numbering is sequential.** No gaps or duplicates in invariant numbers (especially after amendment additions).
- [ ] **TOC matches actual sections.** Section numbers in the table of contents match the document body.
- [ ] **Frontmatter is current.** `revised` date, `status`, `tags`, and `depends_on` reflect the latest amendments.

**Specs with amendments need extra attention:** 03, 07, 08, 10 — verify that amended sections integrate cleanly with the surrounding content and that cross-references from pre-amendment sections still resolve correctly.

### Pass 2 — Cross-Spec Type Consistency

Every named type is defined in one spec and consumed in others. Verify that the definition and all consumption sites agree on fields, types, nullability, and constraints.

#### Master type registry

| Type | Defined in | Consumed in | Fields to verify |
|------|-----------|-------------|-----------------|
| **Segment** | 01 §3–4 | 07 §3, §8.3 | id, content, tokenCount, protection, importance, origin, tags, groupId, state, createdAt, updatedAt |
| **Group** | 01 §5 | 07 §4.3 | groupId, members, protection, importance, origin, tags, tokenCount, createdAt, state |
| **QualityReport** | 02 §9 | 07 §6.1, 11 §3, 14 §4 | All fields — cross-check 02 vs 07 for windowScores/rawScores representation |
| **WindowScores** | 02 §9.2 | 07 §6.1, 11 §6.1 | coherence, density, relevance, continuity — nullable in 11 but not in 02? |
| **SegmentScore** | 02 §9.3 | 11 §6.1 | segmentId, coherence, density, relevance, continuity, composite, tokenCount, redundancy, groupId |
| **GroupScore** | 02 §9.4 | 11 §6.1 | groupId, memberCount, totalTokens, groupCoherence, meanRelevance, meanDensity, composite, integrityWarning |
| **ContinuitySummary** | 02 §9.5 | 07 §6.1, 11 §6.1 | totalEvictions, totalCompactions, totalRestorations, netLoss, tokensEvicted, tokensCompacted, tokensRestored, recentEvents |
| **TrendData** | 02 §9.6 | 07 §6.1, 11 §6.1 | previousReportId, timeDelta, all deltas — check if 02 and 07 have identical fields |
| **BaselineSnapshot** | 02 §7.5 | 07 §6.2, 11 §6.1, 14 §4.1 | coherence, density, relevance, continuity, capturedAt, segmentCount, tokenCount |
| **DetectionResult** | 03 §2.3 | 07 §6.1, 11 §6.3 | patterns, patternCount, highestSeverity, preBaseline |
| **ActivePattern** | 03 §2.3 | 10 §4.1, 11 §6.3, 13 §4 | name, severity, activatedAt, currentSince, duration, trending, signature, explanation, remediation, compoundContext |
| **PatternSignature** | 03 §2.3 | 11 §6.3 | primaryScore, secondaryScores, utilization, thresholdCrossed |
| **RemediationHint** | 03 §2.3 | 11 §6.3 | action, target, estimatedImpact, description |
| **CompoundContext** | 03 §8.2 | 11 §6.3 | compound, coPatterns, diagnosis, remediationShift |
| **PatternDefinition** | 03 §10.2 | 07 §2.2, §6.3 | name, description, detect, severity, explanation, remediation, strategyHint, priority |
| **TaskDescriptor** | 04 §2.1 | 07 §5.1, 11 §6.4 | description, keywords, relatedOrigins, relatedTags |
| **TaskState** | 04 §4.4 | 07 §5.4, 10 §2.2, 11 §6.4 | Multiple field definitions — verify all three agree |
| **TaskTransition** | 07 §5.1 | 04 §4.3, 11 §6.4 | type, similarity, previousTask |
| **CapacityReport** | 06 §4.5 | 07 §6.1, 11 §6.2 | capacity, totalActiveTokens, utilization, headroom, pinnedTokens, seedTokens, managedTokens, availableCapacity |
| **TokenizerMetadata** | 06 §2.2 | 07 §7.3, 11 §6.7 | name, accuracy, modelFamily, errorBound |
| **EvictionPlan** | 08 §4.2 | 11 §5 | planId, timestamp, strategy, target, candidates, candidateCount, totalReclaimable, targetMet, shortfall, seedsIncluded, exhausted, qualityImpact, patterns, reportId |
| **EvictionCandidate** | 08 §4.3 | 11 §6.5 | id, type, tokenCount, cumulativeTokens, evictionScore, tier, importance, scores, impact, recommendation, compaction, memberIds, reason |
| **CompactionRecommendation** | 08 §9.2 | 11 §6.5 | segmentId, currentTokens, estimatedTargetTokens, estimatedSavings, compressionRatio, continuityCost, reason |
| **DiagnosticSnapshot** | 10 §2.2 | 11 §4, 14 §4.1 | All fields — verify 10 vs 11 field names and types |
| **ReportSummary** | 10 §3.1 | 11 §6.6 | reportId, timestamp, windowScores, composite, segmentCount, totalActiveTokens, utilization, patternCount, highestSeverity, embeddingMode, anomalies |
| **TimelineEntry** | 10 §5.1 | 11 §6.6, 14 §4.1 | timestamp, sequence, type, detail |
| **PerformanceSummary** | 10 §6.1 | 11 §6.6 | operationTimings, caches, sessionSelfTime, sessionProviderTime, budgetViolationCount |
| **PatternSummary** | 10 §4.1 | 11 §6.6 | activePatterns, totalActivations, totalResolutions, perPattern, history |
| **FleetReport** | 12 §5.1 | (11 minor addition noted) | schemaVersion, timestamp, instanceCount, assessedCount, failedInstances, cached, instances, aggregate, hotspots, ranking, capacityOverview |
| **SerializedState** | 14 §4.1 | 07 §6.5 | formatVersion, schemaVersion, timestamp, restorable, all state fields |

#### Known type tensions to check

1. **WindowScores nullability.** Spec 02 §9.2 defines scores as `number (0.0–1.0)`. Spec 11 §6.1 makes them nullable for the empty-window case. Verify that spec 02 invariant 4 (empty window) and spec 11's nullable fields are compatible.

2. **QualityReport field set.** Spec 02 §9.1 uses `continuityLedger: ContinuitySummary`. Spec 07 §6.1 reproduces the report. Spec 11 §3.1 uses `continuity: ContinuitySummary` (different field name). Verify consistency.

3. **TrendData fields.** Spec 02 §9.6 has `timeDelta`. Spec 07 §6.1 does not list `timeDelta`. Spec 11 §6.1 has `timeDelta`. Verify the authoritative field set.

4. **TaskState between specs.** Spec 04 §4.4 defines TaskState with detailed fields (reportsSinceSet, reportsSinceTransition, etc.). Spec 07 §5.4 defines a simpler TaskState (state, current, previous, transitionCount, lastTransition, stale, gracePeriodActive, gracePeriodRemaining). Spec 11 §6.4 follows spec 07. Verify which is authoritative and whether both representations are needed.

5. **TaskSummary.** Referenced in QualityReport (spec 07 §6.1) as `task: TaskSummary`. Defined in spec 11 §6.4 with 4 fields. Not explicitly defined in spec 02 or spec 07 as a standalone type. Verify that the definition in spec 11 captures what the report needs.

6. **RedundancyInfo.** Referenced in spec 02 §9.3 as "which segment(s) this is redundant with, origin match." Defined in spec 11 §6.1 as `{ maxSimilarity, mostSimilarSegmentId, sameOrigin }`. Verify this captures spec 02's intent.

7. **ContinuityEvent vs ContinuityLedgerEntry.** Spec 10 §2.2 uses `continuityLedger: ContinuityLedgerEntry[]` for the full ledger. Spec 11 §4.1 uses `continuityLedger: ContinuityEvent[]`. Spec 11 §6.1 defines ContinuityEvent. Verify these are the same type or intentionally different.

8. **EvictionCandidate.compaction polymorphism.** Spec 08 §9.5 says group candidates have an array of CompactionRecommendation. Spec 11 §6.5 notes the `CompactionRecommendation | CompactionRecommendation[] | null` union. Verify the JSON Schema can express this cleanly.

### Pass 3 — Invariant Compatibility

Collect all numbered invariants across all specs and verify no pair conflicts.

| Spec | Invariant count | Key invariants to cross-check |
|------|:-:|---|
| 01 | 16 | #1 unique IDs, #5 group atomicity, #9 pinned immutability, #14 soft capacity |
| 02 | 20 | #4 empty window, #9 no LLM calls, #15 snapshot isolation |
| 03 | 16 (10+6) | #1 deterministic, #2 side-effect free, #10 in-budget, #11 name uniqueness, #14 fail-open |
| 04 | 12 | #1 caller owns task, #3 synchronous invalidation |
| 05 | 10 | #1 single provider, #5 fallback always available |
| 06 | 16 | #1 deterministic counting, #7 capacity required |
| 07 | 8 + cross-spec | #1 snapshot consistency, #2 atomic mutations, #3 deterministic reports, #4 defensive copies |
| 08 | 12 | #1 read-only consumer, #2 deterministic planning, #3 protection inviolable |
| 09 | 10 | #1 deterministic sampling, #2 cache correctness over performance |
| 10 | 10 | #1 read-only diagnostics, #2 cheap assembly, #3 snapshot isolation |
| 11 | 10 | #1 schema conformance, #6 deterministic serialization, #8 null correctness |
| 12 | 6 | #1 read-only consumer, #2 instance independence |
| 13 | 6 | #1 read-only consumer, #2 optional dependency |
| 14 | 8 | #1 snapshot equivalence, #4 round-trip fidelity, #8 atomic restore |

**Total: ~160 invariants.**

#### Cross-spec invariant tensions to check

1. **Determinism chain.** Specs 02, 03, 06, 07, 08 all assert determinism. Verify the chain: same content → same token count (06) → same scores (02) → same patterns (03) → same report (07) → same plan (08). Are there hidden sources of non-determinism (timestamps, registration order, hash order)?

2. **Atomic failure vs fail-open.** Spec 07 asserts atomic failure (invariant 2). Spec 03 §10 asserts fail-open for custom patterns (invariant 14). Verify these are compatible — does a throwing custom pattern during `assess()` violate atomic failure, or is `assess()` itself still atomic (it either returns a report or throws)?

3. **Read-only consumers.** Specs 08, 10, 12, 13 all claim read-only. Spec 08 says `planEviction` may trigger `assess()` (invariant 1 clarification). Verify that this is consistent with the "read-only" claim — `assess()` caches but doesn't mutate segments.

4. **Snapshot isolation across specs.** Spec 02 (invariant 15), spec 07 (invariant 4), spec 10 (invariant 3), and spec 14 (invariant 2) all assert snapshot isolation. Verify the guarantees are consistent.

5. **Performance budget with custom patterns.** Spec 09 budgets `assess()` at <50ms. Spec 03 §10.5 says custom pattern overhead is the caller's responsibility. Spec 09 invariant 1 says deterministic sampling. Verify that custom patterns don't break sampling determinism.

### Pass 4 — Coverage Gaps

Check for behaviors that callers would expect but no spec addresses:

- [ ] **Instance disposal.** Is there a `destroy()` or `dispose()` method? What happens to event handlers, fleet registrations, and OTel exporters when an instance is no longer needed?
- [ ] **Concurrency.** All specs assume single-threaded access. Is this explicitly stated? What happens if `assess()` is called while `add()` is in progress (in an async context)?
- [ ] **Memory lifecycle.** Spec 09 §6 budgets memory. Is there guidance on when/how to release an instance's memory?
- [ ] **Error recovery.** If `setEmbeddingProvider` fails mid-switch and falls back to trigrams (spec 05 §6), is the quality baseline still valid? Does this trigger a baseline re-capture?
- [ ] **Custom pattern + suppression interaction.** Spec 03 §10.4 says suppression works for custom patterns (§9.2 extended). Is the `suppressedPatterns` config field validated to accept custom pattern names, or only base names?
- [ ] **Fleet + serialization.** Can a fleet be serialized? Can a fleet be restored? (Probably not — the fleet holds instance references, not state.)
- [ ] **OTel exporter + serialization.** After `fromSnapshot`, does the caller need to re-attach the OTel exporter?

### Pass 5 — API Surface Completeness

Verify that every public-facing operation, type, and event mentioned across all specs is represented in spec 07.

- [ ] All segment operations from spec 01 appear in spec 07 §3.
- [ ] All quality report fields from spec 02 §9 appear in spec 07 §6.1.
- [ ] All detection result fields from spec 03 §2.3 appear in the QualityReport.
- [ ] All task operations from spec 04 appear in spec 07 §5.
- [ ] Provider operations from specs 05–06 appear in spec 07 §7.
- [ ] `registerPattern` (spec 03 §10) appears in spec 07 §6.3.
- [ ] `toJSON`, `schemas`, `validate` (spec 11 §9) appear in spec 07 §6.4.
- [ ] `snapshot`, `fromSnapshot` (spec 14) appear in spec 07 §6.5.
- [ ] `getDiagnostics` (spec 10) — verify it's in spec 07 (it may be missing from the API categories table since spec 10 was written after spec 07).
- [ ] `planEviction` (spec 08) — verify it's in spec 07.
- [ ] All 22 events are listed in spec 07 §9.2.
- [ ] All 12 error types are listed in spec 07 §10.1.

---

## Resolved Open Questions (verification)

Each resolution should be checked for consistency with the spec that implements it.

| OQ | Resolution | Implemented in | Verify |
|----|-----------|----------------|--------|
| OQ-001 | Coherence via adjacency similarity + clustering + group integrity | 02 §3 | Scoring formulas match the resolution description |
| OQ-002 | Density = 1 - max redundancy | 02 §4 | Formula matches |
| OQ-003 | Caller-provided task descriptor via setTask | 02 §5, 04 | API in 07 §5 |
| OQ-004 | Eviction cost formula for continuity prediction | 02 §6, 08 | Cost formula consistent across specs |
| OQ-005 | No bundled model, adapter interface + optional adapters | 05 | Provider interface in 05 §2, API in 07 §7.2 |
| OQ-006 | Provider abstraction with approximate default | 06 | Three modes (approximate, tiktoken, generic) consistent across 06 and 07 |
| OQ-007 | Five budget tiers | 09 §3 | Tier assignments cover all operations in 07 |
| OQ-008 | Stateful API | 07 §1 | All specs assume stateful instance |
| OQ-009 | Full QualityReport for custom patterns | 03 §10.1 | detect function signature in 03 §10.2 |
| OQ-010 | Independent schema versioning | 11 §2 | schemaVersion field on all outputs in 11 §3–5 |
| OQ-011 | Fresh assessment by default, cached opt-in | 12 §1, §4.1 | assessFleet options match |
| OQ-012 | One format, includeContent option | 14 §6 | snapshot options in 14 §3.1, restorable flag in 14 §4.1 |

---

## Architectural Decisions

Consolidated from the design spec phase. These are cross-cutting choices that inform interpretation of all specs.

- **Stateful API.** Each instance owns its segment collection, quality scores, continuity ledger, pattern history, and caches. Stateless rejected — continuity, pattern detection, caching, and baseline capture all require lifecycle awareness. (OQ-008)
- **One instance, one window.** Instances do not share state. Multiple windows = multiple instances.
- **Caller-driven mutations.** context-lens never auto-evicts, auto-compacts, or auto-reorders. It measures and advises; the caller acts.
- **Progressive disclosure.** Minimal usage: construct with capacity, add segments, call `assess`. Everything else opt-in.
- **Atomic failure.** Every mutating method either completes fully or has no effect.
- **Defensive copies.** All objects returned and accepted by the API are copied. No shared references.
- **No protocol elevation.** Library remains a single artifact. Protocol-inspired ideas integrated as enrichments (011–014).
- **Custom patterns are a library feature.** `PatternDefinition` contract, same severity model, hysteresis, and reporting as base patterns.
- **Report schema is first-class.** JSON Schema for all output types. Independent versioning (semver). Additive-only within major version. (OQ-010)
- **Fleet monitoring is a consumer.** `ContextLensFleet` reads existing public API. No shared state, no internal coupling.
- **OpenTelemetry is optional.** Peer dependency, separate entry point (`context-lens/otel`), no core coupling.
- **Serialization is opt-in.** `snapshot()`/`fromSnapshot()`. Providers not serialized. Caches rebuilt. Scores recomputed.
- **Token counting is approximate by default.** Character-class heuristic (±10%). Exact counting requires external library.
- **Provider interface is minimal.** One required method: `count(content) → number`. Optional `countBatch`.
- **Cache keyed on (content hash, provider name).** LRU-bounded (default 4096). Provider change triggers full invalidation.
- **Capacity is required, not defaulted.** No safe default across model families.
- **Content tokens only.** Framing tokens are the caller's responsibility.
- **Four quality dimensions, scored independently.** Coherence, Density, Relevance, Continuity.
- **No LLM calls in quality scoring.** Structural signals only. Embeddings or Jaccard trigrams.
- **Task descriptor is caller-provided.** No task = relevance 1.0 for all segments.
- **Baseline captured after seeds, before first add.** Immutable. Scores normalized relative to baseline.
- **Composite via weighted geometric mean.** One collapsed dimension → composite zero.
- **Quality reports are on-demand snapshots.** Cached and lazily invalidated.

---

## Session Log

Historical record of spec writing sessions.

| Date | Session | Specs | Summary |
|------|---------|-------|---------|
| 2026-03-24 | brainstorm | — | Project scoped, spec map created |
| 2026-03-25 | spec writing | 001 | Segment model: caller-defined units, dual ID, 4-tier protection, 8 lifecycle ops |
| 2026-03-26 | spec writing | 006 | Tokenization: provider abstraction, approximate default, LRU cache. OQ-006 |
| 2026-03-28 | spec writing | 002 | Quality model: 4 dimensions, similarity, baseline, composite. OQ-001–004 |
| 2026-04-01 | spec writing | 003 | Degradation patterns: causal chains, compounds, priority, hysteresis. 10 invariants |
| 2026-04-02 | spec writing | 007 | API surface: full public contract. OQ-008 |
| 2026-04-04 | spec writing | 009 | Performance budget: 5 tiers, sampling, memory. OQ-007 |
| 2026-04-04 | spec writing | 010 | Report & diagnostics: snapshot, history, timeline, formatting |
| 2026-04-04 | brainstorm | — | Enrichment planning (011–014). Protocol elevation rejected. OQ-009–012 |
| 2026-04-04 | spec writing | 011 | Report schema: JSON Schema, versioning, serialization. OQ-010 |
| 2026-04-04 | amendment | 003 | §10 Custom pattern registration. OQ-009 |
| 2026-04-04 | amendment | 007 | registerPattern, toJSON/schemas/validate, customPatterns config, events |
| 2026-04-04 | amendment | 008, 010 | strategyHint handling, custom pattern accommodation, JSON formatting |
| 2026-04-04 | spec writing | 014 + 007 amend | Serialization: snapshot/fromSnapshot. OQ-012 |
| 2026-04-04 | spec writing | 012, 013 | Fleet monitor + OTel export. OQ-011. All specs complete |

---

## Review Deliverable

The review produces:

1. **Issue list** — numbered findings, each tagged with spec(s), severity (blocker / inconsistency / gap / editorial), and proposed resolution.
2. **Type reconciliation table** — the final authoritative field list for each shared type, resolving any discrepancies found in Pass 2.
3. **Amended specs** — specs updated to resolve blockers and inconsistencies.
4. **Sign-off** — confirmation that the design spec corpus is internally consistent and ready for implementation spec writing.
