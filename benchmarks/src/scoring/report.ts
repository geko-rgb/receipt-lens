import type { ParseResult } from "@receipt-lens/core";
import type { BenchmarkField, DatasetName, GoldAnnotation, LabeledReceipt } from "../datasets/types.js";
import {
  averaging,
  criticalOcrConfidenceFloor,
  nameNormalization,
  nameSimilarityMetric,
  resultsSchemaVersion,
  roundOff,
  scorerVersion,
  tauName,
  warningOcrConfidenceFloor
} from "../benchmark.config.js";
import { nullParse } from "./null-parser.js";
import { addItemCounts, scoreReceiptItems, type ItemAttribute, type ItemFieldCounts } from "./itemScores.js";

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

const itemAttributes: readonly ItemAttribute[] = ["name", "qty", "unitPrice", "lineTotal"];

export interface ScoredField {
  readonly field: string;
  readonly tier: "scalar" | "item";
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** gold-null and predicted-null on the same receipt: agreement on absence, never counted as a hit */
  readonly absentAgreements: number;
  /**
   * Cells this dataset did not annotate, excluded instead of scored — the owner's Option A
   * reading of §8's "never treated as false negatives or as null ground truth". `goldCells`
   * beside it is what the ratios were actually computed over.
   */
  readonly excludedCells: number;
  readonly goldCells: number;
}

export interface DatasetScore {
  readonly dataset: DatasetName;
  readonly snapshotHash: string;
  readonly provider: string;
  readonly providerVersion: string;
  readonly license: string;
  readonly receipts: number;
  readonly fields: readonly ScoredField[];
  readonly excludedFields: readonly string[];
  readonly macro: { readonly precision: number; readonly recall: number; readonly f1: number; readonly fields: number; readonly listed: number };
  readonly items: {
    readonly gold: number;
    readonly predicted: number;
    readonly matchedPairs: number;
    readonly unmatchedGold: number;
    readonly unmatchedPredicted: number;
    readonly tau: number;
  };
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
  /** attribution carried through to the published number (§8: results pin the license) */
  readonly license?: string;
}

/**
 * Zero-division is the whole game here: `0/0` rendered as NaN in a report is how a
 * scoring bug hides. Every ratio below goes through `ratio`, which returns 0 when there
 * is nothing to divide by.
 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function scoreCounts(
  tp: number,
  fp: number,
  fn: number,
  absentAgreements: number,
  excludedCells: number,
  field: string,
  tier: "scalar" | "item"
): ScoredField {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    field,
    tier,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    absentAgreements,
    excludedCells,
    goldCells: tp + fn,
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

export function scoreReceipts(
  receipts: readonly LabeledReceipt[],
  spec: ScoreSpec,
  parse: (ocr: LabeledReceipt["ocr"]) => ParseResult = nullParse
): DatasetScore {
  const labeled = new Set<string>(spec.fieldsLabeled);
  const scalars = scalarFields.filter((field) => labeled.has(field));
  const scoredAttributes = itemAttributes.filter((attribute) => labeled.has(`item.${attribute}`));

  const scalarCounts = new Map<string, { tp: number; fp: number; fn: number; absent: number; strictFailures: number }>();
  for (const field of scalars) scalarCounts.set(field, { tp: 0, fp: 0, fn: 0, absent: 0, strictFailures: 0 });
  const itemCounts = new Map<string, ItemFieldCounts>();
  for (const attribute of scoredAttributes) itemCounts.set(`item.${attribute}`, { tp: 0, fp: 0, fn: 0, excluded: 0 });

  const itemTotals = { gold: 0, predicted: 0, matchedPairs: 0, unmatchedGold: 0, unmatchedPredicted: 0 };
  let matchedTau = tauName;

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

    if (scoredAttributes.length > 0) {
      const outcome = scoreReceiptItems(receipt.gold.items, parsed.items, scoredAttributes);
      matchedTau = outcome.tau;
      for (const attribute of scoredAttributes) {
        addItemCounts(itemCounts.get(`item.${attribute}`)!, outcome.counts[attribute]);
      }
      itemTotals.gold += outcome.goldItems;
      itemTotals.predicted += outcome.predictedItems;
      itemTotals.matchedPairs += outcome.matchedPairs;
      itemTotals.unmatchedGold += outcome.unmatchedGold;
      itemTotals.unmatchedPredicted += outcome.unmatchedPredicted;
      // A receipt that annotates no item cell says nothing about the item tier: it must not
      // earn a strict match from an empty comparison, and it must not enter the denominator
      // either — the same rule the scalar tier already applies to an unlabelled receipt.
      if (outcome.annotatedGoldCells > 0) hasGold = true;
      if (!outcome.strictlyAgrees) strictlyAgrees = false;
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
      return scoreCounts(counts.tp, counts.fp, counts.fn, counts.absent, 0, field, "scalar");
    }),
    ...[...itemCounts.entries()].map(([field, counts]) =>
      scoreCounts(counts.tp, counts.fp, counts.fn, 0, counts.excluded, field, "item")
    ),
  ];

  // Macro is the unweighted mean across the fields that produced evidence. Two kinds of field
  // stay out of it: one the dataset never labels (excluded above, never even listed as
  // scoreable), and one it labels but this receipt set annotates nowhere and the parser
  // asserted nothing about — tp+fp+fn = 0, so its ratios are the 0/0 convention rather than a
  // measurement. Counting that convention as a zero would understate the parser; the field row
  // still publishes its counts, so nothing is hidden either way.
  const participating = fields.filter((field) => field.tp + field.fp + field.fn > 0);
  return {
    dataset: spec.dataset,
    snapshotHash: receipts.length > 0 ? (receipts[0]!.ocr.version.split("@")[1] ?? "") : "",
    provider: receipts.length > 0 ? receipts[0]!.ocr.provider : "",
    providerVersion: receipts.length > 0 ? receipts[0]!.ocr.version : "",
    license: spec.license ?? "",
    receipts: receipts.length,
    fields,
    excludedFields: [...spec.fieldsExcluded].sort(),
    macro: {
      precision: ratio(participating.reduce((sum, field) => sum + field.precision, 0), participating.length),
      recall: ratio(participating.reduce((sum, field) => sum + field.recall, 0), participating.length),
      f1: ratio(participating.reduce((sum, field) => sum + field.f1, 0), participating.length),
      fields: participating.length,
      listed: fields.length,
    },
    items: { ...itemTotals, tau: matchedTau },
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
        schemaVersion: resultsSchemaVersion,
        scorerVersion,
        headlineMode: "cached-reference-ocr-node",
        parser: "null",
        accuracyIsACeiling: true,
        ceilingReasons: [
          "fixtures are the dataset's own reference OCR, so no OCR error reaches these numbers (DECISIONS/0003)",
          "development happens against dev/, so bugs a dev-driven fix would have caught on eval/ are already gone (DECISIONS/0004)",
        ],
        // §8.6: the pins travel with the numbers, so no reader reconstructs them afterwards.
        protocol: {
          nameSimilarityMetric,
          nameNormalization,
          tauName,
          averaging,
          matching: "order-respecting one-to-one dynamic programming: pair count first, total name similarity second (§8.3)",
          itemFieldAgreement: "exact normalized-string equality for names and integer equality for amounts and quantities; tau governs pairing only",
          roundOffBand: roundOff,
          ocrConfidenceFloors: { critical: criticalOcrConfidenceFloor, warning: warningOcrConfidenceFloor },
        },
        strictTier: "every field the dataset labels must agree — scalars and matched items alike (§8 Tier 1)",
        nullSemantics:
          "gold-null and predicted-null count as agreement on absence, never as a true positive; a gold value with no prediction is a false negative, and a prediction with no gold behind it is a false positive; a gold cell the dataset never annotated is excluded from that field — neither a hit nor a miss; fields a dataset does not label are excluded, not scored",
        datasets: scores.map((score) => ({
          dataset: score.dataset,
          snapshotHash: score.snapshotHash,
          provider: score.provider,
          providerVersion: score.providerVersion,
          license: score.license,
          receipts: score.receipts,
          strict: {
            receipts: score.strict.receipts,
            scoreable: score.strict.scoreable,
            goldless: score.strict.goldless,
            matched: score.strict.matched,
            rate: score.strict.rate,
          },
          macro: score.macro,
          items: score.items,
          fieldsLabeled: score.fields.map((field) => field.field),
          fieldsExcluded: score.excludedFields,
          fields: score.fields.map((field) => ({
            field: field.field,
            tier: field.tier,
            tp: field.tp,
            fp: field.fp,
            fn: field.fn,
            precision: field.precision,
            recall: field.recall,
            f1: field.f1,
            absentAgreements: field.absentAgreements,
            excludedCells: field.excludedCells,
            goldCells: field.goldCells,
          })),
        })),
      },
      null,
      2
    ) + "\n"
  );
}
