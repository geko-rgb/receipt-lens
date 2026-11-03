export type {
  QuantitySource,
  FinalQuantitySource,
  PriceSource,
  FinalPriceSource,
  ValueSource,
  ParticipantId,
  ParsedItem,
  ParseWarningCode,
  ParseWarning,
  UnclassifiedRow,
  ParsedTax,
  ParsedOtherCharge,
  ParseResult,
  ValidationSeverity,
  ValidationScope,
  ValidationFinding,
  ValidateOptions,
  ParseValidationResult,
  ReceiptLensResult,
  ExtractOptions,
} from "./types.js";
export type { OcrBox, OcrWord, OcrLine, OcrResult } from "./ocr/types.js";
export type { OcrProvider, OcrOptions } from "./ocr/provider.js";
export {
  PPOCRv6Provider,
  createPPOCRv6Provider,
  type PPOCRv6ProviderOptions,
  type PPOCRv6SessionInfo,
  type OrtRuntime,
} from "./ocr/pp-ocrv6.js";
export {
  fetchModelManifest,
  type ModelAsset,
  type ModelAssetRole,
  type ModelManifest,
} from "./ocr/model-manifest.js";
export { ReceiptLensError, type ReceiptLensErrorCode } from "./errors.js";
export { ocr } from "./ocr/provider.js";
export { parse } from "./parse/index.js";
// Row-geometry seams, exported for the benchmark's row-classification buckets in the same spirit
// as the provider seams above: the numbers DECISIONS/0008 publishes have to be re-derivable by CI,
// not asserted by hand. `parse()` stays the only way to obtain a ParseResult.
export {
  classifyRows,
  continuationLengthCap,
  meetsContinuationConditions,
  type ClassifiedRow,
  type RowClassification,
  type RowClassifyResult,
} from "./parse/index.js";
export {
  isGroupedDigitIdentifier,
  isIdentifierOnlyRow,
  matchesChargeLabel,
  matchesHeaderOrNoisePattern,
} from "./parse/patterns.js";
export {
  ALL_CAPS_STANDALONE_MAX_LENGTH,
  CONTINUATION_LENGTH_FLOOR,
  PRICE_COLUMN_WIDTH_RATIO,
  ROW_BAND_HEIGHT_RATIO,
} from "./parse/constants.js";
export { validate } from "./validate/index.js";
export { extract } from "./extract.js";
