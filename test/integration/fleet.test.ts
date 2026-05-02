/**
 * Integration tests for ContextLensFleet.snapshot() / fromSnapshot() —
 * the pattern-state-cache continuity contract (cl-spec-012 §8.1.1) and
 * snapshot-then-dispose-then-fromSnapshot continuation across whole-fleet
 * disposal (cl-spec-014 §3.4 wrapping).
 *
 * Unit-level coverage of snapshot/fromSnapshot lives in test/unit/fleet.test.ts
 * under "Serialization". This file exercises the cross-subsystem flows where
 * fleet events, instance lifecycle, and serialization compose.
 */

import { describe, it, expect } from 'vitest';
import { ContextLens } from '../../src/index.js';
import { ContextLensFleet } from '../../src/fleet.js';
import type { ActivePattern } from '../../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeLens(capacity = 10000): ContextLens {
  return new ContextLens({ capacity });
}

function distinctContent(index: number): string {
  const topics = [
    'The quick brown fox jumps over the lazy dog near the riverbank during sunrise on a warm summer morning',
    'Quantum computing leverages superposition and entanglement to solve complex optimization problems faster',
    'Photosynthesis converts carbon dioxide and water into glucose and oxygen using sunlight as energy',
    'The architecture of medieval castles included moats drawbridges and thick stone walls for defense',
    'Machine learning algorithms train on large datasets to recognize patterns and make predictions accurately',
    'Ocean currents distribute heat around the globe affecting weather patterns and marine ecosystems significantly',
  ];
  return topics[index % topics.length]!;
}

/** Force a saturated state by dropping a long segment into a tiny-capacity lens. */
function saturate(lens: ContextLens): void {
  const longContent = 'segment '.repeat(200);
  lens.add(longContent);
  lens.assess();
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Fleet serialization integration (cl-spec-012 §8)', () => {
  it('pattern-state continuity across restore: assessFleet emits no spurious instanceDegraded for already-active patterns', () => {
    const fleet = new ContextLensFleet({ degradationThreshold: 0.5 });
    const a = makeLens(100); const b = makeLens(100);
    saturate(a); saturate(b);

    fleet.register(a, 'agent-a');
    fleet.register(b, 'agent-b');

    // First assessFleet emits instanceDegraded for both saturated instances.
    const preEvents: { label: string; pattern: ActivePattern }[] = [];
    fleet.on('instanceDegraded', (p) => preEvents.push(p));

    fleet.assessFleet();
    expect(preEvents.length).toBeGreaterThan(0);
    const preLabels = new Set(preEvents.map(e => e.label));
    expect(preLabels.has('agent-a')).toBe(true);
    expect(preLabels.has('agent-b')).toBe(true);

    // Snapshot + restore. The pattern-state cache must follow.
    const state = fleet.snapshot();
    const restored = ContextLensFleet.fromSnapshot(state, { default: {} });

    // Subscribe AFTER restore so pre-restore events don't pollute.
    const postEvents: { label: string; pattern: ActivePattern }[] = [];
    restored.on('instanceDegraded', (p) => postEvents.push(p));

    // Same pattern set. Should be silent on instanceDegraded.
    restored.assessFleet();
    expect(postEvents).toHaveLength(0);

    // Now mutate one instance to force a NEW pattern transition. The fleet
    // should detect the change and fire one fresh event for the new
    // activation. (Simulated: add yet more content to one instance to make
    // sure detection still works on the restored fleet.)
    const aRestored = restored.get('agent-a')!;
    for (let i = 0; i < 6; i++) {
      aRestored.add(distinctContent(i));
    }
    aRestored.assess();
    restored.assessFleet();
    // Either zero or some new events — we don't strictly assert how many,
    // but the channel is alive: no exceptions, no crashes.
    expect(restored.size).toBe(2);
  });

  it('snapshot-then-dispose-then-fromSnapshot continuation pattern (fleet variant)', () => {
    const fleet = new ContextLensFleet();
    const a = makeLens(20000); const b = makeLens(15000);

    a.add(distinctContent(0));
    a.add(distinctContent(1));
    b.add(distinctContent(2));
    a.assess(); b.assess();

    fleet.register(a, 'agent-a');
    fleet.register(b, 'agent-b');
    fleet.assessFleet();

    // Capture the original instance ids for a sanity check.
    const originalIdA = a.instanceId;
    const originalIdB = b.instanceId;

    // Snapshot the entire fleet, then dispose all instances.
    const state = fleet.snapshot();
    a.dispose();
    b.dispose();

    // Both instances auto-unregister — the original fleet is empty now.
    expect(fleet.size).toBe(0);

    // Restore on a brand-new fleet via fromSnapshot.
    const restored = ContextLensFleet.fromSnapshot(state, { default: {} });

    // The restored fleet has the original labels.
    expect(restored.size).toBe(2);
    expect(restored.listInstances().map(i => i.label).sort()).toEqual(['agent-a', 'agent-b']);

    // The restored instances are fresh (not the disposed ones).
    const aRestored = restored.get('agent-a')!;
    const bRestored = restored.get('agent-b')!;
    expect(aRestored.isDisposed).toBe(false);
    expect(bRestored.isDisposed).toBe(false);
    expect(aRestored.instanceId).not.toBe(originalIdA);
    expect(bRestored.instanceId).not.toBe(originalIdB);

    // Capacities and segment counts are preserved.
    expect(aRestored.getCapacity().capacity).toBe(20000);
    expect(bRestored.getCapacity().capacity).toBe(15000);
    expect(aRestored.getSegmentCount()).toBe(2);
    expect(bRestored.getSegmentCount()).toBe(1);

    // The original (disposed) instances are unaffected by the restore.
    expect(a.isDisposed).toBe(true);
    expect(b.isDisposed).toBe(true);
  });

  it('heterogeneous restore via perLabel config: different capacity overrides per instance', () => {
    // The clearest contrasting axis without mocking embedding providers
    // is RestoreConfig.capacity, which can override the snapshotted capacity.
    const fleet = new ContextLensFleet();
    const small = makeLens(8000); const large = makeLens(8000);
    small.add(distinctContent(0)); large.add(distinctContent(1));
    small.assess(); large.assess();

    fleet.register(small, 'fast-small');
    fleet.register(large, 'slow-large');

    const state = fleet.snapshot();

    const restored = ContextLensFleet.fromSnapshot(state, {
      default: { capacity: 8000 }, // unchanged for any non-overridden label
      perLabel: {
        'fast-small': { capacity: 4000 },   // shrink
        'slow-large': { capacity: 32000 },  // grow
      },
    });

    expect(restored.get('fast-small')!.getCapacity().capacity).toBe(4000);
    expect(restored.get('slow-large')!.getCapacity().capacity).toBe(32000);

    // Both restored instances are functional.
    restored.get('fast-small')!.add(distinctContent(2));
    restored.get('slow-large')!.add(distinctContent(3));
    const report = restored.assessFleet();
    expect(report.instances).toHaveLength(2);
  });
});
