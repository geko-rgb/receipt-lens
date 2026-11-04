import type { DerivedBillState } from "./totals.js";
import type { BillValidationResult, WorkingBill } from "./working-bill.js";
import type { ValidationFinding } from "@receipt-lens/core";

/**
 * The committed unit (DECISIONS/0019 S3). One document holds the data, the numbers derived from it, and
 * both validation results, because §6 line 400's failure clause forbids *displaying* derived state from a
 * failed mutation — which is only implementable if that state cannot exist without the data it came from.
 * A transaction therefore either produces a whole new document or produces nothing at all, and rollback is
 * object identity rather than an undo path in every reader.
 */
export interface BillDocument {
  readonly revision: number;
  readonly working: WorkingBill;
  readonly derived: DerivedBillState;
  readonly billValidation: BillValidationResult;
}

/**
 * The arithmetic §6 line 457-459 computes from the parse. Once a bill exists, the PWA's own recomputation
 * over the working state is the authority for this *family* — not merely for the codes it happened to emit,
 * because an edited bill can legitimately answer a different member of the family than the untouched parse
 * did (over-sum becomes under-sum once the phantom line is deleted). DECISIONS/0020 T8.
 */
const STALE_ARITHMETIC_FAMILY: readonly string[] = [
  "arithmetic_item_sum",
  "arithmetic_total",
  "items_may_be_missing",
  "round_off_adjusted",
];

/**
 * Every finding the UI may show, in the order §6 line 400 establishes: core's extraction findings with the
 * arithmetic family removed (the PWA recomputed it over the edited state), then the PWA's bill-state
 * findings. Everything core says about *extraction* — confidence, `qty_assumed`, `ambiguous_row`,
 * `price_not_resolved`, `unclassified_charge` — is evidence about the receipt and stays verbatim whatever
 * the creator does to the bill.
 *
 * The UI never infers a blocker from message text (§6 line 401), so this list is display material only:
 * `billValidation.blockers` is the action contract.
 */
export function visibleFindings(document: BillDocument): ValidationFinding[] {
  const coreFindings = document.working.parseValidation?.findings ?? [];
  const kept = coreFindings.filter((finding) => !STALE_ARITHMETIC_FAMILY.includes(finding.code));
  return [...kept, ...document.billValidation.findings];
}

/**
 * §7 of DECISIONS/0019: the committed value is frozen, because the runner builds each document by copying
 * the entity it changes and reusing the rest, and a stray in-place write would corrupt the same object
 * that ticket 14 persists, that `validateWorkingBill` reads and that ticket 16 snapshots.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
