---
id: cl-spec-005
title: Embedding Strategy
type: design
status: complete
created: 2026-04-01
revised: 2026-04-29
authors: [Akil Abderrahim, Claude Opus 4.6, Claude Opus 4.7]
tags: [embedding, similarity, provider, adapter, fallback, trigram, caching]
depends_on: [cl-spec-002]
---

# Embedding Strategy

## Table of Contents

1. Overview
2. Provider Interface
3. Built-in Providers
4. Embedding Lifecycle
5. Embedding Cache
6. Provider Switching
7. Fallback Behavior
8. Invariants and Constraints
9. References

---

## 1. Overview

The quality model (cl-spec-002) depends on a similarity function for three of its four dimensions. Coherence measures adjacency similarity, topical concentration, and group integrity — all pairwise similarity comparisons. Density detects redundancy by finding maximum similarity to non-adjacent segments. Relevance measures content-to-task similarity against the task descriptor. Only continuity is similarity-independent. The similarity function is the computational foundation of context quality measurement.

cl-spec-002 section 3.2 defined the similarity function's two modes: cosine similarity over embedding vectors (preferred) and Jaccard similarity over character trigrams (fallback). It defined *how similarity is consumed* — the formulas, the caching, the thresholds. It did not define how embedding vectors are produced, where they come from, or what happens when the source changes or fails. That is this spec's job.

### The problem

Embedding models turn text into vectors that capture semantic meaning. Two texts about the same topic produce vectors that are close together (high cosine similarity); two texts about different topics produce vectors that are far apart. This is the foundation of semantic similarity — and it is dramatically better than the trigram fallback at distinguishing "related" from "unrelated" content. `"Authentication flow"` and `"login security"` embed as similar despite sharing no common words. Trigrams would score them as unrelated.

But embeddings have a cost that trigrams do not: they require an embedding model. That model might be a remote API (OpenAI, Cohere, Voyage), a local model (ONNX runtime, transformers.js), or a custom endpoint. Each requires configuration, credentials, or dependencies. context-lens is a monitoring library — it should work out of the box without requiring the caller to set up an embedding pipeline before they can measure context quality.

### Resolution of OQ-005

This spec resolves OQ-005 (embedding model — bundled vs. user-provided):

**context-lens does not bundle an embedding model.** Bundling a model would add significant weight (even a small ONNX model is 30–100MB), force a dependency on a runtime (ONNX, TensorFlow Lite), create a maintenance burden (model updates, security patches), and make an opinionated choice about embedding quality that may not match the caller's needs. context-lens is a lightweight library, not a model distribution vehicle.

**context-lens provides an adapter interface.** The caller configures an embedding provider that implements a minimal contract (one method: embed text → vector). context-lens ships optional adapters for popular providers (OpenAI, generic function wrapper) that implement this contract. The adapter pattern means context-lens defines *what it needs* (vectors) without dictating *how the caller produces them*.

**Zero-config callers get trigrams.** When no embedding provider is configured, context-lens operates entirely on Jaccard character trigram similarity. This is the same zero-dependency philosophy as the approximate tokenizer (cl-spec-006 section 3.1) — coarser but functional, no setup required. Callers who want semantic precision configure a provider; callers who want simplicity get trigrams.

### What this spec defines

- **The embedding provider interface** (section 2) — the contract that any embedding source must implement. One required method, optional batch, self-describing metadata.
- **Built-in providers** (section 3) — the adapters context-lens ships: the implicit no-provider default (trigram mode), an OpenAI adapter, and a generic adapter for arbitrary embedding functions.
- **The embedding lifecycle** (section 4) — what gets embedded, when embeddings are computed, and how embedding integrates with segment lifecycle operations.
- **The embedding cache** (section 5) — how vectors are stored, keyed, bounded, and invalidated. Separate from the similarity cache defined in cl-spec-002.
- **Provider switching** (section 6) — what happens when the caller changes the embedding provider mid-session. Full recomputation semantics.
- **Fallback behavior** (section 7) — how context-lens degrades when no provider is configured or when a configured provider fails. Mode consistency guarantees.

### Design goals

- **Minimal interface.** One required method (`embed`), one optional method (`embedBatch`), one metadata object. The quality model needs vectors — the provider interface asks for vectors and nothing else. No lifecycle hooks, no initialization protocol, no shutdown sequence.
- **Adapter pattern.** context-lens defines the interface; adapters implement it for specific providers. The adapters are optional imports — a caller using only trigrams never loads OpenAI adapter code. A caller using a custom embedding function writes no adapter at all (the generic adapter wraps any function).
- **Caller owns the provider.** context-lens does not make API key decisions, model selection, or billing commitments. The caller creates and configures the provider; context-lens calls `embed` on it. If the provider has costs (API calls, compute), the caller controls them.
- **Single provider per instance.** All embeddings in a context-lens instance use the same provider and model. No mixing — cosine similarity between vectors from different embedding spaces is meaningless. This is enforced structurally (one provider slot) and stated as an invariant in cl-spec-002 (invariant 13, similarity mode consistency).
- **Graceful degradation.** If the provider fails or is not configured, context-lens falls back to trigram similarity. Quality scoring continues — at lower precision, but without interruption. The system never enters a state where similarity cannot be computed.
- **Caching.** Each text is embedded once and the vector is cached. All similarity computations that reference that text reuse the cached vector. Re-embedding happens only when the text changes or the provider changes.

### Embedding is not LLM inference

The no-LLM constraint (cl-spec-002 invariant 9) prohibits calling a language model for quality scoring — it would be circular (using context window tokens to evaluate context window quality) and slow. Embedding models are architecturally distinct from language models. An embedding model maps text to a fixed-size vector; it does not generate text, follow instructions, or consume a context window. Embedding calls are allowed and encouraged — they are the mechanism that gives context-lens semantic understanding without LLM inference.

In practice, some embedding APIs are served by the same providers that serve LLMs (OpenAI's embedding and chat endpoints share a platform). The constraint is on the *type of call*, not the *provider*: embedding calls (text → vector) are allowed; completion calls (text → generated text) are not.

### How embeddings flow through the system

```
Caller
    |
    +--> Configures embedding provider (or not — trigram default)
    |
    v
Embedding Strategy (this spec)
    |
    +--> Produces embedding vectors for segment content and task descriptions
    +--> Caches vectors keyed on (content hash, provider name)
    |
    +--> Quality Model (cl-spec-002)
    |        Computes pairwise similarity using cached vectors
    |        Feeds coherence, density, relevance scoring
    |
    +--> Task Identity (cl-spec-004)
             Uses task description embedding for transition classification
             and relevance scoring
```

The embedding strategy is a **producer** of vectors. The quality model and task identity are **consumers** of vectors. The similarity function (cl-spec-002 section 3.2) sits between them — it takes two vectors and returns a scalar. This spec is concerned with everything upstream of the similarity function: where vectors come from, how they are cached, and what happens when the source changes.

---

## 2. Provider Interface

context-lens does not implement embedding. It delegates to a **provider** — any object that satisfies the embedding provider interface. This section defines that interface: what a provider must do, what it may optionally do, what metadata it carries, and how errors are handled. The interface mirrors the tokenizer provider pattern (cl-spec-006 section 2) — minimal required surface, optional batch, self-describing metadata — adapted for the specific requirements of vector production.

### 2.1 Core Contract

An embedding provider must implement exactly one method:

```
embed(text: string) → number[]
```

**Input:** a UTF-8 string. May be a segment's content (typically 50–5000 characters) or a task description (up to 2000 characters per cl-spec-004 section 2.2). May be empty, though empty segments are rejected by cl-spec-001 section 2.2, so this case arises only through internal edge paths.

**Output:** a vector of floating-point numbers — the embedding representation of the input text. The vector's length must equal the provider's declared `dimensions` (section 2.2). Each element must be a finite number (not NaN, not Infinity).

**Constraints:**

- **Deterministic for identical input.** The same text must produce the same vector from the same provider instance. This is load-bearing — embedding caching (section 5) depends on it. Most embedding models are deterministic by nature (no sampling), but providers that add noise, use approximate inference, or randomize for privacy must document this and accept that caching may serve stale-on-first-call results.
- **Stateless.** `embed` must not depend on previously embedded texts, call ordering, or accumulated state. context-lens may call `embed` in any order, skip calls for cached content, or repeat calls on cache miss. The result must depend only on the input text and the model.
- **Thread-safe.** context-lens may call `embed` from multiple execution contexts if the runtime supports it. The provider must not corrupt internal state on concurrent calls. Providers that are inherently single-threaded (e.g., a local ONNX model on one GPU) should serialize internally rather than relying on context-lens to serialize externally.

Unlike the tokenizer interface (cl-spec-006 section 2.1), `embed` is **not required to be synchronous**. Embedding frequently involves network calls to remote APIs (OpenAI, Cohere, Voyage) or GPU inference for local models — both have inherent latency that cannot be hidden behind a synchronous interface without blocking. The contract is: `embed` returns a Promise that resolves to the vector. context-lens awaits the result before proceeding. From the caller's perspective, lifecycle operations that trigger embedding (addSegment, setTask) are still effectively synchronous — they do not return until the embedding is complete. The async boundary is internal to the provider call, not exposed to the caller.

### 2.2 Provider Metadata

Every provider carries metadata that context-lens uses for caching, validation, and diagnostics:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **Yes** | Unique identifier for this provider instance (e.g., `"openai:text-embedding-3-small"`, `"local:gte-small"`, `"custom:my-model"`). Used as part of the embedding cache key (section 5.1) and in diagnostics. Must be stable across the session — if the name changes, context-lens treats it as a provider switch (section 6). |
| `dimensions` | number | **Yes** | The length of vectors this provider produces. context-lens validates every returned vector against this value (section 2.4). Typical values: 384 (small local models), 768 (BERT-class), 1536 (OpenAI text-embedding-3-small), 3072 (OpenAI text-embedding-3-large). |
| `modelFamily` | string \| null | No | The model family or architecture (e.g., `"openai"`, `"cohere"`, `"gte"`, `"e5"`). Informational — included in diagnostics and quality reports so the caller can audit which model produced their embeddings. Null if unknown or not applicable. |
| `maxInputTokens` | number \| null | No | Maximum input length the model accepts, in tokens. When provided, context-lens truncates content before embedding if it exceeds this limit (section 2.3). When null, content is passed to the provider untruncated — the provider is responsible for handling overlong input. |

Metadata is declared at provider construction and is **immutable** for the lifetime of the provider. context-lens reads metadata once when the provider is registered and relies on it for the duration. If the caller needs different metadata (a different model, different dimensions), they register a new provider, which triggers a provider switch (section 6).

### 2.3 Content Truncation

Embedding models have a maximum input length. Text that exceeds it is either rejected by the model or silently truncated — and silent truncation means the caller does not know that the embedding represents only a prefix of the content. context-lens handles this explicitly when the provider declares `maxInputTokens`.

**When `maxInputTokens` is set:**

Content whose token count (from the configured tokenizer, cl-spec-006) exceeds `maxInputTokens` is truncated to `maxInputTokens` tokens before being passed to `embed`. The truncation is deterministic — same content, same tokenizer, same limit → same truncated text. The full content is retained in the segment; only the text passed to the embedding provider is truncated.

This means the embedding represents a prefix of the content, not the full content. For segments within the token limit (the common case), truncation has no effect. For unusually long segments, the embedding captures the beginning of the content. This is an acceptable tradeoff — long segments are rare (most context window content is conversational turns or tool outputs of moderate length), and prefix embedding is better than provider-side silent truncation or an error.

**When `maxInputTokens` is null:**

Content is passed to the provider untruncated. The provider is responsible for handling overlong input — it may truncate internally, return an error, or process the full text (some models accept very long inputs). context-lens does not intervene.

**Truncated content is cached under the full content's hash.** The cache key is the hash of the original, untruncated content (section 5.1). This is correct: the embedding was produced by this provider for this content. If the content changes (even by one character), the hash changes and the embedding is recomputed. The truncation is a provider-specific preprocessing step, not a content identity transformation.

### 2.4 Validation

context-lens validates every vector returned by the provider. Validation catches provider bugs, API changes, and misconfigured adapters before corrupt vectors enter the cache and produce meaningless similarity scores.

**Per-call validation:**

| Check | Condition | On failure |
|-------|-----------|------------|
| Dimension match | `vector.length === metadata.dimensions` | Provider error — the vector is the wrong size. Likely a configuration mismatch (wrong `dimensions` in metadata) or a provider bug. The embedding is not cached. The operation propagates the error. |
| Finite values | Every element is a finite number (`!isNaN(x) && isFinite(x)`) | Provider error — NaN or Infinity in a vector would corrupt every cosine similarity computation. The embedding is not cached. The operation propagates the error. |
| Non-zero vector | At least one element is non-zero | Warning (not error) — a zero vector produces NaN in cosine similarity (division by zero in normalization). context-lens stores the vector but flags it in diagnostics. The zero vector case can arise legitimately for empty or whitespace-only inputs with some models. |

Validation runs on every `embed` call result, including cached results revalidated on cache hit (no — cached results are trusted; validation runs only on fresh embeddings from the provider). The cost is O(d) where d is the vector dimension — a single pass over the vector. For d=3072 (the largest common dimension), this is microseconds.

### 2.5 Batch Embedding

Providers may optionally implement a batch method:

```
embedBatch(texts: string[]) → number[][]
```

**Input:** an ordered list of strings.

**Output:** an ordered list of vectors, one per input string. `embedBatch(texts)[i]` must be identical to `embed(texts[i])` for all `i` — batch results must match individual results. This is a correctness requirement, not a guideline. context-lens may mix batch and individual calls based on cache state (some texts hit cache, others need embedding), and the results must be consistent.

Batch embedding exists for performance. Remote API providers (OpenAI, Cohere) support batch embedding endpoints that amortize HTTP overhead and may offer better throughput. Local models can batch GPU inference. The primary beneficiaries are:

- **Seed operations** (cl-spec-001 section 7.1) — seeding 20–50 segments at session start. Batching reduces round-trips from 50 to 1 (or a few, depending on provider batch size limits).
- **Provider switching** (section 6) — re-embedding all active segments when the provider changes. Batching is critical here — re-embedding 100 segments one at a time with a remote API is slow; batching makes it practical.

If a provider does not implement `embedBatch`, context-lens falls back to sequential `embed` calls. The batch interface is an optimization, not a requirement. The fallback loop is:

```
async function embedBatchFallback(provider, texts) {
    return Promise.all(texts.map(text => provider.embed(text)))
}
```

Parallel `embed` calls (via `Promise.all`) rather than sequential — this preserves concurrency benefits for providers that can handle multiple in-flight requests (remote APIs) while being equivalent to sequential for providers that serialize internally (local GPU models).

**Batch size.** context-lens does not impose a maximum batch size. The provider is responsible for chunking if its underlying API has a batch limit. Adapters (section 3) handle this — the OpenAI adapter, for instance, chunks batches to the API's per-request limit and concatenates results.

### 2.6 Error Handling

Embedding can fail. Remote APIs return errors (rate limits, timeouts, authentication failures). Local models throw on out-of-memory or corrupt input. The error contract defines how failures propagate:

**1. Provider throws on `embed`.** context-lens catches the error, wraps it with context (what text was being embedded, which operation triggered it, which segment or task descriptor), and propagates it to the caller. The triggering lifecycle operation (addSegment, setTask, etc.) fails atomically — no segment is partially inserted with a missing embedding. The embedding is not cached.

context-lens does **not** retry. Retry strategy (exponential backoff, jitter, max attempts) is the provider's responsibility. The adapter layer is the right place for retries — the OpenAI adapter can retry on 429 (rate limit) with exponential backoff; a local model adapter has no reason to retry. context-lens calling `embed` once and propagating the error is the simplest correct contract.

**2. Provider throws on `embedBatch`.** Same as individual `embed` failure — the entire batch fails, no partial results are cached, the triggering operation fails atomically. Providers that want partial success semantics should implement them internally and never throw to context-lens for the successful subset. context-lens treats `embedBatch` as all-or-nothing.

**3. Provider returns invalid vector.** Caught by validation (section 2.4). Treated the same as a throw — the embedding is not cached, the operation fails. The error message includes the validation details (dimension mismatch, NaN element, etc.) to help the caller debug their provider.

**4. Provider is slow.** context-lens does not enforce a timeout on `embed` calls. Timeout policy is the caller's responsibility — they control the provider and know its expected latency. However, embedding latency is visible in diagnostics (cl-spec-010) and contributes to the per-operation timing tracked by the performance budget (cl-spec-009). A persistently slow provider will be visible to the caller through these channels.

**Fallback on failure.** A single `embed` failure does not trigger a mode switch to trigrams. The provider is considered functional until fallback conditions are met (section 7.2). Individual failures propagate to the caller, who can decide whether to retry the operation, ignore the segment, or switch providers.

---

## 3. Built-in Providers

context-lens ships adapter factories for common embedding sources and a generic adapter that wraps any embedding function. These are convenience layers — they implement the provider interface (section 2) so the caller does not have to. No adapter bundles a model, downloads weights, or introduces a required dependency. The adapters are optional imports: a caller using trigram-only mode never loads adapter code.

### 3.1 No Provider (Default)

When no embedding provider is configured, context-lens operates in **trigram-only mode**. All similarity computations use Jaccard character trigram similarity (cl-spec-002 section 3.2). No API keys, no model downloads, no network calls, no external dependencies.

This is not a degraded state — it is the intended operating mode for zero-config callers. Trigram similarity reliably detects strong relatedness (shared vocabulary) and strong unrelatedness (no vocabulary overlap). It misses semantic similarity between lexically distinct texts (`"authentication"` and `"login security"`), which limits the precision of coherence, density, and relevance scoring. For callers who accept this tradeoff in exchange for zero setup, trigram mode is the right choice.

The no-provider default parallels the approximate tokenizer default (cl-spec-006 section 3.1): both follow the same philosophy of "useful out of the box, precise when you opt in."

### 3.2 OpenAI Adapter

Adapter for OpenAI's embedding API. context-lens ships the adapter code; the caller provides their API key and model choice.

```
createOpenAIEmbeddingProvider(options: {
    apiKey: string,
    model?: string,          // default: "text-embedding-3-small"
    baseURL?: string,        // default: "https://api.openai.com/v1"
    dimensions?: number,     // optional: request reduced dimensions (text-embedding-3-* only)
}) → EmbeddingProvider
```

**Why OpenAI gets a named adapter.** OpenAI's embedding API is the most widely used embedding endpoint. A named adapter saves callers from writing the HTTP boilerplate, response parsing, error mapping, rate-limit handling, and batch chunking that a generic wrapper would require. The adapter is a convenience, not a preference — context-lens does not favor OpenAI embeddings over any other source.

**Supported models:**

| Model | Dimensions | Max input | Notes |
|-------|-----------|-----------|-------|
| `text-embedding-3-small` | 1536 (or custom) | 8191 tokens | Default. Good quality/cost ratio. Supports Matryoshka dimension reduction. |
| `text-embedding-3-large` | 3072 (or custom) | 8191 tokens | Higher quality, higher cost and memory. Supports Matryoshka dimension reduction. |
| `text-embedding-ada-002` | 1536 | 8191 tokens | Legacy. Still widely deployed. No dimension reduction. |

The `dimensions` option enables Matryoshka dimension reduction for `text-embedding-3-*` models — requesting a 256-dimension or 512-dimension vector instead of the full 1536 or 3072. Lower dimensions reduce memory usage in the embedding cache (section 5) at the cost of some embedding quality. The adapter sets `metadata.dimensions` to match the requested dimensions.

**The adapter handles:**

- **HTTP transport.** POST to `/embeddings` endpoint. Configurable `baseURL` supports Azure OpenAI, OpenAI-compatible APIs (vLLM, Ollama with OpenAI compatibility mode, LiteLLM), and proxies.
- **Response parsing.** Extracts the embedding vector from OpenAI's response format (`data[0].embedding`).
- **Error mapping.** Maps OpenAI API errors to context-lens error types. 401 (auth) and 403 (forbidden) are permanent failures — the adapter does not retry. 429 (rate limit) is retried with exponential backoff (initial 1s, max 30s, 3 attempts). 500/502/503 (server errors) are retried once. All other errors are propagated immediately.
- **Batch chunking.** OpenAI's embedding API accepts multiple inputs per request (up to 2048). The adapter's `embedBatch` implementation chunks large batches to this limit, issues parallel requests for each chunk, and concatenates results in order.

**Metadata produced:**

| Field | Value |
|-------|-------|
| `name` | `"openai:{model}"` (e.g., `"openai:text-embedding-3-small"`) |
| `dimensions` | Model's native dimensions, or the requested Matryoshka dimensions |
| `modelFamily` | `"openai"` |
| `maxInputTokens` | `8191` |

**Optional dependency.** The adapter imports `fetch` (or the runtime's native HTTP client) — no external SDK dependency. A caller who never imports the OpenAI adapter incurs zero cost.

### 3.3 Generic Adapter

A passthrough adapter for any embedding function the caller provides. This is the escape hatch — it covers local models (ONNX Runtime, transformers.js), custom APIs (Cohere, Voyage, Jina), self-hosted models, or any other embedding source that context-lens does not ship a named adapter for.

```
createEmbeddingProvider(options: {
    embed: (text: string) → Promise<number[]> | number[],
    embedBatch?: (texts: string[]) → Promise<number[][]> | number[][],
    name: string,
    dimensions: number,
    modelFamily?: string,
    maxInputTokens?: number,
}) → EmbeddingProvider
```

The factory wraps the caller's function in the provider interface. It validates the contract at construction:

1. Calls `embed("")` and verifies the result is a vector of the declared dimensions. This catches configuration errors (wrong dimensions, broken function) before the first real embedding call.
2. Calls `embed("test")` twice and verifies the results are identical. This catches non-deterministic providers.
3. Validates metadata: `name` non-empty, `dimensions` positive integer.

If any validation fails, the factory throws with a descriptive error. The caller fixes their function and tries again. Validation at construction is cheaper than debugging mysterious similarity scores later.

**Examples of what the generic adapter wraps:**

- A local ONNX model: `embed: (text) => onnxSession.run({ input: tokenize(text) }).then(r => r.embedding)`
- A Cohere API call: `embed: (text) => cohere.embed({ texts: [text], model: "embed-v4.0" }).then(r => r.embeddings[0])`
- A pre-computed embedding lookup: `embed: (text) => embeddingStore.get(hash(text))` (for callers who embed content externally and cache it)

The generic adapter makes no assumptions about the underlying model. context-lens treats it as a black box — it calls `embed`, validates the output, and caches the result.

### 3.4 Provider Registration

One embedding provider per context-lens instance. The provider is set through the configuration API — either at construction time (recommended) or via a `setEmbeddingProvider` method after construction.

**At construction:**

```
const lens = createContextLens({
    capacity: 128000,
    embeddingProvider: createOpenAIEmbeddingProvider({ apiKey: "..." }),
})
```

When the provider is set at construction, it is available before any segments are added. This is the clean path — all segments are embedded from the start, no retroactive computation needed.

**After construction:**

```
lens.setEmbeddingProvider(createOpenAIEmbeddingProvider({ apiKey: "..." }))
```

Setting a provider after segments have already been added triggers a provider switch (section 6) — all active segments are embedded with the new provider. This is the migration path for callers who start in trigram mode and later upgrade to embeddings, or who switch between providers.

**Removing the provider:**

```
lens.setEmbeddingProvider(null)
```

Setting the provider to null switches from embedding mode to trigram mode. All cached embeddings are discarded. All cached similarity scores that used embedding mode are invalidated. Coherence, density, and relevance scores are invalidated and will be recomputed using trigram similarity on the next quality report. This is the inverse of adding a provider — a full mode switch with complete cache invalidation.

**Why allow null.** The alternative — requiring the caller to create a new context-lens instance to switch to trigram mode — would lose all non-embedding state: segments, token counts, quality baseline, continuity ledger, task state, pattern history. That is disproportionate. Setting the provider to null is a clean downgrade that preserves everything except the embeddings themselves.

**Registration is idempotent for the same provider.** If the caller calls `setEmbeddingProvider` with a provider whose `metadata.name` matches the current provider's name, context-lens treats it as a no-op — no cache invalidation, no recomputation. This allows callers to set the provider defensively (e.g., on every initialization path) without penalty. The check is on `metadata.name`, not object identity — two distinct provider objects with the same name are considered the same provider.

**Provider lifecycle is caller-managed.** The embedding provider object is supplied by the caller and its lifetime is the caller's responsibility. context-lens holds a reference to the provider for the duration of the session, calls its `embed` and `embedBatch` methods, and reads its metadata — but it does not create, configure, shut down, or otherwise manage the provider. When a `ContextLens` instance is disposed (cl-spec-015), the library drops its reference to the provider in step 4 of teardown, but it does not invoke any shutdown hook the provider may expose. Providers with their own asynchronous lifecycle (network connection pools, worker threads, subprocess handles) are shut down by the caller after `dispose()` returns; cl-spec-015 §6.5 specifies the recommended pattern (`dispose()` first, then `await provider.close?.()`). This boundary is intentional and load-bearing — `dispose()` is synchronous (cl-spec-015 §3.5), and embedding it within an async provider-shutdown sequence would force every public method to reason about an "is this instance still being torn down?" race.

---

## 4. Embedding Lifecycle

Embedding is not a standalone operation — it is woven into the segment and task lifecycle. Every content-bearing entity that participates in similarity computation needs a vector (or trigram set). This section defines what gets embedded, when, and how embedding integrates with the lifecycle operations defined in cl-spec-001 and cl-spec-004.

### 4.1 What Gets Embedded

Two types of content are embedded:

**Segment content.** Every active segment's content is embedded for use in pairwise similarity computation (coherence, density) and content-to-task similarity (relevance). The content is the full text of the segment — the same string used for token counting (cl-spec-006 section 4) and stored as the segment's primary data (cl-spec-001 section 2.1). One segment, one embedding.

**Task description.** The current task descriptor's `description` field is embedded for relevance scoring (cl-spec-004 section 6.1). The task description is treated as a virtual segment for embedding purposes — it goes through the same embed path and is cached in the same embedding cache (section 5).

**What is not embedded:**

- **Keywords** — matched via case-insensitive whole-word string search, not similarity (cl-spec-004 section 6.4). Embedding keywords would be wasteful; their value is in exact matching.
- **Metadata fields** (origin, tags, importance) — these are structural signals consumed directly by the quality model's relevance formula (cl-spec-002 section 5.3). They are strings or numbers, not natural language text. Embedding them would produce meaningless vectors.
- **Group identifiers** — groups are organizational, not semantic. Group membership affects coherence scoring through group integrity (cl-spec-002 section 3.5), but the group ID itself is not embedded.

### 4.2 Lifecycle Integration

Embedding is triggered by lifecycle operations that create or change content. The table maps each operation (from cl-spec-001 section 7 and cl-spec-004 section 4.3) to its embedding behavior:

| Operation | Embedding action | Rationale |
|-----------|-----------------|-----------|
| `seed(segments)` | Embed each segment's content. Use `embedBatch` if available. | Seed typically adds 10–50 segments at session start — batch embedding amortizes round-trips. |
| `add(segment)` | Embed the segment's content. | New content enters the window; it needs a vector for similarity computation. |
| `update(id, content)` | Embed the new content. Old embedding remains in cache (keyed on old content hash). | Content has changed; the old vector represents the old text and is no longer the segment's embedding. The old entry is not actively removed from cache — LRU handles cleanup, and another segment with the old content might still reference it. |
| `replace(id, content)` | Same as `update` — embed the new content. | Replace is semantically "new content for this slot." Same embedding behavior as update. |
| `compact(id, content)` | Embed the compacted content. | Compacted content is new text (a summary or reduction). It needs its own vector. |
| `split(id, parts)` | Embed each part's content. Use `embedBatch` if available. | Split produces multiple new segments, each needing an embedding. Batch when possible. |
| `evict(id)` | No embedding action. The cache entry persists (keyed on content hash). | The segment is removed from the window, but its embedding may be useful if the content is restored or if another segment has identical content. LRU may eventually reclaim it. |
| `restore(id)` | Check cache for the content hash. If hit, reuse. If miss, re-embed. | Restore brings an evicted segment back. If the embedding survived in the LRU cache, restoration is free. If not, one embed call. |
| `setTask(descriptor)` | Embed the description on change or refinement. No action on same-task no-op. | Per cl-spec-004 section 6.5. The task description's prepared form must be ready before `setTask` returns. |
| `clearTask()` | Discard the task description's embedding. | No task means no relevance scoring against a description. The embedding is not needed and can be reclaimed. |

### 4.3 Embedding Timing

Embedding is completed within the lifecycle operation that triggers it. When `add(segment)` returns, the segment's embedding is computed and cached. When `setTask(descriptor)` returns, the task description is embedded. The caller never observes a state where a segment exists in the window but lacks an embedding.

This matches the synchronous-from-the-caller's-perspective contract established by token counting (cl-spec-006 section 4) and task preparation (cl-spec-004 section 6.5). The internal `embed` call may be async (section 2.1), but the lifecycle operation awaits it before returning.

**Batch optimization for seed.** The `seed` operation adds multiple segments atomically (cl-spec-001 section 7.1). When an embedding provider with `embedBatch` is configured, context-lens collects all seed segment contents and embeds them in a single batch call. This reduces the number of API round-trips from n to ceil(n / provider batch limit). For a remote provider like OpenAI with 20 seed segments, this is 1 HTTP request instead of 20.

When `embedBatch` is not available, seed falls back to parallel individual `embed` calls (section 2.5) — still concurrent, but one request per segment.

**Cache-aware batching.** Before issuing a batch embed call, context-lens checks the cache for each content hash. Texts that already have cached embeddings (e.g., from a previous segment with identical content) are excluded from the batch. Only cache misses are sent to the provider. This avoids redundant embed calls for duplicate content — relevant for callers who seed overlapping content or restore previously evicted segments.

### 4.4 Trigram Mode Lifecycle

When no embedding provider is configured, the lifecycle is simpler. Instead of embedding, each content-bearing operation computes a character trigram set:

```
trigrams(content) = set of all 3-character substrings of lowercase(content)
```

Trigram sets are computed synchronously and are cheap — O(n) where n is the content length, with no external calls. The trigram set is cached in the same embedding cache infrastructure (section 5), keyed on `(content hash, "trigram")`. The lifecycle integration table (section 4.2) applies identically, with "embed" replaced by "compute trigrams."

The trigram path is invisible to the caller. The same lifecycle operations trigger the same caching behavior — only the underlying computation differs. This is the mode consistency guarantee: whether the provider is configured or not, every active segment and the current task description have a prepared form (embedding vector or trigram set) ready for similarity computation at all times.

---

## 5. Embedding Cache

The embedding cache stores vectors so that each text is embedded at most once per provider. Without caching, every similarity computation would require re-embedding its inputs — for a window with n segments, each quality report would need O(n) embed calls for coherence alone (adjacency pairs), plus O(n) for relevance (each segment against the task). With caching, these reduce to zero embed calls after the initial computation, with calls only for new or changed content.

The embedding cache is separate from the similarity cache defined in cl-spec-002 section 3.2. The embedding cache maps content → vector. The similarity cache maps (vector_a, vector_b) → scalar. They form a two-level pipeline: the embedding cache produces vectors, the similarity cache consumes them. Both exist simultaneously when an embedding provider is configured.

### 5.1 Cache Key

Each cache entry is keyed on a composite of content identity and provider identity:

```
key = (contentHash, providerName)
```

- **`contentHash`** — the same content hash used for segment identity (cl-spec-001 section 3.2). Two segments with identical content have the same hash and share one cache entry. This is the primary deduplication mechanism — if the same tool output appears in three segments, it is embedded once.
- **`providerName`** — from `metadata.name` on the provider (section 2.2). Including the provider name ensures that embeddings from different providers do not collide. If the caller switches from `"openai:text-embedding-3-small"` to `"openai:text-embedding-3-large"`, the new provider's embeddings do not hit stale cache entries from the old provider.

In trigram mode, the provider name component is the literal string `"trigram"`. Trigram sets are cached in the same structure as embedding vectors — the cache is mode-agnostic at the storage level.

### 5.2 Cache Structure

The cache maps keys to prepared forms:

```
(contentHash, providerName) → number[] | Set<string>
```

In embedding mode, the value is a `number[]` — the embedding vector. In trigram mode, the value is a `Set<string>` — the character trigram set. The cache does not enforce a type distinction; it stores whatever the active mode produces.

**Separate from the similarity cache.** The similarity cache (cl-spec-002 section 3.2) maps `(hash_a, hash_b, mode) → similarity score`. It consumes embeddings from the embedding cache to compute similarity, then caches the result. The two caches are independently sized and independently invalidated:

| Cache | Stores | Key | Invalidated by |
|-------|--------|-----|---------------|
| Embedding cache (this section) | Raw vectors or trigram sets | `(contentHash, providerName)` | Provider switch (full clear), LRU eviction |
| Similarity cache (cl-spec-002) | Scalar similarity scores | `(hash_a, hash_b, mode)` | Content change (either segment), provider switch, mode change |

The separation exists because embedding and similarity have different access patterns. The embedding cache is written once per content and read many times (every similarity computation involving that content). The similarity cache is written once per pair and read on subsequent quality reports. Merging them would complicate invalidation — a content change invalidates one embedding but many similarity pairs.

### 5.3 Cache Capacity

The embedding cache is LRU-bounded, following the same pattern as the token count cache (cl-spec-006 section 5).

**Default capacity: 4096 entries.** This matches the token cache default and is sufficient for most context window sizes. A 200K-token window with an average segment size of 500 tokens holds ~400 segments — well within 4096 entries. The extra capacity accommodates evicted segments whose embeddings may be referenced later (on restore) and content deduplication across segments.

**Memory cost.** Each entry is a vector of `metadata.dimensions` floats (8 bytes per float in a standard JavaScript number array, or 4 bytes in a Float32Array):

| Model | Dimensions | Bytes per entry | 4096 entries |
|-------|-----------|----------------|-------------|
| GTE-small, MiniLM | 384 | ~1.5 KB | ~6 MB |
| BERT-base, E5-base | 768 | ~3 KB | ~12 MB |
| OpenAI text-embedding-3-small | 1536 | ~6 KB | ~24 MB |
| OpenAI text-embedding-3-large | 3072 | ~12 KB | ~48 MB |

For trigram mode, entries are sets of strings. A 2000-character segment produces ~1998 trigrams at 3 bytes each — ~6 KB per entry, comparable to a 1536-dimension embedding. Memory cost is similar across modes.

The embedding cache is the largest memory cost of embedding mode. For callers with tight memory budgets, the capacity is configurable — reducing it to 1024 entries cuts memory usage proportionally at the cost of more cache misses (and thus more embed calls) for windows with many segments or frequent content changes.

**LRU eviction policy.** When the cache is full and a new entry must be added, the least recently used entry is evicted. "Used" means read (cache hit during similarity computation) or written (fresh embedding cached). LRU is the right policy because embedding access patterns are recency-biased: active segments are referenced on every quality report, recently evicted segments may be restored, and old evicted segments are unlikely to return.

### 5.4 Cache Invalidation

The embedding cache has a simple invalidation model because embeddings are deterministic: same content + same provider = same vector, always. There is no staleness from time, external state changes, or model drift within a session.

**Content change.** When a segment's content changes (update, replace, compact), the new content is embedded and cached under its new content hash. The old cache entry — keyed on the old content hash — is **not** actively removed. It may still be valid for another segment with the same old content, or for a future restore of the old content. LRU eviction reclaims it naturally if it is never accessed again.

**Provider switch.** Full cache clear (section 6). Every entry was produced by the old provider and lives in the old vector space. None are valid for the new provider.

**No time-based expiration.** Embedding models are deterministic — the same text produces the same vector on every call. There is no reason for a cached embedding to become stale during a session. The model itself might be updated by the provider (OpenAI silently upgrading `text-embedding-3-small`), but within a session, the provider instance is fixed. Cross-session model updates are not a concern because the cache is session-scoped (it lives in memory, not on disk).

**`clearTask` removes the task entry.** When `clearTask` is called (cl-spec-004 section 4.2), the task description's embedding is no longer needed. The cache entry is not actively removed (it is benign and LRU will reclaim it), but the reference from task state to the cached embedding is dropped.

---

## 6. Provider Switching

Switching the embedding provider mid-session is the most expensive operation in context-lens. Every cached embedding is from the old provider's vector space and is meaningless in the new one. Every cached similarity score derived from those embeddings is invalid. Every quality score that depends on similarity must be recomputed. The cost is proportional to the number of active segments — the same O(n) recomputation cost as switching the tokenizer provider (cl-spec-006 section 6).

Provider switching is supported because it must be — callers may start in trigram mode and upgrade to embeddings once they have credentials, switch between models as they experiment, or downgrade to trigrams if their API budget runs out. But it is not cheap, and callers should expect the cost.

### 6.1 Switching Scenarios

Three provider switch scenarios exist. All three trigger the same invalidation cascade (section 6.2), differing only in what the new prepared forms are.

**Trigram → Embedding** (`setEmbeddingProvider(provider)` when no provider was configured)

The caller is upgrading from lexical to semantic similarity. All active segments have trigram sets; none have embedding vectors. The switch computes embeddings for all active segments and the task description (if set). The trigram cache entries are not removed — they are benign and LRU will reclaim them. After the switch, all new similarity computations use cosine similarity over embeddings.

**Embedding A → Embedding B** (`setEmbeddingProvider(newProvider)` when a different provider was configured)

The caller is changing embedding models — perhaps switching from `text-embedding-3-small` to `text-embedding-3-large`, or from an OpenAI model to a local model. Vectors from provider A are in a different embedding space than vectors from provider B — cosine similarity between them is meaningless. All cached embeddings are discarded and all active segments are re-embedded with provider B.

**Embedding → Trigram** (`setEmbeddingProvider(null)`)

The caller is downgrading from semantic to lexical similarity. All cached embeddings are discarded. Trigram sets are computed for all active segments and the task description (if set). After the switch, all similarity computations use Jaccard similarity over trigrams.

### 6.2 Invalidation Cascade

On any provider switch (including same-mode switches, e.g., embedding A → embedding B), the following invalidation steps execute in order:

**Step 1 — Clear the embedding cache.** All entries are discarded. Every cached vector (or trigram set) was produced by the old provider and is invalid for the new one. This is a full clear, not selective — even entries for content that has not changed must be recomputed because the provider has changed.

**Step 2 — Invalidate the similarity cache.** All cached pairwise similarity scores are discarded. These scores were computed from old embeddings (or old trigrams); they are stale. The similarity cache (cl-spec-002 section 3.2) is cleared entirely.

**Step 3 — Invalidate quality scores.** All cached per-segment scores that depend on similarity are invalidated:

| Score | Invalidated? | Reason |
|-------|-------------|--------|
| Coherence (per-segment and window) | **Yes** | Coherence is computed from pairwise similarity (adjacency, topical concentration, group integrity). |
| Density (per-segment and window) | **Yes** | Density is computed from pairwise similarity (max redundancy to non-adjacent segments). |
| Relevance (per-segment and window) | **Yes** | Relevance is computed from content-to-task similarity. |
| Continuity | No | Continuity tracks historical loss from the ledger. It does not depend on similarity. |
| Cached quality report | **Yes** | The report includes scores from all four dimensions; three of four are invalidated. |

**Step 4 — Recompute embeddings for all active segments.** Every segment currently in the window (active, not evicted) is embedded with the new provider (or trigrammed if switching to null). This is the expensive step — O(n) embed calls for n active segments.

If the new provider supports `embedBatch`, context-lens collects all active segment contents, excludes any that hit the new cache (unlikely on a fresh switch, but possible if the cache was pre-warmed), and issues a single batch call. For a window with 100 active segments and a remote provider, this reduces 100 HTTP round-trips to one (or a few, depending on provider batch limits).

If `embedBatch` is not available, context-lens issues parallel individual `embed` calls (section 2.5 fallback).

**Step 5 — Recompute the task descriptor's prepared form.** If a task is currently set (cl-spec-004 section 4.1, ACTIVE state), the task description is embedded (or trigrammed) with the new provider. If no task is set, this step is skipped.

### 6.3 Atomicity

The provider switch is atomic from the caller's perspective. `setEmbeddingProvider` does not return until all five steps are complete — cache cleared, similarities invalidated, scores invalidated, all segments re-embedded, task re-prepared. There is no intermediate state where some segments have old embeddings and some have new ones. The next quality report after the switch uses entirely new embeddings.

If the recomputation fails mid-way (e.g., the new provider throws on the 50th segment out of 100), the switch is rolled back: the old provider is restored, the old cache entries are not recoverable (they were cleared in step 1), but the system falls back to trigram mode until the caller successfully retries the switch. This prevents a half-switched state where some segments are embedded with the new provider and others are missing.

**Why not defer recomputation.** An alternative design would switch the provider immediately and recompute embeddings lazily — on first access, during the next quality report. This would make `setEmbeddingProvider` fast but push the cost to an unexpected place (the next quality report would be slow). The synchronous approach makes the cost explicit: the caller calls `setEmbeddingProvider`, waits for it to complete, and knows the system is fully ready. No surprise latency on the next report.

### 6.4 Same-Provider No-Op

Setting a provider whose `metadata.name` matches the current provider's name is a no-op (section 3.4). No cache invalidation, no recomputation, no state change. This allows callers to call `setEmbeddingProvider` defensively — e.g., on every initialization path — without triggering an expensive switch.

The check is on `metadata.name`, not on object identity or deep equality of the provider. Two distinct provider objects with the same name are assumed to produce the same embeddings. This is correct as long as the name uniquely identifies the model — which is the provider's responsibility (section 2.2). A provider that changes its model without changing its name violates the contract and will produce silently incorrect similarity scores.

---

## 7. Fallback Behavior

context-lens must always be able to compute similarity. If the embedding provider fails, is removed, or was never configured, the system cannot stop scoring — quality reports, pattern detection, and eviction advisory all depend on similarity. The fallback to Jaccard character trigram similarity is the guarantee that similarity is always available. This section defines when fallback activates, what it means for scoring, and how the two modes interact.

### 7.1 Permanent Fallback (No Provider Configured)

When no embedding provider is configured, context-lens operates in trigram-only mode. This is the default — every context-lens instance starts here, and callers who never call `setEmbeddingProvider` remain here for the entire session.

Trigram mode is not a fallback in the degraded sense. It is the intended operating mode for zero-config callers. All quality dimensions function, all degradation patterns detect, all lifecycle operations work. The precision of similarity-dependent scores (coherence, density, relevance) is lower than with embeddings, but the system is fully operational.

There is no recovery from permanent fallback because there is nothing to recover from. The caller is not using embeddings. If they want embeddings, they configure a provider (section 3.4).

### 7.2 Transient Fallback (Provider Failure)

An embedding provider is configured but fails — a network timeout, an API error, a rate limit, an out-of-memory condition on a local model. context-lens must decide: propagate the error, or fall back to trigrams?

**Individual embed failures propagate.** When a single `embed` call fails (the provider throws), context-lens does not silently fall back to trigrams for that one text. The error propagates to the caller as a failed lifecycle operation (section 2.6). The segment is not added, the task is not set, the operation fails atomically. The caller can retry, skip the segment, or take other corrective action.

Silent per-call fallback was rejected because it would violate mode consistency (section 7.3). If one segment is trigrammed while the rest are embedded, similarity scores between them are meaningless — cosine similarity on a vector and Jaccard on a trigram set are not comparable. A single trigram result mixed into an otherwise embedding-based quality report would corrupt all scores involving that segment.

**Persistent failure triggers report-level fallback.** If the embedding provider is configured but a quality report cannot be generated because one or more active segments lack embeddings (their embed calls failed and the embeddings were never cached), context-lens generates the report in trigram mode for that report cycle. This is a temporary degradation, not a provider switch:

- The embedding provider remains configured. context-lens does not call `setEmbeddingProvider(null)`.
- Trigram sets are computed on-the-fly for the segments that need them. These trigram sets are not cached in the embedding cache (they would pollute it with entries keyed under the wrong mode).
- The quality report includes a `similarityMode: "trigram"` indicator and a `fallbackReason` field explaining why embedding mode was unavailable.
- On the next lifecycle operation that triggers an embed call (add, update, setTask), context-lens retries the embedding provider. If it succeeds, subsequent reports resume embedding mode. If it fails, the next report falls back again.

**Why report-level, not segment-level.** The mode consistency invariant (section 7.3) requires that all similarity computations in a single report use the same mode. Falling back at the report level — all trigrams or all embeddings — satisfies this invariant. Falling back per-segment would not.

**Why not automatic provider removal.** context-lens does not remove a failing provider after N consecutive failures. The provider may be experiencing a transient outage (API maintenance, rate limit window, network blip). Automatically removing it would require the caller to re-register it after the outage, which is unnecessary friction. The provider stays configured; context-lens retries on each opportunity; reports degrade gracefully in the meantime.

### 7.3 Mode Consistency

Within a single quality report, all similarity computations use the same mode — either embedding or trigram. A report never mixes cosine similarity (from embeddings) and Jaccard similarity (from trigrams). This is cl-spec-002 invariant 13, restated here because this spec owns the mechanism that enforces it.

**Why mixing is forbidden.** Cosine similarity and Jaccard similarity are different metrics on different representations. They produce scores in the same 0.0–1.0 range but with different distributions and different meanings. Cosine similarity of 0.7 between embeddings indicates strong semantic relatedness. Jaccard similarity of 0.7 between trigram sets indicates extraordinary lexical overlap (near-identical text). Mixing them in a single coherence or density computation would compare incomparable numbers — a segment scored via embedding would appear "more similar" or "less similar" than a segment scored via trigrams for reasons that have nothing to do with the actual content relationship.

**Enforcement.** At report generation time, context-lens checks whether all active segments have embeddings cached. If yes, the report uses embedding mode. If any segment lacks an embedding (provider failure, race condition, cache eviction between embed and report), the report falls back entirely to trigram mode (section 7.2). There is no partial embedding report.

**Mode indicator.** Every quality report includes a `similarityMode` field — either `"embedding"` or `"trigram"`. This tells the caller which mode produced the scores, allowing them to interpret thresholds and scores correctly. Pattern thresholds (cl-spec-003) apply identically regardless of mode, but the caller may want to adjust their expectations or configure different thresholds for different modes.

### 7.4 Similarity Score Compatibility

Embedding similarity and trigram similarity produce scores in the 0.0–1.0 range, but the same "real-world" semantic relationship maps to different numeric scores in each mode. This is a fundamental asymmetry, not a bug — the two modes measure different things (semantic vs. lexical similarity), and no calibration can make them equivalent.

**Practical impact:**

| Scenario | Embedding (cosine) | Trigram (Jaccard) |
|----------|-------------------|-------------------|
| Identical text | 1.0 | 1.0 |
| Same topic, same words | 0.85–0.95 | 0.5–0.8 |
| Same topic, different words | 0.6–0.8 | 0.1–0.3 |
| Unrelated topics | 0.0–0.3 | 0.0–0.1 |

The critical gap is row 3: semantically related content with different vocabulary. Embeddings capture the relationship; trigrams miss it. This is the primary quality difference between the two modes and the reason embeddings are preferred.

**Impact on thresholds.** Degradation pattern thresholds (cl-spec-003) are defined as absolute values on the 0.0–1.0 quality score range. These thresholds were designed to be reasonable for both modes, but they are inherently a compromise:

- In embedding mode, a coherence score of 0.6 means "moderate semantic relatedness" — the window has topical structure. The threshold catches genuine fragmentation.
- In trigram mode, a coherence score of 0.6 means "significant lexical overlap" — the window's segments share vocabulary heavily. Topically related but lexically diverse content would score lower, potentially triggering false coherence warnings.

This asymmetry is acknowledged in cl-spec-002 section 3.2 and cl-spec-004 section 3.3. The thresholds are configurable (cl-spec-003 section 9.1), and callers using trigram mode may want to adjust them downward. context-lens does not adjust thresholds automatically based on mode — that would create a confusing system where the same score means different things depending on configuration. The scores are what they are; the caller interprets them knowing which mode produced them.

**No cross-mode score comparison.** Scores from a report generated in embedding mode are not comparable to scores from a report generated in trigram mode. A coherence score of 0.7 in one report (embedding) and 0.5 in the next (trigram, due to fallback) does not mean coherence dropped — it means the measurement mode changed. The `similarityMode` field on each report allows the caller to detect this. Trend analysis (cl-spec-002 section 9.6, score deltas) should compare only within the same mode; cross-mode deltas are meaningless.

---

## 8. Invariants and Constraints

These invariants are guarantees that the implementation must uphold and that consumers — the quality model, task identity, and the caller — can rely on. Each invariant is testable and references the section that defines it.

**1. Single provider.** At most one embedding provider is active per context-lens instance at any time. All embeddings in the instance are produced by that provider. There is no mechanism to embed some segments with provider A and others with provider B. Cosine similarity between vectors from different embedding spaces is meaningless — single-provider is a correctness constraint, not a simplification. (Section 3.4; cl-spec-002 invariant 13.)

**2. Vector dimension consistency.** Every vector returned by the provider has exactly `metadata.dimensions` components. context-lens validates this on every `embed` call (section 2.4). A dimension mismatch is a provider error that prevents the embedding from being cached or used. All vectors in the cache for a given provider have the same dimensionality.

**3. Embedding is not LLM inference.** The embedding provider computes vector representations (`text → number[]`), not language model completions (`text → generated text`). This is architecturally distinct from the no-LLM constraint (cl-spec-002 invariant 9). Embedding calls are allowed and encouraged; completion calls are prohibited. The constraint is on the type of computation, not the provider's identity — an OpenAI API key may be used for embedding calls but not for chat completion calls within context-lens. (Section 1.)

**4. Cache key determinism.** The same content hashed with the same algorithm produces the same hash. The same hash with the same provider name produces the same cache key. Cache hits are guaranteed for unchanged content with an unchanged provider. This is the foundation of embedding reuse — embed once, reference many times. (Section 5.1.)

**5. Full recomputation on provider switch.** When the embedding provider changes, all cached embeddings are discarded and all active segments are re-embedded with the new provider. No embeddings from the previous provider survive the switch. No similarity scores derived from old embeddings survive the switch. The system is fully consistent with the new provider before `setEmbeddingProvider` returns. (Section 6.2.)

**6. Mode consistency.** Within a single quality report, all similarity computations use the same mode — either embedding (cosine similarity over vectors) or trigram (Jaccard similarity over character trigram sets). A report never mixes modes. This is cl-spec-002 invariant 13, enforced by this spec's fallback mechanism: if any segment lacks an embedding at report time, the entire report falls back to trigram mode. (Section 7.3.)

**7. Fallback always available.** Trigram similarity requires no external provider, no API key, no model, and no dependencies. context-lens can always compute Jaccard character trigram similarity for any text. The system never enters a state where similarity cannot be computed — if the embedding provider is absent, fails, or is removed, trigrams are available. (Section 7.1.)

**8. Lifecycle-synchronous embedding.** When a lifecycle operation that triggers embedding (addSegment, setTask, setEmbeddingProvider) returns, the embedding is computed and cached. The caller never observes a segment in the window that lacks a prepared form. There is no deferred embedding, no "pending" state, no background embedding queue. The internal `embed` call may be async (section 2.1), but the lifecycle operation awaits it. (Section 4.3.)

**9. Provider metadata immutability.** The provider's `name`, `dimensions`, `modelFamily`, and `maxInputTokens` do not change after registration. context-lens reads metadata once and relies on it for the session. If the caller needs different metadata, they register a new provider, which triggers a full provider switch (section 6). A provider that silently changes its dimensions or model would corrupt the cache and produce invalid similarity scores. (Section 2.2.)

**10. Deterministic truncation.** When the provider declares `maxInputTokens` and content exceeds it, context-lens truncates the content before embedding. The truncation is deterministic — same content, same tokenizer, same limit → same truncated text. The cached embedding is keyed on the full content's hash (section 2.3), so truncation is transparent to the cache layer. The full content is retained in the segment; only the text passed to `embed` is truncated.

**11. Caller-owned provider lifecycle.** The embedding provider's lifetime is fully owned by the caller. context-lens does not invoke any provider lifecycle hook — no construction, no warmup, no shutdown — at any point in the session, including during `dispose()` (cl-spec-015). When the instance is disposed, the library drops its reference to the provider; the provider's own teardown (network pool drain, worker thread termination, etc.) is the caller's responsibility, performed after `dispose()` returns. (Section 3.4; cl-spec-015 §6.5.)

---

## 9. References

| Reference | Description |
|-----------|-------------|
| `brainstorm_20260324_context-lens.md` | Origin brainstorm — OQ-005 (bundled vs. user-provided embedding model), initial embedding adapter sketch |
| `cl-spec-001` (Segment Model) | Defines content hashing used for embedding cache keys |
| `cl-spec-002` (Quality Model) | Defines similarity function that consumes embeddings (section 3.2), similarity caching (section 3.2), mode consistency invariant (invariant 13), no-LLM constraint (invariant 9) |
| `cl-spec-003` (Degradation Patterns) | Pattern thresholds operate on similarity scores produced by the embedding or trigram path |
| `cl-spec-004` (Task Identity) | Task description embedding (section 6.1), trigram fallback (section 6.2), preparation caching (section 6.3) |
| `cl-spec-006` (Tokenization Strategy) | Parallel provider abstraction pattern — one required method, optional batch, metadata. Cache structure (LRU, content-hash keyed). Provider switch triggers full recount/recomputation |
| `cl-spec-015` (Instance Lifecycle) | Defines `dispose()` and the boundary between library-managed and caller-managed resources. The embedding provider falls on the caller-managed side: §3.4 of this spec and §6.5 of cl-spec-015 jointly specify that `dispose()` does not invoke provider shutdown hooks and the caller must shut down providers after `dispose()` returns. Invariant 11 is the canonical statement of this boundary. |

---

*context-lens -- authored by Akil Abderrahim, Claude Opus 4.6, and Claude Opus 4.7*
