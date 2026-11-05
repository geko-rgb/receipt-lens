import type { BillDocument } from "./document.js";

/**
 * DECISIONS/0022 L10 — the five states of §13, derived from the committed document and never stored.
 * A view renders this; it never keeps a state variable of its own, so the badge cannot disagree with the
 * document that produced it.
 */
export type LifecycleState = "draft" | "review_required" | "ready_to_lock" | "locked" | "settled";

/** Stub until the ticket-13 implementation lands. See DECISIONS/0022 L10 for the pinned rules. */
export function lifecycleOf(document: BillDocument): LifecycleState {
  void document;
  throw new Error("not implemented: DECISIONS/0022 L10 — the derived lifecycle state");
}
