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

describe("staged API surface", () => {
  it("ocr() delegates to the injected provider", async () => {
    const expected = blankOcrResult();
    const provider: OcrProvider = {
      name: "fake",
      version: "0.0.0",
      recognize: async () => expected,
    };
    const result = await ocr(new Blob(["receipt"], { type: "image/png" }), { provider });
    expect(result).toBe(expected);
  });

  it("ocr() propagates typed provider failures", async () => {
    const provider: OcrProvider = {
      name: "failing",
      version: "0.0.0",
      recognize: async () => {
        throw new ReceiptLensError("MODEL_LOAD_FAILED", "assets missing");
      },
    };
    await expect(ocr(new Blob(["x"]), { provider })).rejects.toBeInstanceOf(ReceiptLensError);
  });

  it("confidence stays null rather than a fabricated score", async () => {
    const line = blankOcrResult();
    line.lines = [
      { id: "l1", text: "PARCEL", box: { x: 0, y: 0, width: 4, height: 4 }, confidence: null, words: [] },
    ];
    const provider: OcrProvider = { name: "fake", version: "0", recognize: async () => line };
    const result = await ocr(new Blob(["x"]), { provider });
    expect(result.lines[0]!.confidence).toBeNull();
  });

  it("parse(), validate() and extract() are staged entry points awaiting implementation", async () => {
    const parsed = (): ParseResult => parse(blankOcrResult());
    expect(parsed).toThrow("not implemented");
    const emptyResult: ParseResult = {
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
    expect(() => validate(emptyResult, options)).toThrow("not implemented");
    await expect(extract(new Blob(["x"]), { ...options, provider: "pp-ocrv6" })).rejects.toThrow(
      "not implemented"
    );
  });
});
