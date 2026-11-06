import { fetchModelManifest, type ModelManifest } from "@receipt-lens/core";

import {
  ACTIVE_MODEL_CACHE,
  ACTIVE_MODEL_POINTER_PATH,
  MODEL_CACHE_PREFIX,
  modelCacheName,
  readActiveModelCache,
  supersededModelCaches,
  type CacheStorageLike,
} from "./cache-names.js";
import { acceptsSmokeResult } from "./smoke.js";

/**
 * Ticket 17 — the model-set update protocol of DECISIONS/0027 W5, run by the **page** (W4).
 *
 * The worker cannot honestly run step 5: a smoke inference needs `onnxruntime-web`, a decoder and a canvas,
 * and `browserOcrEnvironment` is the provider's declared environment (`pp-ocrv6.ts:221`). So the protocol is
 * here, the worker only reads, and the whole thing is a pure function of the injected dependencies below —
 * which is what makes each of the eight steps separately falsifiable in `tests/sw/pins.test.ts`.
 *
 * No clock and no random source are read inside (DECISIONS/0011's determinism rule, restated in
 * DECISIONS/0025 P9): `now`, `fetchImpl` and the smoke runner all come in from the caller.
 */

/** Why a newer model set could not be made ready (W7). A closed union: a new failure mode adds a code. */
export type ModelUpdateReason =
  | "probe_unreachable"
  | "manifest_invalid"
  | "download_incomplete"
  | "hash_mismatch"
  | "smoke_failed";

/** The state the shell renders (W7.3). `pending` is §9's "model update pending"; `unavailable` is W13's state. */
export type ModelUpdateState =
  | { readonly status: "idle" }
  | { readonly status: "probing"; readonly startedAt: number }
  | {
      readonly status: "preparing";
      readonly startedAt: number;
      readonly bytesDownloaded: number;
      readonly totalBytes: number;
    }
  | {
      readonly status: "up-to-date";
      readonly providerVersion: string;
      readonly manifestHash: string;
      readonly preparedAt: number;
      /**
       * W18's durability outcome. `false` on the early exit means "not asked again this attempt", not
       * "denied" — the version is already local, so there is nothing to ask.
       */
      readonly persisted: boolean;
    }
  | {
      readonly status: "pending";
      readonly reason: ModelUpdateReason;
      readonly retainedVersion: string | null;
      readonly lastAttemptAt: number;
    }
  | { readonly status: "unavailable"; readonly reason: ModelUpdateReason; readonly attemptedAt: number };

/** Structurally the same as core's `FetchLike` (`model-manifest.ts:218`) — one argument, so W6's bypass is a closure. */
export type FetchLike = (input: string) => Promise<Response>;

/** The verified bytes of one model set, handed to the smoke run so it cannot read anything unverified (W5 step 5). */
export interface VerifiedModelSet {
  readonly providerVersion: string;
  readonly manifestHash: string;
  readonly manifestText: string;
  readonly totalBytes: number;
  readonly assets: Readonly<Record<"det" | "rec" | "dict", ArrayBuffer>>;
}

/** A smoke run's outcome. The acceptance bar is W5 step 5: at least one line **and** one word. */
export interface SmokeOutcome {
  readonly lines?: number;
  readonly words?: number;
  readonly error?: string;
}

export interface PrepareModelSetDeps {
  /** `(input) => fetch(input, { cache: "reload" })` in the browser — the only mechanism W6 has. */
  readonly fetchImpl: FetchLike;
  readonly caches: CacheStorageLike;
  readonly manifestUrl: string;
  /** Runs one inference against the in-memory verified bytes. Provided by the caller, never imported here. */
  readonly runSmoke: (set: VerifiedModelSet) => Promise<SmokeOutcome>;
  /** W18. Called only after a successful activation. */
  readonly requestPersistence: () => Promise<boolean>;
  readonly now: () => number;
  /** Drives the "Preparing OCR — X MB of Y MB" line (W2.1, W7.3). */
  readonly onProgress?: (bytesDownloaded: number, totalBytes: number) => void;
}

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** `receipt-lens-models:<providerVersion>:<manifestHash>` → the version, for the retained-set label (W7.3). */
const providerVersionOf = (cacheName: string): string => cacheName.slice(MODEL_CACHE_PREFIX.length).split(":")[0] ?? "";

/**
 * Steps 1–8 of DECISIONS/0027 W5.
 *
 * The two halves of cleanup stay different (W7.1): a candidate we may have written is deleted on every failure
 * path that knows its name — issued unconditionally, so an earlier attempt's orphan is collected too — while a
 * *superseded active set* is deleted only after the pointer moved. Activation is one `put`, so a crash anywhere
 * earlier cannot leave a half-active deployment, and the retained set is never a deletion target here because
 * the early exit guarantees candidate ≠ retained.
 */
export async function prepareModelSet(deps: PrepareModelSetDeps): Promise<ModelUpdateState> {
  const startedAt = deps.now();
  let networkFailures = 0;
  let answeredUnsuccessfully = false;
  let manifestText = "";

  // W6: core's FetchLike takes one argument, so the reload-mode bypass is this closure rather than a parameter
  // threaded through a helper. The manifest body is cloned here because step 4 has to write the exact bytes
  // whose hash was checked, and core consumes the response while validating it.
  const fetchImpl: FetchLike = async (input) => {
    const response = await deps.fetchImpl(input).catch((error: unknown) => {
      networkFailures += 1;
      throw error;
    });
    if (!response.ok) answeredUnsuccessfully = true;
    if (input === deps.manifestUrl) manifestText = await response.clone().text();
    return response;
  };

  /** `candidateName` is null only when the probe never yielded a manifest, so there is no name to collect. */
  const fail = async (reason: ModelUpdateReason, retained: string | null, candidateName: string | null): Promise<ModelUpdateState> => {
    if (candidateName !== null) await deps.caches.delete(candidateName);
    return retained
      ? { status: "pending", reason, retainedVersion: providerVersionOf(retained), lastAttemptAt: deps.now() }
      : { status: "unavailable", reason, attemptedAt: deps.now() };
  };

  // ---- step 1: probe
  const failuresAtProbe = networkFailures;
  let manifest: ModelManifest;
  let manifestHash: string;
  try {
    const loaded = await fetchModelManifest(deps.manifestUrl, fetchImpl);
    manifest = loaded.manifest;
    manifestHash = loaded.manifestHash;
  } catch {
    const retained = await readActiveModelCache(deps.caches);
    const unreachable = networkFailures > failuresAtProbe || answeredUnsuccessfully;
    return fail(unreachable ? "probe_unreachable" : "manifest_invalid", retained, null);
  }

  const candidateName = modelCacheName(manifest.providerVersion, manifestHash);
  const activeName = await readActiveModelCache(deps.caches);

  // ---- step 1's early exit: this exact set is already verified and live. No download, no smoke, no writes.
  if (activeName === candidateName) {
    return {
      status: "up-to-date",
      providerVersion: manifest.providerVersion,
      manifestHash,
      preparedAt: deps.now(),
      persisted: false,
    };
  }

  // ---- steps 2 and 3: download, then verify length and hash before anything is written.
  const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const bytes: Partial<Record<"det" | "rec" | "dict", ArrayBuffer>> = {};
  let downloaded = 0;
  for (const asset of manifest.assets) {
    let buffer: ArrayBuffer;
    try {
      const response = await fetchImpl(asset.url);
      if (!response.ok) throw new Error(`answered ${response.status}`);
      buffer = await response.arrayBuffer();
    } catch {
      return fail("download_incomplete", activeName, candidateName);
    }
    if (buffer.byteLength !== asset.bytes) return fail("download_incomplete", activeName, candidateName);
    if ((await sha256Hex(buffer)) !== asset.sha256) return fail("hash_mismatch", activeName, candidateName);
    bytes[asset.role] = buffer;
    downloaded += buffer.byteLength;
    deps.onProgress?.(downloaded, totalBytes);
  }
  const det = bytes.det;
  const rec = bytes.rec;
  const dict = bytes.dict;
  if (!det || !rec || !dict) return fail("download_incomplete", activeName, candidateName);

  // ---- step 4: write the candidate under its final name, so a crash leaves an unreferenced cache.
  const candidate = await deps.caches.open(candidateName);
  await candidate.put(deps.manifestUrl, new Response(manifestText, { headers: { "content-type": "application/json" } }));
  for (const asset of manifest.assets) {
    const body = bytes[asset.role];
    if (body) await candidate.put(asset.url, new Response(body, { headers: { "content-type": "application/octet-stream" } }));
  }

  // ---- step 5: smoke, against the in-memory verified bytes rather than whatever the worker is serving.
  const outcome = await deps.runSmoke({
    providerVersion: manifest.providerVersion,
    manifestHash,
    manifestText,
    totalBytes,
    assets: { det, rec, dict },
  });
  if (!acceptsSmokeResult(outcome)) return fail("smoke_failed", activeName, candidateName);

  // ---- step 6: activate. One pointer write.
  const pointer = await deps.caches.open(ACTIVE_MODEL_CACHE);
  await pointer.put(ACTIVE_MODEL_POINTER_PATH, new Response(candidateName));

  // ---- step 7: cleanup, and only now. Shell caches are not this caller's business (W7.2).
  // Shell caches are not this caller's business: only the worker knows which shell the live document reads.
  for (const name of supersededModelCaches(await deps.caches.keys(), candidateName)) {
    await deps.caches.delete(name);
  }

  // ---- step 8: ask for durability (W18) and report.
  const persisted = await deps.requestPersistence();
  return {
    status: "up-to-date",
    providerVersion: manifest.providerVersion,
    manifestHash,
    preparedAt: deps.now(),
    persisted,
  };
}

/**
 * The status values {@link modelUpdateCopy} has fixed wording for. `preparing` carries live numbers, so it has
 * its own formatter; `idle` and `probing` render nothing.
 */
export type ModelUpdateCopyKey = "pending" | "unavailable";

/** Bytes per published MB, matching `DECISIONS/0012` F7's convention rather than a binary one. */
const BYTES_PER_MB = 1_000_000;

/**
 * The pinned user-facing wording (W7.3), asserted verbatim because copy is a contract the way error codes are
 * — DECISIONS/0025 P7 set the precedent. No string here may promise the update will arrive, retry on a timer,
 * or describe the retained set as current.
 */
export function modelUpdateCopy(status: ModelUpdateCopyKey): string {
  switch (status) {
    case "pending":
      return "A model update is pending. Receipts still read with the previous model set.";
    case "unavailable":
      return "Models are not on this device yet. Receipt reading needs them.";
  }
}

/** Formats the W2.1 progress line from the manifest's own declared byte totals. */
export function modelPreparingCopy(bytesDownloaded: number, totalBytes: number): string {
  const mb = (value: number) => (value / BYTES_PER_MB).toFixed(1);
  return `Preparing OCR — ${mb(bytesDownloaded)} MB of ${mb(totalBytes)} MB.`;
}
