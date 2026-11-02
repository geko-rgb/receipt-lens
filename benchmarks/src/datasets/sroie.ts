import type { OcrBox, OcrLine, OcrResult, OcrWord } from "@receipt-lens/core";
import { parseAmountToMinorUnits } from "../money.js";
import type { BenchmarkField, DatasetName, GoldAnnotation, LabeledReceipt, UnreadableAnnotation } from "./types.js";

export interface SroieRow {
  readonly words: readonly string[];
  /** one rectangle per word: `[x1,y1,x2,y2]`, or a flat polygon of corner pairs */
  readonly bboxes: readonly (readonly number[])[];
  readonly imageSize: { readonly width: number; readonly height: number };
  readonly entities: {
    readonly company?: string;
    readonly date?: string;
    readonly address?: string;
    readonly total?: string;
  };
}

/**
 * SROIE annotates company, date, address and total only. Nothing item-level exists in
 * this dataset, so nothing item-level is scored against it (DECISIONS/0002).
 */
export const SROIE_LABELED_FIELDS: readonly BenchmarkField[] = ["grandTotal"];

export const SROIE_EXCLUDED_FIELDS: readonly BenchmarkField[] = [
  "subtotal",
  "serviceCharge",
  "tip",
  "discount",
  "roundOff",
  "taxTotal",
  "item.name",
  "item.qty",
  "item.unitPrice",
  "item.lineTotal",
];

const lineToleranceOfMedianHeight = 0.5;

interface PositionedWord {
  readonly text: string;
  readonly box: OcrBox;
  readonly yCenter: number;
  readonly height: number;
}

function rectOf(bbox: readonly number[]): OcrBox {
  // A 4-length rectangle is the common case; some SROIE conversions emit a closed
  // polygon. Either way the axis-aligned bounds are what the parser coordinates need.
  const coords = bbox.length % 2 === 0 ? bbox : bbox.slice(0, bbox.length - 1);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index + 1 < coords.length; index += 2) {
    xs.push(coords[index]!);
    ys.push(coords[index + 1]!);
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const x2 = Math.max(...xs);
  const y2 = Math.max(...ys);
  return { x, y, width: x2 - x, height: y2 - y };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function unionBox(words: readonly OcrWord[]): OcrBox {
  const x = Math.min(...words.map((word) => word.box.x));
  const y = Math.min(...words.map((word) => word.box.y));
  const x2 = Math.max(...words.map((word) => word.box.x + word.box.width));
  const y2 = Math.max(...words.map((word) => word.box.y + word.box.height));
  return { x, y, width: x2 - x, height: y2 - y };
}

/**
 * SROIE ships a flat token list with rectangles and no line membership, so line
 * boundaries are reconstructed here. DECISIONS/0003 records these lines as
 * harness-derived, not dataset facts: a fixed tolerance, never tuned against a score.
 */
export function clusterWordLines(positioned: readonly PositionedWord[]): OcrLine[] {
  if (positioned.length === 0) return [];
  const tolerance = median(positioned.map((word) => word.height)) * lineToleranceOfMedianHeight;
  const ordered = [...positioned].sort((a, b) => a.yCenter - b.yCenter || a.box.x - b.box.x);

  const groups: PositionedWord[][] = [[ordered[0]!]];
  let bandCenter = ordered[0]!.yCenter;
  for (const word of ordered.slice(1)) {
    if (Math.abs(word.yCenter - bandCenter) <= tolerance) {
      groups[groups.length - 1]!.push(word);
      bandCenter = (bandCenter * (groups[groups.length - 1]!.length - 1) + word.yCenter) / groups[groups.length - 1]!.length;
    } else {
      groups.push([word]);
      bandCenter = word.yCenter;
    }
  }

  return groups.map((group, index) => {
    const words: OcrWord[] = [...group]
      .sort((a, b) => a.box.x - b.box.x)
      .map((word) => ({ text: word.text, box: word.box, confidence: null }));
    return {
      id: `L${index}`,
      text: words.map((word) => word.text).join(" "),
      box: unionBox(words),
      confidence: null,
      words,
    };
  });
}

export function mapSroieReceipt(
  row: SroieRow,
  context: { readonly receiptId: string; readonly snapshotHash: string }
): LabeledReceipt {
  if (row.words.length !== row.bboxes.length) {
    throw new TypeError(
      `${context.receiptId}: ${row.words.length} words but ${row.bboxes.length} boxes — the snapshot row is inconsistent`
    );
  }

  const positioned: PositionedWord[] = row.words.map((text, index) => {
    const box = rectOf(row.bboxes[index]!);
    return { text, box, yCenter: box.y + box.height / 2, height: box.height };
  });

  const ocr: OcrResult = {
    lines: clusterWordLines(positioned),
    imageSize: { width: row.imageSize.width, height: row.imageSize.height },
    provider: "dataset-reference-ocr",
    version: `sroie@${context.snapshotHash}`,
  };

  const printed = row.entities.total?.trim();
  const unreadable: UnreadableAnnotation[] = [];
  let grandTotal: number | null = null;
  if (printed) {
    try {
      grandTotal = parseAmountToMinorUnits(printed, "en");
    } catch {
      // An unreadable total is a missing gold field, recorded — never a zero.
      unreadable.push({ category: "entities.total", text: printed });
    }
  }
  const gold: GoldAnnotation = {
    grandTotal,
    subtotal: null,
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    taxTotal: null,
    items: [],
  };

  return {
    receiptId: context.receiptId,
    dataset: "sroie" as DatasetName,
    split: context.receiptId.split("/")[1] as "dev" | "eval",
    ocr,
    gold,
    unreadableAnnotations: unreadable,
  };
}
