/**
 * Ticket 17 — the precache list of DECISIONS/0027 W1.1.
 *
 * This is the one module whose output differs between the two halves of the W1.0 ruling, and it is isolated
 * on purpose: the entries are emitted in `self.__WB_MANIFEST`'s own shape, so under `injectManifest` with
 * Workbox they feed `precacheAndRoute`, and without it they feed the worker's install handler. No pin
 * assertion changes either way; only the consumer does.
 *
 * W1.1 replaces Workbox's `maximumFileSizeToCacheInBytes` — a ceiling that, once raised, silently drops
 * anything above it while the build still passes — with a completeness rule asserted **at build time**: every
 * file that will be written into `dist/app` is either precached or named as excluded, in both directions, and
 * `pnpm build` fails otherwise. A runtime WASM that cannot be precached cannot be shipped by accident.
 */

export interface PrecacheEntry {
  /** Root-relative request URL, exactly as the origin will serve it. */
  readonly url: string;
  /** `null` for content-hashed build outputs: the filename is the revision (W3). */
  readonly revision: string | null;
}

/**
 * The identifier the Vite plugin replaces with the generated list in the emitted worker (W1.1). It is a bare
 * global in `src/sw.ts` rather than a comment, because a bundler discards comments.
 */
export const PRECACHE_PLACEHOLDER = "__RL_PRECACHE_MANIFEST__";

/** The document a navigation falls back to, first in the list so a deep link always has something to serve. */
const MODEL_PATH_PREFIX = "/assets/models/";

/**
 * The named exclusions (W1.1). Anything outside this list that reaches `dist/app` must be in the precache, and
 * adding a name here is a deliberate act: each one is a file a user will not get offline.
 */
export function precacheExclusions(): readonly string[] {
  return [".vite/manifest.json", "sw.js"];
}

/**
 * A `dist/app` key as a root-relative URL. Only a leading `./` or `/` is stripped — a lone leading `.` is part
 * of the name (`.vite/manifest.json`), and dropping it made the exclusion list unreachable.
 */
const toUrl = (distPath: string): string => `/${distPath.replace(/^\.\//, "").replace(/^\//, "")}`;

const isSourceMap = (distPath: string): boolean => distPath.endsWith(".map");
const isModelPath = (distPath: string): boolean => toUrl(distPath).startsWith(MODEL_PATH_PREFIX);

/**
 * True when a `dist/app` path is deliberately not precached: a named exclusion, a source map (W1.1 — a headless
 * page without devtools never asks for one, and 15 MB of maps is quota spent on nobody), or a model asset,
 * which goes through §9's verification protocol instead (W2.1).
 */
export function isPrecacheExcluded(distPath: string): boolean {
  return precacheExclusions().includes(toUrl(distPath).slice(1)) || isSourceMap(distPath) || isModelPath(distPath);
}

/**
 * The generated list, sorted by `url` so the digest is stable across builds (W3), every entry with
 * `revision: null` because every entry is a content-hashed build output (W2 reason 1).
 */
export function buildPrecacheEntries(distPaths: readonly string[]): PrecacheEntry[] {
  return distPaths
    .filter((path) => !isPrecacheExcluded(path))
    .map((path) => ({ url: toUrl(path), revision: null }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/**
 * The build-time completeness guard, in the inclusion direction (W1.1, owner ruling Condition 2). Fails,
 * naming each file, when something written into `dist/app` is neither precached nor excluded.
 */
export function assertPrecacheComplete(distPaths: readonly string[], entries: readonly PrecacheEntry[]): void {
  const precached = new Set(entries.map((entry) => entry.url));
  const missing = distPaths.filter((path) => !isPrecacheExcluded(path) && !precached.has(toUrl(path)));
  if (missing.length > 0) {
    throw new Error(
      `DECISIONS/0027 W1.1: ${missing.length} file(s) in dist/app are neither precached nor excluded, so an offline reload would not have them: ${missing.join(", ")}. Add the file to the precache or name it in precacheExclusions() deliberately.`,
    );
  }
}

/**
 * The guard in the other direction (W1.1 Condition 2, and W2.1): nothing that must stay out of the precache
 * got in. Model bytes are the serious half — a precached model asset would put unverified weights on a device
 * without ever passing §9's verification and smoke gate.
 */
export function assertNoModelAssets(entries: readonly PrecacheEntry[]): void {
  const offenders = entries.filter((entry) => entry.url.startsWith(MODEL_PATH_PREFIX));
  const maps = entries.filter((entry) => entry.url.endsWith(".map"));
  const unexpected = [...offenders, ...maps];
  if (unexpected.length > 0) {
    throw new Error(
      `DECISIONS/0027 W2.1: the precache manifest holds ${unexpected.length} excluded file(s): ${unexpected.map((entry) => entry.url).join(", ")}.`,
    );
  }
}
