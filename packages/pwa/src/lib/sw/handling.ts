import { SHELL_NAVIGATION_FALLBACK } from "../models/cache-names.js";

/**
 * Ticket 17 — the worker's read path of DECISIONS/0027 W4, as a pure decision.
 *
 * `src/sw.ts` is then a thin adapter: it reads a `FetchEvent`, resolves the pointer and the cache hits, calls
 * this, and performs the action. Keeping the branching out of the worker is what lets W4/W4.1/W6/W2.2 be
 * pinned in a Node test instead of racing a real install-activate-waiting-for-controller cycle — and W13 item
 * 3 says that race is separately pinned *in a browser*, because a mocked test of a race tests the mock.
 */

/** The subset of a `Request` the decision needs. */
export interface ServedRequest {
  readonly url: string;
  readonly method: string;
  /** `Request.mode` — `"navigate"` is the only mode the HTML fallback may answer (W4.1). */
  readonly mode: string;
  /** `Request.cache` — `"reload"` is W6's probe bypass. */
  readonly cache: string;
}

/** What the worker should do, as data. */
export type ServingAction =
  | { readonly kind: "serve-shell"; readonly url: string }
  /** A deep link the shell has no file for: answer with the cached document. Navigations only (W4.1). */
  | { readonly kind: "serve-shell-navigation-fallback"; readonly url: string }
  | { readonly kind: "serve-model"; readonly cacheName: string; readonly url: string }
  | {
      readonly kind: "network";
      /** W2.2: the worker never writes. Every cache write in this design is an explicit `put` by W4's protocol. */
      readonly write: false;
      readonly reason: "cross-origin" | "non-get" | "probe-bypass" | "no-cache-entry" | "no-active-model-set";
    };

export interface ServingState {
  readonly sameOrigin: boolean;
  /** The shell cache the running worker precached. */
  readonly shellCache: string;
  /** The pointer's value, or null when no model set has ever activated. */
  readonly activeModelCache: string | null;
  readonly shellHas: (url: string) => Promise<boolean>;
  readonly modelHas: (cacheName: string, url: string) => Promise<boolean>;
  /** True for a URL under the model-assets path served from the repository (`/assets/models/`). */
  readonly isModelAsset: (url: string) => boolean;
}

const passthrough = (reason: "cross-origin" | "non-get" | "probe-bypass" | "no-cache-entry" | "no-active-model-set"): ServingAction => ({
  kind: "network",
  write: false,
  reason,
});

/**
 * Decide how to answer one request (W4). The order is the pin, because each early return prevents a different
 * failure: cross-origin and non-GET pass through untouched, so the worker is not a proxy for anything the app
 * did not ask for; a model request in `reload` cache mode goes to the network without writing (W6 — otherwise
 * the probe is answered from the cache it is checking, the update path never runs, and the suite stays green
 * while the feature is dead); a model request is served from the active set or passed through, never from the
 * shell and never as HTML; and only a navigation may fall back to the cached document, because serving
 * `index.html` for `/assets/models/manifest.json` would read as a corrupt manifest rather than as a miss
 * (W4.1).
 */
export async function decideServing(request: ServedRequest, state: ServingState): Promise<ServingAction> {
  if (!state.sameOrigin) return passthrough("cross-origin");
  if (request.method !== "GET") return passthrough("non-get");

  const url = new URL(request.url).pathname;

  if (state.isModelAsset(url)) {
    if (request.cache === "reload") return passthrough("probe-bypass");
    if (state.activeModelCache === null) return passthrough("no-active-model-set");
    if (await state.modelHas(state.activeModelCache, url)) return { kind: "serve-model", cacheName: state.activeModelCache, url };
    return passthrough("no-cache-entry");
  }

  if (await state.shellHas(url)) return { kind: "serve-shell", url };
  if (request.mode === "navigate") return { kind: "serve-shell-navigation-fallback", url: SHELL_NAVIGATION_FALLBACK };
  return passthrough("no-cache-entry");
}
