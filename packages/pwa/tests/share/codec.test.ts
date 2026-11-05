import { describe, expect, it } from "vitest";

import {
  decodeSnapshot,
  deriveKeyBytes,
  encodeSnapshot,
  type BillShareSnapshot,
} from "../../src/lib/share/codec.js";

/**
 * DECISIONS/0025, as assertions for the codec seam only. The stubs throw `not implemented: DECISIONS/0025 …`,
 * so this file is red on exactly these pins. No UI, no /share route, no authoring flow.
 */

const CREATED_AT = "2026-11-05T00:00:00.000Z";

function snapshot(over: Partial<BillShareSnapshot> = {}): BillShareSnapshot {
  return {
    snapshotVersion: 1,
    snapshotCreatedAt: CREATED_AT,
    bill: {
      id: "bill:1",
      title: "Dinner",
      creatorId: "p1",
      payerId: "p1",
      createdAt: CREATED_AT,
      grandTotal: 10_000,
      taxIncluded: null,
      taxIncludedSource: "unresolved",
    },
    participants: [
      { id: "p1", name: "Albus", tokenExpiresAt: "" },
      { id: "p2", name: "Bea", tokenExpiresAt: "" },
    ],
    items: [
      {
        id: "i1",
        name: "PLATTER",
        qty: 1,
        unitPrice: 10_000,
        unitAssignments: [
          { unitIndex: 0, participantIds: ["p1", "p2"], confirmedUnassigned: false },
        ],
      },
    ],
    charges: [],
    adjustmentLines: [],
    computedShares: [
      { participantId: "p1", exactAmount: { numeratorPaise: "5000", denominator: "1" }, settlementSharePaise: 5000 },
      { participantId: "p2", exactAmount: { numeratorPaise: "5000", denominator: "1" }, settlementSharePaise: 5000 },
    ],
    ...over,
  };
}

/** Deterministic but poorly compressible, so the budget pin is about bytes rather than DEFLATE's mood. */
function incompressible(length: number): string {
  return Array.from({ length }, (_, index) => String.fromCharCode(33 + ((index * 37) % 90))).join("");
}

const TOKEN = "3f1c2b7a-9d4e-4a61-8c2f-0b5e6d7a8c91";

describe("ticket 16 — round trip (DECISIONS/0025 P0 pin 1, P1, P2)", () => {
  it("encodes and decodes the minimal snapshot", async () => {
    const original = snapshot();
    const fragment = await encodeSnapshot(original, TOKEN);

    expect(fragment).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(fragment.split(".")).toHaveLength(4);
    await expect(decodeSnapshot(fragment, TOKEN)).resolves.toEqual(original);
  });

  it("round-trips a multi-participant bill with fractional exact shares", async () => {
    const original = snapshot({
      participants: [
        { id: "p1", name: "Albus", tokenExpiresAt: "" },
        { id: "p2", name: "Bea", tokenExpiresAt: "" },
        { id: "p3", name: "Cy", tokenExpiresAt: "" },
      ],
      computedShares: [
        { participantId: "p1", exactAmount: { numeratorPaise: "10000", denominator: "3" }, settlementSharePaise: 3334 },
        { participantId: "p2", exactAmount: { numeratorPaise: "10000", denominator: "3" }, settlementSharePaise: 3333 },
        { participantId: "p3", exactAmount: { numeratorPaise: "10000", denominator: "3" }, settlementSharePaise: 3333 },
      ],
    });

    await expect(decodeSnapshot(await encodeSnapshot(original, TOKEN), TOKEN)).resolves.toEqual(original);
  });

  it("accepts a fragment with its leading # and rejects padding", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);
    await expect(decodeSnapshot(`#${fragment}`, TOKEN)).resolves.toEqual(snapshot());
    await expect(decodeSnapshot(`${fragment}=`, TOKEN)).rejects.toMatchObject({
      code: "link_corrupt_or_tampered",
    });
  });

  it("uses a fresh nonce per encode, and both decode", async () => {
    const first = await encodeSnapshot(snapshot(), TOKEN);
    const second = await encodeSnapshot(snapshot(), TOKEN);

    expect(first).not.toBe(second);
    expect(first.split(".")[2]).not.toBe(second.split(".")[2]);
    await expect(decodeSnapshot(first, TOKEN)).resolves.toEqual(snapshot());
    await expect(decodeSnapshot(second, TOKEN)).resolves.toEqual(snapshot());
  });
});

describe("ticket 16 — HKDF (DECISIONS/0025 P3)", () => {
  it("is deterministic for one token and context, and changes with the token", async () => {
    const first = await deriveKeyBytes(TOKEN, "bill:1");
    const again = await deriveKeyBytes(TOKEN, "bill:1");
    const other = await deriveKeyBytes("another-token", "bill:1");

    expect(first).toHaveLength(32);
    expect(Array.from(first)).toEqual(Array.from(again));
    expect(Array.from(first)).not.toEqual(Array.from(other));
  });
});

describe("ticket 16 — version and budget (DECISIONS/0025 P5, P6)", () => {
  it("rejects an unknown version with unsupported_link_version", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);
    const rest = fragment.slice(fragment.indexOf(".") + 1);

    await expect(decodeSnapshot(`v2.${rest}`, TOKEN)).rejects.toMatchObject({
      code: "unsupported_link_version",
    });
  });

  it("allows exactly 8192 encoded bytes and refuses 8193 with link_budget_exceeded", async () => {
    // A deterministic boundary: the last component is padded to make the whole payload exactly 8192, then 8193.
    const head = "v1.";
    const tail = ".AAAA.BBBB";
    const fill = "A".repeat(8192 - head.length - tail.length);
    const exactly = `${head}${fill}${tail}`;
    expect(exactly).toHaveLength(8192);

    // 8192 passes the budget check and fails later as corruption, never as a budget error.
    await expect(decodeSnapshot(exactly, TOKEN)).rejects.toMatchObject({
      code: "link_corrupt_or_tampered",
    });
    await expect(decodeSnapshot(`${exactly}A`, TOKEN)).rejects.toMatchObject({
      code: "link_budget_exceeded",
    });
  });

  it("refuses to encode an over-budget snapshot instead of truncating it", async () => {
    await expect(
      encodeSnapshot(snapshot({ bill: { ...snapshot().bill, title: incompressible(20_000) } }), TOKEN)
    ).rejects.toMatchObject({ code: "link_budget_exceeded" });
  });
});

describe("ticket 16 — tamper and malformed input (DECISIONS/0025 P6)", () => {
  it("detects a flipped ciphertext character", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);
    const parts = fragment.split(".");
    const ciphertext = parts[3]!;
    parts[3] = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;

    await expect(decodeSnapshot(parts.join("."), TOKEN)).rejects.toMatchObject({
      code: "link_corrupt_or_tampered",
    });
  });

  it("detects the wrong token", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);
    await expect(decodeSnapshot(fragment, "a-different-token")).rejects.toMatchObject({
      code: "link_corrupt_or_tampered",
    });
  });

  it("rejects missing components and a bad charset", async () => {
    await expect(decodeSnapshot("v1.only.two", TOKEN)).rejects.toMatchObject({
      code: "link_corrupt_or_tampered",
    });
    await expect(decodeSnapshot("v1.a.b.c!", TOKEN)).rejects.toMatchObject({
      code: "link_corrupt_or_tampered",
    });
  });
});

describe("ticket 16 — schema (DECISIONS/0025 P6)", () => {
  it("rejects well-formed JSON that is not a v1 snapshot", async () => {
    const notASnapshot = { snapshotVersion: 2, anything: true } as unknown as BillShareSnapshot;
    const fragment = await encodeSnapshot(notASnapshot, TOKEN);

    await expect(decodeSnapshot(fragment, TOKEN)).rejects.toMatchObject({
      code: "link_schema_invalid",
    });
  });
});
