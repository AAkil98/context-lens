---
id: cl-spec-016
title: Similarity Caching & Sampling
type: design
status: draft
created: 2026-05-02
revised: 2026-05-02
authors: [Akil Abderrahim, Claude Opus 4.7]
tags: [similarity, caching, sampling, performance, scaling, assess-budget, gap-5]
depends_on: [cl-spec-002, cl-spec-005, cl-spec-007, cl-spec-009]
---

# Similarity Caching & Sampling

## Table of Contents

1. Overview
2. Incremental Similarity Cache
3. Adaptive Sampling
4. Cache-Warm vs Cache-Cold Determinism
5. Configuration
6. Performance Targets
7. Invariants and Constraints
8. References

---

## 1. Overview

cl-spec-002 §3.2 defines the similarity function as the computational foundation of three quality dimensions (coherence, density, relevance) and a critical input to the fourth (continuity, indirectly via similarity-driven scoring during the eviction snapshot that precedes ledger writes). Similarity is also the dominant cost of `assess()` — at n = 500 active segments, the cost of pairwise similarity computations dwarfs every other contributor to the assessment budget.

The v0.1.0 implementation hit this in production: `assess()` at n = 500 takes ~340 ms against a 50 ms target (the `assess@500 over budget` known issue tracked in `SEED_CONTEXT.md`). The shortfall is roughly 7× — large enough that no micro-optimization closes it, but small enough that no architectural rewrite is justified. This spec resolves the shortfall through two orthogonal mechanisms: an **incremental similarity cache** that survives mutation cycles (option b of the v0.2.0 backlog), and **adaptive sampling** that tightens the sample density as n grows past a threshold (option a, applied as a fallback above the cache's effective range).

This spec coordinates amendments to cl-spec-002 (sampling subsection), cl-spec-005 (cache configuration cross-references), and cl-spec-009 (budget rows). It is a Gap 5 deliverable from the v0.2.0 hardening backlog (`V0_2_0_BACKLOG.md`), confirmed by user thumbs-up 2026-05-01.

### What this spec does NOT do

- Does not change the similarity function itself. Cosine over embeddings and Jaccard over trigrams are unchanged. The metrics, the formulas, the bounds, and the score interpretations are exactly as cl-spec-002 specifies.
- Does not change quality scoring formulas. Coherence, density, relevance, and continuity all use the same inputs they did in v0.1.0.
- Does not change pattern detection thresholds. cl-spec-003 is unaffected.
- Does not introduce a new cache kind. The pairwise similarity cache from cl-spec-002 §3.2 is the same cache, refined by configuration and invalidation hooks.
- Does not change deterministic-output guarantees. Cache state and sampling state are both deterministic functions of segment content, mode, and fleet timestamp where applicable. Different cache states produce identical outputs (Invariant 4).

### Why two mechanisms

The cache and the sampling work at different scales:

- **The cache** is the primary lever at n ≤ 500. With a sufficiently large cache, the steady-state cost of `assess()` drops because most pairs hit the cache on subsequent calls. A single mutation (e.g., adding one segment) invalidates only the cache entries involving the changed segment; the remaining O(n²) pairs survive. Across many `assess()` calls per session, this amortizes the cost.
- **Sampling** is the fallback above the cache's effective range. The default cache is sized for n ≤ 200 by historical accident (16,384 entries was a flat default). Above the cache's capacity, LRU eviction starts thrashing — pairs evicted between calls must be recomputed. Adaptive sampling reduces the per-call comparison count, keeping the working set within the cache's effective range and bounding the cold-start cost.

The two mechanisms compose. A larger cache helps the warm path. Tighter sampling helps the cold path. Together they bring `assess@500` cache-warm under the 50 ms target while keeping cache-cold within ~2× of the v0.1.0 baseline.

---

## 2. Incremental Similarity Cache

The pairwise similarity cache from cl-spec-002 §3.2 is the foundation. This section refines its sizing, invalidation, and survivability across mutation cycles.

### 2.1 Sizing

The default cache size is computed from the configured `capacity`:

```
defaultSimilarityCacheSize(capacity) =
  clamp(
    ceil(sqrt(capacity / 200) × 16384),
    16384,
    65536,
  )
```

Rationale:

- At `capacity = 8000` (small), `sqrt(40) × 16384 ≈ 103,649` → clamped to 65,536. Generous for tiny windows where memory is a non-issue.
- At `capacity = 32000`, `sqrt(160) × 16384 ≈ 207,000` → clamped to 65,536.
- At `capacity = 128000` (typical), `sqrt(640) × 16384 ≈ 414,000` → clamped to 65,536.
- At `capacity = 200000`, `sqrt(1000) × 16384 ≈ 518,000` → clamped to 65,536.

The clamp at 65,536 prevents pathological memory footprint. At 80 bytes/entry (cl-spec-009 §6.5), 65,536 entries cost ~5.2 MB — small relative to the embedding cache's tens of megabytes.

The minimum at 16,384 preserves the v0.1.0 default for callers who explicitly construct with very small `capacity` (where the formula would otherwise over-shrink the cache).

### 2.2 Invalidation hooks

The existing `SimilarityEngine.invalidateContentHash(hash)` (cl-spec-002 §3.2) handles the per-mutation case: when segment X's content changes (via `update`, `replace`, `compact`, or `split`), every cache entry involving X's content hash is removed. The remaining cache entries — for pairs of unchanged segments — survive.

This spec adds no new invalidation hooks. The existing surface is sufficient. Gap 5's contribution is to ensure the cache is **large enough** that the survived entries actually serve subsequent `assess()` calls, rather than being LRU-evicted before they can be reused.

### 2.3 Cross-mutation survivability

The contract is:

For any segment X that is unchanged (content not modified, position not changed) between `assess()` calls A and B, the similarity score between X and any other unchanged segment Y is computed at most once across A ∪ B. The second `assess()` reads the cached score; the first `assess()` populates it.

This is a **soft** contract — LRU eviction may break it under memory pressure or with very large n. The cache sizing in §2.1 makes the contract hold in expectation for the configured capacity range.

### 2.4 Provider switch

When the embedding provider changes (cl-spec-005 §6), the entire similarity cache is invalidated (cl-spec-005 §6.2 step 2). This spec does not change that behavior — it would be incorrect to preserve embedding-mode entries across a provider switch since the new provider's embedding space is different.

---

## 3. Adaptive Sampling

cl-spec-002 §5 (and cl-spec-009 §5) specify sampling for two scoring paths that are O(n²) without intervention: density's redundancy detection and coherence's topical concentration. The v0.1.0 implementation uses fixed thresholds and fixed sample sizes:

- Both paths use `SAMPLING_THRESHOLD = 200` — sampling activates above n = 200.
- Density uses `UNCACHED_SAMPLE_CAP = 30` — at most 30 non-adjacent comparisons per segment.
- Topical concentration uses `sampleSize = ceil(sqrt(n) × 3)` — at n = 500, this is 68.

This spec adapts these to scale better at higher n.

### 3.1 Adaptive UNCACHED_SAMPLE_CAP for density

The density per-segment sample cap is adaptive on n:

```
densitySampleCap(n) =
  if n <= 200: 30  (unchanged from v0.1.0)
  if n <= 300: 30
  if n <= 500: 15
  if n > 500:  10
```

Rationale: at n > 300, the cache is the primary working memory; sampling is a brake on cold-start cost. Halving the cap from 30 to 15 at n = 500 cuts density's per-`assess()` work from 500 × 30 = 15,000 to 500 × 15 = 7,500 similarity computations. At n = 1000, dropping to 10 keeps the work at 10,000 instead of 30,000.

### 3.2 Topical concentration sample size

Topical concentration's `sqrt(n) × 3` formula already scales sub-linearly. At n = 500 it samples 68 segments, producing 68 × 67 / 2 = 2,278 pairs — small relative to density's contribution. No change to this formula.

### 3.3 Adjacency

Adjacency similarity is exactly O(n) and not subject to sampling. At n = 500, it does 499 pairwise comparisons. Unchanged.

### 3.4 Group integrity

Group integrity is O(g²) per group where g is the group size. Groups are typically small (5–20 members); the sum across all groups is bounded by the total membership, which is at most n. No sampling needed.

---

## 4. Cache-Warm vs Cache-Cold Determinism

The single most important guarantee of this spec: **`assess()` produces identical scores regardless of cache state**.

Concretely: if instance A has a cold similarity cache (just cleared via `clearCaches('similarity')`), and instance B has a warm cache (populated by previous `assess()` calls), and A and B otherwise have identical state (segments, metadata, task, providers), then `A.assess()` and `B.assess()` produce numerically identical `windowScores`, `composite`, and `patterns` arrays.

This is a non-trivial property. It is the formalization of "the cache is a memoization layer, not a different scoring path." The implementation must:

- Use the same sampling-threshold logic regardless of cache state. The cache cannot influence sampling decisions.
- Use the same deterministic sampling seed regardless of cache state. The seed is derived from the segment set (cl-spec-002 §5), not from cache hit/miss patterns.
- Use the same iteration order regardless of cache state. The cache hit lookup is keyed on the same content-hash pair the iteration would produce on a miss.
- Round to the same precision regardless of cache state. Cosine and Jaccard are computed once per pair (cached or fresh) and the result is cached as-is; no re-rounding on hit.

The property test in §4 of `impl/I-10-similarity-caching.md` exercises this contract: build two identical instances, warm one's cache by repeated `assess()` calls, clear the other's, then run `assess()` on both and assert deep equality across all numeric fields except timestamp.

The v0.1.0 implementation already satisfies this property. Gap 5's changes (larger default cache, adaptive sampling) preserve it.

---

## 5. Configuration

### 5.1 similarityCacheSize constructor option

```
new ContextLens({
  capacity: 128000,
  similarityCacheSize: 32768,  // explicit override; default computed from capacity per §2.1
})
```

When omitted, defaults to `defaultSimilarityCacheSize(capacity)` per §2.1.

When provided, must be a positive integer. `0` is permitted (disables the cache; the next `setCacheSize('similarity', 0)` from cl-spec-007 §8.9.2 has the same effect).

### 5.2 Interaction with cl-spec-007 §8.9 setCacheSize

The `similarityCacheSize` constructor option sets the initial bound. `setCacheSize('similarity', N)` mutates it at runtime per cl-spec-007 §8.9.2. Both surfaces operate on the same underlying `LruCache` — the constructor option is just a shorthand for the construction-time call.

The runtime resize semantics are documented in cl-spec-007 §8.9.2:

- Shrinking evicts least-recently-used entries until the bound is satisfied.
- Growing leaves existing entries unchanged.
- `size = 0` disables the cache; subsequent `set` operations are immediate evictions.

### 5.3 Interaction with cl-spec-007 §8.9.3 getMemoryUsage

The estimate formula at cl-spec-009 §6.5.1 is unchanged: `entries × 80 bytes`. With the larger default cache size at typical capacities (~65,536 entries), the upper-bound footprint is ~5.2 MB. Caller monitoring of similarity cache memory continues to work via `getMemoryUsage().similarity` per cl-spec-007 §8.9.3.

### 5.4 Snapshot/restore

The similarity cache is a derived cache (cl-spec-014 §2 — not serialized). The `similarityCacheSize` configuration is captured in `SerializedConfig` (cl-spec-014 §4) and restored on `fromSnapshot()`. The first `assess()` after restore rebuilds the cache from cold; that rebuild is bounded by the same per-`assess()` cost as a fresh instance (cl-spec-009 §6.5.2).

---

## 6. Performance Targets

| Scenario | n | v0.1.0 actual | v0.2.0 target |
|----------|---|---------------|---------------|
| `assess` cache-cold | 100 | ~5 ms | ≤10 ms |
| `assess` cache-cold | 500 | ~340 ms | ≤200 ms |
| `assess` cache-warm | 500 | ~340 ms (the cache thrashes) | ≤50 ms (Tier 3 budget) |

The cache-warm target is the headline number. It is the case that matters in production: a long-lived instance that has been assessed before. Cache-cold is bounded but relaxed — the first `assess()` of a new instance is naturally slower; sampling adaptation keeps it within ~2× the v0.1.0 baseline rather than tightening it further.

The cache-warm target depends on the cache fitting the working set:

- At n = 500 with default scoring: ~7,500 density pairs (with adaptive cap 15) + 2,278 topical + 499 adjacency = ~10,300 distinct pairs. Default cache size at typical capacity (65,536) fits this comfortably.
- After a single mutation (one segment added or updated): the new segment's content hash invalidates cache entries involving it (~1,000 entries removed at n=500). The remaining 9,300+ survive. Next `assess()` must compute the new segment's pairs (~30 fresh pairs with adaptive sampling) plus rerun the unchanged sampling, hitting cache for each unchanged pair. Expected: well under 50 ms.

A property test (impl spec §5) verifies the determinism contract; a benchmark verifies the latency targets. Both are required for Gap 5 sign-off.

---

## 7. Invariants and Constraints

**Invariant 1: Cache-warm/cache-cold output equality.** For any two instances A and B with identical state and providers, where A has any cache state and B has any cache state, `A.assess()` and `B.assess()` produce identical `windowScores`, `composite`, `segments[].scores`, and `patterns` arrays. The cache is a memoization layer, never a different scoring path. (§4)

**Invariant 2: Sampling determinism preserved.** The sampling seed is a function of segment content (cl-spec-002 §5), not of cache state, wall-clock, or any external signal. Identical segment sets always produce identical samples. The cache hit/miss pattern does not influence the sample. (§3, §4)

**Invariant 3: Per-mutation invalidation precision.** A single segment mutation invalidates exactly the cache entries involving that segment's old content hash (cl-spec-002 §3.2 already specifies this; this spec preserves it). Pairs of unchanged segments survive. (§2.2)

**Invariant 4: Default scaling is monotonic in capacity.** `defaultSimilarityCacheSize(capacity)` is a non-decreasing function of `capacity`. Increasing capacity never produces a smaller default cache size. (§2.1)

**Invariant 5: Default scaling is bounded.** `defaultSimilarityCacheSize(capacity)` ∈ `[16384, 65536]` for any non-negative capacity. The lower bound preserves v0.1.0 behavior at small capacities; the upper bound prevents pathological memory footprint. (§2.1)

**Invariant 6: Adaptive sampling is monotonic in n.** `densitySampleCap(n)` is a non-increasing function of n. Larger windows never produce a higher per-segment sample cap. (§3.1)

**Invariant 7: Adaptive sampling preserves continuity at thresholds.** At each n threshold (200, 300, 500), the sample cap step is at most 50 % of the prior value. No sample cap jumps below half its prior value across a single n increment. The current schedule (30 → 30 → 15 → 10) is conservative — every step halves at most. (§3.1)

**Invariant 8: Cache-cold is bounded.** Even with the cache disabled (`setCacheSize('similarity', 0)`), `assess()` completes within the cl-spec-009 §3.3 budget tier with the multiplicative factor documented in §6 of this spec. Cache disablement is permitted (cl-spec-007 §8.9.2 confirmed at the construction surface) but the caller accepts the increased latency. (§5.1, §6)

**Invariant 9: Memory footprint is documented.** The similarity cache's worst-case memory footprint is `maxEntries × 80 bytes` per cl-spec-009 §6.5.1. At the default upper bound (65,536), this is ~5.2 MB. The `getMemoryUsage().similarity.estimatedBytes` field reports the current consumption (cl-spec-007 §8.9.3). (§5.3)

**Invariant 10: No new cache kind.** This spec refines the existing similarity cache (cl-spec-002 §3.2). It does not introduce a new cache kind, a new event, or a new invalidation surface. The Gap 6 cache management API (cl-spec-007 §8.9 — `clearCaches('similarity')`, `setCacheSize('similarity', N)`, `getMemoryUsage().similarity`) covers everything Gap 5 changes.

---

## 8. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-002` (Quality Model) | Defines the similarity function (§3.2) and the sampling subsection (§5) that this spec amends. The pairwise cache contract from cl-spec-002 §3.2 is the foundation; Gap 5 refines its sizing and acknowledges the survivability contract across mutations. |
| `cl-spec-005` (Embedding Strategy) | Defines the embedding cache (§5) and provider switch invalidation cascade (§6) — Gap 5 preserves the existing cascade unchanged. The cl-spec-005 §5.5 (Manual Release) cross-references cl-spec-007 §8.9 which Gap 5 reuses. |
| `cl-spec-007` (API Surface) | Defines the `setCacheSize`/`clearCaches`/`getMemoryUsage` surface (§8.9) that Gap 6 introduced. Gap 5 adds the `similarityCacheSize` constructor option which is a synonym for the construction-time call. |
| `cl-spec-009` (Performance Budget) | Defines the assessment budget tier (§3.3) and the sampling strategies (§5). Gap 5 amends the budget rows for `assess@500` cache-warm and the sampling adaptation. |
| `cl-spec-014` (Serialization) | Defines snapshot/fromSnapshot. The similarity cache is not serialized (derived state); the `similarityCacheSize` configuration is. After restore, the first `assess()` rebuilds the cache from cold. |
| `V0_2_0_BACKLOG.md` § Gap 5 | The actionable backlog entry that scopes Gap 5. Decision lock applied 2026-05-01: option (b) incremental cache as primary, option (a) tighter sampling as fallback above N. |
| `assess@500 over budget` (Phase 5 known issue) | The original incident: at n = 500, `assess()` takes ~340 ms vs the 50 ms target. Tracked in `SEED_CONTEXT.md` "Known issues" → "Low" tier. Gap 5 closes this on the cache-warm path (the production case) and bounds the cold path within ~2×. |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.7*
