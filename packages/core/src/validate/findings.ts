import type { ParseResult, ParseWarning, ValidationFinding, ValidationScope, ValidationSeverity } from "../types.js";

/**
 * §4 line 329: `name_confidence_low` and `price_confidence_low` are canonical, and the legacy spellings
 * map at the API boundary rather than living on as a second meaning for the same code. They cannot appear
 * in `ParseWarningCode`, so this is a runtime normalisation of incoming data, not a type widening.
 */
const LEGACY_CODES: Readonly<Record<string, ParseWarning["code"]>> = {
  low_name_confidence: "name_confidence_low",
  low_price_confidence: "price_confidence_low",
};

/** Unknown codes pass through unchanged: a future parser code must not be swallowed by the validator. */
export function canonicalCode(code: string): string {
  return LEGACY_CODES[code] ?? code;
}

/**
 * A validated item carries its own warnings: canonicalised at the boundary and copied rather than shared,
 * so nothing in `validation.items` aliases a nested object of the `ParseResult` it came from.
 */
export function copyWarning(warning: ParseWarning): ParseWarning {
  const out: ParseWarning = { ...warning, code: canonicalCode(warning.code) as ParseWarning["code"] };
  if (warning.sourceLineIds) out.sourceLineIds = [...warning.sourceLineIds];
  if (warning.sourceBox) out.sourceBox = { ...warning.sourceBox };
  return out;
}

/**
 * §4's charge shapes carry no `id`, and `serviceCharge`/`tip`/`discount`/`roundOff`/`subtotal`/
 * `grandTotal` are bare numbers, so §6 line 394's "addressed to the charge that caused it" needs a
 * convention. Position-derived and deterministic, exactly like 05/06's `i1`/`u1` ids (DECISIONS/0008).
 * DECISIONS/0011 V9.
 */
export function taxRef(index: number): string {
  return `t${index + 1}`;
}

export function otherChargeRef(index: number): string {
  return `o${index + 1}`;
}

export const SCALAR_CHARGE_REFS = {
  service: "service",
  tip: "tip",
  discount: "discount",
  roundOff: "roundOff",
  subtotal: "subtotal",
  grandTotal: "grandTotal",
} as const;

export interface FindingSeed {
  readonly severity: ValidationSeverity;
  readonly code: string;
  readonly scope: ValidationScope;
  readonly message: string;
  readonly itemRefs?: readonly string[];
  readonly rowRefs?: readonly string[];
  readonly chargeRefs?: readonly string[];
  readonly advisory?: boolean;
}

/** Addresses are emitted only when non-empty, so a receipt-scope finding never carries an empty array. */
export function finding(seed: FindingSeed): ValidationFinding {
  const out: ValidationFinding = {
    severity: seed.severity,
    code: canonicalCode(seed.code),
    scope: seed.scope,
    message: seed.message,
  };
  if (seed.itemRefs && seed.itemRefs.length > 0) out.itemRefs = [...seed.itemRefs];
  if (seed.rowRefs && seed.rowRefs.length > 0) out.rowRefs = [...seed.rowRefs];
  if (seed.chargeRefs && seed.chargeRefs.length > 0) out.chargeRefs = [...seed.chargeRefs];
  if (seed.advisory === true) out.advisory = true;
  return out;
}

/** §6 line 462: relaxed mode marks arithmetic findings advisory. Nothing else has an advisory mode. */
export function advisoryize(seed: FindingSeed, strictArithmetic: boolean): FindingSeed {
  return strictArithmetic ? seed : { ...seed, advisory: true };
}

/**
 * Every amount §4 declares a positive magnitude in paise. `roundOff` is excluded: it is signed by
 * contract, so a negative value there is the printed sign, not a range violation.
 */
export function positiveAmountEntries(parsed: ParseResult): { ref: string; amount: number | null }[] {
  const out: { ref: string; amount: number | null }[] = [];
  parsed.taxes.forEach((tax, index) => out.push({ ref: taxRef(index), amount: tax.amount }));
  parsed.otherCharges.forEach((charge, index) => out.push({ ref: otherChargeRef(index), amount: charge.amount }));
  out.push({ ref: SCALAR_CHARGE_REFS.service, amount: parsed.serviceCharge });
  out.push({ ref: SCALAR_CHARGE_REFS.tip, amount: parsed.tip });
  out.push({ ref: SCALAR_CHARGE_REFS.discount, amount: parsed.discount });
  out.push({ ref: SCALAR_CHARGE_REFS.subtotal, amount: parsed.subtotal });
  out.push({ ref: SCALAR_CHARGE_REFS.grandTotal, amount: parsed.grandTotal });
  return out;
}
