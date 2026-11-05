/**
 * Ticket 17 — the model-set update protocol of DECISIONS/0027 W5, run by the **page** (W4).
 *
 * The worker cannot honestly run step 5: a smoke inference needs `onnxruntime-web`, a decoder and a canvas,
 * and `browserOcrEnvironment` is the provider's declared environment (`pp-ocrv6.ts:221`). So the protocol is
 * here, the worker only reads, and the whole thing is a pure function of the injected dependencies below —
 * which is what makes each of the eight steps separately falsifiable in `tests/sw/pins.test.ts`.
 *
 * No clock and no random source are read inside (DECISIONS/0011's determinism rule, restated in
 * DECISIONS/0025 P9): `now` and `fetchImpl` come in from the caller.
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
      /** W18: the outcome of the durability request. Denied is normal and changes nothing else. */
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

export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

/** The verified bytes of one model set, handed to the smoke run so it cannot read anything unverified (W5 step 5). */
export interface VerifiedModelSet {
  readonly providerVersion: string;
  readonly manifestHash: string;
  readonly manifestText: string;
  readonly totalBytes: number;
  /** role → bytes, keyed `det` | `rec` | `dict`. */
  readonly assets: Readonly<Record<"det" | "rec" | "dict", ArrayBuffer>>;
}

/** A smoke run's outcome. The acceptance bar is W5 step 5: at least one line **and** one word. */
export interface SmokeOutcome {
  readonly lines: number;
  readonly words: number;
  readonly error?: string;
}

export interface PrepareModelSetDeps {
  /** `(input) => fetch(input, { cache: "reload" })` in the browser — the only mechanism W6 has. */
  readonly fetchImpl: FetchLike;
  readonly caches: CacheStorageLike;
  readonly manifestUrl: string;
  /** Runs one inference against the in-memory verified bytes. Provided by the caller, not imported. */
  readonly runSmoke: (set: VerifiedModelSet) => Promise<SmokeOutcome>;
  /** W18. Called only after a successful activation. */
  readonly requestPersistence: () => Promise<boolean>;
  readonly now: () => number;
  /** Drives the "Preparing OCR — X MB of Y MB" line (W2.1, W7.3). */
  readonly onProgress?: (bytesDownloaded: number, totalBytes: number) => void;
}

/**
 * The eight steps of W5, in order: probe → download → verify → write candidate → smoke → activate → cleanup
 * → report.
 *
 * Step 1 exits early when `receipt-lens-models:<providerVersion>:<manifestHash>` is already the pointer's
 * value: no download, no smoke, no writes. Activation (step 6) is one pointer `put`, and nothing before it is
 * observable by a reader. Every failure path leaves that pointer alone (W7) and deletes only its own
 * half-written candidate (W7.1).
 */
export async function prepareModelSet(deps: PrepareModelSetDeps): Promise<ModelUpdateState> {
  throw new Error(`not implemented: DECISIONS/0027 W5 — the model update protocol (${deps.manifestUrl})`);
}

/** The status values {@link modelUpdateCopy} has wording for. `idle`/`probing` render nothing. */
export type ModelUpdateCopyKey = "pending" | "preparing" | "unavailable";

/**
 * The pinned user-facing wording (W7.3), asserted verbatim because copy is a contract the way error codes
 * are — DECISIONS/0025 P7 set the precedent. No string here may promise the update will arrive, retry on a
 * timer, or describe the retained set as current.
 */
export function modelUpdateCopy(status: ModelUpdateCopyKey): string {
  throw new Error(`not implemented: DECISIONS/0027 W7.3 — ${status} copy`);
}

/** Formats the W2.1 progress line from the manifest's own declared byte totals. */
export function modelPreparingCopy(bytesDownloaded: number, totalBytes: number): string {
  throw new Error("not implemented: DECISIONS/0027 W2.1 — preparing OCR progress copy");
}
