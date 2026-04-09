# Changelog

## 0.1.0 — Initial release

### Features

- **Segment model** — seed, add, update, replace, compact, split, evict, restore. Caller-assigned or content-hash IDs. Four-tier protection (pinned > seed > priority(n) > default). Groups with atomic eviction.
- **Quality scoring** — four dimensions (coherence, density, relevance, continuity) scored from structural signals. No LLM calls. Similarity via Jaccard character trigrams (zero-config) or embeddings (optional provider).
- **Degradation detection** — five named patterns (saturation, erosion, fracture, gap, collapse). Three severity levels with hysteresis. Six compound patterns. Custom pattern registration.
- **Task identity** — task descriptor drives relevance scoring. Three-way transition classification (new, refinement, change). Grace period after task changes.
- **Eviction advisory** — five-signal weighted ranking with strategy auto-selection from active patterns. Protection tiers enforced as walls. Group-aware with overshoot penalty.
- **Quality baseline** — captured on first add after seed. All scores normalized relative to initial state.
- **Diagnostics** — report history, pattern stats, session timeline, cache metrics, warnings. Tier 1 (< 1ms) assembly.
- **Serialization** — `snapshot()` / `fromSnapshot()` for full state capture and restore. Format versioning. Provider change detection on restore.
- **Fleet monitoring** (`context-lens/fleet`) — aggregate quality across instances. Hotspots, ranking, capacity overview. Fleet-level degradation events.
- **OTel export** (`context-lens/otel`) — 9 gauges, 6 counters, 1 histogram, 5 log event types. Optional `@opentelemetry/api` peer dependency.
- **Report schema** (`context-lens/schemas`) — JSON Schema (draft 2020-12) for QualityReport, DiagnosticSnapshot, EvictionPlan. Validation utilities.

### Architecture

- Zero runtime dependencies for core
- ESM + CJS dual build
- TypeScript strict mode with full type exports
- 977 tests (unit, integration, e2e, property-based) + 12 performance benchmarks
