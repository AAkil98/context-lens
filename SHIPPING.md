# context-lens — Shipping Strategy

## Current state

Implementation complete. 33 build tasks across 5 phases done. 977 tests passing (unit, integration, e2e, property-based) + 12 performance benchmarks. All typechecks clean. Report assembler cache bug fixed. Testing coverage uplift complete (Phases A–E).

The library is functionally complete and tested. This document covers what remains before a v0.1.0 publish.

---

## Pre-publish checklist

### 1. Build verification

- [ ] `npm run build` produces clean ESM + CJS output
- [ ] All four sub-path exports resolve correctly: `context-lens`, `context-lens/fleet`, `context-lens/schemas`, `context-lens/otel`
- [ ] `package.json` `exports` field validated against published tarball structure
- [ ] `.d.ts` type declarations present for all entry points
- [ ] `npm pack --dry-run` lists only intended files (no specs, impl docs, test files)

### 2. Package hygiene

- [ ] Add `.npmignore` or `files` field in package.json to exclude: `specs/`, `impl/`, `test/`, `*.md` (except README), `tsconfig.json`, `vitest.config.ts`
- [ ] Verify `"type": "module"` works in both ESM and CJS consumer projects
- [ ] `peerDependencies` for `@opentelemetry/api` set with correct version range (`^1.0.0`)
- [ ] `engines` field in package.json (Node >= 18)
- [ ] `license` field matches LICENSE file

### 3. API surface audit

- [ ] All public exports from `src/index.ts` are intentional — no leaked internals
- [ ] Methods prefixed with `_` (e.g., `_restoreFromSnapshot`) are not exported
- [ ] `ContextLensConfig`, `SeedInput`, `RestoreConfig` types exported
- [ ] All 36 shared types from `types.ts` exported
- [ ] Error classes exported from main entry point

### 4. Documentation

- [ ] README has install, quick start, API overview, and architecture summary
- [ ] JSDoc on all public methods of `ContextLens`, `ContextLensFleet`, `ContextLensExporter`
- [ ] `@see` references to design specs in JSDoc
- [ ] CHANGELOG.md for v0.1.0 (initial release)

### 5. Known issues to resolve before v0.1.0

| Issue | Severity | Description |
|-------|----------|-------------|
| Baseline not wired | Low | `BaselineManager.notifyAdd()` never called from `ContextLens.captureBaseline()`. Baseline is never established through normal seed+add flow. Scores work correctly without it (raw scores used when baseline is null). Fix: call `baseline.notifyAdd(rawScores, ...)` inside `captureBaseline()` after the report is built. |
| assess@500 over budget | Low | O(n^2) similarity at 500 segments takes ~300ms vs 50ms budget. Sampling mitigates this in practice but the raw path exceeds spec. Consider tighter sampling or lazy similarity computation. |
| No dispose/cleanup | Info | No `dispose()` method on ContextLens. Event handlers and caches persist until GC. Fleet doesn't auto-unregister on instance disposal. Add `dispose()` in v0.2.0. |
| OTel exporter not re-attached on restore | Info | `fromSnapshot()` creates a new instance but doesn't re-attach OTel exporters. Caller must create a new exporter for the restored instance. Document this. |

### 6. Testing gaps to consider

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

- `dispose()` method for cleanup
- Coverage thresholds enforced in CI (`vitest.config.ts` — thresholds section already drafted in TEST_STRATEGY)
- Remove `fleet.ts` and `otel.ts` from coverage exclusions
- Address assess@500 performance (tighter sampling or incremental similarity)
- Fleet serialization support
- OTel exporter re-attachment helper for restored instances

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
