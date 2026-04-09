/**
 * Composite score — weighted geometric mean of four dimensions.
 * @see cl-spec-002 §8
 */

// Fixed weights — not configurable
const W_COHERENCE = 0.25;
const W_DENSITY = 0.20;
const W_RELEVANCE = 0.30;
const W_CONTINUITY = 0.25;
const W_TOTAL = W_COHERENCE + W_DENSITY + W_RELEVANCE + W_CONTINUITY;

/**
 * Compute the composite quality score as a weighted geometric mean.
 * Any dimension at zero collapses the composite to zero.
 * Returns null if any dimension is null (not yet scored).
 */
export function computeComposite(
  coherence: number | null,
  density: number | null,
  relevance: number | null,
  continuity: number | null,
): number | null {
  if (
    coherence === null ||
    density === null ||
    relevance === null ||
    continuity === null
  ) {
    return null;
  }

  // Zero collapse — geometric mean property
  if (coherence === 0 || density === 0 || relevance === 0 || continuity === 0) {
    return 0;
  }

  // Weighted geometric mean:
  // (c^wc * d^wd * r^wr * t^wt) ^ (1 / (wc+wd+wr+wt))
  const logSum =
    W_COHERENCE * Math.log(coherence) +
    W_DENSITY * Math.log(density) +
    W_RELEVANCE * Math.log(relevance) +
    W_CONTINUITY * Math.log(continuity);

  return Math.exp(logSum / W_TOTAL);
}

/**
 * Compute composite for a single segment's four dimension scores.
 * Same formula as window-level composite.
 */
export function computeSegmentComposite(
  coherence: number,
  density: number,
  relevance: number,
  continuity: number,
): number {
  if (coherence === 0 || density === 0 || relevance === 0 || continuity === 0) {
    return 0;
  }

  const logSum =
    W_COHERENCE * Math.log(coherence) +
    W_DENSITY * Math.log(density) +
    W_RELEVANCE * Math.log(relevance) +
    W_CONTINUITY * Math.log(continuity);

  return Math.exp(logSum / W_TOTAL);
}
