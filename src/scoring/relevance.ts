/**
 * Relevance scorer — task similarity, keyword boost, metadata signals,
 * recency, protection clamp/floor.
 * @see cl-spec-002 §5, R-008
 */

import type { TaskDescriptor, ProtectionLevel } from '../types.js';
import type { SimilarityEngine } from '../similarity.js';

// ─── Weights ──────────────────────────────────────────────────────

const W_CONTENT = 0.45;
const W_KEYWORD = 0.10;
const W_ORIGIN = 0.10;
const W_RECENCY = 0.20;
const W_IMPORTANCE = 0.15;

const CONTENT_SIMILARITY_WEIGHT = 0.7;
const CONTENT_KEYWORD_WEIGHT = 0.3;

const SEED_FLOOR = 0.3;

// ─── Input / Output Types ─────────────────────────────────────────

export interface RelevanceSegment {
  id: string;
  content: string;
  contentHash: number;
  tokenCount: number;
  protection: ProtectionLevel;
  importance: number;
  origin: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface RelevanceResult {
  perSegment: Map<string, number>;
  windowRelevance: number | null;
}

// ─── Keyword Matching ─────────────────────────────────────────────

function countKeywordMatches(content: string, keywords: string[]): number {
  const lower = content.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    // Whole-word case-insensitive match using word boundary regex
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lower)) count++;
  }
  return count;
}

// ─── Core ─────────────────────────────────────────────────────────

/**
 * Compute relevance scores for all segments.
 * @param assessmentTimestamp Captured once per assess() — used for recency.
 * @param task Current task descriptor, or null if unset.
 * @param taskDescHash Content hash of the task description (for similarity lookup).
 */
export function computeRelevance(
  ordered: RelevanceSegment[],
  sim: SimilarityEngine,
  assessmentTimestamp: number,
  task: TaskDescriptor | null,
  taskDescHash: number | null,
): RelevanceResult {
  const n = ordered.length;
  const perSegment = new Map<string, number>();

  if (n === 0) {
    return { perSegment, windowRelevance: null };
  }

  // No task → all segments score 1.0
  if (task === null || taskDescHash === null) {
    for (const seg of ordered) {
      perSegment.set(seg.id, applyProtection(1.0, seg.protection));
    }
    return {
      perSegment,
      windowRelevance: 1.0,
    };
  }

  // Compute maxAge for recency normalization
  let oldestTimestamp = assessmentTimestamp;
  for (const seg of ordered) {
    const latest = Math.max(seg.createdAt, seg.updatedAt);
    if (latest < oldestTimestamp) oldestTimestamp = latest;
  }
  const maxAge = assessmentTimestamp - oldestTimestamp;

  const keywords = task.keywords ?? [];
  const relatedOrigins = task.relatedOrigins ?? [];
  const relatedTags = task.relatedTags ?? [];

  let weightedSum = 0;
  let totalTokens = 0;

  for (const seg of ordered) {
    // 1. Task similarity
    const taskSim = sim.computeSimilarity(
      seg.contentHash, seg.content,
      taskDescHash, task.description,
    );

    // 2. Keyword boost
    let keywordScore = 0;
    if (keywords.length > 0) {
      keywordScore = countKeywordMatches(seg.content, keywords) / keywords.length;
    }

    // 3. Content relevance
    const contentRelevance = keywords.length > 0
      ? taskSim * CONTENT_SIMILARITY_WEIGHT + keywordScore * CONTENT_KEYWORD_WEIGHT
      : taskSim;

    // 4. Origin relevance (binary)
    const originRelevance = relatedOrigins.length > 0 && seg.origin !== null
      && relatedOrigins.includes(seg.origin)
      ? 1.0
      : 0.0;

    // 5. Tag relevance (fractional)
    let tagRelevance = 0;
    if (relatedTags.length > 0 && seg.tags.length > 0) {
      let matches = 0;
      for (const t of seg.tags) {
        if (relatedTags.includes(t)) matches++;
      }
      tagRelevance = matches / relatedTags.length;
    }

    // 6. Combined metadata signal (origin + tag, best of both)
    const metadataSignal = Math.max(originRelevance, tagRelevance);

    // 7. Recency
    const age = assessmentTimestamp - Math.max(seg.createdAt, seg.updatedAt);
    const recency = maxAge > 0 ? 1.0 - age / maxAge : 1.0;

    // 8. Weighted sum
    const base =
      contentRelevance * W_CONTENT +
      keywordScore * W_KEYWORD +
      metadataSignal * W_ORIGIN +
      recency * W_RECENCY +
      seg.importance * W_IMPORTANCE;

    // 8. Protection clamp/floor (R-008)
    const score = applyProtection(base, seg.protection);

    perSegment.set(seg.id, score);
    weightedSum += score * seg.tokenCount;
    totalTokens += seg.tokenCount;
  }

  const windowRelevance = totalTokens > 0 ? weightedSum / totalTokens : 1.0;

  return { perSegment, windowRelevance };
}

// ─── Protection Adjustment ────────────────────────────────────────

function applyProtection(base: number, protection: ProtectionLevel): number {
  if (protection === 'pinned') return 1.0;
  if (protection === 'seed') return Math.max(base, SEED_FLOOR);
  return base;
}
