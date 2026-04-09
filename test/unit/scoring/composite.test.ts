import { describe, it, expect } from 'vitest';
import {
  computeComposite,
  computeSegmentComposite,
} from '../../../src/scoring/composite.js';

// ─── Weights (mirror source constants for reference) ─────────────

const W_C = 0.25;
const W_D = 0.20;
const W_R = 0.30;
const W_T = 0.25;
const W_TOTAL = W_C + W_D + W_R + W_T;

// ─── computeComposite ───────────────────────────────────────────

describe('computeComposite', () => {
  it('all 1.0 returns 1.0', () => {
    expect(computeComposite(1.0, 1.0, 1.0, 1.0)).toBeCloseTo(1.0, 10);
  });

  it('any dimension null returns null', () => {
    expect(computeComposite(null, 1.0, 1.0, 1.0)).toBeNull();
    expect(computeComposite(1.0, null, 1.0, 1.0)).toBeNull();
    expect(computeComposite(1.0, 1.0, null, 1.0)).toBeNull();
    expect(computeComposite(1.0, 1.0, 1.0, null)).toBeNull();
  });

  it('all dimensions null returns null', () => {
    expect(computeComposite(null, null, null, null)).toBeNull();
  });

  it('coherence at 0 collapses composite to 0', () => {
    expect(computeComposite(0, 0.8, 0.9, 0.7)).toBe(0);
  });

  it('density at 0 collapses composite to 0', () => {
    expect(computeComposite(0.8, 0, 0.9, 0.7)).toBe(0);
  });

  it('relevance at 0 collapses composite to 0', () => {
    expect(computeComposite(0.8, 0.9, 0, 0.7)).toBe(0);
  });

  it('continuity at 0 collapses composite to 0', () => {
    expect(computeComposite(0.8, 0.9, 0.7, 0)).toBe(0);
  });

  it('known values: weighted geometric mean matches manual computation', () => {
    const c = 0.8;
    const d = 0.6;
    const r = 0.9;
    const t = 0.7;

    // Weighted geometric mean:
    // (c^wc * d^wd * r^wr * t^wt) ^ (1 / W_TOTAL)
    const logSum =
      W_C * Math.log(c) +
      W_D * Math.log(d) +
      W_R * Math.log(r) +
      W_T * Math.log(t);
    const expected = Math.exp(logSum / W_TOTAL);

    const result = computeComposite(c, d, r, t);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(expected, 10);
  });

  it('known values: second set', () => {
    const c = 0.5;
    const d = 0.5;
    const r = 0.5;
    const t = 0.5;

    // All equal => geometric mean = 0.5
    const result = computeComposite(c, d, r, t);
    expect(result).toBeCloseTo(0.5, 10);
  });

  it('result is in [0, 1] for valid inputs in [0, 1]', () => {
    // A spread of test values
    const testValues = [0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
    for (const c of testValues) {
      for (const d of testValues) {
        for (const r of testValues) {
          for (const t of testValues) {
            const result = computeComposite(c, d, r, t)!;
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('lower scores produce lower composite', () => {
    const high = computeComposite(0.9, 0.9, 0.9, 0.9)!;
    const low = computeComposite(0.3, 0.3, 0.3, 0.3)!;
    expect(high).toBeGreaterThan(low);
  });

  it('relevance weight (0.30) has most influence', () => {
    // Drop relevance from 1.0 to 0.5 vs drop coherence from 1.0 to 0.5
    const dropRelevance = computeComposite(1.0, 1.0, 0.5, 1.0)!;
    const dropCoherence = computeComposite(0.5, 1.0, 1.0, 1.0)!;
    // Relevance has weight 0.30 vs coherence 0.25, so dropping relevance hurts more
    expect(dropRelevance).toBeLessThan(dropCoherence);
  });
});

// ─── computeSegmentComposite ─────────────────────────────────────

describe('computeSegmentComposite', () => {
  it('all 1.0 returns 1.0', () => {
    expect(computeSegmentComposite(1.0, 1.0, 1.0, 1.0)).toBeCloseTo(1.0, 10);
  });

  it('never returns null', () => {
    const result = computeSegmentComposite(0.5, 0.5, 0.5, 0.5);
    expect(result).toBeTypeOf('number');
  });

  it('zero collapse: any dimension at 0 returns 0', () => {
    expect(computeSegmentComposite(0, 0.5, 0.5, 0.5)).toBe(0);
    expect(computeSegmentComposite(0.5, 0, 0.5, 0.5)).toBe(0);
    expect(computeSegmentComposite(0.5, 0.5, 0, 0.5)).toBe(0);
    expect(computeSegmentComposite(0.5, 0.5, 0.5, 0)).toBe(0);
  });

  it('same formula as computeComposite for non-null inputs', () => {
    const c = 0.8, d = 0.6, r = 0.9, t = 0.7;
    const windowResult = computeComposite(c, d, r, t)!;
    const segResult = computeSegmentComposite(c, d, r, t);
    expect(segResult).toBeCloseTo(windowResult, 10);
  });

  it('result is in [0, 1] for valid inputs in [0, 1]', () => {
    const testValues = [0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
    for (const c of testValues) {
      for (const d of testValues) {
        for (const r of testValues) {
          for (const t of testValues) {
            const result = computeSegmentComposite(c, d, r, t);
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});
