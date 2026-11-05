import { SW_SCOPE } from "./registration.js";

/**
 * Ticket 17 — the web app manifest of DECISIONS/0027 W11.
 *
 * This is a TS module rather than a hand-written `public/manifest.webmanifest` for one reason: W11 pins that
 * the manifest's `scope` must agree with the registered worker scope, and a value duplicated across two file
 * formats is a value that drifts. Here it is imported from the module that registers the worker, and the test
 * compares the two rather than trusting that both were written on the same day. The build serialises it to
 * `dist/app/manifest.webmanifest`.
 */

export interface WebAppManifest {
  readonly name: string;
  readonly short_name: string;
  readonly id: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly background_color: string;
  readonly theme_color: string;
  readonly description: string;
  readonly icons: readonly { readonly src: string; readonly sizes: string; readonly type: string; readonly purpose: string }[];
}

/** The palette `src/app.css` already uses — a manifest must not introduce a brand colour as metadata. */
export const MANIFEST_PAGE_BACKGROUND = "#fbfaf7";
export const MANIFEST_FILLED_SURFACE = "#efe9dc";
export const MANIFEST_INK = "#26221c";

/** The three icons W11 pins: 192, 512, and a maskable variant so the launcher does not crop the wordmark. */
export const MANIFEST_ICON_PATHS: readonly string[] = [
  "/icons/receipt-lens-192.png",
  "/icons/receipt-lens-512.png",
  "/icons/receipt-lens-512-maskable.png",
];

/**
 * The manifest, with W11's fields pinned: `start_url` and `scope` both `/` (matching W10), `display`
 * standalone, and a `description` that states §1's claim in the position a store listing puts in front of a
 * person — wording ticket 18 then has to defend.
 */
export function appManifest(): WebAppManifest {
  throw new Error(`not implemented: DECISIONS/0027 W11 — the web app manifest (scope must be ${SW_SCOPE})`);
}
