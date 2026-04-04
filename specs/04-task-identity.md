---
id: cl-spec-004
title: Task Identity
type: design
status: draft
created: 2026-04-01
revised: 2026-04-01
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [task, identity, relevance, descriptor, transition, lifecycle, grace-period]
depends_on: [cl-spec-002]
---

# Task Identity

## Table of Contents

1. Overview
2. Task Descriptor Model
3. Task Identity and Comparison
4. Task Lifecycle
5. Task Transitions
6. Task Descriptor Preparation
7. Integration Points
8. Invariants and Constraints
9. References

---

## 1. Overview

The quality model (cl-spec-002) defines relevance as a function of how well segment content aligns with the current task. The task descriptor is the reference point — it tells context-lens what the model is working on, and every segment is scored against it. But cl-spec-002 treats the task descriptor as an input it receives and consumes. It does not define what a task *is*, how tasks relate to each other, how to detect that a task has changed, or how to manage the lifecycle of task state across a session. That is this spec's job.

**The problem task identity solves.** Without task identity, context-lens can score relevance at a single point in time but cannot reason about relevance *over time*. It cannot distinguish a task update (the user refined "fix the login bug" to "fix the login bug in the OAuth flow") from a task change (the user moved from "fix the login bug" to "write deployment docs"). It cannot track how many times the task has shifted, whether the current window has had time to adapt, or whether the task descriptor is stale relative to the actual conversation. Task identity turns the task descriptor from a static input into a managed, lifecycle-aware entity.

**What this spec defines:**

- **The task descriptor model** — the full structure, validation rules, and normalization semantics. cl-spec-002 section 5.1 defined the fields; this spec defines the constraints, defaults, and edge cases.
- **Task identity and comparison** — how context-lens determines whether two descriptors represent the same task, a refinement of the same task, or a different task entirely. This classification drives transition handling.
- **Task lifecycle** — the state machine governing task state: unset → active → updated → cleared. How each transition is triggered, what state changes it produces, and what invariants it must maintain.
- **Task transitions** — the mechanics of what happens when a task changes. Score invalidation (already defined in cl-spec-002 section 5.6), grace period tracking, staleness detection, and transition history.
- **Task descriptor preparation** — how the task description is transformed into a form suitable for similarity computation. Embedding or trigramming, caching, and invalidation.
- **Integration points** — how task identity interacts with the quality model (relevance scoring), the detection framework (gap pattern, grace period), and the eviction advisory (task-aware eviction).

### Design goals

- **Lightweight lifecycle, not a task manager.** context-lens is not a project management tool. It does not assign tasks, decompose tasks into subtasks, or track task completion. It maintains exactly enough task state to compute relevance scores and detect task transitions. The caller owns task semantics — context-lens owns task *identity* within the window.
- **Caller-driven, not inferred.** The task is what the caller says it is. context-lens does not attempt to infer the current task from conversation content, segment topics, or user intent. Inference would require LLM calls (violating the no-LLM scoring constraint, cl-spec-002 section 1), would be unreliable, and would create a confusing feedback loop where the inferred task influences relevance scores which influence the next inference. The caller declares the task explicitly via `setTask`.
- **Transitions are first-class.** The moment of task change is as important as the task itself. A sharp relevance drop after `setTask` is expected, not alarming — but only if the system knows it just happened. Task transitions are tracked, timestamped, and surfaced to downstream consumers (the detection framework, the diagnostics system) so they can distinguish expected transients from genuine degradation.
- **Graceful absence.** No task is a valid state, not an error. Many callers — especially those building simple context managers without task-tracking — will never call `setTask`. context-lens operates fully without a task descriptor: relevance defaults to 1.0, the gap pattern is suppressed, and all other quality dimensions function normally. Task identity adds value when present but imposes no cost when absent.

### What task identity is not

Task identity is not a task decomposition framework. It does not model subtasks, dependencies, or task hierarchies. A task is a flat descriptor — a description, optional keywords, optional metadata. If the caller's workflow involves subtasks, they model each subtask as a separate `setTask` call. context-lens sees a sequence of task descriptors, not a tree.

Task identity is not a conversation analyzer. It does not read the conversation to detect topic shifts, infer user intent, or predict the next task. It reads the task descriptor the caller provides and compares it to the previous descriptor. The comparison is mechanical (embedding similarity and field-level diff), not semantic (understanding what the user is trying to accomplish).

Task identity is not a persistence layer. Task state exists only in memory for the duration of the session. There is no serialization, no persistence to disk, and no restoration of task history across sessions. Each session starts with no task set. This matches the session-scoped design of quality scores, pattern history, and the continuity ledger.

### How task identity flows through the system

```
Caller
    |
    +--> setTask(descriptor)
    |
    v
Task Identity (this spec)
    |
    +--> Validates and normalizes the descriptor
    +--> Compares against current task → classifies transition type
    +--> Updates task state (current, previous, transition count, timestamps)
    +--> Prepares descriptor for similarity (embed or trigram)
    |
    +--> Quality Model (cl-spec-002)
    |        Consumes prepared task for relevance scoring
    |        Invalidates cached relevance scores on task change
    |
    +--> Detection Framework (cl-spec-003)
    |        Reads taskDescriptorSet flag
    |        Tracks task transition recency for grace period
    |        Suppresses gap when no task
    |
    +--> Eviction Advisory (cl-spec-008)
    |        Uses task-aware relevance for eviction targeting
    |
    +--> Diagnostics (cl-spec-010)
             Surfaces task transitions, staleness, history
```

---

## 2. Task Descriptor Model

The task descriptor is the caller's declaration of what the model is currently working on. cl-spec-002 section 5.1 introduced the structure and defined how relevance scoring consumes it. This section is the authoritative definition of the descriptor itself — its fields, constraints, defaults, and normalization.

### 2.1 Structure

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | **Yes** | Free-text description of the current task. This is the primary semantic signal — it is embedded or trigrammed and compared against segment content for similarity scoring. Should be specific enough to distinguish this task from other work the caller might do. |
| `keywords` | string[] | No | Key terms that indicate relevance. Segments containing these terms receive a keyword boost (cl-spec-002 section 5.2). Keywords provide precision where the description provides breadth — they catch specific identifiers, function names, file paths, or domain terms that semantic similarity might miss. |
| `relatedOrigins` | string[] | No | Origin values (cl-spec-001 section 3.3) that are inherently relevant to this task. A task about "fix the login bug" might declare `["tool:grep", "file:auth.ts", "file:auth.test.ts"]` as related origins — any segment with those origins receives an origin relevance boost (cl-spec-002 section 5.3). |
| `relatedTags` | string[] | No | Segment tags (cl-spec-001 section 3.4) that indicate task relevance. Segments carrying these tags receive a tag relevance boost (cl-spec-002 section 5.3). |

**`description` is the only required field.** A task descriptor with just a description and no keywords, origins, or tags is fully valid and functional — similarity between the description and segment content is the primary relevance signal (0.7 weight in the content relevance formula, cl-spec-002 section 5.2). The optional fields add precision but are not necessary for useful relevance scoring.

### 2.2 Validation

Validation runs before normalization. A descriptor that fails validation is rejected — `setTask` throws, the current task state is unchanged, and no transition is recorded. Validation is strict about structure (the descriptor must be well-formed) and lenient about semantics (context-lens does not judge whether the description is *good*, only whether it is *present*).

**Descriptor-level rules:**

- The descriptor must be a non-null, non-undefined object. A caller who wants to remove the task calls `clearTask()`, not `setTask(null)`. Passing null or undefined to `setTask` is a programming error, not a valid "no task" signal — conflating the two would make it impossible to distinguish "I want no task" from "I forgot to pass a descriptor."
- The descriptor must contain at least the `description` field. An object with no `description` key (or with `description` set to undefined) is rejected.

**Per-field rules:**

| Field | Type | Constraint | On violation |
|-------|------|-----------|--------------|
| `description` | string | Non-empty after trimming. Maximum 2000 characters (pre-trim). | Reject: empty/whitespace-only description means the caller has no task to declare. Max length prevents degenerate embedding/trigramming cost — 2000 characters is ~500 tokens, ample for any reasonable task statement. |
| `keywords` | string[] | Each element must be a non-empty string after trimming. Maximum 50 elements (post-dedup). | Reject on non-string element or element that is empty after trimming. If the post-dedup count exceeds 50, reject — this suggests keyword stuffing, not a focused task. |
| `relatedOrigins` | string[] | Each element must be a non-empty string after trimming. No maximum count. | Reject on non-string or empty-after-trim element. No count limit because origins are constrained in practice by the number of distinct origins in the window. |
| `relatedTags` | string[] | Each element must be a non-empty string after trimming. No maximum count. | Same as `relatedOrigins`. |

**Optional field absence.** `keywords`, `relatedOrigins`, and `relatedTags` may be omitted entirely or provided as empty arrays — both are equivalent after normalization (empty array). Omission is not an error.

**No cross-validation against window content.** Validation does not check whether keywords appear in any segment, whether relatedOrigins match any segment's origin, or whether relatedTags match any segment's tags. A task descriptor that references origins and tags that do not currently exist in the window is perfectly valid — those segments may arrive later, or the caller may be setting up the task before loading relevant content. Cross-validation would create a temporal coupling between `setTask` and segment operations that is unnecessary and surprising.

**No semantic validation.** context-lens does not evaluate whether the description is meaningful, whether the keywords relate to the description, or whether the descriptor "makes sense." The caller owns task semantics. A description of `"asdf"` with keywords `["xyz"]` passes validation — it is well-formed, even if it is useless. The quality model will simply produce low similarity scores between this descriptor and most segments, which is the correct behavior: an incoherent task descriptor means everything is equally (ir)relevant.

### 2.3 Normalization

Normalization transforms a validated descriptor into a canonical form before storage. The canonical form is what gets stored, compared (section 3), prepared for similarity computation (section 6), and returned by `getTask`. The caller's original input is not retained — there is no `getRawDescriptor`. This simplifies the system: one form, everywhere.

**Per-field normalization:**

| Field | Normalization | Rationale |
|-------|--------------|-----------|
| `description` | Trim leading/trailing whitespace. Collapse internal whitespace runs to a single space (tabs, newlines, multiple spaces → one space). Do **not** lowercase. | Whitespace variation is noise — `"fix  the\n  bug"` and `"fix the bug"` are the same task. Casing is preserved because it carries semantic signal: `"OAuth"` and `"oauth"` may embed differently, and callers may capitalize intentionally (proper nouns, acronyms, class names). Lowercasing would destroy signal for zero gain. |
| `keywords` | Each keyword trimmed. Deduplicated case-insensitively — on collision, keep the first occurrence's casing. Sorted lexicographically (case-sensitive sort, for determinism). Absent or null → empty array. | Case-insensitive dedup because keyword matching is case-insensitive (cl-spec-002 section 5.2) — `"Auth"` and `"auth"` would produce identical match results, so keeping both is misleading. Sort for deterministic comparison: two descriptors with the same keywords in different order are the same descriptor. |
| `relatedOrigins` | Each origin trimmed. Deduplicated exactly (case-sensitive). Sorted lexicographically. Absent or null → empty array. | Origins are case-sensitive per cl-spec-001 section 3.3 — `"file:Auth.ts"` and `"file:auth.ts"` are different origins. Exact dedup matches this semantics. Sort for the same determinism reason as keywords. |
| `relatedTags` | Each tag trimmed. Deduplicated exactly (case-sensitive). Sorted lexicographically. Absent or null → empty array. | Tags are case-sensitive per cl-spec-001 section 3.4. Same reasoning as origins. |

**Idempotency.** Normalizing a normalized descriptor produces the identical descriptor — same description string, same keyword array (same elements, same order), same origins, same tags. This is a mechanical consequence of the normalization rules: trimming trimmed strings is a no-op, collapsing single spaces is a no-op, deduplicating unique elements is a no-op, sorting sorted arrays is a no-op. Idempotency matters for the identity comparison in section 3 — it guarantees that "same after normalization" is a stable equivalence relation, not one that shifts depending on how many times the descriptor has been processed.

**Normalization order.** Normalization runs after validation and before storage. The sequence within `setTask` is: validate → normalize → compare against current (section 3) → classify transition → store → prepare for similarity (section 6). Each step consumes the output of the previous step, and the normalized form is the input to all downstream operations.

### 2.4 Immutability After Set

Once stored, a task descriptor does not change until the next `setTask` or `clearTask` call. The normalized form written during `setTask` is the form that `getTask` returns, that relevance scoring reads, that transition comparison uses, and that diagnostics surface — for the entire duration until the caller explicitly replaces or clears it. There is no path by which the stored descriptor can be modified between lifecycle calls.

**Why immutability matters.** The quality model caches per-segment relevance scores and invalidates them when the task changes (cl-spec-002 section 5.6). This invalidation is triggered by `setTask` — it is the only signal. If the descriptor could be mutated in place (the caller grabs a reference and pushes a keyword into the array), the cache would serve stale scores against a silently-changed task with no invalidation signal. Immutability makes the contract explicit: the descriptor is stable between `setTask` calls, so cached scores derived from it are valid between `setTask` calls.

**Defensive copy.** The implementation stores a deep copy of the normalized descriptor, not a reference to the caller's object. `getTask` returns a deep copy of the stored descriptor, not the stored object itself. This prevents mutation from either side — the caller cannot modify the internal state by mutating the object they passed in or the object they got back. Defensive copying is cheap for a structure this small (one string, three small arrays).

**No partial updates.** There is no `patchTask`, `addKeyword`, `removeOrigin`, or any other operation that modifies a subset of the descriptor. To change anything — even a single keyword — the caller calls `setTask` with a complete new descriptor. This triggers the full transition flow (section 5): validation, normalization, comparison, classification, possible grace period activation.

The alternative — partial update operations — was rejected for two reasons:

1. **Ambiguous transition classification.** Adding a keyword to an otherwise identical descriptor: is that a refinement or the same task? Removing all keywords but keeping the description: refinement or change? Every combination of field-level diffs would need a classification rule. Full replacement sidesteps this: the comparison logic (section 3) sees two complete descriptors and classifies the transition from their overall similarity. Simple, predictable, one code path.

2. **Mechanical complexity for marginal convenience.** The task descriptor has four fields. Constructing a complete descriptor is trivial — spread the previous descriptor and override the fields you want to change. A `patchTask` API would save one line of caller code at the cost of a second mutation path through validation, normalization, comparison, and storage. The complexity is not justified.

---

## 3. Task Identity and Comparison

When the caller calls `setTask` with a new descriptor, context-lens must answer a question before it can do anything else: **is this the same task, a sharpened version of the current task, or a different task entirely?** The answer determines everything downstream — whether cached relevance scores survive, whether the grace period activates, what gets recorded in transition history, and what the detection framework sees. This section defines the three-way classification and the mechanics behind it.

### 3.1 The Three Classifications

Every `setTask` call (against an existing active task) produces exactly one of three classifications:

**Same task.** The new descriptor is identical to the current one after normalization. Field-by-field equality: same description string, same keywords array (same elements in same order — guaranteed by sorting in normalization), same relatedOrigins, same relatedTags. `setTask` is a no-op — no scores invalidated, no transition recorded, no state change. The staleness counter (`reportsSinceSet`) resets to zero, because the caller touching the descriptor indicates awareness, even if the descriptor hasn't changed.

This makes `setTask` safe to call defensively. A caller that calls `setTask` on every turn with the same descriptor pays no cost — no recomputation, no grace period, no log noise. This is important because callers should not need to track whether their descriptor has changed; that is context-lens's job.

**Task refinement.** The new descriptor differs from the current one but is semantically close — the caller is sharpening the same task, not switching to a new one. Examples:

- `"fix the login bug"` → `"fix the login bug in the OAuth token refresh flow"` (description elaborated)
- Same description, but keywords expanded: `["auth"]` → `["auth", "refresh_token", "OAuth"]`
- Same description, but relatedOrigins updated to include a newly-discovered relevant file

Refinements invalidate all cached relevance scores — the scoring target has changed, so every segment must be re-evaluated. But refinements do **not** activate the grace period. The reasoning: a refinement means "score more precisely against the same work." The window's content is likely still relevant to the refined task; segments will score similarly, just more precisely. There is no expected relevance cliff to protect against.

**Task change.** The new descriptor is semantically distant from the current one — the caller has moved to different work. Examples:

- `"fix the login bug"` → `"write deployment documentation"` (different domain entirely)
- `"implement user search API"` → `"refactor database connection pooling"` (same codebase, different task)

Task changes trigger the full transition response: all cached relevance scores invalidated, grace period activated (section 5.2), previous task stored, transition recorded as a change. The grace period exists because a task change creates an expected relevance cliff — the window is full of content relevant to the *old* task, and the new task has not had time to accumulate relevant content. Without the grace period, the gap pattern (cl-spec-003 section 6) would fire immediately on every task change, which is noise, not signal.

### 3.2 Classification Mechanics

Classification is a two-step process: first check for identity, then measure similarity.

**Step 1 — Identity check.** Compare the new normalized descriptor to the current normalized descriptor field by field:

```
sameTask(current, new) =
    current.description === new.description
    && current.keywords === new.keywords       // array equality (same length, same elements, same order)
    && current.relatedOrigins === new.relatedOrigins
    && current.relatedTags === new.relatedTags
```

If all four fields are identical, the classification is **same task**. Stop — no similarity computation needed. This is the fast path, and it is exercised frequently by callers who call `setTask` defensively on every turn.

**Step 2 — Similarity measurement.** The descriptors differ in at least one field. Compute the similarity between the old and new **descriptions** using the same similarity function used for relevance scoring (cl-spec-002 section 3.2) — cosine similarity with embeddings if an embedding provider is configured, Jaccard character trigrams otherwise:

```
descriptionSimilarity = similarity(current.description, new.description)
```

This reuses existing infrastructure. The current task description already has a prepared form (embedding vector or trigram set) from section 6. The new task description is prepared as part of the `setTask` flow. The similarity computation is a single vector comparison or set intersection — negligible cost.

**Classification rule:**

```
if descriptionSimilarity > refinementThreshold:    → refinement
if current.description === new.description:         → refinement
else:                                               → change
```

The second condition handles the case where the descriptions are identical but other fields differ (keywords added, origins changed, tags updated). Changes to keywords, origins, or tags alone — with the same description — are always refinements, regardless of how many fields changed. The rationale: the description is the primary semantic signal (0.7 weight in the relevance formula, cl-spec-002 section 5.2). If the description hasn't changed, the caller is tuning the same task, not switching tasks. Keywords and origins are precision instruments; swapping them out is refinement by definition.

### 3.3 The Refinement Threshold

The `refinementThreshold` determines the boundary between refinement and change. It applies only to the description similarity score — the single scalar that captures how semantically close the old and new descriptions are.

**Default: 0.7.** This matches the "strong topical relatedness" boundary noted in cl-spec-002 section 3.2 — descriptions with similarity above 0.7 are about the same topic with different wording or detail. Descriptions below 0.7 are topically distinct enough that the window's content is likely misaligned with the new task.

**Configurable.** The threshold can be overridden in the context-lens configuration. Valid range: 0.1–0.95. The bounds prevent degenerate configurations:

- Below 0.1: everything is a refinement. Task changes are never detected. The grace period never activates, and transition history is useless.
- Above 0.95: almost everything is a change. Minor wording tweaks trigger full grace periods. The caller cannot refine a task without triggering a transition alarm.

**Similarity provider dependence.** The effective meaning of 0.7 varies between embedding-based and trigram-based similarity. With a good embedding model, 0.7 corresponds to clear topical relatedness — `"fix the login bug"` and `"fix the authentication issue"` would likely exceed it. With trigram similarity, 0.7 requires substantial lexical overlap — those same descriptions might not reach it because they share few character trigrams.

This is a known tradeoff, not a defect. The trigram fallback path is intentionally coarser (cl-spec-002 section 3.2), and callers using it accept lower precision across all quality dimensions. The refinement threshold inherits that coarseness. A caller who needs precise refinement-vs-change classification should configure an embedding provider — the same advice that applies to all similarity-dependent features.

### 3.4 First-Task Classification

When the task state is UNSET and the caller calls `setTask` for the first time, there is no current descriptor to compare against. This is not a same/refinement/change classification — it is an **initial set**. The transition type is recorded as `"set"` (section 5.4), not `"change"`. No grace period activates because there is no previous task to create a relevance cliff against — the window has been operating with relevance defaulting to 1.0, and the first real relevance scores may be lower, but this is the baseline establishing itself, not a degradation.

### 3.5 Why This Classification Matters

The three-way classification is the decision point that shapes all downstream behavior. To make the consequences concrete:

| | Same task | Refinement | Change |
|--|-----------|------------|--------|
| Relevance cache invalidated | No | Yes | Yes |
| Grace period activated | No | No | Yes |
| Transition recorded | No | Yes (type: `"refinement"`) | Yes (type: `"change"`) |
| Previous task stored | No | No (current task updated in place) | Yes (current → previous) |
| Staleness counter reset | Yes | Yes | Yes |
| Description similarity computed | No (fast-path identity) | Yes | Yes |
| Task descriptor preparation | No (reuse existing) | Yes (new embedding/trigrams) | Yes (new embedding/trigrams) |

The table makes visible the design intent: **same task is free, refinement is cheap, change is the expensive path.** This incentivizes callers to call `setTask` frequently (defensive calls are no-ops) and to evolve tasks incrementally (refinements avoid grace period disruption). Only genuine task switches — where the window needs time to adapt — pay the full transition cost.

---

## 4. Task Lifecycle

Task identity has two states and five transitions between them. The state machine is deliberately minimal — it tracks whether a task exists, not the task's progress, completeness, or relationship to other tasks. The caller owns task semantics; context-lens owns task *presence*.

### 4.1 States

**UNSET.** No task descriptor has been provided. This is the initial state at session start and the state after `clearTask`. Consequences:

- Relevance defaults to 1.0 for all segments (cl-spec-002 section 5.1) — without a task, context-lens assumes everything is relevant.
- The gap degradation pattern is suppressed (cl-spec-003 section 6.1) — gap detection requires a task to measure divergence from. No task, no gap.
- Coherence, density, and continuity function normally — they do not depend on the task descriptor.
- `getTask()` returns null. `getTaskState()` returns the full state object with `currentTask: null`.

**ACTIVE.** A task descriptor is set. Relevance is scored against it. Gap detection is enabled. This is the state after any successful `setTask` call. The system remains ACTIVE through refinements and changes — only `clearTask` transitions back to UNSET.

There is no STALE state. Staleness (section 5.3) is a metadata flag on the ACTIVE state, not a separate state. A stale descriptor still produces relevance scores and enables gap detection — it just carries an advisory that the caller may want to verify it. Promoting staleness to a full state would mean defining transition rules (ACTIVE → STALE → ?), threshold behaviors, and recovery semantics for a condition that has no effect on scoring. The flag is simpler and sufficient.

### 4.2 Transitions

```
                  setTask(descriptor)
                  ┌──────────────────────┐
                  │                      │
                  v                      │
            ┌──────────┐          ┌──────────┐
  start ──> │  UNSET   │ setTask  │  ACTIVE  │
            │          │ ───────> │          │
            │          │          │          │
            │          │ <─────── │          │
            └──────────┘ clearTask└──────────┘
```

Five transitions are defined. Each is triggered by exactly one operation and produces exactly one outcome.

**UNSET → ACTIVE** (`setTask` when no current task)

The first `setTask` call in a session, or the first after a `clearTask`. No comparison is needed — there is no previous descriptor. The descriptor is validated, normalized, prepared (section 6), and stored. The transition is recorded as type `"set"` (section 5.4). No grace period activates (section 3.4). All task state counters initialize:

```
currentTask       = normalized descriptor
previousTask      = null
taskSetAt          = now
transitionCount   = 1
changeCount       = 0
refinementCount   = 0
reportsSinceSet   = 0
graceActive       = false
reportsRemainingInGrace = 0
```

**ACTIVE → ACTIVE (same task)** (`setTask` with identical normalized descriptor)

The comparison (section 3.2) determines the new descriptor is field-by-field identical to the current one. `setTask` is a no-op for all state except the staleness counter:

```
reportsSinceSet   = 0        // reset — caller is aware of the task
// everything else unchanged
```

No transition is recorded. No scores are invalidated. No preparation is triggered. The existing prepared form (embedding/trigrams) is reused.

**ACTIVE → ACTIVE (refinement)** (`setTask` with similar but non-identical descriptor)

The comparison determines the descriptions are similar above the refinement threshold, or the descriptions are identical but other fields differ. The task is being sharpened, not replaced:

```
currentTask       = new normalized descriptor    // updated in place
previousTask      = unchanged                    // not overwritten — refinements don't push the previous task
taskSetAt          = now
transitionCount   += 1
refinementCount   += 1
reportsSinceSet   = 0
reportsSinceTransition = 0
graceActive       = unchanged                    // refinement does NOT activate grace, but does NOT cancel an active grace period either
reportsRemainingInGrace = unchanged
```

Cached relevance scores are invalidated. The task descriptor is re-prepared (section 6). A transition record of type `"refinement"` is appended (section 5.4).

**Why refinements don't overwrite `previousTask`.** The previous task is retained to give diagnostics a meaningful "what was the last *different* task" reference. If refinements overwrote it, the previous task would always be a near-clone of the current one — useless for understanding session trajectory. `previousTask` is only updated on task changes and clears.

**Why refinements don't cancel an active grace period.** If the caller changes tasks (grace period activates) and then immediately refines the new task, the grace period should continue — the window still hasn't adapted to the new work. Canceling the grace period on refinement would punish callers who set a rough task descriptor and quickly refine it.

**ACTIVE → ACTIVE (change)** (`setTask` with dissimilar descriptor)

The comparison determines the descriptions are below the refinement threshold. The caller has moved to different work:

```
previousTask      = currentTask                  // current becomes previous
currentTask       = new normalized descriptor
taskSetAt          = now
transitionCount   += 1
changeCount       += 1
reportsSinceSet   = 0
reportsSinceTransition = 0
graceActive       = true
reportsRemainingInGrace = 2
```

Cached relevance scores are invalidated. The task descriptor is re-prepared (section 6). A transition record of type `"change"` is appended (section 5.4). The grace period activates, capping gap severity for 2 report cycles (section 5.2).

**ACTIVE → UNSET** (`clearTask`)

The caller removes the task entirely. Relevance reverts to 1.0 for all segments, gap detection is suppressed:

```
previousTask      = currentTask                  // retain for diagnostics
currentTask       = null
taskSetAt          = null
transitionCount   += 1
reportsSinceSet   = 0
reportsSinceTransition = 0
graceActive       = false                        // grace period deactivated — no task means no gap to protect against
reportsRemainingInGrace = 0
```

Cached relevance scores are invalidated (they were computed against a task that no longer exists; the new scores are all 1.0). The prepared form (embedding/trigrams) is discarded. A transition record of type `"clear"` is appended (section 5.4).

`clearTask` is not "set the task to nothing" — it is "stop tracking tasks." The distinction matters for the detection framework: `setTask` with a vague description means "I have a task, it's just poorly defined" (gap detection active, relevance scored). `clearTask` means "I don't want task-based scoring" (gap suppressed, relevance = 1.0).

### 4.3 Operations

Four operations compose the task lifecycle API. This section defines their semantics — the exact method signatures and return types are deferred to cl-spec-007 (API Surface).

**`setTask(descriptor)`** — Set or update the current task. The full sequence:

1. Validate the descriptor (section 2.2). On failure, throw — no state change.
2. Normalize the descriptor (section 2.3).
3. If task state is UNSET: transition UNSET → ACTIVE. Skip comparison.
4. If task state is ACTIVE: compare normalized descriptor to current (section 3.2). Classify as same/refinement/change. Execute the corresponding transition (section 4.2).
5. If not a same-task no-op: prepare the descriptor for similarity computation (section 6). Invalidate relevance caches.
6. Return void. `setTask` is fire-and-forget — the caller does not receive the classification result synchronously. The classification is recorded in task state and available via `getTaskState`.

**Why `setTask` doesn't return the classification.** The classification (same/refinement/change) is an internal concern that drives cache invalidation and grace period mechanics. The caller should not branch on it — if they need to know whether their task changed, they can compare descriptors themselves, or inspect `getTaskState` after the fact. Returning the classification would invite callers to build control flow around it, coupling their logic to context-lens's internal transition semantics.

**`clearTask()`** — Remove the current task. If the task state is already UNSET, `clearTask` is a no-op — no transition recorded, no state change. If ACTIVE, executes the ACTIVE → UNSET transition (section 4.2). Returns void.

**`getTask()`** — Return the current task descriptor (normalized, deep-copied) or null if the state is UNSET. Pure read — no side effects, no state change, no invalidation. The returned object is a snapshot; modifying it does not affect internal state (section 2.4).

**`getTaskState()`** — Return the full task state object. This is the diagnostic window into task identity — it exposes everything the detection framework and diagnostics system consume, and is also available to callers who want to build custom logic around task transitions.

### 4.4 Task State Object

The task state object is the complete representation of task identity at a point in time. It is returned by `getTaskState()` and consumed internally by the detection framework and diagnostics.

| Field | Type | Description |
|-------|------|-------------|
| `currentTask` | TaskDescriptor \| null | The current normalized task descriptor, or null if UNSET. |
| `previousTask` | TaskDescriptor \| null | The descriptor from the last task change or clear. Null if there has been at most one task set with no changes. Retained across exactly one transition — only the most recent previous task is stored. |
| `state` | `"unset"` \| `"active"` | Current lifecycle state. |
| `taskSetAt` | timestamp \| null | When the current task was set (or last refined). Null if UNSET. |
| `transitionCount` | number | Total `setTask`/`clearTask` calls that produced a state change — excludes same-task no-ops. Includes initial sets, refinements, changes, and clears. |
| `changeCount` | number | Subset of `transitionCount` that were task changes (section 3.1). Does not include refinements, initial sets, or clears. |
| `refinementCount` | number | Subset of `transitionCount` that were refinements. |
| `reportsSinceSet` | number | Quality reports generated since the last `setTask` call (including same-task no-ops that reset the counter). Used for staleness detection (section 5.3). |
| `reportsSinceTransition` | number | Quality reports generated since the last transition that was not a same-task no-op. Used for grace period countdown. |
| `graceActive` | boolean | True during the 2-report grace period after a task change. |
| `reportsRemainingInGrace` | number | 0, 1, or 2. Decremented each time a quality report is generated while `graceActive` is true. When it reaches 0, `graceActive` is set to false. |

**`reportsSinceSet` vs. `reportsSinceTransition`.** These track different things. `reportsSinceSet` measures how long since the caller last touched `setTask` at all — it resets on same-task no-ops, because even a no-op indicates the caller is aware of the task. `reportsSinceTransition` measures how long since the last real change — it does not reset on no-ops, because the grace period countdown should not restart when the caller re-asserts the same descriptor. The distinction matters: staleness is about caller attentiveness (any `setTask` touch resets it), grace period is about window adaptation (only real transitions reset it).

---

## 5. Task Transitions

Section 4 defined *when* transitions happen and *what state changes they produce*. This section defines the **downstream effects** — the concrete things that happen to scores, caches, detection behavior, and diagnostic state as a consequence of each transition. These effects are the reason the three-way classification (section 3) exists: different classifications trigger different effects.

### 5.1 Score Invalidation

On any task change or refinement (not same-task no-ops), the following caches are invalidated synchronously within the `setTask` call:

| Cache | Invalidated? | Reason |
|-------|-------------|--------|
| Per-segment relevance scores | **Yes** | Relevance is scored against the task descriptor (cl-spec-002 section 5.2). The descriptor has changed, so every cached score is stale. |
| Cached quality report | **Yes** | The report includes per-segment relevance scores and window-level relevance (cl-spec-002 section 9). Stale relevance scores make the report stale. |
| Per-segment coherence scores | No | Coherence measures relationships between segments (cl-spec-002 section 3). It does not depend on the task descriptor. |
| Per-segment density scores | No | Density measures redundancy between segments (cl-spec-002 section 4). It does not depend on the task descriptor. |
| Continuity ledger | No | Continuity tracks historical loss (cl-spec-002 section 6). It does not depend on the current task — past evictions are facts, not opinions that change with the task. |
| Pairwise similarity cache | No | Segment-to-segment similarities are task-independent. |
| Task descriptor prepared form | **Yes** | The old embedding/trigram set is discarded and recomputed for the new descriptor (section 6). |

**Invalidation is synchronous.** When `setTask` returns, the relevance cache is empty and the new task descriptor is prepared. The next quality report will compute fresh relevance scores against the new task. There is no deferred invalidation, no "dirty" flag that triggers lazy recomputation — the cache is cleared immediately. This keeps the contract simple: after `setTask`, the system is in a consistent state where all cached data reflects the current task.

**Invalidation is complete, not selective.** All per-segment relevance scores are invalidated, not just the ones that would change. Selective invalidation — recomputing only for segments whose relevance actually differs under the new task — would require computing relevance for every segment to determine which ones changed, which costs exactly as much as recomputing all of them. Complete invalidation is simpler and no more expensive.

**On `clearTask`.** Relevance scores are also invalidated on `clearTask`, but for a different reason: the scores were computed against a task that no longer exists. The new relevance scores are trivially 1.0 for all segments (cl-spec-002 section 5.1) — no similarity computation needed.

### 5.2 Grace Period

The grace period is a 2-report window after a task change during which the gap degradation pattern's severity is capped. It exists because a task change creates an expected, transient relevance cliff — the window is full of content from the old task, and the caller has not yet had time to adapt it. Without the grace period, every task change would immediately fire a warning or critical gap alert, which is noise: the caller already knows relevance dropped (they just changed the task), and they need time to respond.

**Activation.** The grace period activates only on task changes (ACTIVE → ACTIVE with dissimilar descriptor). It does not activate on:

- Initial set (UNSET → ACTIVE) — there is no old task to create a relevance cliff against (section 3.4).
- Refinements — the window content is still largely relevant to the refined task; no cliff expected.
- `clearTask` — gap detection is suppressed entirely when no task is set; a grace period would protect nothing.

**Mechanics:**

```
On task change:
    graceActive = true
    reportsRemainingInGrace = 2

On each quality report while graceActive:
    reportsRemainingInGrace -= 1
    if reportsRemainingInGrace == 0:
        graceActive = false
```

**Effect on gap detection (cl-spec-003 section 6.3).** While `graceActive` is true:

- Gap severity is capped at `watch`. Even if relevance drops below 0.3 at 90% utilization (which would normally trigger `critical`), the reported severity is `watch`. The gap pattern still fires — the caller sees that relevance has dropped — but the severity reflects "this is expected, you have time to fix it," not "this is an emergency."
- Rate-based severity elevation is suppressed. The general rule (cl-spec-003 section 2.4) elevates severity by one level when a score drops by more than 0.15 between consecutive reports. This elevation is suppressed during grace because the drop is expected — it is the task change, not a sudden degradation.
- The post-task-change diagnostic template is used (cl-spec-003 section 6.4): `"Window relevance dropped to {relevance} after task change. {irrelevantCount} segments ({irrelevantTokens} tokens) from the previous task remain. This is expected — the window has not yet adapted to the new task."`

**Why 2 reports.** The grace period lasts 2 quality report cycles, not a fixed time duration. Report-based counting matches how the caller interacts with the system — each report is a point where the caller can inspect, decide, and act. Two reports gives the caller: (1) one report to see the damage (how much content is irrelevant to the new task), and (2) one report after taking action (evicting old content, adding new content) to verify the fix. If the window is still in gap after 2 reports, the problem is real, not transient.

**Why not configurable.** The grace period duration (2 reports) is fixed. Configurability was considered and rejected: the grace period is a mechanical safeguard against a specific false-positive pattern (gap alarm on task change). The correct duration is "enough time for one round-trip of inspection and action." Making it configurable invites misconfiguration — a grace period of 0 defeats the purpose, a grace period of 10 masks real problems. Two reports is the right answer for all callers.

**Grace period and rapid task changes.** If the caller changes tasks again while the grace period is active, the grace period restarts — `reportsRemainingInGrace` resets to 2. This handles the case where a caller rapidly explores several tasks (common in interactive agents): each change gets its own adaptation window. The grace period does not stack or extend beyond 2 reports.

**Grace period and refinements.** A refinement during an active grace period does not cancel or restart it (section 4.2). The grace period continues counting down. The rationale: the caller changed tasks (grace started), then refined the new task (sharpened it). The window still hasn't adapted to the new work — the grace period is still protecting against the original change, not the refinement.

### 5.3 Staleness Detection

A task descriptor becomes stale when the caller stops touching it. The descriptor may still be accurate — the caller might simply be working steadily on the same task with no need to update. Or the descriptor might be outdated — the caller has moved on and forgotten to call `setTask`. context-lens cannot distinguish these cases (it would need to understand the conversation, which requires LLM calls). Instead, it tracks a simple proxy: how many quality reports have been generated since the last `setTask` call.

**Staleness threshold: 5 reports.** After 5 quality reports with no `setTask` call, the task descriptor is flagged as potentially stale. The flag is a boolean on the task state:

```
stale = (reportsSinceSet >= 5)
```

The value 5 is a balance between sensitivity and noise. At 1 report, every descriptor would be stale immediately — useless. At 20 reports, staleness would never fire in a typical session — also useless. Five reports gives the caller roughly 5 "turns" (in an agent loop where each turn generates a report) before the system notes that the descriptor hasn't been revisited. This matches the staleness reference in cl-spec-003 section 6.5, where the gap pattern's remediation hints suggest updating the descriptor after 5 reports.

**What staleness is not:**

- Staleness is **not a degradation pattern**. It is not detected by the pattern framework, does not have severity levels, does not produce alerts, and does not appear in the pattern list. It is metadata on the task state — a flag, not a finding.
- Staleness **does not affect scoring**. A stale descriptor produces relevance scores identically to a fresh one. The scores may be wrong (if the task has actually changed), but context-lens cannot know that — it scores against whatever descriptor it has.
- Staleness is **not an error state**. A descriptor that has been set once and never updated for an entire session is perfectly valid. Long-running single-task sessions will naturally exceed the staleness threshold. The flag is informational — "the caller has not revisited this" — not diagnostic.

**What staleness is for.** Two consumers use the staleness flag:

1. **Gap remediation hints (cl-spec-003 section 6.5).** When gap is at `warning` or `critical` and the descriptor is stale, the remediation includes an `"updateTask"` hint suggesting the caller verify that the descriptor is still current. This is the primary value of staleness — it connects a quality problem (low relevance) to a possible cause (outdated descriptor).
2. **Diagnostics (cl-spec-010).** The diagnostic surface includes staleness status so callers and tooling can build their own alerting around it.

**Staleness reset.** Any `setTask` call resets `reportsSinceSet` to 0, clearing the staleness flag. This includes:

- Same-task no-ops — the caller re-asserted the same descriptor, which indicates awareness. The descriptor may be identical, but the caller's attention is fresh.
- Refinements — the caller is actively evolving the descriptor.
- Changes — the caller has moved to a new task; staleness of the old task is moot.

`clearTask` also resets `reportsSinceSet` to 0, but staleness is not meaningful in the UNSET state (there is no descriptor to be stale).

**Why not configurable.** The staleness threshold (5 reports) is fixed. The reasoning parallels the grace period: staleness is a simple heuristic with a single correct operating point. A threshold of 1 would flag every descriptor as stale after the first report. A threshold of 50 would never fire. Five is the reasonable middle ground, and making it configurable adds a knob that callers would not know how to set.

### 5.4 Transition History

Task identity maintains a log of transitions for diagnostic purposes. The log answers the question: *what has the task been doing over the course of this session?* A session with one initial set and no changes indicates steady single-task work. A session with 15 changes in 30 reports may indicate scope thrash or an agent exploring multiple workstreams. The log makes this trajectory visible.

**Entry structure:**

Each transition (excluding same-task no-ops, which are not transitions) appends one entry:

| Field | Type | Present for | Description |
|-------|------|-------------|-------------|
| `type` | `"set"` \| `"change"` \| `"refinement"` \| `"clear"` | All | The transition classification. |
| `timestamp` | timestamp | All | When the transition occurred. |
| `similarity` | number | `"change"`, `"refinement"` | Description similarity between old and new task (section 3.2). Not present for `"set"` (no previous task) or `"clear"` (no new task). |
| `previousDescription` | string (truncated to 200 chars) | `"change"`, `"refinement"`, `"clear"` | The description of the task being replaced or cleared. Truncated to bound log memory. Not present for `"set"` (no previous task). |
| `newDescription` | string (truncated to 200 chars) | `"set"`, `"change"`, `"refinement"` | The description of the new task. Not present for `"clear"` (no new task). |

**Why descriptions are truncated.** The transition log is a diagnostic summary, not a complete record. Storing full 2000-character descriptions for 20 entries would consume up to 80KB of memory for diagnostics alone — disproportionate for a log that exists to show trajectory, not to reconstruct exact task descriptors. 200 characters captures the essential intent of any reasonable task description.

**Capacity: 20 entries.** The log is a ring buffer capped at 20 entries. When the 21st transition occurs, the oldest entry is discarded. This matches the score history cap used in cl-spec-003 section 2.5 — 20 data points is enough to show trajectory without unbounded growth. For a session with frequent task changes (the case where the log is most valuable), 20 entries covers the most recent activity. For a session with few changes, the log never approaches the cap.

**Session-scoped.** The log is not persisted. Each session starts with an empty transition history. This matches the session-scoped design of all task state (section 4.1) and quality model state (cl-spec-002 section 7).

**Access.** The transition history is included in the task state object returned by `getTaskState()` and surfaced by the diagnostics system (cl-spec-010). It is read-only — callers cannot append to, modify, or clear the history. The only way to add entries is through `setTask` and `clearTask` calls that produce state changes.

---

## 6. Task Descriptor Preparation

The task descriptor as the caller provides it is a structured object — a description string, keyword arrays, origin and tag lists. The quality model does not consume it in this form. Relevance scoring (cl-spec-002 section 5.2) needs to compute `similarity(segment.content, task.description)` for every active segment, and this requires the task description in a form suitable for similarity computation: an embedding vector or a character trigram set. This section defines how the descriptor is transformed into that prepared form, when the transformation happens, and how the prepared form is cached.

Preparation is an internal optimization. The caller never sees the prepared form — it is not part of the `TaskDescriptor` structure returned by `getTask()`, and it is not exposed through `getTaskState()`. It exists solely to make relevance scoring efficient.

### 6.1 Embedding Path

When an embedding provider is configured (cl-spec-005), the task description is embedded using the same provider and model used for segment content:

```
preparedTask.embedding = embeddingProvider.embed(normalizedDescriptor.description)
```

The embedding is computed once during `setTask`, immediately after normalization and comparison (section 4.3, step 5). It is stored alongside the normalized descriptor in the internal task state — not on the `TaskDescriptor` object itself.

**Similarity computation.** With the task embedding cached, per-segment relevance scoring reduces to:

```
taskSimilarity(segment) = cosineSimilarity(preparedTask.embedding, segment.embedding)
```

This is the same similarity function used for coherence scoring (cl-spec-002 section 3.2). The segment embeddings are already cached by the quality model — no additional embedding calls are needed for relevance scoring. The cost per segment is one vector dot product plus normalization, which is negligible.

**Same provider, same model.** The task description must be embedded with the same provider and model used for segment content. Mixing providers (task embedded with model A, segments embedded with model B) would produce vectors in different embedding spaces — cosine similarity between them is meaningless. This is enforced structurally: there is one embedding provider configured for the context-lens instance, and all embedding operations use it.

**Keywords are not embedded.** Keywords are matched via case-insensitive whole-word search (cl-spec-002 section 5.2), not via similarity. Embedding keywords would be wasteful — a keyword like `"OAuth"` is a precise identifier, not a semantic concept. Its value is in exact matching, not in its position in embedding space. The keyword boost formula (`keywordScore = |keywords found| / |total keywords|`) operates on string matching, not vector similarity.

### 6.2 Trigram Fallback Path

When no embedding provider is configured — the default, zero-dependency path — the task description is converted to a character trigram set:

```
preparedTask.trigrams = charTrigrams(normalizedDescriptor.description)
```

This uses the same trigram function used for segment similarity in the fallback path (cl-spec-002 section 3.2). Character trigrams are the set of all 3-character substrings of the lowercased description. For `"fix the login bug"`, the trigram set includes `"fix"`, `"ix "`, `"x t"`, `" th"`, `"the"`, `"he "`, `"e l"`, `" lo"`, `"log"`, `"ogi"`, `"gin"`, `"in "`, `"n b"`, `" bu"`, `"bug"`.

**Similarity computation:**

```
taskSimilarity(segment) = jaccardIndex(preparedTask.trigrams, segment.trigrams)
```

Jaccard index: `|A ∩ B| / |A ∪ B|`. Range 0.0–1.0. This is lexical similarity — it captures shared vocabulary, not shared meaning. `"Fix the login bug"` and `"Repair the authentication issue"` would score low because they share few character trigrams despite being semantically similar.

The coarseness is accepted. The trigram path is the zero-config fallback for callers who do not provide an embedding provider. It reliably detects strong relevance (same words) and strong irrelevance (no words in common), but misses nuance. This matches the behavior across all similarity-dependent features — the trigram path trades precision for zero dependencies (cl-spec-002 section 3.2).

**Trigram generation is cheap.** For a 2000-character description (the maximum, section 2.2), trigram generation produces at most 1998 trigrams. Building the set and computing Jaccard against a segment's trigram set is O(n) with hash sets. This is well within the performance budget for a `setTask` call.

### 6.3 Preparation Caching

The prepared form — embedding vector or trigram set — is cached alongside the normalized descriptor in the internal task state. The caching rules are simple because the task descriptor is immutable between lifecycle calls (section 2.4):

**Invalidation triggers:**

| Event | Action |
|-------|--------|
| `setTask` (change or refinement) | Discard old prepared form. Compute and cache new prepared form for the new descriptor. |
| `setTask` (same task) | No action. The existing prepared form is correct — the descriptor hasn't changed. |
| `clearTask` | Discard the prepared form. No new form is needed — there is no task to prepare. |
| Segment added/updated/evicted | No action. The prepared form depends on the task description, not on window content. |
| Embedding provider changed | Discard and recompute. The old embedding was produced by a different model — it is in a different vector space. (This is handled by the embedding provider switch logic in cl-spec-005, which triggers a full recomputation of all embeddings including the task embedding.) |

**The prepared form is not part of `TaskDescriptor`.** The caller's view of the task — what `getTask()` returns — is the normalized descriptor: description, keywords, relatedOrigins, relatedTags. The embedding vector or trigram set is internal state that the quality model reads but the caller never touches. This separation keeps the `TaskDescriptor` type clean and serializable, and prevents callers from depending on preparation details that may change (e.g., switching from trigrams to embeddings).

### 6.4 Keyword Preparation

Keywords require no preparation beyond what normalization already provides (section 2.3). They are trimmed, deduplicated case-insensitively, and sorted during normalization. At query time, keyword matching operates on the normalized keyword strings directly.

**Matching semantics (defined in cl-spec-002 section 5.2, restated here for completeness):**

- Case-insensitive: `"OAuth"` matches `"oauth"` in segment content.
- Whole-word: `"auth"` does not match `"author"` or `"authentication"`. Word boundaries are whitespace and punctuation.
- Linear scan: for each segment, each keyword is checked against the segment content. With a maximum of 50 keywords (section 2.2) and keyword matching implemented as string search, this is O(k × m) per segment where k is keyword count and m is content length. For typical values (10 keywords, 2000-character segments), this is microseconds.

**No precompilation.** Keywords are not compiled into regular expressions, finite automata, or other pattern structures. The keyword list is small enough (≤50 elements) that linear scan is within budget, and precompilation would add complexity for no measurable gain. If a future version needed to support hundreds of keywords, precompilation into an Aho-Corasick automaton would be the right optimization — but that is not this version.

**No stemming.** Keywords are matched exactly (modulo case). `"authenticate"` does not match `"authentication"` or `"auth"`. Stemming was considered and deferred: it adds a dependency (a stemming library) or a custom implementation, introduces language-dependence (English stemming rules do not apply to code identifiers or non-English text), and reduces predictability (callers cannot easily predict what a stemmed keyword will match). Exact matching is simple, predictable, and sufficient for the primary keyword use case — matching specific identifiers, file names, function names, and domain terms that the caller knows exactly.

### 6.5 Preparation Timing

Preparation is synchronous within `setTask`. The full sequence (restated from section 4.3 with preparation detail):

1. Validate the descriptor.
2. Normalize the descriptor.
3. Compare against current descriptor → classify transition.
4. If same task: reset staleness counter, return. No preparation needed.
5. Store the new normalized descriptor.
6. **Prepare the descriptor:** embed the description (embedding path) or compute trigrams (trigram fallback path). Cache the prepared form.
7. Invalidate relevance caches (section 5.1).
8. Record the transition (section 5.4).
9. If task change: activate grace period (section 5.2).

**Preparation happens before cache invalidation.** By the time relevance caches are cleared (step 7), the new prepared form is already available (step 6). This means the next quality report can immediately compute fresh relevance scores against the new task — there is no window where the caches are empty but the new task is not yet prepared.

**Embedding latency.** With the embedding path, step 6 includes an embedding API call — a network round-trip to the embedding provider. This is the only external call in the `setTask` flow. It is synchronous: `setTask` blocks until the embedding returns. This keeps the contract simple (after `setTask` returns, the system is fully ready) but means `setTask` latency depends on the embedding provider's response time. For local embedding models, this is milliseconds. For remote APIs, this may be tens of milliseconds. This latency is acceptable — `setTask` is called infrequently (once per task change, not per segment operation) and the caller expects it to do work.

The trigram path has no external calls. Preparation is pure computation — O(n) where n is the description length. `setTask` on the trigram path completes in microseconds.

---

## 7. Integration Points

Task identity is a producer. It manages task state and exposes it to other systems that consume it for their own purposes. This section defines the contract between task identity and each consumer — what task identity provides, what the consumer reads, what invariants the consumer can rely on, and what the consumer must not do. The contracts are deliberately one-directional: consumers read task state, they do not write it. Only the caller, through `setTask` and `clearTask`, modifies task state.

### 7.1 Quality Model (cl-spec-002)

The quality model is the primary consumer of task identity. It reads the prepared task descriptor to compute per-segment relevance scores (cl-spec-002 section 5).

**Task identity provides:**

| Signal | Type | Used by |
|--------|------|---------|
| Prepared task description | embedding vector or trigram set | Content-to-task similarity (cl-spec-002 section 5.2) |
| Keywords | string[] | Keyword boosting (cl-spec-002 section 5.2) |
| Related origins | string[] | Origin relevance signal (cl-spec-002 section 5.3) |
| Related tags | string[] | Tag relevance signal (cl-spec-002 section 5.3) |
| Task set flag | boolean | No-task default (relevance = 1.0 when false, cl-spec-002 section 5.1) |

**Contract:**

- When `setTask` causes a change or refinement, task identity invalidates the quality model's relevance caches (section 5.1). The quality model does not poll for changes — it is notified.
- The quality model can assume the prepared form is stable between notifications. It does not need to check whether the task has changed before using the cached embedding or trigram set.
- The quality model does **not** call `setTask`, `clearTask`, or modify task state in any way. It is a read-only consumer. Relevance scoring is a pure function of the task descriptor and segment content — it does not feed back into task identity.

**Data flow:**

```
Task Identity ──provides──> prepared descriptor, keywords, origins, tags
                            task set flag
Quality Model ──reads────> computes per-segment relevance scores
              ──receives──> invalidation signal on task change/refinement
```

### 7.2 Detection Framework (cl-spec-003)

The detection framework consumes task state metadata — not the task descriptor itself — to control the gap degradation pattern's behavior.

**Task identity provides:**

| Signal | Type | Used by |
|--------|------|---------|
| `taskDescriptorSet` | boolean | Gap suppression — gap is not detected when no task is set (cl-spec-003 section 6.1) |
| `graceActive` | boolean | Gap severity capping — severity capped at `watch` during grace period (cl-spec-003 section 6.3) |
| `reportsSinceSet` | number | Staleness hint — gap remediation suggests updating the descriptor after 5 reports (cl-spec-003 section 6.5) |
| `reportsSinceTransition` | number | Grace period countdown — the detection framework reads this to determine whether rate-based severity elevation is suppressed (cl-spec-003 section 6.3) |

**Contract:**

- The detection framework reads these signals at report generation time — when a quality report is requested and pattern detection runs. It does not subscribe to task state changes or receive push notifications. It reads the current values from the task state object.
- The detection framework does **not** modify task state. It does not reset counters, clear the grace period, or record transitions. It is a read-only consumer.
- The detection framework can assume that `taskDescriptorSet`, `graceActive`, and the counter values are consistent with each other at the time of reading. Specifically: if `taskDescriptorSet` is false, then `graceActive` is false and both counters are 0 (there is no task to be stale or in grace against).

**Data flow:**

```
Task Identity ────provides──> taskDescriptorSet, graceActive,
                              reportsSinceSet, reportsSinceTransition
Detection Framework ──reads──> controls gap detection behavior
```

### 7.3 Eviction Advisory (cl-spec-008)

The eviction advisory consumes the current task descriptor to make task-aware eviction recommendations. When the window is full and content must be evicted, segments irrelevant to the current task are better eviction candidates than segments relevant to it.

**Task identity provides:**

- The current task descriptor (via `getTask`), or null if no task is set.
- Per-segment relevance scores are provided by the quality model (section 7.1), not by task identity directly. The eviction advisory reads relevance scores from the quality model, which in turn derived them from the task descriptor.

**Contract:**

- When no task is set, the eviction advisory cannot use relevance as an eviction signal — all segments have relevance 1.0. Eviction falls back to other signals (protection level, importance, token cost). This is the expected behavior for callers who do not use task tracking.
- The eviction advisory does not modify task state.
- Full eviction advisory semantics are deferred to cl-spec-008. This section establishes only that task identity is an upstream dependency.

### 7.4 Diagnostics (cl-spec-010)

The diagnostics system surfaces the full task state for inspection and tooling integration. It is the most comprehensive consumer — it reads everything task identity tracks.

**Task identity provides:**

- Full task state object (section 4.4): current task, previous task, state, timestamps, all counters, grace period status.
- Transition history (section 5.4): the last 20 transitions with type, timestamp, similarity, and truncated descriptions.
- Staleness flag: derived from `reportsSinceSet >= 5`.

**Contract:**

- Diagnostics reads task state at report time — it takes a snapshot of the current state and includes it in the diagnostic output. It does not subscribe to changes.
- Diagnostics does not modify task state. It is the most strictly read-only consumer — it exists to observe, not to act.
- Diagnostics surfaces task transitions in a timeline view alongside quality score history and pattern activations. The transition history entries are timestamped, which allows aligning task changes with quality score movements — e.g., "relevance dropped from 0.8 to 0.3 at the same time as a task change, which is expected."
- Full diagnostic output format is deferred to cl-spec-010. This section establishes that the task state object and transition history are the data contract.

### 7.5 API Surface (cl-spec-007)

The four lifecycle operations — `setTask`, `clearTask`, `getTask`, `getTaskState` — are exposed to the caller through the public API. This spec defines their semantics (section 4.3); cl-spec-007 defines their syntax (method signatures, parameter types, return types, error shapes).

**Contract:**

- This spec is authoritative for *what happens* when an operation is called — validation rules, normalization, comparison, transition mechanics, downstream effects.
- cl-spec-007 is authoritative for *how the operation is called* — naming conventions, parameter packaging (positional vs. options object), return value wrapping, error type hierarchy.
- Where the two specs touch the same concept (e.g., "setTask throws on invalid input"), this spec defines the conditions and cl-spec-007 defines the error shape.

**The boundary is behavioral vs. syntactic.** If a question is "what should the system do?" the answer is in this spec. If a question is "what does the method signature look like?" the answer is in cl-spec-007.

---

## 8. Invariants and Constraints

These invariants are guarantees that the implementation must uphold and that consumers can rely on. They are testable — each invariant can be verified by constructing a scenario and checking the result. Where an invariant restates a property defined in an earlier section, the section reference is included. The invariant list is the authoritative summary; the sections provide the reasoning.

**1. Caller ownership.** context-lens never infers, generates, or modifies the task descriptor. The task is what the caller says it is, set exclusively through `setTask` and removed through `clearTask`. There is no automatic task detection, no conversation analysis, no content-based inference. (Section 1, design goal: "caller-driven, not inferred.")

**2. Graceful absence.** No task is not an error. When no task descriptor is set, relevance defaults to 1.0 for all segments, the gap pattern is suppressed, and all other quality dimensions — coherence, density, continuity — function normally. A caller that never calls `setTask` receives full context quality monitoring minus relevance discrimination. (Section 1, design goal: "graceful absence"; section 4.1, UNSET state.)

**3. Defensive setTask.** `setTask` with an identical normalized descriptor is a no-op — no cache invalidation, no transition record, no state change, no preparation recomputation. The only effect is resetting the staleness counter (`reportsSinceSet = 0`). Callers can call `setTask` on every turn with the same descriptor at zero cost. (Section 3.1, same-task classification; section 4.2, ACTIVE → ACTIVE same-task transition.)

**4. Session scope.** Task state is not persisted. Each session starts in the UNSET state with null current and previous tasks, zero counters, empty transition history, and grace inactive. There is no serialization, restoration, or cross-session continuity of task identity. (Section 1, "task identity is not a persistence layer"; section 4.1.)

**5. Normalization idempotency.** Normalizing a normalized descriptor produces the identical descriptor — same description string, same keyword array, same origins, same tags. This guarantees that the identity comparison (section 3.2) is a stable equivalence relation. (Section 2.3.)

**6. Stored immutability.** The descriptor stored by `setTask` is immutable until the next `setTask` or `clearTask`. It cannot be modified by the caller (defensive copy on store), by consumers (defensive copy on read via `getTask`), or by internal operations. Consumers can cache references to the descriptor's prepared form without invalidation checks between lifecycle calls. (Section 2.4.)

**7. Synchronous invalidation.** When `setTask` causes a change or refinement, all cached per-segment relevance scores and the cached quality report are invalidated synchronously within the `setTask` call. There is no deferred invalidation, no dirty flag, no lazy recomputation trigger. When `setTask` returns, the cache is empty and the next quality report will compute fresh scores. (Section 5.1.)

**8. Bounded grace period.** The grace period lasts exactly 2 quality report cycles after a task change, then deactivates. It cannot be extended by caller action, paused, or restarted without another task change. A refinement during an active grace period does not cancel or restart it. Only a new task change restarts it (by resetting `reportsRemainingInGrace` to 2). (Section 5.2.)

**9. Advisory staleness.** Staleness does not affect scoring, threshold evaluation, or pattern detection. A stale descriptor produces identical relevance scores to a fresh one. Staleness is metadata — a flag on the task state consumed by gap remediation hints (cl-spec-003 section 6.5) and diagnostics (cl-spec-010). It is not a degradation pattern, does not have severity levels, and does not appear in the pattern list. (Section 5.3.)

**10. Synchronous preparation.** `setTask` does not return until the task descriptor is prepared for similarity computation — the embedding is computed or the trigram set is built and cached. There is no async preparation, no deferred embedding, no "preparing" state. After `setTask` returns, the next quality report will use the new task's prepared form. (Section 6.5.)

**11. Deterministic classification.** Given the same current descriptor and the same new descriptor, the transition classification (same/refinement/change) is always the same. There is no randomness in the classification logic itself. The similarity score used to classify may vary with the similarity provider (embedding model updates, different trigram implementations), but for a fixed provider, the classification is a pure function of the two descriptors. (Section 3.2, classification mechanics.)

**12. Segment independence.** Task state changes are driven exclusively by `setTask` and `clearTask` calls. Adding, updating, evicting, compacting, or restoring segments does not affect the task descriptor, the transition classification, the grace period, staleness, or any other task state. The task descriptor is compared against segment content for relevance scoring (owned by cl-spec-002), but this is a read operation — the quality model reads the task, it does not write to task state. (Section 1, design goal: "caller-driven, not inferred"; section 7, integration contracts.)

---

## 9. References

| Reference | Description |
|-----------|-------------|
| `brainstorm_20260324_context-lens.md` | Origin brainstorm — initial task descriptor concept and relevance scoring sketch |
| `cl-spec-001` (Segment Model) | Defines origin tags and segment tags consumed by task descriptor's relatedOrigins and relatedTags fields |
| `cl-spec-002` (Quality Model) | Defines relevance scoring that consumes the task descriptor. Sections 5.1–5.6 established the task descriptor structure, relevance formula, and task transition invalidation mechanics |
| `cl-spec-003` (Degradation Patterns) | Consumes task state for gap pattern detection — taskDescriptorSet flag, grace period, staleness. Sections 6.1–6.5 and 8.1–8.2 reference task transitions |
| `cl-spec-005` (Embedding Strategy) | Provides the embedding provider used for task description embedding (when available). Trigram fallback when no provider configured |
| `cl-spec-007` (API Surface) | Exposes setTask, clearTask, getTask, getTaskState as API operations |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.6*
