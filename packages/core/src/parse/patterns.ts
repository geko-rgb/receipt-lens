/**
 * Header/noise pattern families and the charge-label boolean (DECISIONS/0008 P3, P2).
 *
 * Families follow §5's own examples — column labels, registration identifiers, table furniture —
 * plus the grouped-digit family 05 adds on measurement. These are data tables: a new family is a
 * new entry here, not a change to the classifier. The set is a starting point sized to what dev
 * exhibits, not a closed or maximal set.
 */

import { ALL_CAPS_STANDALONE_MAX_LENGTH } from "./constants.js";

/** §5 "Label dictionary" — used here only as a boolean, never as a typed charge (that is ticket 06). */
const CHARGE_LABELS: readonly string[] = [
  "service charge",
  "svc chg",
  "sub total",
  "subtotal",
  "grand total",
  "net amount",
  "bill amount",
  "round off",
  "discount",
  "service",
  "cess",
  "cgst",
  "sgst",
  "igst",
  "jumlah",
  "servis",
  "diskon",
  "pajak",
  "total",
  "tip",
  "vat",
  "gst",
  "tax",
  "sc",
  "round",
];

/** §5 line 379: "Match the longest label first so SUBTOTAL never matches TOTAL prematurely." */
const CHARGE_LABELS_LONGEST_FIRST = [...CHARGE_LABELS].sort((a, b) => b.length - a.length || a.localeCompare(b));

/** DECISIONS/0008 P3 family 1 vocabulary: column headers, not amounts. */
const COLUMN_LABELS = new Set(
  [
    "QTY", "ITEM", "PRICE", "DISC", "DISCOUNT", "AMOUNT", "DESC", "DESCRIPTION", "CODE",
    "TOTAL", "SUBTOTAL", "SUB", "GST", "CGST", "SGST", "IGST", "TAX", "CESS", "VAT",
    "SERVICE", "CHARGE", "SC", "SVC", "CHG", "RM", "RP",
  ].map((label) => label.toUpperCase()),
);

/**
 * DECISIONS/0033 P1: the vocabulary the *header table* stage reads. It is {@link COLUMN_LABELS} widened by the
 * column names retail receipts actually print — `PRODUCT`, `EXPIRE`, `RATE`, `MRP` and friends — because the
 * receipt this decision came from heads its grid `Product | Expire | Qty | Rate | Total` and the old set knew
 * only one of the five. Widening is confined to this stage: a lone `COFFEE` is never tested against it (P1's
 * two-column floor and P4's numeric-density test are what make reading a header safe), while a real header row
 * is now recognisable instead of surviving as `ambiguous`.
 */
export const HEADER_COLUMN_VOCABULARY: ReadonlySet<string> = new Set([
  ...COLUMN_LABELS,
  ...[
    "PRODUCT", "PRODUCTS", "EXPIRY", "EXPIRE", "EXP", "RATE", "UNIT", "UNITS", "UOM", "NOS", "NO",
    "MRP", "OUR", "YOUR", "SP", "NET", "GROSS", "HSN", "SAC", "WEIGHT", "WT", "KGS", "KG", "GM",
    "GMS", "LTR", "LITRE", "ML", "PCS", "PIECES", "COUNT", "SIZE", "TYPE", "MODEL", "BRAND",
    "CATEGORY", "SL", "SNO", "SR", "SRNO", "SLNO", "PARTICULARS", "PARTICULAR", "ITEMNAME", "NAME",
    "DETAILS", "NARRATION", "QNTY", "QUANTITY", "TOT", "VALUE", "TAXABLE", "TAXVALUE", "PERCENT",
    "PER", "CENT", "OFFER", "BARCODE", "REMARKS", "BATCH", "MFG", "PACK", "AMT",
  ].map((label) => label.toUpperCase()),
]);

/** P3 family 2: label-anchored registration identifiers. Shape-only matching is deliberately not used. */
const REGISTRATION_LABEL = /(?:^|\s)(GSTIN|GST\s?ID|TRN|SST\s?(?:NO|ID)|TAX\s?(?:ID|NO|REG)|BRN|ROC|REG\s?(?:NO)?)[.):]?[\s:]/i;

/** P3 family 3: table furniture. */
const TABLE_ROW = /^TABLE\D{0,4}\d+[. ]*$/i;
const TABLE_PREFIX = /^(?:TABLE|TBL)\D{0,4}\d+\b/i;

/** P3 family 4: grouped-digit identifiers (date/time, telephone, registration numbers). */
const MONEY_GROUPED = /^\d{1,3}(?:[.,]\d{2,3})+$/;
/**
 * Groups of 1–7 digits. The upper bound is what keeps a CORD item code such as `95569390-40118`
 * (8+5) out of the family, while `044-2356901` (3+7) stays in it: a telephone exchange part is
 * short and its subscriber part is at most seven digits.
 */
const DIGIT_GROUP = /^\d{1,7}$/;
const GROUPED_DIGIT_MIN = 8;
const GROUPED_DIGIT_MAX = 13;

/**
 * A word is an identifier token when it splits on `- / space` into 1–7 digit groups totalling
 * 8–13 digits and is not a money-grouped amount.
 *
 * The money guard is load-bearing: without it this family fires on Indonesian `1.234.567` and
 * Indian `1,23,456` prices, which are 2,276 words of the dev corpus.
 */
export function isGroupedDigitIdentifier(rawText: string): boolean {
  // Parentheses, quotes and colons are packaging or time separators, never part of the number:
  // `(044) 235 6901` and `09/03/2018 21:28` are each one identifier.
  const token = rawText.replace(/[()'"]/g, "").trim();
  if (MONEY_GROUPED.test(token)) return false;
  const unsigned = token.startsWith("+") ? token.slice(1) : token;
  const groups = unsigned.split(/[-/:., ]/).filter((group) => group.length > 0);
  if (groups.length < 2 || groups.some((group) => !DIGIT_GROUP.test(group))) return false;
  const digits = groups.join("").length;
  return digits >= GROUPED_DIGIT_MIN && digits <= GROUPED_DIGIT_MAX;
}

/**
 * Family 4 is about rows that are *nothing but* an identifier: a number, optionally introduced by a
 * telephone label. The letters test is what keeps real items intact — a CORD item row such as
 * `F/CASTELL 187057-75 TACK-IT 2 SR 12.00` carries an 8-digit product code, and a rule that fired on
 * any identifier token would delete that item to suppress one date stamp.
 */
const TELEPHONE_LABEL_WORDS = new Set([
  "TEL", "TELEPHONE", "PHONE", "FAX", "HOTLINE", "HP", "MOB", "MOBILE", "CELL", "CONTACT", "HANDPHONE",
]);

export function isIdentifierOnlyRow(words: readonly string[]): boolean {
  let sawIdentifier = false;
  for (const word of words) {
    if (isGroupedDigitIdentifier(word)) {
      sawIdentifier = true;
      continue;
    }
    // Anything without Latin letters — a bare amount, a time, a currency token, punctuation — is
    // not a name, so it cannot rescue the row from the family.
    if (!/[A-Za-z]/.test(word)) continue;
    const core = word.replace(/[^A-Za-z]/g, "").toUpperCase();
    if (TELEPHONE_LABEL_WORDS.has(core)) continue;
    return false;
  }
  return sawIdentifier;
}

/**
 * P3 family 6 — receipt metadata (DECISIONS/0034 M1).
 *
 * A receipt's own identifiers print on the same lines and in the same columns as its products: `Bill No:
 * 210373` puts a six-digit number at the right margin, and the price column is *decided by* numbers at the
 * right margin. So a metadata row that shares the price column with a real item row becomes a product — the
 * bug report's `BillNo qty 1 ₹2,10,373.00` — and a family that only fired on *identifier-only* rows
 * ({@link isIdentifierOnlyRow}) cannot stop it, because the row also carries the label `Bill No`.
 *
 * The rule is contextual, not a keyword filter:
 *
 * 1. the label must be **the beginning of the row** — a product may contain `No` or `2`, but a product does not
 *    start with `Bill No`;
 * 2. a label of one word (`Date`, `Table`, `KOT`) is only evidence when the row prints a separator (`Date:`) or
 *    when everything after it is non-alphabetic (`Table 4`, `KOT 12`). `Table water 20.00` is therefore a
 *    product and `Table No: 4` is metadata;
 * 3. a label of two words (`Bill No`, `Invoice Number`, `KOT Number`) is evidence on its own, because those two
 *    words together are the label and `Bill No` is not a product name.
 *
 * The matched label is remembered (`MetadataField`), so a caller can show *what* the row was and why it was not
 * a product.
 */
export type MetadataField =
  | "bill_number"
  | "invoice_number"
  | "order_number"
  | "date"
  | "time"
  | "table"
  | "kot"
  | "gstin"
  | "phone"
  | "cashier"
  | "waiter"
  | "sales_type";

interface MetadataLabel {
  readonly words: readonly string[];
  readonly field: MetadataField;
  /**
   * Whether a single-word label may print a *word* as its value without a separator (`Cashier Ramesh`).
   * A label like `Table` must not: `Table water` opens a perfectly ordinary product name.
   */
  readonly alphaValue?: boolean;
}

/** Longest label first, so `Bill Number` is read as a bill number and never as `Bill` plus a value. */
const METADATA_LABELS: readonly MetadataLabel[] = [
  { words: ["bill", "number"], field: "bill_number" },
  { words: ["bill", "no"], field: "bill_number" },
  { words: ["bill", "num"], field: "bill_number" },
  { words: ["billno"], field: "bill_number" },
  { words: ["bill", "#"], field: "bill_number" },
  { words: ["invoice", "number"], field: "invoice_number" },
  { words: ["invoice", "no"], field: "invoice_number" },
  { words: ["invoice", "num"], field: "invoice_number" },
  { words: ["invoiceno"], field: "invoice_number" },
  { words: ["inv", "no"], field: "invoice_number" },
  { words: ["inv", "#"], field: "invoice_number" },
  { words: ["order", "number"], field: "order_number" },
  { words: ["order", "no"], field: "order_number" },
  { words: ["orderno"], field: "order_number" },
  { words: ["kot", "number"], field: "kot" },
  { words: ["kot", "no"], field: "kot" },
  { words: ["kot", "#"], field: "kot" },
  { words: ["kot"], field: "kot" },
  { words: ["date"], field: "date" },
  { words: ["dt"], field: "date" },
  { words: ["time"], field: "time" },
  { words: ["table", "number"], field: "table" },
  { words: ["table", "no"], field: "table" },
  { words: ["table", "#"], field: "table" },
  { words: ["table"], field: "table" },
  { words: ["tbl", "no"], field: "table" },
  { words: ["gstin"], field: "gstin", alphaValue: true },
  { words: ["gst", "no"], field: "gstin", alphaValue: true },
  { words: ["gst", "id"], field: "gstin", alphaValue: true },
  { words: ["phone"], field: "phone", alphaValue: true },
  { words: ["mobile"], field: "phone", alphaValue: true },
  { words: ["mob"], field: "phone", alphaValue: true },
  { words: ["tel"], field: "phone", alphaValue: true },
  { words: ["cashier"], field: "cashier", alphaValue: true },
  { words: ["waiter"], field: "waiter", alphaValue: true },
  { words: ["steward"], field: "waiter", alphaValue: true },
  // DECISIONS/0034 amendment (2026-11-10, owner decision): the four staff labels a South Asian restaurant prints
  // beside the counter. **Narrow on purpose** — no `alphaValue`, so `Sman : 3`, `Salesman - 2` and `Captain 4`
  // are metadata while `Sman special 180.00` / `Captain Fries 200.00` stay products: the label needs a separator
  // or a value that carries no letters, exactly like `Table`. The printed suffix (`:-3`) is that value, not part of
  // the label match.
  { words: ["sman"], field: "waiter" },
  { words: ["salesman"], field: "waiter" },
  { words: ["captain"], field: "waiter" },
  // Rabbit-ear `Sales Type ： DINING`: a two-word label, evidence on its own like `Bill No`.
  { words: ["sales", "type"], field: "sales_type" },
  { words: ["sale", "type"], field: "sales_type" },
];

/** One word reduced to its label letters: `No:`, `No.` and `No#` are all `NO`. */
function labelKey(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Does the label's printed word end in a separator (`Date:`, `Table No:`)? */
function hasSeparator(text: string): boolean {
  return /[:#.]\s*$/.test(text.trim());
}

export interface MetadataReading {
  readonly field: MetadataField;
  /** The label words as the receipt printed them, for evidence. */
  readonly label: string;
  /** The words that follow the label — the value, which is *not* parsed into a bill field. */
  readonly value: readonly string[];
}

/**
 * P3 family 6. Returns what the row is, or null when it is not a metadata row.
 *
 * The guards are the whole point: `Pineapple lime 3 25.00 75.00` starts with a product, `Table water 20.00`
 * starts with a product whose first word happens to be a metadata word, and both must stay products.
 */
export function readMetadata(words: readonly string[]): MetadataReading | null {
  // A printed label is one *labelling* even when OCR returns it as one box (`Table No:`) or as two (`Table`,
  // `No:`), so the comparison runs over tokens rather than over words. The value is likewise a token list.
  const tokens = words.flatMap((word) => word.trim().split(/\s+/)).filter((token) => token.length > 0);
  const keys = tokens.map(labelKey);
  for (const label of METADATA_LABELS) {
    const width = label.words.length;
    const glued = width === 1 && keys[0] !== undefined && keys[0] === labelKey(label.words[0]);
    const spelled = width > 1 && label.words.every((word, index) => keys[index] === labelKey(word));
    if (!glued && !spelled) continue;

    const value = tokens.slice(width);
    const labelText = tokens.slice(0, width).join(" ");
    if (width === 1) {
      const explicit = hasSeparator(tokens[0] ?? "");
      // A single-word label is evidence through its own punctuation, through a value that carries no letters at
      // all, or through a label whose value is always a name or an identifier (`Cashier`, `GSTIN`).
      // `Date pudding` and `Table water` are products by this test.
      const numericTail = value.every((token) => !/[A-Za-z]/.test(token));
      if (!explicit && !numericTail && label.alphaValue !== true) continue;
    }

    return { field: label.field, label: labelText, value };
  }
  return null;
}

/** The boolean form, which is all classification needs. */
export function isMetadataRow(words: readonly string[]): boolean {
  return readMetadata(words) !== null;
}

/**
 * P3 family 7 — footer instructions and decorative text (DECISIONS/0034 M2).
 *
 * These rows carry no money at all, so they can never be a product line; before this family they were
 * preserved as `ambiguous` and blocked bill locking. The family is deliberately narrow: a phrase from the
 * vocabulary, **no digit anywhere on the row**, and no long word count — a product continuation could not
 * match it, because every phrase here is a sentence a receipt prints at the bottom of the page.
 */
const FOOTER_PHRASES: readonly string[] = [
  "thank you",
  "thanks",
  "thankyou",
  "visit again",
  "please visit",
  "welcome again",
  "have a nice day",
  "powered by",
  "computer generated",
  "gst enabled",
  "no refund",
  "no exchange",
  "subject to",
  "jurisdiction",
  "for and on behalf",
  "good day",
];

const FOOTER_ROW_MAX_WORDS = 10;

/** Normalised phrase haystack: lowercase letters and single spaces, so `THANK YOU !` reads as `thank you`. */
function phraseHaystack(words: readonly string[]): string {
  return ` ${words
    .map((word) => word.toLowerCase().replace(/[^a-z0-9]+/g, " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/** P3 family 7: a footer phrase the receipt prints, whatever numbers it carries. */
export function footerPhraseIn(words: readonly string[]): boolean {
  if (words.length === 0 || words.length > FOOTER_ROW_MAX_WORDS) return false;
  const haystack = phraseHaystack(words);
  return FOOTER_PHRASES.some((phrase) => haystack.includes(` ${phrase} `));
}

/** P3 family 7: decorative text a receipt prints around its items, with no number to read. */
export function isFooterInstructionRow(words: readonly string[]): boolean {
  if (words.some((word) => /\d/.test(word))) return false;
  return footerPhraseIn(words);
}

/** Alphabetic fragments of a word: `CODE/DESC` prints as one token but names two columns. */
export function labelFragments(text: string): string[] {
  return text
    .split(/[^A-Za-z]+/)
    .map((fragment) => fragment.toUpperCase())
    .filter((fragment) => fragment.length > 0);
}

function isColumnLabelRow(words: readonly string[]): boolean {
  if (words.length < 2) return false;
  const fragments = words.flatMap(labelFragments);
  if (fragments.length < 2) return false;
  return fragments.every((fragment) => COLUMN_LABELS.has(fragment));
}

/**
 * P3 family 2 as a named predicate. Ticket 06 needs the family, not the boolean: `GST NO: 0010 9010
 * 5344` carries a tax word and no tax amount, so a row matched here never becomes a charge.
 */
export function isRegistrationRow(words: readonly string[]): boolean {
  return REGISTRATION_LABEL.test(words.join(" "));
}

/**
 * P3 family 5 — tender and payment lines (DECISIONS/0010 Q7), added by ticket 06, not by §5.
 *
 * 06 found 423 dev rows matching this shape and 204 of them classified as `item`: `CASH 50,000` and
 * `CHANGE 4,500` were being sold as products, none of them a gold item. §5's dictionary has no tender
 * term and `ParseResult` has no tender field (ADR-008 locked), so the family is a discard, and it is
 * attributable per row: the vocabulary is 0008's measured predicate plus `changed` (an OCR misspelling on
 * 3 CORD rows) and `kembalian` (Indonesian "change due", 2 CORD rows), and minus `round off`/`diskon`,
 * which are §5 charge labels — counting those as tenders would misattribute rows the charge path owns.
 */
const TENDER_TERMS = "(?:cash|change|changed|tender|balance|payment|pay|paid|kembali|kembalian)";
const TENDER_WORD = new RegExp(`(^|\\W)${TENDER_TERMS}(\\W|$)`, "i");

export function matchesTenderFamily(text: string): boolean {
  return TENDER_WORD.test(text);
}

/** True when the row carries a §5 charge label (longest-first). Ticket 06 turns these into charges. */
export function matchesChargeLabel(text: string): boolean {
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ")} `;
  return CHARGE_LABELS_LONGEST_FIRST.some((label) => haystack.includes(` ${label} `));
}

/**
 * P3 families 1–4 as one boolean: does this row read as header or noise?
 *
 * The column-label check runs before the label-dictionary check so a `QTY ITEM PRICE` row is
 * attributed to the family that actually matches it, but both land in `noise_header`.
 */
export function matchesHeaderOrNoisePattern(words: readonly string[]): boolean {
  const text = words.join(" ");
  if (isColumnLabelRow(words)) return true;
  if (TABLE_ROW.test(text.trim()) || TABLE_PREFIX.test(text.trim())) return true;
  if (REGISTRATION_LABEL.test(text)) return true;
  return isIdentifierOnlyRow(words);
}

/**
 * P2: an all-caps standalone line. Lowercase is the only disqualifier — digits and punctuation do
 * not, because rejecting them would un-block `QTY R17`-shaped furniture from merging.
 */
export function isAllCapsStandalone(words: readonly string[]): boolean {
  const text = words.join(" ").trim();
  if (!/[A-Z]/.test(text) || /[a-z]/.test(text)) return false;
  return text.length <= ALL_CAPS_STANDALONE_MAX_LENGTH;
}

/** Exposed for the label-dictionary tests; the sorted order is the §5 requirement. */
export const chargeLabelOrderForTests: readonly string[] = CHARGE_LABELS_LONGEST_FIRST;
