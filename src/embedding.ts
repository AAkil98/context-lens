/**
 * Embedding subsystem — provider interface, cache, switching, fallback, validation.
 * @see cl-spec-005
 */

import type {
  EmbeddingProvider,
  EmbeddingProviderMetadata,
} from './types.js';
import { ProviderError } from './errors.js';
import type { EmbeddingLookup } from './similarity.js';
import { LruCache } from './utils/lru-cache.js';

// ─── Local Trigram Computation ────────────────────────────────────
// Duplicated from similarity.ts because embedding cannot import similarity
// (dependency rule: similarity → embedding, not the reverse).

function buildTrigrams(text: string): Set<string> {
  const lower = text.toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.add(lower.substring(i, i + 3));
  }
  return trigrams;
}

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_CACHE_SIZE = 4096;
const TRIGRAM_PROVIDER_NAME = 'trigram';

// ─── EmbeddingEngine ──────────────────────────────────────────────

export class EmbeddingEngine implements EmbeddingLookup {
  private provider: EmbeddingProvider | null = null;
  private metadata: EmbeddingProviderMetadata | null = null;
  private cache: LruCache<string, number[] | Set<string>>;
  private readonly cacheSize: number;
  private readonly countTokens: (content: string) => number;

  constructor(cacheSize = DEFAULT_CACHE_SIZE, countTokens: (content: string) => number) {
    this.cacheSize = cacheSize;
    this.cache = new LruCache(cacheSize);
    this.countTokens = countTokens;
  }

  // ── EmbeddingLookup Interface ───────────────────────────────────

  getVector(contentHash: number): number[] | undefined {
    if (this.provider === null || this.metadata === null) return undefined;
    const key = `${contentHash}:${this.metadata.name}`;
    const entry = this.cache.get(key);
    if (entry !== undefined && Array.isArray(entry)) return entry;
    return undefined;
  }

  // ── Provider Management ─────────────────────────────────────────

  hasProvider(): boolean {
    return this.provider !== null;
  }

  getProviderMetadata(): EmbeddingProviderMetadata | null {
    return this.metadata !== null ? { ...this.metadata } : null;
  }

  getMode(): 'embeddings' | 'trigrams' {
    return this.provider !== null ? 'embeddings' : 'trigrams';
  }

  /**
   * Set or switch the embedding provider. Triggers full invalidation cascade:
   * clears embedding + similarity caches, re-embeds all active content.
   * Same-name registration is a no-op.
   */
  async setProvider(
    provider: EmbeddingProvider,
    metadata: EmbeddingProviderMetadata,
    activeContents: Iterable<{ hash: number; content: string }>,
    onCacheClear: () => void,
  ): Promise<{ oldName: string | null; newName: string }> {
    // Same-name is a no-op
    if (this.metadata !== null && this.metadata.name === metadata.name) {
      return { oldName: this.metadata.name, newName: metadata.name };
    }

    const oldName = this.metadata?.name ?? null;
    this.provider = provider;
    this.metadata = { ...metadata };

    // Full invalidation cascade
    this.cache = new LruCache(this.cacheSize);
    onCacheClear();

    // Re-embed all active segments
    const items = [...activeContents];
    if (items.length > 0) {
      await this.prepareBatch(items);
    }

    return { oldName, newName: metadata.name };
  }

  /**
   * Remove the current embedding provider. Falls back to trigram mode.
   */
  removeProvider(onCacheClear: () => void): { oldName: string | null } {
    const oldName = this.metadata?.name ?? null;
    this.provider = null;
    this.metadata = null;

    this.cache = new LruCache(this.cacheSize);
    onCacheClear();

    return { oldName };
  }

  // ── Content Preparation ─────────────────────────────────────────

  /**
   * Prepare a single content item: embed (if provider) or compute trigrams.
   * Skips if already cached for the current mode.
   */
  async prepare(contentHash: number, content: string): Promise<void> {
    const providerName = this.metadata?.name ?? TRIGRAM_PROVIDER_NAME;
    const key = `${contentHash}:${providerName}`;

    if (this.cache.has(key)) return;

    if (this.provider !== null && this.metadata !== null) {
      const text = this.truncate(content);
      const vector = await Promise.resolve(this.provider.embed(text));
      this.validateVector(vector);
      this.cache.set(key, vector);
    } else {
      this.cache.set(key, buildTrigrams(content));
    }
  }

  /**
   * Prepare a batch of content items. Uses provider.embedBatch when available.
   * Cache-aware: already-cached items are excluded from the batch.
   */
  async prepareBatch(items: Iterable<{ hash: number; content: string }>): Promise<void> {
    const providerName = this.metadata?.name ?? TRIGRAM_PROVIDER_NAME;
    const uncached: { hash: number; content: string; key: string }[] = [];

    for (const item of items) {
      const key = `${item.hash}:${providerName}`;
      if (!this.cache.has(key)) {
        uncached.push({ ...item, key });
      }
    }

    if (uncached.length === 0) return;

    if (this.provider !== null && this.metadata !== null) {
      const texts = uncached.map(u => this.truncate(u.content));

      if (this.provider.embedBatch !== undefined) {
        const vectors = await Promise.resolve(this.provider.embedBatch(texts));
        for (let i = 0; i < uncached.length; i++) {
          this.validateVector(vectors[i]!);
          this.cache.set(uncached[i]!.key, vectors[i]!);
        }
      } else {
        // Serial fallback
        for (let i = 0; i < uncached.length; i++) {
          const vector = await Promise.resolve(this.provider.embed(texts[i]!));
          this.validateVector(vector);
          this.cache.set(uncached[i]!.key, vector);
        }
      }
    } else {
      for (const u of uncached) {
        this.cache.set(u.key, buildTrigrams(u.content));
      }
    }
  }

  // ── Queries ─────────────────────────────────────────────────────

  hasPrepared(contentHash: number): boolean {
    const providerName = this.metadata?.name ?? TRIGRAM_PROVIDER_NAME;
    return this.cache.has(`${contentHash}:${providerName}`);
  }

  /**
   * Check if all given content hashes have embedding vectors cached.
   * Returns false if no provider is configured.
   */
  allHaveVectors(contentHashes: Iterable<number>): boolean {
    if (this.provider === null || this.metadata === null) return false;
    const name = this.metadata.name;
    for (const hash of contentHashes) {
      const entry = this.cache.get(`${hash}:${name}`);
      if (entry === undefined || !Array.isArray(entry)) return false;
    }
    return true;
  }

  // ── Cache Management ────────────────────────────────────────────

  invalidate(contentHash: number): void {
    if (this.metadata !== null) {
      this.cache.delete(`${contentHash}:${this.metadata.name}`);
    }
    this.cache.delete(`${contentHash}:${TRIGRAM_PROVIDER_NAME}`);
  }

  clearCache(): void {
    this.cache = new LruCache(this.cacheSize);
  }

  // ── Internal ────────────────────────────────────────────────────

  private truncate(content: string): string {
    if (this.metadata === null || this.metadata.maxInputTokens === null) return content;
    const max = this.metadata.maxInputTokens;
    if (this.countTokens(content) <= max) return content;

    // Binary search for the longest prefix within the token limit
    let lo = 0;
    let hi = content.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.countTokens(content.substring(0, mid)) <= max) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return content.substring(0, lo);
  }

  private validateVector(vector: number[]): void {
    if (this.metadata === null) return;

    if (vector.length !== this.metadata.dimensions) {
      throw new ProviderError(
        `Vector dimension mismatch: expected ${this.metadata.dimensions}, got ${vector.length}`,
        { expected: this.metadata.dimensions, actual: vector.length },
      );
    }

    let allZero = true;
    for (let i = 0; i < vector.length; i++) {
      if (!Number.isFinite(vector[i]!)) {
        throw new ProviderError(
          `Vector contains non-finite element at index ${i}`,
          { index: i, value: vector[i] },
        );
      }
      if (vector[i] !== 0) allZero = false;
    }

    if (allZero) {
      console.warn('[context-lens] Embedding provider returned zero vector');
    }
  }
}
