/**
 * Ticket 10a drift check (DECISIONS/0008 reporting discipline: artifacts are checked, not
 * claimed). Every number published in DECISIONS/0017 is re-read from the committed evidence
 * artifact here and compared against the value in the record. Run:
 *
 *   node scripts/pwa-framework/verify-evidence.mjs
 *
 * It checks the published artifact; it does not rebuild it. Re-derivation is
 * `cd scripts/pwa-framework && pnpm install --ignore-scripts && node measure.mjs --browser`,
 * which needs registry access and the git-ignored SROIE sample image.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const probeDir = import.meta.dirname;
const artifact = path.join(probeDir, "results", "framework-evidence.json");
const evidence = JSON.parse(await readFile(artifact, "utf8"));

const failures = [];
function is(label, actual, expected) {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, found ${actual}`);
}

function variant(app, name) {
  const entry = evidence?.apps?.[app]?.variants?.[name];
  if (!entry) failures.push(`missing ${app}/${name}`);
  return entry ?? {};
}

function entryFile(app, name) {
  const v = variant(app, name);
  const base = (v.chunkGraph?.entry ?? "").split("/").pop();
  return v.dist?.find((file) => file.file.endsWith(base)) ?? {};
}

// --- D1: first-paint entry chunk, raw / gzip / brotli -------------------------------
const firstPaint = {
  "vanilla bare-history": [47188, 16031, 14268],
  "svelte bare-hash": [86603, 30844, 27602],
  "svelte-history bare-history": [103598, 37462, 33359],
  "react bare-hash": [303256, 96669, 82867],
  "react pwa-history": [303013, 96580, 82883],
};
for (const [key, [raw, gzip, brotli]] of Object.entries(firstPaint)) {
  const [app, name] = key.split(" ");
  const file = entryFile(app, name);
  is(`firstPaint ${key} raw`, file.bytes, raw);
  is(`firstPaint ${key} gzip`, file.gzipBytes, gzip);
  is(`firstPaint ${key} brotli`, file.brotliBytes, brotli);
}
// Deltas DECISIONS/0017 publishes, checked as arithmetic on the same artifact.
is("delta raw, react history - svelte history", 303013 - 103598, 199415);
is("delta gzip, react history - svelte history", 96580 - 37462, 59118);
is("delta brotli, react history - svelte history", 82883 - 33359, 49524);
is("delta raw, react hash - svelte hash", 303256 - 86603, 216653);
is("delta gzip, react hash - svelte hash", 96669 - 30844, 65825);
is("delta raw, svelte-routing - svelte-spa-router", 103598 - 86603, 16995);
is("delta raw, svelte+router - no framework", 86603 - 47188, 39415);

// --- D2/D4: the OCR runtime stays out of first paint, and runs in every build -------
for (const [app, name] of [["svelte", "bare-hash"], ["svelte-history", "bare-history"], ["react", "bare-hash"], ["vanilla", "bare-history"]]) {
  const browser = variant(app, name).browser ?? {};
  is(`ortAtFirstPaint ${app}`, browser.ortTouchedAtFirstPaint, false);
  is(`probeAtFirstPaint ${app}`, browser.probeAtFirstPaint, "idle");
  is(`crossOriginIsolated ${app}`, browser.crossOriginIsolated, true);
  is(`ocr state ${app}`, browser.ocrResult?.ocr, "ready");
  is(`ocr lines ${app}`, browser.ocrResult?.parsed?.lines, 29);
  is(`ocr words ${app}`, browser.ocrResult?.parsed?.words, 75);
  const lazy = variant(app, name).chunkGraph?.dynamicEntries ?? [];
  is(`lazy ORT glue chunk ${app}`, lazy.some((file) => file.includes("ort.wasm.bundle.min")), true);
  const glue = (variant(app, name).dist ?? []).find((file) => file.file.includes("ort.wasm.bundle.min")) ?? {};
  is(`ORT glue bytes ${app}`, glue.bytes, 74322);
  is(`glue carries the runtime markers ${app}`, (glue.ortMarkers ?? []).length, 2);
}
is("cold OCR phase bytes (svelte)", variant("svelte", "bare-hash").browser?.ocrPhaseBytes, 21372257);
is("cold OCR phase bytes (react)", variant("react", "bare-hash").browser?.ocrPhaseBytes, 21372257);

// --- D4: routing and the #v1 fragment ----------------------------------------------
is("fragment payload length", evidence.how?.fragmentPayloadLength, 7755);
function routeCase(app, name, caseName) {
  return (variant(app, name).routing?.cases ?? []).find((entry) => entry.name === caseName) ?? {};
}
for (const [app, name] of [["svelte-history", "bare-history"], ["react", "pwa-history"], ["vanilla", "bare-history"]]) {
  const pathCase = routeCase(app, name, "path-route-with-fragment");
  is(`path-mode ${app}: /share routes`, pathCase.observed?.heading, "Share");
  is(`path-mode ${app}: fragment byte-identical`, pathCase.fragmentDeliveredByteIdentical, true);
  is(`path-mode ${app}: payload readable from location.hash`, pathCase.payloadReadableFromLocationHash, true);
  const rootCase = routeCase(app, name, "index-with-bare-fragment-payload");
  is(`path-mode ${app}: root path served with fragment intact`, rootCase.fragmentDeliveredByteIdentical, true);
  is(`path-mode ${app}: app sees the payload at /`, rootCase.payloadReadableViaProbeSnapshot, true);
  is(`path-mode ${app}: no server rewrite for a deep link`, variant(app, name).noFallback?.deepLinkWithoutServerRewrite, 404);
}
const svelteHash = routeCase("svelte", "bare-hash", "index-with-bare-fragment-payload");
is("svelte-spa-router swallows the fragment (no route, no app view)", svelteHash.payloadReadableViaProbeSnapshot, false);
is("svelte-spa-router still leaves location.hash intact", svelteHash.payloadReadableFromLocationHash, true);
const svelteHashRoute = routeCase("svelte", "bare-hash", "hash-route-payload");
is("hash-mode router param carries the payload intact", svelteHashRoute.payloadReadableViaRouterParam, true);

// --- D5/D6: service worker precache -------------------------------------------------
const limitMessage = 'Configure "workbox.maximumFileSizeToCacheInBytes" to change the limit: the default value is 2 MiB.';
for (const app of ["svelte", "svelte-history", "react", "vanilla"]) {
  const v = variant(app, "pwa-history");
  is(`default-limit build fails ${app}`, v.buildFailed, true);
  is(`default-limit failure text ${app}`, v.buildFailureMessage, limitMessage);
  is(`default limit excludes the wasm ${app}`, v.serviceWorker?.wasmPrecached, false);
  is(`default limit exclusion list ${app}`, (v.serviceWorker?.notPrecached ?? []).join(","), "assets/ort-wasm-simd-threaded-qh98TCA_.wasm");
  const big = variant(app, "pwa-big");
  is(`raised-limit build succeeds ${app}`, big.buildFailed, false);
  is(`raised limit precaches the wasm ${app}`, big.serviceWorker?.wasmPrecached, true);
  is(`navigation fallback registered ${app}`, big.serviceWorker?.navigationFallbackRegistered, true);
  is(`skipWaiting ${app}`, big.serviceWorker?.skipWaiting, true);
  is(`clientsClaim ${app}`, big.serviceWorker?.clientsClaim, true);
  is(`cleanupOutdatedCaches ${app}`, big.serviceWorker?.cleanupOutdatedCaches, true);
  is(`nothing left unprecached ${app}`, (big.serviceWorker?.notPrecached ?? []).length, 0);
}
is("precached bytes, svelte shell", variant("svelte", "pwa-big").serviceWorker?.precachedBytes, 15011240);
is("precached bytes, svelte-routing shell", variant("svelte-history", "pwa-big").serviceWorker?.precachedBytes, 15028235);
is("precached bytes, react shell", variant("react", "pwa-big").serviceWorker?.precachedBytes, 15228465);
is("precached bytes, vanilla shell", variant("vanilla", "pwa-big").serviceWorker?.precachedBytes, 14972628);
is("model assets are not build outputs", (variant("svelte", "pwa-big").serviceWorker?.precacheEntries ?? []).some((url) => url.endsWith(".onnx")), false);

// --- no third-party request targets in any built shell ------------------------------
for (const [app, data] of Object.entries(evidence.apps ?? {})) {
  for (const [name, v] of Object.entries(data.variants ?? {})) {
    for (const file of v.dist ?? []) {
      for (const url of file.externalUrlRefs ?? []) {
        if (/\/(svelte\.dev|react\.dev|reactrouter\.com|rolldown\.rs|bit\.ly|web\.dev|www\.w3\.org|localhost)/.test(url)) continue;
        failures.push(`unexpected external reference ${app}/${name}/${file.file}: ${url}`);
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`DECISIONS/0017 evidence check FAILED (${failures.length}):\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("DECISIONS/0017 evidence check passed: every published number re-derives from results/framework-evidence.json\n");
}
