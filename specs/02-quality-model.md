---
id: cl-spec-002
title: Quality Model
type: design
status: draft
created: 2026-03-26
revised: 2026-03-26
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [quality, coherence, density, relevance, continuity, scoring, baseline]
depends_on: [cl-spec-001]
---

# Quality Model

## Table of Contents

1. Overview
2. Quality Dimensions
3. Coherence
4. Density
5. Relevance
6. Continuity
7. Quality Baseline
8. Composite Score
9. Quality Reports
10. Invariants and Constraints
11. References

---

## 1. Overview

Token count is a measure of quantity. It tells you how full the context window is — and nothing else. A window at 90% utilization might be 90% high-quality, carefully curated context, or it might be 40% duplicated tool output, 30% stale conversation history, and 20% content that has nothing to do with the current task. Token counting cannot distinguish these cases. context-lens exists because that distinction matters.

The quality model is the system that makes the distinction. It takes the raw material — segments with content, metadata, and token counts — and produces scores that answer four questions:

1. **Does this context hold together?** (Coherence)
2. **Is this context earning its token cost?** (Density)
3. **Is this context about the right thing?** (Relevance)
4. **Has this context lost anything important?** (Continuity)

Each question maps to a dimension. Each dimension produces a score. Together, the four scores characterize the health of the context window at any point in time — not just how full it is, but how well it is serving the model.

### Why four dimensions

A single "quality score" would be simpler but useless. Consider two scenarios:

- **Scenario A:** A 128K window at 95% utilization. Coherence is high (all content relates to a single codebase), density is low (three copies of the same file are loaded), relevance is high (all content relates to the current task), continuity is perfect (nothing has been evicted).
- **Scenario B:** A 128K window at 95% utilization. Coherence is low (content spans five unrelated topics), density is high (no redundancy), relevance is medium (half the content is from a previous task), continuity is degraded (key context was evicted and only partially restored).

A single score would rate both windows similarly — both are "medium quality." But the remediation is completely different. Scenario A needs deduplication. Scenario B needs topic focusing and restoration. The four dimensions make the diagnosis specific enough to act on.

### What the quality model is not

The quality model is a **measurement system**, not an optimization system. It scores — it does not fix. It reports that density is low — it does not deduplicate content. It reports that relevance is falling — it does not evict irrelevant segments. Remediation is the caller's responsibility, informed by the eviction advisory (cl-spec-008) and degradation pattern detection (cl-spec-003).

The quality model is also **not an LLM**. It does not call a language model to assess quality. Every score is computed from structural signals — token counts, positional relationships, content hashes, similarity scores, timestamps, and metadata. This is a hard constraint, not a simplification. An LLM-based quality model would be circular (using context window tokens to evaluate context window quality) and slow (adding latency to every lifecycle operation). The quality model must run on the hot path alongside token counting — it has the same performance budget.

### How scores flow through the system

The quality model produces scores. Other systems consume them:

```
Segments (cl-spec-001)
    |
    v
Quality Model (this spec)
    |
    +--> Quality Reports (section 9)
    |       |
    |       +--> Caller (direct inspection)
    |       +--> Diagnostics (cl-spec-010)
    |
    +--> Degradation Patterns (cl-spec-003)
    |       |
    |       +--> Pattern alerts (saturation, erosion, fracture, gap, collapse)
    |
    +--> Eviction Advisory (cl-spec-008)
            |
            +--> Eviction recommendations (ranked candidates, reclamation targets)
```

The quality model is a **producer**, not a consumer, of decisions. It feeds signals to systems that decide what to do. This separation keeps the quality model focused — it measures, others act.

### Scoring granularity

Scores are computed at two levels:

- **Per-segment.** Each active segment receives a score for each dimension. Per-segment scores enable fine-grained eviction ranking (which specific segment is least relevant?) and pinpoint diagnostics (which segment is dragging down coherence?).
- **Window-level.** Aggregate scores characterize the context window as a whole. Window-level scores are what the caller sees in quality reports and what degradation pattern detection operates on.

Window-level scores are derived from per-segment scores — they are aggregations, not independent computations. The aggregation method varies by dimension (section 8) because the dimensions have different semantics. Coherence is about relationships between segments, so the window score reflects pairwise structure. Density is about individual segments, so the window score is a weighted average. The details are in each dimension's section.

### Score range and interpretation

All dimension scores are normalized to **0.0–1.0**:

| Score | Interpretation |
|-------|---------------|
| 1.0 | Perfect — no quality issue detectable in this dimension |
| 0.7–0.9 | Healthy — normal operating range for a well-managed window |
| 0.4–0.6 | Degraded — the dimension is measurably impaired, remediation should be considered |
| 0.1–0.3 | Critical — the dimension is severely impaired, the model is likely underperforming |
| 0.0 | Failure — the dimension has collapsed (e.g., no relevant content remains) |

These ranges are guidelines, not thresholds. Degradation pattern detection (cl-spec-003) defines specific activation thresholds. The quality model reports scores; the degradation detector interprets them.

Scores are **relative to the quality baseline** (section 7). A coherence score of 0.8 means "80% of the coherence present at baseline." This makes scores comparable across sessions and configurations — a 0.8 means the same thing whether the window is 32K or 200K tokens.

## 2. Quality Dimensions

This section defines the four dimensions as a framework — what each one measures, what input signals it uses, and how the dimensions relate to each other. Sections 3–6 then define each dimension's scoring mechanics in full detail.

### 2.1 The Four Dimensions

| Dimension | Question it answers | What degrades it | Primary input signals |
|-----------|--------------------|-----------------|-----------------------|
| **Coherence** | Does this context hold together? | Unrelated content mixed in, topic fragmentation, broken group structure | Segment adjacency, group membership, content similarity between neighbors |
| **Density** | Is this context earning its token cost? | Duplicate content, verbose passages, redundant information across segments | Token counts, content hashes, intra-window similarity |
| **Relevance** | Is this context about the right thing? | Task drift, stale content from previous tasks, accumulation of unrelated material | Task descriptor, content-to-task similarity, origin metadata, timestamps |
| **Continuity** | Has this context lost anything important? | Eviction of key segments, lossy compaction, failed restoration | Eviction records, compaction records, pre/post quality deltas |

### 2.2 Input Signals

The quality model does not read content semantically — it cannot "understand" what a segment says. It operates on **structural signals** that are available without an LLM call. Every signal the quality model uses comes from data that context-lens already maintains:

**From the segment model (cl-spec-001):**

| Signal | Source | Used by |
|--------|--------|---------|
| Content string | `segment.content` | Coherence (similarity), Density (hashing, similarity) |
| Token count | `segment.tokenCount` | Density (information ratio) |
| Segment order | Insertion/position index | Coherence (adjacency relationships) |
| Group membership | `segment.groupId`, `group.members` | Coherence (group-internal consistency) |
| Protection level | `segment.protection` | Relevance (seed segments are baseline-relevant by definition) |
| Importance | `segment.importance` | Relevance (caller signal of value) |
| Origin tag | `segment.origin` | Relevance (provenance-based heuristics), Density (origin-class deduplication) |
| Timestamps | `segment.createdAt`, `segment.updatedAt` | Relevance (recency), Continuity (temporal distance of eviction/restoration) |
| Tags | `segment.tags` | Relevance (caller-defined semantic hints) |

**From the tokenization subsystem (cl-spec-006):**

| Signal | Source | Used by |
|--------|--------|---------|
| Tokenizer accuracy | `provider.accuracy` | Quality reports (confidence annotation) |
| Capacity metrics | `totalActiveTokens`, `utilization`, `headroom` | Density (capacity-relative scoring) |

**From lifecycle events:**

| Signal | Source | Used by |
|--------|--------|---------|
| Eviction records | `EvictionRecord` (cl-spec-001 section 7.7) | Continuity (what was lost) |
| Compaction records | `compactionRecord` (cl-spec-001 section 7.5) | Continuity (compression ratio, information loss) |
| Quality snapshots | Stored at eviction time | Continuity (pre/post comparison) |

**Notably absent: embeddings.** Similarity computations (used by coherence, density, and relevance) require some form of content comparison. context-lens supports embeddings as an optional, pluggable signal source (cl-spec-005). When embeddings are available, similarity is computed as cosine similarity between embedding vectors. When embeddings are not available, context-lens falls back to lightweight textual heuristics — character n-gram overlap (Jaccard similarity on character trigrams) for a fast, dependency-free approximation. The quality model operates in both modes; embedding availability affects accuracy, not functionality.

### 2.3 Dimension Independence

The four dimensions are **conceptually independent** — each measures a distinct aspect of quality, and improving one does not necessarily improve another:

- High coherence + low density: the window is topically focused but full of duplicates.
- High density + low relevance: every segment is unique and information-rich, but about the wrong topic.
- High relevance + low continuity: the current content is on-task, but key context was lost during eviction.
- High continuity + low coherence: nothing has been lost, but the accumulated content has drifted into unrelated territory.

This independence is why four scores are necessary. Each combination of high/low values across dimensions points to a different diagnosis and a different remediation strategy. Degradation pattern detection (cl-spec-003) exploits these combinations — each pattern is defined by a characteristic signature across the four dimensions.

**In practice, dimensions correlate.** Evicting segments tends to reduce continuity and may reduce coherence (if the evicted segment was a bridge between topics). Adding unrelated content reduces both coherence and relevance simultaneously. These correlations are real but emergent — the quality model does not enforce them. It scores each dimension independently and lets the patterns fall where they may.

### 2.4 Computation Lifecycle

Quality scores are not maintained continuously — they are computed **on demand** when a quality report is requested, and **proactively** at specific lifecycle moments:

**On-demand computation:**

The caller requests a quality report (section 9). context-lens computes all four dimension scores for all active segments, aggregates them to window-level scores, and returns the report. This is the primary consumption path.

**Proactive computation:**

| Trigger | What is computed | Why |
|---------|-----------------|-----|
| Seed completion | Full baseline snapshot (section 7) | Establishes the reference point for all future scores |
| Eviction | Pre-eviction quality snapshot for affected segments | Stored in `EvictionRecord.qualityBefore` for continuity measurement |
| Restoration | Post-restoration delta against pre-eviction snapshot | Measures restoration fidelity |

**Lazy per-segment scoring:**

Individual per-segment scores are computed lazily and cached. When a segment's content changes, its per-segment scores are invalidated. When a quality report is next requested, only invalidated segments are rescored — unchanged segments reuse cached scores. This makes quality reports O(k) in the number of changed segments, not O(n) in the total number of segments.

The invalidation triggers mirror token count invalidation (cl-spec-006 section 4.1): content mutations invalidate, metadata-only mutations do not (except for relevance, which is affected by importance and tag changes — see section 5).

### 2.5 Dimensions and Groups

Groups (cl-spec-001 section 5) interact with quality scoring in specific ways:

- **Coherence** computes an **intra-group coherence** score: how well the members of a group cohere with each other. A group whose members are topically scattered is a quality signal — the group structure claims the segments belong together, but the content does not support it.
- **Density** treats group members independently. Each member has its own density score. Redundancy between group members is detected the same way as redundancy between ungrouped segments.
- **Relevance** aggregates to the group level for eviction purposes. The group's relevance is the aggregate of its members' relevance (section 8), because groups are evicted atomically — the eviction advisor needs a single relevance score per eviction candidate.
- **Continuity** tracks group-level eviction and restoration. When a group is evicted, a single continuity record covers all members. Restoration fidelity is measured for the group as a whole.

## 3. Coherence

Coherence measures whether the context window holds together as a unified body of information or has fragmented into disconnected islands. A coherent window reads as a focused conversation about related topics. An incoherent window reads as a scrapbook — pieces thrown together with no narrative or topical thread connecting them.

Coherence matters because LLMs perform better when context is coherent. An incoherent window forces the model to mentally juggle unrelated topics, increasing the chance of confusion, hallucination, and attention dilution. The model does not benefit from context it cannot relate to the current thread.

### 3.1 What Coherence Measures

Coherence captures three related but distinct structural properties:

**Adjacency continuity.** Segments that are next to each other in the window should be topically related. A sharp topic break between adjacent segments — a code review discussion followed by an unrelated API specification — indicates a coherence gap. Adjacency continuity measures how smoothly the window flows from one segment to the next.

**Topical concentration.** A window focused on one or two topics is more coherent than a window scattered across ten. Topical concentration does not require every segment to be about the same thing — it measures whether the content clusters into a small number of related themes versus many unrelated ones.

**Group integrity.** Groups declare that their members belong together (cl-spec-001 section 5). Group integrity measures whether the content supports that declaration. A group whose members are highly similar has high integrity. A group whose members have nothing in common — perhaps assembled by accident or by an overly broad grouping rule — has low integrity, and the group structure is misleading rather than helpful.

### 3.2 Similarity Function

Coherence scoring depends on a **similarity function** that quantifies how related two segments are. This function is the core building block — adjacency continuity, topical concentration, and group integrity all reduce to pairwise similarity comparisons.

context-lens supports two similarity modes, selected by whether the caller has configured an embedding provider (cl-spec-005):

**With embeddings:**

```
similarity(a, b) = cosineSimilarity(embed(a.content), embed(b.content))
```

Cosine similarity between embedding vectors. Range: -1.0 to 1.0, but in practice 0.0 to 1.0 for text content (negative similarities are rare with modern embedding models). Values above 0.7 indicate strong topical relatedness; values below 0.3 indicate weak or no relatedness.

Embeddings are the preferred mode. They capture semantic similarity — two segments about "authentication" and "login security" will score as related even if they share no common words. The quality of coherence scoring is directly proportional to the quality of the embedding model.

**Without embeddings (fallback):**

```
similarity(a, b) = jaccardSimilarity(trigrams(a.content), trigrams(b.content))
```

Jaccard similarity over character trigrams. Range: 0.0 to 1.0. This is a lexical similarity measure — it detects shared vocabulary, not shared meaning. "Authentication" and "login security" would score low because they share few character trigrams.

The fallback is coarser but dependency-free. It reliably detects obvious coherence problems (completely unrelated segments) but misses subtle ones (semantically related but lexically different content). This tradeoff is acceptable for zero-config callers — like the approximate tokenizer (cl-spec-006 section 3.1), it is good enough for monitoring and gets out of the way.

**Similarity caching:** Pairwise similarities are cached. The cache key is `(hash(a.content), hash(b.content), mode)` where mode is `"embedding"` or `"trigram"`. Cache entries are invalidated when either segment's content changes. For a window with n segments, there are O(n) adjacency pairs and O(m²) intra-group pairs (where m is the largest group size) — caching ensures these are computed once and reused across quality reports.

### 3.3 Adjacency Coherence

For each pair of adjacent segments (i, i+1) in the window, compute:

```
adjacencyCoherence(i) = similarity(segment[i], segment[i+1])
```

This produces an ordered series of similarity scores — one fewer than the number of segments. The series reveals the coherence structure of the window:

- **Uniformly high values** (> 0.5): the window flows smoothly. Content is topically unified.
- **Uniformly low values** (< 0.3): the window is fragmented. Each segment is an island.
- **High with isolated drops**: the window has **topic breaks** — specific points where the conversation shifted. These are normal and expected (a conversation naturally moves between topics). A few topic breaks indicate healthy structure. Many indicate fragmentation.

**Per-segment adjacency score:**

Each segment's adjacency coherence is the average of its similarity to its neighbors:

```
For the first segment:    coherence_adj(0)     = similarity(0, 1)
For the last segment:     coherence_adj(n-1)   = similarity(n-2, n-1)
For interior segments:    coherence_adj(i)      = (similarity(i-1, i) + similarity(i, i+1)) / 2
```

A single-segment window has adjacency coherence of 1.0 by convention — there are no adjacency relationships to violate.

### 3.4 Topical Concentration

Topical concentration measures how many distinct topics the window contains and how evenly content is distributed across them. A window dominated by one topic is concentrated. A window scattered across many equally-sized topics is diffuse.

**Computation:**

1. Construct a similarity matrix S where `S[i][j] = similarity(segment[i], segment[j])` for all active segment pairs.
2. Identify **clusters** by thresholding: two segments are in the same cluster if their similarity exceeds a threshold `τ_cluster` (default: 0.4). Use single-linkage clustering — a segment joins a cluster if it is similar to any member.
3. Count the clusters: `k`.
4. Compute concentration:

```
topicalConcentration = 1.0 / k
```

A single cluster (k=1) produces concentration 1.0 — the window is fully focused. Ten clusters (k=10) produce concentration 0.1 — the window is scattered. This is a deliberately simple formula. Sophisticated clustering metrics (silhouette score, entropy) would add complexity without proportional benefit — context-lens needs a directional signal, not a publication-grade clustering analysis.

**Performance note:** The full similarity matrix is O(n²) in the number of segments. For large windows (> 200 segments), context-lens samples: it computes similarity for a random subset of pairs and extrapolates cluster count. The sampling threshold and strategy are defined in the performance budget (cl-spec-009). For typical windows (10–100 segments), the full matrix is computed — it is fast enough at these scales.

### 3.5 Group Coherence

For each group, compute the average pairwise similarity among its members:

```
groupCoherence(g) = mean(similarity(a, b)) for all pairs (a, b) in g.members where a ≠ b
```

A group with two members computes one pair. A group with five members computes ten pairs. A group with one member has group coherence of 1.0 by convention.

**Interpretation:**

| Group coherence | Meaning |
|----------------|---------|
| > 0.6 | Members are topically related. The group structure is justified. |
| 0.3–0.6 | Members are loosely related. The group may be too broad. |
| < 0.3 | Members are unrelated. The group structure is misleading — it claims cohesion that does not exist. |

Low group coherence is surfaced in quality reports as a diagnostic signal. context-lens does not dissolve or restructure groups — that is the caller's responsibility — but it tells the caller when a group's content does not support its structure.

### 3.6 Per-Segment Coherence Score

Each segment's coherence score combines adjacency coherence and group coherence (if applicable):

```
For ungrouped segments:
  coherence(i) = coherence_adj(i)

For grouped segments:
  coherence(i) = (coherence_adj(i) + groupCoherence(group(i))) / 2
```

Grouped segments are measured by both their fit with their neighbors in the window (adjacency) and their fit within their group. This dual measurement catches two failure modes:

- A segment that fits its group but is positioned far from related content in the window (low adjacency, high group coherence).
- A segment that fits its window position but was placed in the wrong group (high adjacency, low group coherence).

### 3.7 Window-Level Coherence

The window's overall coherence score combines adjacency coherence and topical concentration:

```
windowCoherence = (meanAdjacencyCoherence * w_adj) + (topicalConcentration * w_topic)
```

Where:
- `meanAdjacencyCoherence` = mean of all per-segment adjacency coherence scores
- `w_adj` = 0.6 (adjacency weight)
- `w_topic` = 0.4 (topical concentration weight)

Adjacency is weighted higher because it reflects the model's actual experience of the context — the model processes segments sequentially, so adjacency relationships matter more than global clustering structure. Topical concentration provides a coarser but complementary signal that catches diffuse windows where adjacency scores are deceptively high (e.g., many small coherent clusters that are unrelated to each other).

The weights are fixed, not configurable. Exposing them would create a tuning surface that most callers should not need to touch. If experience reveals that different workloads need different weights, a future revision can introduce configurable profiles.

## 4. Density

Density measures whether each segment is earning its token cost — whether the information it contributes to the context window justifies the tokens it consumes. A dense window packs maximum information into minimum tokens. A sparse window wastes capacity on redundant, verbose, or vacuous content.

Density is the most directly actionable dimension. Low coherence requires rethinking what content belongs in the window. Low relevance requires understanding the current task. Low continuity requires undoing past evictions. Low density requires one simple thing: remove or compress the wasteful segments. The eviction advisor (cl-spec-008) and compaction operation (cl-spec-001 section 7.5) exist largely to address density problems.

### 4.1 What Density Measures

Density captures two distinct forms of waste:

**Redundancy.** The same information appears more than once. This ranges from exact duplication (identical content in two segments) to partial overlap (two segments that cover the same topic with different wording). Redundancy is the most common density problem in long-running sessions — tool results get re-fetched, documents get re-loaded, the model restates information the user already provided.

**Dilution.** A segment contains information but buries it in low-value content — boilerplate, verbose explanations of simple concepts, filler text. Dilution is harder to detect without semantic understanding, so context-lens uses a proxy: the ratio of unique information in a segment relative to its token cost, measured by how much of the segment's content is novel compared to everything else in the window.

### 4.2 Redundancy Detection

Redundancy is measured by comparing each segment against every other active segment in the window. The result is a per-segment **redundancy score** — the degree to which this segment's content is already covered by other segments.

**Exact duplication:**

context-lens detects exact duplicates at insertion time via content hashing (cl-spec-001 section 3.3). The density scorer inherits this: if two active segments have the same content hash, both receive a redundancy signal of 1.0 for that pair — they are fully redundant.

**Partial overlap:**

For segments that are not exact duplicates, partial overlap is measured using the same similarity function as coherence (section 3.2):

```
redundancy(i, j) = similarity(segment[i], segment[j])
```

A high similarity score between non-adjacent, non-grouped segments is a redundancy signal. The same similarity that indicates *coherence* between neighbors indicates *redundancy* between distant segments. Context matters: similar neighbors are good (topical flow); similar strangers are bad (wasted tokens).

**Per-segment redundancy score:**

```
redundancy(i) = max(similarity(i, j)) for all j ≠ i where j is not adjacent to i
```

The maximum, not the mean. A segment that is 90% redundant with even one other segment is a density problem regardless of how unique it is relative to all others. The adjacency exclusion prevents coherent neighbors from being misclassified as redundant — two adjacent segments about the same topic should be similar; that is coherence, not waste.

**Redundancy interpretation:**

| Redundancy score | Meaning |
|-----------------|---------|
| > 0.8 | Near-duplicate. Strong candidate for deduplication or compaction. |
| 0.5–0.8 | Significant overlap. The segment partially duplicates existing content. |
| 0.2–0.5 | Mild overlap. Some shared content, but the segment contributes novel information. |
| < 0.2 | Minimal redundancy. The segment is largely unique. |

### 4.3 Information Density Ratio

Redundancy tells you how much of a segment is duplicated. The information density ratio tells you how much of a segment's token budget is spent on novel content.

```
informationRatio(i) = 1.0 - redundancy(i)
```

A segment with redundancy 0.0 has an information ratio of 1.0 — every token carries unique information. A segment with redundancy 0.9 has an information ratio of 0.1 — 90% of its token cost is wasted on content available elsewhere.

The information ratio is weighted by token count to produce a **token-weighted density** that reflects the absolute cost of waste, not just the proportion:

```
tokenWaste(i) = segment[i].tokenCount * redundancy(i)
```

A 100-token segment with 0.5 redundancy wastes 50 tokens. A 5,000-token segment with 0.5 redundancy wastes 2,500 tokens. Token-weighted density makes the cost visible — the large redundant segment is a 50× bigger problem, even though both have the same redundancy ratio.

### 4.4 Origin-Aware Redundancy

Not all redundancy is equal. Two copies of a user instruction are more wasteful than two copies of a tool result, because the user instruction carries authority (the model should follow it) while the tool result is data (the model can reference either copy).

context-lens does not make semantic judgments about content value — but it uses origin metadata (cl-spec-001 section 4.2) as a heuristic for redundancy severity:

| Origin pattern | Redundancy severity | Rationale |
|---------------|--------------------|-----------|
| Same origin, same content | High | Likely an accidental re-insertion (tool re-run, document re-load) |
| Same origin, similar content | Medium | Likely an updated version — consider replacing the older segment |
| Different origin, similar content | Lower | May be legitimate cross-referencing (user summarizes a tool result) |

Origin-aware redundancy does not change the redundancy *score* — it provides an annotation on the quality report that helps the caller or eviction advisor decide how to handle the redundancy. Two segments with redundancy 0.8 get the same density score regardless of origin, but the report notes whether they share an origin (suggesting accidental duplication) or have different origins (suggesting intentional overlap).

### 4.5 Per-Segment Density Score

Each segment's density score combines its information ratio with a capacity-relative weight:

```
density(i) = informationRatio(i)
```

The density score is simply the information ratio — the fraction of the segment's content that is novel. This is deliberately simple. Density is the most concrete of the four dimensions: a segment is either carrying unique information or it isn't. Elaborating the score with additional factors would obscure the straightforward signal that makes density actionable.

**Edge cases:**

- **Single-segment window.** The segment has redundancy 0.0 and density 1.0. There is nothing to be redundant with.
- **All segments identical.** Every segment has redundancy 1.0 (each is fully covered by the others) and density 0.0. This is the worst case — the window is entirely wasted.
- **Pinned segments.** Pinned segments receive density scores like any other segment. A pinned segment that is redundant with another segment is a density problem the caller should know about — even though the pinned segment cannot be evicted, the other copy can.

### 4.6 Window-Level Density

The window's overall density score is a **token-weighted mean** of per-segment density scores:

```
windowDensity = Σ(density(i) * tokenCount(i)) / Σ(tokenCount(i))
```

Token-weighting is essential. A 50-token segment with density 0.1 and a 5,000-token segment with density 0.9 should not average to 0.5 — the window is mostly dense. Token-weighting produces 0.88, which accurately reflects that 99% of the window's tokens carry unique information.

**Relationship to capacity:**

Window density does not directly incorporate utilization. A window at 10% utilization with low density has the same density score as a window at 95% utilization with low density. This is intentional — density measures information quality, not capacity pressure. Capacity pressure is tracked by the tokenization subsystem (cl-spec-006 section 4.5) and the saturation degradation pattern (cl-spec-003). Mixing density and capacity into a single score would make both signals less clear.

However, low density at high utilization is a more urgent problem than low density at low utilization. This interaction is handled by the degradation patterns (erosion pattern, cl-spec-003), not by the density score itself.

## 5. Relevance

Relevance measures whether the context window is about the right thing — whether its content relates to the task the model is currently performing. A perfectly coherent, maximally dense window is useless if it is full of information about topic A while the model is working on topic B. Relevance is the dimension that connects context quality to task performance.

Relevance is also the most challenging dimension to compute without an LLM, because "what is this task about?" is fundamentally a semantic question. context-lens does not answer it semantically. Instead, it relies on the caller to declare the current task through a **task descriptor**, and measures relevance as the structural relationship between segments and that descriptor.

### 5.1 The Task Descriptor

The task descriptor is the caller's declaration of what the model is currently working on. It is the reference point for all relevance scoring — without it, relevance is undefined.

```
setTask(descriptor: TaskDescriptor) -> void
```

**TaskDescriptor fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | yes | Free-text description of the current task. Used for similarity comparison against segment content. |
| `keywords` | string[] | no | Key terms that indicate relevance. Segments containing these terms score higher. |
| `relatedOrigins` | string[] | no | Origin values that are inherently relevant to this task (e.g., `["tool:grep", "doc:README.md"]`). |
| `relatedTags` | string[] | no | Segment tags that indicate relevance to this task. |

The task descriptor is mutable — the caller updates it as the task evolves. Task changes are a normal part of a session: the user starts with "fix the login bug," pivots to "also update the tests," and later shifts to "now deploy it." Each transition should update the descriptor so relevance scores track the current focus.

**When no task descriptor is set:** All segments receive a relevance score of 1.0. Without a task declaration, context-lens cannot measure relevance — it assumes everything is relevant. This is the safe default: no task descriptor means no relevance-based eviction pressure, which prevents context-lens from evicting content based on a task it does not know about.

### 5.2 Content-to-Task Similarity

The primary relevance signal is how similar each segment's content is to the task descriptor's description:

```
taskSimilarity(i) = similarity(segment[i].content, task.description)
```

This uses the same similarity function as coherence (section 3.2) — cosine similarity with embeddings, or Jaccard trigrams as fallback. The task description is treated as a virtual segment: it gets embedded (or trigrammed) once when the task is set, and that vector is compared against every active segment.

**Keyword boosting:**

If the task descriptor includes `keywords`, segments that contain those keywords receive a relevance boost:

```
keywordScore(i) = |keywords found in segment[i].content| / |task.keywords|
```

The keyword score is the fraction of task keywords present in the segment. A segment containing 3 of 5 keywords scores 0.6. Keywords are matched as case-insensitive whole words — substring matches do not count (`"auth"` does not match `"author"`).

**Combined content relevance:**

```
contentRelevance(i) = (taskSimilarity(i) * 0.7) + (keywordScore(i) * 0.3)
```

Similarity is weighted higher because it captures topical relatedness broadly. Keywords provide precision — they catch specific terms the caller knows are important. Without keywords, content relevance equals task similarity.

### 5.3 Metadata Relevance Signals

Content similarity alone misses important signals. A segment might be lexically distant from the task description but still highly relevant because of what it *is*, not what it *says*. Metadata provides these structural relevance signals.

**Origin relevance:**

If the task descriptor includes `relatedOrigins`, segments whose origin matches receive a boost:

```
originRelevance(i) = 1.0 if segment[i].origin in task.relatedOrigins, else 0.0
```

This is binary — a segment's origin is either relevant or it is not. The caller declares that `"tool:grep"` results are relevant to the current debugging task; every segment with that origin gets the signal.

**Tag relevance:**

Same pattern as origin:

```
tagRelevance(i) = |segment[i].tags ∩ task.relatedTags| / |task.relatedTags|
```

Fractional — a segment with 2 of 4 relevant tags scores 0.5.

**Importance as a relevance signal:**

The caller-assigned importance (cl-spec-001 section 4.3) is an explicit declaration of value. A segment with importance 0.9 is something the caller considers critical — it should be treated as more relevant than a segment with importance 0.2, all else being equal. Importance does not directly measure task relevance, but it captures caller intent that the similarity function cannot.

**Protection as a relevance signal:**

Seed segments are foundational context that the caller loaded before the session began. By definition, they were relevant at session start. As the task evolves, seeds may become less relevant — but they represent a deliberate choice by the caller, so they receive a floor relevance that prevents them from being scored as completely irrelevant.

```
protectionRelevance(i):
  pinned  -> 1.0   (pinned content is always considered relevant)
  seed    -> max(contentRelevance(i), 0.3)   (floor at 0.3)
  priority(n) -> contentRelevance(i)   (no adjustment)
  default -> contentRelevance(i)   (no adjustment)
```

### 5.4 Recency

Older segments are less likely to be relevant than recent ones. A tool result from 50 turns ago is probably about a different subtask than a tool result from 2 turns ago. Recency provides a temporal relevance signal.

```
recency(i) = 1.0 - (age(i) / maxAge)
```

Where:
- `age(i)` = current time - `segment[i].createdAt` (or `updatedAt`, whichever is more recent)
- `maxAge` = age of the oldest active segment

Recency is normalized to 0.0–1.0. The most recent segment scores 1.0. The oldest segment scores 0.0 (but this is one component among several — an old segment with high task similarity is still relevant).

**Recency is a weak signal.** It is weighted low in the final relevance score (section 5.5) because age is a poor proxy for relevance. A system prompt loaded at the start of the session is the oldest segment and the most relevant. Recency exists to break ties — when two segments have similar content relevance, the more recent one is slightly preferred.

### 5.5 Per-Segment Relevance Score

Each segment's relevance score combines content, metadata, and temporal signals:

```
relevance(i) = protectionRelevance(i) * (
    contentRelevance(i)  * w_content  +
    originRelevance(i)   * w_origin   +
    tagRelevance(i)      * w_tag      +
    importance(i)        * w_importance +
    recency(i)           * w_recency
)
```

**Weights:**

| Component | Weight | Rationale |
|-----------|--------|-----------|
| `w_content` | 0.45 | Content similarity is the strongest relevance signal |
| `w_origin` | 0.10 | Origin is a coarse but reliable indicator |
| `w_tag` | 0.10 | Tags are caller-declared relevance hints |
| `w_importance` | 0.20 | Importance is an explicit caller signal of value |
| `w_recency` | 0.15 | Recency is a weak tiebreaker |

The weights sum to 1.0. The result is then modulated by `protectionRelevance` — pinned segments are clamped to 1.0, seeds are floored at 0.3, others pass through unmodified.

**When metadata signals are absent:** If the task descriptor has no `keywords`, no `relatedOrigins`, and no `relatedTags`, the origin, tag, and keyword components contribute 0.0. The score reduces to content similarity + importance + recency. This is the minimal-configuration path — a caller who provides only `task.description` still gets useful relevance scoring.

### 5.6 Task Transitions

When the caller updates the task descriptor via `setTask`, all per-segment relevance scores are invalidated and recomputed on the next quality report. This is the expected behavior — a task change means the relevance landscape has shifted.

**Task transition mechanics:**

1. The new task description is embedded (or trigrammed) and cached.
2. All cached relevance scores are invalidated.
3. The old task descriptor is retained as `previousTask` for diagnostics — the quality report can show how much relevance changed between tasks, which helps the caller understand the impact of a task pivot.
4. Segments that were highly relevant to the old task but irrelevant to the new one are candidates for eviction. The eviction advisor (cl-spec-008) uses the relevance drop as a signal.

**Frequent task changes** are a usage pattern, not an error. An agent that handles multi-step tasks may update the descriptor on every step. context-lens handles this efficiently — only the task embedding/trigrams and the cached relevance scores are invalidated, not coherence or density scores.

### 5.7 Window-Level Relevance

The window's overall relevance score is a **token-weighted mean** of per-segment relevance scores:

```
windowRelevance = Σ(relevance(i) * tokenCount(i)) / Σ(tokenCount(i))
```

Token-weighting, as with density (section 4.6), ensures that large irrelevant segments dominate the score appropriately. A 10,000-token segment about the wrong topic should drag window relevance down more than a 50-token segment about the wrong topic.

**Interpretation:**

| Window relevance | Meaning |
|-----------------|---------|
| > 0.7 | The window is focused on the current task. Most tokens serve the current goal. |
| 0.4–0.7 | Mixed focus. Significant content from previous tasks or unrelated sources. |
| < 0.4 | The window has drifted. Most content is not about the current task. |

Low window relevance combined with high utilization is the **gap degradation pattern** (cl-spec-003) — the window is full of the wrong things, leaving no room for the right things.

## 6. Continuity

Continuity measures whether the context window has lost important information through eviction or compaction. The other three dimensions assess the content that *is* in the window. Continuity assesses the content that *was* in the window and is no longer there — or is there in degraded form.

A window with perfect continuity has never lost anything. Every segment that was ever added is still present in its original form. This is only possible in short sessions or large windows. In practice, eviction is necessary, compaction is useful, and some information loss is inevitable. Continuity does not penalize eviction itself — it measures the *cost* of eviction: how much quality the window lost because of what was removed.

### 6.1 What Continuity Measures

Continuity tracks two forms of information loss:

**Eviction loss.** A segment was removed from the window entirely. The information it carried is no longer available to the model. The severity depends on what was evicted — removing a stale tool result is low-cost; removing a key constraint from the system prompt is catastrophic.

**Compaction loss.** A segment was compressed — its content replaced with a shorter summary (cl-spec-001 section 7.5). The original information is partially preserved, but detail has been lost. The severity depends on the compression ratio and the quality of the summary. A 10:1 compression that preserves the key points is low-cost. A 10:1 compression that drops critical constraints is high-cost. context-lens cannot judge summary quality (that would require an LLM), so it uses the compression ratio as a proxy.

### 6.2 Eviction Cost

When a segment is evicted, context-lens records a pre-eviction quality snapshot in the `EvictionRecord` (cl-spec-001 section 7.7). This snapshot captures the segment's scores at the moment of removal:

```
evictionCost(record) = record.qualityBefore.relevance * record.importance * tokenWeight
```

Where:
- `record.qualityBefore.relevance` — the segment's relevance score at eviction time. Evicting an irrelevant segment costs little; evicting a highly relevant segment costs a lot.
- `record.importance` — the segment's importance at eviction time. The caller's explicit value signal.
- `tokenWeight` — `record.tokenCount / totalActiveTokensAtEviction`. Normalizes by the fraction of the window this segment occupied. Evicting a large segment has proportionally more impact.

**Why relevance, not all dimensions?** Eviction cost is weighted by relevance because that is the dimension most directly affected by removal. Coherence impact cannot be measured at eviction time — it depends on what remains after the segment is removed, which is computed in the post-eviction quality report. Density is typically *improved* by eviction (removing a redundant segment raises density). Relevance is the dimension where loss is most predictable and most consequential at the moment of eviction.

### 6.3 Compaction Cost

When a segment is compacted, context-lens records a `compactionRecord` (cl-spec-001 section 7.5) with the compression ratio:

```
compressionRatio = 1.0 - (compactedTokenCount / originalTokenCount)
```

A compression ratio of 0.8 means 80% of the tokens were removed — the summary is 20% of the original. Higher compression ratios imply more information loss.

**Compaction cost:**

```
compactionCost(record) = compressionRatio * segment.importance * (1.0 - redundancy(segment))
```

The cost incorporates:

- **Compression ratio.** More compression = more potential loss.
- **Importance.** Compacting important content costs more than compacting expendable content.
- **Inverse redundancy.** If the segment was highly redundant before compaction, the information "lost" in compression likely still exists in other segments. A redundant segment with 0.8 redundancy that gets compacted costs `compressionRatio * importance * 0.2` — most of its information survives in other segments anyway.

### 6.4 Restoration Fidelity

When an evicted segment is restored (cl-spec-001 section 7.8), context-lens measures how well the restoration recovers the lost quality — the **restoration fidelity**:

```
restorationFidelity(record) = qualityAfterRestore / qualityBeforeEviction
```

Where both quality values are the relevance score of the segment (at eviction time and after restoration).

**Fidelity outcomes:**

| Fidelity | Meaning |
|----------|---------|
| 1.0 | Perfect restoration. The segment returned with its full quality intact. |
| 0.7–0.99 | Good restoration. Some quality was lost — likely the task has evolved since eviction, making the segment slightly less relevant. |
| 0.3–0.7 | Partial restoration. Significant quality gap. The segment's relevance to the current task has changed substantially. |
| < 0.3 | The segment is no longer relevant. Restoration recovered the content but not the value. |

**Content-retained vs. content-discarded restoration:**

- When content was retained at eviction (default), restoration returns the original content. Fidelity loss comes from context drift — the task may have changed, making the content less relevant now than when it was evicted.
- When content was discarded and the caller provides new content, fidelity may be less than 1.0 even if the task has not changed — the new content may not exactly match the original.

Restoration fidelity is recorded and contributes to the continuity score. A window that has undergone many eviction-restore cycles with low fidelity has poor continuity — it keeps losing and failing to recover quality.

### 6.5 Cumulative Continuity Tracking

Continuity is cumulative. Each eviction and compaction adds to the total information loss. context-lens maintains a running **continuity ledger** — the history of all losses and recoveries in the session:

| Entry type | Fields | Effect on continuity |
|-----------|--------|---------------------|
| Eviction | segment ID, eviction cost, timestamp | Decreases continuity |
| Compaction | segment ID, compaction cost, timestamp | Decreases continuity |
| Restoration | segment ID, restoration fidelity, timestamp | Partially recovers continuity |

The ledger is append-only. Entries are never removed — they form the audit trail for the continuity dimension.

**Net loss calculation:**

```
totalEvictionLoss = Σ evictionCost(record) for all eviction records
totalCompactionLoss = Σ compactionCost(record) for all compaction records
totalRecovery = Σ (evictionCost(record) * restorationFidelity(record)) for all restored evictions
netLoss = totalEvictionLoss + totalCompactionLoss - totalRecovery
```

Net loss is bounded at 0.0 (no loss) on the low end. It has no theoretical upper bound — a session with extensive eviction of important, relevant content accumulates unbounded loss. The continuity *score* normalizes this into the 0.0–1.0 range (section 6.6).

### 6.6 Per-Segment Continuity Score

Continuity is not naturally a per-segment property — it describes what the window has *lost*, not what individual segments *are*. However, per-segment continuity scores are useful for two purposes: identifying segments that were restored with low fidelity, and identifying segments that survived while important neighbors were evicted.

**For segments that have been restored:**

```
continuity(i) = restorationFidelity(i)
```

The segment carries the fidelity of its restoration. A segment restored with 0.6 fidelity has a continuity score of 0.6 — it is present but degraded.

**For segments that have never been evicted:**

```
continuity(i) = 1.0
```

A segment that has never been evicted has perfect continuity. It has not lost anything.

**For segments that have been compacted:**

```
continuity(i) = 1.0 - compactionCost(i)
```

The segment is still present but its content has been compressed. Its continuity reflects the estimated information loss from compaction.

### 6.7 Window-Level Continuity

The window's overall continuity score reflects the cumulative impact of all information loss relative to the window's total information value:

```
windowContinuity = 1.0 - (netLoss / totalInformationValue)
```

Where:

```
totalInformationValue = Σ(importance(i) * tokenCount(i)) / Σ(tokenCount(i))
    for all segments that have ever been active in this session
```

Total information value is the importance-weighted token count of everything the window has ever contained — active, evicted, and compacted. This normalizes net loss against the total information the session has handled.

**Clamped to 0.0–1.0:**

- A session with no evictions or compactions has `netLoss = 0` and `windowContinuity = 1.0`.
- A session where all important content has been evicted and never restored approaches `windowContinuity = 0.0`.

**Interpretation:**

| Window continuity | Meaning |
|------------------|---------|
| > 0.8 | Minimal information loss. Evictions have targeted low-value content. |
| 0.5–0.8 | Moderate loss. Some important content has been evicted or aggressively compacted. |
| 0.3–0.5 | Significant loss. The window has shed substantial amounts of relevant context. |
| < 0.3 | Severe loss. The window has lost most of its original information. The model is likely missing critical context. This is the **collapse degradation pattern** (cl-spec-003). |

**Continuity only decreases (net).** Individual restorations can recover some loss, but continuity never exceeds its previous high-water mark in practice — restored content returns to a window that has evolved, so restoration fidelity is typically less than 1.0. A steadily declining continuity score is the normal trajectory of a long-running session. The rate of decline is the actionable signal: gentle decline means eviction decisions are sound; rapid decline means something is wrong.

## 7. Quality Baseline

Quality scores are relative — a coherence score of 0.8 means "80% of baseline coherence." Without a baseline, scores have no anchor. A window with coherence 0.6 could be excellent (if the content is inherently diverse and 0.6 is the best achievable) or terrible (if the content was perfectly coherent at the start and has fragmented). The baseline makes the distinction.

### 7.1 What the Baseline Is

The quality baseline is a **snapshot of all four dimension scores taken at a specific moment** — the moment the window transitions from setup to use. It captures the quality of the window before the session's dynamic content begins accumulating.

```
baseline = {
    coherence:  windowCoherence  at snapshot time,
    density:    windowDensity    at snapshot time,
    relevance:  windowRelevance  at snapshot time,
    continuity: 1.0              (always — nothing has been lost yet)
}
```

Continuity is always 1.0 at baseline because no evictions or compactions have occurred. The other three dimensions are measured from whatever content exists at snapshot time.

### 7.2 When the Baseline Is Captured

The baseline is captured **automatically after the last `seed` operation completes**, before the first `add` operation. This moment represents the boundary between foundational context (seeds) and dynamic content (conversation, tool results, evolving context).

**Trigger sequence:**

```
seed(s1)   — no baseline yet
seed(s2)   — no baseline yet
seed(s3)   — no baseline yet
add(a1)    — baseline captured HERE (after seeds, before first add takes effect)
               then a1 is added normally
```

The baseline is captured *before* the first `add` mutates the window, so it reflects the pure seed state. The first `add` operation triggers the snapshot, but the added segment is not included in it.

**Edge cases:**

- **No seeds, immediate `add`.** The baseline is captured on the first `add` against an empty window. All dimension scores are trivially 1.0 (a single segment has perfect coherence, perfect density, perfect relevance to itself). This is a degenerate baseline — it works, but it means early quality scores will drop rapidly as content accumulates. This is expected and not harmful.
- **Seeds added after `add`.** Permitted but generates a warning (cl-spec-001 section 7.1). The baseline is re-captured after the late seed, which may cause a discontinuity in quality trends — scores relative to the old baseline suddenly become scores relative to the new one. The quality report notes the re-baseline event.
- **No operations at all.** No baseline exists. Quality reports return absolute scores (not relative to baseline) and include a flag `baselineEstablished: false`.

### 7.3 Baseline as Reference Point

After capture, the baseline is used to normalize all window-level scores:

```
normalizedScore(dimension) = currentScore(dimension) / baseline[dimension]
```

Clamped to 0.0–1.0. A current score that exceeds the baseline (possible for density and relevance as the window evolves) is clamped to 1.0 — the baseline represents the expected quality level, and exceeding it is not a problem to report.

**Why normalize?** Raw scores are not comparable across sessions or configurations:

- A session seeded with five tightly related documents has a baseline coherence of 0.9. A raw coherence drop to 0.7 is a 22% decline.
- A session seeded with diverse reference materials has a baseline coherence of 0.5. A raw coherence of 0.5 is perfect — no degradation at all.

Without normalization, both sessions report coherence 0.7 and 0.5 respectively, giving no indication of whether the score is good or bad for this window. With normalization, the first reports 0.78 (degraded) and the second reports 1.0 (healthy). The normalized score answers "how is this window doing relative to its own starting point?"

### 7.4 Baseline Immutability

Once captured, the baseline is **immutable** — it does not change as the window evolves. This is intentional:

- A mutable baseline that tracked the "recent best" would hide gradual degradation. If coherence slowly drops from 0.9 to 0.5 over 100 turns, a sliding baseline would report 1.0 the entire time.
- A mutable baseline that tracked the "recent average" would normalize away trends. The whole point of quality scoring is to detect trends — the baseline must be fixed to make trends visible.

The only exception is the late-seed re-baseline (section 7.2), which is a deliberate recalibration, not a drift.

### 7.5 Baseline in Quality Reports

Every quality report includes the baseline alongside current scores:

| Report field | Type | Description |
|-------------|------|-------------|
| `baseline.coherence` | number | Coherence score at baseline capture |
| `baseline.density` | number | Density score at baseline capture |
| `baseline.relevance` | number | Relevance score at baseline capture |
| `baseline.continuity` | number | Always 1.0 |
| `baseline.capturedAt` | timestamp | When the baseline was captured |
| `baseline.segmentCount` | number | Number of segments at baseline capture |
| `baseline.tokenCount` | number | Total tokens at baseline capture |
| `baselineEstablished` | boolean | Whether a baseline has been captured |

The baseline metadata (`segmentCount`, `tokenCount`) helps the caller understand the scale of the baseline state. A baseline captured over 3 segments totaling 500 tokens is a very different reference point than one captured over 50 segments totaling 80,000 tokens — the former is fragile (small changes have large relative impact), the latter is stable.

## 8. Composite Score

The four dimension scores tell the full story. But consumers of quality data — dashboards, automated eviction policies, alerting systems — sometimes need a single number that answers "how healthy is this window right now?" The composite score serves that purpose.

### 8.1 Why a Composite Exists

Section 1 argued that a single quality score is insufficient — different dimension combinations require different diagnoses. That argument stands. The composite score does not replace the four dimensions. It exists alongside them for two narrow use cases:

- **Threshold alerting.** A monitoring system that fires when context quality drops below a threshold needs one number to compare, not four. The composite provides it.
- **Trend comparison.** Plotting a single quality line over time reveals the overall trajectory of a session. Four overlapping lines are harder to read at a glance.

The composite is a **summary**, not a replacement. Any system that acts on quality (eviction advisor, degradation detector) operates on the individual dimensions, never on the composite. The composite is for human consumption and coarse automation.

### 8.2 Aggregation Formula

The composite score is a weighted geometric mean of the four normalized dimension scores:

```
composite = (coherence^w_c * density^w_d * relevance^w_r * continuity^w_t) ^ (1 / (w_c + w_d + w_r + w_t))
```

**Weights:**

| Dimension | Weight | Rationale |
|-----------|--------|-----------|
| Coherence | 0.25 | Equally important — all four dimensions contribute to model performance |
| Density | 0.20 | Slightly lower — low density wastes tokens but does not directly confuse the model |
| Relevance | 0.30 | Slightly higher — irrelevant context is the most direct cause of model underperformance |
| Continuity | 0.25 | Equally important — information loss compounds over session lifetime |

**Why geometric mean, not arithmetic?** The geometric mean penalizes imbalance. With an arithmetic mean, a window with coherence 1.0, density 1.0, relevance 1.0, and continuity 0.0 scores 0.75 — which sounds healthy despite catastrophic information loss. The geometric mean of the same values is 0.0 — which correctly signals that one dimension has collapsed. A context window is only as healthy as its weakest dimension. The geometric mean captures this: a single dimension at zero drags the composite to zero.

### 8.3 Composite Interpretation

| Composite | Interpretation |
|-----------|---------------|
| > 0.75 | Healthy. All dimensions are in acceptable range. |
| 0.50–0.75 | Degraded. At least one dimension is impaired. Inspect individual scores. |
| 0.25–0.50 | Critical. Multiple dimensions are impaired or one has severely declined. |
| < 0.25 | Failing. The context window is not effectively serving the model. |

These thresholds are guidelines. Degradation pattern detection (cl-spec-003) uses its own thresholds on individual dimensions, which are more precise. The composite thresholds are for quick human assessment.

### 8.4 Per-Segment Composite

A per-segment composite is computed using the same formula applied to the segment's four per-segment scores:

```
composite(i) = (coherence(i)^w_c * density(i)^w_d * relevance(i)^w_r * continuity(i)^w_t) ^ (1 / (w_c + w_d + w_r + w_t))
```

The per-segment composite is useful for **eviction triage** — sorting segments by overall quality gives the caller a quick view of which segments are weakest across all dimensions. The eviction advisor (cl-spec-008) does not use the composite directly (it operates on individual dimensions with its own weighting), but the caller may use it for manual inspection.

### 8.5 Weight Configuration

The composite weights are **not configurable**. Exposing them would create a tuning surface with subtle, non-obvious interactions. A caller who increases relevance weight and decreases coherence weight might silence coherence warnings without realizing it — the composite would remain high even as coherence collapses.

If experience across deployments reveals that a different weighting is universally better, the weights will be changed in a future revision. If different workloads genuinely need different weights, a future revision may introduce named profiles (e.g., `"conversational"` vs. `"retrieval-augmented"` vs. `"agent"`). For now, one set of weights for all callers.

## 9. Quality Reports

The quality report is the primary output of the quality model — the artifact that callers, diagnostics, degradation detectors, and eviction advisors consume. This section defines the report structure, what triggers report generation, and how reports relate to each other over time.

### 9.1 Report Structure

A quality report is a snapshot of the window's quality at a point in time. It contains everything a consumer needs to understand the current state and recent trajectory of context quality.

**Top-level fields:**

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | timestamp | When this report was generated |
| `reportId` | string | Unique identifier for this report (auto-generated, monotonically increasing) |
| `segmentCount` | number | Number of ACTIVE segments at report time |
| `windowScores` | WindowScores | Window-level dimension scores (section 9.2) |
| `composite` | number | Composite score (section 8) |
| `baseline` | BaselineSnapshot | Baseline scores and metadata (section 7.5) |
| `capacity` | CapacityReport | Token counting and capacity fields (cl-spec-006 section 4.5) |
| `tokenizer` | TokenizerMetadata | Active tokenizer name, accuracy, error bound, model family (cl-spec-006 section 7.5) |
| `segments` | SegmentScore[] | Per-segment scores for all active segments (section 9.3) |
| `groups` | GroupScore[] | Per-group aggregate scores (section 9.4) |
| `continuityLedger` | ContinuitySummary | Summary of eviction/compaction/restoration history (section 9.5) |
| `trend` | TrendData or null | Comparison against previous reports (section 9.6) |

### 9.2 Window Scores

The `windowScores` object contains normalized window-level scores for all four dimensions plus their raw (pre-normalization) values:

| Field | Type | Description |
|-------|------|-------------|
| `coherence` | number (0.0–1.0) | Normalized window coherence (section 3.7 / 7.3) |
| `density` | number (0.0–1.0) | Normalized window density (section 4.6 / 7.3) |
| `relevance` | number (0.0–1.0) | Normalized window relevance (section 5.7 / 7.3) |
| `continuity` | number (0.0–1.0) | Window continuity (section 6.7 — not normalized, already absolute) |
| `raw.coherence` | number | Pre-normalization coherence score |
| `raw.density` | number | Pre-normalization density score |
| `raw.relevance` | number | Pre-normalization relevance score |
| `raw.continuity` | number | Same as normalized (continuity has no baseline normalization) |

Raw scores are included for callers who need to compare across sessions or who prefer absolute values. Normalized scores are the primary interface — they answer "how is this window doing relative to its own baseline?"

### 9.3 Per-Segment Scores

Each active segment receives a score entry:

| Field | Type | Description |
|-------|------|-------------|
| `segmentId` | string | Segment identifier |
| `coherence` | number | Per-segment coherence score (section 3.6) |
| `density` | number | Per-segment density score (section 4.5) |
| `relevance` | number | Per-segment relevance score (section 5.5) |
| `continuity` | number | Per-segment continuity score (section 6.6) |
| `composite` | number | Per-segment composite score (section 8.4) |
| `tokenCount` | number | Segment token count |
| `redundancy` | RedundancyInfo or null | If redundancy > 0.5: which segment(s) this is redundant with, origin match (section 4.4) |
| `groupId` | string or null | Group membership, if any |

Per-segment scores are **ordered by composite ascending** — weakest segments first. This ordering supports the most common consumption pattern: "show me the worst segments" for eviction triage or diagnostic investigation.

### 9.4 Group Scores

Each group receives an aggregate score entry:

| Field | Type | Description |
|-------|------|-------------|
| `groupId` | string | Group identifier |
| `memberCount` | number | Number of members |
| `totalTokens` | number | Sum of member token counts |
| `groupCoherence` | number | Intra-group coherence (section 3.5) |
| `meanRelevance` | number | Token-weighted mean of member relevance scores |
| `meanDensity` | number | Token-weighted mean of member density scores |
| `composite` | number | Per-group composite |
| `integrityWarning` | boolean | True if `groupCoherence < 0.3` — members do not support the group structure |

Groups are ordered by composite ascending, like segments.

### 9.5 Continuity Summary

A condensed view of the continuity ledger (section 6.5) for the report:

| Field | Type | Description |
|-------|------|-------------|
| `totalEvictions` | number | Total segments evicted in this session |
| `totalCompactions` | number | Total segments compacted in this session |
| `totalRestorations` | number | Total segments restored in this session |
| `netLoss` | number | Current net information loss |
| `tokensEvicted` | number | Total tokens reclaimed by eviction |
| `tokensCompacted` | number | Total tokens reduced by compaction (original - compacted) |
| `tokensRestored` | number | Total tokens restored |
| `recentEvents` | ContinuityEvent[] | Last 10 eviction/compaction/restoration events with timestamps |

The summary provides the headline numbers. The full ledger is available through the diagnostics API (cl-spec-010) for callers who need the complete audit trail.

### 9.6 Trend Data

When at least two reports have been generated, the report includes trend data — a comparison against the previous report:

| Field | Type | Description |
|-------|------|-------------|
| `previousReportId` | string | ID of the report being compared against |
| `timeDelta` | number | Milliseconds between reports |
| `coherenceDelta` | number | Change in window coherence (-1.0 to +1.0) |
| `densityDelta` | number | Change in window density |
| `relevanceDelta` | number | Change in window relevance |
| `continuityDelta` | number | Change in window continuity |
| `compositeDelta` | number | Change in composite score |
| `segmentsDelta` | number | Change in segment count (positive = growth, negative = shrinkage) |
| `tokensDelta` | number | Change in total active tokens |

Trend data makes quality changes visible without requiring the caller to diff reports manually. A negative `coherenceDelta` after an `add` operation tells the caller that the new content reduced coherence — actionable information that raw scores alone do not surface as clearly.

**Trend is shallow** — one report back, not a moving average or a history window. Deeper trend analysis (rolling averages, rate-of-change alerts) is the responsibility of the diagnostics system (cl-spec-010), which retains report history and can compute aggregate trends.

### 9.7 Report Generation

Quality reports are generated in two modes:

**On-demand:** The caller explicitly requests a report through the API (cl-spec-007). context-lens computes all scores, assembles the report, and returns it. This is the primary path.

**Proactive (event-driven):** Certain lifecycle events trigger internal quality computation even without an explicit report request. These proactive computations are partial — they compute only what is needed for the event:

| Event | What is computed | Why |
|-------|-----------------|-----|
| Eviction | Pre-eviction quality snapshot for affected segments | Stored in `EvictionRecord.qualityBefore` |
| Restoration | Post-restoration scores for restored segments | Restoration fidelity measurement |
| Baseline capture | Full window scores | Establishes the baseline |

Proactive computations do not produce a full report — they compute and store the specific scores needed for continuity tracking. A full report is only generated when the caller asks for one.

**Report caching:** The most recent full report is cached. If the caller requests a report and no segments have been mutated since the last report, the cached report is returned (with an updated `timestamp` but identical scores). The cache is invalidated by any content-mutating lifecycle operation or task descriptor change.

## 10. Invariants and Constraints

The following invariants hold at all times within the quality model. Any operation that would violate an invariant is an implementation bug — these are guarantees, not guidelines.

### Score Invariants

1. **Bounded scores.** All dimension scores (per-segment and window-level) are in the range [0.0, 1.0]. The composite score is in the range [0.0, 1.0]. No score exceeds 1.0 or falls below 0.0. Clamping is applied after computation.

2. **Deterministic scoring.** The same window state (same segments, same content, same metadata, same task descriptor, same baseline) produces the same scores. Scores do not depend on wall-clock time, report generation order, or external state. Timestamps influence recency (section 5.4), but recency is computed from segment metadata, not from the system clock at scoring time.

3. **Dimension independence.** Each dimension is computed from its own inputs using its own formula. No dimension score is derived from another dimension's score. The composite (section 8) combines dimension scores but is a separate output, not an input to any dimension.

4. **Empty window.** A window with zero active segments has no meaningful quality. All dimension scores are undefined. Quality report generation on an empty window returns a report with `segmentCount: 0`, no `windowScores`, no `segments`, and `composite: null`. This is not an error — it is a valid state between evicting all content and adding new content.

5. **Single-segment window.** A window with one active segment has: coherence 1.0 (no adjacency to violate), density 1.0 (no other segment to be redundant with), relevance as computed normally, continuity as computed normally. The composite reflects this.

### Baseline Invariants

6. **Baseline immutability.** Once captured, the baseline does not change. No lifecycle operation, quality report, or passage of time modifies the baseline. The only exception is a late-seed re-baseline (section 7.2), which is a deliberate recalibration.

7. **Baseline precedes normalization.** No normalized score is produced before the baseline is captured. If no baseline exists, quality reports return raw scores with `baselineEstablished: false`. Consumers must check this flag.

8. **Continuity baseline is 1.0.** The continuity baseline is always 1.0 regardless of window state at capture time. No evictions or compactions have occurred at baseline capture.

### Computation Invariants

9. **No LLM calls.** The quality model never invokes a language model. All scores are computed from structural signals — token counts, content hashes, similarity scores, metadata, timestamps, and lifecycle records. This is a hard constraint that ensures scoring performance stays within the lifecycle operation budget. Embeddings (cl-spec-005) are computed by a separate, pluggable embedding provider, not by an LLM.

10. **Lazy invalidation.** Per-segment scores are invalidated only by events that change their inputs. Content mutation invalidates all four dimensions. Metadata changes invalidate relevance only (importance, tags affect the relevance formula). Task descriptor changes invalidate all relevance scores. Coherence and density scores are not invalidated by metadata or task changes. This prevents unnecessary recomputation.

11. **Aggregation from parts.** Window-level scores are always derived from per-segment scores by their defined aggregation method. They are never computed independently. If a per-segment score changes, the window-level aggregate is recomputed from all per-segment scores.

### Similarity Invariants

12. **Similarity symmetry.** `similarity(a, b) === similarity(b, a)` for all segment pairs, in both embedding and trigram modes. This is a property of cosine similarity and Jaccard similarity by construction, but the implementation must preserve it — reordering arguments must not change the result.

13. **Similarity mode consistency.** Within a single quality report, all similarity computations use the same mode — either embedding or trigram. A report does not mix modes. If the embedding provider becomes unavailable mid-session, context-lens falls back to trigram mode and invalidates all cached similarity scores. The report notes the active mode.

14. **Similarity cache coherence.** Cached similarity scores are invalidated when either participating segment's content changes. A stale similarity score between segment A (old content) and segment B would corrupt coherence and density scores.

### Report Invariants

15. **Report consistency.** A quality report is a point-in-time snapshot. All scores in a single report reflect the same window state. No lifecycle operation can interleave with report generation — the report sees an atomic view of the window. Segments added or evicted during report generation are not partially included.

16. **Report monotonic IDs.** Report IDs are monotonically increasing. `reportId(n+1) > reportId(n)`. Trend data always references the immediately preceding report. No report references a future report or skips a past report.

17. **Trend consistency.** Trend deltas in a report are exactly `currentScore - previousScore` for each dimension. They are not smoothed, averaged, or adjusted. The raw delta is the contract.

### Continuity Invariants

18. **Ledger append-only.** The continuity ledger accepts new entries but never modifies or deletes existing entries. The history of losses and recoveries is permanent for the session lifetime.

19. **Net loss non-negative.** `netLoss >= 0` at all times. Recovery can offset loss but never produce negative net loss — you cannot recover more quality than you lost. If `totalRecovery` would exceed `totalEvictionLoss + totalCompactionLoss`, it is clamped.

20. **Eviction cost requires pre-eviction snapshot.** Every `EvictionRecord` that contributes to the continuity ledger must include a `qualityBefore` snapshot. An eviction without a pre-eviction snapshot cannot be scored for continuity and is recorded as a ledger entry with `evictionCost: null` and a diagnostic warning.

## 11. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-001` (Segment Model) | Defines segments, groups, protection tiers, and lifecycle operations that produce the data the quality model scores. Eviction records, compaction records, and restoration mechanics feed the continuity dimension. |
| `cl-spec-003` (Degradation Patterns) | Consumes window-level scores to detect the five degradation patterns: saturation (capacity), erosion (density at high utilization), fracture (coherence), gap (relevance), collapse (continuity). Each pattern is a characteristic signature across dimensions. |
| `cl-spec-005` (Embedding Strategy) | Provides the optional embedding provider for semantic similarity. When available, coherence, density, and relevance scoring use cosine similarity on embeddings. When absent, fallback to Jaccard trigram similarity. |
| `cl-spec-006` (Tokenization Strategy) | Provides token counts consumed by density scoring (information ratio, token-weighted aggregation) and capacity metrics included in quality reports. Tokenizer accuracy metadata annotates reports. |
| `cl-spec-007` (API Surface) | Exposes quality report generation, task descriptor management (`setTask`), and per-dimension queries to the caller. |
| `cl-spec-008` (Eviction Advisory) | Consumes per-segment relevance, coherence, and density scores for eviction candidate ranking. Operates on individual dimensions, not the composite. |
| `cl-spec-009` (Performance Budget) | Sets latency constraints for quality score computation. Similarity matrix sampling thresholds for large windows. Report generation latency targets. |
| `cl-spec-010` (Report & Diagnostics) | Retains report history for deep trend analysis. Surfaces per-segment scores, group integrity warnings, and continuity audit trails. |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.6*
