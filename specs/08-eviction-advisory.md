---
id: cl-spec-008
title: Eviction Advisory
type: design
status: draft (amended)
created: 2026-04-02
revised: 2026-04-04
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [eviction, advisory, ranking, plan, strategy, compaction, coherence-impact, protection, custom-patterns]
depends_on: [cl-spec-002, cl-spec-003, cl-spec-007]
---

# Eviction Advisory

## Table of Contents

1. Overview
2. Ranking Model
3. Protection Tier Ordering
4. Eviction Plan
5. Planning Strategies
6. Group Handling
7. Coherence Impact Estimation
8. Task-Aware Eviction
9. Compaction Recommendations
10. Invariants and Constraints
11. References

---

## 1. Overview

The quality model (cl-spec-002) measures. The degradation patterns (cl-spec-003) diagnose. The eviction advisory recommends.

When a context window fills up — or when its quality degrades because the wrong content is filling it — something needs to go. But deciding *what* to remove is a multi-dimensional optimization problem. The caller must balance token reclamation against information loss, protection tiers against quality impact, group atomicity against surgical precision, and current-task relevance against long-term coherence. The eviction advisory solves this problem for the caller.

The eviction advisory is a **planning system**. It consumes the quality report (scores, patterns, capacity metrics, per-segment evaluations) and produces an **eviction plan** — an ordered list of candidates with projected impact, ready for the caller to execute. It does not execute evictions. It does not modify the context window. It answers the question "if I need to free N tokens, what should I remove and what will that cost me?" The caller reads the plan and decides which recommendations to follow.

### What the eviction advisory consumes

The eviction advisory is a pure consumer of data produced by other systems. It computes no scores, runs no similarity functions, and maintains no caches of its own. Its inputs:

| Input | Source | Used for |
|-------|--------|----------|
| Per-segment quality scores | Quality report (cl-spec-002) | Ranking: relevance, density, coherence contribution |
| Window-level quality scores | Quality report | Impact estimation: projected quality after eviction |
| Active degradation patterns | Detection framework (cl-spec-003) | Strategy selection: which pattern drives the eviction |
| Remediation hints | Detection framework | Strategy guidance: pattern-specific suggestions |
| Capacity metrics | Tokenization subsystem (cl-spec-006) | Target calculation: how much to reclaim |
| Segment metadata | Segment model (cl-spec-001) | Ranking: protection, importance, origin, timestamps, group membership |
| Task state | Task identity (cl-spec-004) | Ranking: task-aware relevance weighting |

The advisory does not read segment content. It operates entirely on scores and metadata. This is intentional — content analysis is the quality model's job, and the advisory inherits its conclusions.

### What the eviction advisory produces

A single output: the **eviction plan** (section 4). The plan contains:

- **Ranked candidates.** Segments (and groups) ordered from best eviction target to worst, with scores explaining the ranking.
- **Token reclamation.** How many tokens each candidate would free, and cumulative totals.
- **Quality impact estimates.** Projected effect on each quality dimension if the candidate is evicted.
- **Compaction alternatives.** For candidates where compaction would reclaim enough tokens, a compaction recommendation instead of eviction (section 9).
- **Plan metadata.** Which strategy produced the plan, what constraints were applied, which patterns drove the recommendations.

### Design goals

- **Advisory, not enforcement.** The eviction advisory recommends — it does not execute. The `evict` and `compact` methods on the context-lens instance are the execution path (cl-spec-007 sections 3.5, 3.7). The advisory produces the plan; the caller walks the plan and calls `evict` for each candidate they accept. This separation keeps the caller in control — they can skip candidates, reorder them, add their own logic, or ignore the plan entirely.
- **Protection-respecting.** The advisory never recommends evicting a pinned segment, never recommends evicting a seed before all default and priority segments are exhausted, and never recommends evicting a higher-priority segment while lower-priority candidates remain. The protection tier ordering (cl-spec-001 section 6) is a hard constraint, not a soft preference. The advisory operates within it, not around it.
- **Quality-aware, not quality-blind.** Token reclamation is necessary but not sufficient. A naive FIFO eviction — remove the oldest content — is easy but destructive. The advisory uses quality scores to minimize the quality cost of reclamation: prefer evicting redundant content over unique content, irrelevant content over relevant content, and isolated content over coherence-bridging content. The cheapest tokens to reclaim are the ones whose removal improves quality or at least does not degrade it.
- **Pattern-responsive.** When degradation patterns are active, the advisory tailors its strategy. Saturation drives a capacity-focused plan (reclaim the most tokens). Erosion drives a redundancy-focused plan (remove duplicates). Gap drives a relevance-focused plan (remove off-task content). The advisory reads the diagnosis and prescribes accordingly.
- **Deterministic.** Given the same quality report and the same planning parameters, the advisory produces the same plan. No randomness, no tie-breaking by memory address or hash order. Ties are broken by a deterministic cascade: protection tier → importance → relevance → token count (descending) → creation timestamp (oldest first) → segment ID (lexicographic). The cascade is long enough that ties in practice are vanishingly rare, but the guarantee is absolute.

### What the eviction advisory is not

The eviction advisory is not an optimizer. It does not search for the globally optimal eviction set — the set of segments whose removal maximizes quality per token reclaimed. That is an NP-hard problem (a variant of knapsack with multiple objectives). The advisory uses a greedy ranked approach: score each candidate independently, sort, and present in order. This is fast, predictable, and good enough — the marginal quality difference between the greedy solution and the theoretical optimum is small relative to the uncertainty in quality score precision.

The eviction advisory is not an auto-evictor. It does not trigger eviction based on capacity pressure. A window at 99% utilization with no `planEviction` call receives no eviction. The caller must request a plan and execute it. This is a deliberate design choice — automatic eviction would violate the caller-driven mutation principle (cl-spec-007 section 1) and would make context-lens's behavior unpredictable in production systems where every context modification must be auditable.

The eviction advisory is not a content generator. When it recommends compaction (section 9), it does not produce the summary. It says "compact this segment" and estimates the token savings — the caller generates the summary (possibly via an LLM call) and passes it to `compact`. context-lens does not call LLMs (cl-spec-002 invariant 9).

### How the eviction advisory flows through the system

```
Quality Report (cl-spec-002)
    |
    +--> Per-segment scores (relevance, density, coherence contribution)
    +--> Window-level scores
    +--> Capacity metrics (utilization, headroom, tier breakdown)
    |
Degradation Patterns (cl-spec-003)
    |
    +--> Active patterns with severity
    +--> Remediation hints
    |
    v
Eviction Advisory (this spec)
    |
    +--> planEviction(options) -> EvictionPlan
    |
    v
Caller
    |
    +--> Reviews plan
    +--> Calls evict(id) / compact(id, summary) per candidate
    +--> Calls assess() to verify impact
```

The advisory sits between diagnosis and action. It transforms "here is what is wrong" (patterns) and "here is the state of each segment" (quality report) into "here is what to do about it" (eviction plan). The caller transforms the plan into action.

## 2. Ranking Model

Every eviction plan begins with a ranked list. The ranking model takes all evictable segments, scores each one on how suitable it is for eviction, and sorts them from best candidate (evict first) to worst candidate (evict last). The plan then walks this list until the reclamation target is met. The advisory's candidate pool corresponds to `managedTokens` from the capacity report (cl-spec-006 section 4.5), defined as `totalActiveTokens - pinnedTokens`. This includes seed segments, which are evictable-last but still part of the managed pool.

The ranking model is **not** the composite quality score from cl-spec-002 section 8. The composite answers "how healthy is this segment?" The eviction score answers a different question: "how cheaply can this segment be removed?" A segment with a high composite score — healthy, relevant, unique — is expensive to remove. A segment with a low composite score might still be expensive to remove if it bridges two topical clusters. The eviction score captures removal cost, not current quality.

### 2.1 Eviction Score

Each evictable segment receives an **eviction score** — a value from 0.0 (ideal eviction target) to 1.0 (worst possible eviction target). Lower scores mean better candidates. The score is a weighted combination of five signals, each normalized to 0.0–1.0.

```
evictionScore(i) = w_r * relevanceRetention(i)
                 + w_d * informationLoss(i)
                 + w_c * coherenceContribution(i)
                 + w_i * importanceSignal(i)
                 + w_a * ageRetention(i)
```

**Signals:**

| Signal | Symbol | Range | Meaning at 0.0 | Meaning at 1.0 |
|--------|--------|-------|-----------------|-----------------|
| Relevance retention | `relevanceRetention(i)` | 0.0–1.0 | Segment is completely irrelevant to the current task — removing it costs nothing in relevance | Segment is maximally relevant — removing it directly harms task performance |
| Information loss | `informationLoss(i)` | 0.0–1.0 | Segment is fully redundant — its information exists elsewhere in the window | Segment is completely unique — its information is lost on eviction |
| Coherence contribution | `coherenceContribution(i)` | 0.0–1.0 | Segment is isolated — removing it does not fragment the window's topical structure | Segment bridges topics — removing it fractures coherence |
| Importance signal | `importanceSignal(i)` | 0.0–1.0 | Caller assigned importance 0.0 (expendable) | Caller assigned importance 1.0 (critical) |
| Age retention | `ageRetention(i)` | 0.0–1.0 | Segment is the oldest in the window — least likely to be temporally relevant | Segment is the most recent — most likely to reflect current context |

### 2.2 Signal Derivation

Each signal is derived from data the quality model has already computed. The advisory performs no similarity computations, no embedding lookups, and no content inspection. It reads the quality report and transforms existing scores into eviction-oriented signals.

**Relevance retention** is the segment's per-segment relevance score from the quality report, used directly:

```
relevanceRetention(i) = qualityReport.segments[i].relevance
```

When no task is set (relevance uniformly 1.0 for all segments), this signal contributes equally to every candidate and effectively drops out of the ranking. This is correct — without a task, the advisory cannot distinguish relevant from irrelevant content and should not pretend to.

**Information loss** is the inverse of the segment's redundancy. A highly redundant segment carries little unique information — evicting it loses almost nothing because the information survives in other segments:

```
informationLoss(i) = 1.0 - redundancy(i)
                   = qualityReport.segments[i].density
```

This reuses the per-segment density score directly. A segment with density 0.2 (80% redundant) has information loss 0.2 — cheap to remove. A segment with density 0.95 (5% redundant) has information loss 0.95 — expensive to remove.

**Coherence contribution** measures how much removing this segment would damage the window's topical structure. This is the most complex signal and is detailed in section 7. In summary, it captures whether the segment acts as a topical bridge — connecting otherwise-disconnected regions of the window. Removing a bridge fragments the window; removing an interior segment within a dense topical cluster has minimal coherence impact.

```
coherenceContribution(i) = bridgeScore(i)
```

The bridge score is computed from the segment's adjacency similarities (cl-spec-002 section 3.3). A segment whose neighbors are similar to each other (and would remain coherent without it) has a low bridge score. A segment whose neighbors are dissimilar (and would become disconnected without it) has a high bridge score. Section 7 defines the full computation.

**Importance signal** is the caller-assigned importance, used directly:

```
importanceSignal(i) = segment.importance
```

This is the caller's explicit declaration of value. The advisory respects it as a first-class signal — a segment the caller marked as 0.9 importance resists eviction regardless of what the quality model computes.

**Age retention** normalizes recency to a 0.0–1.0 range:

```
ageRetention(i) = 1.0 - (age(i) / maxAge)
```

Where `age(i)` is `assessmentTimestamp - max(segment.createdAt, segment.updatedAt)` and `maxAge` is the age of the oldest active segment. The `assessmentTimestamp` is the quality report's timestamp, established at the start of each `assess()` call. Age computation does not depend on the system clock. The most recent segment scores 1.0 (high retention value — prefer to keep it). The oldest scores 0.0 (low retention value — acceptable to remove). This mirrors the recency signal in relevance scoring (cl-spec-002 section 5.5) but serves a different purpose: relevance recency estimates task-relatedness; age retention estimates temporal value for eviction.

### 2.3 Weights

| Signal | Weight | Rationale |
|--------|--------|-----------|
| `w_r` (relevance) | 0.30 | Removing irrelevant content is the highest-value eviction. When a task is set, relevance is the strongest signal for what should go. |
| `w_d` (information loss) | 0.25 | Removing redundant content is the cheapest eviction. If the information survives in other segments, the window loses nothing. |
| `w_c` (coherence) | 0.20 | Preserving coherence structure prevents fracture. Bridge segments are disproportionately valuable relative to their token cost. |
| `w_i` (importance) | 0.15 | Caller-declared importance is an explicit signal that the advisory should respect, but not dominate — the caller can use protection tiers for hard constraints. |
| `w_a` (age) | 0.10 | Age is the weakest signal. Old content may be foundational (system prompts, key documents). Age breaks ties more than it drives decisions. |

Weights sum to 1.0. The eviction score is a weighted arithmetic mean — not geometric, because no single signal at zero should force the eviction score to zero. A segment that is completely irrelevant (`relevanceRetention = 0.0`) but highly unique and bridges topics should still resist eviction somewhat. The arithmetic mean allows this; a geometric mean would not.

**Weights are not configurable.** The same reasoning as the composite quality weights (cl-spec-002 section 8.3) applies: exposing weights creates a tuning surface with non-obvious interactions. If a caller wants to override the ranking, they can use protection tiers (hard override) or importance (soft override). The advisory weights define the default quality-of-eviction tradeoff.

### 2.4 Strategy-Adjusted Weights

The default weights (section 2.3) apply when no degradation pattern is driving the eviction. When a planning strategy is pattern-driven (section 5), the weights are adjusted to amplify the signal most relevant to the active pattern:

| Strategy | `w_r` | `w_d` | `w_c` | `w_i` | `w_a` | Rationale |
|----------|-------|-------|-------|-------|-------|-----------|
| Default | 0.30 | 0.25 | 0.20 | 0.15 | 0.10 | Balanced |
| Saturation-driven | 0.20 | 0.30 | 0.15 | 0.15 | 0.20 | Tokens matter most — lower relevance weight because the goal is space, not focus. Information loss and age each gain 0.05 from the relevance reduction, and coherence is reduced by 0.05. Token-size preference applies as a tie-breaking sort rule (see below), not as a weight. |
| Erosion-driven | 0.20 | 0.40 | 0.15 | 0.15 | 0.10 | Redundancy is the problem — amplify information loss signal to target duplicates. |
| Gap-driven | 0.45 | 0.20 | 0.10 | 0.15 | 0.10 | Irrelevance is the problem — amplify relevance to target off-task content. Coherence demoted because off-task content may bridge off-task topics, and removing those bridges is acceptable. |
| Collapse-driven | 0.25 | 0.25 | 0.25 | 0.15 | 0.10 | Continuity is already damaged — prioritize coherence preservation to prevent compounding loss. |

**Saturation's token-size preference.** Saturation needs tokens reclaimed. When saturation drives the plan, the advisory adds a secondary sort preference: among candidates with similar eviction scores (within 0.05), prefer the candidate with the higher token count. This is not a weight adjustment — it is a tie-breaking rule that nudges the ranking toward fewer, larger evictions rather than many small ones. Fewer evictions mean fewer continuity ledger entries and less coherence disruption.

### 2.5 Tie-Breaking Cascade

When two candidates have identical eviction scores (after floating-point rounding to 4 decimal places), the advisory applies a deterministic tie-breaking cascade:

1. **Protection tier.** Lower protection evicted first: `default` < `priority(n)` (ascending by `n`) < `seed`. Pinned segments never appear in the ranking.
2. **Importance.** Lower importance evicted first.
3. **Relevance.** Lower relevance evicted first.
4. **Token count.** Higher token count evicted first. Between two otherwise-equal candidates, removing the larger one reclaims more capacity per eviction operation.
5. **Creation timestamp.** Older segment evicted first (`createdAt` ascending).
6. **Segment ID.** Lexicographic ascending. The final tiebreaker — deterministic and content-independent.

The cascade is evaluated lazily — step N is only evaluated if steps 1 through N-1 produced a tie. In practice, ties past step 2 are rare. Step 6 exists solely to guarantee determinism.

### 2.6 What the Ranking Model Does Not Do

The ranking model scores candidates **independently**. It does not consider interactions between candidates — evicting segment A might make segment B more or less valuable to evict (because B's redundancy score changes, or because A and B together bridged a topic). Modeling pairwise interactions would make ranking O(n²) in the number of candidates and would require re-ranking after each eviction decision, turning a single sort into an iterative optimization.

The advisory acknowledges this limitation through the **plan staleness** mechanism (section 4): after the caller executes evictions from a plan, the plan is marked stale because the window state has changed. The caller should call `assess` and then `planEviction` again if they need further evictions. This iterative plan-execute-replan cycle approximates the interactive optimization that single-pass ranking cannot achieve.

## 3. Protection Tier Ordering

The ranking model (section 2) produces scores within a tier. Protection tiers impose the structure *between* tiers. No amount of ranking-model arithmetic can override a protection constraint — a `default` segment with eviction score 0.99 (terrible candidate) is evicted before a `priority(0)` segment with eviction score 0.01 (ideal candidate). Tiers are walls, not weights.

This section defines the complete ordering, the rules for tier exhaustion, and the special handling of seed-protected segments.

### 3.1 The Ordering

Eviction candidates are partitioned into tiers and presented in strict tier order:

```
Tier 1: default           — evicted first
Tier 2: priority(0)       — evicted after all default segments
Tier 3: priority(1)
  ...
Tier N: priority(999)     — evicted after all lower-priority segments
Tier N+1: seed            — evicted only under extreme pressure, compaction preferred
Tier N+2: pinned          — never evicted, never included in the plan
```

Within each tier, segments are sorted by eviction score (section 2.1, ascending — best candidates first). The advisory walks tiers in order: it exhausts tier 1 before considering tier 2, exhausts tier 2 before tier 3, and so on.

**"Exhausts" does not mean "evicts all."** It means the advisory has walked past every candidate in the tier — either including them in the plan (if the reclamation target is not yet met) or skipping them (if the target is met). The plan may include candidates from only the first tier if that tier provides enough tokens.

### 3.2 Priority Sub-Ordering

`priority(n)` segments form a continuum of 1000 levels (0–999). The advisory treats each priority level as a sub-tier. Within a priority level, the eviction score determines order. Across priority levels, lower `n` is evicted first — `priority(0)` before `priority(1)`, `priority(1)` before `priority(2)`, and so on.

The advisory does not create 1000 separate buckets. It sorts all priority segments by `(n ascending, evictionScore ascending)` in a single pass. The effect is the same as per-level buckets, but the implementation is a compound sort key, not a nested loop.

**Sparse priority levels.** If a caller uses only `priority(100)` and `priority(500)`, the advisory sees two clusters with a gap. This is fine — the gap costs nothing. The caller does not need to use contiguous levels.

### 3.3 Seed Tier: Compaction Before Eviction

Seeds are foundational context — the material the caller loaded before the session began (cl-spec-001 section 6.3, section 7.1). They established the quality baseline (cl-spec-002 section 7). Evicting a seed is structurally expensive: it degrades the baseline's representativeness, it removes content the caller explicitly designated as foundational, and it damages continuity disproportionately because seed content is, by definition, present since the start.

The advisory handles seeds differently from all other tiers:

1. **Seeds appear in the plan only after all `default` and `priority(n)` candidates are exhausted.** If the reclamation target can be met without touching seeds, seeds do not appear.

2. **When seeds must appear, compaction is recommended first.** For each seed candidate, the advisory emits a `CompactionRecommendation` (section 9) before an eviction recommendation. The recommendation estimates how many tokens compaction would reclaim (based on a configurable target compression ratio, default 0.5 — halve the token count). If the compaction savings would meet the remaining reclamation target, the plan includes only the compaction recommendation, not the eviction.

3. **Seeds that are already compacted** (origin is `"summary:compacted"`) skip the compaction step and are presented as eviction candidates directly. Compacting an already-compacted segment is unlikely to yield meaningful savings and risks information loss that compounds.

4. **Among seeds, ranking proceeds normally.** Eviction scores determine order within the seed tier. The seed with the lowest eviction score (most expendable) is recommended first.

### 3.4 Pinned Tier: Excluded Entirely

Pinned segments do not appear in the eviction plan under any circumstances. They are filtered out before ranking begins. The advisory does not compute eviction scores for them, does not include them in candidate lists, and does not suggest compacting them.

If the entire window is pinned, the eviction plan is empty — there are no candidates. The plan metadata notes this: `exhausted: true`, `reason: "all segments are pinned"`. The caller's only recourse is to unpin segments (via `update` to change protection) or increase capacity (via `setCapacity`).

### 3.5 Group Protection

When a segment belongs to a group, the advisory uses the group's **effective protection** — the maximum of the group-level protection (if explicitly set) and the strongest member-level protection (cl-spec-001 section 5.2). This means:

- A group containing one `seed` segment and three `default` segments has effective protection `seed`. The entire group is ranked in the seed tier, even though most of its members are individually `default`.
- A group with explicit `priority(500)` protection is ranked at `priority(500)` regardless of member-level protection.

This is consistent with atomic eviction (cl-spec-001 section 5.3) — the group is one eviction unit, so it needs one tier placement. The strongest member's protection governs because evicting the group means evicting that member, and that member's protection must be respected.

### 3.6 Tier Exhaustion and Plan Completeness

The advisory walks tiers until one of three conditions is met:

1. **Target met.** The cumulative token reclamation of included candidates meets or exceeds the reclamation target. The plan is complete. Remaining candidates in the current and subsequent tiers are omitted.

2. **All tiers exhausted.** Every candidate across all tiers has been included, but the cumulative reclamation is still below the target. The plan is incomplete — it reclaims as much as possible but falls short. The plan metadata notes this: `targetMet: false`, `shortfall: <tokens still needed>`. This happens when the window contains too much pinned or seed content relative to the reclamation target.

3. **Seed boundary.** The advisory has exhausted all `default` and `priority(n)` candidates, the target is not met, and seed candidates exist. The plan includes the seed candidates with compaction-first recommendations (section 3.3), but marks the plan with `seedsIncluded: true` as a warning to the caller that foundational content is being targeted.

The distinction between conditions 1 and 2 is important for the caller. A complete plan means "execute this and you'll have enough room." An incomplete plan means "execute all of this and you still won't have enough room — you need to unpin content, increase capacity, or accept the shortfall."

## 4. Eviction Plan

The eviction plan is the advisory's deliverable — the structured output that tells the caller exactly what to remove, in what order, at what cost. This section defines the plan structure, the method that produces it, and the lifecycle of a plan after it is generated.

### 4.1 planEviction

```
planEviction(options?: PlanOptions) -> EvictionPlan
```

Generates an eviction plan based on the current window state. This method is exposed on the context-lens instance (extending the API surface defined in cl-spec-007).

**PlanOptions:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `targetTokens` | number | no | — | Reclaim at least this many tokens. Mutually exclusive with `targetUtilization`. |
| `targetUtilization` | number (0.0–1.0) | no | — | Reduce utilization to at most this value. Converted internally to `targetTokens = totalActiveTokens - (capacity * targetUtilization)`. |
| `strategy` | `StrategyName` | no | `"auto"` | Which planning strategy to use (section 5). `"auto"` selects based on active patterns. |
| `maxCandidates` | number | no | `50` | Maximum candidates to include in the plan. Limits plan size for callers who want a quick preview, not a full walk. |
| `includeCompactionAlternatives` | boolean | no | `true` | Whether to generate compaction recommendations for candidates where compaction would suffice. |

**Preconditions:**
- At least one of `targetTokens` or `targetUtilization` should be provided. If neither is provided, the advisory plans for the default target: reduce utilization to 0.75 (the saturation watch threshold). This gives the caller a plan that resolves or prevents saturation without requiring them to pick a number.
- `targetTokens` must be positive. `targetUtilization` must be in [0.0, 1.0) and must be less than the current utilization (otherwise there is nothing to reclaim). Throws `ValidationError` on violation.
- If both `targetTokens` and `targetUtilization` are provided, throws `ValidationError`. The caller must choose one.

**Behavior:**
1. Obtains a fresh quality report (equivalent to calling `assess`, reuses the cached report if still valid).
2. Filters out pinned segments. Partitions remaining segments into tiers (section 3).
3. Computes eviction scores for all candidates using the ranking model (section 2), with weights adjusted by strategy (section 2.4).
4. Sorts candidates within each tier by eviction score ascending.
5. Walks the sorted list, accumulating token reclamation, until the target is met or all candidates are exhausted.
6. For each included candidate, computes quality impact estimates (section 4.3).
7. For seed candidates and optionally others, generates compaction alternatives (section 9).
8. Assembles and returns the `EvictionPlan`.

**Returns:** An `EvictionPlan`. Never throws on an empty window or when the target cannot be met — it returns a plan with `targetMet: false`.

### 4.2 EvictionPlan Structure

**Top-level fields:**

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | string | Schema version identifier (cl-spec-011). Present on all top-level output types. |
| `planId` | string | Auto-generated unique identifier. |
| `timestamp` | timestamp | When the plan was generated. |
| `strategy` | `StrategyName` | Which strategy produced this plan (section 5). |
| `target` | `PlanTarget` | The reclamation target as requested. |
| `candidates` | `EvictionCandidate[]` | Ordered list of eviction candidates, best first. |
| `candidateCount` | number | Length of `candidates`. |
| `totalReclaimable` | number | Sum of token counts across all candidates. |
| `targetMet` | boolean | Whether `totalReclaimable >= target.tokens`. |
| `shortfall` | number | `target.tokens - totalReclaimable` if `targetMet` is false, otherwise 0. |
| `seedsIncluded` | boolean | Whether any seed-protected candidates appear in the plan. |
| `exhausted` | boolean | Whether all evictable candidates were included (no more available). |
| `qualityImpact` | `ProjectedQualityImpact` | Projected window-level quality scores if all candidates are evicted. |
| `patterns` | `PatternName[]` | Active degradation patterns at plan generation time. |
| `reportId` | string | The quality report ID this plan was derived from. Links the plan to its source data. |

**PlanTarget:**

| Field | Type | Description |
|-------|------|-------------|
| `tokens` | number | Number of tokens to reclaim. |
| `utilizationBefore` | number | Utilization at plan generation time. |
| `utilizationAfter` | number | Projected utilization if all candidates are evicted. |

### 4.3 EvictionCandidate Structure

Each candidate in the plan carries everything the caller needs to make an informed eviction decision.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Segment ID (or group ID, if this candidate is a group — section 6). |
| `type` | `"segment"` or `"group"` | Whether this candidate is an individual segment or an atomic group. |
| `tokenCount` | number | Tokens reclaimed by evicting this candidate. For groups, the sum of all member token counts. |
| `cumulativeTokens` | number | Running total of tokens reclaimed if all candidates up to and including this one are evicted. |
| `evictionScore` | number (0.0–1.0) | The ranking model score (section 2.1). Lower = better candidate. |
| `tier` | string | Protection tier: `"default"`, `"priority(N)"`, or `"seed"`. |
| `importance` | number | Segment importance (or group effective importance). |
| `scores` | `CandidateScores` | The quality scores that drove the ranking. |
| `impact` | `CandidateImpact` | Projected quality impact of evicting this specific candidate. |
| `recommendation` | `"evict"` or `"compact"` | Whether the advisory recommends eviction or compaction for this candidate. |
| `compaction` | `CompactionRecommendation | CompactionRecommendation[] | null` | If `recommendation` is `"compact"`, the compaction details (section 9). Array for group candidates (section 9.5), single object for segment candidates. `null` if eviction is recommended. |
| `memberIds` | `string[]` or `null` | For group candidates, the ordered list of member segment IDs. `null` for individual segments. |
| `reason` | string | Human-readable explanation of why this candidate was selected and ranked here. |

**CandidateScores:**

| Field | Type | Description |
|-------|------|-------------|
| `relevance` | number | Per-segment relevance score at plan time. |
| `density` | number | Per-segment density score (information ratio). |
| `coherenceContribution` | number | Bridge score (section 7). |
| `redundancy` | number | `1.0 - density`. How much of this segment's content exists elsewhere. |

**CandidateImpact:**

| Field | Type | Description |
|-------|------|-------------|
| `coherenceDelta` | number | Estimated change in window coherence if this candidate is evicted. Negative means degradation. |
| `densityDelta` | number | Estimated change in window density. Typically positive (removing low-density content improves density). |
| `relevanceDelta` | number | Estimated change in window relevance. Negative if the candidate was relevant. |
| `continuityDelta` | number | Estimated change in continuity score based on the eviction cost formula (cl-spec-002 section 6.2). Always negative or zero. |
| `compositeDelta` | number | Estimated change in composite score. |

Impact estimates are **approximations**, not guarantees. They are computed by simulating the removal of a single candidate from the current window state. They do not account for interactions — the impact of removing candidate A changes after candidate B is removed. The estimates are most accurate for the first few candidates in the plan and degrade in accuracy further down the list.

### 4.4 Projected Quality Impact

The plan-level `qualityImpact` field estimates what the window's quality scores would be if every candidate in the plan were evicted. This is the cumulative projection — not a per-candidate delta but the expected end state.

| Field | Type | Description |
|-------|------|-------------|
| `coherence` | number | Projected window coherence after full plan execution. |
| `density` | number | Projected window density. |
| `relevance` | number | Projected window relevance. |
| `continuity` | number | Projected window continuity. |
| `composite` | number | Projected composite score. |

**Computation:** The projection is heuristic, not exact. The advisory cannot run the full quality model against a hypothetical post-eviction window state without materializing that state (which would be expensive and side-effect-prone). Instead, it uses a first-order approximation:

- **Coherence** is estimated by removing the candidates' contributions from the adjacency similarity matrix and recomputing the window mean. This is O(k) in the number of candidates, not O(n²).
- **Density** is estimated by removing the candidates from the redundancy calculation. If a candidate was highly redundant, its removal improves density for segments it was redundant with. If it was unique, its removal has no density effect on other segments.
- **Relevance** is a token-weighted mean — removing candidates adjusts the weights. If removed candidates had below-average relevance, the projected relevance increases. If above-average, it decreases.
- **Continuity** is exact — the eviction cost formula (cl-spec-002 section 6.2) gives a precise continuity impact for each candidate, and costs are additive.
- **Composite** is recomputed from the projected dimension scores using the standard geometric mean formula (cl-spec-002 section 8.2).

The projection answers the caller's core question: "if I execute this plan, will my window be healthier?" A plan where the projected composite exceeds the current composite is a net-positive eviction — the window improves by removing the recommended content. A plan where the projected composite is lower is a necessary-evil eviction — the window degrades, but the capacity pressure is worse.

### 4.5 Plan Staleness

An eviction plan is a snapshot. It reflects the window state at generation time. Any mutation after plan generation — `add`, `update`, `evict`, `compact`, `setTask`, or a provider change — invalidates the plan's assumptions.

context-lens does not track plan staleness automatically. Plans are returned as data objects with no live connection to the instance. The caller is responsible for the freshness of plans they hold.

**Recommended usage pattern:**

```
plan = lens.planEviction({ targetUtilization: 0.70 })
for candidate in plan.candidates:
    if candidate.cumulativeTokens >= plan.target.tokens:
        break
    lens.evict(candidate.id, "eviction-plan:" + plan.planId)

// Plan is now stale — window state has changed.
// If further eviction is needed:
report = lens.assess()
plan = lens.planEviction({ targetUtilization: 0.70 })
```

The eviction `reason` field ties evictions to the plan that recommended them, creating an audit trail visible in the continuity ledger and eviction history.

**Partial execution.** The caller is not obligated to execute the entire plan. They may evict the first three candidates and stop. They may skip a candidate they want to keep. They may execute candidates out of order. The plan is a recommendation, not a transaction. Partial execution means the remaining candidates' impact estimates are stale, but the evictions already performed are valid.

## 5. Planning Strategies

The ranking model (section 2) assigns eviction scores. The protection tier ordering (section 3) partitions candidates into tiers. The planning strategy controls *how* the ranking model weighs its signals — which quality dimension the advisory amplifies and which it relaxes — and adds behavioral rules that go beyond weight adjustment. A strategy is the advisory's posture: given what is wrong with this window, what kind of eviction is most appropriate?

Every eviction plan is produced under exactly one strategy. The plan's `strategy` field (section 4.2) records which strategy was used, so the caller can trace why candidates were ordered the way they were. When the caller passes `strategy: "auto"` (the default), the advisory selects a strategy based on active degradation patterns. When the caller names a strategy explicitly, the advisory uses it regardless of what patterns are active.

### 5.1 StrategyName

The `StrategyName` type is a string enum with six values:

| Value | Meaning |
|-------|---------|
| `"auto"` | The advisory selects the strategy (section 5.3). This is the default when the caller does not specify a strategy. `"auto"` never appears in the plan output — the plan always reports the resolved strategy. |
| `"default"` | Balanced ranking with no pattern bias. The default weights (section 2.3) apply without adjustment. Appropriate when no degradation pattern is active or when the caller wants a general-purpose eviction without pattern-specific targeting. |
| `"saturation"` | Maximize token reclamation per eviction. Targets large, low-value segments. Driven by the saturation pattern (cl-spec-003 section 3). |
| `"erosion"` | Target redundancy. Prefers evicting content whose information survives elsewhere in the window. Driven by the erosion pattern (cl-spec-003 section 4). |
| `"gap"` | Target irrelevance. Prefers evicting content that does not serve the current task. Driven by the gap pattern (cl-spec-003 section 6). |
| `"collapse"` | Minimize further information loss. Prefers compaction over eviction and protects coherence-critical segments. Driven by the collapse pattern (cl-spec-003 section 7). |

Five of the six degradation patterns (cl-spec-003 sections 3–7) map to strategies. One does not — fracture. Section 5.8 explains why.

### 5.2 What a Strategy Controls

A strategy influences the eviction plan through three mechanisms:

1. **Weight adjustment.** Each strategy defines a set of signal weights for the eviction score formula (section 2.1). The weight tables are defined in section 2.4. The strategy name selects the row. This is the primary mechanism — it reshapes the ranking by amplifying the signal most relevant to the active problem.

2. **Behavioral rules.** Some strategies impose rules that cannot be expressed as weight adjustments. These are tie-breaking preferences, recommendation biases (evict vs. compact), or candidate annotations that carry information beyond the eviction score. Each named strategy's behavioral rules are defined in sections 5.4–5.7.

3. **Candidate filtering.** In rare cases, a strategy may filter candidates that would otherwise appear. The collapse strategy, for example, suppresses candidates whose eviction would push continuity below the collapse critical threshold (section 5.8). Filtering is conservative — a strategy removes candidates only when including them would be actively counterproductive, not merely suboptimal.

A strategy does **not** control:
- Protection tier ordering. Tiers are hard constraints (section 3). No strategy can promote a `default` segment above a `priority(n)` segment or skip the seed compaction-first rule.
- The reclamation target. The target comes from the caller's `PlanOptions` (section 4.1). The strategy determines *how* to reach the target, not *what* the target is.
- Plan structure. Every strategy produces the same `EvictionPlan` shape (section 4.2). The caller does not need to handle different plan formats for different strategies.

### 5.3 Auto-Selection

When the caller passes `strategy: "auto"` or omits the field, the advisory selects a strategy based on the active degradation patterns in the current quality report. The selection algorithm is deterministic and runs in three phases.

**Phase 1: Collect active patterns.**

The advisory reads `qualityReport.patterns` — the detection result produced by the framework defined in cl-spec-003 section 2. This gives the set of active patterns, each with a severity, a priority (cl-spec-003 section 8.3), and optionally a compound context (cl-spec-003 section 8.2).

If no patterns are active, auto-selection resolves to `"default"`. The window is healthy or at least not measurably degraded — a balanced strategy is appropriate.

**Phase 2: Check for compound patterns.**

Compound patterns represent specific co-occurrences where the optimal strategy diverges from what simple priority ordering would suggest. The advisory checks for known compounds before falling through to priority-based selection.

| Compound | Active patterns | Selected strategy | Rationale |
|----------|----------------|-------------------|-----------|
| `fullOfJunk` | Saturation + Erosion | `"erosion"` | Deduplication resolves both patterns simultaneously — it reclaims capacity (relieving saturation) and improves density (resolving erosion). The erosion strategy's amplified information-loss signal targets the redundant content that is causing both problems. This follows the compound's remediation shift (cl-spec-003 section 8.2): "deduplicate first." |
| `fullOfWrongThings` | Saturation + Gap | `"gap"` | The window is full of irrelevant content. Generic capacity-focused eviction (the saturation strategy) would reclaim tokens without regard for relevance and might remove the few relevant segments that remain. The gap strategy's amplified relevance signal ensures irrelevant content is evicted first. |
| `scatteredAndIrrelevant` | Fracture + Gap | `"gap"` | Content is both disconnected and irrelevant. Restructuring (fracture's natural remedy) is pointless when the content being restructured serves no task purpose. The gap strategy removes irrelevant content first; once what remains is relevant, coherence can be addressed in a subsequent plan-execute-replan cycle. |
| `lossDominates` | Collapse + any | `"collapse"` | When collapse is active alongside another pattern, the irreversibility of information loss takes precedence. The collapse strategy prioritizes coherence preservation and prefers compaction over eviction, reducing the risk of deepening the loss. |
| `pressureLoop` | Collapse + Saturation | `"collapse"` | This is the hardest compound — restoring content worsens saturation, evicting content deepens collapse. The collapse strategy is selected because further information loss is the less reversible harm. The strategy's preference for compaction over eviction (section 5.8) creates room through zero-loss operations, which is the compound's recommended escape path. |
| `triplePressure` | Saturation + Erosion + Gap | `"gap"` | The window is full, redundant, and irrelevant. The gap strategy's heavy relevance weighting (0.45) targets content that is both irrelevant and redundant first — these candidates score low on both relevance retention and information loss, making them ideal eviction targets that address all three patterns simultaneously. |

**Compound precedence.** If multiple compounds are detected simultaneously (possible only with three or more active patterns — e.g., saturation + erosion + gap activates both `fullOfJunk` and `triplePressure`), the advisory selects the compound with the most participating patterns. Ties are broken by the highest-priority pattern among participants (cl-spec-003 section 8.3, lower priority number wins). In practice, the `triplePressure` compound subsumes `fullOfJunk` and `fullOfWrongThings` when all three patterns are active.

**Phase 3: Priority-based fallback.**

If no compound is detected (either because only one pattern is active or because the active combination does not match a known compound), the advisory selects the strategy corresponding to the highest-priority active pattern:

| Pattern priority | Pattern | Strategy |
|-----------------|---------|----------|
| 1 | Collapse | `"collapse"` |
| 2 | Saturation | `"saturation"` |
| 3 | Gap | `"gap"` |
| 4 | Erosion | `"erosion"` |
| 5 | Fracture | `"default"` |

Fracture maps to `"default"` because it has no dedicated strategy (section 5.9). When fracture is the only active pattern, balanced eviction is the best the advisory can offer — fracture's true remedy is restructuring, not eviction.

**Custom pattern handling.** Custom patterns (cl-spec-003 section 10) participate in Phase 3 but not Phase 2.

- **Phase 2 (compounds):** Custom patterns do not participate in compound detection (cl-spec-003 section 10.8). Only base patterns trigger compound-based strategy selection.
- **Phase 3 (priority fallback):** Custom patterns are considered alongside base patterns in priority order. When a custom pattern is the highest-priority active pattern, the strategy is determined by its `strategyHint` field:
  - `"token-focused"` → `"saturation"` strategy weights.
  - `"redundancy-focused"` → `"erosion"` strategy weights.
  - `"relevance-focused"` → `"gap"` strategy weights.
  - `"coherence-preserving"` → `"collapse"` strategy weights.
  - No hint → `"default"` strategy weights.

Custom patterns default to priority 1000 (after all base patterns, which use priorities 1–5). Unless the caller explicitly sets a lower priority on a custom pattern, base patterns always take precedence in Phase 3. A custom pattern drives strategy selection only when no base patterns are active or when the caller has assigned it a priority that sorts above the active base patterns.

**Selection is logged, not hidden.** The plan metadata includes the resolved strategy and the patterns that drove the selection. When a compound influenced the choice, the plan's `reason` field at the top level notes which compound was detected and why it overrode the priority-based default. The caller should never be surprised by the strategy — the reasoning is in the plan.

### 5.4 Default Strategy

The default strategy is the advisory's neutral posture. It applies the base weights (section 2.3) without adjustment, imposes no behavioral rules beyond the standard tie-breaking cascade (section 2.5), and adds no candidate annotations or filtering.

**When it applies:**
- Auto-selection with no active patterns.
- Auto-selection with fracture as the only active pattern.
- Explicit `strategy: "default"` from the caller.

**Weight profile:** `w_r = 0.30`, `w_d = 0.25`, `w_c = 0.20`, `w_i = 0.15`, `w_a = 0.10` (unchanged).

**Behavioral rules:** None. Standard ranking and tie-breaking. Compaction recommendations generated per the normal rules (section 9) — for seed candidates and, when `includeCompactionAlternatives` is true, for any candidate where compaction would meet the remaining reclamation need.

**Recommendation bias:** Neutral. The default strategy has no preference between eviction and compaction beyond what the standard rules produce. If compaction suffices, it recommends compaction. If not, it recommends eviction.

The default strategy is not inferior to the pattern-driven strategies — it is the correct choice when no specific degradation pattern dominates. A window with mildly elevated utilization, slightly below-average density, and no alarming scores is best served by balanced eviction that does not over-optimize for one dimension at the expense of others.

### 5.5 Saturation-Driven Strategy

Saturation means the window is running out of room. The saturation strategy optimizes for reclaiming the most tokens with the fewest evictions, accepting minor quality costs that the balanced strategy would avoid.

**When it applies:**
- Auto-selection with saturation as the highest-priority active pattern (and no compound override).
- Explicit `strategy: "saturation"` from the caller.

**Weight profile:** See section 2.4, saturation row. Relevance is demoted (0.20 from 0.30) because the goal is space, not focus. Information loss is elevated (0.30 from 0.25) — redundant content is the cheapest to remove under capacity pressure, so the signal is amplified. Coherence is demoted (0.15 from 0.20) because some coherence loss is acceptable when the alternative is being unable to add new content at all. Age is elevated (0.20 from 0.10) to prefer evicting older content when reclaiming capacity.

**Behavioral rules:**

1. **Token-size tie-breaking.** Among candidates with eviction scores within 0.05 of each other, the saturation strategy prefers the candidate with the higher token count. This is a secondary sort applied after the eviction score sort, within the 0.05 band. The effect: when two candidates are roughly equally expensive to lose, prefer the one that frees more tokens. This produces fewer, larger evictions rather than many small ones — fewer evictions mean fewer continuity ledger entries and less operational overhead for the caller. Already defined in section 2.4; restated here for completeness.

2. **Eviction over compaction.** The saturation strategy biases toward eviction recommendations over compaction. Compaction reclaims partial tokens (the savings depend on the compression ratio and the content's compressibility). Eviction reclaims the candidate's full token count. Under capacity pressure, certainty of reclamation matters — the caller needs to know that executing the plan will reach the target. The saturation strategy still recommends compaction for seed candidates (section 3.3, compaction-first rule) and for candidates where the compaction savings alone meet the remaining target. But for candidates where both eviction and compaction are viable and neither is forced by protection rules, it recommends eviction.

3. **Headroom annotation.** When the reclamation target brings utilization to within 0.10 of the saturation `watch` threshold (default 0.75, cl-spec-003 section 3.3), the plan's top-level `reason` includes a note: the target may not provide sufficient headroom to prevent re-saturation on the next few adds. This is advisory — the strategy does not inflate the target. But it alerts the caller that a slightly more aggressive target would avoid a plan-execute-saturate-replan loop.

**What the saturation strategy does not do:** It does not override protection tiers. A window full of priority segments under capacity pressure still respects the tier ordering. If the caller needs to evict priority content, they must lower the protection or use the explicit strategy with a higher `maxCandidates`.

### 5.6 Erosion-Driven Strategy

Erosion means the window is full of redundant content — the same information repeated across multiple segments. The erosion strategy targets this redundancy directly, ranking candidates by how much of their information survives elsewhere.

**When it applies:**
- Auto-selection with erosion as the highest-priority active pattern (and no compound override).
- Auto-selection with the `fullOfJunk` compound (saturation + erosion).
- Explicit `strategy: "erosion"` from the caller.

**Weight profile:** See section 2.4, erosion row. The information-loss signal dominates at 0.40 (up from 0.25). Relevance is demoted to 0.20 because erosion does not care whether the redundant content is relevant or irrelevant — what matters is that it is duplicated. A redundant relevant segment is as wasteful as a redundant irrelevant one. Coherence is demoted to 0.15 because removing one copy of duplicated content has minimal coherence impact — the other copy preserves the topical presence.

**Behavioral rules:**

1. **Redundancy-pair annotation.** When a candidate has redundancy above 0.5 (more than half its content exists in at least one other segment), the candidate's `reason` field identifies the segment(s) it is redundant with. The format: `"redundant with segment <id> (overlap: <redundancy>)"`. This serves two purposes — it helps the caller verify the redundancy claim before evicting, and it signals that evicting this candidate changes the partner segment's density score (the partner becomes more unique). The annotation does not change ranking — it is informational. Up to three partner segments are listed, ordered by pairwise redundancy descending.

2. **Pair-aware ordering.** When two segments are highly redundant with each other (pairwise redundancy > 0.8, the near-duplicate threshold from cl-spec-002 section 4.2), the erosion strategy ensures only one appears in the plan as a recommended eviction. Including both would be misleading — evicting one changes the other's information-loss score dramatically (from near-zero to moderate, since the surviving copy is now unique). The strategy includes the worse candidate of the pair (higher eviction score after erasure of the redundancy signal — i.e., which candidate is worse on the non-redundancy dimensions) and annotates it with `"near-duplicate of <id> — evicting one copy is sufficient"`. The partner is omitted from the plan, not ranked lower — because its eviction score is meaningfully wrong once its partner is removed.

   **Scope of pair suppression.** Only near-duplicate pairs (redundancy > 0.8) trigger suppression. Moderate redundancy (0.5–0.8) does not suppress partners because both copies carry enough unique information to warrant independent evaluation. The threshold matches the near-duplicate definition in cl-spec-002 section 4.2.

3. **Compaction for moderate redundancy.** For candidates with redundancy in the 0.5–0.8 range (significant overlap but enough unique content to matter), the erosion strategy prefers compaction over eviction when `includeCompactionAlternatives` is true. Compaction preserves the unique portion while shedding the redundant portion — the ideal outcome for segments that are partially but not fully duplicated. This aligns with the erosion remediation hints in cl-spec-003 section 4.5, which recommend compaction for this redundancy band.

### 5.7 Gap-Driven Strategy

Gap means the window's content does not serve the current task — relevance scores are low across segments that occupy significant capacity. The gap strategy targets irrelevant content aggressively, treating relevance as the dominant ranking signal.

**When it applies:**
- Auto-selection with gap as the highest-priority active pattern (and no compound override).
- Auto-selection with the `fullOfWrongThings` compound (saturation + gap).
- Auto-selection with the `scatteredAndIrrelevant` compound (fracture + gap).
- Auto-selection with the `triplePressure` compound (saturation + erosion + gap).
- Explicit `strategy: "gap"` from the caller.

**Weight profile:** See section 2.4, gap row. Relevance dominates at 0.45 (up from 0.30). Coherence is demoted to 0.10 because off-task content may bridge off-task topics, and removing those bridges is not a loss — coherence among irrelevant content has no value. Information loss is slightly reduced (0.20 from 0.25) because uniqueness of irrelevant content matters less than uniqueness of relevant content — losing information the model does not need is acceptable.

**Behavioral rules:**

1. **Relevance-band annotation.** Each candidate's `reason` field includes a relevance classification: `"irrelevant"` (relevance < 0.3), `"marginally relevant"` (0.3–0.5), `"moderately relevant"` (0.5–0.7), or `"relevant"` (> 0.7). The bands are not scoring thresholds — they are human-readable labels that help the caller quickly scan the plan and identify where the relevance cliff falls. The gap strategy's weight profile means irrelevant candidates dominate the top of the plan, but the bands make the structure visible without inspecting scores.

2. **Coherence penalty suppressed for low-relevance candidates.** The gap strategy demotes coherence globally (weight 0.10), but it goes further for candidates with relevance below 0.3: their coherence contribution signal is capped at 0.3 regardless of the actual bridge score. This prevents a high-bridge-score, completely-irrelevant segment from resisting eviction. An irrelevant segment that happens to bridge two topical clusters is still a poor use of capacity — the clusters it bridges are themselves irrelevant clusters that may be evicted in subsequent cycles. The cap is applied before the weighted sum, not after.

3. **Task transition caution.** If the task state indicates a recent task change — the grace period has not expired (cl-spec-004 section 5) — the gap strategy annotates the plan with a warning: `"task changed recently — relevance scores may not reflect the new task's alignment with existing content. Consider re-assessing after the grace period expires."` The warning does not change the ranking or suppress candidates. Relevance scores during the grace period are computed against the new task descriptor and are valid — but the caller may not have had time to add task-relevant content, so low relevance may reflect missing content rather than wrong content. The annotation surfaces this ambiguity.

**What the gap strategy does not do:** It does not verify that the task descriptor is current. Stale task descriptors (cl-spec-004 section 5.3) produce stale relevance scores, and the gap strategy will faithfully target low-relevance candidates based on those stale scores. If the descriptor is stale, the evictions may be wrong — the content may be relevant to the actual (undescribed) task but irrelevant to the outdated descriptor. The gap pattern's own remediation hints (cl-spec-003 section 6.5) address this by suggesting `updateTask` before eviction. The strategy trusts that the caller has acted on that hint or is comfortable with the descriptor's freshness.

### 5.8 Collapse-Driven Strategy

Collapse means information has already been lost — continuity scores are degraded because prior evictions or compactions removed content that cannot be fully recovered. The collapse strategy is defensive: it minimizes further loss, prefers compaction over eviction, and protects coherence-critical segments that an aggressive strategy would sacrifice.

**When it applies:**
- Auto-selection with collapse as the highest-priority active pattern.
- Auto-selection with the `lossDominates` compound (collapse + any).
- Auto-selection with the `pressureLoop` compound (collapse + saturation).
- Explicit `strategy: "collapse"` from the caller.

**Weight profile:** See section 2.4, collapse row. Coherence is elevated to 0.25 (up from 0.20) — preserving the window's remaining structure is critical when structure has already been damaged. Relevance and information loss are balanced at 0.25 each. The profile is the most conservative of the pattern-driven strategies — no single signal dominates, because collapse is about damage control across all dimensions.

**Behavioral rules:**

1. **Compaction over eviction.** The collapse strategy inverts the default recommendation bias. For every candidate where compaction is feasible (the segment is not already compacted and estimated compaction savings exceed a minimum threshold of 20% of the segment's token count), the strategy recommends compaction rather than eviction. Compaction preserves information in compressed form — the summary retains the segment's key content and the continuity ledger records a `compacted` entry with partial cost, not a `removed` entry with full cost. The only exceptions: candidates with redundancy above 0.8 (near-duplicates), where eviction is safe because the information survives in the partner, and candidates in the `default` protection tier with relevance below 0.2, where compaction of deeply irrelevant content wastes effort.

2. **Continuity floor guard.** Before including a candidate, the collapse strategy checks whether evicting it would push the projected continuity score below the collapse `critical` threshold (default 0.3, cl-spec-003 section 7.3). If so, the candidate is excluded from the plan and annotated with `"excluded: eviction would deepen collapse beyond critical threshold"`. The projected continuity is computed using the eviction cost formula (cl-spec-002 section 6.2) — it is exact, not estimated. The guard is cumulative: each candidate's continuity cost is added to the running total, so the nth candidate's exclusion check accounts for the impact of all prior candidates in the plan.

   **When the guard prevents target satisfaction.** If excluding candidates causes the plan to fall short of the reclamation target, the plan reports `targetMet: false` with a `reason` explaining that further eviction was blocked by the continuity floor. The caller faces a choice: accept the shortfall, lower the continuity floor by overriding the collapse threshold (not recommended — it exists for a reason), or address the root cause by restoring high-value evicted segments (cl-spec-003 section 7.5 hint 1) and then replanning.

3. **Eviction cost annotation.** Each candidate's `reason` includes the precise continuity cost of evicting it, derived from the eviction cost formula: `"continuity cost: <cost> (importance: <importance>, token fraction: <fraction>)"`. This gives the caller a clear view of what each eviction costs in the dimension that collapse has already damaged. No other strategy annotates continuity cost this explicitly — for the others, the `continuityDelta` field in `CandidateImpact` (section 4.3) suffices. The collapse strategy foregrounds it because continuity is the dimension under threat.

### 5.9 Why No Fracture Strategy

Five degradation patterns, four pattern-driven strategies. Fracture is the exception. The reason is fundamental: fracture's remedy is not eviction.

Fracture means the window's topical structure is fragmented — segments form disconnected clusters rather than a coherent thread. The remediation hints for fracture (cl-spec-003 section 5.5) reflect this: reorder segments to improve adjacency coherence, evict isolated off-topic fragments, compact scattered discussions into consolidated summaries, dissolve misleading groups. Of these, only "evict isolated off-topic fragments" is an eviction action — and it targets a narrow subset of segments (isolated, low-relevance) that the default strategy already handles well because the default weights give coherence contribution 0.20 and relevance 0.30, naturally ranking isolated irrelevant content near the top.

A hypothetical fracture strategy would need to amplify the coherence contribution signal — rank bridge segments last and isolated segments first. But coherence contribution already captures this in the default weights. Amplifying it further (e.g., `w_c = 0.35`) would over-protect bridge segments at the expense of other signals, producing plans that preserve coherence structure but ignore redundancy and relevance. A fragmented window of highly relevant, unique content is better served by restructuring than by eviction — and restructuring is outside the advisory's scope.

The right response to fracture is not "evict differently" but "reorder what you have." The advisory cannot reorder — it can only recommend what to remove. When fracture is the only active pattern and auto-selection resolves to `"default"`, the plan will naturally target isolated, low-relevance, redundant content. The caller should combine this with the fracture remediation hints from the detection framework, which recommend reordering and consolidation as primary actions.

### 5.10 Compound-Aware Selection Details

Section 5.3 defined which compound maps to which strategy. This section explains the reasoning behind the less obvious mappings and addresses edge cases.

**Why `fullOfJunk` selects erosion over saturation.** Pattern priority (cl-spec-003 section 8.3) ranks saturation above erosion. If the advisory used simple priority-based selection, `fullOfJunk` would resolve to `"saturation"`. But the compound's remediation shift says "deduplicate first" — and deduplication is erosion's domain. The erosion strategy's amplified information-loss weight (0.40) targets the redundant content that is causing both the capacity pressure and the density degradation. The saturation strategy's token-size preference would target large segments regardless of redundancy, potentially removing unique content that happens to be large. The compound override is the advisory's way of heeding the compound's more nuanced diagnosis over the blunt priority ordering.

**Why `pressureLoop` selects collapse, not a hybrid.** The pressure loop — collapse + saturation — presents a genuine dilemma: eviction deepens collapse, but not evicting maintains saturation. The collapse strategy is selected because information loss is less reversible than capacity pressure. Capacity pressure can be relieved by compaction (zero information loss), by the caller adding less content, or by increasing capacity. Information loss can only be partially recovered through restoration, and restoration itself requires capacity. The collapse strategy's compaction-over-eviction bias (section 5.8, rule 1) is the mechanism that breaks the loop — compaction frees tokens (relieving saturation) without removing content (preventing further collapse).

**Compound vs. single-pattern priority: when they disagree.** The compound resolution in phase 2 of auto-selection (section 5.3) takes precedence over the priority-based fallback in phase 3. This means a window with active collapse and active erosion — where collapse has priority 1 and erosion has priority 4 — resolves to `"collapse"` via the `lossDominates` compound in phase 2, which requires collapse + any pattern (including erosion). The collapse strategy is selected because information loss takes precedence. But a window with active saturation and active erosion — where saturation has priority 2 and erosion has priority 4 — resolves to `"erosion"` via the `fullOfJunk` compound in phase 2, overriding saturation's higher priority.

This is correct behavior, not an inconsistency. Compounds carry semantic information that priority alone does not: the combination of saturation + erosion is not just "saturation is the bigger problem" — it is "the saturation is caused by the erosion, so fixing erosion fixes both." The compound encodes this causal insight; the priority ordering does not.

**Patterns without compounds.** Some multi-pattern states do not match any known compound. For example, erosion + fracture — the window is redundant and fragmented. This combination has no compound because its diagnosis is merely additive ("the window has redundancy and fragmentation") and no strategy addresses both simultaneously better than addressing the higher-priority one. The advisory falls through to phase 3 and selects based on priority: erosion (priority 4) over fracture (priority 5), resolving to `"erosion"`.

### 5.11 Manual Strategy Selection

The caller can override auto-selection by passing an explicit `strategy` value in `PlanOptions`. Any strategy name except `"auto"` bypasses the selection algorithm entirely — the advisory uses the named strategy regardless of active patterns.

**When to override:**

- **Domain-specific knowledge.** The caller knows something the patterns do not. A caller who is about to load a large batch of new content may want the `"saturation"` strategy preemptively, before saturation activates — clearing room in advance.
- **Post-compound refinement.** After executing a compound-driven plan and replanning, the caller may want to address the remaining pattern with its natural strategy. If the `fullOfJunk` plan addressed the erosion, the remaining saturation can be targeted with `strategy: "saturation"` on the replan.
- **Testing and debugging.** During development, the caller may want to see how each strategy would rank the same window. Running `planEviction` with each strategy in sequence produces five plans that reveal how the strategies differ in their assessment.

**When not to override:**

- **When compound patterns are active.** The compound resolution exists because the naive priority-based strategy is suboptimal for specific pattern combinations. Overriding it without understanding the compound's remediation shift may produce a less effective plan.
- **When no degradation is present.** Using `"saturation"` on a window at 40% utilization or `"gap"` on a window with no task set produces a technically valid but semantically odd plan — the strategy amplifies a signal that is not informative.

**Override does not suppress pattern metadata.** The plan's `patterns` field still reports the active degradation patterns regardless of the selected strategy. The caller can see that they overrode auto-selection and what auto would have chosen by examining the patterns and compound context.

## 6. Group Handling

Groups are atomic eviction units (cl-spec-001 section 5.3). A group cannot be partially evicted — if the advisory recommends a group, it recommends all of its members as a single candidate. This introduces complications that individual-segment ranking does not face: groups may be larger than the remaining reclamation target, group scores must be aggregated from member scores, and group protection may differ from what the members would have independently. This section defines how the advisory handles each of these.

### 6.1 Groups as Candidates

When the advisory partitions candidates into tiers (section 3), grouped segments do not appear individually. Instead, the advisory replaces each group's members with a single group candidate. The group candidate has:

| Property | Derivation |
|----------|------------|
| `id` | The group ID |
| `type` | `"group"` |
| `tokenCount` | Sum of all member token counts |
| `tier` | Determined by effective protection (section 3.5) |
| `importance` | Group effective importance — explicit group value if set, otherwise max of member importances (cl-spec-001 section 5.2) |
| `memberIds` | Ordered list of member segment IDs |

A segment that belongs to a group never appears as an independent candidate. If the caller wants to evict individual members, they must dissolve the group first (`dissolveGroup`, cl-spec-007 section 4) and then replan. The advisory does not recommend dissolution — it is a structural decision outside the eviction planning scope.

### 6.2 Group Eviction Score

The group's eviction score is the **token-weighted mean** of its members' eviction scores:

```
evictionScore(group) = Σ(evictionScore(member_i) * tokenCount(member_i)) / Σ(tokenCount(member_i))
```

Token-weighting ensures that the score reflects how much of the group's capacity is cheap vs. expensive to remove. A 5-member group where one large member is highly redundant and four small members are unique will have a lower eviction score than an unweighted mean would produce — the large redundant member dominates, and correctly so, because the token savings are concentrated there.

**Why not min or max?** The minimum member score would make every group look like its best candidate — too optimistic. The maximum would make every group look like its worst — too pessimistic and would cause groups to resist eviction more than warranted. The weighted mean is the honest aggregate: it reflects the average cost per token of removing this group.

Each member's individual scores (relevance, density, coherence contribution, importance, age retention) are computed normally using the ranking model (section 2). The group-level eviction score is derived from the members' final eviction scores, not from aggregated signals — this preserves the signal weighting defined in section 2.3 or its strategy-adjusted variant (section 2.4).

### 6.3 Overshoot

A group may contain more tokens than the remaining reclamation target needs. Evicting a 5000-token group when only 2000 tokens remain in the target overshoots by 3000 tokens. The advisory includes the group anyway — atomic eviction means there is no "evict 2000 tokens of this group" option. The plan's `cumulativeTokens` field reflects the overshoot.

However, the advisory applies an **overshoot penalty** when a group candidate is being considered and smaller candidates in the same tier could meet the remaining target without overshoot. The penalty is not a score adjustment — it is a placement rule:

1. Walk the sorted candidates within the tier.
2. When the next candidate is a group whose `tokenCount` exceeds `remainingTarget * 2.0`, check whether enough individual (non-group) candidates exist in the remaining sorted list to meet the target.
3. If yes, defer the group — skip it for now and continue walking individual candidates. The group will be included only if the individual candidates do not suffice.
4. If no, include the group. Overshoot is preferable to an incomplete plan.

**Why 2x?** A small overshoot (group is 1.3x the remaining target) is acceptable — the alternative of deferring the group risks presenting a longer, more complex plan for marginal savings. At 2x and above, the cost of overshoot is significant enough that the advisory should prefer surgical individual evictions if they are available. The 2.0 threshold is not configurable.

The deferral is within-tier only. A group in tier 1 (default) is deferred only in favor of individual candidates also in tier 1. The advisory never promotes a tier-2 individual candidate ahead of a tier-1 group to avoid overshoot — protection tier ordering (section 3) is inviolable.

### 6.4 Group Impact Estimation

The `CandidateImpact` for a group candidate estimates the cumulative impact of evicting all members simultaneously:

- **Coherence delta.** Computed by removing all group members from the adjacency structure at once. If the group occupies a contiguous region of the segment order, the impact is the gap created between the segments before and after the group. If the group is scattered (members are non-contiguous), each member's removal is computed against the post-removal state of the members that precede it in the segment order. This is more expensive than individual impact estimation — O(m) per group where m is the member count — but necessary for accuracy because removing one member changes the adjacency structure for subsequent members.

- **Density delta.** Token-weighted, same approach as individual candidates. If group members were redundant with each other (common for groups, since grouped segments often cover the same topic), removing all of them eliminates that intra-group redundancy from the window-level density calculation. The net effect depends on whether the group's content was also redundant with non-group segments.

- **Relevance delta.** Token-weighted mean of member relevance deltas. Straightforward — removing a group removes its total relevance contribution proportional to its total token share.

- **Continuity delta.** Sum of member eviction costs. Each member's eviction cost is computed independently using the cl-spec-002 section 6.2 formula (`relevance × importance × tokenWeight`). Continuity costs are additive.

### 6.5 Group Coherence and Dissolution Hints

The quality model computes **group internal coherence** — the mean pairwise similarity among a group's members (cl-spec-002 section 3.6). When a group candidate's internal coherence is below 0.3, the advisory annotates the candidate's `reason` field:

```
"low internal coherence (0.22) — group members are not topically related. Consider dissolving and replanning for more surgical eviction."
```

This is not a recommendation to dissolve — the advisory does not produce dissolution recommendations. It is a hint that the group's atomicity constraint may be forcing the advisory to recommend evicting valuable members alongside expendable ones. Dissolving the group would allow the ranking model to evaluate each member independently, potentially producing a plan that evicts only the expendable members and retains the valuable ones.

The hint appears only when internal coherence is below 0.3. Above that, the group's members are topically related enough that atomic eviction is a reasonable tradeoff.

### 6.6 Nested Groups

context-lens does not support nested groups (cl-spec-001 section 5.4). A segment belongs to at most one group. The advisory does not need to handle group hierarchies, recursive token counting, or multi-level protection resolution.

## 7. Coherence Impact Estimation

The coherence contribution signal (section 2.2) measures how much removing a segment would damage the window's topical structure. This section defines the computation — the **bridge score** — and its properties.

### 7.1 The Bridge Metaphor

A context window's topical flow is a sequence of adjacency similarities. Each segment contributes to the flow by being topically connected to its neighbors. Some segments are interior to a topical cluster — surrounded by similar content on both sides. Removing an interior segment barely changes the flow because its neighbors are already similar to each other. Other segments are bridges — they connect two dissimilar regions. Removing a bridge fragments the flow because its neighbors, now adjacent to each other, have low similarity.

The bridge score captures this distinction. A high bridge score means the segment is structurally important — it holds disparate regions together. A low bridge score means the segment is structurally expendable — its neighbors do not depend on it for coherence.

### 7.2 Bridge Score Computation

For each active segment `i`, the bridge score is computed from the adjacency similarities that already exist in the quality report (cl-spec-002 section 3.3). The advisory performs no new similarity computations — it reads the similarity values the quality model has already cached.

**Interior segments** (segments with both a predecessor and a successor in the segment order):

```
leftSim   = similarity(i-1, i)
rightSim  = similarity(i, i+1)
skipSim   = similarity(i-1, i+1)
avgNeighborSim = (leftSim + rightSim) / 2.0

bridgeScore(i) = clamp(avgNeighborSim - skipSim, 0.0, 1.0)
```

The bridge score is the coherence drop that would occur at position `i` if the segment were removed. `avgNeighborSim` is the current average coherence contribution at this position. `skipSim` is what the coherence would be if the segment were gone and its neighbors became adjacent. The difference is the cost of removal.

If `skipSim >= avgNeighborSim`, the bridge score is zero — the neighbors are at least as similar to each other as they are to the segment. Removing it does not degrade coherence; it may even improve it. This can happen when a segment is an off-topic interjection between two on-topic neighbors.

**First segment** (no predecessor):

```
rightSim = similarity(0, 1)
bridgeScore(0) = 0.0
```

The first segment has no left neighbor to bridge. Its removal shifts segment 1 to the first position. There is no adjacency to break on the left side, so its bridge score is zero by convention. Its coherence contribution is captured by `rightSim`, but since there is no "skip" comparison possible, the bridge score cannot be computed by the standard formula.

**Last segment** (no successor):

```
leftSim = similarity(n-2, n-1)
bridgeScore(n-1) = 0.0
```

Symmetric with the first segment. The last segment bridges nothing on its right. Its removal leaves segment n-2 as the new last segment. Bridge score is zero.

**Single-segment window:**

```
bridgeScore(0) = 0.0
```

There is no topical structure to bridge when only one segment exists.

### 7.3 Skip Similarity

The bridge score formula requires `similarity(i-1, i+1)` — the similarity between the segment's neighbors, who may not currently be adjacent. This is the **skip similarity**. The quality model's similarity cache stores similarities for adjacent pairs (cl-spec-002 section 3.3), but skip similarities are non-adjacent.

The advisory computes skip similarities on demand during plan generation. These are O(1) per segment (one similarity lookup or computation per candidate). The total cost for a window of `n` segments is O(n) skip-similarity computations — one per interior candidate. This is within the performance budget because:

1. If embeddings are available, cosine similarity between cached embedding vectors is a dot product — microseconds.
2. If trigrams are the fallback, Jaccard similarity between cached trigram sets is a set intersection — milliseconds for typical segment sizes.
3. Skip similarities are computed only during `planEviction`, not during `assess`. They are transient — not cached, not reused between plans. Caching them would add complexity for minimal benefit since plans are snapshots that become stale on the next mutation.

### 7.4 Bridge Score Properties

- **Range:** [0.0, 1.0]. A score of 0.0 means the segment is not a bridge — its neighbors are at least as coherent without it. A score of 1.0 means the segment is a critical bridge — its neighbors have zero similarity, and the segment is the only connection between them.
- **Symmetry:** The bridge score is not symmetric in the segment order. Moving a segment from position `i` to position `j` changes its bridge score because it now has different neighbors. The score is a property of the segment *at its current position*, not an intrinsic property of its content.
- **Transitivity:** The bridge score does not account for second-order effects. If segments A, B, C are sequential and both A-B and B-C have high similarity but A-C have low similarity, removing B produces a high bridge score. But removing B and C together might have a lower combined coherence impact than the sum of their individual bridge scores suggests, because A would then be adjacent to D. The advisory's independent scoring (section 2.6) means these transitive effects are not modeled. The plan-execute-replan cycle (section 4.5) addresses this — after executing part of the plan, the caller replans with the updated state.

### 7.5 Bridge Score for Groups

When a group is contiguous in the segment order (all members are adjacent to each other with no non-member segments interleaved), the group's bridge score is computed as if the group were a single segment:

```
leftSim  = similarity(predecessor of first member, first member)
rightSim = similarity(last member, successor of last member)
skipSim  = similarity(predecessor of first member, successor of last member)

bridgeScore(group) = clamp((leftSim + rightSim) / 2.0 - skipSim, 0.0, 1.0)
```

When a group is **non-contiguous** (members are scattered through the segment order with non-member segments between them), the bridge score is the **maximum** of the individual member bridge scores. The maximum is used because removing all members removes the worst bridge among them — that worst bridge dominates the coherence impact. A non-contiguous group is rare in practice (callers typically group segments that are already adjacent), but the advisory handles it correctly rather than assuming contiguity.

### 7.6 What Bridge Score Does Not Capture

The bridge score measures local adjacency impact — the coherence change at the segment's immediate neighborhood. It does not capture global coherence effects:

- **Topical concentration.** The quality model's coherence score includes a topical concentration component (cl-spec-002 section 3.4) — how many topical clusters exist and how evenly segments distribute across them. Evicting a segment might merge two clusters (improving concentration) or isolate a cluster (worsening it). The bridge score does not model this. The `coherenceDelta` in `CandidateImpact` (section 4.3) includes an approximation of the concentration effect, but the bridge score signal in the ranking model does not.

- **Group integrity.** Evicting a non-member segment adjacent to a group might damage that group's connection to the broader window without affecting the group's internal coherence. The bridge score captures this (the non-member's bridge score reflects the similarity gap its removal creates), but it does not know about the group boundary. Group integrity is the quality model's concern; the bridge score is a local measurement.

## 8. Task-Aware Eviction

The task descriptor (cl-spec-004) is the most powerful signal available to the eviction advisory. When a task is set, the advisory can distinguish content that serves the current goal from content that does not — and target the latter for eviction. When no task is set, the advisory is blind to relevance and must rely on density, coherence, importance, and age alone. This section defines how task state — active, unset, recently changed, stale — modulates the advisory's behavior.

### 8.1 No Task Set

When the task state is `UNSET` (cl-spec-004 section 4), all segments have relevance 1.0 (cl-spec-002 section 5.1). The relevance retention signal (section 2.2) is 1.0 for every candidate. Its contribution to the eviction score is identical across candidates: `w_r * 1.0`. The signal does not differentiate — it contributes a constant offset.

**Effective behavior with no task:**

- The gap strategy is unavailable — gap requires a task descriptor (cl-spec-003 section 6.1). Auto-selection never resolves to `"gap"` when no task is set.
- The `fullOfWrongThings`, `scatteredAndIrrelevant`, and `triplePressure` compounds cannot activate — they require gap, which requires a task.
- The remaining signals — information loss, coherence contribution, importance, age — determine the ranking. The advisory effectively reduces to a four-signal model with adjusted effective weights:

| Signal | Effective contribution |
|--------|----------------------|
| Information loss | 0.25 / 0.70 ≈ 0.36 |
| Coherence contribution | 0.20 / 0.70 ≈ 0.29 |
| Importance | 0.15 / 0.70 ≈ 0.21 |
| Age | 0.10 / 0.70 ≈ 0.14 |

The effective weights are the original weights renormalized after removing relevance's differentiating power. The advisory does not actually renormalize — the eviction scores include the constant relevance term — but the ranking order is determined entirely by the four non-relevance signals. The effect is the same as if relevance were removed and the remaining weights renormalized.

This is the correct behavior. Without a task, the advisory cannot make relevance-based decisions and should not pretend to. It falls back to structural signals: remove redundant content, preserve coherence, respect importance, prefer old content. These are sensible heuristics for any context window, task-aware or not.

### 8.2 Active Task

When a task is active, relevance differentiates candidates. Segments with low relevance — content that does not serve the current task — rank as better eviction targets. Segments with high relevance resist eviction. This is the advisory's primary value proposition: quality-aware eviction that targets the right content, not just the oldest or largest.

**Relevance amplification under the gap strategy.** When the gap pattern is active and the gap strategy is selected (section 5.7), relevance's weight increases to 0.45 — nearly half the eviction score. This makes the advisory aggressive about removing irrelevant content. The gap strategy's behavioral rules (section 5.7) add further refinements: coherence penalty suppression for low-relevance candidates, relevance-band annotations, and task-transition caution.

**Metadata relevance signals.** The per-segment relevance score computed by the quality model (cl-spec-002 section 5.5) incorporates not just content-to-task similarity but also metadata signals:

- **Origin relevance.** Segments whose `origin` matches a `relatedOrigin` in the task descriptor receive a relevance boost. The advisory benefits from this indirectly — segments from task-related origins have higher relevance scores and therefore higher eviction scores (more resistant to eviction). The advisory does not inspect origins directly; it consumes the relevance score that already incorporates origin matching.
- **Tag relevance.** Similarly, segments with tags matching `relatedTags` in the task descriptor have boosted relevance. The effect propagates to the advisory through the relevance score.
- **Protection relevance floor.** Seed segments have a relevance floor of 0.3 (cl-spec-002 section 5.4) even if their content is completely unrelated to the task. This floor propagates through the advisory — seed segments never appear maximally irrelevant, which means the gap strategy never treats them as aggressively as it treats irrelevant `default` segments. This is consistent with the seed tier's compaction-first rule (section 3.3).

### 8.3 Grace Period

When the caller has recently changed the task (cl-spec-004 section 5), the grace period is active for 2 quality reports. During the grace period:

- Gap pattern severity is capped at `watch` (cl-spec-004 section 5.1). This means the gap strategy is less likely to be selected by auto-selection — a capped-at-watch gap will not outprioritize a warning-level saturation or erosion pattern.
- Relevance scores are valid but volatile. The scores reflect similarity to the new task descriptor, but the window has not yet adapted — content from the previous task remains, and the caller may not have added task-relevant content yet. Low relevance during the grace period may mean "wrong content" or "not enough new content yet."

**Advisory behavior during the grace period:**

The advisory does not suppress or modify its ranking during the grace period. If the caller calls `planEviction` during the grace period, the plan is generated normally using current relevance scores. The gap strategy's task-transition caution (section 5.7, rule 3) annotates the plan with a warning, but the ranking is unmodified.

This is intentional. The grace period is a diagnostic mechanism — it prevents the gap pattern from alarming the caller during a transition. But if the caller explicitly requests an eviction plan during the grace period, they have made a conscious decision to act on the current state. The advisory should not second-guess this by silently altering the plan. The annotation surfaces the risk; the caller decides whether to proceed.

**Replanning after the grace period.** The recommended pattern after a task change is:

```
lens.setTask(newDescriptor)
// ... add task-relevant content ...
report = lens.assess()              // grace report 1
report = lens.assess()              // grace report 2 (grace expires)
plan = lens.planEviction({ ... })   // relevance scores now reflect settled state
```

This gives the window time to adapt and produces a plan based on stable relevance scores. Callers who replan during the grace period should be aware that the plan may become significantly different after the grace expires.

### 8.4 Stale Task Descriptor

When the task descriptor is stale (5+ reports without `setTask`, cl-spec-004 section 5.3), relevance scores may not reflect the caller's actual current task. The advisory does not detect staleness independently — it consumes the staleness flag from the task state (cl-spec-004 section 5.3).

**Advisory behavior with a stale descriptor:**

- If the gap pattern is active at `warning` or `critical` and the descriptor is stale, the gap remediation hints (cl-spec-003 section 6.5) recommend `updateTask` before eviction. The advisory echoes this guidance: when generating a plan under the gap strategy with a stale descriptor, the plan's top-level `reason` includes: `"task descriptor is stale (no setTask in 5+ reports) — relevance scores may not reflect the current task. Consider calling setTask before executing this plan."`
- The advisory does not refuse to plan. A stale descriptor is informational — the caller may know that their task has not changed and deliberately avoided calling `setTask`. The advisory trusts the caller's decision and plans accordingly. If the caller acts on stale relevance and evicts content that turns out to be relevant to their actual task, the continuity ledger records the loss and the collapse pattern may activate — the system is self-correcting over time.

### 8.5 Task Change Between Plan and Execution

If the caller generates a plan, then calls `setTask` with a new descriptor, and then executes the plan, the plan's relevance-based recommendations are stale. Content that was irrelevant to the old task may be relevant to the new one, and the plan would incorrectly recommend evicting it.

The advisory does not guard against this — plans are snapshots (section 4.5) with no live connection to the instance. The caller is responsible for replanning after a task change. The `setTask` operation invalidates all relevance scores (cl-spec-004 section 3.3), and the advisory's recommendations are derived from those scores, so any pre-change plan is stale by construction.

**Defensive recommendation:** Callers who integrate `setTask` and `planEviction` should always call `planEviction` *after* the last `setTask` in a sequence. If the caller's workflow involves multiple task changes in rapid succession, they should wait until the task stabilizes before planning eviction.

## 9. Compaction Recommendations

Eviction removes content entirely. Compaction replaces content with a shorter summary, reclaiming tokens while preserving information in compressed form. The eviction advisory can recommend compaction instead of eviction for candidates where compaction would reclaim enough tokens and where the information loss of full eviction is avoidable. This section defines the `CompactionRecommendation` structure, the conditions under which compaction is recommended, and the estimation of compaction savings.

### 9.1 When Compaction Is Recommended

Compaction is recommended instead of eviction when all of the following conditions are met:

1. **The candidate is not already compacted.** If the segment's origin is `"summary:compacted"` (cl-spec-001 section 7.5), it has already been compacted. Compacting again yields diminishing returns and compounds information loss. The advisory recommends eviction for already-compacted candidates.

2. **The candidate is not pinned.** Pinned segments are not compactable (cl-spec-001 section 6.1). They are also excluded from the plan entirely (section 3.4), so this condition is always met for candidates that appear in the plan.

3. **Estimated compaction savings meet the remaining reclamation target, or the candidate is a seed.** For seed candidates, compaction is always recommended before eviction (section 3.3) regardless of whether the savings meet the target — this is the seed compaction-first rule. For non-seed candidates, compaction is recommended only when the estimated savings would be sufficient to fill the remaining reclamation gap, because compaction that does not meet the target merely delays the eviction.

4. **The `includeCompactionAlternatives` option is true (default).** The caller can disable compaction recommendations entirely by passing `includeCompactionAlternatives: false` in `PlanOptions` (section 4.1). When disabled, the advisory recommends eviction for all candidates except seeds (which still receive compaction-first treatment due to the protection rule).

5. **Strategy-specific bias permits it.** The saturation strategy biases toward eviction (section 5.5, rule 2) because it needs certain token reclamation. The collapse strategy biases toward compaction (section 5.8, rule 1) because it needs to minimize information loss. The erosion strategy recommends compaction for moderate redundancy (section 5.6, rule 3). The default and gap strategies have no bias.

### 9.2 CompactionRecommendation Structure

When a candidate's `recommendation` field is `"compact"`, the `compaction` field contains:

| Field | Type | Description |
|-------|------|-------------|
| `segmentId` | string | The segment to compact. For group candidates, see section 9.5. |
| `currentTokens` | number | The segment's current token count. |
| `estimatedTargetTokens` | number | The estimated token count after compaction. |
| `estimatedSavings` | number | `currentTokens - estimatedTargetTokens`. Tokens the caller can expect to reclaim. |
| `compressionRatio` | number (0.0–1.0) | `estimatedTargetTokens / currentTokens`. Lower means more compression. |
| `continuityCost` | number | Estimated continuity cost of compaction, using the compaction cost formula (cl-spec-002 section 6.3). |
| `reason` | string | Human-readable explanation of why compaction is recommended over eviction. |

### 9.3 Compression Ratio Estimation

The advisory does not know how compressible a segment's content is — it does not read content (section 1, "the advisory does not read segment content"). It estimates compaction savings using a **target compression ratio** and the segment's current token count.

```
estimatedTargetTokens = ceil(currentTokens * targetCompressionRatio)
estimatedSavings      = currentTokens - estimatedTargetTokens
```

**Target compression ratio:** Default 0.5 — the advisory assumes compaction will halve the segment's token count. This is a conservative estimate; actual compaction savings depend on the content and the summary the caller generates. The target compression ratio is not configurable per plan — it is a property of the advisory's estimation model, not a parameter the caller tunes.

**Why 0.5?** A well-written summary of a passage typically compresses to 40–60% of the original length. Using 0.5 as the estimate is middle-of-the-range. If the caller consistently achieves better compression (e.g., 0.3), the advisory underestimates savings — the plan is conservative, which is safe. If the caller achieves worse compression (e.g., 0.7), the advisory overestimates savings — the plan may not reclaim as much as projected, and the caller should replan. Overestimation is the riskier direction, but 0.5 is chosen to be realistic, not optimistic.

**Minimum savings threshold.** The advisory does not recommend compacting a segment where estimated savings are below 20% of the segment's token count (i.e., `estimatedSavings < currentTokens * 0.20`). Small segments with few tokens gain almost nothing from compaction — the overhead of generating a summary (an LLM call the caller must make) is not justified by the token savings. This threshold applies after the compression ratio estimation: if `targetCompressionRatio` is 0.5 but the segment has only 50 tokens, the estimated savings are 25 tokens, and 25/50 = 0.50 which exceeds 0.20, so the recommendation stands. But a segment with 10 tokens would save 5 tokens — trivial, and the advisory skips the compaction recommendation.

### 9.4 Compaction Continuity Cost

The advisory estimates the continuity cost of compaction using the formula from cl-spec-002 section 6.3:

```
compactionCost = compressionRatio * segment.importance * (1.0 - redundancy(segment))
```

Where `compressionRatio` is `1.0 - (estimatedTargetTokens / currentTokens)` — the fraction of content removed by compression. For the default 0.5 target, this is 0.5.

The compaction cost is always less than or equal to the eviction cost for the same segment:

```
evictionCost = relevance * importance * tokenWeight
compactionCost = compressionRatio * importance * (1.0 - redundancy)
```

Compaction preserves the segment (its identity, position, and compressed content remain in the window), so the information loss is partial. Eviction removes the segment entirely, so the information loss is total. The advisory includes both costs in the candidate's impact estimates so the caller can compare: "what does eviction cost in continuity vs. what does compaction cost?"

### 9.5 Group Compaction

When a group candidate receives a compaction recommendation, the advisory cannot recommend compacting the group as a single unit — `compact` operates on individual segments (cl-spec-007 section 3.5). Instead, the advisory recommends compacting **each member** of the group individually.

The `compaction` field for a group candidate contains an array of `CompactionRecommendation` objects, one per member. Each member's recommendation includes its own `estimatedTargetTokens`, `estimatedSavings`, and `continuityCost`. The group-level `estimatedSavings` on the candidate is the sum of member savings.

Members that are already compacted (`origin: "summary:compacted"`) are excluded from the compaction list. If all members are already compacted, the group candidate's `recommendation` reverts to `"evict"` — there is nothing left to compact.

**Execution order for group compaction.** The advisory does not prescribe an order for compacting group members. The caller may compact them in any order. Since compaction does not change the segment's identity or group membership, the group remains intact after all members are compacted — no dissolution or re-grouping is needed.

### 9.6 Compaction vs. Eviction Decision Matrix

The following matrix summarizes the recommendation logic across strategies and candidate properties:

| Condition | Default | Saturation | Erosion | Gap | Collapse |
|-----------|---------|------------|---------|-----|----------|
| Seed, not yet compacted | Compact | Compact | Compact | Compact | Compact |
| Seed, already compacted | Evict | Evict | Evict | Evict | Evict |
| Non-seed, redundancy > 0.8 | Evict | Evict | Evict | Evict | Evict |
| Non-seed, redundancy 0.5–0.8, savings meet target | Evict | Evict | Compact | Evict | Compact |
| Non-seed, redundancy < 0.5, savings meet target | Compact (if enabled) | Evict | Evict | Evict | Compact |
| Non-seed, savings below target | Evict | Evict | Evict | Evict | Compact (if feasible) |
| Non-seed, already compacted | Evict | Evict | Evict | Evict | Evict |

The collapse strategy is the most compaction-biased — it recommends compaction in nearly all cases where the segment is not already compacted and the savings exceed the 20% minimum threshold (section 5.8, rule 1). The saturation strategy is the most eviction-biased — it recommends eviction in nearly all cases because it needs certain reclamation (section 5.5, rule 2).

### 9.7 What the Advisory Does Not Do

The advisory does not generate summaries. It does not call LLMs. It does not evaluate the quality of a potential summary. It says "compact this segment" and estimates the savings — the caller generates the summary (possibly via an LLM call, possibly via a hand-written rule) and passes it to `compact(id, summary)` (cl-spec-007 section 3.5). The `compact` method validates that the summary is shorter than the original content and rejects it if not. The advisory's savings estimate is just that — an estimate. The actual savings depend on the summary the caller provides.

## 10. Invariants and Constraints

The following invariants hold for the eviction advisory. They are not aspirational — they are constraints that the implementation must enforce. Violations indicate bugs, not edge cases.

**Invariant 1: Read-only consumer.** The eviction advisory does not call segment-mutating methods (`add`, `update`, `replace`, `compact`, `split`, `evict`, `restore`) or configuration-mutating methods (`setTask`, `clearTask`, `setTokenizer`, `setEmbeddingProvider`). It may call `assess()` to obtain fresh quality data, which updates internal caches but does not modify segments or configuration.

*Clarification:* `planEviction` may trigger a quality report generation (section 4.1, step 1) if the cached report is stale. Quality report generation is a read-derive-cache operation within the quality model (cl-spec-002), not a window mutation. The advisory delegates this to `assess`, which is already defined as non-mutating (cl-spec-007).

**Invariant 2: Deterministic planning.** Given the same window state (segments, scores, metadata, task, patterns, capacity), the same `PlanOptions`, and the same timestamp, `planEviction` produces the same `EvictionPlan`. There is no randomness, no hash-order dependency, and no system-clock sensitivity beyond the timestamp used for age computation. The tie-breaking cascade (section 2.5) ensures total ordering. The strategy auto-selection (section 5.3) is deterministic. Two callers with identical inputs receive identical plans.

*Caveat:* Determinism is with respect to the quality report used. If two calls to `planEviction` happen to trigger quality report regeneration and the window state changed between them, the plans may differ. But given the same report (same `reportId`), the plans are identical.

**Invariant 3: Protection tier inviolability.** No ranking score, strategy, or behavioral rule can cause a segment at a higher protection tier to be evicted before all candidates at lower tiers are exhausted. The tier ordering (section 3.1) is a hard partitioning constraint. Within a tier, the ranking model determines order. Across tiers, the ordering is fixed: `default` < `priority(n)` (ascending) < `seed`. Pinned segments never appear. No code path — including strategy-specific behavioral rules, compound-aware selection, group handling, or overshoot logic — may violate this ordering.

**Invariant 4: Pinned exclusion.** Pinned segments do not appear in the eviction plan under any circumstances. They are not scored, not ranked, not included as candidates, and not recommended for compaction. A plan's `candidates` array contains zero entries with tier `"pinned"`. This holds even when the only remaining content is pinned — the plan is empty (`exhausted: true`) rather than including pinned candidates.

**Invariant 5: Group atomicity.** The advisory never recommends partial group eviction. A group candidate represents the entire group — all members. The `memberIds` field lists every member. The `tokenCount` is the sum of all member token counts. The caller who executes the recommendation by calling `evict(groupId)` evicts all members atomically. If the caller wants to evict individual members, they must dissolve the group first and replan.

**Invariant 6: Plan independence.** An `EvictionPlan` is a data object with no live reference to the context-lens instance. Mutations to the instance after plan generation do not alter the plan. Executing candidates from the plan does not update the plan's remaining candidates or cumulative token counts. The plan is a snapshot, not a cursor. Two plans generated at different times are independent — executing one does not affect the other's validity (though both become stale once the window changes).

**Invariant 7: Score bounds.** All eviction scores are in the range [0.0, 1.0]. The five input signals are each in [0.0, 1.0] (section 2.1). The weights sum to 1.0 (section 2.3). The weighted arithmetic mean of values in [0.0, 1.0] with non-negative weights summing to 1.0 is itself in [0.0, 1.0]. Strategy-adjusted weights (section 2.4) also sum to 1.0. The bridge score (section 7.2) is clamped to [0.0, 1.0]. No eviction score can fall outside the unit interval.

**Invariant 8: Weight summation.** The five signal weights sum to exactly 1.0 for every strategy — default, saturation, erosion, gap, and collapse. The eviction score formula (section 2.1) is a weighted arithmetic mean. If weights summed to less than or greater than 1.0, the eviction score range would shift, breaking invariant 7 and making scores incomparable across strategies.

**Invariant 9: Strategy resolution.** The plan's `strategy` field is never `"auto"`. Auto-selection (section 5.3) always resolves to one of the five concrete strategies: `"default"`, `"saturation"`, `"erosion"`, `"gap"`, or `"collapse"`. The plan records the resolved strategy, not the input option. The caller can always determine which strategy produced the ranking.

**Invariant 10: Impact approximation honesty.** Quality impact estimates (section 4.3, section 4.4) are first-order approximations. They model the effect of each candidate independently, without accounting for interactions between candidates. The advisory does not claim otherwise. The plan structure distinguishes exact values (token counts, tier assignments) from estimates (quality deltas, projected scores) by placing estimates in dedicated `impact` and `qualityImpact` fields. The only exact quality metric is continuity cost — computed via the eviction cost formula (cl-spec-002 section 6.2), which is additive and interaction-free.

**Invariant 11: No content access.** The advisory operates entirely on scores and metadata. It does not read segment content, task description text, embedding vectors, trigram sets, or any content-derived data beyond the pre-computed scores in the quality report. This separation ensures that the advisory's performance is independent of content size — a 100-token segment and a 10,000-token segment are equally cheap to score for eviction. Content analysis is the quality model's job; the advisory inherits its conclusions.

**Invariant 12: No LLM calls.** The eviction advisory does not invoke a language model. It does not generate summaries, evaluate content quality, compute semantic similarity, or perform any operation that requires an LLM. Compaction recommendations (section 9) say "compact this" — the caller generates the summary. This invariant is inherited from the broader context-lens constraint (cl-spec-002 invariant 9) and is reiterated here because the advisory's compaction recommendations might imply summary generation to a reader unfamiliar with the architecture.

## 11. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-001` (Segment Model) | Defines segments, groups, protection tiers, and lifecycle operations. The eviction advisory respects the protection tier ordering, group atomicity, and seed compaction-first rules defined here. |
| `cl-spec-002` (Quality Model) | Produces per-segment and window-level quality scores consumed by the ranking model. Coherence adjacency similarities supply the bridge score. The eviction cost and compaction cost formulas supply continuity impact estimates. |
| `cl-spec-003` (Degradation Patterns) | Produces the active pattern set and remediation hints that drive strategy selection. Compound patterns (base only) influence auto-selection. Custom patterns (section 10) participate in priority-based fallback via `strategyHint`. Pattern severity thresholds interact with the collapse strategy's continuity floor guard. |
| `cl-spec-004` (Task Identity) | Defines the task descriptor lifecycle, transition classification, grace period, and staleness. Task state modulates the advisory's relevance-based ranking and the gap strategy's applicability. |
| `cl-spec-005` (Embedding Strategy) | Provides the similarity computation mode (embeddings or trigram fallback) used by the bridge score's skip-similarity computation. |
| `cl-spec-006` (Tokenization Strategy) | Provides segment token counts and capacity metrics consumed by the plan target calculation and per-candidate reclamation tracking. |
| `cl-spec-007` (API Surface) | Defines `planEviction` as a method on the context-lens instance. Defines `evict`, `compact`, `restore`, and group operations that the caller uses to execute advisory recommendations. |
| `cl-spec-009` (Performance Budget) | Will define latency constraints for `planEviction`, including the cost of skip-similarity computation and plan assembly. |
| `cl-spec-010` (Report & Diagnostics) | Will surface eviction plan metadata, strategy selection rationale, and plan execution history in diagnostic output. |

---

*context-lens — authored by Akil Abderrahim and Claude Opus 4.6*
