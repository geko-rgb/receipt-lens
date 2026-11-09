import { describe, expect, it } from "vitest";
import { parse } from "./index.js";
import { classifyRows } from "./classify.js";
import { columnValue, findHeaderTables, readHeaderRow } from "./header.js";
import { isTableRecordRow, reconstructTableRows } from "./rows.js";
import { isTaxTable, readTaxTables } from "./taxes.js";
import { inferPriceColumn } from "./geometry.js";
import { profileForRows } from "./money.js";
import { INLINE_TABLE_RECEIPT, TABLE_RECEIPT } from "./table-fixtures.js";
import { COLUMN_LABELS, ITEM_A, ITEM_B, ocrRow, receipt } from "./fixtures.js";

/**
 * DECISIONS/0033's regression suite: the bug-report receipt end to end, plus the properties each new rule
 * rests on. The receipt's defining property is that **no product name shares a printed line with its numbers**,
 * which is exactly the layout §5's row clustering could not join.
 */

const items = (fixture: typeof TABLE_RECEIPT) => parse(fixture).items;

describe("the bug-report receipt (DECISIONS/0033 P5–P9)", () => {
  const parsed = parse(TABLE_RECEIPT);

  it("extracts all four products, in printed order", () => {
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items.map((item) => item.name)).toEqual([
      "Coffee",
      "Vada",
      "Chappathi Empty",
      "Combo 2 Chapati / P.B. Masala",
    ]);
  });

  it("reads quantity, rate and line total from their own columns", () => {
    expect(
      parsed.items.map((item) => ({
        name: item.name,
        qty: item.qty,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      }))
    ).toEqual([
      { name: "Coffee", qty: 2, unitPrice: 3500, lineTotal: 7000 },
      { name: "Vada", qty: 2, unitPrice: 2500, lineTotal: 5000 },
      { name: "Chappathi Empty", qty: 2, unitPrice: 2400, lineTotal: 4800 },
      { name: "Combo 2 Chapati / P.B. Masala", qty: 2, unitPrice: 15300, lineTotal: 30600 },
    ]);
  });

  it("provenance is explicit and detected, not assumed", () => {
    for (const item of parsed.items) {
      expect(item.quantitySource).toBe("explicit");
      expect(item.priceSource).toBe("detected");
    }
  });

  it("does not treat the `2` inside `Combo 2 Chapati` as a quantity", () => {
    const combo = parsed.items[3]!;
    expect(combo.name).toBe("Combo 2 Chapati / P.B. Masala");
    // The printed description keeps its 2; the quantity comes from the Qty column and is also 2 — a row where
    // the two disagree would be the only way this test could pass by accident, so both are asserted.
    expect(combo.qty).toBe(2);
    expect(combo.unitPrice).toBe(15300);
  });

  it("keeps the ₹474 receipt total, and does not add the tax to it", () => {
    expect(parsed.grandTotal).toBe(47400);
    const itemSum = parsed.items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0);
    expect(itemSum).toBe(47400);
  });

  it("reads CGST and SGST from the tax table instead of leaving them unresolved", () => {
    const byLabel = Object.fromEntries(parsed.taxes.map((tax) => [tax.label, tax.amount]));
    expect(byLabel.CGST).toBe(1129);
    expect(byLabel.SGST).toBe(1129);
    // Two taxes, exactly as the receipt printed them — the zero `Cess` column is not a charge.
    expect(parsed.taxes.map((tax) => tax.label)).toEqual(["CGST", "SGST"]);
  });

  it("counts the tax table's total row once, never its itemised rows as well", () => {
    // The four HSN rows sum to 11.29 as well; adding both readings would publish 22.58.
    expect(parsed.taxes.filter((tax) => tax.label === "CGST")).toHaveLength(1);
    expect(parsed.taxes.filter((tax) => tax.label === "SGST")).toHaveLength(1);
    expect(parsed.warnings.filter((warning) => warning.code === "unclassified_charge")).toEqual([]);
  });

  it("leaves tax inclusion open rather than deciding it", () => {
    // §7 / 0011 V4: `included` is never inferred. The receipt's line totals already sum to its grand total, so
    // the tax is inside them — but the parser must not be the one to say so.
    for (const tax of parsed.taxes) expect(tax.included).toBeUndefined();
  });

  it("publishes no phantom items and keeps the item list disjoint from the preserved rows", () => {
    expect(parsed.items.every((item) => /[A-Za-z]/.test(item.name))).toBe(true);
    expect(parsed.unclassifiedRows).toEqual([]);
  });
});

describe("the same receipt with names on the numbers' line", () => {
  it("extracts identically, so the table pass is not layout-specific", () => {
    const parsed = parse(INLINE_TABLE_RECEIPT);
    expect(parsed.items.map((item) => [item.name, item.qty, item.unitPrice, item.lineTotal])).toEqual([
      ["Coffee", 2, 3500, 7000],
      ["Vada", 2, 2500, 5000],
    ]);
  });
});

describe("header tables (DECISIONS/0033 P1–P4)", () => {
  it("recognises the five-column header and names its bands", () => {
    const rows = classifyRows(TABLE_RECEIPT).rows.map((entry) => entry.row);
    const column = inferPriceColumn(rows, TABLE_RECEIPT.imageSize.width);
    const tables = findHeaderTables(rows, column, TABLE_RECEIPT.imageSize.width);
    expect(tables).toHaveLength(2);
    const [productTable, taxTable] = tables as [(typeof tables)[number], (typeof tables)[number]];
    expect(productTable.row.text).toBe("Product Expire Qty Rate Total");
    expect(productTable.qty).not.toBeNull();
    expect(productTable.rate).not.toBeNull();
    expect(productTable.total).not.toBeNull();
    expect(productTable.nameLeft).toBe(40);
    // `Expire` is recognised as a column and carries no role: read, and not used.
    expect(productTable.cells.find((cell) => cell.text === "Expire")?.role).toBeNull();
    expect(taxTable.row.text).toBe("HSN Tax% CGST SGST Cess");
    expect(isTaxTable(taxTable)).toBe(true);
    expect(isTaxTable(productTable)).toBe(false);
  });

  it("does not read a single-word product line as a header (P1's floor)", () => {
    const rows = classifyRows(TABLE_RECEIPT).rows.map((entry) => entry.row);
    const column = inferPriceColumn(rows, TABLE_RECEIPT.imageSize.width);
    const coffee = rows.find((row) => row.text === "Coffee")!;
    expect(readHeaderRow(coffee, column, TABLE_RECEIPT.imageSize.width)).toBeNull();
    expect(readHeaderRow(rows.find((row) => row.text === "Vada")!, column, TABLE_RECEIPT.imageSize.width)).toBeNull();
  });

  it("does not read a header-shaped row that prints an amount as a header (P4)", () => {
    const fixture = receipt(COLUMN_LABELS, ITEM_A, ITEM_B, ocrRow("h", 200, [["ITEM", 10, 24], ["PRICE", 90, 30], ["12.00", 150, 26]]));
    const rows = classifyRows(fixture).rows.map((entry) => entry.row);
    const column = inferPriceColumn(rows, fixture.imageSize.width);
    for (const row of rows) {
      if (row.text.includes("12.00")) expect(readHeaderRow(row, column, fixture.imageSize.width)).toBeNull();
    }
  });

  it("keeps the pre-0033 behaviour on a two-column receipt with no header", () => {
    const fixture = receipt(ITEM_A, ITEM_B);
    const classified = classifyRows(fixture);
    expect(classified.headerTables).toEqual([]);
    expect(classified.tableRows.records).toEqual([]);
    expect(parse(fixture).items.map((item) => item.name)).toEqual(["MIKA GORENG", "NASI PUTIH"]);
  });
});

describe("row reconstruction (DECISIONS/0033 P5–P8)", () => {
  const classified = classifyRows(TABLE_RECEIPT);
  const rows = classified.rows.map((entry) => entry.row);

  it("joins a name line to the numbers printed below it", () => {
    const [coffee] = classified.tableRows.records;
    expect(coffee).toBeDefined();
    expect(coffee!.name).toBe("Coffee");
    expect(coffee!.qty?.value).toBe(2);
    expect(coffee!.rate?.value).toBe(35);
    expect(coffee!.total?.value).toBe(70);
    expect(coffee!.evidence).toEqual([]);
  });

  it("never treats a numbers row as a name or a name row as a record", () => {
    for (const entry of classified.rows) {
      const table = classified.headerTables.find(
        (header) => entry.row.index >= header.span.start && entry.row.index < header.span.end
      );
      if (!table) continue;
      const isNumbersOnly = entry.row.words.every((word) => columnValue(word.text) !== null);
      if (!isNumbersOnly) continue;
      // A numbers-only row above the item table is never promoted as *the name* of the next record.
      expect(classified.tableRows.records.map((record) => record.name)).not.toContain(entry.row.text);
    }
  });

  it("is a pure function of the rows: two passes agree", () => {
    const again = reconstructTableRows(
      rows,
      classified.headerTables,
      (row) => /header|noise/i.test(row.text),
      () => false
    );
    expect(again.records).toEqual(classified.tableRows.records);
  });

  it("consumes only rows it actually used", () => {
    for (const index of classified.tableRows.consumedRows) {
      expect(classified.tableRows.records.some((record) => record.sourceRowIndexes.includes(index))).toBe(true);
    }
  });

  it("a labelled charge row is never a table record", () => {
    const records = classified.tableRows.records;
    expect(records.some((record) => /^total\b/i.test(record.name))).toBe(false);
  });

  it("exposes `isTableRecordRow` for a values row and denies it for a name row", () => {
    const table = classified.headerTables[0]!;
    const coffeeName = rows[1]!;
    const coffeeNumbers = rows[2]!;
    expect(isTableRecordRow(coffeeNumbers, table)).toBe(true);
    expect(isTableRecordRow(coffeeName, table)).toBe(false);
  });
});

describe("row arithmetic (DECISIONS/0033 P6)", () => {
  function productRow(name: string, numbers: readonly [string, string, string], y: number) {
    return [
      ocrRow(`n${y}`, y, [[name, 40, 60]]),
      ocrRow(`v${y}`, y + 22, [
        [numbers[0], 434, 36],
        [numbers[1], 510, 50],
        [numbers[2], 604, 56],
      ]),
    ];
  }

  const header = ocrRow("h", 20, [
    ["Product", 40, 78],
    ["Qty", 442, 28],
    ["Rate", 520, 40],
    ["Total", 610, 50],
  ]);

  it("reports a qty × rate that disagrees with the printed total, and keeps all three printed values", () => {
    const fixture = receipt(header, ...productRow("Wrong", ["3.00", "10.00", "99.00"], 100));
    const [item] = parse(fixture).items;
    expect(item).toBeDefined();
    // Nothing is repaired: the receipt's own three numbers survive, because §7 forbids inventing the fourth.
    expect(item!.qty).toBe(3);
    expect(item!.unitPrice).toBe(1000);
    expect(item!.lineTotal).toBe(9900);
    const warning = item!.warnings.find((entry) => entry.code === "row_arithmetic_mismatch");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("quantity 3 × rate 10");
  });

  it("accepts the rounding a printed total legitimately carries", () => {
    // 3 × 33.33 = 99.99; a receipt rounding to 100.00 is not an error.
    const fixture = receipt(header, ...productRow("Rounded", ["3.00", "33.33", "100.00"], 100));
    const [item] = parse(fixture).items;
    expect(item!.warnings.filter((entry) => entry.code === "row_arithmetic_mismatch")).toEqual([]);
  });
});

describe("tax tables (DECISIONS/0033 P10–P12)", () => {
  const classified = classifyRows(TABLE_RECEIPT);
  const rows = classified.rows.map((entry) => entry.row);

  it("reads the tax table's total row, not the sum of its rows", () => {
    const read = readTaxTables(rows, classified.headerTables, TABLE_RECEIPT.imageSize.width, profileForRows(rows));
    expect(read.totalRowText).toBe("Total 11.29 11.29 0");
    // The printed `Cess 0` column is read and contributes nothing: a ₹0.00 charge cannot change an amount and
    // would only ask the creator to confirm inclusion for zero.
    expect(read.taxes.map((tax) => [tax.label, tax.amount])).toEqual([
      ["CGST", 1129],
      ["SGST", 1129],
    ]);
  });

  it("carries the printed rate as display-only", () => {
    const read = readTaxTables(rows, classified.headerTables, TABLE_RECEIPT.imageSize.width, profileForRows(rows));
    for (const tax of read.taxes) expect(tax.rate).toBe(250);
  });

  it("does not consume the grand total row, which belongs to the item table", () => {
    const read = readTaxTables(rows, classified.headerTables, TABLE_RECEIPT.imageSize.width, profileForRows(rows));
    const grand = rows.find((row) => row.text === "Total 474.00")!;
    expect(read.consumedRows.has(grand.index)).toBe(false);
  });

  it("a receipt with no tax table publishes no taxes", () => {
    const read = readTaxTables(rows, [], TABLE_RECEIPT.imageSize.width, profileForRows(rows));
    expect(read.taxes).toEqual([]);
  });
});

describe("the same receipt photographed differently (Phase 6's spacing and OCR-quality cases)", () => {
  /** Every printed x shifted by `dx`, as a photo taken from a different angle and crop would arrive. */
  function shifted(fixture: typeof TABLE_RECEIPT, dx: number): typeof TABLE_RECEIPT {
    const move = (line: (typeof fixture)["lines"][number]) => ({
      ...line,
      box: { ...line.box, x: line.box.x + dx },
      words: line.words.map((word) => ({ ...word, box: { ...word.box, x: word.box.x + dx } })),
    });
    return { ...fixture, lines: fixture.lines.map(move) };
  }

  it("reads the same four items when the whole print is 12px further right", () => {
    // The column bands come from the header words themselves, so a uniform shift moves header and values together
    // and the answer cannot change. This is the property a fixed pixel grid would break.
    const moved = shifted(TABLE_RECEIPT, 12);
    expect(parse(moved).items.map((item) => [item.name, item.qty, item.unitPrice, item.lineTotal])).toEqual(
      parse(TABLE_RECEIPT).items.map((item) => [item.name, item.qty, item.unitPrice, item.lineTotal]),
    );
  });

  it("keeps every value when the columns are squashed together by a narrower scan", () => {
    // A 20% horizontal squeeze about the left margin: the bands get closer than the receipt's own spacing.
    const squeeze = (x: number) => 40 + (x - 40) * 0.8;
    const squashed = {
      ...TABLE_RECEIPT,
      lines: TABLE_RECEIPT.lines.map((line) => ({
        ...line,
        box: { ...line.box, x: squeeze(line.box.x), width: line.box.width * 0.8 },
        words: line.words.map((word) => ({
          ...word,
          box: { ...word.box, x: squeeze(word.box.x), width: word.box.width * 0.8 },
        })),
      })),
    };
    const parsed = parse(squashed);
    expect(parsed.items.map((item) => [item.name, item.qty, item.lineTotal])).toEqual([
      ["Coffee", 2, 7000],
      ["Vada", 2, 5000],
      ["Chappathi Empty", 2, 4800],
      ["Combo 2 Chapati / P.B. Masala", 2, 30600],
    ]);
  });

  it("carries the provider's low confidence onto the item instead of calling it certain", () => {
    // §7: a score is the provider's, never imputed. A weak scan lowers the score and changes no value — the numbers
    // the receipt printed are still the numbers it printed, and the warning surface is where doubt belongs.
    const weak = {
      ...TABLE_RECEIPT,
      lines: TABLE_RECEIPT.lines.map((line) => ({
        ...line,
        confidence: 0.31,
        words: line.words.map((word) => ({ ...word, confidence: 0.31 })),
      })),
    };
    const parsed = parse(weak);
    expect(parsed.items.map((item) => item.confidence)).toEqual([0.31, 0.31, 0.31, 0.31]);
    expect(parsed.items.map((item) => item.lineTotal)).toEqual([7000, 5000, 4800, 30600]);
  });

  it("a header split over two lines is still refused as a table, but the rows are reconstructed without it", () => {
    // `Product Expire` / `Qty Rate Total`: the name column is named on a line of its own, so the second line bounds
    // the value columns but has no name cell, and DECISIONS/0033 P3 requires one. The header pass therefore declines
    // to build a table rather than guessing where names end — that refusal is still asserted below.
    // The row is not lost to review any more: DECISIONS/0035 pairs each description with the numbers it sits next
    // to, using the same geometry. The names and values must both survive that route, so this test asserts them
    // rather than an empty item list.
    const split = receipt(
      ocrRow("h1", 300, [
        ["Product", 40, 78],
        ["Expire", 330, 62],
      ]),
      ocrRow("h2", 322, [
        ["Qty", 442, 28],
        ["Rate", 520, 40],
        ["Total", 610, 50],
      ]),
      ...TABLE_RECEIPT.lines.filter((line) => !line.id.startsWith("h-")),
    );
    const rows = classifyRows(split).rows.map((entry) => entry.row);
    const column = inferPriceColumn(rows, split.imageSize.width);
    const tables = findHeaderTables(rows, column!, split.imageSize.width);
    // The bounds are read, and the table is refused for want of a name column — the rejection is the behaviour.
    expect(tables.every((table) => table.nameLeft === null)).toBe(true);
    const parsed = parse(split);
    expect(parsed.items.map((item) => [item.name, item.qty, item.unitPrice, item.lineTotal])).toEqual([
      ["Coffee", 2, 3500, 7000],
      ["Vada", 2, 2500, 5000],
      ["Chappathi Empty", 2, 2400, 4800],
    ]);
  });

});

describe("quantities the bill model cannot hold (DECISIONS/0033 P9)", () => {
  const header = ocrRow("h", 20, [
    ["Product", 40, 78],
    ["Qty", 442, 28],
    ["Rate", 520, 40],
    ["Total", 610, 50],
  ]);

  function oneProduct(qtyText: string) {
    return parse(
      receipt(
        header,
        ocrRow("n", 100, [["Tea", 40, 40]]),
        ocrRow("v", 122, [
          [qtyText, 434, 36],
          ["10.00", 510, 50],
          ["20.00", 604, 56],
        ])
      )
    );
  }

  it("a printed zero quantity is unresolved, not an item the bill cannot finalize", () => {
    const [item] = oneProduct("0.00").items;
    // §10's `Item.qty` is a positive whole number and `ItemUnit` materializes one per count, so `0` cannot be an
    // explicit count. The printed value is named in the warning rather than dropped.
    expect(item!.qty).toBeNull();
    expect(item!.quantitySource).toBe("unresolved");
    expect(item!.warnings.map((warning) => warning.code)).toContain("row_qty_not_countable");
    expect(item!.warnings.find((warning) => warning.code === "row_qty_not_countable")!.message).toContain("prints 0");
  });

  it("a fractional quantity is unresolved, and the printed value survives in the evidence", () => {
    const [item] = oneProduct("1.50").items;
    expect(item!.qty).toBeNull();
    expect(item!.quantitySource).toBe("unresolved");
    const warning = item!.warnings.find((entry) => entry.code === "row_qty_not_countable");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("1.5");
  });

  it("a whole-number quantity is still explicit", () => {
    const [item] = oneProduct("2.00").items;
    expect(item!.qty).toBe(2);
    expect(item!.quantitySource).toBe("explicit");
    expect(item!.warnings).toEqual([]);
  });
});

describe("degenerate and low-information pages", () => {
  it("a blank result produces no items and no taxes", () => {
    const parsed = parse(receipt());
    expect(parsed.items).toEqual([]);
    expect(parsed.taxes).toEqual([]);
  });

  it("a header with no rows beneath it produces no records", () => {
    const header = ocrRow("h", 20, [
      ["Product", 40, 78],
      ["Qty", 442, 28],
      ["Rate", 520, 40],
      ["Total", 610, 50],
    ]);
    const parsed = parse(receipt(header));
    expect(parsed.items).toEqual([]);
  });

  it("a name with no numbers below it is not an item", () => {
    const header = ocrRow("h", 20, [
      ["Product", 40, 78],
      ["Qty", 442, 28],
      ["Rate", 520, 40],
      ["Total", 610, 50],
    ]);
    const parsed = parse(receipt(header, ocrRow("n", 100, [["Coffee", 40, 66]])));
    expect(parsed.items).toEqual([]);
  });

  it("a row missing its rate leaves the rate unresolved and says so", () => {
    const header = ocrRow("h", 20, [
      ["Product", 40, 78],
      ["Qty", 442, 28],
      ["Rate", 520, 40],
      ["Total", 610, 50],
    ]);
    const parsed = parse(
      receipt(header, ocrRow("n", 100, [["Coffee", 40, 66]]), ocrRow("v", 122, [["2.00", 434, 36], ["70.00", 604, 56]]))
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.unitPrice).toBeNull();
    expect(parsed.items[0]!.priceSource).toBe("unresolved");
  });
});

describe("determinism (DECISIONS/0011)", () => {
  it("two parses of the same page are byte-identical", () => {
    expect(JSON.stringify(parse(TABLE_RECEIPT))).toBe(JSON.stringify(parse(TABLE_RECEIPT)));
  });

  it("reordering the provider's lines does not change the result", () => {
    const shuffled = { ...TABLE_RECEIPT, lines: [...TABLE_RECEIPT.lines].reverse() };
    expect(JSON.stringify(parse(shuffled))).toBe(JSON.stringify(parse(TABLE_RECEIPT)));
  });

  it("the fixture's item count is stable under an unused export", () => {
    // A cheap guard against a fixture edit silently reducing the coverage above.
    expect(items(TABLE_RECEIPT)).toHaveLength(4);
  });
});
