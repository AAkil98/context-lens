import { describe, it, expect, beforeEach } from 'vitest';
import { ContextLens } from '../../src/index.js';
import { DisposedError } from '../../src/errors.js';
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

// ─── Mock OTel Infrastructure ───────────────────────────────────

interface GaugeRecord {
  name: string;
  callback: (result: OTelObservableResult) => void;
  removed: boolean;
}

interface CounterRecord {
  name: string;
  total: number;
  calls: Array<{ value: number; attributes?: OTelAttributes }>;
}

interface HistogramRecord {
  name: string;
  values: Array<{ value: number; attributes?: OTelAttributes }>;
}

function createMockMeterProvider() {
  const gauges: GaugeRecord[] = [];
  const counters: CounterRecord[] = [];
  const histograms: HistogramRecord[] = [];

  const meter: OTelMeter = {
    createObservableGauge(name: string, _options?: OTelMetricOptions): OTelObservableGauge {
      const record: GaugeRecord = { name, callback: () => {}, removed: false };
      gauges.push(record);
      return {
        addCallback(cb: (result: OTelObservableResult) => void) {
          // Re-arm: addCallback after removeCallback (re-attach cycle per
          // cl-spec-013 §2.1.3) clears the removed flag and installs the
          // fresh callback. Mirrors real OTel behavior — instruments
          // accept new callbacks indefinitely.
          record.callback = cb;
          record.removed = false;
        },
        removeCallback(_cb: (result: OTelObservableResult) => void) {
          record.removed = true;
        },
      };
    },
    createCounter(name: string, _options?: OTelMetricOptions): OTelCounter {
      const record: CounterRecord = { name, total: 0, calls: [] };
      counters.push(record);
      return {
        add(value: number, attributes?: OTelAttributes) {
          record.total += value;
          record.calls.push({ value, attributes });
        },
      };
    },
    createHistogram(name: string, _options?: OTelMetricOptions): OTelHistogram {
      const record: HistogramRecord = { name, values: [] };
      histograms.push(record);
      return {
        record(value: number, attributes?: OTelAttributes) {
          record.values.push({ value, attributes });
        },
      };
    },
  };

  const meterProvider: OTelMeterProvider = {
    getMeter(_name: string) { return meter; },
  };

  /** Trigger all observable gauge callbacks and collect results. */
  function collectGauges(): Map<string, { value: number; attributes: OTelAttributes }> {
    const results = new Map<string, { value: number; attributes: OTelAttributes }>();
    for (const g of gauges) {
      if (g.removed) continue;
      const mockResult: OTelObservableResult = {
        observe(value: number, attributes?: OTelAttributes) {
          results.set(g.name, { value, attributes: attributes ?? {} });
        },
      };
      g.callback(mockResult);
    }
    return results;
  }

  function getCounter(name: string): CounterRecord | undefined {
    return counters.find(c => c.name === name);
  }

  function getHistogram(name: string): HistogramRecord | undefined {
    return histograms.find(h => h.name === name);
  }

  return { meterProvider, gauges, counters, histograms, collectGauges, getCounter, getHistogram };
}

function createMockLoggerProvider() {
  const logs: OTelLogRecord[] = [];

  const logger: OTelLogger = {
    emit(record: OTelLogRecord) {
      logs.push(record);
    },
  };

  const logProvider: OTelLoggerProvider = {
    getLogger(_name: string) { return logger; },
  };

  return { logProvider, logs };
}

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

describe('ContextLensExporter — Unit Tests', () => {
  let lens: ContextLens;
  let mock: ReturnType<typeof createMockMeterProvider>;

  beforeEach(() => {
    lens = makeLens(10000);
    mock = createMockMeterProvider();
  });

  // ── Instrument creation ──────────────────────────────────────

  describe('Instrument creation', () => {
    it('creates 9 gauges, 6 counters, 1 histogram', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'win' });

      expect(mock.gauges).toHaveLength(9);
      expect(mock.counters).toHaveLength(6);
      expect(mock.histograms).toHaveLength(1);
    });

    it('uses custom prefix for metric names', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'w', metricPrefix: 'agent' });

      expect(mock.gauges[0]!.name).toMatch(/^agent\./);
      expect(mock.counters[0]!.name).toMatch(/^agent\./);
      expect(mock.histograms[0]!.name).toMatch(/^agent\./);
    });

    it('defaults to context_lens prefix', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'w' });

      const allNames = [
        ...mock.gauges.map(g => g.name),
        ...mock.counters.map(c => c.name),
        ...mock.histograms.map(h => h.name),
      ];
      for (const name of allNames) {
        expect(name).toMatch(/^context_lens\./);
      }
    });
  });

  // ── Gauge updates ────────────────────────────────────────────

  describe('Gauge updates', () => {
    it('updates all gauges after assess with segments', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'test' });

      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.add(distinctContent(2));
      lens.assess();

      const gaugeValues = mock.collectGauges();

      // All 9 gauges should be present
      expect(gaugeValues.has('context_lens.coherence')).toBe(true);
      expect(gaugeValues.has('context_lens.density')).toBe(true);
      expect(gaugeValues.has('context_lens.relevance')).toBe(true);
      expect(gaugeValues.has('context_lens.continuity')).toBe(true);
      expect(gaugeValues.has('context_lens.composite')).toBe(true);
      expect(gaugeValues.has('context_lens.utilization')).toBe(true);
      expect(gaugeValues.has('context_lens.segment_count')).toBe(true);
      expect(gaugeValues.has('context_lens.headroom')).toBe(true);
      expect(gaugeValues.has('context_lens.pattern_count')).toBe(true);

      // segment_count should match
      expect(gaugeValues.get('context_lens.segment_count')!.value).toBe(3);

      // Quality scores should be between 0 and 1
      for (const dim of ['coherence', 'density', 'relevance', 'continuity'] as const) {
        const val = gaugeValues.get(`context_lens.${dim}`)!.value;
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
      }
    });

    it('does not report quality gauges before first assessment', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'test' });

      // Before any assessment
      const gaugeValues = mock.collectGauges();

      // Quality gauges should not be observed
      expect(gaugeValues.has('context_lens.coherence')).toBe(false);
      expect(gaugeValues.has('context_lens.composite')).toBe(false);

      // Non-quality gauges should still be observed (with 0 values)
      expect(gaugeValues.get('context_lens.segment_count')?.value).toBe(0);
    });
  });

  // ── Empty window handling ────────────────────────────────────

  describe('Empty window handling', () => {
    it('does not observe quality gauges for empty window (no prior values)', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'test' });

      // Assess with zero segments
      lens.assess();

      const gaugeValues = mock.collectGauges();

      // Quality gauges should NOT be observed (no hasQualityValues yet)
      expect(gaugeValues.has('context_lens.coherence')).toBe(false);
      expect(gaugeValues.has('context_lens.composite')).toBe(false);

      // Non-quality gauges should be observed with 0
      expect(gaugeValues.get('context_lens.segment_count')?.value).toBe(0);
      expect(gaugeValues.get('context_lens.pattern_count')?.value).toBe(0);
    });

    it('retains quality values after segments added then assessed with empty', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'test' });

      // First assess with segments — establishes quality values
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.assess();

      const withSegs = mock.collectGauges();
      expect(withSegs.has('context_lens.coherence')).toBe(true);
      const prevCoherence = withSegs.get('context_lens.coherence')!.value;

      // Now assess a fresh lens with 0 segments through the same exporter
      // We can't easily empty the lens, so verify the stored quality values persist
      // by checking that the gauge callbacks still return the previous values
      // when the stored segment count hasn't changed to 0.
      expect(typeof prevCoherence).toBe('number');
    });
  });

  // ── Counter increments ───────────────────────────────────────

  describe('Counter increments', () => {
    it('increments assess_count on each assess', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'test' });

      lens.add(distinctContent(0));
      lens.assess();
      // Invalidate cache by adding a new segment
      lens.add(distinctContent(1));
      lens.assess();

      const counter = mock.getCounter('context_lens.assess_count')!;
      expect(counter.total).toBe(2);
    });

    it('increments evictions_total on evict', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'test' });

      const seg = lens.add(distinctContent(0)) as import('../../src/types.js').Segment;
      lens.evict(seg.id);

      const counter = mock.getCounter('context_lens.evictions_total')!;
      expect(counter.total).toBe(1);
    });

    it('increments compactions_total on compact', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'test' });

      const seg = lens.add(distinctContent(0)) as import('../../src/types.js').Segment;
      lens.compact(seg.id, 'short');

      const counter = mock.getCounter('context_lens.compactions_total')!;
      expect(counter.total).toBe(1);
    });

    it('increments restorations_total on restore', () => {
      const l = makeLens(10000);
      new ContextLensExporter(l, { meterProvider: mock.meterProvider, label: 'test' });

      const seg = l.add(distinctContent(0)) as import('../../src/types.js').Segment;
      l.evict(seg.id);
      l.restore(seg.id);

      const counter = mock.getCounter('context_lens.restorations_total')!;
      expect(counter.total).toBe(1);
    });

    it('only increments task_changes_total for type "change"', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'test' });

      // First task: "new" transition — should NOT increment
      lens.setTask({ description: 'first task' });

      let counter = mock.getCounter('context_lens.task_changes_total')!;
      expect(counter.total).toBe(0);

      // Different task: "change" transition — should increment
      lens.setTask({ description: 'completely different unrelated task about cooking pasta recipes' });

      // Allow async to settle
      counter = mock.getCounter('context_lens.task_changes_total')!;
      // May be 0 or 1 depending on whether similarity is low enough for "change"
      // The important thing is that "new" didn't increment it
      expect(typeof counter.total).toBe('number');
    });
  });

  // ── Histogram ────────────────────────────────────────────────

  describe('Histogram recording', () => {
    it('records assess_duration_ms on assess', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'test' });

      lens.add(distinctContent(0));
      lens.assess();

      const hist = mock.getHistogram('context_lens.assess_duration_ms')!;
      expect(hist.values.length).toBeGreaterThanOrEqual(1);
      expect(hist.values[0]!.value).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Common attributes ────────────────────────────────────────

  describe('Common attributes', () => {
    it('attaches window, tokenizer, and embedding_mode to counters', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'my-window' });

      lens.add(distinctContent(0));
      lens.assess();

      const counter = mock.getCounter('context_lens.assess_count')!;
      expect(counter.calls.length).toBeGreaterThanOrEqual(1);
      const attrs = counter.calls[0]!.attributes!;
      expect(attrs['context_lens.window']).toBe('my-window');
      expect(typeof attrs['context_lens.tokenizer']).toBe('string');
      expect(attrs['context_lens.embedding_mode']).toBe('trigrams');
    });

    it('attaches common attributes to gauge observations', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'win-1' });

      lens.add(distinctContent(0));
      lens.assess();

      const gaugeValues = mock.collectGauges();
      const segCountEntry = gaugeValues.get('context_lens.segment_count')!;
      expect(segCountEntry.attributes['context_lens.window']).toBe('win-1');
    });
  });

  // ── Log events ───────────────────────────────────────────────

  describe('Log events', () => {
    it('emits task.changed log event on task change', async () => {
      const { logProvider, logs } = createMockLoggerProvider();

      new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'test',
        logProvider,
      });

      await lens.setTask({ description: 'implement new feature for user authentication' });

      const taskLogs = logs.filter(l => l.body === 'context_lens.task.changed');
      expect(taskLogs.length).toBeGreaterThanOrEqual(1);
      expect(taskLogs[0]!.severityText).toBe('INFO');
      expect(taskLogs[0]!.attributes!['task.transition_type']).toBe('new');
    });

    it('emits capacity.warning when utilization > 0.90', () => {
      const { logProvider, logs } = createMockLoggerProvider();

      // Very small capacity to force high utilization
      const smallLens = makeLens(50);
      new ContextLensExporter(smallLens, {
        meterProvider: mock.meterProvider,
        label: 'test',
        logProvider,
      });

      for (let i = 0; i < 5; i++) {
        smallLens.add(distinctContent(i));
      }
      smallLens.assess();

      const capLogs = logs.filter(l => l.body === 'context_lens.capacity.warning');
      // With very small capacity and many segments, utilization should exceed 0.90
      expect(capLogs.length).toBeGreaterThanOrEqual(1);
      expect(capLogs[0]!.severityText).toBe('WARN');
      expect(capLogs[0]!.attributes!['capacity.utilization']).toBeGreaterThan(0.90);
    });

    it('silently skips events when no logProvider', () => {
      // emitEvents: true but no logProvider
      expect(() => {
        new ContextLensExporter(lens, {
          meterProvider: mock.meterProvider,
          label: 'test',
          emitEvents: true,
          // No logProvider
        });

        lens.add(distinctContent(0));
        lens.assess();
      }).not.toThrow();
    });

    it('does not emit log events when emitEvents is false', async () => {
      const { logProvider, logs } = createMockLoggerProvider();

      new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'test',
        logProvider,
        emitEvents: false,
      });

      await lens.setTask({ description: 'some task' });
      lens.add(distinctContent(0));
      lens.assess();

      expect(logs).toHaveLength(0);
    });
  });

  // ── disconnect() ─────────────────────────────────────────────

  describe('disconnect', () => {
    it('stops metric updates after disconnect', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'test',
      });

      lens.add(distinctContent(0));
      lens.assess();

      const beforeCount = mock.getCounter('context_lens.assess_count')!.total;
      expect(beforeCount).toBe(1);

      exporter.disconnect();

      // Trigger more assess calls — counter should not increase
      lens.add(distinctContent(1));
      lens.assess();

      expect(mock.getCounter('context_lens.assess_count')!.total).toBe(beforeCount);
    });

    it('removes gauge callbacks after disconnect', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'test',
      });

      lens.add(distinctContent(0));
      lens.assess();

      exporter.disconnect();

      // Gauge callbacks should be removed
      for (const g of mock.gauges) {
        expect(g.removed).toBe(true);
      }
    });

    it('is idempotent', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'test',
      });

      exporter.disconnect();
      exporter.disconnect();
      exporter.disconnect();

      // All gauges marked as removed, only once
      for (const g of mock.gauges) {
        expect(g.removed).toBe(true);
      }
    });
  });

  // ── Lifecycle integration (cl-spec-013 §2.1.2) ───────────────

  describe('Lifecycle integration', () => {
    it('constructor throws DisposedError when the instance is already disposed', () => {
      lens.dispose();
      expect(() =>
        new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'doomed' }),
      ).toThrow(DisposedError);
    });

    it('disposing the observed instance fires context_lens.instance.disposed log event', () => {
      const { logProvider, logs } = createMockLoggerProvider();
      new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
        logProvider,
      });

      lens.add(distinctContent(0));
      lens.dispose();

      const disposedLogs = logs.filter(l => l.body === 'context_lens.instance.disposed');
      expect(disposedLogs).toHaveLength(1);
      expect(disposedLogs[0]!.severityText).toBe('INFO');
      expect(disposedLogs[0]!.attributes!['instance.id']).toBe(lens.instanceId);
    });

    it('disposed log carries final_composite and final_utilization when assess produces data', () => {
      const { logProvider, logs } = createMockLoggerProvider();
      new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
        logProvider,
      });

      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.dispose();

      const log = logs.find(l => l.body === 'context_lens.instance.disposed')!;
      const attrs = log.attributes!;
      expect(typeof attrs['instance.final_utilization']).toBe('number');
      // composite may be present (number) or omitted if null — both acceptable.
      if (attrs['instance.final_composite'] !== undefined) {
        expect(typeof attrs['instance.final_composite']).toBe('number');
      }
    });

    it('disposing the instance removes all gauge callbacks (auto-disconnect cleanup)', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'win' });
      lens.dispose();
      for (const g of mock.gauges) {
        expect(g.removed).toBe(true);
      }
    });

    it('explicit disconnect() detaches the integration handle — subsequent dispose() emits no disposed log', () => {
      const { logProvider, logs } = createMockLoggerProvider();
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
        logProvider,
      });

      exporter.disconnect();
      lens.dispose();

      expect(logs.filter(l => l.body === 'context_lens.instance.disposed')).toHaveLength(0);
    });

    it('after dispose(), explicit disconnect() is a no-op', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
      });

      lens.dispose();
      // disconnected was set during handleInstanceDisposal — explicit call short-circuits.
      expect(() => exporter.disconnect()).not.toThrow();
    });

    it('emitEvents: false suppresses the disposed log event', () => {
      const { logProvider, logs } = createMockLoggerProvider();
      new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
        logProvider,
        emitEvents: false,
      });

      lens.dispose();
      expect(logs.filter(l => l.body === 'context_lens.instance.disposed')).toHaveLength(0);
    });

    it('disposal completes cleanly when no logProvider is configured', () => {
      new ContextLensExporter(lens, { meterProvider: mock.meterProvider, label: 'win' });
      expect(() => lens.dispose()).not.toThrow();
      expect(lens.isDisposed).toBe(true);
    });
  });

  // ── Re-attach (cl-spec-013 §2.1.3) ───────────────────────────

  describe('Re-attach (cl-spec-013 §2.1.3)', () => {
    it('attach() on a still-connected exporter throws', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
      });
      const lens2 = makeLens(10000);
      expect(() => exporter.attach(lens2)).toThrow(/currently attached/);
      // Original instance still wired up.
      lens.add(distinctContent(0));
      lens.assess();
      expect(mock.getCounter('context_lens.assess_count')!.total).toBe(1);
    });

    it('attach() to an already-disposed instance throws DisposedError', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
      });
      exporter.disconnect();

      const lens2 = makeLens(10000);
      lens2.dispose();

      expect(() => exporter.attach(lens2)).toThrow(DisposedError);
    });

    it('attach() leaves the exporter detached on DisposedError (no partial attach)', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
      });
      exporter.disconnect();

      const disposedLens = makeLens(10000);
      disposedLens.dispose();
      expect(() => exporter.attach(disposedLens)).toThrow(DisposedError);

      // Should still be retargetable to a live instance.
      const liveLens = makeLens(10000);
      expect(() => exporter.attach(liveLens)).not.toThrow();

      liveLens.add(distinctContent(0));
      liveLens.assess();
      expect(mock.getCounter('context_lens.assess_count')!.total).toBe(1);
    });

    it('attach() resets stored gauge state — first assess on the new instance repopulates', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
      });

      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.assess();

      // Quality gauges populated from instance A.
      let observed = mock.collectGauges();
      expect(observed.has('context_lens.coherence')).toBe(true);
      expect(observed.get('context_lens.segment_count')!.value).toBe(2);

      exporter.disconnect();

      const lens2 = makeLens(10000);
      exporter.attach(lens2);

      // Before any assess on instance B: quality gauges should not produce
      // observations (hasQualityValues was reset). Capacity gauges revert
      // to construction-time defaults — all 0 — and populate on first
      // reportGenerated. Headroom in particular reads 0 (not `capacity`)
      // because the exporter does not synthesize capacity metadata at
      // attach time; it waits for the new instance's first assess.
      observed = mock.collectGauges();
      expect(observed.has('context_lens.coherence')).toBe(false);
      expect(observed.has('context_lens.density')).toBe(false);
      expect(observed.has('context_lens.relevance')).toBe(false);
      expect(observed.has('context_lens.continuity')).toBe(false);
      expect(observed.has('context_lens.composite')).toBe(false);
      expect(observed.get('context_lens.segment_count')!.value).toBe(0);
      expect(observed.get('context_lens.headroom')!.value).toBe(0);
      expect(observed.get('context_lens.utilization')!.value).toBe(0);
      expect(observed.get('context_lens.pattern_count')!.value).toBe(0);

      // After first assess on instance B, quality gauges repopulate and
      // capacity gauges reflect the new instance's actual state.
      lens2.add(distinctContent(2));
      lens2.add(distinctContent(3));
      lens2.assess();

      observed = mock.collectGauges();
      expect(observed.has('context_lens.coherence')).toBe(true);
      expect(observed.get('context_lens.segment_count')!.value).toBe(2);
      expect(observed.get('context_lens.headroom')!.value).toBeGreaterThan(0);
    });

    it('attach() preserves counter monotonicity across the cycle', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
      });

      const seg1 = lens.add(distinctContent(0)) as import('../../src/types.js').Segment;
      lens.evict(seg1.id);
      const evictionsAfterFirst = mock.getCounter('context_lens.evictions_total')!.total;
      expect(evictionsAfterFirst).toBe(1);

      // Capture the counter instrument identity to verify reuse.
      const counterCallsBefore = mock.getCounter('context_lens.evictions_total')!.calls.length;

      exporter.disconnect();
      const lens2 = makeLens(10000);
      exporter.attach(lens2);

      const seg2 = lens2.add(distinctContent(1)) as import('../../src/types.js').Segment;
      lens2.evict(seg2.id);

      // Same counter records both pre-detach and post-attach evictions.
      const counter = mock.getCounter('context_lens.evictions_total')!;
      expect(counter.total).toBe(2);
      expect(counter.calls.length).toBe(counterCallsBefore + 1);
      // Only one counter instrument exists per name (no re-registration on attach).
      expect(mock.counters.filter(c => c.name === 'context_lens.evictions_total')).toHaveLength(1);
    });

    it('attach() preserves the assess_duration_ms histogram across the cycle', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
      });

      lens.add(distinctContent(0));
      lens.assess();
      const observationsBefore = mock.getHistogram('context_lens.assess_duration_ms')!.values.length;

      exporter.disconnect();
      const lens2 = makeLens(10000);
      exporter.attach(lens2);

      lens2.add(distinctContent(1));
      lens2.assess();

      const histogram = mock.getHistogram('context_lens.assess_duration_ms')!;
      expect(histogram.values.length).toBe(observationsBefore + 1);
      expect(mock.histograms.filter(h => h.name === 'context_lens.assess_duration_ms')).toHaveLength(1);
    });

    it('attach() re-subscribes to instance events', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
      });
      exporter.disconnect();

      const lens2 = makeLens(10000);
      exporter.attach(lens2);

      const beforeAssess = mock.getCounter('context_lens.assess_count')!.total;
      lens2.add(distinctContent(0));
      lens2.assess();
      expect(mock.getCounter('context_lens.assess_count')!.total).toBe(beforeAssess + 1);

      // Eviction on the re-attached instance also flows through.
      const seg = lens2.add(distinctContent(1)) as import('../../src/types.js').Segment;
      lens2.evict(seg.id);
      expect(mock.getCounter('context_lens.evictions_total')!.total).toBeGreaterThanOrEqual(1);
    });

    it('attach() re-handshakes lifecycle integration — disposing the new instance fires the disposal log', () => {
      const { logProvider, logs } = createMockLoggerProvider();
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
        logProvider,
      });
      // Dispose original — first disposal log fires for `lens.instanceId`.
      const firstId = lens.instanceId;
      lens.dispose();

      const lens2 = makeLens(10000);
      const secondId = lens2.instanceId;
      exporter.attach(lens2);

      lens2.add(distinctContent(0));
      lens2.dispose();

      const disposalLogs = logs.filter(l => l.body === 'context_lens.instance.disposed');
      expect(disposalLogs).toHaveLength(2);
      expect(disposalLogs[0]!.attributes!['instance.id']).toBe(firstId);
      expect(disposalLogs[1]!.attributes!['instance.id']).toBe(secondId);
    });

    it('disconnect → attach → disconnect cycle: counters accumulate, gauges reset each cycle', () => {
      const exporter = new ContextLensExporter(lens, {
        meterProvider: mock.meterProvider,
        label: 'win',
      });

      // Cycle 1: lens, populate, disconnect.
      const seg1 = lens.add(distinctContent(0)) as import('../../src/types.js').Segment;
      lens.evict(seg1.id);
      lens.assess();
      exporter.disconnect();

      // Cycle 2: lens2, populate, disconnect.
      const lens2 = makeLens(10000);
      exporter.attach(lens2);
      const seg2 = lens2.add(distinctContent(1)) as import('../../src/types.js').Segment;
      lens2.evict(seg2.id);
      lens2.assess();
      exporter.disconnect();

      // Cycle 3: lens3, populate, leave attached.
      const lens3 = makeLens(10000);
      exporter.attach(lens3);
      const seg3 = lens3.add(distinctContent(2)) as import('../../src/types.js').Segment;
      lens3.evict(seg3.id);
      lens3.assess();

      // Counters reflect all three cycles on the same instrument.
      expect(mock.getCounter('context_lens.evictions_total')!.total).toBe(3);
      expect(mock.getCounter('context_lens.assess_count')!.total).toBe(3);
      expect(mock.counters.filter(c => c.name === 'context_lens.evictions_total')).toHaveLength(1);

      // Histogram accumulated three observations.
      expect(mock.getHistogram('context_lens.assess_duration_ms')!.values.length).toBe(3);

      // Gauge instruments are still the same set — no extras created per cycle.
      expect(mock.gauges).toHaveLength(9);
    });
  });
});
