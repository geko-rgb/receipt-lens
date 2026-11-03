/**
 * `validate()` — §6's core extraction validator: findings addressed to the thing that caused them, plus
 * the canonical validated item list with §6 line 408's confidence caps applied.
 *
 * This is the extraction validator and nothing more. It cannot say whether units are assigned, a payer
 * exists, drafts are resolved or the bill can lock — that is the PWA's `validateWorkingBill` (§6 lines
 * 398–401), and `LockBlocker` is deliberately not reachable from here.
 */

import type {
  ParseResult,
  ParseValidationResult,
  ParseWarning,
  ValidateOptions,
  ValidationFinding,
  ValidationScope,
} from "../types.js";
import { validateArithmetic } from "./arithmetic.js";
import { validateConfidence } from "./confidence.js";
import { copyWarning, finding, positiveAmountEntries } from "./findings.js";

/** §6 line 405's initial defaults, which DECISIONS/0006 line 130 hands to ticket 07 to consume. */
export const DEFAULT_CRITICAL_OCR_CONFIDENCE_FLOOR = 0.5;
export const DEFAULT_WARNING_OCR_CONFIDENCE_FLOOR = 0.7;

/** §6 line 408: a non-advisory critical caps the affected item at 0.5. A literal, not the critical floor. */
export const CONFIDENCE_CAP = 0.5;

/** §6 line 433 evaluates the outlier rule only with at least 5 items; DECISIONS/0011 V15 pins the band. */
export const NAME_OUTLIER_MIN_ITEMS = 5;
export const NAME_OUTLIER_SIGMA_MULTIPLE = 2;

/**
 * Every code §4 declares for a parser warning is a warning, so §6's minor table is the whole mapping —
 * the criticals are raised here, not re-emitted from a warning. DECISIONS/0011 V1 row 25 makes the
 * exception explicit: a warning carrying a critical code keeps its critical severity.
 */
const WARNING_SCOPE: Readonly<Partial<Record<ParseWarning["code"], ValidationScope>>> = {
  qty_assumed: "item",
  qty_unresolved: "item",
  name_confidence_low: "item",
  price_confidence_low: "item",
  ocr_confidence_low: "receipt",
  confidence_unavailable: "receipt",
  ambiguous_price_separator: "row",
  ambiguous_row: "row",
  name_length_outlier: "item",
  price_not_resolved: "item",
  unclassified_charge: "charge",
  items_may_be_missing: "receipt",
  round_off_adjusted: "charge",
  missing_optional_field: "receipt",
};

/**
 * Codes `validate()` derives itself from the fields that own the fact. §6 line 466's re-emission duty is
 * to the *finding*, not to the array it arrived in: where the state is readable from an item or a
 * preserved row, that is the address, and the parser's duplicate copy of the same fact is skipped so one
 * cause never produces two findings (DECISIONS/0011 V9).
 */
const DERIVED_CODES: ReadonlySet<string> = new Set([
  "qty_assumed",
  "qty_unresolved",
  "ambiguous_row",
  "name_confidence_low",
  "price_confidence_low",
  "ocr_confidence_low",
  "ocr_critical_field_confidence",
  "confidence_unavailable",
  "items_may_be_missing",
  "round_off_adjusted",
  "price_not_resolved",
  "item_without_price",
  "name_length_outlier",
  "zero_items",
]);

function validateFloors(options: ValidateOptions): void {
  const { criticalOcrConfidenceFloor: critical, warningOcrConfidenceFloor: warning } = options;
  // Misuse, not an operational failure: §4 reserves ReceiptLensError for IMAGE_UNREADABLE,
  // MODEL_LOAD_FAILED and RECOGNIZE_FAILED, and a reversed floor is the caller's bug.
  // DECISIONS/0011 V5; the precedent for the throw type is ocr/provider.ts's TypeError.
  for (const [name, value] of [
    ["criticalOcrConfidenceFloor", critical],
    ["warningOcrConfidenceFloor", warning],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`validate(): ${name} must be a finite number between 0 and 1, received ${String(value)}`);
    }
  }
  if (critical > warning) {
    throw new RangeError(
      `validate(): criticalOcrConfidenceFloor (${critical}) must not exceed warningOcrConfidenceFloor (${warning})`
    );
  }
  if (typeof options.strictArithmetic !== "boolean") {
    throw new RangeError(`validate(): strictArithmetic must be a boolean, received ${String(options.strictArithmetic)}`);
  }
}

/** §4 line 419: output that violates the shape's own declared ranges. Findings, never a throw. */
function schemaFindings(parsed: ParseResult): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const badAmount = (value: number | null): boolean =>
    value !== null && (!Number.isFinite(value) || !Number.isInteger(value));
  const badPositive = (value: number | null): boolean => badAmount(value) || (value !== null && value < 0);

  for (const item of parsed.items) {
    const problems: string[] = [];
    if (badPositive(item.unitPrice)) problems.push(`unitPrice ${String(item.unitPrice)}`);
    if (badPositive(item.lineTotal)) problems.push(`lineTotal ${String(item.lineTotal)}`);
    if (item.qty !== null && (!Number.isFinite(item.qty) || !Number.isInteger(item.qty) || item.qty <= 0)) {
      problems.push(`qty ${String(item.qty)}`);
    }
    if (item.confidence !== null && (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) {
      problems.push(`confidence ${String(item.confidence)}`);
    }
    if (problems.length > 0) {
      out.push(
        finding({
          severity: "critical",
          code: "invalid_result_schema",
          scope: "item",
          message: `Item ${item.id} violates §4's declared ranges: ${problems.join(", ")}`,
          itemRefs: [item.id],
        })
      );
    }
  }

  for (const entry of positiveAmountEntries(parsed)) {
    if (badPositive(entry.amount)) {
      out.push(
        finding({
          severity: "critical",
          code: "invalid_result_schema",
          scope: "charge",
          message: `Charge ${entry.ref} is not a non-negative integer number of paise (${String(entry.amount)})`,
          chargeRefs: [entry.ref],
        })
      );
    }
  }
  if (badAmount(parsed.roundOff)) {
    out.push(
      finding({
        severity: "critical",
        code: "invalid_result_schema",
        scope: "charge",
        message: `roundOff is not an integer number of paise (${String(parsed.roundOff)})`,
        chargeRefs: ["roundOff"],
      })
    );
  }

  const ids = new Set<string>();
  for (const item of parsed.items) {
    if (ids.has(item.id)) {
      out.push(
        finding({
          severity: "critical",
          code: "invalid_result_schema",
          scope: "receipt",
          message: `Item id ${item.id} is not unique within this ParseResult, so findings could not be addressed to one item`,
        })
      );
    }
    ids.add(item.id);
  }
  for (const warning of parsed.warnings) {
    if (warning.itemRef !== undefined && !ids.has(warning.itemRef)) {
      out.push(
        finding({
          severity: "critical",
          code: "invalid_result_schema",
          scope: "receipt",
          message: `A parser warning addresses item ${warning.itemRef}, which is not in items[]`,
        })
      );
    }
  }
  return out;
}

/**
 * §7's quantity states, derived from the item's own fields rather than awaited from a parser warning: a
 * `quantitySource` is the authoritative record of the state, and a finding that only existed when the
 * parser chose to warn would vanish on a result that carries the state silently.
 */
function quantityFindings(parsed: ParseResult): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  for (const item of parsed.items) {
    if (item.qty === null || item.quantitySource === "unresolved") {
      out.push(
        finding({
          severity: "minor",
          code: "qty_unresolved",
          scope: "item",
          message: `Item ${item.id} has no attributable quantity, so units cannot be created, assigned or locked until it is resolved`,
          itemRefs: [item.id],
        })
      );
      continue;
    }
    if (item.quantitySource === "assumed") {
      out.push(
        finding({
          severity: "minor",
          code: "qty_assumed",
          scope: "item",
          message: `Item ${item.id} prints no quantity; 1 is assumed and must be reviewed before lock`,
          itemRefs: [item.id],
        })
      );
    }
  }
  return out;
}

/** §6 line 418: no resolvable price *and* no printed line total is an item with no money at all. */
function priceFindings(parsed: ParseResult): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  for (const item of parsed.items) {
    if (item.unitPrice !== null) continue;
    if (item.lineTotal === null) {
      out.push(
        finding({
          severity: "critical",
          code: "item_without_price",
          scope: "item",
          message: `Item ${item.id} has neither a resolvable price nor a printed line total, so there is nothing to split`,
          itemRefs: [item.id],
        })
      );
    } else {
      // DECISIONS/0011 V14: exactly one of the two codes per item, separated by whether the row printed
      // any money at all, so 187 unresolved prices do not become 374 findings for one fact each.
      out.push(
        finding({
          severity: "minor",
          code: "price_not_resolved",
          scope: "item",
          message: `Item ${item.id} prints a line total of ${item.lineTotal} paise but no unit price, and §7 forbids deriving one`,
          itemRefs: [item.id],
        })
      );
    }
  }
  return out;
}

/** §6 line 433: population standard deviation, evaluated only with at least 5 items. */
function nameLengthFindings(parsed: ParseResult): ValidationFinding[] {
  const items = parsed.items;
  if (items.length < NAME_OUTLIER_MIN_ITEMS) return [];
  const lengths = items.map((item) => item.name.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
  if (sd === 0) return [];
  const limit = NAME_OUTLIER_SIGMA_MULTIPLE * sd;
  const out: ValidationFinding[] = [];
  items.forEach((item, index) => {
    if (Math.abs(lengths[index]! - mean) <= limit) return;
    out.push(
      finding({
        severity: "minor",
        code: "name_length_outlier",
        scope: "item",
        message: `Item ${item.id} has a ${lengths[index]}-character name, more than ${NAME_OUTLIER_SIGMA_MULTIPLE} population standard deviations from this receipt's mean of ${mean.toFixed(1)}; a warning, not proof of an error`,
        itemRefs: [item.id],
      })
    );
  });
  return out;
}

/**
 * A `ParseWarning` says nothing about row identity, but every row-shaped warning carries its source line
 * ids and §5's preserved rows carry `u1…` with the same ids, so the two can be joined. DECISIONS/0011 V9:
 * a finding must name the row, and a warning can only name lines.
 */
function rowIndex(parsed: ParseResult): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of parsed.unclassifiedRows) {
    for (const lineId of row.sourceLineIds) {
      if (!index.has(lineId)) index.set(lineId, row.id);
    }
  }
  return index;
}

/**
 * The core extraction validator. Also the §4 line 329 boundary: parser warnings arrive with whatever
 * spelling they carry and leave canonical, and every emitted code is canonical.
 */
export function validate(
  parseResult: ParseResult,
  options: ValidateOptions = {
    criticalOcrConfidenceFloor: DEFAULT_CRITICAL_OCR_CONFIDENCE_FLOOR,
    warningOcrConfidenceFloor: DEFAULT_WARNING_OCR_CONFIDENCE_FLOOR,
    strictArithmetic: true,
  }
): ParseValidationResult {
  validateFloors(options);
  const floors = { critical: options.criticalOcrConfidenceFloor, warning: options.warningOcrConfidenceFloor };
  const rows = rowIndex(parseResult);
  const out: ValidationFinding[] = [];

  // §4 line 322: an itemless result is never a silent success. The 42 zero-item dev receipts are 05/06's
  // coverage fact, not a validator defect (DECISIONS/0011 V11).
  if (parseResult.items.length === 0) {
    out.push(
      finding({
        severity: "critical",
        code: "zero_items",
        scope: "receipt",
        message: "No items were extracted from a result expected to be an itemized receipt",
      })
    );
  }

  // §6 line 466: re-emit the parser's warnings as structured findings, with the addresses they could not
  // carry. Codes validate() derives from fields are skipped, so the fact is stated once and addressed to
  // the entity that owns it; an unknown code always passes through rather than being swallowed.
  for (const warning of parseResult.warnings) {
    if (DERIVED_CODES.has(warning.code)) continue;
    const scope = WARNING_SCOPE[warning.code] ?? "receipt";
    const rowRefs = warning.sourceLineIds?.map((id) => rows.get(id)).filter((ref): ref is string => ref !== undefined);
    out.push(
      finding({
        severity: "minor",
        code: warning.code,
        scope,
        message: warning.message,
        itemRefs: warning.itemRef ? [warning.itemRef] : undefined,
        rowRefs: rowRefs && rowRefs.length > 0 ? [...new Set(rowRefs)] : undefined,
      })
    );
  }

  for (const row of parseResult.unclassifiedRows) {
    out.push(
      finding({
        severity: "minor",
        code: "ambiguous_row",
        scope: "row",
        message: `Row ${row.id} could not be classified and is preserved for review: ${row.text}`,
        rowRefs: [row.id],
      })
    );
  }

  out.push(...quantityFindings(parseResult));
  out.push(...priceFindings(parseResult));
  out.push(...nameLengthFindings(parseResult));
  out.push(...validateConfidence(parseResult, floors));
  out.push(...validateArithmetic(parseResult, options.strictArithmetic));
  out.push(...schemaFindings(parseResult));

  // §4 line 291: advisory criticals — which only relaxed arithmetic can produce — do not make a result
  // uncertain, and never cap (DECISIONS/0011 V8).
  const uncertain = out.some((f) => f.severity === "critical" && f.advisory !== true);

  const receiptCriticals = out.some(
    (f) => f.severity === "critical" && f.advisory !== true && f.scope === "receipt"
  );
  // Items are copied, never shared: §4 line 319's no-mutation rule extends to the return path, so a
  // caller that keeps its ParseResult cannot reach a validated item's arrays by reference.
  const items = parseResult.items.map((item) => {
    const capped =
      item.confidence !== null &&
      (receiptCriticals ||
        out.some(
          (f) =>
            f.severity === "critical" &&
            f.advisory !== true &&
            f.scope === "item" &&
            f.itemRefs?.includes(item.id) === true
        ));
    return {
      ...item,
      sourceLineIds: [...item.sourceLineIds],
      // A row- or charge-scope critical is not a statement about this item's own words, so it caps nothing.
      confidence: capped ? Math.min(item.confidence!, CONFIDENCE_CAP) : item.confidence,
      warnings: item.warnings.map(copyWarning),
    };
  });

  return { uncertain, findings: out, items };
}
