/**
 * ContextLensFleet — multi-instance fleet monitoring.
 *
 * Aggregates quality metrics across multiple ContextLens instances.
 * Read-only consumer: never mutates instance state.
 * @see cl-spec-012
 */

import type { ContextLens } from './index.js';
import type {
  Severity,
  ActivePattern,
  InstanceReport,
  AggregateStat,
  FleetAggregate,
  Hotspot,
  RankedInstance,
  FleetCapacity,
  FleetReport,
  IntegrationHandle,
} from './types.js';
import { ValidationError, DuplicateIdError } from './errors.js';
import { EventEmitter } from './events.js';

// ─── Constants ───────────────────────────────────────────────────

const SCHEMA_VERSION = '1.0.0';
const DEFAULT_DEGRADATION_THRESHOLD = 0.5;

// ─── Fleet Event Map ─────────────────────────────────────────────

export interface FleetEventMap {
  instanceDegraded: { label: string; pattern: ActivePattern };
  instanceRecovered: { label: string; pattern: string; duration: number };
  instanceDisposed: { label: string; instanceId: string; finalReport: InstanceReport | null };
  fleetDegraded: { degradedCount: number; totalCount: number; ratio: number; hotspots: Hotspot[] };
  fleetRecovered: { degradedCount: number; totalCount: number; ratio: number };
}

// ─── Instance Info (lightweight read) ────────────────────────────

export interface InstanceInfo {
  label: string;
  segmentCount: number;
  capacity: number;
  utilization: number;
  lastAssessedAt: number | null;
}

// ─── Internal tracking state per instance ────────────────────────

interface InstanceState {
  instance: ContextLens;
  /** Lifecycle integration handle — detached on explicit `unregister` to silence auto-unregister (cl-spec-012 §3.2). */
  handle: IntegrationHandle;
  lastAssessedAt: number | null;
  activePatterns: Set<string>;
  patternActivatedAt: Map<string, number>;
}

// ─── Severity ordering ───────────────────────────────────────────

const SEVERITY_ORDER: Record<Severity, number> = {
  watch: 0,
  warning: 1,
  critical: 2,
};

// ─── ContextLensFleet ────────────────────────────────────────────

export class ContextLensFleet {
  private readonly degradationThreshold: number;
  private readonly emitter = new EventEmitter<FleetEventMap>();

  /** Registration-ordered labels */
  private readonly labels: string[] = [];
  /** Label → instance tracking state */
  private readonly instances = new Map<string, InstanceState>();
  /** Whether fleet is currently in degraded state */
  private fleetDegradedState = false;

  /**
   * Create a fleet monitor for aggregating quality across multiple ContextLens instances.
   * @param options.degradationThreshold - Ratio of degraded instances that triggers a fleet-level alert (default 0.5).
   * @see cl-spec-012
   */
  constructor(options?: { degradationThreshold?: number }) {
    this.degradationThreshold = options?.degradationThreshold ?? DEFAULT_DEGRADATION_THRESHOLD;

    if (this.degradationThreshold < 0 || this.degradationThreshold > 1) {
      throw new ValidationError('degradationThreshold must be in [0.0, 1.0]', {
        degradationThreshold: this.degradationThreshold,
      });
    }
  }

  // ── Registration ─────────────────────────────────────────────

  /**
   * Register a ContextLens instance under a unique label.
   *
   * Performs the lifecycle integration handshake by calling
   * `instance.attachIntegration` — propagates `DisposedError` if the instance
   * is already disposed (cl-spec-012 §3.1, cl-spec-015 §6.2). Map mutations
   * are deferred until after the handshake succeeds so registration is atomic.
   *
   * @throws {DuplicateIdError} If the label is already registered.
   * @throws {DisposedError} If the instance is already disposed.
   * @see cl-spec-012 §3
   */
  register(instance: ContextLens, label: string): void {
    if (!label || label.length === 0) {
      throw new ValidationError('Label must be non-empty');
    }
    if (this.instances.has(label)) {
      throw new DuplicateIdError(`Label already registered: ${label}`, { label });
    }
    if (instance == null || typeof instance.assess !== 'function') {
      throw new ValidationError('Instance must be a valid ContextLens instance');
    }

    // Lifecycle integration handshake (cl-spec-012 §3.1, cl-spec-015 §6.2). May throw DisposedError.
    const handle = instance.attachIntegration((live) => {
      this.handleInstanceDisposal(label, live);
    });

    this.labels.push(label);
    this.instances.set(label, {
      instance,
      handle,
      lastAssessedAt: null,
      activePatterns: new Set(),
      patternActivatedAt: new Map(),
    });
  }

  /**
   * Unregister a previously registered instance. Detaches the lifecycle
   * integration handle so a later `dispose()` on the instance does not fire
   * `instanceDisposed` on this fleet (cl-spec-012 §3.2 — explicit unregister
   * is silent; only auto-unregister emits the event).
   */
  unregister(label: string): void {
    const state = this.instances.get(label);
    if (state === undefined) {
      throw new ValidationError(`Label not found: ${label}`, { label });
    }
    state.handle.detach();
    this.instances.delete(label);
    const idx = this.labels.indexOf(label);
    if (idx !== -1) this.labels.splice(idx, 1);
  }

  /** List lightweight metadata for all registered instances. */
  listInstances(): InstanceInfo[] {
    return this.labels.map(label => {
      const state = this.instances.get(label)!;
      const cap = state.instance.getCapacity();
      return {
        label,
        segmentCount: state.instance.getSegmentCount(),
        capacity: cap.capacity,
        utilization: cap.utilization,
        lastAssessedAt: state.lastAssessedAt,
      };
    });
  }

  /** Get an instance reference by label. Returns null if not found. */
  get(label: string): ContextLens | null {
    const state = this.instances.get(label);
    return state !== undefined ? state.instance : null;
  }

  /** Number of registered instances. */
  get size(): number {
    return this.instances.size;
  }

  // ── Events ───────────────────────────────────────────────────

  /** Subscribe to a fleet event. Returns unsubscribe function. */
  on<E extends keyof FleetEventMap>(
    event: E,
    handler: (payload: FleetEventMap[E]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  // ── Assessment ───────────────────────────────────────────────

  /**
   * Assess all fleet instances and produce a fleet-wide report with aggregates,
   * hotspots, ranking, and capacity overview. Fail-open: one failing instance
   * does not break the fleet assessment.
   * @param options.cached - If true, reuse each instance's cached report instead of re-assessing.
   * @see cl-spec-012 §4
   */
  assessFleet(options?: { cached?: boolean }): FleetReport {
    const cached = options?.cached ?? false;
    const now = Date.now();

    // Step 1: Collect per-instance reports
    const instanceReports: InstanceReport[] = [];

    for (const label of this.labels) {
      const state = this.instances.get(label)!;
      instanceReports.push(this.assessOneInstance(state, label, cached, now));
    }

    // Step 2: Separate ok instances for aggregation
    const okInstances = instanceReports.filter(r => r.status === 'ok');
    const failedCount = instanceReports.filter(r => r.status === 'error').length;

    // Step 3: Build aggregate
    const aggregate = this.computeAggregate(okInstances);

    // Step 4: Build hotspots
    const hotspots = this.computeHotspots(okInstances);

    // Step 5: Build ranking
    const ranking = this.computeRanking(okInstances);

    // Step 6: Build capacity overview
    const capacityOverview = this.computeFleetCapacity(instanceReports);

    // Step 7: Emit events (only for fresh assessment)
    if (!cached) {
      this.emitFleetEvents(okInstances, hotspots);
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      timestamp: now,
      instanceCount: this.instances.size,
      assessedCount: okInstances.length,
      failedInstances: failedCount,
      cached,
      instances: instanceReports,
      aggregate,
      hotspots,
      ranking,
      capacityOverview,
    };
  }

  /**
   * Assess a single registered instance without full fleet assessment cost.
   * @throws {ValidationError} If the label is not registered.
   * @see cl-spec-012 §4
   */
  assessInstance(label: string, options?: { cached?: boolean }): InstanceReport {
    const state = this.instances.get(label);
    if (state === undefined) {
      throw new ValidationError(`Label not found: ${label}`, { label });
    }
    const cached = options?.cached ?? false;
    return this.assessOneInstance(state, label, cached, Date.now());
  }

  // ── Private: per-instance assessment ─────────────────────────

  private assessOneInstance(
    state: InstanceState,
    label: string,
    cached: boolean,
    timestamp: number,
  ): InstanceReport {
    const capacity = state.instance.getCapacity();

    if (cached) {
      // Use the instance's cached report (last assess() result)
      // We do a fresh assess() to see if the cache is valid — but in cached mode
      // we look at the last report the instance may have produced.
      // The spec says "reads latest cached report" — we try assess() which returns
      // cached if no mutations. But for truly cached mode we don't call assess().
      // Instead we rely on the instance having been assessed previously.
      // The simplest approach: we check if lastAssessedAt is set.
      if (state.lastAssessedAt === null) {
        return {
          label,
          status: 'no-report',
          error: null,
          report: null,
          capacity,
        };
      }
      // Call assess() which returns cached if no mutations since last call
      try {
        const report = state.instance.assess();
        return { label, status: 'ok', error: null, report, capacity };
      } catch (err) {
        return {
          label,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          report: null,
          capacity,
        };
      }
    }

    // Fresh assessment
    try {
      const report = state.instance.assess();
      state.lastAssessedAt = timestamp;
      return { label, status: 'ok', error: null, report, capacity };
    } catch (err) {
      return {
        label,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        report: null,
        capacity,
      };
    }
  }

  // ── Private: lifecycle integration callback (cl-spec-012 §7) ─

  /**
   * Invoked synchronously during step 3 of an instance's `dispose()` teardown.
   * Computes a final InstanceReport, emits `instanceDisposed` on the fleet
   * emitter, and removes the instance from the tracked set. Errors thrown by
   * `assess()` are tolerated — `assessOneInstance` already absorbs internal
   * exceptions, but the outer try/catch is belt-and-suspenders for any future
   * change. Per cl-spec-015 §6.2, the instance is in `isDisposing === true`
   * state during this callback; mutations would throw `DisposedError`, but
   * read-only `assess()` and `getCapacity()` are valid.
   */
  private handleInstanceDisposal(label: string, instance: ContextLens): void {
    const state = this.instances.get(label);
    if (state === undefined) return;  // defensive: explicit unregister won the race

    let finalReport: InstanceReport | null = null;
    try {
      finalReport = this.assessOneInstance(state, label, false, Date.now());
    } catch {
      finalReport = null;
    }

    this.emitter.emit('instanceDisposed', {
      label,
      instanceId: instance.instanceId,
      finalReport,
    });

    this.instances.delete(label);
    const idx = this.labels.indexOf(label);
    if (idx !== -1) this.labels.splice(idx, 1);
  }

  // ── Private: aggregation ─────────────────────────────────────

  private computeAggregate(okInstances: InstanceReport[]): FleetAggregate {
    const empty: AggregateStat = { mean: 0, min: 0, max: 0, minInstance: '', maxInstance: '', stddev: 0 };

    if (okInstances.length === 0) {
      return {
        coherence: { ...empty },
        density: { ...empty },
        relevance: { ...empty },
        continuity: { ...empty },
        composite: { ...empty },
        utilization: { ...empty },
      };
    }

    const extract = (r: InstanceReport, dim: string): number => {
      const report = r.report!;
      switch (dim) {
        case 'coherence': return report.windowScores.coherence ?? 0;
        case 'density': return report.windowScores.density ?? 0;
        case 'relevance': return report.windowScores.relevance ?? 0;
        case 'continuity': return report.windowScores.continuity ?? 0;
        case 'composite': return report.composite ?? 0;
        case 'utilization': return r.capacity.utilization;
        default: return 0;
      }
    };

    const computeStat = (dim: string): AggregateStat => {
      const entries = okInstances.map(r => ({ label: r.label, value: extract(r, dim) }));

      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      let minLabel = '';
      let maxLabel = '';

      for (const e of entries) {
        sum += e.value;
        if (e.value < min) { min = e.value; minLabel = e.label; }
        if (e.value > max) { max = e.value; maxLabel = e.label; }
      }

      const mean = sum / entries.length;

      // Sample standard deviation (n-1 denominator)
      let stddev = 0;
      if (entries.length >= 2) {
        let sumSqDiff = 0;
        for (const e of entries) {
          const diff = e.value - mean;
          sumSqDiff += diff * diff;
        }
        stddev = Math.sqrt(sumSqDiff / (entries.length - 1));
      }

      return { mean, min, max, minInstance: minLabel, maxInstance: maxLabel, stddev };
    };

    return {
      coherence: computeStat('coherence'),
      density: computeStat('density'),
      relevance: computeStat('relevance'),
      continuity: computeStat('continuity'),
      composite: computeStat('composite'),
      utilization: computeStat('utilization'),
    };
  }

  // ── Private: hotspots ────────────────────────────────────────

  private computeHotspots(okInstances: InstanceReport[]): Hotspot[] {
    const hotspots: Hotspot[] = [];

    for (const inst of okInstances) {
      const patterns = inst.report!.patterns;
      if (patterns.patternCount === 0) continue;

      hotspots.push({
        label: inst.label,
        highestSeverity: patterns.highestSeverity!,
        patternCount: patterns.patternCount,
        patterns: patterns.patterns.map(p => p.name),
        composite: inst.report!.composite ?? 0,
      });
    }

    // Sort: severity desc, patternCount desc, composite asc
    hotspots.sort((a, b) => {
      const sevDiff = SEVERITY_ORDER[b.highestSeverity] - SEVERITY_ORDER[a.highestSeverity];
      if (sevDiff !== 0) return sevDiff;
      const countDiff = b.patternCount - a.patternCount;
      if (countDiff !== 0) return countDiff;
      return a.composite - b.composite;
    });

    return hotspots;
  }

  // ── Private: ranking ─────────────────────────────────────────

  private computeRanking(okInstances: InstanceReport[]): RankedInstance[] {
    const entries = okInstances.map(r => ({
      label: r.label,
      composite: r.report!.composite,
      utilization: r.capacity.utilization,
    }));

    // Sort: composite ascending (weakest first), tie-break by utilization descending
    entries.sort((a, b) => {
      // Null composites rank last
      if (a.composite === null && b.composite === null) return 0;
      if (a.composite === null) return 1;
      if (b.composite === null) return -1;
      const compDiff = a.composite - b.composite;
      if (compDiff !== 0) return compDiff;
      return b.utilization - a.utilization;
    });

    return entries.map((e, i) => ({
      label: e.label,
      composite: e.composite,
      rank: i + 1,
    }));
  }

  // ── Private: fleet capacity ──────────────────────────────────

  private computeFleetCapacity(allInstances: InstanceReport[]): FleetCapacity {
    let totalCapacity = 0;
    let totalActiveTokens = 0;
    let overCapacityCount = 0;
    let highUtilizationCount = 0;

    for (const inst of allInstances) {
      totalCapacity += inst.capacity.capacity;
      totalActiveTokens += inst.capacity.totalActiveTokens;
      if (inst.capacity.utilization > 1.0) overCapacityCount++;
      if (inst.capacity.utilization > 0.85) highUtilizationCount++;
    }

    return {
      totalCapacity,
      totalActiveTokens,
      fleetUtilization: totalCapacity > 0 ? totalActiveTokens / totalCapacity : 0,
      overCapacityCount,
      highUtilizationCount,
    };
  }

  // ── Private: event emission ──────────────────────────────────

  private emitFleetEvents(okInstances: InstanceReport[], hotspots: Hotspot[]): void {
    // Per-instance pattern diff
    for (const inst of okInstances) {
      const state = this.instances.get(inst.label)!;
      const currentPatterns = new Map<string, ActivePattern>();
      for (const p of inst.report!.patterns.patterns) {
        currentPatterns.set(p.name, p);
      }

      const previousNames = state.activePatterns;
      const currentNames = new Set(currentPatterns.keys());

      // New activations
      for (const name of currentNames) {
        if (!previousNames.has(name)) {
          const pattern = currentPatterns.get(name)!;
          state.patternActivatedAt.set(name, pattern.activatedAt);
          this.emitter.emit('instanceDegraded', { label: inst.label, pattern });
        }
      }

      // Resolutions
      for (const name of previousNames) {
        if (!currentNames.has(name)) {
          const activatedAt = state.patternActivatedAt.get(name) ?? inst.report!.timestamp;
          const duration = inst.report!.timestamp - activatedAt;
          state.patternActivatedAt.delete(name);
          this.emitter.emit('instanceRecovered', { label: inst.label, pattern: name, duration });
        }
      }

      // Update cached state
      state.activePatterns = currentNames;
    }

    // Fleet-level degradation
    const totalCount = okInstances.length;
    if (totalCount === 0) return;

    const degradedCount = okInstances.filter(
      r => r.report!.patterns.patternCount > 0,
    ).length;
    const ratio = degradedCount / totalCount;

    if (ratio > this.degradationThreshold && !this.fleetDegradedState) {
      this.fleetDegradedState = true;
      this.emitter.emit('fleetDegraded', { degradedCount, totalCount, ratio, hotspots });
    } else if (ratio <= this.degradationThreshold && this.fleetDegradedState) {
      this.fleetDegradedState = false;
      this.emitter.emit('fleetRecovered', { degradedCount, totalCount, ratio });
    }
  }
}
