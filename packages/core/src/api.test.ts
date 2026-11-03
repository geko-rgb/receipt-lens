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

  it("ocr() delegates to the provider; validate() and extract() keep refusing until ticket 07 lands", async () => {
    const delegate: OcrProvider = { name: "f", version: "0", recognize: async () => blankOcrResult() };
    await expect(ocr(new Blob(["x"]), { provider: delegate })).resolves.toEqual(blankOcrResult());
    // §4: blank OCR is a valid zero-word result — parse() answers it with zero items, not an error.
    expect(parse(blankOcrResult())).toEqual(emptyParse());
    expect(() => validate(emptyParse(), options)).toThrow("not implemented");
    await expect(
      extract(new Blob(["x"]), { ...options, provider: "pp-ocrv6" })
    ).rejects.toThrow("not implemented");
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
