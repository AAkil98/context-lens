# context-lens

Context window quality monitoring for LLM applications.

Everyone managing LLM context windows truncates blind. Token count is the only signal. But context has *quality* — coherence, density, relevance, continuity — and quality degrades in predictable, detectable ways long before the window fills up.

context-lens measures what token counting can't.

## Features

- **Segments** — model your context window as structured, trackable units of meaning
- **Quality scoring** — four dimensions scored from structural signals, no LLM calls required
- **Degradation detection** — five named patterns (saturation, erosion, fracture, gap, collapse) with severity levels and remediation hints
- **Custom patterns** — register domain-specific degradation patterns that plug into the same detection framework
- **Eviction advisory** — ranked recommendations for what to remove, with protection tiers, impact estimates, and strategy awareness
- **Task identity** — set a task descriptor and watch relevance scores shift as context drifts from the current goal
- **Fleet monitoring** — aggregate quality across multiple instances for multi-agent setups
- **Observability export** — optional OpenTelemetry adapter for quality metrics and pattern events
- **Serialization** — snapshot and restore instance state for recovery, replay, and export
- **Report schema** — JSON Schema (draft 2020-12) for all output types, consumable by any language or tool

## Quick start

```typescript
import { ContextLens } from 'context-lens';

const lens = new ContextLens({ capacity: 8000 });

// Seed with foundational context
lens.seed([
  { content: 'You are a helpful assistant.', protection: 'pinned' },
  { content: 'The user prefers concise answers.' },
]);

// Add conversation turns
lens.add('User: Summarize the Q3 report.');
lens.add('Assistant: Q3 revenue grew 12% driven by enterprise subscriptions.');

// Assess quality
const report = lens.assess();
console.log(report.windowScores);   // { coherence, density, relevance, continuity }
console.log(report.composite);      // 0.0–1.0, null if empty
console.log(report.patterns);       // active degradation patterns

// Set a task to enable relevance scoring
await lens.setTask({ description: 'Summarize Q3 financial results' });

// Get eviction recommendations when context fills up
const plan = lens.planEviction({ targetTokens: 200 });
for (const candidate of plan.candidates) {
  console.log(candidate.id, candidate.evictionScore, candidate.recommendation);
}
```

## Installation

```bash
npm install context-lens
```

## Sub-path exports

| Export | What | Dependencies |
|--------|------|--------------|
| `context-lens` | Core library | None |
| `context-lens/fleet` | Multi-instance fleet monitoring | None |
| `context-lens/schemas` | JSON Schema definitions + validation | None |
| `context-lens/otel` | OpenTelemetry metrics/events adapter | `@opentelemetry/api` (peer) |

## Tech stack

- TypeScript 5.x, strict mode
- ESM + CJS dual build via tsup
- Zero runtime dependencies for core
- `@opentelemetry/api` peer dependency for `context-lens/otel` only

## API overview

### `ContextLens` (main class)

| Category | Methods |
|----------|---------|
| Segments | `seed`, `add`, `update`, `replace`, `compact`, `split`, `evict`, `restore` |
| Groups | `createGroup`, `dissolveGroup`, `getGroup`, `listGroups` |
| Assessment | `assess` → `QualityReport`, `planEviction` → `EvictionPlan` |
| Task | `setTask`, `clearTask`, `getTask`, `getTaskState` |
| Providers | `setTokenizer`, `setEmbeddingProvider`, `getTokenizerInfo`, `getEmbeddingProviderInfo` |
| Inspection | `getCapacity`, `getSegment`, `listSegments`, `getSegmentCount`, `getBaseline`, `getDiagnostics` |
| Patterns | `registerPattern` (custom degradation patterns) |
| Events | `on(event, handler)` → unsubscribe function (22 event types) |
| Serialization | `snapshot`, `ContextLens.fromSnapshot` |

### `ContextLensFleet` (`context-lens/fleet`)

Register multiple `ContextLens` instances and get fleet-wide aggregates, degradation hotspots, comparative ranking, and fleet capacity overview.

### `ContextLensExporter` (`context-lens/otel`)

Read-only OTel adapter: 9 gauges, 6 counters, 1 histogram, and 5 log event types. Subscribes to instance events — no polling.

### Error classes

All 13 error classes are exported from the main entry point for `instanceof` checks:
`ContextLensError`, `ConfigurationError`, `ValidationError`, `SegmentNotFoundError`, `GroupNotFoundError`, `DuplicateIdError`, `InvalidStateError`, `ProtectionError`, `MembershipError`, `CompactionError`, `SplitError`, `RestoreError`, `ProviderError`.

## Test suite

977 tests across 36 files + 12 performance benchmarks.

```bash
npm test            # vitest run (977 tests)
npm run bench       # vitest bench (12 benchmarks)
npm run typecheck   # tsc --noEmit
```

| Layer | Files | Tests |
|-------|------:|------:|
| Unit | 28 | 887 |
| Integration | 2 | 21 |
| End-to-end | 1 | 7 |
| Property-based | 5 | 62 |
| **Total** | **36** | **977** |

## Architecture

One instance, one window. Caller-driven mutations — context-lens never auto-evicts, auto-compacts, or auto-reorders. It measures and advises.

**Quality model:** Four dimensions (coherence, density, relevance, continuity) scored independently from structural signals — adjacency similarity, redundancy detection, task descriptor matching, and cumulative loss tracking. No LLM inference. Similarity computed via Jaccard character trigrams (zero-config) or embeddings (optional provider).

**Detection:** Five base patterns classify quality degradation. Three severity levels with hysteresis to prevent flicker. Six compound patterns identify multi-dimensional crises. Custom patterns register at construction or runtime.

**Eviction advisory:** Five-signal weighted ranking (relevance, density, coherence contribution, importance, age). Four protection tiers enforced as walls: default < priority(n) < seed < pinned. Strategy auto-selected from active patterns. Groups evicted atomically.

**Performance budget:** Queries < 1ms, mutations < 5ms, assessment < 50ms, planning < 100ms at n <= 500, excluding provider latency. O(n^2) bottlenecks managed by sampling at n > 200.

## Design specs

14 design specs in `specs/` define the behavioral contract. These are the authoritative reference — implementation answers to design. See `SEED_CONTEXT.md` for the full spec map and key decisions.

## License

MIT
