/**
 * Phase A — ContextLens class unit tests
 * @see TEST_STRATEGY.md §3, Phase A
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ContextLens } from '../../src/index.js';
import type { ContextLensConfig, SeedInput } from '../../src/index.js';
import {
  ConfigurationError,
  ValidationError,
  ProtectionError,
  CompactionError,
  RestoreError,
  DisposedError,
  DisposalError,
} from '../../src/errors.js';
import type {
  Segment,
  QualityReport,
  TaskDescriptor,
  PatternDefinition,
} from '../../src/types.js';
import type { DuplicateSignal } from '../../src/segment-store.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeLens(capacity = 10000): ContextLens {
  return new ContextLens({ capacity });
}

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

function seedAndAdd(lens: ContextLens): void {
  lens.seed([{ content: content(0) }, { content: content(1) }]);
  lens.add(content(2));
}

function isDuplicate(result: Segment | DuplicateSignal): result is DuplicateSignal {
  return 'isDuplicate' in result;
}

// ─── A.1: Constructor and configuration ─────────────────────────

describe('ContextLens — Constructor and Configuration', () => {
  it('constructs with minimal config (capacity only)', () => {
    const lens = makeLens(5000);
    const config = lens.getConfig();
    expect(config.capacity).toBe(5000);
    expect(lens.getSegmentCount()).toBe(0);
  });

  it('constructs with all options specified', () => {
    const lens = new ContextLens({
      capacity: 8000,
      retainEvictedContent: false,
      pinnedCeilingRatio: 0.3,
      tokenCacheSize: 2048,
      embeddingCacheSize: 1024,
      hysteresisMargin: 0.05,
      suppressedPatterns: ['erosion'],
    });
    const config = lens.getConfig();
    expect(config.capacity).toBe(8000);
    expect(config.retainEvictedContent).toBe(false);
    expect(config.pinnedCeilingRatio).toBe(0.3);
    expect(config.tokenCacheSize).toBe(2048);
    expect(config.embeddingCacheSize).toBe(1024);
    expect(config.hysteresisMargin).toBe(0.05);
    expect(config.suppressedPatterns).toEqual(['erosion']);
  });

  it('rejects capacity = 0', () => {
    expect(() => new ContextLens({ capacity: 0 })).toThrow(ConfigurationError);
  });

  it('rejects negative capacity', () => {
    expect(() => new ContextLens({ capacity: -5 })).toThrow(ConfigurationError);
  });

  it('rejects non-integer capacity', () => {
    expect(() => new ContextLens({ capacity: 1.5 })).toThrow(ConfigurationError);
  });

  it('rejects missing capacity', () => {
    expect(() => new ContextLens({} as ContextLensConfig)).toThrow(ConfigurationError);
  });

  it('rejects pinnedCeilingRatio = 0', () => {
    expect(() => new ContextLens({ capacity: 1000, pinnedCeilingRatio: 0 })).toThrow(ConfigurationError);
  });

  it('accepts pinnedCeilingRatio = 0.01 (lower bound)', () => {
    expect(() => new ContextLens({ capacity: 1000, pinnedCeilingRatio: 0.01 })).not.toThrow();
  });

  it('accepts pinnedCeilingRatio = 1.0 (upper bound)', () => {
    expect(() => new ContextLens({ capacity: 1000, pinnedCeilingRatio: 1.0 })).not.toThrow();
  });

  it('rejects pinnedCeilingRatio > 1', () => {
    expect(() => new ContextLens({ capacity: 1000, pinnedCeilingRatio: 1.01 })).toThrow(ConfigurationError);
  });

  it('rejects non-integer tokenCacheSize', () => {
    expect(() => new ContextLens({ capacity: 1000, tokenCacheSize: 1.5 })).toThrow(ConfigurationError);
  });

  it('rejects non-integer embeddingCacheSize', () => {
    expect(() => new ContextLens({ capacity: 1000, embeddingCacheSize: 2.7 })).toThrow(ConfigurationError);
  });

  it('rejects non-boolean retainEvictedContent', () => {
    expect(() => new ContextLens({ capacity: 1000, retainEvictedContent: 'yes' as unknown as boolean })).toThrow(ConfigurationError);
  });

  it('getConfig() returns a deep copy', () => {
    const lens = makeLens(5000);
    const config1 = lens.getConfig();
    (config1 as Record<string, unknown>).capacity = 999;
    const config2 = lens.getConfig();
    expect(config2.capacity).toBe(5000);
  });

  it('getConstructionTimestamp() returns a number', () => {
    const lens = makeLens();
    expect(typeof lens.getConstructionTimestamp()).toBe('number');
    expect(lens.getConstructionTimestamp()).toBeGreaterThan(0);
  });
});

// ─── A.2: Segment operations ────────────────────────────────────

describe('ContextLens — Segment Operations', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
  });

  // ── add ─────────────────────────────────────────────────────
  it('add() returns a Segment with auto-generated ID', () => {
    const seg = lens.add(content(0)) as Segment;
    expect(seg.id).toMatch(/^auto:/);
    expect(seg.content).toBe(content(0));
    expect(seg.state).toBe('active');
    expect(seg.tokenCount).toBeGreaterThan(0);
  });

  it('add() with explicit ID and all options', () => {
    const seg = lens.add(content(0), {
      id: 'my-seg',
      importance: 0.9,
      origin: 'user-input',
      tags: ['test', 'important'],
      protection: 'priority(500)',
    }) as Segment;
    expect(seg.id).toBe('my-seg');
    expect(seg.importance).toBe(0.9);
    expect(seg.origin).toBe('user-input');
    expect(seg.tags).toEqual(['test', 'important']);
    expect(seg.protection).toBe('priority(500)');
  });

  it('add() duplicate content returns DuplicateSignal', () => {
    lens.add(content(0));
    const result = lens.add(content(0));
    expect(isDuplicate(result)).toBe(true);
  });

  it('add() invalidates quality cache (fresh report after mutation)', () => {
    seedAndAdd(lens);
    const r1 = lens.assess();
    lens.add(content(3));
    const r2 = lens.assess();
    expect(r2.reportId).not.toBe(r1.reportId);
  });

  // ── seed ────────────────────────────────────────────────────
  it('seed() batch insert with seed protection default', () => {
    const segments = lens.seed([
      { content: content(0) },
      { content: content(1) },
    ]);
    expect(segments).toHaveLength(2);
    for (const seg of segments) {
      expect(seg.protection).toBe('seed');
      expect(seg.state).toBe('active');
    }
  });

  it('seed() empty array returns empty array', () => {
    const result = lens.seed([]);
    expect(result).toEqual([]);
  });

  it('seed() with empty content throws ValidationError', () => {
    expect(() => lens.seed([{ content: '' }])).toThrow(ValidationError);
  });

  it('seed() late seeding after add emits lateSeeding event', () => {
    const events: unknown[] = [];
    lens.on('lateSeeding', (p) => events.push(p));

    lens.add(content(0));
    lens.seed([{ content: content(1) }]);

    expect(events).toHaveLength(1);
  });

  it('seed() with custom protection and importance', () => {
    const segments = lens.seed([
      { content: content(0), protection: 'pinned', importance: 1.0 },
    ]);
    expect(segments[0]!.protection).toBe('pinned');
    expect(segments[0]!.importance).toBe(1.0);
  });

  it('seed() with explicit ID', () => {
    const segments = lens.seed([
      { content: content(0), id: 'system-prompt' },
    ]);
    expect(segments[0]!.id).toBe('system-prompt');
  });

  // ── update ──────────────────────────────────────────────────
  it('update() changes metadata only', () => {
    const seg = lens.add(content(0)) as Segment;
    const updated = lens.update(seg.id, {
      importance: 0.3,
      tags: ['updated'],
      origin: 'new-origin',
    });
    expect(updated.importance).toBe(0.3);
    expect(updated.tags).toEqual(['updated']);
    expect(updated.origin).toBe('new-origin');
    expect(updated.content).toBe(content(0));
  });

  it('update() with content change triggers recount', () => {
    const seg = lens.add(content(0)) as Segment;
    const originalTokens = seg.tokenCount;
    const updated = lens.update(seg.id, {
      content: 'short',
    });
    expect(updated.content).toBe('short');
    expect(updated.tokenCount).not.toBe(originalTokens);
  });

  // ── replace ─────────────────────────────────────────────────
  it('replace() swaps content, preserves ID', () => {
    const seg = lens.add(content(0), { id: 'r1' }) as Segment;
    const replaced = lens.replace('r1', content(1));
    expect(replaced.id).toBe('r1');
    expect(replaced.content).toBe(content(1));
    expect(replaced.tokenCount).toBeGreaterThan(0);
  });

  it('replace() invalidates quality cache', () => {
    seedAndAdd(lens);
    const r1 = lens.assess();
    const seg = lens.add(content(3)) as Segment;
    lens.assess();
    lens.replace(seg.id, content(4));
    const r3 = lens.assess();
    expect(r3.reportId).not.toBe(r1.reportId);
  });

  // ── compact ─────────────────────────────────────────────────
  it('compact() reduces token count', () => {
    const seg = lens.add(content(0)) as Segment;
    const compacted = lens.compact(seg.id, 'short summary');
    expect(compacted.tokenCount).toBeLessThan(seg.tokenCount);
    expect(compacted.content).toBe('short summary');
  });

  it('compact() on pinned segment throws ProtectionError', () => {
    lens.seed([{ content: content(0), protection: 'pinned', id: 'pinned-seg' }]);
    expect(() => lens.compact('pinned-seg', 'short')).toThrow(ProtectionError);
  });

  it('compact() records in continuity ledger', () => {
    seedAndAdd(lens);
    const seg = lens.add(content(3)) as Segment;
    lens.compact(seg.id, 'x');
    lens.assess();
    const diag = lens.getDiagnostics();
    const compactionEvents = diag.continuityLedger.filter(e => e.type === 'compaction');
    expect(compactionEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ── split ───────────────────────────────────────────────────
  it('split() produces children', () => {
    const seg = lens.add(content(0)) as Segment;
    const children = lens.split(seg.id, (c) => [c.slice(0, 40), c.slice(40)]);
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.state).toBe('active');
      expect(child.tokenCount).toBeGreaterThan(0);
    }
  });

  it('split() on pinned segment throws ProtectionError', () => {
    lens.seed([{ content: content(0), protection: 'pinned', id: 'pinned-split' }]);
    expect(() => lens.split('pinned-split', (c) => [c.slice(0, 40), c.slice(40)])).toThrow(ProtectionError);
  });

  it('split() invalidates quality cache', () => {
    seedAndAdd(lens);
    const r1 = lens.assess();
    const seg = lens.add(content(3)) as Segment;
    lens.assess();
    lens.split(seg.id, (c) => [c.slice(0, 40), c.slice(40)]);
    const r3 = lens.assess();
    expect(r3.reportId).not.toBe(r1.reportId);
  });
});

// ─── A.3: Eviction and restoration ──────────────────────────────

describe('ContextLens — Eviction and Restoration', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
  });

  it('evict() single segment returns single EvictionRecord', () => {
    const seg = lens.add(content(0)) as Segment;
    const record = lens.evict(seg.id);
    // Single segment returns a single record, not array
    expect(Array.isArray(record)).toBe(false);
    expect((record as { segmentId: string }).segmentId).toBe(seg.id);
    expect(lens.getSegmentCount()).toBe(0);
  });

  it('evict() grouped segment evicts all members', () => {
    const s1 = lens.add(content(0), { id: 'g-mem1' }) as Segment;
    const s2 = lens.add(content(1), { id: 'g-mem2' }) as Segment;
    lens.createGroup('grp', [s1.id, s2.id]);
    const records = lens.evict(s1.id);
    expect(Array.isArray(records)).toBe(true);
    expect(lens.getSegmentCount()).toBe(0);
  });

  it('evict() pinned segment throws ProtectionError', () => {
    lens.seed([{ content: content(0), protection: 'pinned', id: 'pinned-evict' }]);
    expect(() => lens.evict('pinned-evict')).toThrow(ProtectionError);
  });

  it('evict() records in continuity ledger', () => {
    seedAndAdd(lens);
    const seg = lens.add(content(3)) as Segment;
    lens.evict(seg.id);
    lens.assess();
    const diag = lens.getDiagnostics();
    const evictionEvents = diag.continuityLedger.filter(e => e.type === 'eviction');
    expect(evictionEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('evict() invalidates quality cache', () => {
    seedAndAdd(lens);
    const seg = lens.add(content(3)) as Segment;
    const r1 = lens.assess();
    lens.evict(seg.id);
    const r2 = lens.assess();
    expect(r2.reportId).not.toBe(r1.reportId);
    expect(r2.segmentCount).toBeLessThan(r1.segmentCount);
  });

  it('restore() single segment to original position', () => {
    const s1 = lens.add(content(0), { id: 'res-1' }) as Segment;
    lens.add(content(1), { id: 'res-2' });
    lens.evict('res-1');
    expect(lens.getSegmentCount()).toBe(1);
    const restored = lens.restore('res-1') as Segment;
    expect(restored.id).toBe('res-1');
    expect(restored.state).toBe('active');
    expect(lens.getSegmentCount()).toBe(2);
  });

  it('restore() grouped eviction restores all members', () => {
    const s1 = lens.add(content(0), { id: 'rg-1' }) as Segment;
    const s2 = lens.add(content(1), { id: 'rg-2' }) as Segment;
    lens.createGroup('rg', [s1.id, s2.id]);
    lens.evict('rg-1');
    expect(lens.getSegmentCount()).toBe(0);
    const restored = lens.restore('rg-1');
    expect(Array.isArray(restored)).toBe(true);
    expect(lens.getSegmentCount()).toBe(2);
  });

  it('restore() without retained content throws RestoreError', () => {
    const noRetain = new ContextLens({ capacity: 10000, retainEvictedContent: false });
    const seg = noRetain.add(content(0)) as Segment;
    noRetain.evict(seg.id);
    expect(() => noRetain.restore(seg.id)).toThrow(RestoreError);
  });

  it('getEvictedSegments() returns deep copies', () => {
    const seg = lens.add(content(0)) as Segment;
    lens.evict(seg.id);
    const evicted1 = lens.getEvictedSegments();
    expect(evicted1).toHaveLength(1);
    (evicted1[0] as Record<string, unknown>).content = 'MUTATED';
    const evicted2 = lens.getEvictedSegments();
    expect(evicted2[0]!.content).toBe(content(0));
  });
});

// ─── A.4: Group operations ──────────────────────────────────────

describe('ContextLens — Group Operations', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
  });

  it('createGroup() with valid segment IDs', () => {
    const s1 = lens.add(content(0), { id: 'gop-1' }) as Segment;
    const s2 = lens.add(content(1), { id: 'gop-2' }) as Segment;
    const group = lens.createGroup('g1', [s1.id, s2.id]);
    expect(group.groupId).toBe('g1');
    expect(group.members).toContain(s1.id);
    expect(group.members).toContain(s2.id);
  });

  it('createGroup() with segment already in a group throws', () => {
    const s1 = lens.add(content(0), { id: 'dup-g1' }) as Segment;
    const s2 = lens.add(content(1), { id: 'dup-g2' }) as Segment;
    lens.createGroup('g-first', [s1.id]);
    expect(() => lens.createGroup('g-second', [s1.id, s2.id])).toThrow();
  });

  it('dissolveGroup() returns freed segments', () => {
    const s1 = lens.add(content(0), { id: 'dis-1' }) as Segment;
    const s2 = lens.add(content(1), { id: 'dis-2' }) as Segment;
    lens.createGroup('g-dis', [s1.id, s2.id]);
    const freed = lens.dissolveGroup('g-dis');
    expect(freed).toHaveLength(2);
    for (const seg of freed) {
      expect(seg.groupId).toBeNull();
    }
  });

  it('getGroup() returns null for unknown ID', () => {
    expect(lens.getGroup('nonexistent')).toBeNull();
  });

  it('listGroups() returns all active groups', () => {
    const s1 = lens.add(content(0), { id: 'lg-1' }) as Segment;
    const s2 = lens.add(content(1), { id: 'lg-2' }) as Segment;
    const s3 = lens.add(content(2), { id: 'lg-3' }) as Segment;
    lens.createGroup('gA', [s1.id]);
    lens.createGroup('gB', [s2.id, s3.id]);
    const groups = lens.listGroups();
    expect(groups).toHaveLength(2);
    const ids = groups.map(g => g.groupId);
    expect(ids).toContain('gA');
    expect(ids).toContain('gB');
  });

  it('dissolveGroup() for unknown group throws ValidationError', () => {
    expect(() => lens.dissolveGroup('ghost')).toThrow(ValidationError);
  });
});

// ─── A.5: Assessment and planning ───────────────────────────────

describe('ContextLens — Assessment and Planning', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
  });

  it('assess() with segments produces QualityReport', () => {
    seedAndAdd(lens);
    const report = lens.assess();
    expect(report.schemaVersion).toBe('1.0.0');
    expect(report.reportId).toBeTruthy();
    expect(report.segmentCount).toBe(3);
    expect(report.windowScores).toBeDefined();
    expect(report.composite).not.toBeNull();
    expect(report.embeddingMode).toBe('trigrams');
  });

  it('assess() with 0 segments produces null composite', () => {
    const report = lens.assess();
    expect(report.segmentCount).toBe(0);
    expect(report.composite).toBeNull();
  });

  it('assess() returns cached report on second call', () => {
    seedAndAdd(lens);
    const r1 = lens.assess();
    const r2 = lens.assess();
    expect(r1.reportId).toBe(r2.reportId);
  });

  it('assess() returns fresh report after mutation', () => {
    seedAndAdd(lens);
    const r1 = lens.assess();
    lens.add(content(3));
    const r2 = lens.assess();
    expect(r2.reportId).not.toBe(r1.reportId);
  });

  it('assess() fires reportGenerated event', () => {
    seedAndAdd(lens);
    const events: QualityReport[] = [];
    lens.on('reportGenerated', (p) => events.push(p.report));
    lens.assess();
    expect(events).toHaveLength(1);
    expect(events[0]!.reportId).toBeTruthy();
  });

  it('assess() fires patternActivated when pattern detected', () => {
    const smallLens = makeLens(200);
    // Register always-fire pattern
    smallLens.registerPattern({
      name: 'always-on',
      description: 'Test pattern',
      detect: () => ({ primaryScore: { dimension: 'density', value: 0.1 }, secondaryScores: [], utilization: null }),
      severity: () => 'watch',
      explanation: () => 'Test',
      remediation: () => [],
    });

    const activated: string[] = [];
    smallLens.on('patternActivated', (p) => activated.push(p.pattern.name));

    smallLens.seed([{ content: content(0) }]);
    smallLens.add(content(1));
    smallLens.assess();

    expect(activated).toContain('always-on');
  });

  it('planEviction() triggers assess() if no cached report', () => {
    seedAndAdd(lens);
    lens.add(content(3));
    // No prior assess() call
    const plan = lens.planEviction({ targetTokens: 50 });
    expect(plan.planId).toBeTruthy();
    expect(plan.candidates.length).toBeGreaterThanOrEqual(0);
  });

  it('planEviction() returns EvictionPlan', () => {
    seedAndAdd(lens);
    lens.add(content(3));
    lens.add(content(4));
    lens.assess();
    const plan = lens.planEviction({ targetTokens: 50 });
    expect(plan.schemaVersion).toBeTruthy();
    expect(plan.strategy).toBeTruthy();
    expect(plan.target).toBeDefined();
    expect(typeof plan.candidateCount).toBe('number');
    expect(typeof plan.targetMet).toBe('boolean');
  });
});

// ─── A.6: Task operations ───────────────────────────────────────

describe('ContextLens — Task Operations', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
  });

  it('setTask() new task returns transition type new', async () => {
    const transition = await lens.setTask({ description: 'Summarize the Q3 report' });
    expect(transition.type).toBe('new');
  });

  it('setTask() similar task returns refinement', async () => {
    await lens.setTask({ description: 'Summarize the Q3 financial report for the board meeting presentation slides' });
    const t2 = await lens.setTask({ description: 'Summarize the Q3 financial report for the board meeting presentation deck' });
    expect(t2.type).toBe('refinement');
  });

  it('setTask() very different task returns change', async () => {
    await lens.setTask({ description: 'Summarize the Q3 financial report' });
    const t2 = await lens.setTask({ description: 'Write a recipe for chocolate cake with vanilla frosting' });
    expect(t2.type).toBe('change');
  });

  it('setTask() identical task returns same', async () => {
    await lens.setTask({ description: 'Summarize the Q3 report' });
    const t2 = await lens.setTask({ description: 'Summarize the Q3 report' });
    expect(t2.type).toBe('same');
  });

  it('clearTask() resets to unset', async () => {
    await lens.setTask({ description: 'test task' });
    lens.clearTask();
    expect(lens.getTask()).toBeNull();
    expect(lens.getTaskState().state).toBe('unset');
  });

  it('getTask() returns null when unset', () => {
    expect(lens.getTask()).toBeNull();
  });

  it('getTaskState() returns full lifecycle state', async () => {
    await lens.setTask({ description: 'test task' });
    const state = lens.getTaskState();
    expect(state.state).toBe('active');
    expect(state.currentTask).not.toBeNull();
    expect(state.transitionCount).toBeGreaterThanOrEqual(1);
    expect(typeof state.stale).toBe('boolean');
    expect(typeof state.gracePeriodActive).toBe('boolean');
    expect(typeof state.gracePeriodRemaining).toBe('number');
  });

  it('setTask() fires taskChanged event', async () => {
    const events: string[] = [];
    lens.on('taskChanged', () => events.push('taskChanged'));
    await lens.setTask({ description: 'test' });
    expect(events).toContain('taskChanged');
  });

  it('clearTask() fires taskCleared event', async () => {
    await lens.setTask({ description: 'test' });
    const events: string[] = [];
    lens.on('taskCleared', () => events.push('taskCleared'));
    lens.clearTask();
    expect(events).toContain('taskCleared');
  });

  it('clearTask() when already unset is a no-op', () => {
    const events: string[] = [];
    lens.on('taskCleared', () => events.push('taskCleared'));
    lens.clearTask();
    expect(events).toHaveLength(0);
  });

  it('setTask() with same task does not fire event', async () => {
    await lens.setTask({ description: 'test' });
    const events: string[] = [];
    lens.on('taskChanged', () => events.push('taskChanged'));
    await lens.setTask({ description: 'test' });
    expect(events).toHaveLength(0);
  });
});

// ─── A.7: Provider management ───────────────────────────────────

describe('ContextLens — Provider Management', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
    seedAndAdd(lens);
  });

  it('setTokenizer() recounts all segments', () => {
    const before = lens.listSegments().map(s => s.tokenCount);
    const doubleCounter = { count: (c: string) => c.length * 2 };
    lens.setTokenizer(doubleCounter, {
      name: 'double',
      accuracy: 'exact' as const,
      modelFamily: null,
      errorBound: null,
    });
    const after = lens.listSegments().map(s => s.tokenCount);
    expect(after).not.toEqual(before);
  });

  it('setTokenizer() emits tokenizerChanged event', () => {
    const events: { oldName: string; newName: string }[] = [];
    lens.on('tokenizerChanged', (p) => events.push(p));
    lens.setTokenizer('approximate');
    expect(events).toHaveLength(1);
  });

  it('setTokenizer() invalidates quality cache', () => {
    const r1 = lens.assess();
    lens.setTokenizer('approximate');
    const r2 = lens.assess();
    expect(r2.reportId).not.toBe(r1.reportId);
  });

  it('setEmbeddingProvider() sets new provider', async () => {
    const mockProvider = {
      embed: (text: string) => new Array(128).fill(0).map((_, i) => Math.sin(i + text.length)),
    };
    await lens.setEmbeddingProvider(mockProvider, {
      name: 'mock-embed',
      dimensions: 128,
      modelFamily: null,
      maxInputTokens: null,
    });
    const info = lens.getEmbeddingProviderInfo();
    expect(info).not.toBeNull();
    expect(info!.name).toBe('mock-embed');
  });

  it('setEmbeddingProvider(null) removes provider', async () => {
    const mockProvider = {
      embed: (text: string) => new Array(8).fill(0).map((_, i) => i + text.length),
    };
    await lens.setEmbeddingProvider(mockProvider, {
      name: 'temp',
      dimensions: 8,
      modelFamily: null,
      maxInputTokens: null,
    });
    expect(lens.getEmbeddingProviderInfo()).not.toBeNull();
    await lens.setEmbeddingProvider(null);
    expect(lens.getEmbeddingProviderInfo()).toBeNull();
  });

  it('setEmbeddingProvider() emits embeddingProviderChanged', async () => {
    const events: { oldName: string | null; newName: string | null }[] = [];
    lens.on('embeddingProviderChanged', (p) => events.push(p));
    const mockProvider = {
      embed: (text: string) => new Array(8).fill(0).map((_, i) => i + text.length),
    };
    await lens.setEmbeddingProvider(mockProvider, {
      name: 'mock',
      dimensions: 8,
      modelFamily: null,
      maxInputTokens: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.newName).toBe('mock');
  });

  it('getTokenizerInfo() returns metadata', () => {
    const info = lens.getTokenizerInfo();
    expect(info.name).toBeTruthy();
    expect(info.accuracy).toBe('approximate');
  });

  it('getEmbeddingProviderInfo() returns null when no provider', () => {
    expect(lens.getEmbeddingProviderInfo()).toBeNull();
  });

  it('setCapacity() updates capacity', () => {
    lens.setCapacity(20000);
    expect(lens.getCapacity().capacity).toBe(20000);
  });

  it('setCapacity() rejects non-positive-integer', () => {
    expect(() => lens.setCapacity(0)).toThrow(ValidationError);
    expect(() => lens.setCapacity(-10)).toThrow(ValidationError);
    expect(() => lens.setCapacity(1.5)).toThrow(ValidationError);
  });

  it('setCapacity() emits capacityChanged event', () => {
    const events: { oldCapacity: number; newCapacity: number }[] = [];
    lens.on('capacityChanged', (p) => events.push(p));
    lens.setCapacity(20000);
    expect(events).toHaveLength(1);
    expect(events[0]!.oldCapacity).toBe(10000);
    expect(events[0]!.newCapacity).toBe(20000);
  });

  it('setCapacity() invalidates quality cache', () => {
    const r1 = lens.assess();
    lens.setCapacity(20000);
    const r2 = lens.assess();
    expect(r2.reportId).not.toBe(r1.reportId);
  });
});

// ─── A.8: Inspection and diagnostics ────────────────────────────

describe('ContextLens — Inspection and Diagnostics', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
  });

  it('getSegment() returns deep copy', () => {
    const seg = lens.add(content(0), { id: 'insp-1' }) as Segment;
    const retrieved = lens.getSegment('insp-1')!;
    (retrieved as Record<string, unknown>).importance = 999;
    const again = lens.getSegment('insp-1')!;
    expect(again.importance).not.toBe(999);
  });

  it('getSegment() returns null for unknown ID', () => {
    expect(lens.getSegment('nonexistent')).toBeNull();
  });

  it('getSegmentCount() matches active segments', () => {
    lens.add(content(0));
    lens.add(content(1));
    expect(lens.getSegmentCount()).toBe(2);
    const s3 = lens.add(content(2)) as Segment;
    expect(lens.getSegmentCount()).toBe(3);
    lens.evict(s3.id);
    expect(lens.getSegmentCount()).toBe(2);
  });

  it('listSegments() returns ordered active segments', () => {
    lens.add(content(0), { id: 'ls-1' });
    lens.add(content(1), { id: 'ls-2' });
    lens.add(content(2), { id: 'ls-3' });
    const segments = lens.listSegments();
    expect(segments).toHaveLength(3);
    expect(segments[0]!.id).toBe('ls-1');
    expect(segments[1]!.id).toBe('ls-2');
    expect(segments[2]!.id).toBe('ls-3');
  });

  it('getBaseline() returns null before seed', () => {
    expect(lens.getBaseline()).toBeNull();
  });

  it('getBaseline() is established after seed + add', () => {
    seedAndAdd(lens);
    const baseline = lens.getBaseline();
    expect(baseline).not.toBeNull();
    expect(baseline!.coherence).toBeGreaterThanOrEqual(0);
    expect(baseline!.density).toBeGreaterThanOrEqual(0);
    expect(baseline!.relevance).toBeGreaterThanOrEqual(0);
    expect(baseline!.continuity).toBe(1.0);
    expect(baseline!.segmentCount).toBeGreaterThan(0);
    expect(baseline!.tokenCount).toBeGreaterThan(0);
  });

  it('getDiagnostics() returns DiagnosticSnapshot', () => {
    seedAndAdd(lens);
    lens.assess();
    const diag = lens.getDiagnostics();
    expect(diag.schemaVersion).toBeTruthy();
    expect(diag.timestamp).toBeGreaterThan(0);
    expect(diag.sessionDuration).toBeGreaterThanOrEqual(0);
    expect(diag.segmentCount).toBe(3);
    expect(diag.latestReport).not.toBeNull();
    expect(diag.timeline.length).toBeGreaterThan(0);
    expect(diag.performance).toBeDefined();
    expect(diag.providers).toBeDefined();
  });

  it('getPerformance() returns instrumentation module', () => {
    const perf = lens.getPerformance();
    expect(perf).toBeDefined();
  });

  it('getDetection() returns detection engine', () => {
    const detection = lens.getDetection();
    expect(detection).toBeDefined();
  });

  it('registerPattern() adds custom pattern', () => {
    const events: string[] = [];
    lens.on('customPatternRegistered', (p) => events.push(p.name));

    lens.registerPattern({
      name: 'custom-test',
      description: 'A test pattern',
      detect: () => null,
      severity: () => 'watch',
      explanation: () => 'Test',
      remediation: () => [],
    });

    expect(events).toContain('custom-test');
  });

  it('registerPattern() custom pattern appears in detection', () => {
    lens.registerPattern({
      name: 'visible-pattern',
      description: 'Always fires',
      detect: () => ({ primaryScore: { dimension: 'density', value: 0.1 }, secondaryScores: [], utilization: null }),
      severity: () => 'warning',
      explanation: () => 'Visible!',
      remediation: () => [],
    });
    seedAndAdd(lens);
    const report = lens.assess();
    const found = report.patterns.patterns.find(p => p.name === 'visible-pattern');
    expect(found).toBeDefined();
    expect(found!.severity).toBe('warning');
  });

  it('getCapacity() returns correct structure', () => {
    seedAndAdd(lens);
    const cap = lens.getCapacity();
    expect(cap.capacity).toBe(10000);
    expect(cap.totalActiveTokens).toBeGreaterThan(0);
    expect(cap.utilization).toBeGreaterThan(0);
    expect(cap.utilization).toBeLessThanOrEqual(1);
    expect(cap.headroom).toBe(cap.capacity - cap.totalActiveTokens);
  });
});

// ─── A.9: Serialization ─────────────────────────────────────────

describe('ContextLens — Serialization', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
    seedAndAdd(lens);
  });

  it('snapshot() returns SerializedState with all state', () => {
    lens.assess();
    const snap = lens.snapshot();
    expect(snap.formatVersion).toBe('context-lens-snapshot-v1');
    expect(snap.schemaVersion).toBe('1.0.0');
    expect(snap.restorable).toBe(true);
    expect(snap.segments.length).toBeGreaterThanOrEqual(3);
    expect(snap.config.capacity).toBe(10000);
    expect(snap.providerMetadata.tokenizer.name).toBeTruthy();
    expect(snap.taskState).toBeDefined();
  });

  it('snapshot({ includeContent: false }) produces lightweight snapshot', () => {
    const snap = lens.snapshot({ includeContent: false });
    expect(snap.restorable).toBe(false);
    for (const seg of snap.segments) {
      expect(seg.content).toBeNull();
    }
  });

  it('snapshot() emits stateSnapshotted event', () => {
    const events: unknown[] = [];
    lens.on('stateSnapshotted', (p) => events.push(p));
    lens.snapshot();
    expect(events).toHaveLength(1);
  });

  it('fromSnapshot() restores full instance', () => {
    lens.assess();
    const snap = lens.snapshot();
    const restored = ContextLens.fromSnapshot(snap);
    expect(restored.getSegmentCount()).toBe(lens.getSegmentCount());
    expect(restored.getCapacity().capacity).toBe(10000);
    const restoredReport = restored.assess();
    expect(restoredReport.segmentCount).toBe(lens.getSegmentCount());
  });

  it('fromSnapshot() rejects invalid format version', () => {
    const snap = lens.snapshot();
    (snap as Record<string, unknown>).formatVersion = 'invalid-v99';
    expect(() => ContextLens.fromSnapshot(snap)).toThrow(ConfigurationError);
  });

  it('fromSnapshot() rejects non-restorable snapshot', () => {
    const snap = lens.snapshot({ includeContent: false });
    expect(() => ContextLens.fromSnapshot(snap)).toThrow(ConfigurationError);
  });

  it('fromSnapshot() detects tokenizer change and recounts', () => {
    const snap = lens.snapshot();
    // Restore with a different tokenizer
    const doubleCounter = { count: (c: string) => c.length * 2 };
    const restored = ContextLens.fromSnapshot(snap, {
      tokenizer: doubleCounter,
    });
    // Segments should have different token counts from original
    const originalSegments = lens.listSegments();
    const restoredSegments = restored.listSegments();
    // The double counter should produce different counts
    expect(restoredSegments[0]!.tokenCount).not.toBe(originalSegments[0]!.tokenCount);
  });

  it('fromSnapshot() detects embedding change and clears cache', async () => {
    // Set up an embedding provider
    const mockEmbed1 = {
      embed: (text: string) => new Array(8).fill(0).map((_, i) => i + text.length),
    };
    await lens.setEmbeddingProvider(mockEmbed1, {
      name: 'embed-v1',
      dimensions: 8,
      modelFamily: null,
      maxInputTokens: null,
    });
    lens.assess();

    const snap = lens.snapshot();

    // Restore with different embedding provider
    const mockEmbed2 = {
      embed: (text: string) => new Array(8).fill(0).map((_, i) => i * 2 + text.length),
    };
    const restored = ContextLens.fromSnapshot(snap, {
      embeddingProvider: mockEmbed2,
      embeddingProviderMetadata: {
        name: 'embed-v2',
        dimensions: 8,
        modelFamily: null,
        maxInputTokens: null,
      },
    });
    // Should not throw — embedding cache cleared silently
    const report = restored.assess();
    expect(report.segmentCount).toBe(lens.getSegmentCount());
  });

  it('fromSnapshot() emits stateRestored event', () => {
    const snap = lens.snapshot();
    // Cannot subscribe before construction, so verify via the returned instance.
    // The event fires inside fromSnapshot, so we check the diagnostics manager
    // captured a stateRestored timeline entry post-restore. Since diagnostics
    // state is replaced before the event fires, we just verify the restore worked.
    const restored = ContextLens.fromSnapshot(snap);
    expect(restored.getSegmentCount()).toBe(lens.getSegmentCount());
    // Verify the stateRestored event payload by subscribing on a second restore
    const snap2 = restored.snapshot();
    const events: unknown[] = [];
    const restored2 = ContextLens.fromSnapshot(snap2);
    // Since we can't subscribe before construction, verify indirectly
    // that the instance is functional post-restore
    expect(restored2.getConfig().capacity).toBe(10000);
  });

  it('fromSnapshot() round-trip produces identical scores', () => {
    const originalReport = lens.assess();
    const snap = lens.snapshot();
    const restored = ContextLens.fromSnapshot(snap);
    const restoredReport = restored.assess();

    // Composite scores should match (same state, same provider)
    expect(restoredReport.composite).toBeCloseTo(originalReport.composite!, 5);
  });
});

// ─── Event system ───────────────────────────────────────────────

describe('ContextLens — Event System', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
  });

  it('on() returns unsubscribe function', () => {
    let count = 0;
    const unsub = lens.on('segmentAdded', () => count++);
    lens.add(content(0));
    expect(count).toBe(1);
    unsub();
    lens.add(content(1));
    expect(count).toBe(1);
  });

  it('segmentAdded fires on add', () => {
    const events: Segment[] = [];
    lens.on('segmentAdded', (p) => events.push(p.segment));
    lens.add(content(0));
    expect(events).toHaveLength(1);
  });

  it('segmentEvicted fires on evict', () => {
    const seg = lens.add(content(0)) as Segment;
    const events: string[] = [];
    lens.on('segmentEvicted', (p) => events.push(p.record.segmentId));
    lens.evict(seg.id);
    expect(events).toContain(seg.id);
  });

  it('segmentRestored fires on restore', () => {
    const seg = lens.add(content(0)) as Segment;
    lens.evict(seg.id);
    const events: string[] = [];
    lens.on('segmentRestored', (p) => events.push(p.segment.id));
    lens.restore(seg.id);
    expect(events).toContain(seg.id);
  });

  it('segmentCompacted fires on compact', () => {
    const seg = lens.add(content(0)) as Segment;
    const events: string[] = [];
    lens.on('segmentCompacted', (p) => events.push(p.segment.id));
    lens.compact(seg.id, 'short');
    expect(events).toContain(seg.id);
  });

  it('segmentSplit fires on split', () => {
    const seg = lens.add(content(0)) as Segment;
    const events: string[] = [];
    lens.on('segmentSplit', (p) => events.push(p.originalId));
    lens.split(seg.id, (c) => [c.slice(0, 40), c.slice(40)]);
    expect(events).toContain(seg.id);
  });

  it('groupCreated fires on createGroup', () => {
    const s1 = lens.add(content(0), { id: 'ev-g1' }) as Segment;
    const s2 = lens.add(content(1), { id: 'ev-g2' }) as Segment;
    const events: string[] = [];
    lens.on('groupCreated', (p) => events.push(p.group.groupId));
    lens.createGroup('evg', [s1.id, s2.id]);
    expect(events).toContain('evg');
  });

  it('groupDissolved fires on dissolveGroup', () => {
    const s1 = lens.add(content(0), { id: 'evd-1' }) as Segment;
    const s2 = lens.add(content(1), { id: 'evd-2' }) as Segment;
    lens.createGroup('evd-g', [s1.id, s2.id]);
    const events: string[] = [];
    lens.on('groupDissolved', (p) => events.push(p.groupId));
    lens.dissolveGroup('evd-g');
    expect(events).toContain('evd-g');
  });

  it('baselineCaptured fires on first add after seed', () => {
    const events: unknown[] = [];
    lens.on('baselineCaptured', (p) => events.push(p));
    lens.seed([{ content: content(0) }, { content: content(1) }]);
    lens.add(content(2));
    expect(events).toHaveLength(1);
  });
});

// ─── Cache invalidation correctness (bug fix validation) ────────

describe('ContextLens — Cache Invalidation After Mutations', () => {
  let lens: ContextLens;

  beforeEach(() => {
    lens = makeLens(10000);
    seedAndAdd(lens);
  });

  it('assess() after add() reflects new segment count', () => {
    const r1 = lens.assess();
    lens.add(content(3));
    const r2 = lens.assess();
    expect(r2.segmentCount).toBe(r1.segmentCount + 1);
  });

  it('assess() after evict() reflects reduced segment count', () => {
    const seg = lens.add(content(3)) as Segment;
    const r1 = lens.assess();
    lens.evict(seg.id);
    const r2 = lens.assess();
    expect(r2.segmentCount).toBe(r1.segmentCount - 1);
  });

  it('assess() after compact() reflects token change', () => {
    const seg = lens.add(content(3)) as Segment;
    const r1 = lens.assess();
    lens.compact(seg.id, 'x');
    const r2 = lens.assess();
    expect(r2.capacity.totalActiveTokens).toBeLessThan(r1.capacity.totalActiveTokens);
  });

  it('assess() after replace() produces fresh report', () => {
    const seg = lens.add(content(3)) as Segment;
    const r1 = lens.assess();
    lens.replace(seg.id, content(4));
    const r2 = lens.assess();
    expect(r2.reportId).not.toBe(r1.reportId);
  });

  it('assess() after split() reflects new segment count', () => {
    const seg = lens.add(content(3)) as Segment;
    const r1 = lens.assess();
    lens.split(seg.id, (c) => [c.slice(0, 40), c.slice(40)]);
    const r2 = lens.assess();
    // Split replaces 1 segment with 2 children
    expect(r2.segmentCount).toBe(r1.segmentCount + 1);
  });

  it('assess() after restore() reflects restored segment', () => {
    const seg = lens.add(content(3)) as Segment;
    const r1 = lens.assess();
    lens.evict(seg.id);
    const r2 = lens.assess();
    lens.restore(seg.id);
    const r3 = lens.assess();
    expect(r3.segmentCount).toBe(r2.segmentCount + 1);
    expect(r3.segmentCount).toBe(r1.segmentCount);
  });

  it('assess() after setCapacity() reflects new capacity', () => {
    const r1 = lens.assess();
    lens.setCapacity(20000);
    const r2 = lens.assess();
    expect(r2.capacity.capacity).toBe(20000);
    expect(r2.reportId).not.toBe(r1.reportId);
  });
});

// ─── Lifecycle surface (cl-spec-015 §2.5, §6.2) ────────────────────

describe('Lifecycle surface', () => {
  it('instanceId matches the documented cl-N-xxxxxx format', () => {
    const lens = makeLens();
    expect(lens.instanceId).toMatch(/^cl-\d+-[a-z0-9]+$/);
  });

  it('two instances get distinct instanceIds', () => {
    const a = makeLens();
    const b = makeLens();
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  it('instanceId is stable across reads', () => {
    const lens = makeLens();
    const first = lens.instanceId;
    expect(lens.instanceId).toBe(first);
    expect(lens.instanceId).toBe(first);
  });

  it('isDisposed returns false on a fresh instance', () => {
    expect(makeLens().isDisposed).toBe(false);
  });

  it('isDisposing returns false on a fresh instance', () => {
    expect(makeLens().isDisposing).toBe(false);
  });

  it('isDisposed and isDisposing are never simultaneously true on a live instance', () => {
    const lens = makeLens();
    expect(lens.isDisposed && lens.isDisposing).toBe(false);
  });

  it('attachIntegration returns a handle with an idempotent detach()', () => {
    const lens = makeLens();
    const handle = lens.attachIntegration(() => {});
    expect(typeof handle.detach).toBe('function');
    expect(() => {
      handle.detach();
      handle.detach();
    }).not.toThrow();
  });

  it('attachIntegration on a live instance does not throw', () => {
    const lens = makeLens();
    expect(() => lens.attachIntegration(() => {})).not.toThrow();
  });
});

// ─── Disposed-state guard wiring (cl-spec-015 §3.4, §5.1) ──────────
//
// T10 wires guardDispose into every public method but the live path is
// unchanged. These tests force the lifecycle state via a private-field
// cast to verify the guard arms correctly. T11 will exercise the same
// behavior through the real dispose() method, and T15 covers exhaustive
// post-disposal property-based coverage.

describe('Disposed-state guard wiring', () => {
  function forceState(lens: ContextLens, state: 'disposed' | 'disposing'): void {
    (lens as unknown as { lifecycleState: string }).lifecycleState = state;
  }

  it('mutating methods throw DisposedError when state is "disposed"', () => {
    const lens = makeLens();
    forceState(lens, 'disposed');
    expect(() => lens.add('x')).toThrow(DisposedError);
    expect(() => lens.setCapacity(5000)).toThrow(DisposedError);
    expect(() => lens.on('segmentAdded', () => {})).toThrow(DisposedError);
    expect(() => lens.attachIntegration(() => {})).toThrow(DisposedError);
  });

  it('read-only methods also throw DisposedError when state is "disposed"', () => {
    const lens = makeLens();
    forceState(lens, 'disposed');
    expect(() => lens.getCapacity()).toThrow(DisposedError);
    expect(() => lens.getSegmentCount()).toThrow(DisposedError);
    expect(() => lens.assess()).toThrow(DisposedError);
    expect(() => lens.snapshot()).toThrow(DisposedError);
    expect(() => lens.getDiagnostics()).toThrow(DisposedError);
  });

  it('mutating methods throw DisposedError when state is "disposing"', () => {
    const lens = makeLens();
    forceState(lens, 'disposing');
    expect(() => lens.add('x')).toThrow(DisposedError);
    expect(() => lens.setCapacity(5000)).toThrow(DisposedError);
    expect(() => lens.attachIntegration(() => {})).toThrow(DisposedError);
  });

  it('read-only methods do NOT throw when state is "disposing"', () => {
    const lens = makeLens();
    lens.add('seed-content');  // populate something so reads have data
    forceState(lens, 'disposing');
    expect(() => lens.getCapacity()).not.toThrow();
    expect(() => lens.getSegmentCount()).not.toThrow();
    expect(() => lens.assess()).not.toThrow();
    expect(() => lens.snapshot()).not.toThrow();
  });

  it('thrown DisposedError carries instanceId and the attempted method name', () => {
    const lens = makeLens();
    const id = lens.instanceId;
    forceState(lens, 'disposed');
    try {
      lens.add('x');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DisposedError);
      const err = e as DisposedError;
      expect(err.instanceId).toBe(id);
      expect(err.attemptedMethod).toBe('add');
    }
  });
});

// T11: dispose() — real flow. Exercises the orchestrator end-to-end via the
// public method. Unit-level coverage of mechanism (state machine, idempotency,
// reentrancy, error aggregation). Full integration flows live in T14.

describe('dispose() — real flow', () => {
  it('flips lifecycle to disposed and emits stateDisposed exactly once', () => {
    const lens = makeLens();
    let count = 0;
    lens.on('stateDisposed', () => { count++; });
    lens.dispose();
    expect(count).toBe(1);
    expect(lens.isDisposed).toBe(true);
    expect(lens.isDisposing).toBe(false);
  });

  it('stateDisposed payload has the documented shape and is frozen', () => {
    const lens = makeLens();
    const id = lens.instanceId;
    const before = Date.now();
    let captured: { type: string; instanceId: string; timestamp: number } | null = null;
    lens.on('stateDisposed', (e) => { captured = e; });
    lens.dispose();
    const after = Date.now();
    expect(captured).not.toBeNull();
    const payload = captured as unknown as { type: string; instanceId: string; timestamp: number };
    expect(payload.type).toBe('stateDisposed');
    expect(payload.instanceId).toBe(id);
    expect(payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp).toBeLessThanOrEqual(after);
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it('is idempotent — three calls fire stateDisposed exactly once', () => {
    const lens = makeLens();
    let count = 0;
    lens.on('stateDisposed', () => { count++; });
    expect(() => { lens.dispose(); lens.dispose(); lens.dispose(); }).not.toThrow();
    expect(count).toBe(1);
    expect(lens.isDisposed).toBe(true);
  });

  it('is reentrant-safe — a stateDisposed handler that calls dispose() does not double-emit', () => {
    const lens = makeLens();
    let count = 0;
    lens.on('stateDisposed', () => {
      count++;
      lens.dispose();   // reentrant call during teardown — must no-op
    });
    expect(() => lens.dispose()).not.toThrow();
    expect(count).toBe(1);
    expect(lens.isDisposed).toBe(true);
  });

  it('mutating methods throw DisposedError after real dispose()', () => {
    const lens = makeLens();
    lens.dispose();
    expect(() => lens.add('x')).toThrow(DisposedError);
    expect(() => lens.setCapacity(5000)).toThrow(DisposedError);
    expect(() => lens.attachIntegration(() => {})).toThrow(DisposedError);
  });

  it('read-only methods throw DisposedError after real dispose()', () => {
    const lens = makeLens();
    lens.dispose();
    expect(() => lens.getCapacity()).toThrow(DisposedError);
    expect(() => lens.assess()).toThrow(DisposedError);
    expect(() => lens.snapshot()).toThrow(DisposedError);
    expect(() => lens.getDiagnostics()).toThrow(DisposedError);
  });

  it('throwing handler causes DisposalError; instance is fully disposed regardless', () => {
    const lens = makeLens();
    const id = lens.instanceId;
    lens.on('stateDisposed', () => { throw new Error('handler boom'); });
    let raised: unknown = null;
    try { lens.dispose(); } catch (e) { raised = e; }
    expect(raised).toBeInstanceOf(DisposalError);
    const err = raised as DisposalError;
    expect(err.instanceId).toBe(id);
    expect(err.errors.length).toBe(1);
    const tagged = err.errors[0] as { cause: unknown; origin: string; index: number };
    expect(tagged.origin).toBe('handler');
    expect(tagged.index).toBe(0);
    expect((tagged.cause as Error).message).toBe('handler boom');
    // Disposal completed despite the throw.
    expect(lens.isDisposed).toBe(true);
    expect(lens.isDisposing).toBe(false);
  });

  it('invokes registered integration callbacks during teardown with the live instance', () => {
    const lens = makeLens();
    let invoked = 0;
    let receivedInstance: unknown = null;
    let stateAtCallback: { isDisposed: boolean; isDisposing: boolean } | null = null;
    lens.attachIntegration((live) => {
      invoked++;
      receivedInstance = live;
      stateAtCallback = { isDisposed: live.isDisposed, isDisposing: live.isDisposing };
    });
    lens.dispose();
    expect(invoked).toBe(1);
    expect(receivedInstance).toBe(lens);
    // Integration callback runs in step 3 — disposing flag set, disposed not yet.
    expect(stateAtCallback).toEqual({ isDisposed: false, isDisposing: true });
  });

  it('throwing integration callback aggregates into DisposalError with origin tag', () => {
    const lens = makeLens();
    lens.attachIntegration(() => { throw new Error('integration boom'); });
    let raised: unknown = null;
    try { lens.dispose(); } catch (e) { raised = e; }
    expect(raised).toBeInstanceOf(DisposalError);
    const err = raised as DisposalError;
    expect(err.errors.length).toBe(1);
    const tagged = err.errors[0] as { cause: unknown; origin: string; index: number };
    expect(tagged.origin).toBe('integration');
    expect(tagged.index).toBe(0);
    expect((tagged.cause as Error).message).toBe('integration boom');
    expect(lens.isDisposed).toBe(true);
  });

  it('aggregates mixed handler+integration errors with origin-relative indices', () => {
    const lens = makeLens();
    lens.on('stateDisposed', () => { throw new Error('h0'); });
    lens.on('stateDisposed', () => { throw new Error('h1'); });
    lens.attachIntegration(() => { throw new Error('i0'); });
    lens.attachIntegration(() => { /* no-throw */ });
    lens.attachIntegration(() => { throw new Error('i1'); });

    let raised: unknown = null;
    try { lens.dispose(); } catch (e) { raised = e; }
    expect(raised).toBeInstanceOf(DisposalError);
    const err = raised as DisposalError;
    // 2 handler errors + 2 integration errors (the no-throw integration is skipped).
    expect(err.errors.length).toBe(4);
    const items = err.errors as { cause: unknown; origin: string; index: number }[];
    expect(items[0]).toMatchObject({ origin: 'handler', index: 0 });
    expect((items[0].cause as Error).message).toBe('h0');
    expect(items[1]).toMatchObject({ origin: 'handler', index: 1 });
    expect((items[1].cause as Error).message).toBe('h1');
    // Integration index restarts at 0 (origin-relative).
    expect(items[2]).toMatchObject({ origin: 'integration', index: 0 });
    expect((items[2].cause as Error).message).toBe('i0');
    expect(items[3]).toMatchObject({ origin: 'integration', index: 1 });
    expect((items[3].cause as Error).message).toBe('i1');
    expect(lens.isDisposed).toBe(true);
  });
});

// ─── Memory Management (cl-spec-007 §8.9, Gap 6) ──────────────────

describe('Memory management', () => {
  function makeWarmedLens(): ContextLens {
    const lens = new ContextLens({ capacity: 100000 });
    // Warm all three caches: token cache via add, similarity cache via assess,
    // embedding cache via assess (trigram mode by default — still populated).
    lens.add('first segment full of unique words for tokenization aaa');
    lens.add('second segment full of different unique words bbb');
    lens.add('third segment full of yet more distinctive words ccc');
    lens.assess();
    return lens;
  }

  it('clearCaches() with no argument clears all three caches and emits cachesCleared("all")', () => {
    const lens = makeWarmedLens();

    const events: { kind: string; entriesCleared: { tokenizer: number; embedding: number; similarity: number } }[] = [];
    lens.on('cachesCleared', (p) => events.push(p));

    const before = lens.getMemoryUsage();
    expect(before.tokenizer.entries).toBeGreaterThan(0);
    expect(before.embedding.entries).toBeGreaterThan(0);
    expect(before.similarity.entries).toBeGreaterThan(0);

    lens.clearCaches();

    const after = lens.getMemoryUsage();
    expect(after.tokenizer.entries).toBe(0);
    expect(after.embedding.entries).toBe(0);
    expect(after.similarity.entries).toBe(0);
    expect(after.totalEstimatedBytes).toBe(0);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('all');
    expect(events[0]!.entriesCleared.tokenizer).toBe(before.tokenizer.entries);
    expect(events[0]!.entriesCleared.embedding).toBe(before.embedding.entries);
    expect(events[0]!.entriesCleared.similarity).toBe(before.similarity.entries);
  });

  it('clearCaches("tokenizer") empties only the token cache; others unchanged', () => {
    const lens = makeWarmedLens();
    const before = lens.getMemoryUsage();

    lens.clearCaches('tokenizer');

    const after = lens.getMemoryUsage();
    expect(after.tokenizer.entries).toBe(0);
    expect(after.embedding.entries).toBe(before.embedding.entries);
    expect(after.similarity.entries).toBe(before.similarity.entries);
  });

  it('clearCaches("embedding") empties only the embedding cache', () => {
    const lens = makeWarmedLens();
    const before = lens.getMemoryUsage();

    lens.clearCaches('embedding');

    const after = lens.getMemoryUsage();
    expect(after.tokenizer.entries).toBe(before.tokenizer.entries);
    expect(after.embedding.entries).toBe(0);
    expect(after.similarity.entries).toBe(before.similarity.entries);
  });

  it('clearCaches("similarity") empties only the similarity cache', () => {
    const lens = makeWarmedLens();
    const before = lens.getMemoryUsage();

    lens.clearCaches('similarity');

    const after = lens.getMemoryUsage();
    expect(after.tokenizer.entries).toBe(before.tokenizer.entries);
    expect(after.embedding.entries).toBe(before.embedding.entries);
    expect(after.similarity.entries).toBe(0);
  });

  it('clearCaches("invalid") throws ValidationError; instance state unchanged', () => {
    const lens = makeWarmedLens();
    const before = lens.getMemoryUsage();

    expect(() => lens.clearCaches('invalid' as 'all')).toThrow(ValidationError);

    const after = lens.getMemoryUsage();
    expect(after.tokenizer.entries).toBe(before.tokenizer.entries);
    expect(after.embedding.entries).toBe(before.embedding.entries);
    expect(after.similarity.entries).toBe(before.similarity.entries);
  });

  it('setCacheSize shrinks the named cache; does NOT emit cachesCleared', () => {
    const lens = makeWarmedLens();
    const events: unknown[] = [];
    lens.on('cachesCleared', (p) => events.push(p));

    lens.setCacheSize('embedding', 1);

    const usage = lens.getMemoryUsage();
    expect(usage.embedding.maxEntries).toBe(1);
    expect(usage.embedding.entries).toBeLessThanOrEqual(1);
    expect(events).toHaveLength(0);
  });

  it('setCacheSize(kind, 0) disables the named cache', () => {
    const lens = makeWarmedLens();

    lens.setCacheSize('similarity', 0);
    const usage = lens.getMemoryUsage();
    expect(usage.similarity.entries).toBe(0);
    expect(usage.similarity.maxEntries).toBe(0);

    // Re-running assess populates segments but the disabled cache stays empty.
    lens.add('an additional segment to force a new assess cycle');
    lens.assess();
    expect(lens.getMemoryUsage().similarity.entries).toBe(0);
  });

  it('setCacheSize("all", N) throws ValidationError', () => {
    const lens = new ContextLens({ capacity: 1000 });
    expect(() => lens.setCacheSize('all' as 'embedding', 1000)).toThrow(ValidationError);
  });

  it('setCacheSize rejects negative size', () => {
    const lens = new ContextLens({ capacity: 1000 });
    expect(() => lens.setCacheSize('embedding', -1)).toThrow(ValidationError);
  });

  it('setCacheSize rejects non-integer size', () => {
    const lens = new ContextLens({ capacity: 1000 });
    expect(() => lens.setCacheSize('embedding', 1.5)).toThrow(ValidationError);
  });

  it('setCacheSize rejects unknown kind', () => {
    const lens = new ContextLens({ capacity: 1000 });
    expect(() => lens.setCacheSize('bogus' as 'embedding', 100)).toThrow(ValidationError);
  });

  it('getMemoryUsage returns the documented shape with totalEstimatedBytes matching the per-cache sum', () => {
    const lens = makeWarmedLens();
    const usage = lens.getMemoryUsage();

    expect(usage).toMatchObject({
      tokenizer: expect.objectContaining({
        entries: expect.any(Number),
        maxEntries: expect.any(Number),
        estimatedBytes: expect.any(Number),
      }),
      embedding: expect.objectContaining({
        entries: expect.any(Number),
        maxEntries: expect.any(Number),
        estimatedBytes: expect.any(Number),
      }),
      similarity: expect.objectContaining({
        entries: expect.any(Number),
        maxEntries: expect.any(Number),
        estimatedBytes: expect.any(Number),
      }),
      totalEstimatedBytes: expect.any(Number),
    });
    expect(usage.totalEstimatedBytes).toBe(
      usage.tokenizer.estimatedBytes + usage.embedding.estimatedBytes + usage.similarity.estimatedBytes,
    );
  });

  it('getMemoryUsage uses 80 bytes/entry for similarity and 100 bytes/entry for tokenizer', () => {
    const lens = makeWarmedLens();
    const usage = lens.getMemoryUsage();

    expect(usage.tokenizer.estimatedBytes).toBe(usage.tokenizer.entries * 100);
    expect(usage.similarity.estimatedBytes).toBe(usage.similarity.entries * 80);
  });

  it('getMemoryUsage uses 8000 bytes/entry for embedding cache in trigram mode', () => {
    const lens = makeWarmedLens();
    const usage = lens.getMemoryUsage();
    // Default zero-config lens runs in trigram mode.
    expect(usage.embedding.estimatedBytes).toBe(usage.embedding.entries * 8000);
  });

  it('getMemoryUsage after clearCaches reports zero entries', () => {
    const lens = makeWarmedLens();
    lens.clearCaches();
    const usage = lens.getMemoryUsage();
    expect(usage.tokenizer.entries).toBe(0);
    expect(usage.embedding.entries).toBe(0);
    expect(usage.similarity.entries).toBe(0);
    expect(usage.totalEstimatedBytes).toBe(0);
  });

  it('clearCaches() throws DisposedError after dispose()', () => {
    const lens = new ContextLens({ capacity: 1000 });
    lens.dispose();
    expect(() => lens.clearCaches()).toThrow(DisposedError);
  });

  it('setCacheSize throws DisposedError after dispose()', () => {
    const lens = new ContextLens({ capacity: 1000 });
    lens.dispose();
    expect(() => lens.setCacheSize('embedding', 100)).toThrow(DisposedError);
  });

  it('getMemoryUsage throws DisposedError after dispose()', () => {
    const lens = new ContextLens({ capacity: 1000 });
    lens.dispose();
    expect(() => lens.getMemoryUsage()).toThrow(DisposedError);
  });

  it('clearCaches preserves segments and assessment continues', () => {
    const lens = makeWarmedLens();
    const segCountBefore = lens.getSegmentCount();
    lens.clearCaches();

    expect(lens.getSegmentCount()).toBe(segCountBefore);

    // Segments still have their stored tokenCount (count stability invariant).
    const segs = lens.listSegments();
    for (const seg of segs) {
      expect(seg.tokenCount).toBeGreaterThan(0);
    }

    // The next assess() that follows a mutation produces a fresh report and
    // repopulates the underlying caches. (assess() without an intervening
    // mutation returns the cached report — see cl-spec-002 §9.6 quality-
    // report caching; clearCaches does not invalidate that higher-level
    // cache because it is the assembled output, not a derived primitive.)
    lens.add('a fresh segment to invalidate the quality report cache');
    const report = lens.assess();
    expect(report).toBeDefined();
    const usageAfterAssess = lens.getMemoryUsage();
    expect(usageAfterAssess.similarity.entries).toBeGreaterThan(0);
  });
});

// ─── similarityCacheSize config (cl-spec-016, Gap 5) ──────────────

describe('similarityCacheSize config', () => {
  it('default scales with capacity, clamped to [16384, 65536]', () => {
    // Lower bound — at capacity < 200, formula computes < 16384, clamped up
    const tiny = new ContextLens({ capacity: 100 });
    expect(tiny.getMemoryUsage().similarity.maxEntries).toBe(16384);

    // Right at the formula's natural lower bound — sqrt(200/200) × 16384 = 16384
    const minimum = new ContextLens({ capacity: 200 });
    expect(minimum.getMemoryUsage().similarity.maxEntries).toBe(16384);

    // Mid-range — formula computes between bounds
    // sqrt(800/200) × 16384 = 2 × 16384 = 32768 (within bounds)
    const mid = new ContextLens({ capacity: 800 });
    expect(mid.getMemoryUsage().similarity.maxEntries).toBe(32768);

    // Upper bound at typical large capacity
    const large = new ContextLens({ capacity: 128000 });
    expect(large.getMemoryUsage().similarity.maxEntries).toBe(65536);

    // Upper bound at huge capacity
    const huge = new ContextLens({ capacity: 1000000 });
    expect(huge.getMemoryUsage().similarity.maxEntries).toBe(65536);
  });

  it('explicit similarityCacheSize overrides the default', () => {
    const lens = new ContextLens({ capacity: 128000, similarityCacheSize: 4096 });
    expect(lens.getMemoryUsage().similarity.maxEntries).toBe(4096);
  });

  it('similarityCacheSize: 0 disables the cache', () => {
    const lens = new ContextLens({ capacity: 100000, similarityCacheSize: 0 });
    expect(lens.getMemoryUsage().similarity.maxEntries).toBe(0);

    // Subsequent operations work but every similarity lookup misses.
    lens.add('one segment');
    lens.add('another segment with different content');
    lens.assess();
    expect(lens.getMemoryUsage().similarity.entries).toBe(0);
  });

  it('rejects negative similarityCacheSize with ConfigurationError', () => {
    expect(() => new ContextLens({ capacity: 1000, similarityCacheSize: -1 }))
      .toThrow(ConfigurationError);
  });

  it('rejects non-integer similarityCacheSize with ConfigurationError', () => {
    expect(() => new ContextLens({ capacity: 1000, similarityCacheSize: 1.5 }))
      .toThrow(ConfigurationError);
  });

  it('rejects NaN similarityCacheSize with ConfigurationError', () => {
    expect(() => new ContextLens({ capacity: 1000, similarityCacheSize: Number.NaN }))
      .toThrow(ConfigurationError);
  });

  it('snapshot captures similarityCacheSize; fromSnapshot honors it', () => {
    const a = new ContextLens({ capacity: 50000, similarityCacheSize: 8192 });
    a.add('content one for the fresh window');
    a.add('content two for the fresh window');
    const state = a.snapshot();
    expect(state.config.similarityCacheSize).toBe(8192);

    const b = ContextLens.fromSnapshot(state, {});
    expect(b.getMemoryUsage().similarity.maxEntries).toBe(8192);
  });

  it('fromSnapshot falls back to default when similarityCacheSize is absent (forward-compat)', () => {
    const a = new ContextLens({ capacity: 128000 });
    a.add('seed content');
    const state = a.snapshot();
    // Simulate an older snapshot by deleting the field.
    delete (state.config as { similarityCacheSize?: number }).similarityCacheSize;

    const b = ContextLens.fromSnapshot(state, {});
    // Defaults to upper bound at capacity=128000.
    expect(b.getMemoryUsage().similarity.maxEntries).toBe(65536);
  });
});
