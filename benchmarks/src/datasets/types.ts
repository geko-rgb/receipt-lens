import type { OcrResult } from "@receipt-lens/core";

/**
 * The fields the parser contract can produce. A dataset declares which of these its
 * annotations actually label; everything else is *excluded* from scoring and is never
 * null-scored (ADR-003, ADR-010, DECISIONS/0002).
 */
export type BenchmarkField =
  | "grandTotal"
  | "subtotal"
  | "serviceCharge"
  | "tip"
  | "discount"
  | "roundOff"
  | "taxTotal"
  | "item.name"
  | "item.qty"
  | "item.unitPrice"
  | "item.lineTotal";

export interface GoldItem {
  readonly name: string;
  readonly qty: number | null;
  /** integer minor units */
  readonly unitPrice: number | null;
  /** integer minor units */
  readonly lineTotal: number | null;
}

/**
 * Annotation in the parser's own vocabulary, so a scorer compares like with like.
 * `null` means the dataset did not print this field — it does not mean zero.
 */
export interface GoldAnnotation {
  readonly grandTotal: number | null;
  readonly subtotal: number | null;
  readonly serviceCharge: number | null;
  readonly tip: number | null;
  readonly discount: number | null;
  readonly roundOff: number | null;
  readonly taxTotal: number | null;
  readonly items: readonly GoldItem[];
}

export type DatasetName = "cord-v2" | "sroie";

/**
 * An annotation the dataset carries but this harness cannot read as a value — label
 * text where a number should be, or a quantity printed as a fraction. Recorded rather
 * than dropped or zeroed, so a missing gold field is always visible and auditable.
 */
export interface UnreadableAnnotation {
  readonly category: string;
  readonly text: string;
}

export interface LabeledReceipt {
  /** `dataset/split/row` — stable across regenerations */
  readonly receiptId: string;
  readonly dataset: DatasetName;
  readonly split: "dev" | "eval";
  readonly ocr: OcrResult;
  readonly gold: GoldAnnotation;
  readonly unreadableAnnotations: readonly UnreadableAnnotation[];
}

export interface DatasetProvenance {
  readonly dataset: DatasetName;
  readonly split: "dev" | "eval";
  readonly sourceSplit: string;
  /** snapshot hash of the pinned files this was generated from (DECISIONS/0003) */
  readonly snapshotHash: string;
  readonly source: string;
  readonly license: string;
  readonly fieldsLabeled: readonly BenchmarkField[];
  readonly fieldsExcluded: readonly BenchmarkField[];
  readonly exclusionReason: string;
  /**
   * Provenance of the reference OCR itself. Not a provider/model key: these fixtures
   * are the dataset's annotation, so regeneration depends on the snapshot alone.
   */
  readonly referenceOcrSource: string;
  readonly receipts: number;
}
