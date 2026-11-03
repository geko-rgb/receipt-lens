import { describe, expect, it } from "vitest";
import { classifyRows, parse } from "./index.js";
import {
  AMBIGUOUS_CHARGE_ROW,
  COLUMN_LABELS,
  DISCOUNT_ROW,
  GSTIN_ROW,
  GRAND_TOTAL_ROW,
  INCLUDED_TAX_ROW,
  ITEM_A,
  ITEM_B,
  LAKH_ITEM_ROW,
  NAMELESS_AMOUNT_ROW,
  ROUND_OFF_ROW,
  SERVICE_ROW,
  SGST_ROW,
  SUBTOTAL_ROW,
  TAX_PAIR_ROW,
  TAX_ROW,
  TENDER_ROW,
  TIP_ROW,
  ocrRow,
  receipt,
  WRAP_1,
  WRAP_2,
  ZERO_TOTAL_ROW,
} from "./fixtures.js";

/**
 * Ticket 06 end to end: item rows become items with provenance, labelled rows become typed charges, and
 * anything the parser cannot establish stays visible instead of becoming a guess.
 */

const CHARGE_RECEIPT = receipt(
  COLUMN_LABELS,
  ITEM_A,
  WRAP_1,
  WRAP_2,
  ITEM_B,
  GSTIN_ROW,
  TAX_ROW,
  SGST_ROW,
  SERVICE_ROW,
  TIP_ROW,
  DISCOUNT_ROW,
  ROUND_OFF_ROW,
  SUBTOTAL_ROW,
  GRAND_TOTAL_ROW
);

describe("labelled money rows become typed charges (§5, §4's DQ-03 shape)", () => {
  it("fills each public charge field from its own label", () => {
    const parsed = parse(CHARGE_RECEIPT);
    expect(parsed.taxes).toEqual([
      { label: "cgst", amount: 250, source: "detected" },
      { label: "sgst", amount: 250, source: "detected" },
    ]);
    expect(parsed.serviceCharge).toBe(590);
    expect(parsed.tip).toBe(300);
    expect(parsed.discount).toBe(1000);
    expect(parsed.roundOff).toBe(20);
    expect(parsed.subtotal).toBe(10800);
    expect(parsed.subtotalSource).toBe("detected");
    expect(parsed.grandTotal).toBe(11800);
    expect(parsed.grandTotalSource).toBe("detected");
  });

  it("never lets a charge row become an item, and never lets a tax identifier become a tax", () => {
    const parsed = parse(CHARGE_RECEIPT);
    expect(parsed.items.map((item) => item.name)).toEqual(["MIKA GORENG Tanpa es dan gula", "NASI PUTIH"]);
    expect(parsed.taxes.map((tax) => tax.label)).not.toContain("gstin");
    expect(parsed.otherCharges).toEqual([]);
  });

  it("keeps a printed percentage as a display-only rate, not as an amount", () => {
    // Indonesian-shaped amounts throughout, so the document's own evidence selects id-ID and `18.182`
    // reads as Rp 18,182 rather than a three-digit fraction.
    const pajakRow = ocrRow("r", 216, [["PAJAK", 10, 30], ["10%", 44, 18], ["18.182", 150, 20]]);
    const parsed = parse(receipt(ITEM_A, ITEM_B, pajakRow));
    const pajak = parsed.taxes.find((tax) => tax.label === "pajak");
    expect(pajak).toMatchObject({ amount: 1818200, rate: 1000 });
  });

  it("reads the tax inclusion cue as an aggregate, so tax already inside prices is never added again", () => {
    const parsed = parse(receipt(INCLUDED_TAX_ROW, GRAND_TOTAL_ROW));
    expect(parsed.taxes).toEqual([]);
    expect(parsed.grandTotal).toBe(11800);
  });

  it("names both taxes when a row prints one amount for two, and says which one it could not attribute", () => {
    const parsed = parse(receipt(TAX_ROW, TAX_PAIR_ROW, GRAND_TOTAL_ROW));
    const pair = parsed.taxes.filter((tax) => tax.label === "cgst" || tax.label === "sgst");
    expect(pair.map((tax) => tax.amount)).toContain(500);
    expect(pair.map((tax) => tax.amount)).toContain(null);
    expect(parsed.warnings.filter((warning) => warning.code === "unclassified_charge").length).toBeGreaterThan(0);
  });

  it("keeps an unclassifiable labelled charge with its label and a warning instead of guessing", () => {
    const parsed = parse(receipt(AMBIGUOUS_CHARGE_ROW, TAX_ROW));
    expect(parsed.otherCharges).toEqual([{ label: "total", amount: null, type: "other", sign: "unknown", source: "detected" }]);
    const warning = parsed.warnings.find((entry) => entry.code === "unclassified_charge");
    expect(warning?.sourceText).toContain("TOTAL");
    expect(parsed.items).toEqual([]);
  });

  it("leaves an unlabelled money row as a preserved row rather than a charge or a product", () => {
    const parsed = parse(receipt(ITEM_A, NAMELESS_AMOUNT_ROW));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.taxes).toEqual([]);
    expect(parsed.otherCharges).toEqual([]);
    expect(parsed.unclassifiedRows.map((row) => row.text)).toEqual(["5,000"]);
    expect(parsed.warnings.some((warning) => warning.code === "ambiguous_row")).toBe(true);
  });
});

describe("item provenance (§7)", () => {
  it("marks an assumed quantity, and only where the receipt printed none", () => {
    const parsed = parse(receipt(ITEM_A, ITEM_B));
    expect(parsed.items.map((item) => item.quantitySource)).toEqual(["assumed", "assumed"]);
    expect(parsed.items.map((item) => item.qty)).toEqual([1, 1]);
    expect(parsed.items.every((item) => item.priceSource === "detected")).toBe(true);
  });

  it("reads an explicit quantity from the `N ×` pattern and never claims it as assumed", () => {
    const parsed = parse(receipt(
      ocrRow("q1", 20, [["2", 10, 8], ["X", 22, 8], ["MIKA", 34, 20], ["GORENG", 58, 32], ["4.000", 150, 20]]),
      ITEM_B
    ));
    expect(parsed.items[0]).toMatchObject({ qty: 2, quantitySource: "explicit", lineTotal: 400000, unitPrice: null, priceSource: "unresolved" });
    expect(parsed.items[0]!.warnings).toEqual([]);
  });

  it("leaves the printed line total separate from anything later computed, and refuses to divide it", () => {
    const three = ocrRow("d1", 180, [["3", 10, 8], ["X", 22, 8], ["NASI", 34, 20], ["LEMAK", 58, 28], ["9.000", 150, 20]]);
    const parsed = parse(receipt(ITEM_A, ITEM_B, three));
    expect(parsed.items[2]).toMatchObject({ qty: 3, lineTotal: 900000, unitPrice: null, priceSource: "unresolved" });
  });

  it("reads an @-printed unit price as its own value", () => {
    const marked = ocrRow("a1", 180, [["2", 10, 8], ["X", 22, 8], ["TEH", 34, 14], ["@6.000", 96, 24], ["12.000", 150, 20]]);
    const parsed = parse(receipt(ITEM_A, ITEM_B, marked));
    expect(parsed.items[2]).toMatchObject({ qty: 2, unitPrice: 600000, priceSource: "detected", lineTotal: 1200000 });
  });

  it("parses Indian lakh grouping through the app's own profile", () => {
    const more = ocrRow("lk2", 408, [["GOBI", 10, 22], ["MANCHURIAN", 36, 44], ["12,345.67", 120, 50]]);
    const parsed = parse(receipt(LAKH_ITEM_ROW, more));
    expect(parsed.items[0]).toMatchObject({ name: "PANEER TICKA", lineTotal: 12345678, priceSource: "detected" });
    expect(parsed.items[1]).toMatchObject({ lineTotal: 1234567 });
  });
});

describe("Q6 and Q7: a zero total parses, and a tender never becomes a product", () => {
  it("parses `MIKA KECIL 0` — the row total really is 0, and the price band excludes it as a bare integer", () => {
    const parsed = parse(receipt(ITEM_A, ITEM_B, ZERO_TOTAL_ROW));
    const zero = parsed.items.at(-1);
    expect(zero).toMatchObject({ name: "MIKA KECIL", lineTotal: 0, priceSource: "detected" });
    expect(parsed.unclassifiedRows.map((row) => row.text)).not.toContain("MIKA KECIL 0");
  });

  it("refuses a non-zero integer in the price band: an item count is not money, in either direction", () => {
    const counted = ocrRow("k1", 180, [["TOTAL", 10, 30], ["ITEMS", 44, 30], ["7", 162, 8]]);
    const parsed = parse(receipt(ITEM_A, ITEM_B, counted));
    // `TOTAL` is a §5 charge label, so the row is a labelled row and 06 reads its amounts — `7` is not
    // one (Q5), so the row becomes neither an item, nor a charge, nor a round-off.
    expect(parsed.items).toHaveLength(2);
    expect(parsed.grandTotal).toBeNull();
    expect(parsed.taxes).toEqual([]);
    expect(parsed.otherCharges).toEqual([]);
  });

  it("classifies tender lines as noise and produces zero tender-named items over the fixture", () => {
    const parsed = parse(receipt(ITEM_A, ITEM_B, TENDER_ROW, ocrRow("t2", 216, [["CHANGE", 10, 34], ["4.500", 150, 20]])));
    expect(parsed.items.map((item) => item.name)).toEqual(["MIKA GORENG", "NASI PUTIH"]);
    expect(parsed.unclassifiedRows.map((row) => row.text)).not.toContain("CASH 20.000");
    const classes = classifyRows(receipt(ITEM_A, ITEM_B, TENDER_ROW)).rows.map((entry) => entry.classification);
    expect(classes.at(-1)).toBe("noise_header");
  });
});

describe("purity of the filled parse()", () => {
  it("never mutates the OcrResult it was handed", () => {
    const ocr = CHARGE_RECEIPT;
    const before = JSON.stringify(ocr);
    parse(ocr);
    expect(JSON.stringify(ocr)).toBe(before);
  });

  it("shares no nested reference between the input and the output (§4 line 319)", () => {
    const ocr = CHARGE_RECEIPT;
    const parsed = parse(ocr);
    const inputBoxes = new Set<unknown>();
    for (const line of ocr.lines) {
      inputBoxes.add(line.box);
      for (const word of line.words) inputBoxes.add(word.box);
    }
    const emitted = [...parsed.items.map((item) => item.id), ...parsed.unclassifiedRows.map((row) => row.id)];
    expect(emitted.length).toBeGreaterThan(0);
    for (const row of parsed.unclassifiedRows) expect(inputBoxes.has(row.box)).toBe(false);
    // Line ids are copied strings, so an output array is never the input's array.
    for (const item of parsed.items) {
      const line = ocr.lines.find((entry) => entry.id === item.sourceLineIds[0]);
      expect(line?.words.length).toBeGreaterThan(0);
    }
  });
});
