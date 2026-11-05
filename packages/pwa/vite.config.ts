import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import { renderIconPng } from "../../scripts/make-icons.mjs";
import { appManifest } from "./src/lib/sw/manifest.js";
import {
  PRECACHE_PLACEHOLDER,
  assertNoModelAssets,
  assertPrecacheComplete,
  buildPrecacheEntries,
} from "./src/precache.js";

/**
 * Ticket 17 — the shell build, plus the service-worker plugin DECISIONS/0027 W1.1 and W11 ask for.
 *
 * The worker is a second entry with a fixed name: a service worker's scope is the directory its script is
 * served from, so `/sw.js` is what gives the app scope `/` and lets a deep link like `/share#v1…` be served
 * offline (W10). `entryFileNames` therefore pins `sw.js` outside the hashed `assets/` tree.
 *
 * The plugin does three things in `generateBundle`, when the whole output is finally known: it emits the
 * manifest and the icons, replaces the precache placeholder in the worker's code, and runs W1.1's completeness
 * guard in both directions. The guard failing the build is the point — it is the setting that replaces
 * Workbox's `maximumFileSizeToCacheInBytes`, which dropped an over-limit asset silently while the build still
 * succeeded, and it is owner Condition 2: an omission is caught before anything ships, not at someone's first
 * offline attempt.
 */

/**
 * The worker's entry name. Its output is pinned to `sw.js` below, because a service worker's scope is the
 * directory its script is served from (W10).
 */
const SW_ENTRY = "sw";

/**
 * The app entry keeps the name `index`, so the emitted chunk stays `assets/index-[hash].js`. Renaming it here
 * would silently move the file `playwright/smoke.spec.ts` and `serve-app.mjs`'s content-type handling both
 * look for, which is a bad trade for a shorter key.
 */
const APP_ENTRY = "index";

/**
 * The icons and the web app manifest are emitted rather than committed: nothing binary enters git, and the
 * bytes are re-derivable from `scripts/make-icons.mjs` and `src/lib/sw/manifest.ts` on any machine.
 */
function pwaAssets(): Plugin {
  return {
    name: "receipt-lens:pwa",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: JSON.stringify(appManifest(), null, 2),
      });
      this.emitFile({ type: "asset", fileName: "icons/receipt-lens-192.png", source: renderIconPng(192) });
      this.emitFile({ type: "asset", fileName: "icons/receipt-lens-512.png", source: renderIconPng(512) });
      this.emitFile({
        type: "asset",
        fileName: "icons/receipt-lens-512-maskable.png",
        source: renderIconPng(512, { maskable: true }),
      });

      // Vite writes the build manifest itself, after this hook, so it is named here rather than discovered.
      const distPaths = [...Object.keys(bundle), ".vite/manifest.json"];
      const entries = buildPrecacheEntries(distPaths);

      const worker = Object.entries(bundle).find(([key]) => key === "sw.js");
      if (!worker) throw new Error("DECISIONS/0027 W1.1: the service worker was not emitted, so there is nothing to precache");
      // The placeholder is an identifier, not a comment: a bundler discards comments and preserves an
      // undeclared global reference, so this is the form that survives to the artifact being checked.
      const token = PRECACHE_PLACEHOLDER;
      const injected = JSON.stringify(entries);
      const code = (worker[1] as { code: string }).code;
      if (!code.includes(token)) {
        throw new Error(`DECISIONS/0027 W1.1: the built sw.js does not contain the precache token ${token}, so the manifest has nowhere to go`);
      }
      (worker[1] as { code: string }).code = code.replace(token, injected);

      // W1.1, both directions. A failure here fails `pnpm build`, which fails CI, which fails the merge.
      assertPrecacheComplete(distPaths, entries);
      assertNoModelAssets(entries);
      const wasm = entries.filter((entry) => entry.url.endsWith(".wasm"));
      if (wasm.length !== 1) {
        throw new Error(`DECISIONS/0027 W1.1 / F12: expected exactly one precached runtime WASM, found ${wasm.length}. The offline-reload claim depends on this one being cached.`);
      }
    },
  };
}

export default defineConfig({
  plugins: [svelte(), pwaAssets()],
  build: {
    // dist/ holds tsc output for the pure-TS modules; the deployable shell bundle goes to dist/app so
    // ticket 08's footprint remeasurement (DECISIONS/0017 D9) has one directory to read.
    outDir: "dist/app",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    rollupOptions: {
      input: { [APP_ENTRY]: "index.html", [SW_ENTRY]: "src/sw.ts" },
      output: {
        entryFileNames: (chunk) => (chunk.name === SW_ENTRY ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
