/**
 * Ticket 17 — registration of DECISIONS/0027 W10, owned by application code.
 *
 * `docs/pwa-design.md` §2.2 asked for `injectRegister: null` so "ticket 17 owns registration so it can be
 * tested", and this is that owner: an importable function rather than a generated snippet.
 *
 * W10's rule is the one that keeps this ticket from becoming a load-bearing dependency of every other flow:
 * **a registration failure is an ordinary start.** It happens three real ways — `serviceWorkers: "block"` in
 * a Playwright context (W19's default, and `offline.spec.ts` already does it), a script the origin's catch-all
 * returns as `text/html`, and a user who disabled workers — and none of them may break a route, a view, the
 * OCR path or persistence.
 */

export const SW_SCRIPT_URL = "/sw.js";

/** The default scope, which a root-registered worker gets without asking (W10). */
export const SW_SCOPE = "/";

export interface RegistrationOutcome {
  readonly registered: boolean;
  readonly scope: string | null;
  /** Recorded, never surfaced. Nothing in the product reads this to decide what the user can do. */
  readonly error: string | null;
}

export interface RegistrationDeps {
  /** Called with the script URL and scope; resolves the registration, or rejects on a blocked/disabled worker. */
  readonly register: (url: string, options: { scope: string }) => Promise<{ scope: string }>;
}

/**
 * Register the worker at `/sw.js` with scope `/`. Never throws and never returns an error state the UI can
 * turn into a message: the outcome is recorded and the app continues as though there were no worker, because
 * there may well be one.
 */
export async function registerServiceWorker(deps: RegistrationDeps): Promise<RegistrationOutcome> {
  try {
    const registration = await deps.register(SW_SCRIPT_URL, { scope: SW_SCOPE });
    // A resolution with no scope is not a control claim: Chromium's `serviceWorkers: "block"` resolves the
    // registration rather than rejecting it, so `scope` is the observable that says a worker is really there.
    const scope = registration?.scope ?? null;
    if (scope === null) return { registered: false, scope: null, error: "registration resolved without a scope" };
    return { registered: true, scope, error: null };
  } catch (error) {
    return { registered: false, scope: null, error: error instanceof Error ? error.message : String(error) };
  }
}
