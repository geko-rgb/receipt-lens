<script lang="ts">
  /**
   * Ticket 16 — the creator's share panel (DECISIONS/0026 A4, A7, A10).
   *
   * It renders what `buildShareLinks` already produced for the bill view, because generating the links is one
   * action per locked revision rather than one per message: the same frozen payload under N keys, so a
   * participant's link is theirs and the panel that shows the budget is the panel that made it.
   */
  import type { BillDocument } from "../lib/bill/document.js";
  import { participantLinkFor } from "../lib/settlement-links.js";
  import { SHARE_FRAGMENT_MAX_BYTES } from "../lib/share/codec.js";
  import { budgetPercent, type ShareLink, type ShareLinkFailureCode, type ShareLinkOutcome } from "../lib/share/link.js";
  import { SHARE_DISCLOSURE, SHARE_DISCLOSURE_SUPPORT } from "../lib/share/view.js";

  let { bill, outcome }: { bill: BillDocument; outcome: ShareLinkOutcome | null } = $props();

  let copied = $state("");

  const names = $derived(new Map(bill.working.participants.map((p) => [p.id, p.name])));
  const origin = window.location.origin;

  /** A4's remedy copy, and the only place a refusal is explained: the row gets no link, not a broken one. */
  const REFUSALS: Readonly<Record<ShareLinkFailureCode, string>> = {
    link_budget_exceeded:
      "This bill is too large for one share link. Shorten or remove non-essential item and charge labels, then " +
      "lock again. Nothing was truncated: a cut link is not a smaller valid link, it is an unreadable one.",
    bill_locked: "Links come from a locked bill, because a link freezes what the bill was at that moment.",
    grand_total_missing: "This bill has no resolved grand total, so there is nothing frozen to share.",
    units_unassigned: "Some units are neither assigned nor acknowledged, so this bill has no final shares to share.",
    unsupported_link_version: "This build cannot make a link of that version.",
    link_corrupt_or_tampered: "The link could not be built from this bill.",
    link_schema_invalid: "This bill does not fit the share snapshot format.",
  };

  function url(fragment: string): string {
    return participantLinkFor(origin, fragment);
  }

  function copy(link: ShareLink): void {
    // The field is selectable by hand too; a clipboard this context refuses is said so rather than faked.
    navigator.clipboard
      ?.writeText(url(link.fragment))
      .then(
        () => (copied = link.participantId),
        () => (copied = ""),
      )
      .catch(() => (copied = ""));
  }

  function readable(iso: string): string {
    return new Date(iso).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" });
  }
</script>

<section data-testid="share-links-section">
  <h2>Share links</h2>
  <p class="hint">
    Each link carries this bill inside itself: no login, no server, and nothing fetched when it is opened. One
    link per participant, because the key is the token that person was sent.
  </p>

  {#if outcome === null}
    <p class="hint" data-testid="share-links-pending">Preparing the links…</p>
  {:else if !outcome.ok}
    <p class="alert-error" role="alert" data-testid="share-refusal" data-code={outcome.code}>{REFUSALS[outcome.code]}</p>
  {:else}
    <ul class="links">
      {#each outcome.links as link (link.participantId)}
        <li class="link" data-testid="share-link-row" data-participant-id={link.participantId}>
          <span class="name">{names.get(link.participantId) ?? link.participantId}</span>
          <input type="text" readonly data-testid="share-link-url" value={url(link.fragment)} />
          <button type="button" data-testid="share-link-copy" onclick={() => copy(link)}>Copy</button>
          {#if copied === link.participantId}
            <span class="badge" data-testid="share-link-copied">copied</span>
          {/if}
          <!-- A4: the meter reads the string that was produced, so the number and the link cannot disagree. -->
          <span class="budget" data-testid="share-budget" data-bytes={link.bytes} data-max={SHARE_FRAGMENT_MAX_BYTES}>
            {link.bytes} / {SHARE_FRAGMENT_MAX_BYTES} bytes ({budgetPercent(link.bytes)}%)
          </span>
        </li>
      {/each}
    </ul>

    {#if outcome.links.length < bill.working.participants.length}
      <p class="hint" data-testid="share-missing-tokens">
        {bill.working.participants.length - outcome.links.length} participant(s) on this bill have no share
        token, so they are offered no link.
      </p>
    {/if}

    <p class="hint" data-testid="share-frozen-at">
      Frozen from the lock at <time datetime={outcome.snapshot.snapshotCreatedAt}
        >{readable(outcome.snapshot.snapshotCreatedAt)}</time
      >. Unlocking and re-locking makes a new bill and new links; the old ones keep showing what they were sent.
    </p>
  {/if}

  <p class="disclosure" data-testid="share-disclosure">{SHARE_DISCLOSURE}</p>
  <ul class="facts">
    {#each SHARE_DISCLOSURE_SUPPORT as fact (fact)}
      <li>{fact}</li>
    {/each}
  </ul>
</section>

<style>
  .links {
    list-style: none;
    padding: 0;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .link {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    border-bottom: 1px solid #eee;
    padding: 6px 0;
  }

  .name {
    font-weight: 600;
    min-width: 6rem;
  }

  input[type="text"] {
    flex: 1 1 18rem;
    min-width: 12rem;
    font-family: ui-monospace, monospace;
    font-size: 0.78em;
    padding: 4px 6px;
  }

  .budget,
  .hint {
    font-size: 0.8em;
    color: #555;
  }

  .budget {
    font-variant-numeric: tabular-nums;
  }

  .badge {
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 0.75em;
    background: #d1e7dd;
    color: #0f5132;
  }

  .disclosure {
    border: 1px solid #ffe28a;
    background: #fff8e1;
    border-radius: 4px;
    padding: 10px 12px;
    margin-top: 12px;
    font-weight: 500;
  }

  .facts {
    font-size: 0.8em;
    color: #555;
    padding-left: 18px;
  }

  .alert-error {
    background: #f8d7da;
    color: #842029;
    border: 1px solid #f5c6cb;
    border-radius: 4px;
    padding: 8px 12px;
    margin: 8px 0;
  }

  section {
    margin-top: 20px;
  }
</style>
