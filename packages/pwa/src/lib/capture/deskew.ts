/**
 * DECISIONS/0018 P4 — deskew is gated on a skew estimate, never guessed.
 *
 * The estimator (Hough/line detection) is an implementation detail the record explicitly leaves open,
 * so this module owns only the decision: an estimate at or above the pinned threshold is applied, a
 * smaller one is refused, and a missing one is refused as well rather than defaulted.
 */

/** DECISIONS/0018 P4. */
export const DESKEW_THRESHOLD_DEGREES = 3;

export interface SkewEstimate {
  /** Signed skew in degrees; the sign is the direction of correction. */
  readonly degrees: number;
  /** False when the estimator itself does not trust the number. */
  readonly reliable: boolean;
}

export type DeskewReason = "below-threshold" | "not-estimable" | "unreliable";

export type DeskewDecision =
  | { readonly applied: true; readonly degrees: number }
  | { readonly applied: false; readonly reason: DeskewReason; readonly degrees: number | null };

/** The pixel buffer the estimator reads. Structural, so nodes and jsdom buffers both fit. */
export interface PixelBuffer {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * Estimates skew in degrees from ink geometry, or null when there is nothing reliable to estimate.
 *
 * Method: dark pixels are treated as ink, then the row-projection histogram is scored for a range of
 * small candidate corrections; aligned text spikes at one candidate because its rows collapse into few
 * bands. The reported value is the *correction* (the sign is what straightens the page). Confidence is
 * the peak against the mean of all candidates — a page with no dominant direction returns null, which
 * is §10's "cannot estimate skew reliably" case rather than a guessed transform.
 */
export function estimateSkew(pixels: PixelBuffer): number | null {
  const { data, width, height } = pixels;
  if (width < 8 || height < 8) return null;

  // Grayscale, and the mean as the ink threshold: receipts are dark ink on a light page, so
  // "darker than the page" is the only classification needed and it survives a shadow gradient.
  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      total += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      count += 1;
    }
  }
  if (count === 0) return null;
  const meanGray = total / count;

  // Ink samples, subsampled so the scoring loop stays linear-ish on a photographed receipt.
  const stride = Math.max(1, Math.floor(Math.sqrt(count / 4000)));
  const inkX: number[] = [];
  const inkY: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x + y) % stride !== 0) continue;
      const i = (y * width + x) * 4;
      const gray = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      if (gray >= meanGray) continue;
      inkX.push(x);
      inkY.push(y);
    }
  }
  if (inkX.length < 40) return null;

  // Candidate corrections: shear the ink by tan(angle) and score how tightly the rows collapse.
  const limit = 15;
  const step = 0.5;
  const bandCount = Math.ceil(height + width * Math.tan((limit * Math.PI) / 180)) + 2;
  const scores: number[] = [];
  const angles: number[] = [];

  for (let angle = -limit; angle <= limit + 1e-9; angle += step) {
    const slope = Math.tan((angle * Math.PI) / 180);
    const bands = new Float64Array(bandCount);
    for (let p = 0; p < inkX.length; p += 1) {
      const band = Math.round(inkY[p]! + inkX[p]! * slope) + 10;
      if (band < 0 || band >= bandCount) continue;
      bands[band]! += 1;
    }

    let mean = 0;
    for (let b = 1; b < bandCount - 1; b += 1) mean += bands[b]!;
    mean /= bandCount - 2;

    let variance = 0;
    for (let b = 1; b < bandCount - 1; b += 1) {
      const deltaValue = bands[b]! - mean;
      variance += deltaValue * deltaValue;
    }
    scores.push(variance);
    angles.push(angle);
  }

  let bestIndex = 0;
  let scoreSum = 0;
  for (let i = 0; i < scores.length; i += 1) {
    scoreSum += scores[i]!;
    if (scores[i]! > scores[bestIndex]!) bestIndex = i;
  }
  const meanScore = scoreSum / scores.length;
  if (meanScore === 0) return null;

  // A page with no dominant direction scores flat everywhere; only a real spike is an estimate.
  const confidence = scores[bestIndex]! / meanScore;
  if (confidence < 1.15) return null;

  return Math.round(angles[bestIndex]! * 10) / 10;
}

/**
 * P4: apply if and only if |degrees| >= the threshold and the estimate is trusted.
 * `null` (no estimate) is the "could not be estimated" case, not a zero-degree identity transform.
 */
export function decideDeskew(estimate: SkewEstimate | null): DeskewDecision {
  if (estimate === null) return { applied: false, reason: "not-estimable", degrees: null };
  if (!estimate.reliable) {
    return { applied: false, reason: "unreliable", degrees: estimate.degrees };
  }
  if (Math.abs(estimate.degrees) >= DESKEW_THRESHOLD_DEGREES) {
    return { applied: true, degrees: estimate.degrees };
  }
  return { applied: false, reason: "below-threshold", degrees: estimate.degrees };
}
