import { describe, expect, it } from "vitest";
import { classifyRows } from "./classify.js";
import { ocrRow, receipt } from "./fixtures.js";
import { parse } from "./index.js";
import { isNameLike, reconstructWithoutHeader, type PairingOptions } from "./pairs.js";
import { validate } from "../validate/index.js";
import type { ParsedRow } from "./geometry.js";
import type { OcrResult } from "../ocr/types.js";

/**
 * The header-free stage, on hand-authored geometry (`fixtures.ts`: 200px-wide page, 10px words, 4px y-band).
 *
 * These are *layout* tests — one per arrangement `next.md` §2 and §6 name — and they are deliberately separate
 * from `headerless.test.ts`, which replays the two photographs' own OCR. A layout has to be reachable with
 * spacing the photographs do not happen to show (numbers below the name, uneven gaps, a repeated product), and
 * only a fixture can vary that. Nothing here is a claim about a real page.
 *
 * Layout on the 200px page: name column at x=10, and the three value columns right-aligned at x≈60 (qty),
 * x≈110 (rate) and x≈160 (total).
 */

const NAME = 10;
const QTY = 60;
const RATE = 110;
const TOTAL = 160;

/** A name line and the numbers that belong with it, `[name, qty, rate, total]`. */
const nameRow = (id: string, y: number, name: string) => ocrRow(id, y, [[name, NAME, Math.max(28, name.length * 6)]]);
// The quantity cell is printed as `2.00` on the photographs this stage was built for, and a bare `2` is not
// money-shaped, so the helper writes the column the way the page does. (A bare integer in a money column is a real
// receipt shape too — `Amendment E`'s year test shows what the stage does then: it refuses it.)
const valueRow = (id: string, y: number, qty: string, rate: string, total: string) =>
  ocrRow(id, y, [
    [qty.includes(".") ? qty : `${qty}.00`, QTY, 24],
    [rate, RATE, 26],
    [total, TOTAL, 26],
  ]);

const options = (
  isFurniture: (row: ParsedRow) => boolean = () => false,
  isLabelled: (row: ParsedRow) => boolean = () => false
): PairingOptions => ({ isFurniture, isLabelled });

describe("numbers above their descriptions (the Saravana layout)", () => {
  const page = receipt(
    valueRow("v1", 20, "2.00", "35.00", "70.00"),
    nameRow("n1", 34, "Coffee"),
    valueRow("v2", 48, "2.00", "25.00", "50.00"),
    nameRow("n2", 62, "Vada"),
    valueRow("v3", 76, "2.00", "24.00", "48.00"),
    nameRow("n3", 90, "Chappathi")
  );

  it("pairs each name with the numbers above it", () => {
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.records.map((record) => [record.name, record.qty?.value, record.rate?.value, record.total?.value])).toEqual([
      ["Coffee", 2, 35, 70],
      ["Vada", 2, 25, 50],
      ["Chappathi", 2, 24, 48],
    ]);
    expect(result.roleSource).toBe("arithmetic");
    expect(result.unpaired).toEqual([]);
  });
});

describe("numbers below their descriptions (the same geometry, reversed)", () => {
  const page = receipt(
    nameRow("n1", 20, "Coffee"),
    valueRow("v1", 34, "2.00", "35.00", "70.00"),
    nameRow("n2", 48, "Vada"),
    valueRow("v2", 62, "2.00", "25.00", "50.00"),
    nameRow("n3", 76, "Chappathi"),
    valueRow("v3", 90, "2.00", "24.00", "48.00")
  );

  it("pairs each name with the numbers below it, with no second code path", () => {
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.records.map((record) => [record.name, record.qty?.value, record.rate?.value, record.total?.value])).toEqual([
      ["Coffee", 2, 35, 70],
      ["Vada", 2, 25, 50],
      ["Chappathi", 2, 24, 48],
    ]);
    expect(result.roleSource).toBe("arithmetic");
  });

  it("decides the side from the page, not from a constant", () => {
    const above = receipt(
      valueRow("v1", 20, "2", "35.00", "70.00"),
      nameRow("n1", 34, "Coffee"),
      valueRow("v2", 48, "2.00", "25.00", "50.00"),
      nameRow("n2", 62, "Vada"),
      valueRow("v3", 76, "2", "24.00", "48.00"),
      nameRow("n3", 90, "Chappathi")
    );
    const read = (page: ReturnType<typeof receipt>) =>
      reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(read(above).records.map((record) => record.name)).toEqual(["Coffee", "Vada", "Chappathi"]);
  });
});

describe("uneven vertical spacing and a repeated product", () => {
  const page = receipt(
    nameRow("n1", 20, "Tea"),
    valueRow("v1", 36, "1.00", "12.00", "12.00"),
    // A wide gap before the second pair, then a second copy of the same product: repetition is a fact, not an error.
    nameRow("n2", 60, "Tea"),
    valueRow("v2", 74, "2.00", "12.00", "24.00"),
    nameRow("n3", 96, "Tea"),
    valueRow("v3", 110, "3.00", "12.00", "36.00")
  );

  it("spans the gap and keeps every row", () => {
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.records.map((record) => [record.name, record.qty?.value, record.total?.value])).toEqual([
      ["Tea", 1, 12],
      ["Tea", 2, 24],
      ["Tea", 3, 36],
    ]);
  });
});

describe("Amendment A — a number with no description is not a product", () => {
  it("pairs only the described row and reports the other", () => {
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      valueRow("v1", 34, "2.00", "35.00", "70.00"),
      nameRow("n2", 48, "Vada"),
      valueRow("v2", 62, "2.00", "25.00", "50.00"),
      // A third money row with nothing printed beside it: a subtotal or a stamp, not a product.
      valueRow("v3", 76, "1", "9.00", "9.00")
    );
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.records.map((record) => record.name)).toEqual(["Coffee", "Vada"]);
    expect(result.unpaired.map((entry) => entry.reason)).toEqual(["no_description"]);
    // The phantom-item class 0033 fixed cannot come back through this stage: no row is promoted with qty 1.
    const parsed = parse(page);
    expect(parsed.items.map((item) => item.name)).toEqual(["Coffee", "Vada"]);
    expect(parsed.items.every((item) => item.quantitySource !== "assumed")).toBe(true);
  });

  it("publishes nothing when a single pair is all the evidence there is", () => {
    // One numeric row is not a column (a band needs three members), so the stage has no roles to hand out at all.
    const page = receipt(nameRow("n1", 20, "Coffee"), valueRow("v1", 34, "2.00", "35.00", "70.00"));
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.records).toEqual([]);
    expect(result.roles).toEqual([]);
    expect(result.roleSource).toBeNull();
  });
});

describe("Amendment B — arithmetic is exact and never repaired", () => {
  it("keeps the printed values and marks the mismatch", () => {
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      valueRow("v1", 34, "2.00", "35.00", "70.00"),
      nameRow("n2", 48, "Vada"),
      valueRow("v2", 62, "3.00", "25.00", "50.00"),
      nameRow("n3", 76, "Tea"),
      valueRow("v3", 90, "1.00", "12.00", "12.00")
    );
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    const vada = result.records.find((record) => record.name === "Vada")!;
    expect(vada.evidence.map((entry) => entry.code)).toContain("arithmetic_mismatch");
    // Nothing is rewritten to make the check pass: the quantity and rate are withheld, the printed total stands.
    expect(vada.qty).toBeNull();
    expect(vada.rate).toBeNull();
    expect(vada.total?.value).toBe(50);
  });
});

describe("Amendment C — roles come from arithmetic, not column order", () => {
  it("names the quantity column even when it is not the leftmost", () => {
    // The line total is printed leftmost, where a reader would expect the quantity: only `qty × rate = total` can
    // say that the leftmost band is the money and not the count. (Qty and rate are then separated by the integer
    // gate and reading order — multiplication cannot tell `2 × 35` from `35 × 2`, and this record does not pretend
    // otherwise.)
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      ocrRow("v1", 34, [
        ["70.00", QTY, 26],
        ["2.00", RATE, 20],
        ["35.00", TOTAL, 26],
      ]),
      nameRow("n2", 48, "Vada"),
      ocrRow("v2", 62, [
        ["50.00", QTY, 26],
        ["2.00", RATE, 20],
        ["25.00", TOTAL, 26],
      ]),
      nameRow("n3", 76, "Tea"),
      ocrRow("v3", 90, [
        ["12.00", QTY, 26],
        ["1.00", RATE, 20],
        ["12.00", TOTAL, 26],
      ])
    );
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.roleSource).toBe("arithmetic");
    expect(result.records.map((record) => [record.name, record.qty?.value, record.rate?.value, record.total?.value])).toEqual([
      ["Coffee", 2, 35, 70],
      ["Vada", 2, 25, 50],
      ["Tea", 1, 12, 12],
    ]);
    // The arithmetic named the leftmost band as the total; the count and the rate sit in the other two.
    expect(result.roles.map((role) => role.role)).toEqual(["total", "qty", "rate"]);
  });
});

describe("Amendment E — candidate sanity gates", () => {
  it("never treats a four-digit year as a quantity", () => {
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      ocrRow("v1", 34, [
        ["2026", QTY, 24],
        ["35.00", RATE, 26],
        ["70.00", TOTAL, 26],
      ]),
      nameRow("n2", 48, "Vada"),
      ocrRow("v2", 62, [
        ["2026", QTY, 24],
        ["25.00", RATE, 26],
        ["50.00", TOTAL, 26],
      ]),
      nameRow("n3", 76, "Tea"),
      ocrRow("v3", 90, [
        ["2026", QTY, 24],
        ["12.00", RATE, 26],
        ["12.00", TOTAL, 26],
      ])
    );
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.records.every((record) => record.qty === null)).toBe(true);
  });
});


describe("quantity columns printed as bare integers (ticket 25)", () => {
  // Six rows, so §5's quantity *band* test (`QUANTITY_BAND_MIN_ROWS`) has enough members to qualify, and the count
  // column prints `1`/`2`/`3` — integers, not money — which `isAmountShaped` answers false for.
  const bareCount = (id: string, y: number, qty: string, rate: string, total: string) =>
    ocrRow(id, y, [
      [qty, QTY, 8],
      [rate, RATE, 26],
      [total, TOTAL, 26],
    ]);
  const barePage = () =>
    receipt(
      nameRow("n1", 20, "Coffee"),
      bareCount("v1", 34, "1", "35.00", "35.00"),
      nameRow("n2", 48, "Vada"),
      bareCount("v2", 62, "2", "25.00", "50.00"),
      nameRow("n3", 76, "Tea"),
      bareCount("v3", 90, "3", "12.00", "36.00"),
      nameRow("n4", 104, "Idli"),
      bareCount("v4", 118, "1", "24.00", "24.00"),
      nameRow("n5", 132, "Dosa"),
      bareCount("v5", 146, "2", "30.00", "60.00"),
      nameRow("n6", 160, "Pongal"),
      bareCount("v6", 174, "1", "28.00", "28.00")
    );
  const rowsOf = (page: OcrResult) => classifyRows(page).rows.map((entry) => entry.row);

  it("reads the count column and proves the roles arithmetically", () => {
    const result = reconstructWithoutHeader(rowsOf(barePage()), 200, options());
    expect(result.roleSource).toBe("arithmetic");
    expect(result.records.map((record) => [record.name, record.qty?.value, record.rate?.value, record.total?.value])).toEqual([
      ["Coffee", 1, 35, 35],
      ["Vada", 2, 25, 50],
      ["Tea", 3, 12, 36],
      ["Idli", 1, 24, 24],
      ["Dosa", 2, 30, 60],
      ["Pongal", 1, 28, 28],
    ]);
  });

  it("publishes those counts through parse(), and closes without a schema finding", () => {
    const parsed = parse(barePage());
    expect(parsed.items.map((item) => [item.name, item.qty, item.lineTotal])).toEqual([
      ["Coffee", 1, 3500],
      ["Vada", 2, 5000],
      ["Tea", 3, 3600],
      ["Idli", 1, 2400],
      ["Dosa", 2, 6000],
      ["Pongal", 1, 2800],
    ]);
    expect(parsed.items.map((item) => item.quantitySource)).toEqual(Array(6).fill("explicit"));
    // §4 declares `qty` strictly positive, so a published `0` would be a critical finding against the bill.
    const findings = validate(parsed, { criticalOcrConfidenceFloor: 0.5, warningOcrConfidenceFloor: 0.7, strictArithmetic: false });
    expect(findings.findings.filter((finding) => finding.code === "invalid_result_schema")).toEqual([]);
  });

  it("never publishes a printed `0` as a quantity", () => {
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      bareCount("v1", 34, "1", "35.00", "35.00"),
      nameRow("n2", 48, "Vada"),
      bareCount("v2", 62, "2", "25.00", "50.00"),
      nameRow("n3", 76, "Tea"),
      bareCount("v3", 90, "3", "12.00", "36.00"),
      nameRow("n4", 104, "Idli"),
      bareCount("v4", 118, "1", "24.00", "24.00"),
      nameRow("n5", 132, "Dosa"),
      bareCount("v5", 146, "2", "30.00", "60.00"),
      nameRow("n6", 160, "Free sample"),
      bareCount("v6", 174, "0", "28.00", "28.00")
    );
    const result = reconstructWithoutHeader(rowsOf(page), 200, options());
    expect(result.records.every((record) => (record.qty?.value ?? 1) > 0)).toBe(true);
    // The `0` row keeps the two printed numbers it does have and loses only the quantity, which is what the page
    // actually prints: a rate and an amount, no count. Publishing `qty 0` instead would violate §4's ranges.
    const zeroRow = result.records.find((record) => record.name === "Free sample");
    expect([zeroRow?.qty?.value ?? null, zeroRow?.rate?.value ?? null, zeroRow?.total?.value ?? null]).toEqual([null, 28, 28]);
    expect(parse(page).items.every((item) => item.qty === null || item.qty > 0)).toBe(true);
    const findings = validate(parse(page), { criticalOcrConfidenceFloor: 0.5, warningOcrConfidenceFloor: 0.7, strictArithmetic: false });
    expect(findings.findings.filter((finding) => finding.code === "invalid_result_schema")).toEqual([]);
  });

  it("does not treat a column of item codes as a quantity column", () => {
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      bareCount("v1", 34, "101", "35.00", "35.00"),
      nameRow("n2", 48, "Vada"),
      bareCount("v2", 62, "102", "25.00", "50.00"),
      nameRow("n3", 76, "Tea"),
      bareCount("v3", 90, "103", "12.00", "36.00"),
      nameRow("n4", 104, "Idli"),
      bareCount("v4", 118, "104", "24.00", "24.00"),
      nameRow("n5", 132, "Dosa"),
      bareCount("v5", 146, "105", "30.00", "60.00"),
      nameRow("n6", 160, "Pongal"),
      bareCount("v6", 174, "106", "28.00", "28.00")
    );
    // §5's own qualification test refuses the band: `101` is not a count, so the column never reaches the stage and
    // nothing is published on a page whose only "quantity" is an item code.
    const result = reconstructWithoutHeader(rowsOf(page), 200, options());
    expect(result.records.map((record) => record.qty?.value ?? null)).toEqual(result.records.map(() => null));
  });
});

describe("garbled and marker-only descriptions (Amendment G, name guards)", () => {
  it("keeps the garbled name exactly as OCR produced it", () => {
    const page = receipt(
      nameRow("n1", 20, "Po8 Masala"),
      valueRow("v1", 34, "2", "153.00", "306.00"),
      nameRow("n2", 48, "offee"),
      valueRow("v2", 62, "2", "35.00", "70.00"),
      nameRow("n3", 76, "Chappathi"),
      valueRow("v3", 90, "2.00", "24.00", "48.00")
    );
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.records.map((record) => record.name)).toEqual(["Po8 Masala", "offee", "Chappathi"]);
  });

  it("refuses a currency token or a reader tag as a name", () => {
    expect(isNameLike("Coffee")).toBe(true);
    expect(isNameLike("SR 6")).toBe(false);
    expect(isNameLike("[ACCOUNT] 1 X")).toBe(false);
    expect(isNameLike("2.00 35.00")).toBe(false);
  });
});

describe("furniture never becomes a description", () => {
  it("leaves a metadata line out of the item's name", () => {
    const page = receipt(
      nameRow("m1", 6, "Bill No: 210373"),
      valueRow("v1", 20, "2", "35.00", "70.00"),
      nameRow("n1", 34, "Coffee"),
      valueRow("v2", 48, "2.00", "25.00", "50.00"),
      nameRow("n2", 62, "Vada"),
      valueRow("v3", 76, "2", "24.00", "48.00"),
      nameRow("n3", 90, "Chappathi")
    );
    // Through `parse()`, so the classifier's own furniture predicates are the ones deciding (`0034`'s metadata
    // family), not a test-local stand-in.
    expect(parse(page).items.map((item) => item.name)).toEqual(["Coffee", "Vada", "Chappathi"]);
  });

  it("never calls a labelled charge row a product", () => {
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      valueRow("v1", 34, "2.00", "35.00", "70.00"),
      nameRow("n2", 48, "Vada"),
      valueRow("v2", 62, "2.00", "25.00", "50.00"),
      nameRow("n3", 76, "Chappathi"),
      valueRow("v3", 90, "2.00", "24.00", "48.00"),
      // A charge label sits between the numbers and the next name: it is never a product description.
      nameRow("t1", 104, "Total 120.00")
    );
    const result = reconstructWithoutHeader(
      classifyRows(page).rows.map((entry) => entry.row),
      200,
      options(undefined, (row) => /total/i.test(row.text))
    );
    expect(result.records.map((record) => record.name)).toEqual(["Coffee", "Vada", "Chappathi"]);
  });

  it("keeps a heading fragment above the header out of the first product", () => {
    const page = receipt(
      nameRow("h0", 2, "roduct"),
      nameRow("h1", 10, "Expire Qty Rate Total"),
      nameRow("n1", 20, "Coffee"),
      valueRow("v1", 34, "2.00", "35.00", "70.00"),
      nameRow("n2", 48, "Vada"),
      valueRow("v2", 62, "2.00", "25.00", "50.00"),
      nameRow("n3", 76, "Chappathi"),
      valueRow("v3", 90, "2.00", "24.00", "48.00")
    );
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, {
      ...options(),
      headerFloorIndex: 1,
      headerRowIndexes: new Set([1]),
    });
    expect(result.records.map((record) => record.name)).toEqual(["Coffee", "Vada", "Chappathi"]);
  });
});

describe("the magnitude gate (DECISIONS/0033's rule, applied by this stage too)", () => {
  /**
   * `0035`'s consolidation claim, given a test: an amount-shaped *identifier* is not money even when it lines up
   * with a money band. The page below prints two ordinary products and one row whose rate and total are an order
   * number — `1 210373.00 210373.00` agrees with itself arithmetically, so without the gate it would pair with the
   * description beside it and publish a ₹2,10,373.00 product. That is the Receipt-B bug in miniature.
   */
  it("refuses a printed identifier that sits in the rate and total bands", () => {
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      valueRow("v1", 34, "2.00", "35.00", "70.00"),
      nameRow("n2", 48, "Vada"),
      valueRow("v2", 62, "2.00", "25.00", "50.00"),
      nameRow("n3", 76, "Bill No"),
      valueRow("v3", 90, "1.00", "210373.00", "210373.00")
    );
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.records.map((record) => [record.name, record.total?.value])).toEqual([
      ["Coffee", 70],
      ["Vada", 50],
    ]);
    // The identifier row is not consumed by a record: it keeps its printed numbers and stays for review.
    expect(result.records.some((record) => record.total?.value === 210373)).toBe(false);
    expect(result.consumedRows.size).toBe(4);
  });

  it("does not refuse a large but real total on a page of small ones", () => {
    // The gate is 1000× the page median, so a ₹9,000 line on a page whose median amount is ₹35 is still money.
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      valueRow("v1", 34, "2.00", "35.00", "70.00"),
      nameRow("n2", 48, "Vada"),
      valueRow("v2", 62, "2.00", "25.00", "50.00"),
      nameRow("n3", 76, "Party Platter"),
      valueRow("v3", 90, "2.00", "4500.00", "9000.00")
    );
    const result = reconstructWithoutHeader(classifyRows(page).rows.map((entry) => entry.row), 200, options());
    expect(result.records.map((record) => [record.name, record.total?.value])).toEqual([
      ["Coffee", 70],
      ["Vada", 50],
      ["Party Platter", 9000],
    ]);
  });
});

describe("a receipt with one product and no header", () => {
  /**
   * `next.md` §6: one product, no table header. Two floors stand between this page and a published item, and both
   * are by design — `ANCHOR_MIN_COLUMN_MEMBERS` (a band needs three alignments before it is a column at all) and
   * `MIN_PAIRED_RECORDS` (two agreeing rows before the arithmetic proves the roles). Either way the stage falls
   * back to position and publishes **nothing**: the row keeps every printed number and stays for review.
   */
  const single = (qty: string, rate: string, total: string) =>
    receipt(nameRow("n1", 20, "Pineapple Lime"), valueRow("v1", 34, qty, rate, total));
  const rowsOf = (page: OcrResult) => classifyRows(page).rows.map((entry) => entry.row);

  it("reads no columns at all when one row is all the evidence there is", () => {
    const result = reconstructWithoutHeader(rowsOf(single("3.00", "25.00", "75.00")), 200, options());
    // Three alignments make a column; one row cannot, so there is no column set to even fall back on.
    expect(result.roles).toEqual([]);
    expect(result.roleSource).toBeNull();
    expect(result.records).toEqual([]);
    expect(result.unpaired).toEqual([]);
  });

  it("falls back to position when the arithmetic cannot decide, and still publishes nothing", () => {
    // Three rows align into bands (so the positional reading exists) but no row satisfies `qty × rate = total`.
    const page = receipt(
      nameRow("n1", 20, "Coffee"),
      valueRow("v1", 34, "2.00", "35.00", "99.00"),
      nameRow("n2", 48, "Vada"),
      valueRow("v2", 62, "3.00", "25.00", "99.00"),
      nameRow("n3", 76, "Chappathi"),
      valueRow("v3", 90, "4.00", "24.00", "99.00")
    );
    const result = reconstructWithoutHeader(rowsOf(page), 200, options());
    // Amendment C: the positional reading is reported (it is what the page's column order suggests)…
    expect(result.roleSource).toBe("positional");
    expect(result.roles.map((band) => band.role)).toEqual(["qty", "rate", "total"]);
    // …and it is not allowed to create products, because a guess about columns is not evidence about money.
    expect(result.records).toEqual([]);
    expect(result.consumedRows.size).toBe(0);
  });

  it("leaves the parsed bill unresolved rather than inventing a quantity or a price", () => {
    const parsed = parse(single("3.00", "25.00", "80.00"));
    expect(parsed.items).toEqual([]);
    // Nothing was repaired to make the row read: the printed numbers are still there, for review.
    expect(parsed.unclassifiedRows.map((row) => row.text)).toContain("3.00 25.00 80.00");
    expect(parsed.warnings.map((warning) => warning.code)).toContain("ambiguous_row");
  });
});
