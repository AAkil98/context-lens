import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingEngine } from '../../src/embedding.js';
import { ProviderError } from '../../src/errors.js';
import type { EmbeddingProvider, EmbeddingProviderMetadata } from '../../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeCountTokens(): (content: string) => number {
  // Simple token counter: split on whitespace
  return (content: string) => content.split(/\s+/).filter(Boolean).length;
}

function makeProvider(dims = 3): { provider: EmbeddingProvider; metadata: EmbeddingProviderMetadata } {
  return {
    provider: {
      embed: vi.fn((text: string) => new Array(dims).fill(0.1) as number[]),
    },
    metadata: {
      name: 'test-provider',
      dimensions: dims,
      modelFamily: null,
      maxInputTokens: null,
    },
  };
}

function makeBatchProvider(dims = 3): { provider: EmbeddingProvider; metadata: EmbeddingProviderMetadata } {
  return {
    provider: {
      embed: vi.fn((text: string) => new Array(dims).fill(0.1) as number[]),
      embedBatch: vi.fn((texts: string[]) =>
        texts.map(() => new Array(dims).fill(0.2) as number[]),
      ),
    },
    metadata: {
      name: 'batch-provider',
      dimensions: dims,
      modelFamily: null,
      maxInputTokens: null,
    },
  };
}

// ─── EmbeddingEngine ─────────────────────────────────────────────

describe('EmbeddingEngine', () => {
  let engine: EmbeddingEngine;
  const countTokens = makeCountTokens();

  beforeEach(() => {
    engine = new EmbeddingEngine(128, countTokens);
  });

  // ── getVector without provider ───────────────────────────────

  describe('getVector without provider', () => {
    it('returns undefined when no provider is set', () => {
      expect(engine.getVector(42)).toBeUndefined();
    });
  });

  // ── setProvider + prepare ────────────────────────────────────

  describe('setProvider + prepare', () => {
    it('after setProvider and prepare, getVector returns a vector', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      await engine.prepare(100, 'some content');
      const vec = engine.getVector(100);
      expect(vec).toBeDefined();
      expect(vec).toHaveLength(3);
    });
  });

  // ── Same-name setProvider is no-op ──────────────────────────

  describe('same-name setProvider', () => {
    it('returns same name and does not clear cache', async () => {
      const { provider, metadata } = makeProvider();
      const onClear = vi.fn();

      await engine.setProvider(provider, metadata, [], onClear);
      await engine.prepare(1, 'cached text');

      const result = await engine.setProvider(provider, metadata, [], onClear);
      expect(result.oldName).toBe('test-provider');
      expect(result.newName).toBe('test-provider');
      // onCacheClear only called once (first setProvider), not on the no-op
      expect(onClear).toHaveBeenCalledTimes(1);

      // Cache still intact
      expect(engine.getVector(1)).toBeDefined();
    });
  });

  // ── Provider switch ─────────────────────────────────────────

  describe('provider switch', () => {
    it('clears cache and re-embeds active content', async () => {
      const { provider: p1, metadata: m1 } = makeProvider();
      const onClear = vi.fn();

      await engine.setProvider(p1, m1, [], onClear);
      await engine.prepare(1, 'text one');
      expect(engine.getVector(1)).toBeDefined();

      const p2: EmbeddingProvider = {
        embed: vi.fn(() => [0.5, 0.5, 0.5]),
      };
      const m2: EmbeddingProviderMetadata = {
        name: 'provider-two',
        dimensions: 3,
        modelFamily: null,
        maxInputTokens: null,
      };

      const activeContents = [{ hash: 1, content: 'text one' }];
      const result = await engine.setProvider(p2, m2, activeContents, onClear);

      expect(result.oldName).toBe('test-provider');
      expect(result.newName).toBe('provider-two');
      // onCacheClear called for both setProvider calls
      expect(onClear).toHaveBeenCalledTimes(2);
      // Re-embedded the active content with new provider
      expect(engine.getVector(1)).toEqual([0.5, 0.5, 0.5]);
    });
  });

  // ── removeProvider ──────────────────────────────────────────

  describe('removeProvider', () => {
    it('returns to trigram mode', async () => {
      const { provider, metadata } = makeProvider();
      const onClear = vi.fn();

      await engine.setProvider(provider, metadata, [], onClear);
      expect(engine.getMode()).toBe('embeddings');

      const result = engine.removeProvider(onClear);
      expect(result.oldName).toBe('test-provider');
      expect(engine.getMode()).toBe('trigrams');
      expect(engine.hasProvider()).toBe(false);
      expect(onClear).toHaveBeenCalledTimes(2);
    });

    it('getVector returns undefined after removeProvider', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());
      await engine.prepare(1, 'content');
      expect(engine.getVector(1)).toBeDefined();

      engine.removeProvider(vi.fn());
      expect(engine.getVector(1)).toBeUndefined();
    });
  });

  // ── Embedding cache ─────────────────────────────────────────

  describe('embedding cache', () => {
    it('hit after prepare, miss after invalidate', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      await engine.prepare(10, 'cached content');
      expect(engine.hasPrepared(10)).toBe(true);
      expect(engine.getVector(10)).toBeDefined();

      engine.invalidate(10);
      expect(engine.hasPrepared(10)).toBe(false);
      expect(engine.getVector(10)).toBeUndefined();
    });

    it('prepare skips already-cached items', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      await engine.prepare(5, 'some text');
      await engine.prepare(5, 'some text');

      // embed called only once (second prepare is a cache hit)
      expect(provider.embed).toHaveBeenCalledTimes(1);
    });
  });

  // ── Vector validation ───────────────────────────────────────

  describe('vector validation', () => {
    it('dimension mismatch throws ProviderError', async () => {
      const provider: EmbeddingProvider = {
        embed: vi.fn(() => [0.1, 0.2]), // 2 dims, expects 3
      };
      const metadata: EmbeddingProviderMetadata = {
        name: 'bad-dims',
        dimensions: 3,
        modelFamily: null,
        maxInputTokens: null,
      };
      await engine.setProvider(provider, metadata, [], vi.fn());

      await expect(engine.prepare(1, 'text')).rejects.toThrow(ProviderError);
    });

    it('NaN in vector throws ProviderError', async () => {
      const provider: EmbeddingProvider = {
        embed: vi.fn(() => [0.1, NaN, 0.3]),
      };
      const metadata: EmbeddingProviderMetadata = {
        name: 'nan-provider',
        dimensions: 3,
        modelFamily: null,
        maxInputTokens: null,
      };
      await engine.setProvider(provider, metadata, [], vi.fn());

      await expect(engine.prepare(1, 'text')).rejects.toThrow(ProviderError);
    });

    it('Infinity in vector throws ProviderError', async () => {
      const provider: EmbeddingProvider = {
        embed: vi.fn(() => [0.1, Infinity, 0.3]),
      };
      const metadata: EmbeddingProviderMetadata = {
        name: 'inf-provider',
        dimensions: 3,
        modelFamily: null,
        maxInputTokens: null,
      };
      await engine.setProvider(provider, metadata, [], vi.fn());

      await expect(engine.prepare(1, 'text')).rejects.toThrow(ProviderError);
    });

    it('-Infinity in vector throws ProviderError', async () => {
      const provider: EmbeddingProvider = {
        embed: vi.fn(() => [0.1, -Infinity, 0.3]),
      };
      const metadata: EmbeddingProviderMetadata = {
        name: 'neginf-provider',
        dimensions: 3,
        modelFamily: null,
        maxInputTokens: null,
      };
      await engine.setProvider(provider, metadata, [], vi.fn());

      await expect(engine.prepare(1, 'text')).rejects.toThrow(ProviderError);
    });

    it('zero vector logs warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const provider: EmbeddingProvider = {
        embed: vi.fn(() => [0, 0, 0]),
      };
      const metadata: EmbeddingProviderMetadata = {
        name: 'zero-provider',
        dimensions: 3,
        modelFamily: null,
        maxInputTokens: null,
      };
      await engine.setProvider(provider, metadata, [], vi.fn());

      await engine.prepare(1, 'text');
      expect(warnSpy).toHaveBeenCalledWith(
        '[context-lens] Embedding provider returned zero vector',
      );
      warnSpy.mockRestore();
    });
  });

  // ── Batch operations ────────────────────────────────────────

  describe('batch', () => {
    it('uses embedBatch when available', async () => {
      const { provider, metadata } = makeBatchProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      const items = [
        { hash: 1, content: 'alpha' },
        { hash: 2, content: 'beta' },
      ];
      await engine.prepareBatch(items);

      expect(provider.embedBatch).toHaveBeenCalledTimes(1);
      expect(provider.embed).not.toHaveBeenCalled();
      expect(engine.getVector(1)).toBeDefined();
      expect(engine.getVector(2)).toBeDefined();
    });

    it('falls back to serial embed when embedBatch not available', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      const items = [
        { hash: 10, content: 'one' },
        { hash: 20, content: 'two' },
        { hash: 30, content: 'three' },
      ];
      await engine.prepareBatch(items);

      expect(provider.embed).toHaveBeenCalledTimes(3);
      expect(engine.getVector(10)).toBeDefined();
      expect(engine.getVector(20)).toBeDefined();
      expect(engine.getVector(30)).toBeDefined();
    });

    it('cache-aware: excludes already-cached items from batch', async () => {
      const { provider, metadata } = makeBatchProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      // Pre-cache hash 1
      await engine.prepare(1, 'alpha');

      const items = [
        { hash: 1, content: 'alpha' },
        { hash: 2, content: 'beta' },
      ];
      await engine.prepareBatch(items);

      // embedBatch should only receive the uncached item
      expect(provider.embedBatch).toHaveBeenCalledTimes(1);
      const batchTexts = (provider.embedBatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
      expect(batchTexts).toHaveLength(1);
      expect(batchTexts[0]).toBe('beta');
    });

    it('prepareBatch is a no-op when all items are cached', async () => {
      const { provider, metadata } = makeBatchProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      await engine.prepare(1, 'alpha');
      await engine.prepare(2, 'beta');

      // Reset mock counts
      (provider.embed as ReturnType<typeof vi.fn>).mockClear();
      (provider.embedBatch as ReturnType<typeof vi.fn>).mockClear();

      await engine.prepareBatch([
        { hash: 1, content: 'alpha' },
        { hash: 2, content: 'beta' },
      ]);

      expect(provider.embed).not.toHaveBeenCalled();
      expect(provider.embedBatch).not.toHaveBeenCalled();
    });
  });

  // ── Truncation ──────────────────────────────────────────────

  describe('truncation', () => {
    it('content exceeding maxInputTokens is truncated before embedding', async () => {
      const embedFn = vi.fn((text: string) => [0.1, 0.2, 0.3]);
      const provider: EmbeddingProvider = { embed: embedFn };
      const metadata: EmbeddingProviderMetadata = {
        name: 'truncate-provider',
        dimensions: 3,
        modelFamily: null,
        maxInputTokens: 3, // max 3 tokens
      };
      await engine.setProvider(provider, metadata, [], vi.fn());

      // "one two three four five" = 5 tokens with our simple counter
      await engine.prepare(1, 'one two three four five');

      // embed should have been called with truncated content
      expect(embedFn).toHaveBeenCalledTimes(1);
      const embeddedText = embedFn.mock.calls[0]![0];
      const tokenCount = countTokens(embeddedText);
      expect(tokenCount).toBeLessThanOrEqual(3);
    });

    it('content within maxInputTokens is not truncated', async () => {
      const embedFn = vi.fn((text: string) => [0.1, 0.2, 0.3]);
      const provider: EmbeddingProvider = { embed: embedFn };
      const metadata: EmbeddingProviderMetadata = {
        name: 'no-truncate',
        dimensions: 3,
        modelFamily: null,
        maxInputTokens: 100,
      };
      await engine.setProvider(provider, metadata, [], vi.fn());

      await engine.prepare(1, 'short text');
      expect(embedFn).toHaveBeenCalledWith('short text');
    });

    it('null maxInputTokens means no truncation', async () => {
      const embedFn = vi.fn((_text: string) => [0.1, 0.2, 0.3]);
      const provider: EmbeddingProvider = { embed: embedFn };
      const metadata: EmbeddingProviderMetadata = {
        name: 'null-max',
        dimensions: 3,
        modelFamily: null,
        maxInputTokens: null,
      };
      await engine.setProvider(provider, metadata, [], vi.fn());

      const longText = 'a b c d e f g h i j k l m n o p q r s t';
      await engine.prepare(1, longText);
      expect(embedFn).toHaveBeenCalledWith(longText);
    });
  });

  // ── allHaveVectors ──────────────────────────────────────────

  describe('allHaveVectors', () => {
    it('true when all content hashes are cached', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      await engine.prepare(1, 'alpha');
      await engine.prepare(2, 'beta');
      expect(engine.allHaveVectors([1, 2])).toBe(true);
    });

    it('false when any hash is missing', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      await engine.prepare(1, 'alpha');
      // hash 2 not prepared
      expect(engine.allHaveVectors([1, 2])).toBe(false);
    });

    it('false when no provider is set', () => {
      expect(engine.allHaveVectors([1, 2])).toBe(false);
    });

    it('true for empty iterable with provider', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());
      expect(engine.allHaveVectors([])).toBe(true);
    });
  });

  // ── getMode ─────────────────────────────────────────────────

  describe('getMode', () => {
    it('returns "trigrams" without provider', () => {
      expect(engine.getMode()).toBe('trigrams');
    });

    it('returns "embeddings" with provider', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());
      expect(engine.getMode()).toBe('embeddings');
    });

    it('returns "trigrams" after removeProvider', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());
      engine.removeProvider(vi.fn());
      expect(engine.getMode()).toBe('trigrams');
    });
  });

  // ── hasProvider ─────────────────────────────────────────────

  describe('hasProvider', () => {
    it('false initially', () => {
      expect(engine.hasProvider()).toBe(false);
    });

    it('true after setProvider', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());
      expect(engine.hasProvider()).toBe(true);
    });
  });

  // ── getProviderMetadata ─────────────────────────────────────

  describe('getProviderMetadata', () => {
    it('returns null when no provider', () => {
      expect(engine.getProviderMetadata()).toBeNull();
    });

    it('returns a defensive copy of metadata', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      const m1 = engine.getProviderMetadata();
      const m2 = engine.getProviderMetadata();
      expect(m1).toEqual(m2);
      expect(m1).not.toBe(m2); // different objects (defensive copy)
    });
  });

  // ── clearCache ──────────────────────────────────────────────

  describe('clearCache', () => {
    it('removes all cached entries', async () => {
      const { provider, metadata } = makeProvider();
      await engine.setProvider(provider, metadata, [], vi.fn());

      await engine.prepare(1, 'alpha');
      await engine.prepare(2, 'beta');
      expect(engine.hasPrepared(1)).toBe(true);

      engine.clearCache();
      expect(engine.hasPrepared(1)).toBe(false);
      expect(engine.hasPrepared(2)).toBe(false);
    });
  });

  // ── Trigram fallback without provider ───────────────────────

  describe('trigram fallback', () => {
    it('prepare caches trigrams when no provider is set', async () => {
      await engine.prepare(1, 'hello world');
      expect(engine.hasPrepared(1)).toBe(true);
      // getVector returns undefined for trigram entries (not embedding vectors)
      expect(engine.getVector(1)).toBeUndefined();
    });
  });
});
