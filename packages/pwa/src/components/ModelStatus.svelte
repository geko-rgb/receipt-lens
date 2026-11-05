<script lang="ts">
  import { modelStatusCopy, modelStatusId } from "../lib/models/model-state.svelte.js";
</script>

{#if modelStatusCopy() !== null}
  <!-- DECISIONS/0027 W7.3: the model cache is shell-level state, not a condition of one view. A receipt
       cannot be read without it, and a pending update is not an error the capture route owns. -->
  <aside id="model-status" data-testid="model-status" data-model-status={modelStatusId()} role="status">
    <p>{modelStatusCopy()}</p>
  </aside>
{/if}
