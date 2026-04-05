---
id: cl-spec-003
title: Degradation Patterns
type: design
status: complete (amended)
created: 2026-03-28
revised: 2026-04-04
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [degradation, patterns, detection, saturation, erosion, fracture, gap, collapse, alerting, custom-patterns, registration]
depends_on: [cl-spec-002]
---

# Degradation Patterns

## Table of Contents

1. Overview
2. Detection Framework
3. Saturation
4. Erosion
5. Fracture
6. Gap
7. Collapse
8. Pattern Interactions
9. Detection Configuration
10. Custom Pattern Registration
11. Invariants and Constraints
12. References

---

## 1. Overview

The quality model (cl-spec-002) produces four dimension scores. Scores are numbers — they answer "how high?" but not "what's wrong?" or "what should I do about it?" A coherence score of 0.4 tells you coherence is degraded. It does not tell you whether the window is fragmenting into unrelated topics, whether a key bridging segment was evicted, or whether the caller is injecting content from too many domains at once. Degradation patterns make that diagnosis.

A **degradation pattern** is a named, recognizable configuration of quality scores and contextual signals that corresponds to a specific failure mode of context window management. Each pattern has:

- A **signature** — which dimension scores and contextual signals activate it
- An **activation threshold** — the boundary between "healthy" and "degraded"
- **Severity levels** — graduated from early warning to critical
- A **diagnostic explanation** — what is happening and why
- **Remediation hints** — what the caller (or eviction advisor) can do about it

### Design goals

- **Diagnostic, not prescriptive.** Patterns name the problem — they do not fix it. A fracture alert tells the caller that coherence has broken down and identifies the disconnected regions. It does not reorder segments, insert bridging summaries, or evict off-topic content. The caller decides what to do. The eviction advisory (cl-spec-008) can translate pattern alerts into concrete eviction plans, but that is a separate system with a separate spec.
- **Cheap classification over expensive scores.** The quality model does the expensive work — computing similarity, aggregating dimensions, maintaining the continuity ledger. Pattern detection is a thin classification layer on top. It reads the scores the quality model already produced and applies threshold logic. Detection adds negligible overhead to quality report generation — it is in the same performance budget, not an additional budget.
- **Actionable over comprehensive.** Five patterns, not fifty. Each pattern corresponds to a failure mode that has a distinct remediation strategy. If two failure modes have the same fix, they don't need separate patterns. If a failure mode has no fix the caller can act on, naming it doesn't help. The pattern set is intentionally small so that every alert is meaningful and every alert suggests a direction.
- **Stable signals over noisy alerts.** A pattern that flickers on and off every other turn is worse than no pattern at all. Detection uses hysteresis (section 9.3) to ensure patterns activate cleanly and deactivate only when the underlying condition has genuinely resolved, not when scores happen to oscillate near a threshold.

### What degradation patterns are not

Degradation patterns are not quality scores. The quality model (cl-spec-002) produces scores — continuous values from 0.0 to 1.0 that measure each dimension. Patterns consume those scores and classify the window's state into named failure modes. A coherence score of 0.35 is a number. A fracture alert at warning severity is a diagnosis. The distinction matters because scores invite interpolation ("is 0.35 bad?") while patterns provide categorical answers ("yes, the window is fractured, here's what's broken").

Patterns are not optimizers. They do not modify the context window. They do not evict segments, reorder content, generate summaries, or call LLMs. They are read-only — they inspect the quality report and emit a classification. The eviction advisory (cl-spec-008) is the system that acts on pattern alerts. The diagnostics system (cl-spec-010) is the system that surfaces them to humans. Patterns sit between measurement and action: they interpret the former and inform the latter.

Patterns are not anomaly detectors. They do not learn from the window's history and flag deviations from "normal." Each pattern has a fixed definition — a signature over quality scores and contextual signals with explicit thresholds. The thresholds are tunable (section 9.1) but the pattern definitions are not learned or adaptive. This is intentional. Adaptive detection would require a training period, would behave unpredictably across sessions, and would be harder for callers to reason about. Fixed patterns are predictable: the caller knows exactly what will trigger each pattern and can build automation around that guarantee.

### How patterns flow through the system

```
Quality Report (cl-spec-002 section 9)
    |
    +--> Window scores (coherence, density, relevance, continuity)
    +--> Capacity metrics (utilization, headroom)
    +--> Continuity ledger (eviction cost, net loss)
    +--> Trend data (score deltas from previous report)
    |
    v
Pattern Detection (this spec)
    |
    +--> Active patterns with severity, explanation, remediation hints
    |
    +--> Eviction Advisory (cl-spec-008) — uses patterns to prioritize strategy
    +--> Diagnostics (cl-spec-010) — surfaces patterns to the caller
    +--> Caller — direct consumption via quality report
```

Pattern detection is not a separate pass. It runs as part of quality report generation — every quality report includes the current set of active patterns. There is no separate "detect patterns" API call. This keeps pattern state synchronized with the scores that produced it and avoids the stale-alert problem where a pattern alert refers to scores that have already changed.

### The five patterns

| Pattern | Primary dimension | Failure mode | One-line description |
|---------|------------------|--------------|---------------------|
| **Saturation** | Capacity | Overflow pressure | The window is approaching or exceeding token capacity |
| **Erosion** | Density | Information dilution | Useful information is being displaced by redundant or low-value content |
| **Fracture** | Coherence | Topic fragmentation | Content has splintered into disconnected, unrelated regions |
| **Gap** | Relevance | Task drift | The window is full of content that doesn't serve the current task |
| **Collapse** | Continuity | Information loss | Critical context has been permanently lost through eviction or compaction |

Each pattern is defined in its own section (3–7). Section 8 covers how patterns interact and compound. Section 10 defines a registration mechanism for caller-defined custom patterns.

---

## 2. Detection Framework

How degradation pattern detection works as a system — the inputs it consumes, when it runs, how it reports results.

### 2.1 Inputs

Pattern detection is a **consumer** of quality data, not a producer. It reads the quality report that the quality model (cl-spec-002) has already computed and applies threshold logic. It does not inspect segment content, compute similarity, or call any scoring function. Every input to pattern detection is an output of something else.

**Primary inputs — from the quality report (cl-spec-002 section 9):**

| Input | Source | Consumed by |
|-------|--------|-------------|
| `windowScores.coherence` | Quality report section 9.2 | Fracture |
| `windowScores.density` | Quality report section 9.2 | Erosion |
| `windowScores.relevance` | Quality report section 9.2 | Gap |
| `windowScores.continuity` | Quality report section 9.2 | Collapse |
| `trend.coherenceDelta` | Quality report section 9.6 | Fracture (rate detection) |
| `trend.densityDelta` | Quality report section 9.6 | Erosion (rate detection) |
| `trend.relevanceDelta` | Quality report section 9.6 | Gap (rate detection) |
| `trend.continuityDelta` | Quality report section 9.6 | Collapse (rate detection) |
| `segments[]` | Quality report section 9.3 | All patterns (per-segment diagnostics) |
| `groups[]` | Quality report section 9.4 | Fracture (group integrity) |
| `continuityLedger` | Quality report section 9.5 | Collapse (loss history) |
| trend.tokensDelta | Quality report (cl-spec-002 section 9.6) | Saturation (rate-based early activation) |

**Secondary inputs — from the capacity report (cl-spec-006 section 4.5):**

| Input | Source | Consumed by |
|-------|--------|-------------|
| `capacity.utilization` | Tokenization subsystem | Saturation (primary), Erosion and Gap (compound condition) |
| `capacity.headroom` | Tokenization subsystem | Saturation (diagnostic output) |
| `capacity.totalActiveTokens` | Tokenization subsystem | Saturation (diagnostic output) |
| `capacity.capacity` | Tokenization subsystem | Saturation (diagnostic output) |

**Tertiary inputs — from the detection framework's own state:**

| Input | Source | Consumed by |
|-------|--------|-------------|
| `patternHistory` | Previous detection results (section 2.5) | Hysteresis (section 9.3), severity trending |
| `configuration` | Caller-provided overrides (section 9) | All patterns (threshold and suppression) |

**What detection does not consume:** segment content, raw similarity scores, embedding vectors, token provider metadata, or any data that requires additional computation beyond reading the quality report. If a signal is not in the quality report or capacity report, pattern detection cannot see it. This is the key performance guarantee — detection is a thin classification layer, not a second scoring pass.

**Task descriptor awareness:** Pattern detection does not read the task descriptor directly. It reads the relevance scores that the quality model computed using the task descriptor. However, detection does need to know whether a task descriptor is currently set — when no task is set, relevance scores are uniformly 1.0 (cl-spec-002 section 5.1), and the gap pattern must be suppressed because those scores are uninformative. This is the one piece of state detection reads from outside the quality report: `taskDescriptorSet: boolean`.

### 2.2 Detection Lifecycle

Pattern detection runs as part of quality report generation. It is not a separate pass, not an independent system with its own trigger, and not an optional post-processing step. Every quality report includes pattern detection results. This is non-negotiable — it is the design that prevents stale alerts.

**Execution order within report generation:**

```
1. Compute per-segment scores (lazy, cached, only invalidated segments recomputed)
2. Aggregate to window-level scores
3. Compute trend data (delta from previous report)
4. Assemble capacity metrics
5. Run pattern detection  ← HERE
6. Assemble and return the complete report
```

Detection runs after all scores and trends are finalized, so it sees the complete picture for this report. It runs before the report is returned to the caller, so the caller never receives a report without pattern results.

**No separate detection API.** There is no `detectPatterns()` call. Patterns are accessed through the quality report. This eliminates a class of bugs where the caller retrieves a quality report, then calls detection separately, and the two are computed against different window states (because a lifecycle operation occurred between them). One report, one snapshot, one set of pattern results.

**Proactive quality computations (eviction snapshots, restoration fidelity) do not trigger pattern detection.** These partial computations (cl-spec-002 section 9.7) produce specific scores for specific segments — they do not produce a full window-level quality report, so there is nothing for pattern detection to classify. Patterns only update when a full report is generated.

**Detection on an empty window.** If the quality report has `segmentCount: 0`, pattern detection returns an empty result — no active patterns. An empty window has no quality to degrade. This matches the quality model's treatment (cl-spec-002, invariant 4).

**Detection before baseline.** If `baselineEstablished: false`, pattern detection operates on raw scores rather than normalized scores. The thresholds defined in sections 3–7 are calibrated for normalized scores, so pre-baseline detection may produce false positives or false negatives. The pattern results include a flag `preBaseline: true` to warn the consumer. In practice, pre-baseline detection is rare — it only occurs in the window between the first `add` and baseline capture, which is typically zero operations.

### 2.3 Pattern Result Structure

Each quality report includes a `patterns` field containing the full detection result:

**Top-level detection result:**

| Field | Type | Description |
|-------|------|-------------|
| `patterns` | `ActivePattern[]` | Currently active patterns, ordered by priority (section 8.3) |
| `patternCount` | number | Number of active patterns (`patterns.length`) |
| `highestSeverity` | `Severity` or null | The highest severity among active patterns, or null if none active |
| `preBaseline` | boolean | True if detection ran on raw (non-normalized) scores |

**ActivePattern structure:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `PatternName` | Enum: `saturation`, `erosion`, `fracture`, `gap`, `collapse` |
| `severity` | `Severity` | Enum: `watch`, `warning`, `critical` |
| `activatedAt` | timestamp | When this pattern first became active at its current-or-lower severity |
| `currentSince` | timestamp | When the pattern reached its current severity level |
| `duration` | number | Milliseconds since `activatedAt` |
| `trending` | `Trend` | Enum: `worsening`, `stable`, `improving` |
| `signature` | `PatternSignature` | The scores and signals that activated this pattern |
| `explanation` | string | Human-readable diagnostic — what is happening and why |
| `remediation` | `RemediationHint[]` | Structured suggestions for the caller, ordered by estimated impact |
| compoundContext | CompoundContext or null | Present when this pattern participates in a known compound (section 8.2). Null otherwise. |

**PatternSignature structure:**

| Field | Type | Description |
|-------|------|-------------|
| `primaryScore` | `{ dimension: string, value: number }` | The primary dimension score that triggered activation |
| `secondaryScores` | `{ dimension: string, value: number }[]` | Additional scores contributing to the diagnosis |
| `utilization` | number or null | Utilization at detection time (included when relevant to the pattern) |
| `thresholdCrossed` | `{ severity: Severity, threshold: number }` | Which threshold this pattern crossed to reach current severity |

The signature is diagnostic evidence — it answers "why did this pattern fire?" A caller who receives a fracture warning can inspect the signature and see that coherence was 0.38, below the warning threshold of 0.4, and that topical cluster count (a secondary score) was elevated. The signature is not a replay mechanism — it does not contain enough information to recompute the pattern from scratch. It is a summary of the triggering condition.

**RemediationHint structure:**

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | What the caller should do: `evict`, `compact`, `deduplicate`, `reorder`, `restore`, `updateTask`, `increaseCapacity`, `slowEviction`, `restart`, `dissolve` |
| `target` | string or null | Specific segment IDs, group IDs, or protection tiers the action targets. Null for general suggestions. |
| `estimatedImpact` | string or null | Human-readable estimate: `"reclaim ~3200 tokens"`, `"improve density by ~0.15"`. Null when impact cannot be estimated. |
| `description` | string | Human-readable explanation of why this action helps |

Remediation hints are **suggestions, not commands**. They describe what would help, not what context-lens will do. context-lens is read-only with respect to the context window at detection time — it diagnoses but does not treat. The eviction advisory (cl-spec-008) translates hints into concrete eviction plans. The caller may also act on hints directly.

Hints are ordered by estimated impact — highest-impact suggestion first. If multiple patterns are active, each pattern provides its own hints independently. The caller or eviction advisor can prioritize across patterns using pattern priority (section 8.3).

### 2.4 Severity Model

Three severity levels, ordered from mildest to most severe:

| Severity | Meaning | Caller expectation |
|----------|---------|-------------------|
| `watch` | Early warning. Scores are trending toward degradation, or have crossed the first threshold. The window is still functional. | Be aware. Consider preventive action. No urgency. |
| `warning` | Active degradation. The pattern's primary threshold has been crossed and the quality dimension is measurably impaired. | Act soon. The window is underperforming and the problem will worsen without intervention. |
| `critical` | Severe degradation. The quality dimension has declined to a level where the model is likely receiving inadequate context. For collapse, the damage may be irreversible. | Act now. Continued operation at this level risks permanent quality loss or model underperformance. |

**Severity is per-pattern, not per-window.** A window can have fracture at `critical` and saturation at `watch` simultaneously. The `highestSeverity` field on the detection result provides a quick aggregate, but the per-pattern severity is the actionable signal.

**Severity implies lower levels.** If a pattern is at `warning`, the `watch` condition is also met — the scores have passed through the watch threshold to reach warning. Detection reports only the current (highest) severity, not all met levels. A pattern at `critical` means `watch` and `warning` conditions are also satisfied.

**Threshold ownership.** The detection framework defines the severity model and the mechanics of threshold evaluation. Each individual pattern (sections 3–7) defines its own threshold values for each severity level. The framework enforces:

1. **Monotonic severity ordering.** For score-based patterns (erosion, fracture, gap, collapse), the thresholds must satisfy: `watch_threshold > warning_threshold > critical_threshold` (since lower scores mean worse quality). For utilization-based patterns (saturation), the ordering is reversed: `watch_threshold < warning_threshold < critical_threshold` (since higher utilization means worse). Custom threshold overrides (section 9.1) are validated against this ordering — invalid overrides are rejected.

2. **Single active severity.** A pattern is reported at exactly one severity level — its highest met level. The detection framework evaluates thresholds from `critical` down to `watch` and reports the first match.

3. **Hysteresis on severity transitions.** Severity levels use the same hysteresis mechanism as activation/deactivation (section 9.3). Escalation (watch → warning → critical) happens immediately when the score crosses the threshold. De-escalation (critical → warning → watch → inactive) requires the score to recover past the threshold by the hysteresis margin. This prevents severity flickering when scores oscillate near a boundary.

**Rate-based severity elevation.** In addition to absolute threshold crossings, detection can elevate severity when scores are declining rapidly, even if the absolute level has not reached the next threshold. This is defined per-pattern in sections 3–7 where applicable. The general rule: if a dimension score drops by more than 0.15 between consecutive reports, the pattern's severity is elevated by one level (watch → warning, warning → critical) regardless of the absolute score. This catches acute degradation — a sudden eviction batch that drops continuity from 0.8 to 0.6 should trigger `warning` immediately, not wait for the score to drift below the watch threshold of 0.7. Rate-based elevation is a floor raise — if the absolute threshold already places the pattern at a higher severity, the rate-based rule has no effect.

### 2.5 Pattern History

Patterns are not instantaneous events. They activate, persist at a severity level, escalate or de-escalate, and eventually resolve. The detection framework maintains a history of this lifecycle to distinguish between transient fluctuations and structural problems.

**Per-pattern tracking state:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `PatternName` | Which pattern |
| `state` | `active` or `resolved` | Current state |
| `activatedAt` | timestamp | When the pattern first became active (any severity) |
| `currentSeverity` | `Severity` | Current severity level |
| `severitySince` | timestamp | When the pattern reached its current severity level |
| `peakSeverity` | `Severity` | The highest severity this pattern has reached in its current activation |
| `peakAt` | timestamp | When peak severity was reached |
| `resolvedAt` | timestamp or null | When the pattern resolved (null if currently active) |
| `reportCount` | number | Number of consecutive reports where this pattern has been active |
| `scoreHistory` | `{ reportId: string, score: number }[]` | The primary dimension score at each report during this activation (capped at last 20 entries) |

**Activation and resolution lifecycle:**

```
           ┌─────────── scores cross threshold ───────────┐
           │                                              │
           v                                              │
  ┌──────────────┐    scores recover past    ┌───────────────────┐
  │    ACTIVE    │ ── threshold + hysteresis ──>│    RESOLVED     │
  └──────────────┘                           └───────────────────┘
  │ severity may                              │ entry retained
  │ escalate/de-escalate                      │ in history
  │ while active                              │ for diagnostics
  └──────────────────────────────────────────────────────────────
```

When a pattern activates, a new history entry is created. While active, the entry is updated each report — severity may change, `reportCount` increments, `scoreHistory` appends. When the pattern resolves (scores recover past threshold + hysteresis margin), `resolvedAt` is set and the entry is closed.

**Trending.** The `trending` field on `ActivePattern` (section 2.3) is derived from `scoreHistory`:

| Trend | Condition |
|-------|-----------|
| `worsening` | The primary score has declined over the last 3 reports (or since activation if fewer than 3 reports) |
| `improving` | The primary score has improved over the last 3 reports |
| `stable` | Neither worsening nor improving — the score is fluctuating within ±0.03 |

Trending is a qualitative signal for the caller: "this pattern is getting better" or "this pattern is getting worse." It is not a prediction. A worsening trend does not forecast when the next severity level will be reached — that would require modeling the caller's future behavior, which is unknowable.

**History retention.** Resolved pattern entries are retained for the lifetime of the session. They are not included in the quality report's `patterns` array (which contains only active patterns), but they are available through the diagnostics API (cl-spec-010) and are used by the detection framework itself for one purpose: distinguishing first-time activation from recurrence. A pattern that activates, resolves, and activates again within the same session receives a `recurrence: true` flag and includes the previous activation's duration and peak severity in its diagnostic output. Recurrence is a signal that the underlying problem was not fully addressed — the caller patched the symptom but the root cause persists.

Pattern history is session-scoped by default. Each new instance starts with empty history. The serialization mechanism (cl-spec-014) preserves pattern tracking state and history across sessions when the caller explicitly opts in via `snapshot()`/`fromSnapshot()`. Without explicit serialization, pattern history exists only in memory for the duration of the session.

---

## 3. Saturation

Saturation is the capacity pressure pattern. It activates when token utilization approaches or exceeds the configured window capacity.

### 3.1 Definition

Saturation is the simplest pattern. It is a function of one number — utilization — and it does not depend on any quality dimension score. A window at 90% utilization is saturated regardless of whether its coherence, density, relevance, and continuity are all perfect.

Saturation is included as a degradation pattern rather than a standalone capacity warning because capacity pressure is the **root cause** of most other degradation. The causal chain:

1. Utilization climbs as the caller adds content.
2. When utilization is high, the caller is forced to evict to make room for new content.
3. Eviction degrades continuity (information is lost).
4. Forced eviction under pressure is often indiscriminate — the caller evicts whatever is cheapest, not what is least valuable. This degrades coherence (bridging segments removed) and relevance (relevant content sacrificed for recency).
5. When utilization stays high without eviction, low-value content accumulates unchecked, degrading density.

Saturation is the upstream pattern. Erosion, fracture, gap, and collapse are downstream effects. Detecting saturation early — before it forces bad eviction decisions — is the highest-leverage alert the detection framework provides.

**Saturation is pre-quality.** It fires before quality has degraded. A window at 92% utilization with perfect quality scores is still at saturation `warning` because the pressure is real even if the damage has not yet occurred. This makes saturation the only pattern that is **predictive** rather than diagnostic — it signals what is about to go wrong, not what has already gone wrong.

### 3.2 Signature

**Primary signal:**

| Signal | Source | Role |
|--------|--------|------|
| `capacity.utilization` | Tokenization subsystem (cl-spec-006 section 4.5) | Sole activation signal — utilization exceeding a threshold is necessary and sufficient for saturation |

**Secondary signals (diagnostic, not activation):**

| Signal | Source | Role |
|--------|--------|------|
| `capacity.headroom` | Tokenization subsystem | Reported in diagnostic output — absolute tokens remaining |
| `capacity.totalActiveTokens` | Tokenization subsystem | Reported in diagnostic output — current usage |
| `capacity.capacity` | Tokenization subsystem | Reported in diagnostic output — configured maximum |
| `capacity.pinnedTokens` | Tokenization subsystem | Diagnostic — how much capacity is permanently locked |
| `capacity.seedTokens` | Tokenization subsystem | Diagnostic — how much capacity is in foundational content |
| `capacity.managedTokens` | Tokenization subsystem | Diagnostic — how much capacity is evictable |
| `trend.tokensDelta` | Quality report (cl-spec-002 section 9.6) | Rate-based activation — how fast utilization is climbing |

**What is not in the signature:** Quality dimension scores. Saturation does not read coherence, density, relevance, or continuity. It is the only pattern with this property — every other pattern is defined primarily by a quality dimension. Saturation is defined by capacity alone. This separation is intentional: it means saturation cannot be masked by high quality scores. A window that is 95% utilized with perfect quality is still at `critical` saturation — the quality is about to degrade because there is no room for the next piece of context.

### 3.3 Activation Thresholds

**Absolute thresholds (default values):**

| Severity | Condition | Rationale |
|----------|-----------|-----------|
| `watch` | `utilization > 0.75` | Three-quarters full. The caller should be aware that capacity is not unlimited. Enough headroom for normal operation, but large additions may push into warning territory. |
| `warning` | `utilization > 0.85` | Limited headroom. Each new segment addition is significant relative to remaining capacity. The caller should be actively managing content — evicting, compacting, or being selective about what enters the window. |
| `critical` | `utilization > 0.95` | Near or at capacity. Fewer than 5% of tokens remain. Any non-trivial addition will push the window over capacity. When `utilization > 1.0`, the window has already overflowed — context-lens permits this (soft capacity, cl-spec-001 invariant 14) but the model is receiving more tokens than its window supports. |

The thresholds satisfy the monotonic ordering required by the severity model (section 2.4): `watch < warning < critical` in utilization terms.

**Rate-based early activation:**

In addition to absolute thresholds, saturation supports rate-based activation that triggers `watch` before utilization reaches 0.75. The condition:

```
projectedUtilization = utilization + (tokensDelta / capacity) * lookAheadFactor
```

Where `tokensDelta` is the token count change between the current and previous report, and `lookAheadFactor` is `3` (project three reports ahead, since most callers generate reports every turn or every few turns).

If `projectedUtilization > 0.75` and `utilization <= 0.75`, saturation activates at `watch` with the explanation noting that activation is rate-based — current utilization is below threshold but the growth rate will reach it soon.

Rate-based activation only applies to the `watch` level. `warning` and `critical` require the absolute threshold to be crossed. This prevents rate-based projection from triggering high-severity alerts based on speculation — a single large addition might spike the rate without establishing a trend.

**Rate-based activation requires trend data.** If the quality report has `trend: null` (first report in the session), rate-based activation is skipped. Only absolute thresholds apply.

**Hysteresis.** Saturation deactivation follows the framework hysteresis rules (section 9.3). If saturation activated at `watch` because utilization crossed 0.75, it does not deactivate until utilization drops below `0.75 - hysteresisMargin` (default margin: 0.03, so deactivation at 0.72). This prevents flicker when the caller evicts just enough to dip below the threshold and then adds one more segment.

### 3.4 Diagnostic Output

A saturation alert includes all the information the caller needs to understand the capacity situation and decide how to respond.

**Explanation template by severity:**

| Severity | Explanation pattern |
|----------|-------------------|
| `watch` | `"Context window is at {utilization}% utilization ({totalActiveTokens}/{capacity} tokens). {headroom} tokens of headroom remaining."` |
| `watch` (rate-based) | `"Context window is at {utilization}% utilization and growing. At the current rate of addition, utilization will reach 75% within {N} operations."` |
| `warning` | `"Context window is at {utilization}% utilization with only {headroom} tokens remaining. Active content management is recommended."` |
| `critical` | `"Context window is at {utilization}% utilization. {headroom} tokens remaining (or {-headroom} tokens over capacity). Immediate eviction or compaction is needed to prevent quality degradation."` |

**Signature content for saturation:**

```
signature: {
    primaryScore: { dimension: "utilization", value: <current utilization> },
    secondaryScores: [
        { dimension: "headroom", value: <tokens remaining> },
        { dimension: "tokensDelta", value: <change since last report> }
    ],
    utilization: <current utilization>,
    thresholdCrossed: { severity: <current severity>, threshold: <threshold value> }
}
```

**Protection tier breakdown.** The saturation diagnostic includes a capacity breakdown by protection tier, derived from the capacity report fields (cl-spec-006 section 4.5). This tells the caller not just how full the window is, but how much of its content is evictable:

| Tier | Tokens | Evictable? |
|------|--------|-----------|
| Pinned | `capacity.pinnedTokens` | Never |
| Seed | `capacity.seedTokens` | Last resort, compactable first |
| Priority + Default | `capacity.managedTokens - capacity.seedTokens` | Yes, in protection order |

This breakdown is critical for actionability. A window at 95% utilization where 60% is pinned has only 35% of managed content to work with — the effective pressure is much higher than the utilization number suggests. A window at 95% where 90% is default-protected has abundant eviction candidates. The breakdown makes these situations visually distinct.

**Per-segment eviction candidates.** When saturation is at `warning` or `critical`, the diagnostic includes the top-5 eviction candidates from the quality report's per-segment scores — the segments with the lowest composite scores among those with `default` or low-priority protection. These are not eviction commands — they are pointers that say "if you need to evict, start here." The eviction advisory (cl-spec-008) provides the full ranked list; saturation provides a preview for callers who want to act immediately without consulting the advisor.

### 3.5 Remediation Hints

Saturation remediation hints are ordered by estimated impact — highest token reclamation first.

**Hint generation logic:**

1. **Evict default segments.** If default-protected segments exist, the first hint targets them. It identifies the number of default segments, their total token count, and the lowest-composite candidates:

   ```
   {
       action: "evict",
       target: "default",
       estimatedImpact: "reclaim ~{N} tokens from {M} default segments",
       description: "Evict low-value default segments to reduce utilization.
           Lowest-quality candidates: {segmentId1}, {segmentId2}, {segmentId3}."
   }
   ```

2. **Compact seed segments.** If seed-protected segments exist and are not already compacted, suggest compaction. Seeds are not eviction candidates under normal pressure, but compacting them reclaims tokens while preserving the foundational context:

   ```
   {
       action: "compact",
       target: "seed",
       estimatedImpact: "reduce seed token usage (currently {seedTokens} tokens)",
       description: "Compact seed segments to reduce their token footprint.
           Seeds are foundational but may contain verbose content that can be summarized."
   }
   ```

3. **Evict low-priority segments.** If `priority(n)` segments exist at low priority levels, suggest evicting the lowest-priority tier:

   ```
   {
       action: "evict",
       target: "priority(0-{lowestTier})",
       estimatedImpact: "reclaim ~{N} tokens from {M} priority segments",
       description: "Evict lowest-priority segments. Priority levels 0–{lowestTier}
           contain {M} segments totaling {N} tokens."
   }
   ```

4. **Increase capacity.** Always included as the final hint at `warning` and `critical`, because sometimes the right answer is a bigger window:

   ```
   {
       action: "increaseCapacity",
       target: null,
       estimatedImpact: null,
       description: "If the target model supports a larger context window,
           increasing capacity avoids the need for eviction."
   }
   ```

**Hint filtering.** Hints that do not apply are omitted. If there are no default segments, hint 1 is skipped. If all seeds are already compacted (origin is `"summary:compacted"`), hint 2 is skipped. If there are no priority segments, hint 3 is skipped. In the degenerate case where the entire window is pinned, only hint 4 is emitted — and the explanation notes that pinned content is consuming the entire window and nothing can be evicted.

**Hints do not reference the eviction advisory directly.** The hints say "evict these segments" not "consult cl-spec-008." The caller may or may not be using the eviction advisory. Remediation hints are self-contained — they provide enough information to act on without requiring another API call. The eviction advisory provides a more sophisticated analysis (respecting group atomicity, coherence impact, restoration cost), but the saturation hint is the fast path for callers who need to act immediately.

---

## 4. Erosion

Erosion is the information dilution pattern. It activates when density degrades at high utilization — the window is full, and what's filling it isn't earning its token cost.

### 4.1 Definition

Erosion is a **compound pattern** — it requires two conditions simultaneously. Low density alone is not erosion. Low density in a half-empty window is waste, but it is not urgent — there is room for new, useful content alongside the redundant material. The caller can address it at their convenience or ignore it entirely. Low density at high utilization is a different situation: the window is full, and what is filling it is not earning its token cost. Redundant, verbose, or duplicated content is consuming capacity that should be available for new, valuable context. The window is eroding — useful information is being displaced by junk.

This compound nature is what makes erosion a distinct pattern rather than a restatement of the density score. The density score says "30% of your tokens are wasted on redundancy." Erosion says "30% of your tokens are wasted on redundancy **and you have no room for anything else.**" The second statement is actionable in a way the first is not — it carries urgency because capacity pressure transforms waste from an inefficiency into a bottleneck.

Erosion is the pattern that distinguishes three scenarios the density score alone conflates:

| Density | Utilization | Diagnosis | Urgency |
|---------|-------------|-----------|---------|
| 0.4 | 0.3 | Redundant content, but plenty of room | Low — clean up when convenient |
| 0.4 | 0.5 | Redundant content, moderate room | Medium — worth addressing but not blocking |
| 0.4 | 0.9 | Redundant content crowding out useful context | **High — erosion is active** |

Erosion often emerges in long-running sessions where the same tools are invoked repeatedly (re-fetching documents, re-running searches), conversations circle back to previously discussed topics, or the model restates information the user already provided. Each repetition is individually small, but they accumulate. By the time utilization is high, a significant fraction of the window may be redundant copies of content that should appear once.

### 4.2 Signature

Erosion has two primary signals. Both must be degraded for the pattern to activate — this is the compound condition that distinguishes erosion from a bare density warning.

**Primary signals:**

| Signal | Source | Role |
|--------|--------|------|
| `windowScores.density` | Quality report (cl-spec-002 section 4.6) | Measures information dilution — how much of the window is redundant |
| `capacity.utilization` | Tokenization subsystem (cl-spec-006 section 4.5) | Measures capacity pressure — how full the window is |

**The compound condition:** Erosion activates when density is below a threshold **AND** utilization is above a threshold. Neither condition alone is sufficient. This is enforced by the activation logic, not by a continuous formula — the two signals are evaluated as independent gates, not multiplied into a single score. This keeps the activation behavior predictable: the caller knows exactly what density and utilization values will trigger erosion, without needing to reason about a nonlinear surface.

**Secondary signals (diagnostic, not activation):**

| Signal | Source | Role |
|--------|--------|------|
| Per-segment redundancy | `segments[].redundancy` from quality report (cl-spec-002 section 9.3) | Identifies which segments are the worst offenders |
| Redundant segment count | Count of segments with redundancy > 0.5 | Quantifies how widespread the problem is |
| Token waste | Sum of `tokenCount × redundancy` for segments with redundancy > 0.5 | Quantifies the reclamation opportunity in absolute tokens |
| Origin-class duplication | `segments[].redundancy.originMatch` (cl-spec-002 section 4.4) | Distinguishes accidental re-insertion from intentional overlap |

Secondary signals do not affect whether erosion activates or at what severity. They enrich the diagnostic output so the caller knows what to do about it.

### 4.3 Activation Thresholds

**Default thresholds:**

| Severity | Density condition | Utilization condition | Both required? |
|----------|------------------|----------------------|---------------|
| `watch` | `density < 0.7` | `utilization > 0.7` | Yes |
| `warning` | `density < 0.5` | `utilization > 0.8` | Yes |
| `critical` | `density < 0.3` | `utilization > 0.9` | Yes |

Both conditions must hold simultaneously. A window with density 0.4 and utilization 0.5 does not trigger erosion at any level — utilization is below every utilization threshold. A window with density 0.8 and utilization 0.95 does not trigger erosion — density is above every density threshold. Only when both gates are open does the pattern activate.

**Threshold evaluation order.** Detection evaluates from `critical` down to `watch` and reports the first match (section 2.4). A window with density 0.25 and utilization 0.95 satisfies all three levels — it is reported at `critical`.

**Rate-based severity elevation.** The general rate-based rule from section 2.4 applies: if `densityDelta < -0.15` between consecutive reports (density dropped by more than 0.15), severity is elevated by one level. This catches acute erosion — for example, a batch addition of redundant tool results that suddenly tanks density. The rate-based elevation requires the utilization gate to also be met. A density drop of 0.2 at utilization 0.3 does not elevate erosion severity because the utilization condition is not satisfied.

**Hysteresis.** Both gates use the framework hysteresis margin (section 9.3) independently. If erosion activated because density crossed below 0.7 and utilization crossed above 0.7, it deactivates only when density recovers above `0.7 + margin` **OR** utilization drops below `0.7 - margin`. Either gate closing deactivates the pattern — the compound condition requires both gates open.

### 4.4 Diagnostic Output

**Explanation template by severity:**

| Severity | Explanation pattern |
|----------|-------------------|
| `watch` | `"Window density is {density} at {utilization}% utilization. {redundantCount} segments show significant redundancy, consuming ~{wastedTokens} tokens of redundant content."` |
| `warning` | `"Window is eroding: density has fallen to {density} while utilization is at {utilization}%. Approximately {wastedTokens} tokens ({wastedPercent}% of active content) are consumed by redundant material."` |
| `critical` | `"Severe erosion: density is {density} at {utilization}% utilization. {wastedTokens} tokens of redundant content are consuming capacity needed for new context. Deduplication or eviction of redundant segments is critical."` |

**Signature content for erosion:**

```
signature: {
    primaryScore: { dimension: "density", value: <window density> },
    secondaryScores: [
        { dimension: "redundantSegments", value: <count with redundancy > 0.5> },
        { dimension: "tokenWaste", value: <total wasted tokens> }
    ],
    utilization: <current utilization>,
    thresholdCrossed: { severity: <current severity>, threshold: <density threshold> }
}
```

**Redundancy detail.** The erosion diagnostic includes a ranked list of the worst redundancy offenders — up to 10 segments with the highest redundancy scores, ordered by token waste (descending). For each offender:

| Field | Description |
|-------|-------------|
| `segmentId` | The redundant segment |
| `redundancy` | Its redundancy score (0.0–1.0) |
| `tokenCount` | Tokens this segment consumes |
| `tokenWaste` | `tokenCount × redundancy` — tokens reclaimed if redundancy were eliminated |
| `redundantWith` | The segment ID it is most redundant with |
| `originMatch` | Whether both segments share the same origin (suggests accidental re-insertion) |

This offender list gives the caller a direct action path: "these are the segments wasting the most tokens, and here is what they are redundant with." The caller can deduplicate, compact, or evict without further analysis.

### 4.5 Remediation Hints

Erosion hints target the specific redundancy that triggered the pattern. They are ordered by token reclamation — the hint that frees the most capacity comes first.

**Hint generation logic:**

1. **Deduplicate exact or near-exact pairs.** If any segment pairs have redundancy > 0.8 (near-duplicates, per cl-spec-002 section 4.2), the first hint identifies them and suggests removing the copy. When the pair shares the same origin, the hint specifically suggests removing the older copy (by `createdAt`) since the newer one is likely the more current version:

   ```
   {
       action: "deduplicate",
       target: "{segmentId_older}",
       estimatedImpact: "reclaim ~{tokenCount} tokens (near-duplicate of {segmentId_newer})",
       description: "Segments {segmentId_older} and {segmentId_newer} are {redundancy}%
           redundant (same origin: {origin}). Removing the older copy reclaims {tokenCount} tokens
           with no information loss."
   }
   ```

   One hint is emitted per redundant pair, up to 5 pairs. Pairs are ordered by token waste.

2. **Compact high-redundancy segments.** For segments with redundancy in the 0.5–0.8 range (significant overlap but not near-duplicates), suggest compaction rather than removal — the segment carries some unique information that would be lost by eviction:

   ```
   {
       action: "compact",
       target: "{segmentId}",
       estimatedImpact: "reduce by ~{estimatedSavings} tokens",
       description: "Segment {segmentId} overlaps {redundancy}% with existing content.
           Compacting to retain its unique information while reducing token cost."
   }
   ```

3. **Evict lowest-density segments.** If the above targeted actions are insufficient to resolve the erosion (total reclaimable tokens from deduplication and compaction do not bring projected density above the `watch` threshold), suggest evicting the segments with the lowest density scores:

   ```
   {
       action: "evict",
       target: "{segmentId}",
       estimatedImpact: "reclaim ~{tokenCount} tokens (density: {density})",
       description: "Segment {segmentId} has density {density} — most of its content
           is available elsewhere in the window. Evicting it reclaims {tokenCount} tokens
           with minimal information loss."
   }
   ```

**Hint ordering across types.** Deduplication hints come first because they have zero information loss — the content is fully redundant, so removing the copy costs nothing. Compaction hints come second because they preserve unique information while reducing waste. Eviction hints come last because they may remove some unique content. Within each type, hints are ordered by token reclamation descending.

---

## 5. Fracture

Fracture is the topic fragmentation pattern. It activates when coherence degrades — content has splintered into disconnected, unrelated regions with weak or no topical bridges between them.

### 5.1 Definition

Fracture occurs when the window's content stops forming a coherent body of information and splinters into disconnected regions. Instead of one or two focused topic clusters with smooth transitions between them, the window contains many small, unrelated clusters — or worse, isolated segments with no topical neighbors at all. The model sees fragments, not context.

Fracture is the structural pattern. It describes the **shape** of the window's content, not its value. A fractured window may contain content that is individually high-quality, high-density, and highly relevant to the task — but the pieces do not connect to each other. The model must mentally juggle unrelated fragments rather than following a coherent narrative or working through a unified set of reference material. This increases the chance of attention dilution, hallucination, and failure to synthesize information across segments.

**Fracture vs. gap.** These two patterns are easy to confuse because both indicate that "something is wrong with what's in the window." The distinction:

| | Fracture | Gap |
|---|---------|-----|
| **Primary dimension** | Coherence | Relevance |
| **What's wrong** | Content doesn't connect *to each other* | Content doesn't connect *to the task* |
| **Can coexist?** | Yes — a fractured window can be fully relevant (all fragments relate to the task individually) | Yes — an irrelevant window can be perfectly coherent (all content is about the same wrong topic) |
| **Remediation direction** | Restructure what's in the window (reorder, bridge, consolidate) | Replace what's in the window (evict irrelevant, add relevant) |

A window about "auth implementation" that contains scattered segments — some about OAuth, some about password hashing, some about session management, some about JWT validation — with no logical ordering or bridging is fractured but not gapped. Every segment is relevant; the structure is the problem. A window about last week's debugging session in a context where the current task is "write deployment docs" is gapped but not fractured — the content is coherent (it tells a clear debugging story), just irrelevant.

**How fracture emerges.** Common causes:

1. **Interleaved topics.** An agent session where the user discusses multiple unrelated subtasks, and the segments from different subtasks are interleaved by insertion order rather than grouped by topic.
2. **Eviction of bridging content.** A segment that connected two topical regions is evicted, leaving the regions disconnected. The coherence drop after eviction is what the continuity dimension measures — but the resulting structural state is what fracture detects.
3. **Broad context loading.** The caller seeds the window with diverse reference materials (multiple files, mixed documentation, varied tool results) that cover the breadth of a project without topical focus.
4. **Long-running sessions.** Over many turns, content from different phases of work accumulates. Early segments about task A sit next to later segments about task B, which sit next to even later segments about task C. No single topic dominates.

### 5.2 Signature

**Primary signal:**

| Signal | Source | Role |
|--------|--------|------|
| `windowScores.coherence` | Quality report (cl-spec-002 section 3.7) | Sole activation signal — window coherence below threshold is necessary and sufficient for fracture |

**Secondary signals (diagnostic, not activation):**

| Signal | Source | Role |
|--------|--------|------|
| Topical cluster count | Derived from coherence's topical concentration component (cl-spec-002 section 3.4). `clusterCount = round(1.0 / topicalConcentration)` | Quantifies fragmentation — more clusters means more disconnected regions |
| Adjacency discontinuities | Count of adjacent segment pairs (i, i+1) where `adjacencyCoherence(i) < 0.3` (cl-spec-002 section 3.3) | Identifies the specific points where the window "breaks" |
| Groups with integrity warnings | Groups where `integrityWarning: true` (groupCoherence < 0.3, cl-spec-002 section 9.4) | Identifies groups whose members don't support their grouping |
| Segment count | `segmentCount` from quality report | Contextualizes cluster count — 5 clusters across 50 segments is different from 5 clusters across 8 segments |

**Cluster count derivation.** The quality model computes topical concentration as `1.0 / k` where k is the number of clusters (cl-spec-002 section 3.4). Pattern detection inverts this to recover k. This is not an approximation — it is the exact inverse of the formula. Fracture reports cluster count because it is more intuitive than concentration: "your window has 7 disconnected topic clusters" is more diagnostic than "your topical concentration is 0.14."

**Fracture is a single-signal pattern.** Unlike erosion (which compounds density and utilization), fracture activates on coherence alone. A window with low coherence is fractured regardless of utilization, density, or relevance. Utilization does not gate fracture because fragmentation is a structural problem at any fill level — a half-empty window with scattered content is just as hard for the model to reason about as a full one.

### 5.3 Activation Thresholds

**Default thresholds:**

| Severity | Condition | Rationale |
|----------|-----------|-----------|
| `watch` | `coherence < 0.6` | Content is beginning to fragment. Topical structure is loosening. The model can still work effectively but the window is drifting from its baseline coherence. |
| `warning` | `coherence < 0.4` | Significant fragmentation. The window contains multiple disconnected topic regions. The model is likely struggling to synthesize information across regions. Adjacency flow is broken in multiple places. |
| `critical` | `coherence < 0.2` | Severe fragmentation. The window is a collection of unrelated fragments. Almost no topical structure remains — segments are islands with no coherent narrative connecting them. |

The thresholds satisfy the monotonic ordering: `watch > warning > critical` in coherence terms (lower coherence = worse).

**Secondary cluster-count trigger.** In addition to the absolute coherence threshold, fracture severity is elevated when the cluster count is disproportionately high relative to segment count:

```
clusterRatio = clusterCount / segmentCount
```

| Cluster ratio | Effect |
|---------------|--------|
| `> 0.5` | Elevate severity by one level (if not already at critical) |
| `≤ 0.5` | No elevation |

A cluster ratio above 0.5 means more than half the segments are in their own cluster — the window is more fragments than structure. This secondary trigger catches a specific failure mode that coherence score alone may underweight: a window where most segments have moderate adjacency scores (pulling coherence to ~0.5) but form many tiny clusters rather than a few large ones. The coherence score might read 0.5 (watch level), but the structural reality is worse than that number suggests.

The cluster-count trigger can only elevate — it cannot activate fracture independently. Coherence must be below the `watch` threshold before cluster ratio is evaluated.

**Rate-based severity elevation.** The general rule from section 2.4 applies: if `coherenceDelta < -0.15` between consecutive reports, severity is elevated by one level. This catches acute fracture — for example, a batch addition of unrelated content that suddenly shatters the window's topical structure.

**Hysteresis.** Standard framework hysteresis (section 9.3). Fracture activated at coherence < 0.4 does not deactivate until coherence > 0.4 + margin.

### 5.4 Diagnostic Output

**Explanation template by severity:**

| Severity | Explanation pattern |
|----------|-------------------|
| `watch` | `"Window coherence is {coherence}. Content is distributed across {clusterCount} topical clusters with {discontinuityCount} adjacency breaks."` |
| `warning` | `"Window is fracturing: coherence has fallen to {coherence}. Content is fragmented across {clusterCount} disconnected topic regions. {discontinuityCount} of {adjacencyPairCount} adjacent segment pairs have low similarity."` |
| `critical` | `"Severe fragmentation: coherence is {coherence}. The window contains {clusterCount} disconnected clusters across {segmentCount} segments. The model is receiving fragments, not coherent context."` |

**Signature content for fracture:**

```
signature: {
    primaryScore: { dimension: "coherence", value: <window coherence> },
    secondaryScores: [
        { dimension: "clusterCount", value: <number of topical clusters> },
        { dimension: "discontinuities", value: <count of low-similarity adjacency pairs> },
        { dimension: "brokenGroups", value: <count of groups with integrityWarning> }
    ],
    utilization: null,
    thresholdCrossed: { severity: <current severity>, threshold: <coherence threshold> }
}
```

**Adjacency break map.** The fracture diagnostic includes a list of adjacency discontinuities — the specific points in the segment order where topical flow breaks. For each break:

| Field | Description |
|-------|-------------|
| `segmentBefore` | Segment ID on the left side of the break |
| `segmentAfter` | Segment ID on the right side of the break |
| `similarity` | The adjacency similarity score at this point (< 0.3 by definition of a break) |
| `position` | Index position in the segment order |

This map tells the caller exactly where the fracture lines are. A window with 30 segments and 3 adjacency breaks has a clear structure: three contiguous topic regions separated by sharp transitions. A window with 30 segments and 15 breaks is scattered — nearly every other segment is unrelated to its neighbor.

**Group integrity alerts.** If any groups have `integrityWarning: true` (groupCoherence < 0.3), the fracture diagnostic lists them with their member count and group coherence score. These groups are structurally misleading — the group claims its members belong together, but their content does not support that claim. This is distinct from (but compounds) window-level fracture: a group with poor integrity is a local fracture within a declared unit.

### 5.5 Remediation Hints

Fracture remediation is about restructuring, not reducing. Unlike saturation (evict to free space) or erosion (remove redundancy), fracture requires the caller to change the arrangement or composition of content.

**Hint generation logic:**

1. **Reorder segments to improve adjacency.** If adjacency breaks can be reduced by moving segments closer to topically similar neighbors, suggest reordering. Detection identifies segment pairs with high similarity that are currently non-adjacent, and suggests moving one to be adjacent to the other:

   ```
   {
       action: "reorder",
       target: "{segmentId}",
       estimatedImpact: "improve adjacency coherence at position {position}",
       description: "Segment {segmentId} is similar to segments {nearId1}, {nearId2}
           but currently separated by unrelated content. Moving it adjacent to its
           topical neighbors would improve coherence flow."
   }
   ```

   Up to 3 reorder hints, targeting the segments with the highest similarity-to-a-non-adjacent-segment score. Reorder hints are first because they have zero content loss — no segments are removed, only repositioned. Note: reordering changes adjacency coherence scores and may invalidate the segment order that the quality model uses. The caller must request a new quality report after reordering.

2. **Evict isolated off-topic segments.** If any segments belong to a cluster of 1 (isolated, no topical neighbors) and have low relevance, suggest evicting them. These segments are fragments that do not connect to anything:

   ```
   {
       action: "evict",
       target: "{segmentId}",
       estimatedImpact: "remove isolated fragment ({tokenCount} tokens, relevance: {relevance})",
       description: "Segment {segmentId} is topically isolated — it has no similar
           neighbors and low relevance ({relevance}). Removing it simplifies the
           window's topical structure without losing relevant context."
   }
   ```

   Only suggested for segments with relevance < 0.4 — isolated but relevant segments should be repositioned, not evicted.

3. **Compact scattered same-topic segments.** If multiple non-adjacent segments belong to the same topical cluster, suggest compacting them into a single segment. This consolidates scattered fragments into a focused unit:

   ```
   {
       action: "compact",
       target: "{segmentId1}, {segmentId2}, ...",
       estimatedImpact: "consolidate {count} scattered segments into 1 ({tokenEstimate} tokens saved)",
       description: "Segments {segmentId1}, {segmentId2}, ... cover the same topic but are
           scattered across the window. Compacting them into a single segment improves
           adjacency flow and reduces fragmentation."
   }
   ```

   This is a suggestion for the caller to compact and merge, not a single compact operation — it may require evicting the scattered copies and adding a consolidated replacement. The hint provides the segment IDs and estimated savings, not the implementation.

4. **Dissolve misleading groups.** If any groups have integrity warnings, suggest dissolving them so that members can be independently repositioned or evicted:

   ```
   {
       action: "dissolve",
       target: "{groupId}",
       estimatedImpact: null,
       description: "Group {groupId} has internal coherence {groupCoherence} — its members
           are not topically related. Dissolving the group allows members to be independently
           repositioned or evicted, which may improve window-level coherence."
   }
   ```

**Hint ordering.** Reorder first (zero loss, structural improvement), evict isolated fragments second (removes noise), compact scattered clusters third (consolidates with some information loss), dissolve groups last (enables future restructuring but does not directly improve coherence).

---

## 6. Gap

Gap is the task relevance drift pattern. It activates when relevance is low — the window is occupied by content that does not serve the current task, leaving insufficient room for content that would.

### 6.1 Definition

Gap is the mismatch between what the window contains and what the task needs. The name captures the key insight: there is a **gap** between the context the model has and the context the model needs. The window may be full, well-structured, and free of redundancy — and still fail the model because its content does not serve the current task.

Gap can emerge in two ways:

**Gradual drift.** The task evolves but the context does not keep up. The user starts with "fix the login bug," and the window fills with auth-related context. The conversation pivots to "now update the deployment pipeline," but the auth context remains. Each turn adds a little deployment content while the auth content persists — the window slowly drifts from fully relevant to partially relevant to mostly irrelevant. Gradual drift is insidious because no single operation causes the gap. It emerges from the accumulation of small relevance losses over many turns.

**Sudden shift.** The caller updates the task descriptor via `setTask` without evicting content from the previous task. This is the most common trigger in agent systems that handle multi-step workflows — the agent finishes step 1 and moves to step 2, but the window still contains step 1's context. The relevance score drops immediately because the new task descriptor redefines what "relevant" means (cl-spec-002 section 5.6). A sudden shift is easier to detect and easier to fix than gradual drift — the caller knows they changed the task and can proactively evict stale content.

**Gap and utilization.** Gap at low utilization is a mild concern — there is room to add relevant content alongside the irrelevant material. The model receives some noise but also has space for signal. Gap at high utilization is urgent: the window is full of the wrong things, and there is no room for the right things. The model cannot receive the context it needs because irrelevant content is occupying the capacity. This interaction between gap and utilization is reflected in the severity thresholds (section 6.3) — higher severity requires both low relevance and high utilization.

**Task descriptor requirement.** Gap is the only pattern that has a hard prerequisite: it **requires an active task descriptor**. Without a task descriptor, relevance scores are uniformly 1.0 for all segments (cl-spec-002 section 5.1) — the quality model assumes everything is relevant because it has no basis to judge otherwise. Gap detection on uniformly-1.0 relevance scores is meaningless. When `taskDescriptorSet` is false, gap is suppressed entirely — it does not appear in the pattern results, regardless of any other condition. This is not a configurable suppression (section 9.2); it is a structural requirement. The caller can set a task descriptor at any time via `setTask` to enable gap detection.

### 6.2 Signature

**Primary signal:**

| Signal | Source | Role |
|--------|--------|------|
| `windowScores.relevance` | Quality report (cl-spec-002 section 5.7) | Primary activation signal — window relevance below threshold is necessary for gap |

**Gating signal:**

| Signal | Source | Role |
|--------|--------|------|
| `taskDescriptorSet` | Detection framework state (section 2.1) | Hard prerequisite — gap is suppressed entirely when false |

**Compound signal (for warning and critical):**

| Signal | Source | Role |
|--------|--------|------|
| `capacity.utilization` | Tokenization subsystem (cl-spec-006 section 4.5) | Compound condition at higher severities — gap under capacity pressure is more urgent |

**Secondary signals (diagnostic, not activation):**

| Signal | Source | Role |
|--------|--------|------|
| Irrelevant segment count | Count of segments with `relevance < 0.3` from quality report | Quantifies how many segments are strongly misaligned with the task |
| Irrelevant token cost | Sum of `tokenCount` for segments with `relevance < 0.3` | Quantifies the capacity consumed by irrelevant content |
| Per-segment relevance scores | `segments[].relevance` from quality report | Identifies the worst offenders |
| Task transition recency | Whether `setTask` was called within the last 2 reports | Contextualizes the gap — recent task change means low relevance may be transient |

**Gap is a hybrid pattern.** At `watch` severity, it activates on relevance alone — the window is drifting from the task and the caller should be aware. At `warning` and `critical`, it requires both low relevance and high utilization — the drift is only urgent when capacity pressure prevents adding relevant content. This hybrid structure places gap between single-signal patterns (fracture, collapse) and fully compound patterns (erosion).

### 6.3 Activation Thresholds

**Default thresholds:**

| Severity | Relevance condition | Utilization condition | Both required? |
|----------|--------------------|-----------------------|---------------|
| `watch` | `relevance < 0.6` | — | No — relevance alone suffices |
| `warning` | `relevance < 0.4` | `utilization > 0.6` | Yes |
| `critical` | `relevance < 0.3` | `utilization > 0.8` | Yes |

The `watch` level has no utilization gate. Low relevance is worth reporting even when the window has room — it tells the caller that context is drifting and preventive eviction would be wise. The caller can ignore the watch if they know they have capacity to add relevant content.

The `warning` and `critical` levels gate on utilization because gap without capacity pressure is annoying but not blocking — there is room to fix it by adding relevant content. Gap with capacity pressure is blocking — irrelevant content must be removed before relevant content can enter.

**Task transition grace period.** When `setTask` was called within the last 2 quality reports, gap severity is capped at `watch` regardless of absolute scores. A task change immediately invalidates all relevance scores and recomputes them against the new descriptor (cl-spec-002 section 5.6). This typically causes a sharp relevance drop — content that was relevant to the old task is irrelevant to the new one. This drop is expected and transient; the caller needs time to evict stale content and add new content. Firing `warning` or `critical` immediately after a task change would produce an alarm that the caller cannot yet have addressed. The grace period gives the caller 2 report cycles to adapt the window before high-severity alerts activate.

The grace period does not suppress gap entirely — `watch` still fires, informing the caller that the window needs adaptation. It only caps severity, preventing noise at higher levels.

**Rate-based severity elevation.** The general rule from section 2.4 applies: if `relevanceDelta < -0.15` between consecutive reports, severity is elevated by one level. However, this elevation is **suppressed during the task transition grace period** — a large relevance drop immediately after `setTask` is expected, not anomalous.

**Hysteresis.** Standard framework hysteresis (section 9.3). For the compound levels (`warning`, `critical`), either gate closing (relevance recovering or utilization dropping) triggers deactivation with hysteresis margin, following the same logic as erosion (section 4.3).

### 6.4 Diagnostic Output

**Explanation template by severity:**

| Severity | Explanation pattern |
|----------|-------------------|
| `watch` | `"Window relevance is {relevance} for the current task. {irrelevantCount} segments ({irrelevantTokens} tokens) have low task alignment."` |
| `watch` (post-task-change) | `"Window relevance dropped to {relevance} after task change. {irrelevantCount} segments ({irrelevantTokens} tokens) from the previous task remain. This is expected — the window has not yet adapted to the new task."` |
| `warning` | `"Task-context gap: relevance is {relevance} at {utilization}% utilization. {irrelevantTokens} tokens of irrelevant content are consuming capacity needed for task-relevant context."` |
| `critical` | `"Severe task-context gap: relevance is {relevance} at {utilization}% utilization. The window is full of content that does not serve the current task. {irrelevantTokens} tokens ({irrelevantPercent}% of active content) are irrelevant."` |

**Signature content for gap:**

```
signature: {
    primaryScore: { dimension: "relevance", value: <window relevance> },
    secondaryScores: [
        { dimension: "irrelevantSegments", value: <count with relevance < 0.3> },
        { dimension: "irrelevantTokens", value: <total tokens in irrelevant segments> }
    ],
    utilization: <current utilization>,
    thresholdCrossed: { severity: <current severity>, threshold: <relevance threshold> }
}
```

**Irrelevance detail.** The gap diagnostic includes a ranked list of the most irrelevant segments — up to 10 segments with the lowest relevance scores, ordered by token cost (descending). For each:

| Field | Description |
|-------|-------------|
| `segmentId` | The irrelevant segment |
| `relevance` | Its relevance score |
| `tokenCount` | Tokens this segment consumes |
| `origin` | The segment's origin tag (helps the caller understand what type of content is misaligned) |
| `protection` | The segment's protection level (tells the caller whether it is evictable) |
| `createdAt` | When the segment was added (older segments from previous tasks are common offenders) |

This list gives the caller a direct eviction path ordered by the most capacity reclaimed from the least relevant content.

### 6.5 Remediation Hints

Gap remediation is primarily about replacing irrelevant content with relevant content. The hints reflect this — most suggest eviction, with special cases for content that should be compacted rather than removed.

**Hint generation logic:**

1. **Evict lowest-relevance default segments.** The primary hint targets default-protected segments with the lowest relevance scores. These are the easiest to remove and typically the largest source of irrelevant tokens:

   ```
   {
       action: "evict",
       target: "{segmentId1}, {segmentId2}, ...",
       estimatedImpact: "reclaim ~{totalTokens} tokens of irrelevant content",
       description: "These {count} segments have relevance below {threshold} and default
           protection. Evicting them frees capacity for task-relevant content.
           Lowest relevance: {segmentId1} ({relevance1}), {segmentId2} ({relevance2})."
   }
   ```

   Up to 5 segment IDs in the target, ordered by token count descending.

2. **Update the task descriptor.** If the task descriptor has not been updated recently (no `setTask` call within the last 5 reports) and window relevance is at `warning` or `critical`, suggest that the task descriptor may be stale:

   ```
   {
       action: "updateTask",
       target: null,
       estimatedImpact: "relevance scores will be recomputed against the updated task",
       description: "The task descriptor has not been updated recently. If the task has
           evolved, updating via setTask() will produce more accurate relevance scores
           and may resolve or clarify the gap."
   }
   ```

   This hint acknowledges that low relevance may be a measurement problem (stale descriptor) rather than a content problem (wrong content). The caller should verify the descriptor is current before mass-evicting content.

3. **Compact irrelevant seed segments.** Seed segments cannot be evicted under normal pressure, but they may have low relevance to the current task — especially after a task change. Suggest compacting them to reduce their token footprint while preserving their foundational role:

   ```
   {
       action: "compact",
       target: "{segmentId}",
       estimatedImpact: "reduce seed token usage while preserving foundational context",
       description: "Seed segment {segmentId} has relevance {relevance} to the current task.
           Compacting it preserves its foundational information in fewer tokens, freeing
           capacity for task-relevant content."
   }
   ```

   Only suggested for seed segments with relevance < 0.4. Seeds with higher relevance should not be compacted — they are still serving the task.

4. **Evict low-priority segments with low relevance.** After default segments, target `priority(n)` segments at low priority levels that are also irrelevant:

   ```
   {
       action: "evict",
       target: "{segmentId}",
       estimatedImpact: "reclaim ~{tokenCount} tokens (relevance: {relevance}, priority: {n})",
       description: "Priority segment {segmentId} has low relevance ({relevance}) and low
           priority ({n}). Evicting it frees capacity without removing high-value content."
   }
   ```

**Post-task-change special case.** When the gap activated within the task transition grace period (section 6.3), the first hint is always the `updateTask` check — but reframed as a confirmation rather than a suggestion:

   ```
   {
       action: "updateTask",
       target: null,
       estimatedImpact: null,
       description: "Task was recently changed. Low relevance is expected while the window
           adapts. Evict content from the previous task to make room for the new task's
           context."
   }
   ```

This prevents the caller from interpreting the gap as a problem with the new task descriptor when it is actually an expected transition state.

---

## 7. Collapse

Collapse is the information loss pattern. It activates when continuity drops below critical thresholds — the window has lost substantial amounts of important context through eviction or aggressive compaction, and the losses are likely unrecoverable.

### 7.1 Definition

Collapse represents the most severe form of degradation: the window has shed so much context that it can no longer adequately support the model. The other four patterns describe problems with what is in the window. Collapse describes a problem with what is **no longer** in the window — information that was present, was important, and is now gone.

What makes collapse distinct — and what makes it the highest-priority pattern (section 8.3) — is **irreversibility**. Saturation is resolved by evicting content. Erosion is resolved by deduplicating. Fracture is resolved by restructuring. Gap is resolved by replacing irrelevant content with relevant content. Collapse may not be resolvable at all:

- Evicted content where `retainContent: false` was set is gone permanently. There is nothing to restore.
- Evicted content where `retainContent: true` was set can be restored, but restoration fidelity is typically less than 1.0 — the task has evolved since eviction, making the content less relevant than when it was removed (cl-spec-002 section 6.4).
- Aggressively compacted content has lost detail that cannot be recovered. The summary preserves the gist but not the specifics. If the specifics matter, the compaction is a permanent loss.

Collapse is the end state of poorly managed degradation. The typical progression:

1. Saturation builds (capacity pressure).
2. The caller evicts to relieve pressure, but without adequate quality signals — they evict by size, recency, or protection level rather than by value.
3. High-value content is evicted alongside low-value content.
4. Continuity drops as the cumulative cost of information loss mounts.
5. At some point, enough important context has been lost that the model no longer has what it needs. This is collapse.

Collapse is also the pattern that validates or indicts the caller's eviction strategy. A session that reaches high utilization and evicts extensively without triggering collapse is well-managed — the eviction decisions targeted low-value content. A session that collapses after moderate eviction had bad eviction decisions — it removed the wrong segments. The continuity ledger (cl-spec-002 section 6.5) provides the forensic detail to distinguish these cases.

### 7.2 Signature

**Primary signal:**

| Signal | Source | Role |
|--------|--------|------|
| `windowScores.continuity` | Quality report (cl-spec-002 section 6.7) | Sole activation signal — window continuity below threshold is necessary and sufficient for collapse |

**Secondary signals (diagnostic, not activation):**

| Signal | Source | Role |
|--------|--------|------|
| `continuityLedger.netLoss` | Quality report (cl-spec-002 section 9.5) | Absolute magnitude of cumulative information loss |
| `continuityLedger.totalEvictions` | Quality report | Total eviction count in this session |
| `continuityLedger.totalCompactions` | Quality report | Total compaction count in this session |
| `continuityLedger.totalRestorations` | Quality report | Total restoration count — indicates how much recovery has been attempted |
| `continuityLedger.tokensEvicted` | Quality report | Total tokens removed by eviction |
| `continuityLedger.tokensCompacted` | Quality report | Total tokens reduced by compaction |
| `continuityLedger.tokensRestored` | Quality report | Total tokens recovered by restoration |
| `continuityLedger.recentEvents` | Quality report | Last 10 continuity events — shows the recent pattern of loss |
| `trend.continuityDelta` | Quality report (cl-spec-002 section 9.6) | Rate of continuity decline — acute drops signal bad eviction decisions |
| Per-segment continuity scores | `segments[].continuity` from quality report | Identifies restored segments with low fidelity and compacted segments with high information loss |

**Collapse is a single-signal pattern**, like fracture. It activates on continuity alone — no utilization gate, no compound condition. Information loss is information loss regardless of how full the window is. A half-empty window that has lost its most important segments is in collapse just as much as a full one.

**Collapse and the continuity ledger.** Collapse is the pattern most tightly coupled to the continuity ledger. While the continuity score triggers activation, the ledger provides the forensic detail that makes the diagnostic useful — which evictions caused the most damage, whether restoration has been attempted and how successful it was, and whether the loss is accelerating or stabilizing.

### 7.3 Activation Thresholds

**Default thresholds:**

| Severity | Condition | Rationale |
|----------|-----------|-----------|
| `watch` | `continuity < 0.7` | Moderate information loss. Some important content has been evicted or aggressively compacted. The window is still functional but the cumulative cost is becoming significant. |
| `warning` | `continuity < 0.5` | Substantial information loss. The window has shed a meaningful fraction of its total information value. The model is likely missing context that would improve its performance. |
| `critical` | `continuity < 0.3` | Severe information loss. This threshold is referenced directly in cl-spec-002 section 6.7 — it marks the boundary where the quality model considers the window to have "lost most of its original information." The model is likely underperforming significantly due to missing context. |

The thresholds satisfy the monotonic ordering: `watch > warning > critical` in continuity terms.

**Rate-of-decline trigger.** Collapse has a specialized rate-based rule that is stricter than the general 0.15 rule from section 2.4:

```
If continuityDelta < -0.10 between consecutive reports:
    elevate severity by one level
```

The threshold is 0.10 rather than the general 0.15 because continuity declines are discrete — they happen at eviction or compaction events, not gradually. A continuity drop of 0.10 in a single report cycle typically means a high-value eviction just occurred. This is worth flagging immediately because:

1. The eviction may have been a mistake that can be reversed (restore while the content is still retained).
2. If eviction continues at this rate, collapse will deepen rapidly.

**Acute collapse trigger.** A single eviction event that contributes more than 0.15 to net loss (a very expensive eviction — high relevance, high importance, large token count) triggers immediate `warning` regardless of the absolute continuity score. This catches the scenario where continuity was 0.9, a catastrophic eviction drops it to 0.74, and the absolute threshold would only trigger `watch`. The acute trigger recognizes that the event itself is alarming — a single eviction should not cost that much.

The acute trigger is evaluated by inspecting `continuityLedger.recentEvents` for the most recent eviction event and comparing its cost against the 0.15 threshold. It only applies to the most recent event in the current report cycle — historical events are already reflected in the absolute continuity score.

**Hysteresis.** Standard framework hysteresis (section 9.3). Collapse deactivation requires continuity to recover above the threshold plus margin. In practice, continuity rarely recovers — it is a monotonically declining dimension in most sessions (cl-spec-002 section 6.7). Collapse, once activated, tends to persist for the remainder of the session. This is a feature, not a flaw — it keeps the alert visible as a reminder that information has been lost.

### 7.4 Diagnostic Output

**Explanation template by severity:**

| Severity | Explanation pattern |
|----------|-------------------|
| `watch` | `"Window continuity is {continuity}. {totalEvictions} evictions and {totalCompactions} compactions have resulted in a net information loss of {netLoss}. {tokensEvicted} tokens have been evicted, {tokensRestored} restored."` |
| `warning` | `"Context is collapsing: continuity has fallen to {continuity}. Net information loss is {netLoss}. {unrestorableCount} evicted segments cannot be restored (content not retained). The model is missing significant context."` |
| `warning` (acute) | `"Acute context loss: a recent eviction of segment {segmentId} cost {evictionCost} — an unusually expensive removal. Continuity dropped to {continuity}. Consider restoring this segment."` |
| `critical` | `"Severe context collapse: continuity is {continuity}. The window has lost most of its original information value through {totalEvictions} evictions and {totalCompactions} compactions. Net loss: {netLoss}. Session restart may be more effective than repair."` |

**Signature content for collapse:**

```
signature: {
    primaryScore: { dimension: "continuity", value: <window continuity> },
    secondaryScores: [
        { dimension: "netLoss", value: <cumulative net information loss> },
        { dimension: "totalEvictions", value: <eviction count> },
        { dimension: "unrestorableSegments", value: <count of evicted segments with content not retained> }
    ],
    utilization: null,
    thresholdCrossed: { severity: <current severity>, threshold: <continuity threshold> }
}
```

**Loss forensics.** The collapse diagnostic includes a forensic breakdown of information loss, derived from the continuity ledger:

| Field | Description |
|-------|-------------|
| `totalEvictionCost` | Sum of all eviction costs |
| `totalCompactionCost` | Sum of all compaction costs |
| `totalRecovery` | Sum of all restoration recovery (eviction cost × restoration fidelity) |
| `netLoss` | `totalEvictionCost + totalCompactionCost - totalRecovery` |
| `evictedRetained` | Count of evicted segments with content retained (restorable) |
| `evictedDiscarded` | Count of evicted segments with content discarded (unrestorable) |
| `worstEviction` | The single eviction with the highest cost: segment ID, cost, relevance at eviction, importance, token count |
| `recentLossRate` | Average continuity delta over the last 3 reports — indicates whether collapse is accelerating, decelerating, or stable |

The worst eviction is highlighted because it is often the single decision the caller most regrets — and most wants to reverse. If the segment's content was retained, the caller can restore it immediately.

**Restored-segment fidelity.** If any segments have been restored with low fidelity (continuity score < 0.5), the diagnostic lists them. These segments are present in the window but degraded — the caller should be aware that the restoration did not fully recover the lost quality.

### 7.5 Remediation Hints

Collapse remediation is difficult by design — collapse means information is lost, and loss is hard to undo. The hints reflect this reality: they range from targeted recovery (when possible) to acceptance (when not).

**Hint generation logic:**

1. **Restore high-value evicted segments.** If evicted segments exist with `retainContent: true`, suggest restoring those with the highest eviction cost (they were the most valuable when removed):

   ```
   {
       action: "restore",
       target: "{segmentId1}, {segmentId2}, ...",
       estimatedImpact: "recover ~{estimatedRecovery} of continuity loss",
       description: "These {count} evicted segments had the highest eviction cost and their
           content is retained. Restoring them recovers the most information per operation.
           Highest-value: {segmentId1} (eviction cost: {cost1}), {segmentId2} (cost: {cost2})."
   }
   ```

   Up to 5 segments, ordered by eviction cost descending. The estimated recovery is `evictionCost × estimatedFidelity`, where estimated fidelity is 0.7 (a conservative assumption — actual fidelity depends on how much the task has evolved since eviction).

   Restoration hints are only emitted if restoring the segments would not push utilization above `critical` saturation (> 0.95). Restoring content into an already-saturated window trades one problem for another.

2. **Slow eviction rate.** If `recentLossRate` shows accelerating decline (continuityDelta getting more negative over recent reports), suggest reducing eviction frequency:

   ```
   {
       action: "slowEviction",
       target: null,
       estimatedImpact: "stabilize continuity decline rate",
       description: "Continuity is declining at an accelerating rate ({recentLossRate} per report).
           Reducing eviction frequency or switching to compaction instead of full eviction
           will slow the loss of information."
   }
   ```

3. **Switch to compaction.** If recent continuity events show full evictions of segments with moderate-to-high importance (importance > 0.5), suggest compaction as an alternative:

   ```
   {
       action: "compact",
       target: "future eviction candidates",
       estimatedImpact: "preserve information while reducing token cost",
       description: "Recent evictions removed segments with importance > 0.5. Compacting
           these segments instead of evicting them would preserve their core information
           while still reclaiming tokens. Compaction cost is lower than eviction cost."
   }
   ```

4. **Increase capacity.** As with saturation, sometimes the right answer is a bigger window — especially when the caller is caught in a cycle of eviction-driven collapse:

   ```
   {
       action: "increaseCapacity",
       target: null,
       estimatedImpact: "reduce eviction pressure, slowing continuity decline",
       description: "Increasing the window capacity reduces the need for eviction, which
           is the primary driver of continuity loss."
   }
   ```

5. **Restart session.** At `critical` severity only, when `evictedDiscarded` is high (many segments with content not retained) and `netLoss` exceeds 0.6, suggest that repair may cost more than rebuilding:

   ```
   {
       action: "restart",
       target: null,
       estimatedImpact: "reset continuity to 1.0 with fresh context",
       description: "Continuity is at {continuity} with {evictedDiscarded} unrestorable
           segments. Repairing the current session may be less effective than starting fresh
           with re-seeded context. Consider whether the remaining context justifies
           continuing this session."
   }
   ```

   The restart hint is the last resort. It is only emitted at `critical` collapse with a high proportion of unrestorable losses. It does not trigger at `warning` — moderate collapse is recoverable. It does not trigger when most evicted content is retained — restoration is still viable. It is the honest signal that the session has degraded beyond practical repair.

**Hint ordering.** Restore first (direct recovery), slow eviction second (stop the bleeding), compact third (change strategy for future operations), increase capacity fourth (structural fix), restart last (nuclear option).

---

## 8. Pattern Interactions

Degradation patterns do not occur in isolation. In practice, they compound — saturation causes eviction, which causes collapse; unmanaged content growth causes erosion and fracture simultaneously. This section defines how patterns interact and how compound states are reported.

### 8.1 Causal Chains

Degradation follows predictable causal progressions. Detecting an upstream pattern should raise the detection framework's vigilance for downstream patterns — not by lowering thresholds (thresholds are fixed and explicit), but by enriching the diagnostic output with causal context. When saturation is active and an eviction occurs, the collapse diagnostic should note that the eviction happened under capacity pressure, which correlates with lower eviction quality.

**Primary causal chains:**

| Chain | Progression | Mechanism | Frequency |
|-------|-------------|-----------|-----------|
| **Pressure → Loss** | Saturation → Collapse | Saturation forces eviction. Eviction under pressure is rushed — the caller evicts whatever relieves the most pressure (large segments), not whatever has the least value. High-value segments are disproportionately large, so pressure-driven eviction often removes the wrong content. Each bad eviction erodes continuity until collapse activates. | Most common. This is the dominant degradation pathway in production sessions. |
| **Pressure → Dilution** | Saturation → Erosion | Saturation without eviction. The caller keeps adding content without removing anything, hoping to avoid information loss. Redundant content accumulates — repeated tool invocations, restated instructions, duplicated context. The window fills with junk that no one cleaned up because removing content felt risky. | Common in sessions where the caller lacks eviction logic or is too conservative about removal. |
| **Shift → Drift** | Task change → Gap | The caller updates the task descriptor (or the task evolves implicitly without a `setTask` call). Content from the previous task remains in the window. Relevance scores drop because the quality model now evaluates content against the new task. The window is full of the old task's context with little room for the new task's needs. | Common in agent workflows with multi-step tasks. The task transition grace period (section 6.3) mitigates false alarms but does not prevent the gap itself. |
| **Drift + Pressure → Loss** | Gap + Saturation → Collapse | The window is full of irrelevant content (gap) and under capacity pressure (saturation). The caller must evict to make room for relevant content, but any eviction risks removing the few remaining relevant segments. If the caller evicts by size or recency rather than relevance, they may remove exactly the content the new task needs. This is the most dangerous compound chain — it combines the urgency of saturation with the misdirection of gap. | Moderate. Requires both a task shift and high utilization, which co-occur in long-running agent sessions. |
| **Accumulation → Fragmentation** | Long session → Fracture | Over many turns spanning diverse topics, content from different phases of work accumulates without eviction. Segments from task A interleave with segments from task B and C. No single topic dominates. Coherence degrades as the window becomes a timeline of everything that happened rather than a focused body of reference material. | Common in interactive sessions. Less common in agent workflows with focused tasks. |
| **Dilution → Loss** | Erosion → Collapse | The window is full of redundant content (erosion). The caller evicts to free capacity, but their eviction logic is density-unaware — it does not distinguish redundant segments from unique ones. It removes segments with low composite scores, which may include segments whose uniqueness was their primary value. The non-redundant copy is evicted; the redundant copies remain. Continuity drops because unique information was lost while duplicates were preserved. | Less common but particularly damaging. The caller intended to improve the window and made it worse. |

**Causal chain visualization:**

```
                    ┌─────────────────────────────────┐
                    │          Saturation              │
                    │    (capacity pressure builds)    │
                    └──────┬──────────────┬────────────┘
                           │              │
              eviction     │              │  no eviction
              under        │              │  (content
              pressure     │              │   accumulates)
                           │              │
                           v              v
                    ┌──────────┐   ┌──────────┐
                    │ Collapse │   │ Erosion  │
                    │ (loss)   │   │ (dilution)│
                    └──────────┘   └────┬─────┘
                         ^              │
                         │              │ density-unaware
                         │              │ eviction
                         │              │
                         └──────────────┘

  Task change ──────> Gap ──────> (+ Saturation) ──────> Collapse
                      (drift)     (pressure on             (loss of
                                   wrong content)           remaining
                                                            relevant
                                                            content)

  Long session ─────> Fracture
                      (topic accumulation)
```

**Upstream vigilance.** When a pattern is active, the detection framework annotates downstream patterns with a `causalContext` field in their diagnostic output. This field is informational — it does not change activation logic, severity, or thresholds. It tells the caller why the downstream pattern may have emerged and suggests that addressing the upstream cause may be more effective than treating the symptom.

| Active upstream | Downstream to watch | Annotation |
|----------------|--------------------|----|
| Saturation | Collapse | `"Collapse risk is elevated — saturation is forcing eviction decisions under capacity pressure."` |
| Saturation | Erosion | `"Erosion risk is elevated — content is accumulating without eviction, which typically leads to redundancy buildup."` |
| Gap | Collapse | `"Collapse risk is elevated — eviction under a task-context gap may remove the few remaining relevant segments."` |
| Erosion | Collapse | `"Collapse risk is elevated — density-unaware eviction may remove unique content while preserving redundant copies."` |
| Gap + Saturation | Collapse | `"Collapse risk is critically elevated — the window is full of irrelevant content, and eviction under this pressure is likely to remove remaining relevant context."` |

The causal context is only included when the upstream pattern is active in the same report. Historical upstream patterns (previously active, now resolved) do not generate causal annotations — they are available in the pattern history (section 2.5) for forensic analysis but do not clutter the current diagnostic.

### 8.2 Compound Patterns

When multiple patterns are active simultaneously, the combination is often more diagnostic than the individual patterns. The detection framework does not define named compound states — named compounds add a combinatorial taxonomy that grows with every new pattern and provides little value over simply reporting all active patterns. Instead, the framework identifies **semantically meaningful combinations** and includes compound-specific diagnostic annotations when they co-occur.

**Compound detection.** After individual pattern detection completes, the framework evaluates pairwise and higher-order combinations among active patterns. When a known compound is detected, each participating pattern receives a `compoundContext` field describing what the combination means and how remediation priority should shift.

**Defined compounds:**

| Compound | Patterns | Diagnosis | Remediation implication |
|----------|----------|-----------|------------------------|
| **Full of junk** | Saturation + Erosion | The window is at capacity and what fills it is largely redundant. Capacity pressure is real but the bottleneck is waste, not volume. Deduplication would resolve both patterns simultaneously — it reduces utilization (relieving saturation) and improves density (resolving erosion). | Deduplicate first. This is the rare case where one action addresses two patterns. The erosion remediation hints (section 4.5) should be prioritized over the saturation hints — removing redundancy is higher-leverage than generic eviction because it reclaims capacity with zero information loss. |
| **Full of the wrong things** | Saturation + Gap | The window is at capacity and what fills it is irrelevant to the current task. Unlike "full of junk" (where the content is on-topic but redundant), this compound indicates a task–content mismatch at scale. Generic eviction will not help unless it targets irrelevant content specifically. | Task-aware eviction is critical. The gap remediation hints (section 6.5) take priority. If the task descriptor is stale, update it first — relevance scores drive eviction targeting, so inaccurate relevance means inaccurate eviction. The saturation hints are secondary because relieving capacity pressure with task-unaware eviction risks removing the few relevant segments that remain. |
| **Scattered and irrelevant** | Fracture + Gap | Content is both disconnected from each other and disconnected from the task. The window has no topical structure (fracture) and no task alignment (gap). This is the most disoriented state — the model is receiving fragments of content it doesn't need. Restructuring (fracture's remedy) is pointless when the content being restructured is irrelevant. | Replace, don't restructure. Address the gap first by evicting irrelevant content. Once the remaining content is task-relevant, then address fracture by restructuring what is left. Reordering irrelevant fragments is wasted effort. |
| **Loss dominates** | Collapse + any | When collapse is active alongside any other pattern, the loss signal dominates. Other patterns describe problems with what is in the window. Collapse describes a problem with what is no longer in the window. The information that has been lost may be the same information that would resolve the other patterns — a key bridging segment whose eviction caused both the continuity drop (collapse) and the coherence drop (fracture), or a highly relevant segment whose removal caused both the continuity drop and the relevance drop (gap). | Address collapse first. Specifically: if restorable segments exist, evaluate whether restoring them would also improve the co-occurring pattern. A restored bridging segment may resolve both collapse and fracture. A restored relevant segment may resolve both collapse and gap. The collapse remediation hints (section 7.5) should be evaluated for cross-pattern impact before acting on the co-occurring pattern's hints. |
| **Pressure loop** | Collapse + Saturation | The worst compound. Information has been lost (collapse) AND there is no room to recover it (saturation). Restoring evicted segments — the primary collapse remedy — would push utilization higher, worsening saturation. Evicting to relieve saturation risks deepening collapse. The caller is trapped: every action that helps one pattern hurts the other. | Break the loop by creating room through zero-loss operations. Deduplicate or compact non-critical segments to free capacity without further continuity loss. Then restore the highest-value evicted segments into the freed space. If deduplication and compaction cannot free enough space, the caller faces a genuine tradeoff — the collapse diagnostic should include the cost–benefit of restoration vs. continued saturation, and the `restart` hint (section 7.5) becomes more relevant. |
| **Triple pressure** | Saturation + Erosion + Gap | The window is full, redundant, and irrelevant. This is the degenerate state of a long-running session after a task change with no content management. Every dimension except coherence and continuity is degraded. | Prioritize gap-targeted deduplication — identify content that is both redundant and irrelevant, and remove it first. This simultaneously addresses all three patterns. Then address remaining gap (evict irrelevant non-redundant content) and remaining erosion (deduplicate relevant redundant content). |

**Compound context in diagnostic output.** When a compound is detected, each participating pattern's `ActivePattern` result includes:

| Field | Type | Description |
|-------|------|-------------|
| `compoundContext` | `CompoundContext` or null | Present when this pattern participates in a known compound |
| `compoundContext.compound` | string | Identifier for the compound: `"fullOfJunk"`, `"fullOfWrongThings"`, `"scatteredAndIrrelevant"`, `"lossDominates"`, `"pressureLoop"`, `"triplePressure"` |
| `compoundContext.coPatterns` | `PatternName[]` | The other patterns in this compound |
| `compoundContext.diagnosis` | string | Human-readable compound diagnosis (the "Diagnosis" column from the table above) |
| `compoundContext.remediationShift` | string | How remediation priority changes under this compound (the "Remediation implication" column) |

Compound context is informational. It does not change pattern severity, activation thresholds, or remediation hints. Each pattern still produces its own hints independently. The compound context tells the caller how to prioritize across the independent hint sets — which pattern's hints to act on first, and which actions address multiple patterns simultaneously.

**Compound detection is not combinatorial.** The framework checks for the specific compounds defined above, not for every possible pattern combination. Five patterns produce 26 non-empty subsets — most are not semantically meaningful. Erosion + Fracture, for example, does not have a distinct diagnosis beyond "the window has redundancy and fragmentation" — the individual patterns cover this adequately. Compounds are defined only when the combination produces an insight or remediation shift that the individual patterns do not.

### 8.3 Pattern Priority

When multiple patterns are active, the `patterns` array in the detection result (section 2.3) is ordered by priority — the pattern the caller should address first appears first. Priority is a fixed ordering, not a dynamic ranking. It does not depend on severity, duration, or compound state — those factors inform urgency within a priority level, but the level itself is determined by the nature of the pattern.

**Priority ordering (highest to lowest):**

| Priority | Pattern | Rationale |
|----------|---------|-----------|
| 1 | **Collapse** | Irreversibility. Collapse means information has been permanently lost. Every other pattern describes a problem that can be fixed without information loss — saturation by evicting, erosion by deduplicating, fracture by restructuring, gap by replacing. Collapse may not be fixable at all. Delayed response to collapse is worse than delayed response to any other pattern because the window of opportunity for restoration closes as the session progresses and content retention expires. Address collapse first because the cost of delay is highest. |
| 2 | **Saturation** | Causality. Saturation is the upstream cause of most other patterns (section 8.1). A saturated window forces eviction, which causes collapse; a saturated window without eviction accumulates junk, which causes erosion. Addressing saturation before it triggers downstream patterns is higher-leverage than addressing the downstream patterns after they activate. Saturation is second to collapse because collapse is irreversible — if both are active, the damage that has already happened (collapse) takes precedence over the pressure that may cause more damage (saturation). |
| 3 | **Gap** | Task impact. Gap directly impairs the model's ability to serve the current task — the context window does not contain what the model needs. Erosion and fracture impair efficiency and structure, but a relevant, redundant window (erosion) or a relevant, fragmented window (fracture) still provides the model with task-appropriate information. A full, well-structured, non-redundant window of irrelevant content (gap) provides the model with nothing useful. Gap is below saturation because saturation causes gap (the window is too full to add relevant content), so relieving saturation may partially resolve the gap. |
| 4 | **Erosion** | Capacity waste. Erosion consumes tokens with redundant content. It is a less urgent problem than gap because redundant content at least contains the right information — it is just carrying multiple copies. The window is inefficient, not misdirected. Erosion is above fracture because it has a direct capacity cost (wasted tokens prevent new content from entering) while fracture is a structural problem with no capacity dimension. |
| 5 | **Fracture** | Structural only. Fracture degrades the model's ability to synthesize across segments, but it does not waste capacity, block task-relevant content, cause information loss, or prevent the model from accessing the content it needs. Each fragment is individually available to the model — the problem is that the fragments do not connect. This is the least immediately harmful pattern because the model can often work around poor topical structure if the content itself is present, relevant, and non-redundant. |

**Priority is advisory, not prescriptive.** The ordering appears in the `patterns` array and is available to the caller and the eviction advisory (cl-spec-008), but pattern detection does not enforce an action sequence. A caller who knows their use case may reasonably address erosion before gap (because deduplication is cheap and mechanical while gap remediation requires judgment). Priority provides a default ordering for callers who do not have domain-specific knowledge about their degradation state.

**Priority vs. severity.** Priority and severity are independent axes. A fracture at `critical` is still lower-priority than a collapse at `watch`. Priority reflects the nature of the pattern — what kind of problem it represents. Severity reflects the degree of the problem within that pattern. The caller should generally address higher-priority patterns first, but within the same priority level (which only applies when a single pattern has multiple severity levels over time — each pattern appears at most once in the array), severity determines urgency.

The `highestSeverity` field on the detection result (section 2.3) provides a quick aggregate across all active patterns. If the caller wants a single signal for "how bad is it," `highestSeverity` answers that question. If the caller wants to know "what should I fix first," the `patterns` array order answers that question. These two signals may diverge — a window with fracture at `critical` and saturation at `watch` has `highestSeverity: critical` but the first element in `patterns` is saturation. This is correct: fracture is the most severe problem, but saturation is the most important to address.

**Compound interaction with priority.** When a compound is detected (section 8.2), priority ordering still applies — the patterns are not reordered based on compound context. However, the compound context's `remediationShift` field may suggest a different action order than the priority ordering implies. For the "full of junk" compound (saturation + erosion), the priority order is saturation first, but the remediation shift recommends addressing erosion's hints first because deduplication resolves both. This is not a contradiction: priority says "saturation is the more important problem"; the compound says "but erosion's remedy is the more efficient solution." The caller should read both signals.

**Priority in the detection output.** The `patterns` array is sorted by priority (ascending priority number = first in array). Within the same priority (impossible in practice since each pattern appears at most once), patterns are sorted by severity descending. This means the caller can always take the first element of `patterns` as the highest-priority active pattern, and the `highestSeverity` field as the most severe active pattern — these may or may not be the same pattern.

---

## 9. Detection Configuration

While degradation patterns have sensible defaults, callers may need to tune detection for their use case.

### 9.1 Threshold Overrides

All activation thresholds — per-pattern, per-severity — are overridable. The default values are the ones defined in sections 3–7. Custom thresholds let the caller adapt detection to their tolerance for degradation, the characteristics of their content, and the model they are targeting. A caller using a model with a large effective window may tolerate higher utilization before saturation becomes concerning. A caller with highly heterogeneous content may tolerate lower coherence before fracture is meaningful.

**Configuration surface.** Thresholds are provided as a single `thresholds` object passed at detection framework initialization. The object is optional — when omitted, all defaults apply. When provided, it specifies only the thresholds the caller wants to override; unspecified thresholds retain their defaults.

**Threshold configuration structure:**

```
thresholds: {
    saturation?: {
        watch?:    number,   // default: 0.75  (utilization above this)
        warning?:  number,   // default: 0.85
        critical?: number    // default: 0.95
    },
    erosion?: {
        density?: {
            watch?:    number,   // default: 0.7  (density below this)
            warning?:  number,   // default: 0.5
            critical?: number    // default: 0.3
        },
        utilization?: {
            watch?:    number,   // default: 0.7  (utilization above this)
            warning?:  number,   // default: 0.8
            critical?: number    // default: 0.9
        }
    },
    fracture?: {
        watch?:    number,   // default: 0.6  (coherence below this)
        warning?:  number,   // default: 0.4
        critical?: number    // default: 0.2
    },
    gap?: {
        relevance?: {
            watch?:    number,   // default: 0.6  (relevance below this)
            warning?:  number,   // default: 0.4
            critical?: number    // default: 0.3
        },
        utilization?: {
            warning?:  number,   // default: 0.6  (utilization above this)
            critical?: number    // default: 0.8
        }
        // gap watch has no utilization gate — relevance alone suffices (section 6.3)
    },
    collapse?: {
        watch?:    number,   // default: 0.7  (continuity below this)
        warning?:  number,   // default: 0.5
        critical?: number    // default: 0.3
    }
}
```

**Partial overrides.** The caller can override any subset of thresholds. Overriding `saturation.watch` to 0.80 while leaving `saturation.warning` and `saturation.critical` at their defaults is valid. Overriding `erosion.density` thresholds while leaving `erosion.utilization` thresholds at defaults is valid. Each threshold is independently overridable.

**Validation rules.** Custom thresholds are validated at initialization. Invalid configurations are rejected with a descriptive error — the detection framework does not silently fall back to defaults, because the caller explicitly asked for specific behavior and should know if that behavior cannot be provided.

| Rule | Applies to | Constraint |
|------|-----------|------------|
| **Score-direction severity ordering** | fracture, collapse, gap (relevance), erosion (density) | `watch > warning > critical` — lower scores mean worse quality, so the watch threshold (earliest warning) must be highest. Example: fracture with watch=0.6, warning=0.4, critical=0.2 is valid. watch=0.3, warning=0.4 is rejected because warning is higher than watch, which would mean warning fires before watch. |
| **Utilization-direction severity ordering** | saturation, erosion (utilization), gap (utilization) | `watch < warning < critical` — higher utilization means worse, so the watch threshold must be lowest. Example: saturation with watch=0.75, warning=0.85, critical=0.95 is valid. watch=0.90, warning=0.85 is rejected. |
| **Range bounds** | All thresholds | Score-based thresholds must be in [0.0, 1.0]. Utilization thresholds must be in (0.0, 1.0]. A threshold of 0.0 for a score-based pattern would mean the pattern never activates (no score goes below 0.0). A utilization threshold of 0.0 would mean the pattern always activates. Both are likely configuration errors and are rejected. The one exception: utilization thresholds up to 1.0 are valid — `saturation.critical = 1.0` means saturation only goes critical when the window is completely full, which is a legitimate (if aggressive) configuration. |
| **Minimum separation** | Adjacent severity levels within the same pattern | Adjacent thresholds must differ by at least 0.05. Thresholds closer than 0.05 leave no room for hysteresis and will produce unreliable severity transitions. Example: fracture with watch=0.41, warning=0.40 is rejected because the 0.01 gap is smaller than the hysteresis margin. |

**Threshold override scope.** Overrides apply to absolute threshold evaluation only. They do not affect:

- **Rate-based severity elevation** (section 2.4). The 0.15 general rule and the 0.10 collapse-specific rule are not configurable through threshold overrides. They are fixed because they represent "an unusually large change between reports," which is an absolute concept independent of where the caller sets activation thresholds.
- **Secondary triggers.** The fracture cluster-ratio trigger (section 5.3) and the collapse acute-event trigger (section 7.3) are not threshold-overridable. They are structural elements of those patterns' detection logic, not tunable parameters.
- **Compound conditions.** For erosion and gap, the caller can override both the score threshold and the utilization threshold independently. The compound logic (both gates must be open) is not configurable — it is part of the pattern definition.

**Overrides are session-scoped.** They are set at initialization and do not change during the session. There is no `updateThresholds()` call. Changing thresholds mid-session would invalidate pattern history — a pattern that activated at the old threshold might not satisfy the new threshold, creating an inconsistent state where an active pattern's `thresholdCrossed` field references a threshold that no longer applies. If the caller needs different thresholds, they should create a new detection framework instance.

### 9.2 Pattern Suppression

The caller can disable specific patterns entirely. A suppressed pattern is not computed and does not appear in the detection result — it produces no `ActivePattern` entry, does not participate in compound detection (section 8.2), and does not appear in the priority ordering (section 8.3). Suppression is not the same as setting thresholds to impossible values (e.g., fracture watch at 0.0). Setting impossible thresholds still runs the detection logic and consumes the (negligible) computation. Suppression skips the pattern entirely.

**Why suppress a pattern.** Not every pattern is meaningful for every caller:

| Pattern | Suppression rationale |
|---------|----------------------|
| Gap | The caller does not use task descriptors. Without a task descriptor, relevance scores are uniformly 1.0 (cl-spec-002 section 5.1) and gap detection is meaningless. Gap is **automatically suppressed** when `taskDescriptorSet` is false (section 6.1) — this is structural, not configurable. But the caller can also explicitly suppress gap even when a task descriptor is set, if they manage task relevance through other means and do not want gap alerts. |
| Saturation | The caller manages capacity externally — they have their own utilization monitoring and eviction triggers. Saturation alerts from context-lens would be redundant noise. |
| Erosion | The caller's content model tolerates redundancy by design — for example, a session that intentionally keeps multiple versions of a document for comparison. Erosion alerts would flag this intended behavior as a problem. |
| Fracture | The caller's use case involves intentionally heterogeneous content — for example, a research session that deliberately loads documents from diverse domains. Low coherence is expected and not harmful. |
| Collapse | Rare, but a caller running a short-lived session with aggressive eviction may not want continuity tracking overhead or collapse alerts. |

**Configuration surface.** Suppression is configured via a `suppressedPatterns` array passed at detection framework initialization:

```
suppressedPatterns?: PatternName[]   // e.g., ["gap", "saturation"]
```

An empty array (or omission) means no patterns are suppressed. The array accepts any combination of the five pattern names. Suppressing all five patterns is technically valid — the detection result will have `patterns: [], patternCount: 0, highestSeverity: null`. This is a degenerate configuration but not an error — the caller explicitly asked for no detection.

**Suppression vs. gap auto-suppression.** Gap has two suppression paths:

1. **Structural auto-suppression.** When `taskDescriptorSet` is false, gap is suppressed automatically. This happens even if the caller did not include `"gap"` in the `suppress` array. The caller cannot override this — gap detection without a task descriptor is meaningless by definition.

2. **Explicit suppression.** When the caller includes `"gap"` in the `suppress` array, gap is suppressed even if a task descriptor is set. This is the caller saying "I have a task descriptor but I don't want gap alerts."

If both apply (no task descriptor and explicit suppression), the effect is the same — gap is not computed. There is no conflict.

**Suppression is session-scoped.** Like threshold overrides (section 9.1), suppression is set at initialization and does not change during the session. There is no `suppressPattern()` or `unsuppressPattern()` call. The detection framework's pattern set is fixed for the session.

**Suppression and compound detection.** When a pattern is suppressed, compounds that include it cannot activate. If saturation is suppressed, the "full of junk" compound (saturation + erosion) cannot fire — even if erosion is active and utilization is high. The remaining active pattern (erosion) is still detected and reported normally; it simply does not receive compound context for compounds that require the suppressed pattern. This is the correct behavior: if the caller suppressed saturation, they do not want capacity-related diagnostics, and compound diagnoses that reference capacity pressure would be inconsistent with that intent.

**Suppression and pattern history.** Suppressed patterns do not generate history entries (section 2.5). If a pattern was active, then suppressed mid-session (which requires reinitializing the detection framework), the previous activation's history is lost. This is acceptable because session-scoped reinitialization is a fresh start — the new instance has no knowledge of the previous instance's state.

Suppression accepts custom pattern names in addition to the five base pattern names. Suppressing a custom pattern name before that pattern is registered is valid — the suppression takes effect if and when the pattern is later registered via `registerPattern`. Validation of custom pattern names occurs at detection time, not at configuration time.

### 9.3 Hysteresis

Hysteresis prevents pattern flicker — the rapid oscillation between active and inactive when scores hover near a threshold. Without hysteresis, a coherence score that fluctuates between 0.39 and 0.41 would cause fracture to activate and deactivate every other report, producing a stream of alerts that obscure rather than inform.

**The mechanism.** Hysteresis introduces an asymmetry between activation and deactivation. Activation occurs when the score crosses the threshold in the degraded direction. Deactivation requires the score to recover past the threshold by a margin — it must not just return to the threshold, but move beyond it by enough to indicate genuine recovery.

**For score-based patterns** (fracture, collapse, gap relevance, erosion density) — where lower scores mean worse quality:

```
Activation:   score < threshold
Deactivation: score > threshold + hysteresisMargin
```

**For utilization-based patterns** (saturation, erosion utilization, gap utilization) — where higher values mean worse:

```
Activation:   utilization > threshold
Deactivation: utilization < threshold - hysteresisMargin
```

**Example.** Fracture activates at coherence < 0.4 (warning). With a hysteresis margin of 0.03, it does not deactivate until coherence recovers above 0.43. The 0.03 gap is the dead zone — scores in [0.40, 0.43] leave the pattern in whatever state it was already in:

```
coherence: 0.45  →  fracture: inactive
coherence: 0.38  →  fracture: active (warning)     — crossed below 0.40
coherence: 0.41  →  fracture: active (warning)     — above 0.40 but below 0.43
coherence: 0.39  →  fracture: active (warning)     — still below threshold
coherence: 0.44  →  fracture: inactive              — crossed above 0.43
```

**Default hysteresis margin: 0.03.** This value is a balance between stability and responsiveness. A margin of 0.01 would provide almost no flicker protection. A margin of 0.10 would make patterns sticky — once activated, they would require substantial recovery to deactivate, potentially masking genuine improvement. The 0.03 default means a pattern requires approximately a 3-percentage-point recovery beyond the threshold to clear, which is small enough to respond to real improvement but large enough to absorb normal score noise.

**Hysteresis on severity transitions.** The same mechanism applies to severity escalation and de-escalation within an active pattern. Escalation (watch → warning → critical) occurs immediately when the score crosses the next severity threshold — there is no hysteresis delay for worsening conditions. De-escalation (critical → warning → watch → inactive) requires the score to recover past the threshold by the hysteresis margin. This asymmetry is intentional: worsening should be reported immediately, but improvement should be confirmed before the alert is downgraded.

```
Escalation:     score crosses threshold → immediate
De-escalation:  score recovers past threshold + margin → delayed
```

**Example with severity transitions.** Fracture thresholds: watch < 0.6, warning < 0.4, critical < 0.2. Margin: 0.03.

```
coherence: 0.55  →  fracture: watch
coherence: 0.38  →  fracture: warning              — crossed below 0.40 (immediate)
coherence: 0.42  →  fracture: warning              — above 0.40 but below 0.43
coherence: 0.44  →  fracture: watch                — crossed above 0.43 (de-escalated)
coherence: 0.62  →  fracture: watch                — above 0.60 but below 0.63
coherence: 0.64  →  fracture: inactive              — crossed above 0.63 (deactivated)
```

**Hysteresis for compound patterns.** Compound patterns (erosion, gap at warning/critical) use hysteresis on each gate independently (sections 4.3, 6.3). Activation requires both gates open. Deactivation occurs when either gate closes with hysteresis. The hysteresis margin is applied to each gate's threshold separately — there is no combined margin for the compound condition.

**Configurable margin.** The hysteresis margin is overridable at initialization:

```
hysteresis?: {
    margin?: number    // default: 0.03, valid range: [0.01, 0.10]
}
```

The margin applies uniformly to all patterns and all severity transitions. There is no per-pattern or per-severity margin — a single margin keeps the behavior predictable and avoids a combinatorial configuration surface. The valid range is [0.01, 0.10]. Values below 0.01 provide negligible flicker protection. Values above 0.10 make patterns excessively sticky — they would require a 10-percentage-point recovery to deactivate, which in practice means most patterns would never deactivate once triggered.

**Validation.** The margin is validated against the minimum separation between adjacent thresholds (section 9.1). The margin must be strictly less than the smallest gap between adjacent severity thresholds across all non-suppressed patterns. If the caller sets fracture thresholds at watch=0.50, warning=0.45 (gap of 0.05) and a margin of 0.05, the de-escalation threshold for warning would be 0.45 + 0.05 = 0.50, which equals the watch activation threshold. This creates an ambiguous state where the pattern simultaneously satisfies watch activation and warning de-escalation. The validation rejects this — the margin must be less than 0.05 in this case.

**Hysteresis state.** Hysteresis requires the detection framework to remember whether each pattern is currently active and at what severity. This state is maintained in the pattern tracking state (section 2.5) and is the reason pattern detection is not purely functional — it depends on the previous detection result to determine whether a threshold crossing represents activation, deactivation, or neither (in the dead zone). This is the sole piece of mutable state in the detection framework beyond the pattern history itself.

---

## 10. Custom Pattern Registration

The five base patterns (saturation, erosion, fracture, gap, collapse) cover the common failure modes of context window management. But callers in specialized domains encounter failure modes that no general-purpose library can anticipate. A RAG framework detects when retrieved context drifts from the retrieval query. A coding assistant detects when reference documentation becomes stale relative to the code under discussion. A multi-turn agent detects when instruction segments conflict with each other.

Custom pattern registration lets callers define domain-specific degradation patterns that plug into the existing detection framework. Custom patterns run alongside base patterns with the same severity model, the same hysteresis mechanics, the same reporting structure, and the same diagnostic output. From the perspective of the quality report consumer, a custom pattern is indistinguishable from a base pattern — it appears in the same `patterns` array, with the same `ActivePattern` shape, the same severity levels, and the same remediation hints.

### 10.1 Resolution of OQ-009: Full QualityReport

**Decision:** Custom pattern `detect` functions receive the **full QualityReport**.

The alternative — a simplified view exposing only the four dimension scores, utilization, and trend — was considered and rejected:

- **Power.** Custom patterns that need per-segment scores (e.g., "flag when more than N segments share the same origin and all have relevance below 0.3") cannot work with a simplified view. The simplified view would limit custom patterns to window-level threshold logic, which is exactly what base patterns already cover — there would be little reason to register a custom pattern if it could only do what the base patterns do.
- **Stability.** The QualityReport is a public API output (cl-spec-007 section 6.1), now schema'd with versioning (cl-spec-011). It is as stable as any public interface — more so than a bespoke simplified view that would need its own definition and its own versioning.
- **Simplicity.** No new type to define. Custom patterns receive what `assess()` returns. The caller already knows this type.

Custom patterns that only need dimension scores can read `report.windowScores` — they are not forced to traverse the full report. The full report is the *ceiling*, not the *floor*, of what custom patterns can inspect.

When the segment count exceeds the sampling threshold (cl-spec-009 section 5), the quality report contains scores computed from sampled similarity data. Custom pattern detection logic should be designed to tolerate score approximation.

### 10.2 The PatternDefinition Contract

A custom pattern is defined by a `PatternDefinition` object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **yes** | Unique pattern identifier. Must not collide with base pattern names or other registered custom pattern names. Validated at registration time. |
| `description` | string | **yes** | Human-readable description of what this pattern detects. For documentation and diagnostics. |
| `detect` | `(report: QualityReport) → PatternSignal \| null` | **yes** | The detection function. Returns a `PatternSignal` if the pattern condition is met, or `null` if not. Called on every `assess()`. |
| `severity` | `(report: QualityReport, previous: Severity \| null) → Severity` | **yes** | Determines the severity level. `previous` is the current severity if the pattern is already active, or `null` if this is a new activation. Returns the severity for this detection cycle. |
| `explanation` | `(report: QualityReport) → string` | **yes** | Generates the human-readable diagnostic explanation. Called only when the pattern is active. |
| `remediation` | `(report: QualityReport) → RemediationHint[]` | **yes** | Generates remediation suggestions. Called only when the pattern is active. Returns hints in priority order (highest impact first). |
| `strategyHint` | StrategyHint | no | Optional eviction strategy mapping. If provided, the eviction advisory (cl-spec-008) uses this hint when this custom pattern is the active driver of strategy selection. See section 10.7. |
| `priority` | number | no | Ordering relative to other patterns. Default: 1000 (after all base patterns, which use priorities 1–5). Lower numbers = higher priority. Custom patterns with the same priority are ordered by registration order. |

**PatternSignal:**

| Field | Type | Description |
|-------|------|-------------|
| `primaryScore` | `{ dimension: string, value: number }` | The primary score that triggered detection. |
| `secondaryScores` | `{ dimension: string, value: number }[]` | Additional contributing scores. |
| `utilization` | number or null | Utilization if relevant to this pattern. |

The `PatternSignal` is the same structure as the `PatternSignature.primaryScore`, `PatternSignature.secondaryScores`, and `PatternSignature.utilization` fields on the `ActivePattern` output (section 2.3). The detection framework constructs the full `PatternSignature` by combining the signal with the severity threshold information.

**StrategyHint:**

A string enum with four values that map to the existing strategy-adjusted weight sets in cl-spec-008:

| Value | Maps to | Use when |
|-------|---------|----------|
| `"token-focused"` | Saturation strategy weights | Custom pattern detects a capacity-related issue. |
| `"redundancy-focused"` | Erosion strategy weights | Custom pattern detects a redundancy-related issue. |
| `"relevance-focused"` | Gap strategy weights | Custom pattern detects a relevance-related issue. |
| `"coherence-preserving"` | Collapse strategy weights | Custom pattern detects a continuity or coherence issue. |

If no `strategyHint` is provided, the eviction advisory uses default (unbiased) weights when this pattern drives strategy selection.

### 10.3 Validation

Validation runs at registration time — before the pattern is added to the detection framework. A pattern that fails validation is rejected; the framework state is unchanged.

**Name rules:**

- Must be a non-empty string.
- Must not be one of the five base pattern names: `saturation`, `erosion`, `fracture`, `gap`, `collapse`.
- Must not collide with any already-registered custom pattern name. Name comparison is exact (case-sensitive).
- Should follow the pattern `lowercase-kebab-case` for consistency with base pattern conventions. This is a recommendation, not a requirement — the framework accepts any non-empty string.

**Function rules:**

- `detect`, `severity`, `explanation`, and `remediation` must be functions. The framework validates their type at registration time — it does not validate their behavior (the framework cannot know what a correct detection function looks like for a domain-specific pattern).
- `detect` must be callable with a single argument (the QualityReport). The framework calls it with a defensive copy of the report — the custom function cannot mutate the report.
- `severity` must return a valid Severity value (`watch`, `warning`, or `critical`). If it returns an invalid value, the framework treats this detection cycle as if `detect` returned `null` — the pattern does not activate or remains at its previous severity. A warning is emitted to the diagnostic warning list.
- `explanation` must return a string. If it throws, the framework uses a generic fallback: `"Custom pattern '{name}' is active at {severity}"`.
- `remediation` must return an array of RemediationHint objects. If it throws, the framework uses an empty array.

**Priority rules:**

- Must be a positive integer if provided. Default: 1000.
- No uniqueness constraint — multiple custom patterns may share the same priority. Ties are broken by registration order.
- Custom patterns with priority < 6 are technically valid but would sort before base patterns, which may be surprising. The framework accepts this — the caller is responsible for understanding the implications.

**strategyHint rules:**

- Must be one of the four StrategyHint values if provided. Invalid values are rejected at registration.

### 10.4 Registration Lifecycle

Custom patterns can be registered in two ways:

**At construction time.** The `ContextLensConfig` (cl-spec-007 section 2.2) accepts a `customPatterns` field:

```
customPatterns?: PatternDefinition[]
```

Patterns provided at construction are validated and registered before the instance is usable. If any pattern fails validation, the constructor throws a `ConfigurationError`. All-or-nothing — either all patterns are registered or none are.

**At runtime.** The `registerPattern` method (cl-spec-007 amendment) adds a pattern to a running instance:

```
registerPattern(definition: PatternDefinition) → void
```

The pattern is validated and registered immediately. It participates in the next `assess()` call. There is no retroactive detection — the pattern is not run against previous reports.

**Registration is append-only in v1.** There is no `unregisterPattern` or `removePattern`. Once registered, a custom pattern remains active for the session. The caller can suppress it via the suppression mechanism (section 9.2, extended to accept custom pattern names), but suppression skips detection — it does not remove the registration. This simplification avoids the complexity of pattern history cleanup, mid-session state invalidation, and the question of what happens to active alerts when a pattern is deregistered.

**Registration order determines tie-breaking.** When multiple custom patterns have the same `priority`, they appear in the `patterns` array in the order they were registered. Construction-time patterns are registered before runtime patterns, in the order they appear in the `customPatterns` array.

### 10.5 Detection Integration

Custom patterns participate in the same detection pass as base patterns. During `assess()`:

1. The quality model computes scores and assembles the QualityReport (the quality model (cl-spec-002)).
2. Base pattern detection runs on the report (section 2 of this spec).
3. Custom pattern detection runs on the same report, in registration order.
4. Results from base and custom patterns are merged into the `DetectionResult`.

**Step 3 in detail:**

For each registered, non-suppressed custom pattern:

1. Call `pattern.detect(report)`. If it returns `null`, the pattern is not firing. Check hysteresis for deactivation (section 10.6).
2. If it returns a `PatternSignal`:
   a. Call `pattern.severity(report, previousSeverity)` to determine the severity.
   b. Apply hysteresis (section 10.6) to determine whether this is an activation, escalation, de-escalation, or no change.
   c. If the pattern is active after hysteresis: call `pattern.explanation(report)` and `pattern.remediation(report)`.
   d. Construct the `ActivePattern` entry with the same shape as base patterns.
3. Update pattern tracking state (section 2.5) and pattern history.

**Error handling.** If `detect` throws, the framework catches the error, emits a warning to the diagnostic warning list (`"Custom pattern '{name}' detect() threw: {error.message}"`), and treats this cycle as if `detect` returned `null`. The pattern's hysteresis state is unchanged — a throwing `detect` does not activate or deactivate the pattern. This fail-open behavior prevents a buggy custom pattern from breaking the entire detection framework.

If `severity` returns an invalid value, the framework treats the cycle as `null` (same as `detect` throwing). If `explanation` or `remediation` throw, fallbacks are used (section 10.3).

For `severity`, `explanation`, and `remediation` function failures, see §10.3 fallback behavior.

**Performance contract.** Custom `detect`, `severity`, `explanation`, and `remediation` functions are called within the `assess()` budget (cl-spec-009 section 3.3). The framework does not enforce a per-function time limit — it trusts the caller to provide fast functions. A custom `detect` that calls an external API or performs expensive computation will blow the assessment budget. This is the caller's responsibility. The performance measurement infrastructure (cl-spec-009 section 8) reports total assessment time including custom pattern overhead, so budget violations caused by slow custom patterns are visible in diagnostics.

### 10.6 Hysteresis and State Management

The framework wraps custom patterns with the same hysteresis mechanics used for base patterns (section 9.3). The custom pattern's `detect` function determines whether the pattern condition is met; the framework determines whether the pattern activates, deactivates, or remains unchanged based on hysteresis state.

**Activation hysteresis.** The custom pattern does not need to implement hysteresis. The framework tracks the pattern's active/inactive state and severity. When `detect` returns a signal:

- If the pattern was inactive: activate at the severity returned by `severity()`.
- If the pattern was active and `severity()` returns a higher severity: escalate immediately.
- If the pattern was active and `severity()` returns a lower severity: de-escalate only if the pattern has been at the higher severity for at least one report cycle and the severity returned is consistent across the current and previous cycle (same hysteresis margin logic as base patterns, applied to the severity transitions rather than raw scores).

When `detect` returns `null`:

- If the pattern was inactive: no change.
- If the pattern was active: check whether the pattern has been returning `null` for enough cycles to clear hysteresis. The framework tracks how many consecutive `null` returns have occurred. The pattern deactivates after 1 consecutive `null` return **plus** the hysteresis delay — effectively, the pattern must return `null` on two consecutive `assess()` calls to deactivate. This is the temporal equivalent of the score-based hysteresis margin: one cycle of `null` could be a fluctuation, two consecutive `null` cycles indicates genuine resolution.

**Why two-cycle deactivation, not score-margin hysteresis:** Base patterns have a numeric score that can be compared against a threshold + margin. Custom patterns have a boolean signal (`PatternSignal` or `null`) — there is no numeric margin to apply. The two-cycle rule provides equivalent flicker protection using the only signal available: consecutive non-detection.

**State tracking.** Each custom pattern has the same per-pattern tracking state as base patterns (section 2.5): `activatedAt`, `currentSeverity`, `severitySince`, `peakSeverity`, `peakAt`, `resolvedAt`, `reportCount`, `scoreHistory`. The `scoreHistory` records the `primaryScore.value` from the `PatternSignal` at each detection cycle where the pattern was active.

### 10.7 Interaction with Base Patterns

Custom patterns and base patterns coexist in the detection result:

**Priority ordering.** The `patterns` array (section 2.3) is sorted by priority across both base and custom patterns. Base patterns use priorities 1–5 (collapse=1, saturation=2, gap=3, erosion=4, fracture=5). Custom patterns default to priority 1000 (after all base patterns). A custom pattern can override its priority to sort among or before base patterns.

**`highestSeverity`.** Reflects the highest severity across all active patterns — base and custom. A custom pattern at `critical` raises `highestSeverity` to `critical` even if all base patterns are at `watch`.

**`patternCount`.** Counts all active patterns — base and custom.

**Eviction strategy.** When the eviction advisory (cl-spec-008) selects a strategy via auto-selection (cl-spec-008 section 5.3):

1. Compound patterns are checked first (base patterns only — see section 10.8).
2. If no compound applies, patterns are considered in priority order.
3. For a base pattern, the strategy is the pattern's defined strategy (saturation → saturation strategy, etc.).
4. For a custom pattern, the strategy is determined by `strategyHint`:
   - If `strategyHint` is provided, the hint maps to a strategy (section 10.2, StrategyHint table).
   - If no `strategyHint`, the default strategy is used (unbiased weights).

**Pattern names in output.** Custom pattern names appear in all the same positions as base pattern names: the `ActivePattern.name` field, the `PatternHistoryEntry.name` field, the `EvictionPlan.patterns` array, the `TimelineEntry.detail.name` for `patternActivated`/`patternResolved` events. Consumers should not assume that pattern names come from a closed set — the `PatternName` enum in cl-spec-011 section 7.2 covers base patterns; custom names are open-vocabulary strings.

### 10.8 Limitations (v1)

The following limitations apply to custom patterns in the initial implementation. They may be relaxed in future versions.

**No compound detection.** Custom patterns do not participate in compound pattern detection (section 8). The six named compounds (fullOfJunk, fullOfWrongThings, etc.) are defined exclusively in terms of base patterns. A custom pattern that co-occurs with a base pattern does not produce a compound diagnosis or compound context. Future versions may allow custom compound definitions.

**No threshold overrides.** Custom patterns manage their own thresholds internally — through their `detect` and `severity` functions. The per-pattern threshold override mechanism (section 9.1) applies only to base patterns. Custom patterns that need configurable thresholds should accept configuration through their closure or constructor, not through the detection framework's threshold API.

**No dynamic priority.** Custom pattern priority is immutable once registered. If a custom pattern is registered with the wrong priority, the only recourse is to create a new ContextLens instance with corrected custom pattern definitions.

**No mutual awareness.** Custom patterns cannot access the detection result of other patterns (base or custom). The `detect` function receives the QualityReport, which contains the previous cycle's `DetectionResult` (via the `patterns` field). This means a custom pattern can read *last report's* pattern state but not *this cycle's* base pattern results. This one-cycle lag prevents detection order from affecting results — if custom patterns could read base pattern results from the same cycle, the detection result would depend on whether base patterns ran before or after custom patterns.

**No content access.** Like base patterns, custom patterns receive the QualityReport, not raw segment content. The report includes per-segment scores, token counts, and metadata — but not the content strings. This is a design constraint, not a limitation: patterns that need content analysis should be implemented as scoring extensions (computing custom per-segment scores that are then consumed by the custom pattern's `detect` function), not as patterns that directly inspect content.

---

## 11. Invariants and Constraints

The following invariants hold for the pattern detection framework. They are not aspirational — they are constraints that the implementation must enforce. Violations indicate bugs, not edge cases.

**Invariant 1: Deterministic detection.** Given the same quality report, the same pattern history state, *and the same custom pattern set in the same registration order*, pattern detection produces the same result. There is no randomness, no sampling, and no dependence on wall-clock time (timestamps come from the quality report, not from `Date.now()`). Two calls to detection with identical inputs produce identical outputs. This guarantee enables testing, replay, and debugging — a bug report that includes the quality report and pattern history is sufficient to reproduce any detection result.

*Caveat:* Determinism is with respect to a fixed detection state. Two consecutive calls with the same quality report but different pattern history (because the first call updated the history) may produce different results. This is expected — hysteresis depends on history. The invariant is: same inputs, same outputs. Pattern history is an input.

**Invariant 2: Side-effect free detection.** Pattern detection does not modify segments, scores, quality reports, or any state outside the detection framework's own pattern history. It is a read-only consumer of quality data. The quality report that enters detection is the same quality report that exits — detection appends pattern results to it but does not alter any existing field. This invariant is what makes detection safe to run on every quality report without concern for side effects on the window or quality model.

*One exception:* Detection updates its own pattern history (section 2.5) — activating new patterns, updating severity, closing resolved patterns. This is internal bookkeeping, not a side effect on external state. The pattern history is owned exclusively by the detection framework.

**Invariant 3: Severity ordering.** A pattern reported at `warning` implies that the `watch` condition is also met. A pattern reported at `critical` implies both `warning` and `watch` are met. Detection evaluates from `critical` down to `watch` and reports only the highest met level (section 2.4), but the lower levels are logically satisfied. This invariant follows from the monotonic threshold ordering enforced in section 9.1 — if the critical threshold is the most extreme and the score has passed it, it has necessarily passed the less extreme watch and warning thresholds.

*Consequence:* A caller who filters on severity `warning` will see all patterns at `warning` or `critical`. There is no state where a pattern is at `critical` but `warning` is not implied.

**Invariant 4: Saturation is quality-independent.** Saturation activates on capacity metrics only — utilization from the tokenization subsystem (cl-spec-006). It does not read coherence, density, relevance, or continuity. A window with perfect quality scores and high utilization is still saturated. A window with terrible quality scores and low utilization is not. This separation ensures saturation cannot be masked by high quality and cannot be triggered by low quality. It is the only pattern with this property.

**Invariant 5: Gap requires a task descriptor.** When `taskDescriptorSet` is false, gap is not computed. It does not appear in the `patterns` array, does not contribute to `highestSeverity`, and does not participate in compound detection. This is a structural requirement (section 6.1), not a configurable suppression (section 9.2). The caller cannot override it — gap detection without a task descriptor is undefined because relevance scores are uniformly 1.0 and carry no diagnostic signal.

**Invariant 6: Collapse threshold alignment.** The collapse thresholds (watch < 0.7, warning < 0.5, critical < 0.3) align with the continuity score semantics defined in cl-spec-002 section 6.7. Specifically, the `critical` threshold of 0.3 corresponds to the quality model's characterization of a window that has "lost most of its original information." Custom threshold overrides (section 9.1) may shift these values, but the default alignment ensures that collapse severity levels carry the same semantic meaning as the continuity score ranges they reference.

**Invariant 7: Timestamp monotonicity.** Pattern activation timestamps (`activatedAt`, `currentSince`) are derived from quality report timestamps, not from system clocks. If quality report A has timestamp T1 and quality report B has timestamp T2 where T2 > T1, then any pattern activated in response to report B has `activatedAt` ≥ T1. A pattern cannot activate "in the past" relative to a report that preceded it. Similarly, `resolvedAt` for a pattern resolved in report B satisfies `resolvedAt` ≥ `activatedAt`. This monotonicity prevents temporal paradoxes in the pattern history — a pattern's lifecycle is a forward-only timeline.

**Invariant 8: Symmetric hysteresis margin.** The hysteresis margin (section 9.3) is the same value for activation and deactivation of any given threshold. If fracture activates when coherence crosses below 0.4, and the margin is 0.03, then fracture deactivates when coherence crosses above 0.43. The margin is 0.03 in both directions. There is no asymmetric margin where activation uses one value and deactivation uses another. The asymmetry in hysteresis is directional (activation is immediate, deactivation is delayed), not in the margin value itself.

*Note:* "Symmetric" refers to the margin magnitude, not the behavior. Escalation is still immediate while de-escalation is delayed (section 9.3). The invariant guarantees that the dead zone has the same width regardless of which direction the score is moving.

**Invariant 9: Suppression is total.** A suppressed pattern (section 9.2) produces no output of any kind. It is not computed and then hidden — it is not computed at all. No `ActivePattern` entry, no history entry, no compound participation, no contribution to `highestSeverity` or `patternCount`. The caller cannot detect whether a pattern was suppressed by inspecting the detection result — a suppressed pattern is indistinguishable from a pattern that was never defined. This is intentional: suppression means "this pattern does not exist for this session."

**Invariant 10: Detection is in-budget.** Pattern detection completes within the same performance budget as quality score computation. It adds negligible overhead to quality report generation — threshold comparisons, array scans of active patterns, and history updates. Detection does not compute similarity, does not iterate over segment content, does not call external services, and does not perform any operation whose cost scales with segment count beyond a linear scan of the quality report's pre-computed per-segment scores. The quality model does the expensive work; detection is a thin classification layer on top.

*Caveat for custom patterns:* The budget invariant applies to the detection framework's own overhead, not to custom pattern `detect` functions. A custom `detect` that performs expensive computation may cause the overall `assess()` call to exceed its budget. The framework reports this as a budget violation in diagnostics (cl-spec-009 section 8) but does not prevent it. The caller is responsible for ensuring their custom pattern functions are fast.

### Custom Pattern Invariants

The following additional invariants apply to custom pattern registration and detection.

**Invariant 11: Name uniqueness.** No two patterns (base or custom) share the same name. This is enforced at registration time. A `registerPattern` call with a name that collides with any existing pattern (base or custom) is rejected with a `ValidationError`. The five base names are permanently reserved.

**Invariant 12: Registration is permanent (v1).** Once registered, a custom pattern cannot be removed from the detection framework. It can be suppressed (section 9.2) but not unregistered. This avoids the complexity of mid-session pattern removal: history cleanup, state invalidation, and the question of what happens to active alerts when their pattern ceases to exist.

**Invariant 13: Uniform output shape.** A custom pattern produces the same `ActivePattern` structure as a base pattern (section 2.3). Consumers of the detection result do not need separate handling for custom vs. base patterns — the same fields are present, with the same types and semantics. The only difference is the `name` field, which is an open-vocabulary string for custom patterns rather than a closed enum for base patterns.

**Invariant 14: Fail-open detection.** If a custom pattern's `detect`, `severity`, `explanation`, or `remediation` function throws, the detection framework catches the error, emits a diagnostic warning, and continues. The throwing pattern does not activate (or remains at its previous state if already active). Other patterns — base and custom — are unaffected. A buggy custom pattern cannot break base pattern detection.

**Invariant 15: Defensive report.** Custom pattern functions receive a defensive copy of the QualityReport. Mutations to the report object within `detect`, `severity`, `explanation`, or `remediation` do not affect the actual report or the inputs to other patterns. Each custom pattern sees the same report regardless of what other custom patterns did with their copy.

**Invariant 16: No compound participation (v1).** Custom patterns do not participate in compound pattern detection (section 8). The six named compounds are defined exclusively in terms of base patterns. Custom patterns receive no `compoundContext` annotation.

---

## 12. References

| Reference | Description |
|-----------|-------------|
| `brainstorm_20260324_context-lens.md` | Origin brainstorm — first enumeration of the five degradation patterns and their detection heuristics |
| `cl-spec-001` (Segment Model) | Defines segments, groups, and protection tiers that constrain eviction-related pattern remediation |
| `cl-spec-002` (Quality Model) | Produces the four dimension scores and quality reports that pattern detection consumes. Defines score semantics, baseline normalization, and the threshold guidelines patterns refine |
| `cl-spec-006` (Tokenization Strategy) | Provides capacity metrics (utilization, headroom) consumed by the saturation pattern |
| `cl-spec-007` (API Surface) | Exposes `registerPattern()` and `customPatterns` config. Defines the public registration API |
| `cl-spec-008` (Eviction Advisory) | Consumes pattern detection output to inform eviction strategy. Custom patterns provide `strategyHint` for strategy selection |
| `cl-spec-010` (Report & Diagnostics) | Surfaces pattern detection results in diagnostic output. Custom patterns appear in pattern history and timeline |
| `cl-spec-011` (Report Schema) | Schemas the output types that custom patterns produce and consume. Custom pattern names extend the PatternName vocabulary |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.6*
