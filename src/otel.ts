/**
 * ContextLensExporter — OpenTelemetry metrics and log event adapter.
 *
 * Read-only observer that translates context-lens quality signals into
 * OTel gauges, counters, a histogram, and optional log events.
 * Requires @opentelemetry/api as a peer dependency.
 * @see cl-spec-013
 */

import type { ContextLens } from './index.js';
import type { QualityReport, IntegrationHandle } from './types.js';

// ─── Minimal OTel interfaces (structural typing) ────────────────
// Defined locally to avoid tight coupling to specific @opentelemetry/api versions.

export interface OTelMeterProvider {
  getMeter(name: string, version?: string): OTelMeter;
}

export interface OTelMeter {
  createObservableGauge(name: string, options?: OTelMetricOptions): OTelObservableGauge;
  createCounter(name: string, options?: OTelMetricOptions): OTelCounter;
  createHistogram(name: string, options?: OTelMetricOptions): OTelHistogram;
}

export interface OTelMetricOptions {
  description?: string;
  unit?: string;
}

export interface OTelObservableGauge {
  addCallback(callback: (result: OTelObservableResult) => void): void;
  removeCallback(callback: (result: OTelObservableResult) => void): void;
}

export interface OTelObservableResult {
  observe(value: number, attributes?: OTelAttributes): void;
}

export interface OTelCounter {
  add(value: number, attributes?: OTelAttributes): void;
}

export interface OTelHistogram {
  record(value: number, attributes?: OTelAttributes): void;
}

export interface OTelLoggerProvider {
  getLogger(name: string, version?: string): OTelLogger;
}

export interface OTelLogger {
  emit(logRecord: OTelLogRecord): void;
}

export interface OTelLogRecord {
  severityNumber?: number;
  severityText?: string;
  body?: string;
  attributes?: OTelAttributes;
}

export type OTelAttributes = Record<string, string | number | boolean>;

// ─── OTel Severity Constants ─────────────────────────────────────

const SEV_INFO = 9;
const SEV_WARN = 13;

// ─── ExporterOptions ─────────────────────────────────────────────

export interface ExporterOptions {
  meterProvider: OTelMeterProvider;
  label: string;
  metricPrefix?: string;
  emitEvents?: boolean;
  logProvider?: OTelLoggerProvider | null;
}

// ─── ContextLensExporter ─────────────────────────────────────────

export class ContextLensExporter {
  /** Currently bound instance, or null when detached. Becomes nullable to support `attach()` after `disconnect()` per cl-spec-013 §2.1.3. */
  private instance: ContextLens | null;
  private readonly prefix: string;
  private readonly label: string;
  private readonly emitEvents: boolean;
  private readonly logger: OTelLogger | null;

  /**
   * Detached state flag. True between disconnect/auto-disconnect and a
   * subsequent successful `attach()`; false while the exporter is bound to a
   * live instance. Replaces the prior "terminally disconnected" semantics — a
   * detached exporter may now be re-attached (cl-spec-013 §2.1.3).
   */
  private disconnected = false;

  /** Lifecycle integration handle. Non-null while attached; nulled on disconnect/auto-disconnect; refreshed on `attach()`. */
  private integrationHandle: IntegrationHandle | null;

  // Unsubscribe functions for instance events
  private readonly unsubscribers: (() => void)[] = [];

  // Stored gauge values (updated on reportGenerated)
  private storedCoherence = 0;
  private storedDensity = 0;
  private storedRelevance = 0;
  private storedContinuity = 0;
  private storedComposite = 0;
  private storedUtilization = 0;
  private storedSegmentCount = 0;
  private storedHeadroom = 0;
  private storedPatternCount = 0;
  private hasQualityValues = false;

  /**
   * Gauge registry — preserved across detach/attach cycles so the same
   * `OTelObservableGauge` instances continue to satisfy Invariant 10
   * ("instruments reused, not re-created"). `currentCallback` is the callback
   * currently registered with OTel (null when detached); `getValue` is the
   * stored-value reader closure used to construct fresh callbacks per cycle.
   */
  private readonly gauges: Array<{
    gauge: OTelObservableGauge;
    getValue: () => number | null;
    currentCallback: ((result: OTelObservableResult) => void) | null;
  }> = [];

  // Counters
  private readonly counters: {
    evictions: OTelCounter;
    compactions: OTelCounter;
    restorations: OTelCounter;
    patternActivations: OTelCounter;
    assessCount: OTelCounter;
    taskChanges: OTelCounter;
  };

  // Histogram
  private readonly assessDuration: OTelHistogram;

  /**
   * Create an OTel exporter that subscribes to a ContextLens instance's events
   * and translates quality signals into OTel metrics and log events.
   * @param instance - The ContextLens instance to observe (read-only).
   * @param options - OTel providers, label, and optional metric prefix.
   * @see cl-spec-013
   */
  constructor(instance: ContextLens, options: ExporterOptions) {
    this.instance = instance;
    this.prefix = options.metricPrefix ?? 'context_lens';
    this.label = options.label;
    this.emitEvents = options.emitEvents ?? true;
    this.logger = options.logProvider?.getLogger('context_lens') ?? null;

    const meter = options.meterProvider.getMeter('context_lens');

    // ── Gauges (observable) ──────────────────────────────────────
    // Populate the persistent gauge registry once; callbacks are added by
    // attachGaugeCallbacks below and may be removed/re-added across cycles.
    this.registerGauge(meter, 'coherence', '1', 'Window coherence score', () =>
      this.hasQualityValues ? this.storedCoherence : null,
    );
    this.registerGauge(meter, 'density', '1', 'Window density score', () =>
      this.hasQualityValues ? this.storedDensity : null,
    );
    this.registerGauge(meter, 'relevance', '1', 'Window relevance score', () =>
      this.hasQualityValues ? this.storedRelevance : null,
    );
    this.registerGauge(meter, 'continuity', '1', 'Window continuity score', () =>
      this.hasQualityValues ? this.storedContinuity : null,
    );
    this.registerGauge(meter, 'composite', '1', 'Composite quality score', () =>
      this.hasQualityValues ? this.storedComposite : null,
    );
    this.registerGauge(meter, 'utilization', '1', 'Token utilization ratio', () => this.storedUtilization);
    this.registerGauge(meter, 'segment_count', '{segments}', 'Active segment count', () => this.storedSegmentCount);
    this.registerGauge(meter, 'headroom', '{tokens}', 'Token headroom', () => this.storedHeadroom);
    this.registerGauge(meter, 'pattern_count', '{patterns}', 'Active degradation pattern count', () => this.storedPatternCount);

    // ── Counters ─────────────────────────────────────────────────
    const c = (name: string, unit: string, desc: string) =>
      meter.createCounter(`${this.prefix}.${name}`, { unit, description: desc });

    this.counters = {
      evictions: c('evictions_total', '{evictions}', 'Total evictions'),
      compactions: c('compactions_total', '{compactions}', 'Total compactions'),
      restorations: c('restorations_total', '{restorations}', 'Total restorations'),
      patternActivations: c('pattern_activations_total', '{activations}', 'Total pattern activations'),
      assessCount: c('assess_count', '{assessments}', 'Total assessments'),
      taskChanges: c('task_changes_total', '{changes}', 'Total task changes'),
    };

    // ── Histogram ────────────────────────────────────────────────
    this.assessDuration = meter.createHistogram(`${this.prefix}.assess_duration_ms`, {
      unit: 'ms',
      description: 'Assessment duration',
    });

    // ── Wire gauge callbacks + subscribe to instance events ──────
    this.attachGaugeCallbacks();
    this.subscribeAll(instance);

    // ── Lifecycle integration handshake (cl-spec-013 §2.1.2) ─────
    // Attach last so subscribeAll has already validated the instance is
    // reachable. attachIntegration throws DisposedError if the instance is
    // already disposed; the constructor lets that propagate.
    this.integrationHandle = instance.attachIntegration((live) => {
      this.handleInstanceDisposal(live);
    });
  }

  /**
   * Stop metric updates, remove gauge callbacks, and unsubscribe from all instance events.
   * Detaches the lifecycle integration handle so a later `dispose()` on the
   * instance does not fire the `context_lens.instance.disposed` log event
   * (cl-spec-013 §2.1.1). Idempotent — safe to call multiple times.
   *
   * After disconnect the exporter is in the detached state. It may be
   * re-bound to a fresh instance via `attach()` (cl-spec-013 §2.1.3); the OTel
   * instruments (gauges, counters, histogram) are preserved across the cycle.
   * @see cl-spec-013 §2.1.1
   */
  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;

    if (this.integrationHandle !== null) {
      this.integrationHandle.detach();
      this.integrationHandle = null;
    }
    this.detachGaugeCallbacks();
    this.cleanupSubscriptions();
    this.instance = null;
  }

  /**
   * Re-attach a detached exporter to a fresh `ContextLens` instance.
   *
   * Preconditions: the exporter must be in the detached state (after
   * `disconnect()` or auto-disconnect via the previous instance's `dispose()`),
   * and `instance` must be live. Throws `Error` if attempted on a still-
   * connected exporter; throws `DisposedError` (raised by `attachIntegration`)
   * if `instance` is already disposed. On either failure the exporter remains
   * in the detached state — no partial attachment.
   *
   * State scope: counters and histograms are preserved (no reset; OTel
   * monotonic and distributional contracts unbroken across the cycle). Gauge
   * stored values are reset to defaults so the first `reportGenerated` event
   * from the newly-attached instance repopulates them. The OTel instruments
   * themselves are reused — `attach()` does not re-register with the meter
   * provider.
   *
   * @see cl-spec-013 §2.1.3, Invariants 10 and 11
   */
  attach(instance: ContextLens): void {
    if (!this.disconnected) {
      throw new Error(
        'ContextLensExporter.attach: exporter is currently attached. ' +
          'Call disconnect() before attaching to a new instance.',
      );
    }

    // Validate via the lifecycle handshake first. attachIntegration throws
    // DisposedError if the instance is already disposed. We do this BEFORE
    // any state mutation so the exporter remains in a clean detached state
    // on failure (no partial attachment).
    const handle = instance.attachIntegration((live) => {
      this.handleInstanceDisposal(live);
    });

    // Commit point — past here we are attached.
    this.instance = instance;
    this.integrationHandle = handle;
    this.disconnected = false;

    // Reset gauge state so the new instance's first reportGenerated
    // repopulates the values. Counters and histogram are deliberately
    // untouched (Invariant 10).
    this.resetGaugeState();

    // Re-register gauge callbacks and event subscriptions against the
    // new instance.
    this.attachGaugeCallbacks();
    this.subscribeAll(instance);
  }

  // ── Private: lifecycle integration callback (cl-spec-013 §2.1.2) ─

  /**
   * Invoked synchronously during step 3 of the instance's `dispose()` teardown.
   * Performs the final-signal flush (one fresh `assess()` to capture last
   * composite + utilization), emits the `context_lens.instance.disposed` log
   * event, and then runs the same subscription cleanup as `disconnect()`.
   * Convergent end state with explicit `disconnect()` — both leave
   * `disconnected === true` with no live subscriptions or gauge callbacks.
   *
   * Per cl-spec-015 §6.2 the instance is in `isDisposing === true` here;
   * `assess()` is read-only and passes the disposing-state guard.
   */
  private handleInstanceDisposal(instance: ContextLens): void {
    if (this.disconnected) return;
    this.disconnected = true;

    let finalReport: QualityReport | null = null;
    try {
      finalReport = instance.assess();
    } catch {
      finalReport = null;
    }

    if (this.emitEvents && this.logger) {
      const attrs: OTelAttributes = { 'instance.id': instance.instanceId };
      if (finalReport !== null) {
        if (finalReport.composite !== null) {
          attrs['instance.final_composite'] = finalReport.composite;
        }
        attrs['instance.final_utilization'] = finalReport.capacity.utilization;
      }
      this.log('context_lens.instance.disposed', SEV_INFO, attrs);
    }

    this.detachGaugeCallbacks();
    this.cleanupSubscriptions();
    // The IntegrationRegistry has already removed this entry from its array
    // as part of invokeAll(); the handle's detach() would be a no-op even if
    // called. Null the field anyway to mirror the disconnect() shape.
    this.integrationHandle = null;
    this.instance = null;
  }

  // ── Private: shared cleanup ──────────────────────────────────

  private cleanupSubscriptions(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  // ── Private: gauge registration + callback management ────────

  /**
   * One-shot gauge registration. Called from the constructor only — populates
   * the persistent gauge registry but does NOT install the OTel callback.
   * Callback wiring lives in {@link attachGaugeCallbacks} so it can be
   * removed and re-added across detach/attach cycles per cl-spec-013 §2.1.3.
   */
  private registerGauge(
    meter: OTelMeter,
    name: string,
    unit: string,
    description: string,
    getValue: () => number | null,
  ): void {
    const gauge = meter.createObservableGauge(`${this.prefix}.${name}`, { unit, description });
    this.gauges.push({ gauge, getValue, currentCallback: null });
  }

  /**
   * Install fresh gauge callbacks against OTel for every entry in
   * {@link gauges}. Called once at construction and again from {@link attach}.
   * Each callback wraps the value-producer with the disconnected guard plus
   * the common-attribute lookup.
   */
  private attachGaugeCallbacks(): void {
    for (const entry of this.gauges) {
      // Defensive: if a callback is already attached, leave it. This branch
      // is unreachable from the documented call sites (constructor and
      // attach()), but the guard prevents double-registration if a future
      // call site forgets to detach first.
      if (entry.currentCallback !== null) continue;

      const callback = (result: OTelObservableResult): void => {
        if (this.disconnected) return;
        const val = entry.getValue();
        if (val !== null) result.observe(val, this.commonAttributes());
      };
      entry.gauge.addCallback(callback);
      entry.currentCallback = callback;
    }
  }

  /**
   * Remove all currently-attached gauge callbacks from OTel. Called from
   * {@link disconnect} and {@link handleInstanceDisposal}. Preserves gauge
   * identity in {@link gauges} so {@link attach} can re-register fresh
   * callbacks against the same instruments.
   */
  private detachGaugeCallbacks(): void {
    for (const entry of this.gauges) {
      if (entry.currentCallback !== null) {
        entry.gauge.removeCallback(entry.currentCallback);
        entry.currentCallback = null;
      }
    }
  }

  /**
   * Reset stored gauge values to their construction-time defaults. Called from
   * {@link attach} so the new instance's first `reportGenerated` event
   * repopulates the values rather than carrying over the prior instance's
   * point-in-time observations (cl-spec-013 §2.1.3, Invariant 10).
   */
  private resetGaugeState(): void {
    this.storedCoherence = 0;
    this.storedDensity = 0;
    this.storedRelevance = 0;
    this.storedContinuity = 0;
    this.storedComposite = 0;
    this.storedUtilization = 0;
    this.storedSegmentCount = 0;
    this.storedHeadroom = 0;
    this.storedPatternCount = 0;
    this.hasQualityValues = false;
  }

  // ── Private: common attributes ───────────────────────────────

  private commonAttributes(): OTelAttributes {
    // Defensive guard for the detached state. Every reachable caller of
    // commonAttributes already short-circuits on `disconnected`, so this
    // branch is unreachable from the documented call sites. The guard is
    // here to keep the method total in case a future refactor introduces a
    // path that bypasses the disconnected check.
    if (this.instance === null) {
      return { 'context_lens.window': this.label };
    }
    const embeddingInfo = this.instance.getEmbeddingProviderInfo();
    return {
      'context_lens.window': this.label,
      'context_lens.tokenizer': this.instance.getTokenizerInfo().name,
      'context_lens.embedding_mode': embeddingInfo !== null ? 'embeddings' : 'trigrams',
    };
  }

  // ── Private: event subscriptions ─────────────────────────────

  /**
   * Subscribe to instance lifecycle and quality events. The `instance`
   * parameter is the freshly-attached (or freshly-constructed) reference;
   * the instance field on `this` may be the same value or null at the time
   * of call (constructor sets it just-prior; `attach()` likewise). Using
   * the parameter rather than `this.instance` keeps the call site
   * type-safe across the nullable field shape introduced for re-attach.
   */
  private subscribeAll(instance: ContextLens): void {
    // reportGenerated → gauges + assess counter + histogram + capacity warning
    this.unsubscribers.push(
      instance.on('reportGenerated', ({ report }) => {
        if (this.disconnected) return;
        const attrs = this.commonAttributes();

        this.updateStoredGauges(report);
        this.counters.assessCount.add(1, attrs);

        const duration = Date.now() - report.timestamp;
        if (duration >= 0) this.assessDuration.record(duration, attrs);

        if (this.emitEvents && this.logger && report.capacity.utilization > 0.90) {
          this.log('context_lens.capacity.warning', SEV_WARN, {
            'capacity.utilization': report.capacity.utilization,
            'capacity.headroom': report.capacity.headroom,
          });
        }
      }),
    );

    // segmentEvicted → counter
    this.unsubscribers.push(
      instance.on('segmentEvicted', () => {
        if (this.disconnected) return;
        this.counters.evictions.add(1, this.commonAttributes());
      }),
    );

    // segmentCompacted → counter
    this.unsubscribers.push(
      instance.on('segmentCompacted', () => {
        if (this.disconnected) return;
        this.counters.compactions.add(1, this.commonAttributes());
      }),
    );

    // segmentRestored → counter
    this.unsubscribers.push(
      instance.on('segmentRestored', () => {
        if (this.disconnected) return;
        this.counters.restorations.add(1, this.commonAttributes());
      }),
    );

    // patternActivated → counter + log event
    this.unsubscribers.push(
      instance.on('patternActivated', ({ pattern }) => {
        if (this.disconnected) return;
        this.counters.patternActivations.add(1, this.commonAttributes());
        if (this.emitEvents && this.logger) {
          this.log('context_lens.pattern.activated', SEV_WARN, {
            'pattern.name': pattern.name,
            'pattern.severity': pattern.severity,
            'pattern.explanation': pattern.explanation,
          });
        }
      }),
    );

    // patternResolved → log event only
    this.unsubscribers.push(
      instance.on('patternResolved', ({ name, duration, peakSeverity }) => {
        if (this.disconnected) return;
        if (this.emitEvents && this.logger) {
          this.log('context_lens.pattern.resolved', SEV_INFO, {
            'pattern.name': name,
            'pattern.duration_ms': duration,
            'pattern.peak_severity': peakSeverity,
          });
        }
      }),
    );

    // taskChanged → counter (change only) + log event (all except "same")
    this.unsubscribers.push(
      instance.on('taskChanged', ({ transition }) => {
        if (this.disconnected) return;
        if (transition.type === 'change') {
          this.counters.taskChanges.add(1, this.commonAttributes());
        }
        if (this.emitEvents && this.logger && transition.type !== 'same') {
          const attrs: OTelAttributes = { 'task.transition_type': transition.type };
          if (transition.similarity !== undefined) {
            attrs['task.similarity'] = transition.similarity;
          }
          this.log('context_lens.task.changed', SEV_INFO, attrs);
        }
      }),
    );

    // budgetViolation → log event
    this.unsubscribers.push(
      instance.on('budgetViolation', ({ operation, selfTime, budgetTarget }) => {
        if (this.disconnected) return;
        if (this.emitEvents && this.logger) {
          this.log('context_lens.budget.violated', SEV_WARN, {
            'budget.operation': operation,
            'budget.self_time_ms': selfTime,
            'budget.target_ms': budgetTarget,
          });
        }
      }),
    );
  }

  // ── Private: gauge value storage ─────────────────────────────

  private updateStoredGauges(report: QualityReport): void {
    this.storedSegmentCount = report.segmentCount;
    this.storedUtilization = report.capacity.utilization;
    this.storedHeadroom = report.capacity.headroom;
    this.storedPatternCount = report.patterns.patternCount;

    // Quality gauges: only update when segments exist (retain previous otherwise)
    if (report.segmentCount > 0) {
      this.storedCoherence = report.windowScores.coherence ?? 0;
      this.storedDensity = report.windowScores.density ?? 0;
      this.storedRelevance = report.windowScores.relevance ?? 0;
      this.storedContinuity = report.windowScores.continuity ?? 0;
      this.storedComposite = report.composite ?? 0;
      this.hasQualityValues = true;
    }
  }

  // ── Private: log emission ────────────────────────────────────

  private log(eventName: string, severity: number, extra: OTelAttributes): void {
    if (!this.logger) return;
    try {
      this.logger.emit({
        severityNumber: severity,
        severityText: severity === SEV_WARN ? 'WARN' : 'INFO',
        body: eventName,
        attributes: {
          ...this.commonAttributes(),
          ...extra,
          'context_lens.timestamp': Date.now(),
        },
      });
    } catch {
      // Handler errors swallowed — failing OTel push must not propagate
    }
  }
}
