import type { BillDocument } from "../bill/document.js";
import type { BillShareSnapshot, ShareFailureCode } from "./codec.js";
import type { SnapshotAssemblyCode } from "./snapshot.js";

/**
 * Ticket 16 — turning a locked bill into the links a creator can send (DECISIONS/0026 A4, A7).
 *
 * Encoding is asynchronous and needs a fresh nonce, so this is the view's action, not a transaction: a
 * transaction that called it would be a non-deterministic write in the deterministic runner (0011, 0022 L5).
 * The product is view state and is never persisted — a stored ciphertext of a bill the ledger already holds
 * would be a second copy of the data and a stored bearer secret besides (0023 P4's export carries the ledger).
 */

/** A refusal a creator can be shown. Assembly codes and the codec's budget code, one union. */
export type ShareLinkFailureCode = SnapshotAssemblyCode | ShareFailureCode;

/** One participant's link. `bytes` is the encoded fragment's length, which is the budget's unit (A4). */
export interface ShareLink {
  readonly participantId: string;
  readonly fragment: string;
  readonly bytes: number;
}

export type ShareLinkOutcome =
  | { readonly ok: true; readonly snapshot: BillShareSnapshot; readonly links: readonly ShareLink[] }
  | { readonly ok: false; readonly code: ShareLinkFailureCode };

/** DECISIONS/0026 A4: the meter is computed from the string that was produced, never estimated. */
export function budgetPercent(_bytes: number): number {
  throw new Error("not implemented: DECISIONS/0026 A4 budgetPercent");
}

/**
 * One snapshot, N fragments: each participant's own token is that link's key material, so a roster gets one
 * link per person rather than one shared link (A7). Over budget refuses the whole roster.
 */
export async function buildShareLinks(
  _document: BillDocument,
  _options: { readonly now: string }
): Promise<ShareLinkOutcome> {
  throw new Error("not implemented: DECISIONS/0026 A7 buildShareLinks");
}
