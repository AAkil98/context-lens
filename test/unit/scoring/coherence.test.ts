import { describe, it, expect } from 'vitest';
import {
  computeCoherence,
  type CoherenceSegment,
} from '../../../src/scoring/coherence.js';
import { SimilarityEngine } from '../../../src/similarity.js';
import { fnv1a } from '../../../src/utils/hash.js';

function makeSeg(
  id: string,
  content: string,
  groupId: string | null = null,
): CoherenceSegment {
  return {
    id,
    content,
    contentHash: fnv1a(content),
    tokenCount: content.length,
    groupId,
  };
}

function makeSim(): SimilarityEngine {
  return new SimilarityEngine();
}

describe('computeCoherence', () => {
  // ── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty array returns windowCoherence null', () => {
      const result = computeCoherence([], new Map(), makeSim());
      expect(result.windowCoherence).toBeNull();
      expect(result.perSegment.size).toBe(0);
    });

    it('single segment returns all 1.0', () => {
      const seg = makeSeg('s1', 'the quick brown fox jumps over the lazy dog');
      const result = computeCoherence([seg], new Map(), makeSim());
      expect(result.windowCoherence).toBe(1.0);
      expect(result.adjacencyScores.get('s1')).toBe(1.0);
      expect(result.perSegment.get('s1')).toBe(1.0);
      expect(result.topicalConcentration).toBe(1.0);
    });
  });

  // ── Adjacency ──────────────────────────────────────────────────

  describe('adjacency', () => {
    it('two identical segments produce high adjacency', () => {
      const sim = makeSim();
      const content =
        'the quick brown fox jumps over the lazy dog near the river bank';
      const s1 = makeSeg('s1', content);
      const s2 = makeSeg('s2', content);
      const result = computeCoherence([s1, s2], new Map(), sim);

      // Identical content → adjacency = 1.0
      expect(result.adjacencyScores.get('s1')).toBe(1.0);
      expect(result.adjacencyScores.get('s2')).toBe(1.0);
    });

    it('two unrelated segments produce low adjacency', () => {
      const sim = makeSim();
      const s1 = makeSeg(
        's1',
        'the quick brown fox jumps over the lazy dog near the river bank',
      );
      const s2 = makeSeg(
        's2',
        'quantum mechanics explores subatomic particles and wave functions',
      );
      const result = computeCoherence([s1, s2], new Map(), sim);

      expect(result.adjacencyScores.get('s1')!).toBeLessThan(0.3);
      expect(result.adjacencyScores.get('s2')!).toBeLessThan(0.3);
    });
  });

  // ── Window-level weighting ────────────────────────────────────

  describe('window-level weighting', () => {
    it('windowCoherence is 0.6*adjacency + 0.4*concentration', () => {
      const sim = makeSim();
      const content =
        'the quick brown fox jumps over the lazy dog near the river bank';
      const s1 = makeSeg('s1', content);
      const s2 = makeSeg('s2', content);
      const result = computeCoherence([s1, s2], new Map(), sim);

      // For identical content: adjacency mean = 1.0, concentration = 1/1 = 1.0
      // windowCoherence = 0.6*1.0 + 0.4*1.0 = 1.0
      expect(result.windowCoherence).toBeCloseTo(1.0, 5);
    });
  });

  // ── Group integrity ───────────────────────────────────────────

  describe('group integrity', () => {
    it('single-member group has coherence 1.0', () => {
      const sim = makeSim();
      const s1 = makeSeg(
        's1',
        'the quick brown fox jumps over the lazy dog near the river bank',
        'g1',
      );
      const s2 = makeSeg(
        's2',
        'quantum mechanics explores subatomic particles and wave functions deeply',
      );
      const groups = new Map([['g1', ['s1']]]);
      // Need at least 2 segments so the code reaches the group integrity loop
      const result = computeCoherence([s1, s2], groups, sim);

      expect(result.groupScores.get('g1')!.coherence).toBe(1.0);
      expect(result.groupScores.get('g1')!.integrityWarning).toBe(false);
    });

    it('related group members produce high coherence', () => {
      const sim = makeSim();
      const s1 = makeSeg(
        's1',
        'user authentication login session management security',
        'g1',
      );
      const s2 = makeSeg(
        's2',
        'user authentication session token validation security',
        'g1',
      );
      const groups = new Map([['g1', ['s1', 's2']]]);
      const result = computeCoherence([s1, s2], groups, sim);

      expect(result.groupScores.get('g1')!.coherence).toBeGreaterThan(0.3);
      expect(result.groupScores.get('g1')!.integrityWarning).toBe(false);
    });

    it('unrelated group members produce low coherence + integrityWarning', () => {
      const sim = makeSim();
      const s1 = makeSeg(
        's1',
        'the quick brown fox jumps over the lazy dog near the river bank',
        'g1',
      );
      const s2 = makeSeg(
        's2',
        'quantum mechanics explores subatomic particles and wave functions',
        'g1',
      );
      const groups = new Map([['g1', ['s1', 's2']]]);
      const result = computeCoherence([s1, s2], groups, sim);

      expect(result.groupScores.get('g1')!.coherence).toBeLessThan(0.3);
      expect(result.groupScores.get('g1')!.integrityWarning).toBe(true);
    });
  });

  // ── Per-segment coherence ─────────────────────────────────────

  describe('per-segment coherence', () => {
    it('ungrouped segment coherence equals adjacency', () => {
      const sim = makeSim();
      const content =
        'the quick brown fox jumps over the lazy dog near the river bank';
      const s1 = makeSeg('s1', content);
      const s2 = makeSeg('s2', content);
      const result = computeCoherence([s1, s2], new Map(), sim);

      expect(result.perSegment.get('s1')).toBe(
        result.adjacencyScores.get('s1'),
      );
      expect(result.perSegment.get('s2')).toBe(
        result.adjacencyScores.get('s2'),
      );
    });

    it('grouped segment coherence is avg(adjacency, groupCoherence)', () => {
      const sim = makeSim();
      const s1 = makeSeg(
        's1',
        'user authentication login session management security controls',
        'g1',
      );
      const s2 = makeSeg(
        's2',
        'user authentication session token validation security checks',
        'g1',
      );
      const groups = new Map([['g1', ['s1', 's2']]]);
      const result = computeCoherence([s1, s2], groups, sim);

      const adj = result.adjacencyScores.get('s1')!;
      const groupCoh = result.groupScores.get('g1')!.coherence;
      const expected = (adj + groupCoh) / 2;
      expect(result.perSegment.get('s1')).toBeCloseTo(expected, 10);
    });
  });
});
