/**
 * The shell's router: framework-neutral by design (DECISIONS/0017 D7 — if the Svelte 5 ecosystem ever
 * forces the documented React 19 fallback, this module transfers unchanged).
 *
 * The rules are D3a's owner conditions, and they are load-bearing for ticket 16:
 *   - the fragment is read raw after the FIRST "#"; it is never split on later "#" characters and
 *     never URL-decoded here, because decoding a bearer payload is the codec's job, not the router's;
 *   - a fragment-bearing LANDING page is the share-link entry point, so "/" plus a fragment resolves to
 *     the share view while the fragment stays byte-for-byte intact;
 *   - any other unknown path is the not-found view, with its fragment left in the URL untouched;
 *   - building the URL for the next navigation is string concatenation, so a path change never drops or
 *     re-encodes the fragment it is carrying.
 */

export type RouteName = "capture" | "bill" | "share" | "notFound";

export interface LocationLike {
  readonly pathname: string;
  readonly hash: string;
}

/** Path each view is mounted at. "/" is an alias for capture, the app's landing view. */
export const ROUTE_PATHS: Record<Exclude<RouteName, "notFound">, string> = {
  capture: "/capture",
  bill: "/bill",
  share: "/share",
};

const PATHS: Record<string, RouteName> = {
  "/": "capture",
  "/capture": "capture",
  "/bill": "bill",
  "/share": "share",
};

/**
 * The raw fragment, exactly as it appears after the first "#" — no decoding, no further splitting.
 * A hash of "" or "#" yields ""; "#v1.a#b" yields "v1.a#b".
 */
export function fragmentOf(hash: string): string {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

/**
 * Which view a location resolves to (D3a condition 2, both of its sentences):
 *
 * - a fragment-bearing LANDING page (`/#v1.…`) is the share-link entry point, so `/` with a fragment
 *   resolves to the share view instead of capture;
 * - any other unknown path resolves to the not-found view, and the fragment is left in the URL
 *   untouched — showing not-found must not be the thing that breaks fragment preservation.
 */
export function routeFor(pathname: string, fragment: string): RouteName {
  if (pathname === "/" && fragment.length > 0) return "share";
  return PATHS[pathname] ?? "notFound";
}

/**
 * The URL a navigation to `pathname` must produce while carrying `fragment`. Concatenation, never
 * re-encoding: the byte-for-byte rule (D3a condition 3) is why this is not `new URL(...)`.
 */
export function targetUrl(pathname: string, fragment: string): string {
  return fragment.length > 0 ? `${pathname}#${fragment}` : pathname;
}

/** Resolve a whole location in one call. */
export function resolveLocation(location: LocationLike): { route: RouteName; fragment: string } {
  const fragment = fragmentOf(location.hash);
  return { route: routeFor(location.pathname, fragment), fragment };
}
