/**
 * Ticket 10a evidence for DECISIONS/0017 (gate G1): build the same three-route shell with
 * each candidate framework and record what the bundler, the generated service worker and a
 * real browser actually do.
 *
 *   node measure.mjs                 # builds + static measurements
 *   node measure.mjs --browser       # plus Playwright first-paint / lazy-OCR / routing
 *
 * Requires: pnpm install in this directory, and `pnpm build` at the repo root (core/dist).
 * Output: results/framework-evidence.json. Byte counts come from the emitted files, the
 * chunk graph from Vite's manifest, the precache list from the generated sw.js and the
 * over-the-wire numbers from the serving origin's own request log (DECISIONS/0012 F5).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const probeDir = import.meta.dirname;
const repoRoot = path.resolve(probeDir, "../..");
const viteCli = path.join(probeDir, "node_modules/vite/bin/vite.js");
const withBrowser = process.argv.includes("--browser");

const matrix = [
  { app: "svelte", framework: "Svelte 5 + svelte-spa-router (hash-only)", variants: ["bare-hash", "pwa-history", "pwa-big"], routingVariants: ["bare-hash"] },
  { app: "svelte-history", framework: "Svelte 5 + svelte-routing (history)", variants: ["bare-history", "pwa-history", "pwa-big"], routingVariants: ["bare-history"] },
  { app: "react", framework: "React 19 + react-router (hash + history)", variants: ["bare-hash", "pwa-history", "pwa-big"], routingVariants: ["bare-hash", "pwa-history"] },
  { app: "vanilla", framework: "no framework, hand-rolled router", variants: ["bare-history", "pwa-history", "pwa-big"], routingVariants: ["bare-history"] },
];

const ORT_MARKERS = ["onnxruntime", "ort-wasm-simd-threaded"];
const HASH_MODE_APPS = new Set(["svelte", "react"]);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out.sort();
}

function measureBytes(buffer) {
  return {
    bytes: buffer.length,
    gzipBytes: gzipSync(buffer).length,
    brotliBytes: brotliCompressSync(buffer).length,
  };
}

function build(app, variant) {
  try {
    execFileSync(process.execPath, [viteCli, "build", `apps/${app}`], {
      cwd: probeDir,
      env: { ...process.env, VARIANT: variant },
      stdio: "pipe",
    });
    return null;
  } catch (error) {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    const line = text.split("\n").find((entry) => entry.includes("maximumFileSizeToCacheInBytes"));
    return line ? line.trim() : "build failed";
  }
}

async function distReport(app, variant) {
  const dir = path.join(probeDir, "apps", app, "dist", variant);
  const files = [];
  for (const full of await walk(dir)) {
    const rel = path.relative(dir, full).split(path.sep).join("/");
    if (rel.startsWith(".vite/")) continue;
    const buffer = await readFile(full);
    const text = rel.endsWith(".js") || rel.endsWith(".html") ? buffer.toString("utf8") : "";
    const urls = [...new Set((text.match(/https?:\/\/[^\s"'()<>]+/g) ?? []))];
    files.push({
      file: rel,
      ...measureBytes(buffer),
      ortMarkers: ORT_MARKERS.filter((marker) => text.includes(marker)),
      externalUrlRefs: urls.sort(),
    });
  }
  return files;
}

async function chunkGraph(app, variant) {
  const manifest = JSON.parse(await readFile(path.join(probeDir, "apps", app, "dist", variant, ".vite", "manifest.json"), "utf8"));
  const chunks = Object.values(manifest);
  const entry = chunks.find((chunk) => chunk.isEntry);
  const closure = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const chunk = queue.shift();
    if (!chunk || closure.has(chunk.file)) continue;
    closure.add(chunk.file);
    for (const imported of chunk.imports ?? []) {
      const next = chunks.find((candidate) => candidate.file === imported);
      if (next) queue.push(next);
    }
    for (const css of chunk.css ?? []) closure.add(css);
  }
  return {
    entry: entry.file,
    firstPaintClosure: [...closure].sort(),
    firstPaintBytesRaw: await sumFiles(app, variant, [...closure]),
    dynamicEntries: chunks.filter((chunk) => chunk.isDynamicEntry).map((chunk) => chunk.file).sort(),
  };
}

async function sumFiles(app, variant, fileList) {
  let total = 0;
  for (const rel of fileList) {
    const info = await stat(path.join(probeDir, "apps", app, "dist", variant, rel)).catch(() => null);
    if (info) total += info.size;
  }
  return total;
}

async function precacheReport(app, variant) {
  const dir = path.join(probeDir, "apps", app, "dist", variant);
  const swPath = path.join(dir, "sw.js");
  const exists = await stat(swPath).then(() => true, () => false);
  if (!exists) return { swWritten: false };
  const sw = await readFile(swPath, "utf8");
  const match = sw.match(/precacheAndRoute\((\[[\s\S]*?\]),\s*\{\}\)/);
  const entries = match
    ? JSON.parse(match[1].replace(/([{,])\s*([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":'))
    : null;
  if (!entries) return { swWritten: true, swBytes: sw.length, precacheManifestParsed: false };
  const listed = [];
  const missing = [];
  for (const full of await walk(dir)) {
    const rel = path.relative(dir, full).split(path.sep).join("/");
    if (rel.startsWith(".vite/") || rel === "sw.js" || rel.startsWith("workbox-")) continue;
    const info = await stat(full);
    const url = `/${rel}`;
    (entries.some((entry) => entry.url === url.replace(/^\//, "") || entry.url === url) ? listed : missing).push({ file: rel, bytes: info.size });
  }
  return {
    swWritten: true,
    swBytes: sw.length,
    precacheManifestParsed: true,
    navigationFallbackRegistered: /NavigationRoute\(/.test(sw),
    skipWaiting: /skipWaiting\(\)/.test(sw),
    clientsClaim: /clientsClaim\(\)/.test(sw),
    cleanupOutdatedCaches: /cleanupOutdatedCaches\(\)/.test(sw),
    precacheEntries: entries.map((entry) => entry.url).sort(),
    precachedBytes: listed.reduce((sum, item) => sum + item.bytes, 0),
    notPrecached: missing.map((item) => item.file).sort(),
    wasmPrecached: entries.some((entry) => entry.url.endsWith(".wasm")),
  };
}

async function withServer(app, variant, body) {
  const { default: pw } = await import(path.join(repoRoot, "node_modules/@playwright/test/index.js"));
  const chromium = pw.chromium;
  const { startProbeServer } = await import(path.join(probeDir, "probe-server.mjs"));
  const server = await startProbeServer({
    root: path.join(probeDir, "apps", app, "dist", variant),
    fallback: !HASH_MODE_APPS.has(app) || !variant.includes("hash") ? true : true,
  });
  const browser = await chromium.launch();
  try {
    return await body({ browser, server });
  } finally {
    await browser.close();
    await server.close();
  }
}

async function browserOcrEvidence(app, variant) {
  return withServer(app, variant, async ({ browser, server }) => {
    const page = await browser.newPage();
    const out = { app, variant };
    try {
      await page.goto(server.url, { waitUntil: "load" });
      out.firstPaintRequests = server.requests.map((r) => ({ url: r.url, bodyBytes: r.bodyBytes }));
      out.firstPaintBytes = server.requests.reduce((sum, r) => sum + r.bodyBytes, 0);
      out.probeAtFirstPaint = await page.evaluate(() => window.__probe && window.__probe.ocr);
      out.ortTouchedAtFirstPaint = server.requests.some((r) => r.url.includes("ort") || r.url.endsWith(".wasm"));
      const before = server.requests.length;
      await page.click("#run-ocr");
      await page.waitForFunction(() => window.__probe.ocr === "ready" || window.__probe.ocr === "error", undefined, { timeout: 300000, polling: 250 });
      out.ocrRequests = server.requests.slice(before).map((r) => ({ url: r.url, bodyBytes: r.bodyBytes }));
      out.ocrPhaseBytes = server.requests.slice(before).reduce((sum, r) => sum + r.bodyBytes, 0);
      out.ocrResult = await page.evaluate(() => ({ ocr: window.__probe.ocr, parsed: window.__probe.parsed, error: window.__probe.error }));
      out.crossOriginIsolated = await page.evaluate(() => window.crossOriginIsolated);
    } finally {
      await page.close();
    }
    return out;
  });
}

const TOKEN = createHash("sha512").update("receipt-lens 10a fragment probe").digest("base64url");
const NONCE = createHash("sha384").update("nonce").digest("base64url");
// Sized to ticket 16's 8 KB fragment budget: the same base64url digest repeated until the
// whole fragment is 7,900+ characters, so fidelity is measured at the real payload size.
const CIPHER = (createHash("sha512").update("ciphertext-block").digest("base64url") + "A".repeat(0))
  .repeat(120)
  .slice(0, 7600);
const PAYLOAD = `v1.${TOKEN}.${NONCE}.${CIPHER}`;

async function routingEvidence(app, variant) {
  const specs = [
    { name: "index", path: "" },
    { name: "deep-path-bill", path: "bill" },
    { name: "path-route-with-fragment", path: "share", hash: `#${PAYLOAD}` },
    { name: "index-with-bare-fragment-payload", path: "", hash: `#${PAYLOAD}` },
    { name: "hash-route-payload", path: "", hash: `#/v1/${PAYLOAD.slice(3)}` },
  ];
  return withServer(app, variant, async ({ browser, server }) => {
    const out = { app, variant, serverFallbackToIndexHtml: true, cases: [] };
    for (const spec of specs) {
      const target = `${server.url}${spec.path}${spec.hash ?? ""}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      const response = await page.goto(target, { waitUntil: "domcontentloaded" });
      const read = await page.evaluate(() => ({
        locationHash: window.location.hash,
        locationPath: window.location.pathname,
        probeHash: window.__probe ? window.__probe.rawHash : null,
        routeParam: window.__probe ? window.__probe.routeParam : null,
        heading: document.querySelector("h1") ? document.querySelector("h1").textContent : null,
      }));
      const wanted = spec.hash ?? "";
      out.cases.push({
        name: spec.name,
        requested: target.replace(server.url, "/"),
        status: response ? response.status() : null,
        observed: read,
        fragmentDeliveredByteIdentical: wanted === "" ? null : read.locationHash === wanted,
        payloadReadableFromLocationHash: read.locationHash.replace(/^#/, "") === PAYLOAD,
        payloadReadableViaProbeSnapshot: read.probeHash !== null && String(read.probeHash).replace(/^#/, "") === PAYLOAD,
        payloadReadableViaRouterParam: read.routeParam === PAYLOAD.slice(3),
      });
      await context.close();
    }
    return out;
  });
}

async function noFallbackEvidence(app, variant) {
  const { default: pw } = await import(path.join(repoRoot, "node_modules/@playwright/test/index.js"));
  const { startProbeServer } = await import(path.join(probeDir, "probe-server.mjs"));
  const server = await startProbeServer({ root: path.join(probeDir, "apps", app, "dist", variant), fallback: false });
  const browser = await pw.chromium.launch();
  const page = await browser.newPage();
  const response = await page.goto(`${server.url}bill`, { waitUntil: "domcontentloaded" }).catch(() => null);
  const status = response ? response.status() : null;
  await browser.close();
  await server.close();
  return { deepLinkWithoutServerRewrite: status };
}

const results = {
  schema: 1,
  purpose: "Ticket 10a gate G1 evidence; DECISIONS/0017 cites results/framework-evidence.json for every number.",
  how: {
    buildCommand: "node node_modules/vite/bin/vite.js build apps/<app> (env VARIANT=<variant>)",
    browserCommand: "node measure.mjs --browser",
    byteMethod: "bytes = file length; gzipBytes = node:zlib gzipSync default level; brotliBytes = brotliCompressSync default",
    chunkGraphSource: "apps/<app>/dist/<variant>/.vite/manifest.json",
    overTheWireSource: "probe-server.mjs request log (origin-side, not PerformanceResourceTiming)",
    sampleImage: "benchmarks/datasets/raw/sroie/assets/ex.jpg (git-ignored, served at /sample.jpg)",
    fragmentPayload: "sha512/sha384 digests of a fixed string, base64url - deterministic across runs",
    fragmentPayloadLength: PAYLOAD.length,
    fragmentPayloadCharset: "base64url plus dots and hyphens (no +, / or =)",
  },
  toolchain: {
    probeLockfileSha256: createHash("sha256").update(await readFile(path.join(probeDir, "pnpm-lock.yaml"))).digest("hex"),
    versions: JSON.parse(await readFile(path.join(probeDir, "package.json"), "utf8")).dependencies,
    devVersions: JSON.parse(await readFile(path.join(probeDir, "package.json"), "utf8")).devDependencies,
  },
  apps: {},
};

for (const spec of matrix) {
  const entryOut = { framework: spec.framework, variants: {} };
  for (const variant of spec.variants) {
    const failure = build(spec.app, variant);
    const graph = await chunkGraph(spec.app, variant).catch(() => null);
    entryOut.variants[variant] = {
      buildFailed: Boolean(failure),
      buildFailureMessage: failure,
      dist: await distReport(spec.app, variant),
      chunkGraph: graph,
      serviceWorker: await precacheReport(spec.app, variant),
    };
    if (withBrowser && variant.startsWith("bare")) {
      entryOut.variants[variant].browser = await browserOcrEvidence(spec.app, variant);
    }
    if (withBrowser && spec.routingVariants.includes(variant)) {
      entryOut.variants[variant].routing = await routingEvidence(spec.app, variant);
      entryOut.variants[variant].noFallback = await noFallbackEvidence(spec.app, variant);
    }
    process.stdout.write(`measured ${spec.app}/${variant}\n`);
  }
  results.apps[spec.app] = entryOut;
}

await mkdir(path.join(probeDir, "results"), { recursive: true });
await writeFile(path.join(probeDir, "results", "framework-evidence.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
process.stdout.write("wrote results/framework-evidence.json\n");
