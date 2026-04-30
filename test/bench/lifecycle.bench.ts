/**
 * Phase 6 — lifecycle microbenchmarks (cl-spec-015).
 *
 * Three benchmarks from impl-spec I-06 §5:
 *   1. dispose-empty          — target < 0.5 ms
 *   2. dispose-500            — target < 10 ms (the dispose call itself; see note below)
 *   3. guardDispose live path — target < 100 ns
 *
 * Run with: npm run bench
 *
 * Note on construction overhead. vitest's bench(name, fn, options) only
 * forwards tinybench's Bench-level Options (time/iterations/setup/teardown
 * cycle hooks) — not per-iteration FnOptions like beforeEach. So any per-
 * iteration "fresh fixture" construction has to live inside the timed
 * function body, which contaminates the measurement. This is the same
 * tradeoff as the existing budgets.bench.ts patterns (e.g. `add (single)`
 * constructs a 499-segment lens before each timed add). For dispose-empty
 * the fixture is trivial — construction is sub-millisecond. For dispose-500
 * the construction dominates: the reported number is "construct 500 + assess
 * + dispose", not "dispose alone". The bench is still useful as a regression
 * sentinel — if dispose itself slows down 10×, the total grows accordingly.
 */

import { bench, describe } from 'vitest';
import { ContextLens } from '../../src/index.js';
import { guardDispose } from '../../src/lifecycle.js';

// ─── Helpers ────────────────────────────────────────────────────

const TOPICS = [
  'The quick brown fox jumps over the lazy dog near the riverbank during sunrise on a warm summer morning',
  'Quantum computing leverages superposition and entanglement to solve complex optimization problems faster',
  'Photosynthesis converts carbon dioxide and water into glucose and oxygen using sunlight as energy',
  'The architecture of medieval castles included moats drawbridges and thick stone walls for defense',
  'Machine learning algorithms train on large datasets to recognize patterns and make predictions accurately',
  'Ocean currents distribute heat around the globe affecting weather patterns and marine ecosystems significantly',
  'Renaissance artists developed perspective techniques that transformed painting and visual representation forever',
  'Distributed systems require consensus protocols to maintain consistency across multiple networked nodes reliably',
];

function content(i: number): string {
  return TOPICS[i % TOPICS.length]! + ` variant ${i}`;
}

function populatedLens(n: number): ContextLens {
  const lens = new ContextLens({ capacity: 1_000_000 });
  for (let i = 0; i < n; i++) {
    lens.add(content(i), { id: `seg-${i}` });
  }
  return lens;
}

// ─── 1. dispose-empty (target < 0.5 ms) ────────────────────────

describe('dispose — empty instance', () => {
  bench('dispose on empty lens', () => {
    const lens = new ContextLens({ capacity: 10000 });
    lens.dispose();
  });
});

// ─── 2. dispose-500 (target < 10 ms; construction-contaminated) ─

describe('dispose — 500 segments + assessed', () => {
  bench('dispose on 500-segment lens (includes construction)', () => {
    const lens = populatedLens(500);
    lens.assess();   // populate baseline + report cache + diagnostics
    lens.dispose();
  });
});

// ─── 3. guardDispose live-path (target < 100 ns) ───────────────

// guardDispose runs at the top of every public method on the live path.
// Measurement on the live state — the function returns silently. The
// instanceId is held outside the timed callback so we don't include
// property access in the per-call cost.

describe('guardDispose — live path', () => {
  const lens = new ContextLens({ capacity: 10000 });
  const id = lens.instanceId;

  bench('guardDispose("live", "add", instanceId)', () => {
    guardDispose('live', 'add', id);
  });

  bench('guardDispose("live", "getCapacity", instanceId)', () => {
    guardDispose('live', 'getCapacity', id);
  });
});
