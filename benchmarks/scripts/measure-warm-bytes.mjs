#!/usr/bin/env node
/**
 * Ticket 17 — the number `DECISIONS/0012` F12 set as this ticket's bar: what does a warm visit move over the
 * wire, now that a service worker holds the runtime WASM.
 *
 * Ticket 08 measured **14,848,852 B on every warm visit** and wrote that "ticket 17's acceptance now has a
 * concrete bar (a warm visit must move 0 bytes)", naming the Cache API as the remedy and the removal of the
 * warm exception set as the signal that the remedy had landed (F10, F12). This artifact is that measurement.
 *
 * Why it is a separate artifact rather than a new `footprint.json`: the full re-derivation — `ROLES` re-keyed
 * to the PWA's emitted names, F9's condition set amended for a worker-served warm visit, cold/warm/repeat
 * latency against the real capture UI — is ticket 17b (`DECISIONS/0027` W14.3's escape hatch, exercised in
 * W14.4). What must not be deferred is the claim itself, so this file measures exactly one thing, honestly,
 * with the same discipline `DECISIONS/0012` pins: fresh browser context per sample, bytes counted by the
 * origin that served them (F5), median with min and max and `n` published (F2), and no percentile invented at
 * n=5.
 *
 * Regenerate: `pnpm measure:warm-bytes`. Check without writing: `pnpm verify:warm-bytes`.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startMeasureServer } from "../../scripts/serve-measure-app.mjs";
import { deployment, warmBytesBeforeBlock } from "../dist/footprint/rules.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const outPath = path.join(repoRoot, "benchmarks/results/warm-bytes.json");
const checkOnly = process.argv.includes("--check");
const SAMPLES = 5;

/** How long a cold preparation is allowed to keep running before the warm visit is timed. */
const COLD_SETTLE_MS = 6_000;

/** How long to watch the origin after a warm reload before reading it. */
const WARM_SETTLE_MS = 9_000;

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

/**
 * Ticket 08's published warm cost, read from the archived *harness* artifact rather than from the canonical
 * `footprint.json` — which since ticket 17b describes the same deployment this artifact measures. Reading the
 * live table for a baseline would make the comparison self-referential, so the rule lives in
 * `benchmarks/src/footprint/rules.ts` (T8, `DECISIONS/0029` P4) and is wired here.
 */
const previousWarmBytes = () => warmBytesBeforeBlock();

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summarise = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, min: sorted[0], max: sorted.at(-1), median: median(sorted), mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length), samples: sorted };
};

const appDir = path.join(repoRoot, "packages/pwa", "dist/app");
if (!existsSync(path.join(appDir, "sw.js"))) {
  throw new Error("missing packages/pwa/dist/app/sw.js — run `pnpm build` first. A measurement without a service worker measures the pre-17 deployment.");
}

/** One cold load, then one warm reload with the origin's log cleared between. */
async function sample() {
  // A fresh browser per sample, not just a fresh context. DECISIONS/0012 F2 asks for independent samples, and
  // it matters more here than it did for the harness: Cache API storage is accounted per browser process, and
  // five contexts each holding ~21 MB evicted the model cache under the later samples — which then measured
  // "the worker is not serving" when the truth was "the worker's cache is gone". A cold browser per sample
  // makes the number the deployment's, not the accumulator's.
  const browser = await chromium.launch();
  const server = startMeasureServer();
  const url = await server.url;
  const context = await browser.newContext({ serviceWorkers: "allow" });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 60_000 });
    // "Ready" is the pointer naming a verified set, not a flag: it means the shell is precached, the model
    // bytes are downloaded and hash-verified, and a smoke inference has run (DECISIONS/0027 W5).
    await page.waitForFunction(
      async () => {
        const hit = await (await caches.open("receipt-lens-active-model-cache")).match("/active");
        return Boolean(hit);
      },
      undefined,
      { timeout: 240_000, polling: 250 },
    );
    const coldRequests = server.since();
    const coldBytes = coldRequests.reduce((sum, entry) => sum + entry.bodyBytes, 0);

    // Let the cold preparation finish before the clock starts. The pointer is written at step 6, while the
    // protocol is still reporting persistence and the page is still holding its downloads open — measuring
    // from that instant counted the *cold* run's asset bytes as warm ones, which is how a first pass of this
    // script reported 6,283,819 B on a warm visit that actually costs 6,269 B.
    await page.waitForTimeout(COLD_SETTLE_MS);

    server.reset();
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 60_000 });

    // Settle before reading the log. A warm visit is *supposed* to cost one probe of the model manifest: W2.1
    // triggers a preparation on navigation to /capture, and step 1 asks the origin what version it serves
    // (2,700 B) before deciding the active set already matches. Measuring before that lands produced samples
    // that alternated between 0 B and 2,700 B, which is a race in the harness, not a property of the
    // deployment — and an intermittent asset cannot carry a published total (DECISIONS/0012 F9.12).
    await page
      .waitForFunction(
        async () => {
          const hit = await (await caches.open("receipt-lens-active-model-cache")).match("/active");
          return Boolean(hit);
        },
        undefined,
        { timeout: 60_000 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(WARM_SETTLE_MS);
    const warmRequests = server.since();
    const perAsset = {};
    for (const entry of warmRequests) {
      perAsset[entry.path] = (perAsset[entry.path] ?? 0) + entry.bodyBytes;
    }
    return {
      coldBytes,
      coldRequests: coldRequests.length,
      warmBytes: warmRequests.reduce((sum, entry) => sum + entry.bodyBytes, 0),
      warmRequests: warmRequests.length,
      warmPaths: warmRequests.map((entry) => entry.path),
      perAsset,
      wasmOnWarmVisit: warmRequests.filter((entry) => entry.path.endsWith(".wasm")).map((entry) => entry.path),
    };
  } finally {
    await server.close();
    await context.close();
    await browser.close();
  }
}

const samples = [];
for (let index = 0; index < SAMPLES; index += 1) samples.push(await sample());

// Fail-loud, in the F9 sense: the claim this artifact carries is about the WASM, so a run in which any of the
// eight conditions below holds writes no results.
const problems = [];
const warmTotals = samples.map((entry) => entry.warmBytes);
for (const [index, entry] of samples.entries()) {
  if (entry.wasmOnWarmVisit.length > 0) problems.push(`sample ${index}: the runtime WASM moved ${entry.warmBytes} B on a warm visit — the worker is not serving it`);
  if (entry.coldBytes === 0) problems.push(`sample ${index}: a cold visit moved zero bytes, so nothing was installed`);
  if (entry.warmRequests > entry.coldRequests) problems.push(`sample ${index}: the warm visit issued more requests than the cold one`);
  // The warm visit costs exactly three things and nothing else. Each is declared with its reason, because a
  // list that merely tolerates them would also tolerate a regression back to 14.85 MB.
  //   /assets/models/manifest.json — W5 step 1's probe: the app asks what version the origin serves, and the
  //     early exit means no model byte follows it.
  //   /sw.js — the browser's own worker-script byte-check on navigation.
  //   a worker module chunk — a service worker never intercepts its own script's imports, and the shipping
  //     server answers code with `cache-control: no-store` (W17 leaves that header alone on purpose), so the
  //     worker re-fetches its 955 B module graph each time it is instantiated. Ticket 17b's first item.
  for (const path of Object.keys(entry.perAsset)) {
    const declared =
      path === "/assets/models/manifest.json" ||
      path === "/sw.js" ||
      /^\/assets\/cache-names-[\w-]+\.js$/.test(path);
    if (!declared) problems.push(`sample ${index}: unexpected warm-visit asset ${path} (${entry.perAsset[path]} B)`);
  }
  if (entry.warmBytes > 20_000) {
    problems.push(`sample ${index}: warm visit moved ${entry.warmBytes} B, above the 20 kB ceiling this artifact declares`);
  }
  if ((entry.perAsset["/assets/models/PP-OCRv6_tiny_rec.onnx"] ?? 0) > 0 || (entry.perAsset["/assets/models/PP-OCRv6_tiny_det.onnx"] ?? 0) > 0) {
    problems.push(`sample ${index}: model bytes moved on a warm visit — the model cache is not being served`);
  }
}
if (new Set(samples.map((entry) => entry.warmBytes)).size !== 1) {
  problems.push(`warm bytes differ between samples (${[...new Set(samples.map((entry) => entry.warmBytes))].join(", ")}) — an intermittent asset cannot carry a published total (DECISIONS/0012 F9.12)`);
}

const before = previousWarmBytes();
const result = {
  schemaVersion: "1.0",
  kind: "warm-bytes",
  protocol: "receipt-lens-warm-bytes/1",
  measuredAt: new Date().toISOString(),
  git: { revision: git(["rev-parse", "HEAD"]), shortRevision: git(["rev-parse", "--short", "HEAD"]), branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) },
  claim: "F12's remedy, measured: what one warm visit costs over the wire now that the service worker's Cache API holds the runtime WASM.",
  deployment: {
    entry: "packages/pwa/dist/app/index.html — the built PWA shell, not the §9 M1 harness",
    scope: "PWA shell + runtime WASM precached by the service worker; model set verified and activated by DECISIONS/0027 W5",
    // Derived from the rule module rather than restated: this string is the claim that the measured origin is the
    // shipping origin, and a copy of it typed into a second driver is a copy that can go stale (DECISIONS/0029 finding 9).
    servedBy: "scripts/serve-measure-app.mjs — one same-origin HTTP/1.1 origin on 127.0.0.1, no reverse proxy, and the same contract the shipping server implements: " + deployment().cacheContract,
    threads: "1 ORT thread: serve-app.mjs sends no COOP/COEP, so crossOriginIsolated is false and resolveThreadCount returns 1. The harness's 4-thread measurement is a different deployment in that respect too.",
    notMeasured: [
      "latency (cold/warm/repeat) — ticket 17b's full re-derivation",
      "the per-asset table F1's footprint artifact publishes, for the same reason",
      "a real network link, a real phone, peak memory",
    ],
  },
  byteCounting: "summed from the origin's own request log (DECISIONS/0012 F5), so a response the worker served never appears as a byte moved over the wire",
  samples: summarise(warmTotals),
  coldVisit: summarise(samples.map((entry) => entry.coldBytes)),
  requests: { cold: summarise(samples.map((entry) => entry.coldRequests)), warm: summarise(samples.map((entry) => entry.warmRequests)) },
  warmPerAsset: samples[0].perAsset,
  warmPaths: [...new Set(samples.flatMap((entry) => entry.warmPaths))].sort(),
  before: {
    artifact: before.artifact,
    secondVisitBytesOverTheWire: before.secondVisitBytesOverTheWire,
    redownloadedOnEveryVisit: before.redownloadedOnEveryVisit,
    findingResolvedBy: before.findingResolvedBy,
    measuredDeployment: before.deploymentEntry,
  },
  reduction: {
    fromBytes: before.secondVisitBytesOverTheWire,
    toBytes: median(warmTotals),
    factor: Number((before.secondVisitBytesOverTheWire / Math.max(1, median(warmTotals))).toFixed(1)),
  },
};

if (problems.length > 0) {
  process.stdout.write(`warm-bytes measurement is invalid:\n- ${problems.join("\n- ")}\n`);
  process.exit(1);
}

const serialized = `${JSON.stringify(result, null, 2)}\n`;
const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
if (checkOnly) {
  const onDisk = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (!onDisk.includes(`"protocol": "receipt-lens-warm-bytes/1"`)) {
    process.stdout.write("warm-bytes.json is missing — run `pnpm measure:warm-bytes`\n");
    process.exit(1);
  }
  const parsed = JSON.parse(onDisk);
  if (parsed.samples.median !== result.samples.median) {
    process.stdout.write(`warm-bytes.json says median ${parsed.samples.median} B, this tree measures ${result.samples.median} B\n`);
    process.exit(1);
  }
  process.stdout.write(`warm-bytes.json re-derives: median warm visit ${result.samples.median} B over the wire\n`);
  process.exit(0);
}

writeFileSync(outPath, serialized);
process.stdout.write(
  `warm visit: median ${result.samples.median} B (was ${before.secondVisitBytesOverTheWire} B) — ${result.reduction.factor}x less, runtime WASM among them: ${result.warmPaths.filter((p) => p.endsWith(".wasm")).length ? "YES" : "no"} (sha256 ${digest})\n`,
);
