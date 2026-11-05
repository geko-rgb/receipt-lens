import { decodeSnapshot, type BillShareSnapshot, type ShareFailureCode } from "./codec.js";
import { sharesFromSnapshot, stalenessOf, type SnapshotShares, type Staleness } from "./snapshot.js";
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

/**
 * Decode, re-derive and classify a fragment as a participant view. Never a partially decoded bill: nothing
 * below touches `snapshot` until `decodeSnapshot` has resolved, and that function is the only validator.
 */
export async function openShareLink(
  fragment: string,
  options: OpenShareLinkOptions = {}
): Promise<ShareView> {
  // The codec strips a leading `#` itself and the router has usually already done so; the view must not fight
  // either, so it normalizes once and hands the codec what it expects.
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (raw === "") return { state: "empty" };

  // The key material travels inside the link it opens (0025 P3). A malformed fragment may have no second
  // component at all; the codec's own order then answers with the code for *that* condition, because a token
  // that is not the one the sender used simply fails the authentication tag.
  const token = raw.split(".")[1] ?? "";

  let snapshot: BillShareSnapshot;
  try {
    snapshot = await decodeSnapshot(raw, token);
  } catch (cause) {
    const code = classify(cause);
    return { state: "failed", code, headline: FAILURE_HEADLINES[code], message: describe(cause) };
  }

  let cutoffAt: string | null = null;
  try {
    cutoffAt = (await options.cutoffOf?.(snapshot.bill.id)) ?? null;
  } catch {
    // A ledger this build cannot open is the "cannot know" state, not an error and not a claim of freshness.
    cutoffAt = null;
  }

  return {
    state: "ready",
    snapshot,
    shares: sharesFromSnapshot(snapshot),
    staleness: stalenessOf(snapshot.snapshotCreatedAt, cutoffAt),
    disclosure: SHARE_DISCLOSURE,
  };
}

/**
 * DECISIONS/0026 A9's second step: refine the freshness label once this device has answered, and change
 * nothing else. `routes/Share.svelte` renders the bill before the ledger is consulted, because a lookup can
 * wait on a migration gate this route deliberately does not show — so the label arrives after the numbers and
 * the view must be re-classifiable without a second decode.
 */
export function withStaleness(view: ShareView, staleLinkCutoffAt: string | null): ShareView {
  if (view.state !== "ready") return view;
  return { ...view, staleness: stalenessOf(view.snapshot.snapshotCreatedAt, staleLinkCutoffAt) };
}

/**
 * 0025 P6's four codes are a closed union, so a value outside it is not a code the view may show. Anything the
 * codec did not classify — a platform rejection, say — becomes `link_corrupt_or_tampered`, which is what a
 * link this build cannot read actually is. DECISIONS/0026 A15 fixed the one known escape, and the boundary
 * keeps the answer anyway: a person opening a link should get a sentence, not a blank screen.
 */
function classify(cause: unknown): ShareFailureCode {
  const code = (cause as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && (FAILURE_CODES as readonly string[]).includes(code)
    ? (code as ShareFailureCode)
    : "link_corrupt_or_tampered";
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
