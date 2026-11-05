import { describe, expect, it, vi } from "vitest";

import { encodeSnapshot, SHARE_FRAGMENT_MAX_BYTES, type BillShareSnapshot } from "../../src/lib/share/codec.js";
import {
  FAILURE_HEADLINES,
  openShareLink,
  SHARE_DISCLOSURE,
  SNAPSHOT_MAY_HAVE_CHANGED,
  type ShareView,
} from "../../src/lib/share/view.js";

/**
 * DECISIONS/0026 A8–A10, as assertions for the participant view's model.
 *
 * `openShareLink` throws `not implemented: DECISIONS/0026 A8 …`, so this file is red on exactly those pins.
 * The fragments are produced by the shipped codec rather than hand-written, because the pin is about what the
 * real link does — a fabricated string would let a view pass by matching a made-up shape. No component and no
 * browser: `routes/Share.svelte` renders this model, and `playwright/share.spec.ts` proves the DOM.
 */

const CREATED_AT = "2026-11-05T08:00:00.000Z";
const TOKEN = "3f1c2b7a-9d4e-4a61-8c2f-0b5e6d7a8c91";

function snapshot(over: Partial<BillShareSnapshot> = {}): BillShareSnapshot {
  return {
    snapshotVersion: 1,
    snapshotCreatedAt: CREATED_AT,
    bill: {
      id: "bill:view",
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
        unitAssignments: [{ unitIndex: 0, participantIds: ["p1", "p2"], confirmedUnassigned: false }],
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

function failed(view: ShareView): { code: string; headline: string; message: string } {
  if (view.state !== "failed") throw new Error(`expected a failure, got ${view.state}`);
  return view;
}

function ready(view: ShareView): Extract<ShareView, { state: "ready" }> {
  if (view.state !== "ready") throw new Error(`expected a bill, got ${view.state}`);
  return view;
}

describe("ticket 16 — /share decodes through the codec (DECISIONS/0026 A8)", () => {
  it("renders nothing for an empty fragment, which is not a failure", async () => {
    await expect(openShareLink("")).resolves.toEqual({ state: "empty" });
  });

  it("renders the snapshot, its own recomputation and the disclosure for a valid link", async () => {
    const original = snapshot();
    const view = ready(await openShareLink(await encodeSnapshot(original, TOKEN)));

    expect(view.snapshot).toEqual(original);
    expect(view.shares.shares.map((share) => [share.participantId, share.exactAmount])).toEqual([
      ["p1", { numeratorPaise: "5000", denominator: "1" }],
      ["p2", { numeratorPaise: "5000", denominator: "1" }],
    ]);
    expect(view.shares.mismatch).toBe(false);
    expect(view.disclosure).toBe(SHARE_DISCLOSURE);
    // 0025 P7's words, pinned: the link is a bearer secret, and one person's share is a display default.
    expect(view.disclosure).toContain("This link is the key.");
    expect(view.disclosure).toContain("It is a bearer secret, not protection from the person you send it to.");
    expect(view.disclosure).toContain("is a display default, not access control.");
    // A device with no copy of this bill cannot know freshness, and says so.
    expect(view.staleness).toEqual({ state: "unknown" });
    expect(SNAPSHOT_MAY_HAVE_CHANGED).toBe("The bill may have changed since.");
  });

  it("accepts the fragment with its leading #, because the codec strips it and the view must not fight that", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);

    expect(ready(await openShareLink(`#${fragment}`)).snapshot).toEqual(snapshot());
  });

  it("shows its own recomputation when the link's cache was forged, and renders anyway", async () => {
    const forged = snapshot({
      computedShares: [
        { participantId: "p1", exactAmount: { numeratorPaise: "999999", denominator: "1" }, settlementSharePaise: 999_999 },
        { participantId: "p2", exactAmount: { numeratorPaise: "1", denominator: "1" }, settlementSharePaise: 1 },
      ],
    });

    const view = ready(await openShareLink(await encodeSnapshot(forged, TOKEN)));

    expect(view.shares.mismatch).toBe(true);
    expect(view.shares.shares.map((share) => share.exactAmount)).toEqual([
      { numeratorPaise: "5000", denominator: "1" },
      { numeratorPaise: "5000", denominator: "1" },
    ]);
  });
});

describe("ticket 16 — every failure code, readably (DECISIONS/0026 A8, 0025 P6)", () => {
  it("fails closed on a tampered fragment with link_corrupt_or_tampered and no content", async () => {
    const parts = (await encodeSnapshot(snapshot(), TOKEN)).split(".");
    parts[3] = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;

    const view = failed(await openShareLink(parts.join(".")));

    expect(view.code).toBe("link_corrupt_or_tampered");
    expect(view.headline).toBe(FAILURE_HEADLINES.link_corrupt_or_tampered);
    expect(view.headline).toContain("Nothing was read from it.");
    expect(view.message).not.toBe("");
  });

  it("names a newer format as unsupported_link_version", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);

    const view = failed(await openShareLink(`v9.${fragment.slice(fragment.indexOf(".") + 1)}`));

    expect(view.code).toBe("unsupported_link_version");
    expect(view.headline).toContain("newer receipt-lens");
  });

  it("names an over-long fragment as link_budget_exceeded, before any decompression", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);
    const oversized = `${fragment}${"A".repeat(SHARE_FRAGMENT_MAX_BYTES)}`;

    const view = failed(await openShareLink(oversized));

    expect(view.code).toBe("link_budget_exceeded");
    expect(view.headline).toContain("shorten the bill's labels");
  });

  it("names a payload that is not a v1 snapshot as link_schema_invalid", async () => {
    const notASnapshot = { snapshotVersion: 2, anything: true } as unknown as BillShareSnapshot;

    const view = failed(await openShareLink(await encodeSnapshot(notASnapshot, TOKEN)));

    expect(view.code).toBe("link_schema_invalid");
    expect(view.headline).toContain("Nothing was rendered.");
  });

  it("renders no snapshot, shares or disclosure for any failure", async () => {
    const view = await openShareLink("v1.tok.AAAA.AAAA");

    expect(view.state).toBe("failed");
    expect("snapshot" in view).toBe(false);
    expect("shares" in view).toBe(false);
    expect("disclosure" in view).toBe(false);
  });

  it("fails closed rather than throwing when the codec raises something unexpected", async () => {
    // The view is the outer boundary: 0025 P6's promise is a readable message, not a white screen. A real
    // WebCrypto rejection is not constructible through the shipped codec, so the codec module itself is the
    // thing made to throw — and the pin is about what the view does with it.
    vi.resetModules();
    vi.doMock("../../src/lib/share/codec.js", () => ({
      decodeSnapshot: () => {
        throw new TypeError("the platform refused this key material");
      },
    }));
    const { openShareLink: openThroughAMock } = await import("../../src/lib/share/view.js");

    const view = failed(await openThroughAMock("v1.tok.AAAA.AAAA"));

    expect(view.code).toBe("link_corrupt_or_tampered");
    vi.doUnmock("../../src/lib/share/codec.js");
    vi.resetModules();
  });

  it("does not report a code outside 0025 P6's closed set", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/share/codec.js", () => ({
      decodeSnapshot: () => {
        throw Object.assign(new Error("made-up condition"), { code: "link_somehow_broke" });
      },
    }));
    const { openShareLink: openThroughAMock } = await import("../../src/lib/share/view.js");

    const view = failed(await openThroughAMock("v1.tok.AAAA.AAAA"));

    expect(view.code).toBe("link_corrupt_or_tampered");
    vi.doUnmock("../../src/lib/share/codec.js");
    vi.resetModules();
  });
});

describe("ticket 16 — staleness is shown on the view (DECISIONS/0026 A9)", () => {
  it("labels a snapshot taken before this bill's unlock stale, with the cutoff to name", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);

    const view = ready(
      await openShareLink(fragment, { cutoffOf: () => Promise.resolve("2026-11-05T12:00:00.000Z") })
    );

    expect(view.staleness).toEqual({ state: "stale", cutoffAt: "2026-11-05T12:00:00.000Z" });
    // Stale is a status, not a rewrite: the frozen numbers are still the ones on screen.
    expect(view.snapshot.bill.grandTotal).toBe(10_000);
  });

  it("calls a snapshot from this lock epoch current for this bill, and only that", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);

    const at = ready(await openShareLink(fragment, { cutoffOf: () => Promise.resolve(CREATED_AT) }));
    const before = ready(await openShareLink(fragment, { cutoffOf: () => Promise.resolve("2026-11-05T07:00:00.000Z") }));

    expect(at.staleness).toEqual({ state: "current_for_this_bill" });
    expect(before.staleness).toEqual({ state: "current_for_this_bill" });
  });

  it("says unknown, not current, when the lookup finds no local bill", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);

    const view = ready(await openShareLink(fragment, { cutoffOf: () => Promise.resolve(null) }));

    expect(view.staleness).toEqual({ state: "unknown" });
  });

  it("says unknown when the ledger itself is unavailable, and still renders the bill", async () => {
    const fragment = await encodeSnapshot(snapshot(), TOKEN);

    const view = ready(
      await openShareLink(fragment, {
        cutoffOf: () => Promise.reject(new Error("storage is gated or broken on this device")),
      })
    );

    expect(view.staleness).toEqual({ state: "unknown" });
    expect(view.snapshot.bill.title).toBe("Dinner");
  });
});
