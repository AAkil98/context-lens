/**
 * Integration tests for ContextLensExporter.attach() — the snapshot-then-
 * dispose-then-fromSnapshot-then-attach continuation pattern (cl-spec-013
 * §2.1.3, cl-spec-014 §3.4) and fleet-and-OTel cohabitation across re-attach.
 *
 * Unit-level coverage of attach() lives in test/unit/otel.test.ts under
 * "Re-attach (cl-spec-013 §2.1.3)". This file exercises the cross-subsystem
 * flow where snapshot, dispose, fromSnapshot, fleet, and OTel all compose.
 */

import { describe, it, expect } from 'vitest';
import { ContextLens } from '../../src/index.js';
import { ContextLensFleet } from '../../src/fleet.js';
import {
  ContextLensExporter,
  type OTelMeterProvider,
  type OTelMeter,
  type OTelObservableGauge,
  type OTelObservableResult,
  type OTelCounter,
  type OTelHistogram,
  type OTelLoggerProvider,
  type OTelLogger,
  type OTelLogRecord,
  type OTelAttributes,
  type OTelMetricOptions,
} from '../../src/otel.js';

// ─── Mock OTel infrastructure with counter/histogram totals ─────

interface CounterRecord {
  name: string;
  total: number;
}

interface HistogramRecord {
  name: string;
  values: number[];
}

interface GaugeRecord {
  name: string;
  callback: ((result: OTelObservableResult) => void) | null;
}

function createMockMeterProvider() {
  const gauges: GaugeRecord[] = [];
  const counters: CounterRecord[] = [];
  const histograms: HistogramRecord[] = [];

  const meter: OTelMeter = {
    createObservableGauge(name: string, _o?: OTelMetricOptions): OTelObservableGauge {
      const rec: GaugeRecord = { name, callback: null };
      gauges.push(rec);
      return {
        addCallback(cb: (r: OTelObservableResult) => void) {
          rec.callback = cb;
        },
        removeCallback(_cb: (r: OTelObservableResult) => void) {
          rec.callback = null;
        },
      };
    },
    createCounter(name: string, _o?: OTelMetricOptions): OTelCounter {
      const rec: CounterRecord = { name, total: 0 };
      counters.push(rec);
      return {
        add(value: number, _a?: OTelAttributes) {
          rec.total += value;
        },
      };
    },
    createHistogram(name: string, _o?: OTelMetricOptions): OTelHistogram {
      const rec: HistogramRecord = { name, values: [] };
      histograms.push(rec);
      return {
        record(value: number, _a?: OTelAttributes) {
          rec.values.push(value);
        },
      };
    },
  };

  const meterProvider: OTelMeterProvider = { getMeter(_n: string) { return meter; } };

  function getCounter(name: string): CounterRecord {
    const c = counters.find(c => c.name === name);
    if (!c) throw new Error(`counter not found: ${name}`);
    return c;
  }

  function getHistogram(name: string): HistogramRecord {
    const h = histograms.find(h => h.name === name);
    if (!h) throw new Error(`histogram not found: ${name}`);
    return h;
  }

  function gaugeNames(): string[] {
    return gauges.map(g => g.name);
  }

  return { meterProvider, gauges, counters, histograms, getCounter, getHistogram, gaugeNames };
}

function createCapturingLogger() {
  const logs: OTelLogRecord[] = [];
  const logger: OTelLogger = { emit(r: OTelLogRecord) { logs.push(r); } };
  const logProvider: OTelLoggerProvider = { getLogger(_n: string) { return logger; } };
  return { logProvider, logs };
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

// ─── Tests ──────────────────────────────────────────────────────

describe('OTel re-attach integration (cl-spec-013 §2.1.3)', () => {
  it('snapshot → dispose → fromSnapshot → attach: metric stream resumes on the restored instance', () => {
    const mock = createMockMeterProvider();
    const { logProvider, logs } = createCapturingLogger();

    const lensA = new ContextLens({ capacity: 10000 });
    const exporter = new ContextLensExporter(lensA, {
      meterProvider: mock.meterProvider,
      label: 'agent-1',
      logProvider,
    });

    // Pre-snapshot activity. Each assess() is preceded by a mutation so
    // the quality cache is invalidated and reportGenerated fires (the cache
    // suppresses the event on consecutive assess calls without intervening
    // mutation). 3 adds, 1 eviction, 2 reportGenerated cycles on lensA.
    const seg0 = lensA.add(distinctContent(0)) as import('../../src/types.js').Segment;
    lensA.add(distinctContent(1));
    lensA.assess();              // cycle 1
    lensA.add(distinctContent(2));
    lensA.evict(seg0.id);
    lensA.assess();              // cycle 2 (mutations invalidated cache)

    expect(mock.getCounter('context_lens.evictions_total').total).toBe(1);
    expect(mock.getCounter('context_lens.assess_count').total).toBe(2);
    expect(mock.getHistogram('context_lens.assess_duration_ms').values.length).toBe(2);

    // Snapshot then dispose lensA.
    const state = lensA.snapshot();
    const idA = lensA.instanceId;
    lensA.dispose();

    // Auto-disconnect log fired exactly once for lensA.
    const disposalLogsAfterA = logs.filter(l => l.body === 'context_lens.instance.disposed');
    expect(disposalLogsAfterA).toHaveLength(1);
    expect(disposalLogsAfterA[0]!.attributes!['instance.id']).toBe(idA);

    // Restore on a fresh instance and re-attach the exporter.
    const lensB = ContextLens.fromSnapshot(state, {});
    expect(lensB.isDisposed).toBe(false);
    expect(lensB.instanceId).not.toBe(idA);

    exporter.attach(lensB);

    // Post-attach activity on lensB. Same cache-invalidation pattern.
    const seg1 = lensB.add(distinctContent(3)) as import('../../src/types.js').Segment;
    lensB.assess();              // cycle 3
    lensB.add(distinctContent(4));
    lensB.assess();              // cycle 4
    lensB.evict(seg1.id);
    lensB.assess();              // cycle 5

    // Counter monotonicity preserved across detach/attach cycle.
    expect(mock.getCounter('context_lens.evictions_total').total).toBe(2); // 1 + 1
    expect(mock.getCounter('context_lens.assess_count').total).toBe(5);    // 2 + 3
    expect(mock.getHistogram('context_lens.assess_duration_ms').values.length).toBe(5); // 2 + 3

    // Same instrument identity (no re-registration on attach).
    expect(mock.counters.filter(c => c.name === 'context_lens.evictions_total')).toHaveLength(1);
    expect(mock.histograms.filter(h => h.name === 'context_lens.assess_duration_ms')).toHaveLength(1);
    // Same nine gauges total — no extras from the re-attach.
    expect(mock.gaugeNames().filter(n => n === 'context_lens.coherence')).toHaveLength(1);
    expect(mock.gauges).toHaveLength(9);

    // Disposing lensB now fires a second disposal log with lensB's id.
    const idB = lensB.instanceId;
    lensB.dispose();
    const allDisposalLogs = logs.filter(l => l.body === 'context_lens.instance.disposed');
    expect(allDisposalLogs).toHaveLength(2);
    expect(allDisposalLogs[1]!.attributes!['instance.id']).toBe(idB);
  });

  it('fleet + OTel cohabit across re-attach: both integrations follow the snapshot transition', () => {
    const mock = createMockMeterProvider();
    const { logProvider, logs } = createCapturingLogger();

    const fleet = new ContextLensFleet();
    const fleetEvents: { type: string; label: string }[] = [];
    fleet.on('instanceDisposed', (p) => {
      fleetEvents.push({ type: 'instanceDisposed', label: p.label });
    });

    const lensA = new ContextLens({ capacity: 10000 });
    fleet.register(lensA, 'agent-1');
    const exporter = new ContextLensExporter(lensA, {
      meterProvider: mock.meterProvider,
      label: 'agent-1',
      logProvider,
    });

    // Activity on lensA.
    lensA.add(distinctContent(0));
    lensA.add(distinctContent(1));
    lensA.assess();

    expect(mock.getCounter('context_lens.assess_count').total).toBe(1);
    expect(fleet.listInstances().map(i => i.label)).toEqual(['agent-1']);

    // Snapshot, dispose — fleet auto-unregisters AND exporter auto-disconnects.
    const state = lensA.snapshot();
    lensA.dispose();

    expect(fleetEvents.filter(e => e.type === 'instanceDisposed')).toHaveLength(1);
    expect(fleet.listInstances()).toHaveLength(0);
    expect(logs.filter(l => l.body === 'context_lens.instance.disposed')).toHaveLength(1);

    // Restore, re-register with fleet, re-attach exporter — both integrations
    // bind to the new instance independently. The same label is reused.
    const lensB = ContextLens.fromSnapshot(state, {});
    fleet.register(lensB, 'agent-1');
    exporter.attach(lensB);

    expect(fleet.listInstances().map(i => i.label)).toEqual(['agent-1']);

    // Activity on lensB flows to both fleet (via assessFleet) and OTel.
    lensB.add(distinctContent(2));
    lensB.assess();

    expect(mock.getCounter('context_lens.assess_count').total).toBe(2);

    const fleetReport = fleet.assessFleet();
    expect(fleetReport.instances.map(i => i.label)).toEqual(['agent-1']);

    // Final dispose on lensB: both integrations again fire their respective
    // teardown signals.
    lensB.dispose();
    expect(fleetEvents.filter(e => e.type === 'instanceDisposed')).toHaveLength(2);
    expect(logs.filter(l => l.body === 'context_lens.instance.disposed')).toHaveLength(2);
    expect(fleet.listInstances()).toHaveLength(0);
  });
});
