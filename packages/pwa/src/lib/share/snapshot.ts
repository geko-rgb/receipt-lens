import { deepFreeze, type BillDocument } from "../bill/document.js";
import { isIntegerPaise, type FinalPriceSource, type FinalQuantitySource, type ValueSource } from "../bill/working-bill.js";
import { compare } from "../exact-money.js";
import type {
  AdjustmentLine,
  Bill,
  BillCharge,
  ExactMoney,
  Item,
  ItemUnit,
  ItemUnitAssignment,
  Participant,
  SplittableBill,
} from "../entities.js";
import { allocateSettlement } from "../settlement.js";
import { computeExactShares } from "../splitting.js";
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
 * DECISIONS/0026 A1. All three codes are pre-existing vocabulary — `bill_locked` is 0022 L2's refusal, the
 * other two are §10's locking blockers read back as guards. `bill_locked` is the only one a caller can reach.
 */
export type SnapshotAssemblyCode = "bill_locked" | "grand_total_missing" | "units_unassigned";

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

type SnapshotCharge = BillShareSnapshot["charges"][number];
type SnapshotShare = BillShareSnapshot["computedShares"][number];

const VALUE_SOURCES: readonly ValueSource[] = ["detected", "unresolved", "user_confirmed"];

/**
 * §10 types `BillShareSnapshot.bill.taxIncludedSource` as a string (0025 P4), and the split engine never reads
 * it — `taxIncluded` is a summary hint, not an arithmetic input. So an unrecognised value answers
 * "unresolved", which is the one thing a recipient is never allowed to be handed: a provenance claim the link
 * did not make.
 */
function valueSourceOf(text: string): ValueSource {
  return VALUE_SOURCES.includes(text as ValueSource) ? (text as ValueSource) : "unresolved";
}

/**
 * §10's shape, assembled from a committed locked document and nothing else.
 *
 * Built field by field rather than by projecting `working`, which is what makes DECISIONS/0026 A3's exclusions
 * the default: nothing enters the payload unless it is named here. Order is the contract of A2 — the roster's
 * order, the document's item and charge order, and ascending `unitIndex` — so a second assemble of an
 * unchanged bill is byte-identical.
 */
export function assembleSnapshot(
  document: BillDocument,
  options: { readonly now: string }
): BillShareSnapshot {
  const { working, derived } = document;
  const bill = working.bill;
  if (!bill.isLocked) {
    throw new ShareAssemblyError("bill_locked", "a share snapshot freezes a locked bill (DECISIONS/0026 A1)");
  }
  // Defensive narrowing: 0022 L3's invariant means a committed locked document has neither of these states.
  if (!isIntegerPaise(bill.grandTotal)) {
    throw new ShareAssemblyError("grand_total_missing", "a locked bill's grand total is resolved integer paise");
  }
  if (derived.shares === null) {
    throw new ShareAssemblyError("units_unassigned", "a locked bill has its units assigned or acknowledged");
  }

  const roster = working.participants;
  const holdersOf = (itemUnitId: string): string[] =>
    roster
      .filter((participant) =>
        working.assignments.some(
          (assignment) => assignment.itemUnitId === itemUnitId && assignment.participantId === participant.id
        )
      )
      .map((participant) => participant.id);

  const items = working.items.map((item) => ({
    id: item.id,
    name: item.name,
    qty: item.qty,
    unitPrice: item.unitPrice,
    unitAssignments: working.itemUnits
      .filter((unit) => unit.itemId === item.id)
      .sort((earlier, later) => earlier.unitIndex - later.unitIndex)
      .map((unit) => ({
        unitIndex: unit.unitIndex,
        participantIds: holdersOf(unit.id),
        confirmedUnassigned: unit.confirmedUnassigned,
      })),
  }));

  const charges = working.charges.map((charge) => ({
    type: charge.type,
    label: charge.label,
    amount: charge.amount,
    included: charge.included,
    ...(charge.rate === undefined ? {} : { rate: charge.rate }),
    ...(charge.otherSign === "add" || charge.otherSign === "subtract" ? { otherSign: charge.otherSign } : {}),
  })) satisfies readonly SnapshotCharge[];

  const adjustmentLines = bill.adjustmentLines.map((line) => ({
    reason: line.reason,
    amount: line.amount,
    assignedToParticipantId: line.assignedToParticipantId,
  }));

  // The cache is the runner's own answer over the document, which is what makes A6's recomputation over the
  // projection a second opinion rather than an echo: if assembly and the projection silently disagreed, the
  // recipient's mismatch flag would be the thing that says so.
  const settlement = allocationOf(derived.shares, derived.printedGrandTotal ?? derived.calculatedPayableTotal);
  const computedShares = derived.shares.map((share) => ({
    participantId: share.participantId,
    exactAmount: { numeratorPaise: share.exactAmount.numeratorPaise, denominator: share.exactAmount.denominator },
    settlementSharePaise: settlement?.get(share.participantId) ?? null,
  })) satisfies readonly SnapshotShare[];

  return deepFreeze({
    snapshotVersion: 1,
    snapshotCreatedAt: options.now,
    bill: {
      id: bill.id,
      title: bill.title,
      creatorId: bill.creatorId,
      payerId: bill.payerId,
      createdAt: bill.createdAt,
      grandTotal: bill.grandTotal,
      taxIncluded: bill.taxIncluded,
      taxIncludedSource: bill.taxIncludedSource,
    },
    participants: roster.map((participant) => ({
      id: participant.id,
      name: participant.name,
      tokenExpiresAt: participant.tokenExpiresAt,
    })),
    items,
    charges,
    adjustmentLines,
    computedShares,
  });
}

/**
 * §12's transfer-boundary conversion, or null for everyone when it refuses. 0024 S8-4's inconsistent-total
 * condition is reported by the settlement panel, so the cache says "not computable" in the one way §10's
 * `number | null` allows rather than inventing a second refusal surface.
 */
function allocationOf(
  shares: readonly { participantId: string; exactAmount: ExactMoney }[],
  confirmedTotalPaise: number
): Map<string, number> | null {
  try {
    return new Map(
      allocateSettlement([...shares], confirmedTotalPaise).map((entry) => [
        entry.participantId,
        entry.settlementSharePaise,
      ])
    );
  } catch {
    return null;
  }
}

/**
 * The join the split engine needs, synthesized from the snapshot alone (DECISIONS/0026 A6).
 *
 * The unit and assignment ids here are *local* identity for the join, never snapshot content, so A3's ban on
 * internal ids is untouched. `Item`'s provenance fields and `Participant`'s settlement fields are filled with
 * the only values a resolved bill could carry: `computeExactShares` reads ids, prices, quantities, units,
 * assignments, charge amounts, inclusion flags and adjustment lines, and nothing else (§11).
 */
export function splittableFromSnapshot(snapshot: BillShareSnapshot): SplittableBill {
  const bill: Bill = {
    id: snapshot.bill.id,
    title: snapshot.bill.title,
    creatorId: snapshot.bill.creatorId,
    payerId: snapshot.bill.payerId,
    createdAt: snapshot.bill.createdAt,
    isLocked: true,
    grandTotal: snapshot.bill.grandTotal,
    // §10's snapshot carries the resolved total and no provenance for it (0025 P4), so the only honest answer
    // about how this device knows the number is "unresolved". The split engine reads `grandTotal` alone, and
    // never this field, so the absence is a fact not carried rather than a fact invented.
    grandTotalSource: "unresolved",
    taxIncluded: snapshot.bill.taxIncluded,
    taxIncludedSource: valueSourceOf(snapshot.bill.taxIncludedSource),
    adjustmentLines: snapshot.adjustmentLines.map(
      (line, index): AdjustmentLine => ({
        id: `snapshot:adjustment:${index}`,
        billId: snapshot.bill.id,
        reason: line.reason,
        amount: line.amount,
        assignedToParticipantId: line.assignedToParticipantId,
      })
    ),
  };

  const items: Item[] = snapshot.items.map((item) => ({
    id: item.id,
    billId: snapshot.bill.id,
    name: item.name,
    qty: item.qty,
    quantitySource: "explicit" as FinalQuantitySource,
    unitPrice: item.unitPrice,
    priceSource: "detected" as FinalPriceSource,
    lineTotal: item.qty * item.unitPrice,
    detectedLineTotal: null,
    confidence: null,
    assumedQtyReviewed: true,
  }));

  const itemUnits: ItemUnit[] = snapshot.items.flatMap((item) =>
    item.unitAssignments.map((unit) => ({
      id: `${item.id}#${unit.unitIndex}`,
      itemId: item.id,
      unitIndex: unit.unitIndex,
      confirmedUnassigned: unit.confirmedUnassigned,
    }))
  );

  const assignments: ItemUnitAssignment[] = snapshot.items.flatMap((item) =>
    item.unitAssignments.flatMap((unit) =>
      unit.participantIds.map((participantId) => ({
        itemUnitId: `${item.id}#${unit.unitIndex}`,
        participantId,
      }))
    )
  );

  const participants: Participant[] = snapshot.participants.map((participant) => ({
    id: participant.id,
    billId: snapshot.bill.id,
    name: participant.name,
    paid: false,
    token: "",
    tokenExpiresAt: participant.tokenExpiresAt,
  }));

  const charges: BillCharge[] = snapshot.charges.map((charge, index) => ({
    id: `snapshot:charge:${index}`,
    billId: snapshot.bill.id,
    type: charge.type,
    label: charge.label,
    amount: charge.amount,
    rate: charge.rate ?? null,
    included: charge.included,
    ...(charge.otherSign === undefined ? {} : { otherSign: charge.otherSign }),
    source: "detected" as const,
  }));

  return { bill, participants, items, itemUnits, assignments, charges };
}

/**
 * Recompute shares and settlement amounts from the snapshot, then check them against its cache
 * (DECISIONS/0026 A6). §10: "Shares are recomputed on load and never trusted from a cache."
 */
export function sharesFromSnapshot(snapshot: BillShareSnapshot): SnapshotShares {
  const { shares } = computeExactShares(splittableFromSnapshot(snapshot));
  const names = new Map(snapshot.participants.map((participant) => [participant.id, participant.name]));
  const settlement = allocationOf(shares, snapshot.bill.grandTotal);

  const recomputed = shares.map((share) => ({
    participantId: share.participantId,
    name: names.get(share.participantId) ?? "",
    exactAmount: share.exactAmount,
    settlementSharePaise: settlement?.get(share.participantId) ?? null,
  }));

  const mismatch =
    recomputed.length !== snapshot.computedShares.length ||
    recomputed.some((share, index) => {
      const cached = snapshot.computedShares[index];
      if (cached === undefined || cached.participantId !== share.participantId) return true;
      if (compare(cached.exactAmount, share.exactAmount) !== 0) return true;
      return cached.settlementSharePaise !== share.settlementSharePaise;
    });

  return deepFreeze({ shares: recomputed, mismatch });
}

/**
 * The one comparison 0022 L6's `staleLinkCutoffAt` was created for (DECISIONS/0026 A9). Strictly less-than: a
 * snapshot taken at the cutoff instant belongs to this lock epoch.
 */
export function stalenessOf(snapshotCreatedAt: string, staleLinkCutoffAt: string | null): Staleness {
  if (staleLinkCutoffAt === null) return { state: "unknown" };
  return Date.parse(snapshotCreatedAt) < Date.parse(staleLinkCutoffAt)
    ? { state: "stale", cutoffAt: staleLinkCutoffAt }
    : { state: "current_for_this_bill" };
}
