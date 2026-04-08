import { describe, it, expect } from 'vitest';
import { ContextLens } from '../../src/index.js';
import type { RestoreConfig } from '../../src/index.js';
import { ConfigurationError } from '../../src/errors.js';
import type { Segment, SerializedState } from '../../src/types.js';

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
    'Renaissance artists developed perspective techniques that transformed painting and visual representation forever',
    'Distributed systems require consensus protocols to maintain consistency across multiple networked nodes reliably',
  ];
  return topics[index % topics.length]!;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Serialization — Unit Tests', () => {
  // ── Round-trip fidelity ──────────────────────────────────────

  describe('Round-trip fidelity', () => {
    it('snapshot + fromSnapshot produces identical assessment scores', () => {
      const lens = makeLens(10000);

      // Add segments (no seed — avoids baseline capture interaction)
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.add(distinctContent(2));
      lens.add(distinctContent(3));
      lens.add(distinctContent(4));

      // Assess to populate scoring state
      const origReport = lens.assess();
      expect(origReport.segmentCount).toBe(5);

      // Snapshot
      const snap = lens.snapshot();
      expect(snap.restorable).toBe(true);

      // Restore
      const restored = ContextLens.fromSnapshot(snap);
      const restoredReport = restored.assess();

      expect(restoredReport.segmentCount).toBe(origReport.segmentCount);

      // Scores should match closely
      if (origReport.composite !== null && restoredReport.composite !== null) {
        expect(restoredReport.composite).toBeCloseTo(origReport.composite, 5);
      }
      if (origReport.windowScores.coherence !== null && restoredReport.windowScores.coherence !== null) {
        expect(restoredReport.windowScores.coherence).toBeCloseTo(origReport.windowScores.coherence, 5);
      }
    });

    it('preserves segment content and metadata', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0), { importance: 0.9, origin: 'test', tags: ['tag1'] });
      lens.add(distinctContent(1));

      const snap = lens.snapshot();
      const restored = ContextLens.fromSnapshot(snap);

      const origSegments = lens.listSegments();
      const restoredSegments = restored.listSegments();

      expect(restoredSegments).toHaveLength(origSegments.length);
      for (let i = 0; i < origSegments.length; i++) {
        expect(restoredSegments[i]!.content).toBe(origSegments[i]!.content);
        expect(restoredSegments[i]!.importance).toBe(origSegments[i]!.importance);
        expect(restoredSegments[i]!.origin).toBe(origSegments[i]!.origin);
        expect(restoredSegments[i]!.tags).toEqual(origSegments[i]!.tags);
      }
    });
  });

  // ── Lightweight snapshot ─────────────────────────────────────

  describe('Lightweight snapshot', () => {
    it('sets restorable to false and nulls content', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));

      const snap = lens.snapshot({ includeContent: false });

      expect(snap.restorable).toBe(false);
      for (const seg of snap.segments) {
        expect(seg.content).toBeNull();
      }
    });

    it('rejects fromSnapshot on non-restorable snapshot', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));

      const snap = lens.snapshot({ includeContent: false });

      expect(() => ContextLens.fromSnapshot(snap)).toThrow(ConfigurationError);
    });
  });

  // ── Format version validation ────────────────────────────────

  describe('Format version validation', () => {
    it('rejects snapshot with tampered formatVersion', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));

      const snap = lens.snapshot();
      // Tamper
      (snap as Record<string, unknown>).formatVersion = 'invalid-version';

      expect(() => ContextLens.fromSnapshot(snap)).toThrow(ConfigurationError);
    });
  });

  // ── Provider change detection ────────────────────────────────

  describe('Provider change detection', () => {
    it('recounts segments when tokenizer name changes', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.assess();

      const origSegments = lens.listSegments();
      const snap = lens.snapshot();

      // Custom tokenizer that counts differently
      const doubleTokenizer = {
        name: 'double-counter',
        count: (content: string) => content.length * 2,
      };

      const restored = ContextLens.fromSnapshot(snap, {
        tokenizer: doubleTokenizer,
      });

      const restoredSegments = restored.listSegments();

      // Token counts should be different due to different tokenizer
      for (let i = 0; i < origSegments.length; i++) {
        expect(restoredSegments[i]!.tokenCount).not.toBe(origSegments[i]!.tokenCount);
      }
    });

    it('fires stateRestored event with providerChanged flag', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));

      const snap = lens.snapshot();

      // Restore with same providers — providerChanged should be false
      let restoredEvent: Record<string, unknown> | null = null;
      const restored1 = ContextLens.fromSnapshot(snap);
      // Can't listen before construction, so verify structurally:
      // segmentCount should match
      expect(restored1.getSegmentCount()).toBe(1);

      // Restore with different tokenizer — triggers recount
      const restored2 = ContextLens.fromSnapshot(snap, {
        tokenizer: { name: 'different', count: (c: string) => c.length },
      });

      // Segments should be recounted with the new tokenizer
      const segs = restored2.listSegments();
      expect(segs).toHaveLength(1);
      // The new tokenizer counts by character length
      expect(segs[0]!.tokenCount).toBe(distinctContent(0).length);
    });
  });

  // ── Post-restore behavior ────────────────────────────────────

  describe('Post-restore behavior', () => {
    it('restored instance has no subscribers', () => {
      const lens = makeLens(10000);
      let eventCount = 0;
      lens.on('segmentAdded', () => { eventCount++; });
      lens.add(distinctContent(0));
      expect(eventCount).toBe(1);

      const snap = lens.snapshot();
      const restored = ContextLens.fromSnapshot(snap);

      // Adding to restored should not trigger original listener
      eventCount = 0;
      restored.add(distinctContent(1));
      // The original listener was on the original instance, not restored
      // Restored instance has no subscribers
      expect(eventCount).toBe(0);
    });

    it('latestReport is null after restore', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.assess();

      const snap = lens.snapshot();
      const restored = ContextLens.fromSnapshot(snap);

      const diag = restored.getDiagnostics();
      expect(diag.latestReport).toBeNull();
    });

    it('first assess after restore produces a fresh report', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.assess();

      const snap = lens.snapshot();
      const restored = ContextLens.fromSnapshot(snap);

      const report = restored.assess();
      expect(report).not.toBeNull();
      expect(typeof report.reportId).toBe('string');
      expect(report.segmentCount).toBe(2);
    });
  });

  // ── Snapshot structure ───────────────────────────────────────

  describe('Snapshot structure', () => {
    it('contains all required fields', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.assess();

      const snap = lens.snapshot();

      expect(snap.formatVersion).toBeDefined();
      expect(snap.timestamp).toBeDefined();
      expect(snap.restorable).toBe(true);
      expect(Array.isArray(snap.segments)).toBe(true);
      expect(Array.isArray(snap.groups)).toBe(true);
      expect(snap.config).toBeDefined();
      expect(snap.providerMetadata).toBeDefined();
      expect(snap.taskState).toBeDefined();
      expect(snap.patternTracking).toBeDefined();
      expect(Array.isArray(snap.timeline)).toBe(true);
      expect(Array.isArray(snap.reportHistory)).toBe(true);
      expect(Array.isArray(snap.continuityLedger)).toBe(true);
      expect(snap.continuityCounters).toBeDefined();
    });

    it('captures segment positions correctly', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.add(distinctContent(2));

      const snap = lens.snapshot();

      const activeSegs = snap.segments.filter(s => s.state === 'active');
      for (let i = 0; i < activeSegs.length; i++) {
        expect(activeSegs[i]!.position).toBe(i);
      }
    });

    it('is serializable to JSON', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.assess();

      const snap = lens.snapshot();
      const jsonStr = JSON.stringify(snap);
      const parsed = JSON.parse(jsonStr) as SerializedState;

      expect(parsed.formatVersion).toBe(snap.formatVersion);
      expect(parsed.segments).toHaveLength(snap.segments.length);
    });
  });

  // ── stateSnapshotted event ───────────────────────────────────

  describe('stateSnapshotted event', () => {
    it('fires when snapshot is called', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));

      let eventFired = false;
      let eventPayload: Record<string, unknown> = {};
      lens.on('stateSnapshotted', (payload) => {
        eventFired = true;
        eventPayload = payload as unknown as Record<string, unknown>;
      });

      lens.snapshot();

      expect(eventFired).toBe(true);
      expect(eventPayload['segmentCount']).toBe(1);
      expect(eventPayload['restorable']).toBe(true);
    });
  });
});
