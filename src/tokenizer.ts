/**
 * Tokenization subsystem — provider interface, approximate provider, token cache, capacity reporting.
 * @see cl-spec-006
 */

import type {
  TokenizerProvider,
  TokenizerMetadata,
  CapacityReport,
  Segment,
} from './types.js';
import { fnv1a } from './utils/hash.js';
import { LruCache } from './utils/lru-cache.js';

// ─── Approximate Provider ─────────────────────────────────────────

const CJK_RANGES: [number, number][] = [
  [0x4e00, 0x9fff],   // CJK Unified Ideographs
  [0x3400, 0x4dbf],   // CJK Extension A
  [0xf900, 0xfaff],   // CJK Compatibility Ideographs
  [0x2e80, 0x2eff],   // CJK Radicals Supplement
  [0x3000, 0x303f],   // CJK Symbols and Punctuation
  [0x31f0, 0x31ff],   // Katakana Phonetic Extensions
  [0x3200, 0x32ff],   // Enclosed CJK Letters
  [0x3300, 0x33ff],   // CJK Compatibility
  [0xff00, 0xffef],   // Halfwidth and Fullwidth Forms
];

function isCjk(code: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

function approximateCount(content: string): number {
  if (content.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code <= 0x7f) {
      // ASCII
      if (
        (code >= 0x30 && code <= 0x39) || // 0-9
        (code >= 0x41 && code <= 0x5a) || // A-Z
        (code >= 0x61 && code <= 0x7a)    // a-z
      ) {
        sum += 0.25;
      } else if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        // whitespace: 0
      } else {
        sum += 0.50;
      }
    } else if (isCjk(code)) {
      sum += 1.0;
    } else {
      sum += 0.35;
    }
  }

  return Math.max(1, Math.ceil(sum));
}

/** @see cl-spec-006 §4 */
export const APPROXIMATE_PROVIDER: TokenizerProvider = {
  count: approximateCount,
};

export const APPROXIMATE_METADATA: TokenizerMetadata = {
  name: 'approximate',
  accuracy: 'approximate',
  modelFamily: null,
  errorBound: 0.15,
};

// ─── Tokenizer Service ────────────────────────────────────────────

export interface TokenizerDeps {
  getActiveSegments(): Iterable<Segment>;
  setSegmentTokenCount(id: string, tokenCount: number): void;
}

export class Tokenizer {
  private provider: TokenizerProvider;
  private metadata: TokenizerMetadata;
  private cache: LruCache<string, number>;

  constructor(
    provider: TokenizerProvider | 'approximate',
    metadata: TokenizerMetadata | undefined,
    cacheSize: number,
  ) {
    this.cache = new LruCache(cacheSize);

    if (provider === 'approximate') {
      this.provider = APPROXIMATE_PROVIDER;
      this.metadata = APPROXIMATE_METADATA;
    } else {
      this.provider = provider;
      this.metadata = metadata ?? {
        name: 'custom',
        accuracy: 'exact',
        modelFamily: null,
        errorBound: null,
      };
    }
  }

  count(content: string, contentHash?: number): number {
    const hash = contentHash ?? fnv1a(content);
    const cacheKey = `${hash}:${this.metadata.name}`;

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = this.provider.count(content);
    this.cache.set(cacheKey, result);
    return result;
  }

  countBatch(contents: string[], contentHashes?: number[]): number[] {
    if (this.provider.countBatch !== undefined) {
      // Check cache first, batch-count only uncached
      const results: number[] = new Array(contents.length);
      const uncachedIndices: number[] = [];
      const uncachedContents: string[] = [];

      for (let i = 0; i < contents.length; i++) {
        const hash = contentHashes?.[i] ?? fnv1a(contents[i]!);
        const cacheKey = `${hash}:${this.metadata.name}`;
        const cached = this.cache.get(cacheKey);
        if (cached !== undefined) {
          results[i] = cached;
        } else {
          uncachedIndices.push(i);
          uncachedContents.push(contents[i]!);
        }
      }

      if (uncachedContents.length > 0) {
        const counted = this.provider.countBatch(uncachedContents);
        for (let j = 0; j < uncachedIndices.length; j++) {
          const idx = uncachedIndices[j]!;
          const val = counted[j]!;
          results[idx] = val;
          const hash = contentHashes?.[idx] ?? fnv1a(contents[idx]!);
          this.cache.set(`${hash}:${this.metadata.name}`, val);
        }
      }

      return results;
    }

    // Fallback: serial count
    return contents.map((c, i) => this.count(c, contentHashes?.[i]));
  }

  switchProvider(
    provider: TokenizerProvider | 'approximate',
    metadata: TokenizerMetadata | undefined,
    deps: TokenizerDeps,
  ): { oldName: string; newName: string } {
    const oldName = this.metadata.name;

    if (provider === 'approximate') {
      this.provider = APPROXIMATE_PROVIDER;
      this.metadata = APPROXIMATE_METADATA;
    } else {
      this.provider = provider;
      this.metadata = metadata ?? {
        name: 'custom',
        accuracy: 'exact',
        modelFamily: null,
        errorBound: null,
      };
    }

    // Clear cache and recount all active segments. Keep the LruCache instance
    // (and its current maxSize) — preserves any setCacheSize call the caller
    // made before the provider switch (cl-spec-006 §5.6, cl-spec-007 §8.9).
    this.cache.clear();

    const segments = [...deps.getActiveSegments()];
    const contents = segments.map(s => s.content);
    const counts = this.countBatch(contents);

    for (let i = 0; i < segments.length; i++) {
      deps.setSegmentTokenCount(segments[i]!.id, counts[i]!);
    }

    return { oldName, newName: this.metadata.name };
  }

  computeCapacity(
    capacity: number,
    activeSegments: Iterable<Segment>,
  ): CapacityReport {
    let totalActiveTokens = 0;
    let pinnedTokens = 0;
    let seedTokens = 0;

    for (const seg of activeSegments) {
      totalActiveTokens += seg.tokenCount;
      if (seg.protection === 'pinned') {
        pinnedTokens += seg.tokenCount;
      } else if (seg.protection === 'seed') {
        seedTokens += seg.tokenCount;
      }
    }

    return {
      capacity,
      totalActiveTokens,
      utilization: capacity > 0 ? totalActiveTokens / capacity : 0,
      headroom: capacity - totalActiveTokens,
      pinnedTokens,
      seedTokens,
      managedTokens: totalActiveTokens - pinnedTokens,
      availableCapacity: capacity - pinnedTokens,
    };
  }

  getInfo(): TokenizerMetadata {
    return { ...this.metadata };
  }

  /**
   * Empty the token-count cache. Used by the teardown orchestrator (step 4)
   * and the public clearCaches API (cl-spec-007 §8.9.1). The tokenizer
   * remains functional — subsequent count() calls recompute from the active
   * provider and repopulate the cache.
   * @see cl-spec-015 §4.1, cl-spec-006 §5.6
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Resize the token-count cache at runtime. Drops least-recently-used
   * entries on shrink. Setting size to 0 disables the cache.
   * @returns Number of entries evicted by the resize.
   * @see cl-spec-006 §5.6, cl-spec-007 §8.9.2
   */
  setCacheSize(size: number): number {
    return this.cache.resize(size);
  }

  /** Current number of cache entries — used by ContextLens.getMemoryUsage. */
  getEntryCount(): number {
    return this.cache.size;
  }

  /** Configured maximum entries — used by ContextLens.getMemoryUsage. */
  getMaxEntries(): number {
    return this.cache.maxEntries;
  }
}
