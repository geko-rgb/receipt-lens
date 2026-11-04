import type {
  BillCharge,
  DraftCharge,
  DraftItem,
  FinalizationBlocker,
  Item,
  WorkingBill,
} from "./working-bill.js";
import { isCountableQuantity, isUnitPricePaise } from "./working-bill.js";
import type { FinalPriceSource, FinalQuantitySource } from "@receipt-lens/core";
import { INCLUSION_AFFECTING_CHARGE_TYPES } from "./mapping.js";

/**
 * Draft → finalized (ROADMAP 3C.2). §10 line 764 is the whole point of the two tiers: a draft may hold
 * `null`s, a finalized `Item`/`BillCharge` may not. DECISIONS/0020 T6 pins which gates apply and — the
 * half that is easier to get wrong — which do not.
 */
export interface FinalizationCheck {
  ok: boolean;
  blockers: FinalizationBlocker[];
}

/**
 * §10 line 765's four conditions, plus the review condition. Not gates: an unreviewed *assumed* quantity
 * (that is `assumed_qty_unreviewed`, a locking blocker per §10 line 804), a `line_total_mismatch`, a
 * below-warning confidence, and any receipt-level arithmetic finding — the last because making one item
 * wait for the whole bill to reconcile would invert §13's Draft → Ready-to-lock order.
 */
export function checkDraftItemFinalizable(draft: DraftItem, working: WorkingBill): FinalizationCheck {
  const blockers: FinalizationBlocker[] = [];

  if (draft.name.trim() === "") blockers.push("name_missing");

  if (draft.qty === null || draft.quantitySource === "unresolved") blockers.push("qty_unresolved");
  else if (!isCountableQuantity(draft.qty)) blockers.push("qty_invalid");

  if (draft.unitPrice === null || draft.priceSource === "unresolved") blockers.push("price_unresolved");
  else if (!isUnitPricePaise(draft.unitPrice)) blockers.push("price_unresolved");

  // Read the validator's output, not the parser's warnings: §6 line 408's caps and §6 line 417's
  // `item_without_price` are validation results, and 0011 V10's canonicalisation happens at that boundary.
  const unreviewedCritical = (working.parseValidation?.findings ?? []).some(
    (finding) =>
      finding.severity === "critical" &&
      finding.advisory !== true &&
      finding.scope === "item" &&
      (finding.itemRefs ?? []).includes(draft.id),
  );
  if (unreviewedCritical) blockers.push("review_required");

  return { ok: blockers.length === 0, blockers };
}

/** §10 line 766: amount, type/sign semantics, and inclusion wherever that distinction affects arithmetic. */
export function checkDraftChargeFinalizable(draft: DraftCharge): FinalizationCheck {
  const blockers: FinalizationBlocker[] = [];

  if (draft.type === null) blockers.push("charge_type_unresolved");
  if (draft.amount === null) blockers.push("charge_amount_unresolved");
  if (draft.type === "other" && (draft.otherSign === null || draft.otherSign === undefined || draft.otherSign === "unknown")) {
    blockers.push("charge_sign_unresolved");
  }
  if (draft.type !== null && INCLUSION_AFFECTING_CHARGE_TYPES.includes(draft.type) && draft.included === null) {
    blockers.push("charge_inclusion_unresolved");
  }

  return { ok: blockers.length === 0, blockers };
}

/**
 * `detectedLineTotal` takes the parsed row total here and is immutable afterwards (§10 line 631,
 * DECISIONS/0020 T5) while `lineTotal` is the live `qty × unitPrice`. Keeping the two apart is what lets
 * validation compare them instead of overwriting the printed fact (§10 line 784). The id survives, so the
 * row the user was looking at stays the row the units hang off.
 *
 * Both operands are integers at this point — `isCountableQuantity` and `isUnitPricePaise` are the gates —
 * so the product is exact paise with no rounding step.
 */
export function toFinalizedItem(draft: DraftItem, billId: string): Item {
  return {
    id: draft.id,
    billId,
    name: draft.name.trim(),
    qty: draft.qty as number,
    quantitySource: draft.quantitySource as FinalQuantitySource,
    unitPrice: draft.unitPrice as number,
    priceSource: draft.priceSource as FinalPriceSource,
    lineTotal: (draft.qty as number) * (draft.unitPrice as number),
    detectedLineTotal: draft.lineTotal,
    confidence: draft.confidence,
    assumedQtyReviewed: draft.assumedQtyReviewed,
  };
}

export function toFinalizedCharge(draft: DraftCharge, billId: string): BillCharge {
  const charge: BillCharge = {
    id: draft.id,
    billId,
    type: draft.type as BillCharge["type"],
    label: draft.label,
    amount: draft.amount as number,
    rate: draft.rate ?? null,
    included: draft.included as boolean,
    source: draft.source,
  };
  // §10: `otherSign` is "used only when type = other", so it is absent rather than null on every other type.
  if (charge.type === "other" && draft.otherSign !== null && draft.otherSign !== undefined) {
    charge.otherSign = draft.otherSign;
  }
  return charge;
}
