---
id: cl-spec-007
title: API Surface
type: design
status: complete
created: 2026-04-02
revised: 2026-04-29
authors: [Akil Abderrahim, Claude Opus 4.6, Claude Opus 4.7]
tags: [api, public-interface, constructor, configuration, lifecycle, dispose, events, errors, serialization, snapshot, patterns]
depends_on: [cl-spec-001, cl-spec-002, cl-spec-003, cl-spec-004, cl-spec-005, cl-spec-006]
---

# API Surface

## Table of Contents

1. Overview
2. Constructor and Configuration
3. Segment Operations
4. Group Operations
5. Task Operations
6. Quality Operations
7. Provider Management
8. Capacity and Inspection
9. Lifecycle
10. Event System
11. Error Model
12. Invariants and Constraints
13. References

---

## 1. Overview

Specs 1 through 6 define the internal machinery of context-lens: how segments are structured (cl-spec-001), how quality is scored (cl-spec-002), how degradation is detected (cl-spec-003), how tasks are tracked (cl-spec-004), how embeddings are produced (cl-spec-005), and how tokens are counted (cl-spec-006). Each spec defines behavior, invariants, and data structures — but none of them defines what the caller actually sees. The segment model defines eight lifecycle operations but does not specify how the caller invokes them. The quality model defines a report structure but does not specify how the caller requests one. The provider specs define interfaces but do not specify how the caller registers a provider.

This spec is the public contract. It defines the complete set of operations that a caller can perform on a context-lens instance — the constructor, the methods, the configuration, the events, and the errors. Everything in this spec is caller-facing. Everything not in this spec is internal.

### Resolution of OQ-008: Stateful API

context-lens is **stateful**. A context-lens instance owns and maintains its segment collection, quality scores, continuity ledger, pattern history, task state, and caches. The caller creates an instance, feeds it content through lifecycle operations, and queries its state through reports and accessors.

The alternative — a stateless API where the caller passes the full segment collection on every call — was considered and rejected:

- **Continuity requires history.** The continuity dimension tracks eviction cost and restoration fidelity across the session. A stateless API would need the caller to pass this history on every call, which shifts bookkeeping complexity to the caller without reducing it.
- **Pattern detection requires temporal state.** Hysteresis, pattern history, trending, and recurrence detection all require state that persists across calls. A stateless API would either lose these capabilities or require the caller to manage an opaque state blob.
- **Caching requires ownership.** Token count caches, embedding caches, similarity caches, and quality score caches are keyed to content that context-lens tracks. A stateless API cannot cache effectively because it does not know what has changed between calls.
- **Quality baseline requires lifecycle awareness.** The baseline is captured at the transition from seeds to adds. A stateless API cannot detect this transition — it sees a bag of segments, not a sequence of operations.

Stateful does not mean persistent. Instance state lives in memory for the session's duration. context-lens does not serialize to disk, does not persist across process restarts, and does not synchronize across instances. Each instance is an independent, session-scoped monitor. Persistence, if needed, is the caller's responsibility.

### Design principles

- **One instance, one window.** Each context-lens instance monitors one context window. To monitor multiple windows (e.g., parallel conversations), create multiple instances. Instances do not share state.
- **Caller-driven mutations.** context-lens never modifies the context window on its own. It does not auto-evict, auto-compact, or auto-reorder. Every mutation originates from an explicit caller method call. context-lens measures and advises; the caller decides and acts.
- **Fail-fast on misuse.** Invalid arguments, violated preconditions, and broken invariants throw immediately. context-lens does not silently accept bad input and produce bad output. The error model (section 11) defines what fails and why.
- **Consistent snapshots.** Every read operation returns data consistent with the most recent mutation. There is no eventual consistency, no stale reads, no race between mutation and query. When `add` returns, the segment is immediately visible in `listSegments`, counted in `getUtilization`, and scorable in the next `assess` call.
- **Progressive disclosure.** The minimal viable usage is three lines: construct with a capacity, add segments, call `assess`. Advanced features — providers, groups, tasks, events, threshold overrides — are opt-in. A caller who ignores them gets sensible defaults.

### API categories

The public API is organized into twelve categories:

| Category | Purpose | Key methods |
|----------|---------|-------------|
| **Construction** | Create and configure an instance | `new ContextLens(config)` |
| **Segment operations** | Manage content in the window | `seed`, `add`, `update`, `replace`, `compact`, `split`, `evict`, `restore` |
| **Group operations** | Manage segment groups | `createGroup`, `dissolveGroup`, `getGroup`, `listGroups` |
| **Task operations** | Manage the current task descriptor | `setTask`, `clearTask`, `getTask`, `getTaskState` |
| **Quality operations** | Query context quality | `assess`, `getBaseline` |
| **Pattern registration** | Register custom degradation patterns | `registerPattern` |
| **Serialization** | Produce schema-conforming output | `toJSON`, `schemas`, `validate`, `snapshot`, `fromSnapshot` |
| **Provider management** | Configure tokenizer and embedding providers | `setTokenizer`, `setEmbeddingProvider`, `getTokenizerInfo`, `getEmbeddingProviderInfo` |
| **Capacity and inspection** | Query window state without scoring | `getCapacity`, `setCapacity`, `getSegment`, `listSegments`, `getSegmentCount`, `getEvictionHistory` |
| **Diagnostics** | Inspect internal state | `getDiagnostics` |
| **Eviction planning** | Produce advisory eviction plans | `planEviction` |
| **Lifecycle** | Transition the instance to its terminal state and probe lifecycle state | `dispose`, `isDisposed`, `isDisposing` |

An **event system** (section 10) provides lifecycle hooks. An **error model** (section 11) defines failure modes.

### What the API is not

The API is not a context window implementation. context-lens does not hold the actual messages sent to an LLM. It maintains a parallel model of the context — the caller adds segments that represent their context window's content, and context-lens tracks, scores, and advises on those segments. The caller is responsible for keeping their actual LLM context and their context-lens instance in sync.

The API is not middleware. It does not intercept LLM calls, modify prompts, or inject content. A middleware layer could be built on top of context-lens (calling `add` before each LLM call, reading `assess` to decide what to trim), but that is the caller's integration, not context-lens's responsibility.

The API is not async-first. All methods are synchronous except where explicitly noted. Embedding provider calls may be async (cl-spec-005 section 2.1 permits async `embed`), but the public API methods that trigger embedding (`add`, `seed`, `setTask`, `setEmbeddingProvider`) are themselves async — they return promises that resolve when embedding is complete. Callers using only the trigram fallback (no embedding provider) can treat the entire API as synchronous.

---

## 2. Constructor and Configuration

### 2.1 Constructor

```
new ContextLens(config: ContextLensConfig) -> ContextLens
```

Creates a new context-lens instance. The instance begins in an empty state: no segments, no task, no baseline, no pattern history. The configured providers are validated but not exercised until the first content-mutating operation.

Construction is synchronous. Provider validation (checking that the tokenizer returns 0 for empty string, that the embedding provider's metadata is well-formed) happens at construction time. If validation fails, the constructor throws.

### 2.2 Configuration Object

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `capacity` | number | **yes** | — | Maximum token capacity of the context window. Must be a positive integer. No default — the caller must declare their window size (cl-spec-006 decision). |
| `tokenizer` | `TokenizerProvider` or `"approximate"` | no | `"approximate"` | The tokenizer provider. Accepts a provider object implementing the tokenizer interface (cl-spec-006 section 2), or the string `"approximate"` for the built-in character-class heuristic. |
| `embeddingProvider` | `EmbeddingProvider` or `null` | no | `null` | The embedding provider. Accepts a provider object implementing the embedding interface (cl-spec-005 section 2), or `null` for trigram-only mode. |
| `retainEvictedContent` | boolean | no | `true` | Whether to retain segment content in memory after eviction. When `true`, evicted segments can be restored without the caller re-providing content. When `false`, content is discarded on eviction and must be supplied on restore. |
| `pinnedCeilingRatio` | number (0.0–1.0) | no | `0.5` | Emit a warning when pinned tokens exceed this fraction of capacity (cl-spec-001 invariant 15). |
| `patternThresholds` | `PatternThresholdOverrides` or `null` | no | `null` | Per-pattern, per-severity threshold overrides (cl-spec-003 section 9.1). `null` uses all defaults. |
| `suppressedPatterns` | `PatternName[]` | no | `[]` | Patterns to suppress entirely from detection results (cl-spec-003 section 9.2). Suppressed patterns are not evaluated — they consume no computation and produce no results. |
| `hysteresisMargin` | number (0.01–0.10) | no | `0.03` | Margin for hysteresis on pattern severity transitions (cl-spec-003 section 9.3). |
| `tokenCacheSize` | number | no | `4096` | Maximum entries in the token count LRU cache (cl-spec-006 section 5). |
| `embeddingCacheSize` | number | no | `4096` | Maximum entries in the embedding vector LRU cache (cl-spec-005 section 5). |
| `customPatterns` | `PatternDefinition[]` | no | `[]` | Custom degradation patterns to register at construction time (cl-spec-003 section 10). All-or-nothing validation — if any pattern fails, the constructor throws. |

### 2.3 Capacity is Required

There is no default capacity. context-lens cannot guess the caller's model, context window size, or how much of that window is reserved for output tokens and framing overhead. A default would be wrong for most callers and silently dangerous for all — capacity is the denominator in utilization, and a wrong denominator corrupts every downstream signal.

The caller must know their window size. If they do not, they should not be using a context window monitor.

### 2.4 Configuration Validation

The constructor validates all configuration fields at construction time:

| Field | Validation | Error on failure |
|-------|-----------|------------------|
| `capacity` | Positive integer, > 0 | `ConfigurationError` |
| `tokenizer` | If object: must have `count` method that returns 0 for empty string. If string: must be `"approximate"`. | `ProviderError` |
| `embeddingProvider` | If non-null: must have `embed` method and valid metadata (name, dimensions). | `ProviderError` |
| `retainEvictedContent` | Boolean | `ConfigurationError` |
| `pinnedCeilingRatio` | Number in (0.0, 1.0] | `ConfigurationError` |
| `patternThresholds` | Per-pattern thresholds must satisfy monotonic severity ordering (cl-spec-003 section 9.1) | `ConfigurationError` |
| `suppressedPatterns` | Array of valid `PatternName` values | `ConfigurationError` |
| `hysteresisMargin` | Number in [0.01, 0.10] | `ConfigurationError` |
| `tokenCacheSize` | Positive integer | `ConfigurationError` |
| `embeddingCacheSize` | Positive integer | `ConfigurationError` |
| `customPatterns` | Each element must satisfy PatternDefinition validation (cl-spec-003 section 10.3). Names must not collide with base patterns or each other. | `ConfigurationError` |

Validation is eager — all fields are checked before the instance is created. If any field fails, the constructor throws and no instance is returned. Partial construction does not exist.

### 2.5 Configuration Immutability

Configuration is captured at construction time via defensive copy. The caller's config object is not retained by reference — mutations to it after construction have no effect. Individual configuration fields can be changed after construction only through dedicated methods:

| Field | Mutable after construction? | Method |
|-------|---------------------------|--------|
| `capacity` | Yes | `setCapacity(newCapacity)` |
| `tokenizer` | Yes | `setTokenizer(provider)` |
| `embeddingProvider` | Yes | `setEmbeddingProvider(provider)` |
| `retainEvictedContent` | No | — |
| `pinnedCeilingRatio` | No | — |
| `patternThresholds` | No | — |
| `suppressedPatterns` | No | — |
| `hysteresisMargin` | No | — |
| `tokenCacheSize` | No | — |
| `embeddingCacheSize` | No | — |
| `customPatterns` | Append-only | `registerPattern(definition)` |

The immutable fields are set once because changing them mid-session would invalidate state in non-obvious ways. Changing `hysteresisMargin` would alter pattern deactivation behavior retroactively. Changing `suppressedPatterns` would create discontinuities in pattern history. These are session-level decisions that belong at construction time.

The mutable fields — capacity and providers — have dedicated methods because they correspond to legitimate mid-session changes (model switch, capacity resize) and their change semantics are well-defined (full recount on tokenizer switch, full re-embed on embedding switch, utilization recalculation on capacity change).

---

## 3. Segment Operations

Segment operations are the core of the API — they mutate the content of the monitored context window. Every segment operation defined in cl-spec-001 section 7 is exposed as a public method. The method signatures, parameters, and return types defined here are the authoritative public contract; cl-spec-001 defines the internal semantics.

All segment operations are **atomic**. If any step of an operation fails (token counting throws, validation rejects input, group constraint violated), the entire operation is rolled back. No partial mutations are observable.

### 3.1 seed

```
seed(segments: SeedInput[]) -> Segment[]
```

Seeds foundational context into the window. This is the batch entry point for initial content — system prompts, reference documents, project context. Seeds establish the quality baseline (cl-spec-002 section 7).

**SeedInput:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `content` | string | **yes** | — | Segment content. Must be non-empty. |
| `id` | string | no | auto-generated | Caller-assigned ID. Must satisfy ID constraints (cl-spec-001 section 3.1). |
| `importance` | number (0.0–1.0) | no | `0.5` | Priority weight. |
| `protection` | protection level | no | `seed` | Protection tier. Defaults to `seed`, not `default`. |
| `origin` | string | no | `null` | Provenance label. |
| `tags` | string[] | no | `[]` | Custom labels. |
| `groupId` | string | no | `null` | Add to an existing group. |

**Behavior:**

1. Validates all inputs. Any invalid input rejects the entire batch — no partial seeding.
2. For each input: generates ID if omitted (content hash, cl-spec-001 section 3.2). Checks for duplicate IDs across the batch and against existing segments.
3. Computes token counts. Uses batch counting if the provider supports `countBatch` (cl-spec-006 section 2.3).
4. Computes embeddings if an embedding provider is configured. Uses batch embedding if the provider supports `embedBatch` (cl-spec-005 section 2).
5. Inserts all segments in order. Updates aggregate token counts atomically.
6. Returns the created `Segment` objects in insertion order.

**Seeding after add:** Permitted but emits a warning event (`lateSeeding`). The quality baseline is re-captured after the seed completes, which may cause a discontinuity in quality trends (cl-spec-002 section 7).

**Calling seed multiple times:** Permitted. Each call appends seeds. The baseline is captured (or re-captured) after the most recent seed batch, before the next `add`.

**Empty array:** No-op. Returns `[]`. Does not trigger baseline capture.

### 3.2 add

```
add(content: string, options?: AddOptions) -> Segment | DuplicateSignal
```

Inserts a single segment into the context window.

**AddOptions:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | no | auto-generated | Caller-assigned ID. |
| `importance` | number (0.0–1.0) | no | `0.5` | Priority weight. |
| `protection` | protection level | no | `default` | Protection tier. |
| `origin` | string | no | `null` | Provenance label. |
| `tags` | string[] | no | `[]` | Custom labels. |
| `groupId` | string | no | `null` | Add to an existing group. |

**Behavior:**

1. If this is the first `add` and seeds exist, the quality baseline is captured before the segment is inserted (cl-spec-002 section 7).
2. If `id` is provided and already exists → throws `DuplicateIdError`.
3. If `id` is omitted, generates via content hash. If the auto-generated ID matches an existing ACTIVE segment → returns `DuplicateSignal` (cl-spec-001 section 3.3). The segment is **not** inserted.
4. Computes token count. Computes embedding if provider configured.
5. Inserts at end of segment order.
6. If `groupId` provided, adds to the group. Throws `GroupNotFoundError` if group does not exist. Throws `MembershipError` if segment already belongs to another group.
7. Updates aggregate token counts. Invalidates affected quality score caches.
8. Emits `segmentAdded` event.
9. Returns the created `Segment`.

**DuplicateSignal:**

| Field | Type | Description |
|-------|------|-------------|
| `duplicate` | `true` | Discriminator — distinguishes from a `Segment` return. |
| `existingId` | string | ID of the existing segment with matching content. |
| `existingSegment` | `Segment` | The existing segment. |

The caller decides how to handle duplicates: ignore (do not insert), replace the existing segment's metadata, or force-add with a caller-assigned ID.

### 3.3 update

```
update(id: string, changes: SegmentChanges) -> Segment
```

Modifies a segment in place. The segment retains its ID and position.

**SegmentChanges:**

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | New content. Triggers token recount, embedding recomputation, quality score invalidation. If the ID was auto-generated, the ID changes (new content hash). |
| `importance` | number (0.0–1.0) | New importance. Triggers group aggregate recomputation if grouped. |
| `protection` | protection level | New protection level. Triggers group aggregate recomputation if grouped. |
| `origin` | string or `null` | New origin tag. |
| `tags` | string[] | New tags (replaces, does not merge). |

All fields are optional. At least one must be provided. Omitted fields are unchanged.

**Preconditions:**
- Segment must exist and be ACTIVE. Throws `SegmentNotFoundError` if not found. Throws `InvalidStateError` if EVICTED.
- If `content` is provided and segment is `pinned`, throws `ProtectionError` — pinned segments cannot have their content changed (cl-spec-001 invariant 9).
- If `content` is provided, it must be non-empty. Throws `ValidationError` otherwise.

**Returns:** The updated `Segment` with new field values and `updatedAt` set to current time.

**Emits:** `segmentUpdated` event.

### 3.4 replace

```
replace(id: string, newContent: string, options?: ReplaceOptions) -> Segment
```

Replaces a segment's content entirely while preserving its ID, position, and group membership.

**ReplaceOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `importance` | number (0.0–1.0) | Override importance. |
| `origin` | string or `null` | Override origin. |
| `tags` | string[] | Override tags. |

**Preconditions:**
- Segment must be ACTIVE. Throws `SegmentNotFoundError` or `InvalidStateError`.
- Segment must not be `pinned`. Throws `ProtectionError`.
- `newContent` must be non-empty. Throws `ValidationError`.

**Behavior:** Content is overwritten. Token count recomputed. Embedding recomputed. Quality scores invalidated. `updatedAt` set to current time. Metadata from `options` merged (provided fields overwrite, omitted fields unchanged).

**Returns:** The updated `Segment`.

**Emits:** `segmentReplaced` event.

### 3.5 compact

```
compact(id: string, summary: string) -> Segment
```

Replaces a segment's content with a shorter summary. A specialized form of `replace` with additional constraints and continuity tracking.

**Preconditions:**
- Segment must be ACTIVE. Throws `SegmentNotFoundError` or `InvalidStateError`.
- Segment must not be `pinned`. Throws `ProtectionError`.
- `summary` must be non-empty. Throws `ValidationError`.
- `summary` must produce fewer tokens than the current content. Throws `CompactionError` if the summary is not shorter — compaction must reduce token usage (cl-spec-001 invariant 12).

**Behavior:**
1. Computes token count of `summary`. Validates it is strictly less than current token count.
2. Replaces content with `summary`. Recomputes embedding.
3. Updates `origin` to `"summary:compacted"`. Stores original origin in segment metadata as `originalOrigin`.
4. Records a `CompactionRecord` (original token count, compacted token count, compression ratio, timestamp) for the continuity ledger (cl-spec-002 section 6.3).
5. Invalidates quality scores. Updates aggregate token counts.

**Returns:** The compacted `Segment`.

**Emits:** `segmentCompacted` event with the `CompactionRecord`.

### 3.6 split

```
split(id: string, splitFn: (content: string) -> string[]) -> Segment[]
```

Breaks a segment into multiple child segments. The original segment is removed and replaced by the children at its position.

**Preconditions:**
- Segment must be ACTIVE. Throws `SegmentNotFoundError` or `InvalidStateError`.
- Segment must not be `pinned`. Throws `ProtectionError`.
- `splitFn` must return at least one non-empty string. Throws `SplitError` if it returns an empty array or any empty string.

**Behavior:**
1. Calls `splitFn(segment.content)` to produce ordered content chunks.
2. Removes the original segment.
3. Creates child segments at the original's position, in order.
4. Child IDs: `<originalId>:0`, `<originalId>:1`, etc.
5. Children inherit the original's metadata (importance, protection, origin, tags) unless the children would violate constraints.
6. If the original belonged to a group, all children join that group.
7. Token counts computed for each child. Embeddings computed for each child.
8. Quality scores invalidated for the affected region.

**Returns:** The created child `Segment[]` in order.

**Emits:** `segmentSplit` event with the original ID and child IDs.

### 3.7 evict

```
evict(id: string, reason?: string) -> EvictionRecord | EvictionRecord[]
```

Removes a segment (or an entire group) from the active context window.

**Preconditions:**
- Segment must be ACTIVE. Throws `SegmentNotFoundError` or `InvalidStateError`.
- Segment must not be `pinned`. Throws `ProtectionError`.

**Behavior:**
1. If the segment belongs to a group, the entire group is evicted atomically (cl-spec-001 section 5.3). An `EvictionRecord` is created for each member. The method returns an array.
2. A pre-eviction quality snapshot is computed for the segment (or each group member) and stored in the `EvictionRecord` (cl-spec-002 section 6.2).
3. The segment transitions to EVICTED. It no longer contributes to token counts or quality scores.
4. Content is retained or discarded based on the `retainEvictedContent` configuration.
5. Aggregate token counts updated. Quality score caches invalidated.
6. The continuity ledger records the eviction cost (cl-spec-002 section 6.2).

**EvictionRecord:**

| Field | Type | Description |
|-------|------|-------------|
| `segmentId` | string | ID of the evicted segment. |
| `tokenCount` | number | Tokens reclaimed. |
| `importance` | number | Importance at eviction time. |
| `protection` | protection level | Protection at eviction time. |
| `reason` | string or `null` | Caller-provided reason, or `null`. |
| `timestamp` | timestamp | When eviction occurred. |
| `qualityBefore` | quality snapshot | Per-segment quality scores at eviction time. |
| `contentRetained` | boolean | Whether content was retained for potential restore. |

**Returns:** A single `EvictionRecord` if the segment was ungrouped. An `EvictionRecord[]` if a group was evicted.

**Emits:** `segmentEvicted` event for each evicted segment.

### 3.8 restore

```
restore(id: string, options?: RestoreOptions) -> Segment | Segment[]
```

Returns an evicted segment (or group) to the ACTIVE state.

**RestoreOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | Required if content was not retained at eviction. Throws `RestoreError` if content was discarded and not provided. |
| `importance` | number (0.0–1.0) | Override importance (otherwise restored to pre-eviction value). |
| `protection` | protection level | Override protection (otherwise restored to pre-eviction value). |

**Preconditions:**
- Segment must exist and be EVICTED. Throws `SegmentNotFoundError` or `InvalidStateError`.
- If content was not retained, `options.content` must be provided. Throws `RestoreError`.

**Behavior:**
1. If the segment belonged to a group, the entire group is restored atomically. Partial group restore is not permitted (cl-spec-001 section 5.3).
2. The segment is inserted at its **original position** in the segment order (not appended). This preserves coherence.
3. Token count is recomputed if content was caller-provided (content may differ from the original). If content was retained, the cached count is reused.
4. Embedding recomputed if content changed.
5. `updatedAt` set to current time. `createdAt` unchanged.
6. Restoration fidelity is measured: the continuity dimension compares pre-eviction and post-restoration quality (cl-spec-002 section 6.4).
7. Aggregate token counts updated. Quality scores invalidated.

**Returns:** A single `Segment` if ungrouped. A `Segment[]` if a group was restored.

**Emits:** `segmentRestored` event for each restored segment.

---

## 4. Group Operations

Groups are first-class entities for atomic eviction and coherence scoring (cl-spec-001 section 5). Group operations manage group lifecycle — creation, membership, and dissolution. Segment operations (`add`, `evict`, `restore`) interact with groups through the `groupId` parameter; group operations manage the groups themselves.

### 4.1 createGroup

```
createGroup(groupId: string, segmentIds: string[], options?: GroupOptions) -> Group
```

Creates a new group from existing ACTIVE segments.

**GroupOptions:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `protection` | protection level | no | max of members | Group-level protection override. |
| `importance` | number (0.0–1.0) | no | max of members | Group-level importance override. |
| `origin` | string | no | `null` | Group provenance. |
| `tags` | string[] | no | `[]` | Group labels. |

**Preconditions:**
- `groupId` must satisfy ID constraints and not already exist. Throws `DuplicateIdError`.
- `segmentIds` must be non-empty. Throws `ValidationError`.
- All segment IDs must refer to ACTIVE segments. Throws `SegmentNotFoundError` or `InvalidStateError`.
- No segment may already belong to another group. Throws `MembershipError`.

**Behavior:**
1. Creates the group with the specified members in order.
2. Computes aggregate properties (cl-spec-001 section 5.2): token count (sum), importance (explicit or max of members), protection (explicit or max of members).
3. Each member segment records its group membership.

**Returns:** The created `Group`.

**Emits:** `groupCreated` event.

### 4.2 dissolveGroup

```
dissolveGroup(groupId: string) -> Segment[]
```

Dissolves a group, returning all members to independent status. Members remain ACTIVE and in their current positions — only the group relationship is removed.

**Preconditions:**
- Group must exist. Throws `GroupNotFoundError`.
- Group must be fully ACTIVE (all members ACTIVE). Throws `InvalidStateError` if the group is evicted — restore it first.

**Returns:** The former member `Segment[]` in their group order.

**Emits:** `groupDissolved` event.

### 4.3 getGroup

```
getGroup(groupId: string) -> Group | null
```

Returns the group with the given ID, or `null` if no such group exists. Does not throw for missing groups — returns `null` for safe lookup.

**Group:**

| Field | Type | Description |
|-------|------|-------------|
| `groupId` | string | Group identifier. |
| `members` | string[] | Ordered list of member segment IDs. |
| `protection` | protection level | Effective protection (explicit or derived). |
| `importance` | number | Effective importance (explicit or derived). |
| `origin` | string or `null` | Group provenance. |
| `tags` | string[] | Group labels. |
| `tokenCount` | number | Sum of member token counts. |
| `createdAt` | timestamp | When the group was created. |
| `state` | `"active"` or `"evicted"` | Matches the state of all members. |

Returns a defensive copy. Mutations to the returned object do not affect the instance.

### 4.4 listGroups

```
listGroups() -> Group[]
```

Returns all groups (active and evicted), ordered by creation time. Returns `[]` if no groups exist.

---

## 5. Task Operations

Task operations manage the task descriptor that drives relevance scoring. The task descriptor model, lifecycle, and transition semantics are defined in cl-spec-004. This section defines the public methods.

### 5.1 setTask

```
setTask(descriptor: TaskDescriptorInput) -> TaskTransition
```

Sets or updates the current task descriptor.

**TaskDescriptorInput:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | **yes** | Free-text description of the current task. Max 2000 characters. |
| `keywords` | string[] | no | Key terms indicating relevance. Max 50. |
| `relatedOrigins` | string[] | no | Origin values relevant to this task. |
| `relatedTags` | string[] | no | Segment tags relevant to this task. |

**Behavior:**
1. Validates and normalizes the descriptor (cl-spec-004 section 2.2): whitespace collapse, case-insensitive keyword deduplication, sorted arrays. The normalized descriptor is stored via defensive copy — the caller's object is not retained.
2. If no current task: classifies as a new task (`unset → active`).
3. If a current task exists: compares the new descriptor against the current one (cl-spec-004 section 3) and classifies the transition:
   - **Same task** (no meaningful change): no-op. Returns a transition with `type: "same"`.
   - **Refinement** (similarity > 0.7): invalidates relevance scores. No grace period.
   - **Change** (similarity ≤ 0.7): invalidates relevance scores. Activates grace period (2 quality reports, caps gap severity at watch).
4. Prepares the descriptor for similarity computation — embeds the description (if embedding provider configured) or computes trigrams. This is synchronous within `setTask`.
5. Records the transition in the transition history ring buffer (cl-spec-004 section 5.4).

**TaskTransition:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"new"` or `"refinement"` or `"change"` or `"same"` or `"clear"` | Classification of the transition. |
| `similarity` | number or `null` | Similarity between old and new task descriptions. `null` for new tasks. |
| `previousTask` | `TaskDescriptor` or `null` | The task that was replaced. `null` for new tasks. |

**Returns:** A `TaskTransition` describing what happened.

**Emits:** `taskChanged` event (except for `"same"` transitions).

### 5.2 clearTask

```
clearTask() -> void
```

Removes the current task descriptor. Transitions task state to unset. All segments receive relevance 1.0 (safe default). The gap pattern is suppressed. Relevance scores are invalidated.

If no task is set, this is a no-op.

**Emits:** `taskCleared` event (if a task was active).

### 5.3 getTask

```
getTask() -> TaskDescriptor | null
```

Returns the current task descriptor, or `null` if no task is set. Returns a defensive copy.

### 5.4 getTaskState

```
getTaskState() -> TaskState
```

Returns the full task lifecycle state.

**TaskState:**

| Field | Type | Description |
|-------|------|-------------|
| `state` | `"unset"` or `"active"` | Current lifecycle state |
| `currentTask` | `TaskDescriptor` or `null` | Current task descriptor. Null when unset |
| `previousTask` | `TaskDescriptor` or `null` | Previous task descriptor. Null if no prior task |
| `taskSetAt` | number or `null` | Timestamp when current task was set. Null when unset |
| `transitionCount` | number | Total transitions |
| `changeCount` | number | Total task changes |
| `refinementCount` | number | Total refinements |
| `reportsSinceSet` | number | Reports generated since last setTask |
| `reportsSinceTransition` | number | Reports since last transition of any type |
| `lastTransition` | `TaskTransition` or `null` | Most recent transition result (section 5.1) |
| `stale` | boolean | True when reportsSinceSet >= 5 (cl-spec-004 section 5.3) |
| `gracePeriodActive` | boolean | Whether grace period is in effect |
| `gracePeriodRemaining` | number | Reports remaining in grace period (0 if inactive) |
| `transitionHistory` | `TransitionEntry[]` | Ring buffer of last 20 transitions (cl-spec-004 section 5.4) |

---

## 6. Quality Operations

Quality operations are the primary output of context-lens — they produce the scores, patterns, and diagnostics that tell the caller how their context window is doing.

### 6.1 assess

```
assess() -> QualityReport
```

Generates a quality report — a complete snapshot of context window quality at the current moment. This is the central method of context-lens. Everything else feeds into it: segment operations build the window, task operations set the reference point, provider configuration determines accuracy. `assess` produces the result.

**Behavior:**
1. If no segments are active, returns a report with zero scores and no patterns. `segmentCount: 0`.
2. Computes per-segment scores for all four dimensions. Uses lazy caching — only segments whose scores have been invalidated since the last report are rescored (cl-spec-002 section 9.7).
3. Aggregates per-segment scores to window-level scores.
4. Computes the composite score (cl-spec-002 section 8).
5. Computes trend data by comparing against the previous report (cl-spec-002 section 9.6). `null` on first report.
6. Runs pattern detection over window scores, capacity metrics, and trend data (cl-spec-003 section 2).
7. Assembles the complete `QualityReport` and caches it.

**Caching:** The most recent report is cached. If `assess` is called again with no intervening content mutations or task changes, the cached report is returned with an updated `timestamp` but identical scores. The cache is invalidated by any content-mutating segment operation, any task operation, or any provider change.

**QualityReport structure:** Defined in cl-spec-002 section 9.1 and cl-spec-003 section 2.3. The full structure is reproduced here for API completeness:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | timestamp | When this report was generated. |
| `reportId` | string | Auto-generated, monotonically increasing. |
| `segmentCount` | number | Number of ACTIVE segments. |
| `windowScores` | `WindowScores` | Normalized window-level scores for all four dimensions. |
| `rawScores` | `WindowScores` | Pre-normalization (absolute) window-level scores. |
| `composite` | number | Weighted geometric mean composite score. |
| `baseline` | `BaselineSnapshot` | Baseline scores and metadata. |
| `capacity` | `CapacityReport` | Token counts, utilization, headroom, tier breakdown. |
| `tokenizer` | `TokenizerMetadata` | Active tokenizer name, accuracy, error bound, model family. |
| `embeddingMode` | `"embeddings"` or `"trigrams"` | Which similarity mode was used for this report. |
| `segments` | `SegmentScore[]` | Per-segment scores, ordered by composite ascending (weakest first). |
| `groups` | `GroupScore[]` | Per-group aggregate scores, ordered by composite ascending. |
| `continuity` | `ContinuitySummary` | Eviction/compaction/restoration summary. |
| `trend` | `TrendData` or `null` | Comparison against previous report. |
| `patterns` | `DetectionResult` | Active degradation patterns with severity, explanation, and remediation hints. |
| `task` | `TaskSummary` | Current task state summary (set/unset, stale flag, grace period). |

**WindowScores:**

| Field | Type | Description |
|-------|------|-------------|
| `coherence` | number (0.0–1.0) | Window coherence, normalized to baseline. |
| `density` | number (0.0–1.0) | Window density, normalized to baseline. |
| `relevance` | number (0.0–1.0) | Window relevance, normalized to baseline. |
| `continuity` | number (0.0–1.0) | Window continuity. |

In the empty-window case (zero active segments), all WindowScores fields are `null`.

**CapacityReport:**

| Field | Type | Description |
|-------|------|-------------|
| `capacity` | number | Configured maximum tokens. |
| `totalActiveTokens` | number | Sum of all active segment token counts. |
| `utilization` | number | `totalActiveTokens / capacity`. |
| `headroom` | number | `capacity - totalActiveTokens`. May be negative if over capacity. |
| `pinnedTokens` | number | Tokens locked by pinned segments. |
| `seedTokens` | number | Tokens in seed-protected segments. |
| `managedTokens` | number | Tokens in non-pinned segments (totalActiveTokens minus pinnedTokens). Includes seed, priority, and default segments. |
| `availableCapacity` | number | `capacity - pinnedTokens`. |

**TrendData:**

| Field | Type | Description |
|-------|------|-------------|
| `coherenceDelta` | number | Change in coherence since previous report. |
| `densityDelta` | number | Change in density since previous report. |
| `relevanceDelta` | number | Change in relevance since previous report. |
| `continuityDelta` | number | Change in continuity since previous report. |
| `compositeDelta` | number | Change in composite since previous report. |
| `tokensDelta` | number | Change in total active tokens since previous report. |
| `segmentCountDelta` | number | Change in segment count since previous report. |
| `previousReportId` | string | ID of the preceding report. |
| `timeDelta` | number | Milliseconds between this report and the previous. |

The entire `trend` field is `null` on the first report. When `trend` is non-null, all fields are present and non-null.

### 6.2 getBaseline

```
getBaseline() -> BaselineSnapshot | null
```

Returns the quality baseline, or `null` if no baseline has been captured yet.

**BaselineSnapshot:**

| Field | Type | Description |
|-------|------|-------------|
| `coherence` | number | Coherence at baseline capture. |
| `density` | number | Density at baseline capture. |
| `relevance` | number | Relevance at baseline capture. |
| `continuity` | number | Always 1.0. |
| `capturedAt` | timestamp | When the baseline was captured. |
| `segmentCount` | number | Segments at baseline capture. |
| `tokenCount` | number | Total tokens at baseline capture. |

### 6.3 registerPattern

```
registerPattern(definition: PatternDefinition) -> void
```

Registers a custom degradation pattern at runtime. The pattern participates in the next `assess()` call.

**PatternDefinition** is defined in cl-spec-003 section 10.2. The required fields are `name`, `description`, `detect`, `severity`, `explanation`, and `remediation`. Optional fields are `strategyHint` and `priority`.

**Preconditions:**
- `definition` must pass all validation rules (cl-spec-003 section 10.3).
- `definition.name` must not collide with any base pattern name or any already-registered custom pattern name. Throws `ValidationError` on collision.

**Behavior:**
1. Validates the definition.
2. Registers the pattern in the detection framework.
3. The pattern is immediately available for the next `assess()` call. There is no retroactive detection — the pattern is not run against previous reports.

**Returns:** void.

**Throws:** `ValidationError` if the definition fails validation.

**Emits:** `customPatternRegistered` event with the pattern name and description.

Registration is append-only in v1 — there is no `unregisterPattern`. A registered pattern can be suppressed via the `suppressedPatterns` configuration mechanism (cl-spec-003 section 9.2), but not removed. See cl-spec-003 section 10.4 for the full registration lifecycle.

### 6.4 Serialization

context-lens output objects (QualityReport, DiagnosticSnapshot, EvictionPlan) are schema-conforming data structures defined in cl-spec-011. The serialization API produces plain objects suitable for `JSON.stringify`, external transmission, and cross-language consumption.

#### toJSON

```
toJSON(output: QualityReport | DiagnosticSnapshot | EvictionPlan) -> object
```

Converts a context-lens output to a plain, schema-conforming JSON object. Overloaded on input type — the return type matches the corresponding schema (cl-spec-011 sections 3–5).

**Behavior:**
1. Strips non-serializable internal state (cached computation intermediates, provider references, internal flags).
2. Sets the `schemaVersion` field to the current schema version.
3. Applies serialization conventions (cl-spec-011 section 8): timestamps as epoch-ms numbers, enums as strings, nulls where defined.
4. Returns a plain object with no circular references, suitable for `JSON.stringify`.

**Returns:** A plain object that validates against the corresponding JSON Schema file.

**Throws:** Never. If the input is a valid context-lens output, `toJSON` always succeeds.

`toJSON` is a **pure function** — it does not access instance state, call providers, or emit events. It can be called on any output from any instance, including outputs from previous sessions if the caller retained them.

#### schemas

Static schema access, available without a context-lens instance:

```
import { schemas } from 'context-lens'

schemas.qualityReport        // → JSON Schema object for QualityReport
schemas.diagnosticSnapshot   // → JSON Schema object for DiagnosticSnapshot
schemas.evictionPlan         // → JSON Schema object for EvictionPlan
schemas.version              // → current schema version string (e.g., "1.0.0")
```

These are the same schema objects that the JSON Schema files contain (cl-spec-011 section 9.1), available in-process. They are static exports — they do not change at runtime.

#### validate

Static validation utilities:

```
import { validate } from 'context-lens'

validate.qualityReport(obj)        // → { valid: boolean, errors: ValidationError[] }
validate.diagnosticSnapshot(obj)   // → { valid: boolean, errors: ValidationError[] }
validate.evictionPlan(obj)         // → { valid: boolean, errors: ValidationError[] }
```

Validates a plain JSON object against the corresponding schema. Returns a result object with `valid` (boolean) and `errors` (array of validation errors, empty if valid). Uses a JSON Schema draft 2020-12 validator internally.

Formatting utilities (`formatReport`, `formatDiagnostics`, `formatPattern`) are defined in cl-spec-010 section 8. These are pure functions that produce plain-text representations of output objects.

### 6.5 State Serialization

#### snapshot

```
snapshot(options?: SnapshotOptions) -> SerializedState
```

Produces a complete, self-contained state snapshot of the instance. The snapshot is a plain object — JSON.stringify-safe, no circular references, no class instances. The format, contents, and semantics are defined in cl-spec-014.

**SnapshotOptions:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `includeContent` | boolean | `true` | Include segment content. When `false`, produces a lightweight (non-restorable) snapshot. |

**Returns:** A `SerializedState` object (cl-spec-014 section 4).

**Emits:** `stateSnapshotted` event.

`snapshot()` is read-only — it does not mutate instance state, trigger computation, or invalidate caches. It is O(n) in the number of segments.

#### fromSnapshot

```
ContextLens.fromSnapshot(state: SerializedState, config?: RestoreConfig) -> ContextLens
```

A static factory method that creates a new instance from a serialized snapshot. The returned instance is fully functional.

**RestoreConfig:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `capacity` | number | snapshot's capacity | May differ from snapshot. |
| `tokenizer` | TokenizerProvider or `"approximate"` | `"approximate"` | Must be re-provided. |
| `embeddingProvider` | EmbeddingProvider or null | `null` | Must be re-provided. |
| `customPatterns` | PatternDefinition[] | `[]` | Custom patterns to re-register. Matched to snapshot metadata by name. |

**Preconditions:**
- `state.formatVersion` must be a supported format version. Throws `ConfigurationError`.
- `state.restorable` must be `true`. Throws `ConfigurationError` for lightweight snapshots.

**Behavior:** Restores segments, groups, task state, baseline, continuity ledger, pattern tracking state, history, and configuration from the snapshot. Detects provider changes and triggers recount/re-embed as needed. Invalidates all quality scores. Full restore sequence defined in cl-spec-014 section 5.2.

**Returns:** A fully functional `ContextLens` instance.

**Throws:** `ConfigurationError` on format/version/restorability failures.

**Emits:** `stateRestored` event on the new instance.

---

## 7. Provider Management

Providers — tokenizers and embedding models — are configured at construction time and can be switched at runtime. Switching has well-defined invalidation semantics defined in cl-spec-005 section 6 and cl-spec-006 section 5.2.

### 7.1 setTokenizer

```
setTokenizer(provider: TokenizerProvider | "approximate") -> void
```

Switches the active tokenizer provider.

**Behavior:**
1. Validates the new provider (same checks as constructor).
2. If the new provider has the same `name` as the current provider, this is a no-op.
3. Invalidates the entire token count cache.
4. Recounts all active segments using the new provider. This is a full O(n) recount — every segment's `tokenCount` is recomputed and all aggregates are updated (cl-spec-006 section 5.2).
5. Invalidates all quality score caches (token counts feed density scoring).

**Throws:** `ProviderError` if validation fails. On failure, the previous provider remains active.

**Emits:** `tokenizerChanged` event with old and new provider names.

### 7.2 setEmbeddingProvider

```
setEmbeddingProvider(provider: EmbeddingProvider | null) -> void
```

Switches the active embedding provider. Pass `null` to remove the provider and downgrade to trigram-only mode.

**Behavior:**
1. Validates the new provider (if non-null).
2. If the new provider has the same `name` as the current provider, this is a no-op.
3. Executes the 5-step invalidation cascade (cl-spec-005 section 6):
   - Clears the embedding cache.
   - Invalidates the similarity cache.
   - Invalidates all quality scores.
   - Recomputes embeddings for all active segments (or switches to trigrams if provider is `null`).
   - Recomputes task description embedding (if a task is set).
4. If recomputation fails mid-way, rolls back to trigram mode. The previous provider is not restored — the system downgrades rather than leaving inconsistent state (cl-spec-005 section 6).

**Throws:** `ProviderError` if validation fails (pre-switch). Mid-switch failures result in trigram fallback, not thrown errors.

**Emits:** `embeddingProviderChanged` event with old and new provider names (or `null`).

### 7.3 getTokenizerInfo

```
getTokenizerInfo() -> TokenizerMetadata
```

Returns metadata about the active tokenizer: `name`, `accuracy` (`exact` or `approximate`), `modelFamily`, `errorBound`.

### 7.4 getEmbeddingProviderInfo

```
getEmbeddingProviderInfo() -> EmbeddingProviderMetadata | null
```

Returns metadata about the active embedding provider, or `null` if in trigram-only mode: `name`, `dimensions`, `modelFamily`.

**EmbeddingProviderMetadata:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Provider name |
| `dimensions` | number | Embedding vector dimensions |
| `modelFamily` | string or null | Model family identifier |
| `maxInputTokens` | number or null | Maximum input length in tokens |

---

## 8. Capacity and Inspection

Inspection methods provide read-only access to instance state without triggering quality computation. They are cheap — O(1) for aggregate queries, O(n) for collection queries — and always return data consistent with the most recent mutation.

### 8.1 setCapacity

```
setCapacity(newCapacity: number) -> void
```

Changes the configured token capacity.

**Preconditions:** `newCapacity` must be a positive integer. Throws `ConfigurationError` otherwise.

**Behavior:** Updates the capacity. Recalculates utilization and headroom. Invalidates saturation pattern state (new thresholds apply to new capacity). Does not recount tokens or recompute quality scores — only the denominator changes.

**Emits:** `capacityChanged` event with old and new values.

### 8.2 getCapacity

```
getCapacity() -> CapacityReport
```

Returns the current capacity report — the same `CapacityReport` structure included in `assess`, but without triggering quality computation. This is the lightweight path for callers who need capacity metrics without the cost of a full quality report.

### 8.3 getSegment

```
getSegment(id: string) -> Segment | null
```

Returns the segment with the given ID (ACTIVE or EVICTED), or `null` if no such segment exists. Returns a defensive copy.

**Segment:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Segment identifier. |
| `content` | string or `null` | Segment content. `null` if evicted with `retainEvictedContent: false`. |
| `tokenCount` | number | Token count. |
| `createdAt` | timestamp | Insertion time. |
| `updatedAt` | timestamp | Last modification time. |
| `protection` | protection level | Current protection tier. |
| `importance` | number (0.0–1.0) | Current importance. |
| `origin` | string or `null` | Provenance label. |
| `tags` | string[] | Custom labels. |
| `groupId` | string or `null` | Group membership. |
| `state` | `"active"` or `"evicted"` | Current lifecycle state. |

### 8.4 listSegments

```
listSegments(filter?: SegmentFilter) -> Segment[]
```

Returns segments matching the filter, in segment order. If no filter is provided, returns all ACTIVE segments.

**SegmentFilter:**

| Field | Type | Description |
|-------|------|-------------|
| `state` | `"active"` or `"evicted"` or `"all"` | Filter by lifecycle state. Default: `"active"`. |
| `protection` | protection level or protection level[] | Filter by protection tier(s). |
| `groupId` | string | Filter to members of a specific group. |
| `origin` | string | Filter by origin tag. |
| `tags` | string[] | Filter to segments that have all specified tags. |
| `minImportance` | number | Filter to segments with importance ≥ this value. |

Filters are conjunctive (AND). A segment must match all specified criteria.

### 8.5 getSegmentCount

```
getSegmentCount() -> { active: number, evicted: number, total: number }
```

Returns segment counts by state.

### 8.6 getEvictionHistory

```
getEvictionHistory() -> EvictionRecord[]
```

Returns all eviction records for the session, ordered by timestamp. This is the raw data behind the continuity ledger — every eviction and its pre-eviction quality snapshot.

### 8.7 Diagnostics

`getDiagnostics() → DiagnosticSnapshot`

Returns a diagnostic snapshot of the instance's internal state, including report history, pattern history, session timeline, performance metrics, cache metrics, and provider information. Assembly only — no computation triggered. Tier 1 (<1ms).

See cl-spec-010 for the complete DiagnosticSnapshot structure.

### 8.8 Eviction Planning

`planEviction(target: number, options?: PlanEvictionOptions) → EvictionPlan`

Produces a ranked list of eviction candidates to reclaim at least `target` tokens. The plan is advisory — the caller decides which candidates to actually evict. Read-only: may trigger `assess()` if no current report exists, but does not modify segments.

Options: `strategy` (override auto-selection), `includeSeeds` (default false), `compressionRatio` (default 0.5 for compaction recommendations).

See cl-spec-008 for the complete EvictionPlan structure and ranking algorithm.

---

## 9. Lifecycle

context-lens instances have an explicit terminal state. The methods documented in this section transition an instance to that state and let callers probe its current state. The full behavioral contract — teardown sequence, atomicity, failure model, integration callbacks, error semantics, and per-method dispatch rules during and after disposal — is specified by cl-spec-015. This section summarizes the public surface; cl-spec-015 governs behavior.

The three lifecycle methods (`dispose`, `isDisposed`, `isDisposing`) are the only public methods that remain valid after disposal. Every other public method on a disposed instance throws `DisposedError` (section 11.1). Mutating public methods invoked while disposal is in progress (`isDisposing === true`) also throw `DisposedError` per the read-only-during-disposal rule (cl-spec-015 §3.4).

### 9.1 dispose

```
dispose() → void
```

Transitions the instance from live to disposed. Synchronous, idempotent, parameterless. The teardown sequence — set disposing flag, emit `stateDisposed`, notify lifecycle-aware integrations (fleet aggregators per cl-spec-012, OpenTelemetry exporters per cl-spec-013), clear caches and ring buffers, detach the event registry, set the disposed flag — is specified by cl-spec-015 §4.

Caller-supplied callback errors during steps 2 (`stateDisposed` handlers) and 3 (integration teardown callbacks) are caught, aggregated into a per-call disposal error log, and surfaced as a single `DisposalError` (section 11.1) raised after teardown completes. Disposal itself is unconditional — it completes regardless of how many callbacks throw, and the instance is fully disposed at the moment `DisposalError` is raised.

Calling `dispose()` on an already-disposed instance is a no-op: no event, no teardown, no error. Reentrant calls from inside a `stateDisposed` handler observe `isDisposing === true` and return immediately.

Provider lifecycle (tokenizer per cl-spec-006, embedding provider per cl-spec-005) is caller-managed — `dispose()` does not invoke provider shutdown hooks. The recommended caller pattern is `dispose()` first (releasing the library's references) and then await any provider shutdowns (cl-spec-015 §6.5).

Throws `DisposalError` only if one or more caller-supplied callbacks threw during teardown. Never throws on its own internal logic; library-internal teardown steps are infallible by construction (cl-spec-015 §4.3).

### 9.2 isDisposed

```
readonly isDisposed: boolean
```

Returns `true` once `dispose()` has returned successfully (the disposed flag set in step 6 of teardown), `false` otherwise. Never throws. Remains valid in both live and disposed states.

The predicate for "is this instance terminal?" — used by external integrations and caller-supplied health checks to decide whether to invoke methods that need post-disposal recovery semantics (cl-spec-015 §2.5).

### 9.3 isDisposing

```
readonly isDisposing: boolean
```

Returns `true` while a `dispose()` call is on the stack — between the start of teardown (the disposing flag set in step 1) and the originating call's return — and `false` otherwise. Never throws. Remains valid in both live and disposed states.

The predicate for "should I avoid mutating methods right now?" — used by `stateDisposed` handlers and integration teardown callbacks to gate their own mutation calls (cl-spec-015 §2.5). During disposal, mutating public methods throw `DisposedError` per the read-only-during-disposal rule; read-only methods behave per their live specification until backing state is cleared.

`isDisposed` and `isDisposing` are mutually exclusive — at most one is true at any inspection point. Both are false during normal live operation.

---

## 10. Event System

context-lens emits 25 events on lifecycle transitions. The event system is synchronous and observer-based — handlers are called inline during the operation that triggers the event. This means handlers execute before the triggering method returns.

### 10.1 Subscribing

```
on(event: EventName, handler: (payload: EventPayload) -> void) -> Unsubscribe
```

Registers an event handler. Returns an unsubscribe function that removes the handler when called.

Multiple handlers can be registered for the same event. Handlers are called in registration order. Handler errors are caught and do not propagate to the caller or prevent subsequent handlers from running — a failing handler should not break context-lens operations.

### 10.2 Events

| Event | Payload | Emitted when |
|-------|---------|-------------|
| `segmentAdded` | `{ segment: Segment }` | `add` or `seed` inserts a segment. |
| `segmentUpdated` | `{ segment: Segment, changes: string[] }` | `update` modifies a segment. `changes` lists which fields changed. |
| `segmentReplaced` | `{ segment: Segment, previousTokenCount: number }` | `replace` overwrites content. |
| `segmentCompacted` | `{ segment: Segment, record: CompactionRecord }` | `compact` summarizes content. |
| `segmentSplit` | `{ originalId: string, children: Segment[] }` | `split` divides a segment. |
| `segmentEvicted` | `{ record: EvictionRecord }` | `evict` removes a segment. Fired once per segment (group eviction fires multiple times). |
| `segmentRestored` | `{ segment: Segment, fidelity: number }` | `restore` returns a segment. `fidelity` is the restoration fidelity score. |
| `groupCreated` | `{ group: Group }` | `createGroup` forms a group. |
| `groupDissolved` | `{ groupId: string, memberIds: string[] }` | `dissolveGroup` breaks a group. |
| `taskChanged` | `{ transition: TaskTransition }` | `setTask` changes the task (not on `"same"` transitions). |
| `taskCleared` | `{}` | `clearTask` removes the task. |
| `tokenizerChanged` | `{ oldName: string, newName: string }` | `setTokenizer` switches providers. |
| `embeddingProviderChanged` | `{ oldName: string or null, newName: string or null }` | `setEmbeddingProvider` switches providers. |
| `capacityChanged` | `{ oldCapacity: number, newCapacity: number }` | `setCapacity` resizes. |
| `baselineCaptured` | `{ baseline: BaselineSnapshot }` | The quality baseline is captured (first add after seed). |
| `lateSeeding` | `{ segmentCount: number }` | `seed` is called after `add` — baseline will be re-captured. |
| `pinnedCeilingWarning` | `{ pinnedTokens: number, capacity: number, ratio: number }` | Pinned tokens exceed the configured ceiling ratio. |
| `patternActivated` | `{ pattern: ActivePattern }` | A degradation pattern (base or custom) activates or escalates to a new severity. |
| `patternResolved` | `{ name: PatternName, duration: number, peakSeverity: Severity }` | A degradation pattern (base or custom) deactivates. |
| `customPatternRegistered` | `{ name: string, description: string }` | `registerPattern` successfully registers a custom pattern. |
| `stateSnapshotted` | `{ timestamp: number, restorable: boolean, segmentCount: number, sizeEstimate: number }` | `snapshot` produces a state snapshot. |
| `stateRestored` | `{ formatVersion: string, segmentCount: number, providerChanged: boolean, customPatternsRestored: number, customPatternsUnmatched: number }` | `fromSnapshot` completes restoration on the new instance. |
| `reportGenerated` | `{ report: QualityReport }` | Fired after each `assess()` completes. Payload: the QualityReport. |
| `budgetViolation` | `{ operation: string, selfTime: number, budgetTarget: number }` | Fired when an operation exceeds its performance budget tier. |
| `stateDisposed` | `{ type: 'stateDisposed', instanceId: string, timestamp: number }` | Fired exactly once per instance during step 2 of `dispose()` teardown. Last event the instance ever emits. Payload is frozen. See cl-spec-015 §7.1. |

The session timeline (cl-spec-010 section 5) records a superset of API events. Some timeline event types (e.g., `patternEscalated`, `patternDeescalated`) are logged to the timeline but not emitted as API events.

### 10.3 Handler Contract

- Handlers **must not** call context-lens methods on the same instance. Re-entrant calls (e.g., calling `add` inside a `segmentEvicted` handler) would violate atomicity invariants. context-lens does not guard against re-entrancy — the behavior is undefined. If the caller needs to react to events with mutations, they should queue the mutations and apply them after the triggering operation returns.
- Handlers should be fast. They run inline — a slow handler slows down the operation that triggered the event.
- Handler errors are caught, logged (if a logger is configured), and swallowed. The operation proceeds regardless of handler failures. This prevents observer bugs from corrupting context-lens state.

The general "must not call methods, behavior is undefined" rule above has a single deliberate exception: `stateDisposed` handlers (cl-spec-015 §3.4) are governed by the **read-only-during-disposal rule**. They may call read-only public methods (`getCapacity`, `getSegment`, `getDiagnostics`, `assess`, `snapshot`, etc.) — the instance's last live state is intact and may be inspected. Mutating public methods invoked from a `stateDisposed` handler throw `DisposedError` (cl-spec-015 §3.4); they do not fall through to "undefined behavior." Handler errors during `stateDisposed` are also handled differently: rather than being swallowed-and-logged per the rule above, they are aggregated and surfaced as `DisposalError` after teardown completes (cl-spec-015 §4.3, section 11.1). Both deviations exist because disposal is a one-shot terminal lifecycle event — silent corruption of teardown is unacceptable, and per-callback errors carry diagnostic signal that the caller cannot recover from any other source.

---

## 11. Error Model

context-lens uses typed errors with a clear hierarchy. Every error thrown by a public method is an instance of one of these types. Callers can catch specific error types to handle specific failure modes.

### 11.1 Error Hierarchy

```
ContextLensError (base)
├── ConfigurationError       — invalid constructor config or setCapacity value
├── ValidationError          — invalid method arguments (empty content, out-of-range importance, etc.)
├── SegmentNotFoundError     — referenced segment ID does not exist
├── GroupNotFoundError       — referenced group ID does not exist
├── DuplicateIdError         — caller-assigned ID already exists
├── InvalidStateError        — operation incompatible with segment/group state (e.g., update on evicted)
├── ProtectionError          — operation blocked by protection level (e.g., evict pinned)
├── MembershipError          — group membership violation (already in another group)
├── CompactionError          — compact summary is not shorter than original
├── SplitError               — splitFn produced invalid output
├── RestoreError             — restore without content when content was not retained
└── ProviderError            — tokenizer or embedding provider validation/execution failure

Lifecycle errors (cl-spec-015) — extend native Error rather than ContextLensError:
DisposedError extends Error              — public method invoked on a disposed instance,
                                            or mutating method invoked during disposal
DisposalError extends AggregateError     — caller-supplied callbacks errored during dispose() teardown
```

The lifecycle errors deliberately bypass `ContextLensError` so they can extend platform-native classes (`AggregateError` in particular requires the inheritance chain). Callers distinguish them from `ContextLensError` subclasses using `instanceof` and the `name` field. See cl-spec-015 §7.2 for full type definitions, fields, and message conventions.

All errors extend `ContextLensError`, which extends the platform's native `Error`. Every error includes:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Error type name (e.g., `"SegmentNotFoundError"`). |
| `message` | string | Human-readable description of what went wrong. |
| `code` | string | Machine-readable error code (e.g., `"SEGMENT_NOT_FOUND"`). |
| `details` | object or `null` | Structured context: which segment ID, which operation, what the expected state was. |

The lifecycle errors (`DisposedError`, `DisposalError`) do not carry the `ContextLensError` fields above. They expose their own fields per cl-spec-015 §7.2: `DisposedError` carries `name`, `instanceId`, `attemptedMethod`; `DisposalError` carries `name`, `instanceId`, and the inherited `errors` array from `AggregateError`.

### 11.2 Error Codes

| Code | Error type | Trigger |
|------|-----------|---------|
| `INVALID_CONFIG` | `ConfigurationError` | Constructor config validation failure. |
| `INVALID_ARGUMENT` | `ValidationError` | Method argument out of range or wrong type. |
| `SEGMENT_NOT_FOUND` | `SegmentNotFoundError` | ID does not exist in any state. |
| `GROUP_NOT_FOUND` | `GroupNotFoundError` | Group ID does not exist. |
| `DUPLICATE_ID` | `DuplicateIdError` | Caller-assigned ID collides with existing. |
| `INVALID_STATE` | `InvalidStateError` | Segment/group in wrong state for operation. |
| `PROTECTION_VIOLATION` | `ProtectionError` | Operation blocked by protection tier. |
| `MEMBERSHIP_VIOLATION` | `MembershipError` | Segment already in a group, or group constraint violated. |
| `COMPACTION_NOT_SHORTER` | `CompactionError` | Summary ≥ original token count. |
| `SPLIT_INVALID_OUTPUT` | `SplitError` | `splitFn` returned empty array or empty strings. |
| `RESTORE_MISSING_CONTENT` | `RestoreError` | Content discarded and not provided on restore. |
| `PROVIDER_VALIDATION` | `ProviderError` | Provider fails validation (bad count, bad metadata). |
| `PROVIDER_EXECUTION` | `ProviderError` | Provider throws during count/embed. |

The lifecycle errors are not assigned `code` strings — they are distinguished by class identity (`instanceof DisposedError`, `instanceof DisposalError`) and by their `name` field per cl-spec-015 §7.2.

### 11.3 Error Guarantees

1. **Atomic failure.** If a method throws, no observable state has changed. The instance is in the same state as before the call. This applies to all segment operations, group operations, and task operations. Provider switches are the one exception: a mid-switch embedding failure results in trigram fallback rather than rollback (section 7.2). `dispose()` is also an exception: when it throws `DisposalError` after caller-supplied callbacks errored, the instance has already transitioned to disposed and the error is informational (cl-spec-015 §4.3).
2. **No silent failures.** context-lens does not swallow errors and return partial results. If token counting fails for one segment in a `seed` batch, the entire batch fails. The caller always knows whether an operation succeeded or not.
3. **Predictable types.** Every public method documents which error types it can throw. A method that documents `SegmentNotFoundError` and `ProtectionError` will only throw those types (plus `ProviderError` if the operation triggers token counting or embedding). Callers can write exhaustive catch blocks. Every public method other than `dispose`, `isDisposed`, and `isDisposing` additionally throws `DisposedError` when invoked on a disposed instance, and mutating methods additionally throw `DisposedError` when invoked during disposal — these are universal post/during-disposal guards documented globally rather than per-method (cl-spec-015 §5.1, §3.4).

---

## 12. Invariants and Constraints

The following invariants hold across all public API operations. They extend and do not contradict the invariants defined in specs 1–6.

### API-Level Invariants

1. **Snapshot consistency.** Every read method (`getSegment`, `listSegments`, `getCapacity`, `assess`, `getTask`, etc.) returns data consistent with the most recent completed mutation. There is no window between a mutation returning and its effects being visible.

2. **Atomic mutations.** Every mutating method (`add`, `update`, `replace`, `compact`, `split`, `evict`, `restore`, `createGroup`, `dissolveGroup`, `setTask`, `clearTask`) either completes fully or has no effect. Partial mutations are never observable. `assess()` is not a mutating method. It either returns a complete QualityReport or throws. Custom pattern failures within `assess()` are handled per cl-spec-003 §10.5 (fail-open) and do not prevent report generation.

3. **Deterministic reports.** Given the same sequence of operations on the same instance, `assess` produces identical scores. Scores depend only on segment content, metadata, task state, and provider behavior — never on wall-clock time, random state, or external factors. Timestamps in reports reflect wall-clock time but do not influence scores.

4. **Defensive copies.** All objects returned by the API are copies. Mutating a returned `Segment`, `Group`, `QualityReport`, or `TaskDescriptor` has no effect on instance state. All objects accepted by the API are copied on input — mutating the caller's object after passing it to a method has no effect.

5. **Event ordering.** Events are emitted in a deterministic order relative to the operation that triggers them. For operations that emit multiple events (e.g., group eviction emits one `segmentEvicted` per member), events are emitted in segment order. All events for an operation are emitted before the method returns.

6. **Re-entrancy prohibition.** Calling any mutating method on the same instance from within an event handler is undefined behavior. context-lens does not guard against this — the caller is responsible for avoiding re-entrancy.

7. **Provider consistency.** At any point in time, all token counts in the instance reflect the current tokenizer, and all embeddings (if any) reflect the current embedding provider. There is no state where some segments use one provider and others use a different one.

8. **Capacity is advisory.** Adding segments that exceed capacity does not throw. context-lens reports the overage through utilization > 1.0 and saturation pattern activation. Enforcement is the caller's responsibility.

**Read-only consumer contract.** Consumer modules (eviction advisory, diagnostics, fleet monitor, observability exporter) do not call segment-mutating methods (`add`, `update`, `replace`, `compact`, `split`, `evict`, `restore`) or configuration-mutating methods (`setTask`, `clearTask`, `setTokenizer`, `setEmbeddingProvider`). They may call `assess()`, which updates internal caches but does not modify segments or configuration.

**Instance lifecycle.** context-lens instances have an explicit terminal state and the `dispose()` method that transitions to it (section 9, cl-spec-015). Long-lived callers (monitoring daemons, multi-agent orchestrators, server processes handling rolling contexts) **must** call `dispose()` to release event handlers, caches, history buffers, and external integration back-references — garbage collection alone is insufficient because event subscribers and integrations hold strong references that prevent GC. Short-lived callers **may** call `dispose()` to release resources earlier than GC would. After `dispose()` returns, `isDisposed === true` and every public method except `dispose`, `isDisposed`, and `isDisposing` throws `DisposedError`. The full lifecycle contract — teardown sequence, atomicity, integration callbacks, error semantics — is specified by cl-spec-015. This invariant supersedes the prior "no explicit disposal" claim that this section formerly carried.

**Single-threaded access.** context-lens assumes single-threaded, sequential access. Concurrent calls from multiple async contexts produce undefined behavior. Callers in async environments must serialize access to each instance. Re-entrant calls from event handlers are also prohibited (section 10.3).

### Cross-Spec Invariant Summary

This spec inherits all invariants from specs 1–6. The key cross-cutting invariants, restated for API context:

| Source | Invariant | API implication |
|--------|-----------|----------------|
| cl-spec-001 #1 | Unique IDs | `add` and `seed` reject duplicate caller-assigned IDs. |
| cl-spec-001 #5 | Group atomicity | `evict` and `restore` on grouped segments affect the entire group. |
| cl-spec-001 #9 | Pinned immutability | `update` (with content), `compact`, `split`, `evict` throw on pinned segments. |
| cl-spec-001 #12 | Compaction reduces | `compact` throws if summary is not shorter. |
| cl-spec-001 #13 | Restore preserves position | `restore` inserts at original position, not end. |
| cl-spec-001 #14 | Soft capacity | `add` succeeds even when over capacity. |
| cl-spec-002 #9 | No LLM calls | `assess` never calls a language model. Embedding calls are permitted. |
| cl-spec-003 #10 | In-budget detection | `assess` runs pattern detection within the quality computation budget — no additional passes. Custom pattern overhead is caller's responsibility. |
| cl-spec-003 #11 | Custom pattern name uniqueness | `registerPattern` rejects names that collide with base or existing custom patterns. |
| cl-spec-003 #13 | Uniform output shape | Custom patterns produce the same `ActivePattern` structure as base patterns — no separate handling. |
| cl-spec-003 #14 | Fail-open detection | A throwing custom pattern does not break base pattern detection or other custom patterns. |
| cl-spec-004 #1 | Caller owns task | context-lens does not infer or modify the task. Only `setTask`/`clearTask` change task state. |
| cl-spec-005 #1 | Single provider | One embedding provider per instance. All embeddings use the same model. |
| cl-spec-005 #5 | Fallback always available | Trigram similarity is always available. Embedding failure degrades to trigrams, not to error. |
| cl-spec-006 #1 | Deterministic counting | Same content + same provider = same token count. |
| cl-spec-006 #7 | Capacity required | Constructor requires `capacity`. No default. |

---

## 13. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-001` (Segment Model) | Segment data structure, lifecycle operations, groups, protection model, invariants. |
| `cl-spec-002` (Quality Model) | Four quality dimensions, scoring mechanics, baseline, composite, quality reports. |
| `cl-spec-003` (Degradation Patterns) | Five base degradation patterns, detection framework, severity model, hysteresis, pattern interactions. Section 10: custom pattern registration (PatternDefinition contract, lifecycle, detection integration). |
| `cl-spec-004` (Task Identity) | Task descriptor model, lifecycle, transitions, grace period, staleness, preparation. |
| `cl-spec-005` (Embedding Strategy) | Embedding provider interface, adapters, caching, provider switching, fallback. |
| `cl-spec-006` (Tokenization Strategy) | Tokenizer provider interface, built-in providers, caching, capacity tracking. |
| `cl-spec-008` (Eviction Advisory) | Consumes quality reports and patterns to produce eviction plans. Depends on this spec. |
| `cl-spec-009` (Performance Budget) | Latency and resource constraints for all API operations. Depends on this spec. |
| `cl-spec-010` (Report & Diagnostics) | Extended reporting, diagnostics API, trend analysis. Depends on this spec. |
| `cl-spec-011` (Report Schema) | JSON Schema definitions for QualityReport, DiagnosticSnapshot, EvictionPlan. Schema versioning. Serialization conventions. Defines what `toJSON` produces and what `validate` checks. |
| `cl-spec-014` (Serialization) | Defines snapshot format, restore semantics, lightweight snapshots, format versioning. Governs what `snapshot()` produces and what `fromSnapshot()` consumes. |
| `cl-spec-015` (Instance Lifecycle) | Defines `dispose()`, `isDisposed`, `isDisposing`, the `stateDisposed` event, and the `DisposedError` / `DisposalError` types added by section 9, section 10.2, and section 11.1 of this spec. Specifies the teardown sequence, atomicity, integration callbacks, and the read-only-during-disposal rule. The handler contract deviation from section 10.3 is documented in cl-spec-015 §3.4 and §4.3. |
| `brainstorm_20260324_context-lens.md` | Origin brainstorm — API shape exploration (Options A/B/C), MVP scope. |

---

*context-lens — authored by Akil Abderrahim, Claude Opus 4.6, and Claude Opus 4.7*
