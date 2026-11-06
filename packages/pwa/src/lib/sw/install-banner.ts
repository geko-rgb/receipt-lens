/**
 * Ticket 17 — the install banner of DECISIONS/0027 W12.
 *
 * **What this module can and cannot prove.** Measured before the pins were written: headless Chromium fires no
 * `beforeinstallprompt` at all — valid manifest, installed and controlling worker with a `fetch` handler,
 * secure loopback origin, 20 s poll, online and after an offline reload — and has no
 * `navigator.getInstalledRelatedProducts`. So the browser's half of "is it installable" is a declared manual
 * check (W12, W20), and everything below is the app's half: given the event, does the banner appear, dismiss,
 * stay suppressed, and expire. The e2e drives a fabricated event to test exactly that.
 *
 * Safari and Firefox never fire the event either, and there is then no banner and no "add to home screen"
 * instructions — the alternative is claiming to support an install path this build cannot detect.
 */

/**
 * The only `localStorage` key the app may ever hold (W12.1). §10's IndexedDB stores are the versioned bill
 * ledger, and a shell preference that participates in a schema migration would make an app update a data
 * migration; this holds no bill data, no name, no amount, no fragment and no image. The single-key rule is
 * asserted by `scripts/check-local-storage.mjs`, because a preference surface that grows quietly is how a
 * bearer secret ends up in `localStorage`.
 */
export const INSTALL_BANNER_STORAGE_KEY = "receipt-lens:install-banner-dismissed-at";

/** W12.1's N, ruled from the brief: a dismissal suppresses the banner for seven days, not forever. */
export const INSTALL_BANNER_SUPPRESS_DAYS = 7;

export const INSTALL_BANNER_MS = 24 * 60 * 60 * 1000;

/** Pinned copy (W12.1). */
export function installBannerCopy(): { readonly headline: string; readonly install: string; readonly dismiss: string } {
  return {
    headline: "Install receipt-lens for offline use",
    install: "Install",
    dismiss: "Not now",
  };
}

export interface BannerInput {
  /** The browser offered an install. False in Safari and Firefox, and in this project's headless Chromium. */
  readonly eventSeen: boolean;
  /** Value of {@link INSTALL_BANNER_STORAGE_KEY}, parsed to a millisecond epoch, or null. */
  readonly dismissedAt: number | null;
  /** Caller-supplied clock (DECISIONS/0011's determinism rule). */
  readonly now: number;
  /** Already installed as an application window — offering install there is noise. */
  readonly displayMode: "browser" | "standalone";
}

/**
 * True exactly when the banner should render. The boundary is inclusive on the way out: a dismissal from
 * exactly seven days ago is still suppressed, one millisecond older is not.
 */
export function shouldShowInstallBanner(input: BannerInput): boolean {
  if (!input.eventSeen || input.displayMode !== "browser") return false;
  if (input.dismissedAt === null) return true;
  return input.now - input.dismissedAt > INSTALL_BANNER_SUPPRESS_DAYS * INSTALL_BANNER_MS;
}

export interface BannerStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Record a dismissal at `now`, so W12.1's window counts from the click rather than from the event. */
export function dismissInstallBanner(storage: BannerStorage, now: number): void {
  storage.set(INSTALL_BANNER_STORAGE_KEY, String(now));
}

/** Called once the user has answered the browser's prompt: the offer is spent, and the suppression is moot. */
export function consumeInstallPrompt(storage: BannerStorage): void {
  storage.remove(INSTALL_BANNER_STORAGE_KEY);
}
