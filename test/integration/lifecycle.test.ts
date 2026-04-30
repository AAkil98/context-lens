/**
 * Instance lifecycle integration tests — cl-spec-015 / impl-spec I-06 §5.
 *
 * Exercises the 15 flows from the impl spec end-to-end across ContextLens,
 * ContextLensFleet, and ContextLensExporter. Unit-level coverage of the
 * mechanism lives in test/unit/{context-lens,fleet,otel}.test.ts; this file
 * is for cross-subsystem flows where the mechanisms compose.
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
import { DisposedError, DisposalError } from '../../src/errors.js';
import type { TokenizerProvider } from '../../src/types.js';

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

function createMinimalMeter() {
  const gauges: { name: string; removed: boolean }[] = [];
  const meter: OTelMeter = {
    createObservableGauge(name: string, _o?: OTelMetricOptions): OTelObservableGauge {
      const rec = { name, removed: false };
      gauges.push(rec);
      return {
        addCallback(_cb: (r: OTelObservableResult) => void) {},
        removeCallback(_cb: (r: OTelObservableResult) => void) { rec.removed = true; },
      };
    },
    createCounter(_name: string, _o?: OTelMetricOptions): OTelCounter {
      return { add(_v: number, _a?: OTelAttributes) {} };
    },
    createHistogram(_name: string, _o?: OTelMetricOptions): OTelHistogram {
      return { record(_v: number, _a?: OTelAttributes) {} };
    },
  };
  const meterProvider: OTelMeterProvider = { getMeter(_n: string) { return meter; } };
  return { meterProvider, gauges };
}

function createCapturingLogger() {
  const logs: OTelLogRecord[] = [];
  const logger: OTelLogger = { emit(r: OTelLogRecord) { logs.push(r); } };
  const logProvider: OTelLoggerProvider = { getLogger(_n: string) { return logger; } };
  return { logProvider, logs };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Instance lifecycle integration (cl-spec-015)', () => {

  describe('Single-instance flows', () => {

    // Flow 1
    it('dispose-on-empty-instance: stateDisposed fires once, post-disposal calls throw', () => {
      const lens = makeLens();
      let count = 0;
      lens.on('stateDisposed', () => { count++; });

      lens.dispose();

      expect(count).toBe(1);
      expect(lens.isDisposed).toBe(true);
      expect(lens.isDisposing).toBe(false);
      expect(() => lens.add('x')).toThrow(DisposedError);
      expect(() => lens.getCapacity()).toThrow(DisposedError);
    });

    // Flow 2
    it('dispose-with-state: caches cleared (getDiagnostics throws), instanceId retained', async () => {
      const lens = makeLens();
      const id = lens.instanceId;
      lens.seed([{ content: distinctContent(0) }, { content: distinctContent(1) }]);
      lens.add(distinctContent(2));
      await lens.setTask({ description: 'analyze the system architecture and identify bottlenecks' });
      lens.assess();

      lens.dispose();

      // Caches are cleared; next call to a read-only method throws because instance is disposed.
      expect(() => lens.getDiagnostics()).toThrow(DisposedError);
      expect(() => lens.assess()).toThrow(DisposedError);

      // instanceId is retained for error correlation.
      expect(lens.instanceId).toBe(id);
      try {
        lens.add('post-disposal');
      } catch (e) {
        expect((e as DisposedError).instanceId).toBe(id);
      }
    });

    // Flow 3
    it('idempotent-dispose: three calls fire stateDisposed exactly once', () => {
      const lens = makeLens();
      let count = 0;
      lens.on('stateDisposed', () => { count++; });

      expect(() => { lens.dispose(); lens.dispose(); lens.dispose(); }).not.toThrow();

      expect(count).toBe(1);
      expect(lens.isDisposed).toBe(true);
    });

    // Flow 4
    it('reentrant-dispose: handler that calls dispose() does not double-emit', () => {
      const lens = makeLens();
      let count = 0;
      lens.on('stateDisposed', () => {
        count++;
        lens.dispose();
      });

      expect(() => lens.dispose()).not.toThrow();

      expect(count).toBe(1);
      expect(lens.isDisposed).toBe(true);
    });

    // Flow 5
    it('read-during-disposal: handler calls to read-only methods return valid data', () => {
      const lens = makeLens();
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.assess();  // populate baseline + cache

      const captured: { capacity?: number; segCount?: number; assessed?: boolean; snapped?: boolean } = {};
      lens.on('stateDisposed', () => {
        captured.capacity = lens.getCapacity().capacity;
        captured.segCount = lens.getSegmentCount();
        captured.assessed = lens.assess().composite !== undefined;
        captured.snapped = lens.snapshot().formatVersion === 'context-lens-snapshot-v1';
      });

      expect(() => lens.dispose()).not.toThrow();

      expect(captured.capacity).toBe(10000);
      expect(captured.segCount).toBe(2);
      expect(captured.assessed).toBe(true);
      expect(captured.snapped).toBe(true);
    });

    // Flow 6
    it('mutate-during-disposal: handler calling add throws, error aggregated into DisposalError', () => {
      const lens = makeLens();
      lens.on('stateDisposed', () => { lens.add('x'); });

      let raised: unknown = null;
      try { lens.dispose(); } catch (e) { raised = e; }

      expect(raised).toBeInstanceOf(DisposalError);
      const err = raised as DisposalError;
      expect(err.errors).toHaveLength(1);
      const tagged = err.errors[0] as { cause: unknown; origin: string };
      expect(tagged.origin).toBe('handler');
      expect(tagged.cause).toBeInstanceOf(DisposedError);
      expect((tagged.cause as DisposedError).attemptedMethod).toBe('add');
      // Disposal completed despite the throw.
      expect(lens.isDisposed).toBe(true);
    });

    // Flow 7
    it('post-disposal-throws: every public method category throws DisposedError; lifecycle surfaces stay valid', async () => {
      const lens = makeLens();
      const id = lens.instanceId;
      lens.add(distinctContent(0));
      lens.dispose();

      // Mutating methods (sync)
      const mutatingSync: [string, () => unknown][] = [
        ['seed', () => lens.seed([{ content: 'x' }])],
        ['add', () => lens.add('x')],
        ['evict', () => lens.evict('any-id')],
        ['createGroup', () => lens.createGroup('g', [])],
        ['dissolveGroup', () => lens.dissolveGroup('g')],
        ['setCapacity', () => lens.setCapacity(5000)],
        ['clearTask', () => lens.clearTask()],
        ['registerPattern', () => lens.registerPattern({
          name: 'x',
          description: 'x',
          detect: () => null,
        })],
        ['attachIntegration', () => lens.attachIntegration(() => {})],
        ['on', () => lens.on('segmentAdded', () => {})],
        ['setTokenizer', () => lens.setTokenizer('approximate')],
      ];
      for (const [name, fn] of mutatingSync) {
        try { fn(); expect.fail(`${name} should have thrown`); } catch (e) {
          expect(e).toBeInstanceOf(DisposedError);
          expect((e as DisposedError).attemptedMethod).toBe(name);
        }
      }

      // Read-only methods
      const readOnly: [string, () => unknown][] = [
        ['getCapacity', () => lens.getCapacity()],
        ['getSegmentCount', () => lens.getSegmentCount()],
        ['listSegments', () => lens.listSegments()],
        ['listGroups', () => lens.listGroups()],
        ['getTask', () => lens.getTask()],
        ['getTaskState', () => lens.getTaskState()],
        ['assess', () => lens.assess()],
        ['snapshot', () => lens.snapshot()],
        ['planEviction', () => lens.planEviction()],
        ['getDiagnostics', () => lens.getDiagnostics()],
        ['getBaseline', () => lens.getBaseline()],
        ['getConfig', () => lens.getConfig()],
        ['getEvictedSegments', () => lens.getEvictedSegments()],
        ['getTokenizerInfo', () => lens.getTokenizerInfo()],
        ['getEmbeddingProviderInfo', () => lens.getEmbeddingProviderInfo()],
        ['getConstructionTimestamp', () => lens.getConstructionTimestamp()],
        ['getPerformance', () => lens.getPerformance()],
        ['getDetection', () => lens.getDetection()],
      ];
      for (const [name, fn] of readOnly) {
        try { fn(); expect.fail(`${name} should have thrown`); } catch (e) {
          expect(e).toBeInstanceOf(DisposedError);
          expect((e as DisposedError).attemptedMethod).toBe(name);
        }
      }

      // Async methods reject with DisposedError (the guard fires synchronously inside the async body).
      await expect(lens.setTask({ description: 'x' })).rejects.toBeInstanceOf(DisposedError);
      await expect(lens.setEmbeddingProvider(null)).rejects.toBeInstanceOf(DisposedError);

      // The four always-valid surfaces remain functional.
      expect(lens.isDisposed).toBe(true);
      expect(lens.isDisposing).toBe(false);
      expect(lens.instanceId).toBe(id);
      expect(() => lens.dispose()).not.toThrow();
    });

    // Flow 8
    it('unsubscribe-handle-noop-on-disposed: holding an unsubscribe and calling it post-dispose is silent', () => {
      const lens = makeLens();
      const off = lens.on('segmentAdded', () => {});

      lens.dispose();

      expect(() => off()).not.toThrow();
      expect(lens.isDisposed).toBe(true);
    });

    // Flow 9
    it('handler-error-aggregated: throwing handler does not block second handler; instance fully disposed', () => {
      const lens = makeLens();
      let secondRan = false;
      lens.on('stateDisposed', () => { throw new Error('h0 boom'); });
      lens.on('stateDisposed', () => { secondRan = true; });

      let raised: unknown = null;
      try { lens.dispose(); } catch (e) { raised = e; }

      expect(raised).toBeInstanceOf(DisposalError);
      expect((raised as DisposalError).errors).toHaveLength(1);
      expect(secondRan).toBe(true);
      expect(lens.isDisposed).toBe(true);
    });
  });

  describe('Fleet integration', () => {

    // Flow 10
    it('fleet-auto-unregister: dispose() removes from fleet and emits instanceDisposed with finalReport', () => {
      const fleet = new ContextLensFleet();
      const lens = makeLens();
      const id = lens.instanceId;
      lens.add(distinctContent(0));
      fleet.register(lens, 'win-1');

      let event: { label: string; instanceId: string; finalReport: { status: string } | null } | null = null;
      fleet.on('instanceDisposed', (e) => { event = e as never; });

      lens.dispose();

      expect(event).not.toBeNull();
      const ev = event as unknown as { label: string; instanceId: string; finalReport: { status: string } | null };
      expect(ev.label).toBe('win-1');
      expect(ev.instanceId).toBe(id);
      expect(ev.finalReport).not.toBeNull();
      expect(ev.finalReport!.status).toBe('ok');

      expect(fleet.size).toBe(0);
      expect(fleet.listInstances()).toEqual([]);
      const fleetReport = fleet.assessFleet();
      expect(fleetReport.instances).toEqual([]);
    });

    // Flow 11
    it('fleet-explicit-unregister: subsequent dispose() does NOT fire instanceDisposed (handle was detached)', () => {
      const fleet = new ContextLensFleet();
      const lens = makeLens();
      fleet.register(lens, 'win-1');
      let emitted = 0;
      fleet.on('instanceDisposed', () => { emitted++; });

      fleet.unregister('win-1');
      // Instance is still live after explicit unregister.
      expect(lens.isDisposed).toBe(false);

      lens.dispose();

      expect(emitted).toBe(0);
      expect(lens.isDisposed).toBe(true);
    });
  });

  describe('OTel integration', () => {

    // Flow 12
    it('otel-auto-disconnect: dispose() emits context_lens.instance.disposed log; disconnect() afterward is a no-op', () => {
      const { meterProvider, gauges } = createMinimalMeter();
      const { logProvider, logs } = createCapturingLogger();
      const lens = makeLens();
      lens.add(distinctContent(0));
      const exporter = new ContextLensExporter(lens, {
        meterProvider,
        label: 'win',
        logProvider,
      });

      lens.dispose();

      const disposedLogs = logs.filter(l => l.body === 'context_lens.instance.disposed');
      expect(disposedLogs).toHaveLength(1);
      expect(disposedLogs[0]!.attributes!['instance.id']).toBe(lens.instanceId);

      // Gauge callbacks were removed during auto-disconnect.
      for (const g of gauges) expect(g.removed).toBe(true);

      // Subsequent explicit disconnect is silent.
      expect(() => exporter.disconnect()).not.toThrow();
    });

    // Flow 13
    it('otel-explicit-disconnect: after disconnect(), dispose() does NOT fire the disposal log', () => {
      const { meterProvider } = createMinimalMeter();
      const { logProvider, logs } = createCapturingLogger();
      const lens = makeLens();
      const exporter = new ContextLensExporter(lens, {
        meterProvider,
        label: 'win',
        logProvider,
      });

      exporter.disconnect();
      lens.dispose();

      expect(logs.filter(l => l.body === 'context_lens.instance.disposed')).toHaveLength(0);
      expect(lens.isDisposed).toBe(true);
    });
  });

  describe('Cross-cutting flows', () => {

    // Flow 14
    it('snapshot-then-dispose-then-restore: restored instance is live with fresh instanceId; original throws', () => {
      const original = makeLens();
      const originalId = original.instanceId;
      original.seed([{ content: distinctContent(0) }, { content: distinctContent(1) }]);
      original.add(distinctContent(2));
      original.assess();

      const snap = original.snapshot();
      original.dispose();

      // Disposed instance throws on every public method.
      expect(() => original.assess()).toThrow(DisposedError);
      expect(() => original.add('x')).toThrow(DisposedError);
      expect(original.instanceId).toBe(originalId);  // identifier retained for error correlation

      // Restore into a fresh instance.
      const restored = ContextLens.fromSnapshot(snap, { capacity: 10000 });
      expect(restored.isDisposed).toBe(false);
      expect(restored.instanceId).not.toBe(originalId);  // fresh identifier
      expect(restored.getSegmentCount()).toBe(3);
      // The restored instance is live and independent — disposing it does not re-affect the original.
      restored.dispose();
      expect(restored.isDisposed).toBe(true);
      expect(original.isDisposed).toBe(true);  // still disposed; not reactivated by snapshot/restore
    });

    // Flow 15
    it('provider-shutdown-ordering: dispose() does NOT call provider close(); caller-managed lifecycle works after', async () => {
      let tokenizerClosed = false;
      const tokenizer: TokenizerProvider & { close: () => Promise<void> } = {
        name: 'mock-async',
        accuracy: 'approximate',
        modelFamily: 'mock',
        errorBound: 0.1,
        count: (text: string) => Math.ceil(text.length / 4),
        close: async () => { tokenizerClosed = true; },
      };

      const lens = new ContextLens({
        capacity: 10000,
        tokenizer,
      });
      lens.add(distinctContent(0));

      lens.dispose();

      // dispose() did not invoke the tokenizer's close() — providers are caller-managed.
      expect(tokenizerClosed).toBe(false);

      // Caller invokes close() explicitly after dispose returns; no library code path accesses the
      // provider during or after disposal, so this is safe regardless of order.
      await tokenizer.close();
      expect(tokenizerClosed).toBe(true);
    });
  });
});
