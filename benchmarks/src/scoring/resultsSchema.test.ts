import { describe, expect, it } from "vitest";
import { resultsSchema } from "../benchmark.config.js";
import { emptyParseResult } from "./null-parser.js";
import { renderReport, scoreReceipts } from "./report.js";
import type { LabeledReceipt } from "../datasets/types.js";
import type { OcrResult } from "@receipt-lens/core";

// The results JSON is the artifact a published number travels in, so its shape is declared in
// `benchmark.config` and checked here rather than inferred from whatever the renderer emitted
// last. `toEqual` on `Object.keys` is order-sensitive, which pins key order too — the same
// property that makes two runs byte-identical.

const ocr = {
  lines: [{ id: "L0", text: "NASI GORENG 23.000", box: { x: 0, y: 0, width: 10, height: 10 }, confidence: null, words: [] }],
  imageSize: { width: 100, height: 200 },
  provider: "dataset-reference-ocr",
  version: "cord-v2@abc",
} satisfies OcrResult;

const receipt: LabeledReceipt = {
  receiptId: "cord-v2/dev/0",
  dataset: "cord-v2",
  split: "dev",
  ocr,
  gold: {
    grandTotal: 2300000,
    subtotal: 2300000,
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    taxTotal: null,
    items: [{ name: "Nasi Goreng", qty: 1, unitPrice: null, lineTotal: 2300000 }],
  },
  unreadableAnnotations: [],
};

const parsed = () => ({
  ...emptyParseResult(),
  grandTotal: 2300000,
  subtotal: 2300000,
  items: [
    {
      id: "i0",
      name: "Nasi Goreng",
      qty: 1,
      quantitySource: "explicit" as const,
      unitPrice: null,
      priceSource: "detected" as const,
      lineTotal: 2300000,
      confidence: null,
      sourceLineIds: [],
      warnings: [],
    },
  ],
});

function report() {
  return JSON.parse(
    renderReport([
      scoreReceipts(
        [receipt],
        {
          dataset: "cord-v2",
          fieldsLabeled: ["grandTotal", "subtotal", "item.name", "item.qty", "item.unitPrice", "item.lineTotal"],
          fieldsExcluded: ["tip", "roundOff", "serviceCharge", "discount", "taxTotal"],
          license: "CC-BY-4.0",
        },
        parsed
      )
    ])
  ) as {
    datasets: Record<string, unknown>[];
    protocol: Record<string, unknown>;
  };
}

function fieldsOf(rendered: ReturnType<typeof report>): Record<string, unknown>[] {
  return (rendered.datasets[0] as { fields: Record<string, unknown>[] }).fields;
}

describe("the results JSON schema", () => {
  it("declares the top-level keys, in order", () => {
    expect(Object.keys(report())).toEqual([...resultsSchema.top]);
  });

  it("declares the protocol block that carries the pins", () => {
    expect(Object.keys(report().protocol)).toEqual([...resultsSchema.protocol]);
  });

  it("declares the per-dataset block", () => {
    expect(Object.keys(report().datasets[0]!)).toEqual([...resultsSchema.dataset]);
  });

  it("declares the per-field block, on both tiers", () => {
    for (const field of fieldsOf(report())) {
      expect(Object.keys(field), String(field.field)).toEqual([...resultsSchema.field]);
    }
  });

  it("names the schema version inside the file it describes", () => {
    const rendered = report();

    expect(rendered.protocol.tauName).toBe(0.7);
    expect(rendered.protocol.nameSimilarityMetric).toBe("normalized-levenshtein");
    expect(fieldsOf(rendered).some((field) => field.tier === "item")).toBe(true);
  });
});
