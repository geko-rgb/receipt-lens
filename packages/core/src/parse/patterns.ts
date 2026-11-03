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

/** Alphabetic fragments of a word: `CODE/DESC` prints as one token but names two columns. */
function labelFragments(text: string): string[] {
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
