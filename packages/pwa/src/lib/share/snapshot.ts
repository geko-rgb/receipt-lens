import type { BillDocument } from "../bill/document.js";
import type { ExactMoney, SplittableBill } from "../entities.js";
import type { BillShareSnapshot } from "./codec.js";

/**
 * Ticket 16 — assembling §10's `BillShareSnapshot` from a locked bill, and re-deriving it on the other side
 * (DECISIONS/0026 A1–A6, A9).
 *
 * Framework-free, and the same discipline as the codec: no clock read inside, because `snapshotCreatedAt` is a
 * comparison a staleness rule depends on and a test must be able to pin it (0011's determinism rule, restated
 * by 0022 L5 for `lockBill`'s `now`).
 */

/**
 * DECISIONS/0026 A1. Both codes come from vocabulary that already exists: `bill_locked` is 0022 L2's refusal
 * and `grand_total_missing` is one of §10's nine locking blockers.
 */
export type SnapshotAssemblyCode = "bill_locked" | "grand_total_missing";

export class ShareAssemblyError extends Error {
  readonly code: SnapshotAssemblyCode;

  constructor(code: SnapshotAssemblyCode, message: string) {
    super(message);
    this.name = "ShareAssemblyError";
    this.code = code;
  }
}

/** DECISIONS/0026 A6: the recipient's own numbers, plus whether they disagree with the link's cache. */
export interface SnapshotShares {
  readonly shares: ReadonlyArray<{
    readonly participantId: string;
    readonly name: string;
    readonly exactAmount: ExactMoney;
    readonly settlementSharePaise: number | null;
  }>;
  /** True when a cached `computedShares` entry is not exactly the recomputation. The cache is not authority. */
  readonly mismatch: boolean;
}

/** DECISIONS/0026 A9. Three states because the honest answer includes "this device cannot know". */
export type Staleness =
  | { readonly state: "stale"; readonly cutoffAt: string }
  | { readonly state: "current_for_this_bill" }
  | { readonly state: "unknown" };

/** §10's shape, assembled from a committed locked document and nothing else. */
export function assembleSnapshot(
  _document: BillDocument,
  _options: { readonly now: string }
): BillShareSnapshot {
  throw new Error("not implemented: DECISIONS/0026 A1 assembleSnapshot");
}

/** The join the split engine needs, synthesized from the snapshot alone (A6). */
export function splittableFromSnapshot(_snapshot: BillShareSnapshot): SplittableBill {
  throw new Error("not implemented: DECISIONS/0026 A6 splittableFromSnapshot");
}

/** Recompute shares and settlement amounts from the snapshot, and check them against its cache (A6). */
export function sharesFromSnapshot(_snapshot: BillShareSnapshot): SnapshotShares {
  throw new Error("not implemented: DECISIONS/0026 A6 sharesFromSnapshot");
}

/** The one comparison 0022 L6's `staleLinkCutoffAt` was created for (A9). */
export function stalenessOf(_snapshotCreatedAt: string, _staleLinkCutoffAt: string | null): Staleness {
  throw new Error("not implemented: DECISIONS/0026 A9 stalenessOf");
}
