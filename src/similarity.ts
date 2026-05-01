/**
 * Similarity engine — Jaccard trigrams, cosine similarity, pairwise cache, mode switching.
 * @see cl-spec-002 §3.2
 */

import { LruCache } from './utils/lru-cache.js';

// ─── Embedding Lookup Interface ───────────────────────────────────

export interface EmbeddingLookup {
  getVector(contentHash: number): number[] | undefined;
}

// ─── Trigram Computation ──────────────────────────────────────────

export function computeTrigrams(text: string): Set<string> {
  const lower = text.toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.add(lower.substring(i, i + 3));
  }
  return trigrams;
}

// ─── Jaccard Similarity ──────────────────────────────────────────

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── Cosine Similarity ───────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Similarity Engine ───────────────────────────────────────────

const DEFAULT_CACHE_SIZE = 16384;

type SimilarityMode = 'embedding' | 'trigram';

export class SimilarityEngine {
  private cache: LruCache<string, number>;
  private embeddingLookup: EmbeddingLookup | null = null;

  constructor(cacheSize = DEFAULT_CACHE_SIZE) {
    this.cache = new LruCache(cacheSize);
  }

  setEmbeddingLookup(lookup: EmbeddingLookup | null): void {
    this.embeddingLookup = lookup;
  }

  /**
   * Compute similarity between two content items, dispatching to cosine
   * (when embeddings available) or Jaccard trigrams (fallback).
   * Results are cached with ordered-key symmetry.
   */
  computeSimilarity(
    hashA: number,
    contentA: string,
    hashB: number,
    contentB: string,
  ): number {
    // Same content → identical
    if (hashA === hashB && contentA === contentB) return 1.0;

    // Ordered key for symmetry: similarity(a,b) === similarity(b,a)
    const [lo, hi] = hashA <= hashB ? [hashA, hashB] : [hashB, hashA];
    const mode = this.resolveMode(hashA, hashB);
    const cacheKey = `${lo}:${hi}:${mode}`;

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    let score: number;
    if (mode === 'embedding') {
      const vecA = this.embeddingLookup!.getVector(hashA)!;
      const vecB = this.embeddingLookup!.getVector(hashB)!;
      score = cosineSimilarity(vecA, vecB);
    } else {
      const triA = computeTrigrams(contentA);
      const triB = computeTrigrams(contentB);
      score = jaccardSimilarity(triA, triB);
    }

    // Clamp to [0, 1]
    score = Math.max(0, Math.min(1, score));

    this.cache.set(cacheKey, score);
    return score;
  }

  /** Invalidate all cache entries involving a specific content hash. */
  invalidateContentHash(hash: number): void {
    const hashStr = hash.toString();
    const keysToDelete: string[] = [];
    for (const [key] of this.cache.entries()) {
      const sep1 = key.indexOf(':');
      const sep2 = key.indexOf(':', sep1 + 1);
      const lo = key.substring(0, sep1);
      const hi = key.substring(sep1 + 1, sep2);
      if (lo === hashStr || hi === hashStr) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }

  /**
   * Empty the similarity cache. Called by the public clearCaches API
   * (cl-spec-007 §8.9.1), the teardown orchestrator (cl-spec-015 §4.1), and
   * the provider-switch invalidation cascade (cl-spec-005 §6.2). Keeps the
   * LruCache instance and its current maxSize, preserving any setCacheSize
   * call the caller made beforehand.
   * @see cl-spec-002 §3.2, cl-spec-007 §8.9.1
   */
  clearCache(): void {
    this.cache.clear();
  }

  get cacheEntryCount(): number {
    return this.cache.size;
  }

  /**
   * Resize the similarity cache at runtime. Drops least-recently-used entries
   * on shrink. Setting size to 0 disables the cache.
   * @returns Number of entries evicted by the resize.
   * @see cl-spec-007 §8.9.2
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

  private resolveMode(hashA: number, hashB: number): SimilarityMode {
    if (this.embeddingLookup === null) return 'trigram';
    const vecA = this.embeddingLookup.getVector(hashA);
    const vecB = this.embeddingLookup.getVector(hashB);
    return vecA !== undefined && vecB !== undefined ? 'embedding' : 'trigram';
  }
}
