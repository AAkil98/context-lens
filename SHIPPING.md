# context-lens — Shipping Strategy

## Current state

**v0.1.0 published to npm 2026-04-09.** Phases 1–5 (33 tasks) shipped. 977 tests, 12 performance benchmarks, all typechecks clean.

**v0.2.0 Phase 6 (`feat/dispose-lifecycle`) implementation complete (T1–T17, 26 commits ahead of `main`).** Adds `dispose()`, `isDisposed`, `isDisposing`, `instanceId`, `stateDisposed` event, `DisposedError` / `DisposalError`, fleet auto-unregister + `instanceDisposed`, OTel auto-disconnect + `context_lens.instance.disposed`. 1116 tests across 39 files, 16 benchmark cases. Branch ready for merge / cut. The remaining v0.2.0 backlog items (coverage thresholds, assess@500 perf, fleet serialization, OTel re-attach helper) have not been built — see the v0.2.0 list below for the cadence question.

This document covers what remains before each release.

---

## Pre-publish checklist

### 1. Build verification

- [x] `npm run build` produces clean ESM + CJS output
- [x] All four sub-path exports resolve correctly: `context-lens`, `context-lens/fleet`, `context-lens/schemas`, `context-lens/otel`
- [x] `package.json` `exports` field validated against published tarball structure
- [x] `.d.ts` type declarations present for all entry points
- [x] `npm pack --dry-run` lists only intended files (no specs, impl docs, test files)

### 2. Package hygiene

- [x] Add `.npmignore` or `files` field in package.json to exclude: `specs/`, `impl/`, `test/`, `*.md` (except README), `tsconfig.json`, `vitest.config.ts`
- [x] Verify `"type": "module"` works in both ESM and CJS consumer projects
- [x] `peerDependencies` for `@opentelemetry/api` set with correct version range (`^1.0.0`)
- [x] `engines` field in package.json (Node >= 18)
- [x] `license` field matches LICENSE file

### 3. API surface audit

- [x] All public exports from `src/index.ts` are intentional — no leaked internals
- [x] Methods prefixed with `_` (e.g., `_restoreFromSnapshot`) are not exported (class inaccessible at runtime; type-only artifact of DTS bundling)
- [x] `ContextLensConfig`, `SeedInput`, `RestoreConfig` types exported
- [x] All shared types from `types.ts` exported via `export type *`
- [x] Error classes exported from main entry point (13 classes)

### 4. Documentation

- [x] README has install, quick start, API overview, and architecture summary
- [x] JSDoc on all public methods of `ContextLens`, `ContextLensFleet`, `ContextLensExporter`
- [x] `@see` references to design specs in JSDoc
- [x] CHANGELOG.md for v0.1.0 (initial release)

### 5. Known issues to resolve before v0.1.0

| Issue | Severity | Description |
|-------|----------|-------------|
| ~~Baseline not wired~~ | ~~Low~~ | **Fixed.** `captureBaseline()` now calls `baseline.notifyAdd()` with raw scores, then re-assesses with baseline established. |
| assess@500 over budget | Low | O(n^2) similarity at 500 segments takes ~300ms vs 50ms budget. Sampling mitigates this in practice but the raw path exceeds spec. Consider tighter sampling or lazy similarity computation. |
| No dispose/cleanup | Info | No `dispose()` method on ContextLens. Event handlers and caches persist until GC. Fleet doesn't auto-unregister on instance disposal. Add `dispose()` in v0.2.0. |
| OTel exporter not re-attached on restore | Info | `fromSnapshot()` creates a new instance but doesn't re-attach OTel exporters. Caller must create a new exporter for the restored instance. Document this. |

### 6. Testing gaps to consider (post v0.1.0)

- [ ] Browser/edge runtime compatibility (currently Node-only testing)
- [ ] Memory profiling under sustained load (1000+ segments over time)
- [ ] Concurrent access patterns (single-threaded by design, but document limitations)

---

## Release plan

### v0.1.0 — Initial release

**Scope:** Everything that's built. Ship what works.

- Fix baseline wiring (low effort, high correctness value)
- Package hygiene (npmignore, exports validation)
- JSDoc on public API surface
- CHANGELOG.md
- Publish to npm as `context-lens`

### v0.2.0 — Hardening

**Implemented (on `feat/dispose-lifecycle`, ready to ship):**
- [x] `dispose()` method for cleanup — Phase 6, T1–T17. Includes `isDisposed`/`isDisposing` getters, stable `instanceId`, `stateDisposed` event, `DisposedError`/`DisposalError`, fleet auto-unregister with `instanceDisposed` event, OTel auto-disconnect with `context_lens.instance.disposed` log, snapshot-then-dispose continuation pattern.

**Deferred — open question whether to bundle into v0.2.0 or split:**
- [ ] Coverage thresholds enforced in CI (`vitest.config.ts` — thresholds section already drafted in TEST_STRATEGY)
- [ ] Remove `fleet.ts` and `otel.ts` from coverage exclusions
- [ ] Address assess@500 performance (tighter sampling or incremental similarity)
- [ ] Fleet serialization support
- [ ] OTel exporter re-attachment helper for restored instances

The `dispose()` work is large and self-contained — shipping it as v0.2.0 alone (and rolling the rest into v0.2.1 or v0.3.0) is a viable cut.

### v0.3.0 — Developer experience

- Adapter packages: `context-lens-tiktoken`, `context-lens-openai-embeddings`
- Example projects: chatbot context manager, RAG window optimizer, multi-agent fleet dashboard
- API reference documentation (generated from JSDoc)
- Interactive playground

---

## CI pipeline (recommended)

```yaml
# .github/workflows/ci.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

Add benchmark regression tracking in v0.2.0 (vitest bench with `--outputJson` and comparison against baseline).

---

*context-lens shipping strategy -- authored by AAkil98*
