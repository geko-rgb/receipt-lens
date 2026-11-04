/**
 * The one place a rupee amount crosses from a text input into the bill, and therefore the one place a float
 * could sneak into money. business.md §5.1: "No monetary value is ever a float" — so this parses the string
 * it is given instead of multiplying by 100, and `100.10` becomes `10010` paise rather than the
 * `10009.999999999998` that `Math.round(Number(text) * 100)` produces.
 */

/**
 * Blank is `null` (§10's unresolved, business.md §5.5: undetected is never guessed). Anything the grammar
 * refuses becomes `Number.NaN`, which is deliberate: the seam's own `invalid_amount` predicate rejects it,
 * so the UI shows the transaction's reason instead of inventing a second validation path (DECISIONS/0020 T1).
 */
export function parsePaiseInput(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, "");
  if (trimmed === "") return null;

  // A trailing dot is a half-typed whole rupee ("4." is ₹4), not an error; "" and "." are the blank and
  // malformed cases.
  const match = /^([-+]?)(\d*)(?:\.(\d{0,2}))?$/.exec(trimmed);
  if (!match) return Number.NaN;
  const [, sign, whole, fraction] = match;
  if (!whole && !fraction) return Number.NaN;

  const digits = `${whole ?? ""}${(fraction ?? "").padEnd(2, "0")}`;
  const paise = Number(digits);
  if (!Number.isSafeInteger(paise)) return Number.NaN;
  return sign === "-" ? -paise : paise;
}

/** Exact display: an integer paise amount always has a terminating two-decimal rupee form. */
export function formatPaise(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error("formatPaise needs an integer paise amount");
  const sign = paise < 0 ? "-" : "";
  const magnitude = Math.abs(paise);
  const rupees = Math.trunc(magnitude / 100);
  const rest = magnitude % 100;
  return `${sign}₹${rupees.toLocaleString("en-IN")}.${String(rest).padStart(2, "0")}`;
}

/** The `null` state has a word of its own, because "₹0.00" would be a lie about an unresolved value. */
export function formatPaiseOrNull(paise: number | null): string {
  return paise === null ? "unresolved" : formatPaise(paise);
}
