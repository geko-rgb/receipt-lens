import type { OcrBox, OcrResult } from "./ocr/types.js";
import type { OcrProvider } from "./ocr/provider.js";

export type QuantitySource = "explicit" | "assumed" | "unresolved" | "user_confirmed";
export type FinalQuantitySource = "explicit" | "assumed" | "user_confirmed";
export type PriceSource = "detected" | "unresolved" | "user_confirmed";
export type FinalPriceSource = "detected" | "user_confirmed";
export type ValueSource = "detected" | "unresolved" | "user_confirmed";
export type ParticipantId = string;

export interface ParsedItem {
  /** stable within this ParseResult */
  id: string;
  name: string;
  qty: number | null;
  quantitySource: QuantitySource;
  /** integer paise */
  unitPrice: number | null;
  priceSource: PriceSource;
  /** integer paise; detected row total when present */
  lineTotal: number | null;
  /** heuristic, not a probability */
  confidence: number | null;
  sourceLineIds: string[];
  warnings: ParseWarning[];
}

export type ParseWarningCode =
  | "qty_assumed"
  | "qty_unresolved"
  | "name_confidence_low"
  | "price_confidence_low"
  | "ocr_confidence_low"
  | "confidence_unavailable"
  | "ambiguous_price_separator"
  | "ambiguous_row"
  | "name_length_outlier"
  | "price_not_resolved"
  | "unclassified_charge"
  | "items_may_be_missing"
  | "round_off_adjusted"
  | "missing_optional_field";

export interface ParseWarning {
  code: ParseWarningCode;
  message: string;
  itemRef?: string;
  sourceLineIds?: string[];
  sourceText?: string;
  sourceBox?: OcrBox;
}

export interface UnclassifiedRow {
  id: string;
  text: string;
  box: OcrBox;
  sourceLineIds: string[];
  reason: "ambiguous";
  warningCode: "ambiguous_row";
}

/**
 * Public v1 charge shape is deliberately kept as the owner's DQ-03 choice.
 * All amounts are integer paise; null means unresolved during parsing.
 */
export interface ParsedTax {
  label: string;
  /** positive magnitude; arithmetic adds if not included */
  amount: number | null;
  /** display-only, parsed from a printed percentage */
  rate?: number | null;
  /** display-only; never add/split this charge again */
  included?: boolean;
  source: "detected" | "user_confirmed";
}

export interface ParsedOtherCharge {
  label: string;
  /** positive magnitude; null while unresolved */
  amount: number | null;
  type: "other";
  /** unknown is excluded from arithmetic until reviewed */
  sign: "add" | "subtract" | "unknown";
  included?: boolean;
  source: "detected" | "user_confirmed";
}

export interface ParseResult {
  items: ParsedItem[];
  unclassifiedRows: UnclassifiedRow[];
  taxes: ParsedTax[];
  /** positive magnitude in paise */
  serviceCharge: number | null;
  /** positive magnitude in paise */
  tip: number | null;
  /** positive magnitude in paise; arithmetic subtracts it */
  discount: number | null;
  /** signed integer paise, preserving the printed +/- sign */
  roundOff: number | null;
  otherCharges: ParsedOtherCharge[];
  subtotal: number | null;
  subtotalSource: ValueSource;
  grandTotal: number | null;
  grandTotalSource: ValueSource;
  warnings: ParseWarning[];
}

export type ValidationSeverity = "critical" | "minor";
export type ValidationScope = "receipt" | "item" | "row" | "charge";

export interface ValidationFinding {
  severity: ValidationSeverity;
  code: string;
  scope: ValidationScope;
  message: string;
  itemRefs?: string[];
  rowRefs?: string[];
  chargeRefs?: string[];
  advisory?: boolean;
}

export interface ValidateOptions {
  criticalOcrConfidenceFloor: number;
  warningOcrConfidenceFloor: number;
  strictArithmetic: boolean;
}

export interface ParseValidationResult {
  /** true when a non-advisory critical parse finding exists */
  uncertain: boolean;
  /** parse/extraction/arithmetic findings only */
  findings: ValidationFinding[];
  /** canonical validated items, with confidence caps applied */
  items: ParsedItem[];
}

export interface ReceiptLensResult {
  parse: ParseResult;
  validation: ParseValidationResult;
  ocr: OcrResult;
}

export interface ExtractOptions extends ValidateOptions {
  provider: "pp-ocrv6" | OcrProvider;
}
