import { describe, it, expect } from 'vitest';
import { BaselineManager } from '../../../src/scoring/baseline.js';
import type { WindowScores, BaselineSnapshot } from '../../../src/types.js';

// ─── Helper ──────────────────────────────────────────────────────

function scores(c: number | null, d: number | null, r: number | null, t: number | null): WindowScores {
  return { coherence: c, density: d, relevance: r, continuity: t };
}

// ─── BaselineManager ─────────────────────────────────────────────

describe('BaselineManager', () => {
  it('is not established initially', () => {
    const bm = new BaselineManager();
    expect(bm.isEstablished()).toBe(false);
  });

  it('getSnapshot returns null before capture', () => {
    const bm = new BaselineManager();
    expect(bm.getSnapshot()).toBeNull();
  });

  it('normalize returns null before capture', () => {
    const bm = new BaselineManager();
    expect(bm.normalize(scores(0.5, 0.5, 0.5, 0.5))).toBeNull();
  });

  // ── notifyAdd ────────────────────────────────────────────────

  it('notifyAdd captures baseline on first call and returns true', () => {
    const bm = new BaselineManager();
    const captured = bm.notifyAdd(scores(0.8, 0.9, 0.7, 0.6), 3, 500, 1000);
    expect(captured).toBe(true);
    expect(bm.isEstablished()).toBe(true);

    const snap = bm.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.coherence).toBe(0.8);
    expect(snap!.density).toBe(0.9);
    expect(snap!.relevance).toBe(0.7);
    expect(snap!.segmentCount).toBe(3);
    expect(snap!.tokenCount).toBe(500);
    expect(snap!.capturedAt).toBe(1000);
  });

  it('notifyAdd returns false on subsequent calls (already captured)', () => {
    const bm = new BaselineManager();
    bm.notifyAdd(scores(0.8, 0.9, 0.7, 0.6), 3, 500, 1000);
    const second = bm.notifyAdd(scores(0.5, 0.5, 0.5, 0.5), 5, 800, 2000);
    expect(second).toBe(false);
  });

  it('captured snapshot always has continuity 1.0 regardless of input', () => {
    const bm = new BaselineManager();
    bm.notifyAdd(scores(0.8, 0.9, 0.7, 0.3), 2, 100, 1000);
    const snap = bm.getSnapshot()!;
    expect(snap.continuity).toBe(1.0);
  });

  it('null dimension scores default to 1.0 in captured baseline', () => {
    const bm = new BaselineManager();
    bm.notifyAdd(scores(null, null, null, null), 1, 50, 500);
    const snap = bm.getSnapshot()!;
    expect(snap.coherence).toBe(1.0);
    expect(snap.density).toBe(1.0);
    expect(snap.relevance).toBe(1.0);
    expect(snap.continuity).toBe(1.0);
  });

  // ── normalize ────────────────────────────────────────────────

  it('normalize: score below baseline returns fraction', () => {
    const bm = new BaselineManager();
    bm.notifyAdd(scores(0.8, 1.0, 0.5, 1.0), 2, 100, 1000);
    const result = bm.normalize(scores(0.4, 0.5, 0.25, 0.5))!;
    expect(result.coherence).toBeCloseTo(0.5, 10);   // 0.4 / 0.8
    expect(result.density).toBeCloseTo(0.5, 10);      // 0.5 / 1.0
    expect(result.relevance).toBeCloseTo(0.5, 10);    // 0.25 / 0.5
    expect(result.continuity).toBeCloseTo(0.5, 10);   // 0.5 / 1.0
  });

  it('normalize: score above baseline is clamped to 1.0', () => {
    const bm = new BaselineManager();
    bm.notifyAdd(scores(0.5, 0.5, 0.5, 1.0), 1, 50, 1000);
    const result = bm.normalize(scores(0.9, 1.0, 0.8, 1.5))!;
    expect(result.coherence).toBe(1.0);
    expect(result.density).toBe(1.0);
    expect(result.relevance).toBe(1.0);
    expect(result.continuity).toBe(1.0);
  });

  it('normalize: zero baseline with positive current returns 1.0', () => {
    const bm = new BaselineManager();
    // Force a zero baseline via rebaseline
    bm.rebaseline(scores(0, 0, 0, 0), 0, 0, 1000);
    // continuity baseline is always 1.0, but coherence/density/relevance are 0
    const result = bm.normalize(scores(0.5, 0.5, 0.5, 0.5))!;
    // baseline coherence stored is max(0, raw) = 0 since raw is 0
    // clampNorm(0.5, 0) → current > 0 ? 1.0 : 0.0 → 1.0
    expect(result.coherence).toBe(1.0);
    expect(result.density).toBe(1.0);
    expect(result.relevance).toBe(1.0);
    // continuity baseline is always 1.0, so 0.5 / 1.0 = 0.5
    expect(result.continuity).toBeCloseTo(0.5, 10);
  });

  it('normalize: zero baseline with zero current returns 0.0', () => {
    const bm = new BaselineManager();
    bm.rebaseline(scores(0, 0, 0, 0), 0, 0, 1000);
    const result = bm.normalize(scores(0, 0, 0, 0))!;
    expect(result.coherence).toBe(0.0);
    expect(result.density).toBe(0.0);
    expect(result.relevance).toBe(0.0);
    expect(result.continuity).toBe(0.0);
  });

  it('normalize: null dimension in input passes through as null', () => {
    const bm = new BaselineManager();
    bm.notifyAdd(scores(0.5, 0.5, 0.5, 0.5), 1, 50, 1000);
    const result = bm.normalize(scores(null, 0.3, null, 0.8))!;
    expect(result.coherence).toBeNull();
    expect(result.density).toBeCloseTo(0.6, 10); // 0.3 / 0.5
    expect(result.relevance).toBeNull();
    expect(result.continuity).toBeCloseTo(0.8, 10); // 0.8 / 1.0
  });

  // ── Immutability ─────────────────────────────────────────────

  it('baseline does not change after capture', () => {
    const bm = new BaselineManager();
    bm.notifyAdd(scores(0.8, 0.9, 0.7, 0.6), 3, 500, 1000);
    const snap1 = bm.getSnapshot()!;

    // Attempt to mutate the returned snapshot
    snap1.coherence = 0.0;

    const snap2 = bm.getSnapshot()!;
    expect(snap2.coherence).toBe(0.8);
  });

  // ── rebaseline ───────────────────────────────────────────────

  it('rebaseline replaces snapshot with new values', () => {
    const bm = new BaselineManager();
    bm.notifyAdd(scores(0.8, 0.9, 0.7, 0.6), 3, 500, 1000);

    bm.rebaseline(scores(0.5, 0.5, 0.5, 0.5), 5, 800, 2000);
    const snap = bm.getSnapshot()!;
    expect(snap.coherence).toBe(0.5);
    expect(snap.density).toBe(0.5);
    expect(snap.relevance).toBe(0.5);
    expect(snap.continuity).toBe(1.0); // Always 1.0
    expect(snap.segmentCount).toBe(5);
    expect(snap.tokenCount).toBe(800);
    expect(snap.capturedAt).toBe(2000);
  });

  // ── restoreSnapshot ──────────────────────────────────────────

  it('restoreSnapshot restores from serialized data', () => {
    const bm = new BaselineManager();
    const serialized: BaselineSnapshot = {
      coherence: 0.6,
      density: 0.7,
      relevance: 0.8,
      continuity: 1.0,
      capturedAt: 3000,
      segmentCount: 10,
      tokenCount: 1500,
    };

    bm.restoreSnapshot(serialized);

    expect(bm.isEstablished()).toBe(true);
    const snap = bm.getSnapshot()!;
    expect(snap.coherence).toBe(0.6);
    expect(snap.density).toBe(0.7);
    expect(snap.relevance).toBe(0.8);
    expect(snap.continuity).toBe(1.0);
    expect(snap.segmentCount).toBe(10);
    expect(snap.tokenCount).toBe(1500);
    expect(snap.capturedAt).toBe(3000);
  });

  it('restoreSnapshot makes defensive copy of input', () => {
    const bm = new BaselineManager();
    const serialized: BaselineSnapshot = {
      coherence: 0.6,
      density: 0.7,
      relevance: 0.8,
      continuity: 1.0,
      capturedAt: 3000,
      segmentCount: 10,
      tokenCount: 1500,
    };
    bm.restoreSnapshot(serialized);

    // Mutate the original input
    serialized.coherence = 0.0;

    const snap = bm.getSnapshot()!;
    expect(snap.coherence).toBe(0.6);
  });

  // ── Edge case ────────────────────────────────────────────────

  it('no seeds + immediate add captures degenerate baseline from raw scores', () => {
    const bm = new BaselineManager();
    // notifySeed never called, directly notifyAdd
    const captured = bm.notifyAdd(scores(0.2, 0.3, 0.1, 0.9), 1, 20, 100);
    expect(captured).toBe(true);
    const snap = bm.getSnapshot()!;
    expect(snap.coherence).toBe(0.2);
    expect(snap.density).toBe(0.3);
    expect(snap.relevance).toBe(0.1);
    expect(snap.continuity).toBe(1.0);
    expect(snap.segmentCount).toBe(1);
    expect(snap.tokenCount).toBe(20);
  });
});
