import { compare, floorPaise, fromPaise, sub } from "./exact-money.js";
import type { ParticipantShare } from "./splitting.js";

export interface SettlementAllocation {
  participantId: string;
  settlementSharePaise: number;
}

/**
 * Largest-remainder conversion at the UPI transfer boundary (§12). Floors first,
 * remaining paise one each by descending fractional remainder, ties by stable
 * participant id. Exact shares are never mutated.
 */
export function allocateSettlement(
  shares: ParticipantShare[],
  confirmedGrandTotalPaise: number
): SettlementAllocation[] {
  const target = BigInt(confirmedGrandTotalPaise);
  const entries = shares.map((s) => {
    const floor = floorPaise(s.exactAmount);
    return {
      participantId: s.participantId,
      floor,
      remainder: sub(s.exactAmount, fromPaise(floor)),
    };
  });
  const sumFloors = entries.reduce((acc, e) => acc + e.floor, 0n);
  const spare = target - sumFloors;
  if (spare < 0n || spare > BigInt(entries.length - 1)) {
    // TODO(ticket 13): map to lock blocker at the throw site
    throw new Error("settlement target inconsistent with exact shares");
  }

  const ordered = [...entries].sort((a, b) => {
    const byRemainder = compare(b.remainder, a.remainder);
    return byRemainder !== 0 ? byRemainder : a.participantId.localeCompare(b.participantId);
  });
  const winners = new Set(ordered.slice(0, Number(spare)).map((e) => e.participantId));

  return entries.map((e) => ({
    participantId: e.participantId,
    settlementSharePaise: Number(e.floor + (winners.has(e.participantId) ? 1n : 0n)),
  }));
}
