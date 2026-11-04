#!/usr/bin/env node
/**
 * Ticket 08 — measure the footprint, do not claim it.
 *
 *   node benchmarks/scripts/measure-footprint.mjs [--samples 5] [--image path]
 *
 * What is measured, in one sentence: what a user's browser must download and keep, and how
 * long it takes, to get one receipt image through the pipeline on the only browser deployment
 * this repo has today — the PROJECT(1).md §9 M1 harness page.
 *
 * Each sample is one fresh browser context against one fresh server instance, in three phases:
 *   cold    first visit, empty cache;
 *   warm    same context, page reloaded — every asset the HTTP cache retains answers 304 with no
 *           body; an asset larger than the browser's cache-entity limit is re-downloaded in full,
 *           which is published as the finding it is rather than assumed away (DECISIONS/0012 F10);
 *   repeat  second receipt in the same page — WASM and both inference sessions already in memory.
 * Bytes are counted by the origin that served them (harness/serve.mjs request log), because the
 * WebAssembly and worker loads never appear in the page's own resource timings. Latency is
 * taken inside the page against `performance.timeOrigin`, so no Playwright round-trip is hidden
 * in a published number — the one it does carry is reported as `harnessLatencyMs`.
 *
 * Output: `benchmarks/results/footprint.json` (canonical, what the table generator reads) and the
 * archive copy `footprint-<date>-<git-sha>.json` named after the revision it was measured from.
 * Both are committed. Nothing in the README is typed by hand.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../../harness/serve.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resultsDir = path.join(repoRoot, "benchmarks", "results");
const PROTOCOL = "receipt-lens-footprint/1";
const SCHEMA_VERSION = "1.0";
const PHASE_LABEL = {
  cold: "Cold start — first visit, empty cache",
  warm: "Warm visit — same browser, assets revalidated from cache",
  repeat: "Second receipt — same page, sessions already in memory",
};

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const samplesPerState = Number(flagValue("samples", "5"));
const debug = argv.includes("--debug");
const started = Date.now();
const trace = (message) => {
  if (debug) console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
};
const imagePath = path.resolve(
  flagValue("image", path.join(repoRoot, "benchmarks/datasets/raw/sroie/assets/ex.jpg")),
);
if (!Number.isInteger(samplesPerState) || samplesPerState < 2) {
  throw new Error(`--samples must be an integer >= 2, got ${samplesPerState}`);
}

/**
 * Declared classes. Both are this machine and this browser build; the second is an emulated CPU
 * throttle, which is a stated proxy for slower hardware and explicitly NOT a phone. A real device
 * class needs a real device; inventing one here would be exactly the folklore this ticket exists
 * to end.
 */
const CLASSES = [
  {
    id: "desktop-chromium-unthrottled",
    label: "Desktop Chromium (headless), this machine at native speed",
    cpuThrottleRate: 1,
    declaredAs: "physical desktop machine, loopback origin, no bandwidth throttling, no network emulation",
  },
  {
    id: "desktop-chromium-cpu4x",
    label: "Desktop Chromium (headless), 4x emulated CPU throttle",
    cpuThrottleRate: 4,
    declaredAs:
      "the same physical machine with Chromium's Emulation.setCPUThrottlingRate at 4x (the Lighthouse slow-4x convention). Emulation, not a device: it slows script, WASM compile and inference, and says nothing about a phone's memory, GPU or network stack.",
  },
];

/**
 * The rows the ticket requires. `required` entries must appear in every cold sample, which is what
 * stops a silent shape change (an ORT upgrade that swaps the WASM build, a renamed asset) from
 * publishing a table with a missing row.
 */
const ROLES = [
  { test: (url) => url === "/" || url === "/index.html", role: "Harness page (HTML)", category: "app", required: true },
  { test: (url) => url === "/dist/main.js", role: "Application script (core + runtime JS glue)", category: "app", required: true },
  { test: (url) => url === "/assets/models/manifest.json", role: "Model manifest", category: "model", required: true },
  { test: (url) => url.endsWith("/PP-OCRv6_tiny_det.onnx"), role: "Detection model (PP-OCRv6 Tiny)", category: "model", required: true },
  { test: (url) => url.endsWith("/PP-OCRv6_tiny_rec.onnx"), role: "Recognition model (PP-OCRv6 Tiny)", category: "model", required: true },
  { test: (url) => url.endsWith("/PP-OCRv6_tiny_rec.txt"), role: "Recognition dictionary", category: "model", required: true },
  { test: (url) => url.startsWith("/ort/") && url.endsWith(".wasm"), role: "Inference runtime WASM", category: "runtime", required: true },
  { test: (url) => url.startsWith("/ort/"), role: "Inference runtime JS loader", category: "runtime", required: false },
];

/**
 * Assets this deployment's HTTP cache provably does not retain, with the measured reason. This is an
 * exception list the warm phase verifies against, not a permission slip: anything outside it that
 * arrives with a full body on a warm visit still fails the run, and an entry here that starts being
 * retained fails the run too (the declaration would be stale). DECISIONS/0012 F10 has the evidence.
 */
const NOT_RETAINABLE = new Map([
  [
    "/ort/ort-wasm-simd-threaded.wasm",
    "larger than this Chromium build's HTTP-cache entity limit — it answers 200 with its full body on every warm visit while all seven smaller assets answer 304 (DECISIONS/0012 F10)",
  ],
]);

const classify = (url) => ROLES.find((entry) => entry.test(url)) ?? { role: `uncatalogued ${url}`, category: "other", required: false };

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const gitInfo = {
  revision: git(["rev-parse", "HEAD"]),
  shortRevision: git(["rev-parse", "--short", "HEAD"]),
  branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  dirtyPaths: git(["status", "--porcelain"]).split("\n").filter((line) => line.trim() !== "").map((line) => line.slice(3)),
};

const readFileOf = async (file) => readFile(file);
const byteLengthOf = async (file) => (await readFileOf(file)).byteLength;
const sha256Of = async (file) => createHash("sha256").update(await readFileOf(file)).digest("hex");

/** The committed model bytes: the manifest the provider verifies against is the same record. */
const modelManifestPath = path.join(repoRoot, "assets/models/manifest.json");
const modelManifest = JSON.parse(await readFile(modelManifestPath, "utf8"));
const pinnedModelBytes = new Map(
  modelManifest.assets.map((asset) => [`/assets/models/${asset.file}`, { bytes: asset.bytes, sha256: asset.sha256 }]),
);

/** onnxruntime-web is a dependency of packages/core, so it resolves from there (as serve.mjs does). */
const coreRequire = createRequire(path.join(repoRoot, "packages/core/package.json"));
const ortDistDir = path.dirname(coreRequire.resolve("onnxruntime-web/wasm"));
const ortPackage = JSON.parse(await readFile(path.join(ortDistDir, "..", "package.json"), "utf8"));

const imageBytes = await readFile(imagePath);
const appBundleFile = "harness/dist/main.js";

const round = (value) => Math.round(value * 10) / 10;
const medianOf = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};
function summarize(values) {
  const rounded = values.filter((value) => value !== null && Number.isFinite(value)).map(round);
  if (rounded.length === 0) return { n: 0, min: null, median: null, max: null, mean: null, samples: [] };
  return {
    n: rounded.length,
    min: Math.min(...rounded),
    median: round(medianOf(rounded)),
    max: Math.max(...rounded),
    mean: round(rounded.reduce((sum, value) => sum + value, 0) / rounded.length),
    samples: rounded,
  };
}

/**
 * One phase: hand the image to the page and wait for a *new* result object.
 *
 * Every call here is short-lived. A pending `page.evaluate` whose promise resolves inside the
 * browser never returns to the driver here (the poll loop stops running once the page is busy),
 * which stalls the whole sample; `waitForFunction` is the primitive that survives it. The marker
 * is stashed in the page rather than passed in, because `harness.last` from the previous phase is
 * a live object that cannot cross the boundary — and comparing against a serialized `null` would
 * make the repeat phase return the warm run a second time.
 */
async function runPhase(page, file) {
  const startedAtMs = await page.evaluate(() => {
    window.__footprintMarker = window.__receiptLensHarness?.last;
    return performance.now();
  });
  await page.setInputFiles("#file", file);
  trace("  image handed over; waiting for a new result object");
  await page.waitForFunction(
    () => {
      const harness = window.__receiptLensHarness;
      if (!harness) return true;
      return Boolean(harness.last && harness.last !== window.__footprintMarker) || Boolean(harness.error);
    },
    undefined,
    { timeout: 120_000, polling: "raf" },
  );
  const run = await page.evaluate((started) => {
    const harness = window.__receiptLensHarness;
    if (harness?.error) {
      throw new Error(`harness reported ${harness.error.code ?? harness.error.name}: ${harness.error.message}`);
    }
    const last = harness?.last;
    if (!last || last === window.__footprintMarker) {
      throw new Error("the served page never exposed a new harness result — wrong build?");
    }
    const tenth = (value) => Math.round(value * 10) / 10;
    return {
      detectedAtMs: performance.now(),
      startedAtMs: started,
      timings: last.timings,
      assets: last.assets,
      session: last.session,
      executionProvider: last.executionProvider,
      provider: last.result.provider,
      version: last.result.version,
      lines: last.result.lines.length,
      words: last.result.lines.reduce((count, line) => count + line.words.length, 0),
      imageSize: last.result.imageSize,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      userAgent: navigator.userAgent,
      navigation: performance
        .getEntriesByType("navigation")
        .map((entry) => ({
          responseEndMs: tenth(entry.responseEnd),
          domContentLoadedMs: tenth(entry.domContentLoadedEventEnd),
          loadEventMs: tenth(entry.loadEventEnd),
        }))[0],
      resources: performance.getEntriesByType("resource").map((entry) => ({
        url: new URL(entry.name, location.href).pathname,
        transferBytes: entry.transferSize,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
        servedWithoutValidation: entry.transferSize === 0 && entry.encodedBodySize > 0,
      })),
    };
  }, startedAtMs);
  trace(`  run finished: load ${Math.round(run.timings.loadMs)} ms, inference ${Math.round(run.timings.inferenceMs)} ms`);
  return run;
}

async function measureSample(browser, cpuThrottleRate) {
  const server = await startServer(0, { cacheMode: "validate" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const origins = new Set();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  context.on("request", (request) => {
    try {
      origins.add(new URL(request.url()).origin);
    } catch {
      /* blob:/data: URLs are not origins */
    }
  });

  let cdp = null;
  try {
    trace(`sample up: ${server.url} (${server.cacheMode})`);
    if (cpuThrottleRate !== 1) {
      cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
      trace(`  CPU throttle set to ${cpuThrottleRate}x`);
    }

    const phases = {};
    const cut = () => server.requests.length;

    // The mark is taken before the navigation, not after it: the page and its script are part of
    // what a cold visit downloads, and cutting at the load event would silently drop them.
    let mark = cut();
    await page.goto(server.url, { waitUntil: "load" });
    trace("  navigation settled; COLD");
    phases.cold = await runPhase(page, imagePath);
    phases.cold.wire = server.requests.slice(mark);

    mark = cut();
    await page.reload({ waitUntil: "load" });
    trace("  reload settled; WARM");
    phases.warm = await runPhase(page, imagePath);
    phases.warm.wire = server.requests.slice(mark);

    // Clearing first guarantees a change event for the same file, so the repeat phase cannot
    // quietly measure the warm run a second time. It costs no request.
    mark = cut();
    await page.setInputFiles("#file", []);
    trace("  input cleared; REPEAT");
    phases.repeat = await runPhase(page, imagePath);
    phases.repeat.wire = server.requests.slice(mark);

    if (consoleErrors.length > 0) {
      throw new Error(`console errors during the measured run:\n- ${consoleErrors.join("\n- ")}`);
    }
    return { phases, origins: [...origins].sort(), cacheMode: server.cacheMode };
  } finally {
    trace("  closing context");
    await context.close();
    trace("  closing server");
    await server.close();
    trace("  sample down");
  }
}

/** Publish one raw sample, asserting the cache state each phase claims to be in. */
function publishSample(classId, sampleIndex, sample) {
  const published = [];
  for (const [phase, run] of Object.entries(sample.phases)) {
    const where = `${classId} sample ${sampleIndex} (${phase})`;
    // First use of a URL in a phase is the one a cache could have answered; anything after it is a
    // repeat fetch inside the same page. onnxruntime-web's threaded build re-fetches its loader for
    // every worker, so a genuinely cold visit shows one 200 plus N-1 conditionals. That is a
    // property of the deployment, not a stale cache, and it is published as conditionalFetches.
    const firstUse = new Map();
    for (const entry of run.wire) {
      const url = new URL(entry.url, "http://o/").pathname;
      if (!firstUse.has(url)) firstUse.set(url, entry);
    }
    const repeatFetches = run.wire.filter(
      (entry) => firstUse.get(new URL(entry.url, "http://o/").pathname) !== entry,
    );
    const fullBodies = run.wire.filter((entry) => entry.status === 200);
    const failures = run.wire.filter((entry) => entry.status >= 400);
    const assets = Object.fromEntries(
      [...firstUse].filter(([, entry]) => entry.status === 200).map(([url, entry]) => [url, entry.bodyBytes]),
    );
    const servedWithoutValidation = run.resources.filter((entry) => entry.servedWithoutValidation).length;

    if (phase === "cold") {
      for (const [url, entry] of firstUse) {
        if (entry.status !== 200) {
          throw new Error(`${where}: ${url} first arrived as ${entry.status} — the context was not empty, so this is not a cold measurement`);
        }
      }
      for (const entry of fullBodies) {
        const pinned = pinnedModelBytes.get(new URL(entry.url, "http://o/").pathname);
        if (pinned && entry.bodyBytes !== pinned.bytes) {
          throw new Error(`${where}: served ${entry.url} is ${entry.bodyBytes} bytes, the committed manifest pins ${pinned.bytes}`);
        }
      }
    } else if (phase === "warm") {
      // A warm visit must cost nothing except the assets this browser provably cannot retain. A full
      // body for anything else means the cache contract broke, and a 200 with no body means the
      // server or browser is lying — both fail loudly. An asset that the declaration covers but the
      // browser now revalidates is caught after aggregation (stale declaration), not here.
      if (firstUse.size === 0 && servedWithoutValidation === 0) {
        throw new Error(`${where}: the warm visit neither revalidated nor read its own cache — no cache was in use, so "warm" would be a fiction`);
      }
      for (const [url, entry] of firstUse) {
        if (entry.status === 200 && entry.bodyBytes === 0) {
          throw new Error(`${where}: ${url} answered 200 with no body — server or browser is lying about the cache`);
        }
        if (entry.status === 200 && !NOT_RETAINABLE.has(url)) {
          throw new Error(
            `${where}: ${url} was re-downloaded in full on a warm visit — the browser retains it, so a full body here is a broken cache contract (declared non-retainable: ${[...NOT_RETAINABLE.keys()].join(", ")})`,
          );
        }
      }
    } else if (run.wire.length > 0) {
      throw new Error(`${where}: the second receipt touched the network (${run.wire.map((entry) => `${entry.status} ${entry.url}`).join(", ")})`);
    }
    if (failures.length > 0) {
      throw new Error(`${where}: ${failures.length} failed requests (${failures.map((e) => `${e.status} ${e.url}`).join(", ")})`);
    }
    if (!fullBodies.every((entry) => entry.completed)) {
      throw new Error(`${where}: an asset download did not complete`);
    }
    if (run.lines === 0 || run.words === 0) {
      throw new Error(`${where}: ${run.lines} lines / ${run.words} words — footprint numbers from a run that read nothing are meaningless`);
    }
    if (sample.origins.length !== 1) {
      throw new Error(`${where}: ${sample.origins.length} request origins (${sample.origins.join(", ")}) — expected the same origin only (PROJECT(1).md §9)`);
    }

    // cold and warm begin at a navigation, so their latency is measured from navigation start.
    // The repeat phase has none: it is the duration from "receipt handed over" to "result in hand".
    const fromNavigation = phase !== "repeat";
    const base = fromNavigation ? run.startedAtMs : 0;
    published.push({
      class: classId,
      phase,
      sample: sampleIndex,
      appReadyMs: fromNavigation ? round(run.startedAtMs) : null,
      ocrReadyMs: fromNavigation ? round(run.startedAtMs + run.timings.loadMs) : null,
      firstResultMs: round(base + run.timings.totalMs),
      modelLoadMs: round(run.timings.loadMs),
      inferenceMs: round(run.timings.inferenceMs),
      harnessLatencyMs: round(run.detectedAtMs - run.startedAtMs - run.timings.totalMs),
      sinceNavigationMs: fromNavigation ? round(run.detectedAtMs) : null,
      downloadBytes: fullBodies.reduce((sum, entry) => sum + entry.bodyBytes, 0),
      fullBodyRequests: fullBodies.length,
      conditionalFetches: repeatFetches.length,
      firstUseStatus: Object.fromEntries([...firstUse].map(([url, entry]) => [url, entry.status])),
      assetBytes: assets,
      pageObservedTransferBytes: run.resources.reduce((sum, entry) => sum + entry.transferBytes, 0),
      // transferSize includes response headers; the body total does not. The difference is the
      // header cost the page could see, and it is why the byte totals exclude headers explicitly.
      pageObservedHeaderBytes: run.resources.reduce((sum, entry) => sum + entry.transferBytes, 0)
        - fullBodies.reduce((sum, entry) => sum + entry.bodyBytes, 0),
      resourcesServedWithoutValidation: servedWithoutValidation,
      providerName: run.provider,
      lines: run.lines,
      words: run.words,
      imageSize: run.imageSize,
      manifestHash: run.assets.manifestHash,
      providerVersion: run.version,
      providerAssetBytes: run.assets.bytes,
      wasmThreads: run.session?.numThreads ?? null,
      crossOriginIsolated: run.crossOriginIsolated,
      executionProvider: run.executionProvider,
      navigation: run.navigation,
      wire: run.wire.map((entry) => ({
        url: new URL(entry.url, "http://o/").pathname,
        status: entry.status,
        bodyBytes: entry.bodyBytes,
        completed: entry.completed,
      })),
    });
  }
  return published;
}

console.log(`footprint: ${samplesPerState} samples x ${CLASSES.length} classes, image ${path.relative(repoRoot, imagePath)}`);

// A 512 MB HTTP disk cache — far larger than any real profile — so that anything the browser still
// re-downloads on a warm visit cannot be blamed on the cache being too small. Recorded in
// environment.browser.launchArgs for exactly that reason.
const launchArgs = ["--disk-cache-size=536870912"];
const browser = await chromium.launch({ args: launchArgs });
const runs = [];
for (const classSpec of CLASSES) {
  for (let index = 0; index < samplesPerState; index += 1) {
    const sample = await measureSample(browser, classSpec.cpuThrottleRate);
    const published = publishSample(classSpec.id, index, sample);
    runs.push(...published);
    const byPhase = Object.fromEntries(published.map((run) => [run.phase, run]));
    console.log(
      `  ${classSpec.id} #${index}: cold ${Math.round(byPhase.cold.firstResultMs)} ms / ${(byPhase.cold.downloadBytes / 1e6).toFixed(2)} MB · ` +
        `warm ${Math.round(byPhase.warm.firstResultMs)} ms / ${byPhase.warm.downloadBytes} B over the wire · ` +
        `repeat ${Math.round(byPhase.repeat.firstResultMs)} ms`,
    );
  }
}
const meta = runs[0];
await browser.close();

/* ------------------------------------------------------------------ inventory */

const coldRuns = runs.filter((run) => run.phase === "cold");
const warmRuns = runs.filter((run) => run.phase === "warm");
/**
 * Did the browser keep it? A URL that answers 304 on every warm visit was retained; one that
 * answers 200 with its full body every time was not. Measured, not assumed: this is what tells a
 * user whether the second visit costs them anything.
 */
const warmFirstUse = warmRuns.map((run) => run.firstUseStatus);
const cacheBehaviour = (url) => {
  const statuses = warmFirstUse.map((map) => map[url] ?? null);
  const revalidated = statuses.filter((status) => status === 304).length;
  const redownloaded = statuses.filter((status) => status === 200).length;
  if (redownloaded > 0 && revalidated > 0) {
    throw new Error(`${url}: ${revalidated} warm visits revalidated it, ${redownloaded} re-downloaded it — inconsistent caching, and no number about it is safe to publish`);
  }
  return redownloaded > 0 ? "redownloaded" : revalidated > 0 ? "retained" : "not-requested-again";
};

const urls = [...new Set(coldRuns.flatMap((run) => Object.keys(run.assetBytes)))].sort();
const assets = [];
for (const url of urls) {
  const observed = coldRuns.map((run) => run.assetBytes[url] ?? null);
  const hits = observed.filter((bytes) => bytes !== null);
  const { role, category, required } = classify(url);
  const pinned = pinnedModelBytes.get(url);
  const localFile = url.startsWith("/ort/")
    ? path.join(ortDistDir, path.basename(url))
    : url === "/dist/main.js"
      ? path.join(repoRoot, appBundleFile)
      : url === "/assets/models/manifest.json"
        ? modelManifestPath
        : url === "/" || url === "/index.html"
          ? path.join(repoRoot, "harness/index.html")
          : null;
  assets.push({
    url,
    role,
    category,
    required,
    wireBytes: hits[0] ?? 0,
    bytesStable: hits.every((bytes) => bytes === hits[0]),
    fetchedByColdVisits: hits.length,
    ofColdSamples: coldRuns.length,
    revalidatedOnWarmVisits: warmRuns.filter((run) => run.wire.some((entry) => entry.url === url && entry.status === 304)).length,
    warmVisitCacheState: cacheBehaviour(url),
    bytesOfRecord: pinned
      ? { kind: "committed", file: `assets/models/${path.basename(url)}`, bytes: pinned.bytes, sha256: pinned.sha256 }
      : url === "/assets/models/manifest.json"
        ? { kind: "committed", file: "assets/models/manifest.json" }
        : url === "/" || url === "/index.html"
          ? { kind: "committed", file: "harness/index.html" }
          : url === "/dist/main.js"
            ? { kind: "built", file: appBundleFile, note: "git-ignored build output: pnpm build produces it, so its bytes are re-derivable but not committed" }
            : {
                kind: "installed",
                file: localFile ? path.relative(repoRoot, localFile) : `node_modules/onnxruntime-web/dist/${path.basename(url)}`,
                note: `pinned by pnpm-lock.yaml (onnxruntime-web@${ortPackage.version}); git-ignored, but the lockfile makes it re-derivable`,
              },
    localFileBytes: localFile ? (await stat(localFile)).size : null,
  });
}
assets.sort((a, b) => (a.category === b.category ? a.url.localeCompare(b.url) : a.category.localeCompare(b.category)));

for (const role of ROLES.filter((entry) => entry.required)) {
  const matched = assets.filter((asset) => role.test(asset.url));
  if (matched.length === 0) {
    throw new Error(`required footprint row "${role.role}" was never requested — the deployment changed shape and the table would be incomplete`);
  }
  for (const asset of matched) {
    if (asset.fetchedByColdVisits !== coldRuns.length) {
      throw new Error(`required row "${role.role}" (${asset.url}) was fetched in ${asset.fetchedByColdVisits} of ${coldRuns.length} cold visits — an intermittent asset cannot carry a published total`);
    }
  }
}
const unstable = assets.filter((asset) => !asset.bytesStable);
if (unstable.length > 0) {
  throw new Error(`asset bytes differ between cold samples: ${unstable.map((asset) => asset.url).join(", ")} — there is nothing reproducible about that`);
}

// The non-retainable declaration is a measurement too: if the browser starts keeping the asset, the
// finding this ticket publishes (a per-visit cost) has changed, and a stale declaration would hide it.
for (const [url, reason] of NOT_RETAINABLE) {
  const asset = assets.find((candidate) => candidate.url === url);
  if (!asset) {
    throw new Error(`${url} is declared non-retainable (${reason}) but this deployment never requested it — re-measure and update DECISIONS/0012`);
  }
  if (asset.warmVisitCacheState !== "redownloaded") {
    throw new Error(`${url} is declared non-retainable (${reason}) but the warm visits report "${asset.warmVisitCacheState}" — re-measure and update DECISIONS/0012 F10`);
  }
}

const perCategoryBytes = {};
for (const asset of assets) {
  perCategoryBytes[asset.category] = (perCategoryBytes[asset.category] ?? 0) + asset.wireBytes;
}

const latency = {};
for (const classSpec of CLASSES) {
  latency[classSpec.id] = {};
  for (const phase of ["cold", "warm", "repeat"]) {
    const subset = runs.filter((run) => run.class === classSpec.id && run.phase === phase);
    latency[classSpec.id][phase] = {
      label: PHASE_LABEL[phase],
      appReadyMs: summarize(subset.map((run) => run.appReadyMs)),
      ocrReadyMs: summarize(subset.map((run) => run.ocrReadyMs)),
      firstResultMs: summarize(subset.map((run) => run.firstResultMs)),
      modelLoadMs: summarize(subset.map((run) => run.modelLoadMs)),
      inferenceMs: summarize(subset.map((run) => run.inferenceMs)),
      downloadBytes: summarize(subset.map((run) => run.downloadBytes)),
    };
  }
}

const harnessPageBytes = assets.find((asset) => asset.role.startsWith("Harness page"))?.wireBytes ?? null;

const report = {
  schemaVersion: SCHEMA_VERSION,
  kind: "footprint",
  protocol: PROTOCOL,
  measuredAt: new Date().toISOString(),
  git: gitInfo,
  measurement: {
    deployment: {
      entry: "harness/index.html — the PROJECT(1).md §9 M1 minimal inference harness page",
      scope: "core runtime + harness wrapper; PWA not built",
      remeasureRequiredAfter: "tickets 10a, 10",
      harnessOnlyBytes: {
        separable: { file: "harness/index.html", bytes: harnessPageBytes },
        bundled:
          "not separable in the current bundle: harness/dist/main.js is one esbuild output combining harness/src/main.ts, packages/core/dist and the onnxruntime-web JS glue, so the harness wrapper's share of those bytes is not isolated. The bundle total is not the eventual PWA's total.",
      },
      servedBy: "harness/serve.mjs — one same-origin HTTP/1.1 origin on 127.0.0.1, no reverse proxy",
      cacheContract: "cache-control: no-cache + ETag revalidation (serve.mjs cacheMode=validate, added by ticket 08; the default stays no-store)",
      contentEncoding: "identity — nothing is compressed, so wire bytes equal file bytes",
      appScript: `harness/dist/main.js: esbuild ESM bundle of packages/core/dist plus onnxruntime-web/dist/ort.wasm.bundle.min.mjs (${(await byteLengthOf(path.join(ortDistDir, "ort.wasm.bundle.min.mjs"))).toLocaleString("en-US")} bytes of runtime JS glue). Not minified at the core layer, and not the PWA — tickets 10a and 10 do not exist yet.`,
      sourceMaps: "harness/dist/main.js.map exists but a headless page without devtools never requests it",
      threads: `ORT runs on the WASM execution provider with ${meta.wasmThreads} threads under COOP/COEP cross-origin isolation (serve.mjs sets both headers)`,
    },
    phases: {
      cold: { required: true, description: PHASE_LABEL.cold },
      warm: { required: true, description: PHASE_LABEL.warm },
      repeat: {
        required: false,
        description: "supplementary — second inference in the same page, sessions warm",
      },
    },
    byteCounting: "summed from the origin's own request log (harness/serve.mjs), which sees WASM and worker loads that page resource timings do not; HTTP header bytes are excluded",
    timingAnchor: "performance.timeOrigin of the measured document. appReadyMs is the instant the page was handed to the driver to attach the image, so it carries one Playwright round-trip; harnessLatencyMs reports the polling lag on the other side of the run.",
    centralValue: "median, with min and max published beside it. With n=5 no percentile is claimed.",
    latencyBases: "cold and warm are timed from their own navigation, page load included; the repeat phase has no navigation and is the duration from the receipt being handed over to the result arriving, with everything already in memory. That is why the repeat row carries no app-ready or OCR-ready figure.",
    image: {
      ...imagePathInfo(imagePath, imageBytes),
      width: meta.imageSize.width,
      height: meta.imageSize.height,
      note: "user data, not app footprint: it is never a network request (the page reads the File object directly). Declared because it sets the inference time.",
    },
    samplesPerState: samplesPerState,
    excludedFromFootprint: [
      "the receipt image itself — user data, and never a network request",
      "HTTP request/response header bytes (a few hundred bytes per asset per visit)",
      "anything a service worker would cache: this deployment has no service worker yet (ticket 17), so the HTTP cache is the whole cache",
    ],
    notMeasured: [
      "any real phone, tablet or low-end laptop — the 4x class is an emulated CPU rate, not a device",
      "network latency and bandwidth beyond loopback; on a real link add RTT and whatever the connection delivers, which is why bytes are published per asset and not only as a total",
      "peak memory: the WASM heap, the decoded image buffers and both inference graphs are resident after load and are not sized here",
      "parse() and validate() separately: they run in the same frame as inference on this page, so firstResultMs includes them and modelLoadMs does not",
      "PP-OCRv6 Small, quantized builds, or a lazy/deferred model load (1E.3, ticket 09b, and the risk R2 contingencies)",
    ],
  },
  environment: {
    classes: CLASSES.map((classSpec) => ({
      id: classSpec.id,
      label: classSpec.label,
      declaredAs: classSpec.declaredAs,
      cpuThrottleRate: classSpec.cpuThrottleRate,
      samples: samplesPerState,
    })),
    device: {
      platform: `${os.platform()} ${os.arch()}`,
      kernel: os.release(),
      cpuModel: (await readFile("/proc/cpuinfo", "utf8")).match(/^model name\s*:\s*(.+)$/m)?.[1].trim() ?? "unknown",
      logicalCores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    browser: {
      name: "chromium",
      headless: true,
      version: browser.version(),
      userAgent: meta.userAgent,
      launchArgs,
      httpDiskCacheBytes: 536_870_912,
      contextIsolation: "a fresh BrowserContext per sample; every cold sample re-downloaded every asset, so contexts do not share an HTTP cache here",
    },
    toolchain: {
      playwright: JSON.parse(await readFile(path.join(repoRoot, "node_modules/@playwright/test/package.json"), "utf8")).version,
      node: process.version,
    },
    runtime: {
      onnxruntimeWeb: ortPackage.version,
      executionProvider: meta.executionProvider,
      wasmThreads: meta.wasmThreads,
      crossOriginIsolated: meta.crossOriginIsolated,
      webgpu: "not attempted (the WASM-only ORT entry point is what core imports)",
    },
    underTest: {
      package: "@receipt-lens/core",
      packageVersion: JSON.parse(await readFile(path.join(repoRoot, "packages/core/package.json"), "utf8")).version,
      provider: meta.providerName,
      providerVersion: meta.providerVersion,
      modelPreset: modelManifest.preset,
      modelVersion: modelManifest.providerVersion,
      modelLicense: modelManifest.license,
      manifestHash: meta.manifestHash,
      providerReportedAssetBytes: meta.providerAssetBytes,
      linesAndWords: `${meta.lines} lines / ${meta.words} words on the declared image`,
    },
  },
  assets,
  findings: [
    {
      code: "warm_not_zero_ort_wasm_exceeds_cache_entity_limit",
      detail:
        "Chromium HTTP cache retains ~6-8 MiB per entity; the 14.85 MB ort-wasm-simd-threaded.wasm answers 200 with full body on every warm visit, while 7 of 8 assets revalidate as 304",
      evidence:
        "session probe: 6 MiB entity retained, 8 MiB entity not retained, same server/headers as harness; 512 MB disk cache rules out eviction",
      remedy: "ticket 17 Cache API; header changes cannot fix browser per-entity limits",
      affectsClaim:
        "section 9 initial-download / re-fetch cost, not the local-processing claim (same-origin only)",
    },
  ],
  totals: {
    perCategoryBytes,
    initialDownloadBytes: summarize(coldRuns.map((run) => run.downloadBytes)),
    secondVisitBytesOverTheWire: summarize(warmRuns.map((run) => run.downloadBytes)),
    secondVisitRevalidationOverheadPageObserved: summarize(warmRuns.map((run) => run.pageObservedTransferBytes)),
    retainedCacheBytes: assets
      .filter((asset) => asset.warmVisitCacheState === "retained")
      .reduce((sum, asset) => sum + asset.wireBytes, 0),
    assetsRetainedInCache: assets.filter((asset) => asset.warmVisitCacheState === "retained").length,
    assetsRedownloadedOnEveryVisit: assets.filter((asset) => asset.warmVisitCacheState === "redownloaded").map((asset) => asset.url),
    redownloadedOnEveryVisitBytes: assets
      .filter((asset) => asset.warmVisitCacheState === "redownloaded")
      .reduce((sum, asset) => sum + asset.wireBytes, 0),
    assets: assets.length,
    requestsPerColdVisit: summarize(coldRuns.map((run) => run.wire.length)),
    conditionalFetchesPerColdVisit: summarize(coldRuns.map((run) => run.conditionalFetches)),
    requestsPerWarmVisit: summarize(warmRuns.map((run) => run.wire.length)),
    coldHeaderOverheadBytesPageObserved: summarize(coldRuns.map((run) => run.pageObservedHeaderBytes)),
    warmHeaderOverheadBytesPageObserved: summarize(warmRuns.map((run) => run.pageObservedHeaderBytes)),
  },
  latency,
  runs,
  provenance: {
    script: "benchmarks/scripts/measure-footprint.mjs",
    regenerate: "node benchmarks/scripts/measure-footprint.mjs && node benchmarks/scripts/render-footprint-table.mjs --write",
    table: "packages/core/README.md, between the footprint markers, generated by benchmarks/scripts/render-footprint-table.mjs",
    supersedes: "the withdrawn \"~4.3 MB complete OCR pipeline\" claim (ADR-002, PROJECT(1).md §2). The claim stays withdrawn; this file carries the measured number.",
    note: "measuredAt and the request log are the record of one run on one machine. Latency is not a stable constant: it is a distribution of n samples on the declared class, and a different machine class will produce a different table.",
  },
};

function imagePathInfo(file, bytes) {
  return { path: path.relative(repoRoot, file), bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
await mkdir(resultsDir, { recursive: true });
await writeFile(path.join(resultsDir, "footprint.json"), serialized, "utf8");
const archive = `footprint-${report.measuredAt.slice(0, 10)}-${gitInfo.shortRevision}.json`;
await writeFile(path.join(resultsDir, archive), serialized, "utf8");

const download = report.totals.initialDownloadBytes;
console.log(
  [
    `wrote benchmarks/results/footprint.json + benchmarks/results/${archive}`,
    `initial download: ${download.median.toLocaleString("en-US")} B median (${download.min}–${download.max}, n=${download.n}) = ${(download.median / 1e6).toFixed(2)} MB`,
    `retained cache:   ${report.totals.retainedCacheBytes.toLocaleString("en-US")} B = ${(report.totals.retainedCacheBytes / 1e6).toFixed(2)} MB`,
    ...CLASSES.map(
      (classSpec) =>
        `${classSpec.id}: cold ${latency[classSpec.id].cold.firstResultMs.median} ms · warm ${latency[classSpec.id].warm.firstResultMs.median} ms · receipt again ${latency[classSpec.id].repeat.firstResultMs.median} ms`,
    ),
  ].join("\n"),
);
