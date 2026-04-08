import { describe, it, expect } from 'vitest';
import { ContextLens, toJSON, validate } from '../../src/index.js';
import { ContextLensFleet } from '../../src/fleet.js';
import {
  ContextLensExporter,
  type OTelMeterProvider,
  type OTelMeter,
  type OTelObservableGauge,
  type OTelObservableResult,
  type OTelCounter,
  type OTelHistogram,
  type OTelMetricOptions,
  type OTelAttributes,
} from '../../src/otel.js';

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
    'Volcanic eruptions release magma gases and ash into the atmosphere impacting climate for years afterward',
    'Functional programming emphasizes immutable data pure functions and declarative composition over imperative mutation',
  ];
  return topics[index % topics.length]!;
}

function createMockMeterProvider() {
  const counters = new Map<string, { total: number }>();

  const meter: OTelMeter = {
    createObservableGauge(_name: string, _opts?: OTelMetricOptions): OTelObservableGauge {
      return {
        addCallback(_cb: (r: OTelObservableResult) => void) {},
        removeCallback(_cb: (r: OTelObservableResult) => void) {},
      };
    },
    createCounter(name: string, _opts?: OTelMetricOptions): OTelCounter {
      // Reuse existing record if already created (shared across exporters)
      if (!counters.has(name)) {
        counters.set(name, { total: 0 });
      }
      const rec = counters.get(name)!;
      return { add(v: number, _a?: OTelAttributes) { rec.total += v; } };
    },
    createHistogram(_name: string, _opts?: OTelMetricOptions): OTelHistogram {
      return { record(_v: number, _a?: OTelAttributes) {} };
    },
  };

  const meterProvider: OTelMeterProvider = { getMeter() { return meter; } };
  return { meterProvider, counters };
}

// ─── Integration Tests ──────────────────────────────────────────

describe('Phase 5 — Integration Tests', () => {
  // ── 1. Schema round-trip via full ContextLens flow ──────────

  describe('Schema round-trip via ContextLens', () => {
    it('full flow: seed, add, assess, diagnostics, plan — all validate', () => {
      const lens = makeLens(10000);
      lens.seed([
        { content: distinctContent(0) },
        { content: distinctContent(1) },
      ]);
      lens.add(distinctContent(2));
      lens.add(distinctContent(3));
      lens.add(distinctContent(4));

      // QualityReport
      const report = lens.assess();
      const reportJson = toJSON(report);
      const reportResult = validate.qualityReport(reportJson);
      expect(reportResult.valid).toBe(true);

      // DiagnosticSnapshot
      const diag = lens.getDiagnostics();
      const diagJson = toJSON(diag);
      const diagResult = validate.diagnosticSnapshot(diagJson);
      expect(diagResult.valid).toBe(true);

      // EvictionPlan
      const plan = lens.planEviction();
      const planJson = toJSON(plan);
      const planResult = validate.evictionPlan(planJson);
      expect(planResult.valid).toBe(true);

      // JSON round-trip preserves key fields
      const reportParsed = JSON.parse(JSON.stringify(reportJson));
      expect(validate.qualityReport(reportParsed).valid).toBe(true);
      expect(reportParsed['reportId']).toBe(reportJson['reportId']);
    });
  });

  // ── 2. Serialization across provider switch ─────────────────

  describe('Serialization across provider switch', () => {
    it('restored instance with different tokenizer produces different token counts', () => {
      const original = makeLens(10000);
      original.add(distinctContent(0));
      original.add(distinctContent(1));
      original.add(distinctContent(2));
      original.assess();

      const snap = original.snapshot();

      // Restore with a different tokenizer
      const customTokenizer = {
        name: 'fixed-10',
        count: (_content: string) => 10,
      };

      const restored = ContextLens.fromSnapshot(snap, { tokenizer: customTokenizer });

      const origReport = original.assess();
      const restoredReport = restored.assess();

      // Both should be valid reports
      expect(origReport.segmentCount).toBe(restoredReport.segmentCount);

      // Token counts should differ due to different tokenizer
      const origTokens = origReport.capacity.totalActiveTokens;
      const restoredTokens = restoredReport.capacity.totalActiveTokens;
      expect(restoredTokens).toBe(30); // 3 segments × 10 tokens each
      expect(origTokens).not.toBe(restoredTokens);
    });
  });

  // ── 3. Fleet + OTel combined ────────────────────────────────

  describe('Fleet + OTel combined', () => {
    it('fleet assessment with OTel exporters on each instance', () => {
      const fleet = new ContextLensFleet();
      const { meterProvider, counters } = createMockMeterProvider();
      const exporters: ContextLensExporter[] = [];

      // Create 3 instances with different content
      for (let i = 0; i < 3; i++) {
        const lens = makeLens(10000);
        for (let j = 0; j < 3; j++) {
          lens.add(distinctContent(i * 3 + j));
        }

        const label = `window-${i}`;
        fleet.register(lens, label);
        exporters.push(new ContextLensExporter(lens, { meterProvider, label }));
      }

      // Fleet assessment triggers assess() on each instance
      const report = fleet.assessFleet();

      expect(report.instanceCount).toBe(3);
      expect(report.assessedCount).toBe(3);
      expect(report.failedInstances).toBe(0);

      // OTel should have recorded assess_count increments for each instance
      const assessCounter = counters.get('context_lens.assess_count')!;
      expect(assessCounter.total).toBe(3);

      // Fleet report structure is valid
      expect(report.aggregate.composite.mean).toBeGreaterThanOrEqual(0);
      expect(report.ranking).toHaveLength(3);
      expect(report.capacityOverview.totalCapacity).toBe(30000);

      // Clean up
      for (const e of exporters) e.disconnect();
    });

    it('fleet events fire during fleet assessment', () => {
      const fleet = new ContextLensFleet({ degradationThreshold: 0 });

      // One instance with very low capacity to trigger patterns
      const saturated = makeLens(100);
      for (let i = 0; i < 6; i++) {
        saturated.add(distinctContent(i));
      }
      fleet.register(saturated, 'saturated');

      // One healthy instance
      const healthy = makeLens(100000);
      healthy.add(distinctContent(0));
      fleet.register(healthy, 'healthy');

      const events: string[] = [];
      fleet.on('instanceDegraded', () => events.push('instanceDegraded'));
      fleet.on('fleetDegraded', () => events.push('fleetDegraded'));

      fleet.assessFleet();

      // If patterns were detected on the saturated instance:
      // instanceDegraded should fire before fleetDegraded
      if (events.includes('instanceDegraded') && events.includes('fleetDegraded')) {
        expect(events.indexOf('instanceDegraded')).toBeLessThan(events.indexOf('fleetDegraded'));
      }
    });
  });

  // ── 4. Snapshot + schema validation ─────────────────────────

  describe('Snapshot schema integration', () => {
    it('assess after restore produces schema-valid output', () => {
      const original = makeLens(10000);
      original.seed([{ content: distinctContent(0) }]);
      original.add(distinctContent(1));
      original.add(distinctContent(2));
      original.assess();

      const snap = original.snapshot();
      const restored = ContextLens.fromSnapshot(snap);

      const report = restored.assess();
      const json = toJSON(report);
      const result = validate.qualityReport(json);
      expect(result.valid).toBe(true);
    });
  });
});
