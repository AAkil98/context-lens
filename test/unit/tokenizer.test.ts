import { describe, it, expect, vi } from 'vitest';
import {
  APPROXIMATE_PROVIDER,
  APPROXIMATE_METADATA,
  Tokenizer,
} from '../../src/tokenizer.js';
import type { TokenizerProvider, TokenizerMetadata, Segment } from '../../src/types.js';
import type { TokenizerDeps } from '../../src/tokenizer.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeSegment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: 'seg-1',
    content: 'hello world',
    tokenCount: 10,
    createdAt: 1000,
    updatedAt: 1000,
    protection: 'default',
    importance: 0.5,
    state: 'active',
    origin: null,
    tags: [],
    groupId: null,
    ...overrides,
  };
}

function makeMockProvider(countFn?: (content: string) => number): TokenizerProvider {
  return {
    count: countFn ?? ((content: string) => content.length),
  };
}

function makeMockProviderWithBatch(
  countFn: (content: string) => number,
  countBatchFn: (contents: string[]) => number[],
): TokenizerProvider {
  return {
    count: countFn,
    countBatch: countBatchFn,
  };
}

function makeMockDeps(segments: Segment[]): TokenizerDeps & { setCalls: [string, number][] } {
  const setCalls: [string, number][] = [];
  return {
    getActiveSegments: () => segments,
    setSegmentTokenCount: (id: string, count: number) => {
      setCalls.push([id, count]);
    },
    setCalls,
  };
}

// ─── Approximate Provider ────────────────────────────────────────

describe('APPROXIMATE_PROVIDER', () => {
  const { count } = APPROXIMATE_PROVIDER;

  it('returns 0 for empty string', () => {
    expect(count('')).toBe(0);
  });

  it('returns 1 for pure whitespace (non-empty minimum)', () => {
    // Whitespace contributes 0.0 per char, but minimum is 1 for non-empty
    expect(count(' ')).toBe(1);
    expect(count('   ')).toBe(1);
    expect(count('\t')).toBe(1);
    expect(count('\n')).toBe(1);
    expect(count('\r')).toBe(1);
    expect(count(' \t\n\r ')).toBe(1);
  });

  it('counts ASCII letters at 0.25 per char', () => {
    // 4 letters * 0.25 = 1.0 => ceil(1.0) = 1
    expect(count('abcd')).toBe(1);
    // 5 letters * 0.25 = 1.25 => ceil(1.25) = 2
    expect(count('abcde')).toBe(2);
    // 8 letters * 0.25 = 2.0 => ceil(2.0) = 2
    expect(count('abcdefgh')).toBe(2);
  });

  it('counts ASCII digits at 0.25 per char', () => {
    // 4 digits * 0.25 = 1.0 => ceil(1.0) = 1
    expect(count('1234')).toBe(1);
    // 7 digits * 0.25 = 1.75 => ceil(1.75) = 2
    expect(count('1234567')).toBe(2);
  });

  it('counts ASCII punctuation at 0.50 per char', () => {
    // 1 punct * 0.50 = 0.50 => ceil(0.50) = 1
    expect(count('!')).toBe(1);
    // 2 punct * 0.50 = 1.0 => ceil(1.0) = 1
    expect(count('!?')).toBe(1);
    // 3 punct * 0.50 = 1.5 => ceil(1.5) = 2
    expect(count('!?.')).toBe(2);
    // 5 punct * 0.50 = 2.5 => ceil(2.5) = 3
    expect(count('!?.:;')).toBe(3);
  });

  it('counts CJK ideographs at 1.00 per char', () => {
    // U+4E00..U+9FFF range
    expect(count('\u4e00')).toBe(1);
    expect(count('\u4e00\u4e01\u4e02')).toBe(3);
    expect(count('\u6d4b\u8bd5')).toBe(2); // common Chinese chars
  });

  it('counts other Unicode at 0.35 per char', () => {
    // Accented letters like e-acute (U+00E9) are non-ASCII, non-CJK => 0.35
    // 3 chars * 0.35 = 1.05 => ceil(1.05) = 2
    expect(count('\u00e9\u00e9\u00e9')).toBe(2);
    // 1 char * 0.35 = 0.35 => ceil(0.35) = 1 (but also >= 1 minimum)
    expect(count('\u00e9')).toBe(1);
  });

  it('handles mixed content correctly', () => {
    // "Hello! " => 5 letters * 0.25 + 1 punct * 0.50 + 1 space * 0.0
    //           => 1.25 + 0.50 + 0.00 = 1.75 => ceil(1.75) = 2
    expect(count('Hello! ')).toBe(2);

    // "abc\u4e00" => 3 letters * 0.25 + 1 CJK * 1.0 = 0.75 + 1.0 = 1.75 => ceil = 2
    expect(count('abc\u4e00')).toBe(2);

    // "test!!!" => 4 letters * 0.25 + 3 punct * 0.50 = 1.0 + 1.5 = 2.5 => ceil = 3
    expect(count('test!!!')).toBe(3);
  });

  it('minimum is 1 for any non-empty string', () => {
    // Single space: sum = 0, but max(1, ceil(0)) => max(1, 0) = 1
    expect(count(' ')).toBe(1);
    // Single letter: 0.25 => ceil(0.25) = 1, max(1, 1) = 1
    expect(count('a')).toBe(1);
  });
});

describe('APPROXIMATE_METADATA', () => {
  it('has expected fields', () => {
    expect(APPROXIMATE_METADATA).toEqual({
      name: 'approximate',
      accuracy: 'approximate',
      modelFamily: null,
      errorBound: 0.15,
    });
  });
});

// ─── Tokenizer.count() ──────────────────────────────────────────

describe('Tokenizer.count()', () => {
  it('delegates to the provider for uncached content', () => {
    const countFn = vi.fn((content: string) => content.length * 2);
    const provider = makeMockProvider(countFn);
    const tok = new Tokenizer(provider, undefined, 100);

    const result = tok.count('hello');
    expect(result).toBe(10);
    expect(countFn).toHaveBeenCalledWith('hello');
    expect(countFn).toHaveBeenCalledTimes(1);
  });

  it('returns cached result on second call with same content', () => {
    const countFn = vi.fn((content: string) => content.length);
    const provider = makeMockProvider(countFn);
    const tok = new Tokenizer(provider, undefined, 100);

    const first = tok.count('hello');
    const second = tok.count('hello');

    expect(first).toBe(second);
    expect(countFn).toHaveBeenCalledTimes(1);
  });

  it('uses contentHash when provided for cache keying', () => {
    const countFn = vi.fn((_content: string) => 42);
    const provider = makeMockProvider(countFn);
    const tok = new Tokenizer(provider, undefined, 100);

    tok.count('hello', 12345);
    const second = tok.count('different content', 12345);

    // Same hash => cache hit, provider not called again
    expect(second).toBe(42);
    expect(countFn).toHaveBeenCalledTimes(1);
  });

  it('constructs with "approximate" shorthand', () => {
    const tok = new Tokenizer('approximate', undefined, 100);
    // "Hello" => 5 letters * 0.25 = 1.25 => ceil = 2
    expect(tok.count('Hello')).toBe(2);
  });

  it('uses default metadata for custom provider without metadata', () => {
    const provider = makeMockProvider();
    const tok = new Tokenizer(provider, undefined, 100);
    const info = tok.getInfo();
    expect(info.name).toBe('custom');
    expect(info.accuracy).toBe('exact');
    expect(info.modelFamily).toBeNull();
    expect(info.errorBound).toBeNull();
  });
});

// ─── Tokenizer.countBatch() ─────────────────────────────────────

describe('Tokenizer.countBatch()', () => {
  it('uses provider.countBatch when available', () => {
    const countFn = vi.fn((content: string) => content.length);
    const countBatchFn = vi.fn((contents: string[]) => contents.map(c => c.length * 10));
    const provider = makeMockProviderWithBatch(countFn, countBatchFn);
    const tok = new Tokenizer(provider, undefined, 100);

    const results = tok.countBatch(['aa', 'bbb']);
    expect(results).toEqual([20, 30]);
    expect(countBatchFn).toHaveBeenCalledTimes(1);
    expect(countFn).not.toHaveBeenCalled();
  });

  it('falls back to serial count() when provider has no countBatch', () => {
    const countFn = vi.fn((content: string) => content.length);
    const provider = makeMockProvider(countFn);
    const tok = new Tokenizer(provider, undefined, 100);

    const results = tok.countBatch(['aa', 'bbb', 'c']);
    expect(results).toEqual([2, 3, 1]);
    expect(countFn).toHaveBeenCalledTimes(3);
  });

  it('uses cache for already-counted items in batch (with countBatch)', () => {
    const countFn = vi.fn((content: string) => content.length);
    const countBatchFn = vi.fn((contents: string[]) => contents.map(c => c.length));
    const provider = makeMockProviderWithBatch(countFn, countBatchFn);
    const tok = new Tokenizer(provider, undefined, 100);

    // Pre-populate cache via count()
    tok.count('aa');

    // Now batch: 'aa' should be cached, 'bbb' should go to countBatch
    const results = tok.countBatch(['aa', 'bbb']);
    expect(results).toEqual([2, 3]);
    // countBatch should only be called with the uncached item
    expect(countBatchFn).toHaveBeenCalledWith(['bbb']);
  });

  it('skips countBatch call when all items are cached', () => {
    const countFn = vi.fn((content: string) => content.length);
    const countBatchFn = vi.fn((contents: string[]) => contents.map(c => c.length));
    const provider = makeMockProviderWithBatch(countFn, countBatchFn);
    const tok = new Tokenizer(provider, undefined, 100);

    // Pre-populate cache
    tok.count('aa');
    tok.count('bbb');

    const results = tok.countBatch(['aa', 'bbb']);
    expect(results).toEqual([2, 3]);
    expect(countBatchFn).not.toHaveBeenCalled();
  });

  it('falls back serial count uses cache too', () => {
    const countFn = vi.fn((content: string) => content.length);
    const provider = makeMockProvider(countFn);
    const tok = new Tokenizer(provider, undefined, 100);

    // Pre-populate cache
    tok.count('aa');

    // countFn was called once for 'aa'
    expect(countFn).toHaveBeenCalledTimes(1);

    const results = tok.countBatch(['aa', 'bbb']);
    expect(results).toEqual([2, 3]);
    // Only 'bbb' triggers a new provider call (via serial fallback count())
    expect(countFn).toHaveBeenCalledTimes(2);
  });

  it('caches results from countBatch for future count() calls', () => {
    const countFn = vi.fn((content: string) => content.length);
    const countBatchFn = vi.fn((contents: string[]) => contents.map(c => c.length));
    const provider = makeMockProviderWithBatch(countFn, countBatchFn);
    const tok = new Tokenizer(provider, undefined, 100);

    tok.countBatch(['aa', 'bbb']);

    // These should all be cache hits now
    const r1 = tok.count('aa');
    const r2 = tok.count('bbb');
    expect(r1).toBe(2);
    expect(r2).toBe(3);
    // countBatch called once, count never directly called
    expect(countBatchFn).toHaveBeenCalledTimes(1);
    expect(countFn).not.toHaveBeenCalled();
  });
});

// ─── Tokenizer.switchProvider() ─────────────────────────────────

describe('Tokenizer.switchProvider()', () => {
  it('clears cache and recounts all active segments', () => {
    const oldCountFn = vi.fn((_content: string) => 10);
    const newCountFn = vi.fn((content: string) => content.length * 3);
    const oldProvider = makeMockProvider(oldCountFn);
    const newProvider = makeMockProvider(newCountFn);
    const newMeta: TokenizerMetadata = {
      name: 'new-provider',
      accuracy: 'exact',
      modelFamily: 'gpt-4',
      errorBound: null,
    };

    const seg1 = makeSegment({ id: 'seg-1', content: 'hello', tokenCount: 10 });
    const seg2 = makeSegment({ id: 'seg-2', content: 'world', tokenCount: 10 });
    const deps = makeMockDeps([seg1, seg2]);

    const tok = new Tokenizer(oldProvider, undefined, 100);

    // Pre-populate the cache
    tok.count('hello');
    tok.count('world');
    expect(oldCountFn).toHaveBeenCalledTimes(2);

    const result = tok.switchProvider(newProvider, newMeta, deps);

    expect(result.oldName).toBe('custom');
    expect(result.newName).toBe('new-provider');

    // Segments should have been recounted with new provider
    expect(deps.setCalls).toEqual([
      ['seg-1', 15], // 'hello'.length * 3 = 15
      ['seg-2', 15], // 'world'.length * 3 = 15
    ]);

    // After switch, old cache is gone; count uses new provider
    expect(tok.count('hello')).toBe(15);
    expect(tok.getInfo().name).toBe('new-provider');
  });

  it('switches to approximate provider with string shorthand', () => {
    const customCount = vi.fn((_content: string) => 99);
    const customProvider = makeMockProvider(customCount);
    const deps = makeMockDeps([]);

    const tok = new Tokenizer(customProvider, undefined, 100);
    const result = tok.switchProvider('approximate', undefined, deps);

    expect(result.oldName).toBe('custom');
    expect(result.newName).toBe('approximate');
    expect(tok.getInfo().name).toBe('approximate');
    expect(tok.getInfo().accuracy).toBe('approximate');
  });

  it('handles empty segment list without error', () => {
    const provider = makeMockProvider();
    const deps = makeMockDeps([]);
    const tok = new Tokenizer(provider, undefined, 100);

    const result = tok.switchProvider('approximate', undefined, deps);

    expect(result.newName).toBe('approximate');
    expect(deps.setCalls).toEqual([]);
  });
});

// ─── Tokenizer.computeCapacity() ────────────────────────────────

describe('Tokenizer.computeCapacity()', () => {
  it('computes all 8 CapacityReport fields correctly', () => {
    const tok = new Tokenizer('approximate', undefined, 100);

    const segments = [
      makeSegment({ id: 's1', tokenCount: 100, protection: 'pinned' }),
      makeSegment({ id: 's2', tokenCount: 200, protection: 'seed' }),
      makeSegment({ id: 's3', tokenCount: 300, protection: 'default' }),
      makeSegment({ id: 's4', tokenCount: 150, protection: 'priority(5)' }),
    ];

    const report = tok.computeCapacity(1000, segments);

    expect(report.capacity).toBe(1000);
    expect(report.totalActiveTokens).toBe(750); // 100 + 200 + 300 + 150
    expect(report.utilization).toBeCloseTo(0.75); // 750 / 1000
    expect(report.headroom).toBe(250); // 1000 - 750
    expect(report.pinnedTokens).toBe(100);
    expect(report.seedTokens).toBe(200);
    expect(report.managedTokens).toBe(650); // 750 - 100
    expect(report.availableCapacity).toBe(900); // 1000 - 100
  });

  it('handles zero capacity', () => {
    const tok = new Tokenizer('approximate', undefined, 100);
    const report = tok.computeCapacity(0, []);

    expect(report.capacity).toBe(0);
    expect(report.totalActiveTokens).toBe(0);
    expect(report.utilization).toBe(0);
    expect(report.headroom).toBe(0);
    expect(report.pinnedTokens).toBe(0);
    expect(report.seedTokens).toBe(0);
    expect(report.managedTokens).toBe(0);
    expect(report.availableCapacity).toBe(0);
  });

  it('handles empty segment list', () => {
    const tok = new Tokenizer('approximate', undefined, 100);
    const report = tok.computeCapacity(5000, []);

    expect(report.totalActiveTokens).toBe(0);
    expect(report.utilization).toBe(0);
    expect(report.headroom).toBe(5000);
    expect(report.pinnedTokens).toBe(0);
    expect(report.seedTokens).toBe(0);
    expect(report.managedTokens).toBe(0);
    expect(report.availableCapacity).toBe(5000);
  });

  it('computes negative headroom when over capacity', () => {
    const tok = new Tokenizer('approximate', undefined, 100);
    const segments = [
      makeSegment({ id: 's1', tokenCount: 600, protection: 'default' }),
      makeSegment({ id: 's2', tokenCount: 600, protection: 'default' }),
    ];

    const report = tok.computeCapacity(1000, segments);

    expect(report.totalActiveTokens).toBe(1200);
    expect(report.headroom).toBe(-200);
    expect(report.utilization).toBeCloseTo(1.2);
  });

  it('computes correctly with all pinned segments', () => {
    const tok = new Tokenizer('approximate', undefined, 100);
    const segments = [
      makeSegment({ id: 's1', tokenCount: 300, protection: 'pinned' }),
      makeSegment({ id: 's2', tokenCount: 200, protection: 'pinned' }),
    ];

    const report = tok.computeCapacity(1000, segments);

    expect(report.pinnedTokens).toBe(500);
    expect(report.seedTokens).toBe(0);
    expect(report.managedTokens).toBe(0); // 500 - 500
    expect(report.availableCapacity).toBe(500); // 1000 - 500
  });

  it('accepts an iterable (generator) for activeSegments', () => {
    const tok = new Tokenizer('approximate', undefined, 100);
    const segments = [
      makeSegment({ id: 's1', tokenCount: 50, protection: 'default' }),
      makeSegment({ id: 's2', tokenCount: 50, protection: 'seed' }),
    ];

    function* gen(): Iterable<Segment> {
      yield* segments;
    }

    const report = tok.computeCapacity(200, gen());

    expect(report.totalActiveTokens).toBe(100);
    expect(report.seedTokens).toBe(50);
    expect(report.pinnedTokens).toBe(0);
  });
});

// ─── Tokenizer.getInfo() ────────────────────────────────────────

describe('Tokenizer.getInfo()', () => {
  it('returns approximate metadata for approximate provider', () => {
    const tok = new Tokenizer('approximate', undefined, 100);
    const info = tok.getInfo();

    expect(info).toEqual({
      name: 'approximate',
      accuracy: 'approximate',
      modelFamily: null,
      errorBound: 0.15,
    });
  });

  it('returns custom metadata when provided', () => {
    const meta: TokenizerMetadata = {
      name: 'tiktoken-gpt4',
      accuracy: 'exact',
      modelFamily: 'gpt-4',
      errorBound: null,
    };
    const tok = new Tokenizer(makeMockProvider(), meta, 100);
    const info = tok.getInfo();

    expect(info).toEqual(meta);
  });

  it('returns a defensive copy (not the internal reference)', () => {
    const tok = new Tokenizer('approximate', undefined, 100);
    const info1 = tok.getInfo();
    const info2 = tok.getInfo();

    // Equal but not the same reference
    expect(info1).toEqual(info2);
    expect(info1).not.toBe(info2);

    // Mutating returned object does not affect internal state
    info1.name = 'mutated';
    expect(tok.getInfo().name).toBe('approximate');
  });

  // ── Phase C: Non-ASCII branch coverage ─────────────────────

  describe('Non-ASCII character classes', () => {
    it('CJK extension B (U+20000+) counted as non-zero', () => {
      const result = APPROXIMATE_PROVIDER.count('\u{20000}\u{20001}');
      expect(result).toBeGreaterThanOrEqual(1);
    });

    it('emoji counted as non-zero', () => {
      const result = APPROXIMATE_PROVIDER.count('\u{1F600}\u{1F389}');
      expect(result).toBeGreaterThanOrEqual(1);
    });

    it('combining diacritics processed correctly', () => {
      const result = APPROXIMATE_PROVIDER.count('cafe\u0301');
      expect(result).toBeGreaterThanOrEqual(1);
    });

    it('mixed ASCII + CJK + emoji produces reasonable token count', () => {
      const text = 'Hello \u4E16\u754C \u{1F600}';
      const result = APPROXIMATE_PROVIDER.count(text);
      expect(result).toBeGreaterThanOrEqual(3);
      expect(result).toBeLessThanOrEqual(10);
    });

    it('Hangul syllables counted as non-zero', () => {
      const result = APPROXIMATE_PROVIDER.count('\uAC00\uAC01\uAC02');
      expect(result).toBeGreaterThanOrEqual(1);
    });

    it('Arabic text counted as non-zero', () => {
      const result = APPROXIMATE_PROVIDER.count('\u0645\u0631\u062D\u0628\u0627');
      expect(result).toBeGreaterThanOrEqual(1);
    });

    it('whitespace-only returns 1 (min for non-empty)', () => {
      const result = APPROXIMATE_PROVIDER.count('   \t  \n  ');
      expect(result).toBe(1);
    });

    it('provider switch triggers recount on all active segments', () => {
      const segs = [
        makeSegment({ id: 'ps-1', content: 'hello world' }),
        makeSegment({ id: 'ps-2', content: 'another segment' }),
      ];
      const counts: Record<string, number> = {};
      const deps: TokenizerDeps = {
        getActiveSegments: () => segs[Symbol.iterator](),
        setSegmentTokenCount: (id: string, tc: number) => { counts[id] = tc; },
      };

      const tok = new Tokenizer('approximate', undefined, 256);
      const custom = { count: () => 42 };
      tok.switchProvider(custom, { name: 'fixed', accuracy: 'exact' as const, modelFamily: null, errorBound: null }, deps);

      expect(counts['ps-1']).toBe(42);
      expect(counts['ps-2']).toBe(42);
    });
  });

  describe('clearCache (cl-spec-015 §4.1)', () => {
    it('empties the cache; subsequent count() recomputes from the provider', () => {
      let providerCalls = 0;
      const provider: TokenizerProvider = { count: () => { providerCalls++; return 7; } };
      const tok = new Tokenizer(
        provider,
        { name: 'p', accuracy: 'exact', modelFamily: null, errorBound: null },
        256,
      );

      tok.count('hello');
      expect(providerCalls).toBe(1);
      tok.count('hello');
      expect(providerCalls).toBe(1);  // cached — no new provider call

      tok.clearCache();
      tok.count('hello');
      expect(providerCalls).toBe(2);  // recomputed
    });

    it('is idempotent and the tokenizer remains functional after clearCache', () => {
      const tok = new Tokenizer('approximate', undefined, 256);
      tok.count('seed-content');
      expect(() => {
        tok.clearCache();
        tok.clearCache();
        tok.clearCache();
      }).not.toThrow();
      expect(tok.count('post-clear')).toBeGreaterThan(0);
    });
  });

  // ── Memory management hooks (cl-spec-007 §8.9, cl-spec-006 §5.6) ─

  describe('Memory management hooks', () => {
    it('getEntryCount + getMaxEntries reflect current cache state', () => {
      const tok = new Tokenizer('approximate', undefined, 100);
      expect(tok.getEntryCount()).toBe(0);
      expect(tok.getMaxEntries()).toBe(100);
      tok.count('one');
      tok.count('two');
      expect(tok.getEntryCount()).toBe(2);
    });

    it('setCacheSize shrinks and returns evicted count', () => {
      const tok = new Tokenizer('approximate', undefined, 10);
      for (let i = 0; i < 10; i++) tok.count(`fragment-${i}`);
      expect(tok.getEntryCount()).toBe(10);

      const evicted = tok.setCacheSize(3);
      expect(evicted).toBe(7);
      expect(tok.getEntryCount()).toBe(3);
      expect(tok.getMaxEntries()).toBe(3);
    });

    it('setCacheSize(0) disables the cache; count() still returns correct results', () => {
      const tok = new Tokenizer('approximate', undefined, 100);
      tok.count('warmup');
      tok.setCacheSize(0);
      expect(tok.getEntryCount()).toBe(0);
      expect(tok.getMaxEntries()).toBe(0);

      expect(tok.count('post-disable')).toBeGreaterThan(0);
      expect(tok.getEntryCount()).toBe(0);
    });
  });
});
