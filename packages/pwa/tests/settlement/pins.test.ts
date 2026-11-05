import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ParsedItem, ParseResult } from "@receipt-lens/core";

import {
  addParticipant,
  assignUnit,
  beginFrom,
  finalizeItems,
  lockBill,
  runTransaction,
  setParticipantPaid,
  setPayer,
  unlockBill,
  type TransactionResult,
} from "../../src/lib/bill/transactions.js";
import type { BillDocument } from "../../src/lib/bill/document.js";
import type { ExactMoney } from "../../src/lib/entities.js";
import type { ParticipantShare } from "../../src/lib/splitting.js";
import {
  buildSettlement,
  buildUpiIntent,
  buildWhatsAppMessage,
  buildWhatsAppUrl,
  deriveTransactionRef,
  formatExactRupees,
  formatPaymentPaise,
  participantLinkFor,
  settlementRows,
  type SettlementContext,
  type SettlementParticipant,
} from "../../src/lib/settlement-links.js";

/**
 * DECISIONS/0024, as assertions. Written before the implementation, deliberately: every settlement-links
 * export throws `not implemented: DECISIONS/0024 …`, so this file is red on exactly those pins.
 *
 * The seam is a committed document plus a profile in, display/copy material out — no component, no clock, no
 * store. `setPayer`'s narrowed contract and the `paid` flag go through the transaction runner, because they
 * are state, not presentation.
 */

const CREATED_AT = "2026-11-05T00:00:00.000Z";
const UNLOCKED_AT = "2026-11-05T12:00:00.000Z";
const BILL_ID = "bill:test";
const CREATOR = `${BILL_ID}:creator`;
const PROFILE = { displayName: "Albus", upiId: "albus@okhdfc" };

const em = (numeratorPaise: string, denominator = "1"): ExactMoney => ({ numeratorPaise, denominator });

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

function parseFixture(): ParseResult {
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
  };
}

function begin(): BillDocument {
  const parse = parseFixture();
  return beginFrom(parse, { uncertain: false, findings: [], items: [...parse.items] }, {
    billId: BILL_ID,
    createdAt: CREATED_AT,
  });
}

function ok(result: TransactionResult): BillDocument {
  if (!result.ok) throw new Error(`expected a commit, got ${result.reject.code}`);
  return result.document;
}

function rejected(result: TransactionResult): { code: string; refs: string[] } {
  if (result.ok) throw new Error("expected a rejection, got a commit");
  return result.reject;
}

/** A locked bill whose single ₹100 unit is held by all three participants. */
function lockedWithThreeHolders(): BillDocument {
  let document = ok(finalizeItems(begin(), ["i1"]));
  document = ok(addParticipant(document, "A"));
  document = ok(addParticipant(document, "B"));
  for (const id of [CREATOR, "p1", "p2"]) document = ok(assignUnit(document, "unit:i1:0", id));
  return ok(lockBill(document, { mintToken: (id) => `token-${id}` }));
}

interface RowSpec {
  readonly id: string;
  readonly exact: ExactMoney;
  readonly paid?: boolean;
  readonly token?: string;
}

function context(rows: readonly RowSpec[], confirmedTotalPaise: number, over: Partial<SettlementContext> = {}): SettlementContext {
  const participants: SettlementParticipant[] = rows.map((row) => ({
    id: row.id,
    name: row.id === CREATOR ? "Albus" : row.id.toUpperCase(),
    paid: row.paid ?? false,
    token: row.token ?? `token-${row.id}`,
  }));
  const shares: ParticipantShare[] = rows.map((row) => ({ participantId: row.id, exactAmount: row.exact }));
  return {
    billId: BILL_ID,
    title: "Dinner",
    payerId: CREATOR,
    creatorId: CREATOR,
    participants,
    shares,
    confirmedTotalPaise,
    profile: PROFILE,
    ...over,
  };
}

function row(view: ReturnType<typeof settlementRows>, id: string) {
  if (!view.ok) throw new Error(`expected a view, got ${view.code}`);
  const found = view.rows.find((entry) => entry.participantId === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

function params(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

describe("ticket 15 — exact versus payment (DECISIONS/0024 S2)", () => {
  it("shows both values when a third of the bill does not land on whole paise", () => {
    const view = settlementRows(
      context(
        [
          { id: CREATOR, exact: em("10000", "3") },
          { id: "p1", exact: em("10000", "3") },
          { id: "p2", exact: em("10000", "3") },
        ],
        10_000
      )
    );

    const p1 = row(view, "p1");
    expect(p1.differs).toBe(true);
    expect(p1.exactText).toBe("₹33.3333…");
    expect(p1.paymentText).toBe("₹33.33");
    expect(p1.exactText).not.toBe(p1.paymentText);
  });

  it("collapses to one value when the share is a whole number of paise", () => {
    const view = settlementRows(
      context(
        [
          { id: CREATOR, exact: em("2500") },
          { id: "p1", exact: em("2500") },
          { id: "p2", exact: em("2500") },
          { id: "p3", exact: em("2500") },
        ],
        10_000
      )
    );

    const p1 = row(view, "p1");
    expect(p1.differs).toBe(false);
    expect(p1.exactText).toBe("₹25.00");
    expect(p1.paymentText).toBe("₹25.00");
  });

  it("shows a zero share as nothing to pay, with no payment material", () => {
    const view = settlementRows(
      context(
        [
          { id: CREATOR, exact: em("10000") },
          { id: "p1", exact: em("0") },
        ],
        10_000
      )
    );

    const p1 = row(view, "p1");
    expect(p1.state).toBe("nothing_to_pay");
    expect(p1.paymentPaise).toBe(0);
    expect(p1.upiUrl).toBeNull();
    expect(p1.whatsappUrl).toBeNull();
    expect(formatExactRupees(em("0"))).toBe("₹0.00");
  });

  it("formats the payment amount from integer paise, never from a float", () => {
    expect(formatPaymentPaise(150)).toBe("₹1.50");
    expect(formatPaymentPaise(100)).toBe("₹1.00");
    expect(formatPaymentPaise(50)).toBe("₹0.50");
    expect(formatPaymentPaise(10_000)).toBe("₹100.00");
  });
});

describe("ticket 15 — self-payment (DECISIONS/0024 S4)", () => {
  it("gives the creator/payer no link and everyone else one", () => {
    const view = settlementRows(
      context(
        [
          { id: CREATOR, exact: em("10000", "3") },
          { id: "p1", exact: em("10000", "3") },
          { id: "p2", exact: em("10000", "3") },
        ],
        10_000
      )
    );

    const creator = row(view, CREATOR);
    expect(creator.state).toBe("payer");
    expect(creator.upiUrl).toBeNull();
    expect(creator.whatsappUrl).toBeNull();

    expect(row(view, "p1").state).toBe("payable");
    expect(row(view, "p1").upiUrl).toMatch(/^upi:\/\/pay\?/);
    expect(row(view, "p1").whatsappUrl).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it("refuses to build an intent when the creator has no name anywhere", () => {
    const result = buildUpiIntent({
      payerUpi: PROFILE.upiId,
      payerName: "   ",
      amountPaise: 5000,
      note: "Dinner share",
    });

    expect(result).toEqual({ ok: false, code: "creator_name_missing" });
  });

  it("falls back to the payer participant's name when the profile display name is blank", () => {
    const view = settlementRows(
      context(
        [
          { id: CREATOR, exact: em("5000") },
          { id: "p1", exact: em("5000") },
        ],
        10_000,
        { profile: { displayName: "", upiId: PROFILE.upiId } }
      )
    );

    const p1 = row(view, "p1");
    expect(p1.state).toBe("payable");
    expect(params(p1.upiUrl!).get("pn")).toBe("Albus");
  });
});

describe("ticket 15 — the intent (DECISIONS/0024 S3)", () => {
  it("encodes every parameter, including unicode, ampersands and quotes", () => {
    const result = buildUpiIntent({
      payerUpi: "albus@okhdfc",
      payerName: 'Ada & Sons "Café"',
      amountPaise: 150,
      note: "Dinner & drinks",
      reference: "abc123",
    });

    if (!result.ok) throw new Error(result.code);
    expect(result.url).toContain("pa=albus%40okhdfc");
    expect(result.url).toContain("pn=Ada%20%26%20Sons%20%22Caf%C3%A9%22");
    expect(result.url).toContain("tn=Dinner%20%26%20drinks");
    expect(result.url).toContain("am=1.50");
    expect(result.url).toContain("cu=INR");
    expect(result.url).toContain("tr=abc123");
  });

  it("always renders the amount with exactly two decimals", () => {
    const oneFifty = buildUpiIntent({ payerUpi: "a@b", payerName: "A", amountPaise: 150, note: "n" });
    const one = buildUpiIntent({ payerUpi: "a@b", payerName: "A", amountPaise: 100, note: "n" });
    if (!oneFifty.ok || !one.ok) throw new Error("expected intents");
    expect(params(oneFifty.url).get("am")).toBe("1.50");
    expect(params(one.url).get("am")).toBe("1.00");
  });

  it("truncates the payee name at 40 and the note at 50, rather than dropping them", () => {
    const result = buildUpiIntent({
      payerUpi: "a@b",
      payerName: "N".repeat(60),
      amountPaise: 500,
      note: "n".repeat(80),
    });

    if (!result.ok) throw new Error(result.code);
    expect(params(result.url).get("pn")).toHaveLength(40);
    expect(params(result.url).get("tn")).toHaveLength(50);
  });

  it("refuses without a payee UPI id", () => {
    expect(buildUpiIntent({ payerUpi: "  ", payerName: "A", amountPaise: 500, note: "n" })).toEqual({
      ok: false,
      code: "creator_upi_missing",
    });
  });
});

describe("ticket 15 — the transaction reference (DECISIONS/0024 S3 pin 4)", () => {
  it("is the first 16 hex characters of HMAC-SHA-256 over billId:participantId keyed by the token", () => {
    const expected = createHmac("sha256", "secret").update(`${BILL_ID}:p1`).digest("hex").slice(0, 16);

    const actual = deriveTransactionRef(BILL_ID, "p1", "secret");

    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is present in the intent when it exists, and omitted when the token is empty", () => {
    const derived = deriveTransactionRef(BILL_ID, "p1", "secret")!;
    const withReference = buildUpiIntent({
      payerUpi: "a@b",
      payerName: "A",
      amountPaise: 500,
      note: "n",
      reference: derived,
    });
    if (!withReference.ok) throw new Error(withReference.code);
    expect(params(withReference.url).get("tr")).toBe(derived);

    expect(deriveTransactionRef(BILL_ID, "p1", "")).toBeNull();
    const without = buildUpiIntent({ payerUpi: "a@b", payerName: "A", amountPaise: 500, note: "n", reference: null });
    if (!without.ok) throw new Error(without.code);
    expect(without.url).not.toContain("tr=");
  });

  it("omits a caller reference that would break the length or charset limit", () => {
    const tooLong = buildUpiIntent({
      payerUpi: "a@b",
      payerName: "A",
      amountPaise: 500,
      note: "n",
      reference: "x".repeat(36),
    });
    const wrongCharset = buildUpiIntent({
      payerUpi: "a@b",
      payerName: "A",
      amountPaise: 500,
      note: "n",
      reference: "order#42",
    });
    if (!tooLong.ok || !wrongCharset.ok) throw new Error("expected intents");
    expect(tooLong.url).not.toContain("tr=");
    expect(wrongCharset.url).not.toContain("tr=");
  });
});

describe("ticket 15 — zero and sub-rupee settlement (DECISIONS/0024 S4 pin 5)", () => {
  it("has no link at zero and a valid 0.50 link at 50 paise", () => {
    const view = settlementRows(
      context(
        [
          { id: CREATOR, exact: em("9950") },
          { id: "p1", exact: em("50") },
        ],
        10_000
      )
    );

    const p1 = row(view, "p1");
    expect(p1.paymentPaise).toBe(50);
    expect(p1.state).toBe("payable");
    expect(params(p1.upiUrl!).get("am")).toBe("0.50");
  });
});

describe("ticket 15 — WhatsApp (DECISIONS/0024 S5)", () => {
  it("labels the exact share, the payment amount and the participant link separately", () => {
    const view = settlementRows(
      context(
        [
          { id: CREATOR, exact: em("10000", "3") },
          { id: "p1", exact: em("10000", "3") },
          { id: "p2", exact: em("10000", "3") },
        ],
        10_000,
        { origin: "https://example.test" }
      )
    );

    const p1 = row(view, "p1");
    const text = buildWhatsAppMessage({
      participantName: p1.name,
      billTitle: "Dinner",
      exactText: p1.exactText,
      paymentText: p1.paymentText,
      upiUrl: p1.upiUrl!,
      participantLink: p1.participantLink!,
    });

    expect(text).toContain("Exact share: ₹33.3333…");
    expect(text).toContain("UPI payment amount: ₹33.33");
    expect(text).toContain("https://example.test/share#v1.token-p1");
    expect(text).toContain("Nothing here verifies a transfer");

    const url = buildWhatsAppUrl(text);
    expect(url).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent(url.slice("https://wa.me/?text=".length))).toBe(text);
  });

  it("supplies the version-and-token placeholder link ticket 16 will replace", () => {
    expect(participantLinkFor("https://example.test", "abc")).toBe("https://example.test/share#v1.abc");
    expect(participantLinkFor("", "abc")).toBe("/share#v1.abc");
  });
});

describe("ticket 15 — payer equals creator (DECISIONS/0024 S1 pin 1)", () => {
  it("rejects a non-creator payer with payer_must_be_creator", () => {
    const document = ok(addParticipant(begin(), "A"));

    const attempt = setPayer(document, "p1");

    expect(rejected(attempt).code).toBe("payer_must_be_creator");
    expect(rejected(attempt).refs).toEqual(["p1"]);
    expect(attempt.document).toBe(document);
  });

  it("still permits clearing the payer and naming the creator", () => {
    const document = ok(addParticipant(begin(), "A"));

    expect(ok(setPayer(document, CREATOR)).working.bill.payerId).toBe(CREATOR);
    expect(ok(setPayer(document, null)).working.bill.payerId).toBe("");
  });
});

describe("ticket 15 — the manual paid flag (DECISIONS/0024 S6 pin 8)", () => {
  it("does not change the UPI link, and survives unlock and re-lock", () => {
    let document = lockedWithThreeHolders();
    const before = buildSettlement(document, PROFILE, { origin: "https://example.test" });
    if (!before.ok) throw new Error(before.code);
    const beforeUrl = before.rows.find((entry) => entry.participantId === "p1")!.upiUrl;

    document = ok(setParticipantPaid(document, "p1", true));
    const after = buildSettlement(document, PROFILE, { origin: "https://example.test" });
    if (!after.ok) throw new Error(after.code);
    expect(after.rows.find((entry) => entry.participantId === "p1")!.upiUrl).toBe(beforeUrl);
    expect(after.rows.find((entry) => entry.participantId === "p1")!.paid).toBe(true);

    document = ok(
      unlockBill(document, { confirmed: true, now: UNLOCKED_AT, mintToken: (id) => `second-${id}` })
    );
    expect(document.working.participants.find((entry) => entry.id === "p1")!.paid).toBe(true);

    document = ok(lockBill(document, { mintToken: (id) => `second-${id}` }));
    expect(document.working.participants.find((entry) => entry.id === "p1")!.paid).toBe(true);
  });

  it("un-marking is the same operation in the other direction", () => {
    let document = ok(setParticipantPaid(lockedWithThreeHolders(), "p1", true));
    document = ok(setParticipantPaid(document, "p1", false));
    expect(document.working.participants.find((entry) => entry.id === "p1")!.paid).toBe(false);
  });
});

describe("ticket 15 — G5 is recorded in DECISIONS/0024 (pin 10)", () => {
  it("carries the primary source URL, its date and the unverified-against-primary statement", () => {
    const record = readFileSync(
      new URL("../../../../DECISIONS/0024-settlement-and-upi.md", import.meta.url),
      "utf8"
    );

    expect(record).toContain("UPI Linking Specifications 1.6");
    expect(record).toContain("2026-11-05");
    expect(record).toContain("unverified against the primary specification");
    expect(record).toContain("https://www.npci.org.in/");
  });
});
