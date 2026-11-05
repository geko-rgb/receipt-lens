import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { validate } from "@receipt-lens/core";
import type { ParsedItem, ParseResult, UnclassifiedRow } from "@receipt-lens/core";

import type { BillDocument } from "../../src/lib/bill/document.js";
import { billStore } from "../../src/lib/bill/bill-document.svelte.js";
import { creatorNameFor } from "../../src/lib/bill/mapping.js";
import {
  addParticipant,
  beginFrom,
  deleteItem,
  rebuildDocument,
  setItemPrice,
  type TransactionResult,
} from "../../src/lib/bill/transactions.js";
import type { CaptureDraft } from "../../src/lib/draft.js";
import type { CreatorProfile } from "../../src/lib/entities.js";
import type { DatabaseHandle, GateNeeded, OpenDatabaseOptions, UpgradeDispatch } from "../../src/lib/storage/database.js";
import {
  DatabaseVersionTooNewError,
  MigrationFailedError,
  UpgradeDeclinedError,
  openDatabase,
  readStoredVersion,
} from "../../src/lib/storage/database.js";
import {
  deleteBill,
  deleteRetainedImage,
  exportJson,
  hasRetainedImage,
  listBills,
  loadBill,
  loadCreatorProfile,
  mostRecentBill,
  putRetainedImage,
  saveBill,
  saveCreatorProfile,
  saveFailureKind,
} from "../../src/lib/storage/repository.js";
import {
  CREATOR_PROFILE_ID,
  decodeBillRecord,
  encodeBillRecord,
  type StoredBillRecord,
} from "../../src/lib/storage/records.js";
import type { SessionOptions, StorageSession } from "../../src/lib/storage/session.js";
import { createSession } from "../../src/lib/storage/session.js";
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  MIGRATIONS,
  STORE_NAMES,
  droppedFieldPaths,
  requiresExport,
  type MigrationStep,
} from "../../src/lib/storage/schema.js";

/**
 * Ticket 14 — DECISIONS/0023 P1–P10, as assertions.
 *
 * Written before the implementation, deliberately: every function in `src/lib/storage/`, plus
 * `rebuildDocument` and `creatorNameFor`, throws `not implemented: DECISIONS/0023 P…`, so this file is red on
 * exactly the pins of this ticket and on nothing else. Each test cites the pin it discharges, so a rule that
 * later vanishes from the code fails its named test rather than passing silently.
 *
 * Two things about how these tests are built, because both differ from the other suites:
 *
 * 1. **Storage is tested against a real IndexedDB implementation, not a mock of this module.** Every test
 *    gets its own `new FakeIDBFactory()` from `fake-indexeddb`, so no test can see another's database and the
 *    abort, rollback and version-change behaviour is the spec's rather than a stand-in that agrees with
 *    whatever the author of the code assumed. P9's Chromium agreement test in
 *    `playwright/persistence.spec.ts` is what makes that fidelity a measurement instead of a trust claim.
 * 2. **The "before" state of every migration test is a committed artifact.** `fixtures/v1-bills.json` is a
 *    dump of what `bills` actually held, produced by the app's own save path in Chromium by
 *    `pnpm generate:storage-fixtures`, and CI re-runs the generator and fails on `git diff --exit-code`
 *    (P9). A hand-built record is a story about what someone thought the shape was; a fixture is evidence of
 *    what the code wrote.
 */

const CREATED_AT = "2026-11-05T00:00:00.000Z";
const SAVED_AT = "2026-11-05T00:00:01.000Z";
const LATER_AT = "2026-11-05T00:00:02.000Z";

const STORAGE_DIR = path.join(import.meta.dirname!, "../../src/lib/storage");
const FIXTURE_DIR = path.join(import.meta.dirname!, "fixtures");

// ── harness ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The committed v1 records — every file `scripts/storage-fixtures.mjs` wrote, merged. There is no fallback to
 * a hand-built record, and that is the whole of P9: a missing file fails with the command that produces it.
 *
 * Sorted by key so a fixture regenerated in a different scenario order cannot reorder a test's expectations.
 */
function fixtureBills(): StoredBillRecord[] {
  const files = existsSync(FIXTURE_DIR)
    ? readdirSync(FIXTURE_DIR)
        .filter((name) => name.startsWith("v1-") && name.endsWith(".json"))
        .sort()
        .map((name) => path.join(FIXTURE_DIR, name))
    : [];
  if (files.length === 0) {
    throw new Error(
      `no committed v1 fixtures in ${FIXTURE_DIR} — run \`pnpm generate:storage-fixtures\` (DECISIONS/0023 P9): ` +
        "a migration test that starts from an invented record is not a migration test.",
    );
  }
  const bills = files.flatMap((file) => {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { bills?: StoredBillRecord[] };
    if (!Array.isArray(raw.bills)) throw new Error(`${file} must hold a \`bills\` array of stored records`);
    return raw.bills;
  });
  expect(bills.length).toBeGreaterThan(0);
  return [...bills].sort((a, b) => (a.billId < b.billId ? -1 : 1));
}

/** The committed profile row and the committed retained-image row, from the scenario that made them. */
function fixtureStore(store: "creatorProfile" | "retainedImages"): Record<string, unknown>[] {
  const file = path.join(FIXTURE_DIR, "v1-profile-and-image.json");
  if (!existsSync(file)) throw new Error(`missing ${file} — run \`pnpm generate:storage-fixtures\` (P9)`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { _meta?: unknown } & Record<string, unknown>;
  expect(Array.isArray(raw[store])).toBe(true);
  return raw[store] as Record<string, unknown>[];
}

/** Opens the shipped chain, answering the gate as a user who exported would. */
function openHandle(factory: IDBFactory, over: Partial<OpenDatabaseOptions> = {}): Promise<DatabaseHandle> {
  return openDatabase({ factory, onGate: () => Promise.resolve("exported" as const), ...over });
}

/** Reads the database at whatever version it is at, bypassing the gate — for asserting state after a failure. */
async function openAtStoredVersion(factory: IDBFactory): Promise<IDBDatabase> {
  const version = await readStoredVersion(factory);
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Captures a failure whether it arrives synchronously or as a rejection. The stubs throw synchronously and
 * the implementations return rejected promises, and a test that only accepted one of the two would pass at
 * the wrong moment — which is the opposite of what this file is for.
 */
async function failureOf(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return null;
}

function request<T>(operation: () => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let pending: IDBRequest<T>;
    try {
      pending = operation();
    } catch (cause) {
      reject(cause);
      return;
    }
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
}

/** Raw IndexedDB access, deliberately bypassing the module under test: for seeding and for inspecting. */
function rawPut(database: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    transaction.objectStore(store).put(value as never);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function rawGet(database: IDBDatabase, store: string, key: IDBValidKey): Promise<unknown> {
  return request(() => database.transaction(store).objectStore(store).get(key));
}

function rawCount(database: IDBDatabase, store: string): Promise<number> {
  return request(() => database.transaction(store).objectStore(store).count());
}

function storageSource(): string {
  return ["session.ts", "repository.ts", "database.ts", "records.ts", "schema.ts"]
    .map((file) => readFileSync(path.join(STORAGE_DIR, file), "utf8"))
    .join("\n");
}

// ── bill fixtures ──────────────────────────────────────────────────────────────────────────────────────

function parsedItem(id: string, over: Partial<ParsedItem> = {}): ParsedItem {
  return {
    id,
    name: `Item ${id}`,
    qty: 1,
    quantitySource: "explicit",
    unitPrice: 10_000,
    priceSource: "detected",
    lineTotal: 10_000,
    confidence: null,
    sourceLineIds: [`line-${id}`],
    warnings: [],
    ...over,
  };
}

function ambiguousRow(id: string): UnclassifiedRow {
  return {
    id,
    text: "NAAN 60.00",
    box: { x: 0, y: 10, width: 100, height: 12 },
    sourceLineIds: [`line-${id}`],
    reason: "ambiguous",
    warningCode: "ambiguous_row",
  };
}

function parseOf(over: Partial<ParseResult> = {}): ParseResult {
  return {
    items: [parsedItem("i1"), parsedItem("i2", { qty: 2, unitPrice: 32_050, lineTotal: null })],
    unclassifiedRows: [],
    taxes: [],
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    otherCharges: [],
    subtotal: 10_000,
    subtotalSource: "detected",
    grandTotal: 42_050,
    grandTotalSource: "detected",
    warnings: [],
    ...over,
  };
}

function begin(billId = "b1", over: Partial<ParseResult> = {}): BillDocument {
  const parse = parseOf(over);
  return beginFrom(parse, validate(parse), { billId, createdAt: CREATED_AT, creatorName: "Creator" });
}

function ok(result: TransactionResult): BillDocument {
  if (!result.ok) throw new Error(`expected success, got ${result.reject.code} [${result.reject.refs.join(", ")}]`);
  return result.document;
}

/** A bill built the way the editor builds one: the accepted import, then a committed price edit. Revision 1. */
function edited(billId = "b1"): BillDocument {
  return ok(setItemPrice(begin(billId), "i1", 12_345));
}

function draftOf(over: Partial<CaptureDraft> = {}): CaptureDraft {
  const parse = parseOf();
  return { items: parse.items, charges: [], parse, validation: validate(parse), ...over };
}

function session(factory: IDBFactory, over: Partial<SessionOptions> = {}): StorageSession {
  return createSession({ factory, now: () => SAVED_AT, ...over });
}

/** One bill, written through the real save path, on a private factory. */
async function saved(factory: IDBFactory, document: BillDocument = edited()): Promise<StorageSession> {
  const open = session(factory);
  await open.persist(document);
  await open.flush();
  return open;
}

// ── rig-only migration steps (P9: never in the shipped chain) ──────────────────────────────────────────

/** Adds a field to every bill record — the shape most v2-style steps will be, and provably lossless. */
function additiveStep(field = "rigField"): MigrationStep {
  return {
    from: 1,
    description: `test-only: add ${field} to every bill record`,
    lossless: { lossless: true, clauses: ["L1", "L2", "L3", "L4"] },
    up: (transaction) => {
      const store = transaction.objectStore("bills");
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        const record = at.value as Record<string, unknown>;
        record[field] = "added";
        // An inline keyPath store: passing the cursor's key alongside the value is a DataError, which is the
        // IndexedDB API rejecting the write, not this app's rule.
        store.put(record);
        at.continue();
      };
    },
  };
}

/** Removes a field every record has — lossy by P4's L1, so it must not run before an export exists. */
function reductiveStep(): MigrationStep {
  return {
    from: 1,
    description: "test-only: drop working.excludedRowIds from every bill record",
    lossless: { lossless: false, reason: "L1: removes a field present in every record" },
    up: (transaction) => {
      const store = transaction.objectStore("bills");
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        const record = at.value as { working: Record<string, unknown> };
        delete record.working.excludedRowIds;
        store.put(record);
        at.continue();
      };
    },
  };
}

/** Writes, then fails. The abort and rollback fixture. */
function throwingStep(): MigrationStep {
  return {
    from: 1,
    description: "test-only: writes a record, then throws",
    lossless: { lossless: false, reason: "test-only step" },
    up: (transaction) => {
      transaction.objectStore("bills").put({ billId: "half-written", revision: 99, savedAt: SAVED_AT, working: null });
      throw new Error("the migration itself failed");
    },
  };
}

/** Creates a store, then fails: the schema half of the rollback promise. */
function orphanStoreThenThrowStep(): MigrationStep {
  return {
    from: 1,
    description: "test-only: creates a store, then throws",
    lossless: { lossless: false, reason: "test-only step" },
    up: (_transaction, database) => {
      database.createObjectStore("halfMadeStore", { keyPath: "id" });
      throw new Error("the migration itself failed");
    },
  };
}

// ── P1 — what persists ─────────────────────────────────────────────────────────────────────────────────

describe("DECISIONS/0023 P1 — what persists, and what a load refuses to trust", () => {
  it("round-trips a document built by the real path: working and revision by value, derived recomputed", async () => {
    const factory = new FakeIDBFactory();
    const source = edited();
    await saved(factory, source);
    const handle = await openHandle(factory);

    const stored = await loadBill(handle, "b1");
    expect(stored).not.toBeNull();
    const restored = rebuildDocument(stored!.working, stored!.revision);

    expect(restored.working).toEqual(source.working);
    expect(restored.revision).toBe(source.revision);
    // Equal because both sides ran the same recompute over the same working — §10 line 745, asserted as a
    // value rather than promised. Nothing was stored to make this come out right.
    expect(restored.derived).toEqual(source.derived);
    expect(restored.billValidation).toEqual(source.billValidation);
  });

  it("writes four fields and no fifth, and discards a poisoned stored parseValidation on load", async () => {
    const factory = new FakeIDBFactory();
    const source = edited();
    await saved(factory, source);
    const handle = await openHandle(factory);

    const record = (await rawGet(handle.database, "bills", "b1")) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["billId", "revision", "savedAt", "working"]);

    const poison = structuredClone(record) as { working: { parseValidation: { findings: unknown[] } } };
    poison.working.parseValidation.findings = [];
    await rawPut(handle.database, "bills", poison);

    const stored = await loadBill(handle, "b1");
    const rebuilt = rebuildDocument(stored!.working, stored!.revision);
    const fresh = validate(rebuilt.working.parseResult!);
    expect(rebuilt.working.parseValidation!.findings).toEqual(fresh.findings);
    // The parse here does produce findings; if the recomputed answer were the poisoned empty one, this is
    // the assertion that would catch it.
    expect(rebuilt.working.parseValidation!.findings.length).toBeGreaterThan(0);
  });

  it("keeps unclassifiedRows and excludedRowIds inside working, where the blocker resolves them together", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory, begin("b1", { unclassifiedRows: [ambiguousRow("r1")] }));
    const handle = await openHandle(factory);

    expect([...handle.database.objectStoreNames].sort()).toEqual([...STORE_NAMES].sort());
    const record = (await rawGet(handle.database, "bills", "b1")) as StoredBillRecord;
    expect(record.working.unclassifiedRows.map((row) => row.id)).toEqual(["r1"]);
    expect(Array.isArray(record.working.excludedRowIds)).toBe(true);
  });

  it("encodes a document to the record and decodes it back by value, keyed by the bill it names", () => {
    const document = edited("b7");
    const record = encodeBillRecord(document, SAVED_AT);

    expect(Object.keys(record).sort()).toEqual(["billId", "revision", "savedAt", "working"]);
    expect(record.billId).toBe("b7");
    expect(record.billId).toBe(record.working.bill.id);
    expect(record.revision).toBe(1);
    expect(record.savedAt).toBe(SAVED_AT);
    expect(decodeBillRecord(record)).toEqual({ working: document.working, revision: 1 });
  });
});

// ── P2 — the stores ────────────────────────────────────────────────────────────────────────────────────

describe("DECISIONS/0023 P2 — the stores at version 1", () => {
  it("creates exactly three stores, with the pinned keyPaths and no indexes", async () => {
    const handle = await openHandle(new FakeIDBFactory());

    expect([...handle.database.objectStoreNames].sort()).toEqual(["bills", "creatorProfile", "retainedImages"]);
    expect(handle.version).toBe(1);
    // The superseded plan's per-entity stores, asserted absent: a second reading of §10's shape must not
    // arrive by accident in a later ticket.
    for (const retired of ["draftItems", "items", "units", "assignments", "charges", "participants", "adjustments", "unclassifiedRows"]) {
      expect(handle.database.objectStoreNames.contains(retired)).toBe(false);
    }

    expect(handle.database.transaction("bills").objectStore("bills").keyPath).toBe("billId");
    expect(handle.database.transaction("retainedImages").objectStore("retainedImages").keyPath).toBe("billId");
    expect(handle.database.transaction("creatorProfile").objectStore("creatorProfile").keyPath).toBe("id");
    for (const name of STORE_NAMES) {
      expect(handle.database.transaction(name).objectStore(name).indexNames.length).toBe(0);
    }
  });

  it("names entities.ts as CreatorProfile's home: storage wraps it and never redefines it", () => {
    expect(readFileSync(path.join(import.meta.dirname!, "../../src/lib/entities.ts"), "utf8")).toContain(
      "export interface CreatorProfile",
    );
    for (const file of ["records.ts", "repository.ts", "session.ts", "database.ts", "schema.ts"]) {
      expect(readFileSync(path.join(STORAGE_DIR, file), "utf8")).not.toMatch(/(interface|type) CreatorProfile\b/);
    }
  });
});

// ── P3 — the chain, the abort, the recovery ────────────────────────────────────────────────────────────

describe("DECISIONS/0023 P3 — the migration mechanism", () => {
  it("ships a contiguous chain, one lossless creation step at version 1", () => {
    expect(DB_SCHEMA_VERSION).toBe(1);
    const froms = MIGRATIONS.map((step) => step.from);
    expect(froms).toEqual([0]);
    expect(froms).not.toContain(DB_SCHEMA_VERSION);
    for (const step of MIGRATIONS) {
      if (step.lossless.lossless) expect([...step.lossless.clauses].sort()).toEqual(["L1", "L2", "L3", "L4"]);
      else expect(typeof step.lossless.reason).toBe("string");
    }
  });

  it("aborts a throwing step: the database stays at its old version with its data intact", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);
    const before = await openHandle(factory);
    const original = structuredClone(await rawGet(before.database, "bills", "b1")) as StoredBillRecord;
    expect(original.working.draftItems.length + original.working.items.length).toBeGreaterThan(0);
    before.database.close();

    // The user exported first (P4 satisfied); the step then failed. Without the gate answered the open would
    // decline before the step ever ran, which tests P4, not P3.
    const exported = () => Promise.resolve("exported" as const);
    const failure = await failureOf(() =>
      openDatabase({ factory, targetVersion: 2, migrations: [throwingStep()], onGate: exported }),
    );
    expect(failure).toBeInstanceOf(MigrationFailedError);
    expect((failure as MigrationFailedError).failure).toMatchObject({ from: 1, to: 2 });

    const after = await openAtStoredVersion(factory);
    expect(after.version).toBe(1);
    expect(await rawCount(after, "bills")).toBe(1);
    expect((await rawGet(after, "bills", "b1")) as object).toEqual(original);
    expect(await rawGet(after, "bills", "half-written")).toBeUndefined();
  });

  it("rolls the schema back too: a store created by the step that failed does not exist afterwards", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);

    const failure = await failureOf(() =>
      openDatabase({
        factory,
        targetVersion: 2,
        migrations: [orphanStoreThenThrowStep()],
        onGate: () => Promise.resolve("exported" as const),
      }),
    );
    expect(failure).toBeInstanceOf(MigrationFailedError);

    const after = await openAtStoredVersion(factory);
    expect(after.objectStoreNames.contains("halfMadeStore")).toBe(false);
    expect([...after.objectStoreNames].sort()).toEqual([...STORE_NAMES].sort());
  });

  it("refuses a database written by a newer schema and changes nothing while refusing", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);
    const ahead = await openDatabase({ factory, targetVersion: 2, migrations: [additiveStep()] });
    expect(ahead.version).toBe(2);
    ahead.database.close();

    const failure = await failureOf(() => openDatabase({ factory }));
    expect(failure).toBeInstanceOf(DatabaseVersionTooNewError);

    const untouched = await openAtStoredVersion(factory);
    expect(untouched.version).toBe(2);
    expect(await rawCount(untouched, "bills")).toBe(1);
  });

  it("waits for a connection that will not yield: blocked fires, and the upgrade runs only after it closes", async () => {
    const factory = new FakeIDBFactory();
    // A holder opened raw, with no versionchange listener — a tab that has not been taught to yield. This is
    // the case `blocked` exists for, and the surface P3 owes the user when it happens.
    const holder = await openAtStoredVersion(factory);
    let blocked = 0;
    const dispatched: UpgradeDispatch[] = [];

    const opened = openDatabase({
      factory,
      targetVersion: 2,
      migrations: [additiveStep()],
      onGate: () => Promise.resolve("exported" as const),
      onBlocked: () => {
        blocked += 1;
      },
      onUpgrade: (dispatch) => dispatched.push(dispatch),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(blocked).toBeGreaterThan(0);
    expect(dispatched).toEqual([]);

    holder.close();
    const handle = await opened;
    expect(handle.version).toBe(2);
    expect(dispatched).toEqual([{ oldVersion: 1, newVersion: 2, stepsExecuted: 1 }]);
  });

  it("a session's own connection yields the moment something upgrades, instead of blocking it forever", async () => {
    const factory = new FakeIDBFactory();
    const holder = await openHandle(factory);
    let versionchange = 0;
    holder.database.addEventListener("versionchange", () => {
      versionchange += 1;
    });

    const handle = await openDatabase({ factory, targetVersion: 2, migrations: [additiveStep()] });

    // The holder never gets a close() call in this test: closing itself on versionchange is the promise.
    expect(versionchange).toBe(1);
    expect(handle.version).toBe(2);
  });
});

// ── P4 — lossless, and the export gate ─────────────────────────────────────────────────────────────────

describe("DECISIONS/0023 P4 — provably lossless, and when the export fires", () => {
  it("runs a lossless step with no gate, and the field walk finds nothing dropped", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);
    const before = await openHandle(factory);
    const original = structuredClone(await rawGet(before.database, "bills", "b1")) as StoredBillRecord;
    before.database.close();
    let gateCalls = 0;

    const handle = await openDatabase({
      factory,
      targetVersion: 2,
      migrations: [additiveStep()],
      onGate: () => {
        gateCalls += 1;
        return Promise.resolve("exported" as const);
      },
    });

    expect(gateCalls).toBe(0);
    const after = (await rawGet(handle.database, "bills", "b1")) as Record<string, unknown>;
    expect(after.rigField).toBe("added");
    expect(droppedFieldPaths(original, after)).toEqual([]);
  });

  it("the field walk does catch the lossy step's removal — the checker is not a no-op", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);
    const before = await openHandle(factory);
    const original = structuredClone(await rawGet(before.database, "bills", "b1")) as StoredBillRecord;
    before.database.close();

    const handle = await openDatabase({
      factory,
      targetVersion: 2,
      migrations: [reductiveStep()],
      onGate: () => Promise.resolve("exported" as const),
    });
    const after = await rawGet(handle.database, "bills", "b1");

    expect(droppedFieldPaths(original, after)).toEqual(["working.excludedRowIds"]);
  });

  it("gates a lossy step before the upgrade runs: nothing changes while the gate is open", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);
    const seen: GateNeeded[] = [];
    let releaseGate: ((choice: "exported" | "declined") => void) | null = null;

    const opened = openDatabase({
      factory,
      targetVersion: 2,
      migrations: [reductiveStep()],
      onGate: (needed) =>
        new Promise((resolve) => {
          seen.push(needed);
          releaseGate = resolve;
        }),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ from: 1, to: 2, billCount: 1 });

    const whileGated = await openAtStoredVersion(factory);
    expect(whileGated.version).toBe(1);
    const untouched = (await rawGet(whileGated, "bills", "b1")) as StoredBillRecord;
    expect(untouched.working.excludedRowIds).toBeDefined();
    whileGated.close();

    releaseGate!("exported");
    expect((await opened).version).toBe(2);
  });

  it("honours a decline: no upgrade, no change, and the app keeps working at the old version", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);

    const failure = await failureOf(() =>
      openDatabase({ factory, targetVersion: 2, migrations: [reductiveStep()], onGate: () => Promise.resolve("declined") }),
    );
    expect(failure).toBeInstanceOf(UpgradeDeclinedError);

    const handle = await openAtStoredVersion(factory);
    expect(handle.version).toBe(1);
    expect((await rawGet(handle, "bills", "b1")) as object).toBeTruthy();
  });

  it("does not gate an empty database: a step with nothing to lose has nothing to export", async () => {
    let gateCalls = 0;
    const handle = await openDatabase({
      factory: new FakeIDBFactory(),
      targetVersion: 2,
      migrations: [MIGRATIONS[0]!, reductiveStep()],
      onGate: () => {
        gateCalls += 1;
        return Promise.resolve("exported" as const);
      },
    });

    expect(gateCalls).toBe(0);
    expect(handle.version).toBe(2);
  });

  it("answers the gate question from the shipped chain alone", () => {
    expect(requiresExport(0, DB_SCHEMA_VERSION)).toBe(false);
  });

  it("never puts image bytes in a backup, and says which bills had them", async () => {
    const factory = new FakeIDBFactory();
    const open = await saved(factory);
    await open.persistRetainedImage({ billId: "b1", mediaType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]).buffer });
    const handle = await openHandle(factory);

    const envelope = await exportJson(handle, LATER_AT);
    expect(JSON.stringify(envelope)).not.toContain("bytes");
    expect(envelope.retainedImageBillIds).toEqual(["b1"]);
  });

  it("exports verbatim records under four version fields, never re-encoded documents", async () => {
    const factory = new FakeIDBFactory();
    const source = edited();
    const record = encodeBillRecord(source, SAVED_AT);
    await saved(factory, source);
    const handle = await openHandle(factory);

    const envelope = await exportJson(handle, LATER_AT);
    expect(Object.keys(envelope).sort()).toEqual([
      "app",
      "bills",
      "creatorProfile",
      "dbVersion",
      "exportVersion",
      "exportedAt",
      "retainedImageBillIds",
      "unreadable",
    ]);
    expect(envelope.app).toBe("receipt-lens");
    expect(envelope.exportVersion).toBe(1);
    expect(envelope.dbVersion).toBe(1);
    expect(envelope.exportedAt).toBe(LATER_AT);
    expect(envelope.bills).toEqual([record]);
  });

  it("is record-level: one unreadable row is named in the manifest, and does not take the others with it", async () => {
    const factory = new FakeIDBFactory();
    const open = await saved(factory, edited("b1"));
    await open.persist(edited("b2"));
    await open.flush();
    const handle = await openHandle(factory);
    await rawPut(handle.database, "bills", { billId: "b-broken", revision: 1 });

    const envelope = await exportJson(handle, LATER_AT);
    expect(envelope.bills.map((record) => record.billId).sort()).toEqual(["b1", "b2"]);
    expect(envelope.unreadable).toHaveLength(1);
    expect(envelope.unreadable[0]!.billId).toBe("b-broken");
    expect(typeof envelope.unreadable[0]!.reason).toBe("string");
  });

  it("still exports a bill the editor cannot open: the export path never rebuilds", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);
    const handle = await openHandle(factory);
    const torn = structuredClone((await rawGet(handle.database, "bills", "b1")) as StoredBillRecord);
    // A record that violates §11 rule 2's invariant: units exist for an item that does not. recompute throws
    // on this, which is the "unloadable bill" surface — and the row itself is still perfectly readable.
    torn.working.itemUnits = [
      { id: "unit:i9:0", itemId: "i9", unitIndex: 0, confirmedUnassigned: false },
      { id: "unit:i9:1", itemId: "i9", unitIndex: 1, confirmedUnassigned: false },
    ];
    await rawPut(handle.database, "bills", torn);

    expect(() => rebuildDocument(torn.working, 1)).toThrow();
    const envelope = await exportJson(handle, LATER_AT);
    expect(envelope.bills).toHaveLength(1);
    expect(envelope.unreadable).toEqual([]);
  });

  it("classifies a failed write by code, so the copy reacts to the kind and not to message text", () => {
    expect(saveFailureKind(new DOMException("full", "QuotaExceededError"))).toBe("quota");
    expect(saveFailureKind(new DOMException("closed", "InvalidStateError"))).toBe("invalid-state");
    expect(saveFailureKind("not an error")).toBe("unknown");
    expect(saveFailureKind(new Error("QuotaExceededError"))).toBe("quota");
  });
});

// ── P5 — two tabs, one bill ────────────────────────────────────────────────────────────────────────────

describe("DECISIONS/0023 P5 — concurrent tabs", () => {
  it("defers a write that is not against the record this tab last synced, and says so", async () => {
    const factory = new FakeIDBFactory();
    const tabA = session(factory);
    const tabB = session(factory);
    await tabA.persist(begin());
    await tabA.flush();
    const baseA = await tabA.restore();
    const baseB = await tabB.restore();
    expect(baseA!.revision).toBe(baseB!.revision);

    // Both tabs edit the same base: both produce the same *number*, which is why the comparison is against
    // what this tab synced and never against the incoming revision.
    const editA = ok(setItemPrice(baseA!, "i1", 11_111));
    const editB = ok(setItemPrice(baseB!, "i1", 22_222));
    expect(editA.revision).toBe(editB.revision);

    expect((await tabA.persist(editA)).status).toBe("saved");
    expect(tabB.status()).toBe("idle");
    const deferred = await tabB.persist(editB);

    expect(deferred.status).toBe("divergent");
    expect(deferred.outcome.status).toBe("deferred");
    expect(tabB.divergence()).toEqual({ revision: editA.revision, savedAt: SAVED_AT });
    const handle = await openHandle(factory);
    const stored = await loadBill(handle, "b1");
    expect(stored!.working.draftItems.find((item) => item.id === "i1")!.unitPrice).toBe(11_111);
  });

  it("overwrites when a human asks, and the stored record becomes the tab that was deferred", async () => {
    const factory = new FakeIDBFactory();
    const tabA = session(factory);
    const tabB = session(factory);
    await tabA.persist(begin());
    await tabA.flush();
    const baseA = (await tabA.restore())!;
    const baseB = (await tabB.restore())!;
    await tabA.persist(ok(setItemPrice(baseA, "i1", 11_111)));
    await tabA.flush();

    const editB = ok(setItemPrice(baseB, "i1", 22_222));
    expect((await tabB.persist(editB)).status).toBe("divergent");
    expect((await tabB.overwrite(editB)).status).toBe("saved");
    expect(tabB.divergence()).toBeNull();

    const handle = await openHandle(factory);
    const stored = await loadBill(handle, "b1");
    expect(stored!.revision).toBe(editB.revision);
    expect(stored!.working.draftItems.find((item) => item.id === "i1")!.unitPrice).toBe(22_222);
  });

  it("re-applies the deferred operation on the saved document, through the runner", async () => {
    const factory = new FakeIDBFactory();
    const tabA = session(factory);
    const tabB = session(factory);
    await tabA.persist(begin());
    await tabA.flush();
    const baseA = (await tabA.restore())!;
    const baseB = (await tabB.restore())!;
    await tabA.persist(ok(setItemPrice(baseA, "i1", 11_111)));
    await tabA.flush();

    const editB = ok(setItemPrice(baseB, "i1", 22_222));
    const deferred = await tabB.persist(editB, (document) => setItemPrice(document, "i1", 22_222));
    expect(deferred.status).toBe("divergent");

    const reapplied = await tabB.reapply();
    expect(reapplied.status).toBe("saved");
    expect(reapplied.replay?.ok).toBe(true);
    const handle = await openHandle(factory);
    const stored = await loadBill(handle, "b1");
    // The other tab's price survived, and this tab's did too: re-apply is a replay, not an overwrite.
    expect(stored!.working.draftItems.find((item) => item.id === "i1")!.unitPrice).toBe(22_222);
  });

  it("lets the runner refuse a replay that no longer applies, and does not apply it anyway", async () => {
    const factory = new FakeIDBFactory();
    const tabA = session(factory);
    const tabB = session(factory);
    await tabA.persist(begin());
    await tabA.flush();
    const baseA = (await tabA.restore())!;
    const baseB = (await tabB.restore())!;

    // A deletes the line B is editing, and saves first.
    const deleted = ok(deleteItem(baseA, "i1"));
    await tabA.persist(deleted);
    await tabA.flush();

    const deferred = await tabB.persist(ok(setItemPrice(baseB, "i1", 22_222)), (document) => setItemPrice(document, "i1", 22_222));
    expect(deferred.status).toBe("divergent");
    const reapplied = await tabB.reapply();

    expect(reapplied.status).toBe("not saved");
    expect(reapplied.replay && !reapplied.replay.ok ? reapplied.replay.reject.code : null).toBe("unknown_entity");
    const handle = await openHandle(factory);
    const stored = await loadBill(handle, "b1");
    expect(stored!.working.draftItems.map((item) => item.id)).toEqual(["i2"]);
  });

  it("never tells a tab that has not gone to check: the detection lives at write time", async () => {
    const factory = new FakeIDBFactory();
    const tabA = session(factory);
    const tabB = session(factory);
    await tabA.persist(begin());
    await tabA.flush();
    await tabB.restore();

    await tabA.persist(ok(setItemPrice((await tabA.restore())!, "i1", 11_111)));
    await tabA.flush();

    expect(tabB.status()).toBe("idle");
    expect(tabB.divergence()).toBeNull();
  });

  //
  // SCOPED ABSENCE — read before "fixing" this by deleting it. What v1 forbids is a cross-tab channel *for
  // bill synchronization*: a `storage` listener or a BroadcastChannel would make P5's "no tab is told before
  // it next interacts" false, which is the whole shape of the concurrency rule. It is not a permanent ban on
  // those APIs as technology — a later ticket could legitimately want one for, say, shared download progress,
  // and then this assertion moves with a decision recorded against it, not silently.
  // (Owner forward note, 2026-11-05; DECISIONS/0023 P5.)
  it("ships no cross-tab channel for bill synchronization, and no storage-layer rejection code", () => {
    const sources = `${storageSource()}\n${readFileSync(
      path.join(import.meta.dirname!, "../../src/lib/bill/bill-document.svelte.ts"),
      "utf8",
    )}`;
    for (const banned of ["BroadcastChannel", "navigator.locks", 'addEventListener("storage"', "onstorage", "localStorage"]) {
      expect(sources).not.toContain(banned);
    }
    expect(storageSource()).not.toMatch(/TransactionRejectCode\s*=/);
    expect(storageSource()).not.toContain("revision_stale");
    const transactions = readFileSync(path.join(import.meta.dirname!, "../../src/lib/bill/transactions.ts"), "utf8");
    expect(transactions).not.toContain("revision_stale");
  });
});

// ── P6 — receipt image retention ───────────────────────────────────────────────────────────────────────

describe("DECISIONS/0023 P6 — receipt image retention", () => {
  it("stores no image byte when the box was never ticked", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);
    const handle = await openHandle(factory);

    expect(await rawCount(handle.database, "retainedImages")).toBe(0);
    expect(await hasRetainedImage(handle, "b1")).toBe(false);
  });

  it("stores the accepted working copy when the creator opted in, keyed by the bill", async () => {
    const factory = new FakeIDBFactory();
    const open = await saved(factory);
    const status = await open.persistRetainedImage({ billId: "b1", mediaType: "image/jpeg", bytes: new Uint8Array([9, 8, 7]).buffer });
    expect(status).toBe("saved");

    const handle = await openHandle(factory);
    expect(await rawCount(handle.database, "retainedImages")).toBe(1);
    const record = (await rawGet(handle.database, "retainedImages", "b1")) as {
      billId: string;
      mediaType: string;
      bytes: ArrayBuffer;
      retainedAt: string;
    };
    expect(record.billId).toBe("b1");
    expect(record.mediaType).toBe("image/jpeg");
    expect(record.bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(record.bytes)).toEqual(new Uint8Array([9, 8, 7]));
    expect(record.retainedAt).toBe(SAVED_AT);
    expect(await hasRetainedImage(handle, "b1")).toBe(true);
  });

  it("never leaves an image without a bill: the write is refused when the bill row is absent", async () => {
    const factory = new FakeIDBFactory();
    const open = await saved(factory);
    const handle = await openHandle(factory);

    const failure = await failureOf(() =>
      putRetainedImage(handle, { billId: "no-such-bill", retainedAt: SAVED_AT, mediaType: "image/png", bytes: new Uint8Array([1]).buffer }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(await rawCount(handle.database, "retainedImages")).toBe(0);
    // Through the session too: P6's ordering is not a convention the repository can be talked around.
    expect(await open.persistRetainedImage({ billId: "no-such-bill", mediaType: "image/png", bytes: new Uint8Array([1]).buffer })).toBe("not saved");
  });

  it("a failed image write leaves the bill and every number in it alone", async () => {
    const factory = new FakeIDBFactory();
    const source = edited();
    const open = await saved(factory, source);
    const handle = await openHandle(factory);
    const before = structuredClone(await rawGet(handle.database, "bills", "b1")) as StoredBillRecord;

    // An unclonable value: the storage layer rejects it, which is the class of failure P6's ordering exists for.
    const failure = await failureOf(() =>
      putRetainedImage(handle, {
        billId: "b1",
        retainedAt: SAVED_AT,
        mediaType: "image/jpeg",
        bytes: (() => 0) as unknown as ArrayBuffer,
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(await rawCount(handle.database, "retainedImages")).toBe(0);
    expect(structuredClone(await rawGet(handle.database, "bills", "b1"))).toEqual(before);
    expect(await open.persistRetainedImage({ billId: "b1", mediaType: "image/jpeg", bytes: new Uint8Array([2]).buffer })).toBe("saved");
  });

  it("deleting the photo keeps the bill and every number in it", async () => {
    const factory = new FakeIDBFactory();
    const open = await saved(factory);
    await open.persistRetainedImage({ billId: "b1", mediaType: "image/jpeg", bytes: new Uint8Array([1]).buffer });
    const handle = await openHandle(factory);
    const bill = structuredClone(await rawGet(handle.database, "bills", "b1")) as StoredBillRecord;

    await deleteRetainedImage(handle, "b1");

    expect(await rawCount(handle.database, "retainedImages")).toBe(0);
    expect(await hasRetainedImage(handle, "b1")).toBe(false);
    expect(structuredClone(await rawGet(handle.database, "bills", "b1"))).toEqual(bill);
  });

  it("deleting the bill deletes its photo too", async () => {
    const factory = new FakeIDBFactory();
    const open = await saved(factory);
    await open.persistRetainedImage({ billId: "b1", mediaType: "image/jpeg", bytes: new Uint8Array([1]).buffer });
    const handle = await openHandle(factory);

    await deleteBill(handle, "b1");

    expect(await rawCount(handle.database, "bills")).toBe(0);
    expect(await rawCount(handle.database, "retainedImages")).toBe(0);
  });

  it("keeps no retention flag that could lie about a missing byte: presence is the state", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory);
    const handle = await openHandle(factory);

    const record = (await rawGet(handle.database, "bills", "b1")) as unknown as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["billId", "revision", "savedAt", "working"]);
    expect(JSON.stringify(record.working)).not.toContain("etention");
  });
});

// ── P7 — the save trigger, the restore, the empty states ───────────────────────────────────────────────

describe("DECISIONS/0023 P7 — writing, restoring, and having nothing to restore", () => {
  it("writes the record for every published document, including revision 0", async () => {
    const factory = new FakeIDBFactory();
    const open = session(factory);
    billStore.attach(open);
    billStore.clear();

    billStore.begin(draftOf(), { billId: "b1", createdAt: CREATED_AT });
    await open.flush();

    const handle = await openHandle(factory);
    const record = (await rawGet(handle.database, "bills", "b1")) as StoredBillRecord;
    expect(record.revision).toBe(0);
    expect(record.savedAt).toBe(SAVED_AT);
    expect(billStore.saveStatus).toBe("saved");
    billStore.attach(null);
  });

  it("clearing the view does not delete the bill", async () => {
    const factory = new FakeIDBFactory();
    const open = session(factory);
    billStore.attach(open);
    billStore.begin(draftOf(), { billId: "b1", createdAt: CREATED_AT });
    await open.flush();

    billStore.clear();

    const handle = await openHandle(factory);
    expect(await rawCount(handle.database, "bills")).toBe(1);
    expect(billStore.document).toBeNull();
    billStore.attach(null);
  });

  it("carries the retained image into the handoff without putting it through the JSON detach", async () => {
    const factory = new FakeIDBFactory();
    const open = session(factory);
    billStore.attach(open);
    billStore.clear();
    const blob = new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" });

    billStore.begin(draftOf({ retainedImage: { blob, mediaType: "image/jpeg" } }), { billId: "b1", createdAt: CREATED_AT });
    await open.flush();

    const handle = await openHandle(factory);
    expect(await rawCount(handle.database, "retainedImages")).toBe(1);
    const record = (await rawGet(handle.database, "retainedImages", "b1")) as { bytes: ArrayBuffer };
    expect(new Uint8Array(record.bytes)).toEqual(new Uint8Array([4, 5, 6]));
    billStore.attach(null);
  });

  it("restores the most recently saved bill, ties broken by billId", async () => {
    const factory = new FakeIDBFactory();
    await saved(factory, edited("b1"));
    const later = session(factory, { now: () => LATER_AT });
    await later.persist(edited("b2"));
    await later.flush();
    const handle = await openHandle(factory);

    expect((await mostRecentBill(handle))!.billId).toBe("b2");

    // Same savedAt on three rows: the tie must not depend on insertion order or on a clock's luck.
    // Both stamped at the *greatest* savedAt in the store, so the comparison really is a tie.
    await rawPut(handle.database, "bills", encodeBillRecord(edited("a1"), LATER_AT));
    await rawPut(handle.database, "bills", encodeBillRecord(edited("z9"), LATER_AT));
    expect((await mostRecentBill(handle))!.billId).toBe("z9");
  });

  it("an empty ledger lists nothing and has nothing to restore — the predicate the capture CTA renders from", async () => {
    const open = session(new FakeIDBFactory());

    expect(await open.listBills()).toEqual([]);
    expect(await open.restore()).toBeNull();
  });

  it("lists stored records as a projection of fields, and runs no rebuild per bill", async () => {
    const factory = new FakeIDBFactory();
    const first = edited("b1");
    const open = await saved(factory, first);
    await open.persist(edited("b2"));
    await open.flush();

    const listed = await open.listBills();
    expect(listed.map((record) => record.billId)).toEqual(["b1", "b2"]);
    expect(listed[0]).toEqual(encodeBillRecord(first, SAVED_AT));
    expect(listed[0] as unknown as Record<string, unknown>).not.toHaveProperty("derived");
    expect(listed[0] as unknown as Record<string, unknown>).not.toHaveProperty("billValidation");
  });

  it("reports a failed write as not saved, and keeps the committed edit on screen", async () => {
    const factory = new FakeIDBFactory();
    const open = session(factory);
    await open.persist(begin());
    await open.flush();
    open.disconnect(); // every later write fails: the connection is gone.
    billStore.attach(open);
    billStore.clear();
    billStore.begin(draftOf(), { billId: "b2", createdAt: CREATED_AT });
    await open.flush();

    expect(billStore.document).not.toBeNull();
    expect(billStore.document!.working.bill.id).toBe("b2");
    expect(billStore.saveStatus).toBe("not saved");
    const handle = await openHandle(factory);
    expect(await rawCount(handle.database, "bills")).toBe(1);
    billStore.attach(null);
  });
});

// ── P8 — the profile, and the roster before any item ───────────────────────────────────────────────────

describe("DECISIONS/0023 P8 — CreatorProfile and the roster", () => {
  it("round-trips the profile verbatim: §10's two fields plus its key", async () => {
    const handle = await openHandle(new FakeIDBFactory());
    const profile: CreatorProfile = { displayName: "Albus", upiId: "albus@okhdfc" };

    await saveCreatorProfile(handle, profile);
    const stored = (await rawGet(handle.database, "creatorProfile", CREATOR_PROFILE_ID)) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["displayName", "id", "upiId"]);
    expect(await loadCreatorProfile(handle)).toEqual(profile);
  });

  it("reads no profile as null, so a first run keeps the Creator fallback", async () => {
    const handle = await openHandle(new FakeIDBFactory());
    expect(await loadCreatorProfile(handle)).toBeNull();
  });

  it("seeds the creator's name from the profile, treating blank as absent", () => {
    expect(creatorNameFor(null)).toBe("Creator");
    expect(creatorNameFor({ displayName: "   ", upiId: "x@y" })).toBe("Creator");
    expect(creatorNameFor({ displayName: "Albus", upiId: "" })).toBe("Albus");
  });

  it("begins a bill whose creator participant carries the profile's display name", async () => {
    const factory = new FakeIDBFactory();
    const open = session(factory);
    await open.saveProfile({ displayName: "Albus", upiId: "albus@okhdfc" });
    billStore.attach(open);
    billStore.clear();

    billStore.begin(draftOf(), { billId: "b1", createdAt: CREATED_AT });

    expect(billStore.document!.working.participants[0]!.name).toBe("Albus");
    billStore.attach(null);
  });

  it("never rewrites a stored bill when the profile changes later", async () => {
    const factory = new FakeIDBFactory();
    const open = session(factory);
    await open.saveProfile({ displayName: "Albus", upiId: "a@b" });
    await open.persist(begin());
    await open.flush();
    const handle = await openHandle(factory);
    const before = JSON.stringify(await rawGet(handle.database, "bills", "b1"));

    await open.saveProfile({ displayName: "Someone Else", upiId: "c@d" });

    expect(JSON.stringify(await rawGet(handle.database, "bills", "b1"))).toBe(before);
    expect(billStore.present ? billStore.document!.working.participants[0]!.name : "Creator").not.toBe("Someone Else");
  });

  it("adds a participant to a bill with no finalized items — the gate ticket 13 forwarded", () => {
    const document = begin();
    expect(document.working.items).toEqual([]);

    const added = ok(addParticipant(document, "P1"));

    expect(added.working.participants.map((participant) => participant.name)).toEqual(["Creator", "P1"]);
    expect(added.working.itemUnits).toEqual([]);
    expect(added.working.bill.adjustmentLines).toEqual([]);
    expect(added.working.draftItems.length).toBe(2);
  });

  it("keeps unit assignment gated on finalization, which is a data fact rather than a UI gate", () => {
    const withParticipant = ok(addParticipant(begin(), "P1"));
    expect(withParticipant.working.items.length).toBe(0);
    expect(withParticipant.billValidation.blockers.unitCreation).toContain("item_not_finalized");
  });
});

// ── P9 — migration realism ─────────────────────────────────────────────────────────────────────────────

describe("DECISIONS/0023 P9 — the fixture is the before state", () => {
  it("opens a fresh factory at version 1 exactly once, running the one shipped step", async () => {
    const dispatched: UpgradeDispatch[] = [];
    const handle = await openHandle(new FakeIDBFactory(), { onUpgrade: (entry) => dispatched.push(entry) });

    expect(dispatched).toEqual([{ oldVersion: 0, newVersion: 1, stepsExecuted: 1 }]);
    expect(handle.version).toBe(1);
  });

  it("carries a bill written by the real save path through the no-op reopen, untouched", async () => {
    const factory = new FakeIDBFactory();
    const created: UpgradeDispatch[] = [];
    const first = await openHandle(factory, { onUpgrade: (entry) => created.push(entry) });
    for (const record of fixtureBills()) await rawPut(first.database, "bills", record);
    const [original] = fixtureBills();
    first.close();

    const reopened: UpgradeDispatch[] = [];
    const second = await openHandle(factory, { onUpgrade: (entry) => reopened.push(entry) });

    // The two halves of P9's counter: once at creation with one step, zero at the reopen with none.
    expect(created).toHaveLength(1);
    expect(reopened).toEqual([]);
    expect(second.version).toBe(1);

    const stored = await loadBill(second, original!.billId);
    const rebuilt = rebuildDocument(stored!.working, stored!.revision);
    expect(rebuilt.working).toEqual(original!.working);
    expect(rebuilt.revision).toBe(original!.revision);
  });

  it("migrates every committed fixture forward with nothing dropped and nothing lost", async () => {
    const source = fixtureBills();
    const factory = new FakeIDBFactory();
    const seeded = await openHandle(factory);
    for (const record of source) await rawPut(seeded.database, "bills", record);
    seeded.close();

    const upgraded = await openDatabase({ factory, targetVersion: 2, migrations: [additiveStep()] });
    const after = await listBills(upgraded);

    expect(after.map((record) => record.billId).sort()).toEqual(source.map((record) => record.billId).sort());
    for (const [index, record] of after.entries()) {
      expect(droppedFieldPaths(source[index], record)).toEqual([]);
    }
  });

  it("gates the committed fixture behind an export when the step removes a field from it", async () => {
    const source = fixtureBills();
    const factory = new FakeIDBFactory();
    const seeded = await openHandle(factory);
    for (const record of source) await rawPut(seeded.database, "bills", record);
    seeded.close();
    const gates: GateNeeded[] = [];

    await openDatabase({
      factory,
      targetVersion: 2,
      migrations: [reductiveStep()],
      onGate: (needed) => {
        gates.push(needed);
        return Promise.resolve("exported");
      },
    });

    expect(gates).toHaveLength(1);
    expect(gates[0]!.billCount).toBe(source.length);
  });

  it("aborts against the committed fixture, leaving every bill readable at its old version", async () => {
    const source = fixtureBills();
    const factory = new FakeIDBFactory();
    const seeded = await openHandle(factory);
    for (const record of source) await rawPut(seeded.database, "bills", record);
    seeded.close();

    // Past the gate (this step declares itself lossy) and into the abort: the fixture is what must survive.
    expect(
      await failureOf(() =>
        openDatabase({ factory, targetVersion: 2, migrations: [throwingStep()], onGate: () => Promise.resolve("exported" as const) }),
      ),
    ).toBeInstanceOf(MigrationFailedError);

    const handle = await openAtStoredVersion(factory);
    expect(handle.version).toBe(1);
    expect(await rawCount(handle, "bills")).toBe(source.length);
    expect(await readStoredVersion(factory)).toBe(1);
  });

  it("keeps the shipped chain free of rig steps", () => {
    // [0] is the chain *for DB_SCHEMA_VERSION === 1*. When v2 lands this becomes [0, 1] as an expected part
    // of that ticket — the bump, its step and this assertion move together. See DECISIONS/0023 P5's scoped-
    // absence note: updating this is normal, deleting it to stay green is not.
    expect(MIGRATIONS.map((step) => step.from)).toEqual([0]);
    for (const step of MIGRATIONS) expect(step.description).not.toMatch(/test-only|synthetic|rig/);
  });

  it("commits the profile row and the image row as the save path wrote them, with photo bytes digested", () => {
    // P9's realism has one deliberate limit, and it is a standing rule rather than a shortcut: fixtures are
    // PII-clean, and a real receipt photograph is precisely the PII. So `bytes` is stored here as the
    // generator's `{ byteLength, fnv1a }` digest — the row's shape and size are evidence, its pixels are not.
    // The byte-level assertions live in `playwright/persistence.spec.ts`, which never commits a photo.
    const [profile] = fixtureStore("creatorProfile");
    expect(Object.keys(profile!).sort()).toEqual(["displayName", "id", "upiId"]);
    expect(profile!.id).toBe(CREATOR_PROFILE_ID);

    const [image] = fixtureStore("retainedImages");
    expect(Object.keys(image!).sort()).toEqual(["billId", "bytes", "mediaType", "retainedAt"]);
    // `{ __bytes: … }` is the generator's marker that a binary value was digested, in the page, before it
    // crossed to Node — `page.evaluate` would otherwise have returned an ArrayBuffer as `{}`.
    const bytes = image!.bytes as { __bytes: { byteLength: number; fnv1a: string } };
    expect(Object.keys(bytes)).toEqual(["__bytes"]);
    expect(bytes.__bytes.byteLength).toBeGreaterThan(0);
    expect(typeof bytes.__bytes.fnv1a).toBe("string");
    expect(JSON.stringify(image)).not.toContain("data:image");
  });
});

// ── P10 — what each failure promises ───────────────────────────────────────────────────────────────────

describe("DECISIONS/0023 P10 — the failure surfaces", () => {
  it("makes an unloadable record a per-bill failure: the ledger still lists and opens the others", async () => {
    const factory = new FakeIDBFactory();
    const open = await saved(factory, edited("b1"));
    await open.persist(edited("b2"));
    await open.flush();
    const handle = await openHandle(factory);

    const torn = structuredClone((await rawGet(handle.database, "bills", "b1")) as StoredBillRecord);
    // count(units where itemId = X) !== Item.qty: recompute throws, so the editor cannot open this bill.
    torn.working.itemUnits.push({ id: "unit:iX:0", itemId: "iX", unitIndex: 0, confirmedUnassigned: false });
    await rawPut(handle.database, "bills", torn);

    const listed = await open.listBills();
    expect(listed.map((record) => record.billId)).toEqual(["b1", "b2"]);
    expect(() => rebuildDocument(listed[0]!.working, listed[0]!.revision)).toThrow();
    expect(rebuildDocument(listed[1]!.working, listed[1]!.revision).working.bill.id).toBe("b2");
  });

  // SCOPED ABSENCE: no `deleteDatabase` in the *storage layer* — the module that must never trade data for
  // progress (P3). A rig or a fixture script may delete a database it created, and `fake-indexeddb`'s own
  // tests do; that is not this promise. DECISIONS/0023 P10.
  it("never clears a database: deleteDatabase appears nowhere in the storage layer", () => {
    expect(storageSource()).not.toContain("deleteDatabase");
  });

  it("keeps the save-status vocabulary to the states P10 names", async () => {
    const open = session(new FakeIDBFactory());
    expect(open.status()).toBe("idle");
    await open.persist(edited());
    await open.flush();
    expect(open.status()).toBe("saved");
  });
});
