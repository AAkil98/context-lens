/**
 * Coherence scorer — adjacency, topical concentration (with sampling), group integrity.
 * @see cl-spec-002 §3
 */

import type { SimilarityEngine } from '../similarity.js';
import { fnv1a } from '../utils/hash.js';

// ─── Constants ────────────────────────────────────────────────────

const ADJACENCY_WEIGHT = 0.6;
const CONCENTRATION_WEIGHT = 0.4;
const CLUSTER_THRESHOLD = 0.4;
const SAMPLING_THRESHOLD = 200;
const INTEGRITY_WARNING_THRESHOLD = 0.3;

// ─── Input / Output Types ─────────────────────────────────────────

export interface CoherenceSegment {
  id: string;
  content: string;
  contentHash: number;
  tokenCount: number;
  groupId: string | null;
}

export interface CoherenceResult {
  perSegment: Map<string, number>;
  adjacencyScores: Map<string, number>;
  groupScores: Map<string, { coherence: number; integrityWarning: boolean }>;
  topicalConcentration: number;
  windowCoherence: number | null;
}

// ─── Seeded RNG ───────────────────────────────────────────────────

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ─── Union-Find ───────────────────────────────────────────────────

class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array<number>(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]!);
    }
    return this.parent[x]!;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (this.rank[rx]! < this.rank[ry]!) {
      this.parent[rx] = ry;
    } else if (this.rank[rx]! > this.rank[ry]!) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx] = this.rank[rx]! + 1;
    }
  }

  countClusters(): number {
    const roots = new Set<number>();
    for (let i = 0; i < this.parent.length; i++) {
      roots.add(this.find(i));
    }
    return roots.size;
  }
}

// ─── Core ─────────────────────────────────────────────────────────

export function computeCoherence(
  ordered: CoherenceSegment[],
  groups: Map<string, string[]>,
  sim: SimilarityEngine,
): CoherenceResult {
  const n = ordered.length;
  const adjacencyScores = new Map<string, number>();
  const perSegment = new Map<string, number>();
  const groupScores = new Map<string, { coherence: number; integrityWarning: boolean }>();

  if (n === 0) {
    return { perSegment, adjacencyScores, groupScores, topicalConcentration: 1.0, windowCoherence: null };
  }

  if (n === 1) {
    adjacencyScores.set(ordered[0]!.id, 1.0);
    perSegment.set(ordered[0]!.id, 1.0);
    return { perSegment, adjacencyScores, groupScores, topicalConcentration: 1.0, windowCoherence: 1.0 };
  }

  // ── Adjacency coherence ────────────────────────────────────────

  // Compute pairwise adjacency similarities
  const adjSim: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    adjSim[i] = sim.computeSimilarity(a.contentHash, a.content, b.contentHash, b.content);
  }

  // Per-segment adjacency score
  for (let i = 0; i < n; i++) {
    let score: number;
    if (i === 0) {
      score = adjSim[0]!;
    } else if (i === n - 1) {
      score = adjSim[n - 2]!;
    } else {
      score = (adjSim[i - 1]! + adjSim[i]!) / 2;
    }
    adjacencyScores.set(ordered[i]!.id, score);
  }

  const meanAdj = adjSim.reduce((a, b) => a + b, 0) / adjSim.length;

  // ── Topical concentration ──────────────────────────────────────

  const topicalConcentration = computeTopicalConcentration(ordered, sim);

  // ── Group integrity ────────────────────────────────────────────

  const segById = new Map(ordered.map(s => [s.id, s]));

  for (const [groupId, memberIds] of groups) {
    const members = memberIds.map(id => segById.get(id)).filter((s): s is CoherenceSegment => s !== undefined);
    if (members.length <= 1) {
      groupScores.set(groupId, { coherence: 1.0, integrityWarning: false });
      continue;
    }

    // Average pairwise similarity
    let pairSum = 0;
    let pairCount = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        pairSum += sim.computeSimilarity(
          members[i]!.contentHash, members[i]!.content,
          members[j]!.contentHash, members[j]!.content,
        );
        pairCount++;
      }
    }
    const groupCoh = pairCount > 0 ? pairSum / pairCount : 1.0;
    groupScores.set(groupId, {
      coherence: groupCoh,
      integrityWarning: groupCoh < INTEGRITY_WARNING_THRESHOLD,
    });
  }

  // ── Per-segment coherence ──────────────────────────────────────

  for (const seg of ordered) {
    const adj = adjacencyScores.get(seg.id) ?? 0;
    if (seg.groupId !== null) {
      const gs = groupScores.get(seg.groupId);
      const groupCoh = gs?.coherence ?? 0;
      perSegment.set(seg.id, (adj + groupCoh) / 2);
    } else {
      perSegment.set(seg.id, adj);
    }
  }

  // ── Window-level coherence ─────────────────────────────────────

  const windowCoherence = meanAdj * ADJACENCY_WEIGHT + topicalConcentration * CONCENTRATION_WEIGHT;

  return { perSegment, adjacencyScores, groupScores, topicalConcentration, windowCoherence };
}

// ─── Topical Concentration ────────────────────────────────────────

function computeTopicalConcentration(
  ordered: CoherenceSegment[],
  sim: SimilarityEngine,
): number {
  const n = ordered.length;
  if (n <= 1) return 1.0;

  const useSampling = n > SAMPLING_THRESHOLD;

  if (!useSampling) {
    // Full all-pairs clustering
    const uf = new UnionFind(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const s = sim.computeSimilarity(
          ordered[i]!.contentHash, ordered[i]!.content,
          ordered[j]!.contentHash, ordered[j]!.content,
        );
        if (s >= CLUSTER_THRESHOLD) {
          uf.union(i, j);
        }
      }
    }
    const k = uf.countClusters();
    return 1 / k;
  }

  // Sampled clustering
  const sampleSize = Math.min(Math.ceil(Math.sqrt(n) * 3), n);
  const sampled = stratifiedSample(ordered, sampleSize);

  const uf = new UnionFind(sampled.length);
  for (let i = 0; i < sampled.length; i++) {
    for (let j = i + 1; j < sampled.length; j++) {
      const s = sim.computeSimilarity(
        sampled[i]!.contentHash, sampled[i]!.content,
        sampled[j]!.contentHash, sampled[j]!.content,
      );
      if (s >= CLUSTER_THRESHOLD) {
        uf.union(i, j);
      }
    }
  }

  const cs = uf.countClusters();
  return Math.max(0, 1 - (cs - 1) / Math.max(1, Math.floor(sampleSize / 4)));
}

// ─── Stratified Sampling ──────────────────────────────────────────

function stratifiedSample(
  ordered: CoherenceSegment[],
  sampleSize: number,
): CoherenceSegment[] {
  if (sampleSize >= ordered.length) return ordered;

  // Deterministic seed from sorted segment IDs
  const sortedIds = ordered.map(s => s.id).sort();
  const seed = fnv1a(sortedIds.join('\0'));
  const rng = seededRng(seed);

  // Stratify by groupId
  const strata = new Map<string | null, CoherenceSegment[]>();
  for (const seg of ordered) {
    const key = seg.groupId;
    let list = strata.get(key);
    if (list === undefined) {
      list = [];
      strata.set(key, list);
    }
    list.push(seg);
  }

  const n = ordered.length;
  const result: CoherenceSegment[] = [];

  for (const [, members] of strata) {
    const alloc = Math.max(1, Math.ceil(sampleSize * members.length / n));
    const count = Math.min(alloc, members.length);
    // Partial Fisher-Yates shuffle
    const arr = [...members];
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(rng() * (arr.length - i));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    for (let i = 0; i < count; i++) {
      result.push(arr[i]!);
    }
  }

  // Trim to exact sample size (rounding may overshoot)
  return result.slice(0, sampleSize);
}
