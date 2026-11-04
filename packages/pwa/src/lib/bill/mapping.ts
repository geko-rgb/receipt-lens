import type { ParseResult, ParseValidationResult, ParsedItem } from "@receipt-lens/core";
import type { Bill, ChargeType, Participant } from "../entities.js";
import type { DraftCharge, DraftItem, WorkingBill } from "./working-bill.js";

/**
 * ROADMAP 3C.1 — `ParseResult` → the draft tier. The accepted parse ticket 10 hands over (`lib/draft.ts`)
 * is not a bill yet; this is where it becomes one, and where §4's public charge shape (`taxes[]`,
 * `serviceCharge`, `tip`, `discount`, signed `roundOff`, `otherCharges[]`) is unified into §10's internal
 * `DraftCharge[]` without replacing the public shape (ADR-008, business.md §6).
 *
 * Charge ids are DECISIONS/0011 V9's refs (`t1`, `service`, `tip`, `discount`, `roundOff`, `o1`), and item
 * ids are the parsed item's own id, so core's `itemRefs`/`chargeRefs` address the very rows the editor
 * renders — one address per entity across the parse, the drafts and the bill-state findings.
 */
export interface NewBillOptions {
  billId: string;
  /** An ISO string the caller supplies: nothing in `lib/bill/` reads a clock (DECISIONS/0011's determinism rule). */
  createdAt: string;
  title?: string;
  creatorName?: string;
}

export function draftItemFromParsed(item: ParsedItem): DraftItem {
  return {
    id: item.id,
    parsedRef: item.id,
    name: item.name,
    qty: item.qty,
    quantitySource: item.quantitySource,
    unitPrice: item.unitPrice,
    priceSource: item.priceSource,
    // The parsed `lineTotal` is the printed row total — `parse/items.ts` only ever fills it from the
    // price-column word — so it is a detected fact, and DECISIONS/0020 T5 keeps it that way.
    lineTotal: item.lineTotal,
    confidence: item.confidence,
    warnings: [...item.warnings],
    assumedQtyReviewed: false,
    manuallyAdded: false,
  };
}

/** The types whose inclusion is a coherent question, and so a finalization gate (DECISIONS/0020 T6). */
export const INCLUSION_AFFECTING_CHARGE_TYPES: readonly ChargeType[] = ["tax", "service_charge", "tip", "other"];

/**
 * The public charge shape, unified. `roundOff` stays signed (§11 rule 8) and every other type keeps its
 * positive magnitude; `included` is `null` wherever the question is coherent, because §10 line 752 and
 * DECISIONS/0011 V4 forbid inferring it from anything but an explicit receipt cue — and core never sets it.
 * `discount` and `round_off` arrive resolved to `false`: a discount is subtracted *from* the subtotal and a
 * round-off *is* the printed difference, so "already inside the item prices" is not a question they answer.
 */
export function draftChargesFromParse(parse: ParseResult): DraftCharge[] {
  const charges: DraftCharge[] = [];

  parse.taxes.forEach((tax, index) => {
    charges.push({
      id: `t${index + 1}`,
      type: "tax",
      label: tax.label,
      amount: tax.amount,
      rate: tax.rate ?? null,
      included: tax.included ?? null,
      source: tax.source,
      manuallyAdded: false,
    });
  });

  if (parse.serviceCharge !== null) {
    charges.push({
      id: "service",
      type: "service_charge",
      label: "Service charge",
      amount: parse.serviceCharge,
      included: null,
      source: "detected",
      manuallyAdded: false,
    });
  }

  if (parse.tip !== null) {
    charges.push({
      id: "tip",
      type: "tip",
      label: "Tip",
      amount: parse.tip,
      included: null,
      source: "detected",
      manuallyAdded: false,
    });
  }

  if (parse.discount !== null) {
    charges.push({
      id: "discount",
      type: "discount",
      label: "Discount",
      amount: parse.discount,
      included: false,
      source: "detected",
      manuallyAdded: false,
    });
  }

  if (parse.roundOff !== null) {
    charges.push({
      id: "roundOff",
      type: "round_off",
      label: "Round off",
      amount: parse.roundOff,
      included: false,
      source: "detected",
      manuallyAdded: false,
    });
  }

  parse.otherCharges.forEach((charge, index) => {
    charges.push({
      id: `o${index + 1}`,
      type: "other",
      label: charge.label,
      amount: charge.amount,
      included: charge.included ?? null,
      otherSign: charge.sign,
      source: charge.source,
      manuallyAdded: false,
    });
  });

  return charges;
}

/**
 * The first `WorkingBill`: drafts from the parse, the retained `parseResult`/`parseValidation` (the printed
 * subtotal and the ambiguous rows live there — §10 gives `Bill` no `subtotal` field), and exactly one
 * participant. §11 rule 10 requires creator and payer to be participants and defaults the payer to the
 * creator, and unassigned-unit accounting (DECISIONS/0020 T7) needs a creator to land an `AdjustmentLine`
 * on before ticket 12 adds anyone else. `token`/`tokenExpiresAt` are ticket 16's share material.
 */
export function createWorkingBill(
  parse: ParseResult,
  parseValidation: ParseValidationResult,
  options: NewBillOptions,
): WorkingBill {
  const creatorId = `${options.billId}:creator`;
  const creator: Participant = {
    id: creatorId,
    billId: options.billId,
    name: options.creatorName ?? "Creator",
    paid: false,
    token: "",
    tokenExpiresAt: "",
  };

  const bill: Bill = {
    id: options.billId,
    title: options.title ?? "Receipt",
    creatorId,
    payerId: creatorId,
    createdAt: options.createdAt,
    isLocked: false,
    taxIncluded: null,
    taxIncludedSource: "unresolved",
    grandTotal: parse.grandTotal,
    grandTotalSource: parse.grandTotal === null ? "unresolved" : parse.grandTotalSource,
    adjustmentLines: [],
  };

  return {
    bill,
    draftItems: parse.items.map(draftItemFromParsed),
    items: [],
    draftCharges: draftChargesFromParse(parse),
    charges: [],
    participants: [creator],
    itemUnits: [],
    assignments: [],
    unclassifiedRows: parse.unclassifiedRows.map((row) => ({ ...row, sourceLineIds: [...row.sourceLineIds] })),
    parseResult: parse,
    parseValidation,
  };
}
