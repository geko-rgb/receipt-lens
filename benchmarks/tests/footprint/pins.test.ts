import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertColdSample,
  assertRepeatSample,
  assertWarmCrossCheck,
  assertWarmSample,
  buildFindings,
  cacheHeldBytes,
  classes,
  coldReady,
  deployment,
  domAnchors,
  failLoudRules,
  harnessBaseline,
  latencyBases,
  missingRequiredRoles,
  roles,
  sequencing,
  threadNote,
  uncataloguedColdPaths,
  warmModuleChunkDefect,
  warmToleranceBytes,
  type ColdSample,
  type Finding,
  type OriginEntry,
  type WarmSample,
} from "../../src/footprint/rules.js";

/**
 * DECISIONS/0028 T1–T10 — the ticket 17b pins, as assertions.
 *
 * 17b moves the measured footprint deployment from the §9 M1 harness to the PWA, and the whole point of the
 * record is that the move is honest: the warm number must still cross-check against `warm-bytes.json` at ±0,
 * the fail-loud set must be re-derived for a deployment whose worker empties the origin log rather than
 * answered with 304s, `NOT_RETAINABLE` must disappear in the same commit that moves the deployment, and a
 * number that can no longer be separated must be published as unseparable instead of carried over from the
 * old deployment.
 *
 * Those are decisions about *measurement*, so they are pinned against pure functions over fixtures rather
 * than against a live browser: `benchmarks/scripts/measure-footprint.mjs` and this file import the same rules
 * module, which is the only thing that keeps a pin from drifting from the code that is supposed to obey it.
 * The measurement itself stays out of the unit suite (0012 F2's samples need a real origin, real Chromium and
 * real weights); `verify:footprint` remains the CI gate.
 *
 * Written before the implementation, deliberately: every rule-carrying function in `src/footprint/rules.ts`
 * throws `not implemented: DECISIONS/0028 T<n>`, so this file is red on exactly the new pins.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

/** The origin `scripts/serve-measure-app.mjs` listens on, and the only one a run may touch (§9). */
const ORIGIN = "http://127.0.0.1:4173";

/** The names the Vite build emits today. Patterns are shape-based, so these stay valid when hashes move. */
const ASSETS = {
  navigation: "/capture",
  indexHtml: "/index.html",
  entry: "/assets/index-0itO_252.js",
  css: "/assets/index-DSs-D2Tf.css",
  rolldown: "/assets/rolldown-runtime-CEoa-xHZ.js",
  runtimeLoader: "/assets/ort.wasm.bundle.min-DEokbyO3.js",
  runtimeWasm: "/assets/ort-wasm-simd-threaded-qh98TCA_.wasm",
  workerModule: "/assets/cache-names-BCswqTtv.js",
  sw: "/sw.js",
  webmanifest: "/manifest.webmanifest",
  icon192: "/icons/receipt-lens-192.png",
  icon512: "/icons/receipt-lens-512.png",
  iconMaskable: "/icons/receipt-lens-512-maskable.png",
  modelManifest: "/assets/models/manifest.json",
  det: "/assets/models/PP-OCRv6_tiny_det.onnx",
  rec: "/assets/models/PP-OCRv6_tiny_rec.onnx",
  dict: "/assets/models/PP-OCRv6_tiny_rec.txt",
} as const;

/** Every path a correctly-built PWA cold visit serves: the navigation, the precache the worker fetches with
 *  `cache: "reload"`, the worker itself, its module import, and the four model assets. */
const COLD_PATHS: readonly string[] = [
  ASSETS.navigation,
  ASSETS.indexHtml,
  ASSETS.entry,
  ASSETS.css,
  ASSETS.rolldown,
  ASSETS.runtimeLoader,
  ASSETS.runtimeWasm,
  ASSETS.workerModule,
  ASSETS.sw,
  ASSETS.webmanifest,
  ASSETS.icon192,
  ASSETS.icon512,
  ASSETS.iconMaskable,
  ASSETS.modelManifest,
  ASSETS.det,
  ASSETS.rec,
  ASSETS.dict,
];

/** `warm-bytes.json`'s measured warm visit: the three things that legitimately reach the origin. */
const WARM_BYTES = 6_527;
const WARM_MODEL_MANIFEST_BYTES = 2_700;
const WARM_SW_BYTES = 2_872;
const WARM_MODULE_CHUNK_BYTES = 955;

const entry = (p: string, bodyBytes = 1_000, status = 200, completed = true): OriginEntry => ({
  path: p,
  status,
  bodyBytes,
  completed,
});

/**
 * Run a fail-loud check and report the *code* it fired, or `undefined` when it did not fire at all.
 *
 * The rules module's stubs throw a plain `not implemented` error with no code, so every assertion written this
 * way is red until the condition genuinely exists — which is the property a keyword regex does not have.
 */
const fired = (run: () => void): { code?: string; message: string } => {
  try {
    run();
  } catch (error) {
    const violation = error as { code?: string; message?: string };
    return { code: violation.code, message: String(violation.message ?? error) };
  }
  return { message: "" };
};

const warmWire = (): OriginEntry[] => [
  entry(ASSETS.sw, WARM_SW_BYTES),
  entry(ASSETS.modelManifest, WARM_MODEL_MANIFEST_BYTES),
  entry(ASSETS.workerModule, WARM_MODULE_CHUNK_BYTES),
];

const warmSample = (overrides: Partial<WarmSample> = {}): WarmSample => ({
  wire: warmWire(),
  origins: [ORIGIN],
  swControlling: true,
  warmBytes: WARM_BYTES,
  pageTransferred: [
    { path: ASSETS.entry, transferBytes: 0 },
    { path: ASSETS.css, transferBytes: 0 },
    { path: ASSETS.runtimeWasm, transferBytes: 0 },
    { path: ASSETS.det, transferBytes: 0 },
  ],
  ...overrides,
});

const pinnedModels = (): Map<string, number> =>
  new Map([
    [ASSETS.det, 1_780_590],
    [ASSETS.rec, 4_462_639],
    [ASSETS.dict, 34_063],
  ]);

/** Bytes a correctly-built PWA cold visit actually serves, so the pinned-model check is not tripped by the
 *  fixture itself — the driver's job is to reject a *deployment* that moves, not a test that typed 100 KB. */
const coldBytes = (p: string): number =>
  pinnedModels().get(p) ?? (p === ASSETS.modelManifest ? WARM_MODEL_MANIFEST_BYTES : p === ASSETS.runtimeWasm ? 14_848_852 : 100_000);

const coldSample = (overrides: Partial<ColdSample> = {}): ColdSample => ({
  wire: COLD_PATHS.map((p) => entry(p, coldBytes(p))),
  origins: [ORIGIN],
  readySignalSeen: true,
  pinnedModelBytes: pinnedModels(),
  renderedZeroItems: false,
  ...overrides,
});

const filesUnder = (relative: string, filter: (file: string) => boolean): string[] => {
  const dir = path.join(repoRoot, relative);
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...filesUnder(path.relative(repoRoot, full), filter));
    else if (filter(full)) found.push(full);
  }
  return found;
};

describe("T1 — the measured deployment is the PWA, and every row is named", () => {
  it("names the built PWA shell, not the harness, as what is measured", () => {
    const identity = deployment();
    expect(identity.entry).toBe("packages/pwa/dist/app/index.html");
    expect(identity.scope).toBe("PWA");
    expect(identity.servedBy).toContain("serve-measure-app.mjs");
    expect(identity.entry).not.toContain("harness");
  });

  // Updated by ticket 17c, deliberately (DECISIONS/0029 P5 row 1). This pin asserted `no-store` with no
  // `ETag`, which was the shipping contract 17b measured and the reason its warm-liveness rule had to be
  // written without 304s. 17c replaces that contract for code assets, so the pin moves to the new one rather
  // than being deleted — and it still pins the half that did NOT change, because "both policies exist" is only
  // honest if the bulk group is named.
  it("records the two-policy contract 17c shipped, and that a 304 is evidence rather than a violation", () => {
    const identity = deployment();
    const contract = identity.cacheContract.toLowerCase();
    expect(contract).toContain("no-cache");
    expect(contract).toContain("etag");
    expect(contract).toContain("no-store");
    expect(contract).toContain("304");
    expect(contract).toMatch(/evidence for that claim|not a violation/);
    expect(identity.contentEncoding).toContain("identity");
  });

  it("re-keys ROLES to the emitted names and deletes the harness rows", () => {
    const table = roles();
    const matched = (p: string) => table.find((row) => row.pattern.test(p));
    expect(matched(ASSETS.runtimeWasm)?.category).toBe("runtime");
    expect(matched(ASSETS.runtimeWasm)?.required).toBe(true);
    expect(matched(ASSETS.entry)?.required).toBe(true);
    expect(matched(ASSETS.runtimeLoader)?.category).toBe("runtime");
    for (const model of [ASSETS.modelManifest, ASSETS.det, ASSETS.rec, ASSETS.dict]) {
      expect(matched(model)?.category).toBe("model");
    }
    // The harness's rows are gone, not renamed: an artifact that still catalogued them would be half-moved.
    expect(matched("/dist/main.js")).toBeUndefined();
    expect(matched("/ort/ort-wasm-simd-threaded.wasm")).toBeUndefined();
  });

  it("catalogues every path a correct cold visit serves", () => {
    expect(uncataloguedColdPaths(COLD_PATHS)).toEqual([]);
  });

  it("fails on an asset it cannot name rather than publishing a mystery row", () => {
    expect(uncataloguedColdPaths([...COLD_PATHS, "/assets/surprise-Ab34.js"])).toEqual(["/assets/surprise-Ab34.js"]);
  });

  it("fails when a required row never arrived, including the runtime WASM", () => {
    expect(missingRequiredRoles(COLD_PATHS)).toEqual([]);
    const missing = missingRequiredRoles(COLD_PATHS.filter((p) => p !== ASSETS.runtimeWasm));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.join(" ")).toMatch(/WASM/i);
  });
});

describe("T2 — cold readiness is the W5 step-6 pointer, not a timing hook", () => {
  it("names the pointer cache, the pointer path and a fail-fast timeout", () => {
    const signal = coldReady();
    expect(signal.cache).toBe("receipt-lens-active-model-cache");
    expect(signal.path).toBe("/active");
    expect(signal.timeoutMs).toBe(240_000);
    expect(signal.pollingMs).toBeLessThanOrEqual(1_000);
  });

  it("accepts a well-formed cold sample", () => {
    expect(() => assertColdSample(coldSample())).not.toThrow();
  });

  // Amended by ticket 17c (DECISIONS/0029 P4). The condition is about the FIRST use of a URL — an empty cache
  // cannot answer a first request with a 304. 17b wrote the gate over every logged entry, which was invisible
  // while the origin answered no 304s at all and became a false alarm the moment validators existed: a cold
  // visit fetches the worker's module chunk twice and the second fetch now legitimately revalidates. So the pin
  // fires on a first-use 304 and, in etag-pins.test.ts, declines to fire on a repeat one.
  it("rejects a cold visit whose FIRST use of a URL was a 304, because the context was not empty", () => {
    const wire = COLD_PATHS.map((p) =>
      p === ASSETS.runtimeWasm ? entry(p, 0, 304) : entry(p, coldBytes(p)),
    );
    expect(fired(() => assertColdSample(coldSample({ wire }))).code).toBe("cold_conditional_response");
  });

  it("rejects a 200 that carried no body", () => {
    const wire = COLD_PATHS.map((p) => (p === ASSETS.rec ? entry(p, 0) : entry(p, coldBytes(p))));
    expect(fired(() => assertColdSample(coldSample({ wire }))).code).toBe("cold_zero_body");
  });

  it("rejects served model bytes that differ from the committed manifest, naming both", () => {
    const wire = COLD_PATHS.map((p) => (p === ASSETS.det ? entry(p, 1_780_591) : entry(p, coldBytes(p))));
    const violation = fired(() => assertColdSample(coldSample({ wire })));
    expect(violation.code).toBe("cold_model_bytes_moved");
    expect(violation.message).toContain("1780590");
    expect(violation.message).toContain("1780591");
  });

  it("rejects a second origin, because §9 is same-origin only", () => {
    expect(fired(() => assertColdSample(coldSample({ origins: [ORIGIN, "http://cdn.example.com"] }))).code).toBe(
      "cross_origin_request",
    );
  });

  it("rejects an interrupted download rather than summing it as a completed one", () => {
    const wire = COLD_PATHS.map((p) => entry(p, coldBytes(p), 200, p !== ASSETS.runtimeWasm));
    expect(fired(() => assertColdSample(coldSample({ wire }))).code).toBe("download_incomplete");
  });

  it("rejects a cold run whose ready pointer never appeared, instead of measuring a half-installed app", () => {
    expect(fired(() => assertColdSample(coldSample({ readySignalSeen: false }))).code).toBe("cold_pointer_never_ready");
  });

  it("treats a zero-items draft as the failed parse F9.8 has always meant", () => {
    expect(fired(() => assertColdSample(coldSample({ renderedZeroItems: true }))).code).toBe("draft_produced_nothing");
  });
});

describe("T3 — the warm number cross-checks against warm-bytes.json at ±0", () => {
  it("pins the tolerance at exactly zero bytes", () => {
    expect(warmToleranceBytes()).toBe(0);
  });

  it("accepts the committed median", () => {
    expect(() =>
      assertWarmCrossCheck({
        measured: WARM_BYTES,
        committed: WARM_BYTES,
        measuredPaths: warmWire().map((e) => e.path),
        committedPaths: [ASSETS.workerModule, ASSETS.modelManifest, ASSETS.sw],
      }),
    ).not.toThrow();
  });

  it("fails a disagreement by name, with the delta and both path sets", () => {
    const violation = fired(() =>
      assertWarmCrossCheck({
        measured: WARM_BYTES - WARM_MODULE_CHUNK_BYTES,
        committed: WARM_BYTES,
        measuredPaths: [ASSETS.sw, ASSETS.modelManifest],
        committedPaths: [ASSETS.workerModule, ASSETS.modelManifest, ASSETS.sw],
      }),
    );
    expect(violation.code).toBe("warm_cross_check_disagrees");
    expect(violation.message).toContain("5572");
    expect(violation.message).toContain("6527");
    expect(violation.message).toContain(ASSETS.workerModule);
  });

  // Amended by ticket 17c, deliberately (the fourth red pin; DECISIONS/0029 P5 listed three). As written this
  // pinned 17b's *value* rather than 17b's *property*: it asserted warm-bytes.json says 6,527 B, which was true
  // only until the ETag ticket regenerated that artifact. What the pin actually guards is that the witness
  // exists, is independent, is a PWA measurement, is deterministic across samples, and agrees with the
  // footprint table — so it now reads the cross-check relationship instead of a constant.
  it("keeps an independent, deterministic PWA witness that agrees with the footprint table", () => {
    const artifact = JSON.parse(read("benchmarks/results/warm-bytes.json")) as {
      samples: { median: number; n: number; min: number; max: number };
      deployment: { scope: string };
    };
    const footprint = JSON.parse(read("benchmarks/results/footprint.json")) as {
      totals: { secondVisitBytesOverTheWire: { median: number } };
      measurement: { crossCheck: { warmBytesPublished: number; toleranceBytes: number } };
    };
    expect(artifact.deployment.scope).toContain("PWA");
    expect(artifact.samples.n).toBe(5);
    expect(artifact.samples.min).toBe(artifact.samples.median);
    expect(artifact.samples.max).toBe(artifact.samples.median);
    expect(artifact.samples.median).toBe(footprint.totals.secondVisitBytesOverTheWire.median);
    expect(footprint.measurement.crossCheck.warmBytesPublished).toBe(artifact.samples.median);
    expect(footprint.measurement.crossCheck.toleranceBytes).toBe(0);
  });

  it("never writes warm-bytes.json from the footprint driver", () => {
    const source = read("benchmarks/scripts/measure-footprint.mjs");
    const writes = source.split("\n").filter((line) => /writeFile|writeFileSync/.test(line));
    for (const line of writes) expect(line).not.toContain("warm-bytes");
  });
});

describe("T4 — two latency numbers stay measured, three become not separable", () => {
  it("keeps exactly appReadyMs and firstResultMs measured", () => {
    const bases = latencyBases();
    expect([...bases.measured].sort()).toEqual(["appReadyMs", "firstResultMs"]);
  });

  it("publishes ocrReadyMs, modelLoadMs and inferenceMs as unseparable, each with a reason", () => {
    const bases = latencyBases();
    expect(bases.notSeparable.map((row) => row.field).sort()).toEqual(["inferenceMs", "modelLoadMs", "ocrReadyMs"]);
    for (const row of bases.notSeparable) {
      expect(row.reason.length).toBeGreaterThan(40);
      expect(row.reason).toMatch(/hook|DOM|surface/i);
    }
  });

  it("is right about the app surfacing no OCR duration to the DOM", () => {
    const sources = filesUnder("packages/pwa/src", (file) => /\.(ts|svelte)$/.test(file) && !/\.test\.|\.spec\./.test(file));
    const offenders = sources.filter((file) =>
      /inferenceMs|durationMs|\belapsed\b|timings/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("waits on the DOM capture.spec.ts already treats as proof", () => {
    const anchors = domAnchors();
    expect(anchors.firstResult).toBe('[data-testid="draft-review"]');
    expect(anchors.fileInput).toContain("file-input");
    expect(anchors.zeroItems).toContain("zero-items-state");
    expect(anchors.appReady).toMatch(/load/i);
  });
});

describe("T5 — F9's fail-loud set, amended for a worker-served warm visit", () => {
  it("adds the three new conditions and drops the one the declaration's deletion retires", () => {
    const codes = failLoudRules().map((rule) => rule.code);
    for (const added of ["sw_not_controlling_at_warm", "warm_cross_check_disagrees", "uncatalogued_cold_asset"]) {
      expect(codes).toContain(added);
    }
    expect(codes).not.toContain("not_retainable_stale");
    for (const rule of failLoudRules()) expect(rule.when.length).toBeGreaterThan(20);
  });

  it("refuses to call a warm visit warm when no worker is controlling", () => {
    expect(fired(() => assertWarmSample(warmSample({ swControlling: false }))).code).toBe("sw_not_controlling_at_warm");
  });

  it("refuses a warm visit in which the runtime WASM reached the origin", () => {
    const violation = fired(() => assertWarmSample(warmSample({ wire: [...warmWire(), entry(ASSETS.runtimeWasm, 14_848_852)] })));
    expect(violation.code).toBe("warm_asset_over_the_wire");
    expect(violation.message).toContain(ASSETS.runtimeWasm);
  });

  it("refuses a warm visit in which model bytes reached the origin", () => {
    const violation = fired(() => assertWarmSample(warmSample({ wire: [...warmWire(), entry(ASSETS.rec, 4_462_639)] })));
    expect(violation.code).toBe("warm_asset_over_the_wire");
    expect(violation.message).toContain(ASSETS.rec);
  });

  it("refuses a shell asset the worker could have served", () => {
    const violation = fired(() => assertWarmSample(warmSample({ wire: [...warmWire(), entry(ASSETS.entry, 200_000)] })));
    expect(violation.code).toBe("warm_asset_over_the_wire");
    expect(violation.message).toContain(ASSETS.entry);
  });

  it("requires the page's own evidence that nothing came over the wire", () => {
    expect(
      fired(() => assertWarmSample(warmSample({ pageTransferred: [{ path: ASSETS.runtimeWasm, transferBytes: 14_848_852 }] })))
        .code,
    ).toBe("page_observed_network_transfer");
  });

  it("accepts the deployment working correctly, which the pre-17 condition 3 used to fail", () => {
    expect(() => assertWarmSample(warmSample({ wire: [], warmBytes: 0, pageTransferred: [] }))).not.toThrow();
  });

  it("accepts the measured warm visit, defects and all", () => {
    expect(() => assertWarmSample(warmSample())).not.toThrow();
  });

  it("still fails a status >= 400, an incomplete body and a second origin", () => {
    expect(fired(() => assertWarmSample(warmSample({ wire: [entry(ASSETS.sw, 0, 404)] }))).code).toBe(
      "failed_request_status",
    );
    expect(
      fired(() => assertWarmSample(warmSample({ wire: [entry(ASSETS.sw, WARM_SW_BYTES, 200, false)] }))).code,
    ).toBe("download_incomplete");
    expect(fired(() => assertWarmSample(warmSample({ origins: [ORIGIN, "http://elsewhere.example"] }))).code).toBe(
      "cross_origin_request",
    );
  });

  it("keeps F9 condition 5: a second receipt in the same page touches nothing", () => {
    expect(() => assertRepeatSample([])).not.toThrow();
    expect(fired(() => assertRepeatSample([entry(ASSETS.modelManifest, WARM_MODEL_MANIFEST_BYTES)])).code).toBe(
      "repeat_touched_network",
    );
  });
});

describe("T6 — NOT_RETAINABLE is deleted in the commit that moves the deployment", () => {
  it("leaves no trace of the exception set in the measurement code", () => {
    const files = [
      ...filesUnder("benchmarks/scripts", (file) => /\.mjs$/.test(file)),
      ...filesUnder("benchmarks/src", (file) => /\.ts$/.test(file) && !/\.test\.|\.spec\./.test(file)),
    ];
    const offenders = files.filter((file) => readFileSync(file, "utf8").includes("NOT_RETAINABLE"));
    expect(offenders.map((file) => path.relative(repoRoot, file))).toEqual([]);
  });

  it("moves the driver onto the PWA server in the same breath", () => {
    const source = read("benchmarks/scripts/measure-footprint.mjs");
    expect(source).toContain("serve-measure-app.mjs");
    expect(source).not.toContain("harness/serve.mjs");
  });
});

describe("T7 — the ETag defect is declared and owned by 17c, not fixed here", () => {
  it("names the 955 B module chunk, why it is there, and who fixes it", () => {
    const defect = warmModuleChunkDefect(WARM_MODULE_CHUNK_BYTES);
    expect(defect.findingCode).toBe("warm_worker_module_chunk_refetched");
    expect(defect.bytes).toBe(WARM_MODULE_CHUNK_BYTES);
    expect(defect.reason).toMatch(/intercept|own script|imports/i);
    expect(defect.owner).toBe("ticket 17c");
    expect(defect.condition).toMatch(/same commit|one commit/);
  });

  it("has a ticket file carrying the both-artifacts-in-one-commit condition", () => {
    const dir = path.join(repoRoot, ".scratch/receipt-lens-v1/issues");
    const file = readdirSync(dir).find((name) => name.startsWith("17c-"));
    expect(file).toBeDefined();
    const body = readFileSync(path.join(dir, file!), "utf8");
    expect(body).toContain("footprint.json");
    expect(body).toContain("warm-bytes.json");
    expect(body).toMatch(/one commit|same commit/);
  });

  // Replaced by ticket 17c, deliberately (DECISIONS/0029 P5 row 2). As written, this pin was 17b's guard
  // against doing header work at all: it asserted the measure server had no ETag and kept `no-store`. The
  // `no-store` half still passes now purely because the 404 path mentions it — a pin that stays green while the
  // behaviour it guards has changed is the failure mode 17c exists to fix, so it now asserts the real thing:
  // both servers answer through ONE policy module, and the live behaviour is checked over HTTP in
  // etag-pins.test.ts rather than by grepping text.
  it("routes both origins through the single policy module 17c shipped", () => {
    for (const file of ["scripts/serve-app.mjs", "scripts/serve-measure-app.mjs"]) {
      const server = read(file);
      expect(server).toContain("etag-policy.js");
      expect(server).toContain("cachePolicyFor");
      expect(server).toContain("shouldNotModify");
    }
    const policy = read("benchmarks/src/footprint/etag-policy.ts");
    expect(policy).toMatch(/BULK/);
    expect(policy).toMatch(/DOCUMENT/);
    expect(policy).toContain("no-store");
  });
});

describe("T8 — findings close honestly, and cacheHeldBytes replaces retainedCacheBytes", () => {
  const archived = JSON.parse(read("benchmarks/results/footprint-2026-11-04-16ae8de.json")) as {
    findings: Finding[];
    totals: { secondVisitBytesOverTheWire: { median: number }; assetsRedownloadedOnEveryVisit: string[] };
    measurement: { deployment: { entry: string; scope: string } };
  };
  const previous = archived.findings.find((f) => f.code === "warm_not_zero_ort_wasm_exceeds_cache_entity_limit")!;

  it("closes ticket 08's finding without rewriting its history", () => {
    const findings = buildFindings({
      previousFinding: previous,
      warmBytes: WARM_BYTES,
      warmPaths: warmWire().map((e) => e.path),
      moduleChunk: warmModuleChunkDefect(WARM_MODULE_CHUNK_BYTES),
      measuredAt: "2026-11-06T00:00:00.000Z",
    });
    const closed = findings.find((f) => f.code === previous.code)!;
    expect(closed.resolvedBy).toBe("ticket 17");
    expect(closed.detail).toBe(previous.detail);
    expect(closed.evidence).toBe(previous.evidence);
    expect(closed.remedy).toBe(previous.remedy);
    expect(closed.affectsClaim).toBe(previous.affectsClaim);
  });

  it("adds the warm finding as a measurement, not a sentence", () => {
    const findings = buildFindings({
      previousFinding: previous,
      warmBytes: WARM_BYTES,
      warmPaths: warmWire().map((e) => e.path),
      moduleChunk: warmModuleChunkDefect(WARM_MODULE_CHUNK_BYTES),
      measuredAt: "2026-11-06T00:00:00.000Z",
    });
    const added = findings.find((f) => f.code === "warm_visit_served_by_service_worker")!;
    expect(added.detail).toContain(String(WARM_BYTES));
    expect(findings.find((f) => f.code === "warm_worker_module_chunk_refetched")).toBeDefined();
  });

  it("derives cacheHeldBytes from the manifest and the model set rather than from 304s", () => {
    const bytes = cacheHeldBytes({
      precacheManifest: [
        { url: ASSETS.runtimeWasm, bytes: 14_848_852 },
        { url: ASSETS.entry, bytes: 200_000 },
      ],
      modelAssets: [
        { file: "PP-OCRv6_tiny_det.onnx", bytes: 1_780_590 },
        { file: "PP-OCRv6_tiny_rec.onnx", bytes: 4_462_639 },
      ],
    });
    expect(bytes).toBe(14_848_852 + 200_000 + 1_780_590 + 4_462_639);
  });

  it("publishes the new field in the canonical artifact and retires the old one", () => {
    const totals = JSON.parse(read("benchmarks/results/footprint.json")).totals as Record<string, unknown>;
    expect(totals.cacheHeldBytes).toBeTypeOf("number");
    expect(totals.retainedCacheBytes).toBeUndefined();
  });

  it("reads the pre-17 baseline from the archive, not from the file 17b regenerates", () => {
    const baseline = harnessBaseline();
    expect(baseline.artifactPath).toContain("footprint-2026-11-04-16ae8de.json");
    expect(baseline.warmBytes).toBe(14_848_852);
    expect(baseline.redownloaded).toEqual(["/ort/ort-wasm-simd-threaded.wasm"]);
    expect(baseline.findingResolvedBy ?? null).toBeNull();
  });

  it("keeps that archive describing the harness, which is why it exists", () => {
    expect(archived.measurement.deployment.scope).toContain("harness");
    expect(archived.totals.secondVisitBytesOverTheWire.median).toBe(14_848_852);
    expect(existsSync(path.join(repoRoot, "benchmarks/results/footprint-2026-11-04-16ae8de.json"))).toBe(true);
  });
});

describe("T9 — classes are unchanged; the thread count is named", () => {
  it("states 1 ORT thread, the missing isolation headers, and that the harness rows are superseded", () => {
    const note = threadNote();
    expect(note).toContain("1 ORT thread");
    expect(note).toMatch(/COOP|COEP/);
    expect(note).toMatch(/superseded/i);
  });

  it("keeps DECISIONS/0012 F4's two declared classes and invents no phone", () => {
    const declared = classes();
    expect(declared.map((c) => c.id)).toEqual(["desktop-chromium-unthrottled", "desktop-chromium-cpu4x"]);
    expect(declared.map((c) => c.cpuThrottleRate)).toEqual([1, 4]);
    expect(declared.join(" ")).not.toMatch(/pixel|android|iphone/i);
  });
});

describe("T10 — the table the README publishes is the PWA's", () => {
  it("records that 17b blocks 18 and hands the header change to 17c", () => {
    const order = sequencing();
    expect(order.blocks).toBe("18");
    expect(order.deferredTo).toBe("17c");
    expect(order.why).toMatch(/harness bytes|post-SW|honest/i);
  });

  it("removes the harness-shaped assumptions from the table generator", () => {
    const generator = read("benchmarks/scripts/render-footprint-table.mjs");
    expect(generator).not.toContain("harnessOnlyBytes");
    expect(generator).not.toContain("no service worker yet");
    expect(generator).not.toContain("Harness-only bytes");
  });

  it("regenerates the README block without a single harness row", () => {
    const readme = read("packages/core/README.md");
    const block = readme.slice(readme.indexOf("<!-- footprint:begin -->"), readme.indexOf("<!-- footprint:end -->"));
    expect(block).toContain("packages/pwa/dist/app/index.html");
    expect(block).toContain("1 ORT thread");
    expect(block).not.toContain("/dist/main.js");
    expect(block).not.toContain("/ort/");
    expect(block).not.toContain("PWA not built");
    expect(block).toContain("not separable");
  });
});
