---
id: cl-spec-014
title: Serialization
type: design
status: draft
created: 2026-04-04
revised: 2026-04-04
authors: [Akil Abderrahim, Claude Opus 4.6]
tags: [serialization, snapshot, restore, persistence, replay, export, state]
depends_on: [cl-spec-007, cl-spec-011]
---

# Serialization

## Table of Contents

1. Overview
2. What Is Serialized
3. Snapshot Production
4. Snapshot Format
5. State Restoration
6. Lightweight Snapshots
7. Format Versioning
8. Invariants and Constraints
9. References

---

## 1. Overview

context-lens is session-scoped. Instance state — segments, scores, patterns, history — lives in memory for the session's duration. When the process exits, the state is gone. This is by design: persistence adds complexity, and most callers do not need it. But some do.

Three use cases motivate opt-in serialization:

1. **Restart recovery.** A long-running agent saves context-lens state before shutdown and restores it after restart. The agent continues from where it left off — segments, baseline, pattern history, continuity ledger all intact. Without serialization, the agent would need to replay every segment addition and task change from scratch.

2. **Debugging replay.** A developer exports a session's full state for post-mortem analysis. The snapshot contains everything needed to reconstruct the instance — the developer can load it in a test environment, call `assess()`, and reproduce the exact quality report and pattern detection that the production session experienced.

3. **Analytics export.** A monitoring system collects periodic state snapshots from multiple context-lens instances (via cl-spec-012 Fleet Monitor or directly) and ships them to a data warehouse. The snapshots capture the quality trajectory, pattern history, and operational metrics of each session. For analytics, segment content is often unnecessary or sensitive — a lightweight snapshot omits content for cheaper transport and safe sharing.

This spec defines how instance state is serialized to a portable, JSON-safe format and how that format is restored into a functional instance. It is the only path for state persistence — there is no other mechanism for saving and loading context-lens state.

### What serialization is

- **Opt-in.** Callers who do not call `snapshot()` pay no serialization cost. The feature adds no overhead to normal operation.
- **Point-in-time.** A snapshot captures the instance's state at the moment of the call. It is a frozen copy — subsequent mutations do not affect it. Multiple snapshots can be taken at different points during a session.
- **Portable.** The serialized format is a plain JSON object — no class instances, no circular references, no platform-specific types. It can be stored in a file, sent over a network, or persisted in a database.
- **Provider-independent.** Provider instances (tokenizer, embedding) are not serialized. The caller re-provides them on restore. This means a snapshot can be restored with different providers — trading accuracy for portability.

### What serialization is not

Serialization is not automatic persistence. context-lens does not save state to disk, a database, or any external store. The caller calls `snapshot()`, receives a plain object, and decides what to do with it. `JSON.stringify`, write to a file, send to a queue — that is the caller's integration, not context-lens's responsibility.

Serialization is not incremental. Each snapshot is a complete copy of the instance state. There is no diff-based mechanism, no change log export, and no streaming serialization. For the expected instance sizes (hundreds of segments, not millions), full-copy serialization is simple, fast, and sufficient.

---

## 2. What Is Serialized

### 2.1 Included State

The snapshot captures everything needed to restore a fully functional instance that produces identical quality reports (given the same providers):

| State | Source spec | Why included |
|-------|------------|--------------|
| **All segments** (active + evicted with retained content) | cl-spec-001 | The segment collection is the core data. Content, metadata, protection, group membership, position order. |
| **All groups** | cl-spec-001 §5 | Group structure, membership, aggregate properties. |
| **Task state** | cl-spec-004 | Current descriptor, lifecycle state, transition history, grace period, staleness counters. |
| **Quality baseline** | cl-spec-002 §7 | Captured scores and metadata. Required for normalization. |
| **Continuity ledger** | cl-spec-002 §6 | Full eviction/compaction/restoration history. Continuity scoring depends on cumulative loss. |
| **Pattern tracking state** | cl-spec-003 §2.5 | Per-pattern active/inactive state, severity, hysteresis state. Required for deterministic detection on the first `assess()` after restore. |
| **Pattern history** | cl-spec-010 §4 | Per-pattern stats and the 50-entry history ring buffer. |
| **Session timeline** | cl-spec-010 §5 | The 200-entry event ring buffer. |
| **Report history** | cl-spec-010 §3 | The 20-entry report summary ring buffer and rolling trend state. |
| **Warnings** | cl-spec-010 §2.3 | Accumulated warnings. |
| **Configuration** | cl-spec-007 §2 | capacity, retainEvictedContent, pinnedCeilingRatio, patternThresholds, suppressedPatterns, hysteresisMargin, tokenCacheSize, embeddingCacheSize. |
| **Custom pattern metadata** | cl-spec-003 §10 | Name, description, priority, strategyHint for each registered custom pattern. Functions are not serialized (section 2.2). |
| **Provider metadata** | cl-spec-006, cl-spec-005 | Tokenizer name, accuracy, modelFamily, errorBound. Embedding provider name, dimensions, modelFamily. Used on restore to detect provider changes. |

### 2.2 Excluded State

The snapshot does **not** include:

| State | Why excluded |
|-------|-------------|
| **Provider instances** (tokenizer, embedding) | Functions and objects with external dependencies (network connections, native modules) are not JSON-serializable. The caller re-provides providers on restore. Provider *metadata* is serialized for change detection. |
| **Caches** (token count, embedding, similarity) | Caches are derived from segment content and provider behavior. They are rebuilt transparently on restore — the first operations after restore populate the caches. Serializing caches would bloat the snapshot (embedding cache alone can be 6–100MB per cl-spec-009 §6) without adding information that cannot be recomputed. |
| **Computed quality scores** | Scores are derived from segment content, provider behavior, and task state. They are recomputed on the first `assess()` after restore. Serializing scores would create a consistency risk — scores computed by one provider may differ from scores computed by the restored provider. |
| **Event handlers** | Closures. Not serializable. The caller re-registers handlers on the restored instance. |
| **Custom pattern functions** | `detect`, `severity`, `explanation`, `remediation` are functions — not serializable. Only metadata (name, description, priority, strategyHint) is preserved. The caller re-provides custom patterns on restore. |
| **Performance metrics** | Diagnostic counters (operation timings, cache hit rates, budget violation counts) are session-specific measurements. They are reset on restore. |

**Why not serialize caches as an optimization?** The embedding cache is the largest in-memory structure (cl-spec-009 §6). Pre-populating it on restore would avoid re-embedding all segments. But: (1) embedding vectors are provider-specific — if the provider changes on restore, cached vectors are invalid; (2) the cache is an LRU with bounded size — serializing it faithfully requires preserving access order, not just entries; (3) the snapshot size would increase dramatically (potentially 100MB+ for large windows with high-dimensional embeddings). The cost–benefit is unfavorable. Caches rebuild naturally as the instance is used after restore.

---

## 3. Snapshot Production

### 3.1 The snapshot Method

```
snapshot(options?: SnapshotOptions) → SerializedState
```

Produces a complete, self-contained state snapshot of the context-lens instance.

**SnapshotOptions:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `includeContent` | boolean | no | `true` | Whether to include segment content strings. When `false`, produces a lightweight snapshot (section 6). |

**Behavior:**

1. Assembles the full instance state into a plain object (section 4).
2. If `includeContent` is `false`, sets all segment content fields to `null` and marks the snapshot as non-restorable (section 6).
3. Sets `formatVersion` to the current snapshot format version.
4. Sets `schemaVersion` to the current schema version (cl-spec-011).
5. Sets `timestamp` to the current time.
6. Returns a defensive copy — the snapshot is a new object, not a reference to internal state.

**Performance:** Snapshot production is O(n) in the number of segments — it copies each segment's data. It does not trigger quality computation, provider calls, or cache operations. The snapshot reads existing state and copies it. For a 500-segment instance, snapshot production should complete in under 10ms (dominated by object allocation and string copying for content).

**Emits:** `stateSnapshotted` event with `{ timestamp, restorable, segmentCount, sizeEstimate }`.

The `sizeEstimate` is an approximate byte count of the serialized output (computed from segment content lengths and metadata sizes, not from `JSON.stringify` — the estimate is cheap, the exact count would require serialization). It gives event handlers a sense of the snapshot's size for logging and monitoring.

### 3.2 Snapshot Is Read-Only

`snapshot()` does not mutate instance state. It does not invalidate caches, trigger computation, emit quality events, or modify any field. It is a pure read operation that produces a new object. The instance is in exactly the same state after `snapshot()` as before.

This means `snapshot()` can be called at any point during a session — between mutations, between assessments, during a burst of operations — without affecting the instance's behavior. The caller does not need to plan around snapshot timing.

### 3.3 Multiple Snapshots

Multiple snapshots can be taken from the same instance at different points. Each is an independent copy of the state at its capture time. There is no relationship between snapshots — they do not reference each other, and restoring one does not affect others.

A caller who wants a quality timeline can take a snapshot after each `assess()` call, building a sequence of state captures over time. Each snapshot includes the full state, not a diff — there is no incremental snapshot mechanism.

---

## 4. Snapshot Format

### 4.1 SerializedState Structure

| Field | Type | Description |
|-------|------|-------------|
| `formatVersion` | string | Snapshot format version (section 7). |
| `schemaVersion` | string | Schema version (cl-spec-011 §2). |
| `timestamp` | number | When the snapshot was taken (epoch ms). |
| `restorable` | boolean | `true` if segment content is included, `false` for lightweight snapshots. |
| `instanceId` | string | Auto-generated instance identifier. Helps correlate snapshots to instances. |
| `sessionStartedAt` | number | When the instance was constructed (epoch ms). |
| `sessionDuration` | number | Milliseconds from construction to snapshot. |
| `config` | SerializedConfig | Instance configuration (section 4.2). |
| `providerMetadata` | ProviderMetadataSnapshot | Tokenizer and embedding metadata at snapshot time (section 4.3). |
| `segments` | SerializedSegment[] | All segments in position order (section 4.4). |
| `groups` | SerializedGroup[] | All groups (section 4.5). |
| `taskState` | TaskState | Full internal task state including descriptor, lifecycle, counters, grace period, and transition history (cl-spec-004 section 4.4). Includes transition history (cl-spec-004 section 5.4) as part of the serialized task state. |
| `baseline` | BaselineSnapshot or null | Quality baseline (cl-spec-007 §6.2). |
| `continuityLedger` | ContinuityEvent[] | Full continuity audit trail. |
| `patternTracking` | PatternTrackingSnapshot | Per-pattern detection state and history (section 4.6). |
| `timeline` | TimelineEntry[] | Session timeline (cl-spec-010 §5). |
| `reportHistory` | ReportSummary[] | Report summary ring buffer (cl-spec-010 §3.1). |
| `rollingTrend` | RollingTrend or null | Current rolling trend state (cl-spec-010 §3.2). |
| `warnings` | Warning[] | Accumulated warnings. |
| `customPatternMetadata` | CustomPatternMeta[] | Metadata for registered custom patterns (section 4.7). |
| `assessCount` | integer | Total `assess()` calls in the session. |
| `mutationCount` | integer | Total content-mutating operations in the session. |

### 4.2 SerializedConfig

| Field | Type | Description |
|-------|------|-------------|
| `capacity` | integer | Configured token capacity. |
| `retainEvictedContent` | boolean | Whether evicted content is retained. |
| `pinnedCeilingRatio` | number | Pinned token ceiling ratio. |
| `patternThresholds` | object or null | Per-pattern threshold overrides. |
| `suppressedPatterns` | string[] | Suppressed pattern names. |
| `hysteresisMargin` | number | Hysteresis margin. |
| `tokenCacheSize` | integer | Token cache LRU size. |
| `embeddingCacheSize` | integer | Embedding cache LRU size. |

The `customPatterns` configuration field is not included in SerializedConfig. Custom pattern metadata is serialized separately (section 4.7) because pattern functions are not serializable (section 2.2).

### 4.3 ProviderMetadataSnapshot

| Field | Type | Description |
|-------|------|-------------|
| `tokenizer` | object | `{ name, accuracy, modelFamily, errorBound }` — metadata from the active tokenizer at snapshot time. |
| `embedding` | object or null | `{ name, dimensions, modelFamily }` — metadata from the active embedding provider, or `null` in trigram mode. |

This metadata enables change detection on restore (section 5.3). The restore process compares snapshot provider metadata against the restore-time providers to determine whether recounting or re-embedding is needed.

### 4.4 SerializedSegment

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Segment identifier. |
| `content` | string or null | Segment content. `null` in lightweight snapshots or for evicted segments whose content was not retained. |
| `tokenCount` | integer | Token count at snapshot time (from the snapshot-time tokenizer). |
| `createdAt` | number | Insertion timestamp. |
| `updatedAt` | number | Last modification timestamp. |
| `protection` | string | Protection tier. |
| `importance` | number | Importance weight. |
| `origin` | string or null | Provenance label. |
| `tags` | string[] | Custom labels. |
| `groupId` | string or null | Group membership. |
| `state` | string | `"active"` or `"evicted"`. |
| `position` | integer | Ordering index in the segment collection. |

**Ordering.** Segments are serialized in position order — the same order they appear in `listSegments()`. Position is critical for coherence scoring (adjacency similarity) and for `restore()` semantics (segments are restored to their original position). The `position` field is an explicit integer index to make ordering unambiguous during deserialization.

### 4.5 SerializedGroup

| Field | Type | Description |
|-------|------|-------------|
| `groupId` | string | Group identifier. |
| `members` | string[] | Ordered member segment IDs. |
| `protection` | string | Effective protection. |
| `importance` | number | Effective importance. |
| `origin` | string or null | Group provenance. |
| `tags` | string[] | Group labels. |
| `state` | string | `"active"` or `"evicted"`. |
| `createdAt` | number | Group creation timestamp. |

### 4.6 PatternTrackingSnapshot

| Field | Type | Description |
|-------|------|-------------|
| `perPattern` | Record<string, PatternTrackingState> | Per-pattern detection state. Keyed by pattern name (base + custom). |
| `history` | PatternHistoryEntry[] | Pattern history ring buffer. |
| `perPatternStats` | Record<string, PatternStats> | Per-pattern summary statistics (cl-spec-010 ��4.1). |

**PatternTrackingState:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Pattern name. |
| `state` | string | `"active"` or `"resolved"`. |
| `activatedAt` | number or null | Current activation start. |
| `currentSeverity` | Severity or null | Current severity. |
| `severitySince` | number or null | When current severity was reached. |
| `peakSeverity` | Severity or null | Peak severity in current activation. |
| `peakAt` | number or null | When peak was reached. |
| `reportCount` | integer | Consecutive reports active. |
| `scoreHistory` | object[] | Recent primary scores (capped at 20). |
| `consecutiveNulls` | integer | For custom patterns: consecutive null detect returns (section 10.6 of cl-spec-003). |
| `resolvedAt` | number or null | When the pattern resolved in its current cycle. Null if currently active. |

This is the hysteresis state that the detection framework maintains between `assess()` calls. Without it, the first `assess()` after restore would not have the context needed for hysteresis — patterns could flicker on the restore boundary.

### 4.7 CustomPatternMeta

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Pattern name. |
| `description` | string | Human-readable description. |
| `priority` | integer | Priority value. |
| `strategyHint` | string or null | StrategyHint value. |
| `registeredAt` | number | When the pattern was registered (epoch ms). |
| `registrationOrder` | integer | Registration sequence number (for tie-breaking). |

Functions (`detect`, `severity`, `explanation`, `remediation`) are not included. They are re-provided by the caller on restore (section 5.4).

---

## 5. State Restoration

### 5.1 The fromSnapshot Method

```
ContextLens.fromSnapshot(state: SerializedState, config: RestoreConfig) → ContextLens
```

A static factory method that creates a new context-lens instance from a serialized snapshot. The returned instance is fully functional — all operations work as normal.

**RestoreConfig:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `capacity` | number | no | snapshot's capacity | Token capacity. May differ from the snapshot's — the caller might restore into a larger or smaller window. |
| `tokenizer` | TokenizerProvider or `"approximate"` | no | `"approximate"` | Tokenizer provider. Must be re-provided — not serialized. |
| `embeddingProvider` | EmbeddingProvider or null | no | `null` | Embedding provider. Must be re-provided. |
| `customPatterns` | PatternDefinition[] | no | `[]` | Custom pattern definitions to re-register. Matched to snapshot metadata by name. |

All other configuration fields (retainEvictedContent, pinnedCeilingRatio, thresholds, suppression, hysteresis, cache sizes) are restored from the snapshot. The caller can override capacity and providers — the most likely things to change between sessions — but the operational configuration is preserved.

### 5.2 Restore Sequence

The restore proceeds in a defined order:

1. **Validate format version.** Check `state.formatVersion` against supported versions. Throw `ConfigurationError` if unsupported.
2. **Create instance.** Construct with the merged config (snapshot config + RestoreConfig overrides). The instance starts empty.
3. **Restore segments.** Insert all segments from the snapshot in position order. Active segments and evicted segments are restored to their respective states. Content from the snapshot is used; token counts are recomputed with the restore-time tokenizer (section 5.3).
4. **Restore groups.** Recreate all groups with their membership and metadata.
5. **Restore task state.** Set the task descriptor, lifecycle state, transition history, grace period, and staleness counters.
6. **Restore baseline.** If the snapshot includes a baseline, restore it. The baseline is an immutable historical record — it is not recomputed.
7. **Restore continuity ledger.** Load the full eviction/compaction/restoration history.
8. **Restore pattern state.** Load per-pattern tracking state (hysteresis, severity, activation timestamps) and pattern history.
9. **Restore diagnostics.** Load timeline, report history, rolling trends, and warnings.
10. **Re-register custom patterns.** Match provided `customPatterns` to snapshot metadata by name (section 5.4). Register matched patterns. Log warnings for unmatched metadata.
11. **Detect provider changes.** Compare snapshot provider metadata against restore-time providers (section 5.3). Trigger recount or re-embed if needed.
12. **Invalidate quality scores.** All cached scores are marked stale. The first `assess()` after restore recomputes all scores.
13. **Emit `stateRestored` event** with `{ formatVersion, segmentCount, providerChanged, customPatternsRestored, customPatternsUnmatched }`.

**Atomicity.** If any step fails, the partially-constructed instance is discarded and an error is thrown. The caller does not receive a half-restored instance. This matches the atomic failure guarantee of the constructor (cl-spec-007 §10.3).

### 5.3 Provider Change Detection

The snapshot records provider metadata (section 4.3). On restore, the library compares this metadata against the restore-time providers:

**Tokenizer change.** If the restore tokenizer has a different `name` than the snapshot tokenizer, a full recount occurs: every segment's `tokenCount` is recomputed using the new tokenizer. This is the same operation as `setTokenizer` (cl-spec-007 §7.1) but happens during restore. Aggregate token counts and capacity metrics are updated accordingly.

If the tokenizer is the same, cached token counts from the snapshot are trusted — no recount needed.

**Embedding provider change.** If the restore embedding provider has a different `name` than the snapshot's (or the snapshot was in trigram mode and the restore has an embedding provider, or vice versa), all embeddings are recomputed. This triggers the same invalidation cascade as `setEmbeddingProvider` (cl-spec-007 §7.2): clear embedding cache, invalidate similarity cache, recompute embeddings for all active segments, recompute task embedding.

If the provider is the same, no re-embedding is needed — the embedding cache is empty (not serialized), but embeddings are recomputed lazily on the first `assess()`.

**Capacity change.** If the restore capacity differs from the snapshot's, the change is applied. This may shift utilization and saturation thresholds but does not trigger recounting or re-embedding.

### 5.4 Custom Pattern Restoration

Custom pattern functions are not serialized. On restore, the caller re-provides custom patterns via `RestoreConfig.customPatterns`. The restore process matches them to snapshot metadata by name:

| Scenario | Behavior |
|----------|----------|
| Pattern in snapshot AND in `customPatterns` (same name) | Pattern is registered. Priority and strategyHint from the provided `PatternDefinition` are used (not the snapshot values — the caller may have updated them). Pattern tracking state (hysteresis, history) from the snapshot is restored. |
| Pattern in snapshot but NOT in `customPatterns` | Pattern is not registered. A warning is emitted: `"Custom pattern '{name}' was active in snapshot but not provided for restore"`. Pattern history is preserved in the snapshot data (and visible in diagnostics via the `perPatternStats` and `history` fields) but the pattern is not evaluated in future `assess()` calls. |
| Pattern in `customPatterns` but NOT in snapshot | Pattern is registered as a new pattern. No tracking state to restore — it starts fresh, like a newly registered pattern. |

This design follows the same principle as provider restoration: the snapshot records what was there, the caller provides what should be there going forward. The snapshot is a state record, not a contract.

### 5.5 Restored Instance Behavior

After restore, the instance is fully functional:

- **`assess()`** recomputes all quality scores (caches are empty) and produces a quality report. The report reflects the restored segments, task state, and baseline. Pattern detection runs with the restored hysteresis state — patterns that were active at snapshot time will remain active if the quality scores still meet the thresholds.
- **All mutation operations** (`add`, `update`, `evict`, etc.) work normally. The restored instance is not read-only.
- **The timeline and history continue** from where the snapshot left off. New events are appended after the restored timeline entries. The timeline sequence numbers continue from the snapshot's highest sequence number + 1.
- **`getDiagnostics()`** returns a snapshot that includes both pre-restore history (from the snapshot) and post-restore activity.
- **`getDiagnostics().latestReport`** is null until the first `assess()` call, even if the original instance had generated reports. Quality reports are not serialized — they are recomputed on demand.

**External integrations.** Event handlers, fleet registrations, and OTel exporter subscriptions are not serialized or restored. Callers must re-attach these after `fromSnapshot()`. The restored instance's event system starts with no subscribers.

---

## 6. Lightweight Snapshots

### 6.1 Resolution of OQ-012: Two Modes, One Format

**Decision:** `snapshot()` supports an `includeContent` option. When `false`, segment content is omitted — the snapshot is cheaper to produce, smaller to store, and safe to share (no sensitive content). The format is identical; only the `content` fields differ.

**Why not two separate methods:** A lightweight snapshot is the same data minus content. A separate method (`snapshotLight()` or similar) would duplicate the serialization logic and introduce a second format. An option on `snapshot()` keeps the format unified and the API minimal.

**Why not always include content:** Content dominates snapshot size. A session with 500 segments of ~500 tokens each produces ~1MB of content. The rest of the snapshot — metadata, scores, history — is ~50KB. For analytics export, the content is unnecessary (consumers want scores, patterns, and trends, not the text). For cross-network transport, the content may be sensitive (PII, proprietary text). The lightweight option serves both constraints.

### 6.2 Lightweight Snapshot Properties

When `includeContent` is `false`:

- `restorable` is set to `false`.
- Every `SerializedSegment.content` is `null`.
- Everything else is identical to the full snapshot — metadata, scores, history, configuration, all present.

`fromSnapshot` rejects a non-restorable snapshot: if `state.restorable` is `false`, `fromSnapshot` throws a `ConfigurationError` with a clear message: `"Cannot restore from a lightweight snapshot — segment content was not included. Use snapshot({ includeContent: true }) to produce a restorable snapshot."`

**Why not allow restore with caller-provided content?** A restore from a lightweight snapshot would require the caller to provide content for every segment. The mapping would be by segment ID. This is technically possible but adds complexity: the caller must maintain a separate content store, correlate IDs, handle content that has been updated or compacted since the snapshot. The use cases for lightweight snapshots (analytics, export, monitoring) do not need restore. Keeping the rule simple — `restorable: false` means no restore — avoids an error-prone code path.

### 6.3 Size Comparison

| Component | Full snapshot | Lightweight snapshot |
|-----------|:---:|:---:|
| Segment content | ~1MB (500 segments × ~2KB) | 0 |
| Segment metadata | ~25KB | ~25KB |
| Groups | ~2KB | ~2KB |
| Task state | ~1KB | ~1KB |
| Baseline | ~0.1KB | ~0.1KB |
| Continuity ledger | ~5KB | ~5KB |
| Pattern tracking | ~3KB | ~3KB |
| Timeline | ~30KB | ~30KB |
| Report history | ~4KB | ~4KB |
| Warnings | ~2KB | ~2KB |
| Config + metadata | ~1KB | ~1KB |
| **Total** | **~1.1MB** | **~100KB** |

Estimates for a typical 500-segment session. The lightweight snapshot is ~10x smaller, dominated by the timeline and history buffers.

---

## 7. Format Versioning

### 7.1 Format Version

The `formatVersion` field identifies the snapshot format:

```
"context-lens-snapshot-v1"
```

The format version is distinct from the schema version (cl-spec-011). The schema version describes the shape of output types (QualityReport, etc.). The format version describes the shape of the serialized state — which fields are present, what their types are, how segments and groups are encoded.

**Why separate from schema version:** The snapshot format may change independently of the output schemas. Adding a new internal state field to the snapshot (e.g., a new cache metric) changes the format but not the output schemas. Conversely, adding a new field to QualityReport changes the schema but not necessarily the snapshot format (the snapshot stores the report history, which stores ReportSummary, which may or may not include the new field).

### 7.2 Forward Compatibility

**Unknown fields are ignored.** A deserializer for format v1 that encounters a field not defined in v1 silently ignores it. This allows future format versions to add fields without breaking older deserializers. The cost: an older deserializer restoring a newer snapshot may lose the new fields — but the restored instance is still functional, just missing the new state.

### 7.3 Backward Compatibility

The reference implementation maintains a deserializer for each published format version. When `fromSnapshot` receives a snapshot with `formatVersion: "context-lens-snapshot-v1"`, it uses the v1 deserializer regardless of the library's current format version. This means snapshots produced by older library versions can be restored by newer library versions.

**Migration on restore.** When restoring a snapshot in an older format, the restore process fills in any fields that are new in the current version with their default values. A snapshot from format v1 restored by a library that uses format v2 will have the v2 fields initialized to defaults — the restored instance is fully functional but does not have history for the v2-specific state.

---

## 8. Invariants and Constraints

**Invariant 1: Snapshot equivalence.** A restored instance produces the same `assess()` result as the original instance would have, given the same providers. Formally: if instance A takes a snapshot S, and instance B is created from `fromSnapshot(S, sameConfig)` with identical providers, then `B.assess()` produces the same quality scores, patterns, and composite as `A.assess()` would at the same state. Timestamps differ (they reflect wall-clock time at computation), but scores are identical.

*Caveat:* "Same providers" means the same tokenizer and embedding provider (by name and behavior). If the providers differ, scores may differ — this is expected and correct. Provider metadata comparison (section 5.3) detects this case.

**Invariant 2: Snapshot is read-only.** `snapshot()` does not mutate instance state. It does not invalidate caches, trigger computation, emit quality events, or modify any field of the instance. Calling `snapshot()` ten times in a row produces ten identical snapshots (assuming no interleaved mutations) and leaves the instance unchanged.

**Invariant 3: Restored instance is valid.** `fromSnapshot` produces an instance that satisfies all invariants from cl-spec-007 §11. Every mutation operation, query, assessment, and diagnostic call works correctly on a restored instance. There is no "restored mode" or restricted operation set — the instance is indistinguishable from one that was built incrementally through API calls.

**Invariant 4: Round-trip fidelity.** `fromSnapshot(instance.snapshot(), sameConfig)` produces an equivalent instance — same segments, same metadata, same groups, same task state, same baseline, same continuity ledger, same pattern tracking state, same history. The first `assess()` on both instances produces the same scores. This is the serialization round-trip guarantee.

**Invariant 5: Format version presence.** Every serialized snapshot includes a `formatVersion` field. `fromSnapshot` checks this field before proceeding. An absent or unrecognized format version causes `fromSnapshot` to throw a `ConfigurationError`. There is no "guess the format" fallback.

**Invariant 6: Content completeness for restore.** If `restorable` is `true`, every active segment in the snapshot has non-null `content`. If `restorable` is `false`, `fromSnapshot` rejects the snapshot. There is no partial-content restore.

**Invariant 7: No circular references.** The serialized snapshot is a tree. `JSON.stringify` on the snapshot never throws a circular reference error. This follows from the internal data model having no circular references (cl-spec-011 invariant 7) and the snapshot being a copy of that model.

**Invariant 8: Atomic restore.** `fromSnapshot` either returns a fully functional instance or throws an error. There is no partially-restored instance. If segment 247 of 500 fails to deserialize, the entire restore fails and no instance is returned.

---

## 9. References

| Reference | Description |
|-----------|-------------|
| `cl-spec-001` (Segment Model) | Defines segments, groups, protection, position ordering — all serialized in the snapshot. |
| `cl-spec-002` (Quality Model) | Defines baseline, continuity ledger, quality scores — baseline and ledger serialized, scores recomputed on restore. |
| `cl-spec-003` (Degradation Patterns) | Defines pattern detection state, hysteresis, pattern history — all serialized. Custom pattern metadata (§10) serialized, functions re-provided. |
| `cl-spec-004` (Task Identity) | Defines task state, transition history — all serialized. |
| `cl-spec-005` (Embedding Strategy) | Defines embedding cache and provider interface — cache not serialized, provider re-provided, metadata preserved for change detection. |
| `cl-spec-006` (Tokenization Strategy) | Defines token cache and tokenizer interface — cache not serialized, provider re-provided, metadata preserved for change detection. |
| `cl-spec-007` (API Surface) | Defines `snapshot()` and `fromSnapshot()` as API methods. Defines constructor config restored from snapshot. |
| `cl-spec-010` (Report & Diagnostics) | Defines report history, pattern history, timeline, performance metrics, warnings — all serialized. |
| `cl-spec-011` (Report Schema) | Defines schema versioning conventions followed by the snapshot format. Shared type definitions referenced by the snapshot structure. |

---

*context-lens -- authored by Akil Abderrahim and Claude Opus 4.6*
