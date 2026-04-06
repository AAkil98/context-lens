# Phase 4 -- Public API and Diagnostics

## 1. Preamble

Phase 4 is the integration layer. It introduces the `ContextLens` class -- the sole public-facing entry point -- and wires together every module from Phases 1 through 3. After Phase 4, a caller can construct an instance, manage segments, set tasks, assess quality, detect degradation patterns, plan evictions, and inspect full diagnostics. Everything before Phase 4 is internal machinery; everything after (Phase 5: serialization, schemas, fleet, OTel) is enrichment that builds on the public API without modifying it.

**Design specs covered:**
- `cl-spec-007` (API Surface) -- constructor, segment operations, group operations, task operations, quality operations, provider management, inspection, events, errors, invariants
- `cl-spec-010` (Report & Diagnostics) -- diagnostic snapshot, report history, pattern history, session timeline, performance diagnostics, provider diagnostics, warning accumulation, formatting

**Performance budget:** `cl-spec-009` -- `getDiagnostics()` is Tier 1 (< 1ms); segment operations are Tier 2 (< 5ms); `assess()` is Tier 3 (< 50ms at n <= 500); `planEviction()` is Tier 4 (< 100ms)

**Key resolutions referenced:**
- R-008: Protection relevance uses post-hoc clamp/floor, not multiplicative
- R-177: `assessmentTimestamp` (captured once per `assess()`) replaces all wall-clock references in scoring formulas
- R-178: FNV-1a for all non-cryptographic hashing

**Parent document:** `IMPLEMENTATION.md` (section 5, Phase 4 row; section 4, dependency graph)

---

## 2. Module Map

| Module | Primary design spec | Responsibility |
|--------|-------------------|----------------|
| `index.ts` (ContextLens class) | cl-spec-007 | Integration layer: constructor, all public methods, defensive copy boundary, atomic mutation boundary, invalidation routing, event orchestration |
| `diagnostics` | cl-spec-010 SS2--7 | Diagnostic state maintenance, snapshot assembly, report history ring buffer, rolling trends, pattern history surfacing, session timeline, performance aggregation, provider diagnostics, warning accumulation |
| `formatters` | cl-spec-010 SS8 | Pure functions: `formatReport`, `formatDiagnostics`, `formatPattern`. Plain text output, no ANSI, no side effects |

---

## 3. Dependency Direction

```
                        ┌─────────────────────┐
                        │  index.ts            │  (ContextLens class)
                        │  (public boundary)   │
                        └──────────┬──────────┘
          ┌──────────┬─────────────┼────────────┬────────────┐
          v          v             v            v            v
    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
    │diagnostics│ │eviction  │ │detection │ │perform.  │ │quality-  │
    └─────┬────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │ report   │
          │           │            │             │       └────┬─────┘
          │           └────────────┼─────────────┘            │
          │                        v                          │
          │             Phase 1--3 modules                    │
          │    (segment-store, tokenizer, task, events,       │
          │     similarity, embedding, scoring/*, utils)      │
          v                                                   │
   reads pre-maintained state from Phase 1--3 modules ◄──────┘

    ┌──────────┐
    │formatters │  (pure functions, no instance dependency)
    └──────────┘
```

**Rules (from IMPLEMENTATION.md SS4):**
- No circular imports.
- No upward imports: `diagnostics` does not import `index.ts`. `formatters` imports nothing from the instance layer.
- `index.ts` imports all Phase 1--3 modules plus `diagnostics`. It does not import `formatters` -- formatters are exported alongside the class but are not wired into the class.
- `diagnostics` imports Phase 1 types and reads from pre-maintained internal state (ring buffers, counters, caches). It does not import scoring modules or detection modules directly -- it receives data through the event subscription mechanism and through accessors on the modules it observes.
- `formatters` imports only type definitions (`types.ts`). No runtime module dependencies.

---

## 4. Module Specifications

### 4.1 ContextLens class (index.ts)

The ContextLens class is the integration layer. It owns instances of every internal module, delegates all computation to them, enforces the defensive copy boundary, provides atomic mutation guarantees, and orchestrates the event flow. Every public method on the class follows the same structural pattern: validate input, deep-copy input, delegate to internal module(s), fire events, deep-copy output, return.

#### 4.1.1 Internal state

The class holds the following private fields, all instantiated during construction:

- **config** -- Deep copy of the caller's `ContextLensConfig`, frozen after validation. Used for read-back by inspection methods and to initialize internal modules.
- **segmentStore** -- Instance of the segment-store module. Owns all segment and group state: the active/evicted segment maps, group map, position tracking, token accounting.
- **tokenizer** -- Instance of the tokenizer module. Wraps the configured `TokenizerProvider` (or the built-in approximate provider). Owns the token count LRU cache.
- **embeddingModule** -- Instance of the embedding module. Wraps the configured `EmbeddingProvider` (or null for trigram-only mode). Owns the embedding/trigram LRU cache.
- **similarityModule** -- Instance of the similarity module. Owns the similarity LRU cache. Dispatches to cosine or Jaccard based on available prepared forms.
- **taskModule** -- Instance of the task module. Owns current/previous task descriptors, transition history, grace period state, staleness counter.
- **qualityReport** -- Instance of the quality-report module. Owns the cached report, invalidation flags, per-segment score tracking, baseline state.
- **detectionModule** -- Instance of the detection module. Owns the pattern framework: five base patterns, custom patterns, hysteresis state, pattern tracking.
- **evictionModule** -- Instance of the eviction module. Stateless except for the reference to quality-report (it needs the current report to rank candidates).
- **performanceModule** -- Instance of the performance module. Owns per-operation timing ring buffers, budget targets, budget violation counters.
- **diagnosticsModule** -- Instance of the diagnostics module. Owns report history ring buffer (20), session timeline ring buffer (200), warning list (50), performance aggregation state, provider switch counters.
- **emitter** -- Instance of the event emitter. All event subscriptions and emissions flow through this single emitter.
- **constructionTimestamp** -- `Date.now()` captured at construction. Used by diagnostics for `sessionDuration`.
- **reportIdCounter** -- Monotonic counter for report IDs. Incremented on each `assess()` that produces a new (non-cached) report.
- **timelineSequence** -- Monotonic counter for timeline entry sequence numbers. Incremented on every timeline entry to break timestamp ties.
- **qualityCacheValid** -- Boolean flag. Set to `false` by any content mutation, task change, or provider switch. Set to `true` after `assess()` completes. When `true`, `assess()` returns the cached report. When `false`, `assess()` recomputes.

#### 4.1.2 Construction sequence

Construction is synchronous. The steps execute in strict order, each depending on the successful completion of the previous step. If any step throws, no instance is created.

1. **Validate config.** All fields checked per cl-spec-007 SS2.4: capacity is a positive integer; tokenizer is valid (returns 0 for empty string if object, or the string `"approximate"`); embeddingProvider has `embed` method and valid metadata if non-null; pinnedCeilingRatio in (0.0, 1.0]; hysteresisMargin in [0.01, 0.10]; all cache sizes are positive integers; customPatterns pass PatternDefinition validation with no name collisions; suppressedPatterns are valid pattern names; patternThresholds satisfy monotonic severity ordering. Any failure throws `ConfigurationError`.
2. **Deep-copy config.** The caller's config object is cloned via `deepCopy`. The copy is stored; the original is never referenced again. This prevents post-construction mutations from affecting the instance.
3. **Capture construction timestamp.** `constructionTimestamp = Date.now()`.
4. **Create event emitter.** Instantiate the typed `EventEmitter<EventMap>` with all 24 event names.
5. **Create tokenizer.** Instantiate with the validated provider (or built-in approximate provider). Initialize the token count LRU cache with the configured `tokenCacheSize`.
6. **Create segment store.** Instantiate with a reference to the tokenizer (for token counting on mutation), the emitter (for segment/group events), and config values (`retainEvictedContent`, `pinnedCeilingRatio`).
7. **Create embedding module.** Instantiate with the validated `embeddingProvider` (or null). Initialize the embedding LRU cache with the configured `embeddingCacheSize`.
8. **Create similarity module.** Instantiate with a reference to the embedding module (for retrieving vectors/trigrams). Initialize the similarity LRU cache.
9. **Create task module.** Instantiate with references to the similarity module (for transition classification) and embedding module (for descriptor preparation). Initialize transition history ring buffer (20).
10. **Create quality-report module.** Instantiate with references to all four scoring sub-modules, similarity module, embedding module, task module, segment store, and baseline module. Initialize per-segment invalidation tracking.
11. **Create detection module.** Instantiate with config values (`patternThresholds`, `suppressedPatterns`, `hysteresisMargin`). Register all five base patterns. Register custom patterns from `config.customPatterns` (all-or-nothing -- validation was done in step 1).
12. **Create eviction module.** Instantiate with references to the segment store (for candidate enumeration) and quality-report module (for current scores).
13. **Create performance module.** Instantiate with per-operation timing ring buffers and budget target lookup.
14. **Create diagnostics module.** Instantiate with references to the emitter (for timeline subscription), performance module (for timing aggregation), and config values. Initialize report history ring buffer (20), session timeline ring buffer (200), and warning list (50). Subscribe to all relevant events on the emitter for automatic timeline logging (see section 4.2.2).
15. **Emit construction warnings.** If tokenizer is `"approximate"`, add a warning about count uncertainty. If tokenizer and embeddingProvider have mismatched `modelFamily` values, add a provider-mismatch warning.

After step 15, the instance is fully constructed and ready for use. No segments, no task, no baseline, no reports, no pattern history.

#### 4.1.3 Segment operations

Eight segment operations are exposed as public methods. Each follows the same structural pattern.

**Pattern for mutating segment operations (add, seed, update, replace, compact, split, evict, restore):**

1. **Start performance timer.** Record the operation start time via the performance module.
2. **Deep-copy input.** All input objects (SeedInput arrays, AddOptions, SegmentChanges, ReplaceOptions, RestoreOptions) are cloned at entry. Primitives (strings, numbers) are passed by value and need no copying.
3. **Validate input.** Delegate to the segment store's validation logic. Throws typed errors on failure (ValidationError, SegmentNotFoundError, ProtectionError, etc.).
4. **Capture pre-mutation state (for rollback).** For operations that modify existing segments (update, replace, compact), snapshot the segment's current state. For operations that add segments (add, seed), the rollback is removal. For evict/restore, the rollback is state transition reversal.
5. **Execute mutation.** Delegate to the segment store. This is where token counting (via tokenizer), embedding computation (via embedding module), and state transitions occur.
6. **Fire events.** Emit the appropriate event(s) through the emitter. Events fire synchronously, inline. Handler errors are caught and swallowed.
7. **Invalidate quality cache.** Set `qualityCacheValid = false`. This ensures the next `assess()` call recomputes scores.
8. **Mark per-segment scores as invalidated.** Notify the quality-report module which segment IDs have changed. For add/seed: new segment ID. For update/replace/compact: the modified segment's ID plus its neighbors (adjacency coherence depends on neighbors). For split: the original segment's ID (removed) plus all child IDs plus neighbors. For evict: the evicted segment's ID plus its former neighbors. For restore: the restored segment's ID plus its new neighbors.
9. **Stop performance timer.** Record the operation end time. Check against budget. If budget violated, emit `budgetViolation` event and log timeline entry.
10. **Deep-copy output.** Clone the returned Segment, Segment[], EvictionRecord, or DuplicateSignal before returning to the caller.

**Rollback on failure:** If step 5 throws (e.g., token counting fails, embedding fails, group constraint violated), the segment store reverts to the pre-mutation state captured in step 4. No events are fired for the failed operation. The performance timer still records the failed attempt. The quality cache validity flag is unchanged -- no invalidation occurred because no mutation completed.

**Specific operation details:**

**seed(segments):** Validates all inputs atomically -- one invalid seed rejects the entire batch. Generates IDs for seeds without caller-assigned IDs (FNV-1a content hash, per R-178). Delegates to segment store for batch insertion. Computes embeddings for all seeds (batch embedding via `embedBatch` if available). After successful insertion, checks whether this is the first seed call and whether adds have already occurred (late seeding). If late seeding, emits `lateSeeding` event and adds a warning to the diagnostics warning list. Fires `segmentAdded` event for each inserted segment. Empty array input is a no-op returning `[]`.

**add(content, options):** If this is the first `add` call and seeds exist, triggers baseline capture in the quality-report module before the segment is inserted. The baseline is captured from the current seed-only window state. Then inserts the segment. If the auto-generated ID collides with an existing active segment, returns a `DuplicateSignal` instead of inserting -- this is not an error. Fires `segmentAdded` event on successful insertion.

**update(id, changes):** Validates that the segment is ACTIVE and not pinned (if content change requested). Delegates to segment store. If content changed: triggers token recount, embedding recomputation, and similarity cache invalidation for all pairs involving this segment's content hash. Fires `segmentUpdated` event.

**replace(id, newContent, options):** Same as update with content change, but the method signature makes content replacement the primary intent. Fires `segmentReplaced` event.

**compact(id, summary):** Validates that the summary is shorter in tokens than the current content. Delegates to segment store. Records a `CompactionRecord` in the continuity ledger. Updates the segment's origin to `"summary:compacted"`. Fires `segmentCompacted` event.

**split(id, splitFn):** Calls `splitFn(segment.content)` to get content chunks. Validates that the result is a non-empty array of non-empty strings. Removes the original segment and inserts children at its position. Children inherit the original's metadata (importance, protection, origin, tags, groupId). Fires `segmentSplit` event.

**evict(id, reason):** If the segment belongs to a group, evicts the entire group atomically. Captures pre-eviction quality snapshots for the continuity ledger. Transitions segments to EVICTED. Content retained or discarded per `retainEvictedContent` config. Fires `segmentEvicted` event for each evicted segment (in segment order for group evictions).

**restore(id, options):** If the segment belonged to a group, restores the entire group. Inserts at original position (not end). Recomputes token count and embedding if content was caller-provided. Measures restoration fidelity. Fires `segmentRestored` event for each restored segment.

#### 4.1.4 Group operations

Group operations delegate directly to the segment store. They follow the same input-copy/output-copy pattern.

**createGroup(groupId, segmentIds, options):** Validates all preconditions (unique groupId, all segments ACTIVE, no existing group membership). Creates the group with computed aggregates (token count sum, max importance, max protection unless overridden). Fires `groupCreated` event. Returns deep copy of the created Group.

**dissolveGroup(groupId):** Validates group exists and is fully ACTIVE. Removes group relationship from all members. Members remain ACTIVE in their positions. Fires `groupDissolved` event. Returns deep copy of former member Segments.

**getGroup(groupId):** Returns deep copy of the group, or `null` if not found. Does not throw for missing groups.

**listGroups():** Returns deep copies of all groups (active and evicted), ordered by creation time.

#### 4.1.5 Task operations

Task operations delegate to the task module. Task changes trigger quality cache invalidation because relevance scores depend on the active task.

**setTask(descriptor):** Deep-copies input. Delegates to the task module for validation, normalization, and transition classification. The task module computes description similarity (via the similarity module) and prepares the new descriptor (embed or trigram via the embedding module). On a "same" transition, returns the TaskTransition immediately -- no invalidation, no event. On "refinement" or "change": invalidates all per-segment relevance scores, sets `qualityCacheValid = false`, fires `taskChanged` event. On "change" specifically: activates the 2-report grace period in the task module. Returns deep copy of the TaskTransition.

**clearTask():** If no task is set, this is a no-op. Otherwise: clears the task in the task module, invalidates all per-segment relevance scores (they all become trivially 1.0), sets `qualityCacheValid = false`, fires `taskCleared` event.

**getTask():** Returns deep copy of the current task descriptor, or `null`. Does not trigger computation.

**getTaskState():** Returns deep copy of the full task lifecycle state (current/previous task, timestamps, counters, grace period, staleness, transition history). Does not trigger computation.

#### 4.1.6 assess() -- the central call chain

`assess()` is the central method. It consumes all state and produces the quality report. It is not a mutating method -- it updates internal caches but does not modify segments, groups, or configuration. It either returns a complete QualityReport or throws.

**Call chain:**

1. **Check cache.** If `qualityCacheValid` is true, return deep copy of the cached report with an updated `timestamp`. Skip all subsequent steps. This makes repeated `assess()` calls between mutations O(1).
2. **Start performance timer.** Record assess start time.
3. **Capture assessmentTimestamp.** `assessmentTimestamp = Date.now()`. This single timestamp flows to all scorers that need a time reference (relevance recency, continuity age). No other `Date.now()` call occurs during the remainder of this method. Per R-177.
4. **Generate report ID.** Increment `reportIdCounter`, produce the report ID string.
5. **Delegate to quality-report module.** The quality-report module orchestrates scoring:
   - Retrieves the active segment list from the segment store.
   - If no segments are active, produces a zero-score report immediately.
   - Identifies which per-segment scores are invalidated since the last report.
   - Recomputes scores for invalidated segments only (lazy invalidation). Reuses cached scores for unchanged segments.
   - For each invalidated segment, the four dimension scorers compute per-segment scores:
     - **Coherence:** adjacency similarity with neighbors, topical concentration (with sampling at n > 200), group integrity.
     - **Density:** maximum similarity to non-adjacent segments (with cached-first sampling), information ratio, token waste annotation.
     - **Relevance:** task similarity, keyword boost, metadata signals, recency (using `assessmentTimestamp`), protection adjustment (pinned = 1.0, seed floor = 0.3, per R-008).
     - **Continuity:** eviction cost, compaction cost, restoration fidelity from the ledger.
   - Aggregates per-segment scores to window-level scores (token-weighted means for density and relevance; weighted average for coherence; ledger-based for continuity).
   - Normalizes window scores against the baseline (if captured). Raw scores stored separately.
   - Computes composite score (weighted geometric mean, weights: coherence 0.25, density 0.20, relevance 0.30, continuity 0.25).
   - Computes trend data (deltas against previous report). Null on first report.
   - Ticks the grace period counter (decrement `gracePeriodRemaining` if active; deactivate if zero).
   - Ticks the staleness counter (increment `reportsSinceSet`).
   - Assembles the full QualityReport structure.
6. **Run detection.** Pass the quality report to the detection module. The detection module evaluates all active patterns (base + custom) against the report's window scores, capacity metrics, and trend data. It applies hysteresis for severity transitions. It checks for compound patterns. Custom pattern evaluation is fail-open -- a throwing custom pattern is logged and skipped, not propagated. The detection module returns a `DetectionResult` which is attached to the quality report.
7. **Fire pattern events.** For each pattern state transition detected (activation, escalation, deescalation, resolution), fire the corresponding event and log a timeline entry. Events: `patternActivated` for new activations and escalations, `patternResolved` for deactivations.
8. **Cache the report.** Store the full report in the quality-report module. Set `qualityCacheValid = true`.
9. **Update diagnostics.** Push a ReportSummary to the report history ring buffer. Update rolling trends (recomputed from the most recent 5 summaries). Detect score anomalies (any dimension delta > 0.15). Push a `reportGenerated` timeline entry.
10. **Fire reportGenerated event.** Emit with the full QualityReport as payload.
11. **Stop performance timer.** Record timing. Check against Tier 3 budget (< 50ms at n <= 500 excluding provider calls). If violated, emit `budgetViolation` event.
12. **Return deep copy of the report.**

**Empty window:** If no segments are active, `assess()` returns a report with all WindowScores fields as `null`, `segmentCount: 0`, `composite: 0`, no patterns, no trend (even if a previous report exists -- there is no meaningful delta to a zero-state report). The report is still cached, and the `reportGenerated` event still fires.

**Error handling:** If any scorer throws (a provider error during similarity computation, for example), the entire `assess()` call fails. No partial report is produced, no events are fired, the cache is not updated. The quality cache remains invalid. The next `assess()` call will attempt the full computation again.

#### 4.1.7 planEviction(target, options)

**Call chain:**

1. **Start performance timer.**
2. **Check for current report.** If `qualityCacheValid` is false and no cached report exists at all, call `assess()` first. If a cached report exists but is stale (invalidated), the eviction module uses the stale report rather than forcing a fresh assessment -- the caller can call `assess()` explicitly if they want fresh scores before planning.
3. **Delegate to eviction module.** The eviction module takes the target token count, the strategy (auto-selected or caller-overridden), the `includeSeeds` flag (default false), and the `compressionRatio` (default 0.5). It enumerates candidates from the segment store (excluding pinned segments always, excluding seeds unless `includeSeeds` is true), ranks them using the selected strategy, and assembles the `EvictionPlan`.
4. **Stop performance timer.** Check against Tier 4 budget (< 100ms).
5. **Return deep copy of the plan.**

The plan is advisory. The caller decides which candidates to evict by calling `evict()` on chosen segment IDs.

#### 4.1.8 Provider management

Provider switches have the most complex invalidation semantics of any operation.

**setTokenizer(provider):** Validates the new provider. If same name as current provider, no-op. Otherwise: invalidate the entire token count cache; recount all active segments using the new provider (full O(n) recount -- every segment's tokenCount is recomputed and all aggregates updated); invalidate all quality score caches (token counts feed density scoring); set `qualityCacheValid = false`; fire `tokenizerChanged` event; add timeline entry; increment the tokenizer switch counter in diagnostics. On validation failure, throw `ProviderError` -- previous provider remains active.

**setEmbeddingProvider(provider):** Validates the new provider if non-null. If same name as current provider, no-op. Otherwise: execute the 5-step invalidation cascade (cl-spec-005 SS6): (1) clear embedding cache, (2) clear similarity cache, (3) invalidate all quality scores, (4) re-embed all active segments using the new provider (or switch to trigram sets if provider is null), (5) re-prepare the task description embedding if a task is set. Set `qualityCacheValid = false`. Fire `embeddingProviderChanged` event. Add timeline entry. Increment the embedding switch counter in diagnostics. If mid-cascade failure: fall back to trigram mode rather than rolling back. Previous provider is not restored -- the system degrades gracefully. Add a warning to diagnostics. On pre-switch validation failure, throw `ProviderError` -- previous provider remains active.

**getTokenizerInfo():** Returns deep copy of tokenizer metadata: name, accuracy, modelFamily, errorBound.

**getEmbeddingProviderInfo():** Returns deep copy of embedding provider metadata, or null if in trigram mode: name, dimensions, modelFamily, maxInputTokens.

#### 4.1.9 Capacity and inspection

**setCapacity(newCapacity):** Validates positive integer. Updates the stored capacity. Recalculates utilization and headroom (these are derived values, not stored separately). Invalidates saturation pattern state in the detection module (new thresholds apply to the new denominator). Does not recount tokens or recompute quality scores -- only the denominator changes, not the numerator. Sets `qualityCacheValid = false` (utilization is part of the report). Fires `capacityChanged` event.

**getCapacity():** Assembles and returns deep copy of the CapacityReport from segment store aggregates and the configured capacity. Does not trigger quality computation. This is the lightweight path for capacity checks.

**getSegment(id):** Returns deep copy of the segment (ACTIVE or EVICTED), or null. Does not throw for missing IDs.

**listSegments(filter):** Deep-copies input filter. Delegates to segment store. Returns deep copies of matching segments in segment order. Default filter: ACTIVE only.

**getSegmentCount():** Returns `{ active, evicted, total }` from segment store aggregates.

**getEvictionHistory():** Returns deep copies of all eviction records for the session, ordered by timestamp.

**getBaseline():** Returns deep copy of the baseline snapshot from the quality-report module, or null if baseline has not been captured.

**registerPattern(definition):** Deep-copies the definition. Validates per cl-spec-003 SS10.3: name must not collide with base or existing custom patterns. Delegates to the detection module for registration. Fires `customPatternRegistered` event. The pattern participates in the next `assess()` call.

#### 4.1.10 Event system

**on(event, handler):** Delegates to the emitter. Returns an unsubscribe function. Multiple handlers per event are supported; called in registration order. Handler errors are caught and swallowed.

The ContextLens class does not subscribe to its own events internally. Event emission is explicit at each call site (steps 6 in the mutation pattern, steps 7 and 10 in the assess chain). The diagnostics module subscribes to the emitter at construction time for timeline logging (section 4.2.2), but this is an internal subscription, not visible to the caller.

#### 4.1.11 Defensive copy boundary

The ContextLens class is the defensive copy boundary. All objects entering the class (inputs to public methods) are deep-copied before being passed to internal modules. All objects leaving the class (return values of public methods) are deep-copied before being returned to the caller. Internal modules pass references to each other -- copying happens only at the public boundary.

The copy mechanism is `deepCopy` from `utils/copy.ts`. It handles plain objects, arrays, Date instances, null, primitives, Map, and Set. It does not handle class instances with methods or circular references -- neither exists in the public API surface.

Primitives (strings, numbers, booleans) are passed by value in JavaScript and need no explicit copy. But compound arguments (SeedInput objects, AddOptions, SegmentChanges, filter objects) are cloned at entry because the caller could retain and mutate them after the call returns. Similarly, returned Segment, Group, QualityReport, TaskDescriptor, CapacityReport, and DiagnosticSnapshot objects are cloned before return.

#### 4.1.12 Atomic mutation guarantee

Every mutating method (add, seed, update, replace, compact, split, evict, restore, createGroup, dissolveGroup, setTask, clearTask) either completes fully or has no observable effect. The mechanism:

- Before the mutation, capture enough state to roll back. For segment operations, this is either the full pre-mutation segment object (for update/replace/compact) or a marker indicating "nothing was added yet" (for add/seed). For group operations, capture the pre-mutation group membership state.
- Execute the mutation within a try block.
- On success: fire events, invalidate caches, return.
- On failure (any throw from the segment store, tokenizer, or embedding module): restore the captured state, do not fire events, do not invalidate caches, re-throw the original error.

This is simpler than transactional rollback because context-lens is single-threaded. There are no concurrent observers who might see intermediate state. The only observers are event handlers, and events do not fire until after the mutation succeeds.

**assess() is not a mutating method.** It reads segment state and produces a report. It updates the report cache and diagnostics history, but these are internal caches that do not affect the segment state that the caller manages. If assess() throws, the cache remains stale and the next call re-attempts -- no segment state is corrupted.

---

### 4.2 diagnostics

The diagnostics module maintains diagnostic state incrementally as events occur. `getDiagnostics()` assembles a snapshot from this pre-maintained state -- it does not recompute, rescore, or re-analyze anything. This is how it achieves Tier 1 performance (< 1ms).

#### 4.2.1 Internal state

- **reportHistory** -- Ring buffer of 20 ReportSummary entries. Updated after each `assess()` call. Each summary is approximately 200 bytes: reportId, timestamp, windowScores (4 numbers), composite, segmentCount, totalActiveTokens, utilization, patternCount, highestSeverity, embeddingMode, anomalies array.
- **rollingTrend** -- Cached RollingTrend object (or null if fewer than 2 reports exist). Recomputed from the report history ring buffer after each `assess()`. The rolling window is `min(5, available reports)`. Per-dimension TrendLine contains: direction (`"improving"` if averageRate > 0.01, `"degrading"` if < -0.01, `"stable"` otherwise), averageRate, current score, windowMin, windowMax, volatility (standard deviation of deltas within the window). Recomputation is O(5) -- trivially fast.
- **timeline** -- Ring buffer of 200 TimelineEntry objects. Each entry: timestamp, sequence number (monotonically increasing, breaks ties), event type, detail payload. Updated by event subscription (section 4.2.2). Approximately 150 bytes per entry, 30KB total.
- **warnings** -- Array of Warning objects, bounded at 50 entries. Deduplicated by message string. Oldest dropped when limit reached. Not clearable by the caller.
- **providerState** -- Cached TokenizerInfo and EmbeddingInfo objects. Updated on provider switches. Includes switch counts and last-switch timestamps.

#### 4.2.2 Event subscription for timeline logging

At construction time, the diagnostics module subscribes to the following events on the emitter and logs corresponding timeline entries:

| Event | Timeline entry type |
|-------|-------------------|
| `segmentAdded` | `segmentAdded` |
| `segmentUpdated` | `segmentUpdated` |
| `segmentReplaced` | `segmentReplaced` |
| `segmentCompacted` | `segmentCompacted` |
| `segmentSplit` | `segmentSplit` |
| `segmentEvicted` | `segmentEvicted` |
| `segmentRestored` | `segmentRestored` |
| `groupCreated` | `groupCreated` |
| `groupDissolved` | `groupDissolved` |
| `taskChanged` | `taskSet` |
| `taskCleared` | `taskCleared` |
| `tokenizerChanged` | `tokenizerChanged` |
| `embeddingProviderChanged` | `embeddingProviderChanged` |
| `capacityChanged` | `capacityChanged` |
| `reportGenerated` | `reportGenerated` |
| `patternActivated` | `patternActivated` |
| `patternResolved` | `patternResolved` |
| `customPatternRegistered` | `customPatternRegistered` |
| `baselineCaptured` | `baselineCaptured` |
| `lateSeeding` | `lateSeeding` |
| `pinnedCeilingWarning` | `pinnedCeilingWarning` |
| `budgetViolation` | `budgetViolation` |

Additionally, pattern escalation and deescalation events are logged to the timeline but are not exposed as public API events (they are internal state transitions logged by the detection module during assess). The ContextLens class logs these directly after the detection step in `assess()`, not through the event subscription mechanism.

Each timeline entry gets the current timestamp and the next sequence number from the monotonic counter. The detail field varies by event type, matching the structure defined in cl-spec-010 SS5.2.

#### 4.2.3 getDiagnostics() assembly

`getDiagnostics()` assembles the DiagnosticSnapshot from pre-maintained state. No scoring, no detection, no provider calls. The assembly reads from:

- `latestReport` -- the cached QualityReport from the quality-report module. Null if `assess()` has never been called.
- `reportHistory` -- deep copy of the report history ring buffer contents (ReportSummary array, newest first).
- `rollingTrend` -- deep copy of the cached RollingTrend (or null).
- `patternSummary` -- assembled from the detection module's internal pattern tracking state. The detection module maintains per-pattern stats (activationCount, totalActiveTime, peakSeverity, currentState, currentSeverity, lastActivation, lastResolution, recurrenceCount) and a pattern history ring buffer (50 entries). getDiagnostics reads these and packages them into the PatternSummary structure.
- `timeline` -- deep copy of the timeline ring buffer contents (TimelineEntry array, oldest first).
- `performance` -- assembled from the performance module's timing records. Per-operation aggregation (count, totalSelfTime, totalProviderTime, averageSelfTime, maxSelfTime, p95SelfTime, budgetTarget, budgetViolations, withinBudgetRate). Cache metrics from the tokenizer module, embedding module, and similarity module (hits, misses, hitRate, currentEntries, maxEntries, utilization, evictions). Session-level aggregates (sessionSelfTime, sessionProviderTime, budgetViolationCount).
- `providers` -- deep copy of the cached provider state (tokenizer info, embedding info).
- `segmentCount`, `groupCount`, `evictedCount` -- from segment store aggregates.
- `taskState` -- deep copy from the task module.
- `continuityLedger` -- deep copy of the full continuity ledger from the continuity scorer. The diagnostic snapshot provides the full ledger (every eviction, compaction, restoration), not just the 10-entry summary on the quality report.
- `warnings` -- deep copy of the warning list.
- `schemaVersion` -- from the schema version constant (cl-spec-011).
- `timestamp` -- `Date.now()` at assembly time.
- `sessionDuration` -- `timestamp - constructionTimestamp`.

All of these reads are from in-memory data structures. The most expensive operation is the deep copy of returned arrays. For the bounded buffer sizes (20 report summaries, 50 pattern history entries, 200 timeline entries), this is well within the 1ms budget.

#### 4.2.4 Report history and rolling trends

After each `assess()` call that produces a new (non-cached) report, the diagnostics module:

1. Constructs a ReportSummary from the full report (extracting window scores, composite, counts, pattern info, embedding mode).
2. Detects anomalies by comparing this summary's scores against the previous summary. A dimension delta exceeding 0.15 in magnitude is an anomaly. For each anomaly, best-effort cause attribution checks the timeline for events between the two reports: task change, bulk eviction (multiple eviction events), provider switch, or bulk add (multiple add events). First match in priority order is used; null if no match.
3. Pushes the summary into the report history ring buffer.
4. Recomputes the rolling trend from the most recent `min(5, available)` summaries. For each dimension plus composite: compute per-report deltas, average the deltas (averageRate), classify direction, find min/max over the window, compute volatility (standard deviation of deltas). If fewer than 2 reports, rolling trend is null.

#### 4.2.5 Warning accumulation

Warnings are added by the ContextLens class at specific trigger points:

- Provider mismatch: checked at construction time and on each provider switch.
- Pinned ceiling: checked after each segment mutation that could change pinned token totals (add with `pinned` protection, update to `pinned`, restore of a pinned segment).
- Late seeding: checked in the seed method when adds already exist.
- Zero vector: checked after embedding computation returns.
- Approximate capacity: checked at construction time if tokenizer accuracy is `"approximate"`.

Deduplication is by message string. The warning list is bounded at 50. When full, the oldest warning is dropped to make room.

---

### 4.3 formatters

Three pure functions exported alongside the ContextLens class. They are not methods on the class -- they are standalone utilities that operate on output data structures. They have no access to instance state, do not call providers, do not emit events, and produce no side effects. The same input always produces the same output.

#### 4.3.1 formatReport(report: QualityReport): string

Produces a multi-line plain-text summary of a quality report.

**Content:**
- **Line 1:** Header with report ID and ISO 8601 timestamp.
- **Line 2:** Five headline scores (coherence, density, relevance, continuity, composite) at two decimal places, space-separated with labels.
- **Line 3:** Capacity summary: utilization percentage, token ratio with comma-formatted numbers, segment count, headroom in tokens.
- **Lines 4+:** Active patterns section. Each active pattern on its own line, prefixed by severity in brackets (WATCH, WARNING, CRITICAL, EMERGENCY), followed by pattern name and the human-readable explanation from the detection result. Ordered by pattern priority (collapse > saturation > gap > erosion > fracture). Custom patterns appear after base patterns, ordered alphabetically.
- **Trend lines:** Per-dimension delta since last report with direction indicators ("+0.02", "-0.12", "stable"). Omitted on first report.
- **Notes:** Compound pattern annotations, grace period status, anomaly flags. Only present when applicable.

**Formatting rules:** No ANSI escape codes. Scores at two decimal places. Tokens comma-formatted. Timestamps ISO 8601. Fixed-width alignment for score columns where practical.

#### 4.3.2 formatDiagnostics(snapshot: DiagnosticSnapshot): string

Produces a multi-line summary of the full diagnostic snapshot. Includes the report summary (identical to formatReport output for the latest report, or a "no reports yet" line) plus:

- **Session overview:** Duration (human-readable), total reports generated, total mutations (derived from timeline entry count by type).
- **Pattern history summary:** Total activations, total resolutions, currently active patterns, recurrence warnings for patterns with recurrenceCount > 1.
- **Performance overview:** Average selfTime for hot-path operations (add, assess, planEviction), cache hit rates for token/embedding/similarity caches, budget violation count. Omitted if no operations have been recorded.
- **Provider state:** Tokenizer name and accuracy classification, embedding mode and provider name.
- **Warnings:** Active warnings listed. "No warnings" if empty.

#### 4.3.3 formatPattern(pattern: ActivePattern): string

Produces a single-line or multi-line summary of one active pattern. Includes: severity in brackets, pattern name (prefixed with "Custom: " for custom patterns), explanation text, and the top remediation hint from the pattern's remediation array. Used for logging individual pattern events.

---

## 5. Test Requirements

Phase 4 is the integration test phase. Unit tests for `diagnostics` and `formatters` exist, but the primary test value is in integration tests that exercise full flows through the ContextLens class boundary.

### Unit tests

**`diagnostics.test.ts`:**
- Report history: ring buffer stores 20 summaries, oldest dropped at 21. Summary fields correctly extracted from full report.
- Rolling trends: correct direction classification (improving/stable/degrading at +/-0.01 threshold), correct averageRate, volatility, windowMin, windowMax. Null when fewer than 2 reports. Window is min(5, available).
- Anomaly detection: delta > 0.15 flagged. Correct likely-cause attribution from timeline events.
- Timeline: ring buffer stores 200 entries, monotonic sequence, correct event types from event subscriptions.
- Warnings: deduplication by message string, 50-entry bound, oldest dropped.
- Provider diagnostics: switch counters incremented, metadata updated on switch.
- Snapshot assembly: all fields present, correct types, deep copies returned.

**`formatters.test.ts`:**
- formatReport: correct header, score alignment, pattern ordering, trend lines. No ANSI codes. Two decimal places. Comma-formatted tokens. ISO timestamps. Empty window report produces meaningful output.
- formatDiagnostics: includes report summary, session overview, pattern history, performance, providers, warnings. Handles null latest report.
- formatPattern: correct severity prefix, pattern name, explanation text.
- All three functions are pure: same input produces same output. No side effects.

### Integration tests

In `test/integration/`, exercising the ContextLens class as the caller sees it.

**Seed-to-assess flow:** Construct with capacity. Seed 3 related segments. Add 2 more segments (triggers baseline capture). Call `assess()`. Verify: report has correct segment count, all four dimension scores in [0.0, 1.0], composite is geometric mean of dimensions, baseline is established, trend is null (first report).

**Double-assess caching:** After the above, call `assess()` again with no intervening mutations. Verify: returned report has the same scores and report ID (cache hit). Then add a segment, call `assess()` again. Verify: new report ID, scores recomputed.

**Task lifecycle flow:** Set task. Assess. Verify relevance scores against task. Refine task (similarity > 0.7). Verify: relevance invalidated, no grace period. Change task (similarity <= 0.7). Verify: grace period activates (2 reports). Assess twice to exhaust grace period. Clear task. Assess. Verify: all relevance = 1.0, gap pattern suppressed.

**Pattern detection flow:** Seed segments. Add segments until utilization exceeds saturation thresholds. Assess. Verify: saturation pattern active with correct severity. Evict segments to reduce utilization. Assess. Verify: saturation resolved (with hysteresis). Check diagnostics: pattern history shows activation and resolution.

**Eviction plan flow:** Seed segments (protected). Add segments (various importances). Set task. Assess. Plan eviction for target token count. Verify: plan excludes pinned segments, excludes seeds (default), candidates ordered by score, total reclaimable meets or exceeds target. Execute two evictions from the plan. Assess. Verify continuity tracking reflects the losses.

**Provider switch flow:** Start with approximate tokenizer. Add segments. Assess. Switch to mock exact tokenizer via setTokenizer. Verify: all segments recounted, quality cache invalidated, tokenizerChanged event fired. Assess. Verify: scores reflect new token counts. Check diagnostics: timeline shows tokenizerChanged entry.

**Embedding provider switch flow:** Start in trigram mode. Add segments. Assess. Set mock embedding provider via setEmbeddingProvider. Verify: full invalidation cascade (embedding cache cleared, similarity cache cleared, all segments re-embedded). Assess. Verify: report shows embeddingMode "embeddings". Set provider to null. Verify: fallback to trigrams.

**Diagnostics completeness flow:** Construct. Seed. Add. Set task. Assess (twice). Evict one segment. Assess. Call getDiagnostics(). Verify: all fields non-null where expected. latestReport matches the most recent assess. reportHistory has 3 entries. timeline has entries for seed, adds, task set, assessments, eviction. segmentCount/groupCount/evictedCount match reality. warnings present if applicable.

**Defensive copy flow:** Add a segment. Get the segment via getSegment(). Mutate the returned object (change content, change importance). Get the segment again. Verify: second retrieval returns the original values, not the mutated ones. Similarly: call assess(), mutate the returned report object, call assess() again, verify the cached report is unmodified.

**Atomic mutation flow:** Add a mock segment that will cause an embedding error on the next add (configure a failing mock embedding provider). Attempt to add a segment. Verify: the method throws ProviderError. Verify: segment count has not changed. Verify: the quality cache is still valid (no invalidation from failed mutation). Verify: no events were fired.

**Event ordering flow:** Subscribe to segmentAdded, reportGenerated, patternActivated. Add segments and assess. Verify: events fire in the correct order (segmentAdded before reportGenerated, patternActivated before reportGenerated within assess). Verify: handler errors are caught and swallowed (subscribe a throwing handler, verify the operation completes normally).

**Formatter integration flow:** Seed and add segments. Set task. Assess. Call formatReport on the returned report. Verify: output is a non-empty string with no ANSI codes, contains correct score values, contains pattern names if active. Call getDiagnostics(). Call formatDiagnostics on the snapshot. Verify: output includes session duration, report count, provider info.

### Property-based tests

Using fast-check via vitest, in `test/property/`:

- **Defensive copy isolation:** For any sequence of segment operations, mutating a returned object never affects subsequent reads from the instance.
- **Atomic mutation:** For any mutating operation that throws, the instance state (segment count, capacity, task state) is unchanged before and after the call.
- **Assess determinism:** For any sequence of operations followed by two assess() calls with no intervening mutations, the two reports have identical scores.
- **Diagnostic completeness:** For any sequence of operations, getDiagnostics() returns a snapshot with all required fields non-null (except latestReport before first assess).
- **Report history bounds:** For any number of assess() calls, the report history ring buffer never exceeds 20 entries.

---

## 6. Exit Criteria

All of the following must be true to complete Phase 4:

- The `ContextLens` class is implemented in `index.ts` and is the sole public export (alongside types, errors, and formatter functions).
- All 8 segment operations, 4 group operations, 4 task operations, `assess()`, `planEviction()`, `registerPattern()`, `setTokenizer()`, `setEmbeddingProvider()`, `setCapacity()`, all inspection methods, and `getDiagnostics()` are implemented and functional.
- The `diagnostics` module maintains report history (20-entry ring buffer), rolling trends (5-report window), session timeline (200-entry ring buffer), warning list (50-entry deduplicated), pattern history (surfaced from detection module), performance aggregation (from performance module), and provider diagnostics.
- `getDiagnostics()` completes in < 1ms (Tier 1), validated by benchmark. It triggers no scoring, no detection, no provider calls.
- All three formatter functions (`formatReport`, `formatDiagnostics`, `formatPattern`) are implemented as pure, stateless functions exported alongside the class. No ANSI codes, no side effects.
- Defensive copies at all public method boundaries (input and output). Verified by the defensive copy integration test and property-based test.
- Atomic mutations for all mutating methods. Verified by the atomic mutation integration test and property-based test.
- Quality cache invalidation fires correctly: any content mutation, task change, or provider switch sets `qualityCacheValid = false`. Repeated assess() with no intervening mutations returns cached report.
- All 24 events fire at the correct points with correct payloads. Event handler errors are caught and swallowed.
- The `assess()` call chain produces correct reports: scores match Phase 2 scorer output, detection matches Phase 3 detection output, trends and anomalies are correct.
- All integration tests pass for the 12 flows listed in section 5.
- All property-based tests pass for the 5 properties listed in section 5.
- No circular imports. `diagnostics` does not import `index.ts`. `formatters` imports only types.
- No upward imports from Phase 1--3 modules into Phase 4 modules.
- Phase 1--3 modules are not modified except for adding accessors or hooks required by Phase 4 consumers.
- The package's main entry point (`context-lens`) exports the ContextLens class, all public types, the three formatter functions, and the error hierarchy. Internal modules are not re-exported.
