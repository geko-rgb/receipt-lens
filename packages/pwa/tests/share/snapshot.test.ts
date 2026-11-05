import { describe, expect, it } from "vitest";
import { validate } from "@receipt-lens/core";
import type { ParsedItem, ParseResult, UnclassifiedRow } from "@receipt-lens/core";

import type { BillDocument } from "../../src/lib/bill/document.js";
import {
  acknowledgeUnassignedUnit,
  addParticipant,
  assignUnit,
  beginFrom,
  finalizeItems,
  lockBill,
  setGrandTotal,
  setItemQuantity,
  setUnclassifiedRowExcluded,
  type TransactionResult,
} from "../../src/lib/bill/transactions.js";
import {
  decodeSnapshot,
  encodeSnapshot,
  SHARE_FRAGMENT_MAX_BYTES,
  type BillShareSnapshot,
} from "../../src/lib/share/codec.js";
import {
  assembleSnapshot,
  ShareAssemblyError,
  sharesFromSnapshot,
  splittableFromSnapshot,
  stalenessOf,
} from "../../src/lib/share/snapshot.js";
import { budgetPercent, buildShareLinks } from "../../src/lib/share/link.js";

/**
 * DECISIONS/0026 A1–A7 and A9, as assertions for the assembly seam.
 *
 * Written before the implementation, deliberately: every `lib/share/snapshot.ts` and `lib/share/link.ts`
 * export throws `not implemented: DECISIONS/0026 …`, so this file is red on exactly those pins. The codec is
 * already shipped and is used here as a real dependency, because a payload that cannot be encoded is not a
 * share link and the budget is a property of the encoded fragment (A4). No component, no /share route, no
 * browser.
 */

const CREATED_AT = "2026-11-05T08:00:00.000Z";
const NOW = "2026-11-05T09:00:00.000Z";
const BILL_ID = "bill:share";
const CREATOR = `${BILL_ID}:creator`;
const ROSTER = [CREATOR, "p1", "p2"] as const;
/** Receipt-only text. It must reach the working bill and stop there (A3). */
const MARKER = "OCRprivacyMARKER9182";

/**
 * The codec requires a base64url token and derives the key from its UTF-8 bytes, so the fixture mints
 * UUID-shaped material rather than the readable `token-p1` strings the settlement pins used.
 */
function uuidAt(index: number): string {
  return `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;
}

function parsedItem(over: Partial<ParsedItem> = {}): ParsedItem {
  return {
    id: "i1",
    name: "PLATTER",
    qty: 1,
    quantitySource: "explicit",
    unitPrice: 10_000,
    priceSource: "detected",
    lineTotal: 10_000,
    confidence: null,
    sourceLineIds: ["line-i1"],
    warnings: [],
    ...over,
  };
}

function ambiguousRow(id: string, over: Partial<UnclassifiedRow> = {}): UnclassifiedRow {
  return {
    id,
    text: MARKER,
    box: { x: 0, y: 40, width: 120, height: 14 },
    sourceLineIds: [`line-${id}`],
    reason: "ambiguous",
    warningCode: "ambiguous_row",
    ...over,
  };
}

function parseFixture(over: Partial<ParseResult> = {}): ParseResult {
  return {
    items: [parsedItem()],
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

function ok(result: TransactionResult): BillDocument {
  if (!result.ok) throw new Error(`expected a commit, got ${result.reject.code} [${result.reject.refs.join(", ")}]`);
  return result.document;
}

function captureError(work: () => unknown): unknown {
  try {
    work();
  } catch (cause) {
    return cause;
  }
  throw new Error("expected a throw");
}

function tokenOf(document: BillDocument, participantId: string): string {
  const found = document.working.participants.find((participant) => participant.id === participantId);
  if (!found) throw new Error(`no participant ${participantId}`);
  return found.token;
}

/**
 * A locked bill: a ₹100-per-unit platter, the roster holding it, and the optional extras a case needs.
 * `holders` is the *assignment* order, which is deliberately not roster order in A2's ordering pin.
 */
function locked(
  over: {
    title?: string;
    qty?: number;
    holders?: readonly string[];
    markerRow?: boolean;
    unassigned?: boolean;
    mint?: (participantId: string) => string;
    grandTotal?: number;
  } = {}
): BillDocument {
  const qty = over.qty ?? 1;
  const parse = parseFixture({
    items: [parsedItem({ qty, lineTotal: 10_000 * qty })],
    unclassifiedRows: over.markerRow ? [ambiguousRow("u1")] : [],
    subtotal: 10_000 * qty,
    // A bill whose printed total is its payable total, so the settlement allocation works unless a case
    // deliberately moves it (the A2 allocation-refusal pin).
    grandTotal: over.grandTotal ?? 10_000 * qty,
  });
  let document = beginFrom(parse, validate(parse), {
    billId: BILL_ID,
    createdAt: CREATED_AT,
    title: over.title ?? "Dinner",
    creatorName: "Albus",
  });
  if (over.markerRow) document = ok(setUnclassifiedRowExcluded(document, "u1", true));
  if (qty !== 1) document = ok(setItemQuantity(document, "i1", qty));
  document = ok(finalizeItems(document, ["i1"]));
  document = ok(addParticipant(document, "Bea"));
  document = ok(addParticipant(document, "Cy"));

  if (over.unassigned) {
    document = ok(acknowledgeUnassignedUnit(document, "unit:i1:0"));
  } else {
    for (let unit = 0; unit < qty; unit += 1) {
      for (const participantId of over.holders ?? ROSTER) {
        document = ok(assignUnit(document, `unit:i1:${unit}`, participantId));
      }
    }
  }

  const mint = over.mint ?? ((participantId: string) => uuidAt(ROSTER.indexOf(participantId as never) + 1));
  return ok(lockBill(document, { mintToken: mint }));
}

/** Deterministic pseudo-random printable text, so a budget pin is about bytes rather than DEFLATE's mood. */
function incompressible(length: number): string {
  let state = 0x12345678;
  const characters: string[] = [];
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    characters.push(String.fromCharCode(33 + ((state >>> 0) % 94)));
  }
  return characters.join("");
}

/** Every object in a value, for the frozen-at-every-level and key-name walks. */
function objectsIn(value: unknown, into: object[] = []): object[] {
  if (value !== null && typeof value === "object") {
    into.push(value);
    for (const nested of Object.values(value as Record<string, unknown>)) objectsIn(nested, into);
  }
  return into;
}

function keyNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const nested of value) keyNames(nested, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      keyNames(nested, into);
    }
  }
  return into;
}

const FORBIDDEN_KEYS = [
  // §10's parse tier and the PWA review state beside it (0022 L1).
  "parseResult",
  "parseValidation",
  "unclassifiedRows",
  "excludedRowIds",
  "staleLinkCutoffAt",
  // the draft tier, which may hold nulls a finalized record may not.
  "draftItems",
  "draftCharges",
  "parsedRef",
  "manuallyAdded",
  "assumedQtyReviewed",
  // extraction quality and provenance.
  "confidence",
  "warnings",
  "quantitySource",
  "priceSource",
  "detectedLineTotal",
  "uncertain",
  "findings",
  "blockers",
  // OCR geometry and text.
  "text",
  "box",
  "sourceLineIds",
  "words",
  // local ledger and identity material.
  "revision",
  "billId",
  "itemUnitId",
  "token",
  "paid",
  "isLocked",
  "upiId",
  "displayName",
  "grandTotalSource",
];

describe("ticket 16 — assembly reads a locked bill (DECISIONS/0026 A1, A2)", () => {
  it("produces §10's shape with every field present, in the pinned order", () => {
    const document = locked();
    const snapshot = assembleSnapshot(document, { now: NOW });

    expect(Object.keys(snapshot)).toEqual([
      "snapshotVersion",
      "snapshotCreatedAt",
      "bill",
      "participants",
      "items",
      "charges",
      "adjustmentLines",
      "computedShares",
    ]);
    expect(snapshot.snapshotVersion).toBe(1);
    expect(snapshot.snapshotCreatedAt).toBe(NOW);
    expect(Object.keys(snapshot.bill)).toEqual([
      "id",
      "title",
      "creatorId",
      "payerId",
      "createdAt",
      "grandTotal",
      "taxIncluded",
      "taxIncludedSource",
    ]);
    expect(Object.keys(snapshot.participants[0]!)).toEqual(["id", "name", "tokenExpiresAt"]);
    expect(Object.keys(snapshot.items[0]!)).toEqual(["id", "name", "qty", "unitPrice", "unitAssignments"]);
    expect(Object.keys(snapshot.items[0]!.unitAssignments[0]!)).toEqual([
      "unitIndex",
      "participantIds",
      "confirmedUnassigned",
    ]);
    expect(Object.keys(snapshot.computedShares[0]!)).toEqual([
      "participantId",
      "exactAmount",
      "settlementSharePaise",
    ]);
    expect(Object.keys(snapshot.computedShares[0]!.exactAmount)).toEqual(["numeratorPaise", "denominator"]);
  });

  it("carries the resolved values the creator locked", () => {
    const document = locked();
    const snapshot = assembleSnapshot(document, { now: NOW });

    expect(snapshot.bill).toEqual({
      id: BILL_ID,
      title: "Dinner",
      creatorId: CREATOR,
      payerId: CREATOR,
      createdAt: CREATED_AT,
      grandTotal: 10_000,
      taxIncluded: null,
      taxIncludedSource: "unresolved",
    });
    expect(snapshot.participants.map((participant) => participant.name)).toEqual(["Albus", "Bea", "Cy"]);
    // §10's shape carries the expiry hint; ticket 13 never writes one (0022 L5), so it travels as "".
    expect(snapshot.participants.map((participant) => participant.tokenExpiresAt)).toEqual(["", "", ""]);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.id).toBe(document.working.items[0]!.id);
    expect(snapshot.items[0]!.name).toBe("PLATTER");
    expect(snapshot.items[0]!.qty).toBe(1);
    expect(snapshot.items[0]!.unitPrice).toBe(10_000);
    expect(snapshot.charges).toEqual([]);
  });

  it("orders holders by roster and units by unitIndex, not by insertion", () => {
    const reverse = ["p2", "p1", CREATOR] as const;
    // Assigned worst-first on purpose, and unit 1's holders land in the store before unit 0's are read back.
    const document = locked({ qty: 2, holders: reverse });
    const snapshot = assembleSnapshot(document, { now: NOW });

    expect(snapshot.items[0]!.unitAssignments.map((unit) => unit.unitIndex)).toEqual([0, 1]);
    for (const unit of snapshot.items[0]!.unitAssignments) {
      expect(unit.participantIds).toEqual([CREATOR, "p1", "p2"]);
    }
    // The bite: the stored assignment rows really are in the other order.
    expect(document.working.assignments.map((assignment) => assignment.participantId)).toEqual([...reverse, ...reverse]);
  });

  it("copies the unassigned adjustment line and drops its internal ids", () => {
    const document = locked({ unassigned: true });
    const snapshot = assembleSnapshot(document, { now: NOW });

    expect(snapshot.adjustmentLines).toHaveLength(1);
    expect(Object.keys(snapshot.adjustmentLines[0]!)).toEqual(["reason", "amount", "assignedToParticipantId"]);
    expect(snapshot.adjustmentLines[0]).toEqual({
      reason: "unassigned",
      amount: 10_000,
      assignedToParticipantId: CREATOR,
    });
    expect(snapshot.items[0]!.unitAssignments[0]).toEqual({
      unitIndex: 0,
      participantIds: [],
      confirmedUnassigned: true,
    });
    // The source row does carry ids (0022's `adj:<unitId>` linkage), so the omission above is a decision.
    expect(document.working.bill.adjustmentLines[0]!.id).toBe(`adj:unit:i1:0`);
  });

  it("leaves every settlement amount null when the allocation refuses, and the shares still travel", () => {
    // A printed total 20 rupees above the calculated payable: 0024 S8-4's unreachable-by-allocation case.
    const document = locked({ grandTotal: 12_000 });
    const snapshot = assembleSnapshot(document, { now: NOW });

    expect(snapshot.bill.grandTotal).toBe(12_000);
    expect(snapshot.computedShares).toHaveLength(3);
    expect(snapshot.computedShares.map((share) => share.settlementSharePaise)).toEqual([null, null, null]);
    expect(snapshot.computedShares.map((share) => share.exactAmount)).toEqual([
      { numeratorPaise: "10000", denominator: "3" },
      { numeratorPaise: "10000", denominator: "3" },
      { numeratorPaise: "10000", denominator: "3" },
    ]);
  });

  it("refuses an unlocked document with bill_locked", () => {
    const parse = parseFixture();
    const unlocked = beginFrom(parse, validate(parse), { billId: BILL_ID, createdAt: CREATED_AT });

    const cause = captureError(() => assembleSnapshot(unlocked, { now: NOW }));

    expect(cause).toBeInstanceOf(ShareAssemblyError);
    expect((cause as ShareAssemblyError).code).toBe("bill_locked");
  });

  it("defensive: narrows the grand total to resolved integer paise, or refuses", () => {
    // Unreachable through `runTransaction` — the lock checklist gates on it (0022 L3). This pin exists to
    // prove the narrowing is a check and not a cast, so the state is forged rather than produced.
    const document = locked();
    for (const grandTotal of [null, 10_000.5]) {
      const forged = {
        ...document,
        working: { ...document.working, bill: { ...document.working.bill, grandTotal } },
      } as BillDocument;

      const cause = captureError(() => assembleSnapshot(forged, { now: NOW }));

      expect(cause).toBeInstanceOf(ShareAssemblyError);
      expect((cause as ShareAssemblyError).code).toBe("grand_total_missing");
    }
  });

  it("is deterministic: one locked document and one now produce a byte-identical payload", () => {
    const document = locked({ qty: 2 });

    expect(JSON.stringify(assembleSnapshot(document, { now: NOW }))).toBe(
      JSON.stringify(assembleSnapshot(document, { now: NOW }))
    );
  });
});

describe("ticket 16 — excluded content (DECISIONS/0026 A3)", () => {
  it("carries none of the forbidden keys, and the working bill carries them all", () => {
    const document = locked({ markerRow: true });
    const snapshot = assembleSnapshot(document, { now: NOW });

    const payload = keyNames(snapshot);
    expect([...payload].filter((key) => FORBIDDEN_KEYS.includes(key))).toEqual([]);

    // The bite: every one of those names really is present in the state assembly read from.
    const source = keyNames(document.working);
    const inSource = FORBIDDEN_KEYS.filter((key) => source.has(key));
    expect(inSource).toEqual(expect.arrayContaining([
      "parseResult",
      "parseValidation",
      "unclassifiedRows",
      "excludedRowIds",
      "staleLinkCutoffAt",
      "draftItems",
      "draftCharges",
      "revision",
      "billId",
      "itemUnitId",
      "token",
      "paid",
      "isLocked",
      "box",
      "sourceLineIds",
      "text",
      "confidence",
    ]));
    expect(document.working.items[0]).toHaveProperty("detectedLineTotal");
    expect(document.working.items[0]).toHaveProperty("quantitySource");
  });

  it("keeps receipt-only marker text out of the payload, its JSON and the encoded fragment", async () => {
    const document = locked({ markerRow: true });
    expect(JSON.stringify(document.working)).toContain(MARKER);

    const snapshot = assembleSnapshot(document, { now: NOW });
    const json = JSON.stringify(snapshot);

    expect(json).not.toContain(MARKER);
    const fragment = await encodeSnapshot(snapshot, uuidAt(1));
    expect(fragment).not.toContain(MARKER);
    // No raster or encoded-image material either way, in any form the payload could have carried it.
    expect(json).not.toContain("data:");
    expect(json).not.toContain("base64");
    await expect(decodeSnapshot(fragment, uuidAt(1))).resolves.toEqual(snapshot);
  });
});

describe("ticket 16 — the budget is measured on the fragment (DECISIONS/0026 A4)", () => {
  it("does not refuse on size itself; the encode does, and names the same code", async () => {
    const document = locked({ title: incompressible(20_000) });

    const snapshot = assembleSnapshot(document, { now: NOW });
    await expect(encodeSnapshot(snapshot, uuidAt(1))).rejects.toMatchObject({ code: "link_budget_exceeded" });

    const outcome = await buildShareLinks(document, { now: NOW });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.code).toBe("link_budget_exceeded");
    expect("links" in outcome).toBe(false);
  });

  it("reports the bytes of the fragment it produced, and the meter reads from them", async () => {
    const outcome = await buildShareLinks(locked(), { now: NOW });
    if (!outcome.ok) throw new Error(`expected links, got ${outcome.code}`);

    for (const link of outcome.links) {
      expect(link.bytes).toBe(link.fragment.length);
      expect(link.bytes).toBeLessThanOrEqual(SHARE_FRAGMENT_MAX_BYTES);
      expect(budgetPercent(link.bytes)).toBe(Math.floor((link.bytes / SHARE_FRAGMENT_MAX_BYTES) * 100));
    }
    expect(budgetPercent(SHARE_FRAGMENT_MAX_BYTES)).toBe(100);
    expect(budgetPercent(SHARE_FRAGMENT_MAX_BYTES + 1)).toBe(100);
    expect(budgetPercent(0)).toBe(0);
  });
});

describe("ticket 16 — the snapshot is a frozen value (DECISIONS/0026 A5)", () => {
  it("is frozen at every level", () => {
    const snapshot = assembleSnapshot(locked({ qty: 2 }), { now: NOW });

    for (const value of objectsIn(snapshot)) expect(Object.isFrozen(value)).toBe(true);
    expect(() => {
      (snapshot.bill as unknown as { title: string }).title = "rewritten";
    }).toThrow();
    expect(() => {
      (snapshot.participants as unknown as Array<{ name: string }>)[0]!.name = "rewritten";
    }).toThrow();
  });

  it("survives a JSON round trip unchanged, holding no bigint and no undefined", () => {
    const snapshot = assembleSnapshot(locked({ qty: 2, unassigned: false }), { now: NOW });

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    for (const value of objectsIn(snapshot)) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        expect(nested).not.toBeUndefined();
        expect(typeof nested).not.toBe("bigint");
      }
    }
  });
});

describe("ticket 16 — the recipient re-derives the shares (DECISIONS/0026 A6)", () => {
  it("recomputes exactly what the cache carried for a real locked bill", () => {
    const snapshot = assembleSnapshot(locked(), { now: NOW });

    const derived = sharesFromSnapshot(snapshot);

    expect(derived.mismatch).toBe(false);
    expect(derived.shares.map((share) => [share.participantId, share.exactAmount])).toEqual(
      snapshot.computedShares.map((share) => [share.participantId, share.exactAmount])
    );
    expect(derived.shares.map((share) => share.name)).toEqual(["Albus", "Bea", "Cy"]);
    expect(derived.shares.reduce((total, share) => total + (share.settlementSharePaise ?? 0), 0)).toBe(10_000);
  });

  it("detects a forged cache and keeps its own numbers", () => {
    const snapshot = assembleSnapshot(locked(), { now: NOW });
    const forged = {
      ...snapshot,
      computedShares: snapshot.computedShares.map((share, index) =>
        index === 0 ? { ...share, exactAmount: { numeratorPaise: "1", denominator: "1" } } : share
      ),
    } as BillShareSnapshot;

    const derived = sharesFromSnapshot(forged);

    expect(derived.mismatch).toBe(true);
    expect(derived.shares[0]!.exactAmount).toEqual({ numeratorPaise: "10000", denominator: "3" });
  });

  it("synthesizes one unit row per unit of quantity, from the snapshot alone", () => {
    const snapshot = assembleSnapshot(locked({ qty: 2 }), { now: NOW });

    const state = splittableFromSnapshot(snapshot);

    expect(state.itemUnits).toHaveLength(snapshot.items.reduce((total, item) => total + item.qty, 0));
    expect(state.assignments).toHaveLength(6);
    expect(state.participants.map((participant) => participant.id)).toEqual(snapshot.participants.map((p) => p.id));
    expect(state.bill.adjustmentLines).toHaveLength(snapshot.adjustmentLines.length);
    expect(state.items[0]!.unitPrice).toBe(10_000);
  });
});

describe("ticket 16 — links are a lock-time action (DECISIONS/0026 A7)", () => {
  it("mints one fragment per participant from one snapshot, each keyed by that participant's token", async () => {
    const document = locked();

    const outcome = await buildShareLinks(document, { now: NOW });
    if (!outcome.ok) throw new Error(`expected links, got ${outcome.code}`);

    expect(outcome.snapshot).toEqual(assembleSnapshot(document, { now: NOW }));
    expect(outcome.links.map((link) => link.participantId)).toEqual([...ROSTER]);
    expect(new Set(outcome.links.map((link) => link.fragment))).toHaveLength(3);

    for (const link of outcome.links) {
      await expect(decodeSnapshot(link.fragment, tokenOf(document, link.participantId))).resolves.toEqual(
        outcome.snapshot
      );
    }
    // Another participant's token is not a key to this link: the fragments really are individually keyed.
    const [first, second] = outcome.links;
    await expect(decodeSnapshot(first!.fragment, tokenOf(document, second!.participantId))).rejects.toMatchObject({
      code: "link_corrupt_or_tampered",
    });
  });

  it("offers no link at all for a participant with no token", async () => {
    const document = locked({ mint: (participantId) => (participantId === "p1" ? "" : uuidAt(1)) });

    const outcome = await buildShareLinks(document, { now: NOW });
    if (!outcome.ok) throw new Error(`expected links, got ${outcome.code}`);

    expect(outcome.links.map((link) => link.participantId)).toEqual([CREATOR, "p2"]);
  });

  it("refuses an unlocked bill rather than encoding a moving target", async () => {
    const parse = parseFixture();
    const unlocked = beginFrom(parse, validate(parse), { billId: BILL_ID, createdAt: CREATED_AT });

    const outcome = await buildShareLinks(unlocked, { now: NOW });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.code).toBe("bill_locked");
  });
});

describe("ticket 16 — staleness is one comparison (DECISIONS/0026 A9)", () => {
  it("marks a snapshot before the cutoff stale, at-or-after it current, and with no cutoff unknown", () => {
    expect(stalenessOf(CREATED_AT, NOW)).toEqual({ state: "stale", cutoffAt: NOW });
    expect(stalenessOf(NOW, NOW)).toEqual({ state: "current_for_this_bill" });
    expect(stalenessOf("2026-11-05T10:00:00.000Z", NOW)).toEqual({ state: "current_for_this_bill" });
    expect(stalenessOf(NOW, null)).toEqual({ state: "unknown" });
  });
});
