import { describe, expect, it } from "vitest";
import {
  assertSplitsDisjoint,
  serializeFixtureFile,
  serializeReceiptFile,
  tallyRedactions,
  type FixtureFile,
} from "./serialize.js";
import type { LabeledReceipt } from "../datasets/types.js";
import type { Redaction } from "./redact.js";

// Seam S3: fixture serialization. The byte-identical regeneration check only means
// anything if the writer is a pure function of its input, so these tests are about key
// order, whitespace, and the absence of anything that varies between runs.

const receipt = {
  receiptId: "sroie/dev/0",
  dataset: "sroie",
  split: "dev",
  ocr: {
    lines: [
      {
        id: "L0",
        text: "TOTAL: [ACCOUNT]",
        box: { x: 1, y: 2, width: 3, height: 4 },
        confidence: null,
        words: [{ text: "TOTAL:", box: { x: 1, y: 2, width: 2, height: 2 }, confidence: null }],
      },
    ],
    imageSize: { width: 10, height: 20 },
    provider: "dataset-reference-ocr",
    version: "sroie@abc",
  },
  gold: {
    grandTotal: 19300,
    subtotal: null,
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    taxTotal: null,
    items: [],
  },
  unreadableAnnotations: [{ category: "menu.cnt", text: "1/2" }],
} satisfies LabeledReceipt;

const redaction: Redaction = {
  class: "NAME",
  line: 0,
  word: 1,
  before: "LOCAL@DOMAIN.COM",
  after: "[EMAIL]",
};

const file: FixtureFile = {
  provenance: {
    dataset: "sroie",
    split: "dev",
    sourceSplit: "train",
    snapshotHash: "abc",
    source: "https://example.invalid/sroie",
    license: "CC-BY-4.0 as declared by the mirror",
    fieldsLabeled: ["grandTotal"],
    fieldsExcluded: ["subtotal"],
    exclusionReason: "no item-level annotation exists",
    referenceOcrSource: "dataset annotation",
    receipts: 1,
  },
  receipts: [receipt],
  redactionCounts: { NAME: 0, EMAIL: 2 },
  unmatchedEntities: [{ class: "ADDRESS", text: "NO 2 & 4" }],
};

describe("serializeReceiptFile", () => {
  it("produces the same bytes twice for the same input", () => {
    expect(serializeReceiptFile(receipt, [redaction])).toBe(serializeReceiptFile(receipt, [redaction]));
  });

  it("writes the same bytes whatever order the object's keys arrived in", () => {
    const rebuilt = {
      gold: receipt.gold,
      ocr: receipt.ocr,
      split: receipt.split,
      dataset: receipt.dataset,
      receiptId: receipt.receiptId,
      unreadableAnnotations: receipt.unreadableAnnotations,
    } as LabeledReceipt;

    expect(serializeReceiptFile(rebuilt, [redaction])).toBe(serializeReceiptFile(receipt, [redaction]));
  });

  it("carries no run timestamp, because a dated fixture is not reproducible", () => {
    const text = serializeReceiptFile(receipt, [redaction]);

    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("keeps the gold annotation exactly as mapped", () => {
    const parsed = JSON.parse(serializeReceiptFile(receipt, []));

    expect(parsed.gold).toEqual(receipt.gold);
    expect(parsed.ocr.lines[0].words[0].box).toEqual({ x: 1, y: 2, width: 2, height: 2 });
  });
});

describe("serializeFixtureFile", () => {
  it("is the provenance header: snapshot, license, coverage, and the redaction tally", () => {
    const text = serializeFixtureFile(file);
    const parsed = JSON.parse(text);

    expect(parsed.provenance.snapshotHash).toBe("abc");
    expect(parsed.provenance.fieldsLabeled).toEqual(["grandTotal"]);
    expect(parsed.redactionCounts).toEqual({ EMAIL: 2 });
  });

  it("describes an unmatched entity without committing its text", () => {
    const parsed = JSON.parse(serializeFixtureFile(file));

    expect(serializeFixtureFile(file)).not.toContain("NO 2 & 4");
    expect(parsed.unmatchedEntities).toHaveLength(1);
    expect(parsed.unmatchedEntities[0].class).toBe("ADDRESS");
    expect(parsed.unmatchedEntities[0].textLength).toBe(8);
    expect(parsed.unmatchedEntities[0].words).toBe(4);
    expect(parsed.unmatchedEntities[0].digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it("drops zero-count classes instead of listing every class on every receipt", () => {
    expect(JSON.parse(serializeFixtureFile(file)).redactionCounts).not.toHaveProperty("NAME");
  });

  it("keeps the redaction log from re-committing the text it removed", () => {
    const text = serializeReceiptFile(receipt, [redaction]);

    expect(text).not.toContain("LOCAL@DOMAIN.COM");
    expect(JSON.parse(text).redactions[0]).toEqual({
      class: "NAME",
      line: 0,
      word: 1,
      beforeLength: 16,
      after: "[EMAIL]",
    });
  });

  it("is stable", () => {
    expect(serializeFixtureFile(file)).toBe(serializeFixtureFile(file));
  });
});

describe("tallyRedactions", () => {
  it("counts per class so the audit can state volumes", () => {
    expect(
      tallyRedactions([
        redaction,
        { ...redaction, class: "PHONE" },
        { ...redaction, class: "EMAIL" },
      ])
    ).toEqual({ NAME: 1, PHONE: 1, EMAIL: 1 });
  });
});

describe("assertSplitsDisjoint", () => {
  it("rejects a receipt id that appears in both dev and eval", () => {
    expect(() =>
      assertSplitsDisjoint(["sroie/dev/0", "sroie/dev/1"], ["sroie/eval/0", "sroie/dev/1"])
    ).toThrowError(/dev\/eval overlap/);
  });

  it("accepts two genuinely separate splits", () => {
    expect(() => assertSplitsDisjoint(["sroie/dev/0"], ["sroie/eval/0"])).not.toThrow();
  });
});
