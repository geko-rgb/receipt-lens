import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../../../scripts/serve-app.mjs";
import { startMeasureServer } from "../../../scripts/serve-measure-app.mjs";
import { cachePolicyFor, etagFor } from "../../src/footprint/etag-policy.js";
import {
  assertWarmSample,
  assertColdSample,
  buildFindings,
  warmModuleChunkDefect,
  warmOutcomeFor,
  warmValidators,
  type Finding,
  type OriginEntry,
} from "../../src/footprint/rules.js";

/**
 * DECISIONS/0029 P1–P3, P5 — the conditional-request pins.
 *
 * Two groups of assertions, and the split matters. The policy table is checked against the module that defines
 * it (`benchmarks/src/footprint/etag-policy.ts`), which is where P2's split lives. Then **both servers** are
 * checked against the bytes they actually serve, over real HTTP, because the rule being importable is not the
 * same claim as the shipping origin honouring it — 17b's baseline wiring is the cautionary tale, and it is the
 * reason this file fetches from live sockets rather than reading source text.
 *
 * The expected validator is recomputed here from the file contents rather than imported from the module: if the
 * implementation and the test shared a helper, a wrong helper would satisfy both.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appDir = path.join(repoRoot, "packages/pwa", "dist", "app");

const ORIGIN = "http://127.0.0.1";

/** Run a fail-loud check and report the code it fired, or undefined when it fired nothing. */
function fired(run: () => void): { code?: string; message: string } {
  try {
    run();
  } catch (error) {
    const violation = error as { code?: string; message?: string };
    return { code: violation.code, message: String(violation.message ?? error) };
  }
  return { message: "" };
}

/** Every committed model asset, so a cold fixture can satisfy `roles()` rather than guess at it. */
const MODEL_ASSETS: readonly { readonly file: string; readonly url: string; readonly bytes: number }[] = (
  JSON.parse(readFileSync(path.join(repoRoot, "assets/models/manifest.json"), "utf8")) as {
    assets: { file: string; bytes: number }[];
  }
).assets.map((asset) => ({ ...asset, url: `/assets/models/${asset.file}` }));

/** The first committed model asset of a given kind, named here so a missing asset fails with a message. */
function modelAsset(suffix: string): string {
  const asset = MODEL_ASSETS.find((entry) => entry.file.endsWith(suffix));
  if (asset === undefined) throw new Error(`assets/models/manifest.json pins no ${suffix} asset`);
  return asset.url;
}

/** Pull a finding out by code and fail with the codes that were present, which is the useful half of the error. */
function findingBy(findings: readonly Finding[], code: string): Finding {
  const found = findings.find((entry) => entry.code === code);
  if (found === undefined) throw new Error(`no finding with code ${code}; this run produced ${findings.map((entry) => entry.code).join(", ")}`);
  return found;
}

const digest = (body: Uint8Array): string => `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;

const assetNamed = (pattern: RegExp): string => {
  const found = readdirSync(path.join(appDir, "assets")).find((name) => pattern.test(name));
  if (found === undefined) throw new Error(`no built asset matches ${pattern} — the build shape changed and this pin needs updating`);
  return `/assets/${found}`;
};

const ASSETS = {
  entryScript: assetNamed(/^index-[\w-]+\.js$/),
  stylesheet: assetNamed(/^index-[\w-]+\.css$/),
  workerModule: assetNamed(/^cache-names-[\w-]+\.js$/),
  bundleRuntime: assetNamed(/^rolldown-runtime-[\w-]+\.js$/),
  runtimeLoader: assetNamed(/^ort\.wasm\.bundle\.min-[\w-]+\.js$/),
  runtimeWasm: assetNamed(/^ort-wasm-simd-threaded-[\w-]+\.wasm$/),
  sw: "/sw.js",
  webmanifest: "/manifest.webmanifest",
  icon: "/icons/receipt-lens-192.png",
  modelManifest: "/assets/models/manifest.json",
  modelWeights: modelAsset(".onnx"),
  dictionary: modelAsset(".txt"),
  document: "/index.html",
  route: "/capture",
} as const;

/** The file on disk behind a served path, so the test can hash the bytes the origin is answering with. */
function fileFor(pathname: string): string {
  if (pathname.startsWith("/assets/models/")) {
    const leaf = pathname.slice("/assets/models/".length);
    if (leaf === "manifest.json") return path.join(repoRoot, "assets/models/manifest.json");
    return path.join(repoRoot, "assets/models", leaf);
  }
  if (pathname === "/capture" || pathname === "/") return path.join(appDir, "index.html");
  return path.join(appDir, pathname.replace(/^\//, ""));
}

interface Origin {
  readonly url: string;
  readonly close: () => unknown;
}

/** The measurement origin additionally exposes the origin's own log, which the 304 pins read. */
interface MeasureOrigin extends Origin {
  readonly since: () => { path: string; status: number; bodyBytes: number; completed: boolean; etag?: string | null }[];
  readonly reset: () => void;
}

const started: Origin[] = [];

/** Both servers announce themselves with a trailing slash, so naive concatenation asks for `//sw.js`. */
const assetAt = (origin: Origin, pathname: string): string => `${origin.url.replace(/\/$/, "")}${pathname}`;

/**
 * Both helpers register the *real* close on the teardown list. Registering a no-op and keeping the handle for
 * the test is how a suite leaks a dozen Node children and then reports a 5 s timeout nobody can explain.
 */
async function shipping(): Promise<Origin> {
  const server = startServer();
  const url = await waitForUrl(server.url, "scripts/serve-app.mjs");
  const handle: Origin = { url, close: () => server.close() };
  started.push(handle);
  return handle;
}

async function measuring(appDir?: string): Promise<MeasureOrigin> {
  const server = startMeasureServer(appDir === undefined ? {} : { appDir });
  const url = await waitForUrl(server.url, "scripts/serve-measure-app.mjs");
  const handle: MeasureOrigin = { url, since: () => server.since(), reset: () => server.reset(), close: () => server.close() };
  started.push(handle);
  return handle;
}

async function waitForUrl(promise: Promise<string>, who: string): Promise<string> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${who} printed no URL within 30s`)), 30_000)),
  ]);
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
});

describe("P2 — the policy table is one definition, and it splits", () => {
  it("code and app metadata revalidate", () => {
    for (const pathname of [ASSETS.entryScript, ASSETS.stylesheet, ASSETS.workerModule, ASSETS.runtimeLoader, ASSETS.sw, ASSETS.webmanifest, ASSETS.icon, ASSETS.modelManifest]) {
      expect(cachePolicyFor(pathname).mode).toBe("revalidate");
    }
  });

  it("bulk binaries and the shell never enter the HTTP cache", () => {
    for (const pathname of [ASSETS.modelWeights, ASSETS.dictionary, ASSETS.runtimeWasm]) {
      expect(cachePolicyFor(pathname)).toMatchObject({ mode: "no-store", group: expect.stringMatching(/model weights|dictionary|WASM/) });
    }
    for (const pathname of [ASSETS.document, ASSETS.route]) {
      expect(cachePolicyFor(pathname).mode).toBe("no-store");
    }
  });

  it("every revalidate asset's group is named, because 'everything else' is not a policy", () => {
    expect(cachePolicyFor(ASSETS.workerModule).group).toBe("code and app metadata");
    expect(cachePolicyFor(ASSETS.modelWeights).reason).toMatch(/Cache API/);
  });
});

describe("P1 — the validator is the content, on the shipping server", () => {
  it("answers a code asset with an ETag equal to sha256 of the bytes served", async () => {
    const server = await shipping();
    const body = readFileSync(fileFor(ASSETS.entryScript));
    const response = await fetch(assetAt(server, ASSETS.entryScript));
    expect(response.status).toBe(200);
    // Recomputed here rather than imported: the test and the implementation must not share a helper.
    expect(response.headers.get("etag")).toBe(digest(new Uint8Array(body)));
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("is a strong validator only: no weak marker, no Last-Modified to disagree with", async () => {
    const server = await shipping();
    const response = await fetch(assetAt(server, ASSETS.sw));
    expect(response.headers.get("etag")).not.toMatch(/^W\//);
    expect(response.headers.get("last-modified")).toBeNull();
  });

  it("revalidates on If-None-Match with a 304 that carries no body", async () => {
    const server = await shipping();
    const first = await fetch(assetAt(server, ASSETS.workerModule));
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await fetch(assetAt(server, ASSETS.workerModule), { headers: { "if-none-match": etag ?? "" } });
    expect(second.status).toBe(304);
    expect(second.headers.get("content-length")).toBeNull();
    expect((await second.arrayBuffer()).byteLength).toBe(0);
    expect(second.headers.get("cache-control")).toBe("no-cache");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("serves the body again when the validator does not match", async () => {
    const server = await shipping();
    const response = await fetch(assetAt(server, ASSETS.entryScript), { headers: { "if-none-match": '"00000000000000000000000000000000"' } });
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});

describe("P2 — the policy is enforced on the wire, on both servers", () => {
  it("code assets get no-cache, bulk binaries get no-store and no validator", async () => {
    const server = await measuring();
    const code = await fetch(assetAt(server, ASSETS.runtimeLoader));
    expect(code.headers.get("cache-control")).toBe("no-cache");
    expect(code.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);

    for (const pathname of [ASSETS.modelWeights, ASSETS.dictionary, ASSETS.runtimeWasm]) {
      const bulk = await fetch(assetAt(server, pathname));
      expect(bulk.headers.get("cache-control")).toBe("no-store");
      expect(bulk.headers.get("etag")).toBeNull();
    }

    const shell = await fetch(assetAt(server, ASSETS.document));
    expect(shell.headers.get("cache-control")).toBe("no-store");
    expect(shell.headers.get("etag")).toBeNull();
  });

  it("the model manifest is code-adjacent metadata and revalidates", async () => {
    const server = await measuring();
    const manifest = await fetch(assetAt(server, ASSETS.modelManifest));
    expect(manifest.headers.get("cache-control")).toBe("no-cache");
    expect(manifest.headers.get("etag")).toBe(
      digest(new Uint8Array(readFileSync(path.join(repoRoot, "assets/models/manifest.json")))),
    );
  });

  it("both servers agree, path for path — one policy, not two that happen to match today", async () => {
    const shippingServer = await shipping();
    const measureServer = await measuring();
    for (const pathname of [ASSETS.entryScript, ASSETS.sw, ASSETS.modelWeights, ASSETS.runtimeWasm, ASSETS.webmanifest, ASSETS.document]) {
      const a = await fetch(shippingServer.url + pathname);
      const b = await fetch(measureServer.url + pathname);
      expect(b.headers.get("cache-control")).toBe(a.headers.get("cache-control"));
      expect(b.headers.get("etag")).toBe(a.headers.get("etag"));
      expect(b.headers.get("content-length")).toBe(a.headers.get("content-length"));
    }
  });
});

describe("P3 — a 304 is logged as a zero-byte completed response, not an interrupted one", () => {
  it("the origin log says 304, 0 bytes, completed", async () => {
    const server = await measuring();
    const first = await fetch(server.url.replace(/\/$/, "") + ASSETS.sw);
    server.reset();
    await fetch(assetAt(server, ASSETS.sw), { headers: { "if-none-match": first.headers.get("etag") ?? "" } });
    // The completion marker is written from the response's end callback, which a header-only 304 reaches too;
    // without it, DECISIONS/0012 F9.7 would fail a run whose cache was working perfectly.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const logged = server.since().filter((entry) => entry.path === ASSETS.sw);
    if (logged.length !== 1) throw new Error(`expected exactly one /sw.js entry in the warm window, saw ${JSON.stringify(logged)}`);
    const answered = logged[0]!;
    expect(answered).toMatchObject({ status: 304, bodyBytes: 0, completed: true });
    expect(answered.etag).toMatch(/^"[0-9a-f]{32}"$/);
  });
});


describe("P7 — warm classification becomes status-aware, so a revalidation is not reported as a failure", () => {
  it("classifies a path the caches answered as worker-served", () => {
    expect(warmOutcomeFor([{ path: ASSETS.entryScript, status: 200, bodyBytes: 242_513, completed: true }], [])).toBe("worker-served");
  });

  it("classifies a 304 as revalidated, distinct from both other states", () => {
    const warm = [{ path: ASSETS.sw, status: 304, bodyBytes: 0, completed: true }];
    expect(warmOutcomeFor(warm, [ASSETS.sw])).toBe("revalidated-304");
  });

  it("classifies a 200 with a body as redownloaded — the only state that is a violation", () => {
    const warm = [{ path: ASSETS.entryScript, status: 200, bodyBytes: 242_513, completed: true }];
    expect(warmOutcomeFor(warm, [ASSETS.entryScript])).toBe("redownloaded-200");
  });

  it("still fails a warm body the worker could have served, and no longer fails a zero-body revalidation", () => {
    expect(
      fired(() =>
        assertWarmSample({
          wire: [{ path: ASSETS.entryScript, status: 200, bodyBytes: 242_513, completed: true }],
          origins: [ORIGIN],
          swControlling: true,
          warmBytes: 242_513,
          pageTransferred: [],
        }),
      ).code,
    ).toBe("warm_asset_over_the_wire");

    expect(
      fired(() =>
        assertWarmSample({
          wire: [
            { path: ASSETS.sw, status: 304, bodyBytes: 0, completed: true },
            { path: ASSETS.workerModule, status: 304, bodyBytes: 0, completed: true },
            { path: ASSETS.modelManifest, status: 200, bodyBytes: 2_700, completed: true },
          ],
          origins: [ORIGIN],
          swControlling: true,
          warmBytes: 2_700,
          pageTransferred: [{ path: ASSETS.sw, transferBytes: 0 }],
        }),
      ).code,
    ).toBeUndefined();
  });

  it("records which validator each revalidated path answered against", () => {
    const measured = warmValidators([{ path: ASSETS.sw, status: 304, bodyBytes: 0, completed: true, etag: '"abc"' }]);
    expect(measured).toEqual({ [ASSETS.sw]: '"abc"' });
  });
});

describe("P6 — findings append rather than rewrite", () => {
  const previous = {
    code: "warm_not_zero_ort_wasm_exceeds_cache_entity_limit",
    detail: "d", evidence: "e", remedy: "r", affectsClaim: "a",
    resolvedBy: "ticket 17", resolvedAt: "2026-11-06",
  };

  it("adds a history entry to the superseded warm finding instead of editing its detail", () => {
    const findings = buildFindings({
      previousFinding: previous,
      warmBytes: 2_700,
      warmPaths: [ASSETS.modelManifest],
      warmOutcomes: { "/assets/models/manifest.json": "redownloaded-200", "/sw.js": "revalidated-304" },
      moduleChunk: warmModuleChunkDefect(0),
      measuredAt: "2026-11-06T00:00:00.000Z",
      previousWarmBytesPublished: 6_527,
      previousMeasuredAt: "2026-11-06T08:43:03.389Z",
      supersedesArtifact: "benchmarks/results/footprint-2026-11-06-6b3ca50.json",
    });
    const warm = findingBy(findings, "warm_visit_served_by_service_worker");
    expect(warm.detail).toContain((2_700).toLocaleString("en-US"));
    expect(warm.history).toEqual([
      {
        warmBytesOverTheWire: 6_527,
        measuredAt: "2026-11-06T08:43:03.389Z",
        artifact: "benchmarks/results/footprint-2026-11-06-6b3ca50.json",
        supersededBy: "ticket 17c",
        why: "the origin began answering code assets with an ETag, so a warm visit revalidates instead of re-downloading",
      },
    ]);
  });

  it("closes the module-chunk finding only when the body actually stopped moving", () => {
    const closed = buildFindings({
      previousFinding: previous, warmBytes: 2_700, warmPaths: [ASSETS.modelManifest],
      warmOutcomes: { [ASSETS.workerModule]: "revalidated-304" },
      moduleChunk: warmModuleChunkDefect(0), measuredAt: "2026-11-06T00:00:00.000Z",
      previousWarmBytesPublished: 6_527, previousMeasuredAt: "x", supersedesArtifact: "y",
    });
    expect(findingBy(closed, "warm_worker_module_chunk_refetched").resolvedBy).toBe("ticket 17c");

    const stillMoving = buildFindings({
      previousFinding: previous, warmBytes: 6_527, warmPaths: [ASSETS.workerModule],
      warmOutcomes: { [ASSETS.workerModule]: "redownloaded-200" },
      moduleChunk: warmModuleChunkDefect(955), measuredAt: "2026-11-06T00:00:00.000Z",
      previousWarmBytesPublished: 6_527, previousMeasuredAt: "x", supersedesArtifact: "y",
    });
    const open = findingBy(stillMoving, "warm_worker_module_chunk_refetched");
    expect(open.resolvedBy).toBeNull();
    expect(open.detail).toContain("955");
  });

  it("answers the ticket's open question about /sw.js from the run, either way", () => {
    const conditional = buildFindings({
      previousFinding: previous, warmBytes: 2_700, warmPaths: [], warmOutcomes: { "/sw.js": "revalidated-304" },
      moduleChunk: warmModuleChunkDefect(0), measuredAt: "2026-11-06T00:00:00.000Z",
      previousWarmBytesPublished: 6_527, previousMeasuredAt: "x", supersedesArtifact: "y",
    });
    expect(findingBy(conditional, "sw_js_byte_check_conditional").code).toBe("sw_js_byte_check_conditional");

    const notConditional = buildFindings({
      previousFinding: previous, warmBytes: 6_527, warmPaths: ["/sw.js"], warmOutcomes: { "/sw.js": "redownloaded-200" },
      moduleChunk: warmModuleChunkDefect(955), measuredAt: "2026-11-06T00:00:00.000Z",
      previousWarmBytesPublished: 6_527, previousMeasuredAt: "x", supersedesArtifact: "y",
    });
    expect(findingBy(notConditional, "sw_js_byte_check_unconditional").code).toBe("sw_js_byte_check_unconditional");
  });
});


describe("P4 — cold first use must be a body; a later 304 in the same visit is the fix working", () => {
  const coldWire = (extra: { path: string; status: number; bodyBytes: number }[] = []): OriginEntry[] => [
    { path: ASSETS.route, status: 200, bodyBytes: 905, completed: true },
    { path: ASSETS.document, status: 200, bodyBytes: 905, completed: true },
    { path: ASSETS.entryScript, status: 200, bodyBytes: 242_513, completed: true },
    { path: ASSETS.stylesheet, status: 200, bodyBytes: 7_980, completed: true },
    { path: ASSETS.bundleRuntime, status: 200, bodyBytes: 543, completed: true },
    { path: ASSETS.workerModule, status: 200, bodyBytes: 955, completed: true },
    { path: ASSETS.sw, status: 200, bodyBytes: 2_872, completed: true },
    { path: ASSETS.webmanifest, status: 200, bodyBytes: 728, completed: true },
    { path: ASSETS.runtimeLoader, status: 200, bodyBytes: 74_322, completed: true },
    { path: ASSETS.runtimeWasm, status: 200, bodyBytes: 14_848_852, completed: true },
    { path: "/icons/receipt-lens-192.png", status: 200, bodyBytes: 562, completed: true },
    { path: "/icons/receipt-lens-512.png", status: 200, bodyBytes: 2_642, completed: true },
    { path: "/icons/receipt-lens-512-maskable.png", status: 200, bodyBytes: 2_515, completed: true },
    { path: ASSETS.modelManifest, status: 200, bodyBytes: 2_700, completed: true },
    // Every model asset the committed manifest pins, so no required row is missing by accident.
    ...MODEL_ASSETS.map((asset) => ({ path: asset.url, status: 200, bodyBytes: asset.bytes, completed: true })),
    ...extra.map((entry) => ({ ...entry, completed: true })),
  ];

  const sample = (wire: OriginEntry[]) => ({
    wire,
    origins: [ORIGIN],
    readySignalSeen: true,
    pinnedModelBytes: new Map(MODEL_ASSETS.map((asset) => [asset.url, asset.bytes])),
    renderedZeroItems: false,
  });

  it("accepts a cold visit in which the worker's module chunk revalidates on its second fetch", () => {
    const withRevalidation = coldWire([{ path: ASSETS.workerModule, status: 304, bodyBytes: 0 }]);
    expect(() => assertColdSample(sample(withRevalidation) as never)).not.toThrow();
  });

  it("counts that revalidation, so the artifact can explain a smaller cold total", () => {
    const counted = { ...sample(coldWire([{ path: ASSETS.workerModule, status: 304, bodyBytes: 0 }])) } as never;
    assertColdSample(counted);
    // The count is written back onto the sample the driver aggregates from, not logged and discarded.
    expect((counted as unknown as { conditionalRefetches: OriginEntry[] }).conditionalRefetches.length).toBe(1);
  });

  it("still rejects a 304 on a URL's first use, which is the stale-context case F9.1 names", () => {
    const wire = coldWire().map((entry) => (entry.path === ASSETS.runtimeWasm ? { ...entry, status: 304, bodyBytes: 0 } : entry));
    expect(fired(() => assertColdSample(sample(wire) as never)).code).toBe("cold_conditional_response");
  });
});

describe("P1 — the validator value never comes from filesystem metadata", () => {
  it("identical bytes at different mtimes produce the same validator", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "etag-determinism-"));
    const body = Buffer.from("export const identical = true;\n");
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(path.join(dir, "a-1111.js"), body);
    writeFileSync(path.join(dir, "a-2222.js"), body);
    // Two files, same bytes, deliberately different mtimes.
    utimesSync(path.join(dir, "a-1111.js"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(path.join(dir, "a-2222.js"), new Date(1_000_000_000_000), new Date(1_000_000_000_000));

    const server = await measuring(dir);
    const first = await fetch(assetAt(server, "/a-1111.js"));
    const second = await fetch(assetAt(server, "/a-2222.js"));
    expect(first.headers.get("etag")).toBe(second.headers.get("etag"));
    expect(first.headers.get("etag")).toBe(digest(new Uint8Array(body)));

    // And the module-level contract, stated directly: the digest of the bytes, not of the stat.
    expect(etagFor(path.join(dir, "a-1111.js"), new Uint8Array(body))).toBe(digest(new Uint8Array(body)));
  });

  it("different bytes at the same size are not conflated by the memo", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "etag-collision-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(path.join(dir, "x-1111.js"), Buffer.from("aaaaaaaaaa"));
    const server = await measuring(dir);
    const before = (await fetch(assetAt(server, "/x-1111.js"))).headers.get("etag");
    writeFileSync(path.join(dir, "x-1111.js"), Buffer.from("bbbbbbbbbb"));
    const after = (await fetch(assetAt(server, "/x-1111.js"))).headers.get("etag");
    expect(after).not.toBe(before);
    expect(after).toBe(digest(new Uint8Array(readFileSync(path.join(dir, "x-1111.js")))));
  });
});
