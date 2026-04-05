# context-lens — Design Spec Review Findings

Findings from the design spec review defined in `REVIEW.md`. Each finding is numbered sequentially across all phases.

Severity levels: **blocker** (contradictory/broken) | **inconsistency** (mismatch/ambiguous) | **gap** (missing coverage) | **editorial** (formatting/stale refs)

**Phase 1 status: COMPLETE — all findings identified and fixes applied (2026-04-05).**

---

## Phase 1 — Internal Consistency (Pass 1)

### B1: Spec 01 (Segment Model), Spec 06 (Tokenization Strategy)

**R-001** [editorial] (01-segment-model)
Group Identity table (§5.1), `protection` field references "see section 5.3" for override behavior. The override semantics (group-level protection overriding member-level) are described in §5.2 (Aggregate Properties), not §5.3 (Atomic Eviction).
**Proposed resolution:** Change "see section 5.3" to "see section 5.2" in the §5.1 table.

**R-002** [inconsistency] (01-segment-model)
Frontmatter `status: draft` but SEED_CONTEXT.md declares Spec 1 as "complete."
**Proposed resolution:** Change `status: draft` to `status: complete`.

**R-003** [inconsistency] (01-segment-model)
Frontmatter `revised: 2026-03-24` equals `created` date, suggesting no revision since initial creation despite the spec being finalized as complete.
**Proposed resolution:** Update `revised` to the date the spec reached its final form.

**R-004** [inconsistency] (06-tokenization-strategy)
Frontmatter `status: draft` but SEED_CONTEXT.md declares Spec 6 "complete."
**Proposed resolution:** Change `status: draft` to `status: complete`.

**R-005** [editorial] (06-tokenization-strategy)
Frontmatter `revised: 2026-03-25` equals `created` date, not updated after finalization.
**Proposed resolution:** Update `revised` to the date the spec reached its final form.

**B1 note:** Both foundation specs are structurally sound — all cross-references resolve, tables match prose, invariant numbering is sequential (01: 15 invariants, 06: 16 invariants), TOCs match sections. The only issues are stale frontmatter (status + revised dates). This is likely a systematic pattern across all specs.

### B2: Spec 02 (Quality Model)

**R-006** [inconsistency] (02-quality-model)
§1 line 92: "The aggregation method varies by dimension (section 8)" — section 8 is "Composite Score." Per-dimension aggregation is in §3.7, §4.6, §5.7, §6.7.
**Proposed resolution:** Change "(section 8)" to "(sections 3–6)".

**R-007** [inconsistency] (02-quality-model)
§2.5 line 199: "The group's relevance is the aggregate of its members' relevance (section 8)" — section 8 is "Composite Score." Group relevance aggregation is in §9.4 (GroupScore table).
**Proposed resolution:** Change "(section 8)" to "(section 9.4)".

**R-008** [blocker] (02-quality-model)
`protectionRelevance` function (§5.3) and per-segment relevance formula (§5.5) are structurally inconsistent. The formula multiplies `protectionRelevance(i)` by the weighted component sum. For priority/default segments, `protectionRelevance` returns `contentRelevance(i)`, squaring the content relevance contribution. For pinned segments returning 1.0, multiplying gives the weighted sum — not the "clamped to 1.0" described in prose (line 593). For seeds returning `max(contentRelevance, 0.3)`, multiplying does not produce a floor of 0.3 on the final score. The function appears designed to BE the final score for special cases, but is used as a multiplicative modulator.
**Proposed resolution:** Rewrite the formula to use `protectionRelevance` as a post-hoc clamp/floor, not a multiplier. E.g., `relevance(i) = clamp(weightedSum, protectionFloor(i), protectionCeiling(i))`.

**R-009** [inconsistency] (02-quality-model)
`baselineEstablished` (boolean) is defined in §7.5 and referenced by invariant 7, but does not appear in the §9.1 top-level report fields table. A consumer implementing from §9.1 alone would miss it.
**Proposed resolution:** Add `baselineEstablished | boolean | Whether a baseline has been captured (section 7.2)` to §9.1.

**R-010** [inconsistency] (02-quality-model)
Frontmatter `status: draft` but SEED_CONTEXT.md declares Spec 2 "complete."
**Proposed resolution:** Change `status: draft` to `status: complete`.

**R-011** [editorial] (02-quality-model)
§9.1 line 953: `tokenizer` field references "cl-spec-006 section 7.5" (consumption context) instead of "cl-spec-006 section 2.2" (type definition), inconsistent with other fields in the same table that cite defining sections.
**Proposed resolution:** Reference "cl-spec-006 section 2.2" for consistency.

**B2 note:** One blocker (R-008) — the protectionRelevance formula is structurally broken as written. Two misdirected section references point to §8 (Composite Score) instead of the actual aggregation sections. `baselineEstablished` is missing from the report structure table. TOC, invariant numbering (20 invariants, matching REVIEW.md), and all other tables are clean.

### B3: Spec 03 (Degradation Patterns), Spec 04 (Task Identity), Spec 05 (Embedding Strategy)

#### Spec 03 — Degradation Patterns

**R-012** [inconsistency] (03-degradation-patterns)
`ActivePattern` table (§2.3) omits the `compoundContext` field, which is defined in §8.2 and expected by REVIEW.md's type registry.
**Proposed resolution:** Add `compoundContext: CompoundContext | null` to the §2.3 table.

**R-013** [inconsistency] (03-degradation-patterns)
`RemediationHint.action` enum (§2.3 line 206) lists 7 values but pattern remediation sections use 3 additional actions: `slowEviction` (collapse), `restart` (collapse), `dissolve` (fracture).
**Proposed resolution:** Expand the enum to include `slowEviction`, `restart`, `dissolve`.

**R-014** [blocker] (03-degradation-patterns, 14-serialization)
§2.5 states "History is not persisted across sessions. There is no serialization." This contradicts cl-spec-014 which explicitly includes pattern tracking state and pattern history in serialized snapshots.
**Proposed resolution:** Amend §2.5 to acknowledge serialization via `snapshot()`/`fromSnapshot()` (cl-spec-014).

**R-015** [inconsistency] (03-degradation-patterns, 07-api-surface)
Suppression config field named `suppress` in §9.2 but `suppressedPatterns` in spec 07 §2.2.
**Proposed resolution:** Align on `suppressedPatterns` (spec 07 is API authority). Update §9.2.

**R-016** [editorial] (03-degradation-patterns)
Frontmatter `status: complete` should be `complete (amended)` per SEED_CONTEXT.md.
**Proposed resolution:** Update frontmatter status.

**R-017** [editorial] (03-degradation-patterns)
Frontmatter tags missing `custom-patterns` and `registration` after §10 amendment.
**Proposed resolution:** Add to tags array.

**R-018** [gap] (03-degradation-patterns)
`trend.tokensDelta` used by saturation (§3.3) for rate-based early activation but not listed in §2.1 inputs table.
**Proposed resolution:** Add row to §2.1 inputs table.

**R-019** [gap] (03-degradation-patterns)
§9.2 suppression never explicitly states that custom pattern names are accepted, nor describes validation behavior for custom names.
**Proposed resolution:** Add paragraph to §9.2 clarifying custom pattern name suppression.

**R-020** [editorial] (03-degradation-patterns)
§1.2 overview mentions sections 3–7 for patterns but does not mention §10 custom pattern registration.
**Proposed resolution:** Append note about §10 to the overview sentence.

**R-021** [inconsistency] (03-degradation-patterns)
§10.5 references "sections 1-9 of cl-spec-002" — misleadingly specific since cl-spec-002 has 11 sections.
**Proposed resolution:** Change to "the quality model (cl-spec-002)".

**R-022** [gap] (03-degradation-patterns)
§10.8 references unregister/re-register as workaround for wrong custom pattern priority, but unregistration is unavailable in v1.
**Proposed resolution:** State priority is immutable; only recourse is a new instance.

#### Spec 04 — Task Identity

**R-023** [inconsistency] (04-task-identity)
`relatedOrigins` field (§2.1 line 102) cites "cl-spec-001 section 3.3" — should be section 4.2 (Origin Tag).
**Proposed resolution:** Change to "cl-spec-001 section 4.2".

**R-024** [inconsistency] (04-task-identity)
`relatedTags` field (§2.1 line 103) cites "cl-spec-001 section 3.4" — section 3.4 does not exist. Tags are in section 4.5.
**Proposed resolution:** Change to "cl-spec-001 section 4.5".

**R-025** [inconsistency] (04-task-identity)
Normalization table (§2.3 lines 141–142) repeats the same wrong section numbers as R-023/R-024.
**Proposed resolution:** Same fixes: section 4.2 for origins, section 4.5 for tags.

**R-026** [blocker] (04-task-identity, 07-api-surface)
`setTask` return type contradiction. Spec 04 §4.3 explicitly returns void with rationale paragraph ("Why setTask doesn't return the classification"). Spec 07 §5.1 defines `setTask → TaskTransition`. Spec 02 §5.1 agrees with spec 04 (void).
**Proposed resolution:** Decide one. If TaskTransition kept (spec 07), remove void rationale from spec 04 and update spec 02. If void kept, update spec 07.

**R-027** [inconsistency] (04-task-identity, 07-api-surface, 11-report-schema)
Transition type enum mismatch. Spec 04: `"set" | "change" | "refinement" | "clear"`. Specs 07/11: `"new" | "refinement" | "change" | "same"`. Divergences: `"set"` vs `"new"`, spec 04 has `"clear"` (absent from 07/11), specs 07/11 have `"same"` (absent from 04).
**Proposed resolution:** Reconcile enum. Either unify with notes on when each value appears, or define two related enums with clear names.

**R-028** [inconsistency] (04-task-identity, 07-api-surface, 11-report-schema)
TaskState lifecycle state casing: spec 04 uses `"unset" | "active"` (lowercase), specs 07/11 use `"UNSET" | "ACTIVE"` (uppercase). Casing is load-bearing for JSON schema.
**Proposed resolution:** Align on uppercase (specs 07/11 agree). Update spec 04.

**R-029** [inconsistency] (04-task-identity, 07-api-surface)
TaskState field divergence. Spec 04 defines 12 fields (`currentTask`, `graceActive`, `reportsSinceSet`, etc.). Spec 07 defines 8 fields (`current`, `gracePeriodActive`, `stale`, etc.). Different field names for same concepts, different field sets.
**Proposed resolution:** Designate spec 04 as behavioral authority, spec 07 as API shape. Reconcile field names and decide on single comprehensive type.

**R-030** [gap] (04-task-identity)
§4.4 TaskState table omits `transitionHistory` despite §5.4 explicitly stating it is "included in the task state object returned by getTaskState()."
**Proposed resolution:** Add `transitionHistory: TransitionEntry[]` to §4.4 table.

**R-031** [gap] (04-task-identity)
§4.4 TaskState table omits `stale` field despite §5.3 defining staleness as task state metadata and spec 07 including `stale: boolean`.
**Proposed resolution:** Add `stale` as computed boolean to §4.4 table.

**R-034** [inconsistency] (04-task-identity)
Frontmatter `status: draft` but SEED_CONTEXT.md declares Spec 4 "complete."
**Proposed resolution:** Change to `status: complete`.

**R-037** [inconsistency] (04-task-identity, 14-serialization)
Invariant 4 states "Task state is not persisted. There is no serialization." Spec 14 explicitly includes task state in snapshots.
**Proposed resolution:** Amend invariant 4 to acknowledge serialization via cl-spec-014, preserving spirit (no auto-persistence).

**R-038** [inconsistency] (04-task-identity)
Three different step sequences for `setTask` flow (§2.3, §4.3, §6.5) differ in granularity, numbering, and included steps.
**Proposed resolution:** Designate §6.5 as canonical and have §2.3 and §4.3 reference it.

**R-039** [gap] (04-task-identity)
`TaskTransition` type is never defined in spec 04 despite REVIEW.md listing it as consumed in spec 04 §4.3.
**Proposed resolution:** If setTask returns TaskTransition (per R-026), add type definition or cross-reference.

**R-040** [editorial] (04-task-identity)
§4.4 quotes a diagnostic template from cl-spec-003 §6.4 inline — will silently go stale if spec 03's template changes.
**Proposed resolution:** Replace inline quote with reference, or accept and flag for sync.

#### Spec 05 — Embedding Strategy

**R-041** [inconsistency] (05-embedding-strategy)
Frontmatter `status: draft` but SEED_CONTEXT.md declares Spec 5 "complete."
**Proposed resolution:** Change to `status: complete`.

**R-042** [inconsistency] (05-embedding-strategy)
§5.1 (line 413) references "cl-spec-001 section 2.2" for content hashing. Spec 01 §2.2 is "Boundary Rules"; content hashing is in §3.2.
**Proposed resolution:** Change to "cl-spec-001 section 3.2".

**R-043** [inconsistency] (05-embedding-strategy)
§7.4 (line 599) references "cl-spec-003 section 2.5" for score deltas in trend analysis. Spec 03 §2.5 is "Pattern History." Score deltas are in spec 02 §9.6.
**Proposed resolution:** Change to "cl-spec-002 section 9.6".

**R-044** [inconsistency] (05-embedding-strategy, REVIEW.md)
REVIEW.md lists Spec 05 key invariants as "#5 fallback always available" but in the actual spec, #5 is "Full recomputation on provider switch" and #7 is "Fallback always available."
**Proposed resolution:** Fix REVIEW.md to reference "#7 fallback always available".

**R-045** [editorial] (05-embedding-strategy)
References table describes cl-spec-004 §6.3 as "provider switch handling" — §6.3 is "Preparation Caching."
**Proposed resolution:** Change to "preparation caching (section 6.3)".

**B3 note:** Two blockers surfaced — R-014 (spec 03 §2.5 contradicts spec 14 on pattern history serialization) and R-026 (setTask return type: void in spec 04 vs TaskTransition in spec 07). The TaskState divergence cluster (R-027/R-028/R-029/R-030/R-031) confirms REVIEW.md's known tension #4 is real and extensive. Multiple wrong section references to spec 01 (R-023/R-024/R-025/R-042) suggest a section renumbering in spec 01 that wasn't propagated. Specs 03 and 04 both have "no serialization" claims that contradict spec 14 (R-014, R-037).

### B4: Spec 07 (API Surface)

**R-046** [inconsistency] (07-api-surface)
`assess` step 5 references "cl-spec-002 section 9.4" for trend data — §9.4 is "Group Scores." Trend data is §9.6.
**Proposed resolution:** Change to "cl-spec-002 section 9.6".

**R-047** [inconsistency] (07-api-surface)
`assess` step 2 references "cl-spec-002 section 8.2" for lazy caching — §8.2 is "Aggregation Formula." Report caching is §9.7.
**Proposed resolution:** Change to "cl-spec-002 section 9.7".

**R-049** [inconsistency] (07-api-surface, 02-quality-model)
QualityReport field set divergence. Spec 07 has 16 fields; spec 02 has 12. Spec 07 adds `rawScores`, `embeddingMode`, `patterns`, `task`. Also `rawScores` is a top-level field in spec 07 but nested inside `windowScores` in spec 02.
**Proposed resolution:** Decide authoritative representation. Add missing fields to spec 02 or document that spec 07 extends spec 02's report.

**R-050** [inconsistency] (07-api-surface, 02-quality-model)
TrendData field: spec 02 uses `segmentsDelta`, spec 07 uses `segmentCountDelta`.
**Proposed resolution:** Align on `segmentCountDelta` (more descriptive). Update spec 02.

**R-051** [inconsistency] (07-api-surface, 02-quality-model)
TrendData `timeDelta` defined in spec 02 §9.6 but absent from spec 07. REVIEW.md tension #3.
**Proposed resolution:** Add `timeDelta` to spec 07 TrendData table or document intentional omission.

**R-052** [inconsistency] (07-api-surface, 06-tokenization-strategy)
`managedTokens` definition: spec 06 = `totalActiveTokens - pinnedTokens` (includes seeds), spec 07 = "priority + default segments (evictable)" (excludes seeds). Spec 03 usage implies spec 06's definition.
**Proposed resolution:** Align spec 07 with spec 06's authoritative definition.

**R-053** [gap] (07-api-surface)
`customPatterns` missing from Configuration Immutability table (§2.5) despite being in the config options table (§2.2).
**Proposed resolution:** Add: `customPatterns | Append-only | registerPattern(definition)`.

**R-054** [blocker] (07-api-surface) — confirms R-026
`setTask` return type: spec 07 returns `TaskTransition`, spec 04 returns void with explicit rationale.
**Proposed resolution:** See R-026. Recommend spec 07's TaskTransition return (more ergonomic, spec 07 is API authority).

**R-055** [inconsistency] (07-api-surface) — confirms R-027
Transition type enum: spec 07 uses `"new"`, spec 04 uses `"set"` for UNSET→ACTIVE.
**Proposed resolution:** See R-027.

**R-056** [inconsistency] (07-api-surface) — confirms R-028
TaskState casing: UPPERCASE here but lowercase in spec 04. Also internally inconsistent — spec 07 uses lowercase for segment/group state.
**Proposed resolution:** See R-028. Lowercase everywhere for consistency.

**R-057** [inconsistency] (07-api-surface) — confirms R-029
TaskState: 8 fields here vs 12 in spec 04, plus field name divergences.
**Proposed resolution:** See R-029.

**R-060** [editorial] (07-api-surface)
Frontmatter `status: draft` — should indicate amended state per SEED_CONTEXT.md.
**Proposed resolution:** Change to `status: draft (amended)`.

**R-062** [editorial] (07-api-surface)
Frontmatter tags missing `serialization`, `snapshot`, `patterns` from amendment additions.
**Proposed resolution:** Add to tags.

**R-063** [gap] (07-api-surface)
`getDiagnostics()` (spec 10) not in spec 07 — the authoritative API catalog.
**Proposed resolution:** Add to spec 07 under Quality Operations or new subsection.

**R-064** [gap] (07-api-surface)
`planEviction()` (spec 08) not in spec 07.
**Proposed resolution:** Add to spec 07 with signature and cross-reference to spec 08.

**R-065** [gap] (07-api-surface)
`formatReport`, `formatDiagnostics`, `formatPattern` (spec 10 §8) not in spec 07.
**Proposed resolution:** Add or explicitly note these as spec 10 utilities outside core API.

**R-066** [inconsistency] (07-api-surface)
§1.2 says "seven categories" but the API categories table lists nine rows.
**Proposed resolution:** Change "seven" to match actual count.

**R-067** [inconsistency] (07-api-surface)
API categories table omits: `validate`, `snapshot`/`fromSnapshot`, `setCapacity`, `getEvictionHistory`, `getTokenizerInfo`, `getEmbeddingProviderInfo`.
**Proposed resolution:** Update table to include all public methods.

**R-068** [gap] (07-api-surface)
`EmbeddingProviderMetadata` type used by `getEmbeddingProviderInfo()` but never defined with a field table.
**Proposed resolution:** Add field table to §7.4, referencing spec 05 §2.2.

**B4 note:** Spec 07 has the heaviest finding density — 20 findings. Key themes: (1) API catalog is incomplete (getDiagnostics, planEviction, format utilities missing — these specs were written after spec 07), (2) QualityReport structure diverges from spec 02, (3) all TaskState/transition issues confirmed from spec 04 side, (4) managedTokens definition contradicts spec 06. The API categories table is stale. One blocker (R-054, confirming R-026).

### B5: Spec 08 (Eviction Advisory), Spec 09 (Performance Budget)

#### Spec 08 — Eviction Advisory

**R-069** [blocker] (08-eviction-advisory)
Saturation-driven weight row sums to 0.85, not 1.0 (§2.4). w_r=0.20 + w_d=0.25 + w_c=0.15 + w_i=0.15 + w_a=0.10 = 0.85. Prose mentions distributing remaining 0.15 but the table values don't reflect it. Violates invariant 8 ("weights sum to exactly 1.0").
**Proposed resolution:** Fix table values to sum to 1.0 (e.g., w_d=0.30, w_a=0.20).

**R-070** [inconsistency] (08-eviction-advisory)
Five cross-references to collapse-driven strategy point to §5.7 (Gap-Driven). Collapse is §5.8. Root cause: section renumbering after §5.3 amendment.
**Proposed resolution:** Change all five "section 5.7" → "section 5.8" for collapse refs.

**R-071** [inconsistency] (08-eviction-advisory)
Two cross-references to gap-driven strategy point to §5.6 (Erosion-Driven). Gap is §5.7. Same renumbering issue.
**Proposed resolution:** Change both "section 5.6" → "section 5.7".

**R-072** [inconsistency] (08-eviction-advisory)
Cross-reference to "Why No Fracture Strategy" points to §5.8 (Collapse). Should be §5.9.
**Proposed resolution:** Change "section 5.8" → "section 5.9".

**R-073** [inconsistency] (08-eviction-advisory, 03-degradation-patterns)
`lossDominates` compound scope: spec 03 defines it as "Collapse + any." Spec 08 §5.10 fabricates a restriction "any non-erosion" that doesn't exist in spec 03.
**Proposed resolution:** Amend spec 08 to acknowledge collapse + erosion triggers `lossDominates`.

**R-074** [gap] (08-eviction-advisory) — confirms R-064
`planEviction()` defined here but absent from spec 07.

**R-075** [inconsistency] (08-eviction-advisory)
`EvictionCandidate.compaction` type listed as `CompactionRecommendation | null` in §4.3, but §9.5 says group candidates get an array. Spec 11 correctly captures the full union.
**Proposed resolution:** Update §4.3 type to `CompactionRecommendation | CompactionRecommendation[] | null`.

**R-076** [gap] (08-eviction-advisory)
Spec never references `managedTokens` from the capacity report despite operating on that exact pool.
**Proposed resolution:** Clarify that advisory's candidate pool = `managedTokens` (spec 06 definition, including seeds).

**R-077** [editorial] (08-eviction-advisory)
Frontmatter `status: draft` should be `draft (amended)` per SEED_CONTEXT.md.

**B5-08 note:** One blocker (R-069, saturation weights). Seven section cross-references off by one due to §5.3 amendment renumbering (R-070/071/072). Invariants (12), TOC (11 sections), depends_on all verified correct.

#### Spec 09 — Performance Budget

**R-082** [inconsistency] (09-performance-budget)
§3.5 references "cl-spec-006 section 5.2" for provider switching — should be §6.3.
**Proposed resolution:** Change to "cl-spec-006 section 6.3".

**R-083** [inconsistency] (09-performance-budget)
Per-operation timing record table (§8.1) omits `budgetExceeded` and `budgetTarget` fields that §8.3 says are added to the record.
**Proposed resolution:** Add both fields to §8.1 table.

**R-084** [inconsistency] (09-performance-budget, 07-api-surface)
§8.2 describes a `timing` event dispatched after every timed operation. Spec 07's 22-event list does not include any `timing` event.
**Proposed resolution:** Either add `timing` event to spec 07 or revise spec 09 to use existing mechanism (e.g., `budgetViolation` timeline event from spec 10).

**R-085** [gap] (09-performance-budget)
Budget tables omit 8+ public operations added after amendments: `getDiagnostics`, `registerPattern`, `snapshot`, `fromSnapshot`, `toJSON`, `validate`, `getTokenizerInfo`, `getEmbeddingProviderInfo`.
**Proposed resolution:** Add budget entries and complexity classifications for all missing operations.

**R-086** [inconsistency] (09-performance-budget)
Memory scaling table (§6.4) contradicts memory formula (§6.3). Formula uses `min(cache_size, n)` (lazy allocation) but table shows full-cache costs regardless of segment count.
**Proposed resolution:** Align formula and table — either both use max-allocation or both use lazy-allocation.

**R-087** [inconsistency] (09-performance-budget)
§3.1 references "cl-spec-007 section 2.5" for defensive copying — §2.5 is "Configuration Immutability," not defensive copying.
**Proposed resolution:** Change to "cl-spec-007 invariant 4".

**R-088** [gap] (09-performance-budget)
`setCapacity` classified as Tier 5 (batch/rare) despite O(1) cost and Tier 1 characteristics.
**Proposed resolution:** Move to Tier 1 or add clarifying note.

**R-090** [gap] (09-performance-budget)
Invariant 4 ("Sampling is deterministic") claims seed derived from segment set, but §5.2 and §5.3 never specify the derivation algorithm.
**Proposed resolution:** Add concrete seed derivation rule (e.g., hash of sorted segment IDs).

**R-093** [gap] (09-performance-budget)
References table omits `cl-spec-004` despite budgeting `setTask`/`clearTask`.
**Proposed resolution:** Add cl-spec-004 to references.

**B5-09 note:** No blockers. Key issues: phantom `timing` event not in spec 07 event list (R-084), 8+ operations missing from budget tables (R-085), memory formula vs table contradiction (R-086). Invariants (10), TOC (10 sections), frontmatter all verified correct.

### B6: Spec 10 (Report & Diagnostics)

**R-095** [inconsistency] (10-report-diagnostics, 07-api-surface)
Timeline event type `taskSet` (§5.2) vs API event name `taskChanged` (spec 07 §9.2) for the same lifecycle trigger.
**Proposed resolution:** Align names — rename spec 07's event to `taskSet` (fewer changes) or vice versa.

**R-096** [gap] (10-report-diagnostics, 07-api-surface)
Timeline/event misalignment. 5 spec 07 events have no timeline representation: `lateSeeding`, `pinnedCeilingWarning`, `customPatternRegistered`, `stateSnapshotted`, `stateRestored`. 4 timeline types have no spec 07 event: `reportGenerated`, `patternEscalated`, `patternDeescalated`, `budgetViolation`.
**Proposed resolution:** Add missing events to timeline (§5.2) and spec 07's event list, or document timeline-only vs API-only event categories.

**R-097** [blocker] (10-report-diagnostics) — confirms R-063
`getDiagnostics()` and formatting utilities (`formatReport`, `formatDiagnostics`, `formatPattern`) entirely absent from spec 07.
**Proposed resolution:** See R-063.

**R-098** [inconsistency] (10-report-diagnostics)
`ReportSummary` table (§3.1) omits `anomalies: AnomalyFlag[]` despite §3.3 prose and spec 11 both including it.
**Proposed resolution:** Add `anomalies` field to §3.1 table.

**R-099** [inconsistency] (10-report-diagnostics, 11-report-schema)
`continuityLedger` field typed as `ContinuityLedgerEntry[]` in §2.2 but `ContinuityEvent[]` in spec 11 §4.1. REVIEW.md tension #7.
**Proposed resolution:** Adopt `ContinuityEvent[]` in spec 10 to match spec 11.

**R-100** [inconsistency] (10-report-diagnostics, 11-report-schema)
`CacheMetrics.hitRate` is "NaN if no lookups" in §6.2 but `null` in spec 11. NaN is not JSON-representable.
**Proposed resolution:** Change to `number | null` with "null if no lookups."

**R-101** [gap] (10-report-diagnostics)
`DiagnosticSnapshot` table (§2.2) missing `schemaVersion` field that spec 11 requires on all top-level outputs.
**Proposed resolution:** Add `schemaVersion: string` as first field.

**R-102** [gap] (10-report-diagnostics)
`ReportHistorySummary` type used in DiagnosticSnapshot table but never formally defined. Spec 11 defines it with `{ reports, rollingTrend }`.
**Proposed resolution:** Add formal structure table to §3.

**R-103** [inconsistency] (10-report-diagnostics, 07-api-surface)
Field naming convention: spec 07 events use `old` prefix (`oldName`), spec 10 timeline uses `previous` prefix (`previousName`). Also semantic difference: `embeddingProviderChanged` timeline records mode change while spec 07 records provider name.
**Proposed resolution:** Harmonize prefix convention and clarify semantic distinction.

**R-104** [inconsistency] (10-report-diagnostics, 09-performance-budget) — confirms R-084
Phantom `timing` event from spec 09 appears nowhere in spec 07 events, spec 10 timeline, or spec 11 schema.
**Proposed resolution:** See R-084. Recommend removing from spec 09, surfacing only through aggregated PerformanceSummary and budgetViolation timeline entries.

**B6 note:** Timeline/event ecosystem needs reconciliation (R-095, R-096, R-103, R-104) — the event names, timeline types, and field conventions diverge across specs 07, 09, and 10. Multiple types are used but never formally defined (R-102). REVIEW.md tension #7 confirmed (R-099). Invariants (10), TOC (10 sections), frontmatter verified correct.

### B7: Spec 11 (Report Schema), Spec 12 (Fleet Monitor), Spec 13 (Observability Export), Spec 14 (Serialization)

#### Spec 11 — Report Schema

**R-108** [inconsistency] (11-report-schema, 02-quality-model, 07-api-surface)
QualityReport field named `continuity` in spec 11 vs `continuityLedger` in specs 02 and 07. REVIEW.md tension #2.
**Proposed resolution:** Align on one name. If `continuity` (shorter), update specs 02 and 07. If `continuityLedger` (more descriptive), update spec 11.

**R-109** [inconsistency] (11-report-schema, 02-quality-model)
QualityReport in spec 11 includes `rawScores`, `embeddingMode`, `patterns`, `task` — all from spec 07's expanded definition. Spec 02 §9.1 (original definition) has none of these.
**Proposed resolution:** Amend spec 02 §9.1 to include the expanded fields, or add a note that spec 07 supersedes.

**R-110** [inconsistency] (11-report-schema) — confirms R-050
TrendData `segmentsDelta` (spec 02) vs `segmentCountDelta` (specs 07, 11).
**Proposed resolution:** See R-050.

**R-111** [inconsistency] (11-report-schema) — confirms R-051
TrendData `previousReportId` and `timeDelta` present in specs 02/11 but absent from spec 07.
**Proposed resolution:** See R-051.

**R-112** [blocker] (11-report-schema) — confirms R-028
TaskLifecycleState: `"UNSET" | "ACTIVE"` (specs 07, 11) vs `"unset" | "active"` (spec 04). Schema authority must be definitive.
**Proposed resolution:** See R-028. Standardize on one casing.

**R-113** [blocker] (11-report-schema) — confirms R-027
TransitionType: `"new" | "refinement" | "change" | "same"` (specs 07, 11) vs `"set" | "change" | "refinement" | "clear"` (spec 04). Single enum in spec 11 must serve both TaskTransition and transition history.
**Proposed resolution:** See R-027. Define one unified enum or two separate enums.

**R-114** [inconsistency] (11-report-schema)
TaskState field names: spec 11 uses a hybrid of spec 04 names (`currentTask`, `graceActive`) and spec 07 names (`lastTransition`). Three specs disagree.
**Proposed resolution:** Spec 11 as schema authority should define canonical names; update specs 04 and 07 to match.

**R-115** [inconsistency] (11-report-schema)
TaskState field set: spec 11 includes `changeCount`, `refinementCount`, `reportsSinceSet`, `reportsSinceTransition` (from spec 04) but not `taskSetAt`. Hybrid of specs 04 and 07.
**Proposed resolution:** Decide whether `taskSetAt` belongs in serialized form. Document spec 07's version as public summary, spec 11's as full serialized form.

**R-116** [inconsistency] (11-report-schema) — confirms R-099
`continuityLedger` typed `ContinuityEvent[]` in spec 11 vs `ContinuityLedgerEntry[]` in spec 10. REVIEW.md tension #7.
**Proposed resolution:** See R-099. Adopt one name.

**R-117** [gap] (11-report-schema)
TimelineEventType enum has 21 values. Missing: `customPatternRegistered`, `stateSnapshotted`, `stateRestored` (from spec 07 amendment), plus `lateSeeding` and `pinnedCeilingWarning`.
**Proposed resolution:** Add missing event types. Aligns with R-096.

**R-124** [editorial] (11-report-schema)
Frontmatter `depends_on` omits `cl-spec-004` and `cl-spec-006` despite consuming types from both.
**Proposed resolution:** Add to depends_on.

**R-125** [gap] (11-report-schema)
`TaskSummary` type defined only in spec 11 §6.4 — referenced by spec 07 §6.1 but never defined there.
**Proposed resolution:** Add TaskSummary definition to spec 07, or reference spec 11.

**R-126** [gap] (11-report-schema) — confirms R-098
ReportSummary `anomalies` field in spec 11 but missing from spec 10 §3.1 table.
**Proposed resolution:** See R-098.

**R-129** [gap] (11-report-schema)
`EvictionCandidate.compaction` polymorphism (segment vs group) — no JSON Schema pattern shown. REVIEW.md tension #8.
**Proposed resolution:** Add `if`/`then` discriminated union example.

**B7-11 note:** Two blockers (R-112, R-113) confirming the casing and enum vocabulary tensions from earlier batches. The QualityReport field name divergence (R-108) and TaskState three-way disagreement (R-114/R-115) are the heaviest cross-spec issues. TOC, invariants (10), structural checks all pass.

#### Spec 12 — Fleet Monitor

**R-133** [inconsistency] (12-fleet-monitor)
`InstanceInfo.segmentCount` described as integer from `getSegmentCount()`, but spec 07 says `getSegmentCount()` returns `{ active, evicted, total }` — an object, not a plain integer.
**Proposed resolution:** Change description to "from `getSegmentCount().active`".

**R-134** [inconsistency] (12-fleet-monitor)
References table claims fleet uses `getDiagnostics()`, but the method never appears in spec body or invariant 1's method list.
**Proposed resolution:** Remove `getDiagnostics()` from references.

**R-136** [gap] (12-fleet-monitor)
`InstanceInfo.capacity` and `utilization` fields don't state their source (unlike `segmentCount` which says "from getSegmentCount()").
**Proposed resolution:** Add source annotations: "from `getCapacity().capacity`" and "from `getCapacity().utilization`".

**R-137** [gap] (12-fleet-monitor)
`InstanceInfo.lastAssessedAt` has no clear data source — no public method returns assessment timestamp.
**Proposed resolution:** Clarify source: fleet's internal tracking from `assessFleet()` calls.

**B7-12 note:** Clean structurally. Two inconsistencies and two gaps, all straightforward. No blockers. Invariants (6), TOC (8 sections), frontmatter all correct.

#### Spec 13 — Observability Export

**R-142** [inconsistency] (13-observability-export, 07-api-surface)
Gauge updates rely on `reportGenerated` event (§3.1), which is a timeline event type (spec 10 §5.2), not an API event in spec 07 §9.2. The adapter subscribes to the event system but has no trigger for gauge updates after `assess()`.
**Proposed resolution:** Add `reportGenerated` event to spec 07 §9.2, or revise adapter to wrap `assess()` instead of subscribing.

**R-143** [inconsistency] (13-observability-export, 07-api-surface)
`context_lens.budget.violated` OTel event requires a `budgetViolation` event that doesn't exist in spec 07's event system.
**Proposed resolution:** Add `budgetViolation` event to spec 07, or clarify adapter monitors timeline.

**R-144** [gap] (13-observability-export)
`task_changes_total` counter increments on `taskChanged` events, but that event fires for both changes and refinements. No filtering logic described.
**Proposed resolution:** Add note: adapter filters by `transition.type === "change"`.

**R-147** [gap] (13-observability-export)
`compactions_total` and `restorations_total` counters — driving events not identified.
**Proposed resolution:** Add: driven by `segmentCompacted` and `segmentRestored` events.

**B7-13 note:** The core issue is that the adapter relies on events that don't exist in spec 07's event system (R-142, R-143). This is the same timeline-vs-events category confusion seen in R-096 and R-104. Invariants (6), TOC (7 sections), frontmatter all correct.

#### Spec 14 — Serialization

**R-150** [blocker] (14-serialization) — confirms R-014
Serializes pattern tracking state and history, directly contradicting spec 03 §2.5 "no serialization."
**Proposed resolution:** See R-014. Amend spec 03.

**R-151** [blocker] (14-serialization) — confirms R-037
Serializes task state, directly contradicting spec 04 invariant 4 "no serialization."
**Proposed resolution:** See R-037. Amend spec 04.

**R-152** [inconsistency] (14-serialization)
PatternTrackingState table (§4.6) missing `resolvedAt` field defined in spec 03 §2.5.
**Proposed resolution:** Add `resolvedAt: number | null` to §4.6 table.

**R-154** [inconsistency] (14-serialization)
`taskState` type references spec 07 §5.4 (8-field summary), but serialization needs the full spec 04 §4.4 representation (12 fields).
**Proposed resolution:** Change reference to spec 04 §4.4 and clarify full internal state is serialized.

**R-156** [gap] (14-serialization)
Restore step 5 mentions "transition history" but it's not a field in SerializedState, and neither spec's TaskState table includes it.
**Proposed resolution:** Add `taskTransitionHistory` field or clarify it's part of serialized `taskState`.

**R-158** [gap] (14-serialization)
Performance metrics (cumulative session counters) neither included nor explicitly excluded from serialization.
**Proposed resolution:** Add to §2.2 "Excluded State" with rationale, or include in §2.1.

**R-161** [gap] (14-serialization)
After restore, `getDiagnostics().latestReport` will be null even if original instance had reports. Not documented.
**Proposed resolution:** Add note to §5.5 (Restored Instance Behavior).

**R-163** [inconsistency] (14-serialization)
SerializedConfig (§4.2) omits `customPatterns` without noting it's handled separately in §4.7.
**Proposed resolution:** Add note to §4.2 explaining the intentional split.

**R-164** [editorial] (14-serialization)
`continuityLedger` typed `ContinuityEvent[]` here vs `ContinuityLedgerEntry[]` in spec 10. REVIEW.md tension #7.
**Proposed resolution:** See R-099.

**B7-14 note:** Two blockers (R-150, R-151) confirming the serialization contradictions already found from the spec 03/04 side. TaskState reference points to wrong spec (R-154). Multiple gaps in what's serialized vs documented.

---

## Phase 1 Summary

**Total unique findings: ~100** (some are confirmations of the same cross-spec issue from both sides)

### Blockers (7 unique issues)

| ID(s) | Specs | Issue |
|--------|-------|-------|
| R-008 | 02 | `protectionRelevance` formula structurally broken — multiplier vs clamp/floor |
| R-014, R-150 | 03, 14 | Spec 03 says "no serialization" for pattern history; spec 14 serializes it |
| R-026, R-054 | 04, 07 | `setTask` return type: void (spec 04, with rationale) vs `TaskTransition` (spec 07) |
| R-037, R-151 | 04, 14 | Spec 04 says "no serialization" for task state; spec 14 serializes it |
| R-069 | 08 | Saturation-driven eviction weights sum to 0.85, not 1.0 (violates invariant 8) |
| R-027, R-113 | 04, 07, 11 | `TransitionType` enum: `"set"/"clear"` (spec 04) vs `"new"/"same"` (specs 07, 11) |
| R-028, R-112 | 04, 07, 11 | `TaskLifecycleState` casing: lowercase (spec 04) vs UPPERCASE (specs 07, 11) |

### Systematic patterns

1. **Stale frontmatter status** — Specs 01, 02, 04, 05, 06 marked `draft` but declared "complete" in SEED_CONTEXT.md. Spec 03 marked `complete` but should be `complete (amended)`. Specs 07, 08, 10 should indicate amended state.

2. **"No serialization" claims vs spec 14** — Specs 03 (§2.5) and 04 (invariant 4) both explicitly deny serialization. Spec 14 serializes both. These specs predate spec 14 and were never amended.

3. **Section reference drift after amendments** — Spec 08 has 7 cross-references off by one (§5.6→5.7, §5.7→5.8, §5.8→5.9) due to §5.3 insertion. Spec 04 has wrong section numbers for spec 01 (§3.3→4.2, §3.4→4.5).

4. **TaskState divergence** — Three different definitions across specs 04 (12 fields), 07 (8 fields), 11 (hybrid). Field names differ even for identical concepts. This is the single biggest reconciliation task.

5. **Timeline vs event system confusion** — Timeline event types (spec 10) and API events (spec 07) are two different systems, but specs 09 and 13 reference events that only exist in one or neither.

6. **API catalog incomplete** — `getDiagnostics`, `planEviction`, formatting utilities, and several amended methods missing from spec 07's API categories table and method catalog.

### Phase 1 decisions (resolved during fix application)

1. **setTask return type** (R-026): → returns `TaskTransition` (spec 07 is API authority)
2. **TransitionType vocabulary** (R-027): → unified 5-value enum (`"new"`, `"refinement"`, `"change"`, `"same"`, `"clear"`)
3. **TaskLifecycleState casing** (R-028): → lowercase (`"unset"`, `"active"`)
4. **TaskState fields** (R-029): → canonical 14-field type across specs 04, 07, 11
5. **QualityReport field name** (R-108): → `continuity` (not `continuityLedger`)
6. **Serialization carve-outs** (R-014, R-037): → specs 03/04 amended to acknowledge spec 14
7. **Timeline vs events** (R-096): → 5 missing event types added to spec 07; timeline is a documented superset

---

## Phase 2 — Cross-Cutting Analysis (Passes 2–5)

**Phase 2 status: COMPLETE (2026-04-05)**

Four sweeps executed: S1 (8 known type tensions), S2 (remaining ~32 registry types), S3 (5 invariant chains), S4 (7 coverage gaps + API surface audit).

### S1: Known Type Tensions — Verification of Phase 1 Fixes

#### Verified (fixes confirmed applied)

- **Tension 4 (TaskState):** Canonical 14-field type consistent across specs 04, 07, 11. Field names, types, and counts all match.
- **Tension 5 (TaskSummary):** Added to spec 07, fields match spec 11 definition (state, stale, gracePeriodActive, gracePeriodRemaining).
- **Tension 6 (RedundancyInfo):** Spec 02 descriptive language maps correctly to spec 11's 3-field structure. Consistent.
- **Tension 7 (ContinuityEvent naming):** All specs (10, 11, 14) consistently use `ContinuityEvent`. No `ContinuityLedgerEntry` remains.
- **Tension 8 (EvictionCandidate.compaction):** Full union type `CompactionRecommendation | CompactionRecommendation[] | null` present in both specs 08 and 11.
- **TaskLifecycleState:** Lowercase (`"unset"`, `"active"`) everywhere.
- **TransitionType:** 5-value enum consistent across specs 04, 07, 11.
- **TaskTransition:** 3-field type consistent. `setTask` returns `TaskTransition` in all specs.
- **TaskDescriptor:** 4-field type consistent across specs 04, 07, 11.

#### Incomplete fixes (remaining inconsistencies)

**R-165** [inconsistency] (02, 07, 11)
WindowScores nullability not explicit in specs 02 and 07. Spec 11 §6.1 explicitly declares fields nullable for empty-window case (`number | null`). Spec 02 invariant 4 says "no windowScores" for empty window (ambiguous — absent or null?). Spec 07 §6.1 types fields as `number (0.0–1.0)`, non-nullable.
**Proposed resolution:** Add nullability annotation to specs 02 §9.2 and 07 §6.1 WindowScores tables. Clarify spec 02 invariant 4: "windowScores fields are `null`" (not absent).

**R-166** [inconsistency] (02, 07)
QualityReport in spec 02 §9.1 still missing 4 fields that specs 07 and 11 include: `rawScores`, `embeddingMode`, `patterns`, `task`. The `continuity` field name is correctly aligned (Phase 1 fix verified), but the field set expansion was not applied to spec 02.
**Proposed resolution:** Add the 4 fields to spec 02 §9.1 with cross-references to their defining specs. Add note that spec 07 extends the base report.

**R-167** [inconsistency] (07, 11)
TrendData `previousReportId` and `timeDelta` nullable in spec 07 (`string or null`, `number or null`) but non-nullable in spec 11 (Required: yes, Nullable: no). The entire `trend` field is null on first report (both specs agree), so when TrendData is present, these fields should always have values.
**Proposed resolution:** Either (a) remove nullable annotation from spec 07 (since trend is null on first report, not the fields within), or (b) make spec 11 nullable to match. Option (a) is semantically correct.

**R-168** [editorial] (04)
Spec 04 §5.1 inline TransitionType code block lists only 4 values, omitting `"clear"`. The formal table in §5.4 and all other specs include all 5 values.
**Proposed resolution:** Add `"clear"` to the inline code block in §5.1.

**R-169** [editorial] (11)
TransitionEntry type used in spec 11 §6.4 TaskState definition but not given its own field table in spec 11. Definition deferred to spec 04 §5.4. Architecturally correct but requires cross-spec lookup.
**Proposed resolution:** Either add a TransitionEntry table to spec 11 §6.4 or add explicit "defined in cl-spec-004 §5.4" reference.

### S2: Remaining Type Registry — Systematic Verification

#### Types verified consistent (no findings)

All 5 scoring/detection types — **SegmentScore**, **GroupScore**, **ContinuitySummary**, **DetectionResult**, **ActivePattern** — match across defining and consuming specs. 39 field checks, zero mismatches.

All 7 diagnostic/enrichment types — **DiagnosticSnapshot**, **ReportSummary**, **TimelineEntry**, **PerformanceSummary**, **PatternSummary**, **FleetReport**, **SerializedState** — match across all specs.

All 6 pattern/eviction types except EvictionPlan — **PatternSignature**, **RemediationHint**, **CompoundContext**, **PatternDefinition**, **EvictionCandidate**, **CompactionRecommendation** — match.

**TokenizerMetadata** — match (4 fields consistent across specs 06, 07, 11).

#### New findings

**R-170** [inconsistency] (01, 07, 14)
Segment `state` field (ACTIVE/EVICTED) not listed in spec 01 §4 core field table. State is described in §7 (Lifecycle) and referenced in invariants, but the field itself is missing from the defining type definition. Spec 07 returns it, spec 14 serializes it.
**Proposed resolution:** Add `state: "active" | "evicted"` to spec 01 §4.1 field table.

**R-171** [editorial] (01, 14)
Segment `position` field only appears in spec 14 §4.4 (SerializedSegment). Not mentioned in spec 01. Acceptable as a serialization-only field but undocumented origin.
**Proposed resolution:** Add note to spec 01 §3 that segment ordering is tracked internally via position index, referenced in serialization.

**R-172** [inconsistency] (01, 07, 14)
Group `state` field missing from spec 01 §5.1 definition table. Spec 07 §4.3 `getGroup()` returns it, spec 14 §4.5 serializes it. Same pattern as R-170 for segments.
**Proposed resolution:** Add `state: "active" | "dissolved"` to spec 01 §5.1 Group Identity table.

**R-173** [editorial] (01, 07)
Group `tokenCount` described only in spec 01 §5.2 (Aggregate Properties) as a computed value, not in §5.1 field table. Spec 07 §4.3 returns it as a required field. Semantically correct (it's derived) but presentation is inconsistent.
**Proposed resolution:** Add note to spec 01 §5.1 or §5.2 clarifying that `tokenCount` is a computed aggregate exposed by the API.

**R-174** [editorial] (06, 07, 11)
CapacityReport token-count fields typed as `number` in behavioral specs (06, 07) but `integer` in schema spec (11). Expected: behavioral specs use generic "number" (JS has no integer type); schema spec uses JSON Schema's `integer`. Not a true conflict.
**Proposed resolution:** Add parenthetical "(integer)" to token-count fields in spec 06 §4.5 for clarity, or note the convention once in spec 11.

**R-175** [editorial] (02, 07, 11)
BaselineSnapshot `segmentCount` and `tokenCount` typed `number` in specs 02/07, `integer` in spec 11. Same convention issue as R-174.
**Proposed resolution:** Same approach as R-174.

**R-176** [inconsistency] (08, 11)
EvictionPlan in spec 11 §5.1 includes `schemaVersion` field not documented in the defining spec 08 §4.2. Spec 11 is schema authority and adds `schemaVersion` to all top-level outputs, but spec 08 doesn't list it in its field table.
**Proposed resolution:** Add `schemaVersion` to spec 08 §4.2 EvictionPlan table, or add note that spec 11 decorates all output types with `schemaVersion`.

### S3: Cross-Spec Invariant Chains

#### Chain 1 — Determinism

**R-177** [blocker] (02, 07, 08)
Recency/age formulas use wall-clock time, directly contradicting determinism invariants. Spec 02 §5.4 recency formula: `age(i) = current time - segment[i].createdAt`. Spec 08 §2.1 age retention: `age(i) = now - max(segment.createdAt, segment.updatedAt)`. Both use `current time` / `now` (system clock), yet spec 02 invariant 2 says "scores do not depend on wall-clock time" and spec 07 invariant 3 says the same. Two `assess()` calls at different wall-clock times on identical window state produce different recency scores.
**Proposed resolution:** Replace `current time` with `report.timestamp` (the timestamp captured at assessment start). This makes recency a function of assessment-time metadata, not the system clock. Document that the report timestamp is the temporal reference point.

**R-178** [gap] (09)
Sampling seed hash function not specified. Spec 09 §5.1 says "seed derived from hash of sorted active segment ID set" but does not name the hash algorithm. Cross-implementation determinism requires a defined hash.
**Proposed resolution:** Specify the hash algorithm (e.g., FNV-1a, djb2, or CRC32 of concatenated sorted IDs). Or scope determinism to "within a single implementation" and document this.

**R-179** [inconsistency] (03, 07)
Custom pattern registration order affects detection result ordering and tie-breaking (spec 03 §10.5: "in registration order"), but neither spec 03 invariant 1 nor spec 07 invariant 3 lists registration order as a precondition for determinism.
**Proposed resolution:** Add registration order to the determinism invariant preconditions: "same segments, same patterns *in the same registration order*."

#### Chain 2 — Atomic Failure vs Fail-Open

**R-180** [gap] (03, 07)
Atomic failure definition (spec 07 invariant 2) does not explicitly classify `assess()`. Spec 07 lists mutating methods as `add, update, replace, compact, split, evict, restore, createGroup, dissolveGroup, setTask, clearTask`. `assess()` is absent — it's not a mutation, but it updates caches and pattern history. When a custom pattern's `detect()` throws, spec 03 §10.5 says fail-open (skip pattern, return report). This is compatible with atomic failure (which applies to mutations), but the contract is implicit.
**Proposed resolution:** Add explicit note to spec 07 invariant 2: "`assess()` is not a mutating method. It either returns a complete report or throws. Custom pattern failures within `assess()` are handled per cl-spec-003 §10.5 (fail-open) and do not cause `assess()` to fail."

**R-181** [gap] (03)
Custom pattern exception handling for non-`detect` functions (`severity`, `explanation`, `remediation`) deferred to spec 03 §10.3 fallbacks. While `detect()` has explicit fail-open, the other functions' error behavior is less prominently documented.
**Proposed resolution:** Add brief summary to §10.5: "For `severity`, `explanation`, and `remediation` failures, see §10.3 fallback behavior."

#### Chain 3 — Read-Only Consumers

**R-182** [inconsistency] (08, 10, 12, 13)
"Read-only consumer" invariant (specs 08, 10, 12, 13) is semantically ambiguous. `planEviction` (spec 08) triggers `assess()` which updates caches. `assessFleet` (spec 12) calls `assess()` on each instance. These update internal state (caches, report history) while claiming "read-only." The invariants are compatible under a narrow definition ("does not call segment-mutating methods"), but this definition is only explicit in spec 08's footnote, not in the invariant text.
**Proposed resolution:** Standardize the invariant wording across all 4 specs: "Read-only consumer: does not call segment-mutating methods (`add`, `update`, `replace`, `compact`, `split`, `evict`, `restore`) or configuration-mutating methods (`setTask`, `clearTask`, `setTokenizer`, `setEmbeddingProvider`). May call `assess()`, which updates internal caches but does not modify segments."

#### Chain 4 — Snapshot Isolation

Compatible. All 4 specs (02, 07, 10, 14) implement snapshot isolation via defensive copies. Reports are immutable after return. Caches not serialized, rebuilt on restore. Provider change detection on restore documented. No findings.

#### Chain 5 — Performance Budget + Custom Patterns

**R-183** [inconsistency] (03, 09)
Custom pattern execution time folded into `selfTime` without carve-out. Provider time gets a dedicated `providerTime` category (spec 09 §7) and is excluded from budget accountability. Custom pattern time — also caller-provided code — gets no equivalent treatment. A slow `detect()` causes `assess()` to exceed its 50ms budget, reported as context-lens's own time.
**Proposed resolution:** Add `customPatternTime` as a third timing category in spec 09 §8, alongside `selfTime` and `providerTime`. Exclude it from budget accountability. Add to spec 03 §10.5: "Custom pattern overhead is measured separately as `customPatternTime`."

**R-184** [inconsistency] (03, 09)
Sampling affects custom pattern input without explicit documentation. At n > 200, `assess()` produces reports with sampled topical concentration and density scores (spec 09 §5). Custom patterns receive this report (spec 03 §10.1 — "full QualityReport"). Spec 09 invariant 3 guarantees "pattern detection thresholds apply identically to sampled and non-sampled scores" but refers only to base patterns.
**Proposed resolution:** Add note to spec 03 §10.1: "Custom patterns receive the same QualityReport as base patterns, which may contain sampled (approximate) scores when n > 200 (cl-spec-009 §5). Custom pattern authors should design detection logic to be robust to score approximation."

**R-185** [gap] (09)
Spec 09 §2.1 (budget scope) does not mention custom pattern detection. Event listener execution is explicitly out of scope, provider calls explicitly out of scope, but custom pattern execution (also caller-provided code) is not categorized. This creates ambiguity about whether custom pattern time counts against the budget.
**Proposed resolution:** Add to spec 09 §2.1 Out of Scope: "Custom pattern `detect`, `severity`, `explanation`, and `remediation` functions (caller-provided code, analogous to provider calls)."

### S4: Coverage Gaps + API Surface Completeness

#### API surface audit: ALL 12 CHECKS PASS

1. Segment operations (8/8) — PASS
2. QualityReport fields — PASS
3. DetectionResult fields — PASS
4. Task operations (4/4) — PASS
5. Provider operations (4/4) — PASS
6. `registerPattern` — PASS
7. `toJSON`/`schemas`/`validate` — PASS
8. `snapshot`/`fromSnapshot` — PASS
9. `getDiagnostics` — PASS (spec 07 §8.7)
10. `planEviction` — PASS (spec 07 §8.8)
11. Events — PASS (24 API events; timeline is documented superset with `patternEscalated`/`patternDeescalated`)
12. Error types (13 types) — PASS

#### Coverage gaps

**R-186** [gap] (07)
No `destroy()` or `dispose()` method. Event handler deregistration has no centralized cleanup mechanism. Fleet registrations and OTel exporter subscriptions persist until their wrapper objects are garbage collected.
**Proposed resolution:** Document GC-based cleanup expectations in spec 07 §1 (Design Principles): "context-lens instances are designed for garbage-collected environments. No explicit disposal is needed. Callers managing OTel exporters or fleet registrations should unsubscribe/unregister before releasing references." Optionally add a `dispose()` convenience method that unsubscribes all handlers.

**R-187** [gap] (07)
Concurrency guarantees undefined. Spec 07 §9.3 states re-entrant calls have "undefined behavior" but this only covers event handlers. No statement about concurrent calls from separate async contexts (e.g., `assess()` racing `add()`). The library implicitly assumes single-threaded sequential access.
**Proposed resolution:** Add explicit concurrency statement to spec 07 §1 or §11: "context-lens assumes single-threaded, sequential access. Concurrent calls from multiple async contexts produce undefined behavior. Callers in async environments must serialize access to a single instance."

**R-188** [gap] (09)
No runtime memory release guidance. Spec 09 §6 estimates memory footprint but provides no mechanisms for clearing caches, trimming history, or releasing evicted content memory at runtime.
**Proposed resolution:** Add a brief note to spec 09 §6: "Memory is released when the instance is garbage collected. Cache sizes are bounded by construction-time configuration. History buffers are bounded by ring buffer limits (spec 10). No explicit cache-clearing API is provided in v1."

**R-189** [gap] (12, 14)
Fleet cannot be serialized. Spec 12 (Fleet Monitor) holds instance references with no `snapshot()`/`fromSnapshot()`. Restoring a fleet requires re-registering instances.
**Proposed resolution:** Document in spec 12 §1: "Fleet state is not serializable. To persist a fleet, serialize individual instances (cl-spec-014) and re-register after restoration."

**R-190** [gap] (13, 14)
OTel exporter not re-attached after `fromSnapshot()`. Serialization excludes event handlers and exporter subscriptions. Caller must manually re-attach.
**Proposed resolution:** Document in spec 14 §5.5 (Restored Instance Behavior): "Event handlers, fleet registrations, and OTel exporter subscriptions are not restored. Callers must re-attach these after `fromSnapshot()`."

---

## Phase 2 Summary

**Total Phase 2 findings: 26** (R-165 through R-190)

### Blockers (1 unique issue)

| ID | Specs | Issue |
|----|-------|-------|
| R-177 | 02, 07, 08 | Recency/age formulas use wall-clock time (`current time`, `now`) while invariants claim no wall-clock dependence. Determinism chain breaks. |

### Inconsistencies (10)

| ID | Specs | Issue |
|----|-------|-------|
| R-165 | 02, 07, 11 | WindowScores nullability not explicit in specs 02/07 (spec 11 is nullable) |
| R-166 | 02, 07 | QualityReport in spec 02 missing 4 fields present in specs 07/11 |
| R-167 | 07, 11 | TrendData field nullability disagrees (spec 07 nullable, spec 11 non-nullable) |
| R-170 | 01, 07, 14 | Segment `state` field missing from spec 01 core type definition |
| R-172 | 01, 07, 14 | Group `state` field missing from spec 01 core type definition |
| R-176 | 08, 11 | EvictionPlan `schemaVersion` in spec 11 but not spec 08 |
| R-179 | 03, 07 | Registration order affects detection but not in invariant preconditions |
| R-182 | 08, 10, 12, 13 | "Read-only consumer" definition ambiguous (narrow vs broad) |
| R-183 | 03, 09 | Custom pattern time folded into selfTime, no carve-out like providerTime |
| R-184 | 03, 09 | Sampling affects custom pattern input without documentation |

### Gaps (8)

| ID | Specs | Issue |
|----|-------|-------|
| R-178 | 09 | Sampling seed hash algorithm not specified |
| R-180 | 03, 07 | assess() classification (mutating vs non-mutating) implicit |
| R-181 | 03 | Custom pattern non-detect exception handling cross-ref missing |
| R-185 | 09 | Custom pattern detection not categorized in budget scope |
| R-186 | 07 | No instance disposal / cleanup API |
| R-187 | 07 | Concurrency guarantees undefined |
| R-188 | 09 | No runtime memory release guidance |
| R-189 | 12, 14 | Fleet serialization not supported (undocumented) |

### Editorials (5)

| ID | Specs | Issue |
|----|-------|-------|
| R-168 | 04 | Inline TransitionType omits "clear" |
| R-169 | 11 | TransitionEntry not tabled in spec 11 |
| R-171 | 01, 14 | Segment position field only in serialization |
| R-173 | 01, 07 | Group tokenCount presentation inconsistent |
| R-174, R-175 | 06, 02, 07, 11 | number vs integer convention mismatch (behavioral vs schema specs) |

### Coverage gap: R-190 (OTel re-attachment)

### Verified consistent (no findings needed)

**32 types verified across all consuming specs** with zero field mismatches:
SegmentScore, GroupScore, ContinuitySummary, DetectionResult, ActivePattern, PatternSignature, RemediationHint, CompoundContext, PatternDefinition, EvictionCandidate, CompactionRecommendation, TokenizerMetadata, DiagnosticSnapshot, ReportSummary, TimelineEntry, PerformanceSummary, PatternSummary, FleetReport, SerializedState, TaskState, TaskSummary, TaskDescriptor, TaskTransition, TransitionType, TaskLifecycleState, TransitionEntry, RedundancyInfo, ContinuityEvent, CapacityReport (modulo R-174), BaselineSnapshot (modulo R-175), EvictionPlan (modulo R-176), Segment (modulo R-170), Group (modulo R-172)

**Invariant chains verified compatible:**
- Snapshot isolation (specs 02, 07, 10, 14): fully compatible via defensive copies
- Atomic failure vs fail-open (specs 03, 07): compatible at different levels

**API surface completeness: 12/12 checks pass.** All public operations, types, events (24), and errors (13) present in spec 07.

### Phase 2 decisions (resolved — all recommendations approved)

1. **Wall-clock time in recency** (R-177): → replaced with `assessmentTimestamp` (report.timestamp)
2. **Custom pattern timing** (R-183): → added `customPatternTime` as third timing category
3. **Read-only definition** (R-182): → standardized narrow definition across specs 08/10/12/13
4. **number vs integer convention** (R-174/R-175): → convention noted in spec 11 §8.2

---

## Phase 3 — Deliverables

**Phase 3 status: COMPLETE (2026-04-05)**

### Amendments applied

32 edits across 12 specs, in dependency order:

| Spec | Edits | Findings resolved |
|------|:-----:|-------------------|
| 01 Segment Model | 4 | R-170 (state field), R-172 (group state), R-171 (position), R-173 (tokenCount) |
| 02 Quality Model | 4 | R-177 (recency formula + invariant), R-165 (WindowScores nullable + invariant) |
| 03 Degradation Patterns | 3 | R-184 (sampling note), R-181 (exception cross-ref), R-179 (registration order invariant) |
| 04 Task Identity | 1 | R-168 (inline TransitionType "clear") |
| 07 API Surface | 6 | R-165 (WindowScores), R-167 (TrendData), R-180 (assess invariant), R-182 (read-only), R-186 (disposal), R-187 (concurrency) |
| 08 Eviction Advisory | 3 | R-177 (age formula), R-176 (schemaVersion), R-182 (read-only) |
| 09 Performance Budget | 4 | R-183 (customPatternTime), R-185 (scope), R-178 (hash algorithm), R-188 (memory) |
| 10 Report & Diagnostics | 1 | R-182 (read-only) |
| 11 Report Schema | 2 | R-169 (TransitionEntry ref), R-174/R-175 (numeric convention) |
| 12 Fleet Monitor | 2 | R-182 (read-only), R-189 (serialization) |
| 13 Observability Export | 1 | R-182 (read-only) |
| 14 Serialization | 1 | R-190 (exporter re-attachment) |

**Note:** R-166 (QualityReport 4 missing fields in spec 02) was already applied during Phase 1 fix session. Phase 2 verification confirmed the fields are present.

### Type reconciliation table

Authoritative field list for every shared type in the master registry. Status reflects post-amendment state.

| Type | Authority | Fields | Consumed in | Status |
|------|-----------|:------:|-------------|--------|
| **Segment** | 01 §4.1 | 12 | 07, 14 | **Reconciled** — `state` added (R-170), `position` documented (R-171) |
| **Group** | 01 §5.1 | 10 | 07, 14 | **Reconciled** — `state` added (R-172), `tokenCount` clarified (R-173) |
| **QualityReport** | 02 §9.1 | 16 | 07, 11, 14 | **Reconciled** — 4 fields confirmed present, `continuity` naming verified |
| **WindowScores** | 02 §9.2 | 4 | 07, 11 | **Reconciled** — nullable in empty-window case (R-165) |
| **SegmentScore** | 02 §9.3 | 9 | 11 | Consistent |
| **GroupScore** | 02 §9.4 | 8 | 11 | Consistent |
| **ContinuitySummary** | 02 §9.5 | 8 | 07, 11 | Consistent |
| **TrendData** | 02 §9.6 | 9 | 07, 11 | **Reconciled** — fields non-nullable, entire object null on first report (R-167) |
| **BaselineSnapshot** | 02 §7.5 | 7 | 07, 11, 14 | Consistent (integer convention noted in spec 11) |
| **DetectionResult** | 03 §2.3 | 4 | 07, 11 | Consistent |
| **ActivePattern** | 03 §2.3 | 10 | 10, 11, 13 | Consistent |
| **PatternSignature** | 03 §2.3 | 4 | 11 | Consistent |
| **RemediationHint** | 03 §2.3 | 4 | 11 | Consistent |
| **CompoundContext** | 03 §8.2 | 4 | 11 | Consistent |
| **PatternDefinition** | 03 §10.2 | 8 | 07 | Consistent |
| **TaskDescriptor** | 04 §2.1 | 4 | 07, 11 | Consistent |
| **TaskState** | 04 §4.4 | 14 | 07, 11 | Consistent (Phase 1 reconciliation verified) |
| **TaskTransition** | 07 §5.1 | 3 | 04, 11 | Consistent |
| **TaskSummary** | 11 §6.4 | 4 | 07 | Consistent |
| **TransitionType** | 11 §7.8 | 5 values | 04, 07 | Consistent (R-168: inline "clear" added) |
| **TaskLifecycleState** | 11 §7.7 | 2 values | 04, 07 | Consistent (lowercase everywhere) |
| **TransitionEntry** | 04 §5.4 | 5 | 07, 11 | **Reconciled** — cross-ref added to spec 11 (R-169) |
| **RedundancyInfo** | 11 §6.1 | 3 | 02 | Consistent |
| **ContinuityEvent** | 11 §6.1 | 7 | 10, 14 | Consistent (name unified in Phase 1) |
| **CapacityReport** | 06 §4.5 | 8 | 07, 11 | Consistent (integer convention noted in spec 11) |
| **TokenizerMetadata** | 06 §2.2 | 4 | 07, 11 | Consistent |
| **EvictionPlan** | 08 §4.2 | 15 | 11 | **Reconciled** — `schemaVersion` added (R-176) |
| **EvictionCandidate** | 08 §4.3 | 13 | 11 | Consistent (compaction polymorphism verified) |
| **CompactionRecommendation** | 08 §9.2 | 7 | 11 | Consistent |
| **DiagnosticSnapshot** | 10 §2.2 | 15 | 11, 14 | Consistent |
| **ReportSummary** | 10 §3.1 | 11 | 11, 14 | Consistent |
| **TimelineEntry** | 10 §5.1 | 4 | 11, 14 | Consistent |
| **PerformanceSummary** | 10 §6.1 | 5 | 11 | Consistent |
| **PatternSummary** | 10 §4.1 | 5 | 11 | Consistent |
| **FleetReport** | 12 §5.1 | 11 | — | Consistent (standalone) |
| **SerializedState** | 14 §4.1 | 22 | 07 | Consistent |

**36 types. 7 reconciled (amendments applied). 29 verified consistent. 0 remaining discrepancies.**

### Sign-off

The context-lens design spec corpus (14 specs, 5 amendments) has been reviewed across three phases:

- **Phase 1** (internal consistency): ~100 findings, 7 blockers resolved, all fixes applied
- **Phase 2** (cross-cutting analysis): 26 findings, 1 blocker resolved, all fixes applied
- **Phase 3** (deliverables): 32 amendments across 12 specs, type reconciliation table complete

**All blockers resolved. All types reconciled. API surface complete. Invariant chains verified.**

The corpus is internally consistent and ready for implementation spec writing.

