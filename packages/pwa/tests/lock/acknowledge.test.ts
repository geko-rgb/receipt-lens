import { describe, expect, it } from "vitest";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { validate } from "@receipt-lens/core";
import type { ParsedItem, ParseResult, UnclassifiedRow } from "@receipt-lens/core";

import type { BillDocument } from "../../src/lib/bill/document.js";
import {
  acknowledgeableRows,
  effectiveAcknowledgements,
  rowCarriesAnAmount,
  rowsBlockedByAmount,
} from "../../src/lib/bill/acknowledge.js";
import {
  addParticipant,
  assignUnit,
  beginFrom,
  finalizeItems,
  lockBill,
  acknowledgeRows,
  rebuildDocument,
  runTransaction,
  setUnclassifiedRowAcknowledged,
} from "../../src/lib/bill/transactions.js";
import { assembleSnapshot } from "../../src/lib/share/snapshot.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/lib/share/codec.js";
import { loadBill, saveBill } from "../../src/lib/storage/repository.js";
import { openDatabase } from "../../src/lib/storage/database.js";

/**
 * Ticket 23 — bulk acknowledgement of preserved rows (owner ruling, 2026-11-10).
 *
 * The contract the ticket pins, as assertions: per-row human provenance (not an exclusion, not a parser class, not
 * inferable from the parse), undoable before the lock, refused for a row carrying an amount and voided — not
 * deleted — when a row starts carrying one. `next.md` issue 6's "rows that should never block a bill" is answered
 * here by the *human*, because `DECISIONS/0035`'s audit refused a confident-discard rule and §5 rule 7 stands.
 */

const CREATED_AT = "2026-11-05T00:00:00.000Z";
const ACKED_AT = "2026-11-05T01:00:00.000Z";

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

function row(id: string, text: string, over: Partial<UnclassifiedRow> = {}): UnclassifiedRow {
  return {
    id,
    text,
    box: { x: 0, y: 10, width: 100, height: 12 },
    sourceLineIds: [`line-${id}`],
    reason: "ambiguous",
    warningCode: "ambiguous_row",
    ...over,
  };
}

function begin(rows: UnclassifiedRow[], over: Partial<ParseResult> = {}): BillDocument {
  const parse: ParseResult = {
    items: [parsedItem("i1")],
    unclassifiedRows: rows,
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
  return beginFrom(parse, validate(parse), { billId: "b1", createdAt: CREATED_AT, creatorName: "Creator" });
}

function ok(result: ReturnType<typeof acknowledgeRows>): BillDocument {
  if (!result.ok) throw new Error(`expected success, got ${result.reject.code} [${result.reject.refs.join(", ")}]`);
  return result.document;
}

function rejected(result: ReturnType<typeof acknowledgeRows>): { code: string; refs: string[] } {
  if (result.ok) throw new Error("expected a rejection, got a committed document");
  return result.reject;
}

function blockerRefs(document: BillDocument): string[] {
  return (
    document.billValidation.blockers.locking.find((entry) => entry.code === "unclassified_rows_unreviewed")?.refs ?? []
  );
}

/** The Saravana photograph's five preserved rows, verbatim from the replay fixture (`real-ocr-fixtures.ts`). */
const SARAVANA_ROWS = ["ocrec re", "e", "Wtnin 2gis", "sarrna", "saraerana"];

/** The KOT photograph's three trailing marks (one invoice `1` and two illegible rows). */
const KOT_ROWS = ["1", "|", "—"];

describe("what a preserved row carries (ticket 23's amount rule)", () => {
  it("reads money on a row and reads nothing money-shaped on the two real bills' preserved rows", () => {
    // Money the creator must resolve rather than acknowledge: a decimal part, a thousands group, a currency marker.
    expect(["TOT QTY: 28 313.50", "[ACCOUNT] 25.00", "SR 6 313.50", "TOTAL RM 106.10", "Rs 45", "1,234.00"].map(rowCarriesAnAmount)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    // And the rows the real pages actually preserve, which are text and marks: no amount to wave through.
    expect([...SARAVANA_ROWS, ...KOT_ROWS].map(rowCarriesAnAmount)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("does not read a bare integer as an amount, because a count is not money", () => {
    // The same distinction DECISIONS/0037 relies on in the parser. Acknowledging `Table 2` is a human reading a row,
    // not a human dismissing ₹2.
    expect(rowCarriesAnAmount("Table 2")).toBe(false);
    expect(rowCarriesAnAmount("Wtnin 2gis")).toBe(false);
  });
});

describe("acknowledging in bulk (ticket 23)", () => {
  it("records one acknowledgement per row, in row order, with the human's timestamp", () => {
    const document = begin(SARAVANA_ROWS.map((text, index) => row(`u${index + 1}`, text)));
    expect(blockerRefs(document)).toEqual(["u1", "u2", "u3", "u4", "u5"]);

    const acknowledged = ok(
      acknowledgeRows(
        document,
        acknowledgeableRows(document.working).map((entry) => entry.id),
        { now: ACKED_AT },
      ),
    );

    expect(acknowledged.working.acknowledgedRows.map((entry) => [entry.rowId, entry.text, entry.acknowledgedAt])).toEqual([
      ["u1", "ocrec re", ACKED_AT],
      ["u2", "e", ACKED_AT],
      ["u3", "Wtnin 2gis", ACKED_AT],
      ["u4", "sarrna", ACKED_AT],
      ["u5", "saraerana", ACKED_AT],
    ]);
    // The parser's own output is untouched: the rows are still preserved and still listed, which is what makes the
    // two facts (`ambiguous` and `user-acknowledged`) distinguishable in the stored bill.
    expect(acknowledged.working.unclassifiedRows.map((entry) => entry.id)).toEqual(["u1", "u2", "u3", "u4", "u5"]);
    expect(blockerRefs(acknowledged)).toEqual([]);
    // No money moves and no exclusion is recorded: an acknowledgement is not an edit.
    expect(JSON.stringify(acknowledged.derived)).toBe(JSON.stringify(document.derived));
    expect(acknowledged.working.excludedRowIds).toEqual([]);
  });

  it("clears only the rows it acknowledged, leaving the rest blocking", () => {
    const document = begin([
      row("u1", "ocrec re"),
      row("u2", "e"),
      row("u3", "sarrna"),
    ]);
    const partial = ok(acknowledgeRows(document, ["u1", "u3"], { now: ACKED_AT }));
    expect(blockerRefs(partial)).toEqual(["u2"]);
  });

  it("refuses the whole request when any named row carries an amount", () => {
    const document = begin([row("u1", "ocrec re"), row("u2", "TOT QTY: 28 313.50")]);
    const refusal = rejected(acknowledgeRows(document, ["u1", "u2"], { now: ACKED_AT }));

    expect(refusal).toMatchObject({ code: "row_carries_amount", refs: ["u2"] });
    // All or nothing: the acknowledgeable row was not silently recorded either.
    expect(document.working.acknowledgedRows).toEqual([]);
    expect(blockerRefs(document)).toEqual(["u1", "u2"]);
  });

  it("refuses an unknown row id rather than acknowledging what it does have", () => {
    const document = begin([row("u1", "ocrec re")]);
    expect(rejected(acknowledgeRows(document, ["u1", "u9"], { now: ACKED_AT }))).toMatchObject({
      code: "unknown_entity",
      refs: ["u9"],
    });
  });

  it("treats an empty request as a no-op, so the bulk control is safe to press", () => {
    const document = begin([row("u1", "ocrec re")]);
    const unchanged = ok(acknowledgeRows(document, [], { now: ACKED_AT }));
    // Committed like every other transaction (the revision advances), but the review state is the same state.
    expect(unchanged.working.acknowledgedRows).toEqual([]);
    expect(unchanged.working.unclassifiedRows).toEqual(document.working.unclassifiedRows);
    expect(blockerRefs(unchanged)).toEqual(["u1"]);
  });

  it("is idempotent: acknowledging a row twice keeps the first timestamp", () => {
    const document = begin([row("u1", "ocrec re")]);
    const once = ok(acknowledgeRows(document, ["u1"], { now: ACKED_AT }));
    const twice = ok(acknowledgeRows(once, ["u1"], { now: "2026-11-05T02:00:00.000Z" }));
    expect(twice.working.acknowledgedRows).toEqual(once.working.acknowledgedRows);
  });
});

describe("undo and redo (ticket 23, DECISIONS/0019's inverse-operation rule)", () => {
  it("round-trips acknowledge → undo → redo through the transaction runner", () => {
    const document = begin(SARAVANA_ROWS.map((text, index) => row(`u${index + 1}`, text)));
    // v1 has no history stack (DECISIONS/0019 keeps undo/redo out), so "undo" is the inverse transaction and the
    // round trip is what proves the state is restorable without one.
    const acknowledged = ok(acknowledgeRows(document, ["u1", "u2", "u3", "u4", "u5"], { now: ACKED_AT }));
    const undone = ok(setUnclassifiedRowAcknowledged(acknowledged, "u3", false, { now: ACKED_AT }));
    const redone = ok(setUnclassifiedRowAcknowledged(undone, "u3", true, { now: ACKED_AT }));

    expect(acknowledged.working.acknowledgedRows.map((entry) => entry.rowId)).toEqual(["u1", "u2", "u3", "u4", "u5"]);
    expect(undone.working.acknowledgedRows.map((entry) => entry.rowId)).toEqual(["u1", "u2", "u4", "u5"]);
    expect(blockerRefs(undone)).toEqual(["u3"]);
    expect(redone.working.acknowledgedRows.map((entry) => entry.rowId)).toEqual(["u1", "u2", "u3", "u4", "u5"]);
    expect(blockerRefs(redone)).toEqual([]);
    // The redo state is the acknowledged state, field for field, not merely equivalent.
    expect(redone.working.acknowledgedRows).toEqual(acknowledged.working.acknowledgedRows);
  });

  it("refuses to acknowledge amount-carrying rows singly too, and never records the decision", () => {
    const document = begin([row("u1", "[ACCOUNT] 25.00")]);
    expect(rejected(setUnclassifiedRowAcknowledged(document, "u1", true, { now: ACKED_AT }))).toMatchObject({
      code: "row_carries_amount",
      refs: ["u1"],
    });
  });
});

describe("the refusal edge: a row that starts carrying an amount voids the acknowledgement", () => {
  it("stops honouring the record and puts the row back in front of the creator", () => {
    const document = begin([row("u1", "ocrec re"), row("u2", "e")]);
    const acknowledged = ok(acknowledgeRows(document, ["u1", "u2"], { now: ACKED_AT }));
    expect(blockerRefs(acknowledged)).toEqual([]);

    // A re-parse or an edit that gives the row a printed amount. The stored record is *not* deleted — it is the
    // history of a decision that no longer applies — and the row keeps blocking until the money is resolved.
    const nowCarriesMoney = ok(
      runTransaction(acknowledged, (working) => ({
        ...working,
        unclassifiedRows: working.unclassifiedRows.map((entry) =>
          entry.id === "u2" ? { ...entry, text: "e 25.00" } : entry,
        ),
      })),
    );

    expect(blockerRefs(nowCarriesMoney)).toEqual(["u2"]);
    expect(nowCarriesMoney.working.acknowledgedRows.map((entry) => entry.rowId)).toEqual(["u1", "u2"]);
    expect(effectiveAcknowledgements(nowCarriesMoney.working).map((entry) => entry.row.id)).toEqual(["u1"]);
    expect(rowsBlockedByAmount(nowCarriesMoney.working).map((entry) => entry.id)).toEqual(["u2"]);
    // Undoing the edit brings the acknowledgement back into force without a second human act: the record never moved.
    const reverted = ok(
      runTransaction(nowCarriesMoney, (working) => ({
        ...working,
        unclassifiedRows: working.unclassifiedRows.map((entry) =>
          entry.id === "u2" ? { ...entry, text: "e" } : entry,
        ),
      })),
    );
    expect(blockerRefs(reverted)).toEqual([]);
  });
});

describe("persistence (DECISIONS/0023 P1)", () => {
  it("round-trips acknowledgements through the real save path and rebuild", async () => {
    const factory = new FakeIDBFactory();
    const handle = await openDatabase({ factory });
    const document = begin([row("u1", "ocrec re"), row("u2", "e")]);
    const acknowledged = ok(acknowledgeRows(document, ["u1", "u2"], { now: ACKED_AT }));

    const saved = await saveBill(handle, {
      document: acknowledged,
      savedAt: ACKED_AT,
      syncedRevision: acknowledged.revision,
    });
    expect(saved.status).toBe("written");

    const stored = await loadBill(handle, "b1");
    const rebuilt = rebuildDocument(stored!.working, stored!.revision);
    expect(rebuilt.working.acknowledgedRows).toEqual(acknowledged.working.acknowledgedRows);
    expect(blockerRefs(rebuilt)).toEqual([]);
    // And the two facts are still distinguishable after the round trip: preserved *and* acknowledged.
    expect(rebuilt.working.unclassifiedRows.map((entry) => entry.text)).toEqual(["ocrec re", "e"]);
  });

  it("keeps acknowledgements on a locked bill and refuses to write them once locked (transactions only)", () => {
    const document = begin([row("u1", "ocrec re")]);
    const acknowledged = ok(acknowledgeRows(document, ["u1"], { now: ACKED_AT }));
    const withP = ok(addParticipant(acknowledged, "P1"));
    const finalized = ok(finalizeItems(withP, ["i1"]));
    const assigned = ok(assignUnit(finalized, "unit:i1:0", "p1"));
    const locked = lockBill(assigned, { mintToken: (participantId) => `t-${participantId}` });
    if (!locked.ok) throw new Error(`expected the bill to lock, got ${locked.reject.code}`);

    expect(locked.document.working.acknowledgedRows.map((entry) => entry.rowId)).toEqual(["u1"]);
    // Locking is not a review act, so the record travels unchanged, and the review state is frozen with the bill.
    expect(rejected(setUnclassifiedRowAcknowledged(locked.document, "u1", false, { now: ACKED_AT }))).toMatchObject({
      code: "bill_locked",
      refs: ["b1"],
    });
  });
});

describe("the share snapshot carries acknowledgements (DECISIONS/0025/0026)", () => {
  function lockedBill(rows: UnclassifiedRow[], acknowledgedIds: string[]): BillDocument {
    const document = begin(rows);
    const acknowledged = ok(acknowledgeRows(document, acknowledgedIds, { now: ACKED_AT }));
    const withP = ok(addParticipant(acknowledged, "P1"));
    const finalized = ok(finalizeItems(withP, ["i1"]));
    const assigned = ok(assignUnit(finalized, "unit:i1:0", "p1"));
    const locked = lockBill(assigned, { mintToken: (participantId) => `t-${participantId}` });
    if (!locked.ok) throw new Error(`expected the bill to lock, got ${locked.reject.code}`);
    return locked.document;
  }

  it("names every acknowledged row, with the moment, and no amount", () => {
    const bill = lockedBill([row("u1", "ocrec re"), row("u2", "e")], ["u1", "u2"]);
    const snapshot = assembleSnapshot(bill, { now: ACKED_AT });
    expect(snapshot.acknowledgedRows).toEqual([
      { text: "ocrec re", acknowledgedAt: ACKED_AT },
      { text: "e", acknowledgedAt: ACKED_AT },
    ]);
    // Internal row ids stay out of the payload (0026 A3), and nothing about an acknowledgement looks like money.
    expect(JSON.stringify(snapshot.acknowledgedRows)).not.toContain("u1");
  });

  it("omits the field entirely for a bill with nothing acknowledged, so an old snapshot's bytes are unchanged", () => {
    const bill = lockedBill([], []);
    expect("acknowledgedRows" in assembleSnapshot(bill, { now: ACKED_AT })).toBe(false);
  });

  it("survives the link codec, and a snapshot without the field still decodes", async () => {
    const bill = lockedBill([row("u1", "ocrec re")], ["u1"]);
    const snapshot = assembleSnapshot(bill, { now: ACKED_AT });
    const token = "token-aaaaaaaaaaaaaaaaaaaa";
    const fragment = await encodeSnapshot(snapshot, token);
    const decoded = await decodeSnapshot(fragment, token);
    expect(decoded.acknowledgedRows).toEqual([{ text: "ocrec re", acknowledgedAt: ACKED_AT }]);

    // A link written before this field existed: same payload minus one optional key.
    const { acknowledgedRows: _omitted, ...legacy } = snapshot;
    const legacyFragment = await encodeSnapshot(legacy as typeof snapshot, token);
    const legacyDecoded = await decodeSnapshot(legacyFragment, token);
    expect(legacyDecoded.acknowledgedRows).toBeUndefined();
    expect(legacyDecoded.bill.grandTotal).toBe(snapshot.bill.grandTotal);
  });

  it("rejects a snapshot whose acknowledgement timestamp is not a date", async () => {
    const bill = lockedBill([row("u1", "ocrec re")], ["u1"]);
    const snapshot = assembleSnapshot(bill, { now: ACKED_AT });
    const token = "token-aaaaaaaaaaaaaaaaaaaa";
    const broken = { ...snapshot, acknowledgedRows: [{ text: "ocrec re", acknowledgedAt: "yesterday" }] };
    const fragment = await encodeSnapshot(broken as typeof snapshot, token);
    await expect(decodeSnapshot(fragment, token)).rejects.toMatchObject({ code: "link_schema_invalid" });
  });
});
