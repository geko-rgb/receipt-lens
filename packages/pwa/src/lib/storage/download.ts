/**
 * Ticket 14 — turning an export envelope into a file (DECISIONS/0023 P4).
 *
 * The download is a `Blob` plus an `<a download>` click: no request leaves the page, and the payload never
 * enters the URL. That second half matters here — the share-link fragment is a bearer secret that ends up in
 * browser history (0017 D3a, business.md §10), so a backup that used the same channel would publish the whole
 * ledger wherever the link went. An object URL is revoked as soon as the click is issued.
 */

import type { ExportEnvelope } from "./records.js";

/**
 * P4: the file is named for the version it was written at, because that is the only meaning it has.
 *
 * The stamp is sanitized: an ISO instant contains `:`, which is illegal in a Windows file name and confusing
 * in a shell, and the export is precisely a file a user moves between devices. `exportedAt` in the envelope
 * keeps its exact ISO value — the name is a label, the field is the record.
 */
export function exportFileName(envelope: ExportEnvelope): string {
  const stamp = envelope.exportedAt.replace(/[:.]/g, "-");
  return `receipt-lens-export-v${envelope.dbVersion}-${stamp}.json`;
}

export function envelopeBlob(envelope: ExportEnvelope): Blob {
  return new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
}

/**
 * Produces the download and reports where it went. Returns the file name so the screen can repeat it back to
 * the user — P4 requires the export to say where the file is, not merely to start a download.
 */
export function downloadEnvelope(envelope: ExportEnvelope): string {
  const name = exportFileName(envelope);
  const url = URL.createObjectURL(envelopeBlob(envelope));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // One task later: the click needs the URL alive, and holding it open keeps the blob reachable to any
  // script on the page, which is what the bearer-secret rule in pwa-design §3 is about.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return name;
}
