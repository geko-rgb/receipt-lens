<script lang="ts">
  // Ticket 16 owns the fragment codec: version, token, nonce, ciphertext, AES-GCM decryption and
  // validation. The shell hands over the RAW fragment (DECISIONS/0017 D3a) and decodes nothing here,
  // so a future codec change cannot be masked by router-side normalisation.
  let { fragment }: { fragment: string } = $props();
</script>

<h1>Share</h1>
{#if fragment.length === 0}
  <p data-testid="share-state">No share link was opened.</p>
  <p class="placeholder" data-testid="share-placeholder">Placeholder view — ticket 16 owns the participant view and its messages.</p>
{:else}
  <p data-testid="share-state">Share link received.</p>
  <p class="placeholder" data-testid="share-placeholder">
    Ticket 16 decodes this fragment. The shell proves only that it arrives unchanged, so the raw string
    is published for the integrity check and never parsed here.
  </p>
  <code data-testid="share-fragment" data-raw={fragment}>{fragment.length} characters received</code>
{/if}
