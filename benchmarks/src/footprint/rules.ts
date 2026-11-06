/**
 * DECISIONS/0028 — the ticket 17b footprint re-derivation pins, as code.
 *
 * Why a module and not just prose in the driver: a pin that lives only inside a twenty-minute browser run is
 * not a pin. Every rule `DECISIONS/0028` T1–T10 states is here as a named function so
 * `benchmarks/tests/footprint/pins.test.ts` can fire it against a fixture, and so
 * `benchmarks/scripts/measure-footprint.mjs` applies *the same* rule the tests check rather than a paraphrase
 * of it. The driver that moves the measured deployment from the §9 M1 harness to the PWA imports this; the
 * tests import this; neither can drift from the record without the other noticing.
 *
 * Fail-loud violations throw `FootprintFailLoud` with a code from `FailLoudCode` (T5, ruled at checkpoint 2).
 * Assertions compare codes, not message keywords, because a keyword regex can be satisfied by any text that
 * happens to contain the word — including a stub's apology, which is exactly how eight assertions in the first
 * draft were vacuous and three were green for the wrong reason.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

/** What the artifact calls an asset's group in the generated table. */
export type AssetCategory = "app" | "model" | "runtime" | "other";

/**
 * Every fail-loud condition `DECISIONS/0028` T5 states, by the code its message carries.
 *
 * Codes rather than message matching: a pin you check with a regex can be satisfied by any text that happens
 * to contain the word, including a stub's apology. The tests assert this union, so a run that *silently* stopped
 * checking is the only thing that can make one of them go quiet, and `failLoudRules()` enumerates what must be
 * live.
 */
export type FailLoudCode =
  | "cold_conditional_response"
  | "cold_zero_body"
  | "cold_model_bytes_moved"
  | "cold_pointer_never_ready"
  | "draft_produced_nothing"
  | "cross_origin_request"
  | "failed_request_status"
  | "download_incomplete"
  | "warm_asset_over_the_wire"
  | "sw_not_controlling_at_warm"
  | "warm_cross_check_disagrees"
  | "page_observed_network_transfer"
  | "repeat_touched_network"
  | "uncatalogued_cold_asset"
  | "required_row_missing";

/** A fail-loud violation, carrying the code that names the condition it fired. */
export class FootprintFailLoud extends Error {
  readonly code: FailLoudCode;
  readonly detail: string;

  constructor(code: FailLoudCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "FootprintFailLoud";
    this.code = code;
    this.detail = detail;
  }
}

/** One `ROLES` row: a shape matched against a served path, and the row it publishes. */
export interface RolePattern {
  readonly pattern: RegExp;
  readonly role: string;
  readonly category: AssetCategory;
  /** T1/F9.11 — a required row missing from a cold visit fails the run. */
  readonly required: boolean;
}

/** One entry in the origin's request log — the byte count F5 insists on taking at the origin. */
export interface OriginEntry {
  readonly path: string;
  readonly status: number;
  readonly bodyBytes: number;
  /** F9.7: an interrupted download may not be summed as a completed one. */
  readonly completed: boolean;
}

/** T1 — what is measured, in the words the artifact publishes. */
export interface DeploymentIdentity {
  readonly entry: string;
  readonly scope: string;
  readonly servedBy: string;
  readonly cacheContract: string;
  readonly contentEncoding: string;
  readonly threads: string;
  readonly remeasureRequiredAfter: string;
}

/** T2 — the observable ready signal. A pointer naming a verified set, not a flag and not a timing hook. */
export interface ColdReadySignal {
  readonly cache: string;
  readonly path: string;
  readonly timeoutMs: number;
  readonly pollingMs: number;
}

/** One fail-loud condition, named by the code its message carries. */
export interface FailLoudRule {
  readonly code: FailLoudCode;
  readonly when: string;
}

/** A cold sample as the driver observed it, before any byte is published. */
export interface ColdSample {
  readonly wire: readonly OriginEntry[];
  readonly origins: readonly string[];
  /** T2: the W5 step-6 pointer appeared, so a verified model set is active. */
  readonly readySignalSeen: boolean;
  /** `/assets/models/*` bytes, as the committed manifest pins them (F9.10). */
  readonly pinnedModelBytes: ReadonlyMap<string, number>;
  /** T5/F9.8, DOM form: a draft that rendered the zero-items state read nothing usable. */
  readonly renderedZeroItems: boolean;
}

/** A warm sample: one reload with the worker in control, and the origin's record of it. */
export interface WarmSample {
  readonly wire: readonly OriginEntry[];
  readonly origins: readonly string[];
  readonly swControlling: boolean;
  readonly warmBytes: number;
  /**
   * T5/F9.3 amended. The resources the *page* could see on the warm visit, with the `transferSize` the page
   * observed. WASM and worker loads never appear in the measured document's resource timings — `DECISIONS/0012`
   * F5 says so and ticket 08 measured it — so this is a cross-check over what the page can honestly report,
   * not the byte count. For those, a warm visit must show `transferSize === 0`.
   */
  readonly pageTransferred: readonly { readonly path: string; readonly transferBytes: number }[];
}

/** T4 — which latency rows are measured and which are reported as unseparable. */
export interface LatencyBases {
  readonly measured: readonly string[];
  readonly notSeparable: readonly { readonly field: string; readonly reason: string }[];
}

/** T4 — the DOM the driver waits on, and the events that anchor the two measured numbers. */
export interface DomAnchors {
  readonly appReady: string;
  readonly firstResult: string;
  readonly zeroItems: string;
  readonly fileInput: string;
}

/** T7 — the inherited ETag defect, declared rather than fixed. */
export interface WarmModuleChunkDefect {
  readonly findingCode: string;
  readonly bytes: number;
  readonly reason: string;
  readonly owner: string;
  readonly condition: string;
}

/** One entry in `footprint.json`'s `findings[]`. */
export interface Finding {
  readonly code: string;
  readonly detail: string;
  readonly evidence: string;
  readonly remedy?: string;
  readonly affectsClaim?: string;
  readonly resolvedBy?: string | null;
  readonly resolvedAt?: string | null;
  readonly resolution?: string;
}

/** The inputs `buildFindings` needs to close ticket 08's finding from a measurement. */
export interface FindingsInput {
  /** The finding as the archived harness artifact published it, verbatim. */
  readonly previousFinding: Finding;
  readonly warmBytes: number;
  readonly warmPaths: readonly string[];
  readonly moduleChunk: WarmModuleChunkDefect;
  readonly measuredAt: string;
}

/** T8 — the pre-17 baseline, read from the artifact that still describes the harness. */
export interface HarnessBaseline {
  readonly artifactPath: string;
  readonly warmBytes: number;
  readonly redownloaded: readonly string[];
  readonly findingResolvedBy: string | null;
  readonly deploymentEntry: string;
}

/** T9 — a declared device class (DECISIONS/0012 F4). */
export interface DeviceClass {
  readonly id: string;
  readonly label: string;
  readonly cpuThrottleRate: number;
}

/** T10 — what this ticket blocks and what it hands on. */
export interface Sequencing {
  readonly blocks: string;
  readonly deferredTo: string;
  readonly why: string;
}

/**
 * The committed artifact that still describes the §9 M1 harness deployment, and that `measure-warm-bytes.mjs`
 * must therefore read instead of the canonical `footprint.json` (T8). Named rather than globbed: a baseline
 * found by pattern is a baseline that silently changes what it points at when a second archive lands.
 */
export const HARNESS_BASELINE_ARTIFACT = "benchmarks/results/footprint-2026-11-04-16ae8de.json";

/** The date ticket 17 merged — what `resolvedBy: "ticket 17"` in a finding is pointing at (W16). */
export const TICKET_17_MERGED_ON = "2026-11-06";

/* ------------------------------------------------------------------ T1 */

export function deployment(): DeploymentIdentity {
  return {
    entry: "packages/pwa/dist/app/index.html",
    scope: "PWA",
    servedBy: "scripts/serve-measure-app.mjs — one same-origin HTTP/1.1 origin on 127.0.0.1, no reverse proxy, the request log F5 counts bytes from",
    cacheContract:
      "cache-control: no-store with no ETag: this origin answers no 304 to anything, so warm liveness is proven by the worker's caches plus the origin log, never by a conditional response (DECISIONS/0027 W17.3, DECISIONS/0028 T5)",
    contentEncoding: "identity — nothing is compressed, so wire bytes equal file bytes",
    threads: threadNote(),
    remeasureRequiredAfter:
      "discharged here: DECISIONS/0012 F11 trigger 1 (the PWA exists) was this ticket, and this measurement is the discharge",
  };
}

/**
 * The rows the PWA's build emits, matched by shape because the hashes move with every rebuild.
 *
 * Order matters: the first match wins, so the two `/assets/models/` shapes are named before anything that
 * could claim a `.json` or `.txt` elsewhere, and `sw.js` before the generic route row.
 */
export function roles(): readonly RolePattern[] {
  return [
    { pattern: /^\/sw\.js$/, role: "Service worker script", category: "app", required: true },
    { pattern: /^\/assets\/cache-names-[\w-]+\.js$/, role: "Service worker module chunk", category: "app", required: true },
    { pattern: /^\/assets\/index-[\w-]+\.js$/, role: "Application entry script (shell + core + OCR glue)", category: "app", required: true },
    { pattern: /^\/assets\/index-[\w-]+\.css$/, role: "Application styles", category: "app", required: true },
    { pattern: /^\/assets\/rolldown-runtime-[\w-]+\.js$/, role: "Bundle runtime", category: "app", required: true },
    { pattern: /^\/assets\/ort\.wasm\.bundle\.min-[\w-]+\.js$/, role: "Inference runtime JS loader", category: "runtime", required: true },
    { pattern: /^\/assets\/ort-wasm-simd-threaded-[\w-]+\.wasm$/, role: "Inference runtime WASM", category: "runtime", required: true },
    { pattern: /^\/assets\/models\/manifest\.json$/, role: "Model manifest", category: "model", required: true },
    { pattern: /^\/assets\/models\/PP-OCRv6_tiny_det\.onnx$/, role: "Detection model (PP-OCRv6 Tiny)", category: "model", required: true },
    { pattern: /^\/assets\/models\/PP-OCRv6_tiny_rec\.onnx$/, role: "Recognition model (PP-OCRv6 Tiny)", category: "model", required: true },
    { pattern: /^\/assets\/models\/PP-OCRv6_tiny_rec\.txt$/, role: "Recognition dictionary", category: "model", required: true },
    { pattern: /^\/index\.html$/, role: "App shell document (precached)", category: "app", required: true },
    { pattern: /^\/manifest\.webmanifest$/, role: "Web app manifest", category: "app", required: true },
    { pattern: /^\/icons\/[\w-]+\.png$/, role: "Launcher icon", category: "app", required: false },
    { pattern: /^\/(capture|bill|bills|share|)$/, role: "App shell served for a route navigation", category: "app", required: true },
  ];
}

export function classifyRole(pathname: string): RolePattern | null {
  return roles().find((row) => row.pattern.test(pathname)) ?? null;
}

export function uncataloguedColdPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].filter((pathname) => classifyRole(pathname) === null).sort();
}

export function missingRequiredRoles(paths: readonly string[]): readonly string[] {
  const served = new Set(paths);
  return roles()
    .filter((row) => row.required && ![...served].some((pathname) => row.pattern.test(pathname)))
    .map((row) => row.role);
}

/* ------------------------------------------------------------------ T2 */

export function coldReady(): ColdReadySignal {
  return {
    cache: "receipt-lens-active-model-cache",
    path: "/active",
    timeoutMs: 240_000,
    pollingMs: 250,
  };
}

export function assertColdSample(sample: ColdSample): void {
  if (!sample.readySignalSeen) {
    throw new FootprintFailLoud(
      "cold_pointer_never_ready",
      `the W5 step-6 pointer ${coldReady().path} never appeared in ${coldReady().cache}, so no verified model set was active and the run measured a half-installed app`,
    );
  }
  if (sample.origins.length !== 1) {
    throw new FootprintFailLoud(
      "cross_origin_request",
      `a cold visit touched ${sample.origins.length} origins (${sample.origins.join(", ")}); PROJECT(1).md §9 allows the app origin only`,
    );
  }

  const uncatalogued = uncataloguedColdPaths(sample.wire.map((entry) => entry.path));
  if (uncatalogued.length > 0) {
    throw new FootprintFailLoud(
      "uncatalogued_cold_asset",
      `the cold visit served ${uncatalogued.join(", ")} and ROLES has no row for it (DECISIONS/0028 T1: a table with an unnamed row is not a measured footprint)`,
    );
  }
  const missing = missingRequiredRoles(sample.wire.map((entry) => entry.path));
  if (missing.length > 0) {
    throw new FootprintFailLoud("required_row_missing", `required footprint rows never arrived: ${missing.join(", ")}`);
  }

  for (const entry of sample.wire) {
    if (entry.status >= 400) {
      throw new FootprintFailLoud("failed_request_status", `${entry.path} answered ${entry.status} on a cold visit`);
    }
    if (entry.status === 304) {
      throw new FootprintFailLoud(
        "cold_conditional_response",
        `${entry.path} answered 304 on a cold visit — the context was not empty, so this is not a cold measurement`,
      );
    }
    if (entry.status === 200 && entry.bodyBytes === 0) {
      throw new FootprintFailLoud("cold_zero_body", `${entry.path} answered 200 with no body — origin or browser is lying about the cache`);
    }
    if (!entry.completed) {
      throw new FootprintFailLoud("download_incomplete", `${entry.path} did not finish: an interrupted download may not be summed as a completed one`);
    }
    const pinned = sample.pinnedModelBytes.get(entry.path);
    if (pinned !== undefined && entry.bodyBytes !== pinned) {
      throw new FootprintFailLoud(
        "cold_model_bytes_moved",
        `${entry.path} was served as ${entry.bodyBytes} bytes but assets/models/manifest.json pins ${pinned}`,
      );
    }
  }

  if (sample.renderedZeroItems) {
    throw new FootprintFailLoud(
      "draft_produced_nothing",
      `the draft rendered ${domAnchors().zeroItems}: F9.8's condition, in the DOM form a deployment without a harness hook has to use — footprint numbers from a run that read nothing are meaningless`,
    );
  }
}

/* ------------------------------------------------------------------ T3 */

export function warmToleranceBytes(): number {
  return 0;
}

/**
 * Paths a warm visit may legitimately pay for, and why each is *not* an exception list in the F10 sense:
 *
 * - `/sw.js` — the browser's own byte-check of the worker script. A worker never intercepts the fetch of its
 *   own script, so no cache it controls can prevent this.
 * - `/assets/cache-names-*.js` — the worker's module import. Same structural reason; T7's open defect, with
 *   17c as its owner.
 * - `/assets/models/manifest.json` — W5 step 1's version probe, which W6 pins as a deliberate
 *   `cache: "reload"` request. It is the app asking the origin what it serves, which is the point.
 *
 * Anything else that the active caches could have answered must not appear. And unlike `NOT_RETAINABLE`, this
 * is not a permission slip: a new asset moves the warm total, and `assertWarmCrossCheck` fails on ±0.
 */
function warmRequestIsStructural(pathname: string): boolean {
  return (
    pathname === "/sw.js" ||
    /^\/assets\/cache-names-[\w-]+\.js$/.test(pathname) ||
    pathname === "/assets/models/manifest.json"
  );
}

export function assertWarmCrossCheck(input: {
  readonly measured: number;
  readonly committed: number;
  readonly measuredPaths: readonly string[];
  readonly committedPaths: readonly string[];
}): void {
  const delta = input.measured - input.committed;
  if (Math.abs(delta) > warmToleranceBytes()) {
    const only = (a: readonly string[], b: readonly string[]) => [...new Set(a)].filter((p) => !b.includes(p)).sort();
    throw new FootprintFailLoud(
      "warm_cross_check_disagrees",
      `measure-footprint.mjs measured ${input.measured} B warm and benchmarks/results/warm-bytes.json publishes ${input.committed} B (delta ${delta > 0 ? "+" : ""}${delta} B). Both count bytes at the same origin under DECISIONS/0012 F5, so one of them is not measuring what it claims. paths only this run saw: ${only(input.measuredPaths, input.committedPaths).join(", ") || "none"}; paths only warm-bytes.json saw: ${only(input.committedPaths, input.measuredPaths).join(", ") || "none"}. Neither artifact may be rewritten to match the other — report the delta (DECISIONS/0028 T3).`,
    );
  }
}

/* ------------------------------------------------------------------ T4 */

export function latencyBases(): LatencyBases {
  const reason =
    "no test-only timing hook ships in the bundle (DECISIONS/0027 W15 following DECISIONS/0023 S1), and the app surfaces no OCR duration to the DOM at all — verified by grep of packages/pwa/src";
  return {
    measured: ["appReadyMs", "firstResultMs"],
    notSeparable: [
      { field: "ocrReadyMs", reason },
      { field: "modelLoadMs", reason },
      { field: "inferenceMs", reason },
    ],
  };
}

export function domAnchors(): DomAnchors {
  return {
    appReady: "PerformanceNavigationTiming.loadEventEnd",
    firstResult: '[data-testid="draft-review"]',
    zeroItems: '[data-testid="zero-items-state"]',
    fileInput: '[data-testid="file-input"]',
  };
}

/* ------------------------------------------------------------------ T5 */

export function failLoudRules(): readonly FailLoudRule[] {
  return [
    { code: "cold_conditional_response", when: "a cold visit saw a 304, so the browser context was not empty and the phase is not cold" },
    { code: "cold_zero_body", when: "an origin-logged 200 carried no body bytes, so the origin is not telling the truth about what it sent" },
    { code: "cold_model_bytes_moved", when: "served model bytes differ from the count assets/models/manifest.json pins for that asset" },
    { code: "cold_pointer_never_ready", when: "the W5 step-6 /active pointer never appeared, so no verified model set was active before the run" },
    { code: "draft_produced_nothing", when: "the draft rendered the zero-items state: F9.8 read from the DOM, because the PWA has no harness hook" },
    { code: "cross_origin_request", when: "a measured phase touched more than the app origin — PROJECT(1).md §9, same-origin only, no third-party CDN" },
    { code: "failed_request_status", when: "any response in a measured phase answered 400 or above" },
    { code: "download_incomplete", when: "a logged response's body did not finish writing (F9.7, res.writableFinished false at the origin)" },
    { code: "warm_asset_over_the_wire", when: "a warm visit asked the origin for something the active caches could have answered, with no structural reason for the request" },
    { code: "sw_not_controlling_at_warm", when: "navigator.serviceWorker.controller was null when the warm log window opened, so the warm number measures the pre-17 deployment" },
    { code: "warm_cross_check_disagrees", when: "this run's warm median differs from the published warm-bytes.json median by more than zero bytes" },
    { code: "page_observed_network_transfer", when: "a resource the page could see reported transferSize above zero on a warm visit while the worker was controlling" },
    { code: "repeat_touched_network", when: "the second receipt in the same page issued any origin request at all (F9.5, unchanged by the move)" },
    { code: "uncatalogued_cold_asset", when: "the cold visit served a path ROLES has no row for, which would publish a mystery line in the table" },
    { code: "required_row_missing", when: "a required ROLES row never arrived in a cold visit" },
  ];
}

export function assertWarmSample(sample: WarmSample): void {
  if (!sample.swControlling) {
    throw new FootprintFailLoud(
      "sw_not_controlling_at_warm",
      "no navigator.serviceWorker.controller at the moment the warm log window opened: the warm visit would be measuring the deployment without a worker, which is the pre-17 number this ticket exists to replace",
    );
  }
  if (sample.origins.length !== 1) {
    throw new FootprintFailLoud(
      "cross_origin_request",
      `a warm visit touched ${sample.origins.length} origins (${sample.origins.join(", ")}); §9 allows the app origin only`,
    );
  }
  for (const entry of sample.wire) {
    if (entry.status >= 400) {
      throw new FootprintFailLoud("failed_request_status", `${entry.path} answered ${entry.status} on a warm visit`);
    }
    if (!entry.completed) {
      throw new FootprintFailLoud("download_incomplete", `${entry.path} did not finish on a warm visit`);
    }
    if (classifyRole(entry.path) !== null && !warmRequestIsStructural(entry.path)) {
      throw new FootprintFailLoud(
        "warm_asset_over_the_wire",
        `${entry.path} reached the origin with ${entry.bodyBytes} bytes on a warm visit while the worker was controlling, and the active caches could have answered it. DECISIONS/0012 F12's remedy is the Cache API, so a full re-download here is the broken cache contract, not a declared exception — there is no exception set any more (T6).`,
      );
    }
  }
  for (const resource of sample.pageTransferred) {
    if (resource.transferBytes > 0 && classifyRole(resource.path) !== null && !warmRequestIsStructural(resource.path)) {
      throw new FootprintFailLoud(
        "page_observed_network_transfer",
        `the page saw ${resource.path} move ${resource.transferBytes} bytes on a warm visit; F9.3's amended pass condition is transferSize === 0 for anything the worker could serve`,
      );
    }
  }
}

export function assertRepeatSample(wire: readonly OriginEntry[]): void {
  if (wire.length > 0) {
    throw new FootprintFailLoud(
      "repeat_touched_network",
      `the second receipt in the same page issued ${wire.length} origin request(s): ${wire.map((entry) => `${entry.status} ${entry.path} (${entry.bodyBytes} B)`).join(", ")}`,
    );
  }
}

/* ------------------------------------------------------------------ T7 */

export function warmModuleChunkDefect(observedBytes: number): WarmModuleChunkDefect {
  return {
    findingCode: "warm_worker_module_chunk_refetched",
    bytes: observedBytes,
    reason:
      "a service worker never intercepts the fetch of its own script or that script's imports, and the origin answers code assets with cache-control: no-store, so the worker re-fetches its module chunk on every instantiation",
    owner: "ticket 17c",
    condition:
      "the ETag change and the regeneration of both footprint artifacts land in the same commit (DECISIONS/0028 T3/T7): a header change moves the number two artifacts publish",
  };
}

/* ------------------------------------------------------------------ T8 */

export function buildFindings(input: FindingsInput): readonly Finding[] {
  const previous = input.previousFinding;
  return [
    {
      ...previous,
      resolvedBy: "ticket 17",
      resolvedAt: TICKET_17_MERGED_ON,
      resolution:
        "the worker precaches the runtime WASM into the Cache API, which is not subject to the HTTP cache's per-entity limit; this artifact's warm visit no longer lists it (DECISIONS/0027 W16)",
    },
    {
      code: "warm_visit_served_by_service_worker",
      detail: `a warm visit moves ${input.warmBytes} B over the wire, and the requests that reached the origin are ${input.warmPaths.join(", ") || "none"}`,
      evidence: "this artifact's warm runs[]: five samples per class, counted from the origin's own request log (DECISIONS/0012 F5), cross-checked at ±0 against benchmarks/results/warm-bytes.json",
      affectsClaim: "section 9 initial-download / re-fetch cost: the second visit is no longer priced at the runtime WASM",
    },
    {
      code: input.moduleChunk.findingCode,
      detail: `${input.moduleChunk.bytes} B of the warm total is the worker's own module chunk, re-fetched on every instantiation: ${input.moduleChunk.reason}`,
      evidence: `the warm runs[] path list in this artifact, against benchmarks/results/warm-bytes.json's warmPerAsset`,
      remedy: `ticket 17c: an ETag on code assets, which DECISIONS/0012 F10 measured already revalidating correctly under the entity limit. ${input.moduleChunk.condition}`,
      affectsClaim: "the warm-visit byte total, not the local-processing claim",
      resolvedBy: null,
    },
  ];
}

export function cacheHeldBytes(input: {
  readonly precacheManifest: readonly { readonly url: string; readonly bytes: number }[];
  readonly modelAssets: readonly { readonly file: string; readonly bytes: number }[];
}): number {
  const shell = input.precacheManifest.reduce((sum, asset) => sum + asset.bytes, 0);
  const models = input.modelAssets.reduce((sum, asset) => sum + asset.bytes, 0);
  return shell + models;
}

export function harnessBaseline(): HarnessBaseline {
  const artifact = JSON.parse(readFileSync(path.join(repoRoot, HARNESS_BASELINE_ARTIFACT), "utf8")) as {
    totals: { secondVisitBytesOverTheWire: { median: number }; assetsRedownloadedOnEveryVisit: string[] };
    findings?: { code: string; resolvedBy?: string | null }[];
    measurement: { deployment: { entry: string } };
  };
  const finding = artifact.findings?.find((entry) => entry.code === "warm_not_zero_ort_wasm_exceeds_cache_entity_limit");
  return {
    artifactPath: HARNESS_BASELINE_ARTIFACT,
    warmBytes: artifact.totals.secondVisitBytesOverTheWire.median,
    redownloaded: artifact.totals.assetsRedownloadedOnEveryVisit,
    findingResolvedBy: finding?.resolvedBy ?? null,
    deploymentEntry: artifact.measurement.deployment.entry,
  };
}

/* ------------------------------------------------------------------ T9 */

export function threadNote(): string {
  return "Latency measured at 1 ORT thread (serve-app.mjs sends no COOP/COEP; the harness's 4-thread measurement is superseded). If isolation headers are added, latency improves and the footprint table regenerates.";
}

export function classes(): readonly DeviceClass[] {
  return [
    {
      id: "desktop-chromium-unthrottled",
      label: "Desktop Chromium (headless), this machine at native speed",
      cpuThrottleRate: 1,
    },
    {
      id: "desktop-chromium-cpu4x",
      label: "Desktop Chromium (headless), 4x emulated CPU throttle",
      cpuThrottleRate: 4,
    },
  ];
}

/* ------------------------------------------------------------------ T10 */

export function sequencing(): Sequencing {
  return {
    blocks: "18",
    deferredTo: "17c",
    why: "ticket 18 writes claims against the generated table, and while that table is the harness's it would be citing harness bytes as product bytes — the exact failure ADR-002 and DECISIONS/0012 F1 exist to prevent. The ETag header change is post-SW honest measurement's remaining known cost and belongs to 17c, which changes what ships, not what is measured.",
  };
}
