import { describe, expect, it } from "vitest";
import { classifyRows } from "./classify.js";
import { parse } from "./index.js";
import { KOT_PINEAPPLE_REAL_OCR, SARAVANA_REAL_OCR } from "./real-ocr-fixtures.js";

/**
 * `next.md` — header-free receipt row reconstruction, measured on the two real photographs.
 *
 * These fixtures are the provider's own output replayed (`real-ocr-fixtures.ts`), not hand-authored geometry:
 * the words, boxes and image sizes are what `PP-OCRv6 Small` returned for
 * `images/WhatsApp Image 2026-11-06 at 22.48.34.jpeg` and `images/WhatsApp Image 2026-11-06 at 22.48.35(1).jpeg`
 * through the built shell. Amendment H therefore says to assert exactly what the OCR produced — `offee`, `Po8` —
 * and never to edit a name into what the reader can see on the paper.
 *
 * The Saravana page names no name column (`Product` lost its `P`, `Expire Qty Rate Total` on its own line), so
 * DECISIONS/0033's header pass correctly refuses it. The products are recovered by pairing each description with
 * the numbers it sits nearest to (DECISIONS/0035), and the arithmetic then agrees on every row.
 */

const saravana = parse(SARAVANA_REAL_OCR);
const kot = parse(KOT_PINEAPPLE_REAL_OCR);

describe("Saravana Bhavan — no readable name column, numbers printed under the name", () => {
  it("pairs every product with its own numbers instead of giving one row all of them", () => {
    expect(saravana.items.map((item) => [item.name, item.qty, item.unitPrice, item.lineTotal])).toEqual([
      ["offee", 2, 3500, 7000],
      ["vada", 2, 2500, 5000],
      ["Chappathi Empty", 2, 2400, 4800],
      ["combo 2 chapati/,Po8 Masala", 2, 15300, 30600],
    ]);
    // Quantity and price are both read, not assumed: the printed `2.00` is the count and `35.00` the rate.
    expect(saravana.items.map((item) => item.quantitySource)).toEqual(["explicit", "explicit", "explicit", "explicit"]);
    expect(saravana.items.map((item) => item.priceSource)).toEqual(["detected", "detected", "detected", "detected"]);
  });

  it("closes to the printed grand total exactly", () => {
    const sum = saravana.items.reduce((total, item) => total + (item.lineTotal ?? 0), 0);
    expect(saravana.grandTotal).toBe(47400);
    expect(sum).toBe(47400);
    expect(saravana.warnings.map((warning) => warning.code)).not.toContain("items_may_be_missing");
  });

  it("publishes every product at a printed price, leaving no row it could not place inside the item table", () => {
    // Pairing removed the 12 unread rows and the unpriced product this page used to publish; what remains for review
    // is the trailing block below the totals — see the next test, which is the honest figure and not zero.
    expect(saravana.items.every((item) => item.unitPrice !== null)).toBe(true);
  });

  it("preserves the five trailing rows it could not understand instead of discarding them", () => {
    // DECISIONS/0035's disposition audit (2026-11-10). Until then these rows landed in `noise_header` by accident:
    // 0008 P7's rule 5 asks "is this above the item region?" through a counter (`pricedRowsSeen`) that only rows
    // *the classifier itself* priced ever advanced — and on this page every priced row was reconstructed, so the
    // counter stayed at zero and seven rows with no label and no money were discarded as header noise. A row that
    // cannot be justified as a header, a charge, metadata or an understood tax row belongs in review, even though
    // the figure is worse: the bill cannot be locked until the creator dismisses them.
    // Two of the seven left review on 2026-11-10: `Sman :-3` is a staff label and `Sales Type ： DINING` is the
    // receipt's own metadata (DECISIONS/0034's amendment), so the family list reads them instead of the audit
    // having to preserve them. Five remain, and they are the ones nobody can justify discarding.
    expect(saravana.unclassifiedRows.map((row) => row.text)).toEqual([
      "ocrec re",
      "e",
      "Wtnin 2gis",
      "[BUSINESS] [BUSINESS]",
      "[BUSINESS] [BUSINESS] [BUSINESS]",
    ]);
    expect(saravana.warnings.filter((warning) => warning.code === "ambiguous_row")).toHaveLength(5);
  });
});

describe("KOT counter — `Particulars | Qty | Rate | Amount`", () => {
  it("reads the line as quantity 3 at ₹25.00", () => {
    expect(kot.items.map((item) => [item.name, item.qty, item.unitPrice, item.lineTotal])).toEqual([
      ["D Pineapple lime", 3, 2500, 7500],
    ]);
  });

  it("does not invent the ₹4.50 sambar the ticket never charged for", () => {
    expect(kot.items).toHaveLength(1);
    expect(kot.items.some((item) => item.lineTotal === 450)).toBe(false);
    // Three trailing rows are preserved, none of them priced and none of them a product: the invoice's `1`, and the
    // two illegible marks below it. (Same disposition-audit finding as the Saravana page: they are not headers.)
    expect(kot.unclassifiedRows.map((row) => row.text)).toEqual(["1", "PNITIVIEC", "ei2"]);
  });
});

describe("the pairing ledger (what the stage saw and why)", () => {
  it("ranks roles by arithmetic agreement, not by column order", () => {
    const pairing = classifyRows(SARAVANA_REAL_OCR).pairing;
    expect(pairing?.roled).toBe(true);
    expect(pairing?.scored[0]?.score).toBeGreaterThanOrEqual(4);
    expect(pairing?.unpaired).toEqual([]);
  });

  it("reports the role decision's provenance", () => {
    const pairing = classifyRows(SARAVANA_REAL_OCR).pairing;
    // `2.00 35.00 70.00` is the same arithmetic on four rows, so the decision is arithmetic, not positional.
    expect(pairing?.roleSource).toBe("arithmetic");
    expect(pairing?.roles.map((role) => role.role)).toEqual(["qty", "rate", "total"]);
  });
});
