<script lang="ts">
  // D3a condition 2: an unknown path shows not-found, and showing it must not break fragment
  // preservation when a fragment is present. A fragment-bearing LANDING page (`/#v1.…`) goes to the
  // share view instead — that is the share-link entry point.
  let { fragment }: { fragment: string } = $props();
</script>

<h1>Not found</h1>
<p data-testid="notfound-fragment">
  {fragment.length === 0 ? "No fragment." : `Fragment preserved (${fragment.length} characters).`}
</p>
<p class="placeholder" data-testid="notfound-note">Placeholder view — ticket 10a navigation only.</p>
