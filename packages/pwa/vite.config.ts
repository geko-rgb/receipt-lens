import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import { existsSync, readFileSync, readdirSync, createReadStream, statSync, writeFileSync } from "node:fs";
import path from "node:path";
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
  let outDir = "";
  let root = "";

  /** Every file the build actually wrote, as a `dist/app`-relative path. */
  const written = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const next = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) return next.startsWith("/.vite") ? [] : written(path.join(dir, entry.name), next);
      return [next.replace(/^\//, "")];
    });

  return {
    name: "receipt-lens:pwa",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
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
      void bundle;
    },
    /**
     * Guards and injection run here, after the files exist. They ran in `generateBundle` first, and the
     * enumeration came out short: assets emitted by `emitFile` inside the same hook were not in the bundle
     * object, so the completeness guard checked a list that omitted the icons and the manifest, passed, and
     * shipped a worker that precached neither. A guard that measures the wrong file set is worse than no
     * guard, because it looks like a check. The directory written is the only authoritative answer.
     */
    writeBundle() {
      const swPath = path.join(outDir, "sw.js");
      if (!existsSync(swPath)) {
        throw new Error(`DECISIONS/0027 W1.1: no ${swPath} — the build wrote no service worker to precache from`);
      }
      const distPaths = [...written(outDir, ""), ".vite/manifest.json"];
      const entries = buildPrecacheEntries(distPaths);

      // W1.1, both directions. Failing here fails `pnpm build`, which fails CI, which fails the merge.
      assertPrecacheComplete(distPaths, entries);
      assertNoModelAssets(entries);
      const wasm = entries.filter((entry) => entry.url.endsWith(".wasm"));
      if (wasm.length !== 1) {
        throw new Error(
          `DECISIONS/0027 W1.1 / F12: expected exactly one precached runtime WASM, found ${wasm.length}. The offline-reload claim depends on this one being cached.`,
        );
      }

      const code = readFileSync(swPath, "utf8");
      if (!code.includes(PRECACHE_PLACEHOLDER)) {
        throw new Error(`DECISIONS/0027 W1.1: sw.js does not carry ${PRECACHE_PLACEHOLDER}, so the manifest has nowhere to go`);
      }
      writeFileSync(swPath, code.replace(PRECACHE_PLACEHOLDER, JSON.stringify(entries)));
      void root;
    },
  };
}

/**
 * Dev only: the production server (scripts/serve-app.mjs) serves the repository's model assets at
 * `/assets/models/*`, but `vite dev` had no such mapping — its SPA fallback answered the manifest
 * probe with `index.html`, so every preparation attempt failed as `unavailable` and the capture
 * screen never left "Models are not on this device yet". This mirrors the production mapping for
 * the dev server alone; the build keeps model assets out of the bundle on purpose (W1.1's
 * `assertNoModelAssets`), so the plugin does not apply at build time.
 */
function devModelAssets(): Plugin {
  return {
    name: "receipt-lens:dev-model-assets",
    apply: "serve" as const,
    configureServer(server) {
      const modelDir = path.resolve(import.meta.dirname, "../../assets/models");
      const contentTypes: Record<string, string> = {
        ".json": "application/json",
        ".onnx": "application/octet-stream",
        ".txt": "text/plain",
      };
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0]!;
        if (!url.startsWith("/assets/models/")) return next();
        const name = url.slice("/assets/models/".length);
        const file = path.resolve(modelDir, name);
        if (!file.startsWith(`${modelDir}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("content-type", contentTypes[path.extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), devModelAssets(), pwaAssets()],
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
