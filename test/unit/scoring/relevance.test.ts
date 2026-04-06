import { describe, it, expect } from 'vitest';
import {
  computeRelevance,
  type RelevanceSegment,
} from '../../../src/scoring/relevance.js';
import { SimilarityEngine } from '../../../src/similarity.js';
import { fnv1a } from '../../../src/utils/hash.js';
import type { TaskDescriptor, ProtectionLevel } from '../../../src/types.js';

const NOW = 1_000_000;

function makeSeg(
  id: string,
  content: string,
  overrides: Partial<RelevanceSegment> = {},
): RelevanceSegment {
  return {
    id,
    content,
    contentHash: fnv1a(content),
    tokenCount: content.length,
    protection: 'default',
    importance: 0.5,
    origin: null,
    tags: [],
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...overrides,
  };
}

function makeSim(): SimilarityEngine {
  return new SimilarityEngine();
}

describe('computeRelevance', () => {
  // ── No task ────────────────────────────────────────────────────

  describe('no task', () => {
    it('empty array returns windowRelevance null', () => {
      const result = computeRelevance([], makeSim(), NOW, null, null);
      expect(result.windowRelevance).toBeNull();
      expect(result.perSegment.size).toBe(0);
    });

    it('all segments score 1.0 when task is null', () => {
      const sim = makeSim();
      const s1 = makeSeg('s1', 'some content about authentication');
      const s2 = makeSeg('s2', 'unrelated content about physics');
      const result = computeRelevance([s1, s2], sim, NOW, null, null);

      expect(result.perSegment.get('s1')).toBe(1.0);
      expect(result.perSegment.get('s2')).toBe(1.0);
      expect(result.windowRelevance).toBe(1.0);
    });
  });

  // ── With task ──────────────────────────────────────────────────

  describe('with task', () => {
    it('similar content scores higher than unrelated', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description:
          'implement user authentication with login and session management',
      };
      const taskHash = fnv1a(task.description);

      const s1 = makeSeg(
        's1',
        'user authentication login session token management and security',
      );
      const s2 = makeSeg(
        's2',
        'quantum physics wave function collapse during particle observation',
      );
      const result = computeRelevance([s1, s2], sim, NOW, task, taskHash);

      expect(result.perSegment.get('s1')!).toBeGreaterThan(
        result.perSegment.get('s2')!,
      );
    });
  });

  // ── Keyword boost ──────────────────────────────────────────────

  describe('keyword boost', () => {
    it('"auth" matches "auth" in content', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description: 'implement authentication',
        keywords: ['auth'],
      };
      const taskHash = fnv1a(task.description);

      const s1 = makeSeg(
        's1',
        'the auth module validates tokens and manages sessions',
      );
      const s2 = makeSeg(
        's2',
        'quantum physics explores wave function collapse phenomena',
      );
      const result = computeRelevance([s1, s2], sim, NOW, task, taskHash);

      // s1 has keyword match, s2 does not
      expect(result.perSegment.get('s1')!).toBeGreaterThan(
        result.perSegment.get('s2')!,
      );
    });

    it('"auth" does NOT match "author" (whole word boundary)', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description: 'implement authentication',
        keywords: ['auth'],
      };
      const taskHash = fnv1a(task.description);

      // "author" should not match "auth" due to word boundary
      const segWithAuthor = makeSeg(
        's1',
        'the author wrote a lengthy book about medieval history',
      );
      const segWithAuth = makeSeg(
        's2',
        'the auth system validates tokens and manages sessions',
      );
      const result = computeRelevance(
        [segWithAuthor, segWithAuth],
        sim,
        NOW,
        task,
        taskHash,
      );

      // s2 (has "auth" as a word) should score higher than s1 (only has "author")
      expect(result.perSegment.get('s2')!).toBeGreaterThan(
        result.perSegment.get('s1')!,
      );
    });
  });

  // ── Protection ─────────────────────────────────────────────────

  describe('protection', () => {
    it('pinned segments always score 1.0', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description: 'implement authentication',
      };
      const taskHash = fnv1a(task.description);

      const pinned = makeSeg(
        's1',
        'totally unrelated content about deep sea marine biology and coral reefs',
        { protection: 'pinned' as ProtectionLevel },
      );
      const result = computeRelevance([pinned], sim, NOW, task, taskHash);

      expect(result.perSegment.get('s1')).toBe(1.0);
    });

    it('seed segments have floor of 0.3', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description: 'implement authentication',
      };
      const taskHash = fnv1a(task.description);

      const seed = makeSeg(
        's1',
        'totally unrelated content about deep sea marine biology and coral reefs',
        { protection: 'seed' as ProtectionLevel, importance: 0.0 },
      );
      const result = computeRelevance([seed], sim, NOW, task, taskHash);

      expect(result.perSegment.get('s1')!).toBeGreaterThanOrEqual(0.3);
    });

    it('default protection does not apply floor', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description: 'implement authentication',
      };
      const taskHash = fnv1a(task.description);

      const seg = makeSeg(
        's1',
        'totally unrelated content about deep sea marine biology and coral reefs',
        { protection: 'default' as ProtectionLevel, importance: 0.0 },
      );
      const result = computeRelevance([seg], sim, NOW, task, taskHash);

      // No floor applied — could be below 0.3
      expect(result.perSegment.get('s1')!).toBeLessThan(0.3);
    });
  });

  // ── Recency ────────────────────────────────────────────────────

  describe('recency', () => {
    it('newest segment gets recency 1.0, oldest gets 0.0', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description: 'general topic about system configuration and setup',
      };
      const taskHash = fnv1a(task.description);

      // Use same content so only recency differs
      const content = 'system configuration setup and deployment management';
      const old = makeSeg('old', content, {
        createdAt: NOW - 10000,
        updatedAt: NOW - 10000,
      });
      const recent = makeSeg('recent', content, {
        createdAt: NOW,
        updatedAt: NOW,
      });
      const result = computeRelevance([old, recent], sim, NOW, task, taskHash);

      // The newer segment should score higher due to recency
      expect(result.perSegment.get('recent')!).toBeGreaterThan(
        result.perSegment.get('old')!,
      );
    });
  });

  // ── Missing metadata ──────────────────────────────────────────

  describe('missing metadata', () => {
    it('absent keywords contribute 0 to keyword component', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description: 'implement authentication login session management',
        // no keywords
      };
      const taskHash = fnv1a(task.description);

      const seg = makeSeg(
        's1',
        'user authentication login session token management and security',
      );
      const result = computeRelevance([seg], sim, NOW, task, taskHash);

      // Should still produce a score (from content similarity + recency + importance)
      expect(result.perSegment.get('s1')).toBeDefined();
      expect(result.perSegment.get('s1')!).toBeGreaterThan(0);
    });

    it('absent origins and tags contribute 0 to metadata signal', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description: 'implement authentication',
        relatedOrigins: ['src/auth.ts'],
        relatedTags: ['auth'],
      };
      const taskHash = fnv1a(task.description);

      // Segment has no origin and no tags
      const seg = makeSeg(
        's1',
        'user authentication session management and security controls',
      );
      const result = computeRelevance([seg], sim, NOW, task, taskHash);

      // Score still computable, just without metadata contribution
      expect(result.perSegment.get('s1')).toBeDefined();
    });
  });

  // ── Window relevance ──────────────────────────────────────────

  describe('window relevance', () => {
    it('is a token-weighted mean of per-segment scores', () => {
      const sim = makeSim();
      const task: TaskDescriptor = {
        description:
          'implement user authentication with login and session management',
      };
      const taskHash = fnv1a(task.description);

      const s1 = makeSeg(
        's1',
        'user authentication login session token management security access',
        { tokenCount: 50 },
      );
      const s2 = makeSeg(
        's2',
        'quantum physics wave function collapse observation deeply unusual',
        { tokenCount: 100 },
      );
      const result = computeRelevance([s1, s2], sim, NOW, task, taskHash);

      const r1 = result.perSegment.get('s1')!;
      const r2 = result.perSegment.get('s2')!;
      const expected = (r1 * 50 + r2 * 100) / 150;
      expect(result.windowRelevance).toBeCloseTo(expected, 10);
    });
  });
});
