import type { ValidationFinding, ValidationScope, ValidationSeverity } from "@receipt-lens/core";
import { compare, fromPaise } from "./exact-money.js";
import { checkDraftChargeFinalizable, checkDraftItemFinalizable } from "./bill/finalize.js";
import { ROUND_OFF_MAX_PAISE, ROUND_OFF_TOLERANCE_PAISE, recomputeDerived, unacknowledgedUnits } from "./bill/totals.js";
import type {
  AssignmentBlocker,
  BillFindingCode,
  BillValidationResult,
  FinalizationBlocker,
  LockBlocker,
  UnitCreationBlocker,
  WorkingBill,
} from "./bill/working-bill.js";
import { isCountableQuantity } from "./bill/working-bill.js";

/**
 * §6 line 399's PWA-owned validator, at the path §6 names. Core `validate()` sees a `ParseResult` and knows
 * nothing about drafts, participants or lock state; everything about *this bill's* state is here.
 *
 * One argument, as §6 signs it: the function recalculates the working totals, applicable charges, exact
 * shares and reconciliation itself, by calling the same `recomputeDerived` the transaction's step 2 ran on
 * the same input (DECISIONS/0020 T8). So `derived` and `blockers` cannot disagree, §11's arithmetic lives in
 * one place, and no caller can pass a `derived` that does not match its `working`.
 *
 * The UI consumes codes only (§6 line 401: "The UI uses codes, never message text, to determine whether an
 * action is blocked"), and `LockBlocker` is never nested inside core's result.
 */
/**
 * §4 types `ValidationFinding.code` as an open string, so the PWA's closed code set is enforced here rather
 * than in the shared type. Addresses are attached only when non-empty, the same convention core's `finding()`
 * uses (DECISIONS/0011 V9), so a receipt-scope finding never carries an empty array.
 */
function billFinding(seed: {
  code: BillFindingCode;
  severity: ValidationSeverity;
  scope: ValidationScope;
  message: string;
  itemRefs?: string[];
  chargeRefs?: string[];
}): ValidationFinding {
  const finding: ValidationFinding = {
    severity: seed.severity,
    code: seed.code,
    scope: seed.scope,
    message: seed.message,
  };
  if (seed.itemRefs && seed.itemRefs.length > 0) finding.itemRefs = [...seed.itemRefs];
  if (seed.chargeRefs && seed.chargeRefs.length > 0) finding.chargeRefs = [...seed.chargeRefs];
  return finding;
}

export function validateWorkingBill(workingBill: WorkingBill): BillValidationResult {
  const derived = recomputeDerived(workingBill);
  const findings: ValidationFinding[] = [];
  const unitCreation = new Set<UnitCreationBlocker>();
  const assignment = new Set<AssignmentBlocker>();
  const finalization = new Set<FinalizationBlocker>();
  const locking: LockBlocker[] = [];

  const participantIds = new Set(workingBill.participants.map((participant) => participant.id));

  // --- drafts: what still cannot become a bill line, and why (DECISIONS/0020 T6) -----------------------
  const unresolvedItemRefs: string[] = [];
  for (const draft of workingBill.draftItems) {
    const check = checkDraftItemFinalizable(draft, workingBill);
    if (!check.ok) {
      unresolvedItemRefs.push(draft.id);
      for (const blocker of check.blockers) finalization.add(blocker);
    }
    // Units exist only under a finalized item (§10 line 765), so an open draft blocks unit creation as such.
    unitCreation.add("item_not_finalized");
    if (draft.qty === null || draft.quantitySource === "unresolved") unitCreation.add("qty_unresolved");
    else if (!isCountableQuantity(draft.qty)) unitCreation.add("qty_invalid");
  }

  // §10's two charge blockers are disjoint by cause, not nested: amount/type/sign versus inclusion (0020 T8).
  const amountTypeSignChargeRefs: string[] = [];
  const inclusionChargeRefs: string[] = [];
  for (const draft of workingBill.draftCharges) {
    const check = checkDraftChargeFinalizable(draft);
    if (check.ok) continue;
    for (const blocker of check.blockers) finalization.add(blocker);
    if (check.blockers.includes("charge_inclusion_unresolved")) inclusionChargeRefs.push(draft.id);
    if (
      check.blockers.includes("charge_amount_unresolved") ||
      check.blockers.includes("charge_type_unresolved") ||
      check.blockers.includes("charge_sign_unresolved")
    ) {
      amountTypeSignChargeRefs.push(draft.id);
    }
  }

  // --- finalized lines: §10's invariants and the printed-vs-calculated comparison ----------------------
  for (const item of workingBill.items) {
    if (workingBill.itemUnits.filter((unit) => unit.itemId === item.id).length !== item.qty) {
      assignment.add("unit_missing");
    }
    if (item.detectedLineTotal !== null && item.detectedLineTotal !== item.lineTotal) {
      // §10 line 784: validation compares the two instead of overwriting the printed fact.
      findings.push(
        billFinding({
          severity: "minor",
          code: "line_total_mismatch",
          scope: "item",
          message: `${item.id} calculates ${item.lineTotal} paise against a printed row total of ${item.detectedLineTotal} paise`,
          itemRefs: [item.id],
        }),
      );
    }
  }

  if (workingBill.assignments.some((entry) => !participantIds.has(entry.participantId))) {
    assignment.add("participant_unknown");
  }
  const seenPairs = new Set<string>();
  for (const entry of workingBill.assignments) {
    const pair = `${entry.itemUnitId}|${entry.participantId}`;
    if (seenPairs.has(pair)) assignment.add("assignment_duplicate");
    seenPairs.add(pair);
  }

  const unreviewedAssumedRefs = [...workingBill.draftItems, ...workingBill.items]
    .filter((line) => line.quantitySource === "assumed" && !line.assumedQtyReviewed)
    .map((line) => line.id);

  // --- the arithmetic, over the bill's own values (§6 line 399's "not stale ParseResult arithmetic") ---
  if (derived.printedSubtotal !== null) {
    if (derived.calculatedItemsTotal > derived.printedSubtotal) {
      findings.push(
        billFinding({
          severity: "critical",
          code: "arithmetic_item_sum",
          scope: "receipt",
          message: `the bill's item lines total ${derived.calculatedItemsTotal} paise against a printed subtotal of ${derived.printedSubtotal} paise`,
        }),
      );
    } else if (derived.calculatedItemsTotal < derived.printedSubtotal) {
      // DECISIONS/0011 V3: an under-sum is what a missing row looks like, and a missing row is not a thing a
      // per-item edit resolves — so this branch is the warning, never the contradiction.
      findings.push(
        billFinding({
          severity: "minor",
          code: "items_may_be_missing",
          scope: "receipt",
          message: `the bill's item lines total ${derived.calculatedItemsTotal} paise, below a printed subtotal of ${derived.printedSubtotal} paise`,
        }),
      );
    }
  }

  const roundOffCharge = workingBill.charges.find((charge) => charge.type === "round_off" && !charge.included);
  if (derived.reconciliationGap !== null && derived.reconciliationGap !== 0) {
    const withinBand =
      roundOffCharge !== undefined &&
      Math.abs(derived.reconciliationGap) <= ROUND_OFF_TOLERANCE_PAISE &&
      Math.abs(roundOffCharge.amount) <= ROUND_OFF_MAX_PAISE;
    findings.push(
      withinBand
        ? billFinding({
            severity: "minor",
            code: "round_off_adjusted",
            scope: "receipt",
            message: `the printed round-off of ${roundOffCharge!.amount} paise reconciles the total within ${ROUND_OFF_TOLERANCE_PAISE} paise`,
            chargeRefs: [roundOffCharge!.id],
          })
        : billFinding({
            severity: "critical",
            code: "arithmetic_total",
            scope: "receipt",
            message: `the bill totals ${derived.calculatedPayableTotal} paise against a printed grand total of ${derived.printedGrandTotal} paise`,
          }),
    );
  }

  // --- shares: asserted only when they are computable at all (DECISIONS/0020 T7) ----------------------
  const negativeShareRefs = (derived.shares ?? [])
    .filter((share) => compare(share.exactAmount, fromPaise(0)) < 0)
    .map((share) => share.participantId);
  if (negativeShareRefs.length > 0) {
    findings.push(
      billFinding({
        severity: "critical",
        code: "negative_share",
        scope: "receipt",
        message: "discount allocation would leave a participant owing less than nothing",
      }),
    );
  }

  // --- rows the parse could not classify (§10 line 807) -----------------------------------------------
  // A row is explained while some live line still reads it. Ids survive finalization (0020 T6), so a draft or
  // an item both map back to the parsed row that supplied its `sourceLineIds`.
  const liveIds = new Set([...workingBill.draftItems, ...workingBill.items].map((line) => line.id));
  const claimedLineIds = new Set<string>();
  for (const parsed of workingBill.parseResult?.items ?? []) {
    if (!liveIds.has(parsed.id)) continue;
    for (const lineId of parsed.sourceLineIds) claimedLineIds.add(lineId);
  }
  const unreviewedRowRefs = workingBill.unclassifiedRows
    .filter((row) => !row.sourceLineIds.some((lineId) => claimedLineIds.has(lineId)))
    .map((row) => row.id);

  // --- the nine locking blockers (§10 lines 798-808) -------------------------------------------------
  const pendingUnits = unacknowledgedUnits(workingBill.itemUnits, workingBill.assignments).map((unit) => unit.id);
  const lock = (code: LockBlocker["code"], refs?: string[]) => {
    locking.push(refs && refs.length > 0 ? { code, refs } : { code });
  };
  if (unresolvedItemRefs.length > 0) lock("draft_items_unresolved", unresolvedItemRefs);
  if (amountTypeSignChargeRefs.length > 0) lock("draft_charges_unresolved", amountTypeSignChargeRefs);
  if (inclusionChargeRefs.length > 0) lock("tax_inclusion_unresolved", inclusionChargeRefs);
  if (pendingUnits.length > 0) lock("units_unassigned", pendingUnits);
  if (unreviewedAssumedRefs.length > 0) lock("assumed_qty_unreviewed", unreviewedAssumedRefs);
  if (workingBill.bill.grandTotal === null) lock("grand_total_missing");
  if (!participantIds.has(workingBill.bill.payerId)) lock("payer_missing", [workingBill.bill.payerId]);
  if (unreviewedRowRefs.length > 0) lock("unclassified_rows_unreviewed", unreviewedRowRefs);
  if (negativeShareRefs.length > 0) lock("negative_share_after_discount", negativeShareRefs);

  return {
    findings,
    blockers: {
      unitCreation: [...unitCreation].sort(),
      assignment: [...assignment].sort(),
      finalization: [...finalization].sort(),
      locking,
    },
  };
}
