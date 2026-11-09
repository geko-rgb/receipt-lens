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
  isRegistrationRow,
  matchesChargeLabel,
  matchesHeaderOrNoisePattern,
  matchesTenderFamily,
  // DECISIONS/0034: the two pattern families the metadata/ignored row classes rest on, exported so their
  // boundaries (a product named `Table water`; a product containing `2`) are re-derivable by CI.
  isMetadataRow,
  readMetadata,
  isFooterInstructionRow,
  type MetadataField,
  type MetadataReading,
} from "./parse/patterns.js";
// Ticket 06's content-parsing seams, exported for the same reason as the geometry ones above: the
// numbers DECISIONS/0010 publishes have to be re-derived by CI from the shipped code. `parse()` stays
// the only way to obtain a ParseResult.
export { detectQuantityColumn, quantityPattern, readQuantity } from "./parse/quantity.js";
export { inferProfile, profileForRows, readMoney, readRate } from "./parse/money.js";
export { chargeAmountTokens, resolveChargeAmount, readCharges } from "./parse/charges.js";
export { chooseCategory, hasInclusionCue, matchLabels, overlappingEqualLengthPairs, labelDictionary } from "./parse/labels.js";
// DECISIONS/0035: the header-free reconstruction stage as a seam, for the same reason — a page with no readable
// name column has to be re-derivable by CI, and the completion report reads `roles`/`scored`/`unpaired` from it.
export {
  reconstructWithoutHeader,
  inferPairingRoles,
  isNameLike,
  type PairingOptions,
  type PairingResult,
  type PairRole,
  type RoleSource,
} from "./parse/pairs.js";
export { inferValueColumns, horizontalCenter, type ValueColumn } from "./parse/geometry.js";
// The magnitude gate's rule and constant live in one module (0035's consolidation): an identifier wearing a price's
// shape is rejected by every stage that reads a number column, not only by the classifier's price column.
export { PRICE_MAGNITUDE_MULTIPLE, amountGate, exceedsGate, medianOfSorted } from "./parse/magnitude.js";
export {
  ALL_CAPS_STANDALONE_MAX_LENGTH,
  CONTINUATION_LENGTH_FLOOR,
  PRICE_COLUMN_WIDTH_RATIO,
  QUANTITY_BAND_MIN_ROWS,
  QUANTITY_MAX_VALUE,
  QUANTITY_QUALIFY_SHARE,
  ROW_BAND_HEIGHT_RATIO,
} from "./parse/constants.js";
export { validate } from "./validate/index.js";
export { extract } from "./extract.js";
