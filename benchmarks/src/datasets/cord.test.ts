import { describe, expect, it } from "vitest";
import { CORD_EXCLUDED_FIELDS, CORD_LABELED_FIELDS, mapCordReceipt, type CordRow } from "./cord.js";

// Seam S2: the CORD loader. The row shapes are transcribed from the pinned parquet's
// `ground_truth.valid_line` structure: words with a four-corner quad, a category like
// `menu.price`, and group ids that tie a name to its quantity and price.

function quad(x1: number, y1: number, x2: number, y2: number) {
  return { x1, y1, x2, y2, x3: x2, y3: y2, x4: x2, y4: y2 };
}

const context = { receiptId: "cord-v2/dev/0", snapshotHash: "6cb6555829a62eec" };

const singleItem: CordRow = {
  imageSize: { width: 1108, height: 1478 },
  validLine: [
    {
      category: "menu.nm",
      group_id: 23,
      sub_group_id: 0,
      words: [
        { text: "Kopi", quad: quad(182, 932, 244, 963), is_key: 0 },
        { text: "Susu", quad: quad(261, 925, 328, 965), is_key: 0 },
        { text: "Kolonel", quad: quad(338, 928, 449, 960), is_key: 0 },
      ],
    },
    { category: "menu.cnt", group_id: 23, sub_group_id: 0, words: [{ text: "1", quad: quad(491, 915, 520, 958), is_key: 0 }] },
    { category: "menu.price", group_id: 23, sub_group_id: 0, words: [{ text: "23.000", quad: quad(808, 921, 902, 956), is_key: 0 }] },
    {
      category: "total.total_price",
      group_id: 27,
      sub_group_id: 0,
      words: [
        { text: "Total", quad: quad(181, 1005, 259, 1036), is_key: 1 },
        { text: "23.000", quad: quad(811, 997, 903, 1031), is_key: 0 },
      ],
    },
    {
      category: "total.cashprice",
      group_id: 27,
      sub_group_id: 0,
      words: [
        { text: "Tunai", quad: quad(184, 1084, 259, 1114), is_key: 1 },
        { text: "50.000", quad: quad(805, 1078, 905, 1108), is_key: 0 },
      ],
    },
  ],
};

describe("mapCordReceipt", () => {
  it("reads a dotted id-ID amount into integer minor units", () => {
    const receipt = mapCordReceipt(singleItem, context);

    expect(receipt.gold.grandTotal).toBe(2300000);
  });

  it("ties name, quantity and line total together through the group id", () => {
    const receipt = mapCordReceipt(singleItem, context);

    expect(receipt.gold.items).toEqual([
      { name: "Kopi Susu Kolonel", qty: 1, unitPrice: null, lineTotal: 2300000 },
    ]);
  });

  it("keeps non-key label words in the line text the parser will see", () => {
    const receipt = mapCordReceipt(singleItem, context);

    expect(receipt.ocr.lines.map((line) => line.text)).toEqual([
      "Kopi Susu Kolonel",
      "1",
      "23.000",
      "Total 23.000",
      "Tunai 50.000",
    ]);
  });

  it("does not read a tender line as the grand total", () => {
    const receipt = mapCordReceipt(singleItem, context);

    expect(receipt.gold.grandTotal).toBe(2300000);
    expect(JSON.stringify(receipt.gold)).not.toContain("5000000");
  });

  it("sums multiple tax lines into one annotated tax total", () => {
    const withTaxes: CordRow = {
      imageSize: singleItem.imageSize,
      validLine: [
        ...singleItem.validLine,
        { category: "sub_total.tax_price", group_id: 25, sub_group_id: 0, words: [{ text: "2.000", quad: quad(800, 800, 900, 830), is_key: 0 }] },
        { category: "sub_total.tax_price", group_id: 25, sub_group_id: 1, words: [{ text: "1.500", quad: quad(800, 840, 900, 870), is_key: 0 }] },
      ],
    };

    expect(mapCordReceipt(withTaxes, context).gold.taxTotal).toBe(350000);
  });

  it("leaves a quantity it cannot read as an integer unresolved, not guessed", () => {
    const fractional: CordRow = {
      imageSize: singleItem.imageSize,
      validLine: [
        { category: "menu.nm", group_id: 1, sub_group_id: 0, words: [{ text: "Es Teh", quad: quad(0, 0, 40, 20), is_key: 0 }] },
        { category: "menu.cnt", group_id: 1, sub_group_id: 0, words: [{ text: "1/2", quad: quad(50, 0, 70, 20), is_key: 0 }] },
      ],
    };

    const receipt = mapCordReceipt(fractional, context);
    expect(receipt.gold.items[0]!.qty).toBe(null);
    expect(receipt.unreadableAnnotations).toEqual([{ category: "menu.cnt", text: "1/2" }]);
  });

  it("records a scalar line annotated with label text only, rather than parsing the label", () => {
    // A real CORD shape: the discount line carries "Discount(0%)" and no value word.
    const labelOnly: CordRow = {
      imageSize: singleItem.imageSize,
      validLine: [
        ...singleItem.validLine,
        {
          category: "sub_total.discount_price",
          group_id: 26,
          sub_group_id: 0,
          words: [{ text: "Discount(0%)", quad: quad(100, 100, 200, 120), is_key: 1 }],
        },
      ],
    };

    const receipt = mapCordReceipt(labelOnly, context);
    expect(receipt.gold.discount).toBe(null);
    expect(receipt.unreadableAnnotations).toEqual([
      { category: "sub_total.discount_price", text: "Discount(0%)" },
    ]);
  });

  it("declares the fields CORD does not annotate as excluded, including round-off", () => {
    const receipt = mapCordReceipt(singleItem, context);

    expect(CORD_LABELED_FIELDS).toContain("item.name");
    expect(CORD_EXCLUDED_FIELDS).toEqual(["tip", "roundOff"]);
    expect(receipt.gold.roundOff).toBe(null);
    expect(receipt.gold.tip).toBe(null);
  });

  it("is stable: the same row twice produces the same receipt", () => {
    expect(mapCordReceipt(singleItem, context)).toEqual(mapCordReceipt(singleItem, context));
  });
});
