# Phase 8 — Memory Release (Gap 6 of v0.2.0 hardening)

## 1. Preamble

Phase 8 implements the cache-management surface specified by cl-spec-007 §8.9 (added in the 2026-05-01 amendment for Gap 6 of v0.2.0 hardening) — `clearCaches`, `setCacheSize`, `getMemoryUsage`, and the `cachesCleared` event. Long-lived `ContextLens` instances reach the LRU steady state set by their construction-time cache bounds; this phase gives callers explicit primitives to release that bounded memory mid-session, retune the bounds, or measure current consumption.

**Design specs covered:**
- `cl-spec-007` (API Surface) §8.9 (Memory Management) — three new methods, `cachesCleared` event in §10.2
- `cl-spec-005` (Embedding Strategy) §5.5 — manual release for the embedding cache
- `cl-spec-006` (Tokenization Strategy) §5.6 — manual release for the token count cache
- `cl-spec-009` (Performance Budget) §6.5 — estimate formula, rebuild cost table, long-lived guidance

**Performance budget:** `cl-spec-009` — `clearCaches` is O(c) entries dropped (sub-millisecond at default sizes); `setCacheSize` is O(d) entries evicted on shrink (sub-millisecond at default deltas); `getMemoryUsage` is Tier 1 (<1 ms — pure aggregation over three integer reads + arithmetic).

**Key resolutions referenced (per V0_2_0_BACKLOG.md decision locks confirmed 2026-05-01):**
- `getMemoryUsage` precision: estimate (cheap, advisory). The estimate uses fixed bytes-per-entry coefficients keyed on cache kind and (for embedding) provider mode and dimensions. ±20% expected error band per cl-spec-009 §6.5.
- `setCacheSize(kind, 0)` permitted: yes. Disables the cache (every set is immediately evicted). Per-cache guidance lives in cl-spec-007 §8.9.2; rebuild cost in cl-spec-009 §6.5.

**Parent document:** `IMPLEMENTATION.md` — Phase 8 row to be added as a v0.2.0 hardening entry alongside Phases 6 (dispose) and 7 (OTel re-attach).

---

## 2. Module Map

| Module | Primary design spec | Responsibility |
|--------|---------------------|----------------|
| `utils/lru-cache.ts` (modified) | cl-spec-007 §8.9.2 | New `resize(newSize: number): number` method. Drops oldest entries on shrink, returns the count of evicted entries. Allows `newSize = 0` (every set is immediately evicted). The `maxSize` field becomes mutable. |
| `tokenizer.ts` (modified) | cl-spec-006 §5.6 | New public `setCacheSize(size: number)` and `getEntryCount(): number` methods. Existing `clearCache()` already exists from Phase 6 — no change. |
| `embedding.ts` (modified) | cl-spec-005 §5.5 | Same pattern: `setCacheSize`, `getEntryCount`, plus `getEntryByteEstimate(): number` for mode-aware byte estimation (different formula for embedding vs. trigram). |
| `similarity.ts` (modified) | cl-spec-002 §3.2 | Same pattern: `setCacheSize`, `getEntryCount`. Estimate is fixed 80 bytes/entry. |
| `events.ts` (modified) | cl-spec-007 §10.2 | `cachesCleared` added to `ContextLensEventMap` with payload `{ kind, entriesCleared }`. Event catalog 25 → 26. |
| `types.ts` (modified) | cl-spec-007 §8.9 | Adds `CacheKind` union (`'tokenizer' \| 'embedding' \| 'similarity' \| 'all'`), `CacheUsage` interface, `MemoryUsage` interface. Re-exported from package main entry. |
| `index.ts` (ContextLens, modified) | cl-spec-007 §8.9 | Adds `clearCaches`, `setCacheSize`, `getMemoryUsage` public methods. Wires the `cachesCleared` event emission. Adds three new disposed-state guards (38 → 41 guards on the public surface). |

No new modules. No new test files at the unit level — tests extend existing `lru-cache.test.ts`, `tokenizer.test.ts`, `embedding.test.ts`, `similarity.test.ts`, and `events.test.ts`. Public-API tests extend `context-lens.test.ts`.

---

## 3. Dependency Direction

Unchanged. `index.ts` orchestrates; the cache modules are leaves with no upward imports.

```
                     ┌──────────────────────┐
                     │  index.ts            │
                     │  + clearCaches       │
                     │  + setCacheSize      │
                     │  + getMemoryUsage    │
                     └──────────┬───────────┘
                                │ owns
              ┌─────────────────┼─────────────────┐
              v                 v                 v
        ┌──────────┐      ┌───────────┐    ┌──────────┐
        │ tokenizer│      │ embedding │    │similarity│
        └────┬─────┘      └─────┬─────┘    └────┬─────┘
             │                  │               │
             v                  v               v
                     ┌──────────────────────┐
                     │  utils/lru-cache.ts  │
                     │  + resize            │
                     └──────────────────────┘
```

Each cache module owns one `LruCache` and exposes `setCacheSize`/`getEntryCount`/`clearCache` (existing) over it.

---

## 4. Module Specifications

### 4.1 utils/lru-cache.ts (modifications)

#### 4.1.1 resize method

```ts
/**
 * Resize the cache's maximum-entry bound. On shrink, evicts least-recently-used
 * entries until size <= newMaxSize. On grow, leaves entries unchanged. Setting
 * newMaxSize to 0 drops every entry; subsequent set operations are immediate
 * evictions.
 *
 * @param newMaxSize Non-negative integer. Bounds checking is the caller's job;
 *   this method assumes the value is valid.
 * @returns Number of entries evicted as a result of the resize.
 * @see cl-spec-007 §8.9.2
 */
resize(newMaxSize: number): number {
  const evicted = Math.max(0, this.map.size - newMaxSize);
  this.maxSize = newMaxSize;
  while (this.map.size > newMaxSize) {
    this.removeTail();
  }
  return evicted;
}
```

The `maxSize` field becomes mutable (`private maxSize: number` instead of `private readonly maxSize`). No other behavior change.

#### 4.1.2 LruCache invariants preserved

- `size <= maxSize` after every operation.
- LRU ordering unchanged (head = most recently used; tail = least recently used).
- `set` after a `resize(0)` adds the node, sees `size > maxSize`, and `removeTail` evicts it immediately. The node is briefly head and tail before the tail removal kicks in. Net effect: `size` returns to 0.
- `clear()` is unchanged (resets head, tail, map; `maxSize` is untouched).

### 4.2 tokenizer.ts (modifications)

```ts
/**
 * Resize the token count cache at runtime. Drops least-recently-used entries
 * on shrink. Setting size to 0 disables the cache.
 * @see cl-spec-006 §5.6, cl-spec-007 §8.9.2
 */
setCacheSize(size: number): number {
  return this.cache.resize(size);
}

/** Current number of cache entries — used by getMemoryUsage. */
getEntryCount(): number {
  return this.cache.size;
}

/** Configured maximum entries — used by getMemoryUsage. */
getMaxEntries(): number {
  return this.cache.maxSize;
}
```

`this.cache.maxSize` requires a getter on `LruCache`:

```ts
// In LruCache:
get maxEntries(): number {
  return this.maxSize;
}
```

The existing `cacheSize` field on `Tokenizer` is removed — `LruCache` is now the single source of truth for the bound. The constructor still accepts a cache size and passes it to `new LruCache(cacheSize)`; the `cacheSize` field was only used during provider switches to reset the cache, and that path is updated to call `this.cache.clear()` (which keeps the existing `maxSize`).

#### 4.2.1 Existing clearCache unchanged

The `clearCache()` method from Phase 6 is unchanged — it still calls `this.cache.clear()` and returns `void`. The orchestrator in `ContextLens.clearCaches` reads the entry count via `getEntryCount()` *before* calling `clearCache()` so it can populate the `entriesCleared` field on the emitted event.

### 4.3 embedding.ts (modifications)

```ts
setCacheSize(size: number): number {
  return this.cache.resize(size);
}

getEntryCount(): number {
  return this.cache.size;
}

getMaxEntries(): number {
  return this.cache.maxSize;
}

/**
 * Mode-aware byte estimate per entry. Used by ContextLens.getMemoryUsage.
 *
 * - Embedding mode: dimensions × 8 + 100 bytes (Float64 vector + key/LRU overhead)
 * - Trigram mode: 8000 bytes (conservative average for Set<string> at typical content sizes)
 *
 * Returns 0 when the cache is empty (no per-entry estimate to apply).
 *
 * @see cl-spec-009 §6.5
 */
getEntryByteEstimate(): number {
  if (this.cache.size === 0) return 0;
  if (this.metadata !== null) {
    return this.metadata.dimensions * 8 + 100;
  }
  return 8000;
}
```

The `cacheSize` field on `EmbeddingEngine` is similarly removed; provider-switch and provider-removal code paths previously reset the cache by calling `this.cache = new LruCache(this.cacheSize)`. They are updated to call `this.cache.clear()` instead. This preserves the existing maxSize across switches (the switch is a content-invalidation operation; the bound was set at construction or via a prior `setCacheSize`).

### 4.4 similarity.ts (modifications)

```ts
setCacheSize(size: number): number {
  return this.cache.resize(size);
}

getEntryCount(): number {
  return this.cache.size;
}

getMaxEntries(): number {
  return this.cache.maxSize;
}
```

Estimate is constant 80 bytes/entry per cl-spec-009 §6.5; the orchestrator applies it directly without a per-module helper.

The `cacheSize` field is removed; the existing provider-switch path that re-creates the cache (`this.cache = new LruCache(this.cacheSize)` at line 136) is updated to call `this.cache.clear()`.

### 4.5 events.ts (modifications)

Adds `cachesCleared` to `ContextLensEventMap`:

```ts
export interface ContextLensEventMap {
  // ... 25 existing events ...
  cachesCleared: {
    kind: CacheKind;
    entriesCleared: {
      tokenizer: number;
      embedding: number;
      similarity: number;
    };
  };
}
```

`CacheKind` is imported from `types.ts`. Catalog count goes from 25 to 26. No changes to `EventEmitter` itself.

### 4.6 types.ts (modifications)

```ts
/** Cache kinds supported by clearCaches/setCacheSize. */
export type CacheKind = 'tokenizer' | 'embedding' | 'similarity' | 'all';

/** Per-cache memory snapshot — returned within MemoryUsage. */
export interface CacheUsage {
  entries: number;
  maxEntries: number;
  estimatedBytes: number;
}

/** Memory usage snapshot returned by ContextLens.getMemoryUsage. */
export interface MemoryUsage {
  tokenizer: CacheUsage;
  embedding: CacheUsage;
  similarity: CacheUsage;
  totalEstimatedBytes: number;
}
```

Re-exported from package main entry alongside the other public types.

### 4.7 index.ts (modifications)

#### 4.7.1 clearCaches

```ts
clearCaches(kind: CacheKind = 'all'): void {
  guardDispose(this.lifecycleState, 'clearCaches', this.instanceId);
  if (!CACHE_KINDS.has(kind)) {
    throw new ValidationError(`Unknown cache kind: ${kind}`, { kind });
  }

  const entriesCleared = { tokenizer: 0, embedding: 0, similarity: 0 };

  if (kind === 'tokenizer' || kind === 'all') {
    entriesCleared.tokenizer = this.tokenizer.getEntryCount();
    this.tokenizer.clearCache();
  }
  if (kind === 'embedding' || kind === 'all') {
    entriesCleared.embedding = this.embedding.getEntryCount();
    this.embedding.clearCache();
  }
  if (kind === 'similarity' || kind === 'all') {
    entriesCleared.similarity = this.similarity.getEntryCount();
    this.similarity.clearCache();
  }

  this.emitter.emit('cachesCleared', { kind, entriesCleared });
}
```

`CACHE_KINDS` is a `Set<CacheKind>` constant containing the four valid values. Validation runs before any cache mutation so an invalid kind leaves the instance unchanged (atomic-failure invariant).

#### 4.7.2 setCacheSize

```ts
setCacheSize(kind: Exclude<CacheKind, 'all'>, size: number): void {
  guardDispose(this.lifecycleState, 'setCacheSize', this.instanceId);
  if (kind === 'all') {
    throw new ValidationError(
      "setCacheSize: 'all' is not permitted; specify one of 'tokenizer' | 'embedding' | 'similarity'",
      { kind },
    );
  }
  if (!SETTABLE_CACHE_KINDS.has(kind)) {
    throw new ValidationError(`Unknown cache kind: ${kind}`, { kind });
  }
  if (!Number.isInteger(size) || size < 0) {
    throw new ValidationError('setCacheSize: size must be a non-negative integer', { size });
  }

  switch (kind) {
    case 'tokenizer':
      this.tokenizer.setCacheSize(size);
      break;
    case 'embedding':
      this.embedding.setCacheSize(size);
      break;
    case 'similarity':
      this.similarity.setCacheSize(size);
      break;
  }
}
```

The `'all'` rejection is a runtime guard against callers using a `CacheKind` value (e.g., the type system can be bypassed with `as` casts). The TypeScript signature already excludes `'all'`; this is belt-and-suspenders.

`setCacheSize` does **not** emit `cachesCleared` even when shrinking causes evictions. The spec is explicit (cl-spec-007 §8.9.2): resize is a configuration change with a side effect, not an explicit clear.

#### 4.7.3 getMemoryUsage

```ts
getMemoryUsage(): MemoryUsage {
  guardDispose(this.lifecycleState, 'getMemoryUsage', this.instanceId);

  const tokenizerEntries = this.tokenizer.getEntryCount();
  const embeddingEntries = this.embedding.getEntryCount();
  const similarityEntries = this.similarity.getEntryCount();

  const tokenizerBytes = tokenizerEntries * 100;
  const embeddingBytes = embeddingEntries * this.embedding.getEntryByteEstimate();
  const similarityBytes = similarityEntries * 80;

  const totalEstimatedBytes = tokenizerBytes + embeddingBytes + similarityBytes;

  return {
    tokenizer: {
      entries: tokenizerEntries,
      maxEntries: this.tokenizer.getMaxEntries(),
      estimatedBytes: tokenizerBytes,
    },
    embedding: {
      entries: embeddingEntries,
      maxEntries: this.embedding.getMaxEntries(),
      estimatedBytes: embeddingBytes,
    },
    similarity: {
      entries: similarityEntries,
      maxEntries: this.similarity.getMaxEntries(),
      estimatedBytes: similarityBytes,
    },
    totalEstimatedBytes,
  };
}
```

Pure aggregation. No deep copies needed — the returned object is constructed fresh each call. Tier 1 query (<1 ms).

#### 4.7.4 READ_ONLY_METHODS update

`getMemoryUsage` is read-only and must be added to the `READ_ONLY_METHODS` set in `lifecycle.ts` so it remains callable during the `isDisposing === true` window (e.g., from a `stateDisposed` handler that wants to log final memory consumption). `clearCaches` and `setCacheSize` are mutating and must NOT be in the set.

The audited count goes from 20 to 21 names.

---

## 5. Test Requirements

### Unit tests

**`utils/lru-cache.test.ts` (extended):**
- `resize(newSize)` on a full cache shrinks correctly (drops oldest, returns evicted count).
- `resize(newSize)` to a value larger than current size leaves entries unchanged, returns 0.
- `resize(0)` evicts every entry; subsequent `set` calls evict immediately (size remains 0).
- `resize(currentSize)` is a no-op (returns 0).
- LRU ordering preserved across resizes (most-recently-used entries survive a shrink).

**`tokenizer.test.ts` / `embedding.test.ts` / `similarity.test.ts` (each extended):**
- `setCacheSize(size)` delegates to `cache.resize` and returns the evicted count.
- `getEntryCount()` matches `cache.size`.
- `getMaxEntries()` matches `cache.maxSize` and updates after `setCacheSize`.

**`embedding.test.ts` (additional):**
- `getEntryByteEstimate()` returns 0 on empty cache.
- Returns `dimensions * 8 + 100` when a provider with declared dimensions is configured and the cache is non-empty.
- Returns `8000` when no provider is configured (trigram mode) and the cache is non-empty.

**`events.test.ts` (extended):**
- `cachesCleared` is in the event map with the documented payload shape (compile-time + runtime emit/handle round-trip).

**`context-lens.test.ts` (new "Memory management" describe block):**
- `clearCaches('all')` empties tokenizer, embedding, and similarity caches; emits `cachesCleared` with `kind: 'all'` and per-cache entriesCleared counts matching pre-clear sizes.
- `clearCaches('tokenizer' | 'embedding' | 'similarity')` empties the named cache and leaves the others untouched.
- `clearCaches('invalid')` throws `ValidationError`; instance state unchanged.
- `clearCaches()` (no arg) defaults to `'all'`.
- `setCacheSize('embedding', 64)` shrinks the embedding cache; `getMemoryUsage().embedding.maxEntries === 64`. Does NOT emit `cachesCleared`.
- `setCacheSize('embedding', 0)` evicts every entry; subsequent assess() repopulates per the rebuild-cost contract.
- `setCacheSize('all', 64)` throws `ValidationError`.
- `setCacheSize('embedding', -1)` throws `ValidationError`.
- `setCacheSize('embedding', 1.5)` throws `ValidationError` (non-integer).
- `getMemoryUsage()` returns the expected shape with `entries`, `maxEntries`, `estimatedBytes` fields per cache and `totalEstimatedBytes` matching the sum.
- `getMemoryUsage()` after `clearCaches('all')` reports zero entries for all caches.
- `clearCaches`/`setCacheSize`/`getMemoryUsage` throw `DisposedError` after `dispose()`.

### Integration tests

In `test/integration/context-lens.test.ts` (existing) — one new flow:

- **long-running-clear-and-rebuild:** Construct an instance, add 50 segments, run multiple assessments, capture pre-clear `getMemoryUsage()`. Call `clearCaches('all')` and verify `getMemoryUsage().totalEstimatedBytes === 0`. Run another assess; verify counts repopulate (post-rebuild bytes ≥ post-add baseline). Round-trip ends with the instance functional and the segments unchanged.

### Property-based tests

None planned. The state machine is small and the unit tests exhaustively cover the kind × operation matrix.

### Performance benchmarks

Optional. The cl-spec-009 §6.5 budget is sub-millisecond for clearCaches and setCacheSize at default cache sizes — already trivially satisfied. A bench may be added if a future regression is suspected, but it is not in Phase 8 scope.

---

## 6. Exit Criteria

- `LruCache.resize(newMaxSize)` exists and returns the evicted count. `maxSize` field is mutable. Existing LRU operations are unaffected.
- Each cache module (`tokenizer.ts`, `embedding.ts`, `similarity.ts`) exposes `setCacheSize`, `getEntryCount`, `getMaxEntries`. The internal `cacheSize` field is removed; provider-switch paths use `cache.clear()` instead of recreating the cache. `embedding.ts` additionally exposes `getEntryByteEstimate`.
- `ContextLens` exposes `clearCaches(kind?)`, `setCacheSize(kind, size)`, `getMemoryUsage()`. All three methods include the disposed-state guard at the top. `clearCaches` emits `cachesCleared`; `setCacheSize` does not.
- `cachesCleared` is in `ContextLensEventMap` with the documented payload shape. Catalog count grows from 25 to 26 (`tokenizer`/`fleet`/`OTel` event counts unaffected).
- `READ_ONLY_METHODS` (in `lifecycle.ts`) includes `getMemoryUsage`. Count grows from 20 to 21.
- `CacheKind`, `CacheUsage`, `MemoryUsage` types are defined in `types.ts` and re-exported from the main entry.
- All existing tests pass (1127 hard floor). New tests added per section 5; expected count growth is ~12–18 unit tests + 1 integration test.
- `cl-spec-005` §5.5, `cl-spec-006` §5.6, `cl-spec-007` §8.9 (with cachesCleared event), and `cl-spec-009` §6.5 are fully implemented as specified.
- Public API surface gains exactly three methods (`clearCaches`, `setCacheSize`, `getMemoryUsage`), one event (`cachesCleared`), and three types (`CacheKind`, `CacheUsage`, `MemoryUsage`). No other surface additions.

---

*context-lens implementation spec — Phase 8 (v0.2.0 Gap 6)*
