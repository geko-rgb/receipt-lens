import type { OcrBox, OcrLine, OcrResult, OcrWord } from "@receipt-lens/core";
import { parseAmountToMinorUnits } from "../money.js";
import type { BenchmarkField, DatasetName, GoldAnnotation, GoldItem, LabeledReceipt } from "./types.js";

export interface CordQuad {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly x3: number;
  readonly y3: number;
  readonly x4: number;
  readonly y4: number;
}

export interface CordWord {
  readonly text: string;
  readonly quad: CordQuad;
  /** 1 marks the printed field label ("Total"), 0 the value the annotation reads */
  readonly is_key: number;
}

export interface CordValidLine {
  readonly category: string;
  readonly group_id: number;
  readonly sub_group_id: number;
  readonly words: readonly CordWord[];
}

export interface CordRow {
  readonly imageSize: { readonly width: number; readonly height: number };
  readonly validLine: readonly CordValidLine[];
}

/**
 * What CORD's annotations actually label. The snapshot carries no tip line and no
 * round-off line, so those are excluded rather than null-scored (ADR-003).
 */
export const CORD_LABELED_FIELDS: readonly BenchmarkField[] = [
  "grandTotal",
  "subtotal",
  "serviceCharge",
  "discount",
  "taxTotal",
  "item.name",
  "item.qty",
  "item.unitPrice",
  "item.lineTotal",
];

export const CORD_EXCLUDED_FIELDS: readonly BenchmarkField[] = ["tip", "roundOff"];

/**
 * Categories the snapshot annotates but this benchmark never scores: tender types and
 * counters. Kept visible so nobody later mistakes them for missing parser output.
 */
export const CORD_IGNORED_CATEGORIES: readonly string[] = [
  "total.cashprice",
  "total.changeprice",
  "total.creditcardprice",
  "total.emoneyprice",
  "total.depositprice",
  "total.total_etc",
  "total.menutype_cnt",
  "total.menuqty_cnt",
  "menu.num",
  "menu.etc",
  "menu.itemsubtotal",
  "menu.discountprice",
  "sub_total.etc",
  "sub_total.taxincyn",
  "default.creditcardprice",
];

const moneyFields = {
  "sub_total.subtotal_price": "subtotal",
  "sub_total.service_price": "serviceCharge",
  "sub_total.discount_price": "discount",
  "sub_total.tax_price": "taxTotal",
  "total.total_price": "grandTotal",
} as const;

function boxOf(quad: CordQuad): OcrBox {
  const xs = [quad.x1, quad.x2, quad.x3, quad.x4];
  const ys = [quad.y1, quad.y2, quad.y3, quad.y4];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The value the category refers to: non-label words, or the whole line if all are labels. */
function valueOf(words: readonly CordWord[]): string {
  const value = words.filter((word) => word.is_key === 0).map((word) => word.text);
  return (value.length > 0 ? value : words.map((word) => word.text)).join(" ").trim();
}

function parseQuantity(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null;
}

function unionBox(boxes: readonly OcrBox[]): OcrBox {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const x2 = Math.max(...boxes.map((box) => box.x + box.width));
  const y2 = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: x2 - x, height: y2 - y };
}

export function mapCordReceipt(
  row: CordRow,
  context: { readonly receiptId: string; readonly snapshotHash: string }
): LabeledReceipt {
  const lines: OcrLine[] = row.validLine.map((line, index) => {
    const words: OcrWord[] = line.words.map((word) => ({
      text: word.text,
      box: boxOf(word.quad),
      confidence: null,
    }));
    return {
      id: `L${index}`,
      text: words.map((word) => word.text).join(" "),
      box: unionBox(words.map((word) => word.box)),
      confidence: null,
      words,
    };
  });

  const scalars: Record<string, number | null> = {
    subtotal: null,
    serviceCharge: null,
    discount: null,
    taxTotal: null,
    grandTotal: null,
  };
  // A parent line and its sub-lines share a group_id, so the sub_group_id is part of
  // the key that ties a name to its quantity and price.
  const items = new Map<string, { name: string; qty: number | null; unitPrice: number | null; lineTotal: number | null }>();

  for (const line of row.validLine) {
    const value = valueOf(line.words);
    const scalarField = line.category in moneyFields ? moneyFields[line.category as keyof typeof moneyFields] : undefined;

    if (scalarField) {
      const minor = parseAmountToMinorUnits(value, "id-ID");
      // Tax appears once per rate line; the annotation total is their sum.
      scalars[scalarField] = scalarField === "taxTotal" ? (scalars[scalarField] ?? 0) + minor : minor;
      continue;
    }

    const itemField = /^(?:menu|menu\.sub)\.(nm|cnt|unitprice|price)$/.exec(line.category)?.[1];
    if (!itemField) continue;

    const key = `${line.group_id}:${line.sub_group_id}`;
    const item = items.get(key) ?? { name: "", qty: null, unitPrice: null, lineTotal: null };
    if (itemField === "nm") item.name = value;
    if (itemField === "cnt") item.qty = parseQuantity(value);
    if (itemField === "unitprice") item.unitPrice = parseAmountToMinorUnits(value, "id-ID");
    if (itemField === "price") item.lineTotal = parseAmountToMinorUnits(value, "id-ID");
    items.set(key, item);
  }

  const goldItems: readonly GoldItem[] = [...items.values()]
    .filter((item) => item.name !== "")
    .map((item) => ({ ...item }));

  const gold: GoldAnnotation = {
    grandTotal: scalars.grandTotal,
    subtotal: scalars.subtotal,
    serviceCharge: scalars.serviceCharge,
    discount: scalars.discount,
    taxTotal: scalars.taxTotal,
    tip: null,
    roundOff: null,
    items: goldItems,
  };

  const ocr: OcrResult = {
    lines,
    imageSize: { width: row.imageSize.width, height: row.imageSize.height },
    provider: "dataset-reference-ocr",
    version: `cord-v2@${context.snapshotHash}`,
  };

  return {
    receiptId: context.receiptId,
    dataset: "cord-v2" as DatasetName,
    split: context.receiptId.split("/")[1] as "dev" | "eval",
    ocr,
    gold,
  };
}
