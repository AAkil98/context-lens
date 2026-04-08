/**
 * ContextLensExporter — OpenTelemetry metrics and log event adapter.
 *
 * Read-only observer that translates context-lens quality signals into
 * OTel gauges, counters, a histogram, and optional log events.
 * Requires @opentelemetry/api as a peer dependency.
 * @see cl-spec-013
 */

import type { ContextLens } from './index.js';
import type { QualityReport } from './types.js';

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
  private readonly instance: ContextLens;
  private readonly prefix: string;
  private readonly label: string;
  private readonly emitEvents: boolean;
  private readonly logger: OTelLogger | null;
  private disconnected = false;

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

  // Gauge + callback pairs for cleanup on disconnect
  private readonly gaugeCleanup: Array<{
    gauge: OTelObservableGauge;
    callback: (result: OTelObservableResult) => void;
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

  constructor(instance: ContextLens, options: ExporterOptions) {
    this.instance = instance;
    this.prefix = options.metricPrefix ?? 'context_lens';
    this.label = options.label;
    this.emitEvents = options.emitEvents ?? true;
    this.logger = options.logProvider?.getLogger('context_lens') ?? null;

    const meter = options.meterProvider.getMeter('context_lens');

    // ── Gauges (observable) ──────────────────────────────────────
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

    // ── Subscribe to instance events ─────────────────────────────
    this.subscribeAll();
  }

  /** Stop metric updates and unsubscribe from all events. Idempotent. */
  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;

    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;

    for (const { gauge, callback } of this.gaugeCleanup) {
      gauge.removeCallback(callback);
    }
    this.gaugeCleanup.length = 0;
  }

  // ── Private: gauge registration ──────────────────────────────

  private registerGauge(
    meter: OTelMeter,
    name: string,
    unit: string,
    description: string,
    getValue: () => number | null,
  ): void {
    const gauge = meter.createObservableGauge(`${this.prefix}.${name}`, { unit, description });

    const callback = (result: OTelObservableResult) => {
      if (this.disconnected) return;
      const val = getValue();
      if (val !== null) result.observe(val, this.commonAttributes());
    };

    gauge.addCallback(callback);
    this.gaugeCleanup.push({ gauge, callback });
  }

  // ── Private: common attributes ───────────────────────────────

  private commonAttributes(): OTelAttributes {
    const embeddingInfo = this.instance.getEmbeddingProviderInfo();
    return {
      'context_lens.window': this.label,
      'context_lens.tokenizer': this.instance.getTokenizerInfo().name,
      'context_lens.embedding_mode': embeddingInfo !== null ? 'embeddings' : 'trigrams',
    };
  }

  // ── Private: event subscriptions ─────────────────────────────

  private subscribeAll(): void {
    // reportGenerated → gauges + assess counter + histogram + capacity warning
    this.unsubscribers.push(
      this.instance.on('reportGenerated', ({ report }) => {
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
      this.instance.on('segmentEvicted', () => {
        if (this.disconnected) return;
        this.counters.evictions.add(1, this.commonAttributes());
      }),
    );

    // segmentCompacted → counter
    this.unsubscribers.push(
      this.instance.on('segmentCompacted', () => {
        if (this.disconnected) return;
        this.counters.compactions.add(1, this.commonAttributes());
      }),
    );

    // segmentRestored → counter
    this.unsubscribers.push(
      this.instance.on('segmentRestored', () => {
        if (this.disconnected) return;
        this.counters.restorations.add(1, this.commonAttributes());
      }),
    );

    // patternActivated → counter + log event
    this.unsubscribers.push(
      this.instance.on('patternActivated', ({ pattern }) => {
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
      this.instance.on('patternResolved', ({ name, duration, peakSeverity }) => {
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
      this.instance.on('taskChanged', ({ transition }) => {
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
      this.instance.on('budgetViolation', ({ operation, selfTime, budgetTarget }) => {
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
