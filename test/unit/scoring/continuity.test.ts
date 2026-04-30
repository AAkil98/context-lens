import { describe, it, expect, beforeEach } from 'vitest';
import { ContinuityTracker } from '../../../src/scoring/continuity.js';

describe('ContinuityTracker', () => {
  let ct: ContinuityTracker;

  beforeEach(() => {
    ct = new ContinuityTracker();
  });

  // ── No events ──────────────────────────────────────────────────

  describe('no events', () => {
    it('getSegmentContinuity returns 1.0 for unknown segment', () => {
      expect(ct.getSegmentContinuity('s1')).toBe(1.0);
    });

    it('getWindowContinuity returns 1.0', () => {
      expect(ct.getWindowContinuity()).toBe(1.0);
    });

    it('getSummary returns all zeros', () => {
      const s = ct.getSummary();
      expect(s.totalEvictions).toBe(0);
      expect(s.totalCompactions).toBe(0);
      expect(s.totalRestorations).toBe(0);
      expect(s.netLoss).toBe(0);
      expect(s.tokensEvicted).toBe(0);
      expect(s.tokensCompacted).toBe(0);
      expect(s.tokensRestored).toBe(0);
      expect(s.recentEvents).toEqual([]);
    });
  });

  // ── recordEviction ─────────────────────────────────────────────

  describe('recordEviction', () => {
    it('computes cost = relevance * importance * tokenFraction', () => {
      const cost = ct.recordEviction(
        's1',
        /* tokenCount */ 100,
        /* importance */ 0.8,
        /* relevanceAtEviction */ 0.6,
        /* totalActiveTokens */ 1000,
        /* timestamp */ 1000,
      );

      // tokenFraction = 100/1000 = 0.1
      // cost = 0.6 * 0.8 * 0.1 = 0.048
      expect(cost).toBeCloseTo(0.048, 10);
    });

    it('cost is 0 when totalActiveTokens is 0', () => {
      const cost = ct.recordEviction('s1', 100, 0.8, 0.6, 0, 1000);
      expect(cost).toBe(0);
    });

    it('ledger entry appears in summary', () => {
      ct.recordEviction('s1', 100, 0.8, 0.6, 1000, 1000);
      const s = ct.getSummary();
      expect(s.totalEvictions).toBe(1);
      expect(s.tokensEvicted).toBe(100);
    });
  });

  // ── recordCompaction ───────────────────────────────────────────

  describe('recordCompaction', () => {
    it('computes cost = compressionRatio * importance * (1 - redundancy)', () => {
      const cost = ct.recordCompaction(
        's1',
        /* originalTokenCount */ 200,
        /* compactedTokenCount */ 100,
        /* importance */ 0.5,
        /* redundancy */ 0.2,
        /* timestamp */ 2000,
      );

      // compressionRatio = 1 - 100/200 = 0.5
      // cost = 0.5 * 0.5 * (1 - 0.2) = 0.5 * 0.5 * 0.8 = 0.2
      expect(cost).toBeCloseTo(0.2, 10);
    });

    it('sets segmentContinuity = 1 - cost', () => {
      const cost = ct.recordCompaction('s1', 200, 100, 0.5, 0.2, 2000);
      const continuity = ct.getSegmentContinuity('s1');
      expect(continuity).toBeCloseTo(1.0 - cost, 10);
    });

    it('segmentContinuity is clamped to >= 0', () => {
      // Maximum cost scenario: compressionRatio=1, importance=1, redundancy=0
      // cost = 1 * 1 * 1 = 1.0 → continuity = max(0, 1-1) = 0
      ct.recordCompaction('s1', 200, 0, 1.0, 0.0, 2000);
      expect(ct.getSegmentContinuity('s1')).toBe(0);
    });

    it('ledger entry appears in summary', () => {
      ct.recordCompaction('s1', 200, 100, 0.5, 0.2, 2000);
      const s = ct.getSummary();
      expect(s.totalCompactions).toBe(1);
      expect(s.tokensCompacted).toBe(100); // original - compacted
    });
  });

  // ── recordRestoration ──────────────────────────────────────────

  describe('recordRestoration', () => {
    it('computes fidelity from eviction relevance', () => {
      // First evict
      ct.recordEviction('s1', 100, 0.8, 0.6, 1000, 1000);

      // Then restore with lower relevance
      const fidelity = ct.recordRestoration(
        's1',
        /* tokenCount */ 100,
        /* relevanceAfterRestore */ 0.3,
        /* timestamp */ 2000,
      );

      // fidelity = min(1, 0.3 / 0.6) = 0.5
      expect(fidelity).toBeCloseTo(0.5, 10);
    });

    it('sets segmentContinuity to fidelity', () => {
      ct.recordEviction('s1', 100, 0.8, 0.6, 1000, 1000);
      const fidelity = ct.recordRestoration('s1', 100, 0.3, 2000);
      expect(ct.getSegmentContinuity('s1')).toBeCloseTo(fidelity, 10);
    });

    it('fidelity is 1.0 when relevance >= original', () => {
      ct.recordEviction('s1', 100, 0.8, 0.6, 1000, 1000);
      const fidelity = ct.recordRestoration('s1', 100, 0.9, 2000);
      // fidelity = min(1, 0.9/0.6) = min(1, 1.5) = 1.0
      expect(fidelity).toBe(1.0);
    });

    it('fidelity is 1.0 when no eviction entry found', () => {
      const fidelity = ct.recordRestoration('s_unknown', 100, 0.5, 2000);
      expect(fidelity).toBe(1.0);
    });

    it('fidelity is 1.0 when eviction relevance was 0', () => {
      ct.recordEviction('s1', 100, 0.8, 0.0, 1000, 1000);
      const fidelity = ct.recordRestoration('s1', 100, 0.5, 2000);
      expect(fidelity).toBe(1.0);
    });

    it('recovery amount = evictionCost * fidelity', () => {
      const evictionCost = ct.recordEviction('s1', 100, 0.8, 0.6, 1000, 1000);
      ct.recordRestoration('s1', 100, 0.3, 2000);

      // fidelity = 0.5, recovered = evictionCost * 0.5
      const s = ct.getSummary();
      // netLoss = evictionCost - recovered
      const expectedRecovery = evictionCost * 0.5;
      expect(s.netLoss).toBeCloseTo(evictionCost - expectedRecovery, 10);
    });

    it('ledger entry appears in summary', () => {
      ct.recordEviction('s1', 100, 0.8, 0.6, 1000, 1000);
      ct.recordRestoration('s1', 100, 0.3, 2000);
      const s = ct.getSummary();
      expect(s.totalRestorations).toBe(1);
    });
  });

  // ── Net loss ───────────────────────────────────────────────────

  describe('net loss', () => {
    it('netLoss = eviction + compaction - recovery, clamped >= 0', () => {
      const evCost = ct.recordEviction('s1', 100, 0.8, 0.6, 1000, 1000);
      const compCost = ct.recordCompaction('s2', 200, 100, 0.5, 0.2, 1500);
      // Restore s1 with full fidelity
      ct.recordRestoration('s1', 100, 0.6, 2000);

      const s = ct.getSummary();
      // Recovery = evCost * 1.0 (fidelity = min(1, 0.6/0.6) = 1.0)
      const expected = Math.max(0, evCost + compCost - evCost);
      expect(s.netLoss).toBeCloseTo(expected, 10);
    });

    it('netLoss is clamped to 0 when recovery exceeds losses', () => {
      // Small eviction, large restoration relevance
      ct.recordEviction('s1', 10, 0.1, 0.1, 1000, 1000);
      ct.recordRestoration('s1', 10, 1.0, 2000);

      const s = ct.getSummary();
      expect(s.netLoss).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Summary ────────────────────────────────────────────────────

  describe('summary', () => {
    it('reports correct counts and totals after mixed events', () => {
      ct.recordEviction('s1', 100, 0.8, 0.6, 1000, 1000);
      ct.recordEviction('s2', 200, 0.5, 0.4, 1000, 1100);
      ct.recordCompaction('s3', 300, 150, 0.6, 0.1, 1200);
      ct.recordRestoration('s1', 100, 0.5, 1300);

      const s = ct.getSummary();
      expect(s.totalEvictions).toBe(2);
      expect(s.totalCompactions).toBe(1);
      expect(s.totalRestorations).toBe(1);
      expect(s.tokensEvicted).toBe(300); // 100 + 200
      expect(s.tokensCompacted).toBe(150); // 300 - 150
      expect(s.recentEvents).toHaveLength(4);
    });
  });

  // ── Window continuity ──────────────────────────────────────────

  describe('window continuity', () => {
    it('decreases after eviction when information is tracked', () => {
      ct.trackSegmentInfo(0.8, 100);
      ct.trackSegmentInfo(0.5, 200);

      const before = ct.getWindowContinuity();
      expect(before).toBe(1.0);

      ct.recordEviction('s1', 100, 0.8, 0.6, 300, 1000);

      const after = ct.getWindowContinuity();
      expect(after).toBeLessThan(1.0);
    });

    it('partially recovers after restoration', () => {
      ct.trackSegmentInfo(0.8, 100);
      ct.trackSegmentInfo(0.5, 200);

      ct.recordEviction('s1', 100, 0.8, 0.6, 300, 1000);
      const afterEvict = ct.getWindowContinuity();

      ct.recordRestoration('s1', 100, 0.3, 2000);
      const afterRestore = ct.getWindowContinuity();

      // Should recover partially (fidelity = 0.3/0.6 = 0.5)
      expect(afterRestore).toBeGreaterThan(afterEvict);
    });

    it('stays in [0, 1] range', () => {
      ct.trackSegmentInfo(0.8, 100);
      ct.recordEviction('s1', 100, 0.8, 1.0, 100, 1000);
      ct.recordEviction('s2', 100, 0.8, 1.0, 100, 1100);

      const wc = ct.getWindowContinuity();
      expect(wc).toBeGreaterThanOrEqual(0);
      expect(wc).toBeLessThanOrEqual(1);
    });
  });

  describe('clear (cl-spec-015 §4.1)', () => {
    it('resets ledger, recent events, per-segment continuity, and cumulative totals', () => {
      ct.trackSegmentInfo(0.8, 100);
      ct.recordEviction('s1', 100, 0.8, 1.0, 100, 1000);
      ct.recordCompaction('s2', 200, 100, 0.5, 0.2, 1100);

      expect(ct.getSummary().totalEvictions).toBe(1);
      expect(ct.getSummary().totalCompactions).toBe(1);

      ct.clear();

      const after = ct.getSummary();
      expect(after.totalEvictions).toBe(0);
      expect(after.totalCompactions).toBe(0);
      expect(after.totalRestorations).toBe(0);
      expect(after.netLoss).toBe(0);
      expect(after.recentEvents).toEqual([]);
      expect(after.tokensEvicted).toBe(0);
      expect(after.tokensCompacted).toBe(0);
    });

    it('windowContinuity returns to 1.0 (default) after clear', () => {
      ct.trackSegmentInfo(0.8, 100);
      ct.recordEviction('s1', 100, 0.8, 1.0, 100, 1000);
      expect(ct.getWindowContinuity()).toBeLessThan(1.0);

      ct.clear();
      expect(ct.getWindowContinuity()).toBe(1.0);
    });

    it('per-segment continuity resets — previously-compacted segments score 1.0 again', () => {
      ct.recordCompaction('s2', 200, 100, 0.5, 0.2, 1100);
      expect(ct.getSegmentContinuity('s2')).toBeLessThan(1.0);

      ct.clear();
      expect(ct.getSegmentContinuity('s2')).toBe(1.0);
    });

    it('tracker remains functional after clear', () => {
      ct.recordEviction('s1', 100, 0.8, 1.0, 100, 1000);
      ct.clear();

      ct.recordEviction('s2', 50, 0.5, 0.5, 50, 2000);
      expect(ct.getSummary().totalEvictions).toBe(1);
    });
  });
});
