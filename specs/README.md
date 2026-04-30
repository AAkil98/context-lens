# context-lens — Design Specs

This directory contains the design specs that define the behavioral contract of context-lens. The reference implementation in `../src/` answers to these specs, not the other way around.

If you came here for the code, the repo root has the README, the API surface, and the test suite (977 tests). If you came here for the **thinking** — what problem this solves, why the design looks the way it does, and what tradeoffs were made — read on.

---

## The problem

Everyone managing LLM context windows truncates blind. Token count is the only signal — when the window fills, the oldest stuff (or the longest stuff) gets dropped. But context has *quality* — coherence, density, relevance, continuity — and quality degrades in predictable, detectable ways long before the window fills up. By the time the token count is the alarm, the model has already been operating on a degraded window for some number of turns.

context-lens measures what token counting can't.

---

## The design thesis

Three commitments that shape every spec in this directory:

1. **Quality is measurable from structural signals — no LLM calls required.** Coherence, density, relevance, and continuity each have a defensible structural definition: adjacency similarity, redundancy detection, task-descriptor matching, cumulative loss tracking. Similarity comes from embeddings (optional) or Jaccard character trigrams (zero-config fallback). The whole assessment runs in tens of milliseconds at n ≤ 500.

2. **Eviction is advisory, never automatic.** context-lens reports and ranks. The caller decides what to remove and when. This rules out a class of "the library evicted my system prompt" failure modes and keeps the library composable with whatever orchestration the caller already has.

3. **Degradation has names.** Five base patterns (saturation, erosion, fracture, gap, collapse) classify the modes a context window can fail in, with severity levels and remediation hints. Six compound patterns identify multi-dimensional crises. Custom patterns plug into the same detection framework. "Your window is degrading" is not a useful signal; "your window has Erosion at warning severity, primarily from redundant non-adjacent segments" is.

---

## The 20-minute read

If you only have 20 minutes, read these three in order. They cover the load-bearing ideas; the rest are mechanism.

1. **`01-segment-model.md`** — The foundational data model. What a "segment" is, the dual ID strategy, the four-tier protection model (`pinned` > `seed` > `priority(n)` > `default`), the eight lifecycle operations. ~10 minutes.
2. **`02-quality-model.md`** — The four quality dimensions and how each is scored from structural signals. The baseline mechanism. The composite. ~10 minutes.
3. **`03-degradation-patterns.md`** — The five named patterns, three severity levels with hysteresis, six compound patterns, and the custom-pattern registration mechanism. ~10 minutes.

If those three resonate, the next two to read are **`08-eviction-advisory.md`** (where the quality signal pays off — five-signal ranking, four protection tiers as walls, strategy auto-selection) and **`07-api-surface.md`** (the public contract — what a caller actually touches).

---

## All 14 specs

| # | Spec | Status | What it covers |
|---|------|--------|----------------|
| 01 | Segment Model | complete | Caller-defined units of meaning. Dual ID (caller-assigned or content-hashed). Importance, origin, tags, groups. Four-tier protection model. Eight lifecycle operations (seed, add, update, replace, compact, split, evict, restore). |
| 02 | Quality Model | complete | Four dimensions scored independently from structural signals: coherence (adjacency similarity + topical concentration), density (information ratio = 1 − redundancy), relevance (task descriptor matching), continuity (cumulative loss ledger). Quality baseline. Composite as weighted geometric mean. |
| 03 | Degradation Patterns | complete (amended) | Five base patterns (Saturation, Erosion, Fracture, Gap, Collapse) with three severity levels and hysteresis. Six compound patterns. Custom pattern registration with fail-open error handling. Detection is diagnostic, not prescriptive. |
| 04 | Task Identity | complete | Task descriptor model (description, keywords, related origins/tags). Three-way transition classification (same / refinement / change) via descriptor similarity. Two-state lifecycle (UNSET / ACTIVE) with grace period after task change. |
| 05 | Embedding Strategy | complete | Provider abstraction (`embed(text) → number[]`). Built-in providers: trigram fallback (zero-config), OpenAI adapter, generic adapter. One provider per instance. Five-step invalidation cascade on provider switch. Mode consistency enforced per report. |
| 06 | Tokenization Strategy | complete | Tokenizer abstraction with required `count`, optional `countBatch`, accuracy metadata. Default character-class heuristic (±10%, zero-dep). Adapter pattern for tiktoken et al. LRU token cache. Capacity is required — no default. |
| 07 | API Surface | draft (amended) | The public contract: constructor, segment ops, group ops, task ops, `assess()`, `planEviction()`, provider management, inspection, 24-event system, 13 typed errors, snapshot/restore. Stateful. One instance, one window. Caller-driven mutations only. |
| 08 | Eviction Advisory | draft (amended) | Five-signal weighted ranking (relevance retention, information loss, coherence contribution, importance, age). Four strategies (saturation, erosion, gap, collapse) auto-selected from active patterns. Protection tiers as inviolable walls. Group atomicity. Bridge score for coherence impact. |
| 09 | Performance Budget | draft | Five tiers: queries <1ms, mutations <5ms, assessment <50ms, planning <100ms (n≤500, excluding provider latency). Two O(n²) bottlenecks managed via deterministic stratified sampling at n>200. Per-operation `selfTime` / `providerTime` decomposition. Budgets are advisory. |
| 10 | Report & Diagnostics | draft | `getDiagnostics()` as Tier 1 (<1ms) read-only observability surface. 20-entry report history with rolling 5-report trend analysis. 50-entry pattern history with per-pattern lifecycle tracking. 200-entry session timeline as correlation backbone. Per-operation timing aggregation. |
| 11 | Report Schema | draft | JSON Schema (draft 2020-12) for the three top-level outputs (QualityReport, DiagnosticSnapshot, EvictionPlan). Independent semver versioning, decoupled from library version. Additive-only evolution within major version. Forward-compatible consumers ignore unknown fields. |
| 12 | Fleet Monitor | draft | `ContextLensFleet` for multi-instance setups (multi-agent coordination, swarms). Per-instance reports plus fleet-wide aggregates, degradation hotspots, comparative ranking, capacity overview. Fail-open: one failing instance doesn't break fleet assessment. Read-only consumer. |
| 13 | Observability Export | draft | `ContextLensExporter` as optional OpenTelemetry adapter (separate entry point, peer dep). 9 gauges, 6 counters, 1 histogram, 5 log event types. Push-on-assess via event subscription, no polling. Convention-based naming (`context_lens.*`). |
| 14 | Serialization | draft | `snapshot({ includeContent })` for full or lightweight snapshots. `fromSnapshot(state, config)` static factory with atomic restore, provider change detection, custom pattern matching by name. NOT serialized: provider instances, caches, computed scores, event handlers, custom pattern functions. |

Implementation specs (the per-phase build plans) are in `../impl/`. The tech-stack and overall implementation strategy is in `../IMPLEMENTATION.md`.

---

## What the design deliberately does NOT do

- **No automatic mutation.** No auto-eviction, no auto-compaction, no auto-reorder. The library reports; the caller decides.
- **No LLM calls in scoring.** All quality assessment is structural. Embeddings are an optional optimization, not a requirement.
- **No imposed segment granularity.** A segment is whatever the caller says it is — a turn, a tool call, a document chunk, a system rule.
- **No content interpretation.** context-lens doesn't summarize, doesn't classify topics semantically, doesn't extract entities. It measures structure.
- **No persistence layer.** Snapshots are explicit; the caller chooses when and where to store them.
- **No multi-tenancy in a single instance.** One instance, one window. Multi-instance use is what `ContextLensFleet` is for.

---

## Open questions and known gaps

The design is internally consistent (Phase 1–3 review complete; all blockers resolved, all types reconciled), but it is not finished. Honest list of what's open:

- **Concurrency model is undefined.** The reference implementation is single-threaded by design, but the spec corpus does not state this as a contract or define what happens under concurrent access. Fine for current use; needs to be made explicit.
- **No instance disposal.** No `dispose()` method. Event handlers, caches, and fleet registrations persist until GC. Planned for v0.2.0; spec amendment pending.
- **Fleet serialization is unsupported.** `ContextLensFleet` has no snapshot equivalent. Restoring a fleet means restoring instances individually and re-registering.
- **OTel exporter is not re-attached on restore.** `fromSnapshot()` produces a new instance; the caller must construct a new exporter. Documented but not handled by the API.
- **`assess()` exceeds the 50ms budget at n=500 on the raw path.** Sampling mitigates this in practice; the underlying O(n²) similarity remains. Tighter sampling or incremental similarity is a v0.2.0 candidate.
- **No memory-release guidance.** Embedding cache and similarity cache are LRU-bounded but no spec covers manual cache eviction, downsizing, or release on long-lived instances.

If any of these intersect work you're doing, that is exactly the kind of thing worth a conversation.

---

## How the specs relate

```
01 segment-model ─────┬───────► 02 quality-model ──┬─► 03 patterns ──┬─► 08 eviction
                     │                              │                  │
                     ├───► 06 tokenization          ├─► 04 task        │
                     │                              │                  │
                     │                              └─► 05 embedding   │
                     │                                                 │
                     └─────────────────► 07 api-surface ◄──────────────┘
                                                │
                              ┌─────────────────┼─────────────────┐
                              ▼                 ▼                 ▼
                       09 performance     10 diagnostics    14 serialization
                                                │
                                                ├─► 11 schema
                                                ├─► 12 fleet
                                                └─► 13 observability
```

Spec dependencies are declared explicitly in each spec's `depends_on` frontmatter. Specs 01–06 are the foundation. Spec 07 is the integration point. Specs 08–14 are the surfaces the caller and ecosystem touch.

---

## Reading the specs

Each spec follows the same structure: numbered table of contents, sections by number (`## N. Title`), a References table at the end, and YAML frontmatter declaring `id`, `type`, `status`, `created`, `revised`, `authors`, `tags`, and `depends_on`.

Spec IDs (`cl-spec-001` through `cl-spec-014`) are stable across renames and refactors. Cross-references between specs use the spec ID and section number — never file paths.

---

## Status of this design

The design corpus has been through three review phases (internal consistency, cross-cutting analysis, deliverables sign-off). All blockers resolved. All types reconciled. The reference implementation in `../src/` covers all 14 specs across five build phases — 977 tests passing, all typechecks clean.

The design is not frozen. If you read something that doesn't hold up — a missing edge case, a contradiction, an assumption that breaks under your workload — that is the most useful feedback you can give. Open an issue, send an email, or just write back.

---

*context-lens design specs — authored by Akil Abderrahim, with Claude Opus 4.6 as design collaborator.*
