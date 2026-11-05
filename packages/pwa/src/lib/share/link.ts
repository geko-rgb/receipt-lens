import type { BillDocument } from "../bill/document.js";
import {
  encodeSnapshot,
  ShareCodecError,
  SHARE_FRAGMENT_MAX_BYTES,
  type BillShareSnapshot,
  type ShareFailureCode,
} from "./codec.js";
import { assembleSnapshot, ShareAssemblyError, type SnapshotAssemblyCode } from "./snapshot.js";

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
export function budgetPercent(bytes: number): number {
  return Math.floor((bytes / SHARE_FRAGMENT_MAX_BYTES) * 100);
}

/**
 * participantId → fragment, the shape `buildSettlement` consumes (DECISIONS/0026 A7, A11). A refused generation
 * yields `{}`, which is the honest input: every payable row then has no bill link, and the share panel is where
 * the reason is written.
 */
export function shareLinksOf(outcome: ShareLinkOutcome | null): Record<string, string> {
  return outcome === null || !outcome.ok
    ? {}
    : Object.fromEntries(outcome.links.map((link) => [link.participantId, link.fragment]));
}

/**
 * One snapshot, N fragments: each participant's own token is that link's key material, so a roster gets one
 * link per person rather than one shared link (DECISIONS/0026 A7). Over budget refuses the whole roster — the
 * payload is identical for everyone, so a partial set would be a distinction without a difference that let a
 * creator send some participants a bill and others nothing (A4).
 */
export async function buildShareLinks(
  document: BillDocument,
  options: { readonly now: string }
): Promise<ShareLinkOutcome> {
  let snapshot: BillShareSnapshot;
  try {
    snapshot = assembleSnapshot(document, options);
  } catch (cause) {
    if (cause instanceof ShareAssemblyError) return { ok: false, code: cause.code };
    throw cause;
  }

  const links: ShareLink[] = [];
  for (const participant of document.working.participants) {
    // A participant with no token has no link. 0022 L5 makes that unreachable on a locked bill, so this is the
    // same guard ticket 15 already carries on the settlement row, not a new state.
    if (participant.token === "") continue;
    let fragment: string;
    try {
      fragment = await encodeSnapshot(snapshot, participant.token);
    } catch (cause) {
      if (cause instanceof ShareCodecError) return { ok: false, code: cause.code };
      throw cause;
    }
    links.push({ participantId: participant.id, fragment, bytes: fragment.length });
  }

  return { ok: true, snapshot, links };
}
