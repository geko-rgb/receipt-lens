/**
 * Ticket 17 — the worker's read path of DECISIONS/0027 W4, as a pure decision.
 *
 * `src/sw.ts` is then a thin adapter: it reads a `FetchEvent`, calls this, and performs the action. Keeping
 * the branching out of the worker is what lets W4/W4.1/W6/W2.2 be pinned in a Node test instead of racing a
 * real install-activate-waiting-for-controller cycle — W13 names that race as the likeliest place for this
 * ticket to lose its time, so the logic does not live there.
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
  /** True for a URL under the model-assets path the app serves from the repository (`/assets/models/`). */
  readonly isModelAsset: (url: string) => boolean;
}

/**
 * Decide how to answer one request (W4). The order matters and is the pin: cross-origin and non-GET pass
 * through untouched, a model request in `reload` cache mode goes to the network without writing (W6 —
 * otherwise the probe is answered from the cache it is checking and the update path never runs), a model
 * request is served from the active set or passed through (never from the shell, and never HTML), and only a
 * navigation may fall back to the cached document (W4.1 — serving `index.html` for a manifest would read as a
 * corrupt manifest rather than as a cache miss).
 */
export async function decideServing(request: ServedRequest, state: ServingState): Promise<ServingAction> {
  throw new Error(`not implemented: DECISIONS/0027 W4 — worker serving decision (${request.url})`);
}
