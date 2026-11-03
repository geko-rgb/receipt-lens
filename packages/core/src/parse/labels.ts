/**
 * The §5 label dictionary as typed data, and its matching procedure (DECISIONS/0010 Q3, Q5).
 *
 * Ticket 05 used this dictionary as a boolean — *is this row labelled* — and handed the rows over as
 * `noise_header` so a charge could never become a product. Turning them into charges is this ticket's
 * job, which needs the match to say *which* label matched, so the tie-breaks §5 left as prose are
 * pinned: longest label first, leftmost on a genuine tie, and a matched span is consumed rather than
 * matched twice.
 */

/** §5's dictionary terms, mapped to the public fields of the DQ-03 shape (ADR-008, never reshaped). */
export type LabelCategory = "tax" | "service" | "tip" | "discount" | "roundOff" | "subtotal" | "grandTotal";

const DICTIONARY: readonly { readonly label: string; readonly category: LabelCategory }[] = [
  // English / Indian-English (§5)
  { label: "cgst", category: "tax" },
  { label: "sgst", category: "tax" },
  { label: "igst", category: "tax" },
  { label: "cess", category: "tax" },
  { label: "vat", category: "tax" },
  { label: "gst", category: "tax" },
  { label: "tax", category: "tax" },
  { label: "service charge", category: "service" },
  { label: "svc chg", category: "service" },
  { label: "service", category: "service" },
  { label: "sc", category: "service" },
  { label: "tip", category: "tip" },
  { label: "discount", category: "discount" },
  { label: "subtotal", category: "subtotal" },
  { label: "sub total", category: "subtotal" },
  { label: "grand total", category: "grandTotal" },
  { label: "net amount", category: "grandTotal" },
  { label: "bill amount", category: "grandTotal" },
  { label: "total", category: "grandTotal" },
  { label: "round off", category: "roundOff" },
  { label: "round", category: "roundOff" },
  // Indonesian CORD layout bucket (§5; ADR-010 keeps it a benchmark bucket, not a product language)
  { label: "pajak", category: "tax" },
  { label: "servis", category: "service" },
  { label: "diskon", category: "discount" },
  { label: "jumlah", category: "subtotal" },
];

/** Longest-first (§5 line 379), then alphabetical so the order is a property of the data, not of insertion. */
const ORDERED = [...DICTIONARY].sort((a, b) => b.label.length - a.label.length || a.label.localeCompare(b.label));

export interface LabelMatch {
  readonly label: string;
  readonly category: LabelCategory;
  /** Index into the normalized row text, so document order is recoverable. */
  readonly start: number;
}

/** §5's matching haystack: lowercase, alphanumerics and spaces only, runs collapsed, padded on both ends. */
export function normalizeRowText(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/**
 * Every label the row carries, in document order. At one index the longest dictionary entry wins, and the
 * span it matched is consumed — so `SUBTOTAL` can never be read as `TOTAL`, and `SERVICE CHARGE` never
 * fragments into `SERVICE` plus a leftover word that becomes a phantom item.
 *
 * Q3: two distinct equal-length labels cannot both match at the same index (the substring is determined
 * by position and length), and equal-length labels that *overlap* across indices resolve leftmost.
 */
export function matchLabels(text: string): LabelMatch[] {
  const haystack = normalizeRowText(text);
  const matches: LabelMatch[] = [];
  let index = 0;
  while (index < haystack.length) {
    const hit = ORDERED.find((entry) => haystack.startsWith(` ${entry.label} `, index));
    if (!hit) {
      index += 1;
      continue;
    }
    matches.push({ label: hit.label, category: hit.category, start: index });
    index += hit.label.length + 1;
  }
  return matches;
}

/** Q5's owner ruling: an inclusion cue makes the row an aggregate; otherwise tax outranks an aggregate. */
const INCLUSION_CUE = /\b(?:incl|inclusive|including|includes|excl|excluding|exclude)\b/;
const CHARGE_CATEGORIES: readonly LabelCategory[] = ["tax", "service", "tip", "discount", "roundOff"];

export function hasInclusionCue(text: string): boolean {
  return INCLUSION_CUE.test(normalizeRowText(text));
}

/**
 * The single category a labelled row gets. Charge types outrank aggregate labels, because a `TOTAL TAX`
 * or `GST TOTAL` row states a tax rather than the bill's total; an inclusion cue (`TOTAL INCL. GST`)
 * reverses that, because there the tax word qualifies the aggregate instead of being the charge.
 */
export function chooseCategory(matches: readonly LabelMatch[], inclusionCue: boolean): LabelCategory | null {
  if (matches.length === 0) return null;
  const charges = matches.filter((match) => CHARGE_CATEGORIES.includes(match.category));
  if (charges.length > 0 && !inclusionCue) return charges[0]!.category;
  return matches[0]!.category;
}

/** The dictionary as shipped, for the invariant test in `benchmarks/src/parser/`. */
export const labelDictionary = DICTIONARY;

/**
 * Q3's invariant, tested against the shipped matcher rather than argued from the data.
 *
 * The dictionary *by itself* has equal-length labels that overlap on letters — `cess` and `sgst` agree on
 * the trailing `s`, `vat` and `tax` on the leading `t` — so "no such pair exists" is false. What makes
 * the tie-break unreachable is the matcher: §5's labels are matched as whole words (` label ` in the
 * padded text), so a matched span always ends in a space, and a second equal-length label starting
 * inside that span would need a letter where the first one's boundary space sits. Contradiction, for
 * every pair. This function builds each minimal witness string anyway and runs it through `matchLabels`,
 * so the claim is an artefact and not a proof nobody checked.
 */
export function overlappingEqualLengthPairs(): string[] {
  const offenders: string[] = [];
  for (const a of DICTIONARY) {
    for (const b of DICTIONARY) {
      if (a.label === b.label || a.label.length !== b.label.length) continue;
      for (let shift = 1; shift < a.label.length; shift += 1) {
        if (a.label.slice(shift) !== b.label.slice(0, a.label.length - shift)) continue;
        const witness = a.label + b.label.slice(a.label.length - shift);
        const matches = matchLabels(witness);
        const both = matches.some((m) => m.label === a.label) && matches.some((m) => m.label === b.label);
        if (both) offenders.push(`${a.label}/${b.label}`);
      }
    }
  }
  return offenders;
}
