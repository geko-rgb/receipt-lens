<script lang="ts">
  // Tickets 11 to 13 own the editor, per-unit ownership and the lock checklist. Ticket 10 hands a
  // draft in through `lib/draft.ts`; this view only proves the handoff arrived, and says so plainly
  // while the editor does not exist.
  import { getDraft } from "../lib/draft.js";

  const draft = getDraft();
</script>

<h1>Bill</h1>
{#if draft}
  <p data-testid="bill-note">Draft received from capture.</p>
  <p data-testid="draft-counts">
    {draft.items.length} draft item(s), {draft.charges.length} draft charge(s),
    {draft.validation.findings.length} finding(s).
  </p>
  <ul data-testid="draft-items">
    {#each draft.items as item (item.id)}
      <li>{item.name}</li>
    {/each}
  </ul>
{:else}
  <p data-testid="bill-note">No draft yet — capture a receipt first.</p>
{/if}
<p class="placeholder">The bill editor arrives in ticket 11.</p>

<style>
  .placeholder {
    color: #666;
    font-size: 0.85em;
  }
</style>
