import { describe, it, expect, beforeEach } from 'vitest';
import { SegmentStore } from '../../src/segment-store.js';
import type { AddOptions, DuplicateSignal } from '../../src/segment-store.js';
import { EventEmitter } from '../../src/events.js';
import type { ContextLensEventMap } from '../../src/events.js';
import { Tokenizer } from '../../src/tokenizer.js';
import type { Segment, CompactionRecord, EvictionRecord } from '../../src/types.js';
import {
  ValidationError,
  DuplicateIdError,
  InvalidStateError,
  ProtectionError,
  MembershipError,
  CompactionError,
  SplitError,
  RestoreError,
} from '../../src/errors.js';

// ─── Test Helpers ────────────────────────────────────────────────

function isDuplicateSignal(result: Segment | DuplicateSignal): result is DuplicateSignal {
  return 'isDuplicate' in result && result.isDuplicate === true;
}

function isSegment(result: Segment | DuplicateSignal): result is Segment {
  return !isDuplicateSignal(result);
}

function createTestHarness(retainEvictedContent = true) {
  const tokenizer = new Tokenizer('approximate', undefined, 256);
  const emitter = new EventEmitter<ContextLensEventMap>();
  const store = new SegmentStore(tokenizer, emitter, retainEvictedContent);
  return { tokenizer, emitter, store };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('SegmentStore', () => {
  let tokenizer: Tokenizer;
  let emitter: EventEmitter<ContextLensEventMap>;
  let store: SegmentStore;

  beforeEach(() => {
    const harness = createTestHarness();
    tokenizer = harness.tokenizer;
    emitter = harness.emitter;
    store = harness.store;
  });

  // ── add() ──────────────────────────────────────────────────────

  describe('add()', () => {
    it('adds segment with caller ID and returns Segment with correct fields', () => {
      const result = store.add('Hello world', { id: 'seg-1', importance: 0.8, origin: 'test', tags: ['a'] });

      expect(isSegment(result)).toBe(true);
      if (!isSegment(result)) return;

      expect(result.id).toBe('seg-1');
      expect(result.content).toBe('Hello world');
      expect(result.importance).toBe(0.8);
      expect(result.state).toBe('active');
      expect(result.origin).toBe('test');
      expect(result.tags).toEqual(['a']);
      expect(result.protection).toBe('default');
      expect(result.tokenCount).toBeGreaterThan(0);
      expect(result.createdAt).toBeGreaterThan(0);
      expect(result.updatedAt).toBe(result.createdAt);
      expect(result.groupId).toBeNull();
    });

    it('auto-generates "auto:..." ID when no id is provided', () => {
      const result = store.add('Some content');

      expect(isSegment(result)).toBe(true);
      if (!isSegment(result)) return;

      expect(result.id).toMatch(/^auto:/);
    });

    it('returns DuplicateSignal for duplicate content without caller ID', () => {
      const first = store.add('Duplicate content');
      expect(isSegment(first)).toBe(true);
      if (!isSegment(first)) return;

      const second = store.add('Duplicate content');

      expect(isDuplicateSignal(second)).toBe(true);
      if (!isDuplicateSignal(second)) return;

      expect(second.isDuplicate).toBe(true);
      expect(second.existingId).toBe(first.id);
      expect(second.contentHash).toBeTypeOf('number');
    });

    it('throws DuplicateIdError when caller ID already exists', () => {
      store.add('First', { id: 'dup-id' });

      expect(() => store.add('Second', { id: 'dup-id' })).toThrow(DuplicateIdError);
    });

    it('throws ValidationError for empty content', () => {
      expect(() => store.add('')).toThrow(ValidationError);
    });

    it('throws ValidationError for importance below 0', () => {
      expect(() => store.add('Content', { importance: -0.1 })).toThrow(ValidationError);
    });

    it('throws ValidationError for importance above 1', () => {
      expect(() => store.add('Content', { importance: 1.1 })).toThrow(ValidationError);
    });

    it('adds segment to group when groupId is specified', () => {
      const segA = store.add('A', { id: 'a' });
      const segB = store.add('B', { id: 'b' });
      if (!isSegment(segA) || !isSegment(segB)) return;

      store.createGroup('g1', ['a', 'b']);

      const segC = store.add('C', { id: 'c', groupId: 'g1' });
      if (!isSegment(segC)) return;

      expect(segC.groupId).toBe('g1');

      const group = store.getGroup('g1');
      expect(group).toBeDefined();
      expect(group!.members).toContain('c');
    });

    it('emits segmentAdded event with segment payload', () => {
      const events: { segment: Segment }[] = [];
      emitter.on('segmentAdded', (payload) => {
        events.push(payload);
      });

      const result = store.add('Event test', { id: 'ev-1' });

      expect(events).toHaveLength(1);
      expect(events[0]!.segment.id).toBe('ev-1');
      if (isSegment(result)) {
        expect(events[0]!.segment.content).toBe(result.content);
      }
    });

    it('defaults importance to 0.5 when not specified', () => {
      const result = store.add('Default importance', { id: 'def-imp' });
      if (!isSegment(result)) return;

      expect(result.importance).toBe(0.5);
    });

    it('defaults protection to "default" when not specified', () => {
      const result = store.add('Default protection', { id: 'def-prot' });
      if (!isSegment(result)) return;

      expect(result.protection).toBe('default');
    });
  });

  // ── update() ───────────────────────────────────────────────────

  describe('update()', () => {
    it('updates content with recounted tokenCount and updated contentHash', () => {
      const seg = store.add('Short', { id: 'u1' }) as Segment;
      const origTokenCount = seg.tokenCount;

      const updated = store.update('u1', { content: 'A much longer piece of content than before' });

      expect(updated.content).toBe('A much longer piece of content than before');
      expect(updated.tokenCount).not.toBe(origTokenCount);
      expect(updated.id).toBe('u1');
    });

    it('updates metadata without changing content', () => {
      store.add('Keep this content', { id: 'u2', importance: 0.3, tags: ['old'] });

      const updated = store.update('u2', { importance: 0.9, tags: ['new'] });

      expect(updated.content).toBe('Keep this content');
      expect(updated.importance).toBe(0.9);
      expect(updated.tags).toEqual(['new']);
    });

    it('throws InvalidStateError when updating an evicted segment', () => {
      store.add('To evict', { id: 'u3' });
      store.evict('u3');

      expect(() => store.update('u3', { importance: 0.1 })).toThrow(InvalidStateError);
    });

    it('throws ProtectionError when updating content of pinned segment', () => {
      store.add('Pinned content', { id: 'u4', protection: 'pinned' });

      expect(() => store.update('u4', { content: 'New content' })).toThrow(ProtectionError);
    });

    it('allows updating metadata of pinned segment', () => {
      store.add('Pinned content', { id: 'u5', protection: 'pinned' });

      const updated = store.update('u5', { importance: 0.9, tags: ['updated'] });

      expect(updated.importance).toBe(0.9);
      expect(updated.tags).toEqual(['updated']);
      expect(updated.content).toBe('Pinned content');
    });

    it('emits segmentUpdated event with changes list', () => {
      store.add('Original', { id: 'u6' });

      const events: { segment: Segment; changes: string[] }[] = [];
      emitter.on('segmentUpdated', (payload) => {
        events.push(payload);
      });

      store.update('u6', { content: 'Changed', importance: 0.7 });

      expect(events).toHaveLength(1);
      expect(events[0]!.changes).toContain('content');
      expect(events[0]!.changes).toContain('importance');
      expect(events[0]!.segment.id).toBe('u6');
    });
  });

  // ── replace() ──────────────────────────────────────────────────

  describe('replace()', () => {
    it('replaces content keeping same ID and position', () => {
      store.add('A', { id: 'r-a' });
      store.add('B', { id: 'r-b' });
      store.add('C', { id: 'r-c' });

      const replaced = store.replace('r-b', 'New B content');

      expect(replaced.id).toBe('r-b');
      expect(replaced.content).toBe('New B content');

      // Position preserved: order should still be A, B, C
      const ordered = store.getOrderedActiveSegments();
      expect(ordered.map(s => s.id)).toEqual(['r-a', 'r-b', 'r-c']);
    });

    it('throws ValidationError for empty content', () => {
      store.add('Original', { id: 'r-empty' });

      expect(() => store.replace('r-empty', '')).toThrow(ValidationError);
    });
  });

  // ── compact() ──────────────────────────────────────────────────

  describe('compact()', () => {
    it('compacts with shorter summary, decreasing token count and setting origin', () => {
      store.add('This is a very long piece of content with many words and lots of detail that should be compacted down', { id: 'c1' });
      const before = store.getSegment('c1')!;
      const origTokenCount = before.tokenCount;

      const compacted = store.compact('c1', 'Short');

      expect(compacted.tokenCount).toBeLessThan(origTokenCount);
      expect(compacted.origin).toBe('summary:compacted');
      expect(compacted.content).toBe('Short');
    });

    it('throws CompactionError when summary is not shorter', () => {
      store.add('Hi', { id: 'c2' });

      expect(() => store.compact('c2', 'This is a longer compaction that has more tokens than the original')).toThrow(CompactionError);
    });

    it('throws ProtectionError when compacting pinned segment', () => {
      store.add('Long content for pinned segment compaction test', { id: 'c3', protection: 'pinned' });

      expect(() => store.compact('c3', 'Short')).toThrow(ProtectionError);
    });

    it('emits segmentCompacted event with CompactionRecord', () => {
      store.add('This is a sufficiently long piece of content to compact successfully', { id: 'c4' });

      const events: { segment: Segment; record: CompactionRecord }[] = [];
      emitter.on('segmentCompacted', (payload) => {
        events.push(payload);
      });

      store.compact('c4', 'Short');

      expect(events).toHaveLength(1);
      expect(events[0]!.record.originalTokenCount).toBeGreaterThan(events[0]!.record.compactedTokenCount);
      expect(events[0]!.record.compressionRatio).toBeGreaterThan(0);
      expect(events[0]!.record.compressionRatio).toBeLessThan(1);
      expect(events[0]!.record.timestamp).toBeGreaterThan(0);
      expect(events[0]!.segment.id).toBe('c4');
    });
  });

  // ── split() ────────────────────────────────────────────────────

  describe('split()', () => {
    it('splits into parts, removing original and creating children with suffixed IDs', () => {
      store.add('Part one. Part two. Part three.', { id: 'sp1' });

      const children = store.split('sp1', () => ['Part one.', 'Part two.', 'Part three.']);

      expect(children).toHaveLength(3);
      expect(children[0]!.id).toBe('sp1:0');
      expect(children[1]!.id).toBe('sp1:1');
      expect(children[2]!.id).toBe('sp1:2');
      expect(children[0]!.content).toBe('Part one.');
      expect(children[1]!.content).toBe('Part two.');
      expect(children[2]!.content).toBe('Part three.');

      // Original is gone
      expect(store.getSegment('sp1')).toBeUndefined();
    });

    it('children inherit parent metadata (protection, importance, tags)', () => {
      store.add('Split me into two parts please', {
        id: 'sp2',
        importance: 0.7,
        protection: 'seed',
        tags: ['inherited'],
        origin: 'user',
      });

      const children = store.split('sp2', () => ['Split me', 'into two parts please']);

      for (const child of children) {
        expect(child.importance).toBe(0.7);
        expect(child.protection).toBe('seed');
        expect(child.tags).toEqual(['inherited']);
        expect(child.origin).toBe('user');
      }
    });

    it('children preserve group membership', () => {
      store.add('Group member A', { id: 'gm-a' });
      store.add('Group member B to split', { id: 'gm-b' });
      store.createGroup('sg1', ['gm-a', 'gm-b']);

      const children = store.split('gm-b', () => ['Group member B', 'to split']);

      expect(children[0]!.groupId).toBe('sg1');
      expect(children[1]!.groupId).toBe('sg1');

      const group = store.getGroup('sg1');
      expect(group).toBeDefined();
      expect(group!.members).toContain('gm-b:0');
      expect(group!.members).toContain('gm-b:1');
      expect(group!.members).not.toContain('gm-b');
    });

    it('throws SplitError when split function returns empty array', () => {
      store.add('Content', { id: 'sp-empty-arr' });

      expect(() => store.split('sp-empty-arr', () => [])).toThrow(SplitError);
    });

    it('throws SplitError when split function returns an empty string', () => {
      store.add('Content', { id: 'sp-empty-str' });

      expect(() => store.split('sp-empty-str', () => ['valid', ''])).toThrow(SplitError);
    });

    it('throws ProtectionError when splitting pinned segment', () => {
      store.add('Pinned content for split', { id: 'sp-pinned', protection: 'pinned' });

      expect(() => store.split('sp-pinned', () => ['Pinned', 'content'])).toThrow(ProtectionError);
    });
  });

  // ── evict() ────────────────────────────────────────────────────

  describe('evict()', () => {
    it('evicts active segment, moving it to evicted with state=evicted', () => {
      store.add('To evict', { id: 'ev1' });

      const records = store.evict('ev1');

      expect(records).toHaveLength(1);
      expect(records[0]!.segmentId).toBe('ev1');

      expect(store.getActiveSegment('ev1')).toBeUndefined();
      const evicted = store.getEvictedSegment('ev1');
      expect(evicted).toBeDefined();
      expect(evicted!.state).toBe('evicted');
    });

    it('throws InvalidStateError when evicting already-evicted segment', () => {
      store.add('Already evicted', { id: 'ev2' });
      store.evict('ev2');

      expect(() => store.evict('ev2')).toThrow(InvalidStateError);
    });

    it('throws ProtectionError when evicting pinned segment', () => {
      store.add('Pinned', { id: 'ev3', protection: 'pinned' });

      expect(() => store.evict('ev3')).toThrow(ProtectionError);
    });

    it('evicts ALL group members atomically', () => {
      store.add('G-A', { id: 'ga' });
      store.add('G-B', { id: 'gb' });
      store.add('G-C', { id: 'gc' });
      store.createGroup('eg1', ['ga', 'gb', 'gc']);

      const records = store.evict('ga');

      expect(records).toHaveLength(3);
      expect(store.getActiveSegment('ga')).toBeUndefined();
      expect(store.getActiveSegment('gb')).toBeUndefined();
      expect(store.getActiveSegment('gc')).toBeUndefined();
      expect(store.getEvictedSegment('ga')).toBeDefined();
      expect(store.getEvictedSegment('gb')).toBeDefined();
      expect(store.getEvictedSegment('gc')).toBeDefined();
    });

    it('throws ProtectionError when evicting segment in pinned group', () => {
      store.add('PG-A', { id: 'pga' });
      store.add('PG-B', { id: 'pgb' });
      store.createGroup('pg1', ['pga', 'pgb'], { protection: 'pinned' });

      expect(() => store.evict('pga')).toThrow(ProtectionError);
    });

    it('clears content when retainEvictedContent=false', () => {
      const harness = createTestHarness(false);
      harness.store.add('Content to clear', { id: 'ev-noretain' });

      harness.store.evict('ev-noretain');

      const evicted = harness.store.getEvictedSegment('ev-noretain');
      expect(evicted).toBeDefined();
      expect(evicted!.content).toBe('');
    });

    it('retains content when retainEvictedContent=true', () => {
      store.add('Content to retain', { id: 'ev-retain' });

      store.evict('ev-retain');

      const evicted = store.getEvictedSegment('ev-retain');
      expect(evicted).toBeDefined();
      expect(evicted!.content).toBe('Content to retain');
    });

    it('emits segmentEvicted event per segment', () => {
      store.add('Ev-A', { id: 'ev-ea' });
      store.add('Ev-B', { id: 'ev-eb' });
      store.createGroup('evg', ['ev-ea', 'ev-eb']);

      const events: { record: EvictionRecord }[] = [];
      emitter.on('segmentEvicted', (payload) => {
        events.push(payload);
      });

      store.evict('ev-ea');

      expect(events).toHaveLength(2);
      const ids = events.map(e => e.record.segmentId);
      expect(ids).toContain('ev-ea');
      expect(ids).toContain('ev-eb');
    });
  });

  // ── restore() ──────────────────────────────────────────────────

  describe('restore()', () => {
    it('restores evicted segment back to active state', () => {
      store.add('Restore me', { id: 'rs1' });
      store.evict('rs1');

      const restored = store.restore('rs1');

      expect(restored).toHaveLength(1);
      expect(restored[0]!.state).toBe('active');
      expect(restored[0]!.id).toBe('rs1');
      expect(store.getActiveSegment('rs1')).toBeDefined();
      expect(store.getEvictedSegment('rs1')).toBeUndefined();
    });

    it('preserves original position after evict and restore', () => {
      store.add('A', { id: 'pos-a' });
      store.add('B', { id: 'pos-b' });
      store.add('C', { id: 'pos-c' });

      store.evict('pos-b');
      store.restore('pos-b');

      const ordered = store.getOrderedActiveSegments();
      const ids = ordered.map(s => s.id);
      expect(ids).toEqual(['pos-a', 'pos-b', 'pos-c']);
    });

    it('restores with new content when content was not retained', () => {
      const harness = createTestHarness(false);
      harness.store.add('Original content', { id: 'rs-new' });
      harness.store.evict('rs-new');

      const restored = harness.store.restore('rs-new', { content: 'Replacement content' });

      expect(restored).toHaveLength(1);
      expect(restored[0]!.content).toBe('Replacement content');
      expect(restored[0]!.state).toBe('active');
    });

    it('throws RestoreError when content not retained and no new content provided', () => {
      const harness = createTestHarness(false);
      harness.store.add('Will be cleared', { id: 'rs-fail' });
      harness.store.evict('rs-fail');

      expect(() => harness.store.restore('rs-fail')).toThrow(RestoreError);
    });

    it('restores ALL group members atomically', () => {
      store.add('RG-A', { id: 'rga' });
      store.add('RG-B', { id: 'rgb' });
      store.createGroup('rg1', ['rga', 'rgb']);

      store.evict('rga');

      const restored = store.restore('rga');

      expect(restored).toHaveLength(2);
      expect(store.getActiveSegment('rga')).toBeDefined();
      expect(store.getActiveSegment('rgb')).toBeDefined();
    });

    it('emits segmentRestored event', () => {
      store.add('Restore event', { id: 'rs-ev' });
      store.evict('rs-ev');

      const events: { segment: Segment; fidelity: number }[] = [];
      emitter.on('segmentRestored', (payload) => {
        events.push(payload);
      });

      store.restore('rs-ev');

      expect(events).toHaveLength(1);
      expect(events[0]!.segment.id).toBe('rs-ev');
      expect(events[0]!.fidelity).toBe(1.0);
    });
  });

  // ── createGroup() ──────────────────────────────────────────────

  describe('createGroup()', () => {
    it('creates group with members joined and returns group', () => {
      store.add('M1', { id: 'm1' });
      store.add('M2', { id: 'm2' });

      const group = store.createGroup('g1', ['m1', 'm2']);

      expect(group.groupId).toBe('g1');
      expect(group.members).toEqual(['m1', 'm2']);
      expect(group.state).toBe('active');

      // Members have groupId set
      const seg1 = store.getSegment('m1');
      const seg2 = store.getSegment('m2');
      expect(seg1!.groupId).toBe('g1');
      expect(seg2!.groupId).toBe('g1');
    });

    it('throws DuplicateIdError for duplicate groupId', () => {
      store.add('A', { id: 'dga' });
      store.add('B', { id: 'dgb' });
      store.createGroup('dup-g', ['dga']);

      expect(() => store.createGroup('dup-g', ['dgb'])).toThrow(DuplicateIdError);
    });

    it('throws MembershipError when member already belongs to another group', () => {
      store.add('X', { id: 'mx' });
      store.add('Y', { id: 'my' });
      store.createGroup('gx', ['mx']);

      expect(() => store.createGroup('gy', ['mx', 'my'])).toThrow(MembershipError);
    });

    it('throws ValidationError for empty members array', () => {
      expect(() => store.createGroup('empty-g', [])).toThrow(ValidationError);
    });

    it('emits groupCreated event', () => {
      store.add('GE-A', { id: 'ge-a' });

      const events: { group: unknown }[] = [];
      emitter.on('groupCreated', (payload) => {
        events.push(payload);
      });

      store.createGroup('ge-g', ['ge-a']);

      expect(events).toHaveLength(1);
    });
  });

  // ── dissolveGroup() ────────────────────────────────────────────

  describe('dissolveGroup()', () => {
    it('dissolves group, clearing members groupId and setting state dissolved', () => {
      store.add('DA', { id: 'da' });
      store.add('DB', { id: 'db' });
      store.createGroup('dg', ['da', 'db']);

      store.dissolveGroup('dg');

      const seg1 = store.getSegment('da');
      const seg2 = store.getSegment('db');
      expect(seg1!.groupId).toBeNull();
      expect(seg2!.groupId).toBeNull();

      // Group still exists but is dissolved
      const group = store.getGroup('dg');
      expect(group).toBeDefined();
      expect(group!.state).toBe('dissolved');
    });

    it('throws InvalidStateError when dissolving already dissolved group', () => {
      store.add('DDA', { id: 'dda' });
      store.createGroup('ddg', ['dda']);
      store.dissolveGroup('ddg');

      expect(() => store.dissolveGroup('ddg')).toThrow(InvalidStateError);
    });

    it('emits groupDissolved event', () => {
      store.add('DE-A', { id: 'de-a' });
      store.add('DE-B', { id: 'de-b' });
      store.createGroup('de-g', ['de-a', 'de-b']);

      const events: { groupId: string; memberIds: string[] }[] = [];
      emitter.on('groupDissolved', (payload) => {
        events.push(payload);
      });

      store.dissolveGroup('de-g');

      expect(events).toHaveLength(1);
      expect(events[0]!.groupId).toBe('de-g');
      expect(events[0]!.memberIds).toContain('de-a');
      expect(events[0]!.memberIds).toContain('de-b');
    });
  });

  // ── Position tracking ──────────────────────────────────────────

  describe('position tracking', () => {
    it('getOrderedActiveSegments returns segments in insertion order', () => {
      store.add('First', { id: 'p1' });
      store.add('Second', { id: 'p2' });
      store.add('Third', { id: 'p3' });

      const ordered = store.getOrderedActiveSegments();

      expect(ordered.map(s => s.id)).toEqual(['p1', 'p2', 'p3']);
    });

    it('preserves position after evict and restore', () => {
      store.add('Alpha', { id: 'pa' });
      store.add('Beta', { id: 'pb' });
      store.add('Gamma', { id: 'pc' });
      store.add('Delta', { id: 'pd' });

      store.evict('pb');
      store.evict('pc');

      store.restore('pc');
      store.restore('pb');

      const ordered = store.getOrderedActiveSegments();
      expect(ordered.map(s => s.id)).toEqual(['pa', 'pb', 'pc', 'pd']);
    });
  });

  // ── Query methods ──────────────────────────────────────────────

  describe('query methods', () => {
    it('getSegment returns active segments', () => {
      store.add('Active query', { id: 'qa' });
      expect(store.getSegment('qa')).toBeDefined();
      expect(store.getSegment('qa')!.id).toBe('qa');
    });

    it('getSegment returns evicted segments', () => {
      store.add('Evicted query', { id: 'qe' });
      store.evict('qe');
      expect(store.getSegment('qe')).toBeDefined();
      expect(store.getSegment('qe')!.state).toBe('evicted');
    });

    it('getSegment returns undefined for nonexistent id', () => {
      expect(store.getSegment('nonexistent')).toBeUndefined();
    });

    it('getActiveSegment returns only active segments', () => {
      store.add('Active only', { id: 'qao' });
      store.add('Will evict', { id: 'qao2' });
      store.evict('qao2');

      expect(store.getActiveSegment('qao')).toBeDefined();
      expect(store.getActiveSegment('qao2')).toBeUndefined();
    });

    it('getEvictedSegment returns only evicted segments', () => {
      store.add('Active seg', { id: 'qeo1' });
      store.add('Evicted seg', { id: 'qeo2' });
      store.evict('qeo2');

      expect(store.getEvictedSegment('qeo1')).toBeUndefined();
      expect(store.getEvictedSegment('qeo2')).toBeDefined();
    });

    it('segmentCount tracks active segments', () => {
      expect(store.segmentCount).toBe(0);

      store.add('One', { id: 'sc1' });
      store.add('Two', { id: 'sc2' });
      expect(store.segmentCount).toBe(2);

      store.evict('sc1');
      expect(store.segmentCount).toBe(1);
    });

    it('evictedCount tracks evicted segments', () => {
      expect(store.evictedCount).toBe(0);

      store.add('Evict me', { id: 'ec1' });
      store.evict('ec1');
      expect(store.evictedCount).toBe(1);

      store.restore('ec1');
      expect(store.evictedCount).toBe(0);
    });

    it('groupCount tracks active groups', () => {
      expect(store.groupCount).toBe(0);

      store.add('GA', { id: 'gc-a' });
      store.add('GB', { id: 'gc-b' });
      store.createGroup('gc-g1', ['gc-a']);
      expect(store.groupCount).toBe(1);

      store.createGroup('gc-g2', ['gc-b']);
      expect(store.groupCount).toBe(2);

      store.dissolveGroup('gc-g1');
      expect(store.groupCount).toBe(1);
    });
  });

  // ── Phase C: Branch coverage additions ───────────────────────

  describe('auto-ID collision with suffix', () => {
    it('appends suffix when auto-generated ID already exists in evicted map', () => {
      const { store } = createTestHarness();
      // Add first segment — gets auto:HASH
      const seg1 = store.add('unique collision test content alpha');
      expect(isSegment(seg1)).toBe(true);
      const id1 = (seg1 as Segment).id;
      expect(id1).toMatch(/^auto:/);
      expect(id1).not.toContain(':1');

      // Evict the first segment so its ID is still in the evicted map
      store.evict(id1);

      // Add different content that happens to produce same hash is unlikely,
      // but we can test the suffix path by adding same content after eviction.
      // Dedup checks active map only, so evicted content won't trigger DuplicateSignal.
      const seg2 = store.add('unique collision test content alpha');
      expect(isSegment(seg2)).toBe(true);
      const id2 = (seg2 as Segment).id;
      // The base auto:HASH is in evicted, so suffix is appended
      expect(id2).toMatch(/^auto:.*:1$/);
    });
  });

  describe('group token recomputation', () => {
    it('group tokenCount reflects sum of member tokenCounts', () => {
      const { store } = createTestHarness();
      const s1 = store.add('short content', { id: 'gt-1' }) as Segment;
      const s2 = store.add('another piece of short content here for testing', { id: 'gt-2' }) as Segment;
      const group = store.createGroup('gt-g', ['gt-1', 'gt-2']);
      expect(group.tokenCount).toBe(s1.tokenCount + s2.tokenCount);
    });
  });

  describe('restore with content override', () => {
    it('restores evicted segment with new content when provided', () => {
      const { store } = createTestHarness();
      store.add('original content for restore test', { id: 'rco-1' });
      store.evict('rco-1');
      const restored = store.restore('rco-1', { content: 'new replacement content' });
      expect(restored).toHaveLength(1);
      expect(restored[0]!.content).toBe('new replacement content');
      expect(restored[0]!.state).toBe('active');
    });
  });

  describe('evict without retained content', () => {
    it('discards content when retainEvictedContent is false', () => {
      const { store } = createTestHarness(false);
      store.add('content to discard', { id: 'nrc-1' });
      store.evict('nrc-1');
      const evicted = store.getEvictedSegments();
      expect(evicted).toHaveLength(1);
      // Content should be empty or placeholder when not retained
      expect(evicted[0]!.content).toBe('');
    });
  });

  describe('position tracking after evict and restore', () => {
    it('restored segment returns to original position in ordered list', () => {
      const { store } = createTestHarness();
      store.add('first segment', { id: 'pos-1' });
      store.add('second segment', { id: 'pos-2' });
      store.add('third segment', { id: 'pos-3' });

      store.evict('pos-2');
      const withoutSecond = store.getOrderedActiveSegments();
      expect(withoutSecond.map(s => s.id)).toEqual(['pos-1', 'pos-3']);

      store.restore('pos-2');
      const restored = store.getOrderedActiveSegments();
      expect(restored.map(s => s.id)).toEqual(['pos-1', 'pos-2', 'pos-3']);
    });
  });

  describe('clear (cl-spec-015 §4.1)', () => {
    it('empties active, evicted, and group maps', () => {
      const { store } = createTestHarness();
      store.add('a', { id: 'seg-a' });
      store.add('b', { id: 'seg-b' });
      store.evict('seg-b');
      store.add('c', { id: 'seg-c' });
      store.createGroup('g-1', ['seg-a', 'seg-c']);

      expect(store.segmentCount).toBeGreaterThan(0);
      expect(store.getEvictedSegments().length).toBeGreaterThan(0);
      expect(store.listGroups()).toHaveLength(1);

      store.clear();

      expect(store.segmentCount).toBe(0);
      expect(store.getEvictedSegments()).toEqual([]);
      expect(store.listGroups()).toEqual([]);
      expect(store.getOrderedActiveSegments()).toEqual([]);
    });

    it('store remains functional after clear (can add new segments)', () => {
      const { store } = createTestHarness();
      store.add('original', { id: 'seg-1' });
      store.clear();

      const result = store.add('post-clear', { id: 'seg-new' });
      expect(isSegment(result)).toBe(true);
      expect(store.segmentCount).toBe(1);
    });
  });
});
