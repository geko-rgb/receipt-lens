import { describe, expect, it } from "vitest";
import { validate } from "@receipt-lens/core";
import type { ParsedItem, ParseResult, ParsedOtherCharge, ParsedTax, UnclassifiedRow } from "@receipt-lens/core";

import { visibleFindings, type BillDocument } from "../../src/lib/bill/document.js";
import { lifecycleOf } from "../../src/lib/bill/lifecycle.js";
import type { LockBlocker } from "../../src/lib/bill/working-bill.js";
import {
  acknowledgeUnassignedUnit,
  addParticipant,
  assignUnit,
  beginFrom,
  finalizeAllResolvable,
  finalizeItems,
  lockBill,
  removeParticipant,
  resolveChargeInclusion,
  reviewAssumedQuantity,
  runTransaction,
  setChargeAmount,
  setChargeSign,
  setGrandTotal,
  setItemPrice,
  setItemQuantity,
  setParticipantPaid,
  setPayer,
  setUnclassifiedRowExcluded,
  unlockBill,
  type LockOptions,
  type TransactionResult,
  type UnlockOptions,
} from "../../src/lib/bill/transactions.js";

/**
 * DECISIONS/0022 L1–L14 and A16, as assertions.
 *
 * Written before the implementation, deliberately: `lockBill`, `unlockBill`, `setUnclassifiedRowExcluded`,
 * `setPayer`, `removeParticipant` and `lifecycleOf` throw `not implemented`, so this file is red on exactly
 * those pins until the rules exist. Everything it touches is the bill-state seam — a document in, a document
 * or a rejection out — never a component.
 *
 * The blocker matrix is the ticket's Verify line: every one of §13's nine codes produced by its condition and
 * cleared by its fix. `payer_missing` is the one state no product operation can build (creation sets the payer
 * to the creator and `setPayer` rejects a non-participant), so it is built through `runTransaction`'s generic
 * operation seam — the same device DECISIONS/0021 A3 used for `bill_locked`.
 */

const CREATED_AT = "2026-11-05T00:00:00.000Z";
const UNLOCKED_AT = "2026-11-05T12:00:00.000Z";
const CREATOR = "b1:creator";

function parsedItem(id: string, over: Partial<ParsedItem> = {}): ParsedItem {
  return {
    id,
    name: `Item ${id}`,
    qty: 1,
    quantitySource: "explicit",
    unitPrice: 10_000,
    priceSource: "detected",
    lineTotal: 10_000,
    confidence: null,
    sourceLineIds: [`line-${id}`],
    warnings: [],
    ...over,
  };
}

function ambiguousRow(id: string, over: Partial<UnclassifiedRow> = {}): UnclassifiedRow {
  return {
    id,
    text: "NAAN 60.00",
    box: { x: 0, y: 10, width: 100, height: 12 },
    sourceLineIds: [`line-${id}`],
    reason: "ambiguous",
    warningCode: "ambiguous_row",
    ...over,
  };
}

function taxFixture(over: Partial<ParsedTax> = {}): ParsedTax {
  return { label: "GST", amount: 1_551, rate: null, source: "detected", ...over };
}

function otherFixture(over: Partial<ParsedOtherCharge> = {}): ParsedOtherCharge {
  return { label: "Parcel", amount: 500, type: "other", sign: "unknown", included: false, source: "detected", ...over };
}

function parseOf(over: Partial<ParseResult> = {}): ParseResult {
  return {
    items: [parsedItem("i1")],
    unclassifiedRows: [],
    taxes: [],
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    otherCharges: [],
    subtotal: 10_000,
    subtotalSource: "detected",
    grandTotal: 10_000,
    grandTotalSource: "detected",
    warnings: [],
    ...over,
  };
}

function begin(over: Partial<ParseResult> = {}): BillDocument {
  const parse = parseOf(over);
  return beginFrom(parse, validate(parse), { billId: "b1", createdAt: CREATED_AT, creatorName: "Creator" });
}

function ok(result: TransactionResult): BillDocument {
  if (!result.ok) throw new Error(`expected success, got ${result.reject.code} [${result.reject.refs.join(", ")}]`);
  return result.document;
}

/** The whole success value, for the pins that assert `effects` as well as the document. */
function committed(result: TransactionResult): Extract<TransactionResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${result.reject.code} [${result.reject.refs.join(", ")}]`);
  return result;
}

function rejected(result: TransactionResult): { readonly code: string; readonly refs: string[] } {
  if (result.ok) throw new Error("expected a rejection, got a committed document");
  return result.reject;
}

function blocker(document: BillDocument, code: LockBlocker["code"]): LockBlocker | undefined {
  return document.billValidation.blockers.locking.find((entry) => entry.code === code);
}

function lockingCodes(document: BillDocument): string[] {
  return document.billValidation.blockers.locking.map((entry) => entry.code);
}

/** Deterministic token material: `lib/bill/*` never touches randomness, so the caller supplies it. */
function tokenFactory(prefix: string): (participantId: string) => string {
  let count = 0;
  return (participantId) => `${prefix}-${++count}-${participantId}`;
}

function lock(document: BillDocument, prefix = "lock"): TransactionResult {
  return lockBill(document, { mintToken: tokenFactory(prefix) } satisfies LockOptions);
}

function unlock(
  document: BillDocument,
  over: Partial<Omit<UnlockOptions, "confirmed">> = {},
): TransactionResult {
  return unlockBill(document, { confirmed: true, now: UNLOCKED_AT, mintToken: tokenFactory("unlock"), ...over });
}

/** Creator + P1, one finalized line, its only unit held by P1: a clear checklist on an unpaid bill. */
function lockable(): BillDocument {
  const withP = ok(addParticipant(begin(), "P1"));
  const finalized = ok(finalizeItems(withP, ["i1"]));
  return ok(assignUnit(finalized, "unit:i1:0", "p1"));
}

/** The only writer of `paid` in v1 is ticket 15; until then a raw seam is how a pin reaches the state. */
function markingPaid(document: BillDocument, participantId: string): BillDocument {
  return ok(
    runTransaction(document, (working) => ({
      ...working,
      participants: working.participants.map((participant) =>
        participant.id === participantId ? { ...participant, paid: true } : participant,
      ),
    })),
  );
}

describe("ticket 13 — locking (DECISIONS/0022 L3)", () => {
  it("locks a bill whose checklist is clear, and freezes the same document with isLocked set", () => {
    const document = lockable();
    expect(document.billValidation.blockers.locking).toEqual([]);
    const derivedBefore = JSON.stringify(document.derived);

    const locked = ok(lock(document));

    expect(locked.working.bill.isLocked).toBe(true);
    expect(locked.revision).toBe(document.revision + 1);
    expect(locked.billValidation.blockers.locking).toEqual([]);
    // Locking is not a settlement and moves no money: the numbers are the same, recomputed once.
    expect(JSON.stringify(locked.derived)).toBe(derivedBefore);
    expect(locked.working.participants.map((participant) => participant.paid)).toEqual([false, false]);
  });

  it("mints a token for every participant that does not have one, and leaves existing tokens alone", () => {
    const locked = ok(lock(lockable()));
    const tokens = locked.working.participants.map((participant) => participant.token);

    expect(tokens.every((token) => token.length > 0)).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);

    // Unlock re-mints for everyone, so a re-lock has nothing to mint and must leave those tokens alone:
    // the links a creator sends after re-locking are the ones unlock generated (DECISIONS/0022 L4).
    const afterUnlock = ok(unlock(locked));
    const unlockTokens = afterUnlock.working.participants.map((participant) => participant.token);
    expect(unlockTokens).not.toEqual(tokens);

    const relocked = ok(lock(afterUnlock, "relock"));
    expect(relocked.working.participants.map((participant) => participant.token)).toEqual(unlockTokens);
  });

  it("rejects a second lock with bill_locked", () => {
    const locked = ok(lock(lockable()));
    const second = lock(locked);

    expect(rejected(second).code).toBe("bill_locked");
    expect(second.document).toBe(locked);
  });

  it("rejects with lock_blocked and the blocker codes when the checklist is not clear", () => {
    // No draft items: with one present the lock refuses earlier with `items_unfinalized` (0022 L3), and this
    // pin is about the runner's checklist invariant, not that refusal.
    const document = ok(
      finalizeItems(begin({ grandTotal: null, grandTotalSource: "unresolved" }), ["i1"]),
    );
    expect([...lockingCodes(document)].sort()).toEqual(["grand_total_missing", "units_unassigned"]);

    const attempt = lock(document);

    const reject = rejected(attempt);
    expect(reject.code).toBe("lock_blocked");
    expect(reject.refs).toEqual(["grand_total_missing", "units_unassigned"]);
    expect(attempt.document).toBe(document);
  });

  it("refuses to lock while a draft item remains, even when its gates are met (items_unfinalized)", () => {
    const document = begin();
    expect(lockingCodes(document)).not.toContain("draft_items_unresolved");

    const attempt = lock(document);
    const reject = rejected(attempt);

    expect(reject.code).toBe("items_unfinalized");
    expect(reject.refs).toEqual(["i1"]);
    expect(attempt.document).toBe(document);
    expect(attempt.document.working.draftItems).toHaveLength(1);
    expect(attempt.document.working.bill.isLocked).toBe(false);
  });

  it("finalizes resolvable draft charges in the locking commit, since charges have no units", () => {
    let document = begin({
      items: [parsedItem("i1")],
      taxes: [taxFixture()],
      subtotal: 10_000,
      grandTotal: 11_551,
    });
    document = ok(resolveChargeInclusion(document, "t1", false));
    document = ok(finalizeItems(document, ["i1"]));
    document = ok(assignUnit(document, "unit:i1:0", CREATOR));
    expect(document.working.draftCharges).toHaveLength(1);
    expect(document.working.charges).toEqual([]);
    expect(document.billValidation.blockers.locking).toEqual([]);

    const locked = ok(lock(document));

    expect(locked.working.bill.isLocked).toBe(true);
    expect(locked.working.draftCharges).toEqual([]);
    expect(locked.working.charges.map((charge) => charge.id)).toEqual(["t1"]);
  });
});

describe("ticket 13 — a locked bill rejects every mutation (DECISIONS/0022 L2)", () => {
  it("rejects edit, quantity, assignment and removal with the one bill_locked code", () => {
    const locked = ok(lock(lockable()));

    for (const attempt of [
      setItemPrice(locked, "i1", 5_000),
      setItemQuantity(locked, "i1", 2),
      assignUnit(locked, "unit:i1:0", CREATOR),
      removeParticipant(locked, "p1"),
    ]) {
      expect(rejected(attempt).code).toBe("bill_locked");
      expect(attempt.document).toBe(locked);
    }
  });
});

describe("ticket 13 — unlocking (DECISIONS/0022 L4–L7)", () => {
  it("requires the explicit confirmation parameter", () => {
    const locked = ok(lock(lockable()));
    const tokensBefore = locked.working.participants.map((participant) => participant.token);
    const unconfirmed = {
      confirmed: false,
      now: UNLOCKED_AT,
      mintToken: tokenFactory("unconfirmed"),
    } as unknown as UnlockOptions;

    const attempt = unlockBill(locked, unconfirmed);

    expect(rejected(attempt).code).toBe("unlock_unconfirmed");
    expect(attempt.document).toBe(locked);
    expect(attempt.document.working.participants.map((participant) => participant.token)).toEqual(tokensBefore);
  });

  it("rejects an unlock of a bill that is not locked", () => {
    const document = lockable();
    const attempt = unlock(document);

    expect(rejected(attempt).code).toBe("not_locked");
    expect(attempt.document).toBe(document);
  });

  it("regenerates every token and records the stale-link cutoff, without moving a number", () => {
    const locked = ok(lock(lockable()));
    const tokensBefore = locked.working.participants.map((participant) => participant.token);
    const derivedBefore = JSON.stringify(locked.derived);

    const unlocked = ok(unlock(locked));
    const tokensAfter = unlocked.working.participants.map((participant) => participant.token);

    expect(unlocked.working.bill.isLocked).toBe(false);
    expect(tokensAfter.every((token) => token.length > 0)).toBe(true);
    expect(new Set(tokensAfter).size).toBe(tokensAfter.length);
    for (const token of tokensAfter) expect(tokensBefore).not.toContain(token);
    expect(unlocked.working.staleLinkCutoffAt).toBe(UNLOCKED_AT);
    expect(JSON.stringify(unlocked.derived)).toBe(derivedBefore);

    // Re-locking must not clear the marker: the old links still show the old amounts.
    const relocked = ok(lock(unlocked, "relock"));
    expect(relocked.working.staleLinkCutoffAt).toBe(UNLOCKED_AT);
  });

  it("does not revert paid flags", () => {
    const paid = markingPaid(lockable(), "p1");
    const locked = ok(lock(paid));
    const unlocked = ok(unlock(locked));

    expect(unlocked.working.participants.find((participant) => participant.id === "p1")!.paid).toBe(true);
    expect(unlocked.working.participants).toHaveLength(2);
  });
});

describe("ticket 13 — ambiguous rows and exclusion (DECISIONS/0022 L1)", () => {
  it("blocks only the rows that are neither claimed by a live line nor excluded", () => {
    const document = begin({
      unclassifiedRows: [ambiguousRow("u1", { sourceLineIds: ["line-i1"] }), ambiguousRow("u2")],
    });

    expect(blocker(document, "unclassified_rows_unreviewed")!.refs).toEqual(["u2"]);
  });

  it("clears the blocker by exclusion, keeps the row visible, and moves no money", () => {
    const document = begin({ unclassifiedRows: [ambiguousRow("u1")] });
    const derivedBefore = JSON.stringify(document.derived);

    expect(blocker(document, "unclassified_rows_unreviewed")!.refs).toEqual(["u1"]);

    const excluded = ok(setUnclassifiedRowExcluded(document, "u1", true));

    expect(blocker(excluded, "unclassified_rows_unreviewed")).toBeUndefined();
    expect(excluded.working.unclassifiedRows.map((row) => row.id)).toEqual(["u1"]);
    expect(excluded.working.excludedRowIds).toEqual(["u1"]);
    expect(JSON.stringify(excluded.derived)).toBe(derivedBefore);

    const restored = ok(setUnclassifiedRowExcluded(excluded, "u1", false));
    expect(blocker(restored, "unclassified_rows_unreviewed")!.refs).toEqual(["u1"]);
    expect(restored.working.excludedRowIds).toEqual([]);
  });

  it("rejects an unknown row id", () => {
    const document = begin({ unclassifiedRows: [ambiguousRow("u1")] });
    const attempt = setUnclassifiedRowExcluded(document, "u9", true);

    expect(rejected(attempt).code).toBe("unknown_entity");
    expect(attempt.document).toBe(document);
  });
});

describe("ticket 13 — zero items (DECISIONS/0022 L9)", () => {
  it("locks a zero-item bill once its checklist is clear, and keeps the zero_items finding visible", () => {
    const document = begin({ items: [], subtotal: null, subtotalSource: "unresolved" });

    expect(document.working.parseValidation!.findings.map((finding) => finding.code)).toContain("zero_items");
    expect(document.billValidation.blockers.locking).toEqual([]);

    const locked = ok(lock(document));

    expect(locked.working.bill.isLocked).toBe(true);
    expect(visibleFindings(locked).map((finding) => finding.code)).toContain("zero_items");
  });
});

describe("ticket 13 — the lifecycle projection (DECISIONS/0022 L10)", () => {
  it("derives all five states from the document, and returns to ready_to_lock after unlock", () => {
    const draft = begin({ items: [parsedItem("i1", { unitPrice: null, priceSource: "unresolved" })] });
    expect(draft.revision).toBe(0);
    expect(lifecycleOf(draft)).toBe("draft");

    const reviewed = ok(setItemPrice(draft, "i1", 10_000));
    expect(reviewed.revision).toBe(1);
    expect(lifecycleOf(reviewed)).toBe("review_required");

    const ready = lockable();
    expect(lifecycleOf(ready)).toBe("ready_to_lock");

    const locked = ok(lock(ready));
    expect(lifecycleOf(locked)).toBe("locked");

    const settled = ok(lock(markingPaid(lockable(), "p1")));
    expect(lifecycleOf(settled)).toBe("settled");

    expect(lifecycleOf(ok(unlock(settled)))).toBe("ready_to_lock");
  });

  it("never calls a bill with unfinalized draft items ready to lock", () => {
    const resolvable = begin();
    expect(lockingCodes(resolvable)).not.toContain("draft_items_unresolved");
    expect(lifecycleOf(resolvable)).toBe("draft");
  });
});

describe("ticket 13 — the payer (DECISIONS/0022 L11)", () => {
  it("narrows the payer to the creator without moving a share (DECISIONS/0024 S1)", () => {
    const document = lockable();
    const sharesBefore = JSON.stringify(document.derived.shares);

    const attempt = setPayer(document, "p1");

    expect(rejected(attempt).code).toBe("payer_must_be_creator");
    expect(attempt.document).toBe(document);
    expect(JSON.stringify(attempt.document.derived.shares)).toBe(sharesBefore);

    const moved = ok(setPayer(document, CREATOR));
    expect(moved.working.bill.payerId).toBe(CREATOR);
  });

  it("rejects a non-participant payer, and a raw-seam one blocks the lock", () => {
    const document = lockable();
    const attempt = setPayer(document, "ghost");

    expect(rejected(attempt).code).toBe("unknown_entity");
    expect(rejected(attempt).refs).toEqual(["ghost"]);
    expect(attempt.document).toBe(document);

    const ghost = ok(
      runTransaction(document, (working) => ({ ...working, bill: { ...working.bill, payerId: "ghost" } })),
    );
    expect(blocker(ghost, "payer_missing")!.refs).toEqual(["ghost"]);

    const blocked = lock(ghost);
    expect(rejected(blocked).code).toBe("lock_blocked");
    expect(rejected(blocked).refs).toEqual(["payer_missing"]);
    expect(blocked.document).toBe(ghost);
  });
});

describe("ticket 13 — participant removal (DECISIONS/0022 A16)", () => {
  it("rejects a paid participant, because settlement is a completed state", () => {
    const document = markingPaid(lockable(), "p1");
    const attempt = removeParticipant(document, "p1");

    expect(rejected(attempt).code).toBe("participant_paid");
    expect(attempt.document).toBe(document);
    expect(attempt.document.working.participants.map((participant) => participant.id)).toEqual([CREATOR, "p1"]);
  });

  it("removes an unpaid participant and cascades their assignments in one commit", () => {
    const document = lockable();
    const outcome = committed(removeParticipant(document, "p1"));
    const removed = outcome.document;

    expect(removed.revision).toBe(document.revision + 1);
    expect(removed.working.participants.map((participant) => participant.id)).toEqual([CREATOR]);
    expect(removed.working.assignments).toEqual([]);
    expect(removed.working.itemUnits.map((unit) => unit.confirmedUnassigned)).toEqual([false]);
    expect(blocker(removed, "units_unassigned")!.refs).toEqual(["unit:i1:0"]);
    expect(outcome.effects.removedAssignments).toEqual([{ itemUnitId: "unit:i1:0", participantId: "p1" }]);
    // The cost never transfers to the creator implicitly: acknowledgement is a separate creator act.
    expect(removed.working.bill.adjustmentLines).toEqual([]);
  });

  it("rejects removing the creator or the current payer", () => {
    const document = lockable();
    expect(rejected(removeParticipant(document, CREATOR)).code).toBe("protected_participant");

    // The payer can only be the creator in v1, so the non-creator payer is built through the raw seam.
    const payerMoved = ok(
      runTransaction(document, (working) => ({ ...working, bill: { ...working.bill, payerId: "p1" } })),
    );
    expect(rejected(removeParticipant(payerMoved, "p1")).code).toBe("protected_participant");
  });

  it("rejects an unknown participant", () => {
    const document = lockable();
    expect(rejected(removeParticipant(document, "ghost")).code).toBe("unknown_entity");
  });
});

describe("ticket 13 — the blocker matrix: every code produced by its condition, cleared by its fix", () => {
  it("draft_items_unresolved", () => {
    const document = begin({ items: [parsedItem("i1", { qty: null, quantitySource: "unresolved" })] });
    expect(blocker(document, "draft_items_unresolved")!.refs).toEqual(["i1"]);

    const fixed = ok(setItemQuantity(document, "i1", 1));
    expect(blocker(fixed, "draft_items_unresolved")).toBeUndefined();
  });

  it("draft_charges_unresolved", () => {
    const document = begin({
      items: [parsedItem("i1")],
      otherCharges: [otherFixture()],
      subtotal: 10_000,
      grandTotal: 10_500,
    });
    expect(blocker(document, "draft_charges_unresolved")!.refs).toEqual(["o1"]);

    const fixed = ok(setChargeSign(document, "o1", "add"));
    expect(blocker(fixed, "draft_charges_unresolved")).toBeUndefined();
  });

  it("tax_inclusion_unresolved", () => {
    const document = begin({
      items: [parsedItem("i1")],
      taxes: [taxFixture()],
      subtotal: 10_000,
      grandTotal: 11_551,
    });
    expect(blocker(document, "tax_inclusion_unresolved")!.refs).toEqual(["t1"]);

    const fixed = ok(resolveChargeInclusion(document, "t1", false));
    expect(blocker(fixed, "tax_inclusion_unresolved")).toBeUndefined();
  });

  it("units_unassigned", () => {
    const document = ok(finalizeItems(begin(), ["i1"]));
    expect(blocker(document, "units_unassigned")!.refs).toEqual(["unit:i1:0"]);

    const fixed = ok(acknowledgeUnassignedUnit(document, "unit:i1:0"));
    expect(blocker(fixed, "units_unassigned")).toBeUndefined();
  });

  it("assumed_qty_unreviewed", () => {
    const document = begin({ items: [parsedItem("i1", { quantitySource: "assumed" })] });
    expect(blocker(document, "assumed_qty_unreviewed")!.refs).toEqual(["i1"]);

    const fixed = ok(reviewAssumedQuantity(document, "i1"));
    expect(blocker(fixed, "assumed_qty_unreviewed")).toBeUndefined();
  });

  it("grand_total_missing", () => {
    const document = begin({ grandTotal: null, grandTotalSource: "unresolved" });
    expect(blocker(document, "grand_total_missing")).toBeDefined();
    expect(blocker(document, "grand_total_missing")!.refs).toBeUndefined();

    const fixed = ok(setGrandTotal(document, 10_000));
    expect(blocker(fixed, "grand_total_missing")).toBeUndefined();
  });

  it("payer_missing", () => {
    const document = ok(
      runTransaction(begin(), (working) => ({ ...working, bill: { ...working.bill, payerId: "ghost" } })),
    );
    expect(blocker(document, "payer_missing")!.refs).toEqual(["ghost"]);

    const named = ok(addParticipant(document, "P1"));
    const fixed = ok(setPayer(named, CREATOR));
    expect(blocker(fixed, "payer_missing")).toBeUndefined();
  });

  it("unclassified_rows_unreviewed", () => {
    const document = begin({ unclassifiedRows: [ambiguousRow("u1")] });
    expect(blocker(document, "unclassified_rows_unreviewed")!.refs).toEqual(["u1"]);

    const fixed = ok(setUnclassifiedRowExcluded(document, "u1", true));
    expect(blocker(fixed, "unclassified_rows_unreviewed")).toBeUndefined();
  });

  it("negative_share_after_discount", () => {
    let document = begin({
      items: [parsedItem("i1")],
      discount: 20_000,
      subtotal: 10_000,
      grandTotal: 10_000,
    });
    document = ok(finalizeItems(document, ["i1"]));
    document = ok(assignUnit(document, "unit:i1:0", CREATOR));
    document = ok(finalizeAllResolvable(document));
    expect(blocker(document, "negative_share_after_discount")!.refs).toEqual([CREATOR]);

    const fixed = ok(setChargeAmount(document, "discount", 5_000));
    expect(blocker(fixed, "negative_share_after_discount")).toBeUndefined();
  });
});

describe("ticket 13 — decisions taken at checkpoint 3", () => {
  it("represents a payer that has not been chosen as `\"\"`, with no ref to name", () => {
    const cleared = ok(setPayer(lockable(), null));

    expect(cleared.working.bill.payerId).toBe("");
    expect(blocker(cleared, "payer_missing")).toBeDefined();
    expect(blocker(cleared, "payer_missing")!.refs).toBeUndefined();
    expect(rejected(lock(cleared)).refs).toEqual(["payer_missing"]);
  });

  it("permits the paid flag on a locked bill, because settlement follows the lock", () => {
    const locked = ok(lock(lockable()));
    expect(lifecycleOf(locked)).toBe("locked");

    const paid = ok(setParticipantPaid(locked, "p1", true));

    expect(paid.working.bill.isLocked).toBe(true);
    expect(paid.working.participants.find((participant) => participant.id === "p1")!.paid).toBe(true);
    expect(paid.revision).toBe(locked.revision + 1);
    expect(lifecycleOf(paid)).toBe("settled");
  });

  it("leaves a bill with nobody to pay in `locked`, not a vacuous `settled`", () => {
    const base = begin();
    const mine = ok(assignUnit(ok(finalizeItems(base, ["i1"])), "unit:i1:0", base.working.bill.creatorId));

    const locked = ok(lock(mine));

    expect(locked.derived.shares!.every((share) => share.participantId === base.working.bill.payerId)).toBe(true);
    expect(lifecycleOf(locked)).toBe("locked");
  });
});
