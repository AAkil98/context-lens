# Phase 2 -- Similarity and Scoring Engine

## 1. Preamble

Phase 2 builds the scoring engine on top of Phase 1's foundation (types, errors, events, utils, segment-store, tokenizer). After Phase 2, context-lens can compute quality scores across all four dimensions, assemble quality reports, manage task identity, and produce embeddings -- but cannot yet detect degradation patterns or plan evictions.

**Design specs covered:**
- `cl-spec-002` (Quality Model) -- coherence, density, relevance, continuity formulas; baseline capture; composite score; report structure
- `cl-spec-004` (Task Identity) -- descriptor model, transitions, grace period, staleness, history
- `cl-spec-005` (Embedding Strategy) -- provider interface, built-in providers, cache, provider switching, fallback

**Performance budget:** `cl-spec-009` -- assess() < 50ms at n<=500 (excluding provider calls), sampling at n>200, cold-start < 500ms

**Key resolutions:**
- R-008: Protection relevance uses post-hoc clamp/floor, not multiplicative
- R-177: `assessmentTimestamp` (captured once per `assess()`) replaces all wall-clock references in recency/age formulas
- R-178: FNV-1a for sampling seed and all non-cryptographic hashing

**Parent document:** `IMPLEMENTATION.md` (section 5, Phase 2 row; section 4, dependency graph)

---

## 2. Module Map

| Module | Primary design spec | Responsibility |
|--------|-------------------|----------------|
| `similarity` | cl-spec-002 SS3.2 | Trigram computation, cosine similarity, pairwise similarity cache, mode switching |
| `embedding` | cl-spec-005 | Provider interface, embedding cache, provider registration/switching, fallback coordination |
| `task` | cl-spec-004 | Task descriptor model, validation, normalization, transition classification, grace period, staleness, history |
| `scoring/coherence` | cl-spec-002 SS3 | Adjacency coherence, topical concentration (with sampling), group integrity, window-level coherence |
| `scoring/density` | cl-spec-002 SS4 | Redundancy detection (with sampling), information ratio, origin-aware annotation, window-level density |
| `scoring/relevance` | cl-spec-002 SS5 | Task similarity, keyword boost, metadata signals, recency, protection adjustment, window-level relevance |
| `scoring/continuity` | cl-spec-002 SS6 | Eviction cost, compaction cost, restoration fidelity, cumulative ledger, window-level continuity |
| `scoring/baseline` | cl-spec-002 SS7 | Capture trigger detection, snapshot, score normalization |
| `scoring/composite` | cl-spec-002 SS8 | Weighted geometric mean of four dimensions |
| `quality-report` | cl-spec-002 SS9 | Report assembly, caching, lazy invalidation, trend computation |

---

## 3. Dependency Direction

```
                      ┌────────────────┐
                      │ quality-report │
                      └───────┬────────┘
            ┌─────────┬───────┼──────────┬──────────────┐
            v         v       v          v              v
      ┌──────────┐ ┌──────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
      │scoring/  │ │scor/ │ │scoring/  │ │scoring/  │ │scoring/  │
      │coherence │ │dens. │ │relevance │ │continuity│ │composite │
      └────┬─────┘ └──┬───┘ └────┬─────┘ └────┬─────┘ └──────────┘
           │          │          │             │
           └────┬─────┘          │             │
                v                v             │
           ┌──────────┐    ┌────────┐          │
           │similarity│    │  task  │          │
           └────┬─────┘    └───┬────┘          │
                │              │               │
                v              │               │
           ┌──────────┐        │               │
           │embedding │        │               │
           └────┬─────┘        │               │
                │              │               │
      ┌─────────┴──────────────┘               │
      v                                        v
  ┌──────────────────────────────────────────────────┐
  │  Phase 1: segment-store, tokenizer, events,      │
  │           utils/ (hash, lru-cache, ring-buffer,   │
  │           copy), types, errors                    │
  └──────────────────────────────────────────────────┘
```

Additionally, `scoring/baseline` is consumed by `quality-report` for normalization, but does not import any other scoring module.

**Rules (from IMPLEMENTATION.md SS4):**
- No circular imports.
- No upward imports: lower layers never import higher layers.
- `utils/`, `errors`, `types` are imported by any module.
- `scoring/*` modules import `similarity` and `utils/` but **not each other**.
- `quality-report` imports all `scoring/*` modules, `task`, `similarity`, and `embedding`.
- `similarity` imports `embedding` (to retrieve cached vectors) but `embedding` does not import `similarity`.
- `task` imports `similarity` (for transition classification) and `embedding` (for descriptor preparation).

---

## 4. Module Specifications

### 4.1 similarity

**Responsibilities:**
- **Trigram computation.** Compute character trigram sets from arbitrary strings. Trigram sets are the set of all 3-character substrings of the lowercased input. A trigram set is produced for any content string on demand (cl-spec-002 SS3.2).
- **Cosine similarity.** Compute cosine similarity between two embedding vectors. Handles the zero-vector edge case (returns 0.0) to prevent NaN from division by zero.
- **Jaccard similarity.** Compute Jaccard index over two trigram sets: `|A intersection B| / |A union B|`. Range 0.0--1.0.
- **Similarity cache.** LRU cache mapping `(hash_a, hash_b, mode)` to a scalar similarity score. The cache key uses ordered content hashes (lower hash first) to enforce symmetry -- `similarity(a, b)` and `similarity(b, a)` share one cache entry (cl-spec-002 invariant 12). Default capacity: 16384 entries.
- **Mode switching.** Expose a `computeSimilarity` function that dispatches to cosine (when embeddings are available for both inputs) or Jaccard (otherwise). The caller never selects the mode -- it is determined by what prepared forms are available in the embedding cache.
- **Cache invalidation.** Invalidate all cache entries referencing a given content hash (when a segment's content changes). Full clear on provider switch (cl-spec-005 SS6.2, step 2).

**Key design decisions:**
- Jaccard over character trigrams is the fallback, not an alternative. It operates without any external dependency. Cosine over embedding vectors is preferred when a provider is configured.
- The similarity cache is keyed on `(hash_a, hash_b, mode)` where `mode` is `"embedding"` or `"trigram"`. Including mode prevents stale cross-mode hits after a provider switch (cl-spec-005 SS5.2).
- Cache keys use the ordered pair convention: the lexicographically smaller content hash comes first. This guarantees that `similarity(a, b)` and `similarity(b, a)` always resolve to the same cache entry without requiring the caller to sort.
- The similarity cache is separate from the embedding cache. They form a two-level pipeline: embedding cache produces vectors, similarity cache consumes them (cl-spec-005 SS5.2).

**Integration points:**
- All four dimension scorers call `computeSimilarity` -- coherence for adjacency and topical concentration, density for redundancy, relevance for content-to-task similarity.
- Task transition classification (cl-spec-004 SS3.2) calls `computeSimilarity` to measure description similarity between old and new task descriptors.
- Embedding module triggers full similarity cache clear on provider switch.

---

### 4.2 embedding

**Responsibilities:**
- **Provider interface.** Define the `EmbeddingProvider` contract: one required method (`embed`), one optional method (`embedBatch`), and metadata (`name`, `dimensions`, `modelFamily`, `maxInputTokens`). Per cl-spec-005 SS2.1--2.2.
- **Embedding cache.** LRU cache mapping `(contentHash, providerName)` to a vector (`number[]`) or trigram set (`Set<string>`). Default capacity: 4096 entries (cl-spec-005 SS5.3). The cache is mode-agnostic at the storage level -- it stores whatever the active mode produces.
- **Provider registration and switching.** One provider per instance. `setEmbeddingProvider(provider)` triggers the full invalidation cascade: clear embedding cache, clear similarity cache, invalidate all similarity-dependent quality scores, re-embed all active segments, re-prepare the task descriptor (cl-spec-005 SS6.2). Same-name registration is a no-op (cl-spec-005 SS6.4).
- **Fallback coordination.** When no provider is configured (the default), all content is prepared as trigram sets. When a provider is configured but a lifecycle embed call fails, the error propagates to the caller -- no silent per-call fallback (cl-spec-005 SS7.2). Report-level fallback to trigrams occurs only when the quality report detects missing embeddings across active segments.
- **Content truncation.** When the provider declares `maxInputTokens`, content exceeding that limit is truncated before embedding. Truncation uses the configured tokenizer. The full content is retained in the segment; only the text passed to `embed` is truncated (cl-spec-005 SS2.3).
- **Vector validation.** Every vector returned by the provider is validated: dimension match against `metadata.dimensions`, all elements finite, non-zero check with warning (cl-spec-005 SS2.4).
- **Batch embedding.** When `embedBatch` is available, batch calls are used for seed operations and provider switches. Cache-aware batching: content hashes that already have cached embeddings are excluded from the batch (cl-spec-005 SS4.3).

**Key design decisions:**
- One provider per context-lens instance. All embeddings use the same provider and model. Cosine similarity between vectors from different embedding spaces is meaningless -- single-provider is a correctness constraint (cl-spec-005 invariant 1).
- The embedding cache key is `(contentHash, providerName)`. Including `providerName` prevents cross-provider collisions after a switch. In trigram mode, the provider name component is the literal string `"trigram"` (cl-spec-005 SS5.1).
- Mode consistency per report: within a single quality report, all similarity computations use the same mode. If any active segment lacks an embedding at report time, the entire report falls back to trigram mode (cl-spec-005 SS7.3, cl-spec-002 invariant 13).
- `embed` calls may be async (returning a Promise). Lifecycle operations that trigger embedding await the result before returning. From the caller's perspective, operations are synchronous -- no deferred embedding, no pending state (cl-spec-005 invariant 8).

**Integration points:**
- `similarity` reads the embedding cache to retrieve vectors for cosine similarity computation.
- `task` calls the embedding module to prepare (embed or trigram) the task description on `setTask`.
- Provider switch triggers full invalidation cascade through similarity cache clear and quality score invalidation.
- `segment-store` lifecycle operations (add, update, replace, compact, restore) trigger embedding of new/changed content.

---

### 4.3 task

**Responsibilities:**
- **Descriptor model.** Validate and normalize `TaskDescriptor` objects per cl-spec-004 SS2. Validation: description required and non-empty after trim, max 2000 characters; keywords max 50 after dedup; arrays contain non-empty strings. Normalization: trim whitespace, collapse internal whitespace in description, case-insensitive dedup of keywords (keep first occurrence casing), case-sensitive dedup of origins and tags, lexicographic sort of all arrays.
- **Immutability after set.** The normalized descriptor is deep-copied on storage and on retrieval. No partial update API -- `setTask` always takes a complete descriptor (cl-spec-004 SS2.4).
- **Transition classification.** Three-way classification on every `setTask` against an existing active task (cl-spec-004 SS3.1--3.2):
  - **Same task:** Field-by-field identity after normalization. No-op except staleness counter reset.
  - **Refinement:** Description similarity above `refinementThreshold` (default 0.7, configurable 0.1--0.95), or descriptions identical but other fields differ. Invalidates relevance cache. No grace period.
  - **Change:** Description similarity below threshold. Invalidates relevance cache. Activates grace period.
- **Grace period.** 2-report window after a task change. `gracePeriodActive` flag and `gracePeriodRemaining` counter. Decremented on each quality report. Caps gap pattern severity at `watch`. Does not activate on initial set or refinements. Does not cancel on refinement during active grace. Restarts on a new change during active grace (cl-spec-004 SS5.2).
- **Staleness.** Flag set when `reportsSinceSet >= 5`. Reset by any `setTask` call including same-task no-ops. Informational only -- does not affect scoring (cl-spec-004 SS5.3).
- **Transition history.** Ring buffer of 20 entries. Each entry: type, timestamp, similarity (for change/refinement), previousDescription (truncated to 200 chars), newDescription (truncated to 200 chars). Same-task no-ops are not recorded (cl-spec-004 SS5.4).
- **Task state object.** Full state exposed via `getTaskState()`: current/previous task, timestamps, counters, grace period state, staleness flag, transition history (cl-spec-004 SS4.4).
- **Descriptor preparation.** On `setTask` (change or refinement), embed or trigram the description through the embedding module. Keywords are not embedded -- they use case-insensitive whole-word string matching (cl-spec-004 SS6.1--6.4).

**Key design decisions:**
- The task descriptor is immutable between `setTask` calls. Cached relevance scores derived from it are valid until the next `setTask`. Defensive copy on both storage and retrieval prevents mutation from either side (cl-spec-004 SS2.4).
- Three-way classification (same/refinement/change) determines all downstream behavior: whether scores are invalidated, whether grace period activates, what gets recorded in history. Same task is free, refinement is cheap, change is the expensive path (cl-spec-004 SS3.5).
- Grace period duration is fixed at 2 reports, not configurable. It protects against a specific false-positive pattern (gap alarm on task change) and has one correct operating point (cl-spec-004 SS5.2).
- No task is a valid state, not an error. Relevance defaults to 1.0 for all segments. Gap pattern suppressed. `clearTask()` is the explicit "stop tracking tasks" signal, distinct from setting a vague task (cl-spec-004 SS4.1).
- `setTask` returns a `TaskTransition` object containing classification type, similarity score, and previous task descriptor (cl-spec-004 SS4.3).

**Integration points:**
- `scoring/relevance` reads the current task descriptor (prepared form) and task state (for protection, metadata signals).
- Phase 3 detection framework reads `taskDescriptorSet` flag, `gracePeriodActive`, and `gracePeriodRemaining` for gap pattern handling.
- `similarity` is called for transition classification (description similarity between old and new descriptors).
- `embedding` is called for descriptor preparation (embed or trigram the description).

---

### 4.4 scoring/coherence

**Responsibilities:**
- **Adjacency coherence.** For each pair of adjacent segments (i, i+1), compute `similarity(segment[i], segment[i+1])`. Per-segment adjacency score: first and last segments use their single neighbor's score; interior segments average their two neighbor scores. Single-segment window: adjacency coherence 1.0 (cl-spec-002 SS3.3).
- **Topical concentration.** Build a similarity matrix, apply single-linkage clustering at threshold `tau_cluster = 0.4`, count clusters `k`, compute `topicalConcentration = 1/k` (cl-spec-002 SS3.4). At n > 200, sampling activates: sample size `s = min(ceil(sqrt(n) * 3), n)` with stratified sampling to represent groups proportionally. Cluster count is computed on the sampled matrix with the adjusted formula `topicalConcentration = 1 - (c_s - 1) / max(1, floor(s / 4))` (cl-spec-009 SS5.2).
- **Group integrity.** For each group, compute average pairwise similarity among members. Single-member group: integrity 1.0. Surface `integrityWarning: true` when group coherence < 0.3 (cl-spec-002 SS3.5).
- **Per-segment coherence.** Ungrouped: `coherence(i) = coherence_adj(i)`. Grouped: `coherence(i) = (coherence_adj(i) + groupCoherence(group(i))) / 2` (cl-spec-002 SS3.6).
- **Window-level coherence.** `windowCoherence = meanAdjacencyCoherence * 0.6 + topicalConcentration * 0.4`. Weights fixed, not configurable (cl-spec-002 SS3.7).

**Key design decisions:**
- Adjacency weight 0.6, topical concentration weight 0.4. Adjacency is weighted higher because the model processes segments sequentially -- adjacency relationships matter more than global clustering structure (cl-spec-002 SS3.7).
- Sampling activates at n > 200 via stratified `sqrt(n) * 3` sample size. At n = 500, s = 68, producing 2,278 matrix pairs -- well within the 50ms assessment budget (cl-spec-009 SS5.2). FNV-1a of sorted segment IDs (joined by null byte) is the sampling seed, ensuring deterministic sample selection for a given segment set.
- Single-linkage clustering is used for topical concentration. It is the simplest clustering algorithm that produces a count -- more sophisticated methods (DBSCAN, k-means) would add complexity without proportional benefit for a directional signal (cl-spec-002 SS3.4).
- All similarity lookups go through the similarity cache. Cold-start pays O(n^2) or sampled O(s^2); subsequent reports pay O(1) per cached pair.

---

### 4.5 scoring/density

**Responsibilities:**
- **Redundancy detection.** For each segment, find the maximum similarity to any non-adjacent segment: `redundancy(i) = max(similarity(i, j))` for all `j != i` where `j` is not adjacent to `i`. Maximum captures the worst-case overlap -- a segment 90% redundant with even one other segment is a density problem (cl-spec-002 SS4.2).
- **Information ratio.** `informationRatio(i) = 1.0 - redundancy(i)`. Represents the fraction of the segment's content that is novel (cl-spec-002 SS4.3).
- **Per-segment density score.** `density(i) = informationRatio(i)`. Deliberately simple -- density is the most concrete dimension (cl-spec-002 SS4.5).
- **Token waste annotation.** `tokenWaste(i) = segment[i].tokenCount * redundancy(i)`. Included in the per-segment score entry for diagnostic visibility (cl-spec-002 SS4.3).
- **Origin-aware annotation.** When redundancy > 0.5, annotate whether the redundant pair shares an origin (suggesting accidental duplication) or has different origins (suggesting intentional overlap). This annotation does not change the score -- it provides context in the quality report (cl-spec-002 SS4.4).
- **Window-level density.** Token-weighted mean: `windowDensity = sum(density(i) * tokenCount(i)) / sum(tokenCount(i))` (cl-spec-002 SS4.6).
- **Sampling.** At n > 200, density uses cached-first sampling: for each segment, collect all cached similarity values to non-adjacent segments first; if uncached pairs remain, sample `min(30, remaining)` from the uncached set. This bounds per-segment uncached computation at 30 comparisons regardless of n (cl-spec-009 SS5.3).

**Key design decisions:**
- Density equals `1 - maxRedundancy` to the nearest non-adjacent segment. This is the information ratio -- the fraction of the segment's content that is unique relative to the rest of the window (cl-spec-002 SS4.5).
- Adjacency exclusion prevents coherent neighbors from being misclassified as redundant. Similar neighbors are coherence; similar strangers are waste (cl-spec-002 SS4.2).
- Cached-first sampling with a 30-sample cap bounds the worst-case cold-start cost at O(30n) = O(n), linear in segment count. After several reports, the cache covers most pairs and sampling degenerates to pure cache reads (cl-spec-009 SS5.3).
- The sampled max is an optimistic estimate (density >= true density) because sampling can miss the most-similar pair but cannot fabricate one. The bias direction is safe: underestimating redundancy retains slightly more redundant content, which is a minor inefficiency rather than a correctness failure (cl-spec-009 SS5.5).
- Exact duplication is detected via content hash comparison (inherited from segment-store). Same hash = redundancy 1.0 for that pair.

---

### 4.6 scoring/relevance

**Responsibilities:**
- **Task similarity.** `taskSimilarity(i) = similarity(segment[i].content, task.description)` using the prepared form of the task description (embedding vector or trigram set). When no task is set, relevance is 1.0 for all segments (cl-spec-002 SS5.1--5.2).
- **Keyword boost.** `keywordScore(i) = |keywords found in segment[i].content| / |task.keywords|`. Keywords matched case-insensitively as whole words -- `"auth"` does not match `"author"` (cl-spec-002 SS5.2).
- **Content relevance.** `contentRelevance(i) = taskSimilarity(i) * 0.7 + keywordScore(i) * 0.3` (cl-spec-002 SS5.2). Without keywords, content relevance equals task similarity.
- **Metadata signals.** Origin relevance: binary 1.0/0.0 based on `task.relatedOrigins`. Tag relevance: fractional based on intersection with `task.relatedTags`. Importance: the caller-assigned importance value from the segment (cl-spec-002 SS5.3).
- **Recency.** `age(i) = assessmentTimestamp - max(segment[i].createdAt, segment[i].updatedAt)`. `recency(i) = 1.0 - (age(i) / maxAge)` where `maxAge` is the age of the oldest active segment relative to `assessmentTimestamp`. Per R-177, recency uses `assessmentTimestamp` (captured once per `assess()` call), never the system clock (cl-spec-002 SS5.4).
- **Per-segment relevance.** Weighted sum of five components: content (0.45), keyword (0.10), origin (0.10), recency (0.20), importance (0.15). Then protection adjustment as post-hoc clamp/floor per R-008: pinned -> 1.0; seed -> max(base, 0.3); all others pass through (cl-spec-002 SS5.5).
- **Window-level relevance.** Token-weighted mean: `windowRelevance = sum(relevance(i) * tokenCount(i)) / sum(tokenCount(i))` (cl-spec-002 SS5.7).

**Key design decisions:**
- No task = score 1.0 for all segments. This is the safe default: without a task declaration, context-lens cannot measure relevance, so it assumes everything is relevant. No relevance-based eviction pressure (cl-spec-002 SS5.1).
- Recency uses `assessmentTimestamp` (the report's `timestamp` field, captured at `assess()` start), not `Date.now()`. This makes recency deterministic: same state + same assessmentTimestamp = same recency scores. Per R-177, all wall-clock references in formulas are replaced with this single captured timestamp.
- Protection adjustment is post-hoc clamp/floor, not multiplicative. Per R-008: compute the full weighted base relevance first, then apply protection. Pinned segments are clamped to 1.0 regardless of base score. Seed segments are floored at 0.3 -- their base score can only go up from there, never below the floor. This avoids the multiplication problem where a low base score would reduce a protected segment's relevance below the intended protection level.
- When metadata signals are absent (no keywords, no relatedOrigins, no relatedTags), those components contribute 0.0. The score reduces to content similarity + importance + recency. This is the minimal-configuration path (cl-spec-002 SS5.5).
- Relevance is invalidated on any `setTask` (change or refinement) and on `clearTask`. On `clearTask`, all scores become trivially 1.0 with no similarity computation (cl-spec-004 SS5.1).

---

### 4.7 scoring/continuity

**Responsibilities:**
- **Eviction cost.** `evictionCost(record) = record.qualityBefore.relevance * record.importance * (record.tokenCount / totalActiveTokensAtEviction)`. Relevance at eviction time is the primary weight because it is the dimension most directly affected by removal (cl-spec-002 SS6.2).
- **Compaction cost.** `compactionCost(record) = compressionRatio * segment.importance * (1.0 - redundancy(segment))`. Compression ratio: `1.0 - (compactedTokenCount / originalTokenCount)`. Inverse redundancy ensures that compacting a highly redundant segment costs less -- the information likely survives in other segments (cl-spec-002 SS6.3).
- **Restoration fidelity.** `restorationFidelity(record) = qualityAfterRestore.relevance / qualityBeforeEviction.relevance`. Measures how well restoration recovers lost quality. Fidelity loss comes primarily from context drift -- the task may have changed since eviction (cl-spec-002 SS6.4).
- **Cumulative ledger.** Append-only history of all eviction, compaction, and restoration events. Each entry: segment ID, cost or fidelity, timestamp. The ledger is the audit trail for the continuity dimension (cl-spec-002 SS6.5, invariant 18).
- **Net loss.** `netLoss = totalEvictionLoss + totalCompactionLoss - totalRecovery`. Recovery is `sum(evictionCost(r) * restorationFidelity(r))` for all restored evictions. Net loss is non-negative -- clamped at 0.0 (cl-spec-002 invariant 19).
- **Per-segment continuity.** Restored segments: `continuity(i) = restorationFidelity(i)`. Compacted segments: `continuity(i) = 1.0 - compactionCost(i)`. Never-evicted/never-compacted segments: `continuity(i) = 1.0` (cl-spec-002 SS6.6).
- **Window-level continuity.** `windowContinuity = 1.0 - (netLoss / totalInformationValue)` where `totalInformationValue = sum(importance(i) * tokenCount(i)) / sum(tokenCount(i))` for all segments ever active in the session. Clamped to 0.0--1.0 (cl-spec-002 SS6.7).

**Key design decisions:**
- The continuity ledger is append-only. Entries are never removed or modified. This makes continuity auditable -- every loss and recovery is permanently recorded for the session lifetime (cl-spec-002 invariant 18).
- Eviction cost weights by relevance, importance, and token fraction. Only relevance is used (not all four dimensions) because relevance is the dimension where loss is most predictable and consequential at eviction time. Coherence impact depends on what remains after removal -- it cannot be measured at eviction time (cl-spec-002 SS6.2).
- Continuity is the only dimension that is similarity-independent. It does not call the similarity function and is not affected by provider switches. It reads from the ledger and segment state only (cl-spec-004 SS5.1).
- Every `EvictionRecord` must include a `qualityBefore` snapshot. Eviction without a pre-eviction snapshot records `evictionCost: null` with a diagnostic warning (cl-spec-002 invariant 20).

---

### 4.8 scoring/baseline

**Responsibilities:**
- **Capture trigger detection.** The baseline is captured automatically after the last `seed` operation completes, before the first `add` operation takes effect. The first `add` call triggers the snapshot, but the added segment is not included in it (cl-spec-002 SS7.2).
- **Snapshot.** The baseline is a frozen snapshot of all four window-level dimension scores at capture time: coherence, density, relevance at their current values; continuity always 1.0 (no evictions yet). Includes metadata: `capturedAt` timestamp, `segmentCount`, `tokenCount` at capture time (cl-spec-002 SS7.1, SS7.5).
- **Score normalization.** `normalizedScore(dimension) = currentScore(dimension) / baseline[dimension]`. Clamped to 0.0--1.0. Scores exceeding the baseline are clamped to 1.0 -- exceeding baseline quality is not a problem to report (cl-spec-002 SS7.3).
- **Edge cases.** No seeds, immediate `add`: baseline captured on the first add against an empty window (degenerate baseline, all scores 1.0). Seeds added after `add`: re-baseline with a warning. No operations at all: no baseline; reports return raw scores with `baselineEstablished: false` (cl-spec-002 SS7.2).

**Key design decisions:**
- The baseline is immutable after capture. No lifecycle operation, quality report, or passage of time modifies it. The only exception is a late-seed re-baseline, which is a deliberate recalibration (cl-spec-002 invariant 6).
- Baseline precedes normalization. No normalized score is produced before baseline capture. Reports before baseline contain raw scores and `baselineEstablished: false` (cl-spec-002 invariant 7).
- Continuity baseline is always 1.0 regardless of window state at capture time (cl-spec-002 invariant 8).
- The baseline module does not import other scoring modules. It receives the four raw window-level scores as inputs and stores them. This keeps it dependency-free within the scoring layer.

---

### 4.9 scoring/composite

**Responsibilities:**
- **Weighted geometric mean.** `composite = (coherence^w_c * density^w_d * relevance^w_r * continuity^w_t) ^ (1 / (w_c + w_d + w_r + w_t))` (cl-spec-002 SS8.2).
- **Per-segment composite.** Same formula applied to each segment's four per-segment scores (cl-spec-002 SS8.4).
- **Zero collapse.** Any single dimension at zero produces a composite of zero. This is a mechanical property of the geometric mean, not special-case logic -- but it is the key design rationale for choosing geometric over arithmetic mean (cl-spec-002 SS8.2).

**Key design decisions:**
- Weights are fixed, not configurable: coherence 0.25, density 0.20, relevance 0.30, continuity 0.25. Relevance is weighted slightly higher because irrelevant context is the most direct cause of model underperformance. Density is slightly lower because low density wastes tokens but does not directly confuse the model (cl-spec-002 SS8.2).
- The geometric mean penalizes imbalance. A window with three perfect dimensions and one collapsed dimension scores 0.0, not 0.75. This correctly signals that a context window is only as healthy as its weakest dimension (cl-spec-002 SS8.2).
- The composite is a summary for human consumption and coarse automation (threshold alerting, trend plotting). Systems that act on quality (eviction advisory, degradation detection -- both Phase 3) operate on individual dimensions, never on the composite (cl-spec-002 SS8.1).

---

### 4.10 quality-report

**Responsibilities:**
- **Report assembly.** Collect per-segment scores from all four dimension scorers, compute window-level aggregates, compute composite, assemble per-group scores, build continuity summary, include capacity data and tokenizer metadata. Produce the full `QualityReport` structure defined in cl-spec-002 SS9.1.
- **assessmentTimestamp.** Capture `Date.now()` once at the start of `assess()`. This timestamp is stored as the report's `timestamp` field and flows to all scorers that need a time reference (relevance recency, continuity age). Per R-177, no other `Date.now()` call occurs during scoring.
- **Report caching.** Cache the most recent full report. If no content-mutating operations or task changes have occurred since the last report, return the cached report. The cache is invalidated by any content mutation (add, update, replace, compact, evict, restore), any task change (`setTask` change or refinement, `clearTask`), or any provider switch (cl-spec-002 SS9.7).
- **Lazy invalidation.** Track which per-segment scores are invalidated since the last report. On `assess()`, recompute only invalidated segments; reuse cached scores for unchanged segments. This makes incremental assessment O(k) in the number of changed segments, not O(n) (cl-spec-002 SS2.4).
- **Trend computation.** When at least two reports exist, compute trend data: deltas for each dimension, composite, segment count, and total tokens between current and previous report. Trend is shallow -- one report back, not a moving average (cl-spec-002 SS9.6).
- **Mode indicator.** Include `embeddingMode: "embeddings" | "trigrams"` in every report, indicating which similarity mode produced the scores (cl-spec-005 SS7.3).
- **Per-segment ordering.** Per-segment scores ordered by composite ascending -- weakest segments first. Per-group scores also ordered by composite ascending (cl-spec-002 SS9.3--9.4).
- **Baseline normalization.** When `baselineEstablished` is true, window scores are normalized against the baseline. When false, raw scores are reported with the flag set accordingly (cl-spec-002 SS7.3).
- **Grace period tick.** On each report while `gracePeriodActive`, decrement `gracePeriodRemaining`. Deactivate grace period when counter reaches zero (cl-spec-004 SS5.2).
- **Staleness tick.** Increment `reportsSinceSet` on each report. Update the `stale` flag (cl-spec-004 SS5.3).

**Key design decisions:**
- The report is cached until a mutation invalidates it. This makes repeated `assess()` calls without intervening mutations O(1) -- returning a cached object (cl-spec-002 SS9.7).
- Trend is shallow: one-report delta, not a rolling window. Deeper trend analysis (rolling averages, rate-of-change alerts) is the responsibility of Phase 4 diagnostics, which retains report history (cl-spec-002 SS9.6).
- `assessmentTimestamp` is captured once and flows everywhere. This is the single point of non-determinism in the entire scoring pipeline. Given the same window state and the same `assessmentTimestamp`, all scores are fully deterministic (cl-spec-002 invariant 2, R-177).
- Report-level fallback: if any active segment lacks an embedding at report time and an embedding provider is configured, the entire report falls back to trigram mode for mode consistency (cl-spec-005 SS7.2--7.3, cl-spec-002 invariant 13).
- The quality report is the contract boundary between Phase 2 (scoring) and Phase 3 (detection, advisory). Phase 3 modules consume the report structure; they do not call scorers directly.

---

## 5. Test Requirements

### Unit tests

One test file per module in `test/unit/`, mirroring `src/` structure.

**`similarity.test.ts`:**
- Trigram computation: correct trigram sets for known inputs, empty string, single-character string, unicode.
- Jaccard similarity: identity (self-similarity = 1.0), symmetry, disjoint sets = 0.0, known overlap ratios.
- Cosine similarity: identity (same vector = 1.0), orthogonal vectors = 0.0, anti-parallel vectors, zero vector = 0.0.
- Similarity cache: hit/miss behavior, ordered key symmetry (a,b same as b,a), invalidation on content hash change, full clear.
- Mode dispatch: uses cosine when embeddings available, Jaccard when not.

**`embedding.test.ts`:**
- Provider registration: stores metadata, no-op on same-name re-registration.
- Embedding cache: cache hit after initial embed, cache miss after content change, full clear on provider switch.
- Vector validation: dimension mismatch rejection, NaN rejection, Infinity rejection, zero-vector warning.
- Batch embedding: cache-aware exclusion, correct ordering of results.
- Fallback: error propagation on individual embed failure, report-level fallback when embeddings missing.
- Provider switch cascade: embedding cache cleared, similarity cache cleared, all active segments re-embedded.

**`task.test.ts`:**
- Validation: reject null, reject missing description, reject empty description, reject over-2000-char description, reject non-string keyword elements, reject >50 keywords after dedup.
- Normalization: whitespace collapse, keyword case-insensitive dedup, array sorting, idempotency.
- Transition classification: same-task identity, refinement (above threshold), change (below threshold), first-task as "new".
- Grace period: activates on change, does not activate on refinement, countdown on reports, restart on second change.
- Staleness: flag set at 5 reports, reset on any `setTask`.
- History: ring buffer capacity 20, entries contain truncated descriptions, same-task no-ops not recorded.
- Immutability: mutations to returned descriptor do not affect internal state.

**`scoring/coherence.test.ts`:**
- Adjacency: single segment = 1.0, two identical segments = high, two unrelated segments = low.
- Topical concentration: one cluster = 1.0, many clusters = low.
- Group integrity: single member = 1.0, related members = high, unrelated members = low, warning at < 0.3.
- Window-level: correct weighting (0.6 adjacency + 0.4 topical).
- Sampling: activates at n > 200, sample size matches `ceil(sqrt(n) * 3)`, deterministic for same segment set.

**`scoring/density.test.ts`:**
- Single segment: density 1.0.
- Exact duplicates: density 0.0 for both.
- Partial overlap: density between 0 and 1.
- Adjacency exclusion: similar neighbors not counted as redundant.
- Origin-aware annotation: same-origin vs different-origin annotation present when redundancy > 0.5.
- Token waste: correct `tokenCount * redundancy` computation.
- Window-level: correct token-weighted mean.
- Sampling: cached-first behavior, 30-sample cap per segment.

**`scoring/relevance.test.ts`:**
- No task: all segments score 1.0.
- Task similarity: high for related content, low for unrelated.
- Keyword boost: correct fraction computation, case-insensitive whole-word matching, `"auth"` does not match `"author"`.
- Protection: pinned = 1.0 regardless of base, seed floored at 0.3, others pass through.
- Recency: newest segment = 1.0, oldest = 0.0, uses assessmentTimestamp not Date.now().
- Weight verification: five components sum to 1.0 (0.45 + 0.10 + 0.10 + 0.20 + 0.15).
- Missing metadata: absent keywords/origins/tags contribute 0.0.

**`scoring/continuity.test.ts`:**
- No evictions: continuity 1.0 for all segments and window.
- Eviction cost: correct formula, relevance-weighted.
- Compaction cost: correct formula, inverse-redundancy factor.
- Restoration fidelity: correct ratio.
- Ledger append-only: entries persist, never removed.
- Net loss: non-negative after clamping.
- Window-level: correct normalization against totalInformationValue.

**`scoring/baseline.test.ts`:**
- Capture timing: captured after last seed, before first add takes effect.
- Normalization: correct division, clamped to 0.0--1.0.
- Immutability: baseline does not change after capture.
- Continuity baseline: always 1.0.
- Edge cases: no seeds (degenerate baseline), no operations (no baseline, flag false).

**`scoring/composite.test.ts`:**
- Zero collapse: any dimension at 0 produces composite 0.
- All-ones: composite 1.0.
- Weight verification: correct geometric mean with stated weights.
- Per-segment composite: same formula applied per segment.

**`quality-report.test.ts`:**
- Report assembly: all required fields present, correct types.
- Caching: cached report returned when no mutations, invalidated on mutation.
- Trend: correct deltas between consecutive reports, null for first report.
- Mode indicator: matches active similarity mode.
- Baseline normalization: applied when baseline established, raw scores when not.
- Ordering: segments ordered by composite ascending, groups likewise.
- Grace period tick: counter decremented on each report.
- Staleness tick: counter incremented on each report.

### Integration tests

In `test/integration/`, exercising cross-module scoring flows:

- **Seed-to-report flow:** Seed 5 related segments, trigger baseline capture on first add, assess, verify all four dimension scores are in [0.0, 1.0], composite reflects geometric mean.
- **Task lifecycle flow:** Set task, assess (scores against task), refine task (relevance invalidated, no grace period), change task (grace period activates), assess during grace (relevance recalculated, grace counter decremented), clear task (all relevance = 1.0).
- **Redundancy detection flow:** Add two identical segments, assess, verify density reflects the duplication (near-zero for duplicated segment), verify origin annotation.
- **Provider switch flow:** Start in trigram mode, add segments, assess. Switch to mock embedding provider, verify all caches invalidated, assess again, verify scores computed from embeddings.
- **Continuity tracking flow:** Add segments, evict one with pre-eviction snapshot, assess, verify continuity reflects the loss. Restore, assess, verify fidelity.
- **Incremental assessment flow:** Assess (cold start), add one segment, assess again, verify only the new segment and its neighbors are recomputed (verify via timing or cache hit counters).

### Property-based tests

Using fast-check via vitest, in `test/property/`:

- **Score bounds:** For any randomly generated segment content and task descriptor, all four dimension scores are in [0.0, 1.0]. Composite is in [0.0, 1.0].
- **Determinism:** Same segment set + same task + same assessmentTimestamp produces identical scores across repeated `assess()` calls.
- **Similarity symmetry:** `similarity(a, b) === similarity(b, a)` for any two content strings, in both modes.
- **Composite collapse:** For any four dimension scores where at least one is 0, the composite is 0.
- **Protection floors:** For any base relevance and any content, pinned segments score 1.0 and seed segments score >= 0.3.
- **Baseline normalization idempotency:** `normalize(baseline, baseline) === {coherence: 1.0, density: 1.0, relevance: 1.0, continuity: 1.0}`.

---

## 6. Exit Criteria

All of the following must be true to complete Phase 2:

- All 10 modules (`similarity`, `embedding`, `task`, `scoring/coherence`, `scoring/density`, `scoring/relevance`, `scoring/continuity`, `scoring/baseline`, `scoring/composite`, `quality-report`) are implemented and exported.
- All unit tests pass with 100% of the invariants from cl-spec-002 (SS10), cl-spec-004 (SS8), and cl-spec-005 (SS8) covered.
- All integration tests pass for the six cross-module flows listed above.
- All property-based tests pass for the six invariant properties listed above.
- `assess()` completes in < 50ms at n = 500 with warm caches (excluding provider calls), validated by benchmark.
- Cold-start `assess()` completes in < 500ms at n = 500 with sampling enabled, validated by benchmark.
- Sampling activates at n > 200 and uses deterministic FNV-1a seed.
- Similarity mode consistency holds: no report mixes embedding and trigram similarity computations.
- `assessmentTimestamp` is captured once per `assess()` and used in all recency/age formulas (no other `Date.now()` calls during scoring).
- Protection relevance uses post-hoc clamp/floor per R-008 (pinned = 1.0, seed floor = 0.3).
- No circular imports between Phase 2 modules. `scoring/*` modules do not import each other.
- No upward imports from Phase 1 modules into Phase 2.
- Phase 1 modules (`segment-store`, `tokenizer`, `events`, `utils/*`, `types`, `errors`) are not modified except for adding hooks or accessors required by Phase 2 consumers.
- The `quality-report` module produces the full `QualityReport` structure as defined in cl-spec-002 SS9.1, ready for consumption by Phase 3 (detection, eviction advisory).
