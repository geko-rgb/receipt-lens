/**
 * Ticket 14 — the migration rig (DECISIONS/0023 P9, S1).
 *
 * A page that runs a **synthetic** migration against the database the real app wrote, so the two screens
 * ticket 14 promises can be driven end to end in Chromium: the export gate that stands in front of a lossy
 * step, and the recoverable error that follows an aborted one.
 *
 * It is a separate Vite entry (`playwright/vite.rig.config.ts` → `playwright/rig/dist`), not part of
 * `packages/pwa/dist/app`, and no file in `src/` imports it. The reason it exists at all: the shipped storage
 * layer cannot carry a step that throws, because that would be a backdoor in the module whose whole job is
 * not to lose anyone's bills. The rig is the same `openDatabase` call with a test-only chain, and
 * `smoke.spec.ts` asserts the shipped bundle does not contain it.
 *
 * The bill under migration is seeded by the app itself — the spec captures, accepts and edits on `/bill`
 * before arriving here — so the thing being upgraded is what the save path actually serialized.
 */
<script lang="ts">
  import { onMount } from "svelte";
  import StorageStatus from "../src/components/StorageStatus.svelte";
  import type { StorageNotice } from "../src/lib/storage/storage-state.svelte.js";
  import {
    DatabaseVersionTooNewError,
    MigrationFailedError,
    UpgradeDeclinedError,
    openDatabase,
  } from "../src/lib/storage/database.js";
  import type { MigrationStep } from "../src/lib/storage/schema.js";
  import { buildBackup } from "../src/lib/storage/backup.js";
  import { downloadEnvelope } from "../src/lib/storage/download.js";

  type RigKind = "gate" | "abort" | "schema";

  const kind = new URLSearchParams(window.location.search).get("kind") as RigKind | null;

  let notice = $state<StorageNotice | null>(null);
  let result = $state<"idle" | "exported" | "continued" | "declined" | "aborted" | "upgraded">("idle");
  let exportedTo = $state<string | null>(null);
  let resolveGate: ((choice: "exported" | "declined") => void) | null = null;

  /**
   * Removes a field every record carries. Genuinely lossy by P4's L1, which is the only reason the gate
   * should ever appear — a rig step that is secretly safe would prove nothing.
   */
  function reductiveStep(): MigrationStep {
    return {
      from: 1,
      description: "rig: drop working.excludedRowIds",
      lossless: { lossless: false, reason: "L1: removes a field present in every record" },
      up: (transaction) => {
        const store = transaction.objectStore("bills");
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return;
          delete (at.value as { working: Record<string, unknown> }).working.excludedRowIds;
          store.put(at.value);
          at.continue();
        };
      },
    };
  }

  /**
   * Declares itself lossless and then fails. That is the honest shape of the accident: the abort screen exists
   * for the migration whose author believed it was safe, and a rig step that admitted it was lossy would be
   * stopped by the gate instead of reaching the failure it is meant to produce.
   */
  function throwingStep(): MigrationStep {
    return {
      from: 1,
      description: "rig: writes, then throws",
      lossless: { lossless: true, clauses: ["L1", "L2", "L3", "L4"] },
      up: (transaction) => {
        transaction.objectStore("bills").put({
          billId: "bill:rig-half-written",
          revision: 99,
          savedAt: "2026-11-05T00:00:00.000Z",
          working: null,
        });
        throw new Error("the rig migration failed on purpose");
      },
    };
  }

  /** Creates a store and then fails — the half that "no partial migration is left applied" is really about. */
  function orphanStoreStep(): MigrationStep {
    return {
      from: 1,
      description: "rig: creates a store, then throws",
      lossless: { lossless: true, clauses: ["L1", "L2", "L3", "L4"] },
      up: (_transaction, database) => {
        database.createObjectStore("rigHalfMadeStore", { keyPath: "id" });
        throw new Error("the rig migration failed on purpose");
      },
    };
  }

  function chain(): MigrationStep[] {
    if (kind === "abort") return [throwingStep()];
    if (kind === "schema") return [orphanStoreStep()];
    return [reductiveStep()];
  }

  function describe(cause: unknown): StorageNotice | null {
    if (cause instanceof MigrationFailedError) {
      return {
        phase: "migration-failed",
        from: cause.failure.from,
        to: cause.failure.to,
        step: String(cause.failure.to - 1),
        reason: cause.message,
        billCount: 0,
        exportedTo,
      };
    }
    if (cause instanceof DatabaseVersionTooNewError) {
      return { phase: "version-too-new", from: cause.storedVersion, to: cause.requestedVersion, step: "", reason: cause.message, billCount: 0, exportedTo };
    }
    if (cause instanceof UpgradeDeclinedError) {
      return { phase: "declined", from: cause.at, to: cause.at + 1, step: "", reason: cause.message, billCount: 0, exportedTo };
    }
    return null;
  }

  async function run(): Promise<void> {
    try {
      const handle = await openDatabase({
        targetVersion: 2,
        migrations: chain(),
        onGate: (needed) =>
          new Promise<"exported" | "declined">((resolve) => {
            resolveGate = resolve;
            notice = {
              phase: "gating",
              from: needed.from,
              to: needed.to,
              step: needed.step.description,
              reason: needed.step.lossless.lossless === false ? needed.step.lossless.reason : "",
              billCount: needed.billCount,
              exportedTo: null,
            };
          }),
      });
      handle.close();
      result = "upgraded";
    } catch (cause) {
      const found = describe(cause);
      if (found) notice = found;
      result = cause instanceof UpgradeDeclinedError ? "declined" : "aborted";
    }
  }

  async function exportNow(): Promise<string | null> {
    const envelope = await buildBackup({ exportedAt: new Date().toISOString() });
    const name = downloadEnvelope(envelope);
    exportedTo = name;
    if (notice) notice = { ...notice, exportedTo: name };
    result = "exported";
    return name;
  }

  onMount(() => {
    void run();
  });
</script>

<h1>Migration rig</h1>
<p data-testid="rig-kind">{kind ?? "gate"}</p>
<p data-testid="rig-result" data-result={result}>{result}</p>
<p data-testid="rig-exported-to">{exportedTo ?? ""}</p>

<StorageStatus
  {notice}
  blocked={null}
  onExport={exportNow}
  onContinue={() => {
    resolveGate?.("exported");
    resolveGate = null;
    if (notice) notice = { ...notice, phase: "ready", from: 2, to: 2 };
    result = "continued";
    void run();
  }}
  onDecline={() => {
    resolveGate?.("declined");
    resolveGate = null;
  }}
  onRetry={() => {
    notice = null;
    void run();
    return Promise.resolve(true);
  }}
  onOfferAgain={() => {
    notice = null;
    void run();
    return Promise.resolve(true);
  }}
  onClearBlocked={() => undefined}
/>
