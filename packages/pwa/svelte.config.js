import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  // vitePreprocess is what lets the components keep `lang="ts"`; without it the TS in a <script>
  // block reaches the browser unchanged.
  preprocess: [vitePreprocess()],
};
