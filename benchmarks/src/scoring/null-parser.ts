import type { OcrResult, ParseResult } from "@receipt-lens/core";

/**
 * The parser that produces nothing. ADR-003 makes this permanent: if a parser emitting
 * no values can score above zero, the scoring harness is broken and every published
 * number with it.
 */
export function emptyParseResult(): ParseResult {
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

export function nullParse(_ocr: OcrResult): ParseResult {
  return emptyParseResult();
}
