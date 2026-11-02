import { describe, expect, it } from "vitest";
import { SROIE_LABELED_FIELDS, mapSroieReceipt, type SroieRow } from "./sroie.js";

// Seam S2: the SROIE loader. SROIE annotates company/date/address/total and no
// item-level fields, so it is a grand-total-only contract (DECISIONS/0002) and every
// other field must be declared excluded rather than silently null-scored.
//
// The row shapes below are transcribed from the pinned parquet's own structure:
// flat `words`, `[x1,y1,x2,y2]` per word, `entities.total` as a printed string.

const row: SroieRow = {
  words: ["193.00", "TOTAL:", "TAN", "CHAY", "YEE"],
  bboxes: [
    [300, 15, 340, 25],
    [200, 18, 290, 28],
    [10, 60, 60, 70],
    [70, 62, 120, 72],
    [130, 61, 180, 71],
  ],
  imageSize: { width: 463, height: 894 },
  entities: {
    company: "OJC MARKETING SDN BHD",
    date: "15/01/2019",
    address: "NO 2 & 4, JALAN BAYU 4",
    total: "193.00",
  },
};

const context = { receiptId: "sroie/dev/0", snapshotHash: "483632b50b77561e" };

describe("mapSroieReceipt", () => {
  it("reconstructs lines by vertical clustering and keeps left-to-right word order", () => {
    const receipt = mapSroieReceipt(row, context);

    expect(receipt.ocr.lines.map((line) => line.text)).toEqual(["TOTAL: 193.00", "TAN CHAY YEE"]);
  });

  it("unions word boxes into the line box", () => {
    const receipt = mapSroieReceipt(row, context);

    expect(receipt.ocr.lines[0]!.box).toEqual({ x: 200, y: 15, width: 140, height: 13 });
  });

  it("maps the annotated total onto grandTotal in integer minor units", () => {
    const receipt = mapSroieReceipt(row, context);

    expect(receipt.gold.grandTotal).toBe(19300);
  });

  it("declares everything it cannot score as excluded, not as zero", () => {
    const receipt = mapSroieReceipt(row, context);

    expect(SROIE_LABELED_FIELDS).toEqual(["grandTotal"]);
    expect(receipt.gold.items).toEqual([]);
    expect([
      receipt.gold.subtotal,
      receipt.gold.serviceCharge,
      receipt.gold.tip,
      receipt.gold.discount,
      receipt.gold.roundOff,
      receipt.gold.taxTotal,
    ]).toEqual([null, null, null, null, null, null]);
  });

  it("records no confidence anywhere, because SROIE supplies none to report", () => {
    const receipt = mapSroieReceipt(row, context);
    const confidences = receipt.ocr.lines.flatMap((line) => [
      line.confidence,
      ...line.words.map((word) => word.confidence),
    ]);

    expect([...new Set(confidences)]).toEqual([null]);
    expect(receipt.ocr.provider).toBe("dataset-reference-ocr");
    expect(receipt.ocr.version).toBe("sroie@483632b50b77561e");
    expect(receipt.ocr.imageSize).toEqual({ width: 463, height: 894 });
  });

  it("leaves grandTotal null rather than inventing it when the annotation is absent", () => {
    const receipt = mapSroieReceipt({ ...row, entities: { ...row.entities, total: undefined } }, context);

    expect(receipt.gold.grandTotal).toBe(null);
  });

  it("is stable: the same row twice produces the same receipt", () => {
    expect(mapSroieReceipt(row, context)).toEqual(mapSroieReceipt(row, context));
  });
});
