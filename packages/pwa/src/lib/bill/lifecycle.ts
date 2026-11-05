import { compare, fromPaise } from "../exact-money.js";
import type { BillDocument } from "./document.js";

/**
 * DECISIONS/0022 L10 — the five states of §13, derived from the committed document and never stored.
 * A view renders this; it never keeps a state variable of its own, so the badge cannot disagree with the
 * document that produced it.
 */
export type LifecycleState = "draft" | "review_required" | "ready_to_lock" | "locked" | "settled";

export function lifecycleOf(document: BillDocument): LifecycleState {
  const { working } = document;
  if (working.bill.isLocked) return isSettled(document) ? "settled" : "locked";

  const clear = document.billValidation.blockers.locking.length === 0;
  // A lock attempt that has to finalize an item cannot succeed (0022 L3), so draft items keep it unready.
  if (clear && working.draftItems.length === 0) return "ready_to_lock";
  return document.revision === 0 ? "draft" : "review_required";
}

/**
 * "Every relevant participant is paid": not the payer (§11 rule 10 — the payer receives) and not owed exactly
 * zero (§12 rule 11 — no payment link). A bill with nobody to pay is not a vacuous settlement; it stays
 * `locked` until there is something to settle.
 */
function isSettled(document: BillDocument): boolean {
  const shares = document.derived.shares;
  if (shares === null) return false;

  const payerId = document.working.bill.payerId;
  const paid = new Map(
    document.working.participants.map((participant) => [participant.id, participant.paid]),
  );
  const relevant = shares.filter(
    (share) => share.participantId !== payerId && compare(share.exactAmount, fromPaise(0)) !== 0,
  );
  return relevant.length > 0 && relevant.every((share) => paid.get(share.participantId) === true);
}
