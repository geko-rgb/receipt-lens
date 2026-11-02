/**
 * Fixture PII redaction (DECISIONS/0005). Pure and deterministic: the same token
 * stream always produces the same output, so byte-identical fixture regeneration
 * holds. Redaction may only touch non-scored PII — scored fields and structural
 * cues are listed as kept in DECISIONS/0005 and are never rewritten here.
 */

export type PiiClass =
  | "BUSINESS"
  | "ADDRESS"
  | "PHONE"
  | "EMAIL"
  | "UPI"
  | "INVOICE_NNN"
  | "CARD_XXXX"
  | "NAME"
  | "ACCOUNT"
  | "CUSTOMER";

export interface Redaction {
  readonly class: PiiClass;
  readonly line: number;
  readonly word: number;
  readonly before: string;
  readonly after: string;
}

export interface RedactionResult {
  readonly lines: readonly (readonly string[])[];
  readonly redactions: readonly Redaction[];
}

interface InlineRule {
  readonly class: PiiClass;
  readonly pattern: RegExp;
  readonly placeholder: string;
  /**
   * Some number shapes are indistinguishable from money on their own, so they are
   * only redacted when the line carries a label that says what they are. Without an
   * anchor these rules would eat prices — the scored field — which is the one thing
   * DECISIONS/0005 forbids.
   */
  readonly requiresLineLabel?: RegExp;
}

// Order matters: the first rule that matches a word claims the span it replaces.
// VPA handles are an explicit PSP list, not "any local-part@word" — an unknown
// handle is left alone rather than guessed at (and the post-generation PII scan
// is what reports anything that slips through).
const inlineRules: InlineRule[] = [
  {
    class: "UPI",
    pattern:
      /\b[A-Za-z0-9][A-Za-z0-9._-]{1,63}@(?:ybl|paytm|ptd|apl|upi|ok[A-Za-z]{2,12}|[A-Za-z]{2,6}bank[A-Za-z]{0,6})\b/g,
    placeholder: "[UPI]",
  },
  { class: "EMAIL", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, placeholder: "[EMAIL]" },
  // a masked PAN: printed as X…X or **** followed by the last four digits.
  { class: "CARD_XXXX", pattern: /[xX*]{6,}\d{4}/g, placeholder: "[CARD_XXXX]" },
  {
    class: "ACCOUNT",
    pattern: /\d[\d\s-]{8,}\d/g,
    placeholder: "[ACCOUNT]",
    requiresLineLabel: /\b(?:BANK|ACC|A\/C|A-C|REKENING|NO\.? REKENING)\b/i,
  },
  // country-code-prefixed number: unambiguous without an anchor
  { class: "PHONE", pattern: /\+\d{1,3}[-\s]?\d[\d\s()-]{5,}\d/g, placeholder: "[PHONE]" },
  {
    class: "PHONE",
    pattern: /\d[\d\s()-]{5,}\d/g,
    placeholder: "[PHONE]",
    requiresLineLabel: /\b(?:TEL|FAX|TELP|PHONE|HP|MOB|HOTLINE|HUBUNGI|KONTAK)\b/i,
  },
];

const placeholders: Record<PiiClass, string> = {
  BUSINESS: "[BUSINESS]",
  ADDRESS: "[ADDRESS]",
  PHONE: "[PHONE]",
  EMAIL: "[EMAIL]",
  UPI: "[UPI]",
  INVOICE_NNN: "[INVOICE_NNN]",
  CARD_XXXX: "[CARD_XXXX]",
  NAME: "[NAME]",
  ACCOUNT: "[ACCOUNT]",
  CUSTOMER: "[CUSTOMER]",
};

interface SpanRule {
  readonly class: PiiClass;
  readonly labels: readonly string[];
  readonly maxWords: number;
}

/**
 * Labels whose *value* is PII and whose value can span several words. Matching is
 * word-boundary anchored, so `PIC` never fires inside `PICKUP` and `INVOICE NO`
 * never matches the header line `TAX INVOICE`.
 */
const spanRules: SpanRule[] = [
  {
    class: "NAME",
    labels: ["CASHIER IN CHARGE", "ATTENDED BY", "SERVICED BY", "PREPARED BY", "SALES PERSON", "CASHIER", "SERVER", "STAFF", "WAITER", "KASIR", "PIC"],
    maxWords: 4,
  },
  {
    class: "CUSTOMER",
    labels: ["BILL TO", "SOLD TO", "ATTENTION", "PELANGGAN", "CUSTOMER"],
    maxWords: 6,
  },
  {
    class: "INVOICE_NNN",
    labels: [
      "INVOICE NUMBER",
      "INVOICE NO",
      "NO INVOICE",
      "NO. INVOICE",
      "RECEIPT NO",
      "REC NO",
      "BILL NO",
      "SLIP NO",
      "TRANSACTION ID",
      "TRANS ID",
      "TID",
    ],
    maxWords: 2,
  },
];

/**
 * Words that mean "the value ended": the next receipt field or column label. Without
 * these, a one-word name would swallow the structural label that follows it.
 */
const structuralStops = new Set([
  "COVER", "ADDRESS", "DATE", "TIME", "ITEM", "ITEMS", "DESCRIPTION", "QTY", "PRICE", "AMOUNT",
  "TOTAL", "SUBTOTAL", "TABLE", "GST", "SST", "VAT", "TEL", "FAX", "EMAIL", "TAX", "CASH",
  "CARD", "APPROVAL", "REMARKS", "NOTE", "TERMS", "SALES", "SIGNATURE", "PAYMENT", "MODE",
  "CODE", "RM", "RP", "ID", "NO", "NAME", "CHARGE", "CHARGES", "SERVICE", "TAXES",
]);

function normalizeWord(word: string): string {
  return word.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest label first, so `INVOICE NUMBER` wins over `INVOICE NO`. */
const labelPatterns: { rule: SpanRule; label: string; pattern: RegExp }[] = spanRules
  .flatMap((rule) => rule.labels.map((label) => ({ rule, label })))
  .sort((a, b) => b.label.length - a.label.length)
  .map(({ rule, label }) => ({
    rule,
    label,
    pattern: new RegExp(`^(${escapeForPattern(label).replace(/ /g, "\\s+")})(?![A-Z0-9])([\\s:.\\-/]*)(.*)$`, "i"),
  }));

interface SpanMark {
  readonly word: number;
  readonly class: PiiClass;
}

export interface HeaderEntities {
  readonly company?: string;
  readonly address?: string;
}

export interface UnmatchedEntity {
  readonly class: PiiClass;
  readonly text: string;
}

export interface RedactionResult {
  readonly lines: readonly (readonly string[])[];
  readonly redactions: readonly Redaction[];
  readonly unmatchedEntities: readonly UnmatchedEntity[];
}

/**
 * The dataset tells us which text is the business name and which is the address, so
 * header redaction is anchored to those annotation strings instead of guessing from
 * line position. The anchor only ever *restricts* what gets redacted, and only inside
 * the header block: item names are kept verbatim by DECISIONS/0005, and a token that
 * happens to look like a business name further down the receipt is an item, not a
 * business.
 */
const headerEntityLineLimit = 8;

function normalizeEntity(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function redactHeaderEntities(
  words: readonly string[],
  lineIndex: number,
  entities: HeaderEntities
): { words: string[]; marks: SpanMark[] } {
  if (lineIndex >= headerEntityLineLimit) return { words: [...words], marks: [] };
  const anchors: { class: PiiClass; normalized: string }[] = [];
  if (entities.company) anchors.push({ class: "BUSINESS", normalized: normalizeEntity(entities.company) });
  if (entities.address) anchors.push({ class: "ADDRESS", normalized: normalizeEntity(entities.address) });

  const marks: SpanMark[] = [];
  const out = words.map((word, wordIndex) => {
    const normalized = normalizeEntity(word);
    if (normalized.length < 3) return word;
    const hit = anchors.find(
      ({ normalized: entity }) => entity.includes(normalized) || normalized.includes(entity)
    );
    if (!hit) return word;
    marks.push({ word: wordIndex, class: hit.class });
    return placeholders[hit.class];
  });
  return { words: out, marks };
}

function redactSpanLine(words: readonly string[]): { words: string[]; marks: SpanMark[] } {
  const out: string[] = [];
  const marks: SpanMark[] = [];
  let pending: { rule: SpanRule; consumed: number } | null = null;

  for (const [index, word] of words.entries()) {
    const normalized = normalizeWord(word);
    const hit = labelPatterns.find(({ pattern }) => pattern.test(word));

    if (hit) {
      pending = { rule: hit.rule, consumed: 0 };
      const matched = word.match(hit.pattern)!;
      const separator = matched[2] ?? "";
      const value = matched[3] ?? "";
      if (!/[A-Za-z0-9]/.test(value)) {
        // `CASHIER#:` carries no value: the punctuation tail is not a name.
        out.push(word);
      } else {
        // Rebuild from the match groups so the label keeps its own printed form and
        // only the value words are replaced, one placeholder per word.
        const placeholder = placeholders[hit.rule.class];
        const valueWords = value.split(/\s+/).filter((token) => token !== "");
        out.push(`${matched[1]}${separator}${valueWords.map(() => placeholder).join(" ")}`);
        marks.push({ word: index, class: hit.rule.class });
        pending = null;
      }
      continue;
    }

    if (pending) {
      if (normalized === "") {
        out.push(word);
        continue;
      }
      if (structuralStops.has(normalized) || pending.consumed >= pending.rule.maxWords) {
        pending = null;
      } else {
        const leading = /^(\s*[:=\-.]+\s*)/u.exec(word);
        const placeholder = placeholders[pending.rule.class];
        out.push(leading ? `${leading[1]}${placeholder}` : placeholder);
        marks.push({ word: index, class: pending.rule.class });
        pending.consumed += 1;
        if (pending.consumed >= pending.rule.maxWords) pending = null;
        continue;
      }
    }

    out.push(word);
  }
  return { words: out, marks };
}

function redactWord(word: string, lineText: string): { text: string; classes: PiiClass[] } {
  let text = word;
  const classes: PiiClass[] = [];
  for (const rule of inlineRules) {
    if (rule.requiresLineLabel && !rule.requiresLineLabel.test(lineText)) continue;
    const replaced = text.replace(rule.pattern, rule.placeholder);
    if (replaced !== text) {
      text = replaced;
      classes.push(rule.class);
    }
  }
  return { text, classes };
}

export function redactWords(
  lines: readonly (readonly string[])[],
  entities: HeaderEntities = {}
): RedactionResult {
  const redactions: Redaction[] = [];
  const out: string[][] = [];
  const claimedClasses = new Set<PiiClass>();

  for (const [lineIndex, original] of lines.entries()) {
    // Header anchoring first (it works across the receipt's own annotations), then the
    // span pass (across words), then the inline pass. A word is claimed by at most one:
    // each pass outputs placeholders, which no later pattern matches.
    const headed = redactHeaderEntities(original, lineIndex, entities);
    const spanned = redactSpanLine(headed.words);
    const lineText = original.join(" ");
    const line: string[] = [];
    for (const [wordIndex, word] of spanned.words.entries()) {
      const { text, classes } = redactWord(word, lineText);
      const before = original[wordIndex]!;
      if (text !== before) {
        const mark =
          headed.marks.find((candidate) => candidate.word === wordIndex) ??
          spanned.marks.find((candidate) => candidate.word === wordIndex);
        const claimed = mark ? mark.class : classes[0]!;
        claimedClasses.add(claimed);
        redactions.push({ class: claimed, line: lineIndex, word: wordIndex, before, after: text });
      }
      line.push(text);
    }
    out.push(line);
  }

  const unmatchedEntities: UnmatchedEntity[] = [];
  if (entities.company && !claimedClasses.has("BUSINESS")) {
    unmatchedEntities.push({ class: "BUSINESS", text: entities.company });
  }
  if (entities.address && !claimedClasses.has("ADDRESS")) {
    unmatchedEntities.push({ class: "ADDRESS", text: entities.address });
  }

  return { lines: out, redactions, unmatchedEntities };
}
