# context-lens — Next Feature Options

## Context

v0.1.0 is shipped: 977 tests passing, all five implementation phases complete, design specs frozen. `SHIPPING.md` sketches a v0.2.0 (hardening) and v0.3.0 (DX) roadmap but does not pick a next feature to actually start building. This note scopes four candidates and recommends one.

## Candidates

| # | Feature | Scope | Risk | Spec work needed |
|---|---------|-------|------|------------------|
| 1 | `dispose()` on `ContextLens` | Small | Low | Extension to `cl-spec-007` §4 (lifecycle); no new spec |
| 2 | Fleet serialization (`ContextLensFleet.snapshot` / `fromSnapshot`) | Medium | Low | Extension to `cl-spec-014` + `cl-spec-012` |
| 3 | `@madahub/context-lens-tiktoken` adapter package | Medium | Medium | New adapter contract spec (tokenizer provider shape already exists in `cl-spec-006`) |
| 4 | Incremental similarity / tighter sampling for `assess()` at n ≥ 500 | Medium–Large | Medium–High | Extension to `cl-spec-009` (performance budget) |

### 1. `dispose()` lifecycle method

Listed as an Info-severity gap in `SHIPPING.md` §5. Adds a terminal state to `ContextLens` that:

- removes all registered event handlers
- clears tokenizer and embedding caches
- auto-unregisters from any `ContextLensFleet` the instance was added to
- rejects subsequent mutating calls with `InvalidStateError`

Small, well-specified, closes a documented gap. No new spec file — an addendum to `cl-spec-007` §4 and a short impl spec fragment are enough.

### 2. Fleet serialization

`ContextLens.snapshot()` exists per-instance (spec 14) but there is no way to snapshot an entire fleet. Useful for multi-agent setups that want to persist or migrate the whole monitoring surface. Builds directly on existing instance snapshot format — mostly orchestration, not new scoring. Needs a decision on whether fleet-level aggregates (hotspots, ranking) are re-derived on restore or frozen into the snapshot.

### 3. tiktoken adapter

Ships as a new entry point (`@madahub/context-lens-tiktoken`) implementing the `TokenizerProvider` contract against `tiktoken`'s BPE encoders. Real DX win — most LLM consumers already have tiktoken in their dependency graph and currently fall back to the approximate tokenizer. Requires a new package in the monorepo / workspace (or a separate repo), a thin adapter layer, and conformance tests against known tokenization oracles. Good candidate to prototype the adapter contract that v0.3.0 will generalize (OpenAI embeddings, Cohere, etc.).

### 4. Incremental similarity / tighter sampling

Addresses the known `assess@500` budget miss (`SHIPPING.md` §5). The current O(n²) Jaccard adjacency path takes ~300ms at n=500 versus the 50ms budget. Options: tighten the sampling threshold, memoize pairwise similarity across assessments, or compute similarity incrementally on mutation. Interesting engineering but scope risk — touches `similarity.ts`, the assessment pipeline, and caching invariants. Easier to justify after there is a real workload that hits n ≥ 500 in practice.

## Recommendation

Start with **#1 (`dispose()`)**. It is the smallest coherent unit of work, closes a real documented gap, and the mechanics (teardown of caches and event subscribers, fleet auto-unregistration, terminal-state enforcement) surface real design questions about lifecycle that are cheaper to answer now than after v0.2.0 lands features that depend on lifecycle semantics.

If the goal is user-facing impact rather than hardening, pick **#3 (tiktoken adapter)** instead — it is the first concrete DX feature on the v0.3.0 list and validates the adapter pattern the roadmap leans on.

## Proposed next step

Either path wants a short impl spec before coding:

- For #1: extension note under `impl/` (e.g., `impl/I-06-lifecycle.md`) covering terminal state, teardown order, fleet callback, and test matrix.
- For #3: new impl spec `impl/I-06-tokenizer-adapters.md` plus a standalone `specs/` note if the adapter contract warrants a design spec rather than just riding on `cl-spec-006`.

---

*context-lens next-feature proposal -- authored by AAkil98*
