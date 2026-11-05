import { validate } from "@receipt-lens/core";
import type { ParseResult, ParseValidationResult } from "@receipt-lens/core";
import { validateWorkingBill } from "../validate-bill.js";
import { deepFreeze, type BillDocument } from "./document.js";
import {
  checkDraftItemFinalizable,
  finalizeResolvable,
  finalizeResolvableCharges,
  toFinalizedItem,
} from "./finalize.js";
import { createWorkingBill, type NewBillOptions } from "./mapping.js";
import { recompute, type RecomputeResult } from "./totals.js";
import { assignPair, materializeUnits, syncUnitsToQuantity, unassignPair } from "./units.js";
import type {
  BillCharge,
  BillValidationResult,
  ChargeType,
  DraftCharge,
  DraftItem,
  Item,
  ItemUnitAssignment,
  Participant,
  ValueSource,
  WorkingBill,
} from "./working-bill.js";
import {
  isChargeAmountPaise,
  isCountableQuantity,
  isIntegerPaise,
  isUnitPricePaise,
} from "./working-bill.js";

/**
 * The transaction contract, §6 line 400 verbatim: persist the changed working state atomically →
 * recalculate derived exact totals/shares → run core `validate()` → run `validateWorkingBill()` → update UI
 * findings/blockers. If it fails, roll back and display no derived state from the failed mutation.
 *
 * Steps 2–4 are injectable dependencies rather than inline calls, so the order is *proved* rather than
 * assumed: `tests/bill/pins.test.ts` wraps them to record the sequence and to throw at each one in turn,
 * then asserts the returned document is the input document by identity (DECISIONS/0019 S2.2, 0020 T12).
 */

/** DECISIONS/0020 T1. Findings and blockers are deliberately absent: they never fail a transaction. */
export type TransactionRejectCode =
  | "invalid_amount"
  | "invalid_quantity"
  | "unknown_entity"
  | "bill_locked"
  | "not_finalizable"
  | "recompute_failed"
  | "unit_assigned"
  // DECISIONS/0021 A3: two conditions no existing code described, added deliberately rather than squeezed
  // into a code that means something else. The closed union widens per operation kind, not ad hoc.
  | "assignment_duplicate"
  | "invalid_name"
  // DECISIONS/0022 L12: four conditions no earlier code described, each with its own remedy.
  | "lock_blocked"
  | "items_unfinalized"
  | "unlock_unconfirmed"
  | "not_locked"
  | "participant_paid"
  | "protected_participant";

export interface TransactionReject {
  code: TransactionRejectCode;
  refs: string[];
  message: string;
}

/** Step 1: a pure function over the working bill, or a rejection naming its reason and its entities. */
export type OperationOutcome =
  | WorkingBill
  | TransactionReject
  | { readonly working: WorkingBill; readonly effects?: Partial<TransactionEffects> };

export type Operation = (working: WorkingBill) => OperationOutcome;

export function isTransactionReject(value: OperationOutcome): value is TransactionReject {
  return "code" in value && "refs" in value && "message" in value;
}

/** What changed, for the UI to say so — business.md §14.3/§14.4's "identify the assignments being removed". */
export interface TransactionEffects {
  readonly finalizedItemIds: string[];
  readonly finalizedChargeIds: string[];
  readonly removedUnitIds: string[];
  readonly removedAssignments: ItemUnitAssignment[];
}

export type TransactionResult =
  | { readonly ok: true; readonly document: BillDocument; readonly effects: TransactionEffects }
  | { readonly ok: false; readonly document: BillDocument; readonly reject: TransactionReject };

export interface TransactionSteps {
  recompute(working: WorkingBill): RecomputeResult;
  validateParse(parse: ParseResult | null): ParseValidationResult | null;
  validateWorking(working: WorkingBill): BillValidationResult;
}

/**
 * §6 line 399's step 3, at core's pinned defaults (DECISIONS/0011 V5: the defaults are load-bearing and the
 * parameter is optional). `parseResult` never changes inside this ticket, so its output is stable — the step
 * still runs, because §6 names it as a step and skipping it would make the order unprovable.
 */
export const defaultSteps: TransactionSteps = {
  recompute: (working) => recompute(working),
  validateParse: (parse) => (parse === null ? null : validate(parse)),
  validateWorking: (working) => validateWorkingBill(working),
};

const NO_EFFECTS: Partial<TransactionEffects> = {};

function rejection(code: TransactionRejectCode, refs: string[], message: string): TransactionReject {
  return { code, refs, message };
}

function rolledBack(previous: BillDocument, reason: TransactionReject): TransactionResult {
  return { ok: false, document: previous, reject: reason };
}

function wrap(working: WorkingBill, effects: Partial<TransactionEffects> = NO_EFFECTS): OperationOutcome {
  return { working, effects };
}

function commit(document: BillDocument): BillDocument {
  return deepFreeze(document);
}

interface CommitMode {
  /**
   * `false` for the writes that must happen on a locked bill: unlock itself, and settlement metadata
   * (DECISIONS/0022 L4/L7). Every content edit keeps `true`.
   */
  readonly requireUnlocked: boolean;
}

function commitTransaction(
  previous: BillDocument,
  operation: Operation,
  steps: Partial<TransactionSteps>,
  mode: CommitMode,
): TransactionResult {
  const s: TransactionSteps = { ...defaultSteps, ...steps };

  if (mode.requireUnlocked && previous.working.bill.isLocked) {
    // §13: editing a locked bill needs unlock, revision and newly generated links.
    return rolledBack(
      previous,
      rejection("bill_locked", [previous.working.bill.id], "the bill is locked, so it cannot be edited"),
    );
  }

  const outcome = operation(previous.working);
  if (isTransactionReject(outcome)) return rolledBack(previous, outcome);

  const persisted = "working" in outcome ? outcome.working : outcome;
  const effects = "working" in outcome ? outcome.effects ?? NO_EFFECTS : NO_EFFECTS;

  try {
    const recomputed: RecomputeResult = s.recompute(persisted);
    const parseValidation = s.validateParse(recomputed.working.parseResult);
    // Step 3's output is written into the state step 4 reads, in one direction (§10 line 690's field).
    const working: WorkingBill = { ...recomputed.working, parseValidation };
    const billValidation = s.validateWorking(working);

    // DECISIONS/0022 L3: no committed document may be locked with a non-empty checklist, and the blockers
    // that decide it are the ones step 4 just computed — never a second calculation in the operation.
    if (working.bill.isLocked && billValidation.blockers.locking.length > 0) {
      return rolledBack(
        previous,
        rejection(
          "lock_blocked",
          billValidation.blockers.locking.map((blocker) => blocker.code).sort(),
          "the lock checklist is not clear, so nothing was locked",
        ),
      );
    }

    return {
      ok: true,
      document: commit({
        revision: previous.revision + 1,
        working,
        derived: recomputed.derived,
        billValidation,
      }),
      effects: { finalizedItemIds: [], finalizedChargeIds: [], removedUnitIds: [], removedAssignments: [], ...effects },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return rolledBack(
      previous,
      rejection("recompute_failed", [message], "the recalculation failed, so nothing was written"),
    );
  }
}

/**
 * The single edit entry. `previous.document` is returned unchanged — the same object — on any failure, so a
 * rolled-back mutation cannot have published derived state anywhere (DECISIONS/0019 S2.2).
 */
export function runTransaction(
  previous: BillDocument,
  operation: Operation,
  steps: Partial<TransactionSteps> = {},
): TransactionResult {
  return commitTransaction(previous, operation, steps, { requireUnlocked: true });
}

/** Revision 0: the accepted parse becomes a bill. Not a transaction — there is no previous state to roll back to. */
export function beginFrom(
  parse: ParseResult,
  parseValidation: ParseValidationResult,
  options: NewBillOptions,
  steps: Partial<TransactionSteps> = {},
): BillDocument {
  const s: TransactionSteps = { ...defaultSteps, ...steps };
  const working = createWorkingBill(parse, parseValidation, options);
  const recomputed = s.recompute(working);
  const fresh: WorkingBill = {
    ...recomputed.working,
    parseValidation: s.validateParse(recomputed.working.parseResult),
  };
  return commit({ revision: 0, working: fresh, derived: recomputed.derived, billValidation: s.validateWorking(fresh) });
}

/**
 * DECISIONS/0019 S9's promise to ticket 14, and DECISIONS/0023 P1's load path: rebuild the committed
 * document from a stored `working` and its `revision`, by running the *same* steps a transaction runs —
 * recompute, then core `validate`, then `validateWorkingBill` — so a reload cannot disagree with an edit.
 *
 * It is the second and last way a document is minted outside a transaction (`beginFrom` is the first), and
 * like `beginFrom` it is not one: there is no previous state to roll back to, and it does not bump
 * `revision`. The stored `working.parseValidation` is discarded and overwritten, never trusted: §10 line 745
 * says shares and derived values are recomputed on load, and 0019 S5 says the same of the parse validation —
 * a pure function of `parseResult`, so keeping its stored copy would be keeping a second answer to one
 * question.
 */
export function rebuildDocument(
  working: WorkingBill,
  revision: number,
  steps: Partial<TransactionSteps> = {},
): BillDocument {
  throw new Error("not implemented: DECISIONS/0023 P1");
}

/** The leaf predicates, re-exported so the seam's whole API is one module. */
export { isChargeAmountPaise, isCountableQuantity, isIntegerPaise, isUnitPricePaise };

/** §10 line 764: a finalized record has no nulls, so clearing a value is a draft-tier operation only. */
function required<T>(value: T | null, id: string, field: string, code: TransactionRejectCode): TransactionReject | { readonly value: T } {
  return value === null ? rejection(code, [id], `a finalized line cannot leave ${field} unresolved; delete the line instead`) : { value };
}

function findDraftItem(working: WorkingBill, id: string): DraftItem | undefined {
  return working.draftItems.find((draft) => draft.id === id);
}

function findItem(working: WorkingBill, id: string): Item | undefined {
  return working.items.find((item) => item.id === id);
}

function findDraftCharge(working: WorkingBill, id: string): DraftCharge | undefined {
  return working.draftCharges.find((draft) => draft.id === id);
}

function findCharge(working: WorkingBill, id: string): BillCharge | undefined {
  return working.charges.find((charge) => charge.id === id);
}

/**
 * Deterministic manual ids: the next integer above every `m`/`mc` suffix already in the bill. Both tiers
 * are scanned, because a finalized `Item` keeps its id (T6) and reusing it for a new line would give two
 * entities of the same type the same address — which is exactly what §6 line 394's finding refs cannot
 * survive.
 */
function nextManualId(existingIds: readonly string[], prefix: string): string {
  let highest = 0;
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;
    const suffix = Number(id.slice(prefix.length));
    if (Number.isInteger(suffix) && suffix > highest) highest = suffix;
  }
  return `${prefix}${highest + 1}`;
}

const draftLineIds = (working: WorkingBill): string[] => [
  ...working.draftItems.map((draft) => draft.id),
  ...working.items.map((item) => item.id),
];

const draftChargeIds = (working: WorkingBill): string[] => [
  ...working.draftCharges.map((draft) => draft.id),
  ...working.charges.map((charge) => charge.id),
];

/**
 * §10 line 752: the bill-level summary follows only when every tax/service charge has chosen a value and
 * they agree. `Bill.taxIncluded` is a hint, never a second authority — `BillCharge.included` is.
 */
function taxIncludedSummary(working: WorkingBill): { included: boolean | null; source: ValueSource } {
  const relevant = [...working.draftCharges, ...working.charges].filter(
    (charge) => charge.type === "tax" || charge.type === "service_charge",
  );
  if (relevant.length === 0) return { included: null, source: "unresolved" };
  const first = relevant[0]!.included;
  if (first === null) return { included: null, source: "unresolved" };
  return relevant.every((charge) => charge.included === first)
    ? { included: first, source: "user_confirmed" }
    : { included: null, source: "unresolved" };
}

function withTaxSummary(working: WorkingBill): WorkingBill {
  const summary = taxIncludedSummary(working);
  return {
    ...working,
    bill: { ...working.bill, taxIncluded: summary.included, taxIncludedSource: summary.source },
  };
}

/**
 * The inclusion question is only coherent for some types (DECISIONS/0020 T6): a discount is subtracted *from*
 * the subtotal and a round-off *is* the printed difference, so switching to either resolves inclusion by
 * definition rather than by inference.
 */
function inclusionForType(type: ChargeType, current: boolean | null): boolean | null {
  return type === "discount" || type === "round_off" ? false : current;
}

export interface ManualItemInput {
  name: string;
  /** null stays null: a blank price is unresolved, never defaulted to 0 (business.md §5.5, DECISIONS/0020 T4). */
  qty: number | null;
  unitPrice: number | null;
}

export interface ManualChargeInput {
  label: string;
  type: ChargeType;
  amount: number | null;
  otherSign?: "add" | "subtract" | "unknown";
}

export function setItemName(document: BillDocument, itemId: string, name: string): TransactionResult {
  return runTransaction(document, (working) => {
    const draft = findDraftItem(working, itemId);
    const item = findItem(working, itemId);
    if (!draft && !item) return rejection("unknown_entity", [itemId], "no line in this bill has that id");
    // §10 gives a name no provenance field, and T4 forbids inventing one: the value simply changes.
    if (draft) {
      return wrap({ ...working, draftItems: working.draftItems.map((entry) => (entry.id === itemId ? { ...entry, name } : entry)) });
    }
    return wrap({ ...working, items: working.items.map((entry) => (entry.id === itemId ? { ...entry, name } : entry)) });
  });
}

export function setItemQuantity(document: BillDocument, itemId: string, qty: number | null): TransactionResult {
  return runTransaction(document, (working) => {
    const draft = findDraftItem(working, itemId);
    const item = findItem(working, itemId);
    if (!draft && !item) return rejection("unknown_entity", [itemId], "no line in this bill has that id");
    if (qty !== null && !isCountableQuantity(qty)) {
      return rejection("invalid_quantity", [itemId], `a quantity must be a positive whole count, not ${qty}`);
    }

    if (draft) {
      return wrap({
        ...working,
        draftItems: working.draftItems.map((entry) =>
          entry.id === itemId
            ? { ...entry, qty, quantitySource: qty === null ? "unresolved" : ("user_confirmed" as const) }
            : entry,
        ),
      });
    }

    const current = item!;
    const resolved = required(qty, itemId, "quantity", "invalid_quantity");
    if ("code" in resolved) return resolved;
    const next: Item = {
      ...current,
      qty: resolved.value,
      quantitySource: "user_confirmed",
      lineTotal: resolved.value * current.unitPrice,
    };

    // §10 line 785 / business.md §14.3: units follow the quantity transactionally, and the assignments that
    // are about to disappear come back in `effects` so the UI can name them before they go.
    const { units, removedUnitIds } = syncUnitsToQuantity(next, working.itemUnits);
    const removed = new Set(removedUnitIds);
    return wrap(
      {
        ...working,
        items: working.items.map((entry) => (entry.id === itemId ? next : entry)),
        itemUnits: units,
        assignments: working.assignments.filter((entry) => !removed.has(entry.itemUnitId)),
      },
      {
        removedUnitIds,
        removedAssignments: working.assignments.filter((entry) => removed.has(entry.itemUnitId)),
      },
    );
  });
}

export function setItemPrice(document: BillDocument, itemId: string, unitPricePaise: number | null): TransactionResult {
  return runTransaction(document, (working) => {
    const draft = findDraftItem(working, itemId);
    const item = findItem(working, itemId);
    if (!draft && !item) return rejection("unknown_entity", [itemId], "no line in this bill has that id");
    if (unitPricePaise !== null && !isUnitPricePaise(unitPricePaise)) {
      return rejection(
        "invalid_amount",
        [itemId],
        `a unit price must be a non-negative whole number of paise, not ${unitPricePaise}`,
      );
    }

    if (draft) {
      return wrap({
        ...working,
        // The draft's `lineTotal` is the printed row total and stays: §10 line 784 compares, never replaces.
        draftItems: working.draftItems.map((entry) =>
          entry.id === itemId
            ? { ...entry, unitPrice: unitPricePaise, priceSource: unitPricePaise === null ? "unresolved" : ("user_confirmed" as const) }
            : entry,
        ),
      });
    }

    const current = item!;
    const resolved = required(unitPricePaise, itemId, "price", "invalid_amount");
    if ("code" in resolved) return resolved;
    const next: Item = {
      ...current,
      unitPrice: resolved.value,
      priceSource: "user_confirmed",
      lineTotal: current.qty * resolved.value,
    };
    return wrap({ ...working, items: working.items.map((entry) => (entry.id === itemId ? next : entry)) });
  });
}

export function addManualItem(document: BillDocument, input: ManualItemInput): TransactionResult {
  return runTransaction(document, (working) => {
    if (input.qty !== null && !isCountableQuantity(input.qty)) {
      return rejection("invalid_quantity", ["manual"], `a quantity must be a positive whole count, not ${input.qty}`);
    }
    if (input.unitPrice !== null && !isUnitPricePaise(input.unitPrice)) {
      return rejection(
        "invalid_amount",
        ["manual"],
        `a unit price must be a non-negative whole number of paise, not ${input.unitPrice}`,
      );
    }
    const draft: DraftItem = {
      id: nextManualId(draftLineIds(working), "m"),
      name: input.name,
      qty: input.qty,
      // §10 line 777: provenance per field the user supplied, and unresolved for whatever they left blank.
      quantitySource: input.qty === null ? "unresolved" : "user_confirmed",
      unitPrice: input.unitPrice,
      priceSource: input.unitPrice === null ? "unresolved" : "user_confirmed",
      lineTotal: null,
      confidence: null,
      warnings: [],
      assumedQtyReviewed: false,
      manuallyAdded: true,
    };
    return wrap({ ...working, draftItems: [...working.draftItems, draft] });
  });
}

export function deleteItem(document: BillDocument, itemId: string): TransactionResult {
  return runTransaction(document, (working) => {
    if (findDraftItem(working, itemId)) {
      // DECISIONS/0020 T9: a draft is not yet a billing entity, so no confirmation and nothing to cascade.
      return wrap({ ...working, draftItems: working.draftItems.filter((entry) => entry.id !== itemId) });
    }

    const item = findItem(working, itemId);
    if (!item) return rejection("unknown_entity", [itemId], "no line in this bill has that id");

    const removedUnits = working.itemUnits.filter((unit) => unit.itemId === itemId);
    const removedUnitIds = removedUnits.map((unit) => unit.id);
    const removed = new Set(removedUnitIds);
    // §10 line 790: one transaction, and no assignment to a deleted unit may survive. The
    // `AdjustmentLine`s derived from those units disappear when recompute regenerates them from what is left.
    return wrap(
      {
        ...working,
        items: working.items.filter((entry) => entry.id !== itemId),
        itemUnits: working.itemUnits.filter((unit) => unit.itemId !== itemId),
        assignments: working.assignments.filter((entry) => !removed.has(entry.itemUnitId)),
      },
      {
        removedUnitIds,
        removedAssignments: working.assignments.filter((entry) => removed.has(entry.itemUnitId)),
      },
    );
  });
}

export function finalizeItems(document: BillDocument, itemIds: readonly string[]): TransactionResult {
  return runTransaction(document, (working) => {
    const missing = itemIds.filter((id) => !findDraftItem(working, id));
    if (missing.length > 0) {
      // DECISIONS/0020 T10: nothing goes back to being a draft, so an already-finalized id is not finalizable.
      return rejection("unknown_entity", missing, "only a draft line can be finalized");
    }
    const blocked = itemIds.filter((id) => !checkDraftItemFinalizable(findDraftItem(working, id)!, working).ok);
    if (blocked.length > 0) {
      return rejection("not_finalizable", blocked, "these drafts do not meet §10's finalization gates");
    }

    const chosen = new Set(itemIds);
    const drafts = working.draftItems.filter((draft) => chosen.has(draft.id));
    const items = drafts.map((draft) => toFinalizedItem(draft, working.bill.id));
    // §10 line 765: units materialize *after* finalization, never from an unresolved quantity.
    const units = drafts.flatMap((draft) => materializeUnits(draft.id, draft.qty as number));
    return wrap(
      {
        ...working,
        draftItems: working.draftItems.filter((draft) => !chosen.has(draft.id)),
        items: [...working.items, ...items],
        itemUnits: [...working.itemUnits, ...units],
      },
      { finalizedItemIds: items.map((item) => item.id) },
    );
  });
}

/**
 * §10 line 778's bulk form, and ticket 13's lock-attempt path: exactly the drafts whose gates are met
 * finalize, in one transaction, and the rest stay drafts with their per-entity blockers already reported by
 * `validateWorkingBill`. There is no partial commit.
 */
export function finalizeAllResolvable(document: BillDocument): TransactionResult {
  return runTransaction(document, (working) => {
    const result = finalizeResolvable(working);
    if (!result.changed) return wrap(working);
    return wrap(result.working, {
      finalizedItemIds: result.finalizedItemIds,
      finalizedChargeIds: result.finalizedChargeIds,
    });
  });
}

export function setChargeAmount(document: BillDocument, chargeId: string, amountPaise: number | null): TransactionResult {
  return runTransaction(document, (working) => {
    const draft = findDraftCharge(working, chargeId);
    const charge = findCharge(working, chargeId);
    if (!draft && !charge) return rejection("unknown_entity", [chargeId], "no charge in this bill has that id");
    const type = draft ? draft.type : charge!.type;
    if (amountPaise !== null && !isChargeAmountPaise(type, amountPaise)) {
      return rejection(
        "invalid_amount",
        [chargeId],
        `a ${type} amount must be whole paise${type === "round_off" ? "" : " and non-negative"}, not ${amountPaise}`,
      );
    }

    if (draft) {
      return wrap({
        ...working,
        draftCharges: working.draftCharges.map((entry) =>
          entry.id === chargeId
            ? { ...entry, amount: amountPaise, source: amountPaise === null ? entry.source : ("user_confirmed" as const) }
            : entry,
        ),
      });
    }

    const resolved = required(amountPaise, chargeId, "amount", "invalid_amount");
    if ("code" in resolved) return resolved;
    return wrap({
      ...working,
      charges: working.charges.map((entry) =>
        entry.id === chargeId ? { ...entry, amount: resolved.value, source: "user_confirmed" } : entry,
      ),
    });
  });
}

export function setChargeType(document: BillDocument, chargeId: string, type: ChargeType): TransactionResult {
  return runTransaction(document, (working) => {
    const draft = findDraftCharge(working, chargeId);
    const charge = findCharge(working, chargeId);
    if (!draft && !charge) return rejection("unknown_entity", [chargeId], "no charge in this bill has that id");

    // §10 line 656: `otherSign` is used only when the type is `other`, so retyping clears it.
    if (draft) {
      return wrap(
        withTaxSummary({
          ...working,
          draftCharges: working.draftCharges.map((entry) =>
            entry.id === chargeId
              ? {
                  ...entry,
                  type,
                  otherSign: type === "other" ? (entry.otherSign ?? "unknown") : null,
                  included: inclusionForType(type, entry.included),
                  source: "user_confirmed",
                }
              : entry,
          ),
        }),
      );
    }

    const existing = charge!;
    // A finalized charge already has a confirmed `included`, so only the two definitional types move it.
    const next: BillCharge = { ...existing, type, source: "user_confirmed" };
    if (type === "other") next.otherSign = existing.otherSign ?? "unknown";
    else delete next.otherSign;
    if (type === "discount" || type === "round_off") next.included = false;
    return wrap(
      withTaxSummary({ ...working, charges: working.charges.map((entry) => (entry.id === chargeId ? next : entry)) }),
    );
  });
}

export function setChargeSign(document: BillDocument, chargeId: string, sign: "add" | "subtract" | "unknown"): TransactionResult {
  return runTransaction(document, (working) => {
    const draft = findDraftCharge(working, chargeId);
    const charge = findCharge(working, chargeId);
    if (!draft && !charge) return rejection("unknown_entity", [chargeId], "no charge in this bill has that id");
    // Sign is a property of `other` charges only (§10 line 656); giving it an effect on any other type would
    // be arithmetic the receipt never printed.
    if (draft && draft.type !== "other") return wrap(working);
    if (charge && charge.type !== "other") return wrap(working);

    if (draft) {
      return wrap({
        ...working,
        draftCharges: working.draftCharges.map((entry) =>
          entry.id === chargeId ? { ...entry, otherSign: sign, source: "user_confirmed" } : entry,
        ),
      });
    }
    return wrap({
      ...working,
      charges: working.charges.map((entry) => (entry.id === chargeId ? { ...entry, otherSign: sign, source: "user_confirmed" } : entry)),
    });
  });
}

/**
 * §10 line 752: the creator chooses "included in item prices" or "charged separately", the charge's source
 * becomes `user_confirmed`, and the bill-level summary follows only when the tax/service charges agree —
 * never inferred because an arithmetic match happened to look that way (DECISIONS/0011 V4).
 */
export function resolveChargeInclusion(document: BillDocument, chargeId: string, included: boolean): TransactionResult {
  return runTransaction(document, (working) => {
    const draft = findDraftCharge(working, chargeId);
    const charge = findCharge(working, chargeId);
    if (!draft && !charge) return rejection("unknown_entity", [chargeId], "no charge in this bill has that id");

    const next: WorkingBill = draft
      ? {
          ...working,
          draftCharges: working.draftCharges.map((entry) =>
            entry.id === chargeId ? { ...entry, included, source: "user_confirmed" } : entry,
          ),
        }
      : {
          ...working,
          charges: working.charges.map((entry) =>
            entry.id === chargeId ? { ...entry, included, source: "user_confirmed" } : entry,
          ),
        };
    return wrap(withTaxSummary(next));
  });
}

export function addManualCharge(document: BillDocument, input: ManualChargeInput): TransactionResult {
  return runTransaction(document, (working) => {
    if (input.amount !== null && !isChargeAmountPaise(input.type, input.amount)) {
      return rejection("invalid_amount", ["manual"], `a ${input.type} amount must be whole paise, not ${input.amount}`);
    }
    const draft: DraftCharge = {
      id: nextManualId(draftChargeIds(working), "mc"),
      label: input.label,
      type: input.type,
      amount: input.amount,
      included: inclusionForType(input.type, null),
      otherSign: input.type === "other" ? (input.otherSign ?? "unknown") : null,
      source: "user_confirmed",
      manuallyAdded: true,
    };
    return wrap(withTaxSummary({ ...working, draftCharges: [...working.draftCharges, draft] }));
  });
}

export function deleteCharge(document: BillDocument, chargeId: string): TransactionResult {
  return runTransaction(document, (working) => {
    const draftCharges = working.draftCharges.filter((entry) => entry.id !== chargeId);
    const charges = working.charges.filter((entry) => entry.id !== chargeId);
    if (draftCharges.length === working.draftCharges.length && charges.length === working.charges.length) {
      return rejection("unknown_entity", [chargeId], "no charge in this bill has that id");
    }
    return wrap(withTaxSummary({ ...working, draftCharges, charges }));
  });
}

/** The only operation allowed to move `grandTotal`, and the only one that sets `grandTotalSource` (§10 line 743). */
export function setGrandTotal(document: BillDocument, grandTotalPaise: number): TransactionResult {
  return runTransaction(document, (working) => {
    if (!isIntegerPaise(grandTotalPaise) || grandTotalPaise < 0) {
      return rejection(
        "invalid_amount",
        ["grandTotal"],
        `a grand total must be a non-negative whole number of paise, not ${grandTotalPaise}`,
      );
    }
    return wrap({
      ...working,
      bill: { ...working.bill, grandTotal: grandTotalPaise, grandTotalSource: "user_confirmed" },
    });
  });
}

/** §10 line 804: `assumed_qty_unreviewed` clears on this acknowledgement, not on an edit of the quantity. */
export function reviewAssumedQuantity(document: BillDocument, itemId: string): TransactionResult {
  return runTransaction(document, (working) => {
    const draft = findDraftItem(working, itemId);
    const item = findItem(working, itemId);
    if (!draft && !item) return rejection("unknown_entity", [itemId], "no line in this bill has that id");
    if (draft) {
      return wrap({
        ...working,
        draftItems: working.draftItems.map((entry) => (entry.id === itemId ? { ...entry, assumedQtyReviewed: true } : entry)),
      });
    }
    return wrap({
      ...working,
      items: working.items.map((entry) => (entry.id === itemId ? { ...entry, assumedQtyReviewed: true } : entry)),
    });
  });
}

/**
 * §10 line 769 / §11 rule 4: the creator's explicit acknowledgement that a unit belongs to nobody, whose
 * cost lands on them as a visible `AdjustmentLine` through recompute's regeneration (DECISIONS/0020 T7).
 * Assigning it to anyone clears the flag in the same transaction — that is ticket 12's operation, and the
 * guard here is what makes §10's "a confirmed-unassigned unit must have no participant assignments" an
 * enforced rule rather than a note.
 */
export function acknowledgeUnassignedUnit(document: BillDocument, unitId: string): TransactionResult {
  return runTransaction(document, (working) => {
    const unit = working.itemUnits.find((entry) => entry.id === unitId);
    if (!unit) return rejection("unknown_entity", [unitId], "no unit in this bill has that id");
    if (working.assignments.some((entry) => entry.itemUnitId === unitId)) {
      return rejection("unit_assigned", [unitId], "participants are already assigned to this unit");
    }
    return wrap({
      ...working,
      itemUnits: working.itemUnits.map((entry) => (entry.id === unitId ? { ...entry, confirmedUnassigned: true } : entry)),
    });
  });
}

/**
 * DECISIONS/0021 A2/A3: one transaction per toggle. Assigning clears `confirmedUnassigned` on the unit in
 * the same commit (§10 line 769), and a duplicate pair is a rejection rather than a silent no-op. The pure
 * rule is `units.assignPair`; this function owns the vocabulary the UI reads.
 */
export function assignUnit(document: BillDocument, unitId: string, participantId: string): TransactionResult {
  return runTransaction(document, (working) => {
    const outcome = assignPair(working, unitId, participantId);
    if (outcome.ok) return wrap(outcome.working);
    if (outcome.reason === "unit_missing") {
      return rejection("unknown_entity", [unitId], "no unit in this bill has that id");
    }
    if (outcome.reason === "participant_unknown") {
      return rejection("unknown_entity", [participantId], "no participant on this bill has that id");
    }
    if (outcome.reason === "assignment_duplicate") {
      return rejection("assignment_duplicate", [unitId, participantId], "that participant already holds this unit");
    }
    // `assignment_missing` is unreachable from an assign; kept explicit so the reason union stays total.
    return rejection("unknown_entity", [unitId, participantId], "that participant does not hold this unit");
  });
}

/** DECISIONS/0021 A4: the last pair removed leaves the unit pending, never acknowledged. */
export function unassignUnit(document: BillDocument, unitId: string, participantId: string): TransactionResult {
  return runTransaction(document, (working) => {
    const outcome = unassignPair(working, unitId, participantId);
    if (outcome.ok) return wrap(outcome.working);
    if (outcome.reason === "unit_missing") {
      return rejection("unknown_entity", [unitId], "no unit in this bill has that id");
    }
    if (outcome.reason === "participant_unknown") {
      return rejection("unknown_entity", [participantId], "no participant on this bill has that id");
    }
    return rejection("unknown_entity", [unitId, participantId], "that participant does not hold this unit");
  });
}

/**
 * DECISIONS/0021 A10: deterministic `p1..pN` id, no cascade into units or assignments, `invalid_name` on a
 * blank name. Adding someone never re-opens an acknowledgement and never assigns them anything.
 */
export function addParticipant(document: BillDocument, name: string): TransactionResult {
  return runTransaction(document, (working) => {
    const trimmed = name.trim();
    if (trimmed === "") return rejection("invalid_name", ["participant"], "a participant needs a name");

    const participant: Participant = {
      id: nextManualId(
        working.participants.map((entry) => entry.id),
        "p",
      ),
      billId: working.bill.id,
      name: trimmed,
      paid: false,
      token: "",
      tokenExpiresAt: "",
    };
    return wrap({ ...working, participants: [...working.participants, participant] });
  });
}

/**
 * DECISIONS/0022 — the lock lifecycle. `mintToken` and `now` are caller-supplied because `lib/bill/*` reads
 * no clock and no random source (0011's determinism rule); the component supplies both.
 */
export interface LockOptions {
  readonly mintToken: (participantId: string) => string;
}

export interface UnlockOptions {
  /** Only the unlock dialog's confirm handler produces `true` (DECISIONS/0022 L4). */
  readonly confirmed: true;
  /** ISO timestamp recorded as `staleLinkCutoffAt`. */
  readonly now: string;
  readonly mintToken: (participantId: string) => string;
}

/**
 * DECISIONS/0022 L3. Finalizes resolvable draft charges (no units), refuses draft items, sets `isLocked` and
 * mints missing tokens. The checklist is the runner's post-validation invariant: this operation never
 * recomputes blockers (0019 S9).
 */
export function lockBill(document: BillDocument, options: LockOptions): TransactionResult {
  return commitTransaction(
    document,
    (working) => {
      if (working.draftItems.length > 0) {
        return rejection(
          "items_unfinalized",
          working.draftItems.map((draft) => draft.id),
          "draft items must be finalized before the bill can lock",
        );
      }
      const finalized = finalizeResolvableCharges(working);
      return wrap(
        {
          ...finalized.working,
          bill: { ...finalized.working.bill, isLocked: true },
          participants: finalized.working.participants.map((participant) =>
            participant.token === ""
              ? { ...participant, token: options.mintToken(participant.id) }
              : participant,
          ),
        },
        { finalizedChargeIds: finalized.finalizedChargeIds },
      );
    },
    {},
    { requireUnlocked: true },
  );
}

/** DECISIONS/0022 L4–L6: explicit confirmation, a fresh token for everyone, the stale-link cutoff. */
export function unlockBill(document: BillDocument, options: UnlockOptions): TransactionResult {
  if (options.confirmed !== true) {
    return rolledBack(document, rejection("unlock_unconfirmed", [], "unlocking needs explicit confirmation"));
  }
  return commitTransaction(
    document,
    (working) => {
      if (!working.bill.isLocked) {
        return rejection("not_locked", [working.bill.id], "this bill is not locked");
      }
      return wrap({
        ...working,
        participants: working.participants.map((participant) => ({
          ...participant,
          token: options.mintToken(participant.id),
        })),
        staleLinkCutoffAt: options.now,
        bill: { ...working.bill, isLocked: false },
      });
    },
    {},
    { requireUnlocked: false },
  );
}

/** DECISIONS/0022 L1: one operation for both directions, so a mistaken exclusion is fixable. */
export function setUnclassifiedRowExcluded(
  document: BillDocument,
  rowId: string,
  excluded: boolean,
): TransactionResult {
  return runTransaction(document, (working) => {
    if (!working.unclassifiedRows.some((row) => row.id === rowId)) {
      return rejection("unknown_entity", [rowId], "no ambiguous row in this bill has that id");
    }
    const chosen = new Set(working.excludedRowIds);
    if (excluded) chosen.add(rowId);
    else chosen.delete(rowId);
    return wrap({
      ...working,
      // Row order, so the persisted set stays deterministic rather than following click order (0011).
      excludedRowIds: working.unclassifiedRows.filter((row) => chosen.has(row.id)).map((row) => row.id),
    });
  });
}

/**
 * DECISIONS/0022 L11. `null` stores `""`, which names no participant — the state `payer_missing` already
 * reports. It is the UI's "not chosen yet", never a payer for a locked bill.
 */
export function setPayer(document: BillDocument, participantId: string | null): TransactionResult {
  return runTransaction(document, (working) => {
    if (participantId === null) {
      return wrap({ ...working, bill: { ...working.bill, payerId: "" } });
    }
    if (!working.participants.some((participant) => participant.id === participantId)) {
      return rejection("unknown_entity", [participantId], "no participant on this bill has that id");
    }
    return wrap({ ...working, bill: { ...working.bill, payerId: participantId } });
  });
}

/** DECISIONS/0022 A16: refused for the creator, the payer and any paid participant. */
export function removeParticipant(document: BillDocument, participantId: string): TransactionResult {
  return runTransaction(document, (working) => {
    const participant = working.participants.find((entry) => entry.id === participantId);
    if (!participant) {
      return rejection("unknown_entity", [participantId], "no participant on this bill has that id");
    }
    if (participantId === working.bill.creatorId || participantId === working.bill.payerId) {
      return rejection(
        "protected_participant",
        [participantId],
        "the creator and the payer must stay participants",
      );
    }
    if (participant.paid) {
      return rejection(
        "participant_paid",
        [participantId],
        "settlement is a completed state; un-mark this participant as paid first",
      );
    }
    return wrap(
      {
        ...working,
        participants: working.participants.filter((entry) => entry.id !== participantId),
        assignments: working.assignments.filter((assignment) => assignment.participantId !== participantId),
      },
      {
        removedAssignments: working.assignments.filter(
          (assignment) => assignment.participantId === participantId,
        ),
      },
    );
  });
}

/**
 * DECISIONS/0022 L7: the `paid` flag is settlement metadata, not bill content, so it is one of the writes
 * permitted on a locked bill. Ticket 15 owns settlement presentation; the flag itself is §10's.
 */
export function setParticipantPaid(
  document: BillDocument,
  participantId: string,
  paid: boolean,
): TransactionResult {
  return commitTransaction(
    document,
    (working) => {
      if (!working.participants.some((participant) => participant.id === participantId)) {
        return rejection("unknown_entity", [participantId], "no participant on this bill has that id");
      }
      return wrap({
        ...working,
        participants: working.participants.map((participant) =>
          participant.id === participantId ? { ...participant, paid } : participant,
        ),
      });
    },
    {},
    { requireUnlocked: false },
  );
}

export type { BillDocument };
