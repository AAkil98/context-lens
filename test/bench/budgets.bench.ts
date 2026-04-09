/**
 * Phase E — Performance regression benchmarks
 *
 * Asserts operations stay within budget at key segment counts.
 * Run with: npm run bench
 * @see TEST_STRATEGY.md §3, Phase E
 * @see cl-spec-009 (Performance Budget)
 */

import { bench, describe } from 'vitest';
import { ContextLens } from '../../src/index.js';
import { ContextLensFleet } from '../../src/fleet.js';

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
  'Volcanic eruptions release magma gases and ash into the atmosphere impacting climate for years afterward',
  'Functional programming emphasizes immutable data pure functions and declarative composition over imperative mutation',
];

function content(i: number): string {
  return TOPICS[i % TOPICS.length]! + ` variant ${i}`;
}

function populatedLens(n: number, capacity = 1_000_000): ContextLens {
  const lens = new ContextLens({ capacity });
  for (let i = 0; i < n; i++) {
    lens.add(content(i), { id: `seg-${i}` });
  }
  return lens;
}

// ─── Tier 1: Queries (< 1 ms) ──────────────────────────────────

describe('Tier 1 — Queries @ 500 segments', () => {
  const lens = populatedLens(500);
  lens.assess();

  bench('getCapacity', () => {
    lens.getCapacity();
  });

  bench('getSegment', () => {
    lens.getSegment('seg-250');
  });

  bench('getDiagnostics', () => {
    lens.getDiagnostics();
  });
});

// ─── Tier 2: Hot-path mutations (< 5 ms) ───────────────────────

describe('Tier 2 — Mutations @ 500 segments', () => {
  // Pre-create lenses; each iteration uses a fresh one to avoid state accumulation.
  // Since add/evict are fast, the overhead of populatedLens is measured separately.
  bench('add (single)', () => {
    const lens = populatedLens(499);
    lens.add(content(499), { id: 'seg-499' });
  });

  bench('evict (single)', () => {
    const lens = populatedLens(500);
    lens.evict('seg-0');
  });
});

// ─── Tier 3: Assessment (< 50 ms) ──────────────────────────────

describe('Tier 3 — Assessment @ 100 segments', () => {
  // Pre-create lens. Force cache invalidation each iteration via setCapacity.
  const lens100 = populatedLens(100);
  let cap100 = 1_000_000;

  bench('assess @ 100', () => {
    cap100++;
    lens100.setCapacity(cap100);
    lens100.assess();
  });
});

describe('Tier 3 — Assessment @ 500 segments', () => {
  const lens500 = populatedLens(500);
  let cap500 = 1_000_000;

  bench('assess @ 500', () => {
    cap500++;
    lens500.setCapacity(cap500);
    lens500.assess();
  });
});

// ─── Tier 4: Planning (< 100 ms) ───────────────────────────────

describe('Tier 4 — Eviction planning', () => {
  const lens100 = populatedLens(100);
  lens100.assess();

  const lens500 = populatedLens(500);
  lens500.assess();

  bench('planEviction @ 100 segments', () => {
    lens100.planEviction({ targetTokens: 100 });
  });

  bench('planEviction @ 500 segments', () => {
    lens500.planEviction({ targetTokens: 100 });
  });
});

// ─── Tier 5: Batch/rare (< 500 ms) ─────────────────────────────

describe('Tier 5 — Snapshot @ 500 segments', () => {
  const lens = populatedLens(500);
  lens.assess();

  bench('snapshot', () => {
    lens.snapshot();
  });
});

describe('Tier 5 — fromSnapshot @ 500 segments', () => {
  const lens = populatedLens(500);
  lens.assess();
  const snap = lens.snapshot();

  bench('fromSnapshot', () => {
    ContextLens.fromSnapshot(snap);
  });
});

// ─── Fleet overhead ─────────────────────────────────────────────

describe('Fleet — 10 instances x 50 segments', () => {
  // Pre-populate instances
  const instances: ContextLens[] = [];
  for (let i = 0; i < 10; i++) {
    instances.push(populatedLens(50));
  }

  bench('assessFleet', () => {
    const fleet = new ContextLensFleet();
    for (let i = 0; i < 10; i++) {
      fleet.register(instances[i]!, `agent-${i}`);
    }
    fleet.assessFleet();
  });
});
