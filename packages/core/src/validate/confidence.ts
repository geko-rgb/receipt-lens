/**
 * §6's confidence floors, item-scoped and receipt-wide.
 *
 * `null` is never a low score: §4 line 325 makes inventing, imputing or defaulting confidence a contract
 * violation, so a missing score is skipped and, when every score is missing, reported as
 * `confidence_unavailable`. What the floors do decide is *which findings to raise*, and the cap that
 * §6 line 408 attaches to a critical is applied in `index.ts` over the whole finding set, because a
 * receipt-level arithmetic critical caps every item just as an item-level one caps one.
 */

import type { ParseResult, ValidationFinding } from "../types.js";
import { finding } from "./findings.js";

export interface ConfidenceFloors {
  readonly critical: number;
  readonly warning: number;
}

/**
 * §6 line 406 scopes item findings to words contributing to the item's name or price, but `ParseResult`
 * carries one blended mean per item (`parse/items.ts:152`), not a name score and a price score.
 * DECISIONS/0011 V6 pins the response: flag the field set that could have produced the mean rather than
 * guessing which one did, which degrades to exact attribution when the item has only one contributor.
 */
function contributingFieldCodes(item: ParseResult["items"][number]): ("name_confidence_low" | "price_confidence_low")[] {
  return item.priceSource === "detected"
    ? ["name_confidence_low", "price_confidence_low"]
    : ["name_confidence_low"];
}

/**
 * §6 line 407's receipt-wide diagnostic. The spec defines a word-count-weighted mean of word scores;
 * `ParseResult` carries no word counts, so DECISIONS/0011 V0 pins the closest computable reading — the
 * mean of the item scores that do exist. Tolerable only because the same sentence makes this diagnostic
 * "never the sole reason to reject a receipt": it is always minor, and it never caps anything.
 */
function receiptMeanConfidence(parsed: ParseResult): number | null {
  const scores = parsed.items.map((item) => item.confidence).filter((value): value is number => value !== null);
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

export function validateConfidence(parsed: ParseResult, floors: ConfidenceFloors): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const scores = parsed.items.map((item) => item.confidence).filter((value): value is number => value !== null);

  // "If all scores are null, skip comparisons and emit minor confidence_unavailable" (§4 line 325). Zero
  // items is zero supplied scores, so the diagnostic is emitted rather than the receipt read as clean.
  if (scores.length === 0) {
    out.push(
      finding({
        severity: "minor",
        code: "confidence_unavailable",
        scope: "receipt",
        message: "No meaningful confidence scores were supplied, so every confidence comparison is skipped",
      })
    );
    return out;
  }

  for (const item of parsed.items) {
    const score = item.confidence;
    if (score === null) continue;
    if (score < floors.critical) {
      // §6 line 414: one code, stated disjunctively ("name or price"), so a blended score satisfies it
      // directly. It subsumes the warning-floor codes: one cause, one severity.
      out.push(
        finding({
          severity: "critical",
          code: "ocr_critical_field_confidence",
          scope: "item",
          message: `Item ${item.id} scores ${score.toFixed(3)} on its name and price words, below the critical floor of ${floors.critical}`,
          itemRefs: [item.id],
        })
      );
      continue;
    }
    if (score < floors.warning) {
      for (const code of contributingFieldCodes(item)) {
        out.push(
          finding({
            severity: "minor",
            code,
            scope: "item",
            message:
              code === "name_confidence_low"
                ? `Item ${item.id} scores ${score.toFixed(3)} on the words contributing to its name and price, below the warning floor of ${floors.warning} but at or above the critical floor`
                : `Item ${item.id} has a detected price and scores ${score.toFixed(3)}, below the warning floor of ${floors.warning}`,
            itemRefs: [item.id],
          })
        );
      }
    }
  }

  const mean = receiptMeanConfidence(parsed);
  if (mean !== null && mean < floors.warning) {
    out.push(
      finding({
        severity: "minor",
        code: "ocr_confidence_low",
        scope: "receipt",
        message: `Receipt-wide confidence across ${scores.length} scored items averages ${mean.toFixed(3)}, below the warning floor of ${floors.warning}; this diagnostic is never the sole reason to reject a receipt`,
      })
    );
  }

  return out;
}
