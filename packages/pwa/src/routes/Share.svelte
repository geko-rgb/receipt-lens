<script lang="ts">
  /**
   * Ticket 16 — the participant view (DECISIONS/0026 A8–A10, G1, G2).
   *
   * Everything on this screen comes from `openShareLink`, which is the only thing here that touches the bytes:
   * no second validator, no re-encoding, and no bill content until the codec says the fragment is a v1
   * snapshot. The shell hands over the RAW fragment (DECISIONS/0017 D3a), and the `share-fragment` element
   * below still carries it unchanged — ticket 10a's byte-for-byte proof reads that attribute. It is an
   * attribute rather than page text precisely so the bearer secret is not also printed for a screenshot.
   */
  import { formatPaise } from "../lib/bill/paise-input.js";
  import { formatExactRupees } from "../lib/settlement-links.js";
  import { storage } from "../lib/storage/storage-state.svelte.js";
  import {
    openShareLink,
    SHARE_DISCLOSURE,
    SHARE_DISCLOSURE_SUPPORT,
    SNAPSHOT_MAY_HAVE_CHANGED,
    withStaleness,
    type ShareView,
  } from "../lib/share/view.js";

  let { fragment }: { fragment: string } = $props();

  let view = $state.raw<ShareView | null>(null);
  let selected = $state<string | null>(null);
  let fullBill = $state(false);
  let attempt = 0;
  let stalenessLookedUp = false;

  $effect(() => {
    const generation = (attempt += 1);
    selected = null;
    fullBill = false;
    stalenessLookedUp = false;
    view = fragment === "" ? { state: "empty" } : null;
    if (fragment === "") return;
    // No `cutoffOf` in this call, deliberately: the ledger lookup can wait on a migration gate, and this route
    // shows no storage screens by decision (App.svelte hides them, because a recipient has no ledger). The
    // bill renders first and the label is refined below if this device turns out to know better.
    void openShareLink(fragment).then((result) => {
      if (generation === attempt) view = result;
    });
  });

  // DECISIONS/0026 A9's second step, and the reason the label starts as "unknown": a device that cannot answer
  // the question may not claim freshness. One lookup per fragment, so the assignment cannot re-arm it.
  $effect(() => {
    const current = view;
    if (current?.state !== "ready" || stalenessLookedUp) return;
    stalenessLookedUp = true;
    const generation = attempt;
    void cutoffOf(current.snapshot.bill.id).then((cutoffAt) => {
      if (generation !== attempt || view?.state !== "ready") return;
      view = withStaleness(view, cutoffAt);
    });
  });

  /** The creator's local watermark — the one field of the local bill this view is allowed to read (A8). */
  async function cutoffOf(billId: string): Promise<string | null> {
    const session = storage.session();
    const local = await storage.guard(() => session.restoreBill(billId));
    return local?.working.staleLinkCutoffAt ?? null;
  }

  const snapshot = $derived(view?.state === "ready" ? view.snapshot : null);
  const shares = $derived(view?.state === "ready" ? view.shares : null);

  /** Roster material keyed by id, so a row never searches the array it is being rendered from. */
  const roster = $derived.by(() => {
    if (snapshot === null) return new Map<string, { name: string; tokenExpiresAt: string }>();
    return new Map(snapshot.participants.map((p) => [p.id, { name: p.name, tokenExpiresAt: p.tokenExpiresAt }]));
  });

  /** G1: choosing a name moves your row to the top and marks it. It hides nothing, and says so. */
  const ordered = $derived.by(() => {
    if (shares === null) return [];
    if (selected === null) return [...shares.shares];
    const mine = shares.shares.filter((row) => row.participantId === selected);
    return [...mine, ...shares.shares.filter((row) => row.participantId !== selected)];
  });

  function readable(iso: string): string {
    const stamp = Date.parse(iso);
    return Number.isNaN(stamp)
      ? iso
      : new Date(stamp).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  }

  function amount(paise: number | null): string {
    return paise === null ? "not computable" : formatPaise(paise);
  }

  function nameOf(participantId: string): string {
    return roster.get(participantId)?.name ?? participantId;
  }

  function expiryOf(participantId: string): string {
    const expiresAt = roster.get(participantId)?.tokenExpiresAt ?? "";
    // G3: ticket 13 never writes an expiry, so "no expiry set" is the true answer rather than a date.
    return expiresAt === "" ? "no expiry set" : readable(expiresAt);
  }
</script>

<h1>Share</h1>

{#if fragment.length > 0}
  <span class="raw" data-testid="share-fragment" data-raw={fragment}>Link received: {fragment.length} characters</span>
{/if}

{#if view === null}
  <p class="hint" data-testid="share-loading">Reading this link…</p>
{:else if view.state === "empty"}
  <p data-testid="share-state">No share link was opened.</p>
  <p class="placeholder" data-testid="share-placeholder">
    Open a link the creator sent you — this view is ticket 16's. It decodes the fragment here, on this device,
    with nothing fetched.
  </p>
{:else if view.state === "failed"}
  <div class="alert-error" role="alert" data-testid="share-failure">
    <p data-testid="share-failure-code">{view.code}</p>
    <p>{view.headline}</p>
    <p class="hint">{view.message}</p>
  </div>
{:else if snapshot !== null && shares !== null}
  <section data-testid="share-view" data-staleness={view.staleness.state}>
    <h2 data-testid="share-title">{snapshot.bill.title}</h2>

    {#if view.staleness.state === "stale"}
      <p class="alert-error" data-testid="share-stale">
        Bill updated on <time datetime={view.staleness.cutoffAt}>{readable(view.staleness.cutoffAt)}</time>.
        The amounts below are the ones frozen when this link was made, so they are not the bill's current
        numbers — ask the creator for a new link.
      </p>
    {:else if view.staleness.state === "unknown"}
      <p class="hint" data-testid="share-created">
        Snapshot created
        <time datetime={snapshot.snapshotCreatedAt}>{readable(snapshot.snapshotCreatedAt)}</time>.
        {SNAPSHOT_MAY_HAVE_CHANGED}
      </p>
    {:else}
      <p class="hint" data-testid="share-epoch">
        This snapshot is from the current lock of this bill <em>on this device</em>. The creator may have
        unlocked it somewhere else since.
      </p>
    {/if}

    {#if shares.mismatch}
      <p class="alert-error" role="alert" data-testid="share-cache-mismatch">
        The shares carried in this link do not match the ones computed from the bill inside it. The numbers
        below are recomputed here, because a link's cache is not the authority (DECISIONS/0025 P4).
      </p>
    {/if}

    <label class="picker">
      <span>Which one of you are you?</span>
      <select
        data-testid="which-one-are-you"
        onchange={(event) => (selected = (event.currentTarget as HTMLSelectElement).value || null)}
      >
        <option value="">Nobody yet — show every share</option>
        {#each snapshot.participants as participant (participant.id)}
          <option value={participant.id}>{participant.name}</option>
        {/each}
      </select>
    </label>
    <p class="hint" data-testid="share-identity-note">
      This link carries the bill, not your place in it, so the list above is chosen rather than known. Picking
      a name moves your row to the top and hides nothing — you already hold the whole bill.
    </p>

    <ul class="rows">
      {#each ordered as share (share.participantId)}
        <li
          class="row"
          data-testid="share-row"
          data-participant-id={share.participantId}
          data-mine={selected === share.participantId}
        >
          {#if selected === share.participantId}
            <span class="badge" data-testid="share-mine">you</span>
          {/if}
          <span class="name">{nameOf(share.participantId)}</span>
          <span data-testid="share-exact">Exact share: {formatExactRupees(share.exactAmount)}</span>
          <span data-testid="share-payment">UPI payment amount: {amount(share.settlementSharePaise)}</span>
          <span class="hint" data-testid="share-expiry-hint">
            link expiry hint, client-side only: {expiryOf(share.participantId)}
          </span>
        </li>
      {/each}
    </ul>

    <p class="hint" data-testid="share-no-intent">
      There is no payment link on this page. The creator's message carries it; what travels in this link is the
      bill, and a payee address is deliberately not part of it.
    </p>

    <button type="button" data-testid="share-toggle" aria-expanded={fullBill} onclick={() => (fullBill = !fullBill)}>
      {fullBill ? "Hide the bill" : "Show the whole bill"}
    </button>

    {#if fullBill}
      <div data-testid="share-full-bill">
        <h3>Items</h3>
        <ul>
          {#each snapshot.items as item (item.id)}
            <li data-testid="share-item-row" data-item-id={item.id}>
              {item.name} × {item.qty} at {formatPaise(item.unitPrice)}
              <ul>
                {#each item.unitAssignments as unit (unit.unitIndex)}
                  <li data-testid="share-unit-row">
                    unit {unit.unitIndex + 1}:
                    {#if unit.participantIds.length > 0}
                      {unit.participantIds.map(nameOf).join(", ")}
                    {:else if unit.confirmedUnassigned}
                      unassigned — the creator absorbed it
                    {:else}
                      unassigned
                    {/if}
                  </li>
                {/each}
              </ul>
            </li>
          {/each}
        </ul>

        <h3>Charges</h3>
        {#if snapshot.charges.length === 0}
          <p class="hint" data-testid="share-no-charges">No bill-level charges.</p>
        {:else}
          <ul>
            {#each snapshot.charges as charge, index (index)}
              <li data-testid="share-charge-row">
                {charge.label} ({charge.type}): {formatPaise(charge.amount)}
                <span class="hint">{charge.included ? "already inside the item prices" : "added to the bill"}</span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if snapshot.adjustmentLines.length > 0}
          <h3>Adjustments</h3>
          <ul>
            {#each snapshot.adjustmentLines as line, index (index)}
              <li data-testid="share-adjustment-row">
                {line.reason}: {formatPaise(line.amount)} carried by {nameOf(line.assignedToParticipantId)}
              </li>
            {/each}
          </ul>
        {/if}

        <p class="hint" data-testid="share-total">
          Printed total: {formatPaise(snapshot.bill.grandTotal)} · tax-inclusion summary:
          {snapshot.bill.taxIncluded === null
            ? "unknown"
            : snapshot.bill.taxIncluded
              ? "included"
              : "charged separately"}
        </p>
      </div>
    {/if}

    <p class="disclosure" data-testid="share-disclosure">{view.disclosure}</p>
    <ul class="facts">
      {#each SHARE_DISCLOSURE_SUPPORT as fact (fact)}
        <li data-testid="share-disclosure-fact">{fact}</li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .rows {
    list-style: none;
    padding: 0;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    border-bottom: 1px solid #eee;
    padding: 6px 0;
  }

  .name {
    font-weight: 600;
    min-width: 6rem;
  }

  .badge {
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 0.78em;
    background: #cfe2ff;
    color: #084298;
  }

  .picker {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 8px 0 4px;
  }

  .disclosure {
    border: 1px solid #ffe28a;
    background: #fff8e1;
    border-radius: 4px;
    padding: 10px 12px;
    margin-top: 16px;
    font-weight: 500;
  }

  .facts {
    font-size: 0.82em;
    color: #555;
    padding-left: 18px;
  }

  .hint,
  .placeholder,
  .raw {
    font-size: 0.82em;
    color: #555;
  }

  .raw {
    display: block;
    margin-bottom: 8px;
  }

  .alert-error {
    background: #f8d7da;
    color: #842029;
    border: 1px solid #f5c6cb;
    border-radius: 4px;
    padding: 8px 12px;
    margin: 8px 0;
  }

  ul {
    margin: 4px 0;
  }
</style>
