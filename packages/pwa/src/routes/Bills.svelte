<script lang="ts">
  /**
   * Ticket 14 — the creator's local ledger (DECISIONS/0023 P2, P4, P7, P8; PROJECT(1).md §13 line 922:
   * "Sole access to the creator-only local ledger of past bills").
   *
   * The list is a projection of stored fields: title, date, lock, printed total, counts. It runs
   * `rebuildDocument` for no bill, because the lifecycle badge needs `billValidation` and P7 says the ledger
   * must not buy a re-derivation per row to render a row. Opening a row is where a document gets built.
   */
  import { onMount } from "svelte";
  import { billStore } from "../lib/bill/bill-document.svelte.js";
  import type { StoredBillRecord } from "../lib/storage/records.js";
  import { storage } from "../lib/storage/storage-state.svelte.js";
  import { formatPaiseOrNull } from "../lib/bill/paise-input.js";
  import { targetUrl } from "../lib/router.js";

  const session = storage.session();

  let records = $state<StoredBillRecord[]>([]);
  let loading = $state(true);
  let profileName = $state("");
  let profileUpi = $state("");
  let profileSaved = $state(false);
  /** The bill whose delete confirmation is open — delete is the one irreversible act on this screen. */
  let deleting = $state<StoredBillRecord | null>(null);
  let backupFile = $state<string | null>(null);

  /** Newest first, by the stored creation stamp — the same rule `mostRecentBill` uses for a restore (P7). */
  const rows = $derived(
    [...records].sort((a, b) => {
      if (a.working.bill.createdAt !== b.working.bill.createdAt) {
        return a.working.bill.createdAt < b.working.bill.createdAt ? 1 : -1;
      }
      return a.billId < b.billId ? 1 : -1;
    }),
  );

  async function refresh(): Promise<void> {
    records = (await storage.guard(() => session.listBills())) ?? [];
    loading = false;
  }

  onMount(() => {
    void refresh();
    void storage.guard(() => session.loadProfile()).then((saved) => {
      if (!saved) return;
      profileName = saved.displayName;
      profileUpi = saved.upiId;
    });
  });

  function open(billId: string): void {
    void storage
      .guard(() => session.restoreBill(billId))
      .then((document) => {
        if (!document) return;
        billStore.attachRestored(document);
        window.history.pushState({}, "", targetUrl("/bill", window.location.hash));
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
  }

  async function confirmDelete(): Promise<void> {
    const record = deleting;
    if (!record) return;
    deleting = null;
    await storage.guard(() => session.deleteBill(record.billId));
    if (billStore.document?.working.bill.id === record.billId) billStore.clear();
    await refresh();
  }

  async function saveProfile(): Promise<void> {
    await storage.guard(() =>
      session.saveProfile({ displayName: profileName.trim(), upiId: profileUpi.trim() }),
    );
    profileSaved = true;
  }

  async function downloadBackup(): Promise<void> {
    backupFile = await storage.exportBackup();
  }
</script>

<h1>Past bills</h1>

<section class="profile" data-testid="profile-panel">
  <h2>Your profile</h2>
  <p class="hint">
    Stored on this device only, and used to name you on a new bill and to fill a payment link (ticket 15).
  </p>
  <form
    class="inline"
    onsubmit={(event) => {
      event.preventDefault();
      void saveProfile();
    }}
  >
    <label for="profile-name">Display name</label>
    <input id="profile-name" type="text" data-testid="profile-name" bind:value={profileName} />
    <label for="profile-upi">UPI ID</label>
    <input id="profile-upi" type="text" data-testid="profile-upi" bind:value={profileUpi} />
    <button type="submit" data-testid="profile-save">Save profile</button>
  </form>
  {#if profileSaved}
    <p class="badge badge-ok" data-testid="profile-saved">Profile saved on this device.</p>
  {/if}
</section>

{#if loading}
  <p class="hint" data-testid="bills-loading">Reading this device…</p>
{:else if rows.length === 0}
  <!-- P7's first empty state: nothing on the device yet. The CTA is the thing that navigates. -->
  <p data-testid="bills-empty">No bills on this device yet.</p>
  <button
    type="button"
    data-testid="bills-capture-cta"
    onclick={() => {
      window.history.pushState({}, "", targetUrl("/capture", window.location.hash));
      window.dispatchEvent(new PopStateEvent("popstate"));
    }}
  >
    Capture a receipt
  </button>
{:else}
  <ul class="ledger" data-testid="bills-list">
    {#each rows as record (record.billId)}
      {@const bill = record.working.bill}
      <li class="row" data-testid="bill-row" data-bill-id={record.billId}>
        <span data-testid="bill-title">{bill.title || "Untitled bill"}</span>
        <time data-testid="bill-created">{bill.createdAt.slice(0, 10)}</time>
        <span data-testid="bill-total">{formatPaiseOrNull(bill.grandTotal)}</span>
        <span data-testid="bill-counts">
          {record.working.draftItems.length} draft, {record.working.items.length} item,
          {record.working.participants.length} people
        </span>
        {#if bill.isLocked}
          <span class="badge" data-testid="bill-locked">locked</span>
        {:else}
          <span class="badge badge-muted" data-testid="bill-draft">draft</span>
        {/if}
        <button type="button" data-testid="bill-open" onclick={() => open(record.billId)}>Open</button>
        <button type="button" data-testid="bill-delete" onclick={() => (deleting = record)}>Delete</button>
      </li>
    {/each}
  </ul>
{/if}

{#if deleting}
  <div class="modal" role="dialog" aria-label="Delete this bill" data-testid="delete-dialog">
    <h2>Delete “{deleting.working.bill.title || "this bill"}”?</h2>
    <p>
      This removes the bill from this device. It cannot be undone, and it takes any photo kept for it with it.
    </p>
    {#if deleting.working.bill.isLocked}
      <!-- 0022 L4's wording rule: links already sent keep showing the amounts they were locked with. -->
      <p class="warning" data-testid="delete-locked-warning">
        This bill is locked. Share links already sent keep showing the amounts they were locked with; deleting
        the bill here does not recall or revoke them.
      </p>
    {/if}
    <button type="button" data-testid="delete-confirm" onclick={() => void confirmDelete()}>Delete</button>
    <button type="button" data-testid="delete-cancel" onclick={() => (deleting = null)}>Cancel</button>
  </div>
{/if}

<section class="backup" data-testid="backup-panel">
  <h2>Backup</h2>
  <p class="hint">
    A JSON file with every bill and your profile, written to your browser's downloads folder. It never
    contains a kept receipt photo — the file leaves the device the moment you send it somewhere.
  </p>
  <button type="button" data-testid="backup-download" onclick={() => void downloadBackup()}>
    Download a backup
  </button>
  {#if backupFile}
    <p data-testid="backup-file">Saved as {backupFile} in your downloads.</p>
  {/if}
</section>
