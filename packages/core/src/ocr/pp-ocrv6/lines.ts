import type { OcrBox, OcrLine, OcrWord } from "../types.js";

export function unionBoxes(boxes: readonly OcrBox[]): OcrBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

interface Band {
  centerSum: number;
  words: OcrWord[];
}

/**
 * Groups normalized words into reading-order lines.
 *
 * A word joins a band when its vertical centre is within `toleranceRatio` of the
 * band's mean centre (the manifest's `readingOrder.toleranceRatio`, 0.5 — the same
 * constant the upstream browser manifest publishes). Words inside a band are ordered
 * left-to-right; line ids are stable (`l1`, `l2`, …) within one result.
 *
 * The deterministic parser re-clusters words itself (§5), so this only has to be a
 * faithful reading-order view of the page, never a parsing decision.
 */
export function groupWordsIntoLines(words: readonly OcrWord[], toleranceRatio: number): OcrLine[] {
  if (words.length === 0) return [];

  const heights = words.map((word) => word.box.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)]!;
  const tolerance = Math.max(1, medianHeight * toleranceRatio);

  const ordered = [...words].sort(
    (a, b) => a.box.y + a.box.height / 2 - (b.box.y + b.box.height / 2) || a.box.x - b.box.x,
  );

  const bands: Band[] = [];
  for (const word of ordered) {
    const center = word.box.y + word.box.height / 2;
    let target = bands.find((band) => Math.abs(band.centerSum / band.words.length - center) <= tolerance);
    if (!target) {
      target = { centerSum: 0, words: [] };
      bands.push(target);
    }
    target.words.push(word);
    target.centerSum += center;
  }

  bands.sort((a, b) => a.centerSum / a.words.length - b.centerSum / b.words.length);

  return bands.map((band, index) => {
    const lineWords = [...band.words].sort((a, b) => a.box.x - b.box.x);
    const scores = lineWords.map((word) => word.confidence).filter((score): score is number => score !== null);
    return {
      id: `l${index + 1}`,
      text: lineWords.map((word) => word.text).join(" "),
      box: unionBoxes(lineWords.map((word) => word.box)),
      confidence: scores.length === 0 ? null : scores.reduce((total, score) => total + score, 0) / scores.length,
      words: lineWords,
    };
  });
}
