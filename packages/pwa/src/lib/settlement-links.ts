import type { CreatorProfile, ExactMoney } from "./entities.js";
import type { ParticipantShare } from "./splitting.js";
import type { BillDocument } from "./bill/document.js";

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

/** Lossless decimal expansion of the rational rupee amount; `…` exactly when the expansion does not terminate. */
export function formatExactRupees(_exact: ExactMoney, _maxFractionDigits = 4): string {
  throw new Error("not implemented: DECISIONS/0024 S2 exact formatting");
}

/** Two-decimal whole-paise form for a transfer amount. */
export function formatPaymentPaise(_paise: number): string {
  throw new Error("not implemented: DECISIONS/0024 S2 payment formatting");
}

/** First 16 lowercase hex chars of HMAC-SHA-256(token, `billId:participantId`), or null without a token. */
export function deriveTransactionRef(_billId: string, _participantId: string, _token: string): string | null {
  throw new Error("not implemented: DECISIONS/0024 S3 transaction reference");
}

export function buildUpiIntent(_input: UpiIntentInput): UpiIntentResult {
  throw new Error("not implemented: DECISIONS/0024 S3 UPI intent");
}

export function buildWhatsAppMessage(_input: WhatsAppMessageInput): string {
  throw new Error("not implemented: DECISIONS/0024 S5 WhatsApp message");
}

export function buildWhatsAppUrl(_text: string): string {
  throw new Error("not implemented: DECISIONS/0024 S5 WhatsApp url");
}

/** The version prefix and bearer token ticket 16 will replace with the encrypted snapshot (S5/S8). */
export function participantLinkFor(_origin: string, _token: string): string {
  throw new Error("not implemented: DECISIONS/0024 S5 participant link");
}

export function settlementRows(_context: SettlementContext): SettlementView {
  throw new Error("not implemented: DECISIONS/0024 S1–S6 settlement rows");
}

export function buildSettlement(
  _document: BillDocument,
  _profile: CreatorProfile | null,
  _options: { readonly origin?: string } = {}
): SettlementView {
  throw new Error("not implemented: DECISIONS/0024 S1–S6 settlement view");
}
