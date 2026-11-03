import { describe, expect, it } from "vitest";
import {
  extract,
  ocr,
  parse,
  validate,
  ReceiptLensError,
  type OcrProvider,
  type OcrResult,
  type ParseResult,
  type ValidateOptions,
} from "./index.js";
import { FULL_RECEIPT } from "./parse/fixtures.js";

function blankOcrResult(): OcrResult {
  return {
    lines: [],
    imageSize: { width: 640, height: 480 },
    provider: "fake",
    version: "0.0.0",
  };
}

const options: ValidateOptions = {
  criticalOcrConfidenceFloor: 0.5,
  warningOcrConfidenceFloor: 0.7,
  strictArithmetic: true,
};

function emptyParse(): ParseResult {
  return {
    items: [],
    unclassifiedRows: [],
    taxes: [],
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    otherCharges: [],
    subtotal: null,
    subtotalSource: "unresolved",
    grandTotal: null,
    grandTotalSource: "unresolved",
    warnings: [],
  };
}

describe("staged API surface", () => {
  it("ocr(), parse(), validate() and extract() exist as typed entry points", () => {
    const provider: OcrProvider = {
      name: "fake",
      version: "0.0.0",
      recognize: async () => blankOcrResult(),
    };
    expect(typeof ocr).toBe("function");
    expect(typeof parse).toBe("function");
    expect(typeof validate).toBe("function");
    expect(typeof extract).toBe("function");
    expect(provider.recognize).toBeTypeOf("function");
  });

  it("ocr() delegates to the provider; validate() and extract() are filled", async () => {
    const delegate: OcrProvider = { name: "f", version: "0", recognize: async () => blankOcrResult() };
    await expect(ocr(new Blob(["x"]), { provider: delegate })).resolves.toEqual(blankOcrResult());
    // §4: blank OCR is a valid zero-word result — parse() answers it with zero items, not an error.
    expect(parse(blankOcrResult())).toEqual(emptyParse());
    // ...and validate() calls that itemless result what it is (§4 line 322: not a silent success).
    const out = validate(emptyParse(), options);
    expect(out.findings.map((f) => f.code)).toContain("zero_items");
    expect(out.uncertain).toBe(true);

    const result = await extract(new Blob(["x"]), { ...options, provider: delegate });
    expect(result.ocr).toEqual(blankOcrResult());
    expect(result.parse).toEqual(emptyParse());
    expect(result.validation.findings.map((f) => f.code)).toContain("zero_items");
  });

  it("extract() composes the same stages the caller would have run separately", async () => {
    // Dev fixtures carry no recognition score at all (DECISIONS/0011 V0.1), so the floors are exercised
    // here by overlaying one onto a real multi-row receipt rather than by inventing a simpler input.
    const scored: OcrResult = {
      ...FULL_RECEIPT,
      lines: FULL_RECEIPT.lines.map((line) => ({
        ...line,
        confidence: 0.42,
        words: line.words.map((word) => ({ ...word, confidence: 0.42 })),
      })),
    };
    const provider: OcrProvider = { name: "fake", version: "0.0.0", recognize: async () => scored };
    const viaExtract = await extract(new Blob(["x"]), { ...options, provider });
    const staged = validate(parse(await ocr(new Blob(["x"]), { provider })), options);
    // Same input, same three stages: the convenience path must not become a second implementation.
    expect(viaExtract.validation).toEqual(staged);
    expect(viaExtract.parse.items.length).toBeGreaterThan(0);
    expect(viaExtract.validation.findings.some((f) => f.code === "ocr_critical_field_confidence")).toBe(true);
    expect(viaExtract.validation.findings.some((f) => f.code === "confidence_unavailable")).toBe(false);
    // 0.42 is below 0.5, so every item is critical-capped — and the cap never raises, so it stays 0.42.
    expect(viaExtract.validation.items.every((item) => item.confidence === 0.42)).toBe(true);
  });

  it("extract() propagates a provider's typed operational error unchanged", async () => {
    const failing: OcrProvider = {
      name: "broken",
      version: "0",
      recognize: async () => {
        throw new ReceiptLensError("MODEL_LOAD_FAILED", "assets missing");
      },
    };
    await expect(extract(new Blob(["x"]), { ...options, provider: failing })).rejects.toMatchObject({
      code: "MODEL_LOAD_FAILED",
    });
  });

  it("confidence is nullable by contract — a null score is legal, never fabricated", () => {
    const result = blankOcrResult();
    result.lines = [
      {
        id: "l1",
        text: "PARCEL",
        box: { x: 0, y: 0, width: 4, height: 4 },
        confidence: null,
        words: [{ text: "PARCEL", box: { x: 0, y: 0, width: 4, height: 4 }, confidence: null }],
      },
    ];
    expect(result.lines[0]!.confidence).toBeNull();
    expect(result.lines[0]!.words[0]!.confidence).toBeNull();
  });

  it("operational failures carry typed codes only", () => {
    const err = new ReceiptLensError("MODEL_LOAD_FAILED", "assets missing");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("MODEL_LOAD_FAILED");
    expect(err.name).toBe("ReceiptLensError");
  });
});
