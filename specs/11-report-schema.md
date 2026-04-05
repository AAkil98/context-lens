---
id: cl-spec-011
title: Report Schema
type: design
status: draft
created: 2026-04-04
revised: 2026-04-04
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [schema, json, serialization, versioning, interoperability, output-format]
depends_on: [cl-spec-002, cl-spec-003, cl-spec-004, cl-spec-006, cl-spec-007, cl-spec-008, cl-spec-010]
---

# Report Schema

## Table of Contents

1. Overview
2. Schema Versioning
3. QualityReport Schema
4. DiagnosticSnapshot Schema
5. EvictionPlan Schema
6. Shared Type Definitions
7. Enum Definitions
8. Serialization Conventions
9. Schema Distribution and Validation
10. Invariants and Constraints
11. References

---

## 1. Overview

context-lens produces three primary output artifacts: quality reports (cl-spec-002 section 9, cl-spec-007 section 6), diagnostic snapshots (cl-spec-010 section 2), and eviction plans (cl-spec-008 section 4). Each is a structured object defined across multiple specs, with nested types that reference other specs in turn. The TypeScript reference implementation provides these objects as native types — callers who import the library get typed data structures and can use them directly.

But not every consumer imports the library. A dashboard ingests quality reports over a WebSocket. An alerting pipeline reads diagnostic snapshots from a queue. An analytics service in Python aggregates eviction plans from a fleet of TypeScript instances. A Go agent coordinator monitors quality across child processes. Each of these consumers needs to parse context-lens output without access to the TypeScript type system.

This spec makes that possible. It defines a **normative type catalog** for every output type and nested structure that context-lens produces, along with the serialization conventions that govern how these types map to JSON. The catalog is the authoritative reference for what a conforming output looks like. From this catalog, the reference implementation generates **JSON Schema files** (draft 2020-12) that any consumer — in any language, with any JSON Schema validator — can use to parse, validate, and interpret context-lens output.

### What this spec defines

- **Schema versioning** (section 2) — how output schemas are versioned independently of the library, how versions evolve, and the compatibility contract.
- **Three top-level output schemas** (sections 3–5) — the complete field-by-field definition of QualityReport, DiagnosticSnapshot, and EvictionPlan as JSON-serializable objects.
- **Shared type definitions** (section 6) — every nested type referenced by the three outputs: ~35 named structures organized by domain (quality, capacity, detection, task, eviction, diagnostics, provider).
- **Enum definitions** (section 7) — all closed vocabularies (severity levels, pattern names, strategy names, event types, etc.) as string enums.
- **Serialization conventions** (section 8) — the rules that govern how internal types map to JSON: timestamp representation, number precision, null semantics, array ordering, enum encoding.
- **Schema distribution and validation** (section 9) — how schemas are published, how consumers access them, and the validation contract.

### What this spec does not define

This spec does not define a wire protocol. It defines the shape of data at rest — what a quality report looks like as a JSON object. How that object is transmitted (HTTP, WebSocket, file, IPC) is the caller's concern. The schema does not prescribe a transport.

This spec does not define input schemas. The constructor configuration (`ContextLensConfig`), segment input (`SegmentInput`), plan options (`PlanOptions`), and other API inputs are TypeScript-specific and intentionally not schema'd. Input validation is the reference implementation's job (cl-spec-007 section 10). Output schemas serve a different audience: consumers who parse output without calling the API.

This spec does not define formatting. The human-readable text produced by `formatReport`, `formatDiagnostics`, and `formatPattern` (cl-spec-010 section 8) is not schema'd. Formatted text is for humans, not for machines. The schema defines the structured data from which formatted text is derived.

### Design goals

- **Language-agnostic.** A consumer in Python, Go, Rust, or Java can validate and parse context-lens output using only a JSON Schema validator and the schema files. No TypeScript types, no library import, no runtime dependency.
- **Self-describing.** Every output includes a `schemaVersion` field. A consumer can check the version, load the corresponding schema, and validate the output — even if the producer is running a different library version than the consumer expects.
- **Forward-compatible.** Consumers that ignore unknown fields will continue to work when the schema adds new fields. This is the contract: minor version bumps add fields, never remove or retype them.
- **Authoritative.** When this spec and a source spec disagree on the shape of an output type, this spec wins for serialization purposes. The source spec defines the semantic meaning; this spec defines the serialized representation. In practice, these should not diverge — any divergence is a spec bug that should be resolved.

---

## 2. Schema Versioning

### 2.1 Resolution of OQ-010: Independent Versioning

**Decision:** Schema versions are **independent** of library versions.

**Rationale:**

Library versions change for many reasons: internal performance improvements, bug fixes, new API methods, dependency updates. Most of these changes do not affect the shape of output objects. A library version bump from 1.3.0 to 1.4.0 that adds a new `listSegments` filter option does not change what `assess()` returns. If schema versions were coupled to library versions, consumers would need to update their schema references on every library release — even when nothing they consume has changed.

Conversely, some schema changes are additive output-shape changes that warrant a schema version bump without a library major version. Adding a new optional field to QualityReport (e.g., a `samplingActive` flag from cl-spec-009) changes the schema but is not a breaking library change.

Independent versioning lets schema consumers track only the changes that matter to them: additions, removals, or type changes in the output structures they parse.

**Alternative considered:** Coupling schema version to library version. Simpler — one version to track. Rejected because it creates false positives (consumers re-validate on irrelevant library changes) and false negatives (output shape changes that do not merit a library major version get no schema signal).

### 2.2 Version Format

Schema versions follow **semantic versioning** (semver):

```
MAJOR.MINOR.PATCH
```

- **MAJOR** — incompatible changes: field removal, field type change, required field added without default, semantic reinterpretation of an existing field.
- **MINOR** — backwards-compatible additions: new optional fields on existing types, new enum values appended to open enums, new shared type definitions.
- **PATCH** — corrections: description clarifications, constraint tightening that does not reject previously valid output, documentation fixes.

**Initial version:** `1.0.0`. This is set when the reference implementation first ships schema-conforming output. The spec defines the schema; the version is assigned at implementation time.

### 2.3 The schemaVersion Field

Every top-level output includes a `schemaVersion` field:

| Field | JSON type | Example | Description |
|-------|-----------|---------|-------------|
| `schemaVersion` | string | `"1.0.0"` | The schema version that this output conforms to. |

The field is always present — it is required, not optional. It is set by the library at serialization time. The caller does not set it. The value matches the schema version that the library's current output conforms to, which is determined at build time.

**Consumers use this field to:**
1. Select the correct schema version for validation.
2. Detect version mismatches (the consumer expects schema 1.2.0 but the producer emits 1.3.0 — additive, should still validate against 1.2.0).
3. Implement conditional logic for version-specific fields.

### 2.4 Compatibility Contract

**Within a major version:**

- **Additive only.** New fields may be added to any type. New fields are always optional (nullable or with a default value). Existing required fields remain required.
- **No removals.** A field that exists in version 1.x.0 exists in all 1.y.0 where y ≥ x.
- **No type changes.** A field that is `number` in 1.x.0 is `number` in all 1.y.0 where y ≥ x.
- **No semantic reinterpretation.** A field whose description says "milliseconds since epoch" in 1.x.0 still means "milliseconds since epoch" in 1.y.0.

**Consumer obligations:**

- **MUST** ignore unknown fields. A consumer built for schema 1.2.0 that receives output from 1.4.0 will encounter fields it does not recognize. It must not reject the output — it must silently ignore the unknown fields. This is the core forward-compatibility mechanism. JSON Schema validation with `additionalProperties: true` (the default) enforces this.
- **SHOULD NOT** require fields beyond what the schema marks `required`. Optional fields may be absent in older library versions that predate the field's addition.

**Across major versions:**

No compatibility guarantee. A major version bump (1.x.y → 2.0.0) may remove fields, change types, or restructure the output. Consumers must update their parsing logic for the new major version.

---

## 3. QualityReport Schema

The QualityReport is the primary output of context-lens — the result of `assess()` (cl-spec-007 section 6.1). It contains window-level scores, per-segment scores, degradation patterns, capacity metrics, trend data, and task state. This section defines the serialized shape.

### 3.1 Top-Level Fields

| Field | JSON type | Required | Nullable | Description |
|-------|-----------|----------|----------|-------------|
| `schemaVersion` | string | yes | no | Schema version (section 2.3). |
| `timestamp` | number | yes | no | When the report was generated (epoch ms). |
| `reportId` | string | yes | no | Unique, monotonically increasing report identifier. |
| `segmentCount` | integer | yes | no | Number of ACTIVE segments at report time. |
| `windowScores` | WindowScores | yes | no | Normalized window-level dimension scores. |
| `rawScores` | WindowScores | yes | no | Pre-normalization window-level dimension scores. |
| `composite` | number | yes | yes | Weighted geometric mean composite score. `null` if zero active segments. |
| `baseline` | BaselineSnapshot | yes | yes | Baseline scores and metadata. `null` if baseline not yet captured. |
| `capacity` | CapacityReport | yes | no | Token counts, utilization, headroom, tier breakdown. |
| `tokenizer` | TokenizerMetadata | yes | no | Active tokenizer name, accuracy, error bound, model family. |
| `embeddingMode` | string | yes | no | `"embeddings"` or `"trigrams"`. |
| `segments` | SegmentScore[] | yes | no | Per-segment scores, ordered by composite ascending (weakest first). Empty array if zero segments. |
| `groups` | GroupScore[] | yes | no | Per-group aggregate scores, ordered by composite ascending. Empty array if no groups. |
| `continuity` | ContinuitySummary | yes | no | Eviction/compaction/restoration summary. |
| `trend` | TrendData | yes | yes | Comparison against previous report. `null` on first report. |
| `patterns` | DetectionResult | yes | no | Active degradation patterns with severity, explanation, and remediation. |
| `task` | TaskSummary | yes | no | Current task state summary. |

**Why `composite` is nullable:** A window with zero active segments has no meaningful quality (cl-spec-002 invariant 4). All dimension scores are undefined, and the composite is undefined. Rather than emit a misleading 0 or 1, the report emits `null`. Consumers must handle this case — typically by displaying "no data" rather than a score.

**Why `baseline` is nullable:** The baseline is captured after seeds, before the first add (cl-spec-002 section 7). Before that point, there is no baseline. `null` tells the consumer that normalization has not occurred — `windowScores` and `rawScores` are identical.

### 3.2 Empty Window Report

When `segmentCount` is 0:

- `windowScores`: all fields `null` (no scores are meaningful)
- `rawScores`: all fields `null`
- `composite`: `null`
- `segments`: `[]`
- `groups`: `[]`
- `continuity`: populated (the ledger may have history from evicted segments)
- `trend`: `null` (or populated if previous reports exist)
- `patterns`: `patternCount: 0`, `patterns: []`, `highestSeverity: null`
- `task`: populated (task state is independent of segment count)

This means WindowScores fields must be nullable in the empty-window case. See section 6.1.

---

## 4. DiagnosticSnapshot Schema

The DiagnosticSnapshot is the complete diagnostic state of a context-lens instance, returned by `getDiagnostics()` (cl-spec-010 section 2). It includes the latest quality report, report history, pattern history, session timeline, performance metrics, and provider state.

### 4.1 Top-Level Fields

| Field | JSON type | Required | Nullable | Description |
|-------|-----------|----------|----------|-------------|
| `schemaVersion` | string | yes | no | Schema version (section 2.3). |
| `timestamp` | number | yes | no | When the snapshot was assembled (epoch ms). |
| `sessionDuration` | number | yes | no | Milliseconds since instance construction. |
| `latestReport` | QualityReport | yes | yes | Most recent quality report from `assess()`. `null` if `assess()` has not been called. |
| `reportHistory` | ReportHistorySummary | yes | no | Report retention and rolling trend analysis. |
| `patternSummary` | PatternSummary | yes | no | Session-level pattern tracking. |
| `timeline` | TimelineEntry[] | yes | no | Chronological event log, most recent last. |
| `performance` | PerformanceSummary | yes | no | Timing aggregation and cache metrics. |
| `providers` | ProviderSummary | yes | no | Tokenizer and embedding provider state. |
| `segmentCount` | integer | yes | no | Current active segment count. |
| `groupCount` | integer | yes | no | Current group count. |
| `evictedCount` | integer | yes | no | Current evicted (but retained) segment count. |
| `taskState` | TaskState | yes | no | Full task lifecycle state. |
| `continuityLedger` | ContinuityEvent[] | yes | no | Full continuity audit trail. |
| `warnings` | Warning[] | yes | no | Active warnings. |

**Nested QualityReport.** The `latestReport` field contains a full QualityReport — the same structure defined in section 3. This means the DiagnosticSnapshot schema includes the QualityReport schema by reference. The nested report carries its own `schemaVersion`, which always matches the outer `schemaVersion` (same library, same serialization pass).

---

## 5. EvictionPlan Schema

The EvictionPlan is the output of `planEviction()` (cl-spec-008 section 4). It contains ranked eviction candidates, projected quality impact, and plan metadata.

### 5.1 Top-Level Fields

| Field | JSON type | Required | Nullable | Description |
|-------|-----------|----------|----------|-------------|
| `schemaVersion` | string | yes | no | Schema version (section 2.3). |
| `planId` | string | yes | no | Auto-generated unique identifier. |
| `timestamp` | number | yes | no | When the plan was generated (epoch ms). |
| `strategy` | StrategyName | yes | no | Which strategy produced this plan. Never `"auto"` — always the resolved strategy. |
| `target` | PlanTarget | yes | no | The reclamation target as requested. |
| `candidates` | EvictionCandidate[] | yes | no | Ordered list of eviction candidates, best first. |
| `candidateCount` | integer | yes | no | Length of `candidates`. |
| `totalReclaimable` | integer | yes | no | Sum of token counts across all candidates. |
| `targetMet` | boolean | yes | no | Whether `totalReclaimable >= target.tokens`. |
| `shortfall` | integer | yes | no | `target.tokens - totalReclaimable` if `targetMet` is false, otherwise 0. |
| `seedsIncluded` | boolean | yes | no | Whether any seed-protected candidates appear in the plan. |
| `exhausted` | boolean | yes | no | Whether all evictable candidates were included (no more available). |
| `qualityImpact` | ProjectedQualityImpact | yes | no | Projected window-level scores if all candidates are evicted. |
| `patterns` | PatternName[] | yes | no | Active degradation patterns at plan generation time. |
| `reportId` | string | yes | no | The quality report ID this plan was derived from. |

---

## 6. Shared Type Definitions

This section defines every named type referenced by the three top-level output schemas. Types are organized by domain. Each type is defined with its fields, JSON types, required/nullable status, and constraints. These definitions are normative — the JSON Schema files generated from them must enforce these constraints.

### 6.1 Quality Types

#### WindowScores

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `coherence` | number | yes | yes | [0.0, 1.0] when non-null | Window coherence score. `null` in empty-window reports. |
| `density` | number | yes | yes | [0.0, 1.0] when non-null | Window density score. `null` in empty-window reports. |
| `relevance` | number | yes | yes | [0.0, 1.0] when non-null | Window relevance score. `null` in empty-window reports. |
| `continuity` | number | yes | yes | [0.0, 1.0] when non-null | Window continuity score. `null` in empty-window reports. |

**Why nullable:** An empty window (zero active segments) has no meaningful scores (cl-spec-002 invariant 4). Rather than emit 0.0 (which implies low quality) or 1.0 (which implies perfect quality), the fields are `null`. Consumers must distinguish "no segments, no scores" from "low scores."

#### BaselineSnapshot

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `coherence` | number | yes | no | [0.0, 1.0] | Coherence at baseline capture. |
| `density` | number | yes | no | [0.0, 1.0] | Density at baseline capture. |
| `relevance` | number | yes | no | [0.0, 1.0] | Relevance at baseline capture. |
| `continuity` | number | yes | no | | Always 1.0. |
| `capturedAt` | number | yes | no | | Timestamp (epoch ms) of baseline capture. |
| `segmentCount` | integer | yes | no | ≥ 1 | Segments at baseline capture. |
| `tokenCount` | integer | yes | no | ≥ 1 | Total tokens at baseline capture. |

#### SegmentScore

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `segmentId` | string | yes | no | non-empty | Segment identifier. |
| `coherence` | number | yes | no | [0.0, 1.0] | Per-segment coherence score. |
| `density` | number | yes | no | [0.0, 1.0] | Per-segment density score. |
| `relevance` | number | yes | no | [0.0, 1.0] | Per-segment relevance score. |
| `continuity` | number | yes | no | [0.0, 1.0] | Per-segment continuity score. |
| `composite` | number | yes | no | [0.0, 1.0] | Per-segment composite score. |
| `tokenCount` | integer | yes | no | ≥ 0 | Segment token count. |
| `redundancy` | RedundancyInfo | yes | yes | | Redundancy details if redundancy > 0.5. `null` otherwise. |
| `groupId` | string | yes | yes | | Group membership. `null` if ungrouped. |

#### RedundancyInfo

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `maxSimilarity` | number | yes | no | [0.0, 1.0] | Highest similarity to any non-adjacent segment. |
| `mostSimilarSegmentId` | string | yes | no | non-empty | The segment this one is most redundant with. |
| `sameOrigin` | boolean | yes | no | | Whether the most similar segment shares the same origin. |

#### GroupScore

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `groupId` | string | yes | no | non-empty | Group identifier. |
| `memberCount` | integer | yes | no | ≥ 1 | Number of members. |
| `totalTokens` | integer | yes | no | ≥ 0 | Sum of member token counts. |
| `groupCoherence` | number | yes | no | [0.0, 1.0] | Intra-group coherence. |
| `meanRelevance` | number | yes | no | [0.0, 1.0] | Token-weighted mean of member relevance scores. |
| `meanDensity` | number | yes | no | [0.0, 1.0] | Token-weighted mean of member density scores. |
| `composite` | number | yes | no | [0.0, 1.0] | Per-group composite. |
| `integrityWarning` | boolean | yes | no | | True if `groupCoherence < 0.3`. |

#### ContinuitySummary

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `totalEvictions` | integer | yes | no | ≥ 0 | Total segments evicted in this session. |
| `totalCompactions` | integer | yes | no | ≥ 0 | Total segments compacted. |
| `totalRestorations` | integer | yes | no | ≥ 0 | Total segments restored. |
| `netLoss` | number | yes | no | [0.0, 1.0] | Current net information loss. |
| `tokensEvicted` | integer | yes | no | ≥ 0 | Total tokens reclaimed by eviction. |
| `tokensCompacted` | integer | yes | no | ≥ 0 | Total tokens reduced by compaction. |
| `tokensRestored` | integer | yes | no | ≥ 0 | Total tokens restored. |
| `recentEvents` | ContinuityEvent[] | yes | no | max 10 | Last 10 events with timestamps. |

#### ContinuityEvent

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `type` | string | yes | no | enum: `"eviction"`, `"compaction"`, `"restoration"` | Event type. |
| `segmentId` | string | yes | no | non-empty | Affected segment. |
| `timestamp` | number | yes | no | | When the event occurred (epoch ms). |
| `tokensBefore` | integer | yes | no | ≥ 0 | Token count before the operation. |
| `tokensAfter` | integer | yes | no | ≥ 0 | Token count after (0 for eviction, reduced for compaction, restored for restoration). |
| `cost` | number | yes | no | [0.0, 1.0] | Continuity cost of this event. |
| `fidelity` | number | yes | yes | [0.0, 1.0] when non-null | Restoration fidelity. `null` for eviction and compaction events. |

#### TrendData

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `previousReportId` | string | yes | no | | ID of the report being compared against. |
| `timeDelta` | number | yes | no | > 0 | Milliseconds between reports. |
| `coherenceDelta` | number | yes | no | [-1.0, 1.0] | Change in window coherence. |
| `densityDelta` | number | yes | no | [-1.0, 1.0] | Change in window density. |
| `relevanceDelta` | number | yes | no | [-1.0, 1.0] | Change in window relevance. |
| `continuityDelta` | number | yes | no | [-1.0, 1.0] | Change in window continuity. |
| `compositeDelta` | number | yes | no | [-1.0, 1.0] | Change in composite score. |
| `segmentCountDelta` | integer | yes | no | | Change in segment count. |
| `tokensDelta` | integer | yes | no | | Change in total active tokens. |

### 6.2 Capacity Types

#### CapacityReport

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `capacity` | integer | yes | no | ≥ 1 | Configured maximum tokens. |
| `totalActiveTokens` | integer | yes | no | ≥ 0 | Sum of all active segment token counts. |
| `utilization` | number | yes | no | ≥ 0.0 | `totalActiveTokens / capacity`. Can exceed 1.0. |
| `headroom` | integer | yes | no | | `capacity - totalActiveTokens`. May be negative. |
| `pinnedTokens` | integer | yes | no | ≥ 0 | Tokens locked by pinned segments. |
| `seedTokens` | integer | yes | no | ≥ 0 | Tokens in seed-protected segments. |
| `managedTokens` | integer | yes | no | ≥ 0 | Tokens in priority + default segments. |
| `availableCapacity` | integer | yes | no | ≥ 0 | `capacity - pinnedTokens`. |

### 6.3 Detection Types

#### DetectionResult

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `patterns` | ActivePattern[] | yes | no | | Currently active patterns, ordered by priority. |
| `patternCount` | integer | yes | no | ≥ 0 | Number of active patterns. |
| `highestSeverity` | Severity | yes | yes | | Highest severity among active patterns. `null` if none active. |
| `preBaseline` | boolean | yes | no | | True if detection ran on raw (non-normalized) scores. |

#### ActivePattern

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `name` | PatternName | yes | no | | Pattern identifier. |
| `severity` | Severity | yes | no | | Current severity level. |
| `activatedAt` | number | yes | no | | When this pattern first became active (epoch ms). |
| `currentSince` | number | yes | no | | When the pattern reached its current severity (epoch ms). |
| `duration` | number | yes | no | ≥ 0 | Milliseconds since `activatedAt`. |
| `trending` | Trend | yes | no | | Score trend direction. |
| `signature` | PatternSignature | yes | no | | Scores and signals that activated this pattern. |
| `explanation` | string | yes | no | | Human-readable diagnostic. |
| `remediation` | RemediationHint[] | yes | no | | Suggestions ordered by estimated impact. |
| `compoundContext` | CompoundContext | yes | yes | | Present when this pattern participates in a known compound. `null` otherwise. |

#### PatternSignature

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `primaryScore` | ScoreRef | yes | no | | The primary dimension score that triggered activation. |
| `secondaryScores` | ScoreRef[] | yes | no | | Additional scores contributing to the diagnosis. |
| `utilization` | number | yes | yes | [0.0, ∞) when non-null | Utilization at detection time. `null` when not relevant. |
| `thresholdCrossed` | ThresholdRef | yes | no | | Which threshold was crossed to reach current severity. |

#### ScoreRef

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `dimension` | string | yes | no | | Dimension name (e.g., `"coherence"`, `"utilization"`). |
| `value` | number | yes | no | | Score value at detection time. |

#### ThresholdRef

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `severity` | Severity | yes | no | | Which severity threshold was crossed. |
| `threshold` | number | yes | no | | The threshold value that was crossed. |

#### RemediationHint

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `action` | RemediationAction | yes | no | | What the caller should do. |
| `target` | string | yes | yes | | Specific segment IDs, group IDs, or protection tiers. `null` for general suggestions. |
| `estimatedImpact` | string | yes | yes | | Human-readable impact estimate. `null` when impact cannot be estimated. |
| `description` | string | yes | no | | Human-readable explanation. |

#### CompoundContext

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `compound` | CompoundName | yes | no | | Compound pattern identifier. |
| `coPatterns` | PatternName[] | yes | no | ≥ 1 element | The other patterns in this compound. |
| `diagnosis` | string | yes | no | | Human-readable compound diagnosis. |
| `remediationShift` | string | yes | no | | How remediation priority changes under this compound. |

### 6.4 Task Types

#### TaskDescriptor

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `description` | string | yes | no | non-empty, max 2000 chars | Free-text task description (normalized). |
| `keywords` | string[] | yes | no | max 50 elements | Key terms. Empty array if none. |
| `relatedOrigins` | string[] | yes | no | | Origin values relevant to this task. Empty array if none. |
| `relatedTags` | string[] | yes | no | | Segment tags relevant to this task. Empty array if none. |

#### TaskSummary

Lightweight task state for inclusion in QualityReport.

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `state` | TaskLifecycleState | yes | no | | `"unset"` or `"active"`. |
| `stale` | boolean | yes | no | | True if 5+ quality reports without a `setTask` call. |
| `gracePeriodActive` | boolean | yes | no | | True if within the 2-report grace period. |
| `gracePeriodRemaining` | integer | yes | no | 0, 1, or 2 | Reports remaining in grace period. |

#### TaskTransition

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `type` | TransitionType | yes | no | | Classification of the transition. |
| `similarity` | number | yes | yes | [0.0, 1.0] when non-null | Similarity between old and new task descriptions. `null` for new tasks. |
| `previousTask` | TaskDescriptor | yes | yes | | The task that was replaced. `null` for new tasks. |

#### TaskState

Full task lifecycle state for inclusion in DiagnosticSnapshot.

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `state` | TaskLifecycleState | yes | no | | `"unset"` or `"active"`. |
| `currentTask` | TaskDescriptor | yes | yes | | Current task descriptor. `null` if unset. |
| `previousTask` | TaskDescriptor | yes | yes | | Previous task descriptor. `null` if no prior transition. |
| `taskSetAt` | number | yes | yes | | Timestamp (epoch ms) when the current task was set. `null` if unset. |
| `transitionCount` | integer | yes | no | ≥ 0 | Total state-changing transitions. |
| `changeCount` | integer | yes | no | ≥ 0 | Transitions classified as task changes. |
| `refinementCount` | integer | yes | no | ≥ 0 | Transitions classified as refinements. |
| `reportsSinceSet` | integer | yes | no | ≥ 0 | Reports since last `setTask` call. |
| `reportsSinceTransition` | integer | yes | no | ≥ 0 | Reports since last real transition. |
| `lastTransition` | TaskTransition | yes | yes | | Most recent transition. `null` if no transitions. |
| `stale` | boolean | yes | no | | True if `reportsSinceSet ≥ 5`. |
| `gracePeriodActive` | boolean | yes | no | | True during the 2-report grace period. |
| `gracePeriodRemaining` | integer | yes | no | 0, 1, or 2 | Grace period countdown. |
| `transitionHistory` | TransitionEntry[] | yes | no | | Chronological history of task transitions. |

TransitionEntry is defined in cl-spec-004 section 5.4 with fields: `type` (TransitionType), `timestamp` (number), `similarity` (number, present for change/refinement), `previousDescription` (string, truncated), `newDescription` (string, truncated).

### 6.5 Eviction Types

#### PlanTarget

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `tokens` | integer | yes | no | ≥ 1 | Number of tokens to reclaim. |
| `utilizationBefore` | number | yes | no | ≥ 0.0 | Utilization at plan generation time. |
| `utilizationAfter` | number | yes | no | ≥ 0.0 | Projected utilization after full plan execution. |

#### EvictionCandidate

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `id` | string | yes | no | non-empty | Segment ID or group ID. |
| `type` | string | yes | no | enum: `"segment"`, `"group"` | Whether individual segment or atomic group. |
| `tokenCount` | integer | yes | no | ≥ 0 | Tokens reclaimed by evicting this candidate. |
| `cumulativeTokens` | integer | yes | no | ≥ 0 | Running total of tokens reclaimed up to and including this candidate. |
| `evictionScore` | number | yes | no | [0.0, 1.0] | Ranking model score. Lower = better candidate. |
| `tier` | string | yes | no | | Protection tier: `"default"`, `"priority(N)"`, or `"seed"`. |
| `importance` | number | yes | no | [0.0, 1.0] | Segment importance. |
| `scores` | CandidateScores | yes | no | | Quality scores that drove the ranking. |
| `impact` | CandidateImpact | yes | no | | Projected quality impact of evicting this candidate. |
| `recommendation` | string | yes | no | enum: `"evict"`, `"compact"` | Whether eviction or compaction is recommended. |
| `compaction` | CompactionRecommendation | yes | yes | | Compaction details if `recommendation` is `"compact"`. `null` if eviction. For group candidates, this is an array (see note). |
| `memberIds` | string[] | yes | yes | | For group candidates, the ordered list of member IDs. `null` for individual segments. |
| `reason` | string | yes | no | | Human-readable explanation. |

**Note on group compaction:** For group candidates with `recommendation: "compact"`, the `compaction` field contains an array of CompactionRecommendation objects (one per member). For individual segment candidates, it is a single CompactionRecommendation object. The JSON type is `CompactionRecommendation | CompactionRecommendation[] | null`. Consumers should check the `type` field to determine the shape.

**JSON Schema pattern for compaction polymorphism:** For JSON Schema, use a conditional: `if` the `type` field equals `"group"`, `then` `compaction` is `array of CompactionRecommendation | null`; otherwise `CompactionRecommendation | null`.

#### CandidateScores

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `relevance` | number | yes | no | [0.0, 1.0] | Per-segment relevance score at plan time. |
| `density` | number | yes | no | [0.0, 1.0] | Per-segment density score. |
| `coherenceContribution` | number | yes | no | [0.0, 1.0] | Bridge score. |
| `redundancy` | number | yes | no | [0.0, 1.0] | `1.0 - density`. |

#### CandidateImpact

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `coherenceDelta` | number | yes | no | | Estimated change in window coherence. Negative = degradation. |
| `densityDelta` | number | yes | no | | Estimated change in window density. |
| `relevanceDelta` | number | yes | no | | Estimated change in window relevance. |
| `continuityDelta` | number | yes | no | ≤ 0 | Estimated change in continuity. Always ≤ 0. |
| `compositeDelta` | number | yes | no | | Estimated change in composite score. |

#### ProjectedQualityImpact

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `coherence` | number | yes | no | [0.0, 1.0] | Projected window coherence after full plan execution. |
| `density` | number | yes | no | [0.0, 1.0] | Projected window density. |
| `relevance` | number | yes | no | [0.0, 1.0] | Projected window relevance. |
| `continuity` | number | yes | no | [0.0, 1.0] | Projected window continuity. |
| `composite` | number | yes | no | [0.0, 1.0] | Projected composite score. |

#### CompactionRecommendation

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `segmentId` | string | yes | no | non-empty | The segment to compact. |
| `currentTokens` | integer | yes | no | ≥ 1 | Current token count. |
| `estimatedTargetTokens` | integer | yes | no | ≥ 1 | Estimated token count after compaction. |
| `estimatedSavings` | integer | yes | no | ≥ 1 | Tokens expected to reclaim. |
| `compressionRatio` | number | yes | no | (0.0, 1.0) | `estimatedTargetTokens / currentTokens`. |
| `continuityCost` | number | yes | no | [0.0, 1.0] | Estimated continuity cost of compaction. |
| `reason` | string | yes | no | | Why compaction is recommended over eviction. |

### 6.6 Diagnostic Types

#### ReportHistorySummary

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `reports` | ReportSummary[] | yes | no | max 20 | Retained report summaries, oldest first. |
| `rollingTrend` | RollingTrend | yes | yes | | Rolling trend analysis. `null` if fewer than 2 reports. |

#### ReportSummary

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `reportId` | string | yes | no | | Report identifier. |
| `timestamp` | number | yes | no | | When the report was generated (epoch ms). |
| `windowScores` | WindowScores | yes | no | | Window-level scores at report time. |
| `composite` | number | yes | yes | [0.0, 1.0] when non-null | Composite score. `null` if zero segments. |
| `segmentCount` | integer | yes | no | ≥ 0 | Active segments at report time. |
| `totalActiveTokens` | integer | yes | no | ≥ 0 | Token usage at report time. |
| `utilization` | number | yes | no | ≥ 0.0 | Utilization at report time. |
| `patternCount` | integer | yes | no | ≥ 0 | Active patterns at report time. |
| `highestSeverity` | Severity | yes | yes | | Highest pattern severity. `null` if no patterns. |
| `embeddingMode` | string | yes | no | enum: `"embeddings"`, `"trigrams"` | Similarity mode used. |
| `anomalies` | AnomalyFlag[] | yes | no | | Dimensions with anomalous change. Empty if no anomalies. |

#### AnomalyFlag

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `dimension` | string | yes | no | enum: `"coherence"`, `"density"`, `"relevance"`, `"continuity"`, `"composite"` | Which dimension. |
| `delta` | number | yes | no | abs > 0.15 | Signed change. |
| `likelyCause` | string | yes | yes | enum when non-null: `"taskChange"`, `"bulkEviction"`, `"providerSwitch"`, `"bulkAdd"` | Best-effort attribution. `null` if no single cause identified. |

#### RollingTrend

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `window` | integer | yes | no | [2, 5] | Number of reports in the rolling window. |
| `coherence` | TrendLine | yes | no | | Coherence trend. |
| `density` | TrendLine | yes | no | | Density trend. |
| `relevance` | TrendLine | yes | no | | Relevance trend. |
| `continuity` | TrendLine | yes | no | | Continuity trend. |
| `composite` | TrendLine | yes | no | | Composite trend. |

#### TrendLine

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `direction` | TrendDirection | yes | no | | `"improving"`, `"stable"`, or `"degrading"`. |
| `averageRate` | number | yes | no | | Average per-report delta. Positive = improving. |
| `current` | number | yes | no | [0.0, 1.0] | Most recent score. |
| `windowMin` | number | yes | no | [0.0, 1.0] | Lowest score in the window. |
| `windowMax` | number | yes | no | [0.0, 1.0] | Highest score in the window. |
| `volatility` | number | yes | no | ≥ 0.0 | Standard deviation of deltas. |

#### PatternSummary

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `activePatterns` | ActivePattern[] | yes | no | | Currently active patterns. |
| `totalActivations` | integer | yes | no | ≥ 0 | Total activations in this session. |
| `totalResolutions` | integer | yes | no | ≥ 0 | Total resolutions. |
| `perPattern` | object | yes | no | | Map of PatternName → PatternStats. |
| `history` | PatternHistoryEntry[] | yes | no | max 50 | Chronological log, most recent last. |

**`perPattern` encoding:** In JSON, this is an object where each key is a PatternName string and each value is a PatternStats object. Only patterns that have been active at least once appear as keys.

#### PatternStats

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `activationCount` | integer | yes | no | ≥ 0 | How many times this pattern has activated. |
| `totalActiveTime` | number | yes | no | ≥ 0 | Cumulative milliseconds active. |
| `peakSeverity` | Severity | yes | no | | Highest severity reached. |
| `currentState` | string | yes | no | enum: `"active"`, `"inactive"` | Current state. |
| `currentSeverity` | Severity | yes | yes | | Current severity if active. `null` if inactive. |
| `lastActivation` | number | yes | yes | | Timestamp of most recent activation. `null` if never activated. |
| `lastResolution` | number | yes | yes | | Timestamp of most recent resolution. `null` if never resolved. |
| `recurrenceCount` | integer | yes | no | ≥ 0 | Re-activations after previous resolution. |

#### PatternHistoryEntry

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `name` | PatternName | yes | no | | Which pattern. |
| `event` | string | yes | no | enum: `"activated"`, `"escalated"`, `"deescalated"`, `"resolved"` | Lifecycle event. |
| `severity` | Severity | yes | no | | Severity at event time. |
| `timestamp` | number | yes | no | | When the event occurred (epoch ms). |
| `reportId` | string | yes | no | | Which quality report triggered this event. |
| `score` | number | yes | no | | The primary score that drove the event. |
| `compoundContext` | string | yes | yes | | Compound pattern name if active during compound. `null` otherwise. |

#### TimelineEntry

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `timestamp` | number | yes | no | | When the event occurred (epoch ms). |
| `sequence` | integer | yes | no | ≥ 0 | Monotonically increasing sequence number for stable ordering. |
| `type` | TimelineEventType | yes | no | | Event classification. |
| `detail` | object | yes | no | | Event-specific payload (structure varies by type). |

**`detail` encoding:** The `detail` object is polymorphic — its shape depends on the `type` field. Each TimelineEventType (section 7) has a defined detail structure. Consumers should switch on `type` to interpret `detail`. The JSON Schema uses a discriminated union (`if`/`then` on the `type` field) to validate each detail shape.

**Detail structures by event type:**

| Type | Detail fields |
|------|--------------|
| `segmentAdded` | `{ segmentId: string, tokenCount: integer, protection: string, origin: string \| null }` |
| `segmentUpdated` | `{ segmentId: string, contentChanged: boolean, fieldsChanged: string[] }` |
| `segmentReplaced` | `{ segmentId: string, oldTokenCount: integer, newTokenCount: integer }` |
| `segmentCompacted` | `{ segmentId: string, oldTokenCount: integer, newTokenCount: integer, compressionRatio: number }` |
| `segmentSplit` | `{ originalId: string, childIds: string[], childCount: integer }` |
| `segmentEvicted` | `{ segmentId: string, tokenCount: integer, protection: string, evictionCost: number, reason: string \| null }` |
| `segmentRestored` | `{ segmentId: string, tokenCount: integer, fidelity: number }` |
| `groupCreated` | `{ groupId: string, memberCount: integer }` |
| `groupDissolved` | `{ groupId: string, memberCount: integer }` |
| `taskSet` | `{ classification: TransitionType, similarity: number \| null, descriptionPreview: string }` |
| `taskCleared` | `{ previousDescriptionPreview: string }` |
| `baselineCaptured` | `{ segmentCount: integer, totalTokens: integer, scores: WindowScores }` |
| `reportGenerated` | `{ reportId: string, composite: number \| null, highestSeverity: Severity \| null, patternCount: integer }` |
| `patternActivated` | `{ name: PatternName, severity: Severity, primaryScore: number }` |
| `patternEscalated` | `{ name: PatternName, fromSeverity: Severity, toSeverity: Severity }` |
| `patternDeescalated` | `{ name: PatternName, fromSeverity: Severity, toSeverity: Severity }` |
| `patternResolved` | `{ name: PatternName, peakSeverity: Severity, duration: number }` |
| `tokenizerChanged` | `{ previousName: string, newName: string, segmentsRecounted: integer }` |
| `embeddingProviderChanged` | `{ previousMode: string, newMode: string, segmentsReembedded: integer }` |
| `capacityChanged` | `{ previousCapacity: integer, newCapacity: integer, newUtilization: number }` |
| `budgetViolation` | `{ operation: string, selfTime: number, budgetTarget: number, segmentCount: integer }` |
| `customPatternRegistered` | `{ name: string, thresholds: object }` |
| `stateSnapshotted` | `{ snapshotId: string, segmentCount: integer, totalTokens: integer }` |
| `stateRestored` | `{ snapshotId: string, segmentCount: integer, totalTokens: integer }` |
| `lateSeeding` | `{ segmentId: string, tokenCount: integer, reportsSinceBaseline: integer }` |
| `pinnedCeilingWarning` | `{ pinnedTokens: integer, capacity: integer, pinnedRatio: number }` |

#### PerformanceSummary

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `operationTimings` | object | yes | no | | Map of operation name → OperationTiming. |
| `caches` | CacheReport | yes | no | | Aggregated cache metrics. |
| `sessionSelfTime` | number | yes | no | ≥ 0 | Total selfTime across all operations (ms). |
| `sessionProviderTime` | number | yes | no | ≥ 0 | Total providerTime across all operations (ms). |
| `budgetViolationCount` | integer | yes | no | ≥ 0 | Total budget violations in the session. |

**`operationTimings` encoding:** An object where each key is an operation name string (e.g., `"add"`, `"assess"`, `"planEviction"`) and each value is an OperationTiming object. Only operations that have been invoked appear as keys.

#### OperationTiming

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `count` | integer | yes | no | ≥ 1 | Total invocations. |
| `totalSelfTime` | number | yes | no | ≥ 0 | Cumulative selfTime (ms). |
| `totalProviderTime` | number | yes | no | ≥ 0 | Cumulative providerTime (ms). |
| `averageSelfTime` | number | yes | no | ≥ 0 | Mean selfTime per invocation. |
| `maxSelfTime` | number | yes | no | ≥ 0 | Worst-case selfTime. |
| `p95SelfTime` | number | yes | no | ≥ 0 | 95th percentile selfTime. |
| `budgetTarget` | number | yes | no | > 0 | Budget target at current segment count (ms). |
| `budgetViolations` | integer | yes | no | ≥ 0 | Invocations where selfTime exceeded budget. |
| `withinBudgetRate` | number | yes | no | [0.0, 1.0] | Fraction of invocations within budget. |

#### CacheReport

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `tokenCache` | CacheMetrics | yes | no | | Token count cache metrics. |
| `embeddingCache` | CacheMetrics | yes | no | | Embedding/trigram cache metrics. |
| `similarityCache` | CacheMetrics | yes | no | | Similarity score cache metrics. |

#### CacheMetrics

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `hits` | integer | yes | no | ≥ 0 | Total cache hits. |
| `misses` | integer | yes | no | ≥ 0 | Total cache misses. |
| `hitRate` | number | yes | yes | [0.0, 1.0] when non-null | `hits / (hits + misses)`. `null` if no lookups (0/0). |
| `currentEntries` | integer | yes | no | ≥ 0 | Current entries in cache. |
| `maxEntries` | integer | yes | no | ≥ 1 | Maximum cache capacity. |
| `utilization` | number | yes | no | [0.0, 1.0] | `currentEntries / maxEntries`. |
| `evictions` | integer | yes | no | ≥ 0 | Total LRU evictions. |

#### ProviderSummary

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `tokenizer` | TokenizerInfo | yes | no | | Current tokenizer state. |
| `embedding` | EmbeddingInfo | yes | no | | Current embedding provider state. |

#### TokenizerInfo

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `name` | string | yes | no | non-empty | Provider name. |
| `accuracy` | string | yes | no | enum: `"exact"`, `"approximate"` | Counting accuracy. |
| `modelFamily` | string | yes | yes | | Target model family. `null` if model-agnostic. |
| `errorBound` | number | yes | yes | > 0 when non-null | Maximum expected relative error. `null` for exact providers. |
| `switchCount` | integer | yes | no | ≥ 0 | Tokenizer changes this session. |

#### EmbeddingInfo

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `mode` | string | yes | no | enum: `"embeddings"`, `"trigrams"` | Current similarity mode. |
| `providerName` | string | yes | yes | | Provider name. `null` in trigram mode. |
| `dimensions` | integer | yes | yes | ≥ 1 when non-null | Vector dimensions. `null` in trigram mode. |
| `modelFamily` | string | yes | yes | | Provider's model family. `null` in trigram mode. |
| `switchCount` | integer | yes | no | ≥ 0 | Provider changes this session. |
| `lastSwitchAt` | number | yes | yes | | Timestamp of most recent switch. `null` if no switches. |

#### Warning

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `message` | string | yes | no | non-empty | Warning text. Deduplicated by this field. |
| `source` | string | yes | no | non-empty | Which subsystem produced the warning. |
| `timestamp` | number | yes | no | | When the warning was first generated (epoch ms). |

### 6.7 Provider Types

#### TokenizerMetadata

| Field | JSON type | Required | Nullable | Constraints | Description |
|-------|-----------|----------|----------|-------------|-------------|
| `name` | string | yes | no | non-empty | Provider name. |
| `accuracy` | string | yes | no | enum: `"exact"`, `"approximate"` | Counting accuracy. |
| `modelFamily` | string | yes | yes | | Target model family. `null` if model-agnostic. |
| `errorBound` | number | yes | yes | > 0 when non-null | Maximum expected relative error. `null` for exact. |

---

## 7. Enum Definitions

All string enums used across the output schemas. In JSON Schema, each is defined as a `string` type with an `enum` constraint listing the valid values.

### 7.1 Severity

Detection severity levels (cl-spec-003 section 2.4).

Values: `"watch"`, `"warning"`, `"critical"`

Ordered from mildest to most severe. The ordering is semantic, not lexicographic.

### 7.2 PatternName

Base degradation pattern identifiers (cl-spec-003 sections 3–7).

Values: `"saturation"`, `"erosion"`, `"fracture"`, `"gap"`, `"collapse"`

**Extensibility note:** When custom pattern registration is implemented (cl-spec-003 amendment, planned), custom pattern names will appear in pattern-name positions. Custom names are validated to not collide with base names. For schema purposes, the PatternName enum in the base schema contains only the five base names. Custom pattern names are valid strings but do not appear in the enum constraint — consumers should accept unknown pattern names gracefully.

### 7.3 Trend

Pattern score trend direction (cl-spec-003 section 2.3).

Values: `"worsening"`, `"stable"`, `"improving"`

### 7.4 TrendDirection

Rolling trend direction for quality dimension trends (cl-spec-010 section 3.2).

Values: `"improving"`, `"stable"`, `"degrading"`

**Why two trend enums:** Trend (7.3) is used in pattern context where "worsening" means the pattern condition is getting worse. TrendDirection (7.4) is used in quality dimension context where "degrading" means the score is declining. The vocabulary differs because the semantic frame differs — a "worsening" pattern is a bad thing getting worse, while a "degrading" dimension is a good thing getting worse. Using a single enum would force awkward phrasing in one context or the other.

### 7.5 StrategyName

Eviction planning strategy identifiers (cl-spec-008 section 5.1).

Values: `"auto"`, `"default"`, `"saturation"`, `"erosion"`, `"gap"`, `"collapse"`

**Note:** `"auto"` never appears in an EvictionPlan's `strategy` field — it is always resolved to one of the other values (cl-spec-008 section 5.1). It is included in the enum because it is a valid input value that consumers may encounter in other contexts (e.g., configuration).

### 7.6 TimelineEventType

Session timeline event classifications (cl-spec-010 section 5.2).

Values: `"segmentAdded"`, `"segmentUpdated"`, `"segmentReplaced"`, `"segmentCompacted"`, `"segmentSplit"`, `"segmentEvicted"`, `"segmentRestored"`, `"groupCreated"`, `"groupDissolved"`, `"taskSet"`, `"taskCleared"`, `"baselineCaptured"`, `"reportGenerated"`, `"patternActivated"`, `"patternEscalated"`, `"patternDeescalated"`, `"patternResolved"`, `"tokenizerChanged"`, `"embeddingProviderChanged"`, `"capacityChanged"`, `"budgetViolation"`, `"customPatternRegistered"`, `"stateSnapshotted"`, `"stateRestored"`, `"lateSeeding"`, `"pinnedCeilingWarning"`

26 values. Each has a defined detail structure (section 6.6, TimelineEntry).

### 7.7 TaskLifecycleState

Task identity lifecycle states (cl-spec-004 section 4.4).

Values: `"unset"`, `"active"`

### 7.8 TransitionType

Task transition classifications (cl-spec-007 section 5.1).

Values: `"new"`, `"refinement"`, `"change"`, `"same"`, `"clear"`

**Note:** `clear` represents clearTask transitions. `same` is returned by setTask when the new descriptor is identical to the current one (no-op).

### 7.9 CompoundName

Named compound degradation patterns (cl-spec-003 section 8.2).

Values: `"fullOfJunk"`, `"fullOfWrongThings"`, `"scatteredAndIrrelevant"`, `"lossDominates"`, `"pressureLoop"`, `"triplePressure"`

### 7.10 RemediationAction

Remediation hint action types (cl-spec-003 section 2.3).

Values: `"evict"`, `"compact"`, `"deduplicate"`, `"reorder"`, `"restore"`, `"updateTask"`, `"increaseCapacity"`

---

## 8. Serialization Conventions

This section defines how internal context-lens types map to JSON. These conventions are normative — a conforming output must follow them.

### 8.1 Timestamps

**Representation:** Number (IEEE 754 double). Milliseconds since Unix epoch (1970-01-01T00:00:00Z).

This matches the internal type used throughout specs 1–10. Timestamps are not converted to ISO 8601 strings in the schema-conforming JSON output. ISO 8601 is used only in human-formatted text (cl-spec-010 section 8.4) — a separate output path.

**Why not ISO 8601 strings:** The existing specs define timestamps as numbers throughout the internal model. Converting to strings for serialization would introduce a representation mismatch — every consumer would need to parse and convert, and every producer would need to format. Numbers are simpler, unambiguous (no timezone confusion), and directly usable for arithmetic (duration = `endTimestamp - startTimestamp`). Consumers who need human-readable timestamps can format them locally.

### 8.2 Numbers

**Score values:** IEEE 754 double-precision floating point. Serialized with sufficient decimal places to preserve the value, but no more than 6 significant digits after the decimal point. Scores that are mathematically exact (e.g., 0.0, 1.0) may be serialized as integers (0, 1) — consumers must accept both `0` and `0.0` for score fields.

**Integer values:** JSON integers. Token counts, segment counts, and other integer-typed fields are serialized as numbers without decimal points. Consumers should validate that these are whole numbers.

**NaN and Infinity:** Not valid in JSON. Fields that could mathematically produce NaN (e.g., `hitRate` when hits + misses = 0) are defined as nullable and emit `null` instead of NaN. No field in the schema produces Infinity.

**Numeric type convention.** This schema uses JSON Schema's `integer` type for fields that are semantically whole numbers (token counts, segment counts, sequence numbers) and `number` for fields that may have fractional values (scores, ratios, timestamps as epoch milliseconds). Behavioral specs (cl-spec-001 through cl-spec-010) use `number` generically, as the implementation language (JavaScript/TypeScript) does not distinguish integer and float types. The `integer` annotations in this schema are constraints, not type changes.

### 8.3 Null Handling

JSON `null` is used for three semantic cases:

1. **Not yet available.** The baseline is `null` before it is captured. The latest report is `null` before `assess()` is called.
2. **Not applicable.** Restoration fidelity is `null` for eviction events. Group membership is `null` for ungrouped segments.
3. **Undefined value.** Window scores are `null` when the window has zero segments. Cache hit rate is `null` when no lookups have occurred.

Every nullable field is explicitly marked in the type definitions (sections 3–6). A field that is not marked nullable is never `null` in conforming output.

### 8.4 Enums

All enum values are serialized as **lowercase strings** (or camelCase where defined, e.g., `"fullOfJunk"`, `"fullOfWrongThings"`). The exact casing matches the values listed in section 7. Consumers should compare enum values case-sensitively.

### 8.5 Arrays

**Ordering:** Arrays maintain their defined ordering:
- `segments` in QualityReport: ordered by composite ascending (weakest first).
- `groups` in QualityReport: ordered by composite ascending.
- `candidates` in EvictionPlan: ordered by eviction score (best candidate first).
- `patterns` in DetectionResult: ordered by priority (highest priority first).
- `timeline` in DiagnosticSnapshot: ordered by `(timestamp, sequence)`.
- `history` in PatternSummary: chronological, most recent last.
- `reports` in ReportHistorySummary: chronological, oldest first.
- `remediation` in ActivePattern: ordered by estimated impact descending.

**Empty arrays:** Optional array-valued fields use empty arrays, not `null`, to indicate "no items." A `null` array means the field is not applicable; an empty array means it is applicable but currently has no elements. In practice, all array fields in the schema are non-nullable — they use `[]` for the empty case.

### 8.6 Objects

All objects are flat or nested — no circular references. The entire output tree is a DAG (directed acyclic graph) that can be serialized to JSON without cycle-breaking. This is a structural guarantee, not just a convention — the internal data model has no circular references (segments do not reference their scores, scores do not reference the report, etc.).

**Map-typed fields** (`perPattern`, `operationTimings`) are serialized as JSON objects with string keys. The key set is dynamic (only populated entries appear). Consumers should iterate keys rather than hardcoding expected keys.

### 8.7 Defensive Copy Semantics

The schema defines the shape of a **snapshot** — a frozen observation at a point in time. Mutating a serialized output does not affect the context-lens instance (the serialized output is a value, not a reference). Two serializations of the same report may differ in `schemaVersion` if the library is upgraded between serializations, but the score values are identical if the report is the same (cl-spec-007 invariant 3).

---

## 9. Schema Distribution and Validation

### 9.1 Schema Files

The reference implementation ships **three JSON Schema files** (draft 2020-12):

| File | Describes | Root type |
|------|-----------|-----------|
| `quality-report.schema.json` | `assess()` output | QualityReport |
| `diagnostic-snapshot.schema.json` | `getDiagnostics()` output | DiagnosticSnapshot |
| `eviction-plan.schema.json` | `planEviction()` output | EvictionPlan |

Each file is self-contained — all shared type definitions are inlined as `$defs` within the file. There is no external `$ref` resolution required. This makes each schema usable independently, without a schema registry or file server.

**Why self-contained:** Consumers who receive a quality report should be able to validate it with a single schema file and no network access. External `$ref`s introduce a resolution dependency — the consumer needs access to the referenced schema file, which may live at a URL that is not reachable from the consumer's environment. Self-contained schemas are portable.

**Shared definitions are duplicated across files.** WindowScores appears in all three schema files (in QualityReport directly, in DiagnosticSnapshot via the nested QualityReport, and in EvictionPlan via ProjectedQualityImpact). This duplication is acceptable — the definitions are generated from this spec, not hand-maintained, so consistency is guaranteed by construction.

### 9.2 Programmatic Access

The reference implementation exports schema access utilities:

```
import { schemas } from 'context-lens'

schemas.qualityReport    // → the JSON Schema object for QualityReport
schemas.diagnosticSnapshot  // → the JSON Schema object for DiagnosticSnapshot
schemas.evictionPlan     // → the JSON Schema object for EvictionPlan
schemas.version          // → the current schema version string
```

These are static exports — they do not require a context-lens instance. They are the same schema objects that the JSON files contain, available in-process for consumers who import the library.

### 9.3 Serialization Utilities

The reference implementation provides serialization functions that produce schema-conforming JSON:

```
toJSON(report: QualityReport) → object
toJSON(snapshot: DiagnosticSnapshot) → object
toJSON(plan: EvictionPlan) → object
```

Overloaded on input type. Each returns a plain JavaScript object that conforms to the corresponding schema and can be passed to `JSON.stringify` without loss. The `schemaVersion` field is set automatically.

**Why a separate function, not `JSON.stringify` directly:** The internal TypeScript objects may contain non-serializable state (provider references, cached computation intermediates, internal flags). `toJSON` strips non-serializable state and produces a clean, schema-conforming plain object. Calling `JSON.stringify` on a raw internal object may produce output that does not conform to the schema.

### 9.4 Validation

A conforming output **must** validate against the corresponding schema file. The reference implementation ships a validation utility:

```
import { validate } from 'context-lens'

const result = validate.qualityReport(jsonObject)
// → { valid: boolean, errors: ValidationError[] }
```

The validator uses a JSON Schema validation library internally. Consumers in other languages can use any JSON Schema draft 2020-12 compliant validator with the schema files.

**Validation scope:** The schema validates structure (correct fields, correct types, required fields present, enum values in range, numeric constraints met). It does not validate semantics (e.g., that `utilization` equals `totalActiveTokens / capacity`, or that segment scores are correctly ordered). Semantic validation is the reference implementation's responsibility, not the schema's.

### 9.5 Schema Versioning in Practice

**Producer side:** The reference implementation generates output with `schemaVersion` set to the schema version it was built against. The producer does not negotiate schema versions — it emits what it emits.

**Consumer side:** The consumer reads the `schemaVersion` field from the output, selects the corresponding schema file, and validates. If the consumer has schema 1.2.0 and receives output with `schemaVersion: "1.4.0"`:

1. The output is forward-compatible (1.4.0 is a minor bump from 1.2.0).
2. The output will validate against the 1.2.0 schema (unknown fields are ignored, and the 1.2.0 schema does not have `additionalProperties: false`).
3. The consumer can safely parse the output using its 1.2.0 understanding, ignoring fields it does not recognize.

If the consumer receives output with `schemaVersion: "2.0.0"` but only has the 1.x schema, validation may fail. The consumer should update to the 2.0 schema.

---

## 10. Invariants and Constraints

**1. Schema conformance.** Every object returned by `toJSON()` (section 9.3) validates against the corresponding JSON Schema file. This is unconditional — there is no "relaxed mode" or "partial output." If the library produces output that does not validate, it is an implementation bug.

**2. Version consistency.** The `schemaVersion` field on every top-level output matches the version of the schema it conforms to. The `schemaVersion` on a nested QualityReport within a DiagnosticSnapshot matches the outer `schemaVersion`. There is no version mixing within a single serialization.

**3. Self-containment.** Each JSON Schema file is self-contained — no external `$ref` resolution is required. A consumer can validate output using a single schema file and a JSON Schema validator, with no network access and no additional files.

**4. Additive evolution.** Within a major version, schema changes are additive only: new optional fields, new enum values, new type definitions. No removals, no type changes, no semantic reinterpretation.

**5. Forward compatibility.** Output produced under schema version X.Y.Z validates against schema version X.W.V where W ≤ Y (same or earlier minor version within the same major). Consumers are never broken by producer upgrades within the same major version, provided they ignore unknown fields.

**6. Deterministic serialization.** The same internal state produces the same serialized output (modulo timestamp fields, which reflect wall-clock time at serialization). Field ordering within JSON objects is not guaranteed (JSON objects are unordered by specification), but field presence and values are deterministic.

**7. No circular references.** The serialized output is a tree (or DAG). No object references itself directly or transitively. `JSON.stringify` on the output of `toJSON` never throws a circular reference error.

**8. Null correctness.** A field is `null` in the output if and only if the corresponding type definition marks it as nullable (sections 3–6). A non-nullable field is never `null`. A nullable field is `null` only when the specified condition holds (e.g., baseline is `null` only before baseline capture).

**9. Enum completeness.** Every enum value that appears in the output is listed in section 7 (with the exception of custom pattern names, which are validated at registration time per cl-spec-003 amendment). A conforming output never contains an enum value that is not defined in the schema.

**10. Schema source authority.** This spec is the authoritative definition of the serialized output shape. The JSON Schema files are derived from this spec. If a JSON Schema file and this spec disagree, this spec wins — the schema file should be regenerated.

---

## 11. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-002` (Quality Model) | Defines QualityReport structure (section 9), WindowScores, SegmentScore, GroupScore, ContinuitySummary, TrendData, BaselineSnapshot, and the four quality dimensions whose scores this spec schemas. |
| `cl-spec-003` (Degradation Patterns) | Defines DetectionResult, ActivePattern, PatternSignature, RemediationHint, CompoundContext, Severity enum, PatternName enum, compound pattern names, and the detection framework whose output this spec schemas. |
| `cl-spec-004` (Task Identity) | Defines TaskDescriptor, TaskState, TaskTransition, TaskLifecycleState, TransitionType, and the task lifecycle model whose state this spec schemas. |
| `cl-spec-006` (Tokenization Strategy) | Defines CapacityReport and TokenizerMetadata, and the token counting system whose metrics this spec schemas. |
| `cl-spec-007` (API Surface) | Defines the public methods that produce the three top-level outputs: `assess()` → QualityReport, `getDiagnostics()` → DiagnosticSnapshot, `planEviction()` → EvictionPlan. Also defines the serialization utility signatures. |
| `cl-spec-008` (Eviction Advisory) | Defines EvictionPlan, EvictionCandidate, CandidateScores, CandidateImpact, ProjectedQualityImpact, CompactionRecommendation, PlanTarget, and the eviction planning system whose output this spec schemas. |
| `cl-spec-010` (Report & Diagnostics) | Defines DiagnosticSnapshot, ReportHistorySummary, ReportSummary, RollingTrend, TrendLine, AnomalyFlag, PatternSummary, PatternStats, PatternHistoryEntry, TimelineEntry, PerformanceSummary, OperationTiming, CacheReport, CacheMetrics, ProviderSummary, TokenizerInfo, EmbeddingInfo, Warning, and the diagnostic system whose state this spec schemas. |
| JSON Schema draft 2020-12 | The meta-schema standard used for the generated schema files. |
