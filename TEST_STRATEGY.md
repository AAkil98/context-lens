# context-lens — Testing Strategy: Coverage Uplift

## 1. Current State

**794 tests across 34 files.** All passing. Test-to-source ratio: 1.23x (12,600 test LOC / 10,200 source LOC).

### What exists

| Layer | Files | Tests | Coverage quality |
|-------|------:|------:|------------------|
| Unit (modules) | 22 | 635 | Strong for internal modules; absent for main class |
| Integration | 2 | 21 | Basic happy-path workflows |
| Property-based | 5 | 42 | Good invariant coverage per phase |
| **Total** | **34** | **794** | |

### Critical gaps

1. **No unit tests for `ContextLens` class** (1,022 lines) — the entire public API surface is tested only through integration tests. Methods like `replace()`, `compact()`, `split()`, `listSegments()`, `getBaseline()`, `setEmbeddingProvider()`, `getConfig()`, `getConstructionTimestamp()`, `getTaskState()`, and `getEvictedSegments()` have zero direct test coverage.

2. **Report assembler cache stale after mutations** — `add()`, `evict()`, `compact()`, `replace()`, `split()`, `restore()` set `qualityCacheValid = false` but do not call `reportAssembler.invalidate()`. The inner cache returns stale reports after these mutations unless a task or provider change occurred. This means the seed-then-add flow produces a baseline report that persists through subsequent mutations. Existing integration tests mask this by using loose assertions (`toBeGreaterThanOrEqual` instead of `toBe`).

3. **Coverage tool excludes `fleet.ts` and `otel.ts`** — `vitest.config.ts` line 12 explicitly excludes both from coverage measurement despite having 481 and 370 source lines respectively.

4. **No end-to-end lifecycle tests** — no test exercises the full lifecycle: construct, seed, add, set task, assess, evict, compact, restore, change task, re-assess, plan eviction, snapshot, fromSnapshot, re-assess. The integration tests are isolated scenarios, not sequential narratives.

5. **No adversarial/negative tests at API level** — error paths are well-tested at the module level but not at the `ContextLens` API level (e.g., evicting a pinned segment, restoring without retained content, adding after capacity exceeded).

6. **No performance regression tests** — performance budgets are defined in the spec but never enforced via test assertions.

7. **No non-ASCII tokenizer tests** — the approximate tokenizer has CJK, emoji, and diacritics handling paths (5 character-class branches) with no test coverage.

---

## 2. Coverage Target

**Goal: >95% branch coverage across all source files, with comprehensive integration and end-to-end coverage.**

### Metric targets

| Metric | Current (est.) | Target |
|--------|------:|------:|
| Statement coverage | ~70% | >95% |
| Branch coverage | ~55% | >90% |
| Function coverage | ~75% | >98% |
| Line coverage | ~70% | >95% |

### Infrastructure changes

1. **Remove coverage exclusions** — delete `exclude: ['src/otel.ts', 'src/fleet.ts']` from `vitest.config.ts`.
2. **Add coverage thresholds** — fail CI if coverage drops below targets:
   ```ts
   coverage: {
     provider: 'v8',
     include: ['src/**/*.ts'],
     thresholds: {
       statements: 95,
       branches: 90,
       functions: 98,
       lines: 95,
     },
   },
   ```
3. **Add `coverage` script** — `"coverage": "vitest run --coverage"` in package.json.

---

## 3. Uplift Plan

### Phase A — ContextLens class unit tests (highest impact)

**New file: `test/unit/context-lens.test.ts`**

The main class (1,022 lines, 40+ public methods) has no dedicated unit test file. Every method needs direct testing with controlled inputs, not just integration coverage.

#### A.1: Constructor and configuration

| Test | Validates |
|------|-----------|
| Constructs with minimal config (capacity only) | Defaults applied correctly |
| Constructs with all options specified | Full config snapshot stored |
| Rejects capacity = 0, negative, float, missing | 4 ConfigurationError paths |
| Rejects pinnedCeilingRatio outside (0, 1] | Boundary: 0 (rejected), 0.01, 1.0 (accepted), 1.01 (rejected) |
| Rejects non-integer tokenCacheSize, embeddingCacheSize | Validation branches |
| Rejects non-boolean retainEvictedContent | Type check branch |
| getConfig() returns deep copy of construction config | Defensive copy invariant |
| getConstructionTimestamp() returns a number | Timestamp captured |

#### A.2: Segment operations (add, seed, update, replace, compact, split)

| Test | Validates |
|------|-----------|
| add() returns Segment with auto-generated ID | ID format: `auto:<hash>` |
| add() with explicit ID, importance, origin, tags, groupId | All options forwarded |
| add() duplicate content returns DuplicateSignal | Dedup path |
| add() invalidates quality cache | `qualityCacheValid = false` |
| seed() batch insert with seed protection default | Protection = 'seed' |
| seed() empty array returns empty array | No-op path |
| seed() with non-empty content validation | Throws ValidationError |
| seed() late seeding after add emits warning | `lateSeeding` event |
| seed() triggers baseline capture on first subsequent add | Baseline lifecycle |
| update() changes metadata only (no recount) | importance, tags, origin |
| update() changes content (recount + embedding prep) | Token recount triggered |
| replace() swaps content, preserves ID and position | Full content replacement |
| compact() reduces token count | CompactionError if not shorter |
| compact() on pinned segment | Throws ProtectionError |
| compact() records in continuity ledger | Compaction event |
| split() produces children at original position | Position inheritance |
| split() inherits metadata and group membership | Child metadata |
| split() on pinned segment | Throws ProtectionError |

#### A.3: Eviction and restoration

| Test | Validates |
|------|-----------|
| evict() single segment | Returns single EvictionRecord |
| evict() grouped segment evicts all members | Returns EvictionRecord[] |
| evict() pinned segment | Throws ProtectionError |
| evict() records in continuity ledger | Eviction cost tracked |
| evict() invalidates quality cache | Cache invalidation |
| restore() single segment to original position | Position preserved |
| restore() grouped eviction restores all members | Atomic group restore |
| restore() without retained content | Throws RestoreError |
| getEvictedSegments() returns deep copies | Defensive copy |

#### A.4: Group operations

| Test | Validates |
|------|-----------|
| createGroup() with valid segment IDs | Group created, members assigned |
| createGroup() with segment already in a group | Throws MembershipError |
| dissolveGroup() returns freed segments | Members regain individual identity |
| getGroup() returns null for unknown ID | Null path |
| listGroups() returns all active groups | Enumeration |

#### A.5: Assessment and planning

| Test | Validates |
|------|-----------|
| assess() with segments produces QualityReport | Full report structure |
| assess() with 0 segments produces null composite | Empty window |
| assess() returns cached report on second call | Cache hit |
| assess() returns fresh report after mutation | Cache invalidation |
| assess() fires reportGenerated event | Event emission |
| assess() fires patternActivated when pattern detected | Pattern event lifecycle |
| planEviction() triggers assess() if no cached report | Auto-assess |
| planEviction() returns EvictionPlan | Plan structure |

#### A.6: Task operations

| Test | Validates |
|------|-----------|
| setTask() new task returns transition type 'new' | First task |
| setTask() similar task returns 'refinement' | Similarity threshold |
| setTask() different task returns 'change' | Low similarity |
| setTask() same task returns 'same' | Identical descriptor |
| clearTask() resets to unset | Task cleared |
| getTask() returns null when unset | Null state |
| getTaskState() full lifecycle state | All fields populated |

#### A.7: Provider management

| Test | Validates |
|------|-----------|
| setTokenizer() recounts all segments | Token recount triggered |
| setTokenizer() emits tokenizerChanged event | Event with old/new names |
| setTokenizer() invalidates caches | Quality + similarity caches |
| setEmbeddingProvider() sets new provider | Provider switch |
| setEmbeddingProvider(null) removes provider | Back to trigram mode |
| setEmbeddingProvider() emits embeddingProviderChanged | Event with old/new names |
| getTokenizerInfo() returns metadata | Name, accuracy, etc. |
| getEmbeddingProviderInfo() returns null when no provider | Null path |
| setCapacity() updates capacity | New capacity value |
| setCapacity() rejects non-positive-integer | Throws ValidationError |
| setCapacity() emits capacityChanged event | Event with old/new values |

#### A.8: Inspection and diagnostics

| Test | Validates |
|------|-----------|
| getSegment() returns deep copy | Mutation isolation |
| getSegment() returns null for unknown ID | Null path |
| getSegmentCount() matches active segments | Count accuracy |
| listSegments() returns ordered active segments | Order preservation |
| getBaseline() returns null before seed | Pre-baseline state |
| getDiagnostics() returns DiagnosticSnapshot | Full snapshot structure |
| getPerformance() returns instrumentation module | Module access |
| getDetection() returns detection engine | Module access |
| registerPattern() adds custom pattern | Custom pattern lifecycle |
| registerPattern() emits customPatternRegistered | Event |

#### A.9: Serialization

| Test | Validates |
|------|-----------|
| snapshot() returns SerializedState with all state | Full snapshot |
| snapshot({ includeContent: false }) lightweight mode | Content nulled |
| snapshot() emits stateSnapshotted event | Event with metadata |
| fromSnapshot() restores full instance | Round-trip fidelity |
| fromSnapshot() rejects invalid format version | ConfigurationError |
| fromSnapshot() rejects non-restorable snapshot | ConfigurationError |
| fromSnapshot() detects tokenizer change, recounts | Provider detection |
| fromSnapshot() detects embedding change, clears cache | Provider detection |
| fromSnapshot() with RestoreConfig overrides | Config merging |

---

### Phase B — End-to-end lifecycle tests

**New file: `test/e2e/lifecycle.test.ts`**

Full user-journey tests that exercise the system as a coherent whole, not isolated features.

#### B.1: Complete session lifecycle

One test that runs through the entire lifecycle:

```
construct(capacity: 8000)
  → seed 3 segments (system prompt, persona, tools)
  → add 2 conversation turns
  → setTask("Summarize the Q3 report")
  → assess() → verify report structure, 5 segments, task active
  → add 3 more turns (filling context)
  → assess() → verify scores changed, utilization rose
  → planEviction() → verify candidates exclude pinned/seed
  → evict top candidate
  → assess() → verify continuity dropped, segment count reduced
  → compact a segment with summary
  → assess() → verify density change
  → setTask("Draft the executive summary") → transition type = 'change'
  → assess() → verify relevance shifted
  → clearTask()
  → assess() → verify relevance = neutral
  → snapshot()
  → fromSnapshot() with same providers
  → assess() on both → verify identical scores
  → add new content to restored instance
  → assess() → verify restored instance diverges
```

#### B.2: Protection tier enforcement end-to-end

```
construct(capacity: 500)
  → seed 1 pinned segment (200 tokens)
  → seed 1 seed-protected segment (100 tokens)
  → add 1 priority(500) segment (100 tokens)
  → add 3 default segments (100 tokens each → 300 tokens, total = 700, over capacity)
  → assess() → saturation pattern detected
  → planEviction() → verify:
    - default segments first in plan
    - priority(500) before seed
    - seed before pinned (but pinned never appears)
    - evict top 2 candidates → total under capacity
  → evict both
  → assess() → saturation resolved
  → restore one
  → assess() → verify restoration in continuity ledger
```

#### B.3: Pattern lifecycle end-to-end

```
construct(capacity: 500)
  → add 6 large segments (fill to 90%+)
  → assess() → saturation pattern active
  → subscribe to patternActivated, patternResolved events
  → evict 2 segments (drop to ~60%)
  → assess() → saturation resolved, patternResolved fires
  → add 4 near-identical segments (high redundancy)
  → assess() → erosion pattern active
  → evict 3 of the duplicates
  → assess() → erosion resolved
  → verify: event history shows activation → resolution for each pattern
```

#### B.4: Task-driven relevance lifecycle

```
construct(capacity: 10000)
  → add 5 segments about "machine learning"
  → setTask("Explain neural network architectures")
  → assess() → high relevance (task aligns with content)
  → setTask("Write a recipe for pasta") → transition = 'change'
  → assess() → relevance drops (content ≠ task), gap pattern may activate
  → add 2 segments about cooking
  → assess() → relevance recovers (new content matches task)
  → clearTask()
  → assess() → relevance = neutral
```

#### B.5: Fleet orchestration end-to-end

```
  → create 3 instances: agent-1 (healthy), agent-2 (saturated), agent-3 (fragmented)
  → register all with fleet
  → assessFleet()
  → verify: aggregate computed, hotspots list agent-2 and agent-3
  → verify: ranking puts worst first
  → fix agent-2 (evict segments)
  → assessFleet()
  → verify: instanceRecovered fires for agent-2
  → verify: hotspots updated
```

#### B.6: Serialization across provider change

```
  → construct with approximate tokenizer
  → populate 5 segments
  → assess()
  → snapshot()
  → fromSnapshot with custom exact tokenizer (counts differently)
  → verify: all segments recounted
  → assess() on both → scores differ (different token weights)
  → verify: both reports are structurally valid (schema validation)
```

#### B.7: OTel export end-to-end

```
  → create instance + mock OTel meterProvider + mock loggerProvider
  → attach ContextLensExporter
  → add segments, assess → verify 9 gauges updated, assess_count incremented
  → evict segment → verify evictions_total incremented
  → setTask (change) → verify task_changes_total incremented, task.changed log emitted
  → trigger saturation → verify pattern.activated log emitted with WARN severity
  → disconnect exporter
  → assess again → verify no new metric updates
  → verify: all log events have common attributes (window, tokenizer, embedding_mode)
```

---

### Phase C — Branch coverage for internal modules

Targeted tests to reach >90% branch coverage in modules where integration tests don't reach all paths.

#### C.1: `quality-report.ts` — uncovered branches

| Branch | Test |
|--------|------|
| 0 segments → null scores, null composite | Assess empty window |
| 1 segment → no pairwise coherence | Single segment coherence |
| Embedding mode fallback (not all segments have vectors) | Partial embedding coverage |
| Trend computation with no previous report | First report, no trend |
| Trend computation with previous report | Second report, trend computed |
| Report assembler cache hit (`dirty = false`) | Two assess calls, no mutation between |

#### C.2: `detection.ts` — uncovered branches

| Branch | Test |
|--------|------|
| Pattern suppression via suppressedPatterns config | Configure suppression, trigger pattern, verify suppressed |
| Custom pattern function throws | Register pattern with throwing detect(), verify fail-open |
| Hysteresis margin: score oscillates near threshold | Score at threshold ± margin, verify no flicker |
| Compound pattern detection (all 6 compounds) | Trigger each compound's co-pattern conditions |
| Pattern history ring buffer full (>50 entries) | Generate 51+ pattern events, verify oldest evicted |
| Grace period suppresses gap pattern | Set task, assess within grace period, verify no gap |

#### C.3: `eviction.ts` — uncovered branches

| Branch | Test |
|--------|------|
| Strategy auto-selection from active patterns | Each pattern → correct strategy selected |
| No eviction candidates (all pinned) | Verify exhausted = true, empty candidates |
| Group eviction with bridge score | Group members with high bridge score ranked lower |
| Compaction recommendation generated | Segment eligible for compaction, verify recommendation |
| Target met exactly | Evict enough to hit target exactly |
| Target not met (shortfall) | Not enough candidates, verify shortfall > 0 |

#### C.4: `segment-store.ts` — uncovered branches

| Branch | Test |
|--------|------|
| Auto-ID collision with suffix | Two segments with same FNV hash → suffix appended |
| Evict segment without retained content | `retainEvictedContent: false`, verify content discarded |
| Restore with provided content override | Restore evicted segment with new content |
| Group token count recomputation | Add/remove members, verify aggregate updates |
| Segment reorder after restore | Restore to original position between other segments |

#### C.5: `tokenizer.ts` — non-ASCII branches

| Branch | Test |
|--------|------|
| CJK ideographs (U+4E00–U+9FFF) | `"你好世界"` → 4 tokens |
| CJK extensions (U+3400–U+4DBF, etc.) | Extended CJK ranges |
| Emoji (U+1F600+) | `"😀🎉"` → approx 0.7 tokens |
| Combining diacritics | `"café"` with combining marks |
| Mixed ASCII + CJK + emoji | `"Hello 世界 😀"` → sum of per-class estimates |
| Empty string | 0 tokens |
| Whitespace only | 0 tokens (whitespace = 0 per char) |
| Provider switch with recount | Switch provider, verify all segment token counts updated |

#### C.6: `diagnostics.ts` — uncovered branches

| Branch | Test |
|--------|------|
| Rolling trend computation with <3 reports | Not enough data for trend line |
| Anomaly flag threshold crossing | Score deviation > 0.15 from rolling average |
| Timeline ring buffer full (200 entries) | Generate 201+ timeline events |
| Performance summary with zero operations | No assess() calls, empty stats |
| Warning accumulation | Multiple warnings from different sources |

#### C.7: `performance.ts` — uncovered branches

| Branch | Test |
|--------|------|
| Budget violation detection | Operation exceeds tier target |
| Sampling parameters at n > 200 | Verify sampling activated |
| P95 calculation with few samples | < 20 samples, verify P95 still computed |
| Operation tier lookup for unknown operation | Fallback to highest tier |

#### C.8: `schemas/` — uncovered branches

| Branch | Test |
|--------|------|
| validate() with nested oneOf failure | Nullable field with wrong non-null type |
| validate() with unresolved $ref | Tampered schema with bad $ref |
| validate() with additionalProperties schema | Map-typed field validation |
| validate() with array minItems/maxItems | Array length constraints |
| toJSON() with all nullable fields null | Every optional field absent |
| toJSON() with all nullable fields populated | Every optional field present |

---

### Phase D — Property-based tests (invariant hardening)

**Extend `test/property/` with new invariant tests.**

#### D.1: Defensive copy universality

```
For any sequence of operations:
  - Mutating a returned Segment, Group, Report, Plan, Snapshot
    never changes internal state
  - Mutating an input (AddOptions, TaskDescriptor, etc.)
    after passing to a method never changes stored state
```

#### D.2: Event count consistency

```
For any sequence of add/evict/restore/compact/split operations:
  - Number of segmentAdded events = number of successful add() calls
  - Number of segmentEvicted events = number of evicted segments (including group members)
  - Number of reportGenerated events = number of non-cached assess() calls
```

#### D.3: Token accounting invariant

```
For any sequence of mutations:
  - sum(seg.tokenCount for seg in listSegments()) = getCapacity().totalActiveTokens
  - getCapacity().utilization = totalActiveTokens / capacity
  - getCapacity().headroom = capacity - totalActiveTokens
```

#### D.4: Position stability

```
For any add/evict/restore sequence:
  - listSegments() order is insertion order minus evicted segments
  - Restored segments return to their original position
  - No two active segments share a position
```

#### D.5: Score determinism

```
For any instance state:
  - Two consecutive assess() calls with no mutations between
    produce identical reportId, scores, patterns
  - fromSnapshot(snapshot) + assess() produces identical composite score
    as the original instance's last assess()
```

#### D.6: Protection tier ordering

```
For any planEviction() result:
  - All default candidates ranked before all priority(n) candidates
  - All priority(n) ranked before all seed candidates
  - No pinned segments appear as candidates
  - Within same tier: lower importance first
```

#### D.7: Fleet aggregate math

```
For any set of ContextLens instances registered in a fleet:
  - aggregate.{dim}.mean = arithmetic mean of ok instances' {dim} scores
  - aggregate.{dim}.min <= aggregate.{dim}.mean <= aggregate.{dim}.max
  - aggregate.{dim}.stddev >= 0
  - ranking length = assessedCount
  - ranking[0].rank = 1, ranking[last].rank = assessedCount
  - ranking composites are non-decreasing
```

#### D.8: Schema validation universality

```
For any sequence of operations followed by:
  - assess() → toJSON() → validate.qualityReport() = valid
  - getDiagnostics() → toJSON() → validate.diagnosticSnapshot() = valid
  - planEviction() → toJSON() → validate.evictionPlan() = valid
And after JSON.parse(JSON.stringify(json)):
  - Validation still passes (round-trip safe)
```

---

### Phase E — Performance regression tests

**New file: `test/bench/budgets.bench.ts`**

Using vitest `bench` mode, assert that operations stay within budget at key segment counts.

| Benchmark | Segments | Budget | Asserts |
|-----------|------:|------:|---------|
| getCapacity | 500 | < 1 ms | Tier 1 |
| getSegment | 500 | < 1 ms | Tier 1 |
| getDiagnostics | 500 | < 1 ms | Tier 1 |
| add (single) | 500 | < 5 ms | Tier 2 |
| evict (single) | 500 | < 5 ms | Tier 2 |
| assess | 100 | < 50 ms | Tier 3 |
| assess | 500 | < 50 ms | Tier 3 (budget boundary) |
| planEviction | 100 | < 100 ms | Tier 4 |
| planEviction | 500 | < 100 ms | Tier 4 (budget boundary) |
| snapshot | 500 | < 500 ms | Tier 5 (proportional) |
| fromSnapshot | 500 | < 500 ms | Tier 5 (proportional) |
| assessFleet (10 instances x 50 segments) | 500 total | < 600 ms | Fleet overhead |

---

## 4. Implementation Order

| Priority | Phase | New tests (est.) | Impact |
|:--------:|:-----:|------:|--------|
| **P0** | Config: remove exclusions, add thresholds | 0 | Visibility |
| **P1** | A: ContextLens unit tests | ~80 | Covers the #1 gap |
| **P1** | B: End-to-end lifecycle tests | ~15 | Catches integration regressions |
| **P2** | C: Branch coverage for internals | ~60 | Reaches 90%+ branches |
| **P2** | D: Property-based invariants | ~15 | Catches subtle regressions |
| **P3** | E: Performance benchmarks | ~12 | Prevents budget drift |
| | **Total new tests** | **~182** | |

Estimated final test count: **~976 tests** (794 existing + ~182 new).

---

## 5. Test file layout (final state)

```
test/
  unit/
    context-lens.test.ts       ← NEW (Phase A) — ContextLens class unit tests
    segment-store.test.ts      ← existing + Phase C additions
    detection.test.ts          ← existing + Phase C additions
    eviction.test.ts           ← existing + Phase C additions
    quality-report.test.ts     ← existing + Phase C additions
    diagnostics.test.ts        ← existing + Phase C additions
    performance.test.ts        ← existing + Phase C additions
    tokenizer.test.ts          ← existing + Phase C additions
    similarity.test.ts         ← existing
    embedding.test.ts          ← existing
    task.test.ts               ← existing
    events.test.ts             ← existing
    errors.test.ts             ← existing
    fleet.test.ts              ← existing
    otel.test.ts               ← existing
    schema.test.ts             ← existing + Phase C additions
    serialization.test.ts      ← existing
    formatters.test.ts         ← existing
    scoring/                   ← existing
    utils/                     ← existing
  integration/
    context-lens.test.ts       ← existing
    phase5.test.ts             ← existing
  e2e/
    lifecycle.test.ts          ← NEW (Phase B) — full session journeys
  property/
    phase1.test.ts             ← existing
    phase2.test.ts             ← existing
    phase3.test.ts             ← existing
    phase4.test.ts             ← existing
    phase5.test.ts             ← existing + Phase D additions
  bench/
    budgets.bench.ts           ← NEW (Phase E) — performance budgets
```

---

## 6. Bug to fix before uplift

The report assembler cache (`QualityReportAssembler.dirty` flag) is not invalidated by `add()`, `evict()`, `compact()`, `replace()`, `split()`, or `restore()` in the `ContextLens` class. Only `setTask()`, `clearTask()`, `setTokenizer()`, and `setEmbeddingProvider()` call `reportAssembler.invalidate()`. This means `assess()` can return stale `segmentCount` and scores after content mutations if the assembler cache was populated by a prior `assess()` or baseline capture.

**Fix:** Add `this.reportAssembler.invalidate()` to every mutating method in `ContextLens` that sets `this.qualityCacheValid = false`. This should be done before the coverage uplift begins, as many new tests will depend on correct post-mutation assessment behavior.

---

*context-lens testing strategy -- authored by AAkil98*
