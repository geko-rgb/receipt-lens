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
 * Written deliberately before the implementation (the `DECISIONS/0018` pattern ticket 10 used and
 * `DECISIONS/0027` W15 cites): every function carrying a rule throws, so the branch is red on exactly the new
 * pins and green on nothing else.
 */

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

const notImplemented = (pin: string, what: string): never => {
  throw new Error(`not implemented: DECISIONS/0028 ${pin} — ${what}`);
};

/* ------------------------------------------------------------------ T1 */

export function deployment(): DeploymentIdentity {
  return notImplemented("T1", "the measured deployment moves to packages/pwa/dist/app/index.html with scope PWA, served by scripts/serve-measure-app.mjs under no-store with no ETag");
}

export function roles(): readonly RolePattern[] {
  return notImplemented("T1", "ROLES re-keyed to the PWA's emitted asset names, harness rows /dist/main.js and /ort/* deleted");
}

export function uncataloguedColdPaths(paths: readonly string[]): readonly string[] {
  void paths;
  return notImplemented("T1", "every cold asset must match a ROLES row; uncatalogued_cold_asset fails the run");
}

export function missingRequiredRoles(paths: readonly string[]): readonly string[] {
  void paths;
  return notImplemented("T1", "the required rows (entry script, runtime loader, runtime WASM, manifest, det, rec, dictionary, worker, page) must each appear in a cold visit");
}

/* ------------------------------------------------------------------ T2 */

export function coldReady(): ColdReadySignal {
  return notImplemented("T2", "cold readiness is the W5 step-6 /active pointer in receipt-lens-active-model-cache, not a timing hook");
}

export function assertColdSample(sample: ColdSample): void {
  void sample;
  notImplemented("T2", "the cold window: 200 with a non-zero body for every logged asset, pinned model bytes, one origin, completed downloads, a real parse");
}

/* ------------------------------------------------------------------ T3 */

export function warmToleranceBytes(): number {
  return notImplemented("T3", "the warm cross-check tolerance is exactly zero bytes");
}

export function assertWarmCrossCheck(input: {
  readonly measured: number;
  readonly committed: number;
  readonly measuredPaths: readonly string[];
  readonly committedPaths: readonly string[];
}): void {
  void input;
  notImplemented("T3", "measure-footprint.mjs and measure-warm-bytes.mjs must agree on the warm median or the run fails naming the delta and both path sets");
}

/* ------------------------------------------------------------------ T4 */

export function latencyBases(): LatencyBases {
  return notImplemented("T4", "appReadyMs and firstResultMs stay measured; ocrReadyMs, modelLoadMs and inferenceMs become not separable, each with its reason");
}

export function domAnchors(): DomAnchors {
  return notImplemented("T4", "the DOM the driver waits on: the load event, [data-testid=\"draft-review\"], the zero-items state, the file input");
}

/* ------------------------------------------------------------------ T5 */

export function failLoudRules(): readonly FailLoudRule[] {
  return notImplemented("T5", "F9's set amended for a worker-served warm visit, including sw_not_controlling_at_warm, warm_cross_check_disagrees, uncatalogued_cold_asset and cold_pointer_never_ready");
}

export function assertWarmSample(sample: WarmSample): void {
  void sample;
  notImplemented("T5", "the warm window: worker controlling, no WASM or model byte over the origin, no shell asset the worker could have served, transferSize 0 page-side, one origin");
}

export function assertRepeatSample(wire: readonly OriginEntry[]): void {
  void wire;
  notImplemented("T5", "F9 condition 5 unchanged: the second receipt in the same page issues no request at all");
}

/* ------------------------------------------------------------------ T7 */

export function warmModuleChunkDefect(): WarmModuleChunkDefect {
  return notImplemented("T7", "the 955 B worker module chunk is declared with its reason and left to ticket 17c; 17b changes no server header");
}

/* ------------------------------------------------------------------ T8 */

export function buildFindings(input: FindingsInput): readonly Finding[] {
  void input;
  return notImplemented("T8", "ticket 08's finding closes with resolvedBy ticket 17 and its text stays verbatim, a measured warm finding is added, and the open ETag defect is published");
}

export function cacheHeldBytes(input: {
  readonly precacheManifest: readonly { readonly url: string; readonly bytes: number }[];
  readonly modelAssets: readonly { readonly file: string; readonly bytes: number }[];
}): number {
  void input;
  return notImplemented("T8", "cacheHeldBytes replaces retainedCacheBytes: the precache manifest plus the verified model set, derived from files rather than from 304 statuses a no-store origin never sends");
}

export function harnessBaseline(): HarnessBaseline {
  return notImplemented("T8", "the pre-17 warm baseline reads the archived harness artifact, not the canonical footprint.json that 17b regenerates and thereby invalidates");
}

/* ------------------------------------------------------------------ T9 */

export function threadNote(): string {
  return notImplemented("T9", "the generated table names 1 ORT thread, the absence of COOP/COEP, and that the 4-thread harness rows are superseded");
}

export function classes(): readonly DeviceClass[] {
  return notImplemented("T9", "DECISIONS/0012 F4's two declared classes, unchanged: native and 4x CPU throttle on this machine, and no invented phone class");
}

/* ------------------------------------------------------------------ T10 */

export function sequencing(): Sequencing {
  return notImplemented("T10", "17b blocks 18 and hands the header change to 17c, restated so a future session does not rediscover it");
}
