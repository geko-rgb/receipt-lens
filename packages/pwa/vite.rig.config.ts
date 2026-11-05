import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";
import { defineConfig } from "vite";

/**
 * Ticket 14 — the migration rig's own build (DECISIONS/0023 P9, S1).
 *
 * A separate Vite config on purpose. The rig needs a migration step that throws, and shipped code must not
 * carry one (P3: no test backdoor in the module that owns the user's data), so the rig gets its own entry,
 * its own output directory and its own script — `pnpm build`, which CI and the footprint measurement use,
 * never runs it. `smoke.spec.ts` asserts the rig is not inside `dist/app`.
 *
 * It lives here rather than under `playwright/` because the Svelte plugin resolves from this package.
 */
const rigDir = path.join(import.meta.dirname, "rig");

export default defineConfig({
  // Asset URLs are prefixed `/rig/` so the shared server resolves them against the rig's own output
  // directory instead of the shipped app's `dist/app/assets`. Without it the rig's `rig.html` asks for
  // `/assets/rig-*.js`, that path exists in neither place it could be right, and the page never boots.
  base: "/rig/",
  root: rigDir,
  plugins: [svelte()],
  build: {
    outDir: path.join(rigDir, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: path.join(rigDir, "rig.html") },
  },
});
