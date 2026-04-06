/**
 * Segment and group management — CRUD, protection, lifecycle, position tracking, dedup.
 * @see cl-spec-001
 */

import type {
  Segment,
  Group,
  ProtectionLevel,
  EvictionRecord,
  CompactionRecord,
} from './types.js';
import {
  ValidationError,
  SegmentNotFoundError,
  GroupNotFoundError,
  DuplicateIdError,
  InvalidStateError,
  ProtectionError,
  MembershipError,
  CompactionError,
  SplitError,
  RestoreError,
} from './errors.js';
import type { EventEmitter, ContextLensEventMap } from './events.js';
import type { Tokenizer } from './tokenizer.js';
import { fnv1a } from './utils/hash.js';

// ─── Internal Types ───────────────────────────────────────────────

interface InternalSegment extends Segment {
  position: number;
  contentHash: number;
}

interface InternalGroup {
  groupId: string;
  members: string[];
  protection: ProtectionLevel;
  importance: number;
  origin: string | null;
  tags: string[];
  createdAt: number;
  state: 'active' | 'dissolved';
}

// ─── Public Option Types ──────────────────────────────────────────

export interface AddOptions {
  id?: string;
  importance?: number;
  protection?: ProtectionLevel;
  origin?: string;
  tags?: string[];
  groupId?: string;
}

export interface UpdateChanges {
  content?: string;
  importance?: number;
  protection?: ProtectionLevel;
  origin?: string;
  tags?: string[];
}

export interface RestoreOptions {
  content?: string;
  importance?: number;
  protection?: ProtectionLevel;
}

export interface CreateGroupOptions {
  protection?: ProtectionLevel;
  importance?: number;
  origin?: string;
  tags?: string[];
}

export interface DuplicateSignal {
  existingId: string;
  contentHash: number;
  isDuplicate: true;
}

// ─── Helpers ──────────────────────────────────────��───────────────

const ID_REGEX = /^[a-zA-Z0-9._:\-]{1,256}$/;

function validateCallerId(id: string): void {
  if (!ID_REGEX.test(id)) {
    throw new ValidationError(
      `Invalid segment ID: must be 1–256 chars of [a-zA-Z0-9._:-]`,
      { id },
    );
  }
}

function protectionRank(p: ProtectionLevel): number {
  if (p === 'default') return 0;
  if (p === 'pinned') return 10002;
  if (p === 'seed') return 10001;
  const m = /^priority\((\d+)\)$/.exec(p);
  if (m) return 1 + parseInt(m[1]!, 10);
  return 0;
}

function maxProtection(levels: ProtectionLevel[]): ProtectionLevel {
  let best: ProtectionLevel = 'default';
  let bestRank = 0;
  for (const p of levels) {
    const r = protectionRank(p);
    if (r > bestRank) {
      best = p;
      bestRank = r;
    }
  }
  return best;
}

function toPublicGroup(g: InternalGroup, tokenCount: number, coherence: number): Group {
  return {
    groupId: g.groupId,
    members: g.members,
    protection: g.protection,
    importance: g.importance,
    origin: g.origin,
    tags: g.tags,
    createdAt: g.createdAt,
    state: g.state,
    tokenCount,
    coherence,
  };
}

// ─── SegmentStore ─────────────────────────────────────────────────

export class SegmentStore {
  private readonly active = new Map<string, InternalSegment>();
  private readonly evicted = new Map<string, InternalSegment>();
  private readonly groups = new Map<string, InternalGroup>();
  private nextPosition = 0;
  private readonly tokenizer: Tokenizer;
  private readonly emitter: EventEmitter<ContextLensEventMap>;
  private retainEvictedContent: boolean;

  constructor(
    tokenizer: Tokenizer,
    emitter: EventEmitter<ContextLensEventMap>,
    retainEvictedContent: boolean,
  ) {
    this.tokenizer = tokenizer;
    this.emitter = emitter;
    this.retainEvictedContent = retainEvictedContent;
  }

  // ── Segment Operations ────────────────────────────────────────

  add(content: string, options?: AddOptions): Segment | DuplicateSignal {
    if (content.length === 0) {
      throw new ValidationError('Segment content must be non-empty');
    }

    const now = Date.now();
    const contentHash = fnv1a(content);
    const importance = options?.importance ?? 0.5;
    const protection = options?.protection ?? 'default';

    if (importance < 0 || importance > 1) {
      throw new ValidationError('Importance must be in [0.0, 1.0]', { importance });
    }

    // Resolve ID
    let id: string;
    if (options?.id !== undefined) {
      validateCallerId(options.id);
      if (this.active.has(options.id) || this.evicted.has(options.id)) {
        throw new DuplicateIdError(
          `Segment ID already exists: ${options.id}`,
          { id: options.id },
        );
      }
      id = options.id;
    } else {
      // Auto-generated ID — check for content duplicate
      for (const seg of this.active.values()) {
        if (seg.contentHash === contentHash && seg.content === content) {
          return { existingId: seg.id, contentHash, isDuplicate: true };
        }
      }

      // Generate auto ID, handle hash collision
      const baseId = 'auto:' + contentHash.toString(36);
      if (!this.active.has(baseId) && !this.evicted.has(baseId)) {
        id = baseId;
      } else {
        let suffix = 1;
        while (this.active.has(`${baseId}:${suffix}`) || this.evicted.has(`${baseId}:${suffix}`)) {
          suffix++;
        }
        id = `${baseId}:${suffix}`;
      }
    }

    // Validate group membership
    if (options?.groupId !== undefined) {
      const group = this.groups.get(options.groupId);
      if (group === undefined) {
        throw new GroupNotFoundError(
          `Group not found: ${options.groupId}`,
          { groupId: options.groupId },
        );
      }
      if (group.state === 'dissolved') {
        throw new InvalidStateError(
          `Group is dissolved: ${options.groupId}`,
          { groupId: options.groupId, state: 'dissolved' },
        );
      }
    }

    const tokenCount = this.tokenizer.count(content, contentHash);

    const segment: InternalSegment = {
      id,
      content,
      tokenCount,
      createdAt: now,
      updatedAt: now,
      protection,
      importance,
      state: 'active',
      origin: options?.origin ?? null,
      tags: options?.tags ?? [],
      groupId: options?.groupId ?? null,
      position: this.nextPosition++,
      contentHash,
    };

    this.active.set(id, segment);

    // Add to group if specified
    if (segment.groupId !== null) {
      const group = this.groups.get(segment.groupId)!;
      group.members.push(id);
    }

    this.emitter.emit('segmentAdded', { segment });
    return segment;
  }

  update(id: string, changes: UpdateChanges): Segment {
    const seg = this.requireActive(id);

    if (seg.protection === 'pinned' && changes.content !== undefined) {
      throw new ProtectionError(
        'Cannot update content of pinned segment',
        { id, protection: seg.protection },
      );
    }

    const changedFields: string[] = [];

    if (changes.content !== undefined) {
      seg.content = changes.content;
      seg.contentHash = fnv1a(changes.content);
      seg.tokenCount = this.tokenizer.count(changes.content, seg.contentHash);
      changedFields.push('content');
    }
    if (changes.importance !== undefined) {
      if (changes.importance < 0 || changes.importance > 1) {
        throw new ValidationError('Importance must be in [0.0, 1.0]', { importance: changes.importance });
      }
      seg.importance = changes.importance;
      changedFields.push('importance');
    }
    if (changes.protection !== undefined) {
      seg.protection = changes.protection;
      changedFields.push('protection');
    }
    if (changes.origin !== undefined) {
      seg.origin = changes.origin;
      changedFields.push('origin');
    }
    if (changes.tags !== undefined) {
      seg.tags = changes.tags;
      changedFields.push('tags');
    }

    seg.updatedAt = Date.now();

    this.emitter.emit('segmentUpdated', { segment: seg, changes: changedFields });
    return seg;
  }

  replace(id: string, newContent: string, options?: Partial<Pick<AddOptions, 'importance' | 'protection' | 'origin' | 'tags'>>): Segment {
    if (newContent.length === 0) {
      throw new ValidationError('Replacement content must be non-empty');
    }

    const seg = this.requireActive(id);
    const previousTokenCount = seg.tokenCount;

    seg.content = newContent;
    seg.contentHash = fnv1a(newContent);
    seg.tokenCount = this.tokenizer.count(newContent, seg.contentHash);
    seg.updatedAt = Date.now();

    if (options?.importance !== undefined) seg.importance = options.importance;
    if (options?.protection !== undefined) seg.protection = options.protection;
    if (options?.origin !== undefined) seg.origin = options.origin;
    if (options?.tags !== undefined) seg.tags = options.tags;

    this.emitter.emit('segmentReplaced', { segment: seg, previousTokenCount });
    return seg;
  }

  compact(id: string, summary: string): Segment {
    if (summary.length === 0) {
      throw new ValidationError('Compaction summary must be non-empty');
    }

    const seg = this.requireActive(id);

    if (seg.protection === 'pinned') {
      throw new ProtectionError(
        'Cannot compact pinned segment',
        { id, protection: seg.protection },
      );
    }

    const summaryHash = fnv1a(summary);
    const newTokenCount = this.tokenizer.count(summary, summaryHash);

    if (newTokenCount >= seg.tokenCount) {
      throw new CompactionError(
        `Compacted content must have fewer tokens (${newTokenCount} >= ${seg.tokenCount})`,
        { id, originalTokenCount: seg.tokenCount, compactedTokenCount: newTokenCount },
      );
    }

    const record: CompactionRecord = {
      originalTokenCount: seg.tokenCount,
      compactedTokenCount: newTokenCount,
      compressionRatio: newTokenCount / seg.tokenCount,
      timestamp: Date.now(),
    };

    seg.content = summary;
    seg.contentHash = summaryHash;
    seg.tokenCount = newTokenCount;
    seg.origin = 'summary:compacted';
    seg.updatedAt = record.timestamp;

    this.emitter.emit('segmentCompacted', { segment: seg, record });
    return seg;
  }

  split(id: string, splitFn: (content: string) => string[]): Segment[] {
    const seg = this.requireActive(id);

    if (seg.protection === 'pinned') {
      throw new ProtectionError(
        'Cannot split pinned segment',
        { id, protection: seg.protection },
      );
    }

    const parts = splitFn(seg.content);

    if (parts.length === 0) {
      throw new SplitError('Split function returned empty array', { id });
    }
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.length === 0) {
        throw new SplitError(`Split function returned empty string at index ${i}`, { id, index: i });
      }
    }

    const now = Date.now();
    const parentPosition = seg.position;
    const children: InternalSegment[] = [];

    // Shift positions of subsequent segments to make room
    const shiftAmount = parts.length - 1;
    if (shiftAmount > 0) {
      for (const s of this.active.values()) {
        if (s.position > parentPosition) s.position += shiftAmount;
      }
      for (const s of this.evicted.values()) {
        if (s.position > parentPosition) s.position += shiftAmount;
      }
    }

    for (let i = 0; i < parts.length; i++) {
      const content = parts[i]!;
      const contentHash = fnv1a(content);
      const child: InternalSegment = {
        id: `${id}:${i}`,
        content,
        tokenCount: this.tokenizer.count(content, contentHash),
        createdAt: now,
        updatedAt: now,
        protection: seg.protection,
        importance: seg.importance,
        state: 'active',
        origin: seg.origin,
        tags: [...seg.tags],
        groupId: seg.groupId,
        position: parentPosition + i,
        contentHash,
      };
      children.push(child);
      this.active.set(child.id, child);
    }

    // Remove parent
    this.active.delete(id);

    // Update group membership
    if (seg.groupId !== null) {
      const group = this.groups.get(seg.groupId);
      if (group !== undefined) {
        const idx = group.members.indexOf(id);
        if (idx !== -1) {
          group.members.splice(idx, 1, ...children.map(c => c.id));
        }
      }
    }

    // Adjust nextPosition if needed
    const maxChildPos = parentPosition + parts.length - 1;
    if (maxChildPos >= this.nextPosition) {
      this.nextPosition = maxChildPos + 1;
    }

    this.emitter.emit('segmentSplit', { originalId: id, children });
    return children;
  }

  // ── Lifecycle Operations ──────────────────────────────────────

  evict(id: string, reason = 'manual'): EvictionRecord[] {
    const seg = this.requireActive(id);

    if (seg.protection === 'pinned') {
      throw new ProtectionError('Cannot evict pinned segment', { id });
    }

    // If in a group, evict entire group atomically
    if (seg.groupId !== null) {
      const group = this.groups.get(seg.groupId);
      if (group !== undefined && group.state === 'active') {
        if (group.protection === 'pinned') {
          throw new ProtectionError('Cannot evict segment in pinned group', {
            id, groupId: seg.groupId,
          });
        }
        return this.evictGroup(group, reason);
      }
    }

    return [this.evictSingle(seg, reason)];
  }

  restore(id: string, options?: RestoreOptions): Segment[] {
    const seg = this.evicted.get(id);
    if (seg === undefined) {
      throw new SegmentNotFoundError(`Evicted segment not found: ${id}`, { id });
    }
    if (seg.state !== 'evicted') {
      throw new InvalidStateError(`Segment is not evicted: ${id}`, { id, state: seg.state });
    }

    // If in a group, restore entire group atomically
    if (seg.groupId !== null) {
      const group = this.groups.get(seg.groupId);
      if (group !== undefined && group.state === 'active') {
        return this.restoreGroup(group, options);
      }
    }

    return [this.restoreSingle(seg, options)];
  }

  // ── Group Operations ──────────────────────────────────────────

  createGroup(groupId: string, memberIds: string[], options?: CreateGroupOptions): Group {
    validateCallerId(groupId);

    if (this.groups.has(groupId)) {
      throw new DuplicateIdError(`Group ID already exists: ${groupId}`, { groupId });
    }

    if (memberIds.length === 0) {
      throw new ValidationError('Group must have at least one member', { groupId });
    }

    const members: InternalSegment[] = [];
    for (const mid of memberIds) {
      const seg = this.active.get(mid);
      if (seg === undefined) {
        throw new SegmentNotFoundError(`Member segment not found: ${mid}`, { id: mid, groupId });
      }
      if (seg.groupId !== null) {
        throw new MembershipError(
          `Segment ${mid} already belongs to group ${seg.groupId}`,
          { id: mid, currentGroupId: seg.groupId, requestedGroupId: groupId },
        );
      }
      members.push(seg);
    }

    const protection = options?.protection ?? maxProtection(members.map(m => m.protection));
    const importance = options?.importance ?? Math.max(...members.map(m => m.importance));

    const group: InternalGroup = {
      groupId,
      members: [...memberIds],
      protection,
      importance,
      origin: options?.origin ?? null,
      tags: options?.tags ?? [],
      createdAt: Date.now(),
      state: 'active',
    };

    this.groups.set(groupId, group);

    // Update member groupId
    for (const seg of members) {
      seg.groupId = groupId;
    }

    const tokenCount = members.reduce((sum, s) => sum + s.tokenCount, 0);
    const publicGroup = toPublicGroup(group, tokenCount, 0);

    this.emitter.emit('groupCreated', { group: publicGroup });
    return publicGroup;
  }

  dissolveGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (group === undefined) {
      throw new GroupNotFoundError(`Group not found: ${groupId}`, { groupId });
    }
    if (group.state === 'dissolved') {
      throw new InvalidStateError(`Group already dissolved: ${groupId}`, { groupId });
    }

    const memberIds = [...group.members];

    group.state = 'dissolved';

    // Clear groupId from members (both active and evicted)
    for (const mid of memberIds) {
      const seg = this.active.get(mid) ?? this.evicted.get(mid);
      if (seg !== undefined) {
        seg.groupId = null;
      }
    }

    this.emitter.emit('groupDissolved', { groupId, memberIds });
  }

  // ── Query Methods ─────────────────────────────────────────────

  getSegment(id: string): Segment | undefined {
    return this.active.get(id) ?? this.evicted.get(id);
  }

  getActiveSegment(id: string): Segment | undefined {
    return this.active.get(id);
  }

  getEvictedSegment(id: string): Segment | undefined {
    return this.evicted.get(id);
  }

  getGroup(groupId: string): Group | undefined {
    const group = this.groups.get(groupId);
    if (group === undefined) return undefined;
    const tokenCount = this.computeGroupTokenCount(group);
    return toPublicGroup(group, tokenCount, 0);
  }

  getActiveSegments(): Segment[] {
    return [...this.active.values()];
  }

  getOrderedActiveSegments(): Segment[] {
    return [...this.active.values()].sort((a, b) => a.position - b.position);
  }

  getEvictedSegments(): Segment[] {
    return [...this.evicted.values()];
  }

  listGroups(): Group[] {
    const result: Group[] = [];
    for (const g of this.groups.values()) {
      if (g.state === 'active') {
        const tokenCount = this.computeGroupTokenCount(g);
        result.push(toPublicGroup(g, tokenCount, 0));
      }
    }
    return result;
  }

  get segmentCount(): number {
    return this.active.size;
  }

  get evictedCount(): number {
    return this.evicted.size;
  }

  get groupCount(): number {
    let count = 0;
    for (const g of this.groups.values()) {
      if (g.state === 'active') count++;
    }
    return count;
  }

  /** For Tokenizer.switchProvider — returns active segments as iterable */
  getActiveSegmentIterator(): Iterable<Segment> {
    return this.active.values();
  }

  /** For Tokenizer.switchProvider — updates token count directly */
  setSegmentTokenCount(id: string, tokenCount: number): void {
    const seg = this.active.get(id);
    if (seg !== undefined) seg.tokenCount = tokenCount;
  }

  // ── Internal Helpers ──────────────────────────────────────────

  private requireActive(id: string): InternalSegment {
    const seg = this.active.get(id);
    if (seg === undefined) {
      if (this.evicted.has(id)) {
        throw new InvalidStateError(
          `Segment is evicted: ${id}`,
          { id, state: 'evicted', required: 'active' },
        );
      }
      throw new SegmentNotFoundError(`Segment not found: ${id}`, { id });
    }
    return seg;
  }

  private evictSingle(seg: InternalSegment, reason: string): EvictionRecord {
    const record: EvictionRecord = {
      segmentId: seg.id,
      tokenCount: seg.tokenCount,
      importance: seg.importance,
      protection: seg.protection,
      reason,
      timestamp: Date.now(),
    };

    seg.state = 'evicted';
    if (!this.retainEvictedContent) {
      seg.content = '';
    }

    this.active.delete(seg.id);
    this.evicted.set(seg.id, seg);

    this.emitter.emit('segmentEvicted', { record });
    return record;
  }

  private evictGroup(group: InternalGroup, reason: string): EvictionRecord[] {
    const records: EvictionRecord[] = [];
    for (const mid of group.members) {
      const seg = this.active.get(mid);
      if (seg !== undefined) {
        records.push(this.evictSingle(seg, reason));
      }
    }
    return records;
  }

  private restoreSingle(seg: InternalSegment, options?: RestoreOptions): Segment {
    if (seg.content === '' && (options?.content === undefined)) {
      throw new RestoreError(
        `Content required for restore (was not retained): ${seg.id}`,
        { id: seg.id },
      );
    }

    if (options?.content !== undefined) {
      seg.content = options.content;
      seg.contentHash = fnv1a(options.content);
      seg.tokenCount = this.tokenizer.count(options.content, seg.contentHash);
    } else {
      // Recount with current tokenizer (may have switched)
      seg.tokenCount = this.tokenizer.count(seg.content, seg.contentHash);
    }

    if (options?.importance !== undefined) seg.importance = options.importance;
    if (options?.protection !== undefined) seg.protection = options.protection;

    seg.state = 'active';
    seg.updatedAt = Date.now();

    this.evicted.delete(seg.id);
    this.active.set(seg.id, seg);

    this.emitter.emit('segmentRestored', { segment: seg, fidelity: 1.0 });
    return seg;
  }

  private restoreGroup(group: InternalGroup, options?: RestoreOptions): Segment[] {
    const restored: Segment[] = [];
    for (const mid of group.members) {
      const seg = this.evicted.get(mid);
      if (seg !== undefined) {
        restored.push(this.restoreSingle(seg, options));
      }
    }
    return restored;
  }

  private computeGroupTokenCount(group: InternalGroup): number {
    let total = 0;
    for (const mid of group.members) {
      const seg = this.active.get(mid);
      if (seg !== undefined) total += seg.tokenCount;
    }
    return total;
  }
}
