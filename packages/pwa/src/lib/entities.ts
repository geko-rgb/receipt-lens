import type { ParticipantId, ValueSource, FinalQuantitySource, FinalPriceSource } from "@receipt-lens/core";

/**
 * PWA data model per PROJECT(1).md §10 — these entities are PWA-owned,
 * not part of @receipt-lens/core.
 */

export type ChargeType = "tax" | "service_charge" | "tip" | "discount" | "round_off" | "other";

/**
 * Exact rational amount in paise. numeratorPaise/denominator is reduced; denominator > 0.
 * Decimal strings keep this representation lossless in JSON/IndexedDB/share snapshots.
 */
export type ExactMoney = { numeratorPaise: string; denominator: string };

export interface Bill {
  id: string;
  title: string;
  creatorId: ParticipantId;
  payerId: ParticipantId;
  createdAt: string;
  isLocked: boolean;
  taxIncluded: boolean | null;
  taxIncludedSource: ValueSource;
  /** integer paise; preserve parsed/confirmed receipt total; never auto-overwrite */
  grandTotal: number | null;
  grandTotalSource: ValueSource;
  adjustmentLines: AdjustmentLine[];
}

export interface Participant {
  id: string;
  billId: string;
  name: string;
  paid: boolean;
  token: string;
  tokenExpiresAt: string;
}

export interface Item {
  id: string;
  billId: string;
  name: string;
  /** positive and resolved */
  qty: number;
  quantitySource: FinalQuantitySource;
  /** resolved integer paise */
  unitPrice: number;
  priceSource: FinalPriceSource;
  lineTotal: number;
  detectedLineTotal: number | null;
  confidence: number | null;
  assumedQtyReviewed: boolean;
}

export interface ItemUnit {
  id: string;
  itemId: string;
  /** 0..qty-1; unique per item */
  unitIndex: number;
  /** true only after explicit creator acknowledgement */
  confirmedUnassigned: boolean;
}

export interface ItemUnitAssignment {
  itemUnitId: string;
  participantId: ParticipantId;
}

export interface BillCharge {
  id: string;
  billId: string;
  type: ChargeType;
  label: string;
  /** integer paise; round_off is signed, others use a magnitude */
  amount: number;
  rate?: number | null;
  /** finalized charge: inclusion confirmed */
  included: boolean;
  otherSign?: "add" | "subtract" | "unknown";
  source: "detected" | "user_confirmed";
}

/** v1 has exactly one adjustment reason: "unassigned" */
export interface AdjustmentLine {
  id: string;
  billId: string;
  reason: "unassigned";
  /** integer paise, added to creator payable share */
  amount: number;
  assignedToParticipantId: ParticipantId;
}

/** The resolved, finalized state the split engine consumes. */
export interface SplittableBill {
  bill: Bill;
  participants: Participant[];
  items: Item[];
  itemUnits: ItemUnit[];
  assignments: ItemUnitAssignment[];
  charges: BillCharge[];
}
