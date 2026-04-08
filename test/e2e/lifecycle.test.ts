/**
 * Phase B — End-to-end lifecycle tests
 *
 * Full user-journey tests that exercise the system as a coherent whole.
 * @see TEST_STRATEGY.md §3, Phase B
 */

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
  type OTelLoggerProvider,
  type OTelLogger,
  type OTelLogRecord,
} from '../../src/otel.js';
import type { Segment, QualityReport, EvictionRecord } from '../../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────

const TOPICS = [
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

function content(i: number): string {
  return TOPICS[i % TOPICS.length]!;
}

function createMockMeterProvider() {
  const counterValues = new Map<string, number>();
  const gaugeCallbacks: Array<(result: OTelObservableResult) => void> = [];
  const histogramRecords: number[] = [];

  const meter: OTelMeter = {
    createObservableGauge(_name: string, _opts?: OTelMetricOptions): OTelObservableGauge {
      return {
        addCallback(cb: (r: OTelObservableResult) => void) { gaugeCallbacks.push(cb); },
        removeCallback(cb: (r: OTelObservableResult) => void) {
          const idx = gaugeCallbacks.indexOf(cb);
          if (idx >= 0) gaugeCallbacks.splice(idx, 1);
        },
      };
    },
    createCounter(name: string, _opts?: OTelMetricOptions): OTelCounter {
      if (!counterValues.has(name)) counterValues.set(name, 0);
      return { add(v: number, _a?: OTelAttributes) { counterValues.set(name, (counterValues.get(name) ?? 0) + v); } };
    },
    createHistogram(_name: string, _opts?: OTelMetricOptions): OTelHistogram {
      return { record(v: number, _a?: OTelAttributes) { histogramRecords.push(v); } };
    },
  };

  const meterProvider: OTelMeterProvider = { getMeter() { return meter; } };

  function collectGauges(): Map<string, number> {
    const observed = new Map<string, number>();
    for (const cb of gaugeCallbacks) {
      cb({ observe(value: number, attrs?: OTelAttributes) { observed.set(String(attrs?.['context_lens.window'] ?? ''), value); } });
    }
    return observed;
  }

  return { meterProvider, counterValues, histogramRecords, gaugeCallbacks, collectGauges };
}

function createMockLoggerProvider(): { logProvider: OTelLoggerProvider; logs: OTelLogRecord[] } {
  const logs: OTelLogRecord[] = [];
  const logger: OTelLogger = { emit(rec: OTelLogRecord) { logs.push(rec); } };
  const logProvider: OTelLoggerProvider = { getLogger() { return logger; } };
  return { logProvider, logs };
}

// ─── B.1: Complete session lifecycle ────────────────────────────

describe('B.1: Complete session lifecycle', () => {
  it('exercises the full lifecycle: seed, add, task, assess, evict, compact, restore, snapshot, fromSnapshot', async () => {
    // ── Construct
    const lens = new ContextLens({ capacity: 8000 });

    // ── Seed
    const seeds = lens.seed([
      { content: 'You are a helpful assistant that summarizes financial reports clearly and concisely.', id: 'system', protection: 'pinned' },
      { content: 'The user prefers bullet points and short paragraphs in all summaries.', id: 'persona', protection: 'seed' },
      { content: 'Available tools: search_documents, extract_tables, format_chart.', id: 'tools', protection: 'seed' },
    ]);
    expect(seeds).toHaveLength(3);

    // ── Add conversation turns
    const turn1 = lens.add('User: Can you summarize the Q3 revenue report?', { id: 'turn-1' }) as Segment;
    const turn2 = lens.add('Assistant: The Q3 revenue report shows a 12% increase in total revenue compared to Q2, driven primarily by enterprise subscriptions.', { id: 'turn-2' }) as Segment;
    expect(lens.getSegmentCount()).toBe(5);

    // ── Set task
    await lens.setTask({ description: 'Summarize the Q3 revenue report', keywords: ['revenue', 'Q3', 'summary'] });

    // ── First assessment
    const report1 = lens.assess();
    expect(report1.segmentCount).toBe(5);
    expect(report1.task.state).toBe('active');
    expect(report1.windowScores.coherence).not.toBeNull();
    expect(report1.windowScores.density).not.toBeNull();
    expect(report1.windowScores.relevance).not.toBeNull();
    expect(report1.windowScores.continuity).not.toBeNull();

    // ── Add more turns (filling context)
    lens.add('User: What about the breakdown by region?', { id: 'turn-3' });
    lens.add('Assistant: North America contributed 45% of revenue, Europe 30%, and Asia-Pacific 25%. APAC showed the highest growth rate at 18% quarter-over-quarter.', { id: 'turn-4' });
    lens.add('User: Are there any concerning trends in customer churn?', { id: 'turn-5' });

    // ── Second assessment — scores should change
    const report2 = lens.assess();
    expect(report2.segmentCount).toBe(8);
    expect(report2.reportId).not.toBe(report1.reportId);
    expect(report2.capacity.utilization).toBeGreaterThan(report1.capacity.utilization);

    // ── Plan eviction
    const plan = lens.planEviction({ targetTokens: 50 });
    // Pinned and seed segments should not appear as candidates
    for (const candidate of plan.candidates) {
      const seg = lens.getSegment(candidate.id);
      if (seg !== null) {
        expect(seg.protection).not.toBe('pinned');
      }
    }

    // ── Evict top candidate
    if (plan.candidates.length > 0) {
      const topCandidate = plan.candidates[0]!;
      const countBefore = lens.getSegmentCount();
      lens.evict(topCandidate.id);
      expect(lens.getSegmentCount()).toBeLessThan(countBefore);

      // ── Assessment after eviction
      const report3 = lens.assess();
      expect(report3.segmentCount).toBeLessThan(report2.segmentCount);
      // Continuity should reflect the eviction
      expect(report3.continuity.totalEvictions).toBeGreaterThan(0);
    }

    // ── Compact a segment (pick one that is still active)
    const activeSegs = lens.listSegments().filter(s => s.protection === 'default');
    if (activeSegs.length > 0) {
      const target = activeSegs[0]!;
      const tokensBefore = lens.getCapacity().totalActiveTokens;
      lens.compact(target.id, 'Short summary.');
      const report4 = lens.assess();
      expect(report4.capacity.totalActiveTokens).toBeLessThan(tokensBefore);
    }

    // ── Change task
    const transition = await lens.setTask({ description: 'Draft the executive summary for the board presentation' });
    expect(transition.type).toBe('change');

    // ── Assessment with new task
    const report5 = lens.assess();
    expect(report5.task.state).toBe('active');

    // ── Clear task
    lens.clearTask();
    const report6 = lens.assess();
    expect(report6.task.state).toBe('unset');

    // ── Snapshot
    const snap = lens.snapshot();
    expect(snap.restorable).toBe(true);
    expect(snap.segments.length).toBeGreaterThan(0);

    // ── Restore from snapshot
    const restored = ContextLens.fromSnapshot(snap);
    const restoredReport = restored.assess();
    expect(restoredReport.segmentCount).toBe(report6.segmentCount);
    // Composite scores should match (same state, same provider)
    if (report6.composite !== null && restoredReport.composite !== null) {
      expect(restoredReport.composite).toBeCloseTo(report6.composite, 5);
    }

    // ── Diverge the restored instance
    restored.add('User: What about next quarter projections?', { id: 'turn-new' });
    const divergedReport = restored.assess();
    expect(divergedReport.segmentCount).toBe(restoredReport.segmentCount + 1);
  });
});

// ─── B.2: Protection tier enforcement ───────────────────────────

describe('B.2: Protection tier enforcement end-to-end', () => {
  it('enforces protection tier ordering in eviction planning', () => {
    const lens = new ContextLens({ capacity: 100 });

    // Seed with different protection levels
    lens.seed([
      { content: content(0), protection: 'pinned', id: 'pinned-1' },
      { content: content(1), protection: 'seed', id: 'seed-1' },
    ]);

    // Add segments with different protection levels
    lens.add(content(2), { id: 'prio-500', protection: 'priority(500)', importance: 0.5 });
    lens.add(content(3), { id: 'default-1', protection: 'default', importance: 0.3 });
    lens.add(content(4), { id: 'default-2', protection: 'default', importance: 0.2 });
    lens.add(content(5), { id: 'default-3', protection: 'default', importance: 0.1 });

    // Well over capacity — assess should detect saturation
    const report = lens.assess();
    expect(report.capacity.utilization).toBeGreaterThan(1.0);

    // Plan eviction
    const plan = lens.planEviction({ targetTokens: 200 });
    expect(plan.candidateCount).toBeGreaterThan(0);

    // Verify tier ordering: defaults first, then priority, then seed
    // Pinned should NEVER appear
    const candidateProtections: string[] = [];
    for (const c of plan.candidates) {
      const seg = lens.getSegment(c.id);
      if (seg !== null) {
        candidateProtections.push(seg.protection);
        expect(seg.protection).not.toBe('pinned');
      }
    }

    // All defaults should come before any priority or seed
    let seenPriority = false;
    let seenSeed = false;
    for (const prot of candidateProtections) {
      if (prot.startsWith('priority')) seenPriority = true;
      if (prot === 'seed') seenSeed = true;
      if (prot === 'default') {
        expect(seenPriority).toBe(false);
        expect(seenSeed).toBe(false);
      }
    }

    // Execute evictions to get under capacity
    let evicted = 0;
    for (const c of plan.candidates) {
      try {
        lens.evict(c.id);
        evicted++;
      } catch {
        // Skip if protection prevents eviction
      }
      if (lens.getCapacity().utilization <= 1.0) break;
    }
    expect(evicted).toBeGreaterThan(0);

    // After eviction, check that saturation resolved
    const postEvictReport = lens.assess();
    expect(postEvictReport.segmentCount).toBeLessThan(report.segmentCount);

    // Restore one segment
    const evictedSegs = lens.getEvictedSegments();
    if (evictedSegs.length > 0) {
      lens.restore(evictedSegs[0]!.id);
      const postRestoreReport = lens.assess();
      expect(postRestoreReport.continuity.totalRestorations).toBeGreaterThan(0);
    }
  });
});

// ─── B.3: Pattern lifecycle ─────────────────────────────────────

describe('B.3: Pattern lifecycle end-to-end', () => {
  it('tracks pattern activation and resolution through lifecycle', () => {
    // Small capacity to easily trigger saturation
    const lens = new ContextLens({ capacity: 100 });

    const activated: string[] = [];
    const resolved: string[] = [];
    lens.on('patternActivated', (p) => activated.push(p.pattern.name));
    lens.on('patternResolved', (p) => resolved.push(p.name));

    // Fill context well beyond capacity to trigger saturation
    for (let i = 0; i < 6; i++) {
      lens.add(content(i), { id: `sat-${i}` });
    }

    const report1 = lens.assess();
    expect(report1.capacity.utilization).toBeGreaterThan(1.0);

    // Check if saturation was activated
    const saturationActive = report1.patterns.patterns.some(p => p.name === 'saturation');
    if (saturationActive) {
      expect(activated).toContain('saturation');

      // Evict segments to resolve saturation
      lens.evict('sat-0');
      lens.evict('sat-1');
      lens.evict('sat-2');
      lens.evict('sat-3');

      const report2 = lens.assess();
      // Should have resolved if we're under capacity now
      if (report2.capacity.utilization <= 0.75) {
        expect(resolved).toContain('saturation');
      }
    }

    // Add near-identical segments (high redundancy → erosion)
    const baseContent = 'The Q3 financial results show strong growth across all business segments and regions globally';
    lens.add(baseContent + ' with increased revenue', { id: 'dup-1' });
    lens.add(baseContent + ' with higher profits', { id: 'dup-2' });
    lens.add(baseContent + ' with better margins', { id: 'dup-3' });
    lens.add(baseContent + ' with improved outlook', { id: 'dup-4' });

    const report3 = lens.assess();
    // Erosion may or may not activate depending on thresholds
    // But the event history should be consistent
    const diag = lens.getDiagnostics();
    expect(diag.patternSummary).toBeDefined();
    expect(diag.timeline.length).toBeGreaterThan(0);
  });
});

// ─── B.4: Task-driven relevance lifecycle ───────────────────────

describe('B.4: Task-driven relevance lifecycle', () => {
  it('relevance changes with task transitions', async () => {
    const lens = new ContextLens({ capacity: 10000 });

    // Add ML-related content
    lens.add('Neural networks consist of layers of interconnected nodes that process information through weighted connections and activation functions', { id: 'ml-1' });
    lens.add('Backpropagation is the algorithm used to train neural networks by computing gradients of the loss function with respect to network weights', { id: 'ml-2' });
    lens.add('Convolutional neural networks use spatial filters to detect features in images making them ideal for computer vision tasks', { id: 'ml-3' });
    lens.add('Recurrent neural networks maintain hidden state across time steps enabling them to process sequential data like text and speech', { id: 'ml-4' });
    lens.add('Transformer architectures use self-attention mechanisms to process entire sequences in parallel achieving state of the art results in NLP', { id: 'ml-5' });

    // Set a task that aligns with the content
    await lens.setTask({ description: 'Explain neural network architectures and their applications' });
    const reportAligned = lens.assess();
    const relevanceAligned = reportAligned.windowScores.relevance;
    expect(relevanceAligned).not.toBeNull();

    // Change to a completely unrelated task
    const transition = await lens.setTask({ description: 'Write a detailed recipe for homemade pasta with tomato sauce and fresh basil' });
    expect(transition.type).toBe('change');

    const reportMisaligned = lens.assess();
    const relevanceMisaligned = reportMisaligned.windowScores.relevance;
    expect(relevanceMisaligned).not.toBeNull();

    // Relevance should be lower (content doesn't match new task)
    if (relevanceAligned !== null && relevanceMisaligned !== null) {
      expect(relevanceMisaligned).toBeLessThan(relevanceAligned);
    }

    // Add content matching the new task
    lens.add('Start by making the pasta dough with flour eggs and a pinch of salt then knead until smooth', { id: 'cook-1' });
    lens.add('For the sauce simmer crushed tomatoes with garlic olive oil and fresh basil for thirty minutes', { id: 'cook-2' });

    const reportRecovered = lens.assess();
    const relevanceRecovered = reportRecovered.windowScores.relevance;
    // Adding relevant content should improve relevance
    if (relevanceMisaligned !== null && relevanceRecovered !== null) {
      expect(relevanceRecovered).toBeGreaterThan(relevanceMisaligned);
    }

    // Clear task — relevance should become neutral
    lens.clearTask();
    const reportNeutral = lens.assess();
    expect(reportNeutral.task.state).toBe('unset');
  });
});

// ─── B.5: Fleet orchestration ───────────────────────────────────

describe('B.5: Fleet orchestration end-to-end', () => {
  it('aggregates across instances and detects hotspots', () => {
    const fleet = new ContextLensFleet();

    // Create 3 instances with different health states
    const healthy = new ContextLens({ capacity: 10000 });
    healthy.add(content(0), { id: 'h-1' });
    healthy.add(content(1), { id: 'h-2' });

    const saturated = new ContextLens({ capacity: 200 });
    for (let i = 0; i < 6; i++) {
      saturated.add(content(i), { id: `s-${i}` });
    }

    const sparse = new ContextLens({ capacity: 10000 });
    sparse.add('Short note.', { id: 'sp-1' });

    fleet.register(healthy, 'agent-healthy');
    fleet.register(saturated, 'agent-saturated');
    fleet.register(sparse, 'agent-sparse');

    expect(fleet.size).toBe(3);

    // Assess fleet
    const fleetReport = fleet.assessFleet();
    expect(fleetReport.instanceCount).toBe(3);
    expect(fleetReport.assessedCount).toBe(3);
    expect(fleetReport.failedInstances).toBe(0);

    // Aggregate should be computed
    expect(fleetReport.aggregate.coherence.mean).toBeGreaterThanOrEqual(0);
    expect(fleetReport.aggregate.utilization.min).toBeLessThanOrEqual(fleetReport.aggregate.utilization.max);

    // Hotspots should include the saturated instance (if saturation detected)
    const saturatedReport = fleetReport.instances.find(i => i.label === 'agent-saturated');
    expect(saturatedReport).toBeDefined();
    expect(saturatedReport!.status).toBe('ok');
    if (saturatedReport!.report!.patterns.patternCount > 0) {
      expect(fleetReport.hotspots.length).toBeGreaterThan(0);
      const saturatedHotspot = fleetReport.hotspots.find(h => h.label === 'agent-saturated');
      expect(saturatedHotspot).toBeDefined();
    }

    // Ranking should rank all instances
    expect(fleetReport.ranking).toHaveLength(3);
    expect(fleetReport.ranking[0]!.rank).toBe(1);
    expect(fleetReport.ranking[2]!.rank).toBe(3);
    // Composites should be non-decreasing (weakest first)
    for (let i = 1; i < fleetReport.ranking.length; i++) {
      const prev = fleetReport.ranking[i - 1]!.composite ?? -Infinity;
      const curr = fleetReport.ranking[i]!.composite ?? -Infinity;
      expect(curr).toBeGreaterThanOrEqual(prev);
    }

    // Capacity overview
    expect(fleetReport.capacityOverview.totalCapacity).toBe(10000 + 200 + 10000);
    expect(fleetReport.capacityOverview.totalActiveTokens).toBeGreaterThan(0);

    // Fix the saturated instance by evicting
    for (let i = 0; i < 4; i++) {
      try { saturated.evict(`s-${i}`); } catch { /* skip if already gone */ }
    }

    // Fleet events
    const recovered: string[] = [];
    fleet.on('instanceRecovered', (p) => recovered.push(p.label));

    const fleetReport2 = fleet.assessFleet();
    // If saturated instance had patterns before and doesn't now, recovery fires
    if (saturatedReport!.report!.patterns.patternCount > 0) {
      const sat2 = fleetReport2.instances.find(i => i.label === 'agent-saturated');
      if (sat2!.report!.patterns.patternCount === 0) {
        expect(recovered).toContain('agent-saturated');
      }
    }

    // Unregister
    fleet.unregister('agent-sparse');
    expect(fleet.size).toBe(2);
  });
});

// ─── B.6: Serialization across provider change ──────────────────

describe('B.6: Serialization across provider change', () => {
  it('snapshot + restore with different tokenizer produces different scores', () => {
    const lens = new ContextLens({ capacity: 10000 });

    // Populate with content
    lens.add(content(0), { id: 'ser-1' });
    lens.add(content(1), { id: 'ser-2' });
    lens.add(content(2), { id: 'ser-3' });
    lens.add(content(3), { id: 'ser-4' });
    lens.add(content(4), { id: 'ser-5' });

    const originalReport = lens.assess();
    const snap = lens.snapshot();

    // Restore with an exact tokenizer that counts every character as 1 token
    const charTokenizer = { count: (c: string) => c.length };
    const restored = ContextLens.fromSnapshot(snap, {
      tokenizer: charTokenizer,
    });

    // All segments should have been recounted
    const originalSegs = lens.listSegments();
    const restoredSegs = restored.listSegments();
    expect(restoredSegs).toHaveLength(originalSegs.length);

    // Token counts should differ (char counting vs approximate)
    for (let i = 0; i < originalSegs.length; i++) {
      expect(restoredSegs[i]!.tokenCount).not.toBe(originalSegs[i]!.tokenCount);
      // Char tokenizer: 1 token per char
      expect(restoredSegs[i]!.tokenCount).toBe(originalSegs[i]!.content.length);
    }

    // Assess both — capacity utilization should differ
    const restoredReport = restored.assess();
    expect(restoredReport.capacity.totalActiveTokens).not.toBe(originalReport.capacity.totalActiveTokens);

    // Both reports should be schema-valid
    const origValid = validate.qualityReport(toJSON(originalReport));
    expect(origValid.valid).toBe(true);
    const restoredValid = validate.qualityReport(toJSON(restoredReport));
    expect(restoredValid.valid).toBe(true);
  });
});

// ─── B.7: OTel export end-to-end ────────────────────────────────

describe('B.7: OTel export end-to-end', () => {
  it('metrics updated and log events emitted through lifecycle', async () => {
    const lens = new ContextLens({ capacity: 10000 });
    const { meterProvider, counterValues, gaugeCallbacks } = createMockMeterProvider();
    const { logProvider, logs } = createMockLoggerProvider();

    // Attach exporter
    const exporter = new ContextLensExporter(lens, {
      meterProvider,
      label: 'test-window',
      logProvider,
      emitEvents: true,
    });

    // Gauge callbacks should be registered (9 gauges)
    expect(gaugeCallbacks.length).toBe(9);

    // ── Add segments and assess
    lens.add(content(0), { id: 'otel-1' });
    lens.add(content(1), { id: 'otel-2' });
    lens.add(content(2), { id: 'otel-3' });

    lens.assess();

    // assess_count counter should be incremented
    const assessKey = 'context_lens.assess_count';
    expect(counterValues.get(assessKey)).toBe(1);

    // ── Evict a segment — evictions_total incremented
    lens.evict('otel-1');
    const evictKey = 'context_lens.evictions_total';
    expect(counterValues.get(evictKey)).toBe(1);

    // ── Compact a segment — compactions_total incremented
    lens.compact('otel-2', 'short');
    const compactKey = 'context_lens.compactions_total';
    expect(counterValues.get(compactKey)).toBe(1);

    // ── Restore — restorations_total incremented
    lens.restore('otel-1');
    const restoreKey = 'context_lens.restorations_total';
    expect(counterValues.get(restoreKey)).toBe(1);

    // ── Set task (change) — task_changes_total incremented + log emitted
    await lens.setTask({ description: 'Test task for OTel export verification' });
    const taskKey = 'context_lens.task_changes_total';
    // First task is 'new', not 'change', so counter may be 0
    // Let's change it to get a task_changes increment
    await lens.setTask({ description: 'Completely different task about cooking pasta and baking bread' });
    expect(counterValues.get(taskKey)).toBeGreaterThanOrEqual(1);

    // task.changed log should have been emitted
    const taskLogs = logs.filter(l => l.body === 'context_lens.task.changed');
    expect(taskLogs.length).toBeGreaterThanOrEqual(1);

    // ── Trigger pattern and check log
    // Register an always-fire custom pattern
    lens.registerPattern({
      name: 'otel-test-pattern',
      description: 'Fires for OTel test',
      detect: () => ({ primaryScore: { dimension: 'density', value: 0.1 }, secondaryScores: [], utilization: null }),
      severity: () => 'warning',
      explanation: () => 'OTel test pattern',
      remediation: () => [],
    });

    lens.assess();

    // pattern.activated log should fire
    const patternLogs = logs.filter(l => l.body === 'context_lens.pattern.activated');
    expect(patternLogs.length).toBeGreaterThanOrEqual(1);
    const patternLog = patternLogs.find(l => l.attributes?.['pattern.name'] === 'otel-test-pattern');
    expect(patternLog).toBeDefined();
    expect(patternLog!.severityText).toBe('WARN');

    // pattern_activations_total counter
    const patternActKey = 'context_lens.pattern_activations_total';
    expect(counterValues.get(patternActKey)).toBeGreaterThanOrEqual(1);

    // assess_count should have incremented again
    expect(counterValues.get(assessKey)).toBeGreaterThanOrEqual(2);

    // ── Common attributes in logs
    for (const log of logs) {
      if (log.attributes) {
        expect(log.attributes['context_lens.window']).toBe('test-window');
        expect(log.attributes['context_lens.tokenizer']).toBeTruthy();
        expect(log.attributes['context_lens.embedding_mode']).toBe('trigrams');
      }
    }

    // ── Disconnect exporter
    exporter.disconnect();

    const assessCountBefore = counterValues.get(assessKey)!;
    lens.assess();
    // After disconnect, no new metrics should be recorded
    expect(counterValues.get(assessKey)).toBe(assessCountBefore);
  });
});
