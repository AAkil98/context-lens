---
id: cl-spec-006
title: Tokenization Strategy
type: design
status: complete
created: 2026-03-25
revised: 2026-05-01
authors: [Akil Abderrahim, Claude Opus 4.6, Claude Opus 4.7]
tags: [tokenization, token-counting, provider, performance, caching]
depends_on: [cl-spec-001]
---

# Tokenization Strategy

## Table of Contents

1. Overview
2. Tokenizer Interface
3. Built-in Providers
4. Token Counting Operations
5. Caching Strategy
6. Configuration
7. Accuracy Guarantees
8. Invariants and Constraints
9. References

---

## 1. Overview

Token counting is the only measurement in context-lens that touches every segment on every mutation. It is the foundation of capacity tracking, the input to density scoring, and the unit of currency for eviction decisions. If token counts are wrong, capacity reports are wrong, quality scores are wrong, and eviction advisories are wrong. If token counting is slow, every lifecycle operation is slow.

This spec defines how context-lens counts tokens — the abstraction it exposes, the providers it ships, when counts are computed, how they are cached, and what accuracy guarantees the caller can rely on.

### The core tension

Token counting sits at the intersection of three competing demands:

- **Accuracy.** The caller needs token counts that match what their LLM actually consumes. A count that is off by 10% means the caller either wastes 10% of their context window or overflows it. Different models tokenize differently — the same string produces different token counts under GPT-4's tokenizer, Claude's tokenizer, and Llama's tokenizer.
- **Performance.** Token counting is on the hot path of every lifecycle operation that touches content: `seed`, `add`, `update`, `replace`, `compact`, `split`, and `restore` (cl-spec-001 section 7). A tokenizer that adds 50ms per call makes a 100-segment seed operation take 5 seconds. context-lens must be fast enough to be invisible.
- **Portability.** context-lens is model-agnostic. It cannot hardcode a single tokenizer without locking callers into a single model family. It must support multiple tokenization schemes without requiring the caller to understand tokenization internals.

### Design goals

- **Provider abstraction.** context-lens defines a tokenizer interface. Any function that maps a string to a token count can serve as a provider. Built-in providers cover common cases; callers can supply their own.
- **Sensible defaults.** A caller who does not configure a tokenizer gets a reasonable approximation that works across model families. Zero-config must work — poorly configured is worse than unconfigured.
- **Count once, cache aggressively.** Token counts are deterministic for a given (content, tokenizer) pair. context-lens caches counts and invalidates only when content changes. Metadata-only updates never trigger recount.
- **Accuracy is the caller's choice.** context-lens provides exact providers (model-specific) and approximate providers (fast heuristics). The caller chooses based on their accuracy/performance tradeoff. context-lens documents the error bounds of each provider so the choice is informed.
- **No tokenization of content.** context-lens counts tokens — it does not tokenize. It never needs the actual token sequence, only the count. This distinction matters: some providers can count without materializing the full token array, which is faster and uses less memory.

## 2. Tokenizer Interface

context-lens does not implement tokenization. It delegates to a **provider** — any object that satisfies the tokenizer interface. This section defines that interface: what a provider must do, what it may optionally do, and what metadata it carries.

### 2.1 Core Contract

A tokenizer provider must implement exactly one method:

```
count(content: string) -> number
```

**Input:** a UTF-8 string of arbitrary length (including empty string).

**Output:** a non-negative integer representing the number of tokens the string would produce under this provider's tokenization scheme.

**Constraints:**

- **Deterministic.** The same input must always produce the same output for a given provider instance. This is load-bearing — caching (section 5) depends on it.
- **Pure.** `count` must not mutate state, perform I/O, or have side effects. context-lens may cache its results indefinitely. Per-instance call ordering is sequential (cl-spec-007 §12) — within one context-lens instance the tokenizer sees at most one in-flight call. A tokenizer object shared across multiple context-lens instances may receive concurrent calls from those instances and must remain pure under that pattern.
- **Synchronous.** `count` returns immediately. context-lens does not support async token counting on the hot path. Providers that depend on network calls (e.g., a remote tokenization API) must handle latency internally — prefetch, local cache, or fail.
- **Total.** `count` must return a value for any valid UTF-8 input. It must not throw on unusual content (empty strings, lone surrogates repaired to replacement characters, binary-like content). If the content cannot be meaningfully tokenized, the provider returns a best-effort estimate.

The empty string produces zero tokens. This is an invariant, not a convention — context-lens relies on it for the non-empty segment constraint (cl-spec-001 section 2.2).

### 2.2 Provider Metadata

Every provider carries metadata that context-lens uses for reporting, validation, and accuracy classification:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable identifier (e.g., `"cl100k_base"`, `"approximate-word"`, `"claude-sonnet-4-6"`) |
| `accuracy` | enum | yes | `exact` or `approximate` — see section 7 |
| `modelFamily` | string or null | no | The model family this provider targets (e.g., `"gpt-4"`, `"claude"`, `"llama-3"`). Null for model-agnostic providers. |
| `errorBound` | number or null | no | For approximate providers: the maximum expected relative error as a fraction (e.g., `0.05` for ±5%). Null for exact providers. |

Metadata is declared at provider construction time and is immutable. context-lens exposes it in quality reports and diagnostics (cl-spec-010) so callers can audit which tokenizer produced their counts.

**Validation warning:** If the caller configures a `modelFamily` for their context window that does not match the provider's `modelFamily`, context-lens emits a warning. This catches the common misconfiguration of using a GPT tokenizer with a Claude model. The warning is advisory — context-lens does not block the operation.

### 2.3 Batch Counting

Providers may optionally implement a batch method:

```
countBatch(contents: string[]) -> number[]
```

**Input:** an ordered list of strings.

**Output:** an ordered list of token counts, one per input string. `countBatch(contents)[i] === count(contents[i])` for all `i` — batch results must be identical to individual results.

Batch counting exists for performance. Some providers can amortize setup costs (vocabulary loading, WASM initialization) across multiple calls. The `seed` operation (cl-spec-001 section 7.1) is the primary beneficiary — seeding 50 segments in one batch is faster than 50 individual calls if the provider supports it.

If a provider does not implement `countBatch`, context-lens falls back to sequential `count` calls. The batch interface is an optimization, not a requirement.

### 2.4 Error Handling

Token counting must not fail in a way that leaves context-lens in an inconsistent state. The error contract:

1. **Provider throws.** context-lens catches the error, wraps it with context (which segment, which operation triggered the count), and propagates it to the caller. The triggering lifecycle operation (add, update, etc.) fails atomically — no segment is partially inserted with an unknown token count.
2. **Provider returns negative.** Treated as a provider bug. context-lens throws an error. Negative token counts violate the capacity accounting invariant (cl-spec-001 section 8, invariant 4).
3. **Provider returns non-integer.** context-lens floors the result. Token counts are integers — fractional tokens do not exist. Flooring is preferable to rounding because it errs toward undercount, which is safer for capacity tracking (undercounting leaves headroom; overcounting wastes capacity).
4. **Provider is unreasonably slow.** context-lens does not enforce a timeout — that is the caller's responsibility. However, the performance budget (cl-spec-009) will define latency expectations, and diagnostics (cl-spec-010) report per-operation timing that makes slow providers visible.

## 3. Built-in Providers

context-lens ships a small set of providers that cover common use cases without external dependencies. Exact model-specific counting is supported through adapter patterns that wrap external tokenizer libraries — context-lens provides the glue, the caller provides the library.

### 3.1 Approximate: Character-Class Heuristic

The **default provider**. Ships with context-lens, requires no external dependencies, works for any model family.

**Strategy:** Single-pass character analysis that applies variable ratios based on character class distribution.

```
For each character in content:
  ASCII letter/digit     -> accumulate at ratio 0.25  (≈4 chars per token)
  ASCII punctuation      -> accumulate at ratio 0.50  (≈2 chars per token)
  Whitespace             -> accumulate at ratio 0.00  (absorbed into adjacent tokens)
  CJK unified ideograph  -> accumulate at ratio 1.00  (≈1 char per token)
  Other Unicode          -> accumulate at ratio 0.35  (≈3 chars per token)

Token count = ceil(sum of accumulated ratios)
Minimum: 1 (for non-empty content)
```

The ratios are empirically derived from tokenizer behavior across GPT-4 (cl100k_base), Claude, and Llama 3 tokenizers. They reflect the general pattern: English prose averages ~4 characters per token, punctuation-heavy content (code, JSON) produces more tokens per character, and CJK characters are typically individual tokens.

**Metadata:**

| Field | Value |
|-------|-------|
| `name` | `"approximate-charclass"` |
| `accuracy` | `approximate` |
| `modelFamily` | `null` (model-agnostic) |
| `errorBound` | `0.10` (±10% for English prose and code) |

**Error characteristics:**

| Content type | Typical error | Direction |
|-------------|---------------|-----------|
| English prose | ±5–8% | Slight overcount |
| Code (Python, JS, Rust) | ±8–12% | Slight overcount |
| JSON/structured data | ±10–15% | Overcount (punctuation-heavy) |
| CJK text | ±5–10% | Slight undercount |
| Mixed multilingual | ±10–15% | Variable |

Overcounting is the safer failure mode for capacity tracking — it causes the caller to believe they have less room than they do, which prevents overflow. The heuristic is tuned to err in this direction for the most common content types.

**Why this is the default:** Zero-config callers get a provider that works immediately, requires no dependency installation, runs in O(n) time with no memory allocation beyond a few counters, and produces counts accurate enough for capacity monitoring and eviction ranking. Callers who need exact counts can upgrade to a model-specific provider (section 3.2) without changing any other code.

### 3.2 Exact: Model-Specific Adapters

For callers who need exact token counts, context-lens provides **adapter factories** that wrap external tokenizer libraries. The adapter handles the interface contract (section 2.1); the external library handles the actual tokenization.

context-lens does not bundle these libraries. They are optional dependencies — the adapter factory throws a clear error if the underlying library is not installed.

#### tiktoken Adapter (OpenAI models)

Wraps the `tiktoken` library for OpenAI model families.

```
createTiktokenProvider(encoding: string) -> TokenizerProvider
```

| Encoding | Models | Notes |
|----------|--------|-------|
| `o200k_base` | GPT-4o, GPT-4o-mini | Current default for OpenAI |
| `cl100k_base` | GPT-4, GPT-4-turbo, GPT-3.5-turbo | Previous generation |
| `p50k_base` | text-davinci-003, Codex | Legacy |

**Metadata:** `accuracy: exact`, `modelFamily: "openai"`, `errorBound: null`.

The adapter calls `tiktoken.encode(content).length` internally but exposes only the count. It does not retain or return the token array — consistent with the "count, don't tokenize" design goal (section 1).

#### Generic Adapter

For tokenizer libraries that context-lens does not ship a named adapter for:

```
createCustomProvider(countFn, metadata) -> TokenizerProvider
```

Takes any function matching the `count` signature (section 2.1) and a metadata object (section 2.2). The factory validates that the function satisfies the interface contract — it calls `countFn("")` and asserts the result is `0`, calls `countFn` twice with the same input and asserts determinism.

This is the escape hatch. Claude's tokenizer, Llama's tokenizer, Mistral's tokenizer, a proprietary internal tokenizer — any of them can be wrapped in `createCustomProvider` with a one-line function.

### 3.3 Provider Selection Guidance

| Scenario | Recommended provider | Why |
|----------|---------------------|-----|
| Prototyping / model-agnostic tooling | `approximate-charclass` (default) | No setup, good enough for capacity estimates |
| Production with a single OpenAI model | `tiktoken` adapter with matching encoding | Exact counts, capacity tracking is precise |
| Production with Claude | `createCustomProvider` wrapping Anthropic's tokenizer | Exact counts for Claude's tokenization scheme |
| Multi-model application | `approximate-charclass` or per-model provider switching | Approximation avoids the complexity of per-request provider switching; exact counts require the caller to select the right provider per request |
| Offline analysis / batch processing | Exact provider for the target model | Accuracy matters more than latency in batch |

## 4. Token Counting Operations

Token counts are not computed in isolation — they are triggered by lifecycle operations (cl-spec-001 section 7) and feed into aggregate accounting that drives capacity tracking, quality scoring, and eviction ranking. This section defines when counts are computed, how they flow through the system, and what aggregate values context-lens maintains.

### 4.1 When Counts Are Computed

Every lifecycle operation that introduces or modifies content triggers a token count. Operations that touch only metadata do not.

| Operation | Counting behavior |
|-----------|-------------------|
| `seed(content)` | Count computed for each segment. Batch counting used when seeding multiple segments (section 4.3). |
| `add(content)` | Count computed for the new segment. Single `count(content)` call. |
| `update(id, changes)` | Count recomputed **only if `content` is in `changes`**. Metadata-only updates skip counting entirely. |
| `replace(id, newContent)` | Count recomputed. The old count is discarded and replaced by `count(newContent)`. |
| `compact(id, summary)` | Count recomputed on the summary. context-lens verifies the new count is strictly less than the old count before accepting the compaction (cl-spec-001 section 7.5, invariant 12). |
| `split(id, splitFn)` | Count computed for each child segment. The original segment's count is discarded. The sum of child counts may differ from the original — splitting changes token boundaries. |
| `evict(id)` | No count computation. The existing count is preserved in the `EvictionRecord` for audit and restore. The segment's tokens are subtracted from active aggregates. |
| `restore(id)` | Count recomputed if content was caller-provided (content may differ from the original). If content was retained from eviction, the cached count is reused — the content has not changed, so the count is still valid. |

The asymmetry between evict (no recount) and restore (conditional recount) is intentional. Eviction removes known content — the count is already cached and correct. Restoration may introduce new content (when the caller provides it because the original was discarded), which requires a fresh count.

### 4.2 Single-Segment Counting

The most common path. A lifecycle operation produces a single content string that needs counting.

**Flow:**

```
lifecycle operation
    |
    v
check cache (section 5) ──hit──> return cached count
    |
   miss
    |
    v
provider.count(content) -> rawCount
    |
    v
validate: rawCount >= 0, rawCount is finite
    |
    v
floor(rawCount) -> tokenCount
    |
    v
store on segment, update cache, update aggregates
```

**Cost:** One `count` call per content-mutating operation. For the approximate provider, this is O(n) in content length with negligible constant factors. For exact providers, cost depends on the underlying library — typically O(n) with higher constant factors due to vocabulary lookup and BPE merge operations.

**Failure:** If `count` throws, the lifecycle operation fails atomically. The segment is not inserted, updated, or replaced in a partially-counted state. See section 2.4 for the full error contract.

### 4.3 Batch Counting

The `seed` operation is the primary consumer of batch counting. A typical seed loads 5–50 segments of foundational context in a single call. Counting them individually incurs per-call overhead that batch counting can amortize.

**Flow:**

```
seed([content_1, content_2, ..., content_n])
    |
    v
partition into:
  - cached: contents with existing cache entries
  - uncached: contents needing fresh counts
    |
    v
if provider supports countBatch:
    counts = provider.countBatch(uncached)
else:
    counts = uncached.map(c => provider.count(c))
    |
    v
merge cached + fresh counts
    |
    v
assign to segments, update cache, update aggregates
```

**Atomicity:** If batch counting fails on any input (provider throws), the entire seed operation fails. No segments are partially inserted. This matches the atomic failure guarantee of single-segment counting — the batch is all-or-nothing.

**When batch counting helps:** Providers that perform initialization on each call — loading a vocabulary, initializing a WASM module, allocating encoding buffers — benefit most from batching. The tiktoken adapter, for example, can reuse a single encoder instance across the batch. The approximate provider gains little from batching because it has no per-call setup cost, but the overhead of the batch wrapper is negligible.

**When batch counting does not help:** If all seed contents are already cached (e.g., restarting a session with identical seed content), batching adds no value — all counts come from cache and the provider is never invoked.

### 4.4 Aggregate Accounting

Token counts on individual segments are the source of truth. From them, context-lens derives aggregate values that drive capacity tracking, quality scoring, and reporting.

**Maintained aggregates:**

| Aggregate | Derivation | Updated when |
|-----------|------------|-------------|
| `totalActiveTokens` | Sum of `tokenCount` across all ACTIVE segments | Any segment enters or leaves ACTIVE state, or any ACTIVE segment's content changes |
| `pinnedTokens` | Sum of `tokenCount` across ACTIVE segments with `pinned` protection | A pinned segment is added, removed, or changes content; a segment's protection transitions to or from `pinned` |
| `seedTokens` | Sum of `tokenCount` across ACTIVE segments with `seed` protection | Same pattern as `pinnedTokens` but for seed tier |
| `availableCapacity` | `capacity - pinnedTokens` | `pinnedTokens` changes or `capacity` is reconfigured |
| `utilization` | `totalActiveTokens / capacity` | `totalActiveTokens` or `capacity` changes |
| `groupTokenCount(groupId)` | Sum of `tokenCount` across the group's ACTIVE members | A member's content changes, or a member is added/removed from the group |

**Implementation:** Aggregates are maintained incrementally, not recomputed from scratch. When a segment's token count changes from `oldCount` to `newCount`, the delta `(newCount - oldCount)` is applied to every aggregate the segment participates in. This makes aggregate updates O(1) regardless of the total number of segments.

**Consistency:** Aggregates are updated in the same atomic step as the segment mutation. There is no window where the segment's count has changed but the aggregates reflect the old value. This is critical for capacity tracking — a stale `utilization` value could cause the caller to add content past capacity or evict prematurely.

### 4.5 Capacity Tracking

Token counts are the unit of currency for capacity tracking. context-lens does not enforce capacity limits (soft capacity, cl-spec-001 invariant 14), but it provides the accounting that enables the caller and the eviction advisor to make informed decisions.

**Capacity report fields derived from token counting:**

| Field | Type | Description |
|-------|------|-------------|
| `capacity` | number | Configured maximum tokens (caller-set) |
| `totalActiveTokens` | number | Current token usage |
| `utilization` | number (0.0–1.0+) | `totalActiveTokens / capacity`. Can exceed 1.0 when over capacity. |
| `availableCapacity` | number | `capacity - pinnedTokens`. Tokens available for managed (non-pinned) content. |
| `headroom` | number | `capacity - totalActiveTokens`. May be negative when over capacity. |
| `pinnedTokens` | number | Tokens locked by pinned segments |
| `seedTokens` | number | Tokens used by seed-protected segments |
| `managedTokens` | number | `totalActiveTokens - pinnedTokens`. Tokens that the eviction advisor can potentially reclaim. |

These fields are available on every quality report (cl-spec-002) and as a standalone capacity query via the API (cl-spec-007).

**Over-capacity behavior:** When `totalActiveTokens > capacity`, `headroom` is negative and `utilization` exceeds 1.0. context-lens reports this state but does not block it. The saturation degradation pattern (cl-spec-003) activates, and the eviction advisor (cl-spec-008) begins recommending candidates for removal. The caller decides when and whether to act on those recommendations.

### 4.6 Count Stability

Token counts are stable across the lifecycle of a segment unless its content changes. This guarantee is load-bearing — quality trends, eviction rankings, and capacity reports all assume that a segment's token count does not shift between operations.

**Stability contract:**

1. **Same content, same provider → same count.** Determinism (section 2.1) guarantees this. Two calls to `count` with the same string and the same provider instance return the same value. Caching (section 5) makes this explicit — the count is computed once and reused.
2. **Provider change → counts may change.** If the caller switches providers (e.g., from approximate to exact), all cached counts are invalidated and recomputed. This is a deliberate, caller-initiated action — not a silent drift. See section 5 for invalidation mechanics.
3. **Metadata changes do not affect counts.** Updating a segment's importance, protection, origin, or tags does not trigger recounting. Token count depends only on content and provider.
4. **Content changes always affect counts.** Any operation that modifies content (`update` with content, `replace`, `compact`, `split`) produces a fresh count. The old count is discarded, not averaged or blended with the new one.

**Why this matters:** The eviction advisor ranks candidates partly by token cost — how many tokens evicting a segment would reclaim. If a segment's count could change between ranking and eviction, the advisor's decisions would be based on stale data. Count stability ensures that the token cost seen during ranking is the token cost reclaimed during eviction.

## 5. Caching Strategy

Token counting is deterministic — the same content and the same provider always produce the same count (section 2.1). Caching exploits this to ensure that context-lens never counts the same content twice. Because counting sits on the hot path of every content-mutating lifecycle operation, the cache is not an optimization — it is a design requirement. Without it, operations like `seed` (which may load 50 segments) and quality report generation (which reads every segment's count) would invoke the provider far more often than necessary.

### 5.1 Cache Key Design

The cache maps a **(content hash, provider name)** pair to a token count.

```
key   = hash(content) + ":" + provider.name
value = tokenCount (non-negative integer)
```

**Why hash the content, not use the content directly?** Two reasons:

1. **Memory.** Storing full content strings in the cache would double the memory footprint of large segments. A 10,000-token segment might be 40KB of text — the cache should store a fixed-size hash, not a second copy of the content.
2. **Lookup speed.** Hashing is O(n) in content length, but comparison of fixed-size hashes is O(1). For cache lookups on every lifecycle operation, O(1) comparison matters.

The hash function is the same fast, non-cryptographic hash used for auto-generated IDs (cl-spec-001 section 3.2) — e.g., xxHash64. The full 64-bit hash is used as the cache key (not truncated to 16 hex characters as with IDs) to minimize collision probability within the cache.

**Why include provider name in the key?** The same content produces different token counts under different providers. `"Hello, world!"` might be 4 tokens under cl100k_base and 3 tokens under the approximate provider. The provider name disambiguates — if the caller switches providers, old cache entries are not misapplied to the new provider.

### 5.2 Cache Lifecycle

Cache entries are created, read, and invalidated at specific points in the segment lifecycle.

**Creation (cache miss):**

A cache entry is created whenever the provider is invoked — after a cache miss during any content-mutating lifecycle operation. The entry is written atomically with the segment's `tokenCount` field: there is no state where the segment has a count but the cache does not, or vice versa.

**Read (cache hit):**

Before invoking the provider, context-lens hashes the content and looks up the cache. On a hit, the cached count is used directly — the provider is not called. Cache hits are the common case for:

- **Restore with retained content.** The segment's content has not changed since eviction. The cache entry (created at original insertion) is still valid.
- **Duplicate detection.** When a new segment's content hash matches an existing segment, the count is already cached.
- **Read-only operations.** Quality reports, capacity queries, and eviction ranking read token counts but do not mutate them. These always hit the cache (counts are cached at write time).

**Invalidation:**

Cache entries are invalidated (removed) under two conditions:

1. **Content mutation.** When a segment's content changes (`update` with content, `replace`, `compact`), the old cache entry (keyed to the old content hash) becomes orphaned. It is not explicitly deleted — it simply becomes unreachable because no active segment references that content hash. LRU eviction (section 5.3) reclaims the space eventually. The new content produces a new cache entry.

2. **Provider change.** When the caller switches tokenizer providers, **all** cache entries are invalidated. Every active segment's `tokenCount` is recomputed via the new provider, and new cache entries are created. This is a full recount — an O(n) operation across all active segments. context-lens performs it eagerly (at provider switch time) rather than lazily (on next access) to maintain aggregate consistency. A lazy approach would leave `totalActiveTokens` incorrect until every segment happened to be accessed.

Provider changes are expected to be rare — typically once at initialization or when the caller migrates to a different model family. The cost of a full recount is acceptable for an infrequent operation.

### 5.3 Cache Bounds and Eviction

The cache is bounded to prevent unbounded memory growth in long-running sessions where content continuously changes.

**Sizing:** The cache holds up to `maxCacheEntries` entries (configurable, default: 4096). Each entry is a fixed-size key-value pair — a 64-bit hash, a provider name string, and an integer count. Memory overhead is small even at the upper bound: 4096 entries × ~100 bytes ≈ 400KB.

**Eviction policy:** LRU (least recently used). When the cache is full and a new entry must be inserted, the least recently accessed entry is evicted. LRU is appropriate because:

- Active segments are accessed frequently (every quality report reads their counts). Their cache entries stay hot.
- Evicted segments are not accessed. Their cache entries go cold and are eventually reclaimed.
- Content that has been replaced or compacted is no longer referenced. Its old cache entries go cold naturally.

**Cache eviction is transparent.** Evicting a cache entry does not affect the segment's `tokenCount` field — that field is the authoritative value. The cache entry is merely a shortcut to avoid recomputation. If a cache entry is evicted and the same content is later needed (e.g., restoring a segment), the provider is invoked again and a new cache entry is created.

### 5.4 Cache and Batch Counting

Batch counting (section 4.3) interacts with the cache in a specific way:

1. Before invoking `countBatch`, context-lens checks the cache for each content string in the batch.
2. Content strings with cache hits are removed from the batch — their counts are already known.
3. Only cache-missing strings are passed to the provider's `countBatch`.
4. Results from `countBatch` are written to the cache.

This means a `seed` call with 50 segments where 40 are already cached (e.g., restarting a session with mostly-unchanged seed content) invokes `countBatch` with only 10 strings, not 50. The cache reduces not just the number of provider calls but the total bytes the provider must process.

### 5.5 Cache Diagnostics

The cache exposes diagnostic counters for performance monitoring (cl-spec-010):

| Counter | Description |
|---------|-------------|
| `cacheHits` | Total cache hits since initialization |
| `cacheMisses` | Total cache misses since initialization |
| `cacheHitRate` | `hits / (hits + misses)` — should approach 1.0 in steady state |
| `cacheSize` | Current number of entries |
| `cacheEvictions` | Number of LRU evictions (not segment evictions) |
| `fullRecounts` | Number of provider-change-triggered full recounts |

A low `cacheHitRate` in steady state (after initial seed) indicates either high content churn (expected in some workloads) or a `maxCacheEntries` value that is too small for the workload. Diagnostics make this visible without requiring the caller to instrument their own cache monitoring.

### 5.6 Manual Release

The token count cache supports caller-initiated manual release via the API surface defined in cl-spec-007 §8.9. Three operations apply:

- **`clearCaches('tokenizer')` or `clearCaches('all')`** — drops every cached count. Active segments retain their stored `tokenCount` field (the source of truth — section 4.6, count stability). Subsequent content-mutating operations recount from the active provider and repopulate the cache. The next `assess()` immediately after a clear reads the segment-stored counts and incurs no provider calls; only the next mutation that adds, updates, replaces, compacts, or splits content pays the cache miss.
- **`setCacheSize('tokenizer', size)`** — resizes the cache at runtime. Shrinking evicts least-recently-used entries; growing leaves existing entries unchanged. `size = 0` is permitted and disables the cache (every count becomes a fresh provider call); rarely useful in practice because the cache footprint is small (~400 KB at default) and counting is cheap. cl-spec-007 §8.9.2 documents the per-cache guidance.
- **`getMemoryUsage()`** — reports the current `entries`, `maxEntries`, and `estimatedBytes` for the token count cache. The `estimatedBytes` formula is in cl-spec-009 §6.5.

Manual release does not affect the active provider, the segment-stored `tokenCount` fields, or any aggregate (`totalActiveTokens`, `pinnedTokens`, etc.). The cache is a memoization layer between the provider and the lifecycle operations that produce counts; clearing it forfeits memoization but preserves all other state. Provider lifecycle remains caller-managed (Invariant 14a) — `clearCaches` does not invoke any provider shutdown hook.

## 6. Configuration

Tokenization is configured at context-lens initialization time. The configuration surface is deliberately small — two required decisions (provider and capacity) and a handful of tuning knobs — because misconfiguration here silently corrupts every downstream system that consumes token counts.

### 6.1 Tokenizer Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tokenizer` | `TokenizerProvider` or string | `"approximate"` | The tokenizer provider to use. Accepts a provider object (section 2), or a string shorthand for built-in providers. |
| `capacity` | number | *(required)* | Maximum token count for the context window. No default — the caller must declare their window size. |
| `maxCacheEntries` | number | `4096` | Maximum number of entries in the token count cache (section 5.3). |
| `modelFamily` | string or null | `null` | The target model family. Used for validation warnings (section 2.2) — not for provider selection. |
| `capacityWarningThreshold` | number (0.0–1.0) | `0.50` | Emit a warning when pinned tokens exceed this fraction of `capacity` (cl-spec-001 section 6.2). |

**String shorthands for `tokenizer`:**

| Shorthand | Resolves to |
|-----------|-------------|
| `"approximate"` | Built-in character-class heuristic (section 3.1) |
| `"tiktoken:o200k_base"` | tiktoken adapter with o200k_base encoding (section 3.2). Requires `tiktoken` installed. |
| `"tiktoken:cl100k_base"` | tiktoken adapter with cl100k_base encoding. Requires `tiktoken` installed. |
| `"tiktoken:p50k_base"` | tiktoken adapter with p50k_base encoding. Requires `tiktoken` installed. |

String shorthands are a convenience for common cases. For custom providers, the caller passes a provider object directly.

### 6.2 Capacity Is Required

`capacity` has no default. This is a deliberate design choice, not an oversight.

Every model family has a different context window size — 8K, 32K, 128K, 200K, 1M. A wrong default silently produces incorrect utilization ratios, headroom calculations, and eviction timing. A default of 128K would tell a caller with a 32K window that they have 75% headroom when they are actually at capacity. A default of 8K would trigger premature eviction for a caller with a 200K window.

Forcing the caller to declare capacity ensures they have thought about their window size. The error message when `capacity` is omitted is explicit: *"capacity is required — set it to the token limit of your target model (e.g., 128000 for GPT-4-turbo, 200000 for Claude Sonnet)"*.

### 6.3 Provider Switching

The tokenizer provider can be changed after initialization via:

```
setTokenizer(provider: TokenizerProvider | string) -> void
```

**Effects of switching:**

1. All cache entries are invalidated (section 5.2).
2. Every active segment's `tokenCount` is recomputed using the new provider.
3. All aggregates (`totalActiveTokens`, `pinnedTokens`, `seedTokens`, etc.) are recomputed.
4. Quality scores that depend on token counts (density) are invalidated and recomputed on next report.
5. The `fullRecounts` diagnostic counter is incremented.

Provider switching is an expensive operation — O(n) in the number of active segments. It is designed for rare, deliberate transitions (e.g., migrating from approximate to exact counting after a prototyping phase), not for per-request provider selection.

**Per-request provider selection** (using different tokenizers for different requests in a multi-model application) is not supported at the instance level. Callers needing this should either:

- Use the approximate provider (model-agnostic, good enough for capacity monitoring across models).
- Create separate context-lens instances per model, each with its own provider.

This constraint exists because token counts are cached and aggregated under a single provider identity. Mixing providers within one instance would require per-segment provider tracking, per-segment cache partitioning, and would make aggregates meaningless (you cannot sum counts from different tokenizers and get a coherent total).

**Provider lifecycle is caller-managed.** The tokenizer provider object is supplied by the caller and its lifetime is the caller's responsibility. context-lens holds a reference to the provider for the duration of the session, calls its `count` and `countBatch` methods, and reads its metadata — but it does not create, configure, shut down, or otherwise manage the provider. When a `ContextLens` instance is disposed (cl-spec-015), the library drops its reference to the provider in step 4 of teardown, but it does not invoke any shutdown hook the provider may expose. Providers with their own lifecycle (BPE encoder workers, native bindings, subprocess handles for tiktoken) are shut down by the caller after `dispose()` returns; cl-spec-015 §6.5 specifies the recommended pattern (`dispose()` first, then `await tokenizer.close?.()`). This boundary is intentional and load-bearing — `dispose()` is synchronous (cl-spec-015 §3.5), and embedding it within an async provider-shutdown sequence would force every public method to reason about an "is this instance still being torn down?" race.

### 6.4 Configuration Validation

context-lens validates the configuration at initialization and emits errors or warnings:

**Errors (initialization fails):**

| Condition | Error |
|-----------|-------|
| `capacity` omitted or ≤ 0 | `"capacity is required and must be a positive integer"` |
| `tokenizer` string shorthand not recognized | `"unknown tokenizer shorthand '<value>' — use 'approximate', 'tiktoken:<encoding>', or pass a TokenizerProvider object"` |
| `tokenizer` string references tiktoken but library not installed | `"tiktoken adapter requires the 'tiktoken' package — install it or use the 'approximate' provider"` |
| `tokenizer` object does not satisfy interface (no `count` method) | `"tokenizer must implement count(content: string) -> number"` |
| Provider fails contract validation (`count("") !== 0`) | `"tokenizer.count('') must return 0 — provider '<name>' returned <value>"` |
| Provider fails determinism check | `"tokenizer.count must be deterministic — provider '<name>' returned different values for the same input"` |

**Warnings (initialization proceeds):**

| Condition | Warning |
|-----------|---------|
| `modelFamily` set but does not match `tokenizer.modelFamily` | `"model family mismatch — context targets '<configured>' but tokenizer '<name>' targets '<provider's>'. Token counts may not match actual model consumption."` |
| `capacity` exceeds 2,000,000 | `"capacity <value> is unusually large — verify this matches your model's actual context window"` |
| `maxCacheEntries` < 64 | `"maxCacheEntries <value> is very small — cache hit rate may be low for workloads with many segments"` |

Warnings are surfaced through the diagnostics system (cl-spec-010) and, if the caller has registered a warning handler, through that callback. They do not block operations.

### 6.5 Immutable vs. Mutable Configuration

| Option | Mutable after init? | How to change |
|--------|---------------------|---------------|
| `tokenizer` | Yes | `setTokenizer()` — triggers full recount (section 6.3) |
| `capacity` | Yes | `setCapacity(n)` — updates aggregates, may trigger saturation warnings |
| `maxCacheEntries` | No | Requires reinitialization. Changing cache size at runtime would require rehashing or rebuilding the LRU structure. |
| `modelFamily` | Yes | `setModelFamily(f)` — updates validation warnings only, no recomputation |
| `capacityWarningThreshold` | Yes | Immediate — next pinned-token check uses the new threshold |

Mutable options take effect immediately. There is no "pending configuration" state — when `setCapacity` returns, all aggregates and derived values reflect the new capacity.

## 7. Accuracy Guarantees

Token counts drive capacity tracking, density scoring, and eviction decisions. If counts are wrong, downstream systems are wrong — but "wrong" is a spectrum. A count that is off by 1% is fine for eviction ranking but might matter for a caller packing a window to 99% utilization. A count that is off by 20% is useless for anything.

This section defines what accuracy context-lens guarantees, how accuracy is classified, and what the caller can rely on for each provider class.

### 7.1 Accuracy Classification

Every provider declares its accuracy as one of two classes:

| Class | Meaning | Error bound | Use case |
|-------|---------|-------------|----------|
| `exact` | The count matches what the target model's tokenizer produces | `null` (zero error by definition) | Production systems where capacity must be precise |
| `approximate` | The count is a heuristic estimate with known error characteristics | Provider-declared `errorBound` (section 2.2) | Prototyping, model-agnostic tooling, latency-sensitive paths |

The classification is self-declared by the provider via its metadata. context-lens does not verify accuracy — it cannot, because it does not know the "true" token count (that would require a reference tokenizer, which would defeat the purpose of supporting multiple providers). The classification is a contract between the provider and the caller.

### 7.2 Exact Provider Guarantees

An `exact` provider guarantees:

**For every input string `s`, `provider.count(s)` returns the same value as the target model's native tokenizer applied to `s`.**

This means:

1. **The count matches the model's consumption.** If the caller sends a context window containing segments totaling 100,000 tokens by the exact provider's count, the model will consume exactly 100,000 tokens (modulo prompt formatting overhead that context-lens does not manage — see section 7.4).
2. **Capacity tracking is precise.** `utilization`, `headroom`, and `availableCapacity` reflect actual model-side token usage within the segments context-lens manages.
3. **No error margin is needed.** The caller can fill the window to `capacity` without risk of overflow from counting error. (Overflow from prompt formatting — system prompts, role tokens, message separators — is the caller's responsibility to account for.)

**What "exact" does not mean:**

- It does not mean the provider accounts for special tokens (BOS, EOS, role markers) that models insert between messages. context-lens counts content tokens only — the tokens in the string the caller provides. Framing tokens are model-specific and outside context-lens scope.
- It does not mean the count is stable across provider versions. If the underlying tokenizer library updates its vocabulary (e.g., a new tiktoken release with a revised encoding), counts may change. This is a provider-level concern, not a context-lens concern.

### 7.3 Approximate Provider Guarantees

An `approximate` provider guarantees:

**For every input string `s`, `provider.count(s)` is within `±errorBound` of the true count for the provider's target content types, where `errorBound` is a relative error fraction.**

For the built-in `approximate-charclass` provider (`errorBound: 0.10`):

```
trueCount * 0.90 ≤ provider.count(s) ≤ trueCount * 1.10
```

for typical content (English prose, code, structured data). The error bound is a statistical guarantee over representative content — individual strings may exceed it, particularly for:

- **Very short strings** (< 10 tokens). Relative error is amplified when the absolute count is small. A 1-token error on a 3-token string is 33% relative error.
- **Unusual content**. Binary-encoded data, base64 strings, or content dominated by rare Unicode blocks may exceed the declared error bound.
- **Highly repetitive content**. BPE tokenizers exploit repetition — long runs of the same character may tokenize to far fewer tokens than the character-class heuristic predicts.

**What the caller should do with the error bound:**

- **Capacity planning:** Reserve a margin equal to `errorBound × capacity` tokens. If using the default approximate provider with a 128K window, keep 12,800 tokens (10%) as headroom to avoid overflow from counting error.
- **Eviction ranking:** Approximate counts are sufficient for relative ranking. If segment A is counted at 500 tokens and segment B at 5,000 tokens, the ranking is reliable even with ±10% error — segment B is still ~10× larger.
- **Density scoring:** Density is a ratio (information per token). Approximate counts introduce noise into density scores, but the noise is bounded and consistent (it affects all segments equally), so relative density comparisons remain valid.

### 7.4 What context-lens Does Not Count

Token counts produced by any provider — exact or approximate — cover only the content strings that the caller passes to context-lens. Several categories of tokens are outside scope:

| Category | Whose responsibility | Why it's excluded |
|----------|---------------------|-------------------|
| **System prompt framing** | Caller | Model APIs wrap the system prompt in role tokens, tags, or special formatting. The overhead varies by model and API version. |
| **Message separators** | Caller | Models insert tokens between messages (e.g., `<\|im_start\|>`, `\n\nHuman:`, role headers). These are not part of the segment content. |
| **Tool use formatting** | Caller | Tool calls and results are wrapped in model-specific schemas. The wrapper tokens are outside the content string. |
| **Response tokens** | Not applicable | context-lens manages the input context, not the model's output. Response token budgets are the caller's concern. |

For exact capacity tracking, the caller must account for framing overhead. A practical approach: measure the framing overhead for your model once (send a known content string, observe total tokens consumed via the model's usage report, subtract the content tokens) and subtract that overhead from `capacity` when configuring context-lens.

context-lens reports `headroom` (section 4.5) as raw `capacity - totalActiveTokens`. The caller should interpret headroom as headroom *for content tokens*, not total headroom including framing.

### 7.5 Accuracy in Quality Reports

Quality reports (cl-spec-002) include the active provider's accuracy metadata so the caller can interpret scores with appropriate confidence:

| Report field | Source |
|-------------|--------|
| `tokenizer.name` | Provider metadata |
| `tokenizer.accuracy` | `exact` or `approximate` |
| `tokenizer.errorBound` | Declared error bound (null for exact) |
| `tokenizer.modelFamily` | Target model family (null if model-agnostic) |

This allows downstream consumers of quality reports to make accuracy-aware decisions. An automated eviction system might, for example, add a safety margin to eviction targets when the provider is approximate — evicting 10% more tokens than the target to account for counting uncertainty.

## 8. Invariants and Constraints

The following invariants hold at all times within the tokenization subsystem. Any operation that would violate an invariant is rejected with an error.

### Provider Invariants

1. **Empty string produces zero.** `provider.count("") === 0` for every provider. context-lens validates this at provider construction (section 6.4) and relies on it for the non-empty segment constraint (cl-spec-001 section 2.2). A segment with zero tokens would be invisible to capacity tracking and quality scoring — the empty-string invariant prevents this from happening silently.

2. **Determinism.** `provider.count(s) === provider.count(s)` for any string `s` and any given provider instance. The cache (section 5), aggregate accounting (section 4.4), and count stability guarantee (section 4.6) all depend on this. A non-deterministic provider would produce cache poisoning — a cached count that does not match the count the provider would produce on a fresh call.

3. **Non-negative integer output.** `provider.count(s) >= 0` and `Number.isInteger(floor(provider.count(s)))` for any string `s`. Negative counts violate capacity accounting (cl-spec-001 invariant 4). Non-integer results are floored (section 2.4).

4. **Purity.** `count` has no side effects. context-lens may call it from any context — during a lifecycle operation, during cache population, during a full recount after provider switch — and the result must depend only on the input string.

5. **Batch-single equivalence.** If a provider implements `countBatch`, then `countBatch(contents)[i] === count(contents[i])` for all `i`. Batch counting is an optimization, not an alternative counting path. If results diverge, the system's behavior depends on which path was taken — a source of non-determinism that violates invariant 2 at the system level.

### Cache Invariants

6. **Cache-segment consistency.** For every ACTIVE segment, if a cache entry exists for its `(contentHash, providerName)` pair, the cached value equals the segment's `tokenCount`. There is no state where a cached count and a segment's stored count disagree.

7. **Cache transparency.** Removing any cache entry does not change the result of any operation — it only changes performance. The cache is a pure optimization. The provider is the source of truth; the cache is a memoization layer.

8. **Full invalidation on provider change.** When the provider changes, zero cache entries from the previous provider are consulted. All active segment counts are recomputed from the new provider. No stale cross-provider counts survive.

### Aggregate Invariants

9. **Sum consistency.** `totalActiveTokens === Σ segment.tokenCount` across all ACTIVE segments, at all times. No operation leaves the aggregate out of sync with the individual counts.

10. **Tier consistency.** `pinnedTokens === Σ segment.tokenCount` where `segment.protection === pinned` and `segment.state === ACTIVE`. Same for `seedTokens` with `seed` protection. Tier aggregates reflect the current protection assignments, not historical ones.

11. **Derived consistency.** `availableCapacity === capacity - pinnedTokens`, `utilization === totalActiveTokens / capacity`, `headroom === capacity - totalActiveTokens`, `managedTokens === totalActiveTokens - pinnedTokens`. Derived values are always consistent with their inputs — they are computed, never independently stored.

### Lifecycle Invariants

12. **Atomic count assignment.** No segment exists in an ACTIVE state without a valid `tokenCount`. The count is assigned in the same atomic step as the segment's insertion or content mutation. There is no observable state where a segment is ACTIVE but its count is undefined, pending, or stale.

13. **Compaction reduces tokens.** `compact(id, summary)` requires that the token count of `summary` is strictly less than the current token count of the segment. This is validated after counting `summary` — the compaction is rejected if the count is not reduced (cl-spec-001 invariant 12). The tokenizer is the arbiter: it does not matter if `summary` is shorter in characters; it must be shorter in tokens.

14. **Eviction preserves count.** When a segment is evicted, its `tokenCount` at time of eviction is recorded in the `EvictionRecord`. This count is authoritative for audit and for the continuity dimension of the quality model — it represents the tokens reclaimed by the eviction.

14a. **Caller-owned provider lifecycle.** The tokenizer provider's lifetime is fully owned by the caller. context-lens does not invoke any provider lifecycle hook — no construction, no warmup, no shutdown — at any point in the session, including during `dispose()` (cl-spec-015). When the instance is disposed, the library drops its reference to the provider; the provider's own teardown (worker thread termination, native binding cleanup, subprocess wait, etc.) is the caller's responsibility, performed after `dispose()` returns. (Section 6.3; cl-spec-015 §6.5.)

### Capacity Invariants

15. **Soft enforcement.** Token counts and capacity tracking are reporting mechanisms. No lifecycle operation is blocked because `totalActiveTokens` would exceed `capacity`. context-lens reports the overage; the caller decides. This is inherited from cl-spec-001 invariant 14.

16. **Capacity is positive.** `capacity > 0` at all times. Zero or negative capacity would make `utilization` undefined or nonsensical. Validated at initialization and on `setCapacity`.

## 9. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-001` (Segment Model) | Defines `tokenCount` as a core segment field, computed at insertion and recomputed on mutation. Protection tiers and lifecycle operations that trigger counting. |
| `cl-spec-002` (Quality Model) | Consumes token counts for density scoring. Quality reports include tokenizer accuracy metadata. |
| `cl-spec-003` (Degradation Patterns) | Saturation pattern activates when utilization exceeds capacity — depends on accurate token accounting. |
| `cl-spec-007` (API Surface) | Exposes tokenizer configuration, `setTokenizer`, `setCapacity`, and capacity report fields to the caller. §12 defines the strict-sequential per-instance invocation contract that scopes tokenizer call ordering — anchored in the §2.1 Pure bullet. |
| `cl-spec-008` (Eviction Advisory) | Uses token counts for eviction candidate ranking (token cost) and reclamation targets. |
| `cl-spec-009` (Performance Budget) | Sets latency constraints for token counting operations — informs provider selection guidance. |
| `cl-spec-010` (Diagnostics) | Consumes cache diagnostics (hit rate, evictions, recounts) and provider metadata for observability. |
| `cl-spec-015` (Instance Lifecycle) | Defines `dispose()` and the boundary between library-managed and caller-managed resources. The tokenizer provider falls on the caller-managed side: §6.3 of this spec and §6.5 of cl-spec-015 jointly specify that `dispose()` does not invoke provider shutdown hooks and the caller must shut down providers after `dispose()` returns. Invariant 14a is the canonical statement of this boundary. |

---

*context-lens -- authored by Akil Abderrahim, Claude Opus 4.6, and Claude Opus 4.7*