---
id: cl-spec-001
title: Segment Model
type: design
status: draft
created: 2026-03-24
revised: 2026-03-24
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [segment, core, data-model, lifecycle, grouping, protection]
depends_on: []
---

# Segment Model

## Table of Contents

1. Overview
2. Segment Definition
3. Segment Identity
4. Segment Metadata
5. Grouping
6. Protection Model
7. Lifecycle Operations
8. Invariants and Constraints
9. References

---

## 1. Overview

context-lens treats the context window not as a flat token buffer but as a structured collection of **segments** — discrete units of semantic meaning that can be individually tracked, measured, and managed.

This spec defines the segment as the atomic data structure of context-lens. Every other spec builds on it: the Quality Model (cl-spec-002) scores segments, the Degradation Patterns spec (cl-spec-003) detects problems across them, and the Eviction Advisory (cl-spec-008) decides which to remove.

### Design goals

- **Caller-defined granularity.** context-lens does not impose a segmentation scheme. The caller decides what constitutes a segment — a message, a paragraph, a tool result, an entire document. Optional splitter utilities are provided for callers who want guidance, but they are conveniences, not requirements.
- **Rich identity and metadata.** Every segment carries enough information for quality scoring, eviction ranking, and auditability — without requiring the caller to understand context-lens internals.
- **Composable structure.** Segments can be grouped into atomic units (e.g., a tool call paired with its result). Groups are first-class: they have their own identity, aggregate metadata, and are evicted as a whole.
- **Full lifecycle.** Segments are not append-only. They can be seeded, added, updated, replaced, compacted, split, evicted, and restored. The lifecycle is designed for long-running agent sessions where context evolves continuously.
- **Graduated protection.** Not all segments are equal. Protection ranges from absolute (pinned, never evicted) to priority-based (evicted in order) to unprotected (default eviction candidates). Seeded segments occupy a distinct tier — foundational but not sacred.

## 2. Segment Definition

### 2.1 What is a Segment

A **segment** is the smallest unit of content that context-lens tracks independently. It represents a region of semantic meaning within the context window — content that coheres around a single purpose, topic, or function.

A segment is **not** defined by token count, message boundaries, or role. It is defined by the caller's judgment of what constitutes a meaningful unit. Examples:

| Caller's segmentation choice | Segment content |
|------------------------------|----------------|
| Per-message | A single user message, assistant response, or tool output |
| Per-turn | A user message + assistant response as one segment |
| Per-document | An entire file loaded into context |
| Per-section | One section of a long document |
| Per-concept | A block of context that introduces or explains one idea |

context-lens is agnostic to the caller's choice. The quality model scores whatever segments it receives. Finer segmentation yields more granular quality signals and eviction control; coarser segmentation reduces overhead.

### 2.2 Boundary Rules

context-lens enforces only structural constraints on segments, not semantic ones:

1. **Non-empty.** A segment must contain at least one token of content.
2. **Non-overlapping.** Within a context window, no token belongs to more than one segment. Segments partition the content they cover — but they need not cover the entire window (gaps are allowed if the caller manages some content outside context-lens).
3. **Ordered.** Segments maintain insertion order. This order is used by coherence scoring (adjacent-segment similarity) and is preserved across lifecycle operations.
4. **Self-contained identity.** A segment's identity does not depend on its position. Moving, evicting, or restoring a segment does not change its ID.

### 2.3 Splitters (Optional Utilities)

For callers who prefer not to define their own segmentation, context-lens provides **splitters** — functions that take raw content and return an ordered list of segments.

Splitters are utilities, not core. They live outside the segment model and are not required for any operation.

| Splitter | Strategy | Use case |
|----------|----------|----------|
| `byMessage` | One segment per message object | Chat-based applications with message arrays |
| `byTurn` | One segment per user-assistant exchange | Conversational agents wanting turn-level granularity |
| `byTokenBudget(n)` | Split content into chunks of at most `n` tokens | Loading large documents with even chunk sizes |
| `byDelimiter(d)` | Split on a delimiter (heading, separator, etc.) | Structured documents with clear section markers |

Splitters produce segments with auto-generated IDs and default metadata. The caller can override either after splitting.

## 3. Segment Identity

Every segment has a unique identifier within its context window. IDs are the primary handle for all lifecycle operations — evict, restore, update, compact, and group membership all reference segments by ID.

### 3.1 Caller-Assigned IDs

When the caller provides an ID, context-lens uses it verbatim. Caller-assigned IDs are the preferred path for applications that need stable, meaningful references to context regions.

Constraints on caller-assigned IDs:

- **Type:** string
- **Length:** 1–256 characters
- **Characters:** alphanumeric, hyphens, underscores, dots, colons. No whitespace.
- **Uniqueness:** Must be unique within the context window at time of insertion. Attempting to `add` or `seed` a segment with a duplicate ID is an error. (To replace content at an existing ID, use `replace`.)

Recommended conventions (not enforced):

- `system-prompt` — for the system prompt segment
- `tool:<tool_name>:<call_id>` — for tool results
- `user:<turn_number>` — for user messages
- `doc:<filename>` — for loaded documents

### 3.2 Auto-Generated IDs

When the caller omits an ID, context-lens generates one using a deterministic content hash:

```
id = "auto:" + hash(content)[0:16]
```

The hash function is a fast, non-cryptographic hash (e.g., xxHash64) of the segment's content bytes. This produces:

- **Determinism.** Identical content produces identical IDs. This is intentional — it enables deduplication (section 3.3).
- **Stability.** The ID does not change unless the content changes. Metadata updates do not affect auto-generated IDs.
- **Collision resistance.** 16 hex characters (64 bits) provide sufficient uniqueness for context windows up to millions of segments.

If a hash collision occurs (different content, same truncated hash), context-lens appends an incrementing suffix: `auto:<hash>:1`, `auto:<hash>:2`, etc.

### 3.3 Uniqueness and Deduplication

Auto-generated IDs enable **passive deduplication**. When a segment is added with no caller ID and its content hash matches an existing segment:

1. context-lens does **not** silently discard the duplicate. Silent data loss is unacceptable.
2. Instead, it returns a **duplicate detection signal** — the existing segment's ID and a flag indicating the match.
3. The caller decides: skip, replace, or add anyway (with a suffixed ID).

This matters for density scoring (cl-spec-002). Duplicate content is the most direct form of low density. By detecting it at insertion time, context-lens can surface redundancy before it degrades quality.

Deduplication is **content-only**. Two segments with identical content but different metadata (different importance, different origin) are still flagged as duplicates. The caller may legitimately want both — the signal is advisory, not enforced.

## 4. Segment Metadata

Every segment carries metadata alongside its content. Metadata serves three consumers: the quality model (scoring), the eviction advisor (ranking), and the caller (auditability). Fields are divided into core (always present) and optional (caller-provided).

### 4.1 Core Fields

These fields exist on every segment. context-lens populates them automatically if the caller does not provide them.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | auto-generated (section 3.2) | Unique identifier |
| `content` | string | *(required)* | The segment's text content |
| `tokenCount` | number | computed at insertion | Token count per the configured tokenizer (cl-spec-006) |
| `createdAt` | timestamp | insertion time | When the segment was first added or seeded |
| `updatedAt` | timestamp | same as `createdAt` | Last modification time (updated on `update`, `replace`, `compact`) |
| `protection` | protection level | `default` | Protection tier (section 6) |
| `importance` | number (0.0–1.0) | `0.5` | Caller-assigned priority weight. Higher = harder to evict |

### 4.2 Origin Tag

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `origin` | string or null | `null` | Freeform provenance label |

The origin tag is optional but recommended. It tells the eviction advisor *where* this content came from, which informs eviction strategy even when importance scores are equal.

Examples: `"user"`, `"assistant"`, `"tool:grep"`, `"tool:web-search"`, `"document:README.md"`, `"summary:compacted"`.

context-lens does not interpret origin values — they are opaque strings. However, the eviction advisor (cl-spec-008) may use origin as a tiebreaker: when two segments have equal importance and relevance, origin provides a heuristic for which is more replaceable (e.g., a tool result can be re-fetched; a user instruction cannot).

### 4.3 Importance (Priority)

Importance is a continuous value from `0.0` (fully expendable) to `1.0` (critical). It is the caller's explicit signal of how much this segment matters, independent of what the quality model computes.

Importance interacts with but does not replace protection levels (section 6):

- A `pinned` segment is never evicted regardless of importance.
- A `seed` segment uses importance as a tiebreaker among other seeds.
- Among `priority(n)` and `default` segments, importance is the primary eviction ranking signal, modulated by the quality model's relevance and coherence scores.

The default of `0.5` is neutral — it neither accelerates nor resists eviction. Callers who never set importance get uniform eviction behavior driven purely by the quality model.

### 4.4 Timestamps and Token Count

**Timestamps** enable temporal reasoning:

- `createdAt` is immutable after insertion. It records when the segment entered the window.
- `updatedAt` tracks the most recent mutation. The delta between `createdAt` and `updatedAt` indicates how much a segment has evolved.
- Timestamps are used by the eviction advisor as a recency signal. Older segments with low relevance are stronger eviction candidates than recent ones.

**Token count** is computed by context-lens at insertion time using the configured tokenizer (cl-spec-006). It is recomputed on `update`, `replace`, and `compact`. The caller cannot override it — token count must reflect actual content to maintain accurate utilization tracking.

### 4.5 Custom Tags

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tags` | string[] | `[]` | Caller-defined labels for filtering and grouping |

Tags are arbitrary strings the caller attaches for their own use. context-lens does not interpret them, but exposes them in quality reports and eviction plans so the caller can filter or post-process results.

Examples: `["auth", "critical-path"]`, `["iteration-3", "refactor"]`, `["ephemeral"]`.

Tags are mutable — they can be added or removed via `update` without changing the segment's content or ID.

## 5. Grouping

Some segments are only meaningful together. A tool call without its result is incoherent. A multi-part document split across segments loses continuity if only half is evicted. Groups formalize this relationship.

A **group** is a named, ordered collection of segments that context-lens treats as a unit for eviction and coherence scoring.

### 5.1 Group Identity and Metadata

Groups are first-class objects with their own identity:

| Field | Type | Description |
|-------|------|-------------|
| `groupId` | string | Unique identifier (same constraints as segment IDs, section 3.1) |
| `members` | string[] | Ordered list of segment IDs belonging to this group |
| `protection` | protection level | Group-level protection (overrides member-level; see section 5.3) |
| `importance` | number (0.0–1.0) | Group-level importance (overrides member-level for eviction ranking) |
| `origin` | string or null | Optional provenance for the group as a whole |
| `tags` | string[] | Caller-defined labels |
| `createdAt` | timestamp | When the group was formed |

Groups are created explicitly by the caller — context-lens does not infer grouping. A segment may belong to **at most one group**. Attempting to add a segment to a second group is an error; the caller must remove it from the first group before reassigning.

Ungrouped segments are independent — they are evaluated and evicted individually.

### 5.2 Aggregate Properties

context-lens computes aggregate properties from a group's members:

| Property | Aggregation | Description |
|----------|-------------|-------------|
| `tokenCount` | sum of members | Total tokens consumed by the group |
| `importance` | explicit group value, or max of members if unset | The group is as important as its most important member unless the caller overrides |
| `protection` | explicit group value, or max of members if unset | The group inherits the strongest protection of any member unless the caller overrides |
| `coherence` | computed by quality model | Internal coherence among group members (cl-spec-002) |

Aggregates are recomputed when members are added, removed, or mutated. The caller can override `importance` and `protection` at the group level — when set explicitly, member-level values are ignored for eviction purposes.

### 5.3 Atomic Eviction

Groups are evicted atomically: all members are evicted together, or none are. The eviction advisor (cl-spec-008) treats a group as a single eviction candidate with aggregate token cost and aggregate importance.

This means:

- **A group cannot be partially evicted.** If the advisor needs to reclaim fewer tokens than the group occupies, it must look elsewhere or accept reclaiming more than the target.
- **Evicting a group evicts all members.** Each member transitions to the evicted state and becomes eligible for restore (section 7.7, 7.8).
- **Restoring a group restores all members.** Partial restore of a group is not permitted — the coherence guarantee works both ways.

If the caller needs to break a group apart (e.g., to evict one member while keeping the rest), they must explicitly dissolve the group first, returning all members to independent status.

## 6. Protection Model

Protection determines whether and when a segment is eligible for eviction. It is a graduated system — not a binary lock — because different content has different relationships to context integrity.

### 6.1 Protection Levels

Four levels, ordered from strongest to weakest:

| Level | Evictable? | Compactable? | Typical use |
|-------|-----------|-------------|-------------|
| `pinned` | Never | Never | System prompts, safety instructions, hard constraints |
| `seed` | Under extreme pressure only | Yes | Foundational context, project descriptions, key documents |
| `priority(n)` | Yes, in priority order (lowest `n` first) | Yes | Important but expendable content, ranked by caller |
| `default` | Yes, first candidates | Yes | Normal conversation content, tool results, transient context |

### 6.2 Pinned Segments

Pinned segments are **absolute**. They cannot be evicted or compacted under any circumstances. The eviction advisor will never include them as candidates, even if the window is at capacity and no other segments remain.

This means pinned content is a hard floor on token usage. If pinned segments consume 30% of the window, only 70% is available for managed content. context-lens tracks and reports this:

- `pinnedTokens` — total tokens locked by pinned segments
- `availableCapacity` — `capacity - pinnedTokens`

Callers must use pinned sparingly. Over-pinning is a design error that context-lens can warn about (when pinned tokens exceed a configurable threshold of capacity) but cannot prevent.

### 6.3 Seeded Segments

Seeds are foundational context loaded before or at the start of a session via the `seed` lifecycle operation (section 7.1). They differ from pinned in one critical way: **seeds can be compacted and, under extreme pressure, evicted.**

Eviction of seeds is a last resort. The eviction advisor will exhaust all `default` and `priority(n)` candidates before considering seeds. When seeds must be evicted, it prefers to compact them first (replacing content with a summary that preserves the segment's identity and core meaning).

Seeds establish the **quality baseline**. Coherence, density, and relevance scores at turn zero are measured against seeded content. This gives the quality model a reference point — degradation is measured as drift from the seed state.

Seed protection is not a priority number. It is a distinct tier between `pinned` and `priority(n)`. All seeds are evicted after all priority and default segments, regardless of importance scores. Among seeds, importance is the tiebreaker.

### 6.4 Priority-Based Protection

`priority(n)` assigns a numeric rank where `n` is an integer from 0 to 999. Lower values are evicted first.

- `priority(0)` — evicted immediately after `default` segments
- `priority(999)` — evicted last among priority segments, just before seeds

Within the same priority level, the eviction advisor uses importance (section 4.3) and quality model signals (relevance, coherence contribution) to rank candidates.

Priority levels give callers coarse-grained eviction ordering without requiring fine-tuned importance scores. A caller can assign `priority(100)` to conversation history and `priority(500)` to key reference documents, ensuring documents outlast conversation turns.

### 6.5 Default (Unprotected)

Segments with `default` protection are the first eviction candidates. They have no special treatment — the eviction advisor ranks them purely by importance and quality model signals.

Most segments in a typical session are `default`. This is intentional. The quality model and eviction advisor exist to make intelligent decisions about default segments so that callers don't need to manually protect everything.

### 6.6 Protection Transitions

Protection is mutable. A segment's protection level can be changed via `update`:

- Promoting a segment (e.g., `default` to `priority(200)`) takes effect immediately.
- Demoting a segment (e.g., `seed` to `default`) takes effect immediately and makes the segment eligible for eviction on the next advisory cycle.
- Pinning an evicted segment is an error — restore it first.

Protection transitions do not affect group membership. A segment's group inherits the strongest protection among its members (section 5.2), so promoting one member may promote the effective protection of the entire group.

## 7. Lifecycle Operations

A segment moves through a defined lifecycle. Each operation transitions the segment between states and may trigger recomputation of aggregate properties (group, token counts, quality scores).

### Segment States

```
                seed()     add()
                  |          |
                  v          v
              +-----------------+
              |     ACTIVE      |
              +-----------------+
              | update()        |
              | replace()       |
              | compact()       |
              | split() --> new ACTIVE segments
              +--------+--------+
                       |
                    evict()
                       |
                       v
              +-----------------+
              |    EVICTED      |
              +-----------------+
                       |
                    restore()
                       |
                       v
              +-----------------+
              |     ACTIVE      |
              +-----------------+
```

A segment is in one of two states:

- **ACTIVE** — present in the context window, contributing to token count and quality scores.
- **EVICTED** — removed from the context window but retained in metadata. Content may or may not be preserved (caller-configurable). Does not contribute to token count or quality scores.

### 7.1 Seed

**`seed(content, options?) -> Segment`**

Seeds foundational context into the window. Semantically identical to `add` except:

- Protection defaults to `seed` (not `default`).
- Seeded segments define the quality baseline. The quality model snapshots coherence, density, and relevance after all seeds are loaded. Subsequent quality scores are measured as deltas from this baseline.
- Seeds are expected to be loaded before conversational content. Seeding after `add` is permitted but generates a warning — the quality baseline will be re-snapshotted, which may cause discontinuities in quality trends.

Seed order is significant. Seeds are inserted in call order and their positional relationships are used by coherence scoring.

**Options:** same as `add` (section 7.2), with `protection` defaulting to `seed`.

### 7.2 Add

**`add(content, options?) -> Segment | DuplicateSignal`**

Inserts a new segment into the context window in the ACTIVE state.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | string | auto-generated | Caller-assigned ID |
| `importance` | number (0.0–1.0) | `0.5` | Priority weight |
| `protection` | protection level | `default` | Protection tier |
| `origin` | string | `null` | Provenance label |
| `tags` | string[] | `[]` | Custom labels |
| `groupId` | string | `null` | Add to an existing group |

**Behavior:**

1. If `id` is provided and already exists in the window → error.
2. If `id` is omitted, generate via content hash (section 3.2).
3. If auto-generated ID matches an existing segment → return `DuplicateSignal` (section 3.3). Do not insert.
4. Compute token count via configured tokenizer.
5. Insert at end of segment order.
6. If `groupId` is provided, add to the group's member list. Error if group does not exist or segment already belongs to another group.
7. Trigger recomputation of affected aggregate properties.

### 7.3 Update

**`update(id, changes) -> Segment`**

Modifies a segment's metadata and/or content in place. The segment retains its ID and position.

**Updatable fields:**

| Field | Effect on recomputation |
|-------|------------------------|
| `content` | Token count recomputed. If ID was auto-generated, ID changes (content hash). Quality scores invalidated. |
| `importance` | Group aggregate recomputed if member of a group. |
| `protection` | Group aggregate recomputed if member of a group. |
| `origin` | No recomputation. |
| `tags` | No recomputation. |

**Constraints:**

- Cannot update an EVICTED segment. Restore it first.
- Updating `content` sets `updatedAt` to current time.
- Updating metadata-only fields sets `updatedAt` but does not affect quality scores.

### 7.4 Replace

**`replace(id, newContent, options?) -> Segment`**

Replaces a segment's content entirely while preserving its ID, position, and group membership. This is semantically "the same segment with different content" — distinct from evict-then-add, which would lose positional and group context.

**Behavior:**

1. Segment must be ACTIVE. Error if EVICTED.
2. Content is overwritten. Token count recomputed.
3. `updatedAt` set to current time. `createdAt` unchanged.
4. Metadata from `options` is merged (provided fields overwrite, omitted fields unchanged).
5. Quality scores invalidated for this segment and its group.

**Use case:** A tool result that gets refreshed, a document that is re-read after edits, a summary that gets refined.

### 7.5 Compact

**`compact(id, summary) -> Segment`**

Replaces a segment's content with a shorter summary while preserving identity, position, and group membership. Compact is a specialized form of `replace` with additional constraints and metadata.

**Behavior:**

1. Segment must be ACTIVE. Error if EVICTED.
2. Segment must not be `pinned`. Error if pinned — pinned segments are immutable.
3. `summary` must have fewer tokens than the current content. Error otherwise — compaction must reduce token usage.
4. Content is replaced with `summary`. Token count recomputed.
5. `origin` is updated to `"summary:compacted"` (preserving the original origin in a new metadata field `originalOrigin`).
6. `updatedAt` set to current time.
7. A `compactionRecord` is stored: original token count, compacted token count, compression ratio, timestamp. This record is available in quality reports and eviction audit trails.

**Who generates the summary?** context-lens does not generate summaries. The caller provides the summary text. context-lens is a monitor and advisor, not an LLM wrapper. The caller may use their own LLM call, an extractive summarizer, or any other method.

### 7.6 Split

**`split(id, splitFn) -> Segment[]`**

Breaks a single segment into multiple child segments. The original segment is removed and replaced by the children in its position.

**Behavior:**

1. Segment must be ACTIVE. Error if EVICTED.
2. `splitFn` is a function `(content: string) -> string[]` that returns ordered content chunks. The caller controls the splitting logic.
3. The original segment is removed.
4. Child segments are inserted at the original's position, in order.
5. Child IDs are derived: `<originalId>:0`, `<originalId>:1`, etc. If the original had a caller-assigned ID, children inherit the prefix.
6. Children inherit the original's metadata (importance, protection, origin, tags) unless overridden.
7. If the original belonged to a group, all children join that group.
8. Quality scores are invalidated for the affected region.

**Use case:** A large document loaded as one segment that the caller later wants to manage at section granularity. A tool result that contains multiple logical parts.

### 7.7 Evict

**`evict(id) -> EvictionRecord`**

Removes a segment from the active context window. The segment transitions to the EVICTED state.

**Behavior:**

1. Segment must be ACTIVE. Error if already EVICTED.
2. Segment must not be `pinned`. Error if pinned.
3. If the segment belongs to a group, the entire group is evicted atomically (section 5.3). The caller receives an `EvictionRecord` for each member.
4. The segment no longer contributes to token count or quality scores.
5. Content retention is configurable:
   - `retainContent: true` (default) — content is preserved in memory for potential restore.
   - `retainContent: false` — content is discarded. The segment can still be restored but the caller must provide content again.
6. An `EvictionRecord` is created:

| Field | Type | Description |
|-------|------|-------------|
| `segmentId` | string | ID of the evicted segment |
| `tokenCount` | number | Tokens reclaimed |
| `importance` | number | Importance at time of eviction |
| `protection` | protection level | Protection at time of eviction |
| `reason` | string | Why this segment was evicted (caller-provided or from advisor) |
| `timestamp` | timestamp | When eviction occurred |
| `qualityBefore` | quality snapshot | Quality scores before eviction |

The `EvictionRecord` is retained for the continuity dimension of the quality model (cl-spec-002) and for audit trails.

### 7.8 Restore

**`restore(id, options?) -> Segment`**

Returns an evicted segment to the ACTIVE state.

**Behavior:**

1. Segment must be EVICTED. Error if already ACTIVE.
2. If content was retained, the segment is restored with its original content. If content was discarded, the caller must provide `content` in `options`.
3. The segment is inserted at its **original position** in the segment order (not appended to the end). This preserves coherence — a restored segment slots back into its narrative context.
4. If the segment belonged to a group, the entire group is restored atomically. Partial group restore is not permitted.
5. Token count is recomputed (content may have been externally modified if caller-provided).
6. `updatedAt` is set to current time. `createdAt` is unchanged.
7. Quality scores are recomputed. The continuity dimension (cl-spec-002) specifically measures the delta between pre-eviction and post-restoration quality to assess restoration fidelity.

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `content` | string | Required if content was not retained at eviction |
| `importance` | number | Override importance (otherwise restored to pre-eviction value) |
| `protection` | protection level | Override protection (otherwise restored to pre-eviction value) |

## 8. Invariants and Constraints

The following invariants hold at all times. Any operation that would violate an invariant is rejected with an error.

### Structural Invariants

1. **Unique IDs.** No two ACTIVE segments share an ID. No two EVICTED segments share an ID. An ACTIVE and an EVICTED segment may not share an ID (eviction preserves the ID in the evicted pool).
2. **Non-overlapping content.** No token in the context window belongs to more than one ACTIVE segment.
3. **Stable ordering.** The relative order of ACTIVE segments is deterministic and preserved across all operations except `split` (which replaces one position with multiple) and `restore` (which re-inserts at original position).
4. **Consistent token accounting.** The sum of `tokenCount` across all ACTIVE segments equals the total tracked token usage reported by context-lens. Pinned token count equals the sum across all ACTIVE segments with `pinned` protection.
5. **Group atomicity.** A group is either fully ACTIVE (all members ACTIVE) or fully EVICTED (all members EVICTED). No mixed states.

### Membership Invariants

6. **Single group membership.** A segment belongs to at most one group at any time.
7. **Non-empty groups.** A group must have at least one member. Removing the last member dissolves the group.
8. **Group-member state consistency.** All members of a group share the same state (ACTIVE or EVICTED). Operations that change state (evict, restore) are applied atomically to the entire group.

### Protection Invariants

9. **Pinned immutability.** Pinned segments cannot be evicted, compacted, or split. They can be updated (metadata only — content updates on pinned segments are an error) or unpinned (protection transition to a lower level).
10. **Eviction order.** The eviction advisor must respect protection tiers strictly: `default` before `priority(n)` (ascending), `priority(n)` before `seed`, `seed` before `pinned` (never). No segment at a higher protection tier is evicted while candidates at a lower tier remain.

### Lifecycle Invariants

11. **No operations on EVICTED segments** except `restore`. Update, replace, compact, and split require ACTIVE state.
12. **Compaction reduces.** A compact operation must produce fewer tokens than the original. Equal or greater token count is rejected.
13. **Restore preserves position.** A restored segment returns to its original position in the segment order, not to the end.

### Capacity Invariants

14. **Soft capacity.** context-lens tracks token utilization against a configured capacity but does not enforce it. Adding a segment that exceeds capacity succeeds — context-lens reports the overage and the quality model reflects the saturation pattern (cl-spec-003). Enforcement is the caller's responsibility, informed by the eviction advisor.
15. **Pinned ceiling warning.** If pinned tokens exceed 50% of capacity (configurable threshold), context-lens emits a warning. This is advisory — the operation proceeds.

## 9. References

| Reference | Description |
|-----------|-------------|
| `brainstorm_20260324_context-lens.md` | Origin brainstorm session — core insight, four quality dimensions, five degradation patterns, API shape exploration |
| `cl-spec-002` (Quality Model) | Consumes segments for coherence, density, relevance, and continuity scoring |
| `cl-spec-003` (Degradation Patterns) | Detects saturation, erosion, fracture, gap, and collapse across segments |
| `cl-spec-006` (Tokenization Strategy) | Token counting implementation used by segment `tokenCount` computation |
| `cl-spec-007` (API Surface) | Public API that exposes all lifecycle operations defined in section 7 |
| `cl-spec-008` (Eviction Advisory) | Consumes segment metadata, protection, and importance for eviction ranking |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.6*
