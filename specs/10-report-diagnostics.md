---
id: cl-spec-010
title: Report & Diagnostics
type: design
status: draft
created: 2026-04-04
revised: 2026-04-04
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [report, diagnostics, history, timeline, trends, performance, formatting, observability, json, custom-patterns]
depends_on: [cl-spec-003, cl-spec-007, cl-spec-008]
---

# Report & Diagnostics

## Table of Contents

1. Overview
2. Diagnostic Snapshot
3. Report History and Trends
4. Pattern History
5. Session Timeline
6. Performance Diagnostics
7. Provider Diagnostics
8. Formatting
9. Invariants and Constraints
10. References

---

## 1. Overview

The quality model (cl-spec-002) produces scores. The degradation framework (cl-spec-003) produces pattern alerts. The eviction advisory (cl-spec-008) produces eviction plans. The performance budget (cl-spec-009) produces timing records. Each of these systems generates output that the caller needs to observe, and each defines its output in its own spec. But the caller does not consume these systems independently — they consume them together, in context, over time. A coherence score of 0.6 means nothing without knowing whether it was 0.8 last report and what pattern just fired. An eviction plan is hard to evaluate without seeing the quality trend that triggered it. A timing record is noise without cache hit rate context.

This spec defines the **diagnostic layer** — the system that collects, retains, correlates, and surfaces the full operational state of a context-lens instance. It is the observability surface: everything the caller needs to understand what context-lens is doing, why, and how well.

### What this spec defines

- **The diagnostic snapshot** (section 2) — a single method (`getDiagnostics`) that returns the complete diagnostic state of the instance. The snapshot includes the most recent quality report, report history, pattern history, a session timeline, performance metrics, and provider state.
- **Report history and trends** (section 3) — how quality reports are retained across the session and how rolling trends are computed from them. cl-spec-002 defines per-report trends (one report back); this spec defines session-level trends (rolling windows, rate-of-change, anomaly detection).
- **Pattern history** (section 4) — how pattern activations, escalations, and resolutions are tracked across the session. cl-spec-003 section 2.5 defines the pattern history entry; this spec defines how the history is surfaced, summarized, and analyzed.
- **Session timeline** (section 5) — a unified chronological log of every significant event in the instance's lifecycle: mutations, task changes, pattern state transitions, quality movements, eviction events. The timeline is the "activity log" of the instance.
- **Performance diagnostics** (section 6) — aggregated timing records from cl-spec-009, cache metrics from cl-spec-005 and cl-spec-006, and budget violation summaries. This is the performance observability surface.
- **Provider diagnostics** (section 7) — current tokenizer and embedding provider metadata, accuracy classification, switch history, and warnings.
- **Formatting** (section 8) — human-readable summary generation for quality reports, diagnostic snapshots, and pattern alerts. Structured data for programmatic consumers, formatted strings for humans.

### What diagnostics is not

Diagnostics is not a monitoring dashboard. It does not render charts, update in real time, or maintain persistent state across sessions. It produces data structures that a dashboard could consume — but the presentation layer is the caller's responsibility.

Diagnostics is not a remediation system. It tells the caller what happened and why, but does not fix anything. Patterns suggest remediation (cl-spec-003); the eviction advisory proposes concrete plans (cl-spec-008). Diagnostics surfaces both, but adds no remediation logic of its own.

Diagnostics is not persistent. All diagnostic state — report history, pattern history, timeline, performance metrics — lives in memory for the session duration. There is no serialization, no disk persistence, no cross-session state. The caller who needs historical analysis across sessions must export and store diagnostic snapshots themselves.

### Design goals

- **Single-call observability.** `getDiagnostics()` returns everything. The caller does not need to call five methods and correlate the results — one call, one snapshot, complete state.
- **Read-only.** `getDiagnostics()` does not trigger computation, invalidate caches, or mutate state. It reads existing state and assembles it. The diagnostic snapshot is an observation, not an action.
- **Cheap.** Diagnostic state is maintained incrementally as events occur. `getDiagnostics()` assembles the snapshot from pre-computed state — it does not recompute trends, re-analyze patterns, or regenerate reports. Budget: Tier 1 (< 1 ms).
- **Correlated.** Every piece of diagnostic data is timestamped and can be aligned with every other piece. A pattern activation can be traced to the quality report that triggered it, the mutation that caused the score drop, and the task change that preceded it. The timeline (section 5) is the correlation backbone.
- **Progressive.** Callers who just want the quality report call `assess()`. Callers who want the full diagnostic picture call `getDiagnostics()`. The diagnostic snapshot includes the latest report as a field — callers never need to call both.

---

## 2. Diagnostic Snapshot

### 2.1 The getDiagnostics Method

```
getDiagnostics() -> DiagnosticSnapshot
```

Returns the complete diagnostic state of the context-lens instance at the moment of the call. The snapshot is assembled from pre-maintained state — no quality scoring, no pattern detection, no provider calls. This is a Tier 1 operation (cl-spec-009 section 3.1): < 1 ms regardless of window size.

`getDiagnostics()` does **not** trigger a new quality report. It includes the most recent report generated by `assess()`, or null if `assess()` has not been called. If the caller wants fresh scores in the diagnostic snapshot, they call `assess()` first. This separation keeps diagnostics cheap and predictable — it is an observation tool, not a computation trigger.

### 2.2 DiagnosticSnapshot Structure

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | string | Schema version for this output (cl-spec-011 section 2) |
| `timestamp` | number | When this snapshot was assembled |
| `sessionDuration` | number | Milliseconds since instance construction |
| `latestReport` | QualityReport or null | Most recent quality report from `assess()`. Null if `assess()` has not been called. Structure defined in cl-spec-002 section 9 and cl-spec-007 section 6. |
| `reportHistory` | ReportHistorySummary | Report retention and rolling trend analysis (section 3) |
| `patternSummary` | PatternSummary | Session-level pattern tracking (section 4) |
| `timeline` | TimelineEntry[] | Chronological event log, most recent last (section 5) |
| `performance` | PerformanceSummary | Timing aggregation and cache metrics (section 6) |
| `providers` | ProviderSummary | Tokenizer and embedding provider state (section 7) |
| `segmentCount` | number | Current active segment count |
| `groupCount` | number | Current group count |
| `evictedCount` | number | Current evicted (but retained) segment count |
| `taskState` | TaskState | Current task state (cl-spec-004 section 4.4) |
| `continuityLedger` | ContinuityEvent[] | Full continuity audit trail (cl-spec-002 section 6) |
| `warnings` | Warning[] | Active warnings (provider mismatch, pinned ceiling, late seeding, etc.) |

**Why the full continuity ledger?** cl-spec-002 section 9.5 defines a `ContinuitySummary` on the quality report — aggregates (total evictions, tokens evicted, net loss) plus the 10 most recent events. The diagnostic snapshot provides the **full ledger** for callers who need the complete audit trail: forensic analysis of every eviction, compaction, and restoration in the session. The summary is for quick consumption; the ledger is for deep inspection.

### 2.3 Warning Accumulation

Warnings are advisory messages generated by various subsystems throughout the session. They are not errors (they do not interrupt operations) and not patterns (they do not have severity levels or threshold logic). They are operational advisories — things the caller should be aware of.

| Warning source | Trigger | Message |
|---------------|---------|---------|
| Provider mismatch | Tokenizer `modelFamily` does not match embedding provider `modelFamily` (cl-spec-006 section 2.2) | `"Tokenizer model family '{x}' does not match embedding provider model family '{y}'"` |
| Pinned ceiling | Pinned tokens exceed `pinnedCeilingRatio` × capacity (cl-spec-007 section 2.2) | `"Pinned segments consume {n}% of capacity (ceiling: {c}%)"` |
| Late seeding | `seed()` called after `add()` (cl-spec-007 section 3.1) | `"Seeding after add — quality baseline will be re-captured"` |
| Zero vector | Embedding provider returned a zero vector (cl-spec-005 section 2.4) | `"Zero embedding vector for segment '{id}' — cosine similarity undefined"` |
| Approximate capacity | Tokenizer accuracy is approximate, capacity tracking has ±{errorBound}% uncertainty | `"Token counts are approximate (±{n}%) — capacity and utilization have corresponding uncertainty"` |

Warnings are collected in a list, deduplicated by message (the same warning is not added twice), and included in the diagnostic snapshot. The warning list is bounded at 50 entries — oldest warnings are dropped when the limit is reached. Warnings are not clearable by the caller — they persist for the session.

### 2.4 Defensive Copies

`getDiagnostics()` returns a defensive copy of all diagnostic state. The snapshot is a frozen observation — mutating the returned object has no effect on the instance's internal state. Subsequent calls to `getDiagnostics()` return new snapshots reflecting any state changes since the previous call.

---

## 3. Report History and Trends

`assess()` produces a quality report (cl-spec-002 section 9). Each report is a point-in-time snapshot. The quality model retains only the most recent report for caching purposes and computes a one-report-back trend (cl-spec-002 section 9.6). Deeper analysis — rolling averages, rate-of-change, anomaly detection — requires retaining report history. That is this section's job.

### 3.1 Report Retention

context-lens retains the **20 most recent quality reports** in a ring buffer. When the 21st report is generated, the oldest is dropped. The buffer stores **report summaries**, not full reports — retaining 20 full reports with per-segment score arrays would consume disproportionate memory for a diagnostic feature.

**ReportSummary structure:**

| Field | Type | Description |
|-------|------|-------------|
| `reportId` | string | Monotonically increasing report identifier |
| `timestamp` | number | When the report was generated |
| `windowScores` | WindowScores | Window-level scores (coherence, density, relevance, continuity) |
| `composite` | number | Composite score |
| `segmentCount` | number | Active segments at report time |
| `totalActiveTokens` | number | Token usage at report time |
| `utilization` | number | Utilization at report time |
| `patternCount` | number | Number of active patterns |
| `highestSeverity` | Severity or null | Highest active pattern severity |
| `embeddingMode` | string | `"embeddings"` or `"trigrams"` |
| `anomalies` | AnomalyFlag[] | Dimensions that changed by > 0.15 since previous report. Empty if none or if first report (section 3.3) |

Each summary is ~200 bytes. 20 entries: ~4KB. Negligible.

**ReportHistorySummary structure:**

| Field | Type | Description |
|-------|------|-------------|
| `reports` | ReportSummary[] | Ring buffer of the last 20 report summaries, newest first |
| `rollingTrend` | RollingTrend or null | Rolling 5-report trend analysis. Null if fewer than 2 reports |

**Why 20 reports:** Enough to compute meaningful rolling trends (section 3.2) and show the session trajectory. 20 reports at typical assess frequency (every few interactions) covers the recent conversation history without retaining the entire session. The buffer size is a fixed internal parameter, not caller-configurable — tuning it provides no meaningful benefit and adds API complexity.

### 3.2 Rolling Trends

The per-report trend in QualityReport (cl-spec-002 section 9.6) is a one-step delta: the difference between this report and the previous one. It answers "what just changed?" Rolling trends answer a different question: **"where is this heading?"**

**RollingTrend structure:**

| Field | Type | Description |
|-------|------|-------------|
| `window` | number | Number of reports in the rolling window (min(5, available reports)) |
| `coherence` | TrendLine | Coherence trend over the window |
| `density` | TrendLine | Density trend over the window |
| `relevance` | TrendLine | Relevance trend over the window |
| `continuity` | TrendLine | Continuity trend over the window |
| `composite` | TrendLine | Composite trend over the window |

**TrendLine structure:**

| Field | Type | Description |
|-------|------|-------------|
| `direction` | string | `"improving"`, `"stable"`, or `"degrading"` |
| `averageRate` | number | Average per-report delta over the window. Positive = improving, negative = degrading. |
| `current` | number | Most recent score |
| `windowMin` | number | Lowest score in the window |
| `windowMax` | number | Highest score in the window |
| `volatility` | number | Standard deviation of deltas within the window. High volatility = unstable scores. |

**Direction classification:**

- `"improving"`: averageRate > 0.01
- `"degrading"`: averageRate < -0.01
- `"stable"`: |averageRate| ≤ 0.01

The ±0.01 threshold filters noise. Quality scores fluctuate slightly between reports due to segment additions and minor content changes. A per-report delta of 0.005 is noise, not a trend. The threshold ensures that `"degrading"` means a real, sustained decline — not a rounding artifact.

**Rolling window size:** The window is the most recent 5 reports (or fewer if fewer than 5 reports exist). Five reports is enough to smooth single-report spikes and short enough to respond to genuine trajectory changes. The window size is fixed — not configurable.

### 3.3 Score Anomaly Detection

An **anomaly** is a sharp, single-report change in a quality dimension. Anomalies differ from trends: a trend is a gradual movement over multiple reports; an anomaly is a discontinuity in one step.

**Detection:** A score delta is anomalous if its magnitude exceeds 0.15 (the same threshold used for rate-based severity elevation in cl-spec-003 section 2.4). Anomalies are flagged in the report history — each ReportSummary carries an `anomalies` field listing which dimensions experienced anomalous change.

| Field | Type | Description |
|-------|------|-------------|
| `anomalies` | AnomalyFlag[] | Dimensions that changed by > 0.15 since the previous report |

**AnomalyFlag structure:**

| Field | Type | Description |
|-------|------|-------------|
| `dimension` | string | `"coherence"`, `"density"`, `"relevance"`, `"continuity"`, or `"composite"` |
| `delta` | number | Signed change (negative = drop, positive = improvement) |
| `likelyCause` | string or null | Best-effort attribution: `"taskChange"`, `"bulkEviction"`, `"providerSwitch"`, `"bulkAdd"`, or null if no single cause is identified |

**Likely cause attribution:** When an anomaly is flagged, context-lens checks the timeline (section 5) for events between the two reports that could explain the discontinuity:

- A `setTask` change event → `"taskChange"` (explains relevance drops)
- Multiple eviction events → `"bulkEviction"` (explains continuity drops, coherence disruption)
- A provider switch event → `"providerSwitch"` (explains score discontinuities across all dimensions)
- Multiple add events → `"bulkAdd"` (explains density or coherence changes)

Attribution is best-effort, not guaranteed. If multiple causes coincide, the first match in the above priority order is used. If no timeline event explains the anomaly, `likelyCause` is null. This is a diagnostic hint, not a root cause analysis.

---

## 4. Pattern History

The degradation detection framework (cl-spec-003) evaluates patterns on every `assess()` call and produces the `DetectionResult` included in the quality report. But the detection result is a snapshot — it shows what patterns are active *right now*. It does not show how patterns have behaved over the session: how many times saturation has fired, how long erosion persisted before being resolved, whether collapse is a recurrent problem or a one-time event.

Pattern history answers these questions. It retains the lifecycle of every pattern activation across the session and provides summary statistics.

### 4.1 PatternSummary Structure

| Field | Type | Description |
|-------|------|-------------|
| `activePatterns` | ActivePattern[] | Currently active patterns from the most recent detection result (cl-spec-003 section 2.3). Empty if no patterns are active. |
| `totalActivations` | number | Total pattern activations in this session (counting each activation once, regardless of escalation) |
| `totalResolutions` | number | Total pattern resolutions |
| `perPattern` | Record<PatternName, PatternStats> | Per-pattern summary statistics |
| `history` | PatternHistoryEntry[] | Chronological activation/resolution log. Ring buffer of 50 entries. Most recent last. |

**PatternStats structure:**

| Field | Type | Description |
|-------|------|-------------|
| `activationCount` | number | How many times this pattern has activated in the session |
| `totalActiveTime` | number | Cumulative milliseconds this pattern has been active |
| `peakSeverity` | Severity | Highest severity reached in any activation |
| `currentState` | string | `"active"` or `"inactive"` |
| `currentSeverity` | Severity or null | Current severity if active, null if inactive |
| `lastActivation` | number or null | Timestamp of most recent activation |
| `lastResolution` | number or null | Timestamp of most recent resolution |
| `recurrenceCount` | number | How many times this pattern has re-activated after a previous resolution |

**PatternHistoryEntry structure** (as referenced by cl-spec-003 section 2.5):

| Field | Type | Description |
|-------|------|-------------|
| `name` | PatternName | Which pattern |
| `event` | string | `"activated"`, `"escalated"`, `"deescalated"`, `"resolved"` |
| `severity` | Severity | Severity at the time of the event |
| `timestamp` | number | When the event occurred |
| `reportId` | string | Which quality report triggered this event |
| `score` | number | The primary score that drove the event (e.g., utilization for saturation, coherence for fracture) |
| `compoundContext` | string or null | Compound pattern name if this event occurred during a compound (cl-spec-003 section 8.2) |

### 4.2 Pattern Lifecycle Tracking

Pattern state transitions are tracked as they occur during `assess()`:

| Transition | Event logged | Stats updated |
|-----------|-------------|---------------|
| Pattern crosses activation threshold | `"activated"` | activationCount++, lastActivation set, currentState → active. If previously resolved in this session: recurrenceCount++ |
| Active pattern crosses a higher severity threshold | `"escalated"` | currentSeverity updated, peakSeverity updated if new peak |
| Active pattern drops below current severity + hysteresis | `"deescalated"` | currentSeverity updated |
| Active pattern drops below lowest threshold + hysteresis | `"resolved"` | lastResolution set, currentState → inactive, totalActiveTime += (now - lastActivation) |

**Recurrence.** A pattern that activates, resolves, and activates again is a recurrence. Recurrence is a meaningful diagnostic signal — it suggests that the underlying cause was not fully addressed. Collapse that recurs 4 times in a session indicates a structural problem (the caller is repeatedly evicting important content). Saturation that recurs after each eviction batch suggests the caller is not evicting enough. `recurrenceCount` makes this pattern visible.

**History buffer.** The history retains the 50 most recent entries. At typical session activity (5–15 reports with 0–3 pattern events per report), 50 entries covers the full session. For unusually active sessions, the oldest entries are dropped — the most recent events are the most diagnostically relevant.

### 4.3 Compound Pattern Tracking

Compound patterns (cl-spec-003 section 8.2) are logged in the timeline (section 5) but not tracked separately in the pattern history. The compound is a diagnostic annotation on individual patterns, not a separate entity with its own lifecycle. The `compoundContext` field on PatternHistoryEntry links individual pattern events to their compound context, enabling compound-aware analysis without duplicating the tracking.

### 4.4 Custom Pattern Accommodation

Custom patterns (cl-spec-003 section 10) are tracked identically to base patterns. They produce the same `ActivePattern` shape (cl-spec-003 invariant 13), generate the same `PatternHistoryEntry` events, and appear in the same `perPattern` map and `history` buffer.

The `perPattern` map uses pattern name strings as keys. Base pattern names are the five well-known strings; custom pattern names are caller-defined. Consumers iterating `perPattern` should not assume a fixed set of keys — custom patterns add entries dynamically. The map only includes patterns that have been active at least once.

Custom patterns do not produce `compoundContext` annotations (cl-spec-003 section 10.8). Their `PatternHistoryEntry` entries always have `compoundContext: null`. This is the only observable difference between base and custom pattern history entries.

---

## 5. Session Timeline

The session timeline is a unified, chronological log of every significant event in the instance's lifecycle. It is the correlation backbone of diagnostics — the single data structure that aligns mutations, task changes, pattern state transitions, quality score movements, and performance events in time.

### 5.1 TimelineEntry Structure

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | number | When the event occurred |
| `sequence` | number | Monotonically increasing sequence number, for stable ordering of simultaneous events |
| `type` | TimelineEventType | Event classification |
| `detail` | object | Event-specific payload (structure varies by type) |

### 5.2 Event Types

| Type | Trigger | Detail fields |
|------|---------|--------------|
| `segmentAdded` | `add()` or `seed()` completes | `{ segmentId, tokenCount, protection, origin }` |
| `segmentUpdated` | `update()` completes | `{ segmentId, contentChanged: boolean, fieldsChanged: string[] }` |
| `segmentReplaced` | `replace()` completes | `{ segmentId, previousTokenCount, newTokenCount }` |
| `segmentCompacted` | `compact()` completes | `{ segmentId, previousTokenCount, newTokenCount, compressionRatio }` |
| `segmentSplit` | `split()` completes | `{ originalId, childIds: string[], childCount }` |
| `segmentEvicted` | `evict()` completes | `{ segmentId, tokenCount, protection, evictionCost, reason }` |
| `segmentRestored` | `restore()` completes | `{ segmentId, tokenCount, fidelity }` |
| `groupCreated` | `createGroup()` completes | `{ groupId, memberCount }` |
| `groupDissolved` | `dissolveGroup()` completes | `{ groupId, memberCount }` |
| `taskSet` | `setTask()` completes (not same-task no-op) | `{ classification, similarity, descriptionPreview }` |
| `taskCleared` | `clearTask()` completes | `{ previousDescriptionPreview }` |
| `baselineCaptured` | Baseline captured after seed | `{ segmentCount, totalTokens, scores: WindowScores }` |
| `reportGenerated` | `assess()` completes | `{ reportId, composite, highestSeverity, patternCount }` |
| `patternActivated` | Pattern crosses activation threshold | `{ name, severity, primaryScore }` |
| `patternEscalated` | Active pattern severity increases | `{ name, fromSeverity, toSeverity }` |
| `patternDeescalated` | Active pattern severity decreases | `{ name, fromSeverity, toSeverity }` |
| `patternResolved` | Pattern drops below all thresholds | `{ name, peakSeverity, duration }` |
| `tokenizerChanged` | `setTokenizer()` completes | `{ previousName, newName, segmentsRecounted }` |
| `embeddingProviderChanged` | `setEmbeddingProvider()` completes | `{ previousMode, newMode, segmentsReembedded }` |
| `capacityChanged` | `setCapacity()` completes | `{ previousCapacity, newCapacity, newUtilization }` |
| `budgetViolation` | A Tier 1–4 operation exceeds its budget | `{ operation, selfTime, budgetTarget, segmentCount }` |
| `customPatternRegistered` | A custom pattern was registered via registerPattern | `{ name, dimensions }` |
| `stateSnapshotted` | Instance state was serialized via snapshot() | `{ segmentCount, totalTokens }` |
| `stateRestored` | Instance state was restored via fromSnapshot() | `{ segmentCount, totalTokens }` |
| `lateSeeding` | Segments were seeded after non-seed segments already existed | `{ seedCount, existingCount }` |
| `pinnedCeilingWarning` | Pinned tokens exceed the configured ceiling threshold | `{ pinnedTokens, ceiling, utilization }` |

### 5.3 Timeline Retention

The timeline is a **ring buffer of 200 entries**. When the 201st event occurs, the oldest entry is dropped. Each entry is lightweight (~150 bytes), so the full buffer consumes ~30KB.

200 entries covers a typical session comprehensively. A session with 50 adds, 20 evicts, 15 reports, 5 task changes, and associated pattern events produces ~100 timeline entries. The buffer has 2x headroom for busy sessions.

The timeline is ordered by `(timestamp, sequence)`. The sequence number breaks ties when multiple events occur during the same operation (e.g., `assess()` produces a `reportGenerated` event and potentially multiple `patternActivated` events, all with the same timestamp). Sequence numbers are assigned at creation time and never reused.

### 5.4 Timeline Queries

The diagnostic snapshot includes the raw timeline array. context-lens does not provide timeline query or filter methods — the array is small enough for the caller to filter in application code. Callers who need timeline queries (e.g., "show me all pattern events between reports 5 and 10") iterate the array and filter by type and timestamp.

This is a deliberate simplicity choice. A query API for 200 entries adds API surface without adding capability that a simple array filter cannot provide. If the timeline were unbounded or persisted, queries would be justified. For a 200-entry in-memory ring buffer, they are not.

---

## 6. Performance Diagnostics

The performance budget (cl-spec-009) defines per-operation timing records with selfTime/providerTime decomposition. The token count cache (cl-spec-006 section 5.5) exposes diagnostic counters. The embedding cache (cl-spec-005 section 5) and similarity cache (cl-spec-002 section 3.2) follow the same pattern. This section defines how diagnostics aggregates and surfaces these metrics.

### 6.1 PerformanceSummary Structure

| Field | Type | Description |
|-------|------|-------------|
| `operationTimings` | Record<string, OperationTiming> | Per-operation aggregated timing. Key is the operation name (e.g., `"add"`, `"assess"`, `"planEviction"`). |
| `caches` | CacheReport | Aggregated cache metrics across all three caches |
| `sessionSelfTime` | number | Total selfTime across all operations in the session |
| `sessionProviderTime` | number | Total providerTime across all operations in the session |
| `budgetViolationCount` | number | Total budget violations in the session |

**OperationTiming structure:**

| Field | Type | Description |
|-------|------|-------------|
| `count` | number | Total invocations of this operation |
| `totalSelfTime` | number | Cumulative selfTime (ms) |
| `totalProviderTime` | number | Cumulative providerTime (ms) |
| `averageSelfTime` | number | Mean selfTime per invocation |
| `maxSelfTime` | number | Worst-case selfTime |
| `p95SelfTime` | number | 95th percentile selfTime (from the timing ring buffer, cl-spec-009 section 8.2) |
| `budgetTarget` | number | Budget target for this operation at current segment count (ms) |
| `budgetViolations` | number | Number of invocations where selfTime exceeded budgetTarget |
| `withinBudgetRate` | number | Fraction of invocations within budget (0.0–1.0) |

**Why p95, not just max:** The max selfTime is often an outlier — the cold-start first assessment or a GC-adjacent timing anomaly. p95 gives the caller a realistic upper bound for what to expect. If p95 is within budget but max is not, performance is healthy. If p95 exceeds budget, the caller has a systematic problem.

### 6.2 CacheReport Structure

| Field | Type | Description |
|-------|------|-------------|
| `tokenCache` | CacheMetrics | Token count cache (cl-spec-006 section 5) |
| `embeddingCache` | CacheMetrics | Embedding/trigram cache (cl-spec-005 section 5) |
| `similarityCache` | CacheMetrics | Similarity score cache (cl-spec-002 section 3.2) |

**CacheMetrics structure:**

| Field | Type | Description |
|-------|------|-------------|
| `hits` | number | Total cache hits since construction |
| `misses` | number | Total cache misses |
| `hitRate` | number or null | hits / (hits + misses). Null if no lookups have occurred. |
| `currentEntries` | number | Current number of entries in the cache |
| `maxEntries` | number | Maximum cache capacity |
| `utilization` | number | currentEntries / maxEntries |
| `evictions` | number | Total LRU evictions (entries dropped to make room) |

### 6.3 Interpreting Cache Metrics

Cache hit rates are leading indicators of assessment performance. The relationship:

| Cache | Healthy hit rate | Concern threshold | Interpretation of low hit rate |
|-------|:---:|:---:|------|
| Token cache | > 95% | < 80% | High content churn. Most lifecycle operations recount because content changes frequently. Consider increasing `tokenCacheSize` if memory allows. |
| Embedding cache | > 90% | < 70% | Same as above for embedding. High churn or cache too small for the working set. Embedding cache misses are expensive if the provider is remote. |
| Similarity cache | > 80% | < 60% | Assessment is recomputing many similarity pairs. Window is growing or content is churning faster than the cache can absorb. Incremental assessment will be slow. |

These thresholds are guidance for callers interpreting the metrics, not detection thresholds for context-lens. context-lens reports the numbers; the caller decides what constitutes "healthy" for their workload.

---

## 7. Provider Diagnostics

Provider configuration determines the precision/latency tradeoff of the entire system. Diagnostics surfaces the current provider state so the caller can audit which providers are active, verify that they match the intended configuration, and track provider-related events.

### 7.1 ProviderSummary Structure

| Field | Type | Description |
|-------|------|-------------|
| `tokenizer` | TokenizerInfo | Current tokenizer state |
| `embedding` | EmbeddingInfo | Current embedding provider state |

**TokenizerInfo structure:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Provider name (e.g., `"approximate-charclass"`, `"cl100k_base"`) |
| `accuracy` | string | `"exact"` or `"approximate"` |
| `modelFamily` | string or null | Target model family |
| `errorBound` | number or null | Maximum expected relative error (e.g., 0.10 for ±10%) |
| `switchCount` | number | How many times the tokenizer has been changed this session |

**EmbeddingInfo structure:**

| Field | Type | Description |
|-------|------|-------------|
| `mode` | string | `"embeddings"` or `"trigrams"` |
| `providerName` | string or null | Provider name if in embedding mode, null in trigram mode |
| `dimensions` | number or null | Vector dimensions if in embedding mode |
| `modelFamily` | string or null | Provider's model family |
| `switchCount` | number | How many times the embedding provider has been changed this session (including setting to null) |
| `lastSwitchAt` | number or null | Timestamp of most recent provider change |

### 7.2 Provider Mismatch Detection

Provider diagnostics cross-references the tokenizer and embedding provider metadata to detect configuration inconsistencies:

- **Model family mismatch:** If the tokenizer targets `"openai"` and the embedding provider targets `"cohere"`, the diagnostic snapshot includes a warning (section 2.3). Token counts and embeddings are computed by different model families, which may produce inconsistent signals — though context-lens operates correctly regardless.
- **Accuracy downgrade:** If the tokenizer switches from `"exact"` to `"approximate"` during the session, the diagnostic snapshot includes a warning. The caller may not realize that accuracy has degraded.

These checks run at provider switch time, not at getDiagnostics time. The results are stored as warnings and included in the diagnostic snapshot without recomputation.

---

## 8. Formatting

Quality reports and diagnostic snapshots are structured data — nested objects with numeric scores, arrays of pattern results, and typed metadata. This is ideal for programmatic consumption: dashboards, logging pipelines, alerting systems. But for human consumption — log files, console output, debugging sessions — structured data is unwieldy. A quality report with 500 segment scores and 5 active patterns is hard to read as a JSON blob.

This section defines the formatting utilities that produce human-readable summaries from structured diagnostic data.

### 8.1 Report Summary

```
formatReport(report: QualityReport) -> string
```

Produces a multi-line plain-text summary of a quality report. The summary includes:

1. **Headline scores:** Window-level coherence, density, relevance, continuity, and composite — one line.
2. **Capacity:** Utilization percentage, headroom in tokens, segment count.
3. **Active patterns:** Each active pattern on its own line — name, severity, and the human-readable explanation from the detection result (cl-spec-003 section 2.3). Ordered by pattern priority (collapse > saturation > gap > erosion > fracture).
4. **Trends:** Per-dimension delta since last report, with direction indicators.
5. **Alerts:** Compound pattern annotations, if any.

The summary omits per-segment scores (too verbose for human consumption), group details (rarely needed in a summary), and the full continuity ledger. These are available in the structured QualityReport for programmatic access.

**Example output:**

```
Context Quality [report #14, 2026-04-04T15:32:01Z]
  Coherence: 0.72  Density: 0.85  Relevance: 0.41  Continuity: 0.88  Composite: 0.69
  Capacity: 87% (112,640 / 128,000 tokens) | 342 segments | headroom: 15,360

  Patterns:
    [WARNING] Saturation — utilization at 88%, approaching critical threshold
    [WATCH]   Gap — relevance at 0.41, 12 segments (34,200 tokens) below 0.3 relevance

  Trends: coherence +0.02, density -0.01, relevance -0.12, continuity stable
  Note: relevance drop coincides with task change (2 reports in grace period)
```

### 8.2 Diagnostic Summary

```
formatDiagnostics(snapshot: DiagnosticSnapshot) -> string
```

Produces a multi-line summary of the full diagnostic snapshot. Includes the report summary (section 8.1) plus:

1. **Session overview:** Duration, total reports generated, total mutations.
2. **Pattern history summary:** Total activations, currently active patterns, recurrence warnings.
3. **Performance overview:** Average selfTime for hot-path operations, cache hit rates, budget violation count.
4. **Provider state:** Tokenizer name and accuracy, embedding mode and provider.
5. **Warnings:** Active warnings, if any.

### 8.3 Pattern Alert

```
formatPattern(pattern: ActivePattern) -> string
```

Produces a single-line or multi-line summary of one active pattern. Includes the pattern name, severity, explanation, and top remediation hint. Used for logging individual pattern events.

### 8.4 JSON Formatting

In addition to the plain-text formatters above, context-lens provides schema-conforming JSON serialization through the `toJSON()` utility (cl-spec-007 section 6.4). While the plain-text formatters produce human-readable summaries that omit detail, `toJSON()` produces complete, machine-readable output conforming to the JSON Schema definitions in cl-spec-011.

The two formatting paths serve different consumers:

| Path | Output | Audience | Completeness |
|------|--------|----------|-------------|
| `formatReport(report)` | Plain text | Humans (logs, console, debugging) | Summary — headline scores, active patterns, trends |
| `toJSON(report)` | JSON object | Machines (dashboards, pipelines, tools) | Complete — all fields, all segments, all detail |

`formatDiagnostics` and `formatPattern` similarly have their JSON counterparts through `toJSON()` applied to their input objects. There is no separate `formatReportJSON` function — `toJSON()` is the JSON path for all output types.

Custom patterns appear in both formatting paths. `formatReport` includes custom pattern names and explanations in the "Patterns" section, ordered by priority alongside base patterns. `toJSON` includes custom patterns in the `patterns.patterns` array with the same `ActivePattern` structure as base patterns.

### 8.5 Formatting Principles

- **No color codes or ANSI escapes.** Output is plain text, safe for any log sink. Callers who want colored output wrap the formatted strings in their own styling.
- **Fixed-width alignment** where practical (score columns align across dimensions). This makes console output scannable.
- **Scores are two decimal places.** 0.72, not 0.7234. Two decimals is the precision that matters — more digits imply false precision from approximate similarity functions.
- **Tokens are comma-formatted.** `112,640`, not `112640`. Human readability.
- **Timestamps are ISO 8601.** `2026-04-04T15:32:01Z`. Unambiguous and sortable.
- **Formatters are pure functions.** They read data, produce strings. No side effects, no state, no I/O. They can be called on any report or snapshot from any context.

---

## 9. Invariants and Constraints

**1. Read-only diagnostics.** `getDiagnostics()` does not call segment-mutating methods or configuration-mutating methods. It assembles a snapshot from pre-maintained internal state without triggering quality scoring, pattern detection, or provider calls.

**2. Cheap assembly.** `getDiagnostics()` is a Tier 1 operation (cl-spec-009): < 1 ms regardless of window size. Diagnostic state is maintained incrementally as events occur. Assembly is a read-and-copy operation, not a computation.

**3. Snapshot isolation.** A DiagnosticSnapshot is a frozen observation. It is not connected to the instance — mutations after the snapshot is returned do not retroactively update it. Subsequent calls to `getDiagnostics()` return new snapshots. This matches the snapshot semantics of QualityReport (cl-spec-002 invariant 15).

**4. Timeline ordering.** Timeline entries are ordered by `(timestamp, sequence)`. The ordering is total — no two entries share both timestamp and sequence number. Events within a single operation (e.g., multiple pattern activations during one `assess()`) have the same timestamp but distinct, monotonically increasing sequence numbers. The ordering is stable across calls — it does not change retroactively.

**5. History bounds.** All history buffers have fixed capacity: 20 report summaries, 50 pattern history entries, 200 timeline entries. No buffer grows without bound. When a buffer is full, the oldest entry is dropped. Memory consumption from diagnostic history is constant regardless of session length.

**6. Incremental maintenance.** Diagnostic state (report summaries, pattern stats, timeline entries, performance counters, cache metrics) is updated at the time of the triggering event — not recomputed at `getDiagnostics()` time. Adding a segment updates the timeline and performance counters immediately. `getDiagnostics()` reads the result, it does not re-derive it.

**7. Trend accuracy.** Rolling trends (section 3.2) are computed from the retained report summaries. If fewer than 2 reports exist, rolling trends are null. If fewer than 5 reports exist, the window is the available reports. Trends are never computed from reports that have been dropped from the ring buffer — there is no "approximate historical trend" from lost data.

**8. Formatting is pure.** Formatting functions (section 8) are stateless, side-effect-free, and deterministic. The same input produces the same output. They do not access instance state, call providers, or emit events. They are utility functions, not instance methods — they can be called on any QualityReport or DiagnosticSnapshot, including ones from previous sessions if the caller serialized them.

**9. Warning deduplication.** The warning list (section 2.3) does not contain duplicate messages. A warning that has already been recorded is not added again. Deduplication is by message string, not by source event — two different events that produce the same warning message result in one warning entry. This prevents the warning list from filling with repeated advisories during long sessions.

**10. Diagnostic completeness.** The diagnostic snapshot includes the **full** current state of every diagnostic subsystem — report history, pattern summary, timeline, performance metrics, provider info, warnings, task state, and continuity ledger. No diagnostic data is available through a separate method that is not also available through `getDiagnostics()`. This is the single-call observability guarantee: one method, complete state.

---

## 10. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-002` (Quality Model) | Defines quality reports (section 9), quality dimensions, per-report trend (section 9.6), continuity ledger (section 6), and similarity caching whose metrics this spec surfaces |
| `cl-spec-003` (Degradation Patterns) | Defines detection results (section 2.3), per-pattern diagnostic output (sections 3.4–7.4), pattern history entries (section 2.5), compound patterns (section 8.2), causal chains (section 8.1), and custom pattern registration (section 10) — all surfaced by diagnostics. Custom patterns produce the same history entries as base patterns. |
| `cl-spec-004` (Task Identity) | Defines task state and transition history surfaced in the diagnostic snapshot (section 7.4) |
| `cl-spec-005` (Embedding Strategy) | Defines embedding cache metrics (section 5) and provider metadata surfaced by provider diagnostics |
| `cl-spec-006` (Tokenization Strategy) | Defines token cache diagnostics (section 5.5) and tokenizer metadata surfaced by provider diagnostics |
| `cl-spec-007` (API Surface) | Defines the public API that this spec extends with `getDiagnostics()` and formatting utilities. Event system (section 9) provides the triggers for timeline and history updates |
| `cl-spec-008` (Eviction Advisory) | Defines eviction plan metadata surfaced in the session timeline |
| `cl-spec-009` (Performance Budget) | Defines per-operation timing records (section 8.1), timing history (section 8.2), budget violation detection (section 8.3), and cache performance reporting (section 8.4) — all aggregated by performance diagnostics |
| `cl-spec-011` (Report Schema) | Defines JSON Schema for DiagnosticSnapshot and all nested types. The `toJSON()` utility (section 8.4) produces output conforming to these schemas. |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.6*
