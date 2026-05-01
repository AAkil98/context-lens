# Phase 10 — Similarity Caching & Sampling (Gap 5 of v0.2.0 hardening)

## 1. Preamble

Phase 10 implements the cl-spec-016 contract — incremental similarity cache (option b) and adaptive sampling (option a) — to close the `assess@500` over budget known issue from v0.1.0 (~340 ms vs 50 ms target). The spec was added 2026-05-02 for Gap 5 of v0.2.0 hardening; this phase is the corresponding code work.

**Design specs covered:**
- `cl-spec-016` (Similarity Caching & Sampling) — new spec
- `cl-spec-002` §3.4 (Topical Concentration sampling note) — amended
- `cl-spec-009` §3.3 (Tier 3 Incremental Assessment budget) — amended

**Performance budget:** Per cl-spec-009 §3.3 as amended:
- assess@500 cache-warm: <50 ms (headline target).
- assess@500 cache-cold: ≤200 ms.
- assess@500 cache-disabled (`similarityCacheSize: 0`): ≤500 ms (bounded only, no production target).

**Key resolutions referenced (per V0_2_0_BACKLOG.md decision locks confirmed 2026-05-01):**
- Option (b) primary: enlarge default similarity cache and ensure it survives mutation cycles.
- Option (a) fallback: tighter density sample cap above n > 300.
- `similarityCacheSize` config exposed via constructor + `setCacheSize` (cl-spec-007 §8.9.2 — already shipped in Gap 6).

**Parent document:** `IMPLEMENTATION.md` — Phase 10 row to be added as a v0.2.0 hardening entry.

---

## 2. Module Map

| Module | Primary design spec | Responsibility |
|--------|---------------------|----------------|
| `src/scoring/density.ts` (modified) | cl-spec-016 §3.1 | Replace fixed `UNCACHED_SAMPLE_CAP = 30` with adaptive `densitySampleCap(n)` step function. |
| `src/scoring/coherence.ts` (modified) | cl-spec-016 §3.2 | No behavioral change required — topical concentration's `sqrt(n) × 3` already sub-linear. Just import the shared constant if a refactor is opportune. |
| `src/index.ts` (modified) | cl-spec-016 §5 | Add `similarityCacheSize` to `ContextLensConfig`. Compute `defaultSimilarityCacheSize(capacity)` per cl-spec-016 §2.1. Pass to `new SimilarityEngine(...)` constructor. |
| `src/similarity.ts` (modified) | cl-spec-016 §2 | No new public method. The existing `setCacheSize` from Gap 6 already covers runtime resize. The existing `clearCache` and `invalidateContentHash` cover invalidation. |

No new modules. No new types beyond the `ContextLensConfig.similarityCacheSize` field. The cl-spec-016 contract is mostly about sizing and adaptive sampling — the runtime infrastructure shipped earlier in v0.2.0.

---

## 3. Dependency Direction

Unchanged. `src/index.ts` instantiates `SimilarityEngine` with the configured size; `src/scoring/density.ts` and `src/scoring/coherence.ts` consume the engine without knowing its cache size.

```
                     ┌──────────────────────┐
                     │  index.ts            │
                     │  + similarityCacheSize│
                     │    config            │
                     │  + defaultSimilarity │
                     │    CacheSize formula │
                     └──────────┬───────────┘
                                │ constructs
                                v
                     ┌──────────────────────┐
                     │  similarity.ts       │
                     │  (existing surface)  │
                     └──────────────────────┘
                                ^
                                │ consumed by
                                │
                ┌────────────────────────────┐
                │                            │
        ┌──────────────┐            ┌──────────────┐
        │  density.ts  │            │ coherence.ts │
        │  + adaptive  │            │  unchanged   │
        │    sample cap│            │              │
        └──────────────┘            └──────────────┘
```

---

## 4. Module Specifications

### 4.1 src/scoring/density.ts (modifications)

The constant `UNCACHED_SAMPLE_CAP = 30` (line 14 of v0.1.0 source) is replaced with a function:

```ts
// ─── Adaptive sampling per cl-spec-016 §3.1 ─────────────────

/** Number of non-adjacent comparisons per segment when sampling is active. */
function densitySampleCap(n: number): number {
  if (n <= 300) return 30;
  if (n <= 500) return 15;
  return 10;
}
```

The single call site (existing) updates from `Math.min(UNCACHED_SAMPLE_CAP, shuffled.length)` to `Math.min(densitySampleCap(n), shuffled.length)`. Same for the `slice(0, UNCACHED_SAMPLE_CAP)` line.

Constants exported from the module are preserved for backward compatibility with any tests that reference them; `UNCACHED_SAMPLE_CAP` is now just `densitySampleCap(0)` (returns 30) for the n ≤ 300 case.

#### 4.1.1 Determinism preserved

The sampling RNG seed is unchanged: `fnv1a(sortedIds.join('\0'))`. Identical segment sets produce identical samples. The smaller cap at high n simply truncates the same underlying shuffled order earlier — the chosen subset is a prefix of the n ≤ 300 subset, which keeps cache-warm and cache-cold paths consistent with cl-spec-016 §4.

### 4.2 src/index.ts (modifications)

#### 4.2.1 Config surface

Add `similarityCacheSize` to `ContextLensConfig`:

```ts
export interface ContextLensConfig {
  capacity: number;
  // ... existing fields ...
  embeddingCacheSize?: number;
  /**
   * Maximum entries in the pairwise similarity cache. Defaults to a value
   * scaled with capacity per cl-spec-016 §2.1 — clamped to [16384, 65536].
   * Set to 0 to disable the cache (cl-spec-007 §8.9.2 + cl-spec-016 §5.1).
   *
   * Runtime resize via setCacheSize('similarity', N) (cl-spec-007 §8.9.2).
   * @see cl-spec-016
   */
  similarityCacheSize?: number;
}
```

Validation in the constructor: same shape as `embeddingCacheSize` validation — non-negative integer, throws `ConfigurationError` otherwise.

#### 4.2.2 Default formula

```ts
/**
 * Default similarity cache size scaled by capacity per cl-spec-016 §2.1.
 * Clamped to [16384, 65536]:
 *   - lower bound preserves v0.1.0 behavior at small capacities
 *   - upper bound caps memory footprint at ~5.2 MB
 */
function defaultSimilarityCacheSize(capacity: number): number {
  const computed = Math.ceil(Math.sqrt(capacity / 200) * 16384);
  return Math.max(16384, Math.min(65536, computed));
}
```

Module-level (alongside `INSTANCE_COUNTER`, `CACHE_KINDS`, `SETTABLE_CACHE_KINDS`).

#### 4.2.3 SimilarityEngine instantiation

Replace the existing `new SimilarityEngine()` (line 167 area, no args) with the configured size:

```ts
const similarityCacheSize = config.similarityCacheSize ?? defaultSimilarityCacheSize(config.capacity);
this.similarity = new SimilarityEngine(similarityCacheSize);
```

#### 4.2.4 configSnapshot

The `configSnapshot` field used by `snapshot()` (cl-spec-014) gets a new entry:

```ts
this.configSnapshot = {
  // ... existing fields ...
  similarityCacheSize,
};
```

Same pattern as `embeddingCacheSize` — captured at construction, surfaced in `SerializedConfig`, restored on `fromSnapshot()` per cl-spec-014.

`SerializedConfig` (in `types.ts`) gains the field as well. Existing serializations are forward-compatible — older snapshots without the field fall through to the default formula on restore.

### 4.3 src/similarity.ts (no behavioral changes)

The constructor already accepts `cacheSize`; the existing `setCacheSize`, `clearCache`, `invalidateContentHash`, `getEntryCount`, `getMaxEntries` methods cover everything cl-spec-016 needs. No new code in this module.

### 4.4 src/types.ts (modifications)

`SerializedConfig` interface gains `similarityCacheSize: number | null`. The null option is for forward-compat with snapshots from prior v0.2.0 dev builds; `fromSnapshot()` falls back to the default formula in that case.

```ts
export interface SerializedConfig {
  // ... existing fields ...
  embeddingCacheSize: number;
  similarityCacheSize: number;  // new
}
```

(Not nullable — current code path always populates it via `defaultSimilarityCacheSize` at construction. Old snapshots from v0.1.0 don't have this field; `fromSnapshot` checks and falls back. The defensive code lives in `fromSnapshot`, not the type.)

### 4.5 Schema updates

The JSON Schema for `SerializedState` (cl-spec-011) does not currently include `similarityCacheSize`. The schemas are versioned independently of the spec corpus; updating the schema is out of scope for Phase 10. A future schema-version bump can include the field formally. v0.2.0 ships with `additionalProperties: true` on the config block, so the new field validates.

---

## 5. Test Requirements

### Unit tests

In `test/unit/context-lens.test.ts` (existing, expanded):

- **similarityCacheSize default at typical capacities:** `new ContextLens({ capacity: 128000 })` produces an instance whose `getMemoryUsage().similarity.maxEntries === 65536` (the formula upper bound). At `capacity: 800`, `getMemoryUsage().similarity.maxEntries === 16384` (lower bound).
- **similarityCacheSize override:** `new ContextLens({ capacity: 128000, similarityCacheSize: 4096 })` produces an instance with `getMemoryUsage().similarity.maxEntries === 4096`.
- **similarityCacheSize: 0 disables the cache:** verify `getMemoryUsage().similarity.maxEntries === 0`. Subsequent `assess()` calls work but every similarity lookup misses.
- **similarityCacheSize validation:** negative integer, non-integer, NaN all throw `ConfigurationError`.

In `test/unit/scoring/density.test.ts` (existing, expanded):

- **densitySampleCap at thresholds:** assert returns 30 at n=200, 30 at n=300, 15 at n=400, 15 at n=500, 10 at n=501, 10 at n=1000.

### Property-based tests

In `test/property/similarity-determinism.test.ts` (new file, fast-check):

- **Cache-warm and cache-cold produce identical assess output (Invariant 1):** For arbitrary segment counts (10–100), build two identical instances. Warm one's similarity cache via repeated `assess()` calls. Clear the other's via `clearCaches('similarity')`. Run a final `assess()` on both. Assert `windowScores`, `composite`, and `segments[].scores` are deeply equal up to floating-point precision.
- **Cache size variations preserve output:** Same setup, but the two instances have different `similarityCacheSize` values (one default, one minimal at 16). Assert `assess()` outputs are identical.

### Performance benchmarks

In `test/bench/budgets.bench.ts` (existing, expanded):

- **assess @ 500 — cache cold:** baseline benchmark for cl-spec-009 §3.3 cache-cold target (≤200 ms). The existing `assess @ 500` bench already exercises this; verify it stays within the new ceiling.
- **assess @ 500 — cache warm:** new bench. Construct + populate + assess once + assess again (the second assess hits the cache-warm path). Target: <50 ms for the second assess.
- **assess @ 500 — cache disabled:** new bench. Construct with `similarityCacheSize: 0` + populate + assess. Target: <500 ms (bounded only, no production target).

Bench thresholds are advisory in the test framework; the values document the expected envelope rather than hard-failing on regression. Cl-spec-009's budget violations are surfaced through the `budgetViolation` event channel (cl-spec-007 §10.2), not the test framework.

---

## 6. Exit Criteria

- `densitySampleCap(n)` step function replaces the fixed `UNCACHED_SAMPLE_CAP` constant in `src/scoring/density.ts`. Step values (30 / 30 / 15 / 10) match cl-spec-016 §3.1.
- `ContextLensConfig.similarityCacheSize?: number` exists. Validation rejects negative or non-integer values. Default computed via `defaultSimilarityCacheSize(capacity)` per cl-spec-016 §2.1.
- `SerializedConfig.similarityCacheSize: number` is captured at construction and restored on `fromSnapshot()`. Backward compatibility: snapshots from v0.1.0 without the field fall back to the default formula.
- Cache-warm/cache-cold determinism property test passes (Invariant 1). At least 100 fast-check runs with no counterexamples.
- `assess@500` cache-warm benchmark target met (<50 ms). Achieved by combination of (a) larger default cache (~65,536 entries vs 16,384) covering the full working set + (b) adaptive sampling reducing per-`assess()` work.
- `assess@500` cache-cold benchmark within ≤200 ms (relaxed target, sampling adaptation gives the headroom).
- All existing tests pass (1184 hard floor). New tests added per section 5.
- Public API surface gains exactly one new config field (`similarityCacheSize`). No new methods, no new events, no new types beyond the config field.

---

*context-lens implementation spec — Phase 10 (v0.2.0 Gap 5)*
