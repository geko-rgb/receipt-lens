import type { PrecacheEntry } from "../../precache.js";

/**
 * Ticket 17 — the three cache names of DECISIONS/0027 W3, and the only place a name is composed (W3.1).
 *
 * A cache name is not a string template here, it is the identity of a verified model set. §9 forbids reusing
 * one "solely because a filename or generic URL matches", and the pointer cache is the single record of which
 * set readers are served, so the cleanup predicates and the pointer's own name have to be decided together.
 *
 * W3.1 makes this module the only place that decides, and splits the decision by *kind*: `supersededShellCaches`
 * and `supersededModelCaches` are the two selectors, and a caller can only ask about the kind it owns. That is
 * deliberate rather than tidiness — the page does not know which shell the live document is reading, and the
 * worker does not know which candidate the page is still verifying, so a single combined sweep would let either
 * one delete the other's working set (W7.1, W7.2, and owner Condition 1: lifecycle never deletes a model cache).
 */

/** §9's model-cache prefix, verbatim: `receipt-lens-models:<providerVersion>:<manifestHash>`. */
export const MODEL_CACHE_PREFIX = "receipt-lens-models:";

/** DECISIONS/0027 W3. A shipped-app change must bump this name; the ruling makes it bump itself. */
export const SHELL_CACHE_PREFIX = "receipt-lens-shell-v";

/**
 * The pointer (W3). Named so that it matches neither cleanup prefix: `receipt-lens-models:` ends in a colon,
 * and this does not begin `receipt-lens-shell-v`. W3.1 pins that it survives every predicate here.
 */
export const ACTIVE_MODEL_CACHE = "receipt-lens-active-model-cache";

/** The single entry inside {@link ACTIVE_MODEL_CACHE} whose body is the active model cache name. */
export const ACTIVE_MODEL_POINTER_PATH = "/active";

/** The path a precached navigation falls back to when the exact URL is not in the shell cache (W4.1). */
export const SHELL_NAVIGATION_FALLBACK = "/index.html";

/** W3's digest length: 12 hex characters, 48 bits, enough to distinguish two builds of one app. */
const DIGEST_CHARS = 12;

/**
 * Field and record separators of the canonical serialisation (W3). Control characters, so no URL or revision
 * can produce a false boundary. Built from code points rather than written inline, because an invisible byte
 * in a source file is exactly the thing a later reader cannot check.
 */
/**
 * The part of the Cache API this module touches. Declared structurally rather than imported from `lib.dom` so
 * a test can hand in a double (W4: the protocol is a pure function of injected `fetch` and `caches`), and so
 * the worker and the page share one description of what they are allowed to do to a cache.
 */
export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

/** The active model cache name, or null when no set has ever activated (W5 step 6's pointer read). */
export async function readActiveModelCache(caches: CacheStorageLike): Promise<string | null> {
  const response = await (await caches.open(ACTIVE_MODEL_CACHE)).match(ACTIVE_MODEL_POINTER_PATH);
  return response ? await response.text() : null;
}

const FIELD_SEPARATOR = String.fromCharCode(0x1f);
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * The canonical serialisation W3 pins: entries sorted by `url`, each as `url` + FIELD + `revision`, joined by
 * RECORD. A `null` revision renders as the empty string, because the revision of a content-hashed build
 * output *is* its filename (W2 reason 1). Determinism is the point: two builds that emitted the same files
 * must agree on the digest, and a build that gained one file must not.
 */
export function canonicalPrecacheSerialisation(entries: readonly PrecacheEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .map((entry) => `${entry.url}${FIELD_SEPARATOR}${entry.revision ?? ""}`)
    .join(RECORD_SEPARATOR);
}

/** First 12 hex characters of the SHA-256 of {@link canonicalPrecacheSerialisation}. */
export async function canonicalPrecacheDigest(entries: readonly PrecacheEntry[]): Promise<string> {
  return (await sha256Hex(canonicalPrecacheSerialisation(entries))).slice(0, DIGEST_CHARS);
}

/** `receipt-lens-shell-v<digest>` (W3). */
export async function shellCacheName(entries: readonly PrecacheEntry[]): Promise<string> {
  return `${SHELL_CACHE_PREFIX}${await canonicalPrecacheDigest(entries)}`;
}

/**
 * `receipt-lens-models:<providerVersion>:<manifestHash>` (§9, W3). `manifestHash` is SHA-256 of the manifest
 * bytes exactly as served — the same digest core puts in `PPOCRv6Provider.version`.
 */
export function modelCacheName(providerVersion: string, manifestHash: string): string {
  return `${MODEL_CACHE_PREFIX}${providerVersion}:${manifestHash}`;
}

/** True for a name that is a model-set cache. The pointer cache must not satisfy this (W3.1). */
export function isModelCache(name: string): boolean {
  return name.startsWith(MODEL_CACHE_PREFIX);
}

/** True for a name that is a shell cache. */
export function isShellCache(name: string): boolean {
  return name.startsWith(SHELL_CACHE_PREFIX);
}

/**
 * Superseded **shell** caches: every shell cache except the running worker's own (W7.2). The page never calls
 * this — it does not know which shell it is being served from, and guessing would mean deleting the cache the
 * live document is reading.
 */
export function supersededShellCaches(names: readonly string[], currentShell: string): string[] {
  return names.filter((name) => name !== ACTIVE_MODEL_CACHE && isShellCache(name) && name !== currentShell);
}

/**
 * Superseded **model** caches: every model set except the one just verified and promoted (W5 step 7, W7.1).
 * `active === null` means no set has ever activated, so nothing is superseded yet — an orphaned candidate from
 * a crashed attempt is the only thing a caller could legitimately want gone, and it names that one directly.
 */
export function supersededModelCaches(names: readonly string[], active: string | null): string[] {
  if (active === null) return [];
  return names.filter((name) => name !== ACTIVE_MODEL_CACHE && isModelCache(name) && name !== active);
}
