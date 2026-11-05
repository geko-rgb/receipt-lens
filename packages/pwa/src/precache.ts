/**
 * Ticket 17 — the precache list of DECISIONS/0027 W1.1.
 *
 * This is the one module whose output differs between the two halves of the W1.0 ruling, and it is isolated
 * on purpose: the entries are emitted in `self.__WB_MANIFEST`'s own shape, so under `injectManifest` with
 * Workbox they feed `precacheAndRoute` and without it they feed the worker's install handler. No pin
 * assertion changes either way; only the consumer does.
 *
 * W1.1 replaces Workbox's `maximumFileSizeToCacheInBytes` — a ceiling that, once raised, silently drops
 * anything above it while the build still passes — with a completeness rule: every file that will be written
 * into `dist/app` is either precached or explicitly excluded, and the build fails naming the file otherwise.
 * A runtime WASM that cannot be precached cannot be shipped by accident.
 */

export interface PrecacheEntry {
  /** Root-relative request URL, exactly as the origin will serve it. */
  readonly url: string;
  /** `null` for content-hashed build outputs: the filename is the revision (W3). */
  readonly revision: string | null;
}

/** The token the Vite plugin replaces in the emitted worker (W1.1). */
export const PRECACHE_PLACEHOLDER = "__RL_PRECACHE_MANIFEST__";

/**
 * The named exclusions (W1.1). Anything outside this list that reaches `dist/app` must be in the precache,
 * and adding a name here is a deliberate act: each one is a file a user will not get offline.
 */
export function precacheExclusions(): readonly string[] {
  throw new Error("not implemented: DECISIONS/0027 W1.1 — the precache exclusion set");
}

/** True when a `dist/app` path is deliberately not precached. */
export function isPrecacheExcluded(distPath: string): boolean {
  throw new Error("not implemented: DECISIONS/0027 W1.1 — precache exclusion set");
}

/**
 * The generated list, sorted by `url` so the digest is stable across builds (W3), every entry with
 * `revision: null` because every entry is a content-hashed build output (W2 reason 1).
 */
export function buildPrecacheEntries(distPaths: readonly string[]): PrecacheEntry[] {
  throw new Error("not implemented: DECISIONS/0027 W1.1 — precache entry generation");
}

/**
 * The build-completeness guard. Fails, naming each file, when something written into `dist/app` is neither
 * precached nor excluded (W1.1).
 */
export function assertPrecacheComplete(distPaths: readonly string[], entries: readonly PrecacheEntry[]): void {
  throw new Error("not implemented: DECISIONS/0027 W1.1 — precache completeness guard");
}

/**
 * The negative half of W2.1: model bytes are prepared by the W5 protocol, never precached, because their URLs
 * are version-stable and §9 requires them to be verified and smoke-tested before anything may read them. A
 * precache that silently swallowed `/assets/models/*` would put unverified weights on a device.
 */
export function assertNoModelAssets(entries: readonly PrecacheEntry[]): void {
  throw new Error("not implemented: DECISIONS/0027 W2.1 — no model bytes in the precache manifest");
}
