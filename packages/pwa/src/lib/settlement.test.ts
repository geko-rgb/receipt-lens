import { describe, expect, it } from "vitest";
import type { ExactMoney } from "./entities.js";
import { add, divInt, fromPaise } from "./exact-money.js";
import { allocateSettlement, type ParticipantShare } from "./settlement.js";

const em = (n: string, d = "1"): ExactMoney => ({ numeratorPaise: n, denominator: d });

describe("settlement allocation — transfer boundary only", () => {
  const golden: ParticipantShare[] = [
    { participantId: "P1", exactAmount: em("24635", "3") },
    { participantId: "P2", exactAmount: em("72710", "3") },
    { participantId: "P3", exactAmount: em("24635", "3") },
    { participantId: "P4", exactAmount: em("870") },
    { participantId: "P5", exactAmount: em("24870") },
  ];

  it("largest remainder reproduces the spec's golden payment amounts exactly", () => {
    const settlement = allocateSettlement(golden, 66400);
    expect(settlement).toEqual([
      { participantId: "P1", settlementSharePaise: 8212 },
      { participantId: "P2", settlementSharePaise: 24237 },
      { participantId: "P3", settlementSharePaise: 8211 },
      { participantId: "P4", settlementSharePaise: 870 },
      { participantId: "P5", settlementSharePaise: 24870 },
    ]);
  });

  it("settlement amounts sum exactly to the confirmed grand total", () => {
    const sum = allocateSettlement(golden, 66400).reduce((s, x) => s + x.settlementSharePaise, 0);
    expect(sum).toBe(66400);
  });

  it("never mutates the exact shares — they remain the rational source of truth", () => {
    const before = structuredClone(golden);
    allocateSettlement(golden, 66400);
    expect(golden).toEqual(before);
  });

  it("remainder ties between equal fractional parts go to the stable lower participant id", () => {
    const half = divInt(fromPaise(1), 2); // 0.5 each → one extra paisa to break the tie
    const shares: ParticipantShare[] = [
      { participantId: "B", exactAmount: add(fromPaise(10), half) },
      { participantId: "A", exactAmount: add(fromPaise(10), half) },
    ];
    const result = allocateSettlement(shares, 21);
    expect(result.find((r) => r.participantId === "A")!.settlementSharePaise).toBe(11);
    expect(result.find((r) => r.participantId === "B")!.settlementSharePaise).toBe(10);
  });

  it("a target the floors cannot reach is rejected, not silently padded", () => {
    expect(() => allocateSettlement([{ participantId: "P1", exactAmount: fromPaise(10) }], 25)).toThrow();
  });
});
