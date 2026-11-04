import {
  parse as shippedParse,
  validate,
  type OcrResult,
  type ParseResult,
  type ParsedItem
} from "@receipt-lens/core";
import {
  averaging,
  criticalOcrConfidenceFloor,
  nameNormalization,
  nameSimilarityMetric,
  roundOff,
  scorerVersion,
  tauName,
  warningOcrConfidenceFloor
} from "../benchmark.config.js";
import type { BenchmarkField, DatasetName, LabeledReceipt } from "../datasets/types.js";
import { matchItems } from "../matching/matcher.js";
import { nullParse } from "./null-parser.js";
import { scoreReceipts, type DatasetScore, type ScoreSpec } from "./report.js";

/**
 * Ticket 09b — the accuracy measurement behind every published number (DECISIONS/0014).
 *
 * `scoring/report.ts` answers the spec's two tiers (strict exact match, field-level precision/recall/F1),
 * and its rendered output stays exactly as ticket 03b shipped it: `dev-null-bootstrap.json` is committed
 * against those bytes. This module wraps that scorer and adds the four measurements DECISIONS/0014 M7
 * demands beside a number — the money census under **both** matcher configurations, the price-provenance
 * split, the confidence surface, and the finding census that attributes the strict floor.
 *
 * Determinism is inherited: fixed key order, no timestamp in content, no host paths, no receipt text and
 * no amount values (DECISIONS/0014 M6.3). The date belongs in the archive filename.
 */

export const accuracySchemaVersion = "1.0";
export const accuracyKind = "accuracy";

export type AccuracyMode = "parser-only" | "end-to-end";

export interface AccuracySpec extends ScoreSpec {
  readonly dataset: DatasetName;
  /** ADR-010: SROIE is the English headline, CORD is out-of-language layout stress. */
  readonly language: string;
  readonly coverage: string;
  /**
   * The DECISIONS/0003 snapshot hash of the bytes the receipts came from. Parser-only mode needs none:
   * a reference-OCR fixture carries the hash inside `ocr.version`, and the scorer reads it from there.
   * End-to-end mode feeds `parse()` a live `OcrResult`, whose version names the **model** instead, so the
   * snapshot has to be supplied alongside it — §8 requires every published result to pin the snapshot.
   */
  readonly snapshotHash?: string;
}

/** One paired-gold money census, named with the matcher configuration that produced it (DECISIONS/0008). */
export interface MoneyCensus {
  readonly matcher: string;
  readonly moneyGate: boolean;
  readonly pairs: number;
  readonly unitPrice: { readonly goldAnnotated: number; readonly exact: number; readonly absent: number; readonly wrong: number };
  readonly lineTotal: { readonly bothPresent: number; readonly agree: number; readonly disagree: number };
}

export interface ProvenanceCounts {
  readonly items: number;
  readonly priceSource: Readonly<Record<string, number>>;
  readonly quantitySource: Readonly<Record<string, number>>;
  /** `detected` unit prices read straight off the row */
  readonly detectedDirect: number;
  /** `detected` unit prices that are a line total promoted on an assumed qty 1 (ticket 06's rescue) */
  readonly detectedDerivative: number;
}

export interface ConfidenceCounts {
  readonly lines: number;
  readonly scoredLines: number;
  readonly words: number;
  readonly scoredWords: number;
  readonly items: number;
  readonly scoredItems: number;
  /** only populated where OCR actually supplies a score — i.e. never in parser-only mode */
  readonly wordScores: { readonly min: number; readonly max: number; readonly mean: number; readonly belowCritical: number; readonly belowWarning: number } | null;
  readonly itemsCappedByCritical: number;
}

export interface FindingCensus {
  readonly total: number;
  readonly critical: number;
  readonly advisory: number;
  readonly receiptsWithCritical: number;
  readonly byCode: Readonly<Record<string, number>>;
  readonly byCriticalCode: Readonly<Record<string, number>>;
}

/** How one receipt's printed grand total fared, as an outcome rather than a value. */
export type GrandTotalOutcome = "exact" | "wrong" | "absent" | "unannotated" | "hallucinated";

export interface ReceiptRecord {
  readonly id: string;
  readonly goldItems: number;
  readonly predictedItems: number;
  readonly pairs: number;
  readonly strict: 0 | 1 | null;
  readonly grandTotal: GrandTotalOutcome;
  readonly criticals: number;
  readonly zeroItems: 0 | 1;
}

export interface DatasetAccuracy {
  readonly dataset: string;
  readonly language: string;
  readonly coverage: string;
  readonly snapshotHash: string;
  readonly provider: string;
  readonly providerVersion: string;
  readonly license: string;
  readonly receipts: number;
  readonly fieldsLabeled: readonly BenchmarkField[];
  readonly fieldsExcluded: readonly BenchmarkField[];
  readonly strict: Omit<DatasetScore["strict"], "perReceipt">;
  readonly macro: DatasetScore["macro"];
  readonly items: DatasetScore["items"];
  readonly fields: DatasetScore["fields"];
  readonly money: readonly MoneyCensus[];
  readonly provenance: ProvenanceCounts;
  readonly confidence: ConfidenceCounts;
  readonly findings: FindingCensus;
  /** the same fixtures scored by the null parser: the harness still proves a non-parsing parser scores 0 */
  readonly nullDelta: { readonly strictMatched: number; readonly strictScoreable: number; readonly macroF1: number };
  readonly receiptRecords: readonly ReceiptRecord[];
}

function counter(keys: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = 0;
  return out;
}

/**
 * The money census under one matcher configuration. `money_gate=on` is §8.2 and every published scorer:
 * it *refuses* a pair whose monetary fields conflict, so among the pairs it keeps it can only ever report
 * exact money — the field the gate tests is the field it hides. `money_gate=off` pairs on name similarity
 * alone, which is where a wrong price exists to be seen. Both are published and the gap is the price
 * evidence (DECISIONS/0008's paired-gold rule, DECISIONS/0014 M4).
 */
function moneyCensus(receipts: readonly LabeledReceipt[], parsed: readonly ParseResult[], moneyGate: boolean): MoneyCensus {
  const unitPrice = { goldAnnotated: 0, exact: 0, absent: 0, wrong: 0 };
  const lineTotal = { bothPresent: 0, agree: 0, disagree: 0 };
  let pairs = 0;
  receipts.forEach((receipt, index) => {
    const items = parsed[index]!.items;
    const match = matchItems(receipt.gold.items, items, tauName, { moneyGate });
    for (const pair of match.pairs) {
      const gold = receipt.gold.items[pair.goldIndex]!;
      const asserted = items[pair.predictedIndex]!;
      pairs += 1;
      if (gold.unitPrice !== null) {
        unitPrice.goldAnnotated += 1;
        if (asserted.unitPrice === null) unitPrice.absent += 1;
        else if (asserted.unitPrice === gold.unitPrice) unitPrice.exact += 1;
        else unitPrice.wrong += 1;
      }
      if (gold.lineTotal !== null && asserted.lineTotal !== null) {
        lineTotal.bothPresent += 1;
        if (gold.lineTotal === asserted.lineTotal) lineTotal.agree += 1;
        else lineTotal.disagree += 1;
      }
    }
  });
  return {
    matcher: `matchItems(τ=${tauName}, money_gate=${moneyGate ? "on" : "off"})`,
    moneyGate,
    pairs,
    unitPrice,
    lineTotal,
  };
}

function provenance(parsed: readonly ParseResult[]): ProvenanceCounts {
  const items = parsed.flatMap((result) => [...result.items]);
  const priceSource = counter(["detected", "assumed", "unresolved", "user_confirmed"]);
  const quantitySource = counter(["explicit", "assumed", "unresolved", "user_confirmed"]);
  let detected = 0;
  let detectedDerivative = 0;
  for (const item of items) {
    priceSource[item.priceSource] = (priceSource[item.priceSource] ?? 0) + 1;
    quantitySource[item.quantitySource] = (quantitySource[item.quantitySource] ?? 0) + 1;
    if (item.priceSource !== "detected") continue;
    detected += 1;
    // Ticket 06's rescue: a line total promoted into a unit price because the quantity read as 1 —
    // and if that 1 was *assumed*, the value was never printed as a unit price at all (DECISIONS/0014 M7.3).
    if (item.unitPrice !== null && item.unitPrice === item.lineTotal && item.quantitySource === "assumed") detectedDerivative += 1;
  }
  return { items: items.length, priceSource, quantitySource, detectedDirect: detected - detectedDerivative, detectedDerivative };
}

function grandTotalOutcome(gold: number | null, predicted: number | null): GrandTotalOutcome {
  if (gold === null) return predicted === null ? "unannotated" : "hallucinated";
  if (predicted === null) return "absent";
  return gold === predicted ? "exact" : "wrong";
}

function measureConfidence(receipts: readonly LabeledReceipt[], parsed: readonly ParseResult[], outcomes: readonly (readonly ParsedItem[])[]): ConfidenceCounts {
  let lines = 0;
  let scoredLines = 0;
  let words = 0;
  let scoredWords = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let belowCritical = 0;
  let belowWarning = 0;
  for (const receipt of receipts) {
    for (const line of receipt.ocr.lines) {
      lines += 1;
      if (line.confidence !== null) scoredLines += 1;
      for (const word of line.words) {
        words += 1;
        if (word.confidence === null) continue;
        scoredWords += 1;
        sum += word.confidence;
        min = Math.min(min, word.confidence);
        max = Math.max(max, word.confidence);
        if (word.confidence < criticalOcrConfidenceFloor) belowCritical += 1;
        if (word.confidence < warningOcrConfidenceFloor) belowWarning += 1;
      }
    }
  }
  const items = parsed.flatMap((result) => [...result.items]);
  let scoredItems = 0;
  let capped = 0;
  outcomes.forEach((validatedItems, index) => {
    const source = parsed[index]!.items;
    validatedItems.forEach((item, position) => {
      if (item.confidence !== null) scoredItems += 1;
      const before = source[position]?.confidence ?? null;
      if (item.confidence !== null && before !== null && item.confidence < before) capped += 1;
    });
  });
  return {
    lines,
    scoredLines,
    words,
    scoredWords,
    items: items.length,
    // Counted over the validated items, which is the set §6's caps apply to.
    scoredItems,
    wordScores: scoredWords === 0 ? null : { min, max, mean: sum / scoredWords, belowCritical, belowWarning },
    itemsCappedByCritical: capped,
  };
}

function censusFindings(outcomes: readonly { findings: { code: string; severity: string; advisory?: boolean }[] }[]): FindingCensus {
  const codes = new Set<string>();
  const criticalCodes = new Set<string>();
  for (const out of outcomes) {
    for (const finding of out.findings) {
      codes.add(finding.code);
      if (finding.severity === "critical") criticalCodes.add(finding.code);
    }
  }
  const byCode = counter(codes);
  const byCriticalCode = counter(criticalCodes);
  let total = 0;
  let critical = 0;
  let advisory = 0;
  let receiptsWithCritical = 0;
  for (const out of outcomes) {
    total += out.findings.length;
    let hasCritical = false;
    for (const finding of out.findings) {
      byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
      if (finding.advisory) advisory += 1;
      if (finding.severity === "critical" && !finding.advisory) {
        critical += 1;
        byCriticalCode[finding.code] = (byCriticalCode[finding.code] ?? 0) + 1;
        hasCritical = true;
      }
    }
    if (hasCritical) receiptsWithCritical += 1;
  }
  return { total, critical, advisory, receiptsWithCritical, byCode, byCriticalCode };
}

export function measureDatasetAccuracy(
  receipts: readonly LabeledReceipt[],
  spec: AccuracySpec,
  parse: (ocr: OcrResult) => ParseResult = shippedParse
): DatasetAccuracy {
  const score = scoreReceipts(receipts, spec, parse);
  const nullScore = scoreReceipts(receipts, spec, nullParse);
  const parsed = receipts.map((receipt) => parse(receipt.ocr));
  const validated = parsed.map((result) =>
    validate(result, { criticalOcrConfidenceFloor, warningOcrConfidenceFloor, strictArithmetic: true })
  );

  const receiptRecords: ReceiptRecord[] = receipts.map((receipt, index) => {
    const result = parsed[index]!;
    return {
      id: receipt.receiptId,
      goldItems: receipt.gold.items.length,
      predictedItems: result.items.length,
      pairs: matchItems(receipt.gold.items, result.items, tauName).pairs.length,
      strict: score.strict.perReceipt[index] ?? null,
      grandTotal: grandTotalOutcome(receipt.gold.grandTotal, result.grandTotal),
      criticals: validated[index]!.findings.filter((finding) => finding.severity === "critical" && !finding.advisory).length,
      zeroItems: result.items.length === 0 ? 1 : 0,
    };
  });

  return {
    dataset: spec.dataset,
    language: spec.language,
    coverage: spec.coverage,
    // A live OcrResult's version identifies the model, not the dataset snapshot, so end-to-end mode
    // supplies the snapshot pin separately (§8: every published result pins the snapshot).
    snapshotHash: score.snapshotHash === "" ? (spec.snapshotHash ?? "") : score.snapshotHash,
    provider: score.provider,
    providerVersion: score.providerVersion,
    license: score.license,
    receipts: score.receipts,
    fieldsLabeled: spec.fieldsLabeled,
    fieldsExcluded: spec.fieldsExcluded,
    // `perReceipt` stays inside the scorer: the artifact's rows and the aggregate rate must come from one
    // implementation, and the committed JSON publishes the aggregate plus the per-receipt rows.
    strict: {
      receipts: score.strict.receipts,
      scoreable: score.strict.scoreable,
      goldless: score.strict.goldless,
      matched: score.strict.matched,
      rate: score.strict.rate,
    },
    macro: score.macro,
    items: score.items,
    fields: score.fields,
    money: [moneyCensus(receipts, parsed, true), moneyCensus(receipts, parsed, false)],
    provenance: provenance(parsed),
    confidence: measureConfidence(receipts, parsed, validated.map((out) => out.items)),
    findings: censusFindings(validated),
    nullDelta: { strictMatched: nullScore.strict.matched, strictScoreable: nullScore.strict.scoreable, macroF1: nullScore.macro.f1 },
    receiptRecords,
  };
}

export interface AccuracyProvenance {
  readonly mode: AccuracyMode;
  readonly split: "dev" | "eval";
  readonly parser: string;
  readonly ocr: {
    readonly provider: string;
    readonly tier: string;
    readonly version: string;
    readonly manifestHash: string | null;
    readonly assetBytes: number | null;
    /** parser-only: a sentence saying there are no images. end-to-end: the pinned parquet each row came from. */
    readonly imageSource: string | readonly { dataset: string; file: string; bytes: number; sha256: string; receiptsRead: number }[];
    readonly inferenceMs: { readonly n: number; readonly min: number; readonly median: number; readonly max: number } | null;
    readonly runtime?: { readonly executionProvider: string; readonly numThreads: number | null; readonly pageRequestOrigins: readonly string[] } | null;
    readonly receiptImageBytes?: number | null;
    readonly modelLoadMs?: number | null;
  };
}

/** The protocol block §8 requires to travel with every published number, echoed from `benchmark.config`. */
export function protocolBlock() {
  return {
    nameSimilarityMetric,
    nameNormalization,
    tauName,
    averaging,
    matching: "order-respecting one-to-one dynamic programming: pair count first, total name similarity second (§8.3)",
    itemFieldAgreement: "exact normalized-string equality for names and integer equality for amounts and quantities; tau governs pairing only",
    moneyGate: "on for every published scorer; the off column is the same matcher with §8.2's gate disabled, which is where a wrong price is visible (DECISIONS/0008)",
    roundOffBand: roundOff,
    ocrConfidenceFloors: { critical: criticalOcrConfidenceFloor, warning: warningOcrConfidenceFloor },
    scorerVersion,
  };
}

export function renderAccuracyArtifact(provenance: AccuracyProvenance, datasets: readonly DatasetAccuracy[], notes: readonly string[]): string {
  return (
    JSON.stringify(
      {
        kind: accuracyKind,
        schemaVersion: accuracySchemaVersion,
        mode: provenance.mode,
        split: provenance.split,
        headline: provenance.mode === "parser-only",
        parser: provenance.parser,
        accuracyIsACeiling: true,
        ceilingReasons: [
          "fixtures are the dataset's own reference OCR, so no OCR error reaches the parser-only numbers (DECISIONS/0003)",
          "development happens against dev/, so bugs a dev-driven fix would have caught on eval/ are already gone (DECISIONS/0004)",
        ],
        modeNote:
          provenance.mode === "parser-only"
            ? "the headline mode: parse() over committed reference-OCR fixtures in Node, isolating parser quality from OCR quality (PROJECT(1).md §8, DECISIONS/0014 M1)"
            : "the secondary mode: real OCR over the dataset receipt images in headless Chromium, then the same parse(), so OCR error is included (PROJECT(1).md §8, DECISIONS/0014 M1)",
        protocol: protocolBlock(),
        ocr: provenance.ocr,
        notes,
        datasets,
      },
      null,
      2
    ) + "\n"
  );
}
