import type { PrecacheEntry } from "../../precache.js";

/**
 * Ticket 17 — the three cache names of DECISIONS/0027 W3, and the only place a name is composed (W3.1).
 *
 * A cache name is not a string template here, it is the identity of a verified model set. §9 forbids reusing
 * one "solely because a filename or generic URL matches", and the pointer cache is the single record of which
 * set readers are served, so the cleanup predicates and the pointer's own name have to be decided together —
 * that is what `cachesToCleanup` is for, and why W3.1 makes it the only cleanup entry point.
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

/**
 * Field and record separators of the canonical precache serialisation (W3). Control characters, so no URL or
 * revision can produce a false boundary. Written as escapes rather than literals: an invisible byte in a
 * source file is exactly the thing a later reader cannot check.
 */
const FIELD_SEPARATOR = "\u001F";
const RECORD_SEPARATOR = "\u001E";

/**
 * The canonical serialisation W3 pins: entries sorted by `url`, each as `url` + FIELD + `revision` (with
 * `null` rendered as the empty string, because the revision of a content-hashed build output *is* its
 * filename), joined by RECORD. Determinism is the point — two builds that emitted the same files must agree
 * on the digest, and a build that gained one file must not.
 */
export function canonicalPrecacheSerialisation(entries: readonly PrecacheEntry[]): string {
  throw new Error("not implemented: DECISIONS/0027 W3 — canonical precache serialisation");
}

/** First 12 hex characters of the SHA-256 of {@link canonicalPrecacheSerialisation}. */
export async function canonicalPrecacheDigest(entries: readonly PrecacheEntry[]): Promise<string> {
  throw new Error("not implemented: DECISIONS/0027 W3 — shell cache digest");
}

/** `receipt-lens-shell-v<digest>` (W3). */
export async function shellCacheName(entries: readonly PrecacheEntry[]): Promise<string> {
  throw new Error("not implemented: DECISIONS/0027 W3 — shell cache name");
}

/**
 * `receipt-lens-models:<providerVersion>:<manifestHash>` (§9, W3). `manifestHash` is SHA-256 of the manifest
 * bytes exactly as served — the same value core already puts in `PPOCRv6Provider.version`.
 */
export function modelCacheName(providerVersion: string, manifestHash: string): string {
  throw new Error("not implemented: DECISIONS/0027 W3 — model cache name");
}

/** True for a name that is a model-set cache. The pointer cache must not satisfy this (W3.1). */
export function isModelCache(name: string): boolean {
  throw new Error("not implemented: DECISIONS/0027 W3.1 — model cache predicate");
}

/** True for a name that is a shell cache. */
export function isShellCache(name: string): boolean {
  throw new Error("not implemented: DECISIONS/0027 W3.1 — shell cache predicate");
}

export interface CleanupKeep {
  /** The shell cache the running worker precached. Anything else matching {@link SHELL_CACHE_PREFIX} goes. */
  readonly shell: string;
  /** The active model set, or null when none has ever activated. */
  readonly model: string | null;
}

/**
 * Which caches may be deleted (W3.1, W5 step 7, W7.1). Two rules that must not be merged into one sweep:
 * the superseded *active* model set only after a verified activation moved the pointer, and a *failed
 * candidate* immediately. This function is the only place that decides, so a call site cannot get the order
 * wrong by inventing its own predicate.
 */
export function cachesToCleanup(names: readonly string[], keep: CleanupKeep): string[] {
  throw new Error("not implemented: DECISIONS/0027 W3.1 — cleanup selection");
}
