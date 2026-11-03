/**
 * Money parsing under §5's number-format contract, pinned in `DECISIONS/0010` (Q2, Q4, Q8).
 *
 * Three explicit profiles, one grammar each. A token is money only when it matches its profile's
 * grammar exactly; anything else is `null` (unresolved) rather than a reinterpretation, and a fraction
 * longer than two digits is never guessed. Values are integer paise computed in `BigInt` — §5's
 * safeguard "Money parsing must not use binary floating-point equality" is satisfied by never letting
 * a float appear between the token and the output.
 *
 * The profile is inferred per document from exclusive grammar evidence (Q4) because §4 gives `parse()`
 * only an `OcrResult`. Inference is bounded by exclusivity, not accuracy: the two profiles read 1,403
 * dev tokens in agreement and 0 of them with different values, so a wrong choice can only omit a token,
 * never misvalue one it reads.
 */

import type { ParsedRow } from "./geometry.js";

export type NumberProfile = "id-ID" | "en" | "en-IN";

/**
 * §5's table lists currency tokens per profile; stripping is the union, see {@link stripLead}. `$` is not
 * in §5's table and 12 dev SROIE receipts print it (`TOTAL AMOUNT: $8.20`), so it joins the strip list:
 * refusing it would leave a grand total unreadable, and the grammar still decides the value.
 */
const CURRENCY = /^(?:₹|\$|rs\.?|inr|rp\.?|rupiah|rm|myr)(?![a-z])/i;

/** Western thousands grouping: 1234, 1,234, 1,234,567. */
const GROUPS_WESTERN = /^\d{1,3}(?:,\d{3})*$/;
/** DECISIONS/0010 Q2: the exact lakh grammar — a 1–2 digit lead, 2-digit groups, one 3-digit final group. */
const GROUPS_LAKH = /^\d{1,2}(?:,\d{2})+,\d{3}$/;
/** id-ID thousands grouping: dot groups, and the comma-thousands form the corpus actually prints. */
const GROUPS_ID = /^\d{1,3}(?:[.,]\d{3})+$/;

const MAX_PAISE = BigInt(Number.MAX_SAFE_INTEGER);

export interface MoneyToken {
  /** signed integer paise; the sign is the printed one */
  readonly paise: number | null;
  /** `@` marks a printed unit price (CORD's convention, DECISIONS/0010 Q6) */
  readonly unitPriceMarker: boolean;
  /** a `%`-terminated token is a printed rate, never an amount */
  readonly percent: boolean;
  readonly profile: NumberProfile;
}

/**
 * Strip the leading packaging: a sign, then repeated currency tokens, `@`, `:` and spaces.
 *
 * The currency vocabulary is the union of §5's three token sets rather than the selected profile's own,
 * because Q4 infers the profile from number shapes and a misvote must not turn a recognisable amount
 * into nothing. Grammar still decides the value, so this widens what can be *read*, never what it means.
 */
function stripLead(raw: string): { negative: boolean; marker: boolean; body: string } | null {
  let text = raw.trim();
  let negative = /^\(/.test(text) || /^-/.test(text);
  text = text.replace(/[()]/g, "").replace(/^[+-]\s*/, "").replace(/\s+$/, "");
  let marker = false;
  for (;;) {
    const withoutCurrency = text.replace(CURRENCY, "").replace(/^\s+/, "");
    if (withoutCurrency !== text) {
      text = withoutCurrency;
      continue;
    }
    if (/^@/.test(text)) {
      marker = true;
      text = text.slice(1).replace(/^[\s:]+/, "");
      continue;
    }
    if (/^[:\s]/.test(text)) {
      text = text.replace(/^[:\s]+/, "");
      continue;
    }
    break;
  }
  if (!/^[\d.,]*\d$/.test(text)) return null;
  return { negative, marker, body: text };
}

function paiseOf(integerDigits: string, fractionDigits: string): bigint | null {
  const fraction = Number((fractionDigits + "00").slice(0, 2));
  const value = BigInt(integerDigits === "" ? "0" : integerDigits) * 100n + BigInt(fraction);
  return value > MAX_PAISE ? null : value;
}

/** The profile's own grammar, as a digits+separators string → integer paise (unsigned) or null. */
function grammar(body: string, profile: NumberProfile): bigint | null {
  return profile === "id-ID" ? grammarIdId(body) : grammarEnFamily(body, profile);
}

/**
 * `id-ID`: `.` groups thousands and `,` is the decimal mark (§5), but the corpus also prints
 * comma-thousands — `16,500` on 267 dev tokens — which reads to the same value either way and is what
 * `benchmarks/src/money.ts` already normalizes gold with, so §5's "same profile as predictions" needs it.
 * A comma decimal may not follow comma grouping: `12,500,5` is not an Indonesian amount, and it is
 * refused rather than reinterpreted.
 */
function grammarIdId(body: string): bigint | null {
  const decimal = /^([\d.,]+?),(\d{1,2})$/.exec(body);
  if (decimal) {
    const groups = decimal[1]!;
    if (!/^\d{1,3}(?:\.\d{3})*$/.test(groups) && !/^\d+$/.test(groups)) return null;
    return paiseOf(groups.replace(/\./g, ""), decimal[2]!);
  }
  if (/^\d+$/.test(body)) return paiseOf(body, "");
  if (!GROUPS_ID.test(body)) return null;
  return paiseOf(body.replace(/[.,]/g, ""), "");
}

/**
 * `en` and `en-IN`: `,` groups, `.` is the decimal mark, and a fraction longer than two digits is never
 * guessed. en-IN adds the lakh branch, which is what makes it a strict superset of en — so inferring the
 * wrong one of those two can never cost an amount that `en` would have read (DECISIONS/0010 Q4).
 */
function grammarEnFamily(body: string, profile: NumberProfile): bigint | null {
  const parts = body.split(".");
  if (parts.length > 2) return null;
  const integerPart = parts[0]!;
  const fraction = parts[1] ?? "";
  if (fraction.length > 2) return null;
  if (integerPart === "") {
    if (parts.length === 1) return null;
  } else if (!/^\d+$/.test(integerPart.replace(/,/g, ""))) {
    return null;
  }
  if (integerPart.includes(",") && !GROUPS_WESTERN.test(integerPart)) {
    if (profile !== "en-IN" || !GROUPS_LAKH.test(integerPart)) return null;
  }
  return paiseOf(integerPart.replace(/,/g, ""), fraction);
}

/**
 * Read one word as money under `profile`. Returns `paise: null` for anything the grammar refuses, and
 * marks `%` and `@` so callers can exclude rates from an amount count or recognise a printed unit price.
 */
export function readMoney(raw: string, profile: NumberProfile): MoneyToken {
  const text = raw.trim();
  const percent = /%$/.test(text);
  const stripped = stripLead(percent ? text.replace(/%$/, "") : text);
  const base: Omit<MoneyToken, "paise"> = { unitPriceMarker: false, percent, profile };
  if (!stripped) return { ...base, paise: null };
  const value = grammar(stripped.body, profile);
  if (value === null) return { ...base, paise: null };
  return {
    ...base,
    paise: Number(stripped.negative ? -value : value),
    unitPriceMarker: stripped.marker,
  };
}

/**
 * A printed percentage, as hundredths of a percent (`6%` → 600, `12.5%` → 1250). §4 makes `rate`
 * display-only, and paise scaling gives that for free: the grammar's integer-paise value of the printed
 * number *is* its hundredths-of-percent. Values above 1000% are refused — `40.000%` on a CORD row is a
 * decimal-mark artefact, not a rate worth displaying.
 */
export function readRate(raw: string, profile: NumberProfile): number | null {
  const text = raw.trim();
  if (!/%$/.test(text)) return null;
  const stripped = stripLead(text.replace(/%$/, ""));
  if (!stripped || stripped.negative) return null;
  const hundredths = grammar(stripped.body, profile);
  if (hundredths === null || hundredths > 100_000n) return null;
  return Number(hundredths);
}

/**
 * Q4: which profile this document prints. A token readable by only one profile votes for it; tokens
 * readable by both abstain, and they are the overwhelming majority (1,403 on dev, all in agreement).
 */
export function inferProfile(tokens: readonly string[]): NumberProfile {
  let idEvidence = 0;
  let enEvidence = 0;
  for (const token of tokens) {
    const idReadable = readMoney(token, "id-ID").paise !== null;
    const enReadable = readMoney(token, "en-IN").paise !== null;
    if (idReadable && !enReadable) idEvidence += 1;
    else if (enReadable && !idReadable) enEvidence += 1;
  }
  return idEvidence > enEvidence ? "id-ID" : "en-IN";
}

/** Profile over every word of the clustered rows — the shape-only vote, no currency evidence needed. */
export function profileForRows(rows: readonly ParsedRow[]): NumberProfile {
  return inferProfile(rows.flatMap((row) => row.words.map((word) => word.text)));
}

/** Exposed for the pin test, so the grammars in DECISIONS/0010 Q2 are the shipped ones. */
export const grammarPatternsForTests = {
  western: GROUPS_WESTERN,
  lakh: GROUPS_LAKH,
  idId: GROUPS_ID,
};
