# CLAUDE.md — context-lens

## What this project is

context-lens is a TypeScript library that monitors context window quality for LLM applications. It measures four dimensions — coherence, density, relevance, continuity — and detects five degradation patterns, giving callers actionable signals beyond raw token count.

## Project state

The project is in the **implementation phase**. 14 design specs are complete and reviewed. 5 implementation specs define 33 build tasks across 5 phases. No source code exists yet.

- `IMPL_JOURNAL.md` — current task tracker (check here first for what to work on)
- `IMPLEMENTATION.md` — strategy document, tech stack, package structure, Phase 1 spec
- `impl/I-02-scoring-engine.md` through `impl/I-05-enrichments.md` — per-phase specs
- `specs/01-segment-model.md` through `specs/14-serialization.md` — design specs (the authoritative behavioral reference)
- `SEED_CONTEXT.md` — full project history and key decisions per spec

## Tech stack

- TypeScript 5.x, strict mode, `exactOptionalPropertyTypes`
- tsup (ESM + CJS dual build)
- vitest + fast-check (unit, integration, property-based, benchmarks)
- Zero runtime dependencies for core; `@opentelemetry/api` peer dep for `context-lens/otel` only

## Repository layout

```
specs/           14 design specs (read-only reference, do not modify)
impl/            4 per-phase implementation specs
src/             source code (TypeScript)
  scoring/       4 dimension scorers + baseline + composite
  utils/         hash, lru-cache, ring-buffer, copy
test/
  unit/          mirrors src/ structure
  integration/   full ContextLens class flows
  property/      fast-check invariant tests
  bench/         vitest benchmark suite
schemas/         JSON Schema files (spec 11)
```

## How to work on this project

### Task workflow

1. Check `IMPL_JOURNAL.md` for the next pending task
2. Read the relevant implementation spec section and design spec(s)
3. Implement the task
4. Run tests (`vitest run`)
5. Commit with a clean working tree — every task ends with a commit

### Build and test commands

```bash
npm run build        # tsup build
npm test             # vitest run
npm run test:watch   # vitest watch mode
npm run bench        # vitest bench
npm run typecheck    # tsc --noEmit
```

### Conventions

- **Files:** kebab-case (`segment-store.ts`, `quality-report.ts`)
- **Functions/methods:** camelCase
- **Types/classes:** PascalCase
- **Constants:** SCREAMING_SNAKE_CASE
- **Exports:** named only, no default exports
- **Enums:** string union types, not TypeScript `enum`
- **No `any`** in public API types

### Commit discipline

Each task in `IMPL_JOURNAL.md` is an atomic unit of work. After completing a task:
- All tests pass
- Working tree is clean (committed)
- Update the task's status in `IMPL_JOURNAL.md` to done
- Do not bundle multiple tasks into one commit

### Design spec references

When implementing, cite design specs as `cl-spec-NNN` (e.g., `cl-spec-002 SS5.4` for Quality Model section 5.4). In JSDoc, use `@see cl-spec-002 SS5.4`. Only add JSDoc to public API surface — internal code needs comments only where logic is non-obvious.

## Key architectural rules

- **Stateful:** one `ContextLens` instance = one context window. No shared state between instances.
- **Caller-driven:** context-lens never auto-evicts, auto-compacts, or auto-reorders. It measures and advises.
- **Atomic mutations:** every mutating method either completes fully or has no effect.
- **Defensive copies:** all public API inputs and outputs are deep-copied. Internal modules pass references.
- **Single-threaded:** no concurrency guards. Callers must serialize access in async environments.
- **No LLM calls:** all scoring uses structural signals (embeddings or Jaccard trigrams, not model inference).
- **Determinism:** same state + same `assessmentTimestamp` = same output. No `Date.now()` in scoring — the timestamp is captured once per `assess()` call.

## Performance budgets

At n <= 500 segments, excluding provider latency:

| Tier | Target | Operations |
|------|--------|------------|
| Queries | < 1 ms | getCapacity, getSegment, getDiagnostics, etc. |
| Mutations | < 5 ms | add, update, evict, restore, etc. |
| Assessment | < 50 ms | assess() |
| Planning | < 100 ms | planEviction() |
| Batch/rare | proportional | seed, split, snapshot, fromSnapshot |

## Things to avoid

- Do not modify files in `specs/` — design specs are frozen after review
- Do not add runtime dependencies to core (adapters for tiktoken, OpenAI, etc. are optional entry points)
- Do not use `Date.now()` inside scoring or detection — use `assessmentTimestamp` from the quality report
- Do not use TypeScript `enum` — use string union types
- Do not add default exports
- Do not skip the test task at the end of each phase — property-based tests catch invariant violations that unit tests miss
