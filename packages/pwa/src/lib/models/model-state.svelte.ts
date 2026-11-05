import { prepareModelsForBrowser } from "./prepare.js";
import { shouldPrepareModelSet, type CaptureRoute, type PreparationPhase } from "./trigger.js";
import { modelPreparingCopy, modelUpdateCopy, type ModelUpdateState } from "./update.js";

/**
 * Ticket 15-style reactive slot for the model cache (DECISIONS/0027 W7.3) — the only place model state becomes
 * `$state`, in the same shape `storage-state.svelte.ts` and `bill-document.svelte.ts` established: the rules
 * live in framework-free modules and stay testable without a component tree, and this file only routes
 * outcomes to screens and screens' events back to the rules.
 *
 * The trigger is W2.1 as ruled: navigation to `/capture`, not boot and not the capture call. Every other route
 * is inert here, which is what keeps a `/share` recipient from spending 6.3 MB on weights they will never run.
 */

let state: ModelUpdateState = $state.raw({ status: "idle" });
let phase: PreparationPhase = "idle";
let banner: { headline: string; install: string; dismiss: string } | null = $state.raw(null);

export function modelState(): ModelUpdateState {
  return state;
}

export function modelPhase(): PreparationPhase {
  return phase;
}

/**
 * Called on every route change with the resolved route name. A preparation already in flight is never
 * restarted, and a failed one is retryable (W2.1) — so returning from `/bill` to `/capture` after a drop on a
 * train can pick the download up rather than sitting on the failure.
 */
export function onRouteChange(route: CaptureRoute): void {
  if (!shouldPrepareModelSet({ route, phase })) return;
  // W2.1 defers the preparation past first paint, and does it through an idle callback rather than a frame so
  // the boundary is the `load` event and not a race. `shell.spec.ts`'s first-paint walk closes its request
  // snapshot at `load`; anything that could fetch the OCR runtime has to start strictly after that, or the
  // D4 claim ("the shell never forces the runtime on first paint") becomes a timing accident.
  deferToIdle(runPreparation);
}

function deferToIdle(work: () => void): void {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  if (typeof idle === "function") idle(work, { timeout: 2_000 });
  else setTimeout(work, 0);
}

function runPreparation(): void {
  if (phase !== "idle" && phase !== "failed") return;
  const startedAt = Date.now();
  phase = "in-flight";
  state = { status: "probing", startedAt };
  void prepareModelsForBrowser((bytesDownloaded, totalBytes) => {
    state = { status: "preparing", startedAt, bytesDownloaded, totalBytes };
  })
    .then((next) => {
      state = next;
      phase = next.status === "up-to-date" ? "succeeded" : "failed";
    })
    .catch((error: unknown) => {
      // W5's contract is that every failure is a state, never a throw. Reaching here means the protocol
      // itself broke, so the honest report is the same one a dead probe gets — and the previous set, if any,
      // is still what the reader would serve.
      console.warn("model preparation threw", error);
      state = { status: "unavailable", reason: "probe_unreachable", attemptedAt: Date.now() };
      phase = "failed";
    });
}

/** The line the capture view shows. `up-to-date` and `idle` render nothing (W7.3). */
export function modelStatusCopy(): string | null {
  switch (state.status) {
    case "preparing":
      return modelPreparingCopy(state.bytesDownloaded, state.totalBytes);
    case "pending":
      return modelUpdateCopy("pending");
    case "unavailable":
      return modelUpdateCopy("unavailable");
    default:
      return null;
  }
}

export function modelStatusId(): string {
  return state.status;
}

/** Install banner state (W12). The browser half is not automatable — see `installBannerCopy` in the record. */
export function setInstallBanner(value: { headline: string; install: string; dismiss: string } | null): void {
  banner = value;
}

export function installBannerState(): { headline: string; install: string; dismiss: string } | null {
  return banner;
}
