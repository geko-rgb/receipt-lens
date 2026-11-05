/**
 * Ticket 17 — the deterministic image the smoke inference runs on (DECISIONS/0027 W5 step 5).
 *
 * Drawn rather than committed: a stored PNG would be a binary in git that no reader can inspect, and this one
 * has exactly one job — prove the weights execute. The text is shaped like a receipt (a header, two priced
 * lines, a total) because that is what the pipeline downstream expects, but nothing asserts a *string*. The
 * bar is one line and one word; accuracy is ticket 09b's published measurement, and coupling model activation
 * to it would leave the app un-updatable whenever a receipt is hard to read.
 */

const SMOKE_CANVAS = { width: 420, height: 200 };
const SMOKE_FONT = "28px sans-serif";
const SMOKE_LINES = ["RECEIPT 1.00", "COFFEE 2.50", "TOTAL 3.50"];
const SMOKE_LAYOUT = { leftPx: 24, firstBaselinePx: 48, lineHeightPx: 56 };

/**
 * The same canvas technique `playwright/offline.spec.ts` uses for its synthetic receipt, so the smoke run and
 * the M1 offline test are looking at one kind of page rather than two. Returns null when the browser gives no
 * 2d surface, which the caller treats as a failed smoke rather than a passed one.
 */
export async function drawSmokeImage(): Promise<Blob | null> {
  const surface = document.createElement("canvas");
  surface.width = SMOKE_CANVAS.width;
  surface.height = SMOKE_CANVAS.height;
  const context = surface.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, surface.width, surface.height);
  context.fillStyle = "#000000";
  context.font = SMOKE_FONT;
  SMOKE_LINES.forEach((line, index) => {
    context.fillText(line, SMOKE_LAYOUT.leftPx, SMOKE_LAYOUT.firstBaselinePx + index * SMOKE_LAYOUT.lineHeightPx);
  });
  return new Promise((resolve, reject) => {
    surface.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("smoke canvas produced no PNG"))), "image/png");
  });
}
