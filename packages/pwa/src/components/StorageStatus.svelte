<script lang="ts">
  /**
   * Ticket 14 — the storage surfaces (DECISIONS/0023 P3, P4, P5, P10).
   *
   * Four screens and a chip, all of them saying the same thing first: **nothing was deleted.** That is the
   * ticket's headline promise ("a future schema change can never silently wipe a user's bills"), and it is
   * why these states are separate components rather than a string inside `Bill.svelte`: they can appear on
   * any route, including ones where no bill is open.
   *
   * The chip reads `billStore.saveStatus`, which is only ever set by a write that actually landed — P10.1's
   * rule that storage and memory may disagree, but the screen must never claim a save that did not happen.
   * Messages react to codes (`bill_changed_elsewhere`, the failure kind), never to error text (§6 line 401).
   */
  import { billStore } from "../lib/bill/bill-document.svelte.js";
  import { saveFailureKind } from "../lib/storage/repository.js";
  import type { StorageNotice } from "../lib/storage/storage-state.svelte.js";
  import { storage } from "../lib/storage/storage-state.svelte.js";

  /**
   * Every binding defaults to the app's storage state, so `App.svelte` mounts this with no props and gets the
   * live screens. The props exist for one reason: `playwright/rig/` renders the *same* component against a
   * synthetic migration chain, and a broken migration cannot be produced by shipped code (DECISIONS/0023 S1).
   * Presentational props with app-state defaults are a component API; a flag inside the storage module that
   * changes how it opens the database would be a backdoor in the thing that owns the user's data.
   */
  let {
    notice = storage.notice,
    blocked = storage.blocked,
    onExport = () => storage.exportBackup(),
    onContinue = () => storage.continueAfterExport(),
    onDecline = () => storage.declineGate(),
    onRetry = () => storage.retryUpgrade(),
    onOfferAgain = () => storage.offerUpgradeAgain(),
    onClearBlocked = () => storage.clearBlocked(),
  } = $props();
  const status = $derived(billStore.saveStatus);
  const divergence = $derived(billStore.divergence);
  const failureKind = $derived(
    billStore.saveCause === null ? null : saveFailureKind(billStore.saveCause),
  );
  const exportReady = $derived(notice?.exportedTo ?? null);
</script>

{#if notice}
  <section class="alert" role="alert" data-testid="storage-notice" data-phase={notice.phase}>
    {#if notice.phase === "gating"}
      <h2 data-testid="gate-heading">This update changes how your bills are stored</h2>
      <p data-testid="gate-reason">
        The step from version {notice.from} to version {notice.to} is not provably lossless:
        {notice.reason || "it cannot show that no field is dropped, retyped, removed or skipped"}.
      </p>
      <p data-testid="gate-count">
        {notice.billCount} bill(s) on this device would be rewritten. A backup is a JSON file holding every
        bill and your profile, written to your browser's downloads folder; it does not contain any kept
        receipt photo.
      </p>
      <button type="button" data-testid="gate-export" onclick={() => void onExport()}>
        Download my bills first
      </button>
      {#if exportReady}
        <p data-testid="gate-exported">Saved as {exportReady} in your downloads.</p>
      {/if}
      <button
        type="button"
        data-testid="gate-continue"
        disabled={exportReady === null}
        onclick={() => onContinue()}
      >
        Update now
      </button>
      <button type="button" data-testid="gate-later" onclick={() => onDecline()}>
        Not yet — keep using this version
      </button>
      <p class="hint">
        Choosing "not yet" changes nothing: the app keeps working at version {notice.from}, and this screen
        returns next time it is opened.
      </p>
    {:else if notice.phase === "migration-failed"}
      <!-- P10: the abort already rolled the upgrade back, so this screen's whole job is to say that out loud. -->
      <h2 data-testid="migration-failed-heading">Your data was not changed</h2>
      <p>
        The update to version {notice.to} did not complete, so nothing was applied: this device is still at
        version {notice.from} with every bill exactly as it saved it.
      </p>
      <p class="hint" data-testid="migration-failed-step">Step: {notice.step}</p>
      <p class="hint">
        Keep the file — it is what the failed update was trying to change. {notice.billCount > 0 ? "" : ""}
      </p>
      <button type="button" data-testid="migration-export" onclick={() => void onExport()}>
        Download my bills
      </button>
      {#if exportReady}
        <p data-testid="migration-exported">Saved as {exportReady} in your downloads.</p>
      {/if}
      <button type="button" data-testid="migration-retry" onclick={() => void onRetry()}>
        Try the update again
      </button>
    {:else if notice.phase === "version-too-new"}
      <h2>Your bills are stored in a newer format than this app</h2>
      <p>
        This build understands version {notice.to}; this device holds version {notice.from}. Nothing was
        opened for writing and nothing was changed. Open the newer version of the app to continue.
      </p>
      <button type="button" data-testid="newer-export" onclick={() => void onExport()}>
        Download my bills
      </button>
    {:else if notice.phase === "declined"}
      <h2 data-testid="declined-heading">Still on version {notice.from}</h2>
      <p>
        The update was not applied and nothing changed. Your bills are on this device exactly as they were.
      </p>
      <button type="button" data-testid="declined-retry" onclick={() => void onOfferAgain()}>
        Ask me again about the update
      </button>
    {/if}
  </section>
{:else if blocked}
  <section class="alert" role="status" data-testid="storage-blocked">
    Another tab of receipt-lens is holding this device's database open, so this one is waiting
    ({Math.round(blocked.waitingMs / 1000)}s). Close the other tab to let the update continue.
  </section>
{/if}

{#if divergence}
  <!-- P5: the refusal is the notice. Nothing here is written until a human picks, and the edit stays on screen. -->
  <section class="alert alert-warn" role="alert" data-testid="divergence-notice" data-code="bill_changed_elsewhere">
    <h2>Another tab changed this bill</h2>
    <p>
      It saved revision {divergence.revision} at {divergence.savedAt}. This tab has changes that were not
      saved, and they are still on your screen.
    </p>
    <button type="button" data-testid="divergence-overwrite" onclick={() => billStore.overwrite()}>
      Overwrite with this tab's version
    </button>
    <button type="button" data-testid="divergence-reapply" onclick={() => billStore.reapply()}>
      Take the saved version and re-apply my change
    </button>
  </section>
{/if}

{#if status !== "idle"}
  <p
    class="chip"
    data-testid="save-status"
    data-status={status}
    data-failure={failureKind ?? ""}
    role="status"
    aria-live="polite"
  >
    {#if status === "saving"}
      Saving…
    {:else if status === "saved"}
      Saved on this device
    {:else if status === "divergent"}
      Not saved — another tab changed this bill
    {:else if status === "not saved"}
      {#if failureKind === "quota"}
        <span data-testid="quota-message">
          This device's storage is full. Your change is still on screen and was <strong>not</strong> saved —
          free up space, or download a backup and delete a bill, then retry.
        </span>
      {:else}
        <span data-testid="save-failed-message">
          Could not save on this device. Your change is still on screen and was <strong>not</strong> saved.
        </span>
      {/if}
      <button type="button" data-testid="save-retry" onclick={() => billStore.retrySave()}>Retry save</button>
    {/if}
  </p>
{/if}
