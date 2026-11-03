import { describe, expect, it } from "vitest";
import type { OcrResult } from "../ocr/types.js";
import { classifyRows } from "./classify.js";
import { parse } from "./index.js";
import { COLUMN_LABELS, FULL_RECEIPT, ITEM_A, ITEM_B, MISALIGNED_ROW, ocrRow, receipt, SHOUTY_ROW } from "./fixtures.js";

/**
 * The checkpoint is byte-for-byte identity across runs on the same fixture. Everything that could
 * make this drift — object key order, map iteration order, floating-point accumulation, wall clock,
 * randomness — is asserted against rather than assumed away.
 */

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

/** Key-sorted serialization, so identity is not proven by insertion order happening to match. */
function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`)
    .join(",")}}`;
}

/** Source line ids name the provider's lines, so they follow the fixture's own ids, not the parser. */
function withoutLineIds(value: ReturnType<typeof parse>) {
  return JSON.parse(canonical(value).replace(/"(sourceLineIds|id)":\[[^\]]*\]/g, '"refs":[]')) as unknown;
}

function relabelled(ocrResult: OcrResult, idFor: (lineId: string) => string): OcrResult {
  return {
    ...ocrResult,
    lines: ocrResult.lines.map((line) => ({ ...line, id: idFor(line.id) })),
  };
}

describe("byte-identical determinism", () => {
  it("two runs on the same fixture produce identical bytes", () => {
    const first = parse(FULL_RECEIPT);
    const second = parse(FULL_RECEIPT);
    expect(canonical(second)).toBe(canonical(first));
    expect(sortedJson(second)).toBe(sortedJson(first));
  });

  it("holds across twenty parses and on a freshly cloned input each time", () => {
    const baseline = canonical(parse(FULL_RECEIPT));
    for (let run = 0; run < 20; run += 1) {
      const clone = JSON.parse(canonical(FULL_RECEIPT)) as OcrResult;
      expect(canonical(parse(clone))).toBe(baseline);
    }
  });

  it("is independent of the order words and lines arrive in", () => {
    const shuffled: OcrResult = {
      ...FULL_RECEIPT,
      lines: [...FULL_RECEIPT.lines]
        .reverse()
        .map((line) => ({ ...line, words: [...line.words].reverse() })),
    };
    expect(canonical(parse(shuffled))).toBe(canonical(parse(FULL_RECEIPT)));
  });

  it("is independent of how the provider grouped the same words into lines", () => {
    const clustered = classifyRows(FULL_RECEIPT).rows;
    // Same words and geometry, re-cut into provider lines one word per line.
    const exploded: OcrResult = {
      ...FULL_RECEIPT,
      lines: clustered.flatMap((entry, rowIndex) =>
        entry.row.words.map((word, wordIndex) => ({
          id: `${entry.row.sourceLineIds[0]}-${wordIndex}`,
          text: word.text,
          box: word.box,
          confidence: word.confidence,
          words: [word],
          rowIndex,
        }))
      ),
    };
    const fromExploded = parse(exploded);
    expect(fromExploded.items.map((item) => item.name)).toEqual(parse(FULL_RECEIPT).items.map((item) => item.name));
    expect(fromExploded.unclassifiedRows.map((row) => row.text)).toEqual(parse(FULL_RECEIPT).unclassifiedRows.map((row) => row.text));
    expect(withoutLineIds(fromExploded)).toEqual(withoutLineIds(parse(FULL_RECEIPT)));
  });

  it("does not mutate the input or share nested references with it", () => {
    const input = JSON.parse(canonical(FULL_RECEIPT)) as OcrResult;
    const before = canonical(input);
    const parsed = parse(input);
    expect(canonical(input)).toBe(before);

    const inputBoxes = input.lines.flatMap((line) => [line.box, ...line.words.map((word) => word.box)]);
    const outputBoxes = [
      ...parsed.unclassifiedRows.map((row) => row.box),
      ...parsed.warnings.map((warning) => warning.sourceBox),
    ].filter((box): box is NonNullable<typeof box> => box !== undefined);
    expect(outputBoxes.length).toBeGreaterThan(0);
    for (const box of outputBoxes) expect(inputBoxes.includes(box)).toBe(false);

    const inputLineIds = input.lines.map((line) => line.id);
    for (const item of parsed.items) expect(item.sourceLineIds.every((id) => inputLineIds.includes(id))).toBe(true);
  });

  it("derives every id from position, never from wall clock or randomness", () => {
    const parsed = parse(FULL_RECEIPT);
    expect(parsed.items.map((item) => item.id)).toEqual(["i1", "i2"]);
    expect(parsed.unclassifiedRows.map((row) => row.id)).toEqual(["u1"]);
    const renamed = parse(relabelled(FULL_RECEIPT, (lineId) => `z-${lineId}`));
    expect(renamed.items.map((item) => item.id)).toEqual(["i1", "i2"]);
    expect(renamed.items[0]!.sourceLineIds).toEqual(["z-i1", "z-c1", "z-c2"]);
  });

  it("exercises all four row classes on the full fixture, so identity is proven on variety", () => {
    const classes = classifyRows(FULL_RECEIPT).rows.map((entry) => entry.classification);
    expect(new Set(classes)).toEqual(new Set(["item", "continuation", "noise_header", "ambiguous"]));
    expect(classes.filter((value) => value === "item")).toHaveLength(2);
    expect(classes.filter((value) => value === "continuation")).toHaveLength(2);
    expect(classes.filter((value) => value === "noise_header")).toHaveLength(6);
    expect(classes.filter((value) => value === "ambiguous")).toHaveLength(1);
  });
});

describe("row conservation", () => {
  it("places every word in exactly one row and drops none", () => {
    const words = FULL_RECEIPT.lines.flatMap((line) => line.words);
    const clustered = classifyRows(FULL_RECEIPT).rows.flatMap((entry) => entry.row.words);
    expect(clustered).toHaveLength(words.length);
    expect(new Set(clustered).size).toBe(words.length);
  });

  it("accounts for every row as an item, a continuation, noise or an unclassified row", () => {
    const rows = classifyRows(FULL_RECEIPT).rows;
    const parsed = parse(FULL_RECEIPT);
    const count = (classification: string) => rows.filter((entry) => entry.classification === classification).length;
    expect(parsed.items.length).toBe(count("item"));
    expect(parsed.unclassifiedRows.length).toBe(count("ambiguous"));
    expect(parsed.items.length + parsed.unclassifiedRows.length + count("continuation") + count("noise_header")).toBe(rows.length);
  });

  it("carries every ambiguous row through to the result, and warns once per row", () => {
    const result = receipt(ITEM_A, MISALIGNED_ROW, ITEM_B, SHOUTY_ROW);
    const ambiguous = classifyRows(result).rows.filter((entry) => entry.classification === "ambiguous");
    const parsed = parse(result);
    expect(parsed.unclassifiedRows).toHaveLength(ambiguous.length);
    expect(parsed.warnings.filter((warning) => warning.code === "ambiguous_row")).toHaveLength(ambiguous.length);
  });

  it("keeps a priced item row's name free of the price-column word", () => {
    const parsed = parse(receipt(COLUMN_LABELS, ITEM_A, ITEM_B));
    expect(parsed.items[0]!.name).toBe("MIKA GORENG");
    expect(parsed.items[1]!.name).toBe("NASI PUTIH");
  });

  it("assigns ids by document order even when rows arrive unordered", () => {
    const unordered = receipt(ITEM_B, ocrRow("i0", 60, ITEM_A.words.map((w) => [w.text, w.box.x, w.box.width] as [string, number, number])), COLUMN_LABELS);
    expect(parse(unordered).items.map((item) => item.name)).toEqual(["MIKA GORENG", "NASI PUTIH"]);
  });
});
