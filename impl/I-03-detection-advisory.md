# Phase 3 -- Detection, Advisory, and Performance

## 1. Preamble

Phase 3 builds the detection, eviction advisory, and performance measurement layers on top of Phase 2's scoring engine (similarity, embedding, task, 4 dimension scorers, baseline, composite, quality-report). After Phase 3, context-lens can detect degradation patterns, plan evictions with quality-aware ranking, and measure its own performance against budget targets -- but the public `ContextLens` class, diagnostics assembly, and enrichments remain for Phases 4 and 5.

**Design specs covered:**
- `cl-spec-003` (Degradation Patterns) -- 5 base patterns, compounds, hysteresis, custom registration, suppression, configuration
- `cl-spec-008` (Eviction Advisory) -- 5-signal ranking, protection tiers, strategies, auto-selection, groups, bridge scores, compaction
- `cl-spec-009` (Performance Budget) -- budget tiers, provider latency separation, measurement infrastructure, sampling parameters

**Performance budget:** `cl-spec-009` -- planEviction < 100ms at n<=500, pattern detection adds negligible overhead to assess(), custom pattern time excluded from budget accountability

**Key resolutions referenced:**
- R-177: `assessmentTimestamp` flows through from quality report to age computation in eviction ranking
- R-178: FNV-1a for all non-cryptographic hashing (sampling seeds, cache keys)
- OQ-007: Resolved -- five budget tiers, not a single number (cl-spec-009 SS2.3)
- OQ-009: Resolved -- custom pattern `detect` receives the full `QualityReport`, not a simplified view (cl-spec-003 SS10.1)

**Parent document:** `IMPLEMENTATION.md` (section 5, Phase 3 row; section 4, dependency graph)

---

## 2. Module Map

| Module | Primary design spec | Responsibility |
|--------|-------------------|----------------|
| `detection` | cl-spec-003 | Pattern framework: 5 base patterns, hysteresis state machine, compound detection, custom pattern registration and execution, pattern history, suppression, threshold configuration |
| `eviction` | cl-spec-008 | 5-signal ranking model, strategy-adjusted weights, auto-selection from active patterns, protection tier partitioning, group handling, bridge score computation, compaction recommendations, plan assembly |
| `performance` | cl-spec-009 | Per-operation timing with 3-way decomposition, budget violation detection, timing history ring buffer, sampling parameter computation |

---

## 3. Dependency Direction

```
                    ┌──────────┐
                    │ eviction │
                    └────┬─────┘
                         │
            ┌────────────┼─────────────┐
            │            │             │
            v            v             v
     ┌──────────┐  ┌──────────┐  ┌──────────────┐
     │detection │  │quality-  │  │  similarity  │
     │          │  │report    │  │ (skip-sim)   │
     └────┬─────┘  └────┬─────┘  └──────────────┘
          │              │
          v              v
     ┌──────────────────────────────────────────────────┐
     │  Phase 2: quality-report, scoring/*, similarity,  │
     │           embedding, task                         │
     └──────────────────────────────────────────────────┘
                         │
     ┌──────────────────────────────────────────────────┐
     │  Phase 1: segment-store, tokenizer, events,       │
     │           utils/ (hash, lru-cache, ring-buffer,   │
     │           copy), types, errors                    │
     └──────────────────────────────────────────────────┘

     ┌─────────────┐
     │ performance │  (standalone -- imported by index in Phase 4,
     └─────────────┘   wired into operation entry/exit points)
```

**Rules (from IMPLEMENTATION.md SS4, extended):**
- No circular imports.
- No upward imports: lower layers never import higher layers.
- `detection` imports `quality-report` (for the `QualityReport` type), `task` (for `taskDescriptorSet` flag), `types`, `errors`, `events`, and `utils/`. It does not import any `scoring/*` module directly -- it reads pre-computed scores from the quality report.
- `eviction` imports `detection` (for `DetectionResult` and active pattern data), `quality-report` (for report and per-segment scores), `similarity` (for skip-similarity computation in bridge scores), `types`, `errors`, `events`, and `utils/`. It does not import any `scoring/*` module directly.
- `performance` imports only `types`, `errors`, and `utils/` (ring-buffer, hash). It is a standalone measurement utility with no dependency on scoring, detection, or eviction. Phase 4 wires it into the `ContextLens` class as entry/exit instrumentation around each public operation.
- `detection` does not import `eviction`. `eviction` imports `detection`. This is a strict one-way dependency -- detection diagnoses, eviction prescribes.
- `performance` does not import `detection` or `eviction`. It provides timing infrastructure; the wiring happens in Phase 4.

---

## 4. Module Specifications

### 4.1 detection

**Responsibilities:**

- **Pattern framework architecture.** Receive a `QualityReport` (produced by Phase 2's `quality-report` module) and the current detection state (pattern history, hysteresis state, configuration). Evaluate all non-suppressed patterns against the report's window scores, capacity metrics, trend data, and per-segment scores. Produce a `DetectionResult` containing the ordered list of active patterns, highest severity, pattern count, and pre-baseline flag. The detection pass runs as the final step of report generation (cl-spec-003 SS2.2) -- after all scores and trends are finalized but before the report is returned to the caller. Detection is side-effect free with respect to the quality report: it reads the report, appends pattern results to it, but does not alter any existing field (cl-spec-003 invariant 2).

- **5 base patterns.** Each base pattern is an internal function that evaluates a specific failure mode against the quality report. The five patterns and their input signatures:

  1. **Saturation.** Primary signal: `capacity.utilization` from the quality report's capacity section. Secondary signals: headroom, totalActiveTokens, capacity, pinnedTokens, seedTokens, managedTokens, and `trend.tokensDelta`. Saturation is quality-independent -- it does not read any dimension score (cl-spec-003 invariant 4). Thresholds: watch > 0.75, warning > 0.85, critical > 0.95 (utilization ascending). Rate-based early activation at watch: project utilization 3 reports ahead using `tokensDelta / capacity`, activate at watch if projected utilization > 0.75 and current utilization <= 0.75. Rate-based activation requires trend data (skipped on first report). Remediation hints enumerate default-segment eviction, seed compaction, low-priority eviction, and capacity increase -- filtered by availability and ordered by token reclamation (cl-spec-003 SS3.5).

  2. **Erosion.** Compound pattern requiring both gates open simultaneously: density below threshold AND utilization above threshold. Thresholds: watch (density < 0.7, utilization > 0.7), warning (density < 0.5, utilization > 0.8), critical (density < 0.3, utilization > 0.9). Neither gate alone is sufficient (cl-spec-003 SS4.1). Rate-based elevation: `densityDelta < -0.15` elevates severity by one level, but only when the utilization gate is also met (cl-spec-003 SS4.3). Hysteresis applies to each gate independently -- either gate closing (with margin) deactivates the pattern. Diagnostic output includes the top-10 redundancy offenders ordered by token waste, with partner segment identification and origin-match annotation (cl-spec-003 SS4.4).

  3. **Fracture.** Single-signal pattern on `windowScores.coherence`. Thresholds: watch < 0.6, warning < 0.4, critical < 0.2. Secondary cluster-count trigger: if `clusterRatio > 0.5` (derived as `clusterCount / segmentCount`, where `clusterCount = round(1.0 / topicalConcentration)`), severity is elevated by one level. The cluster-count trigger can only elevate, not activate independently -- coherence must already be below the watch threshold (cl-spec-003 SS5.3). Rate-based elevation: `coherenceDelta < -0.15` elevates by one level. Diagnostic output includes the adjacency break map -- pairs of adjacent segments with similarity < 0.3 -- and group integrity alerts for groups with coherence < 0.3 (cl-spec-003 SS5.4).

  4. **Gap.** Hybrid pattern. Hard prerequisite: `taskDescriptorSet` must be true; when false, gap is suppressed entirely (structural, not configurable) (cl-spec-003 invariant 5). Watch level: relevance < 0.6 (no utilization gate). Warning: relevance < 0.4 AND utilization > 0.6. Critical: relevance < 0.3 AND utilization > 0.8. Task transition grace period: when `setTask` was called within the last 2 quality reports, severity is capped at watch regardless of absolute scores (cl-spec-003 SS6.3). Rate-based elevation (`relevanceDelta < -0.15`) is suppressed during the grace period. Diagnostic output includes the top-10 lowest-relevance segments ranked by token cost, with origin and protection metadata (cl-spec-003 SS6.4).

  5. **Collapse.** Single-signal pattern on `windowScores.continuity`. Thresholds: watch < 0.7, warning < 0.5, critical < 0.3. Collapse has a stricter rate-of-decline trigger: `continuityDelta < -0.10` (not the general 0.15) elevates severity by one level (cl-spec-003 SS7.3). Acute collapse trigger: a single eviction event contributing > 0.15 to net loss triggers immediate warning regardless of absolute continuity score (inspected via `continuityLedger.recentEvents`). Diagnostic output includes loss forensics: totalEvictionCost, totalCompactionCost, totalRecovery, netLoss, worst eviction, evictedRetained vs evictedDiscarded counts, and recentLossRate (cl-spec-003 SS7.4).

- **Hysteresis state machine.** Each pattern (base and custom) maintains a hysteresis state that determines whether a threshold crossing represents activation, deactivation, or is absorbed by the dead zone. Three severity levels (watch, warning, critical). The hysteresis margin defaults to 0.03, configurable in [0.01, 0.10] (cl-spec-003 SS9.3). The mechanics:
  - For score-based patterns (fracture, collapse, gap relevance, erosion density): activation when `score < threshold`, deactivation when `score > threshold + margin`.
  - For utilization-based patterns (saturation, erosion utilization, gap utilization): activation when `utilization > threshold`, deactivation when `utilization < threshold - margin`.
  - Escalation (lower severity to higher) is immediate when the score crosses the next threshold. De-escalation requires recovery past threshold plus margin. This asymmetry ensures worsening is reported immediately while improvement must be confirmed.
  - The hysteresis margin is validated against threshold separation at initialization: the margin must be strictly less than the smallest gap between adjacent severity thresholds across all non-suppressed patterns (cl-spec-003 SS9.3).

- **6 compound patterns.** After all 5 base patterns are evaluated for the current report, the detection framework evaluates pairwise and higher-order combinations among active base patterns. Compounds are checked against a fixed table of 6 known combinations (cl-spec-003 SS8.2): `fullOfJunk` (saturation + erosion), `fullOfWrongThings` (saturation + gap), `scatteredAndIrrelevant` (fracture + gap), `lossDominates` (collapse + any), `pressureLoop` (collapse + saturation), `triplePressure` (saturation + erosion + gap). When a compound is detected, each participating pattern's `ActivePattern` entry receives a `compoundContext` field containing the compound identifier, co-patterns, diagnosis, and remediation shift. Compound context is informational -- it does not change severity, thresholds, or remediation hints. Suppressed patterns cannot participate in compounds (cl-spec-003 SS9.2).

- **Custom pattern registration.** The `registerPattern` method accepts a `PatternDefinition` object with 6 required fields (`name`, `description`, `detect`, `severity`, `explanation`, `remediation`) and 2 optional fields (`strategyHint`, `priority`). Validation at registration time (cl-spec-003 SS10.3): name must be non-empty, must not collide with base pattern names or already-registered custom names (case-sensitive), functions must be callable, priority must be a positive integer if provided (default 1000), strategyHint must be one of 4 values if provided. Registration is append-only in v1 -- no unregister. Construction-time registration via `customPatterns` config array is all-or-nothing: any validation failure rejects all patterns.

- **Custom pattern execution.** During detection, each registered non-suppressed custom pattern executes in registration order (cl-spec-003 SS10.5). The framework calls `detect(report)` with a defensive copy of the quality report. If it returns a `PatternSignal`, the framework calls `severity(report, previousSeverity)`, applies hysteresis (2-cycle deactivation for custom patterns, since they produce boolean signals rather than continuous scores -- cl-spec-003 SS10.6), and if active calls `explanation(report)` and `remediation(report)`. Fail-open execution: if any custom function throws, the framework catches the error, emits a diagnostic warning, and treats the cycle as if `detect` returned null. Other patterns (base and custom) are unaffected (cl-spec-003 invariant 14). Custom patterns receive the previous cycle's detection result via the quality report's `patterns` field, introducing a one-cycle lag that prevents detection order from affecting results (cl-spec-003 SS10.8).

- **Pattern history tracking.** The detection framework maintains a per-pattern tracking state for each active or recently-resolved pattern (cl-spec-003 SS2.5): activatedAt, currentSeverity, severitySince, peakSeverity, peakAt, resolvedAt, reportCount, scoreHistory (ring buffer of last 20 primary scores). Resolved pattern entries are retained for the session lifetime for diagnostics and recurrence detection. The `trending` field (worsening, stable, improving) is derived from the last 3 entries in scoreHistory: declining = worsening, improving = improving, fluctuating within +/-0.03 = stable. The pattern history is session-scoped -- each new instance starts with empty history. Serialization (Phase 5) can preserve it across sessions.

- **Suppression.** The `suppressedPatterns` configuration array (set at initialization, session-scoped) disables specific patterns entirely. A suppressed pattern is not computed, produces no output, does not participate in compounds, and does not contribute to `highestSeverity` or `patternCount` (cl-spec-003 invariant 9). Suppression accepts both base and custom pattern names. Suppressing a custom pattern name before registration is valid -- the suppression takes effect on registration.

- **Threshold overrides.** The `thresholds` configuration object (set at initialization, session-scoped) overrides default activation thresholds for any subset of base patterns and severity levels (cl-spec-003 SS9.1). Validation: score-direction ordering (watch > warning > critical for coherence/density/relevance/continuity), utilization-direction ordering (watch < warning < critical), range [0.0, 1.0], minimum separation of 0.05 between adjacent severity levels. Invalid configurations are rejected at initialization with a descriptive error. Threshold overrides do not affect rate-based elevation, secondary triggers (cluster ratio, acute collapse), or compound conditions.

- **Detection ordering in the patterns array.** The output `patterns` array is sorted by priority ascending (cl-spec-003 SS8.3): collapse=1, saturation=2, gap=3, erosion=4, fracture=5, custom patterns at their configured priority (default 1000). Within the same priority, patterns are sorted by severity descending. The `highestSeverity` field is the maximum severity across all active patterns (base and custom). The `patternCount` is the total count of active patterns.

- **Empty window and pre-baseline.** If `segmentCount` is 0, detection returns an empty result (no active patterns). If `baselineEstablished` is false, detection operates on raw scores with `preBaseline: true` in the result (cl-spec-003 SS2.2).

**Key design decisions:**
- Detection is a pure consumer of the quality report. It performs no similarity computation, no embedding lookup, and no content inspection. Every input is a pre-computed value from the report or capacity metrics. This is the performance guarantee -- detection is a thin classification layer, not a second scoring pass (cl-spec-003 invariant 10).
- The detection framework's only mutable state is its own pattern history and hysteresis state. It does not modify segments, scores, or any external state (cl-spec-003 invariant 2).
- Determinism: same quality report + same pattern history + same custom pattern set in the same registration order = same detection result. No randomness, no wall-clock dependency (timestamps come from the quality report) (cl-spec-003 invariant 1).
- Custom pattern functions receive a defensive copy of the report to prevent mutation. Each custom pattern sees the same report regardless of what other custom patterns did with their copy (cl-spec-003 invariant 15).
- The 2-cycle deactivation rule for custom patterns replaces score-margin hysteresis because custom patterns produce boolean signals (PatternSignal or null) rather than continuous scores (cl-spec-003 SS10.6).
- Causal context annotations are added to downstream patterns when an upstream pattern is active in the same report (e.g., saturation active => collapse gets elevated-risk annotation). These annotations are informational and do not change activation logic (cl-spec-003 SS8.1).

**Integration points:**
- `quality-report` calls detection as the final step of report assembly. Detection receives the complete report (all scores, trends, capacity) and appends the `DetectionResult`.
- `eviction` reads the detection result to drive strategy auto-selection (which pattern is active, at what severity, with what compound context).
- Phase 4 (`diagnostics`) reads pattern history for timeline and forensic output.
- Phase 4 (`index`) exposes `registerPattern` on the public API.
- `task` module provides `taskDescriptorSet` and grace period state, read by gap pattern logic.

---

### 4.2 eviction

**Responsibilities:**

- **5-signal ranking model.** Each evictable segment receives an eviction score in [0.0, 1.0] computed as a weighted arithmetic mean of 5 signals, each normalized to [0.0, 1.0] (cl-spec-008 SS2.1). Lower scores mean better eviction candidates. The five signals and their derivation from the quality report:

  1. **Relevance retention** (weight 0.30): `qualityReport.segments[i].relevance`. Used directly. When no task is set, all segments score 1.0 and the signal drops out of the ranking (cl-spec-008 SS2.2).
  2. **Information loss** (weight 0.25): `qualityReport.segments[i].density`. A segment with density 0.2 (80% redundant) has information loss 0.2 -- cheap to remove. A segment with density 0.95 has information loss 0.95 -- expensive to remove (cl-spec-008 SS2.2).
  3. **Coherence contribution** (weight 0.20): the bridge score, computed from adjacency similarities. Interior segments: `bridgeScore(i) = clamp(avgNeighborSim - skipSim, 0.0, 1.0)` where `avgNeighborSim = (similarity(i-1, i) + similarity(i, i+1)) / 2.0` and `skipSim = similarity(i-1, i+1)`. First and last segments: bridge score 0.0. Single-segment window: bridge score 0.0 (cl-spec-008 SS7.2).
  4. **Importance signal** (weight 0.15): `segment.importance`. Used directly (cl-spec-008 SS2.2).
  5. **Age retention** (weight 0.10): `1.0 - (age(i) / maxAge)` where `age(i) = assessmentTimestamp - max(segment.createdAt, segment.updatedAt)` and `maxAge` is the age of the oldest active segment. The `assessmentTimestamp` is the quality report's timestamp, per R-177. Age computation does not depend on the system clock (cl-spec-008 SS2.2).

  Weights sum to 1.0. Weights are not configurable -- callers use protection tiers for hard overrides and importance for soft overrides (cl-spec-008 SS2.3). The arithmetic mean (not geometric) is used so that no single signal at zero forces the eviction score to zero (cl-spec-008 SS2.3).

- **Strategy-adjusted weights.** When a planning strategy is pattern-driven, the signal weights are adjusted to amplify the signal most relevant to the active pattern (cl-spec-008 SS2.4):

  | Strategy | w_r | w_d | w_c | w_i | w_a | Rationale |
  |----------|-----|-----|-----|-----|-----|-----------|
  | Default | 0.30 | 0.25 | 0.20 | 0.15 | 0.10 | Balanced |
  | Saturation | 0.20 | 0.30 | 0.15 | 0.15 | 0.20 | Tokens matter most |
  | Erosion | 0.20 | 0.40 | 0.15 | 0.15 | 0.10 | Target redundancy |
  | Gap | 0.45 | 0.20 | 0.10 | 0.15 | 0.10 | Target irrelevance |
  | Collapse | 0.25 | 0.25 | 0.25 | 0.15 | 0.10 | Preserve coherence |

  All rows sum to 1.0. The saturation strategy additionally applies a token-size tie-breaking rule: among candidates with eviction scores within 0.05, prefer the higher token count (cl-spec-008 SS2.4).

- **Auto-selection.** When the caller passes `strategy: "auto"` (the default) or omits the field, the advisory selects a strategy using a 3-phase deterministic algorithm (cl-spec-008 SS5.3):
  - **Phase 1:** Collect active patterns from the quality report's detection result. If none, resolve to `"default"`.
  - **Phase 2:** Check for compound patterns among active base patterns against the 6 known compounds. Compound precedence: most participating patterns wins; ties broken by highest-priority participant. The compound-to-strategy mapping: `fullOfJunk` => erosion, `fullOfWrongThings` => gap, `scatteredAndIrrelevant` => gap, `lossDominates` => collapse, `pressureLoop` => collapse, `triplePressure` => gap.
  - **Phase 3:** If no compound, select strategy by highest-priority active pattern: collapse => collapse, saturation => saturation, gap => gap, erosion => erosion, fracture => default. Custom patterns participate in Phase 3 via `strategyHint`: `"token-focused"` => saturation weights, `"redundancy-focused"` => erosion weights, `"relevance-focused"` => gap weights, `"coherence-preserving"` => collapse weights, no hint => default weights. Custom patterns default to priority 1000 and only drive selection when no base patterns are active.
  - The resolved strategy (never `"auto"`) is recorded in the plan's `strategy` field (cl-spec-008 invariant 9).

- **Protection tier partitioning.** Candidates are partitioned into strict tiers before ranking (cl-spec-008 SS3.1). The tier order is: default (evicted first) < priority(0) < priority(1) < ... < priority(999) < seed (evicted last). Pinned segments are excluded entirely -- they are never scored, never ranked, and never appear in the plan (cl-spec-008 invariant 4). Within each tier, candidates are sorted by eviction score ascending. The advisory exhausts each tier before considering the next. Priority sub-ordering uses a compound sort key `(n ascending, evictionScore ascending)` in a single pass, not nested buckets (cl-spec-008 SS3.2). Group protection uses the effective protection -- the maximum of the group-level protection and the strongest member-level protection (cl-spec-008 SS3.5).

- **Group handling.** Grouped segments do not appear individually. The advisory replaces each group's members with a single group candidate (cl-spec-008 SS6.1). Group eviction score is the token-weighted mean of member eviction scores: `evictionScore(group) = sum(evictionScore(member_i) * tokenCount(member_i)) / sum(tokenCount(member_i))` (cl-spec-008 SS6.2). Overshoot penalty: when a group candidate's tokenCount exceeds `remainingTarget * 2.0` and sufficient non-group candidates exist in the same tier to meet the target, the group is deferred (cl-spec-008 SS6.3). Deferral is within-tier only -- protection tier ordering is inviolable. Group impact estimation computes coherence delta by removing all members simultaneously, accounting for adjacency changes (O(m) per group) (cl-spec-008 SS6.4). Groups with internal coherence < 0.3 receive a dissolution hint annotation (cl-spec-008 SS6.5).

- **Bridge score computation.** The coherence contribution signal is computed during plan generation, not during assessment. Skip similarities (`similarity(i-1, i+1)` for interior segments) are computed on demand using the similarity module -- O(1) per segment (one similarity lookup or computation), O(n) total for the window. Skip similarities are transient: not cached, not reused between plans. Left/right neighbor similarities are read from the quality report's cached adjacency data. The bridge score formula is `clamp(avgNeighborSim - skipSim, 0.0, 1.0)`. For groups, contiguous groups use the single-segment formula on the group's boundary segments; non-contiguous groups use the maximum of member bridge scores (cl-spec-008 SS7.2, SS7.5).

- **Compaction recommendations.** The advisory can recommend compaction instead of eviction when conditions are met (cl-spec-008 SS9.1): candidate not already compacted (origin != `"summary:compacted"`), not pinned, estimated savings meet the remaining target or the candidate is a seed, and `includeCompactionAlternatives` is true. Savings estimation uses a target compression ratio of 0.5: `estimatedTargetTokens = ceil(currentTokens * 0.5)`, `estimatedSavings = currentTokens - estimatedTargetTokens`. Minimum savings threshold: estimated savings must be >= 20% of the segment's token count. Compaction continuity cost uses the formula from cl-spec-002 SS6.3: `compressionRatio * importance * (1.0 - redundancy)`. Strategy-specific biases: saturation prefers eviction (certain reclamation), collapse prefers compaction (minimize loss), erosion recommends compaction for moderate redundancy (0.5--0.8), default and gap have no bias (cl-spec-008 SS9.6). For group candidates, the advisory produces an array of per-member `CompactionRecommendation` objects, excluding already-compacted members. If all members are compacted, the recommendation reverts to eviction (cl-spec-008 SS9.5).

- **Plan assembly.** The `planEviction(options?)` method (cl-spec-008 SS4.1) accepts `PlanOptions` with optional `targetTokens` or `targetUtilization` (mutually exclusive), `strategy` (default "auto"), `maxCandidates` (default 50), and `includeCompactionAlternatives` (default true). If neither target is provided, the default target is utilization 0.75 (the saturation watch threshold). The method obtains a fresh quality report (reusing cached if valid), filters pinned segments, partitions by tier, computes eviction scores with strategy-adjusted weights, sorts within tiers, walks the sorted list accumulating token reclamation until the target is met or all candidates are exhausted, computes per-candidate quality impact estimates, generates compaction alternatives, and assembles the `EvictionPlan`. The plan is a snapshot data object with no live reference to the instance (cl-spec-008 invariant 6). Plan fields: schemaVersion, planId, timestamp, strategy, target (tokens, utilizationBefore, utilizationAfter), candidates, candidateCount, totalReclaimable, targetMet, shortfall, seedsIncluded, exhausted, qualityImpact, patterns, reportId.

- **Per-candidate impact estimation.** Each candidate carries a `CandidateImpact` with projected deltas for coherence, density, relevance, continuity, and composite. These are first-order approximations: each candidate scored independently, interactions not modeled (cl-spec-008 invariant 10). Continuity cost is exact (eviction cost formula from cl-spec-002 SS6.2, additive and interaction-free). Coherence, density, and relevance deltas are heuristic. Plan-level `qualityImpact` projects the end state if all candidates are evicted -- also a first-order approximation. Composite is recomputed from projected dimension scores using the geometric mean formula.

- **Tie-breaking cascade.** When two candidates have identical eviction scores (after rounding to 4 decimal places), a deterministic cascade applies (cl-spec-008 SS2.5): protection tier (lower first) => importance (lower first) => relevance (lower first) => token count (higher first) => creation timestamp (older first) => segment ID (lexicographic ascending). The cascade is evaluated lazily -- step N only if steps 1 through N-1 tied.

- **Strategy-specific behavioral rules.** Beyond weight adjustment, each strategy imposes additional rules (cl-spec-008 SS5.4--5.8):
  - **Saturation:** Token-size tie-breaking within 0.05 score bands. Eviction over compaction bias. Headroom annotation when target brings utilization within 0.10 of saturation watch.
  - **Erosion:** Redundancy-pair annotation (partner identification for redundancy > 0.5). Pair-aware ordering -- near-duplicate pairs (redundancy > 0.8) include only the worse candidate; the partner is omitted. Compaction for moderate redundancy (0.5--0.8).
  - **Gap:** Relevance-band annotation (irrelevant/marginally/moderately/relevant). Coherence penalty cap at 0.3 for candidates with relevance < 0.3. Task transition caution annotation.
  - **Collapse:** Compaction over eviction bias (for non-compacted segments with savings > 20%). Continuity floor guard -- exclude candidates whose eviction would push projected continuity below the collapse critical threshold (default 0.3), with cumulative tracking. Eviction cost annotation on each candidate's reason.

**Key design decisions:**
- The eviction advisory is a read-only consumer. It may trigger `assess()` to obtain fresh quality data, but it does not call any segment-mutating method (cl-spec-008 invariant 1). It reads the quality report and detection result, computes rankings, and assembles a plan.
- The advisory computes no scores from scratch. All input signals are pre-computed by the quality model. The one exception is the bridge score, which requires skip-similarity computation -- but this is a single O(n) pass of similarity lookups (mostly cached), not a second scoring pass.
- Determinism: same quality report + same PlanOptions + same timestamp = same plan. No randomness, no hash-order dependency. The tie-breaking cascade ensures total ordering (cl-spec-008 invariant 2).
- The advisory does not call LLMs and does not generate summaries. Compaction recommendations say what to compact and estimate the savings; the caller generates the summary (cl-spec-008 invariant 12).
- Plan staleness is the caller's responsibility. Plans are snapshots. Any mutation after plan generation invalidates assumptions. The recommended pattern is plan-execute-replan (cl-spec-008 SS4.5).
- The 0.5 compression ratio for compaction estimation is a fixed internal parameter, not configurable. It is a conservative middle-of-the-range estimate (cl-spec-008 SS9.3).

**Integration points:**
- `detection` provides the active pattern set and compound context that drive strategy auto-selection.
- `quality-report` provides all per-segment scores, window scores, capacity metrics, and trend data consumed by the ranking model.
- `similarity` provides skip-similarity computation for bridge scores. Adjacency similarities are read from the quality report's cached data.
- Phase 4 (`index`) exposes `planEviction` on the public API and wires eviction plan events.
- `segment-store` provides segment metadata (protection, importance, group membership, timestamps) consumed by tier partitioning and signal derivation.

---

### 4.3 performance

**Responsibilities:**

- **Per-operation timing.** Provide a timing harness that wraps each public method invocation. The harness captures a start timestamp (via `performance.now()` in Node.js or equivalent high-resolution timer), yields to the operation, captures an end timestamp, and records the timing record. The timing record contains: operation name, selfTime, providerTime, customPatternTime, totalTime, segmentCount at operation start, cacheHits, cacheMisses, timestamp, budgetExceeded flag, and budgetTarget (cl-spec-009 SS8.1). The overhead of timing itself is < 0.01ms per operation (two `performance.now()` calls + field writes) (cl-spec-009 invariant 7).

- **3-way decomposition.** Every timed operation partitions its wall-clock time into three components (cl-spec-009 SS7.2):
  1. **selfTime** -- time spent in context-lens computation: hashing, cache lookups, score computation, aggregation, report assembly, pattern detection, eviction scoring, sorting.
  2. **providerTime** -- time spent inside caller-provided tokenizer and embedding provider methods (`count`, `countBatch`, `embed`, `embedBatch`). Measured by wrapping each provider call with start/end timestamps and accumulating.
  3. **customPatternTime** -- time spent executing caller-provided custom pattern functions (`detect`, `severity`, `explanation`, `remediation`). Measured the same way as providerTime.
  
  Budget compliance is evaluated against selfTime only. Provider time and custom pattern time are measured for transparency but never counted against budget targets (cl-spec-009 invariant 2). Operations that do not call providers (Tier 1 queries, evict, clearTask, setCapacity) have providerTime = 0.

- **Budget violation detection.** After each operation completes, compare selfTime against the budget target for the operation's tier and current segment count (cl-spec-009 SS8.3). The tier lookup uses the operation budgets from cl-spec-009 SS3:
  - Tier 1 (queries): < 1ms
  - Tier 2 (hot-path mutations): < 5ms
  - Tier 3 (assessment): < 50ms at n<=500
  - Tier 4 (planning): < 100ms at n<=500
  - Tier 5 (batch/rare): proportional
  
  At n > 500, budgets are extrapolated linearly from the n=500 targets (e.g., assess budget at n=1000 is 100ms). If selfTime exceeds the budget, the timing record's `budgetExceeded` flag is set to true and a `budgetViolation` event is emitted (cl-spec-009 SS8.3). Budget violations are advisory -- they do not throw, do not interrupt the operation, and do not trigger corrective action. They exist to make performance regressions visible.

- **Sampling parameter computation.** Provide the sampling thresholds and sample sizes used by the scoring modules during assessment (cl-spec-009 SS5):
  - Sampling activation threshold: n > 200 (not configurable).
  - Topical concentration sample size: `s = min(ceil(sqrt(n) * 3), n)`. At n=225: s=45, n=500: s=68, n=2000: s=135.
  - Density sampling cap: `min(30, remaining)` uncached non-adjacent segments per segment.
  - Sampling seed: FNV-1a hash of concatenated sorted segment IDs (joined by null byte separator), per R-178.
  - Stratified sampling for groups: `ceil(m * s / n)` members per group where m = group member count.
  
  These parameters are computed by the performance module and consumed by Phase 2's coherence and density scorers. The performance module does not execute the sampling -- it provides the parameters.

- **Timing record accumulation.** The performance module maintains a ring buffer of the most recent 200 timing records (cl-spec-009 SS8.2). The buffer size is fixed. Older entries are overwritten. The timing history is not persisted -- it exists for the session duration. Phase 4 (diagnostics) reads these records to produce the `PerformanceSummary` in `getDiagnostics()` output and to aggregate per-operation statistics (worst-case selfTime, violation count, within-budget percentage).

- **Operation-to-tier mapping.** The module maintains a static mapping from operation names to budget tiers. This mapping determines which budget target applies for violation detection. The mapping follows cl-spec-009 SS3.1--3.5:
  - Tier 1: getCapacity, getSegment, getSegmentCount, getBaseline, getTask, getTaskState, getGroup, getDiagnostics, getTokenizerInfo, getEmbeddingProviderInfo, toJSON
  - Tier 2: add, update, replace, compact, evict, restore, registerPattern, createGroup, dissolveGroup
  - Tier 3: assess (incremental and cold-start variants)
  - Tier 4: planEviction
  - Tier 5: seed, split, setTask, clearTask, listSegments, listGroups, getEvictionHistory, setCapacity, snapshot, fromSnapshot, validate, setTokenizer, setEmbeddingProvider

**Key design decisions:**
- The performance module is standalone with no dependency on scoring, detection, or eviction. Phase 4 wires it in as entry/exit instrumentation around each public method of the ContextLens class. This separation keeps the measurement infrastructure independent of the measured code.
- Timing uses the runtime's high-resolution timer, not Date.now(). Timer granularity is sub-millisecond on all target platforms (Node.js 18+).
- The 3-way decomposition requires wrapping provider calls and custom pattern calls with timing capture. The detection module tracks customPatternTime by timing each custom function call. The embedding and tokenizer modules track providerTime by timing each provider method call. Both pass their accumulated time up to the timing harness.
- Budget targets are design commitments, not runtime enforcement. No operation is aborted for exceeding its budget (cl-spec-009 invariant 1). The system reports and advises, it does not enforce.
- The ring buffer size of 200 is fixed and not configurable. It provides enough history for per-operation statistics without unbounded memory growth (cl-spec-009 invariant 9).
- Sampling parameters are computed here rather than in the scoring modules because they involve cross-cutting concerns (segment count thresholds, hash-based seeds) that do not belong in dimension-specific scorers. The scorers call the performance module for parameters and execute the sampling themselves.

**Integration points:**
- Phase 4 (`index`) wraps each public method with the timing harness, accumulating selfTime/providerTime/customPatternTime and storing timing records.
- Phase 2 `scoring/coherence` and `scoring/density` consume sampling parameters (threshold, sample size, sampling seed) from this module.
- Phase 4 (`diagnostics`) reads the timing history ring buffer to produce performance summaries.
- `detection` reports customPatternTime for each custom pattern function call, which the timing harness includes in the decomposition.
- `embedding` and `tokenizer` modules report providerTime for each provider call.

---

## 5. Test Requirements

### Unit tests

One test file per module in `test/unit/`, mirroring `src/` structure.

**`detection.test.ts`:**
- **Saturation:** Activates at utilization > 0.75 (watch), > 0.85 (warning), > 0.95 (critical). Does not activate below 0.75. Rate-based early activation: projects 3 reports ahead, activates watch when projected > 0.75. Rate-based requires trend data (no activation on first report). Quality scores do not affect saturation (invariant 4).
- **Erosion:** Requires both gates: density < 0.7 AND utilization > 0.7 for watch. Neither alone activates. Rate-based elevation at densityDelta < -0.15 only when utilization gate met. Either gate closing deactivates.
- **Fracture:** Activates at coherence < 0.6 (watch), < 0.4 (warning), < 0.2 (critical). Cluster ratio > 0.5 elevates severity by one level. Cluster-count trigger cannot activate independently.
- **Gap:** Suppressed when taskDescriptorSet is false (invariant 5). Watch at relevance < 0.6 (no utilization gate). Warning requires utilization > 0.6. Grace period caps severity at watch. Rate-based elevation suppressed during grace.
- **Collapse:** Activates at continuity < 0.7 (watch), < 0.5 (warning), < 0.3 (critical). Stricter rate trigger at continuityDelta < -0.10. Acute trigger: single eviction cost > 0.15 triggers immediate warning.
- **Hysteresis:** Activation at threshold crossing. Deactivation requires recovery past threshold + 0.03 margin. Escalation immediate, de-escalation delayed. Dead zone behavior (score between threshold and threshold+margin preserves current state). Configurable margin in [0.01, 0.10].
- **Compound detection:** fullOfJunk (saturation+erosion) produces compound context on both patterns. lossDominates (collapse+any) always fires when collapse present. triplePressure subsumes fullOfJunk and fullOfWrongThings. Suppressed patterns do not participate.
- **Custom patterns:** Registration validation (name collision, function type, priority range, strategyHint values). Fail-open: detect() throwing does not affect other patterns. Severity returning invalid value treated as null. Explanation/remediation fallbacks on throw. 2-cycle deactivation (one null not enough, two nulls deactivate). Defensive report copy (mutation in detect does not affect other patterns). Registration order determines tie-breaking within same priority.
- **Suppression:** Suppressed pattern produces no output. Not computed, not in compounds, not in highestSeverity. Custom pattern suppression before registration takes effect on registration.
- **Threshold overrides:** Partial override (only override watch for saturation, warning/critical retain defaults). Validation rejection: reversed ordering, too-close thresholds, out-of-range values.
- **Determinism:** Same report + same history state = same result. Two consecutive calls produce identical output when inputs unchanged.
- **Pattern history:** Activation creates entry. ReportCount increments. Severity transitions tracked (peakSeverity, peakAt). Resolution sets resolvedAt. Trending derived from scoreHistory. Recurrence detection across activations.
- **Empty window:** Returns empty result (no patterns). Pre-baseline: preBaseline flag set to true.
- **Remediation hints:** Each pattern produces correctly ordered hints. Saturation: default-eviction > seed-compaction > priority-eviction > capacity-increase. Gap: lowest-relevance > updateTask > seed-compaction > priority-eviction. Hints filtered by availability (no default segments => skip hint 1).

**`eviction.test.ts`:**
- **Ranking model:** 5-signal weighted score in [0.0, 1.0]. Weights sum to 1.0. Lower score = better candidate. Arithmetic mean behavior: no single signal at zero forces score to zero.
- **Signal derivation:** relevanceRetention = segment relevance. informationLoss = segment density. importanceSignal = segment importance. ageRetention = 1.0 - (age / maxAge) using assessmentTimestamp. No task set: relevance 1.0 for all, signal drops out of differentiation.
- **Bridge scores:** Interior segment: clamp(avgNeighborSim - skipSim, 0.0, 1.0). First/last segment: 0.0. Single-segment window: 0.0. High skip similarity (neighbors similar to each other without the bridge): low bridge score. Low skip similarity (neighbors dissimilar): high bridge score.
- **Strategy weights:** Default, saturation, erosion, gap, collapse weight tables verified. All sum to 1.0.
- **Auto-selection:** No patterns => default. Single pattern => corresponding strategy. Compound override: saturation+erosion => erosion (not saturation priority). Compound precedence: triplePressure over fullOfJunk. Fracture alone => default. Custom pattern strategyHint respected when driving.
- **Protection tiers:** Default exhausted before priority(0). Priority(0) before priority(1). Seed only after all default and priority exhausted. Pinned never appears. Group effective protection: max of group and member protections.
- **Group handling:** Group candidate replaces individual members. Token-weighted mean eviction score. Overshoot penalty at 2x remaining target when non-group alternatives exist. Group impact estimation: simultaneous member removal.
- **Compaction recommendations:** Seed compaction-first (always). Already-compacted segments get eviction. Minimum savings threshold (20%). Strategy biases: saturation prefers eviction, collapse prefers compaction.
- **Plan assembly:** Target met flag correct. Shortfall computed when incomplete. Cumulative tokens accumulate correctly. MaxCandidates limit honored. SeedsIncluded flag set when seeds appear. Exhausted flag set when all candidates consumed.
- **Tie-breaking cascade:** Verified through deliberately equal eviction scores. Protection tier > importance > relevance > token count > creation timestamp > segment ID. Deterministic across calls.
- **Strategy behavioral rules:** Saturation token-size preference within 0.05 band. Erosion pair suppression for redundancy > 0.8. Gap coherence cap at 0.3 for relevance < 0.3. Collapse continuity floor guard (candidate excluded when projected continuity below critical threshold).
- **Impact estimation:** Continuity cost exact (additive formula). Coherence/density/relevance deltas approximate. Plan-level qualityImpact uses projected dimension scores.

**`performance.test.ts`:**
- **Timing harness:** Records operation name, selfTime, totalTime, timestamp. selfTime + providerTime + customPatternTime approximately equals totalTime.
- **3-way decomposition:** providerTime accumulated from provider calls. customPatternTime accumulated from custom pattern calls. selfTime = totalTime - providerTime - customPatternTime.
- **Budget violation:** Tier 1 operations flagged when selfTime > 1ms. Tier 3 flagged when selfTime > 50ms at n<=500. Tier 4 flagged when selfTime > 100ms at n<=500. Linear extrapolation at n > 500. budgetExceeded flag and budgetTarget set correctly.
- **Sampling parameters:** Sample size matches ceil(sqrt(n) * 3) at n > 200. Density cap is min(30, remaining). Seed is deterministic FNV-1a of sorted segment IDs. Stratified group sampling: ceil(m * s / n).
- **Timing history:** Ring buffer size 200. Oldest entries overwritten. Empty buffer returns empty history.
- **Operation-to-tier mapping:** All operations mapped to correct tiers per cl-spec-009 SS3.

### Integration tests

In `test/integration/`, exercising cross-module flows:

- **Detection-after-assessment flow:** Seed 10 segments, add 5 more pushing utilization above 0.85, assess. Verify saturation at warning severity. Verify detection result attached to the quality report. Verify pattern history entry created.
- **Erosion compound flow:** Fill window to 0.9 utilization with highly redundant content (pairs of near-duplicate segments). Assess. Verify erosion active (density low + utilization high). Add saturation (utilization > 0.85). Verify fullOfJunk compound context on both patterns.
- **Gap lifecycle flow:** Set task, add irrelevant content to high utilization, assess. Verify gap at warning/critical. Change task via setTask, assess. Verify grace period caps gap at watch. Assess again (grace report 2). Verify grace expires. Assess again. Verify gap severity no longer capped.
- **Custom pattern flow:** Register a custom pattern that activates when segment count > 20. Seed 10, add 15. Assess. Verify custom pattern active. Verify it appears alongside base patterns in correct priority order. Register a buggy custom pattern that throws on detect. Assess. Verify buggy pattern produces warning, other patterns unaffected.
- **Eviction plan flow:** Fill window to 0.9 utilization with varied content (different relevance, density, importance). Plan eviction with targetUtilization 0.7. Verify candidates ordered by eviction score within tiers. Verify cumulative tokens reach target. Execute first 3 candidates via evict(). Assess. Plan again. Verify plan differs (staleness).
- **Protection tier flow:** Add default, priority(0), priority(1), seed, and pinned segments. Plan eviction. Verify: pinned absent. Default exhausted first. Priority(0) before priority(1). Seed only after all default and priority consumed.
- **Bridge score flow:** Create a window with segments A-B-C where A and C are topically different but both similar to B (B is a bridge). Plan eviction. Verify B has high bridge score and high coherence contribution, ranking it as a poor eviction candidate (resists eviction).
- **Collapse strategy flow:** Evict several important segments (high relevance, high importance). Assess. Verify collapse active. Plan eviction with auto strategy. Verify collapse strategy selected. Verify compaction-over-eviction bias. Verify continuity floor guard excludes candidates that would deepen collapse.
- **Performance timing flow:** Perform add + assess + planEviction. Verify timing records accumulated in ring buffer. Verify selfTime, providerTime, customPatternTime decomposition. Intentionally exceed budget (e.g., via expensive custom pattern in assess). Verify budgetExceeded flag set and budgetViolation event emitted.

### Property-based tests

Using fast-check via vitest, in `test/property/`:

- **Eviction score bounds:** For any randomly generated segment scores (relevance, density, importance, bridge score, age retention all in [0.0, 1.0]), the eviction score is in [0.0, 1.0]. Holds for all 5 strategy weight sets.
- **Deterministic detection:** Same quality report + same pattern history state + same custom patterns in same registration order = same detection result across repeated calls.
- **Deterministic planning:** Same quality report + same PlanOptions = same eviction plan across repeated calls.
- **Protection tier inviolability:** For any randomly generated window with mixed protection tiers, no candidate in the plan at tier T+1 precedes a candidate at tier T in the candidates array.
- **Weight summation:** All 5 strategy weight sets sum to exactly 1.0.
- **Bridge score range:** For any three similarity values in [0.0, 1.0], the bridge score computation produces a value in [0.0, 1.0].
- **Hysteresis stability:** For a sequence of scores oscillating within the dead zone (threshold to threshold+margin), the pattern's active/inactive state does not change after initial activation.
- **Compound symmetry:** The compound fullOfJunk produces compound context on both saturation and erosion patterns, not just one.

---

## 6. Exit Criteria

All of the following must be true to complete Phase 3:

- All 3 modules (`detection`, `eviction`, `performance`) are implemented and exported.
- All unit tests pass with 100% of the invariants from cl-spec-003 (SS11, 16 invariants), cl-spec-008 (SS10, 12 invariants), and cl-spec-009 (SS9, 10 invariants) covered.
- All integration tests pass for the 9 cross-module flows listed above.
- All property-based tests pass for the 8 invariant properties listed above.
- Detection adds negligible overhead to `assess()` at n=500 (< 2ms selfTime for the detection pass itself, measured separately from scoring).
- `planEviction()` completes in < 100ms at n=500 (selfTime, excluding provider calls and any assess() triggered), validated by benchmark.
- Pattern detection is deterministic: same inputs produce same outputs. Verified by running detection twice on identical inputs and comparing results field-by-field.
- Hysteresis prevents flicker: a test that oscillates a score near a threshold boundary produces at most one activation and one deactivation, not repeated toggling.
- Custom pattern fail-open: a test that registers a throwing custom pattern verifies that base patterns and other custom patterns produce identical results to a run without the throwing pattern.
- All 5 strategy weight sets sum to exactly 1.0.
- The eviction plan respects protection tier ordering under all strategies, verified by property-based test across randomly generated windows.
- The bridge score is in [0.0, 1.0] for all inputs, verified by property-based test.
- The tie-breaking cascade produces a total ordering (no ties after all 6 cascade steps), verified on a constructed window where 10 candidates share identical eviction scores.
- No circular imports between Phase 3 modules. `detection` does not import `eviction`. `performance` does not import `detection` or `eviction`.
- No upward imports from Phase 1 or Phase 2 modules into Phase 3.
- Phase 1 and Phase 2 modules are not modified except for: (a) `quality-report` calling the detection pass as the final step of report assembly, and (b) `scoring/coherence` and `scoring/density` consuming sampling parameters from the `performance` module.
- The `detection` module produces the full `DetectionResult` structure as defined in cl-spec-003 SS2.3, ready for consumption by Phase 4 (diagnostics, public API).
- The `eviction` module produces the full `EvictionPlan` structure as defined in cl-spec-008 SS4.2, ready for consumption by Phase 4 (public API).
- The `performance` module produces timing records as defined in cl-spec-009 SS8.1, ready for consumption by Phase 4 (diagnostics).
