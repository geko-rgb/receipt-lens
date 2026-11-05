import type { BillShareSnapshot, ShareFailureCode } from "./codec.js";
import type { SnapshotShares, Staleness } from "./snapshot.js";

/**
 * Ticket 16 — the participant view's model (DECISIONS/0026 A8–A10). `routes/Share.svelte` renders this and
 * adds nothing, so the four failure codes, the staleness rules and the disclosure are testable without a
 * browser the way every other seam in this repo is.
 *
 * The view calls no second validator: `decodeSnapshot` is the codec's own gate, and rendering starts only once
 * it resolves. The token that unlocks a link is read out of the link, because 0025 P3's whole premise is that a
 * recipient derives the key from what was sent to them.
 */

/** The closed set of 0025 P6's codes, as data, for the normalization at the bottom of `openShareLink`. */
export const FAILURE_CODES: readonly ShareFailureCode[] = [
  "unsupported_link_version",
  "link_budget_exceeded",
  "link_corrupt_or_tampered",
  "link_schema_invalid",
];

/** DECISIONS/0026 A8: one headline per code, and the code itself stays visible as the diagnostic. */
export const FAILURE_HEADLINES: Readonly<Record<ShareFailureCode, string>> = {
  unsupported_link_version: "This link is from a newer receipt-lens than this page.",
  link_budget_exceeded:
    "This link is longer than this format allows. Ask the creator to shorten the bill's labels and send a new link.",
  link_corrupt_or_tampered: "This link is incomplete, damaged or was altered. Nothing was read from it.",
  link_schema_invalid: "This link decrypted into something that is not a v1 bill snapshot. Nothing was rendered.",
};

/** DECISIONS/0025 P7, verbatim. The words are pinned; they may be split across elements, not paraphrased. */
export const SHARE_DISCLOSURE =
  "This link is the key. Anyone who has the complete link can read the whole bill and the shares in it. It is a " +
  "bearer secret, not protection from the person you send it to. “Show only my share” is a display default, not " +
  "access control.";

/** The two supporting facts 0025 P7 permits beside the pinned wording, and nothing stronger in their place. */
export const SHARE_DISCLOSURE_SUPPORT: readonly string[] = [
  "Browsers do not send the fragment in the request that loads this page, so ordinary server logs do not see it.",
  "The link can still be copied, synced or backed up, or read by anything on this device, and it cannot be reliably revoked.",
];

/** DECISIONS/0026 A9: what a device with no copy of the bill is allowed to say, and never the word "current". */
export const SNAPSHOT_MAY_HAVE_CHANGED = "The bill may have changed since.";

export type ShareView =
  | { readonly state: "empty" }
  | {
      readonly state: "failed";
      readonly code: ShareFailureCode;
      readonly headline: string;
      /** The codec's own reason, kept for the diagnostic line. Never a stack and never payload content. */
      readonly message: string;
    }
  | {
      readonly state: "ready";
      readonly snapshot: BillShareSnapshot;
      /** The recipient's own recomputation, with the cache disagreement (0026 A6). Not the link's numbers. */
      readonly shares: SnapshotShares;
      readonly staleness: Staleness;
      readonly disclosure: string;
    };

export interface OpenShareLinkOptions {
  /**
   * The local bill's `staleLinkCutoffAt`, when this device holds that bill (DECISIONS/0026 A8). Injected rather
   * than read here for the reason 0022 L5 injects `mintToken`: a pin must be able to test all three staleness
   * states without a ledger. It reads one timestamp and nothing else — no local amount may reach this view.
   */
  readonly cutoffOf?: (billId: string) => Promise<string | null>;
}

/** Decode, re-derive and classify a fragment as a participant view. Never a partially decoded bill. */
export async function openShareLink(
  _fragment: string,
  _options: OpenShareLinkOptions = {}
): Promise<ShareView> {
  throw new Error("not implemented: DECISIONS/0026 A8 openShareLink");
}
