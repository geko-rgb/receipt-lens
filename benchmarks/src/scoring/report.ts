import type { ParseResult } from "@receipt-lens/core";
import type { BenchmarkField, DatasetName, GoldAnnotation, LabeledReceipt } from "../datasets/types.js";
import { nullParse } from "./null-parser.js";

export type ScalarField = "grandTotal" | "subtotal" | "serviceCharge" | "tip" | "discount" | "roundOff" | "taxTotal";
export type ItemField = "item.name" | "item.qty" | "item.unitPrice" | "item.lineTotal";

const scalarFields: readonly ScalarField[] = [
  "grandTotal",
  "subtotal",
  "serviceCharge",
  "tip",
  "discount",
  "roundOff",
  "taxTotal",
];

export interface ScoredField {
  readonly field: string;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** gold-null and predicted-null on the same receipt: agreement on absence, never counted as a hit */
  readonly absentAgreements: number;
}

export interface DatasetScore {
  readonly dataset: DatasetName;
  readonly snapshotHash: string;
  readonly receipts: number;
  readonly fields: readonly ScoredField[];
  readonly excludedFields: readonly string[];
  readonly strict: {
    readonly receipts: number;
    /** receipts with at least one labelled gold value: the only receipts strict can be about */
    readonly scoreable: number;
    readonly goldless: number;
    readonly matched: number;
    readonly rate: number;
  };
}

export interface ScoreSpec {
  readonly dataset: DatasetName;
  readonly fieldsLabeled: readonly BenchmarkField[];
  readonly fieldsExcluded: readonly BenchmarkField[];
}

/**
 * Zero-division is the whole game here: `0/0` rendered as NaN in a report is how a
 * scoring bug hides. Every ratio below goes through `ratio`, which returns 0 when there
 * is nothing to divide by.
 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function scoreCounts(tp: number, fp: number, fn: number, absentAgreements: number, field: string): ScoredField {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    field,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    absentAgreements,
  };
}

function predictedScalar(field: ScalarField, parsed: ParseResult): number | null {
  if (field === "taxTotal") {
    const amounts = parsed.taxes.map((tax) => tax.amount).filter((amount): amount is number => amount !== null);
    return amounts.length === 0 ? null : amounts.reduce((sum, amount) => sum + amount, 0);
  }
  return parsed[field];
}

function goldScalar(field: ScalarField, gold: GoldAnnotation): number | null {
  return field === "taxTotal" ? gold.taxTotal : gold[field];
}

function itemsUnscorable(parsed: ParseResult): boolean {
  return parsed.items.length > 0;
}

export function scoreReceipts(
  receipts: readonly LabeledReceipt[],
  spec: ScoreSpec,
  parse: (ocr: LabeledReceipt["ocr"]) => ParseResult = nullParse
): DatasetScore {
  const labeled = new Set<string>(spec.fieldsLabeled);
  const scalars = scalarFields.filter((field) => labeled.has(field));

  const scalarCounts = new Map<string, { tp: number; fp: number; fn: number; absent: number; strictFailures: number }>();
  for (const field of scalars) scalarCounts.set(field, { tp: 0, fp: 0, fn: 0, absent: 0, strictFailures: 0 });
  const itemCounts = new Map<string, { tp: number; fp: number; fn: number; absent: number }>();
  for (const field of [...labeled]) {
    if (field.startsWith("item.")) itemCounts.set(field, { tp: 0, fp: 0, fn: 0, absent: 0 });
  }

  let strictMatched = 0;
  let scoreable = 0;
  for (const receipt of receipts) {
    const parsed = parse(receipt.ocr);
    let strictlyAgrees = true;
    let hasGold = false;

    for (const field of scalars) {
      const counts = scalarCounts.get(field)!;
      const goldValue = goldScalar(field, receipt.gold);
      const predictedValue = predictedScalar(field, parsed);
      if (goldValue !== null) hasGold = true;
      if (goldValue === null && predictedValue === null) {
        counts.absent += 1;
      } else if (goldValue !== null && goldValue === predictedValue) {
        counts.tp += 1;
      } else {
        if (predictedValue !== null) counts.fp += 1;
        if (goldValue !== null) counts.fn += 1;
        counts.strictFailures += 1;
        strictlyAgrees = false;
      }
    }

    for (const [field, counts] of itemCounts) {
      // With no predicted items there are no pairs to form, whatever matcher is used
      // later, so precision and recall are defined by the gold side alone.
      const attributeName = field.split(".")[1] as "name" | "qty" | "unitPrice" | "lineTotal";
      const goldPresent = receipt.gold.items.filter((item) => item[attributeName] !== null && item[attributeName] !== "").length;
      if (goldPresent > 0) hasGold = true;
      if (parsed.items.length === 0) {
        counts.fn += goldPresent;
        if (goldPresent > 0) strictlyAgrees = false;
      } else {
        throw new Error("item-level scoring requires the 03b matcher");
      }
    }

    // A receipt with nothing labelled is not evidence of anything: it must not enter the
    // strict denominator, or a parser that outputs nothing would earn a match for free.
    if (hasGold) {
      scoreable += 1;
      if (strictlyAgrees) strictMatched += 1;
    }
  }

  const fields: ScoredField[] = [
    ...scalars.map((field) => {
      const counts = scalarCounts.get(field)!;
      return scoreCounts(counts.tp, counts.fp, counts.fn, counts.absent, field);
    }),
    ...[...itemCounts.entries()].map(([field, counts]) =>
      scoreCounts(counts.tp, counts.fp, counts.fn, counts.absent, field)
    ),
  ];

  return {
    dataset: spec.dataset,
    snapshotHash: receipts.length > 0 ? (receipts[0]!.ocr.version.split("@")[1] ?? "") : "",
    receipts: receipts.length,
    fields,
    excludedFields: [...spec.fieldsExcluded].sort(),
    strict: {
      receipts: receipts.length,
      scoreable,
      goldless: receipts.length - scoreable,
      matched: strictMatched,
      rate: ratio(strictMatched, scoreable),
    },
  };
}

/**
 * Deterministic by construction: fixed key order, no timestamp, no host paths. Two runs
 * over the same fixtures produce the same bytes, which is what the ticket requires and
 * what makes a committed result reviewable in a diff.
 */
export function renderReport(scores: readonly DatasetScore[]): string {
  return (
    JSON.stringify(
      {
        headlineMode: "cached-reference-ocr-node",
        parser: "null",
        accuracyIsACeiling: true,
        ceilingReasons: [
          "fixtures are the dataset's own reference OCR, so no OCR error reaches these numbers (DECISIONS/0003)",
          "development happens against dev/, so bugs a dev-driven fix would have caught on eval/ are already gone (DECISIONS/0004)",
        ],
        strictTier: "scalar fields only; item agreement joins this tier when the 03b matcher lands",
        nullSemantics:
          "gold-null and predicted-null count as agreement on absence, never as a true positive; a gold value with no prediction is a false negative, and a prediction with no gold behind it is a false positive; fields a dataset does not label are excluded, not scored",
        datasets: scores.map((score) => ({
          dataset: score.dataset,
          snapshotHash: score.snapshotHash,
          receipts: score.receipts,
          strict: {
            receipts: score.strict.receipts,
            scoreable: score.strict.scoreable,
            goldless: score.strict.goldless,
            matched: score.strict.matched,
            rate: score.strict.rate,
          },
          fieldsLabeled: score.fields.map((field) => field.field),
          fieldsExcluded: score.excludedFields,
          fields: score.fields.map((field) => ({
            field: field.field,
            tp: field.tp,
            fp: field.fp,
            fn: field.fn,
            precision: field.precision,
            recall: field.recall,
            f1: field.f1,
            absentAgreements: field.absentAgreements,
          })),
        })),
      },
      null,
      2
    ) + "\n"
  );
}
