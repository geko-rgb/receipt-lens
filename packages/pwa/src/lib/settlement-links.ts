import type { CreatorProfile, ExactMoney } from "./entities.js";
import type { ParticipantShare } from "./splitting.js";
import type { BillDocument } from "./bill/document.js";
import { fromPaise } from "./exact-money.js";
import { allocateSettlement } from "./settlement.js";
import { formatPaise } from "./bill/paise-input.js";
import { hmacSha256Hex } from "./hmac-sha256.js";

/**
 * Ticket 15 — the settlement view and the UPI/WhatsApp hand-off (DECISIONS/0024).
 *
 * This module is framework-free and reads no clock, no random source and no store: a committed locked document
 * and the creator's local profile go in, rows of display/copy material come out. The conversion from exact
 * rational shares to whole-paise transfers is ticket 02's `allocateSettlement`; nothing here restates it.
 */

/** DECISIONS/0024 S3: the project's contract constants, unverified against the primary NPCI document (S7). */
export const UPI_PAYEE_NAME_MAX = 40;
export const UPI_NOTE_MAX = 50;
export const UPI_REFERENCE_MAX = 35;
export const UPI_REFERENCE_HEX_CHARS = 16;

export type UpiLinkRefusal = "creator_name_missing" | "creator_upi_missing" | "nothing_to_pay";

export type SettlementRefusal =
  | UpiLinkRefusal
  | "shares_unavailable"
  | "settlement_total_inconsistent";

export interface UpiIntentInput {
  readonly payerUpi: string;
  readonly payerName: string;
  readonly amountPaise: number;
  readonly note: string;
  /** Already-fitted reference, or the derived `tr`. Omitted when absent or when it breaks the limit. */
  readonly reference?: string | null;
}

export type UpiIntentResult = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly code: UpiLinkRefusal };

/** The committed participant fields settlement reads. Deliberately not `Participant`, so no extra data is passed. */
export interface SettlementParticipant {
  readonly id: string;
  readonly name: string;
  readonly paid: boolean;
  readonly token: string;
}

export interface SettlementContext {
  readonly billId: string;
  readonly title: string;
  readonly payerId: string;
  readonly creatorId: string;
  readonly participants: readonly SettlementParticipant[];
  readonly shares: readonly ParticipantShare[];
  readonly confirmedTotalPaise: number;
  readonly profile: CreatorProfile | null;
  /** Origin for the participant link; `""` yields a root-relative `/share#…`. */
  readonly origin?: string;
  /**
   * DECISIONS/0026 A7/A11: participantId → the encoded fragment, generated once when the bill is locked.
   * Required rather than optional so no caller can offer a ticket-15-shaped placeholder by accident; a
   * participant missing from it simply has no bill link.
   */
  readonly shareLinks: Readonly<Record<string, string>>;
}

export type SettlementRowState = "payer" | "nothing_to_pay" | "payable" | "refused";

export interface SettlementRow {
  readonly participantId: string;
  readonly name: string;
  readonly exact: ExactMoney;
  readonly exactText: string;
  readonly paymentPaise: number;
  readonly paymentText: string;
  /** `settlementSharePaise` is not the exact rational share, so both must be shown (S2). */
  readonly differs: boolean;
  readonly state: SettlementRowState;
  readonly paid: boolean;
  readonly upiUrl: string | null;
  readonly whatsappUrl: string | null;
  readonly participantLink: string | null;
  readonly refusal: UpiLinkRefusal | null;
}

export type SettlementView =
  | { readonly ok: true; readonly rows: readonly SettlementRow[] }
  | { readonly ok: false; readonly code: SettlementRefusal };

export interface WhatsAppMessageInput {
  readonly participantName: string;
  readonly billTitle: string;
  readonly exactText: string;
  readonly paymentText: string;
  readonly upiUrl: string;
  readonly participantLink: string;
}

/**
 * RFC 3986 encoding for one query parameter. `encodeURIComponent` leaves `!'()*` alone; a payee name may
 * contain them, and a strict parameter grammar should not depend on a browser's tolerance.
 */
function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Clip by Unicode code point, so an emoji at the boundary is not split into half a surrogate pair. */
function clip(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

function formatAmount(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new Error("a transfer amount must be whole paise");
  return `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}

/**
 * Lossless decimal expansion of the rational rupee amount, at most four fractional digits. The ellipsis is
 * exactly the statement that the division has not terminated — never a rounded value presented as exact.
 */
export function formatExactRupees(exact: ExactMoney, maxFractionDigits = 4): string {
  const numerator = BigInt(exact.numeratorPaise);
  const denominator = BigInt(exact.denominator);
  if (denominator <= 0n) throw new Error("exact money needs a positive denominator");

  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const oneRupee = 100n * denominator;
  const whole = magnitude / oneRupee;
  let remainder = magnitude % oneRupee;

  let digits = "";
  for (let index = 0; index < maxFractionDigits && remainder !== 0n; index += 1) {
    remainder *= 10n;
    digits += (remainder / oneRupee).toString();
    remainder %= oneRupee;
  }
  const truncated = remainder !== 0n;
  if (!truncated) digits = digits.padEnd(2, "0");

  const grouped = Number(whole).toLocaleString("en-IN");
  return `${negative ? "-" : ""}₹${grouped}.${digits}${truncated ? "…" : ""}`;
}

/** Two-decimal whole-paise form for a transfer amount. */
export function formatPaymentPaise(paise: number): string {
  return formatPaise(paise);
}

/** A reference is used only if it already fits; a bad one is omitted rather than rewritten (S3 pin 4). */
function normalizeReference(reference: string | null | undefined): string | null {
  if (typeof reference !== "string") return null;
  if (reference.length < 1 || reference.length > UPI_REFERENCE_MAX) return null;
  return /^[A-Za-z0-9]+$/.test(reference) ? reference : null;
}

/** First 16 lowercase hex chars of HMAC-SHA-256(token, `billId:participantId`), or null without a token. */
export function deriveTransactionRef(billId: string, participantId: string, token: string): string | null {
  if (token === "") return null;
  return hmacSha256Hex(token, `${billId}:${participantId}`).slice(0, UPI_REFERENCE_HEX_CHARS);
}

export function buildUpiIntent(input: UpiIntentInput): UpiIntentResult {
  const payerUpi = input.payerUpi.trim();
  const payerName = input.payerName.trim();

  if (payerName === "") return { ok: false, code: "creator_name_missing" };
  if (payerUpi === "") return { ok: false, code: "creator_upi_missing" };
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    return { ok: false, code: "nothing_to_pay" };
  }

  const reference = normalizeReference(input.reference);
  const parameters = [
    `pa=${encodeParam(payerUpi)}`,
    `pn=${encodeParam(clip(payerName, UPI_PAYEE_NAME_MAX))}`,
    `am=${formatAmount(input.amountPaise)}`,
    "cu=INR",
    `tn=${encodeParam(clip(input.note.trim(), UPI_NOTE_MAX))}`,
  ];
  if (reference !== null) parameters.push(`tr=${encodeParam(reference)}`);

  return { ok: true, url: `upi://pay?${parameters.join("&")}` };
}

export function buildWhatsAppUrl(text: string): string {
  // egress-allowed: whatsapp-intent — §15 rule 6: opening WhatsApp is the user's deliberate external action.
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** DECISIONS/0024 S5: the three values are labelled separately, and the manual-settlement rule is stated. */
export function buildWhatsAppMessage(input: WhatsAppMessageInput): string {
  return [
    `Hi ${input.participantName} — your share of "${input.billTitle}".`,
    `Exact share: ${input.exactText}`,
    `UPI payment amount: ${input.paymentText}`,
    `Pay with UPI: ${input.upiUrl}`,
    `Bill link (opens on any device): ${input.participantLink}`,
    "",
    "The creator marks payments as paid by hand. Nothing here verifies a transfer.",
  ].join("\n");
}

/**
 * DECISIONS/0026 A11: the fragment is the encoded snapshot link ticket 16 produces, already carrying its own
 * `v1.` prefix. Ticket 15's `#v1.<token>` placeholder is gone rather than kept as a fallback — a link that
 * decodes to nothing would look like a sent bill, and 0026 A4's rule is that no link is offered when the
 * encoding did not succeed.
 */
export function participantLinkFor(origin: string, fragment: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/share#${fragment}`;
}

const EMPTY_ROW_LINKS = {
  upiUrl: null,
  whatsappUrl: null,
  participantLink: null,
  refusal: null,
} as const;

export function settlementRows(context: SettlementContext): SettlementView {
  let allocation;
  try {
    allocation = allocateSettlement([...context.shares], context.confirmedTotalPaise);
  } catch {
    // A reconciliation gap larger than the allocation's slack is a visible refusal, never an invented amount.
    return { ok: false, code: "settlement_total_inconsistent" };
  }

  const paymentById = new Map(allocation.map((entry) => [entry.participantId, entry.settlementSharePaise]));
  const shareById = new Map(context.shares.map((entry) => [entry.participantId, entry.exactAmount]));
  const payer = context.participants.find((participant) => participant.id === context.payerId);
  const payerName = (context.profile?.displayName.trim() ?? "") || (payer?.name.trim() ?? "");
  const payerUpi = context.profile?.upiId.trim() ?? "";
  const origin = context.origin ?? "";
  const note = `${context.title} share`;

  const rows = context.participants.map((participant): SettlementRow => {
    const exact = shareById.get(participant.id) ?? fromPaise(0);
    const paymentPaise = paymentById.get(participant.id) ?? 0;
    const differs = BigInt(exact.numeratorPaise) !== BigInt(paymentPaise) * BigInt(exact.denominator);
    const base = {
      participantId: participant.id,
      name: participant.name,
      exact,
      exactText: formatExactRupees(exact),
      paymentPaise,
      paymentText: formatPaymentPaise(paymentPaise),
      differs,
      paid: participant.paid,
    };

    // The payer is the creator in v1, and a self-payment link is never generated (S4 pin 6).
    if (participant.id === context.payerId) {
      return { ...base, state: "payer", ...EMPTY_ROW_LINKS };
    }
    if (paymentPaise === 0) {
      return { ...base, state: "nothing_to_pay", ...EMPTY_ROW_LINKS };
    }

    const fragment = context.shareLinks[participant.id];
    const participantLink = fragment === undefined ? null : participantLinkFor(origin, fragment);
    const intent = buildUpiIntent({
      payerUpi,
      payerName,
      amountPaise: paymentPaise,
      note,
      reference: deriveTransactionRef(context.billId, participant.id, participant.token),
    });
    if (!intent.ok) {
      return { ...base, state: "refused", ...EMPTY_ROW_LINKS, refusal: intent.code, participantLink };
    }

    const whatsappUrl =
      participantLink === null
        ? null
        : buildWhatsAppUrl(
            buildWhatsAppMessage({
              participantName: participant.name,
              billTitle: context.title,
              exactText: base.exactText,
              paymentText: base.paymentText,
              upiUrl: intent.url,
              participantLink,
            })
          );

    return { ...base, state: "payable", upiUrl: intent.url, whatsappUrl, participantLink, refusal: null };
  });

  return { ok: true, rows };
}

export function buildSettlement(
  document: BillDocument,
  profile: CreatorProfile | null,
  options: { readonly origin?: string; readonly shareLinks?: Readonly<Record<string, string>> } = {}
): SettlementView {
  const shares = document.derived.shares;
  if (shares === null) return { ok: false, code: "shares_unavailable" };

  const { working } = document;
  return settlementRows({
    billId: working.bill.id,
    title: working.bill.title,
    payerId: working.bill.payerId,
    creatorId: working.bill.creatorId,
    participants: working.participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      paid: participant.paid,
      token: participant.token,
    })),
    shares,
    // §12: the target is the confirmed grand total; the calculated payable total is only a fallback for a
    // bill that has none, which a locked bill cannot be.
    confirmedTotalPaise: document.derived.printedGrandTotal ?? document.derived.calculatedPayableTotal,
    profile,
    origin: options.origin,
    shareLinks: options.shareLinks ?? {},
  });
}
