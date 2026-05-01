---
id: cl-spec-009
title: Performance Budget
type: design
status: draft (amended)
created: 2026-04-04
revised: 2026-05-01
authors: [Akil Abderrahim, Claude Opus 4.6, Claude Opus 4.7]
tags: [performance, budget, latency, complexity, scaling, memory, sampling, measurement, manual-release]
depends_on: [cl-spec-005, cl-spec-006, cl-spec-007]
---

# Performance Budget

## Table of Contents

1. Overview
2. Budget Framework
3. Operation Budgets
4. Computational Complexity
5. Scaling Strategies
6. Memory Budget
7. Provider Latency Separation
8. Measurement and Reporting
9. Invariants and Constraints
10. References

---

## 1. Overview

context-lens is a monitoring library. It observes a context window and reports on its quality — it does not build the window, send it to an LLM, or process the response. The caller adds context-lens to their pipeline for visibility, not functionality. This means context-lens has a performance obligation that most libraries do not: **the overhead of measurement must be negligible relative to the thing being measured.**

An LLM call with a 128K-token context window takes seconds. A tool call that gathers context takes tens to hundreds of milliseconds. If context-lens adds 500ms to every operation in that pipeline, it is consuming a visible fraction of the caller's latency budget — for instrumentation, not capability. If it adds 5ms, it vanishes. The difference between a useful monitoring library and a liability is not correctness or features — it is whether the caller can afford to leave it on.

This spec defines what context-lens can afford to cost. It sets latency targets for every public operation, identifies the computational bottlenecks that threaten those targets, defines the scaling strategies that keep computation within budget at large window sizes, and establishes the memory model that bounds resource consumption. It also defines the measurement infrastructure that makes performance visible — because a budget without measurement is a wish, not a constraint.

### Resolution of OQ-007

OQ-007 asked: "Performance budget per operation — <50ms? <200ms?"

The answer is: **there is no single number.** Operations have fundamentally different computational profiles — a hash table lookup and a pairwise similarity matrix do not share a budget. This spec defines five budget tiers, from <1ms for constant-time queries to proportional-to-batch-size for rare bulk operations. The headline numbers for the most performance-sensitive operations, at the reference window size of 500 segments:

| Operation class | Budget (excluding provider latency) |
|----------------|--------------------------------------|
| Queries (getCapacity, getSegment, ...) | < 1 ms |
| Hot-path mutations (add, evict, ...) | < 5 ms |
| Assessment (assess) | < 50 ms |
| Eviction planning (planEviction) | < 100 ms |

These are context-lens computation budgets — they exclude time spent inside the caller's tokenizer or embedding provider. Provider latency is the caller's choice and responsibility (section 7).

### Design goals

- **Invisible on the hot path.** The operations that callers invoke most frequently — `add`, `evict`, `getCapacity`, `assess` — must be fast enough that removing context-lens from the pipeline produces no perceptible speedup. The caller should never think "this would be faster without context-lens."
- **Predictable scaling.** Doubling the number of segments should not quadruple the latency of common operations. Where quadratic computation is unavoidable (pairwise similarity), sampling strategies (section 5) cap the growth. The caller can predict context-lens overhead from their segment count.
- **Bounded memory.** context-lens does not grow unboundedly in long-running sessions. All caches are LRU-bounded, all histories are ring-buffered or capped, and memory overhead scales linearly with configuration parameters the caller controls.
- **Measurable.** Every public operation records its own latency. Diagnostics (cl-spec-010) surface per-operation timing, cache hit rates, and budget violations. The caller can verify that context-lens is within budget, not just trust that it is.
- **Advisory, not enforced.** Budget targets are design commitments, not runtime enforcement. No operation is aborted for exceeding its budget. This matches context-lens's philosophy of soft constraints — it reports and advises, it does not enforce (cl-spec-001 invariant 14, soft capacity; cl-spec-003, diagnostic not prescriptive patterns).

### 1.1 Runtime Compatibility

The core library (`context-lens`) targets any single-threaded JavaScript runtime that exposes `TextEncoder` from the platform standard library. This includes Node.js (≥18), Deno, Bun, modern browsers (Chromium, Firefox, Safari at recent stable channels), and edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy). The library imports nothing from `node:` schemes, uses no Buffer or other Node-specific APIs, and assumes nothing about the file system, network, or process model. Concurrency expectations are captured by cl-spec-007 §12 — single-threaded, sequential per instance — which all listed runtimes satisfy by their event-loop architecture. The OTel exporter (`context-lens/otel`, cl-spec-013) is the only runtime-restricted entry point: it depends on `@opentelemetry/api` (peer dependency) and the OTel SDK adapters callers wire to it, both of which are Node-leaning ecosystems in practice. Browser and edge callers who want observability should consume the metrics surface directly (gauges and counters via `getDiagnostics()`, cl-spec-010) rather than the OTel adapter. CI verification across the full runtime matrix is a deferred follow-up — this spec declares the compatibility intent; matrix-level test coverage will land alongside or after v0.2.0 release.

---

## 2. Budget Framework

### 2.1 Scope: What Is Budgeted

The performance budget covers **context-lens's own computation** — the work performed inside context-lens code between when a public method is called and when it returns, excluding time spent inside caller-provided providers.

**In scope:**

- Hash computation, cache lookups, cache writes
- Segment storage operations (insert, remove, update, lookup)
- Quality score computation (similarity aggregation, dimension scoring, window-level means)
- Pattern detection (threshold comparisons, hysteresis, compound pattern evaluation)
- Eviction scoring (five-signal weighted score, tier partitioning, sorting, bridge scores)
- Report assembly (per-segment scores, group scores, trends, capacity summary)
- Aggregate maintenance (token totals, utilization, group aggregates)
- Event dispatch overhead (iterating listener list, not listener execution time)
- Defensive copying of inputs and outputs

**Out of scope:**

- Tokenizer provider calls (`count`, `countBatch`) — see section 7
- Embedding provider calls (`embed`, `embedBatch`) — see section 7
- Custom pattern `detect`, `severity`, `explanation`, and `remediation` function execution (caller-provided code, measured separately as `customPatternTime`)
- Event listener execution time — the caller controls handler complexity
- Garbage collection pauses — runtime-dependent, not controllable by library code
- I/O, if any (context-lens performs no I/O, but providers may)

The split is practical: context-lens controls its own algorithms and data structures. It does not control the provider the caller plugs in. A caller who configures a remote embedding API that takes 200ms per call will see 200ms added to every `add` — but that is the cost of their provider choice, not a context-lens performance failure.

### 2.2 Reference Window Sizes

Budget targets are defined against three reference window sizes that span the range of typical context-lens deployments.

| Size class | Segment count (n) | Typical scenario |
|------------|-------------------|------------------|
| **Small** | n ≤ 100 | Short conversations, focused tool use, small models (4K–32K tokens) |
| **Medium** | n ≤ 500 | Production assistants, multi-turn conversations, mid-size models (64K–200K tokens) |
| **Large** | n ≤ 2,000 | Long sessions, large context windows (200K–1M+ tokens), document-heavy workflows |

Segment count, not token count, drives context-lens performance. A 200K-token window with 50 large document segments is cheaper to monitor than a 32K-token window with 500 small message segments. Token counting and embedding scale with content length (provider cost), but quality scoring, pattern detection, and eviction planning scale with segment count (context-lens cost).

The **medium** tier (n ≤ 500) is the primary budget target. It represents the most common production scenario — multi-turn conversations with tool use, where segments average 200–1,000 tokens. Budget targets at this tier are the numbers that matter most. Small windows are comfortably within budget by construction. Large windows require the scaling strategies defined in section 5.

### 2.3 Budget Tiers

Operations are grouped into five tiers based on their computational profile and expected call frequency.

| Tier | Budget at n ≤ 500 | Computational class | Frequency |
|------|-------------------|--------------------|-----------| 
| **1: Queries** | < 1 ms | O(1) lookups and cached aggregates | Very high (10–50 per session) |
| **2: Hot-path mutations** | < 5 ms | O(1) to O(n) bookkeeping, excluding provider calls | High (10–50 per session) |
| **3: Assessment** | < 50 ms | O(n) incremental scoring with warm caches | Medium (5–20 per session) |
| **4: Planning** | < 100 ms | O(n log n) sorting + O(n) bridge scores | Medium (2–10 per session) |
| **5: Batch/rare** | Proportional | O(k) or O(n) depending on operation, excluding provider calls | Low (0–3 per session) |

A sixth category — **cold-start assessment** — applies to the first `assess()` call after seeding or bulk insertion, when no cached scores exist. Cold-start budget is < 500 ms at n ≤ 500 with sampling enabled (section 5). Without sampling, cold-start assessment is unbudgeted for n > 200 — the full O(n^2) computation runs to completion.

### 2.4 Platform Assumptions

Budget targets assume execution on a modern JavaScript runtime (Node.js 20+, Deno, Bun, or current browser engines) on typical developer hardware (2020+ laptop, 4+ cores, 8+ GB RAM). context-lens is single-threaded — it does not use worker threads, shared memory, or parallel execution internally. All computation happens on the calling thread.

Budget numbers are order-of-magnitude commitments, not benchmark guarantees. A 5ms budget means "single-digit milliseconds under normal conditions," not "fails if it hits 6ms on a cold Tuesday." The invariants (section 9) formalize what is guaranteed versus what is targeted.

---

## 3. Operation Budgets

This section defines the budget target for every public API operation (cl-spec-007). Each entry specifies the tier, the target latency at n ≤ 500, and what is included in or excluded from the measurement.

### 3.1 Tier 1: Constant-Time Queries

These operations return pre-computed values or perform hash table lookups. They do not compute, score, or iterate.

| Operation | Budget | What it does |
|-----------|--------|-------------|
| `getCapacity()` | < 1 ms | Returns cached capacity report (aggregates maintained incrementally, cl-spec-006 section 4.4) |
| `getSegment(id)` | < 1 ms | Hash table lookup by segment ID |
| `getSegmentCount()` | < 1 ms | Returns maintained counter |
| `getBaseline()` | < 1 ms | Returns stored baseline snapshot |
| `getTask()` | < 1 ms | Returns defensive copy of stored task descriptor |
| `getTaskState()` | < 1 ms | Returns task lifecycle state |
| `getGroup(groupId)` | < 1 ms | Hash table lookup by group ID |
| `getDiagnostics()` | < 1 ms | Assembly from pre-computed state |
| `getTokenizerInfo()` | < 1 ms | Metadata read |
| `getEmbeddingProviderInfo()` | < 1 ms | Metadata read |
| `toJSON()` | < 1 ms | Pure function on single object |

These operations are always within budget regardless of window size. Their cost is dominated by defensive copying (cl-spec-007 invariant 4), which is O(1) for fixed-size structures. `getSegment` returns a single segment — the copy cost is constant, not proportional to window size.

### 3.2 Tier 2: Hot-Path Mutations

These operations modify the segment collection and update derived state. They are on the hot path — callers invoke them frequently during normal operation. Budget **excludes** tokenizer and embedding provider calls (section 7).

| Operation | Budget at n ≤ 500 | context-lens work |
|-----------|-------------------|-------------------|
| `add(segment)` | < 5 ms | Validate input, generate ID (hash), insert into collection, update token aggregates, invalidate affected quality scores, dispatch event |
| `update(id, changes)` | < 5 ms | Validate, apply changes, update aggregates if content changed, invalidate scores, dispatch event |
| `replace(id, content)` | < 5 ms | Validate, swap content, update aggregates, invalidate scores, dispatch event |
| `compact(id, summary)` | < 5 ms | Validate (summary shorter), swap content, record continuity ledger entry, update aggregates, invalidate scores, dispatch event |
| `evict(id)` | < 5 ms | Record pre-eviction snapshot for continuity, transition state, update aggregates, dispatch event. Group eviction: O(m) where m = group size, still < 5 ms for typical groups (m < 20) |
| `restore(id)` | < 5 ms | Validate evicted state, reinsert at position, update aggregates, record restoration fidelity, invalidate scores, dispatch event |
| `registerPattern(pattern)` | < 5 ms | Validation + append |

**What makes these fast:** Each mutation touches one segment (or one group), updates O(1) aggregates incrementally (cl-spec-006 section 4.4), and sets invalidation flags on cached scores rather than recomputing them. The expensive work — recomputing quality scores — is deferred to the next `assess()` call. This is the lazy invalidation strategy (cl-spec-002 invariant 10): mutations are cheap because they only mark state dirty; assessment pays the recomputation cost.

**Why 5ms, not 1ms:** Defensive copying, validation, and event dispatch have fixed overhead. A segment with 10 tags, a long origin string, and group membership requires copying and validating non-trivial structures. 5ms accommodates this overhead with margin. In practice, most mutations complete in < 2ms.

### 3.3 Tier 3: Incremental Assessment

`assess()` is the central quality operation — it produces the quality report that drives all downstream decisions (pattern detection, eviction planning, diagnostics). It is the most computationally intensive operation callers invoke regularly.

| Scenario | Budget at n ≤ 500 | Condition |
|----------|-------------------|-----------|
| **No changes since last report** | < 1 ms | Cached report returned (Tier 1) |
| **k segments changed, k << n, similarity cache warm** | < 50 ms | Incremental recomputation of invalidated scores; unchanged pairs hit the cache (cl-spec-016) |
| **Cold start (no cached scores) at n ≤ 200** | < 50 ms | Full computation, no sampling |
| **Cold start at n > 200** | < 200 ms | Full computation with sampling per cl-spec-016 §3 |
| **Cache disabled (similarityCacheSize = 0)** | < 500 ms | Full re-computation per assess; cl-spec-016 §6 documents the latency tradeoff |

**Incremental assessment** is the common case. Between two `assess()` calls, the caller typically adds 1–5 segments, evicts a few, or updates a task. The incremental path recomputes scores only for invalidated segments and re-aggregates window-level scores from the mix of cached and fresh per-segment scores.

**What happens in an incremental assess:**

1. **Per-segment scoring** for invalidated segments (O(k) segments, each requiring O(n) similarity lookups for density):
   - Coherence: recompute adjacency similarity for changed segments and their neighbors. O(k) similarity lookups against the cached similarity matrix.
   - Density: for each changed segment, find max redundancy against all non-adjacent segments. O(k * n) similarity lookups in the worst case, but most pairs are cached from previous reports.
   - Relevance: recompute task similarity for changed segments. O(k) lookups.
   - Continuity: read from ledger. O(1) per segment.

2. **Topical concentration** (coherence sub-score): recomputed if any segment changed. O(n^2) in theory, but the similarity matrix is largely cached — only new or changed segments produce cache misses. At n ≤ 200, full recomputation on cached similarities. At n > 200, sampled (section 5).

3. **Window-level aggregation**: token-weighted means across all segments. O(n).

4. **Pattern detection**: threshold comparisons against window-level scores. O(1) per pattern, O(n) for secondary diagnostics (cl-spec-003 invariant 10).

5. **Report assembly**: build segment score list, compute trends against previous report. O(n).

**Why 50ms is sufficient:** At n = 500 with k = 5 changed segments and warm similarity caches, the dominant costs are aggregation (O(n) = 500 iterations) and topical concentration (sampled at n > 200, or full-matrix on cached values at n ≤ 200). Each similarity lookup from cache is O(1) — a hash table read. 500 cached lookups + 500 weighted-mean iterations + report assembly: comfortably under 50ms on any modern runtime.

### 3.4 Tier 4: Eviction Planning

`planEviction()` computes a ranked list of eviction candidates with quality impact estimates (cl-spec-008).

| Scenario | Budget at n ≤ 500 |
|----------|-------------------|
| **Standard planning** | < 100 ms |

**What happens in planEviction:**

1. **Quality report**: reuse cached report if available; otherwise, `assess()` runs first (adding its own budget to the total).

2. **Candidate filtering**: exclude pinned segments. O(n) scan.

3. **Tier partitioning**: group candidates by protection tier. O(n).

4. **Eviction score computation**: five-signal weighted score for each candidate (cl-spec-008 section 2). Four signals (relevance, information loss, importance, age) read from cached per-segment scores — O(1) each. The fifth signal (coherence contribution / bridge score) requires a skip-similarity computation: `similarity(i-1, i+1)` for each interior segment. O(n) similarity lookups total, most from cache.

5. **Sorting**: within each tier, sort by eviction score. O(n log n).

6. **Candidate selection and impact estimation**: walk sorted candidates up to the reclamation target. O(c) where c = number of candidates selected (bounded by `maxCandidates`, default 50).

**Why 100ms:** The sort is O(n log n) — at n = 500, that is ~4,500 comparisons, negligible. The bridge score computation is O(n) similarity lookups from cache, also negligible. The 100ms budget provides margin for group-level aggregation (cl-spec-008, token-weighted member scores), compaction alternative generation, and impact estimation across c candidates. In practice, planning at n = 500 completes in 20–40ms.

### 3.5 Tier 5: Batch and Rare Operations

These operations are invoked infrequently — typically once per session or in response to exceptional events. Their budgets are proportional to the work requested, not fixed.

| Operation | Budget (excluding provider) | Notes |
|-----------|----------------------------|-------|
| `seed(segments[])` | < 1 ms per segment | context-lens overhead only: ID generation, validation, collection insertion, aggregate updates. Provider cost (token counting + embedding) is additional. |
| `split(id, splitFn)` | < 5 ms + 1 ms per child | Overhead for child creation, aggregate updates. Provider cost for child token counts + embeddings is additional. |
| `setTask(descriptor)` | < 5 ms + O(n) invalidation | Validation, normalization, comparison, transition recording. Relevance score invalidation: O(n) flag-setting, not recomputation. Provider cost for task embedding is additional. |
| `clearTask()` | < 1 ms | State transition, flag-setting. |
| `createGroup(id, segmentIds)` | < 5 ms | Validate members, compute aggregate properties. O(m) where m = member count. |
| `dissolveGroup(id)` | < 5 ms | Remove memberships. O(m). |
| `listSegments(filter)` | < 5 ms at n ≤ 500 | O(n) scan with filter evaluation. |
| `listGroups()` | < 1 ms | O(g) where g = group count, typically small. |
| `getEvictionHistory()` | < 5 ms | O(h) where h = eviction count, bounded by session length. |
| `setCapacity(n)` | < 1 ms | Update denominator, recompute utilization. O(1). |
| `snapshot()` | O(n) | Proportional to segment count |
| `fromSnapshot(data)` | O(n) | Proportional to segment count, plus potential provider recount |
| `validate(report)` | Proportional | Proportional to output size |

**Provider-dominated operations:**

| Operation | context-lens overhead | Total time |
|-----------|----------------------|------------|
| `setTokenizer(provider)` | < 1 ms per segment (cache clear + aggregate rebuild) | Overhead + provider.count() × n |
| `setEmbeddingProvider(provider)` | < 1 ms per segment (cache clear + similarity invalidation) | Overhead + provider.embed() × n |

Provider switching (cl-spec-005 section 6, cl-spec-006 section 6.3) is a full recount or re-embedding of all active segments. The context-lens overhead — clearing caches, rebuilding aggregates — is O(n) and fast. The total time is dominated by the provider: n calls to `count` or `embed`. For a remote embedding provider at 50ms per call and n = 500, that is 25 seconds (or ~1 second with batching). context-lens cannot budget this — it is the provider's cost. Section 7 addresses this in detail.

---

## 4. Computational Complexity

### 4.1 Operation Complexity Table

This table gives the formal complexity of every public operation. Complexity is stated in terms of n (active segment count), k (number of changed segments since last report), m (group size), and c (selected eviction candidates). **Provider calls are excluded** — they are O(1) per call from context-lens's perspective, but each call may have arbitrary latency.

| Operation | Best case | Typical | Worst case | Dominates |
|-----------|-----------|---------|------------|-----------|
| `getCapacity` | O(1) | O(1) | O(1) | Aggregate lookup |
| `getSegment` | O(1) | O(1) | O(1) | Hash lookup + copy |
| `getSegmentCount` | O(1) | O(1) | O(1) | Counter read |
| `getBaseline` | O(1) | O(1) | O(1) | Copy |
| `getTask` | O(1) | O(1) | O(1) | Copy |
| `getTaskState` | O(1) | O(1) | O(1) | State read |
| `getGroup` | O(1) | O(1) | O(1) | Hash lookup + copy |
| `listGroups` | O(g) | O(g) | O(g) | Iteration + copy |
| `add` | O(1) | O(1) | O(1) | Insert + aggregates |
| `update` | O(1) | O(1) | O(m) | Copy + aggregates; group aggregates if grouped |
| `replace` | O(1) | O(1) | O(1) | Swap + aggregates |
| `compact` | O(1) | O(1) | O(1) | Swap + ledger + aggregates |
| `evict` | O(1) | O(1) | O(m) | Snapshot + state change; O(m) for group |
| `restore` | O(1) | O(1) | O(n) | Reinsert at position (worst: list scan) |
| `split` | O(m) | O(m) | O(m) | m = child count |
| `seed` | O(k) | O(k) | O(k) | k = batch size |
| `setTask` | O(1) | O(n) | O(n) | Invalidation of n relevance scores |
| `clearTask` | O(1) | O(1) | O(1) | State change + flag |
| `createGroup` | O(m) | O(m) | O(m) | Member validation + aggregates |
| `dissolveGroup` | O(m) | O(m) | O(m) | Membership removal |
| `listSegments` | O(n) | O(n) | O(n) | Filter scan |
| `getEvictionHistory` | O(h) | O(h) | O(h) | h = eviction count |
| `setCapacity` | O(1) | O(1) | O(1) | Recompute utilization |
| `setTokenizer` | O(n) | O(n) | O(n) | Cache clear + aggregate rebuild |
| `setEmbeddingProvider` | O(n) | O(n) | O(n) | Cache clear + similarity invalidation |
| `assess` (cached) | O(1) | O(1) | O(1) | Return cached report |
| `assess` (incremental) | O(n) | O(k * n) | O(n^2) | Score recomputation + aggregation |
| `assess` (cold start) | O(n^2) | O(n^1.5) | O(n^2) | Full similarity matrix; O(n^1.5) with sampling |
| `planEviction` | O(n) | O(n log n) | O(n log n) | Sort + bridge scores |

### 4.2 The Quadratic Bottleneck

Two components of quality scoring have O(n^2) theoretical complexity:

**Topical concentration (coherence, cl-spec-002 section 3.4).** Requires a similarity matrix for single-linkage clustering. The full matrix has n * (n - 1) / 2 unique pairs. At n = 500: 124,750 pairs.

**Density redundancy (cl-spec-002 section 4).** For each segment, finds the maximum similarity to any non-adjacent segment. In the worst case, this is n comparisons per segment: n * (n - 2) total. At n = 500: 249,000 comparisons.

Together, a cold-start assessment at n = 500 requires ~374,000 similarity computations. Each computation is a cache lookup (O(1) if cached) or a vector dot product / trigram intersection (microseconds if not cached). The raw computation time:

| Similarity mode | Cost per comparison | 374K comparisons | Within budget? |
|----------------|--------------------|-----------------:|:---:|
| Cosine (embeddings, 1536-dim) | ~1 μs | ~374 ms | Borderline |
| Cosine (embeddings, 384-dim) | ~0.3 μs | ~112 ms | Yes |
| Jaccard (trigrams, ~300-element sets) | ~5 μs | ~1.9 s | No |

At n = 500 with high-dimensional embeddings or trigram fallback, cold-start assessment exceeds the 500ms budget without sampling. This is why sampling (section 5) activates at n > 200 — it keeps cold-start computation within budget across all similarity modes.

### 4.3 Amortized Complexity

The cold-start O(n^2) is the ceiling, not the floor. In steady-state operation, three mechanisms keep actual computation far below the theoretical worst case:

**Similarity cache.** Once a similarity pair is computed, it is cached in the similarity cache (cl-spec-002 section 3.2) keyed on `(hash_a, hash_b, mode)`. Subsequent reports read cached values at O(1) per pair. The cache absorbs the O(n^2) cost of the first report and amortizes it across all subsequent reports where those segments are unchanged.

**Lazy invalidation.** Only segments whose content, metadata, or relevance inputs have changed since the last report are re-scored (cl-spec-002 invariant 10). Between reports, a typical session changes k = 1–5 segments. Incremental recomputation: O(k * n) similarity lookups for the changed segments' density scores, nearly all of which hit the similarity cache. Effective cost: O(n) for aggregation, O(k) for per-segment recomputation against cached values.

**Incremental aggregates.** Window-level scores (weighted means) and capacity aggregates are maintained incrementally (cl-spec-006 section 4.4). A single `add` updates `totalActiveTokens` by adding the new segment's count — O(1), not O(n). The aggregation pass in `assess()` does sweep all segments, but it reads pre-computed per-segment scores, not raw data.

**Amortized cost model for a typical session:**

| Phase | Operations | Dominant cost |
|-------|-----------|---------------|
| Seed (once) | `seed(20 segments)` | 20 provider calls (token + embed). context-lens: O(20). |
| Baseline capture (once) | First `assess()` after seed | O(20^2) = 400 similarity pairs. Sub-millisecond. |
| Steady state (repeated) | `add` → `assess` → `planEviction` → `evict` | Per cycle: O(1) add + O(n) assess (1 changed segment, cached similarities) + O(n log n) plan. At n = 200: < 30ms total for context-lens computation. |
| Task change (occasional) | `setTask` → `assess` | O(n) relevance invalidation + O(n) relevance recomputation. Similarities cached, only relevance scores recomputed. At n = 200: < 20ms. |
| Growth to large window | As n grows, assess transitions from full to sampled | At n = 500, sampling activates for topical concentration. Incremental assess stays < 50ms. |

The session profile shows that context-lens computation is dominated by incremental operations on warm caches. The expensive cold-start computation happens once — at baseline capture — and is small because the window typically starts with few segments. By the time the window grows large enough for O(n^2) to matter, the similarity cache is warm and incremental assessment is the norm.

---

## 5. Scaling Strategies

The quality model (cl-spec-002) defers to this spec for the scaling strategies that keep assessment within budget at large window sizes. Specifically, cl-spec-002 section 3.4 (topical concentration) references this spec for the sampling algorithm applied to windows with more than 200 segments. This section defines those strategies.

### 5.1 Sampling Threshold

Sampling activates when the **active segment count exceeds 200**. Below this threshold, full O(n^2) computation is performed — at n = 200, the full similarity matrix has 19,900 pairs, which completes within the 500ms cold-start budget even with trigram similarity (~100ms) and well within the 50ms incremental budget with cached values.

The threshold is an internal parameter, not caller-configurable. Exposing it would require the caller to understand the complexity model — a leaky abstraction. context-lens decides when to sample based on its own budget constraints. The caller observes only the resulting scores, which are within the accuracy bounds described in section 5.5.

The sampling seed is computed as FNV-1a hash of the concatenated sorted segment IDs (joined by null byte separator). This ensures deterministic sampling across calls within the same implementation: the same set of segments produces the same sample, regardless of insertion order or wall-clock time.

### 5.2 Topical Concentration Sampling

Topical concentration (cl-spec-002 section 3.4) measures how tightly the window's content clusters into topics. The full algorithm builds an n * n similarity matrix, applies single-linkage clustering with threshold tau_cluster = 0.4, counts the resulting clusters c, and computes:

```
topicalConcentration = 1 - (c - 1) / max(1, floor(n / 4))
```

At n > 200, sampling replaces the full matrix with a representative subset:

**Algorithm:**

```
1. Compute sample size: s = min(ceil(sqrt(n) * 3), n)
   - At n = 225: s = 45
   - At n = 500: s = 68
   - At n = 2000: s = 135

2. Draw s segments uniformly at random from the active segment set.
   If groups exist, use stratified sampling: for each group with m members,
   include ceil(m * s / n) members chosen at random. This ensures groups
   are represented proportionally, preventing large groups from being
   over- or under-sampled.

3. Build the s * s similarity matrix using the same similarity function
   (embeddings or trigrams) used for all other scoring. Cache all computed
   similarities — they are reusable by density scoring and future reports.

4. Apply single-linkage clustering with the same threshold (tau_cluster = 0.4)
   to the sample matrix.

5. Count sample clusters c_s.

6. Compute topical concentration from the sample:
   topicalConcentration = 1 - (c_s - 1) / max(1, floor(s / 4))
```

**Why sqrt(n) * 3:** The sample size scales as O(sqrt(n)), which keeps the similarity matrix at O(n) pairs — s^2 = 9n. This caps the quadratic component. The multiplier 3 provides enough statistical mass to detect clusters reliably: at n = 500, 68 samples drawn uniformly will, with high probability, include at least one representative from every cluster containing more than ~3% of segments. Smaller clusters may be missed, but they contribute minimally to the concentration score.

**Computation cost at n = 500:** s = 68. Matrix: 68 * 67 / 2 = 2,278 pairs. At 5 μs per trigram comparison (worst case): ~11ms. At 1 μs per embedding comparison: ~2ms. Well within the 50ms assessment budget.

**Computation cost at n = 2,000:** s = 135. Matrix: 135 * 134 / 2 = 9,045 pairs. At 5 μs each: ~45ms. Within budget.

### 5.3 Density Sampling

Density scoring (cl-spec-002 section 4) computes per-segment redundancy: for each segment, the maximum similarity to any non-adjacent segment. The full computation is O(n) comparisons per segment, O(n^2) total.

At n > 200, density uses **cached-first sampling:**

**Algorithm:**

```
For each segment i:

1. Collect all cached similarity values between segment i and
   non-adjacent segments. These are available from previous reports
   and from the topical concentration matrix (section 5.2).

2. If cached pairs cover all non-adjacent segments:
   redundancy(i) = max(cached similarities). Done — no sampling needed.

3. If uncached non-adjacent segments remain:
   Sample min(30, remaining count) segments from the uncached set.
   Compute similarities and cache them.

4. redundancy(i) = max(all similarities — cached and newly computed).
```

**Why cached-first:** In steady-state operation, most similarity pairs are already cached from previous reports and from the topical concentration sampling pass. Cached-first sampling avoids redundant computation. After several reports, the cache covers most of the similarity matrix, and sampling degenerates to pure cache reads — O(1) per pair, O(n) per segment.

**Why 30 samples per segment:** This bounds the per-segment uncached computation at 30 comparisons regardless of n. At n = 2,000, a cold-start density pass with no cache would compute 2,000 * 30 = 60,000 comparisons — versus 2,000 * 1,998 = ~4 million for the full scan. The 30-sample bound keeps the worst-case cold-start cost at O(30n) = O(n), linear in segment count.

**Accuracy trade-off:** Sampling 30 non-adjacent segments may miss the true maximum — the most redundant pair for a given segment might not be sampled. The expected quality of the approximation depends on the redundancy distribution:

- **Highly redundant windows** (many near-duplicates): redundancy is concentrated. Even 30 samples reliably find a highly-similar pair because near-duplicates are common in the candidate set. The approximate max is close to the true max.
- **Low-redundancy windows** (diverse content): the true max is low (< 0.3). Missing it by a small amount has minimal impact on the density score because density = 1 - redundancy, and both the true and approximate values are near 1.0.
- **Edge case — one hidden duplicate pair:** If exactly one segment is a near-duplicate of segment i and all others are unrelated, the probability of including it in 30 samples from n - 2 candidates is 30 / (n - 2). At n = 500: ~6%. The duplicate would be missed in ~94% of cold starts. However, the similarity between these segments will be computed and cached if either appears in the topical concentration sample (section 5.2), which has higher coverage. Over subsequent reports, the cache fills in, and the true max is discovered.

**Convergence:** After k reports with 30 new samples per segment per report, the cache covers approximately min(30k, n) non-adjacent pairs per segment. At k = 10 reports: 300 cached pairs per segment, covering 60% of the candidate set at n = 500. The approximate max converges toward the true max with each report. Density scoring accuracy improves over the session lifetime as the similarity cache warms.

### 5.4 Incremental Computation

Sampling is the strategy for cold starts. Incremental computation is the strategy for steady state.

**What is incremental:** Only segments whose scores have been invalidated since the last report are recomputed. The invalidation triggers (cl-spec-002 invariant 10):

| Trigger | What is invalidated |
|---------|---------------------|
| Segment content changes (`update`, `replace`, `compact`) | All four dimensions for that segment. Similarity pairs involving that segment's old content hash. Adjacent segments' coherence (adjacency changed). |
| Segment metadata changes (`update` importance, protection, tags) | Relevance score for that segment only. |
| Task change (`setTask` change or refinement) | Relevance scores for all segments. Coherence, density, continuity unaffected. |
| Segment added (`add`) | New segment needs all four scores. Existing segments: only adjacency coherence of the two neighbors is invalidated. |
| Segment removed (`evict`) | Removed segment's scores discarded. Neighbors' adjacency coherence invalidated. |

**What is not recomputed:** Segments whose scores are still valid. In a typical cycle (one `add`, one `evict`), only ~4 segments need re-scoring: the new segment, the evicted segment's two former neighbors, and the new segment's two neighbors (with possible overlap). At k = 4 changed segments and n = 500, incremental assessment does 4 relevance lookups + 4 density scans (cached) + 4 adjacency coherence lookups + O(n) aggregation ≈ O(n). Comfortably within the 50ms budget.

### 5.5 Accuracy Under Sampling

Sampling trades exactness for speed. The trade-off is acceptable because quality scores are already approximate — they are derived from similarity functions (embedding or trigram) that are themselves imprecise measures of semantic relatedness. Adding a small sampling error on top of an inherently approximate signal does not meaningfully change the utility of the result.

**Topical concentration:** The sampled score converges to the full-computation score as sample size increases. At s = ceil(sqrt(n) * 3), major clusters (containing > 3% of segments) are almost certainly represented in the sample. The concentration score may differ from the full computation by ±0.05–0.10 for a single report, but trends (the direction and magnitude of change between reports) are stable because sampling is consistent within a report and the same random seed is used across consecutive reports for a given segment set.

**Density:** The approximate max redundancy underestimates the true max — sampling can miss the most-similar pair, but cannot find a pair more similar than the true max. This means sampled density is an optimistic estimate (density ≥ true density, because redundancy ≤ true redundancy). The bias direction is safe: if context-lens underestimates redundancy, the caller retains slightly more redundant content than optimal, which is a minor inefficiency, not a correctness failure. The alternative — overestimating redundancy — would cause premature eviction of non-redundant content, which is worse.

**Scoring contract preserved:** Sampling changes the computation path, not the scoring contract. Scores remain bounded [0.0, 1.0], deterministic for a given segment set and sampling seed, and computed from the same formulas. The invariants of cl-spec-002 (section 10) hold under sampling. The composite score formula, the baseline normalization, and the pattern detection thresholds operate on the same score types regardless of whether the underlying similarity computation was full or sampled.

---

## 6. Memory Budget

context-lens runs in-memory for the duration of a session. There is no disk I/O, no database, no persistence layer. All state — segments, scores, caches, histories — lives in the JavaScript heap. This section defines how much heap memory context-lens consumes, what drives that consumption, and what bounds it.

### 6.1 Per-Segment Overhead

Each active segment carries fixed overhead beyond the content string itself. context-lens stores metadata, scores, and index entries — not a copy of the content (the caller owns the content; context-lens stores a reference or a caller-provided string).

| Component | Approximate size | Notes |
|-----------|:---:|-------|
| Segment metadata (ID, origin, tags, importance, protection, timestamps) | ~200 bytes | String fields vary; 200 bytes is typical for a segment with an ID, origin, 3 tags, and protection metadata |
| Token count (stored on segment) | 8 bytes | Single number |
| Quality scores (4 dimensions, cached) | 32 bytes | 4 floats |
| Collection index entry (hash map slot) | ~80 bytes | Key (ID string) + value reference + hash map overhead |
| Group membership reference | ~16 bytes | Pointer + group ID reference; null if ungrouped |
| **Total per segment** | **~340 bytes** | Excluding content string and cache entries |

**Content storage:** The segment's content string is the dominant per-segment cost, but it is the caller's content — context-lens stores it, not duplicates it. A 1,000-token segment is roughly 4KB of text. At n = 500: ~2MB of content. This is inherent to the problem (the caller needs context-lens to hold the content for scoring), not a context-lens overhead.

**Evicted segment content retention:** When `retainEvictedContent` is true (the default, cl-spec-007 section 2.2), evicted segments keep their content in memory. This enables restore without the caller re-providing content but increases memory usage. The caller can set `retainEvictedContent: false` to discard content on eviction, trading restore convenience for memory savings. Evicted segment metadata (~200 bytes) is always retained regardless of this setting.

### 6.2 Cache Memory

context-lens maintains three caches, each LRU-bounded with caller-configurable maximum entries.

**Token count cache (cl-spec-006 section 5):**

| Parameter | Default | Memory |
|-----------|---------|--------|
| Entries | 4,096 | ~400 KB |
| Per-entry | ~100 bytes | Hash key (8 bytes) + provider name ref + count (8 bytes) + LRU overhead (~80 bytes) |

The token count cache is small and fixed-cost. Even at maximum capacity, it consumes under 1MB. Tuning this cache has negligible memory impact.

**Embedding cache (cl-spec-005 section 5):**

| Dimensions | Per-entry (Float64) | Per-entry (Float32) | 4,096 entries (F64) | 4,096 entries (F32) |
|-----------:|:---:|:---:|:---:|:---:|
| 384 | 3.1 KB | 1.6 KB | 12.4 MB | 6.4 MB |
| 768 | 6.2 KB | 3.2 KB | 24.8 MB | 12.8 MB |
| 1,536 | 12.4 KB | 6.2 KB | 49.6 MB | 24.8 MB |
| 3,072 | 24.6 KB | 12.4 KB | 98.4 MB | 49.6 MB |

The embedding cache is the largest consumer of memory. At 3,072 dimensions with Float64 storage and 4,096 entries, it approaches 100MB. Callers using high-dimensional embeddings should consider:

- Reducing `embeddingCacheSize` (e.g., to 1,024 entries for ~25MB at 3,072-dim)
- Using Matryoshka dimension reduction (cl-spec-005 section 3.2 — OpenAI's models support 256 or 512 dimensions)
- Using Float32 storage internally (halves memory; precision loss is negligible for cosine similarity)

In trigram mode (no embedding provider), the embedding cache stores trigram sets instead of vectors. A trigram set for a 1,000-character string contains ~998 trigrams. With hash set overhead: ~10–30KB per entry. At 4,096 entries: ~40–120MB. Trigram sets for long content can be larger than embedding vectors — callers processing long documents in trigram mode should be aware of this.

**Similarity cache (cl-spec-002 section 3.2):**

| Parameter | Default | Memory |
|-----------|---------|--------|
| Entries | 16,384 | ~1.3 MB |
| Per-entry | ~80 bytes | Two hash keys (16 bytes) + mode tag (1 byte) + score (8 bytes) + LRU overhead (~55 bytes) |

The similarity cache default of 16,384 entries stores the full pairwise matrix for up to ~180 segments (180 * 179 / 2 = 16,110 pairs). At n > 180, LRU eviction reclaims old pairs. The cache is large enough for the working set of recently-compared segments, which is what matters for incremental assessment. The default size is not caller-configurable in cl-spec-007 — it is an internal parameter. This spec sets the default at 16,384 and documents it for implementation guidance.

### 6.3 Total Memory Model

Total context-lens memory consumption:

```
M_total = M_segments + M_token_cache + M_embedding_cache + M_similarity_cache + M_fixed

where:
  M_segments     = n * 340 bytes  +  Σ content_length(i)  (for active + retained evicted)
  M_token_cache  = min(token_cache_size, n) * 100 bytes
  M_embedding_cache = min(embedding_cache_size, n) * entry_size(dimensions, float_type)
  M_similarity_cache = min(16384, n*(n-1)/2) * 80 bytes
  M_fixed        ≈ 50 KB  (quality baseline, pattern history, continuity ledger, task state, 
                            transition history, report cache, event listener list)
```

### 6.4 Memory Scaling Table

Approximate total memory (excluding content strings) for common configurations:

| Segments | Embedding mode | Dimensions | Embedding cache entries | Total overhead |
|---------:|---------------|:---:|:---:|:---:|
| 100 | None (trigrams) | — | 4,096 | ~15 MB |
| 100 | OpenAI small | 1,536 | 4,096 | ~50 MB |
| 500 | None (trigrams) | — | 4,096 | ~60 MB |
| 500 | OpenAI small | 1,536 | 4,096 | ~52 MB |
| 500 | OpenAI small | 1,536 | 1,024 | ~14 MB |
| 2,000 | None (trigrams) | — | 4,096 | ~80 MB |
| 2,000 | OpenAI small | 1,536 | 4,096 | ~53 MB |
| 2,000 | OpenAI large | 3,072 | 4,096 | ~100 MB |
| 2,000 | Local small | 384 | 4,096 | ~14 MB |

**Key takeaway:** Memory overhead is dominated by the embedding/trigram cache, which is bounded by `embeddingCacheSize` and the embedding dimension. The per-segment overhead (~340 bytes) is negligible even at n = 2,000 (~680KB). Callers who are memory-constrained should tune `embeddingCacheSize` and consider lower-dimensional embeddings — these are the two levers with the highest impact.

Memory is released when the instance is garbage collected. Cache sizes are bounded by construction-time configuration. History buffers are bounded by ring buffer limits (cl-spec-010). For long-lived sessions where the bounded steady state is still too much memory, the API surface adds explicit cache-management primitives (section 6.5 below).

### 6.5 Manual Memory Release (v0.2.0+)

The construction-time cache bounds (sections 6.2, 6.3) cap memory consumption at the LRU steady state. For long-lived sessions — monitoring daemons, multi-agent orchestrators, server processes handling rolling contexts — the bounded steady state may still exceed the deployment's memory budget, or an external signal (memory pressure, idle reclaim, post-snapshot continuation) may demand a fresh start. cl-spec-007 §8.9 adds three primitives for caller-initiated cache management:

| Method | Purpose | Cost |
|--------|---------|------|
| `clearCaches(kind?)` | Empty one or more derived caches | O(c) where c is entries dropped — sub-millisecond at default sizes |
| `setCacheSize(kind, size)` | Resize a cache's maximum-entry capacity at runtime | O(d) where d is entries evicted on shrink — sub-millisecond at default deltas |
| `getMemoryUsage()` | Estimate current cache memory | O(1) — Tier 1 query (<1 ms) |

These methods operate on the three derived caches (token count, embedding, similarity). They do not touch the segment store, baseline, continuity ledger, pattern history, report history, or any other source-of-truth state — clearing those would corrupt scoring (continuity is cumulative; baseline is immutable; history drives trend analysis).

#### 6.5.1 Estimate formula for getMemoryUsage

The `estimatedBytes` field on each `CacheUsage` (cl-spec-007 §8.9.3) is computed from per-entry coefficients keyed on cache kind and active mode. The coefficients are pessimistic against typical V8 / SpiderMonkey / JSC heap layouts, so the estimate trends slightly high on small caches and within ±20% of the true heap cost on large caches:

| Cache | Per-entry estimate | Notes |
|-------|-------------------|-------|
| Token count cache | `entries × 100 bytes` | Hash key + provider name reference + 8-byte count + LRU node overhead. Independent of provider. |
| Embedding cache (embedding mode) | `entries × (dimensions × 8 + 100)` bytes | Float64 vector + key + LRU overhead. Float32 storage is not used (cl-spec-005 stores `number[]`); the coefficient assumes V8's standard double-precision array representation. |
| Embedding cache (trigram mode) | `entries × 8000 bytes` | Average Set<string> size for ~1,000–2,000-character segments × ~5–10 bytes per trigram entry × Set overhead. Highly content-dependent; the estimate is intentionally conservative. |
| Similarity cache | `entries × 80 bytes` | Two hash strings + mode tag + score + LRU overhead. Mode-independent. |

The total is the sum of the three caches' bytes. The formula is intentionally simple — exact accounting requires runtime introspection that JavaScript does not portably provide (`performance.memory` is non-standard and Chromium-only; `process.memoryUsage` is process-wide, not per-instance), and a complex estimate would create the illusion of precision without its substance.

The estimate is an estimate. Callers needing exact memory accounting must measure at the runtime level and accept the per-runtime portability cost.

#### 6.5.2 Rebuild cost after clearCaches

`clearCaches` is fast (O(c) entries dropped); the subsequent `assess()` may be slow because the cleared caches must rebuild from cold:

| Cache cleared | First `assess()` after clear | Steady-state thereafter |
|---------------|-------------------------------|-------------------------|
| `'tokenizer'` only | Same as steady-state — segments retain stored `tokenCount` (cl-spec-006 §4.6); the cache rebuilds opportunistically on the next mutation. | Unchanged. |
| `'similarity'` only | One full pairwise sweep at the relevant n — comparable to a cold-start assessment but with embedding cache still warm (no provider calls). | Returns to steady state once the LRU steady state is reached. |
| `'embedding'` only or `'all'` | Provider-bound — every active segment's content needs re-preparation. With a remote provider and 100 active segments: ~100 cache misses, 1 batch call (or N parallel calls if no batch support), ~100–500 ms typical. With trigrams: pure CPU, < 50 ms typical at n = 100. | Returns to steady state on the second assess. |

`clearCaches('all')` is the canonical post-snapshot or memory-reclaim primitive. Callers performing continuous reclamation (e.g., on a timer) should monitor the rebuild cost and the embedding provider rate-limit budget — clearing too aggressively turns the embedding provider into the bottleneck.

#### 6.5.3 setCacheSize semantics

`setCacheSize(kind, size)` is a configuration change that mutates the cache's maximum-entry bound. It is not a clear: a grow leaves entries unchanged; a shrink evicts the least-recently-used entries until the new bound is satisfied.

`size = 0` is permitted (per cl-spec-007 §8.9.2) and effectively disables the cache: every set is immediately evicted. The use case is short-lived, memory-constrained sessions where the caller accepts the rebuild cost on every operation. Disabling the embedding cache against a remote provider is rarely a good idea (every assessment becomes provider-bound); disabling the similarity cache is reasonable for tight assessment loops where each call mutates content (cache hit rate is near zero anyway).

#### 6.5.4 Long-lived session guidance

For sessions running indefinitely:

1. Set cache bounds at construction to fit the deployment's memory budget. Use the scaling table (section 6.4) plus the per-entry estimates above as planning inputs.
2. Periodically call `getMemoryUsage()` to confirm the steady state is what was budgeted. Provider switches (cl-spec-005 §6, cl-spec-006 §5.2) may temporarily inflate the embedding cache.
3. Use `clearCaches('embedding')` on a long-idle threshold (e.g., 5 minutes of no `assess()` activity) to release the largest cache without losing segment state. Cost: the next `assess()` re-prepares all active segments.
4. Use `clearCaches('all')` after a `snapshot()` if the caller plans to dispose the instance — it lets the snapshot capture state without lingering cache memory holding the disposed-but-not-collected instance alive.
5. `setCacheSize` is for permanent re-tuning, not idle reclamation. If memory pressure is sustained, shrink the bound; if it's transient, prefer `clearCaches`.

The goal is bounded steady-state memory across an unbounded session lifetime. Construction-time bounds set the ceiling; manual release primitives provide the recovery valve.

---

## 7. Provider Latency Separation

A context-lens operation's wall-clock time is the sum of context-lens computation and provider calls:

```
T_total = T_context_lens + T_provider
```

The performance budget (sections 2–3) constrains T_context_lens. This section addresses T_provider — how it is measured, how callers control it, and why context-lens does not budget it.

### 7.1 Why Provider Latency Is Excluded

Provider latency varies by orders of magnitude depending on the caller's choice:

| Provider type | Typical latency per call | Example |
|--------------|:---:|---------|
| Approximate tokenizer (built-in) | < 0.1 ms | Character-class heuristic (cl-spec-006 section 3.1) |
| Local exact tokenizer | 0.1–1 ms | tiktoken via WASM |
| Local embedding model | 5–50 ms | ONNX Runtime, transformers.js |
| Remote embedding API | 50–500 ms | OpenAI, Cohere, Voyage |
| Remote embedding API (batch) | 100–2,000 ms | Same providers, batch endpoint |

A single `add` operation triggers one `count` call and one `embed` call. With the built-in approximate tokenizer and no embedding provider, the provider cost is < 0.1ms — invisible. With a remote embedding API, the provider cost is 50–500ms — dominating the total by 100x. context-lens cannot set a meaningful budget that spans this range. Instead, it measures and reports both components separately (section 8).

### 7.2 Budget Decomposition

Every timed operation records two durations:

| Measurement | What it captures |
|-------------|-----------------|
| `selfTime` | Time spent in context-lens computation — hash operations, cache lookups, score computation, aggregation, report assembly. This is what the performance budget constrains. |
| `providerTime` | Time spent waiting for provider calls — `count`, `countBatch`, `embed`, `embedBatch`. This is the caller's cost, measured for transparency. |
| `customPatternTime` | Time spent executing caller-provided custom pattern functions (`detect`, `severity`, `explanation`, `remediation`). Like `providerTime`, this is caller-provided code and is excluded from budget accountability. The budget tiers apply to `selfTime` only. |

`selfTime + providerTime + customPatternTime ≈ totalTime` (the difference is event dispatch and minor overhead). These measurements are available in the per-operation timing records surfaced by diagnostics (cl-spec-010).

Assessment timing decomposes into `selfTime` (context-lens computation), `providerTime` (tokenizer and embedding calls), and `customPatternTime` (custom pattern function calls). Budget compliance is evaluated against `selfTime` only.

Operations that do not call providers (Tier 1 queries, `evict`, `clearTask`, `setCapacity`) have `providerTime = 0`. Their `selfTime` is the total time.

### 7.3 Caller Guidance

Provider choice is the single largest factor in context-lens latency. Guidance for callers:

| Priority | Recommended configuration | Expected latency profile |
|----------|--------------------------|-------------------------|
| **Minimal latency** | Approximate tokenizer + no embedding provider (trigram mode) | All operations < 50ms at n ≤ 500. No network calls. No external dependencies. |
| **Balanced** | Approximate tokenizer + local embedding model (384-dim) | Mutations: < 55ms (50ms embed + 5ms context-lens). Assessment: < 50ms (cached embeddings). Low memory overhead. |
| **High precision** | Exact tokenizer + remote embedding API (1536-dim) | Mutations: 50–500ms (dominated by embed API call). Assessment: < 50ms (cached). Provider switching: seconds. |
| **Batch-optimized** | Exact tokenizer + remote embedding API with batch support | Seed: one API call per batch. Mutations: same as high precision. Provider switching: faster with batching. |

The choice is the caller's. context-lens works correctly in all configurations — the quality scoring algorithms, pattern detection, and eviction advisory produce valid results regardless of similarity mode (embedding or trigram) or tokenizer accuracy (exact or approximate). The provider choice affects precision and latency, not correctness.

---

## 8. Measurement and Reporting

A performance budget is meaningful only if compliance is measurable. This section defines how context-lens measures its own performance and surfaces the measurements to callers.

### 8.1 Per-Operation Timing

Every public method invocation is timed. context-lens records:

| Field | Type | Description |
|-------|------|-------------|
| `operation` | string | Method name (e.g., `"add"`, `"assess"`, `"planEviction"`) |
| `selfTime` | number | Milliseconds spent in context-lens computation |
| `providerTime` | number | Milliseconds spent in provider calls (tokenizer + embedding) |
| `customPatternTime` | number | Milliseconds spent in caller-provided custom pattern functions |
| `totalTime` | number | Wall-clock milliseconds from method entry to return |
| `segmentCount` | number | Active segment count at operation start |
| `cacheHits` | number | Similarity cache hits during this operation |
| `cacheMisses` | number | Similarity cache misses during this operation |
| `timestamp` | number | High-resolution timestamp (e.g., `performance.now()`) |
| `budgetExceeded` | boolean | True if selfTime exceeded the budget for this operation's tier |
| `budgetTarget` | number or null | Budget target in milliseconds for this operation's tier. Null for untimed operations |

Timing is recorded using the runtime's high-resolution timer (`performance.now()` in browsers, `process.hrtime.bigint()` in Node.js). The timer granularity is sub-millisecond on all target platforms.

**Overhead of timing itself:** Timing adds two `performance.now()` calls per operation (start and end), plus field writes to the timing record. Total overhead: < 0.01ms per operation — negligible relative to any budget tier.

### 8.2 Timing History

context-lens maintains a ring buffer of the most recent timing records — one per public method invocation. The buffer size is fixed at 200 entries. Older entries are overwritten.

Per-operation timing data is surfaced through two mechanisms: (1) the aggregated `PerformanceSummary` available via `getDiagnostics()` (cl-spec-010 section 6), and (2) a `budgetViolation` event (cl-spec-007 section 9.2) emitted when an operation exceeds its budget tier.

The timing history is not persisted. It exists for the session duration. This matches the session-scoped design of all context-lens state.

### 8.3 Budget Violation Reporting

A timing record whose `selfTime` exceeds the budget for its operation and segment count is flagged as a **budget violation**. The violation is:

- Recorded in the timing record (`budgetExceeded: true`, `budgetTarget: number`)
- Emitted as a `budgetViolation` event (cl-spec-007 section 9.2)
- Aggregated in the diagnostics summary (cl-spec-010): count of violations per operation, worst-case selfTime per operation, percentage of operations within budget

**Budget violations are advisory.** They do not throw, do not interrupt the operation, and do not trigger corrective action. They exist to make performance regressions visible — a caller who sees frequent budget violations on `assess()` knows they should investigate (too many segments? slow similarity mode? cache thrashing?).

The budget lookup for violation detection uses the tier thresholds from section 3, scaled to the current segment count. At n > 500, budgets are extrapolated linearly from the n = 500 targets (e.g., the assess budget at n = 1,000 is 2x the n = 500 target = 100ms). This is a rough heuristic, not a precise scaling law — it accounts for the expected linear growth of incremental assessment without pretending to model all edge cases.

### 8.4 Cache Performance Reporting

Cache performance is a leading indicator of assessment latency. High cache hit rates mean fast reports; low hit rates mean cold-start-like latency. Diagnostics (cl-spec-010) surfaces:

| Metric | Source |
|--------|--------|
| Similarity cache hit rate | Hits / (hits + misses) across recent operations |
| Similarity cache utilization | Current entries / max entries |
| Embedding cache hit rate | Same formula, embedding cache |
| Token cache hit rate | Same formula, token cache |

These metrics help callers diagnose performance issues. A similarity cache hit rate below 80% on incremental `assess()` calls suggests cache thrashing — the cache is too small for the working set, or content is changing too rapidly for the cache to stabilize. The remedy is to increase cache sizes, reduce churn, or accept higher latency.

---

## 9. Invariants and Constraints

These invariants are guarantees that the implementation must uphold. They formalize the commitments made throughout this spec.

**1. Budget targets, not hard limits.** Budget numbers (section 3) are design targets — they guide implementation and set caller expectations. They are not enforced at runtime. No operation is aborted, retried, or degraded for exceeding its budget. A budget violation is reported (section 8.3) but has no behavioral consequence.

**2. Provider time excluded.** All budget targets (section 3) measure context-lens computation only (`selfTime`). Time spent inside caller-provided tokenizer and embedding provider methods is excluded from budget compliance evaluation. Provider time is measured and reported (`providerTime`) but never counted against budget targets.

**3. Sampling preserves scoring contracts.** Sampling (section 5) changes the computation path for topical concentration and density at n > 200, but does not change the scoring contracts defined in cl-spec-002. Scores remain bounded [0.0, 1.0], deterministic for a given segment set, and computed using the same formulas. Pattern detection thresholds (cl-spec-003) apply identically to sampled and non-sampled scores. The composite score formula is unchanged.

**4. Sampling is deterministic.** For a given set of active segments (same IDs, same content, same ordering), sampling produces the same sample and the same scores. Sampling uses a seed derived from the segment set, not from wall-clock time or random state. Two `assess()` calls on the same unchanged window produce identical reports, whether or not sampling is active.

**5. Cache correctness over performance.** If a cache would return a stale or incorrect result (e.g., a similarity score for content that has since changed), the cache entry is invalidated rather than served. context-lens never trades correctness for cache performance. A cache miss results in fresh computation, which may exceed the budget — but the result is correct.

**6. No silent degradation.** context-lens does not silently reduce scoring fidelity, skip dimensions, or return partial reports to meet budget targets. If an operation is slow, it is slow and reported as a budget violation. The caller always receives a complete, correct result. The one exception is the sampling strategy (section 5), which is a documented, deterministic approximation — not a silent degradation.

**7. Measurement overhead is negligible.** The timing infrastructure (section 8) adds < 0.01ms per operation. Timing is always active — there is no "disable timing for performance" mode. The measurement cost is below the noise floor of any budget tier.

**8. Incremental computation is correct.** Incremental assessment (section 5.4) produces the same results as full recomputation for unchanged segments. A segment whose inputs (content, metadata, task) have not changed since the last report receives the same scores as in the previous report — not approximately the same, exactly the same. Lazy invalidation (cl-spec-002 invariant 10) guarantees that unchanged segments are never recomputed and never stale.

**9. Memory is bounded.** All caches are LRU-bounded with configurable or fixed maximum sizes. No cache, history, or internal data structure grows without bound. Total memory consumption is a function of configuration parameters (cache sizes, embedding dimensions) and segment count — not session duration or number of operations performed.

**10. Aggregates are O(1).** Token aggregates (`totalActiveTokens`, `utilization`, `pinnedTokens`, `seedTokens`, `availableCapacity`, `headroom`) are maintained incrementally (cl-spec-006 section 4.4). Reading an aggregate is a constant-time operation regardless of segment count. No aggregate is computed by iterating the segment collection at read time.

---

## 10. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-001` (Segment Model) | Defines segment structure, lifecycle operations, and soft capacity enforcement |
| `cl-spec-002` (Quality Model) | Defines quality dimensions, scoring algorithms, similarity computation, topical concentration clustering (defers sampling strategy to this spec), and lazy invalidation |
| `cl-spec-003` (Degradation Patterns) | Defines detection framework and in-budget detection invariant (invariant 10) |
| `cl-spec-004` (Task Identity) | Defines task descriptor model and lifecycle operations budgeted in section 3.5 |
| `cl-spec-005` (Embedding Strategy) | Defines embedding provider interface, caching, batch embedding, and provider switching — all with performance implications budgeted here |
| `cl-spec-006` (Tokenization Strategy) | Defines token counting, caching, batch counting, and incremental aggregate maintenance |
| `cl-spec-007` (API Surface) | Defines all public operations whose performance is budgeted here; constructor configuration including cache sizes |
| `cl-spec-008` (Eviction Advisory) | Defines eviction scoring, bridge scores, and planning algorithm budgeted here |
| `cl-spec-010` (Report & Diagnostics) | Consumes timing records and cache metrics defined in section 8 |
| `cl-spec-016` (Similarity Caching & Sampling) | Defines the incremental similarity cache contract, adaptive sampling at n > 300, and the cache-warm/cache-cold determinism invariant. Refines the Tier 3 budget rows in section 3.3 of this spec; coordinates with the Sampling subsection (section 5) and the Memory Budget (section 6.2). |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.6*
