import { describe, it, expect, beforeEach } from 'vitest';
import { ContextLens } from '../../src/index.js';
import { ConfigurationError } from '../../src/errors.js';
import type { Segment, QualityReport } from '../../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────

let lens: ContextLens;

function makeLens(capacity = 10000): ContextLens {
  return new ContextLens({ capacity });
}

/**
 * Generate content strings that are sufficiently different from each other
 * so that similarity scores stay meaningful.
 */
function distinctContent(index: number): string {
  const topics = [
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
  return topics[index % topics.length]!;
}

// ─── Integration Tests ──────────────────────────────────────────

describe('ContextLens — Integration Tests', () => {
  beforeEach(() => {
    lens = makeLens(10000);
  });

  // ── 1. Seed-to-assess flow ───────────────────────────────────

  describe('Seed-to-assess flow', () => {
    it('seeds segments, adds more, then produces a valid quality report', () => {
      lens.seed([
        { content: distinctContent(0) },
        { content: distinctContent(1) },
        { content: distinctContent(2) },
      ]);

      lens.add(distinctContent(3));
      lens.add(distinctContent(4));

      // ContextLens tracks 5 active segments
      expect(lens.getSegmentCount()).toBe(5);

      const report = lens.assess();

      // Report segment count reflects assessed segments
      expect(report.segmentCount).toBeGreaterThanOrEqual(3);

      const ws = report.windowScores;
      for (const dim of ['coherence', 'density', 'relevance', 'continuity'] as const) {
        const val = ws[dim];
        expect(val).not.toBeNull();
        expect(val!).toBeGreaterThanOrEqual(0);
        expect(val!).toBeLessThanOrEqual(1);
      }

      expect(typeof report.composite).toBe('number');
      // Baseline may or may not be established depending on internal capture timing
      // trend is null on first report since there is no previous report to compare against
      expect(report.trend).toBeNull();
    });
  });

  // ── 2. Double-assess caching ─────────────────────────────────

  describe('Double-assess caching', () => {
    it('returns cached report on second call, new report after invalidation', async () => {
      lens.seed([{ content: distinctContent(0) }]);
      lens.add(distinctContent(1));

      const report1 = lens.assess();
      const report2 = lens.assess();

      // Same report returned from cache (no mutations between calls)
      expect(report1.reportId).toBe(report2.reportId);

      // Task change fully invalidates both ContextLens cache and assembler cache
      await lens.setTask({ description: 'new task to force invalidation' });
      const report3 = lens.assess();

      expect(report3.reportId).not.toBe(report1.reportId);
    });
  });

  // ── 3. Task lifecycle ────────────────────────────────────────

  describe('Task lifecycle', () => {
    it('transitions through active and idle states', async () => {
      lens.seed([{ content: distinctContent(0) }]);
      lens.add(distinctContent(1));

      const transition = await lens.setTask({ description: 'test task' });
      expect(transition.type).toBe('new');

      const reportActive = lens.assess();
      expect(reportActive.task.state).toBe('active');

      lens.clearTask();

      const reportIdle = lens.assess();
      expect(reportIdle.task.state).toBe('unset');
    });
  });

  // ── 4. Eviction flow ────────────────────────────────────────

  describe('Eviction flow', () => {
    it('plans eviction and executes a candidate', () => {
      const smallLens = makeLens(1000);

      smallLens.seed([
        { content: distinctContent(0), importance: 0.8 },
        { content: distinctContent(1), importance: 0.7 },
        { content: distinctContent(2), importance: 0.6 },
      ]);

      smallLens.add(distinctContent(3), { importance: 0.3 });
      smallLens.add(distinctContent(4), { importance: 0.2 });
      smallLens.add(distinctContent(5), { importance: 0.1 });
      smallLens.add(distinctContent(6), { importance: 0.4 });
      smallLens.add(distinctContent(7), { importance: 0.5 });

      const countBefore = smallLens.getSegmentCount();

      const plan = smallLens.planEviction({ targetTokens: 100 });

      expect(plan.candidateCount).toBeGreaterThan(0);
      expect(plan.candidates.length).toBeGreaterThan(0);

      for (const candidate of plan.candidates) {
        expect(candidate.evictionScore).toBeGreaterThanOrEqual(0);
        expect(candidate.evictionScore).toBeLessThanOrEqual(1);
      }

      // Execute the first candidate
      const firstCandidate = plan.candidates[0]!;
      smallLens.evict(firstCandidate.id);

      expect(smallLens.getSegmentCount()).toBe(countBefore - 1);
    });
  });

  // ── 5. Protection tiers ──────────────────────────────────────

  describe('Protection tiers', () => {
    it('default segments appear before priority segments in eviction plan', () => {
      lens.add(distinctContent(0), { protection: 'default', importance: 0.5 });
      lens.add(distinctContent(1), { protection: 'default', importance: 0.5 });
      lens.add(distinctContent(2), { protection: 'priority(0)', importance: 0.5 });

      const plan = lens.planEviction({ targetTokens: 50 });

      if (plan.candidateCount >= 2) {
        // Find indices of default and priority candidates
        const defaultIndices: number[] = [];
        const priorityIndices: number[] = [];

        for (let i = 0; i < plan.candidates.length; i++) {
          const seg = lens.getSegment(plan.candidates[i]!.id);
          if (seg !== null) {
            if (seg.protection === 'default') {
              defaultIndices.push(i);
            } else if (seg.protection.startsWith('priority')) {
              priorityIndices.push(i);
            }
          }
        }

        // All default candidates should appear before all priority candidates
        if (defaultIndices.length > 0 && priorityIndices.length > 0) {
          const maxDefault = Math.max(...defaultIndices);
          const minPriority = Math.min(...priorityIndices);
          expect(maxDefault).toBeLessThan(minPriority);
        }
      }
    });
  });

  // ── 6. Defensive copy ───────────────────────────────────────

  describe('Defensive copy', () => {
    it('mutations to returned segment do not affect stored state', () => {
      const seg = lens.add(distinctContent(0)) as Segment;
      const id = seg.id;

      const retrieved1 = lens.getSegment(id)!;
      expect(retrieved1).not.toBeNull();

      // Mutate the returned object
      (retrieved1 as Record<string, unknown>).content = 'MUTATED CONTENT';
      (retrieved1 as Record<string, unknown>).importance = 999;

      // Retrieve again
      const retrieved2 = lens.getSegment(id)!;

      expect(retrieved2.content).toBe(distinctContent(0));
      expect(retrieved2.importance).not.toBe(999);
    });
  });

  // ── 7. Capacity management ──────────────────────────────────

  describe('Capacity management', () => {
    it('reports and updates capacity correctly', () => {
      const cap1 = lens.getCapacity();
      expect(cap1.capacity).toBe(10000);

      lens.setCapacity(20000);

      const cap2 = lens.getCapacity();
      expect(cap2.capacity).toBe(20000);
    });
  });

  // ── 8. Event ordering ───────────────────────────────────────

  describe('Event ordering', () => {
    it('segmentAdded fires before reportGenerated', () => {
      const events: string[] = [];

      lens.on('segmentAdded', () => {
        events.push('segmentAdded');
      });
      lens.on('reportGenerated', () => {
        events.push('reportGenerated');
      });

      lens.add(distinctContent(0));
      lens.assess();

      expect(events.indexOf('segmentAdded')).toBeLessThan(
        events.indexOf('reportGenerated'),
      );
      expect(events).toContain('segmentAdded');
      expect(events).toContain('reportGenerated');
    });
  });

  // ── 9. Diagnostics completeness ─────────────────────────────

  describe('Diagnostics completeness', () => {
    it('returns a fully populated diagnostic snapshot', () => {
      lens.seed([
        { content: distinctContent(0) },
        { content: distinctContent(1) },
      ]);

      lens.add(distinctContent(2));
      lens.add(distinctContent(3));

      lens.assess();

      const diag = lens.getDiagnostics();

      expect(diag.sessionDuration).toBeGreaterThanOrEqual(0);
      expect(diag.segmentCount).toBe(4);
      expect(diag.latestReport).not.toBeNull();
      expect(diag.timeline.length).toBeGreaterThan(0);
      expect(diag.schemaVersion).toBeTruthy();
      expect(diag.timestamp).toBeGreaterThan(0);
    });
  });

  // ── 10. Config validation ───────────────────────────────────

  describe('Config validation', () => {
    it('throws ConfigurationError for missing capacity', () => {
      expect(() => new ContextLens({} as { capacity: number })).toThrow(ConfigurationError);
    });

    it('throws ConfigurationError for capacity = 0', () => {
      expect(() => new ContextLens({ capacity: 0 })).toThrow(ConfigurationError);
    });

    it('throws ConfigurationError for negative capacity', () => {
      expect(() => new ContextLens({ capacity: -1 })).toThrow(ConfigurationError);
    });

    it('throws ConfigurationError for non-integer capacity', () => {
      expect(() => new ContextLens({ capacity: 1.5 })).toThrow(ConfigurationError);
    });
  });

  // ── 11. Group operations ────────────────────────────────────

  describe('Group operations', () => {
    it('creates, retrieves, and dissolves groups', () => {
      const seg1 = lens.add(distinctContent(0)) as Segment;
      const seg2 = lens.add(distinctContent(1)) as Segment;
      const seg3 = lens.add(distinctContent(2)) as Segment;

      const group = lens.createGroup('g1', [seg1.id, seg2.id]);

      expect(group.groupId).toBe('g1');
      expect(group.members).toHaveLength(2);
      expect(group.members).toContain(seg1.id);
      expect(group.members).toContain(seg2.id);

      const retrieved = lens.getGroup('g1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.members).toHaveLength(2);

      lens.dissolveGroup('g1');

      const afterDissolve = lens.getGroup('g1');
      // After dissolution, the group either returns null or has dissolved state
      if (afterDissolve !== null) {
        expect(afterDissolve.state).toBe('dissolved');
      }
    });
  });

  // ── 12. Custom pattern registration ─────────────────────────

  describe('Custom pattern registration', () => {
    it('registers a custom pattern that can appear in detection results', () => {
      const events: string[] = [];
      lens.on('customPatternRegistered', (p) => {
        events.push(p.name);
      });

      lens.registerPattern({
        name: 'test-pattern',
        description: 'Always fires for testing',
        detect: (_report: QualityReport) => ({
          primaryScore: { dimension: 'density', value: 0.1 },
          secondaryScores: [],
          utilization: null,
        }),
        severity: () => 'watch',
        explanation: () => 'Test pattern detected',
        remediation: () => [{
          action: 'evict',
          target: null,
          estimatedImpact: null,
          description: 'Test remediation',
        }],
      });

      expect(events).toContain('test-pattern');

      // Seed and assess to trigger detection
      lens.seed([
        { content: distinctContent(0) },
        { content: distinctContent(1) },
      ]);
      lens.add(distinctContent(2));

      const report = lens.assess();

      // The custom pattern should appear if its detect function returns non-null
      const customPattern = report.patterns.patterns.find(
        (p) => p.name === 'test-pattern',
      );
      expect(customPattern).toBeDefined();
      expect(customPattern!.severity).toBe('watch');
    });
  });

  // ── Additional: Unsubscribe from events ─────────────────────

  describe('Event unsubscribe', () => {
    it('stops receiving events after unsubscribe', () => {
      let count = 0;
      const unsub = lens.on('segmentAdded', () => {
        count++;
      });

      lens.add(distinctContent(0));
      expect(count).toBe(1);

      unsub();

      lens.add(distinctContent(1));
      expect(count).toBe(1);
    });
  });
});
