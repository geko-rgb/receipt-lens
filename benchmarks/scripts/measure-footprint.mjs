#!/usr/bin/env node
/**
 * Ticket 17b — re-derive the measured footprint on the deployment users actually receive.
 *
 *   node benchmarks/scripts/measure-footprint.mjs [--samples 5] [--dry-run] [--debug]
 *
 * What changed here, in one sentence: this file used to measure the §9 M1 inference scaffold — its page and its
 * own dev server — because on the day `DECISIONS/0012` F1 pinned that choice it was the only browser deployment
 * in the repo. Tickets 10a, 10 and 17 merged, so F11 trigger 1 expired that measurement, and
 * `DECISIONS/0028` is the pin set for replacing it. This now measures `packages/pwa/dist/app` served by
 * `scripts/serve-measure-app.mjs`, driven through the real capture UI, with a service worker installed.
 *
 * Three consequences, each of which is a published change rather than an implementation detail:
 *
 * 1. **The worker is the cache.** The origin answers `cache-control: no-store` with no `ETag`, so no visit —
 *    cold or warm — ever sees a `304`. F9's condition 3 is therefore inverted (T5): warm liveness is proven by
 *    *nothing reaching the origin* plus `transferSize === 0` page-side, not by conditional revalidation. The
 *    declared non-retainable set that guarded the scaffold's 14.85 MB WASM re-download is deleted in this
 *    commit, because this is the commit that moved the measurement to the deployment where the declaration
 *    stopped being true (T6, F12's designed trigger arriving on schedule).
 * 2. **There is no timing hook in what ships.** `window.__receiptLensHarness` does not exist in the PWA bundle
 *    ticket 17 refused to add a timing hook to it (W15, following `DECISIONS/0023` S1). So `appReadyMs` is the
 *    `load` event and `firstResultMs` is navigation start to the DOM state `capture.spec.ts` already treats as
 *    proof a draft was produced, and `ocrReadyMs`, `modelLoadMs` and `inferenceMs` are published as **not
 *    separable** with the reason where F1 put the harness-bundle caveat (T4).
 * 3. **The warm number has a witness.** `measure-warm-bytes.mjs` counts the same bytes at the same origin, so
 *    this run must land on its published median at ±0. If it does not, the run fails and prints the delta and
 *    both path sets — and neither artifact gets rewritten to flatter the other (T3). That check runs per
 *    sample, so a disagreement costs seconds, not the whole measurement.
 *
 * Samples: a fresh **browser** per sample, not merely a fresh context. Ticket 17 measured why
 * (`measure-warm-bytes.mjs`:65) — Cache API storage is accounted per browser process, and several contexts
 * each holding ~21 MB evicted each other's model cache, which then measured "the worker is not serving" when
 * the truth was "the worker's cache is gone".
 *
 * Output: `benchmarks/results/footprint.json` plus the dated archive the run was measured from, both committed,
 * and the README table regenerated from them by `render-footprint-table.mjs`. Nothing in the README is typed
 * by hand. `--dry-run` measures and reports without writing, which is how the ±0 cross-check is checked before
 * spending the full 5 × 2 classes.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startMeasureServer } from "../../scripts/serve-measure-app.mjs";
import {
  assertColdSample,
  assertRepeatSample,
  assertWarmCrossCheck,
  assertWarmSample,
  buildFindings,
  cacheHeldBytes,
  classifyRole,
  classes,
  coldReady,
  deployment,
  domAnchors,
  harnessBaseline,
  latencyBases,
  sequencing,
  warmModuleChunkDefect,
  FootprintFailLoud,
} from "../dist/footprint/rules.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resultsDir = path.join(repoRoot, "benchmarks", "results");
const appDir = path.join(repoRoot, "packages/pwa", "dist", "app");
const PROTOCOL = "receipt-lens-footprint/2";
const SCHEMA_VERSION = "1.0";

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const samplesPerState = Number(flagValue("samples", "5"));
const dryRun = argv.includes("--dry-run");
const debug = argv.includes("--debug");
const started = Date.now();
const trace = (message) => {
  if (debug) console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
};
if (!Number.isInteger(samplesPerState) || samplesPerState < 2) {
  throw new Error(`--samples must be an integer >= 2, got ${samplesPerState}`);
}

/**
 * Windows and budgets. The two settle values are copied from `measure-warm-bytes.mjs` deliberately: the warm
 * total this run publishes has to be the same quantity that artifact already published, and a window of a
 * different length is a different quantity (T3).
 */
const CONTROLLER_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 240_000;
const BUSY_APPEAR_TIMEOUT_MS = 20_000;
const SETTLE_BEFORE_WARM_MS = 6_000;
const SETTLE_BEFORE_WARM_LOG_MS = 9_000;
const SETTLE_BEFORE_REPEAT_LOG_MS = 3_000;

/** The receipt this run measures inference against — see `declaredImage` below for why it is drawn, not loaded. */
const RECEIPT_LINES = ["RECEIPT", "COFFEE 4.50", "TOTAL 100.00", "CASH 100.00"];

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const gitInfo = {
  revision: git(["rev-parse", "HEAD"]),
  shortRevision: git(["rev-parse", "--short", "HEAD"]),
  branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  dirtyPaths: git(["status", "--porcelain"]).split("\n").filter((line) => line.trim() !== "").map((line) => line.slice(3)),
};

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

/* ------------------------------------------------------------------ committed inputs */

if (!existsSync(path.join(appDir, "sw.js"))) {
  throw new Error("missing packages/pwa/dist/app/sw.js — run `pnpm build` first. A footprint measurement without a service worker measures the pre-17 deployment.");
}

/** F9.10: the model bytes a cold visit must serve, as the committed manifest pins them. */
if (!existsSync(path.join(repoRoot, "assets/models/manifest.json"))) {
  throw new Error("assets/models/manifest.json is missing — the provider verifies against it, so so must this measurement");
}
const modelManifest = JSON.parse(readFileSync(path.join(repoRoot, "assets/models/manifest.json"), "utf8"));
const pinnedModelBytes = new Map(
  modelManifest.assets.map((asset) => [`/assets/models/${asset.file}`, asset.bytes]),
);
const modelManifestHash = createHash("sha256").update(readFileSync(path.join(repoRoot, "assets/models/manifest.json"))).digest("hex");

/** T3's witness, read from the committed artifact rather than restated from memory. */
const warmBytesArtifact = path.join(resultsDir, "warm-bytes.json");
if (!existsSync(warmBytesArtifact)) {
  throw new Error("benchmarks/results/warm-bytes.json is missing — this run cross-checks its warm total against it (DECISIONS/0028 T3)");
}
const warmBytesPublished = JSON.parse(readFileSync(warmBytesArtifact, "utf8"));

/**
 * The worker's own precache list, read out of the built worker. `DECISIONS/0027` W1.1 makes the build emit it
 * and fail if the list is incomplete, so the built worker is the authoritative statement of what the shell
 * cache holds — and `totals.cacheHeldBytes` is derived from it rather than observed from a live cache (T8).
 */
function readPrecacheManifest() {
  const source = readFileSync(path.join(appDir, "sw.js"), "utf8");
  const match = source.match(/=\s*(\[\{"url":.*?\}\])/s);
  if (match === null) throw new Error("could not find the precache manifest inside packages/pwa/dist/app/sw.js");
  const entries = JSON.parse(match[1]);
  return entries.map((entry) => {
    const file = path.join(appDir, entry.url === "/" ? "index.html" : entry.url.replace(/^\//, ""));
    if (!existsSync(file)) throw new Error(`the built worker precaches ${entry.url} but packages/pwa/dist/app does not contain it`);
    return { url: entry.url, bytes: statSync(file).size, revision: entry.revision };
  });
}
const precacheManifest = readPrecacheManifest();

/** onnxruntime-web's version is still worth naming: it is what the emitted WASM build came from. */
const coreRequire = createRequire(path.join(repoRoot, "packages/core/package.json"));
const ortDistDir = path.dirname(coreRequire.resolve("onnxruntime-web/wasm"));
const ortPackage = JSON.parse(readFileSync(path.join(ortDistDir, "..", "package.json"), "utf8"));

/* ------------------------------------------------------------------ in-page observers */

/**
 * The OCR in flight signal: Capture.svelte renders `busy-state` only while `{#if busy}` holds.
 *
 * Every function below is *serialized into the page* by `evaluate`/`waitForFunction`, so it must not close over
 * anything in this file — a driver-side identifier is `undefined` on the other side of that boundary, which is
 * how the first draft of this rewrite died on a selector that existed only in Node. The selectors are repeated
 * as literals here and cross-checked against `domAnchors()` at startup, so the drift is caught at launch rather
 * than twelve minutes into a measurement.
 */
const DRAFT_SELECTOR = '[data-testid="draft-review"]';
const ZERO_ITEMS_SELECTOR = '[data-testid="zero-items-state"]';
const PROCESS_BUTTON_SELECTOR = '[data-testid="process-btn"]';
const FILE_INPUT_SELECTOR = '[data-testid="file-input"]';

const anchors = domAnchors();
for (const [field, expected] of [
  ["firstResult", DRAFT_SELECTOR],
  ["zeroItems", ZERO_ITEMS_SELECTOR],
  ["fileInput", '[data-testid="file-input"]'],
]) {
  if (anchors[field] !== expected) {
    throw new Error(`DECISIONS/0028 T4 says wait on ${expected}, but domAnchors().${field} says ${anchors[field]} — fix the rules, not the run`);
  }
}

function busyPresent() {
  return document.querySelector('[data-testid="busy-state"]') !== null;
}

/**
 * The observable ready signal (T2): a pointer naming a verified, smoke-tested model set.
 *
 * This is polled by `waitUntilTrue` below rather than by `waitForFunction`, because `waitForFunction` treats
 * the *Promise object* a predicate returns as truthy and resolves on the first poll without awaiting it —
 * measured, not assumed: an async predicate that always resolves `false` still made it resolve in 17 ms, and
 * the handle then yielded the awaited `false`. An async condition inside `waitForFunction` is therefore a gate
 * that opens immediately, which is precisely the decorative check this ticket exists to avoid.
 */
function activePointerPresent() {
  return (async () => {
    const hit = await (await caches.open("receipt-lens-active-model-cache")).match("/active");
    return Boolean(hit);
  })();
}

/** Poll an in-page condition from the driver until it is true or the budget runs out. No silent fallback. */
async function waitUntilTrue(page, predicate, { timeoutMs, pollingMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await page.evaluate(predicate)) === true) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(pollingMs);
  }
}

/** Everything the page can honestly report once a phase's inference has finished. */
function pageEvidence() {
  const tenth = (value) => Math.round(value * 10) / 10;
  const navigation = performance.getEntriesByType("navigation").map((entry) => ({
    responseEndMs: tenth(entry.responseEnd),
    domContentLoadedMs: tenth(entry.domContentLoadedEventEnd),
    loadEventMs: tenth(entry.loadEventEnd),
  }))[0] ?? null;
  return {
    appReadyMs: navigation?.loadEventMs ?? null,
    navigation,
    draftReview: document.querySelector('[data-testid="draft-review"]') !== null,
    zeroItems: document.querySelector('[data-testid="zero-items-state"]') !== null,
    itemRows: document.querySelectorAll('[data-testid="item-row"]').length,
    chargeRows: document.querySelectorAll('[data-testid="charge-row"]').length,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    swController: Boolean(navigator.serviceWorker.controller),
    userAgent: navigator.userAgent,
    // F5: the page's own view is a cross-check and the header cost, never the byte total.
    resources: performance.getEntriesByType("resource")
      .map((entry) => ({
        path: new URL(entry.name, location.href).pathname,
        transferBytes: entry.transferSize,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
      }))
      // transferSize is 0 for anything read from a cache without revalidation, and then it carries no header
      // cost either — only entries that actually came over the wire can price one.
      .filter((entry) => entry.transferBytes > 0),
  };
}

/** Draw the receipt in the page and hand the PNG bytes back to the driver, exactly as `capture.spec.ts` does. */
async function drawReceipt(page) {
  const dataUrl = await page.evaluate(async (lines) => {
    await document.fonts.ready;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    context.font = "bold 56px monospace";
    lines.forEach((line, index) => context.fillText(line, 60, 220 + index * 160));
    return canvas.toDataURL("image/png");
  }, RECEIPT_LINES);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

/**
 * Hand a receipt to the app and return the page-side instant the inference finished.
 *
 * Both timestamps come from `performance.now()` observed inside the page, so no driver round-trip is hidden in
 * a published number and no Playwright latency is mistaken for inference time (0012 F6). Waiting for `busy` to
 * *appear* and then *disappear* is what makes the repeat phase measurable without a navigation to anchor on.
 */
async function runInference(page, handover) {
  const at = await page.evaluate(() => performance.now());
  await handover();
  trace("  receipt handed over; waiting for the OCR busy signal");
  await page.waitForFunction(busyPresent, undefined, { timeout: BUSY_APPEAR_TIMEOUT_MS, polling: "raf" });
  const handle = await page.waitForFunction(
    () => (document.querySelector('[data-testid="busy-state"]') ? undefined : performance.now()),
    undefined,
    { timeout: IDLE_TIMEOUT_MS, polling: "raf" },
  );
  const finishedAt = await handle.jsonValue();
  await handle.dispose();
  return { startedAtMs: at, finishedAtMs: finishedAt };
}

/* ------------------------------------------------------------------ one sample */

async function measureSample(classSpec, sampleIndex) {
  const browser = await chromium.launch({ args: ["--disk-cache-size=536870912"] });
  const server = startMeasureServer();
  const url = await server.url;
  const context = await browser.newContext({ serviceWorkers: "allow", viewport: { width: 1280, height: 900 } });
  const origins = new Set();
  const consoleErrors = [];
  context.on("request", (request) => {
    try {
      origins.add(new URL(request.url()).origin);
    } catch {
      /* blob: and data: URLs have no origin, and neither leaves the machine */
    }
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  let cdp = null;
  try {
    trace(`sample up: ${url} at ${classSpec.cpuThrottleRate}x`);
    if (classSpec.cpuThrottleRate !== 1) {
      cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: classSpec.cpuThrottleRate });
    }

    // COLD — the log window opens before the navigation, because the document and its script are part of what
    // a cold visit downloads (F5's note in the harness driver, and truer here: the worker's install precache
    // fetches the whole shell in the same window).
    server.reset();
    await page.goto(`${url.replace(/\/$/, "")}/capture`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: CONTROLLER_TIMEOUT_MS });
    const pointer = await waitUntilTrue(page, activePointerPresent, {
      timeoutMs: coldReady().timeoutMs,
      pollingMs: coldReady().pollingMs,
    });
    trace(`  cold: ready pointer ${pointer} — install precache, model verification and smoke inference`);

    const receipt = await drawReceipt(page);
    const coldRun = await runInference(page, () =>
      page.locator(FILE_INPUT_SELECTOR).setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: receipt }),
    );
    const coldEvidence = await page.evaluate(pageEvidence);
    const coldWire = server.since();

    // The settle that `measure-warm-bytes.mjs` uses, for the same reason: the cold preparation is still
    // reporting persistence after the pointer lands, and counting its requests as warm ones is how ticket 17
    // first measured a warm visit at 6 MB.
    await page.waitForTimeout(SETTLE_BEFORE_WARM_MS);

    // WARM — worker in control before the log window opens, or this is not a post-17 number (T5).
    const swControlling = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    server.reset();
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: CONTROLLER_TIMEOUT_MS });
    await waitUntilTrue(page, activePointerPresent, { timeoutMs: CONTROLLER_TIMEOUT_MS, pollingMs: coldReady().pollingMs });
    const warmRun = await runInference(page, () =>
      page.locator(FILE_INPUT_SELECTOR).setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: receipt }),
    );
    const warmEvidence = await page.evaluate(pageEvidence);
    await page.waitForTimeout(SETTLE_BEFORE_WARM_LOG_MS);
    const warmWire = server.since();

    // REPEAT — no navigation, both sessions already in memory: the app's own re-run of the same receipt.
    server.reset();
    const repeatRun = await runInference(page, () => page.locator(PROCESS_BUTTON_SELECTOR).click());
    await page.waitForTimeout(SETTLE_BEFORE_REPEAT_LOG_MS);
    const repeatWire = server.since();
    const repeatEvidence = await page.evaluate(pageEvidence);

    if (consoleErrors.length > 0) {
      throw new Error(`console errors during the measured run:\n- ${consoleErrors.join("\n- ")}`);
    }

    const phases = {
      cold: { run: coldRun, evidence: coldEvidence, wire: coldWire, pointer },
      warm: { run: warmRun, evidence: warmEvidence, wire: warmWire, pointer: swControlling },
      repeat: { run: repeatRun, evidence: repeatEvidence, wire: repeatWire, pointer: true },
    };

    const toEntries = (wire) => wire.map((entry) => ({ path: entry.path, status: entry.status, bodyBytes: entry.bodyBytes, completed: entry.completed }));
    const bytesOf = (wire) => wire.reduce((sum, entry) => sum + entry.bodyBytes, 0);

    // Fail-loud per sample, before anything is aggregated: the ±0 cross-check in particular should cost
    // seconds of a run, not the whole 5 × 2 classes.
    assertColdSample({
      wire: toEntries(phases.cold.wire),
      origins: [...origins].sort(),
      readySignalSeen: phases.cold.pointer === true,
      pinnedModelBytes,
      renderedZeroItems: phases.cold.evidence.zeroItems,
    });
    assertWarmSample({
      wire: toEntries(phases.warm.wire),
      origins: [...origins].sort(),
      swControlling: phases.warm.pointer === true,
      warmBytes: bytesOf(phases.warm.wire),
      pageTransferred: phases.warm.evidence.resources.map((resource) => ({ path: resource.path, transferBytes: resource.transferBytes })),
    });
    assertRepeatSample(toEntries(phases.repeat.wire));
    assertWarmCrossCheck({
      measured: bytesOf(phases.warm.wire),
      committed: warmBytesPublished.samples.median,
      measuredPaths: phases.warm.wire.map((entry) => entry.path),
      committedPaths: warmBytesPublished.warmPaths,
    });
    if (!phases.warm.evidence.draftReview || phases.warm.evidence.itemRows === 0) {
      throw new FootprintFailLoud(
        "draft_produced_nothing",
        `the warm visit rendered draft=${phases.warm.evidence.draftReview} items=${phases.warm.evidence.itemRows}: a warm run that read nothing cannot price a warm visit`,
      );
    }

    return {
      class: classSpec.id,
      sample: sampleIndex,
      browserVersion: browser.version(),
      origins: [...origins].sort(),
      phases,
      receiptBytes: receipt.byteLength,
      receiptSha: createHash("sha256").update(receipt).digest("hex"),
    };
  } finally {
    trace("  closing server, context, browser");
    await server.close();
    await context.close();
    await browser.close();
    trace("  sample down");
  }
}

/* ------------------------------------------------------------------ run */

console.log(`footprint: ${deployment().entry} (${deployment().scope}), ${samplesPerState} samples x ${classes().length} classes${dryRun ? " — DRY RUN, nothing is written" : ""}`);

const observed = [];
for (const classSpec of classes()) {
  for (let index = 0; index < samplesPerState; index += 1) {
    const sample = await measureSample(classSpec, index);
    observed.push(sample);
    const line = (phase) => {
      const wire = sample.phases[phase].wire;
      return `${phase} ${Math.round(sample.phases[phase].run.finishedAtMs - (phase === "repeat" ? sample.phases[phase].run.startedAtMs : 0))} ms / ${wire.reduce((sum, entry) => sum + entry.bodyBytes, 0)} B over ${wire.length} requests`;
    };
    console.log(`  ${classSpec.id} #${index}: ${line("cold")} · ${line("warm")} · ${line("repeat")}`);
  }
}

/* ------------------------------------------------------------------ inventory */

const urls = [...new Set(observed.flatMap((sample) => sample.phases.cold.wire.map((entry) => entry.path)))].sort();
const assets = [];
for (const url of urls) {
  const role = classifyRole(url);
  if (role === null) throw new FootprintFailLoud("uncatalogued_cold_asset", `${url} reached the aggregate and ROLES has no row for it`);
  const coldBytesPerSample = observed.map((sample) => sample.phases.cold.wire.find((entry) => entry.path === url)?.bodyBytes ?? null);
  const hits = coldBytesPerSample.filter((bytes) => bytes !== null);
  const warmHits = observed.filter((sample) => sample.phases.warm.wire.some((entry) => entry.path === url)).length;
  const warmBytes = observed.flatMap((sample) => sample.phases.warm.wire.filter((entry) => entry.path === url).map((entry) => entry.bodyBytes));
  const pinned = pinnedModelBytes.get(url);
  const committedModel = url.startsWith("/assets/models/");
  const servedFile = committedModel
    ? path.join("assets/models", path.basename(url))
    : /\.html$/.test(url) || url === "/capture" || url === "/"
      ? "packages/pwa/dist/app/index.html"
      : `packages/pwa/dist/app${url}`;
  assets.push({
    url,
    role: role.role,
    category: role.category,
    required: role.required,
    wireBytes: hits[0] ?? 0,
    bytesStable: hits.every((bytes) => bytes === hits[0]),
    fetchedByColdVisits: hits.length,
    ofColdSamples: observed.length,
    requestedOnWarmVisits: warmHits,
    warmVisitBytesPaid: warmHits === 0 ? 0 : warmBytes[0],
    warmVisitCacheState: warmHits === 0 ? "held-by-worker" : "requested-from-origin",
    bytesOfRecord:
      pinned !== undefined
        ? {
            kind: "committed",
            file: servedFile,
            bytes: pinned,
            sha256: modelManifest.assets.find((asset) => `/assets/models/${asset.file}` === url)?.sha256,
          }
        : committedModel
          ? { kind: "committed", file: servedFile }
          : {
              kind: "built",
              file: servedFile,
              note: "git-ignored Vite build output: pnpm build produces it from packages/pwa/src, so its bytes are re-derivable but not committed",
            },
    localFileBytes: existsSync(path.join(repoRoot, servedFile)) ? statSync(path.join(repoRoot, servedFile)).size : null,
  });
}
assets.sort((a, b) => (a.category === b.category ? a.url.localeCompare(b.url) : a.category.localeCompare(b.category)));

const unstable = assets.filter((asset) => !asset.bytesStable);
if (unstable.length > 0) {
  throw new FootprintFailLoud("required_row_missing", `asset bytes differ between cold samples: ${unstable.map((a) => a.url).join(", ")} — there is nothing reproducible about that`);
}
for (const asset of assets.filter((row) => row.required)) {
  if (asset.fetchedByColdVisits !== observed.length) {
    throw new FootprintFailLoud(
      "required_row_missing",
      `${asset.role} (${asset.url}) was fetched in ${asset.fetchedByColdVisits} of ${observed.length} cold visits — an intermittent asset cannot carry a published total (DECISIONS/0012 F9.11)`,
    );
  }
}

// The warm path set must be identical across samples: an intermittent warm asset would make the published
// median a description of whichever sample you happened to quote (F9.12), and the ±0 cross-check needs a
// single answer.
const warmPathSets = [...new Set(observed.map((sample) => sample.phases.warm.wire.map((entry) => `${entry.path}:${entry.bodyBytes}`).sort().join("|")))];
if (warmPathSets.length !== 1) {
  throw new FootprintFailLoud(
    "warm_cross_check_disagrees",
    `the warm visit is not the same request twice over: ${warmPathSets.join("  |  ")}. An intermittent warm asset cannot carry a published total`,
  );
}

/**
 * What the *document* could see, per phase. Reported beside the totals and never added to them (F5): the
 * worker's install precache, the WASM and the model downloads are not document resources, so the page's view is
 * a cross-check on a subset, not a second measurement of the same set.
 */
function pageObservedOf(phase) {
  const fromRuns = observed.map((sample) => {
    const resources = sample.phases[phase].evidence.resources;
    return {
      transferBytes: resources.reduce((sum, resource) => sum + resource.transferBytes, 0),
      headerBytes: resources.reduce((sum, resource) => sum + Math.max(0, resource.transferBytes - resource.encodedBytes), 0),
      resources: resources.length,
    };
  });
  return {
    transferBytes: summarize(fromRuns.map((row) => row.transferBytes)),
    headerBytes: summarize(fromRuns.map((row) => row.headerBytes)),
    resources: summarize(fromRuns.map((row) => row.resources)),
  };
}

const perCategoryBytes = {};
for (const asset of assets) perCategoryBytes[asset.category] = (perCategoryBytes[asset.category] ?? 0) + asset.wireBytes;

const warmTotalPerSample = observed.map((sample) => sample.phases.warm.wire.reduce((sum, entry) => sum + entry.bodyBytes, 0));
const coldTotalPerSample = observed.map((sample) => sample.phases.cold.wire.reduce((sum, entry) => sum + entry.bodyBytes, 0));
const heldByWorker = assets.filter((asset) => asset.warmVisitCacheState === "held-by-worker").map((asset) => asset.url);
const paidOnWarm = assets.filter((asset) => asset.warmVisitCacheState === "requested-from-origin");

const latency = {};
const notSeparable = latencyBases().notSeparable;
for (const classSpec of classes()) {
  latency[classSpec.id] = {};
  for (const phase of ["cold", "warm", "repeat"]) {
    const subset = observed.filter((sample) => sample.class === classSpec.id);
    const at = (sample) => (phase === "repeat" ? sample.phases[phase].run.finishedAtMs - sample.phases[phase].run.startedAtMs : sample.phases[phase].run.finishedAtMs);
    latency[classSpec.id][phase] = {
      required: phase !== "repeat",
      label:
        phase === "cold"
          ? "Cold start — first visit, empty context, worker installs and verifies"
          : phase === "warm"
            ? "Warm visit — same context, page.reload(), answered by the active caches"
            : "Second receipt — same page, sessions already in memory",
      appReadyMs: summarize(subset.map((sample) => (phase === "repeat" ? null : sample.phases[phase].evidence.appReadyMs))),
      firstResultMs: summarize(subset.map(at)),
      downloadBytes: summarize(subset.map((sample) => sample.phases[phase].wire.reduce((sum, entry) => sum + entry.bodyBytes, 0))),
      notSeparable,
      basis:
        phase === "repeat"
          ? "no navigation: the duration from handing the receipt over to the draft arriving, with the runtime and both sessions already in memory"
          : "timed from performance.timeOrigin of this navigation, inside the page: appReadyMs is the load event and firstResultMs is the instant the draft-review node was observed",
    };
  }
}

const runs = [];
for (const sample of observed) {
  for (const phase of ["cold", "warm", "repeat"]) {
    const entry = sample.phases[phase];
    const total = entry.wire.reduce((sum, item) => sum + item.bodyBytes, 0);
    runs.push({
      class: sample.class,
      phase,
      sample: sample.sample,
      appReadyMs: phase === "repeat" ? null : round(entry.evidence.appReadyMs),
      firstResultMs: round(phase === "repeat" ? entry.run.finishedAtMs - entry.run.startedAtMs : entry.run.finishedAtMs),
      downloadBytes: total,
      requests: entry.wire.length,
      origins: sample.origins,
      swController: entry.evidence.swController,
      itemRows: entry.evidence.itemRows,
      chargeRows: entry.evidence.chargeRows,
      zeroItems: entry.evidence.zeroItems,
      crossOriginIsolated: entry.evidence.crossOriginIsolated,
      pageObservedTransferBytes: entry.evidence.resources.reduce((sum, resource) => sum + resource.transferBytes, 0),
      pageObservedHeaderBytes: entry.evidence.resources.reduce((sum, resource) => sum + Math.max(0, resource.transferBytes - resource.encodedBytes), 0),
      pageObservedResources: entry.evidence.resources.length,
      wire: entry.wire.map((item) => ({ url: item.path, status: item.status, bodyBytes: item.bodyBytes, completed: item.completed })),
    });
  }
}

const first = observed[0];
const baseline = harnessBaseline();
const moduleChunkBytes = paidOnWarm.find((asset) => /^\/assets\/cache-names-/.test(asset.url))?.warmVisitBytesPaid ?? 0;
const previousFindingArtifact = JSON.parse(readFileSync(path.join(repoRoot, baseline.artifactPath), "utf8"));
const previousFinding = previousFindingArtifact.findings.find((finding) => finding.code === "warm_not_zero_ort_wasm_exceeds_cache_entity_limit");

const report = {
  schemaVersion: SCHEMA_VERSION,
  kind: "footprint",
  protocol: PROTOCOL,
  measuredAt: new Date().toISOString(),
  git: gitInfo,
  measurement: {
    deployment: {
      ...deployment(),
      precacheEntries: precacheManifest.length,
      workerScriptBytes: statSync(path.join(appDir, "sw.js")).size,
      notSeparable,
      warmStructuralRequests: paidOnWarm.map((asset) => ({
        path: asset.url,
        bytes: asset.warmVisitBytesPaid,
        reason: warmRequestReason(asset.url),
      })),
      warmStructuralRequestsNote:
        "Each of these is structural, not a cache miss: a service worker cannot intercept the fetch of its own script or that script's imports, and W6's version probe deliberately bypasses the cache. An unexplained warm request fails the run, so this list is exhaustive by construction.",
    },
    phases: {
      cold: { required: true, description: "first visit, empty context and empty caches, fresh server instance" },
      warm: {
        required: true,
        description: "same context, page.reload() — DECISIONS/0012 F8's revalidation clause is replaced by 'answered by the active caches' (DECISIONS/0027 W15), because this origin answers no 304",
      },
      repeat: { required: false, description: "supplementary — a second inference in the same page with both sessions warm, driven by the app's own Re-run OCR" },
    },
    byteCounting:
      "summed from the origin's own request log (scripts/serve-measure-app.mjs), which sees the worker's install precache, the WASM and the model downloads that page resource timings do not; HTTP header bytes are excluded",
    timingAnchor:
      "performance.timeOrigin of the measured document. appReadyMs is the navigation's load event; firstResultMs is the instant a page-side poll observed the inference finish (busy-state gone) with the draft rendered. No Playwright round-trip is inside either number.",
    centralValue: "median, with min and max published beside it. With n=5 no percentile is claimed (DECISIONS/0012 F2).",
    latencyBases:
      "cold and warm are timed from their own navigation. The repeat phase has no navigation, so its firstResultMs is the duration from handover to result. appReadyMs is published for cold and warm only.",
    image: {
      kind: "drawn in the page",
      lines: RECEIPT_LINES,
      width: 900,
      height: 1200,
      bytes: first.receiptBytes,
      sha256: first.receiptSha,
      note:
        "re-derivable from this script rather than from a gitignored dataset snapshot: the receipt is drawn on a canvas exactly as playwright/capture.spec.ts draws it, so the declared image is committed code. It is user data either way and never a network request. This supersedes the harness run's benchmarks/datasets/raw/sroie/assets/ex.jpg, which needs the 2.7 GB raw snapshot to re-derive — a published number nobody else can reproduce is not a measured one.",
    },
    samplesPerState: samplesPerState,
    crossCheck: {
      warmBytesThisRun: medianOf(warmTotalPerSample),
      warmBytesPublished: warmBytesPublished.samples.median,
      toleranceBytes: 0,
      artifact: "benchmarks/results/warm-bytes.json",
      harnessBaseline: baseline.artifactPath,
      harnessWarmBytesOverTheWire: baseline.warmBytes,
      rule: "DECISIONS/0028 T3: two drivers count the same bytes at the same origin, so they must agree exactly. Neither artifact may be rewritten to match the other.",
    },
    excludedFromFootprint: [
      "the receipt image itself — user data, and never a network request",
      "HTTP request/response header bytes (a few hundred bytes per asset per visit)",
    ],
    notMeasured: [
      "any real phone, tablet or low-end laptop — the 4x class is an emulated CPU rate, not a device",
      "network latency and bandwidth beyond loopback; bytes are published per asset so a reader can apply RTT",
      "peak memory: the WASM heap, the decoded image buffers and both inference graphs are resident after load and are not sized here",
      "parse() and validate() separately: they run inside firstResultMs and cannot be split without a hook the shipped bundle does not have",
      "PP-OCRv6 Small, quantized builds, or a lazy/deferred model load (1E.3, ticket 09b, R2 contingencies)",
    ],
  },
  environment: {
    classes: classes().map((classSpec) => ({
      ...classSpec,
      declaredAs:
        classSpec.cpuThrottleRate === 1
          ? "physical desktop machine, loopback origin, no bandwidth throttling, no network emulation"
          : "the same physical machine with Chromium's Emulation.setCPUThrottlingRate at 4x (the Lighthouse slow-4x convention). Emulation, not a device: it slows script, WASM compile and inference, and says nothing about a phone's memory, GPU or network stack.",
      samples: samplesPerState,
    })),
    device: {
      platform: `${os.platform()} ${os.arch()}`,
      kernel: os.release(),
      cpuModel: readFileSync("/proc/cpuinfo", "utf8").match(/^model name\s*:\s*(.+)$/m)?.[1].trim() ?? "unknown",
      logicalCores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    browser: {
      name: "chromium",
      headless: true,
      version: first.browserVersion,
      userAgent: first.phases.cold.evidence.userAgent,
      launchArgs: ["--disk-cache-size=536870912"],
      httpDiskCacheBytes: 536_870_912,
      diskCacheNote:
        "kept from the harness run for continuity, but it no longer carries the argument it was made for: this origin sends no-store and no ETag, so the HTTP cache holds nothing on purpose and the Cache API is the cache that matters (DECISIONS/0012 F7's amendment)",
      contextIsolation: "a fresh browser *and* context per sample: Cache API storage is accounted per browser process, and ticket 17 measured contexts evicting each other's model cache (DECISIONS/0028 T2)",
    },
    toolchain: {
      playwright: JSON.parse(readFileSync(path.join(repoRoot, "node_modules/@playwright/test/package.json"), "utf8")).version,
      node: process.version,
    },
    runtime: {
      onnxruntimeWeb: ortPackage.version,
      executionProvider: "wasm",
      wasmThreads: 1,
      threadBasis:
        "derived, not read from a session object: resolveThreadCount (packages/core/src/ocr/pp-ocrv6.ts:77) returns 1 unless crossOriginIsolated, and the measured page reports the value below. The harness's 4-thread run is superseded by this one, and the difference is stated in the generated table.",
      crossOriginIsolated: first.phases.cold.evidence.crossOriginIsolated,
      webgpu: "not attempted (the WASM-only ORT entry point is what core imports)",
    },
    underTest: {
      package: "@receipt-lens/pwa",
      packageVersion: JSON.parse(readFileSync(path.join(repoRoot, "packages/pwa/package.json"), "utf8")).version,
      provider: "pp-ocrv6",
      providerVersion: modelManifest.providerVersion,
      modelPreset: modelManifest.preset,
      modelVersion: modelManifest.providerVersion,
      modelLicense: modelManifest.license,
      manifestHash: modelManifestHash,
      providerReportedAssetBytes: modelManifest.assets.reduce((sum, asset) => sum + asset.bytes, 0),
      draftEvidence: `${first.phases.cold.evidence.itemRows} item rows / ${first.phases.cold.evidence.chargeRows} charge rows rendered from the declared image, zero-items state ${first.phases.cold.evidence.zeroItems}`,
    },
  },
  assets,
  findings: buildFindings({
    previousFinding,
    warmBytes: medianOf(warmTotalPerSample),
    warmPaths: first.phases.warm.wire.map((entry) => entry.path),
    moduleChunk: warmModuleChunkDefect(moduleChunkBytes),
    measuredAt: new Date().toISOString(),
  }),
  totals: {
    perCategoryBytes,
    initialDownloadBytes: summarize(coldTotalPerSample),
    secondVisitBytesOverTheWire: summarize(warmTotalPerSample),
    cacheHeldBytes: cacheHeldBytes({
      precacheManifest,
      modelAssets: modelManifest.assets.filter((asset) => !/manifest\.json$/.test(asset.file)),
    }),
    cacheHeldBasis:
      "deterministic: the built worker's precache manifest (packages/pwa/dist/app/sw.js, stat'd from disk) plus the verified model set named by assets/models/manifest.json. Not 'bytes currently in the named caches', which would depend on eviction (DECISIONS/0028 T8, DECISIONS/0027 W18).",
    secondVisitRevalidationOverheadPageObserved: summarize(observed.map((sample) => sample.phases.warm.evidence.resources.reduce((sum, resource) => sum + resource.transferBytes, 0))),
    assetsHeldByWorker: heldByWorker.length,
    assetsRequestedFromOriginEveryWarmVisit: paidOnWarm.map((asset) => asset.url),
    requestedFromOriginEveryWarmVisitBytes: paidOnWarm.reduce((sum, asset) => sum + asset.warmVisitBytesPaid, 0),
    assets: assets.length,
    requestsPerColdVisit: summarize(observed.map((sample) => sample.phases.cold.wire.length)),
    requestsPerWarmVisit: summarize(observed.map((sample) => sample.phases.warm.wire.length)),
    duplicateFetchesPerColdVisit: summarize(
      observed.map((sample) => sample.phases.cold.wire.length - new Set(sample.phases.cold.wire.map((entry) => entry.path)).size),
    ),
    coldPageObserved: pageObservedOf("cold"),
    warmPageObserved: pageObservedOf("warm"),
    pageObservationNote:
      "The page's own resource timings cover only the resources the *document* fetched. The worker's install precache, the WASM and the model downloads are not document resources and never appear here — that is why F5 counts bytes at the origin. So this pair is reported beside the totals and never added to them, and it is not the header cost of the whole visit.",
  },
  latency,
  runs,
  provenance: {
    script: "benchmarks/scripts/measure-footprint.mjs",
    rules: "benchmarks/src/footprint/rules.ts (DECISIONS/0028 T1-T10, pinned by benchmarks/tests/footprint/pins.test.ts)",
    regenerate: "node benchmarks/scripts/measure-footprint.mjs && node benchmarks/scripts/render-footprint-table.mjs --write",
    table: "packages/core/README.md, between the footprint markers, generated by benchmarks/scripts/render-footprint-table.mjs",
    supersedes:
      "the harness measurement archived at benchmarks/results/footprint-2026-11-04-16ae8de.json (21,299,089 B cold / 14,848,852 B warm at 4 ORT threads). Also the withdrawn \"~4.3 MB complete OCR pipeline\" claim (ADR-002), which stays withdrawn.",
    sequencing: sequencing(),
    note: "measuredAt and the request log are the record of one run on one machine. Latency is not a constant: it is a distribution of n samples on the declared class, and a different machine class will produce a different table.",
  },
};

/** Why a warm request is structural rather than a cache miss (T5, and the reason each is declared not tolerated). */
function warmRequestReason(url) {
  if (url === "/sw.js") return "the browser's own byte-check of the worker script; a worker never intercepts the fetch of its own script";
  if (/^\/assets\/cache-names-/.test(url)) return "the worker's module import — the open defect ticket 17c owns (DECISIONS/0028 T7)";
  if (url === "/assets/models/manifest.json") return "W5 step 1's version probe, deliberately cache: 'reload' (DECISIONS/0027 W6)";
  return "unexplained — and an unexplained warm request fails the run, so this line should be unreachable";
}

/* ------------------------------------------------------------------ write */

const serialized = `${JSON.stringify(report, null, 2)}\n`;
const summary = [
  `initial download: ${report.totals.initialDownloadBytes.median.toLocaleString("en-US")} B median = ${(report.totals.initialDownloadBytes.median / 1e6).toFixed(2)} MB`,
  `warm visit:     ${report.totals.secondVisitBytesOverTheWire.median.toLocaleString("en-US")} B (warm-bytes.json says ${warmBytesPublished.samples.median.toLocaleString("en-US")} B — cross-check passed at ±0)`,
  `cache held:     ${report.totals.cacheHeldBytes.toLocaleString("en-US")} B = ${(report.totals.cacheHeldBytes / 1e6).toFixed(2)} MB (precache + verified model set)`,
  ...classes().map(
    (classSpec) =>
      `${classSpec.id}: cold app ${Math.round(latency[classSpec.id].cold.appReadyMs.median)} ms / result ${Math.round(latency[classSpec.id].cold.firstResultMs.median)} ms · warm result ${Math.round(latency[classSpec.id].warm.firstResultMs.median)} ms · repeat ${Math.round(latency[classSpec.id].repeat.firstResultMs.median)} ms`,
  ),
].join("\n");

if (dryRun) {
  console.log(`DRY RUN — nothing written\n${summary}`);
  process.exit(0);
}

await mkdir(resultsDir, { recursive: true });
await writeFile(path.join(resultsDir, "footprint.json"), serialized, "utf8");
const archive = `footprint-${report.measuredAt.slice(0, 10)}-${gitInfo.shortRevision}.json`;
await writeFile(path.join(resultsDir, archive), serialized, "utf8");
console.log(`wrote benchmarks/results/footprint.json + benchmarks/results/${archive}\n${summary}`);
