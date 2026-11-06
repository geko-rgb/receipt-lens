#!/usr/bin/env node
/**
 * Ticket 08 wrote this generator; ticket 17b re-derives what it reads.
 *
 *   node benchmarks/scripts/render-footprint-table.mjs [--write | --check] [--readme path]
 *
 * Every published byte count and latency is formatted out of `benchmarks/results/footprint.json`. Nothing here
 * knows a number: the "~4.3 MB complete OCR pipeline" claim died because someone typed a size, so the typeable
 * path is gone — the table is a function of the committed results, and CI regenerates it and fails on drift
 * (ADR-002, `DECISIONS/0008` reporting discipline).
 *
 * What changed for the PWA deployment (`DECISIONS/0028` T8), in the order a reviewer should check it:
 *
 * - The measured thing is `packages/pwa/dist/app`, and the check now insists on it: a `footprint.json` that
 *   still describes the §9 M1 scaffold fails here rather than shipping a product claim built on scaffold bytes.
 * - `retainedCacheBytes` is gone, replaced by `cacheHeldBytes`, and this file re-derives it from two committed
 *   inputs — the built worker's precache manifest and `assets/models/manifest.json` — rather than trusting the
 *   number it is printing (`DECISIONS/0012` F7's amendment). The old field meant "assets answered 304", and
 *   this origin answers none, so left alone it would have published 0 about a deployment that caches 21 MB.
 * - The cache column is no longer a 304/200 story. A warm asset either reached the origin or it did not
 *   (`DECISIONS/0012` F9.3, inverted by `DECISIONS/0027` W15).
 * - Three latency cells read "not separable", with the reason carried in the artifact, because the shipped
 *   bundle has no timing hook (W15 as amended by `DECISIONS/0028` T4). Carrying the superseded deployment's
 *   numbers into this table is the dishonesty this ticket exists to end.
 * - The thread count is emitted from `deployment.threads` rather than hand-written, per W14's checkpoint-1
 *   ruling: pre-17 and post-17 latency differ on 4 threads versus 1, and a reader has to see that in the table.
 * - The warm total is cross-checked against `benchmarks/results/warm-bytes.json`, produced by a different
 *   driver counting the same bytes at the same origin (T3). If they disagree, this check fails and says so.
 *
 * `--check` also re-stats and re-hashes committed assets, re-hashes the provider manifest, and requires the
 * archive copy named after the measured revision to be byte-identical to the canonical file. Build output is
 * re-derivable by rebuilding rather than by comparing to a committed object, so it is recorded as
 * `bytesOfRecord.kind: "built"` and skipped here.
 *
 * Markdown code spans are built with `code()` rather than written inline, because this file's emissions are
 * template literals and a prose backtick inside one is a delimiter. That is a syntax trap, not a style choice.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resultsDir = path.join(repoRoot, "benchmarks", "results");
const appDir = path.join(repoRoot, "packages/pwa", "dist", "app");
const canonicalPath = path.join(resultsDir, "footprint.json");
const warmBytesPath = path.join(resultsDir, "warm-bytes.json");
const BEGIN = "<!-- footprint:begin -->";
const END = "<!-- footprint:end -->";

/** A backtick, spelled as an escape so nothing below can accidentally open a template literal with it. */
const CB = "\u0060";
const code = (text) => CB + text + CB;

const argv = process.argv.slice(2);
const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : null;
if (!mode) {
  console.error("usage: node benchmarks/scripts/render-footprint-table.mjs [--write | --check] [--readme path]");
  process.exit(2);
}
const readmeIndex = argv.indexOf("--readme");
const readmePath = readmeIndex === -1 ? path.join(repoRoot, "packages/core/README.md") : path.resolve(repoRoot, argv[readmeIndex + 1]);

const raw = await readFile(canonicalPath, "utf8").catch(() => null);
if (raw === null) {
  console.error("missing " + path.relative(repoRoot, canonicalPath) + " — run: node benchmarks/scripts/measure-footprint.mjs");
  process.exit(1);
}
const results = JSON.parse(raw);
if (results.kind !== "footprint") {
  console.error(path.relative(repoRoot, canonicalPath) + ' is kind "' + results.kind + '", not "footprint"');
  process.exit(1);
}
const deployment = results.measurement.deployment;
const env = results.environment;

const bytes = (value) => Math.round(value).toLocaleString("en-US");
const megabytes = (value) => (value / 1e6).toFixed(2);
const ms = (stat) => (!stat || stat.n === 0 ? "—" : Math.round(stat.median) + " ms");
const spread = (stat) => (stat.n === 0 ? "n/a" : Math.round(stat.min) + "–" + Math.round(stat.max) + " ms, n=" + stat.n);

/** How the warm visit treated each asset, measured at the origin that either served it or did not. */
const warmOutcome = (asset) =>
  asset.warmVisitCacheState === "held-by-worker"
    ? "yes — worker cache, 0 B over the wire"
    : "**no** — " + bytes(asset.warmVisitBytesPaid) + " B paid again, " + asset.requestedOnWarmVisits + "/" + asset.ofColdSamples + " warm visits";

const CATEGORY_LABEL = {
  model: "Model and dictionary",
  runtime: "Inference runtime (onnxruntime-web, WASM)",
  app: "Application",
  other: "Uncatalogued",
};

function sourceOf(asset) {
  const record = asset.bytesOfRecord;
  if (record.kind === "committed") return "committed · " + record.file;
  if (record.kind === "installed") return "lockfile-pinned · " + path.basename(record.file);
  return "built · " + record.file;
}

const lines = [];
const emit = (line = "") => lines.push(line);

const downloadTotal = results.totals.initialDownloadBytes;
const heldTotal = results.totals.cacheHeldBytes;
const warmTotal = results.totals.secondVisitBytesOverTheWire;
const paidOnWarm = results.assets.filter((asset) => asset.warmVisitCacheState === "requested-from-origin");
const notSeparable = new Map((deployment.notSeparable ?? []).map((row) => [row.field, row.reason]));
const supersededWarm = results.measurement.crossCheck.harnessWarmBytesOverTheWire;
const crossCheck = results.measurement.crossCheck;

/** The declared reason a warm request is structural, from the artifact's own list. */
function structuralReason(url) {
  const row = (deployment.warmStructuralRequests ?? []).find((entry) => entry.path === url);
  return row === undefined ? "unexplained — and an unexplained warm request fails the run" : row.reason;
}

emit(BEGIN);
emit("<!-- generated by benchmarks/scripts/render-footprint-table.mjs from benchmarks/results/footprint.json.");
emit("     Do not edit this block by hand. Regenerate with: node benchmarks/scripts/render-footprint-table.mjs --write -->");
emit();
emit("## Footprint, measured");
emit();
emit("Not claimed — measured. Every number below is generated from the committed results file");
emit(
  code("benchmarks/results/footprint.json") + " (protocol " + code(results.protocol) + ", schema " + code(results.schemaVersion) +
    ", measured " + code(results.measuredAt.slice(0, 10)) + " at " + code(results.git.shortRevision) + ", " +
    results.measurement.samplesPerState + " samples per phase per class).",
);
emit(
  "CI regenerates this block and fails on drift. The old \"~4.3 MB complete OCR pipeline\" figure is withdrawn (ADR-002) and does not reappear here; what follows is this deployment's measurement.",
);
emit();
emit("**Measured deployment:** " + code(deployment.entry) + " — the built, installable PWA. Served by " + code(deployment.servedBy.split(" — ")[0]) + ",");
emit("the same origin the offline and capture specs run against.");
emit();
emit("### What a first visit downloads");
emit();
emit("| Component | Request | Bytes | MB | Held for the next visit | Bytes of record |");
emit("|---|---|---:|---:|---|---|");
for (const category of ["model", "runtime", "app", "other"]) {
  const group = results.assets.filter((asset) => asset.category === category);
  if (group.length === 0) continue;
  const total = results.totals.perCategoryBytes[category];
  emit("| **" + CATEGORY_LABEL[category] + "** | | **" + bytes(total) + "** | **" + megabytes(total) + "** | | |");
  for (const asset of group) {
    emit("| " + asset.role + " | " + code(asset.url) + " | " + bytes(asset.wireBytes) + " | " + megabytes(asset.wireBytes) + " | " + warmOutcome(asset) + " | " + sourceOf(asset) + " |");
  }
}
emit(
  "| **Initial download, empty cache** | " + results.totals.requestsPerColdVisit.median + " requests for " + results.assets.length +
    " assets (" + results.totals.duplicateFetchesPerColdVisit.median + " repeat fetches inside the same visit) | **" + bytes(downloadTotal.median) +
    "** | **" + megabytes(downloadTotal.median) + "** | | min " + bytes(downloadTotal.min) + " / max " + bytes(downloadTotal.max) +
    " |",
);
emit(
  "| **Held for the next visit** | " + results.totals.assetsHeldByWorker + " of " + results.assets.length + " assets | **" + bytes(heldTotal) +
    "** | **" + megabytes(heldTotal) + "** | the service worker's Cache API, not the HTTP cache | derived: built precache manifest + verified model set |",
);
if (paidOnWarm.length > 0) {
  emit(
    "| **Paid again on every visit** | " + paidOnWarm.map((asset) => code(asset.url)).join(" ") + " | **" +
      bytes(results.totals.requestedFromOriginEveryWarmVisitBytes) + "** | **" +
      megabytes(results.totals.requestedFromOriginEveryWarmVisitBytes) + "** | no | " +
      paidOnWarm.map((asset) => structuralReason(asset.url)).join("; ") + " |",
  );
}
emit(
  "| **Second visit, over the network** | " + results.totals.requestsPerWarmVisit.median + " requests | **" + bytes(warmTotal.median) +
    "** | **" + megabytes(warmTotal.median) + "** | | " + code("benchmarks/results/warm-bytes.json") + " measures the same quantity with a different driver |",
);
emit();
emit(
  "| What the page itself observed | " + results.totals.coldPageObserved.resources.median + " cold / " +
    results.totals.warmPageObserved.resources.median + " warm document resources, of which " +
    results.totals.warmPageObserved.servedWithoutNetwork.median + " warm ones moved zero bytes | " +
    bytes(results.totals.coldPageObserved.transferBytes.median) + " cold / " + bytes(results.totals.warmPageObserved.transferBytes.median) +
    " B warm | | of which " + bytes(results.totals.coldPageObserved.headerBytes.median) + " B / " +
    bytes(results.totals.warmPageObserved.headerBytes.median) + " B are response headers | " +
    results.totals.pageObservationNote + " |",
);
emit();
emit("MB = 10⁶ bytes. The receipt image is not in this table on purpose: it is user data, never a network request.");

// The owner directive from ticket 11: the table has to reconcile to app shell / models+WASM / total. The
// categories above are finer-grained, so this is a rollup of them — and the fourth row is what makes the three
// add up, because one visit fetches some assets more than once.
{
  const distinct = results.assets.reduce((sum, asset) => sum + asset.wireBytes, 0);
  const total = downloadTotal.median;
  const app = results.totals.perCategoryBytes.app ?? 0;
  const modelsAndWasm = (results.totals.perCategoryBytes.model ?? 0) + (results.totals.perCategoryBytes.runtime ?? 0);
  const repeatFetches = total - distinct;
  emit();
  emit("**Reconciled to the three rows ticket 11 asks for.** These add to the initial download, and the fourth row");
  emit("is why the first two do not: a cold visit is " + results.totals.requestsPerColdVisit.median + " requests for");
  emit(results.assets.length + " assets, so some assets move more than once inside one visit.");
  emit();
  emit("| | Bytes | MB |");
  emit("|---|---:|---:|");
  emit("| App shell (document, entry script, styles, worker and its module, icons, web manifest) | " + bytes(app) + " | " + megabytes(app) + " |");
  emit("| Models + inference runtime (WASM and its JS loader) | " + bytes(modelsAndWasm) + " | " + megabytes(modelsAndWasm) + " |");
  emit("| Repeat fetches within the same visit | " + bytes(repeatFetches) + " | " + megabytes(repeatFetches) + " |");
  emit("| **Total, first visit, empty cache** | **" + bytes(total) + "** | **" + megabytes(total) + "** |");
}
emit();
emit(
  "**Initial download: " + megabytes(downloadTotal.median) + " MB. Second visit: " + bytes(warmTotal.median) + " B** — a warm visit moves " +
    bytes(warmTotal.median) + " bytes over " + results.totals.requestsPerWarmVisit.median + " requests where the superseded scaffold measurement moved " +
    bytes(supersededWarm) + " (" + (supersededWarm / Math.max(1, warmTotal.median)).toFixed(0) + "×), and the runtime WASM is not among the bytes it pays. " +
    "This origin answers " + code("cache-control: no-store") + " with no " + code("ETag") + ", so Chromium's HTTP cache never held that binary in the first place " +
    "(ADR-002, " + code("DECISIONS/0012") + " F10/F12); what holds it now is the worker's Cache API, which has no per-entity ceiling (" + code("DECISIONS/0027") + " W2.2).",
);
emit();
emit(
  "The " + paidOnWarm.length + " items a warm visit still pays are structural, not a cache miss, and each is named with its reason above. The worker's own module",
);
emit(
  "chunk is the one of them that could be fixed — an " + code("ETag") + " on code assets — and that change is ticket 17c's, because a header change whose only visible",
);
emit(
  "effect is a smaller published number belongs in a ticket that says so (" + code("DECISIONS/0028") + " T7). Durability is requested, not assumed: the Cache API is",
);
emit(
  "exempt from the per-entity limit but not from origin quota or eviction (" + code("DECISIONS/0027") + " W18).",
);
emit();
emit("### How long it takes");
emit();
emit("| Class | Phase | App ready | OCR ready | First result | Model load | Inference | Download |");
emit("|---|---|---:|---:|---:|---:|---:|---:|");
const notSeparableLabel = "*not separable*";
for (const classSpec of env.classes) {
  for (const phase of ["cold", "warm", "repeat"]) {
    const entry = results.latency[classSpec.id][phase];
    if (!entry) continue;
    const cell = (field) => (notSeparable.has(field) ? notSeparableLabel : ms(entry[field]));
    emit(
      "| " + classSpec.id + " | " + phase + (phase === "repeat" ? " *(supplementary)*" : "") + " | " + cell("appReadyMs") + " | " + cell("ocrReadyMs") +
        " | **" + ms(entry.firstResultMs) + "** | " + cell("modelLoadMs") + " | " + cell("inferenceMs") + " | " + megabytes(entry.downloadBytes.median) + " MB |",
    );
  }
}
emit();
emit("*App ready* is this deployment's " + code("load") + " event: the shell document, its entry chunk and its styles are parsed and the capture");
emit("view can accept a file. *First result* is navigation start to the DOM state " + code("playwright/capture.spec.ts") + " already treats as");
emit("proof a draft was produced, so on a cold device it includes downloading and verifying the model set — that is the honest");
emit("cold number, not the \"models already fetched\" one, because navigation to " + code("/capture") + " is what triggers the download");
emit("(" + code("DECISIONS/0027") + " W2.1). Medians above; spread per class:");
emit();
for (const classSpec of env.classes) {
  const cold = results.latency[classSpec.id].cold.firstResultMs;
  const warm = results.latency[classSpec.id].warm.firstResultMs;
  emit("- " + code(classSpec.id) + ": cold " + spread(cold) + ", warm " + spread(warm));
}
emit();
emit("*OCR ready*, *model load* and *inference* are **not separable** in this deployment, and are not published as leftovers");
emit("from the superseded one. The shipped bundle carries no timing hook — " + code("DECISIONS/0027") + " W15, following");
emit(code("DECISIONS/0023") + " S1, refuses a test-only hook in what users receive — and the app surfaces no OCR duration to the DOM,");
emit("so the instant a verified model set became usable, and the split between model load and inference, cannot be observed");
emit("from outside. The reason recorded on each field in the artifact:");
emit();
emit("> " + ([...notSeparable.values()][0] ?? "see measurement.deployment.notSeparable"));
emit();
emit("### Declared conditions");
emit();
emit("| | |");
emit("|---|---|");
emit("| Browser | " + env.browser.name + " " + env.browser.version + " (headless " + env.browser.headless + "), Playwright " + env.toolchain.playwright + " |");
emit("| Machine | " + env.device.cpuModel + ", " + env.device.logicalCores + " logical cores, " + Math.round(env.device.totalMemoryBytes / 2 ** 30) + " GB RAM, " + env.device.platform + ", kernel " + env.device.kernel + " |");
emit("| Node | " + env.toolchain.node + " |");
emit(
  "| Runtime | onnxruntime-web " + env.runtime.onnxruntimeWeb + ", " + code(env.runtime.executionProvider) + ", " + env.runtime.wasmThreads +
    " WASM thread" + (env.runtime.wasmThreads === 1 ? "" : "s") + ", crossOriginIsolated " + env.runtime.crossOriginIsolated + " |",
);
emit("| Threads | " + deployment.threads + " |");
emit(
  "| Under test | " + env.underTest.package + " " + env.underTest.packageVersion + ", provider " + code(env.underTest.provider) + " version " +
    code(env.underTest.providerVersion) + ", preset " + code(env.underTest.modelPreset) + " (model " + env.underTest.modelVersion + ", " +
    env.underTest.modelLicense + "; " + env.underTest.draftEvidence + ") |",
);
emit(
  "| Image | " + results.measurement.image.width + "×" + results.measurement.image.height + " receipt drawn in the page, " +
    bytes(results.measurement.image.bytes) + " B, sha256 " + code(results.measurement.image.sha256.slice(0, 16) + "…") + " |",
);
emit("| Bytes counted by | " + results.measurement.byteCounting + " |");
emit("| Timing anchor | " + results.measurement.timingAnchor + " |");
emit("| Central value | " + results.measurement.centralValue + " |");
emit("| Latency basis | " + results.measurement.latencyBases + " |");
emit(
  "| Warm cross-check | this artifact measured " + bytes(crossCheck.warmBytesThisRun) + " B; " + code(crossCheck.artifact) + " measures " +
    bytes(crossCheck.warmBytesPublished) + " B; tolerance ±" + crossCheck.toleranceBytes + " B |",
);
emit();
emit("### Classes");
emit();
for (const classSpec of env.classes) {
  emit("- **" + classSpec.label + "** — " + classSpec.declaredAs);
}
emit();
emit("> **Emulation caveat.** Slow class is 4× Emulation.setCPUThrottlingRate on the same machine (Lighthouse slow-4× convention). This is a declared emulation, not a representative phone measurement. Mobile hardware latency will be higher.");
emit();
emit("### Serving mode of this measurement");
emit();
emit("- Scope: " + deployment.scope + " — " + deployment.remeasureRequiredAfter);
emit("- Entry: " + deployment.entry);
emit("- Server: " + deployment.servedBy);
emit("- Cache: " + deployment.cacheContract);
emit("- Encoding: " + deployment.contentEncoding);
emit("- Precached at install: " + deployment.precacheEntries + " entries; worker script " + bytes(deployment.workerScriptBytes) + " B");
emit();
emit("### Not in this table");
emit();
for (const item of results.measurement.excludedFromFootprint) emit("- excluded: " + item);
for (const item of results.measurement.notMeasured) emit("- not measured: " + item);
emit();
emit("Re-derive it: " + code(results.provenance.regenerate) + ".");
emit(END);

const block = lines.join("\n");

const readmeRaw = await readFile(readmePath, "utf8").catch(() => null);
if (readmeRaw === null) {
  console.error("missing " + path.relative(repoRoot, readmePath) + " — the table has nowhere to live");
  process.exit(1);
}
const begin = readmeRaw.indexOf(BEGIN);
const end = readmeRaw.indexOf(END);
if (begin === -1 || end === -1 || end < begin) {
  console.error(path.relative(repoRoot, readmePath) + " has no " + BEGIN + " / " + END + " markers — add them where the table belongs");
  process.exit(1);
}
const rendered = readmeRaw.slice(0, begin) + block + readmeRaw.slice(end + END.length);

/* ------------------------------------------------------------------ re-derive */

const problems = [];
const note = (message) => problems.push(message);

const expectedArchive = "footprint-" + results.measuredAt.slice(0, 10) + "-" + results.git.shortRevision + ".json";
const archiveBytes = await readFile(path.join(resultsDir, expectedArchive)).catch(() => null);
if (archiveBytes === null) {
  note("archive copy benchmarks/results/" + expectedArchive + " is missing");
} else if (archiveBytes.toString("utf8") !== raw) {
  note("archive copy benchmarks/results/" + expectedArchive + " is not byte-identical to footprint.json");
}

// T1: the table may not publish a PWA claim over an artifact that describes something else.
if (deployment.scope !== "PWA") {
  note("the table is a PWA claim but the artifact says deployment.scope " + JSON.stringify(deployment.scope) + " — re-run measure:footprint against packages/pwa/dist/app (DECISIONS/0028 T1)");
}
if (!deployment.entry.includes("packages/pwa/dist/app")) {
  note("deployment.entry says \"" + deployment.entry + "\", which is not the built PWA shell");
}

for (const asset of results.assets) {
  const record = asset.bytesOfRecord;
  if (record.kind === "built") continue;
  const file = path.resolve(repoRoot, record.file);
  if (!file.startsWith(repoRoot + path.sep)) {
    note(asset.url + ": bytes of record point outside the repo (" + record.file + ")");
    continue;
  }
  const content = await readFile(file).catch(() => null);
  if (content === null) {
    note(
      record.kind === "committed"
        ? asset.url + ": " + record.file + " is published in the table but missing from the tree"
        : asset.url + ": " + record.file + " missing — run pnpm install --frozen-lockfile before checking",
    );
    continue;
  }
  if (content.byteLength !== asset.wireBytes) {
    note(asset.url + ": " + record.file + " is " + content.byteLength + " bytes, the table published " + asset.wireBytes);
  }
  if (record.sha256) {
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== record.sha256) {
      note(asset.url + ": sha256 " + digest + " != the pinned " + record.sha256 + " — the model set moved under the table");
    }
  }
}

const manifestContent = readFileSync(path.join(repoRoot, "assets/models/manifest.json"));
const modelManifest = JSON.parse(manifestContent.toString("utf8"));
const manifestHash = createHash("sha256").update(manifestContent).digest("hex");
if (manifestHash !== env.underTest.manifestHash) {
  note("the measured run reported manifestHash " + env.underTest.manifestHash + ", assets/models/manifest.json now hashes to " + manifestHash);
}
const modelSum = results.assets
  .filter((asset) => asset.category === "model" && asset.url !== "/assets/models/manifest.json")
  .reduce((sum, asset) => sum + asset.wireBytes, 0);
if (modelSum !== env.underTest.providerReportedAssetBytes) {
  note("det + rec + dictionary on the wire is " + modelSum + " B, the committed manifest pins " + env.underTest.providerReportedAssetBytes + " B");
}

// T8: cacheHeldBytes is a derivation, so the gate re-derives it instead of restating it.
if (!existsSync(path.join(appDir, "sw.js"))) {
  note("packages/pwa/dist/app/sw.js is missing — run pnpm build; the cache-held total is derived from the built worker's precache manifest");
} else {
  const embedded = readFileSync(path.join(appDir, "sw.js"), "utf8").match(/=\s*(\[\{"url":.*?\}\])/s);
  if (embedded === null) {
    note("could not find the precache manifest inside packages/pwa/dist/app/sw.js — DECISIONS/0027 W1.1's build-time guard is what puts it there");
  } else {
    const missing = [];
    const precacheBytes = JSON.parse(embedded[1]).reduce((sum, entry) => {
      const file = path.join(appDir, entry.url === "/" ? "index.html" : entry.url.replace(/^\//, ""));
      if (!existsSync(file)) {
        missing.push(entry.url);
        return sum;
      }
      return sum + statSync(file).size;
    }, 0);
    if (missing.length > 0) note("the built worker precaches " + missing.join(", ") + " but packages/pwa/dist/app does not contain them");
    const modelBytes = modelManifest.assets
      .filter((asset) => !/manifest\.json$/.test(asset.file))
      .reduce((sum, asset) => sum + asset.bytes, 0);
    if (precacheBytes + modelBytes !== results.totals.cacheHeldBytes) {
      note("cacheHeldBytes publishes " + results.totals.cacheHeldBytes + " B, but the precache manifest (" + precacheBytes + " B) plus the verified model set (" + modelBytes + " B) is " + (precacheBytes + modelBytes) + " B");
    }
  }
}

// T3: two drivers, one origin, one number — and this half of the gate needs no browser.
if (!existsSync(warmBytesPath)) {
  note("benchmarks/results/warm-bytes.json is missing — the warm row of this table has no independent witness");
} else {
  const warmBytes = JSON.parse(readFileSync(warmBytesPath, "utf8"));
  if (warmBytes.samples.median !== warmTotal.median) {
    note("this table publishes a warm visit of " + warmTotal.median + " B and benchmarks/results/warm-bytes.json measures " + warmBytes.samples.median + " B — the two drivers disagree, so neither number is safe to ship (DECISIONS/0028 T3)");
  }
}

if (problems.length > 0) {
  console.error("footprint results no longer re-derive from this tree:");
  for (const problem of problems) console.error("- " + problem);
  process.exit(1);
}

/* ----------------------------------------------------------------------- write */

const rel = path.relative(repoRoot, readmePath);
if (mode === "check") {
  if (readmeRaw !== rendered) {
    console.error(rel + " does not match a fresh render of benchmarks/results/footprint.json");
    console.error("this is the drift the check exists for — run: node benchmarks/scripts/render-footprint-table.mjs --write");
    process.exit(1);
  }
  console.log(
    rel + " matches benchmarks/results/footprint.json — " + bytes(downloadTotal.median) + " B initial download (" + megabytes(downloadTotal.median) +
      " MB), " + bytes(warmTotal.median) + " B warm agreeing with warm-bytes.json, " + bytes(heldTotal) + " B held by the worker, " +
      env.runtime.wasmThreads + " ORT thread" + (env.runtime.wasmThreads === 1 ? "" : "s") + "; results re-derive from this tree",
  );
} else {
  await writeFile(readmePath, rendered, "utf8");
  console.log("wrote the footprint block into " + rel);
}
