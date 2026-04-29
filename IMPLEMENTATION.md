# context-lens — Implementation Strategy

## 1. Preamble

This document bridges the 14 reviewed design specs to implementation. It defines the technology stack, package structure, module dependency graph, phased build plan, and testing strategy. Phase 1 (Foundation) is specified inline; subsequent phases have dedicated specs in `impl/`.

**Design specs:** `specs/01-segment-model.md` through `specs/14-serialization.md` (reviewed and signed off 2026-04-05)
**Review audit:** `REVIEW_FINDINGS.md` — 126 findings, 8 blockers resolved, 36 types reconciled
**Key resolutions referenced:** R-008 (protectionRelevance clamp/floor), R-177 (assessmentTimestamp replaces wall-clock), R-178 (FNV-1a hash)

---

## 2. Technology Stack

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript 5.x, strict mode | Design specs assume TS. `exactOptionalPropertyTypes` enabled. No `any` in public types. |
| Build | tsup | ESM+CJS dual output, dts generation, esbuild speed (<1s builds), tree-shaking. |
| Tests | vitest + fast-check | Native ESM, property-based testing for invariants, benchmark API for budget validation, built-in coverage. |
| Package format | Dual ESM/CJS | `"type": "module"` in package.json. ESM primary, CJS for legacy consumers. tsup produces both. |
| Package structure | Single package, sub-path exports | `context-lens`, `context-lens/otel`, `context-lens/fleet`. Avoids monorepo overhead. Enrichments extractable later if needed. |
| Peer dependencies | `@opentelemetry/api` (OTel entry point only) | Zero runtime deps for core. |
| Node target | Node 18+ | LTS baseline. No browser target in v1. |

---

## 3. Package Structure

```
context-lens/
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
  IMPLEMENTATION.md          ← this file
  impl/                      ← per-phase implementation specs
    I-02-scoring-engine.md
    I-03-detection-advisory.md
    I-04-api-integration.md
    I-05-enrichments.md
  src/
    index.ts                 ← main entry: ContextLens class + core types
    otel.ts                  ← sub-path entry: context-lens/otel
    fleet.ts                 ← sub-path entry: context-lens/fleet
    types.ts                 ← shared type definitions (36 reconciled types)
    errors.ts                ← 13 typed errors
    events.ts                ← synchronous event emitter
    segment-store.ts         ← segment + group management
    tokenizer.ts             ← provider interface + approximate provider
    similarity.ts            ← trigram + cosine similarity, similarity cache
    embedding.ts             ← provider interface, embedding cache
    task.ts                  ← task descriptor, lifecycle, transitions
    scoring/
      coherence.ts
      density.ts
      relevance.ts
      continuity.ts
      baseline.ts
      composite.ts
    quality-report.ts        ← report assembly, caching, trends
    detection.ts             ← pattern framework, 5 base + compounds + custom
    eviction.ts              ← ranking, strategies, plan assembly
    performance.ts           ← timing, budget checking, sampling config
    diagnostics.ts           ← snapshot assembly, history, timeline
    formatters.ts            ← plain-text report formatting
    serialization.ts         ← snapshot/fromSnapshot
    utils/
      hash.ts                ← FNV-1a
      lru-cache.ts           ← generic LRU
      ring-buffer.ts         ← bounded ring buffer
      copy.ts                ← defensive copy helpers
  test/
    unit/                    ← mirrors src/ structure
    integration/             ← ContextLens class boundary tests
    property/                ← fast-check property-based tests
    bench/                   ← vitest benchmark suite
  schemas/                   ← JSON Schema files (spec 11)
    quality-report.json
    diagnostic-snapshot.json
    eviction-plan.json
```

**Exports map** (package.json):
```json
{
  "exports": {
    ".": { "import": "./dist/index.mjs", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" },
    "./otel": { "import": "./dist/otel.mjs", "require": "./dist/otel.cjs", "types": "./dist/otel.d.ts" },
    "./fleet": { "import": "./dist/fleet.mjs", "require": "./dist/fleet.cjs", "types": "./dist/fleet.d.ts" },
    "./schemas": { "import": "./dist/schemas/index.mjs", "require": "./dist/schemas/index.cjs" }
  }
}
```

---

## 4. Dependency Graph

```
                          ┌─────────┐
                          │  index   │  (ContextLens class — Phase 4)
                          └────┬────┘
          ┌────────┬──────────┼───────────┬──────────────┐
          ▼        ▼          ▼           ▼              ▼
   ┌────────┐ ┌────────┐ ���────────┐ ┌──────────┐ ┌────���───────┐
   │ diag-  │ │format- │ │ evic-  │ │detection │ │performance │
   │nostics │ │ ters   │ │ tion   │ │          │ │            │
   └───┬────┘ └────────┘ └───┬────┘ └────┬─────┘ └──────┬─────┘
       │                     │            │              │
       └─────────┬───────────┘            │              │
                 ▼                        ▼              │
          ┌──────────────┐         ┌──────────┐          │
          │quality-report│         │ scoring/ │◄─────────┘
          └──────┬───────┘         │ (4 dims) │
                 │                 └────┬─────┘
       ┌─────────┼──────────┐          │
       ▼         ▼          ▼          ▼
  ┌────���────┐ ┌──────┐ ┌──────────┐ ┌──────────┐
  │embedding│ │ task  │ │similarity│ │ baseline │
  └────┬────┘ └──┬───┘ └────┬─────┘ └──────────┘
       │         │          │
       └─────────┴──────────┘
                 │
       ┌─────────┼──────────┐
       ▼         ���          ▼
  ┌─────────┐ ┌──────────┐ ┌──────┐
  │ segment │ │tokenizer │ │events│
  │  store  │ │          │ │      │
  └────┬────┘ └────┬─────┘ └──┬───┘
       │           │          │
       └─────────┬─┴──────────┘
                 ▼
          ┌──────────┐
          │  utils/  │  (hash, lru-cache, ring-buffer, copy)
          └──────────┘
          ┌──────────┐
          │  errors  │  (no deps, imported by all)
          └──────────┘
          ┌���─────────┐
          │  types   │  (no deps, imported by all)
          └─────────��┘
```

**Enrichments** (separate entry points, depend only on `index`):
```
  otel.ts  ──► index (event subscription, report reading)
  fleet.ts ──► index (assess, getCapacity, getSegmentCount)
  serialization.ts ���─► index (internal state access)
```

**Rules:**
- No circular imports
- No upward imports (lower layers never import higher layers)
- `utils/`, `errors`, `types` are imported by any module
- `scoring/*` modules import `similarity` and `utils/` but not each other
- Enrichments import only from `index` (public API) — no internal module access

---

## 5. Phase Breakdown

| Phase | Scope | Modules introduced | Design specs | Impl spec |
|:-----:|-------|--------------------|--------------|-----------:|
| **1** | Foundation + infrastructure | `types`, `errors`, `events`, `utils/*`, `segment-store`, `tokenizer` | 01, 06, 07 (partial) | inline below |
| **2** | Similarity + scoring engine | `similarity`, `embedding`, `task`, `scoring/*`, `baseline`, `quality-report` | 02, 04, 05 | `I-02` |
| **3** | Detection + advisory + perf | `detection`, `eviction`, `performance` | 03, 08, 09 | `I-03` |
| **4** | Public API + diagnostics | `index` (ContextLens), `diagnostics`, `formatters` | 07, 10 | `I-04` |
| **5** | Enrichments | `serialization`, `schemas/*`, `fleet`, `otel` | 11, 12, 13, 14 | `I-05` |
| **6** | Instance lifecycle (v0.2.0) | `lifecycle`, modifications to `errors`, `events`, `index`, `fleet`, `otel` | 15, 07/12/13/14 amendments | `I-06` |

Phases 1–5 ship in v0.1.0. Phase 6 is the first v0.2.0 phase; it adds `dispose()`, `isDisposed`, `isDisposing`, the `stateDisposed` event, `DisposedError` / `DisposalError`, and the integration registry that lets fleets and OTel exporters auto-detach on instance disposal. Each phase produces independently testable modules. No phase ships partial modules.

---

## 6. Design-Spec-to-Module Mapping

| Design spec | Primary module(s) | Notes |
|-------------|-------------------|-------|
| 01 Segment Model | `segment-store` | 1:1 mapping. Groups, protection, lifecycle all here. |
| 02 Quality Model | `scoring/*`, `quality-report`, `similarity` | Largest spec, splits into ~8 sub-modules. |
| 03 Degradation Patterns | `detection` | 5 base patterns + compounds + custom registration. |
| 04 Task Identity | `task` | Descriptor, transitions, grace period, staleness. |
| 05 Embedding Strategy | `embedding` | Provider interface, cache, fallback. |
| 06 Tokenization Strategy | `tokenizer` | Provider interface, approximate provider, cache. |
| 07 API Surface | `index` (ContextLens class), `types`, `errors`, `events` | Integration layer. Types/errors/events extracted to Phase 1. |
| 08 Eviction Advisory | `eviction` | Ranking, strategies, plan assembly. |
| 09 Performance Budget | `performance`, sampling logic in `scoring/*` | Budget checking in `performance`; sampling thresholds wired into scorers. |
| 10 Report & Diagnostics | `diagnostics`, `formatters` | History, timeline, formatting. |
| 11 Report Schema | `schemas/` | JSON Schema files + validation. |
| 12 Fleet Monitor | `fleet` (sub-path export) | ContextLensFleet class. Phase 6 adds the `instanceDisposed` event and the auto-unregister callback. |
| 15 Instance Lifecycle | `lifecycle` (internal), modifications to `index`, `errors`, `events`, `fleet`, `otel` | Phase 6 (v0.2.0). Internal `IntegrationRegistry`, `dispose()` orchestrator, disposed-state guard. Touches every module that takes part in teardown. |
| 13 Observability Export | `otel` (sub-path export) | OTel adapter, peer dep on `@opentelemetry/api`. |
| 14 Serialization | `serialization` | snapshot/fromSnapshot. |

---

## 7. Testing Strategy

### Unit tests
One test file per module in `test/unit/`, mirroring `src/` structure. Tests exercise module contracts in isolation, mocking dependencies where needed.

**Invariant coverage:** The 14 design specs define ~160 invariants. Unit tests cover these by category:
- **Structural invariants** (unique IDs, ordering, group atomicity) → `segment-store.test.ts`
- **Scoring invariants** (scores in [0,1], determinism, empty window) → `scoring/*.test.ts`
- **Detection invariants** (determinism, side-effect freedom, fail-open) → `detection.test.ts`
- **Budget invariants** (tier compliance, deterministic sampling) → `performance.test.ts`

### Integration tests
In `test/integration/`, exercising the ContextLens class boundary. Full add-assess-plan-evict flows.
- Seed → add → assess → verify scores and patterns
- Task set → assess → gap detection → task clear
- Provider switch → score invalidation → reassessment
- Eviction plan → execute plan → verify continuity tracking

### Property-based tests
Using fast-check via vitest. In `test/property/`.
- **Score bounds:** all dimension scores in [0.0, 1.0] for any segment content
- **Determinism:** same inputs → same outputs across repeated calls
- **Monotonicity:** eviction candidates ordered by tier then score
- **Composite collapse:** one zero dimension → composite zero (geometric mean property)
- **Protection inviolability:** pinned segments never appear in eviction plans

### Performance benchmarks
Using vitest `bench()`. In `test/bench/`.
- Budget tier validation: measure each operation category against spec 09 targets
- Scaling: benchmark assess() at n=100, 200, 500, 1000 with trigrams
- Sampling threshold: verify O(n^1.5) at n>200 vs O(n^2) without sampling

### Schema conformance
Snapshot tests in `test/unit/schemas/`.
- `toJSON(assess())` validates against `quality-report.json`
- `toJSON(getDiagnostics())` validates against `diagnostic-snapshot.json`
- `toJSON(planEviction())` validates against `eviction-plan.json`

---

## 8. Cross-Cutting Concerns

### Defensive copies
All public API inputs and outputs are deep-copied at the boundary. Internal modules pass references for performance. The copy boundary is `index.ts` (ContextLens class methods). Implementation: `utils/copy.ts` exports `deepCopy<T>(value: T): T` using structured clone or manual copy for known types.

### Timestamp strategy
No module calls `Date.now()` during scoring or detection. Instead:
- `assess()` captures `assessmentTimestamp = Date.now()` once at call start
- This timestamp flows to all scorers (recency in relevance, age in eviction)
- The timestamp is stored in the QualityReport as `timestamp`
- Per R-177: determinism is preserved because scoring depends on the report's timestamp, not the system clock

### Content hashing
FNV-1a (per R-178) for all non-cryptographic hashing:
- Auto-generated segment IDs: `"auto:" + fnv1a(content).toString(36).slice(0, 12)`
- Token cache keys: `fnv1a(content) + ":" + providerName`
- Embedding cache keys: `fnv1a(content) + ":" + providerName`
- Similarity cache keys: `fnv1a(id1 + "\0" + id2)` (ordered pair)
- Sampling seed: `fnv1a(sortedSegmentIds.join("\0"))`

### Error propagation
- Segment operations throw typed errors (13 types from spec 07 §10). Caller catches.
- Provider errors are caught at the boundary and wrapped in `ProviderError`.
- Custom pattern errors are caught by the detection framework and handled fail-open (spec 03 §10.5).
- Event handler errors are caught and swallowed (spec 07 §9.3).

### Event ordering
Events fire synchronously, inline with the operation that triggers them. Order within a single operation is deterministic (e.g., `segmentEvicted` fires before `groupDissolved` when evicting the last member of a group). Re-entrant calls from handlers produce undefined behavior (documented in spec 07).

---

## 9. Conventions

### Naming
- Functions and methods: `camelCase` (`addSegment`, `computeCoherence`)
- Types and classes: `PascalCase` (`ContextLens`, `QualityReport`, `SegmentScore`)
- Constants: `SCREAMING_SNAKE` (`DEFAULT_CACHE_SIZE`, `MAX_RING_BUFFER_SIZE`)
- Files: `kebab-case` (`segment-store.ts`, `quality-report.ts`, `lru-cache.ts`)

### Exports
- Named exports only. No default exports.
- Each module has a barrel export at the top of the file.
- `index.ts` re-exports the public API surface (ContextLens class + all public types).
- Internal modules are not re-exported from `index.ts`.

### Documentation
- JSDoc on all public types and methods (the ones re-exported from `index.ts`).
- No JSDoc on internal functions unless logic is non-obvious.
- Design spec references in JSDoc: `@see cl-spec-002 §5.4` format.

---

## 10. Phase 1 — Foundation and Infrastructure

### 10.1 Scope

Phase 1 produces the base layer that all subsequent phases build on: shared types, error hierarchy, event system, utility data structures, the segment store, and the tokenizer subsystem. After Phase 1, a caller can construct a minimal instance, add segments, query capacity, and receive events — but cannot score quality or detect patterns.

**Produces:** `types.ts`, `errors.ts`, `events.ts`, `utils/*`, `segment-store.ts`, `tokenizer.ts`
**Does NOT produce:** Quality scoring, pattern detection, task management, embedding, reporting, serialization.

### 10.2 Module specifications

#### `types.ts` — Shared type definitions

All 36 reconciled types from the design review (REVIEW_FINDINGS.md type reconciliation table). Organized by domain:

**Segment domain:** `Segment`, `Group`, `ProtectionLevel`, `SegmentState`, `GroupState`
**Quality domain:** `QualityReport`, `WindowScores`, `SegmentScore`, `GroupScore`, `ContinuitySummary`, `TrendData`, `BaselineSnapshot`, `RedundancyInfo`, `ContinuityEvent`
**Detection domain:** `DetectionResult`, `ActivePattern`, `PatternSignature`, `RemediationHint`, `CompoundContext`, `PatternDefinition`, `Severity`, `PatternName`, `CompoundName`, `TrendDirection`
**Task domain:** `TaskDescriptor`, `TaskState`, `TaskTransition`, `TaskSummary`, `TransitionType`, `TaskLifecycleState`, `TransitionEntry`
**Capacity domain:** `CapacityReport`, `TokenizerMetadata`
**Eviction domain:** `EvictionPlan`, `EvictionCandidate`, `CompactionRecommendation`, `StrategyName`, `RemediationAction`
**Diagnostics domain:** `DiagnosticSnapshot`, `ReportSummary`, `TimelineEntry`, `PerformanceSummary`, `PatternSummary`, `TimelineEventType`
**Provider domain:** `TokenizerProvider`, `EmbeddingProvider`, `EmbeddingProviderMetadata`
**Serialization domain:** `SerializedState`, `FleetReport`

Types are defined as TypeScript interfaces and type aliases. Enums are string union types (not TS enums).

#### `errors.ts` — Error hierarchy

Base class `ContextLensError` extends `Error` with `code: string` and `details?: Record<string, unknown>`.

12 subclasses, each with a fixed `code` constant:
`ConfigurationError`, `ValidationError`, `SegmentNotFoundError`, `GroupNotFoundError`, `DuplicateIdError`, `InvalidStateError`, `ProtectionError`, `MembershipError`, `CompactionError`, `SplitError`, `RestoreError`, `ProviderError`

#### `events.ts` — Synchronous event emitter

**Responsibilities:**
- Type-safe `on(event, handler)` → unsubscribe function
- Synchronous `emit(event, payload)` — handlers run inline
- Re-entrancy detection: if `emit` is called during handler execution, log warning (not throw)
- Handler error isolation: catch and swallow (no propagation to caller)

**Design decisions:**
- Generic `EventEmitter<EventMap>` where `EventMap` maps event names to payload types
- Not using Node's `EventEmitter` — custom implementation for type safety and re-entrancy guard
- 24 events defined in the EventMap type (from spec 07 §9.2)
- `once(event, handler)` convenience method

#### `utils/hash.ts` — FNV-1a

- `fnv1a(input: string): number` — 32-bit FNV-1a hash
- `fnv1aHex(input: string): string` — hex-encoded hash
- Deterministic, zero dependencies, fast

**Why 32-bit:** Sufficient for cache keys and sampling seeds. 64-bit would require BigInt, adding overhead for no benefit in this context (we're not doing collision-resistant hashing).

#### `utils/lru-cache.ts` — Generic LRU cache

- `LruCache<K, V>` class with `maxSize: number` constructor parameter
- `get(key: K): V | undefined`
- `set(key: K, value: V): void`
- `has(key: K): boolean`
- `delete(key: K): boolean`
- `clear(): void`
- `size: number` (getter)
- `entries(): IterableIterator<[K, V]>` (for iteration, e.g., during provider switch recount)

**Implementation:** Doubly-linked list + Map for O(1) get/set/delete. Standard LRU algorithm.

**Used by:** Token cache (Phase 1), embedding cache (Phase 2), similarity cache (Phase 2).

#### `utils/ring-buffer.ts` — Bounded ring buffer

- `RingBuffer<T>` class with `capacity: number` constructor parameter
- `push(item: T): void` — appends; evicts oldest if at capacity
- `toArray(): T[]` — returns items in insertion order (oldest first)
- `get(index: number): T | undefined` — access by logical index
- `size: number` (getter)
- `clear(): void`

**Used by:** Report history (20), pattern history (50), session timeline (200), transition history (20).

#### `utils/copy.ts` — Defensive copy helpers

- `deepCopy<T>(value: T): T` — deep clone for public API boundaries
- Uses `structuredClone` where available (Node 17+), manual recursive copy as fallback
- Handles: plain objects, arrays, Date, null, primitives, Map, Set
- Does NOT handle: functions, class instances with methods, circular references (not needed per spec 07 invariant 4)

#### `segment-store.ts` ��� Segment and group management

**Responsibilities:**
- Segment CRUD: create, read, update, replace, compact, split, evict, restore
- Group management: create, dissolve, get, list
- ID management: caller-assigned or auto-generated (FNV-1a of content)
- Protection tier enforcement: pinned cannot be evicted/compacted/split
- Position tracking: insertion order, stable across operations
- Capacity tracking: token accounting (delegates counting to tokenizer)
- State machine: ACTIVE ↔ EVICTED transitions
- Event emission: fires segment/group events via injected emitter

**Key data structures:**
- `Map<string, InternalSegment>` for active segments (O(1) lookup by ID)
- `Map<string, InternalSegment>` for evicted segments (separate map, not mixed)
- `Map<string, InternalGroup>` for groups
- Ordered array or linked structure for position tracking

**InternalSegment** extends `Segment` with internal fields not exposed publicly:
- `position: number` (insertion order index)
- `contentHash: string` (FNV-1a of content, for dedup and cache keys)

**Key design decisions:**
- The segment store does NOT compute quality scores. It manages data and metadata.
- Token counting is delegated: the store calls `tokenizer.count(content)` on insert/update/replace/compact.
- Events are emitted synchronously within each operation, before the operation returns.
- Group protection overrides member protection for eviction decisions (spec 01 §5.2).
- Compaction asserts `newTokenCount < oldTokenCount` (spec 01, compaction invariant).
- Split replaces at original position, children get auto-generated IDs with `parent:N` suffix.

**Depends on:** `types`, `errors`, `events` (injected), `tokenizer` (injected), `utils/hash`, `utils/copy`

#### `tokenizer.ts` — Tokenization subsystem

**Responsibilities:**
- Provider interface definition (`TokenizerProvider`)
- Built-in approximate provider (character-class heuristic)
- Token count caching via LRU (keyed on `contentHash:providerName`)
- Provider switching: clear cache, recount all active segments
- Capacity reporting: compute `CapacityReport` from segment store state
- Metadata exposure: `getTokenizerInfo() → TokenizerMetadata`

**Approximate provider algorithm:**
Single-pass character classification:
```
ASCII letter/digit:  0.25 per char
ASCII punctuation:   0.50 per char
Whitespace:          0.00 per char
CJK ideograph:       1.00 per char
Other Unicode:       0.35 per char
Result: ceil(sum), minimum 1 for non-empty
```

**Key design decisions:**
- Cache key is `fnv1a(content) + ":" + providerName`, not full content (memory-efficient)
- Provider switch triggers full recount of all active segments (O(n) token counts)
- The tokenizer module is a service object, not a static utility — it holds the cache and provider reference
- `countBatch` optimization: if provider supports it, batch-count during seed/recount; fall back to serial `count` otherwise

**Depends on:** `types`, `utils/hash`, `utils/lru-cache`

### 10.3 Test requirements

**Unit tests:**
- `utils/hash.test.ts`: FNV-1a known vectors, determinism, distribution
- `utils/lru-cache.test.ts`: insertion, eviction, size limits, get/set/delete, iteration
- `utils/ring-buffer.test.ts`: push, overflow, toArray ordering, get by index
- `utils/copy.test.ts`: deep copy of nested objects, arrays, Date, null handling
- `errors.test.ts`: each error type has correct code, extends ContextLensError
- `events.test.ts`: on/emit, handler ordering, unsubscribe, once, re-entrancy detection, error swallowing
- `segment-store.test.ts`: all 8 lifecycle operations, group CRUD, protection enforcement, deduplication, position stability, event emission
- `tokenizer.test.ts`: approximate provider accuracy (test against known token counts), cache hit/miss, provider switching recount, capacity report computation

**Property-based tests:**
- Segment IDs are unique after any sequence of add/evict/restore
- Token accounting: `sum(active segment tokens) === capacityReport.totalActiveTokens`
- Position ordering: deterministic and stable across add/evict/restore sequences
- Protection invariant: pinned segments survive any evict sequence

### 10.4 Exit criteria

- [ ] All 36 shared types compile with strict TypeScript
- [ ] All 12 error subclasses instantiate correctly with appropriate codes
- [ ] Event emitter passes: subscribe, emit, unsubscribe, once, re-entrancy guard, error swallowing
- [ ] LRU cache: O(1) get/set verified, eviction at capacity, correct size tracking
- [ ] Ring buffer: overflow wraps correctly, toArray returns insertion order
- [ ] Segment store: all 8 lifecycle operations work, groups enforce atomicity, protection enforced, events fire
- [ ] Tokenizer: approximate provider within ±10% of tiktoken for English prose, cache works, provider switch recounts
- [ ] Capacity report: all 8 fields computed correctly
- [ ] All unit tests pass, coverage > 90% for Phase 1 modules
- [ ] Property-based tests pass (100 iterations minimum per property)
