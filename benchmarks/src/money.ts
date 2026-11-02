/**
 * Harness-side amount reading for dataset annotations. This is not the product's
 * locale parser (that is ticket 06's job under §5); it exists so gold values are
 * integers before anything compares them. No float ever reaches the comparison.
 */

export type AmountProfile = "en" | "id-ID";

/** Minor units per whole unit. Both source currencies are 2-decimal nominally. */
const minorDigits = 2;

/**
 * A separator followed by exactly one group of three is thousands, not a decimal.
 * Profile-bound, because under `en` a dot is a decimal mark: `23.000` is 23000 rupiah
 * under id-ID and unreadable-by-choice under en.
 */
const thousandsPatterns: Record<AmountProfile, RegExp> = {
  en: /^\d{1,3}(?:,\d{3})+$/,
  "id-ID": /^\d{1,3}(?:[.,]\d{3})+$/,
};

function fail(input: string, profile: AmountProfile): never {
  throw new TypeError(
    `"${input}" is not an amount the ${profile} profile can read exactly — refusing to guess`
  );
}

function toMinor(integerDigits: string, fractionDigits: string): number {
  const units = Number(integerDigits === "" ? "0" : integerDigits);
  const scaled = Number(fractionDigits.padEnd(minorDigits, "0") || "0");
  const minor = units * 10 ** minorDigits + scaled;
  if (!Number.isSafeInteger(minor)) return Number.NaN;
  return minor;
}

/**
 * `id-ID` prints thousands with a dot and sometimes a comma (`23.000`, `16,500`) and
 * amounts on these receipts carry no fraction; a comma is a decimal mark only with a
 * one- or two-digit tail. `en` groups with commas and decimals on the dot.
 *
 * A three-digit fraction is never guessed at: `23.000` is 23000 rupiah under id-ID and
 * ambiguous under en, and the same printed string must not silently take two values.
 */
export function parseAmountToMinorUnits(input: string, profile: AmountProfile): number {
  const unsigned = input.trim().replace(/^[^\d+-]+/, "").replace(/^[+-]/, "").trim();
  if (unsigned === "" || !/^[\d.,]*\d[\d.,]*$/.test(unsigned)) fail(input, profile);
  const negative = /^\s*-/.test(input.trim());

  let integerDigits: string;
  let fractionDigits: string;

  if (thousandsPatterns[profile].test(unsigned)) {
    integerDigits = unsigned.replace(/[.,]/g, "");
    fractionDigits = "";
  } else if (profile === "id-ID") {
    const match = /^(\d+)(?:,(\d{1,2}))?$/.exec(unsigned);
    if (!match) fail(input, profile);
    integerDigits = match[1]!;
    fractionDigits = match[2] ?? "";
  } else {
    const match = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(unsigned);
    if (!match) fail(input, profile);
    integerDigits = match[1]!.replaceAll(",", "");
    fractionDigits = match[2] ?? "";
  }

  const minor = toMinor(integerDigits, fractionDigits);
  if (Number.isNaN(minor)) fail(input, profile);
  return negative ? -minor : minor;
}
