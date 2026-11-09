import type {
  FinalPriceSource,
  FinalQuantitySource,
  ParseResult,
  ParseValidationResult,
  ParseWarning,
  ParticipantId,
  PriceSource,
  QuantitySource,
  UnclassifiedRow,
  ValidationFinding,
  ValueSource,
} from "@receipt-lens/core";
import type {
  AdjustmentLine,
  Bill,
  BillCharge,
  ChargeType,
  Item,
  ItemUnit,
  ItemUnitAssignment,
  Participant,
} from "../entities.js";

/**
 * The PWA data model of PROJECT(1).md §10 that ticket 02's `entities.ts` did not already own: the draft
 * tier, the validation vocabulary and the whole mutable state. §10 owns these shapes; nothing here widens
 * them. §10 leaves three blocker arrays as `string[]` with no vocabulary — DECISIONS/0020 T8 closes it,
 * and the closed unions below are that record, not an invention of this file.
 */

export type {
  AdjustmentLine,
  Bill,
  BillCharge,
  ChargeType,
  FinalPriceSource,
  FinalQuantitySource,
  Item,
  ItemUnit,
  ItemUnitAssignment,
  Participant,
  ParticipantId,
  PriceSource,
  QuantitySource,
  ValueSource,
};

/** §10 line 607: import/edit-stage item; may hold nulls a finalized `Item` may not. */
export interface DraftItem {
  id: string;
  parsedRef?: string;
  name: string;
  qty: number | null;
  quantitySource: QuantitySource;
  /** integer paise */
  unitPrice: number | null;
  priceSource: PriceSource;
  /** the detected row total, or null when the row printed none (§10 line 615) */
  lineTotal: number | null;
  confidence: number | null;
  warnings: ParseWarning[];
  assumedQtyReviewed: boolean;
  manuallyAdded: boolean;
}

/** §10 line 660: import/edit-stage charge; `type`, `amount`, `included` and `otherSign` may be unresolved. */
export interface DraftCharge {
  id: string;
  parsedRef?: string;
  type: ChargeType | null;
  label: string;
  /** integer paise, or null while unresolved */
  amount: number | null;
  rate?: number | null;
  /** null until inclusion semantics are known — never inferred (DECISIONS/0011 V4) */
  included: boolean | null;
  otherSign?: "add" | "subtract" | "unknown" | null;
  source: "detected" | "user_confirmed";
  manuallyAdded: boolean;
}

/** §10 line 674: the nine locking blockers, verbatim and unmodified. */
export type LockBlockerCode =
  | "draft_items_unresolved"
  | "draft_charges_unresolved"
  | "tax_inclusion_unresolved"
  | "units_unassigned"
  | "assumed_qty_unreviewed"
  | "grand_total_missing"
  | "payer_missing"
  | "unclassified_rows_unreviewed"
  | "negative_share_after_discount";

/** §10 line 678. PWA-owned, and never nested inside core's `ParseValidationResult` (§6 line 401). */
export interface LockBlocker {
  code: LockBlockerCode;
  refs?: string[];
}

/**
 * §10 types these three arrays `string[]`. The closed unions are DECISIONS/0020 T8's vocabulary, and they
 * still satisfy §10's shape. Per-entity addressing comes from `findings[].itemRefs/rowRefs/chargeRefs`
 * (DECISIONS/0011 V9's convention), never from these arrays.
 */
export type UnitCreationBlocker = "item_not_finalized" | "qty_unresolved" | "qty_invalid";

export type AssignmentBlocker = "unit_missing" | "participant_unknown" | "assignment_duplicate";

export type FinalizationBlocker =
  | "name_missing"
  | "price_unresolved"
  | "qty_unresolved"
  | "qty_invalid"
  | "review_required"
  | "charge_amount_unresolved"
  | "charge_type_unresolved"
  | "charge_sign_unresolved"
  | "charge_inclusion_unresolved";

/** §10 line 692, with no field added. */
export interface BillValidationResult {
  findings: ValidationFinding[];
  blockers: {
    unitCreation: UnitCreationBlocker[];
    assignment: AssignmentBlocker[];
    finalization: FinalizationBlocker[];
    locking: LockBlocker[];
  };
}

/**
 * Ticket 23. One preserved row a human has read and accepted as-is: the row's own text and the moment of the
 * decision, which is what makes it *review evidence* rather than a parser class.
 *
 * It is deliberately not a classification. `unclassifiedRows` stays exactly as `parse()` produced it, so the
 * two are distinguishable in the stored bill, in an export and on screen, and no rule can derive one from the
 * other — §5 rule 7 forbids the parser from discarding a row, and this field is the human's answer, not the
 * parser's. It carries no arithmetic (an acknowledged row has no amount), so excluding and acknowledging a row
 * are different acts that survive a reload as such.
 */
export interface AcknowledgedRow {
  /** The `UnclassifiedRow.id` this decision is about. */
  rowId: string;
  /** The row's text as the human read it — the same evidence shape the parser uses. */
  text: string;
  /** ISO timestamp of the human decision, supplied by the caller (0011's determinism rule). */
  acknowledgedAt: string;
}

/** §10 line 679: the whole mutable state — the unit of persistence and of validation. */
export interface WorkingBill {
  bill: Bill;
  draftItems: DraftItem[];
  items: Item[];
  draftCharges: DraftCharge[];
  charges: BillCharge[];
  participants: Participant[];
  itemUnits: ItemUnit[];
  assignments: ItemUnitAssignment[];
  unclassifiedRows: UnclassifiedRow[];
  parseResult: ParseResult | null;
  parseValidation: ParseValidationResult | null;
  /**
   * DECISIONS/0022 L1: ambiguous rows the creator has accounted for. PWA review state, not core parse
   * output — which is why it sits here rather than on `UnclassifiedRow`. §10 carries the authorized note.
   */
  excludedRowIds: string[];
  /**
   * Ticket 23: preserved rows the creator has read and acknowledged, in row order. Undoable while the bill is
   * unlocked, voided (not deleted) when a row starts carrying an amount, and carried into a share snapshot so a
   * recipient can see what the owner admitted (see `lib/bill/acknowledge.ts` for the validity rules).
   */
  acknowledgedRows: AcknowledgedRow[];
  /**
   * DECISIONS/0022 L6: ISO timestamp of the most recent unlock; null until the first one. A snapshot whose
   * `snapshotCreatedAt` precedes it came from an earlier lock of this bill.
   */
  staleLinkCutoffAt: string | null;
}

/** §4's `ValidationFinding.code` is an open string; these are the PWA's bill-state codes (0020 T8). */
export type BillFindingCode =
  | "line_total_mismatch"
  | "arithmetic_item_sum"
  | "items_may_be_missing"
  | "arithmetic_total"
  | "round_off_adjusted"
  | "negative_share";

/**
 * The leaf validity rules of §10's entity contract, kept here so `finalize`, `units`, `totals` and
 * `transactions` all read one definition instead of restating §7's "finite and positive" and business.md
 * §5.1's "integer paise" four times.
 */

/** An exact paise amount: a finite safe integer. Not `null`, not fractional, not a float that only looks round. */
export function isIntegerPaise(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** A resolved unit price: §10 line 765's "non-negative", and a zero is a real price (a free or fully discounted line). */
export function isUnitPricePaise(value: unknown): value is number {
  return isIntegerPaise(value) && value >= 0;
}

/**
 * A countable quantity: §7 line 485's "finite and positive" plus §11 rule 2's `unitIndex 0..qty−1`, which
 * together mean a positive integer. `1.5` has no representation in the unit model (DECISIONS/0020 T6).
 */
export function isCountableQuantity(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * A charge amount: `round_off` is signed by contract (§11 rule 8), every other type is a positive
 * magnitude (§4's public shape). Zero is allowed — a printed `DISC 0.00` is a fact about the receipt.
 */
export function isChargeAmountPaise(type: ChargeType | null, value: unknown): value is number {
  if (!isIntegerPaise(value)) return false;
  return type === "round_off" || value >= 0;
}
