/**
 * Density scorer — redundancy detection (with sampling), information ratio,
 * origin-aware annotation, window-level density.
 * @see cl-spec-002 §4
 */

import type { RedundancyInfo } from '../types.js';
import type { SimilarityEngine } from '../similarity.js';
import { fnv1a } from '../utils/hash.js';

// ─── Constants ────────────────────────────────────────────────────

const SAMPLING_THRESHOLD = 200;
const REDUNDANCY_ANNOTATION_THRESHOLD = 0.5;

/**
 * Adaptive per-segment cap on the number of non-adjacent comparisons sampled
 * during cold-start density scoring. The step function tightens the cap as n
 * grows past 300, keeping the per-`assess()` cost bounded while preserving the
 * v0.1.0 baseline at smaller windows.
 *
 * @see cl-spec-016 §3.1
 */
function densitySampleCap(n: number): number {
  if (n <= 300) return 30;
  if (n <= 500) return 15;
  return 10;
}

// ─── Input / Output Types ─────────────────────────────────────────

export interface DensitySegment {
  id: string;
  content: string;
  contentHash: number;
  tokenCount: number;
  origin: string | null;
}

export interface DensitySegmentResult {
  density: number;
  redundancy: number;
  redundancyInfo: RedundancyInfo | null;
  tokenWaste: number;
}

export interface DensityResult {
  perSegment: Map<string, DensitySegmentResult>;
  windowDensity: number | null;
}

// ─── Seeded RNG ───────────────────────────────────────────────────

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ─── Core ─────────────────────────────────────────────────────────

/**
 * Compute density scores for all segments.
 * @param ordered Segments in position order (adjacency is determined by index).
 */
export function computeDensity(
  ordered: DensitySegment[],
  sim: SimilarityEngine,
): DensityResult {
  const n = ordered.length;
  const perSegment = new Map<string, DensitySegmentResult>();

  if (n === 0) {
    return { perSegment, windowDensity: null };
  }

  if (n === 1) {
    perSegment.set(ordered[0]!.id, {
      density: 1.0,
      redundancy: 0.0,
      redundancyInfo: null,
      tokenWaste: 0,
    });
    return { perSegment, windowDensity: 1.0 };
  }

  const useSampling = n > SAMPLING_THRESHOLD;
  // Adaptive per-segment sample cap (cl-spec-016 §3.1). Tighter at higher n
  // to keep the per-`assess()` work bounded; the same prefix-of-shuffle
  // semantics preserve cache-warm/cache-cold determinism.
  const sampleCap = densitySampleCap(n);
  let rng: (() => number) | null = null;
  if (useSampling) {
    const sortedIds = ordered.map(s => s.id).sort();
    rng = seededRng(fnv1a(sortedIds.join('\0')));
  }

  // Build index for O(1) adjacency checks
  const positionOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    positionOf.set(ordered[i]!.id, i);
  }

  let weightedSum = 0;
  let totalTokens = 0;

  for (let i = 0; i < n; i++) {
    const seg = ordered[i]!;
    let maxRedundancy = 0;
    let mostSimilarId: string | null = null;

    // Collect non-adjacent segment indices
    const nonAdj: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i || j === i - 1 || j === i + 1) continue;
      // Also check exact content hash match (instant redundancy 1.0)
      if (ordered[j]!.contentHash === seg.contentHash && ordered[j]!.content === seg.content) {
        maxRedundancy = 1.0;
        mostSimilarId = ordered[j]!.id;
        // Can't beat 1.0, skip further comparisons
        break;
      }
      nonAdj.push(j);
    }

    if (maxRedundancy < 1.0 && nonAdj.length > 0) {
      let indicesToCheck: number[];

      if (!useSampling || nonAdj.length <= sampleCap) {
        indicesToCheck = nonAdj;
      } else {
        // Cached-first sampling: check all, but limit uncached computations
        // We pass all indices through — the similarity cache handles hits cheaply.
        // For truly cold-start, we cap uncached comparisons at sampleCap.
        // Shuffle non-adjacent indices deterministically and take a prefix.
        const shuffled = [...nonAdj];
        for (let k = 0; k < Math.min(sampleCap, shuffled.length); k++) {
          const j = k + Math.floor(rng!() * (shuffled.length - k));
          [shuffled[k], shuffled[j]] = [shuffled[j]!, shuffled[k]!];
        }
        indicesToCheck = shuffled.slice(0, sampleCap);
      }

      for (const j of indicesToCheck) {
        const other = ordered[j]!;
        const s = sim.computeSimilarity(
          seg.contentHash, seg.content,
          other.contentHash, other.content,
        );
        if (s > maxRedundancy) {
          maxRedundancy = s;
          mostSimilarId = other.id;
        }
      }
    }

    const density = 1.0 - maxRedundancy;
    const tokenWaste = seg.tokenCount * maxRedundancy;

    // Origin-aware annotation when redundancy > 0.5
    let redundancyInfo: RedundancyInfo | null = null;
    if (maxRedundancy > REDUNDANCY_ANNOTATION_THRESHOLD && mostSimilarId !== null) {
      const otherSeg = ordered.find(s => s.id === mostSimilarId);
      redundancyInfo = {
        maxSimilarity: maxRedundancy,
        mostSimilarSegmentId: mostSimilarId,
        sameOrigin: otherSeg !== undefined
          && seg.origin !== null
          && seg.origin === otherSeg.origin,
      };
    }

    perSegment.set(seg.id, { density, redundancy: maxRedundancy, redundancyInfo, tokenWaste });

    weightedSum += density * seg.tokenCount;
    totalTokens += seg.tokenCount;
  }

  // Token-weighted mean
  const windowDensity = totalTokens > 0 ? weightedSum / totalTokens : 1.0;

  return { perSegment, windowDensity };
}
