/**
 * §6's conditional arithmetic validator.
 *
 * Every check here runs only where the receipt supplies both operands and their semantics are known —
 * DECISIONS/0011 V1 is the dependency graph this file implements, and a check absent from that table must
 * stay absent here. Integer paise throughout: §4 makes every amount an integer minor unit, so addition and
 * `===` comparison are exact without a floating-point equality anywhere (§5 Safeguards); the safe-integer
 * guard below is what keeps them that way.
 */

import type { ParseResult, ValidationFinding } from "../types.js";
import { advisoryize, finding, SCALAR_CHARGE_REFS, taxRef, otherChargeRef } from "./findings.js";

/** §6 line 458: the signed round-off must match `expected` within ₹0.02 and stay at or under ₹1.00. */
export const ROUND_OFF_TOLERANCE_PAISE = 2;
export const ROUND_OFF_MAX_MAGNITUDE_PAISE = 100;

function isSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * `base_computed_total` — §6 lines 445–451.
 *
 * Returns null when a required operand or its semantics are not established, which is the validator's
 * "do not compare" signal rather than a treated-as-zero one: an unclassified charge is not a zero, and a
 * missing subtotal cannot be substituted with the sum of the items (that would be computing the very
 * thing under test).
 *
 * The two exclusions behave differently on purpose and must not be merged (DECISIONS/0011 V4). A charge
 * marked `included: true` is already inside the relevant item/subtotal prices, so it is simply not added —
 * the base is still complete and the check still runs. A charge whose sign or amount is unknown makes the
 * base incomplete, so the check does not run at all.
 */
export function computedBase(parsed: ParseResult): number | null {
  if (parsed.subtotal === null) return null;
  if (parsed.taxes.some((tax) => tax.amount === null)) return null;
  if (parsed.otherCharges.some((charge) => charge.amount === null || charge.sign === "unknown")) return null;

  let base = parsed.subtotal;
  parsed.taxes.forEach((tax) => {
    if (tax.included === true || tax.amount === null) return;
    base += tax.amount;
  });
  parsed.otherCharges.forEach((charge) => {
    if (charge.included === true || charge.amount === null) return;
    base += charge.sign === "subtract" ? -charge.amount : charge.amount;
  });
  base += parsed.serviceCharge ?? 0;
  base += parsed.tip ?? 0;
  base -= parsed.discount ?? 0;
  return isSafeInteger(base) ? base : null;
}

/** The operand refs a reconciliation finding is addressed to. */
function totalOperandRefs(parsed: ParseResult): string[] {
  const refs: string[] = [SCALAR_CHARGE_REFS.subtotal, SCALAR_CHARGE_REFS.grandTotal];
  parsed.taxes.forEach((_tax, index) => refs.push(taxRef(index)));
  parsed.otherCharges.forEach((_charge, index) => refs.push(otherChargeRef(index)));
  if (parsed.serviceCharge !== null) refs.push(SCALAR_CHARGE_REFS.service);
  if (parsed.tip !== null) refs.push(SCALAR_CHARGE_REFS.tip);
  if (parsed.discount !== null) refs.push(SCALAR_CHARGE_REFS.discount);
  if (parsed.roundOff !== null) refs.push(SCALAR_CHARGE_REFS.roundOff);
  return refs;
}

export function validateArithmetic(parsed: ParseResult, strictArithmetic: boolean): ValidationFinding[] {
  const out: ValidationFinding[] = [];

  // --- item-sum branch: needs a printed subtotal *and* full line-total coverage (V1 rows 2–6) ---
  const totals = parsed.items.filter((item) => item.lineTotal !== null);
  if (parsed.items.length > 0 && parsed.subtotal !== null) {
    if (totals.length !== parsed.items.length) {
      // V1 row 3: the list is not whole, so any difference is unmeasured rather than contradictory.
      const missing = parsed.items.filter((item) => item.lineTotal === null).map((item) => item.id);
      out.push(
        finding(
          advisoryize(
            {
              severity: "minor",
              code: "items_may_be_missing",
              scope: "receipt",
              message: `${totals.length} of ${parsed.items.length} items have a printed line total, so the item sum cannot be compared with the printed subtotal of ${parsed.subtotal} paise`,
              itemRefs: missing,
            },
            strictArithmetic
          )
        )
      );
    } else {
      const sum = totals.reduce((acc, item) => acc + (item.lineTotal ?? 0), 0);
      if (isSafeInteger(sum) && sum !== parsed.subtotal) {
        // V3: coverage plausibility is not computable from a ParseResult — validate() cannot know how many
        // item rows the receipt printed. The sign of the difference is what is computable, and it separates
        // the two explanations §6 line 459 distinguishes: absent rows can only make the sum small.
        if (sum > parsed.subtotal) {
          out.push(
            finding(
              advisoryize(
                {
                  severity: "critical",
                  code: "arithmetic_item_sum",
                  scope: "receipt",
                  message: `Item line totals sum to ${sum} paise against a printed subtotal of ${parsed.subtotal} paise (+${sum - parsed.subtotal}); with every item carrying a line total, missing rows cannot explain the excess`,
                },
                strictArithmetic
              )
            )
          );
        } else {
          out.push(
            finding(
              advisoryize(
                {
                  severity: "minor",
                  code: "items_may_be_missing",
                  scope: "receipt",
                  message: `Item line totals sum to ${sum} paise against a printed subtotal of ${parsed.subtotal} paise (−${parsed.subtotal - sum}); rows appear to be missing rather than contradicted`,
                },
                strictArithmetic
              )
            )
          );
        }
      }
    }
  }

  // --- total-reconciliation branch: needs grand total, subtotal, and every charge's semantics (V1 rows 7–13) ---
  if (parsed.grandTotal !== null) {
    const base = computedBase(parsed);
    if (base !== null) {
      const expected = parsed.grandTotal - base;
      if (isSafeInteger(expected)) {
        if (parsed.roundOff !== null) {
          const withinTolerance = Math.abs(parsed.roundOff - expected) <= ROUND_OFF_TOLERANCE_PAISE;
          const withinMagnitude = Math.abs(parsed.roundOff) <= ROUND_OFF_MAX_MAGNITUDE_PAISE;
          if (withinTolerance && withinMagnitude) {
            // §6 line 458: a valid printed round-off is an exception that *passes*, reported as information.
            out.push(
              finding(
                advisoryize(
                  {
                    severity: "minor",
                    code: "round_off_adjusted",
                    scope: "charge",
                    message: `Printed round-off of ${parsed.roundOff} paise reconciles the total within ${ROUND_OFF_TOLERANCE_PAISE} paise of the expected ${expected} paise`,
                    chargeRefs: [...totalOperandRefs(parsed)],
                  },
                  strictArithmetic
                )
              )
            );
          } else {
            out.push(
              finding(
                advisoryize(
                  {
                    severity: "critical",
                    code: "arithmetic_total",
                    scope: "receipt",
                    message: `Printed round-off of ${parsed.roundOff} paise does not reconcile the base ${base} paise with the printed grand total of ${parsed.grandTotal} paise (expected ${expected} paise)`,
                    chargeRefs: [...totalOperandRefs(parsed)],
                  },
                  strictArithmetic
                )
              )
            );
          }
        } else if (expected !== 0) {
          out.push(
            finding(
              advisoryize(
                {
                  severity: "critical",
                  code: "arithmetic_total",
                  scope: "receipt",
                  message: `Printed grand total of ${parsed.grandTotal} paise does not reconcile with subtotal plus charges (${base} paise, off by ${expected} paise) and no round-off was printed`,
                  chargeRefs: [...totalOperandRefs(parsed)],
                },
                strictArithmetic
              )
            )
          );
        }
      }
    }
  }

  return out;
}
