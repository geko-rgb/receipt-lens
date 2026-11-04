/**
 * DECISIONS/0018 P1 — which image types the capture view accepts, and the exact `accept` attribute
 * the file input carries.
 *
 * HEIC is deliberately absent: no local decoder is bundled, and there is no upload fallback path, so
 * offering it would mean offering a format the app cannot read.
 */

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

/** The `accept` attribute for `<input type="file">`. Pinned so the input cannot drift from the rule. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(",");

/** P1: JPEG, PNG and WebP are accepted without a gate; HEIC and everything else is not. */
export function isAcceptedImageType(type: string): boolean {
  const normalised = type.split(";")[0]?.trim().toLowerCase();
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(normalised ?? "");
}

/** Human-readable refusal, used when a picked file is not one of the three. */
export function unsupportedTypeMessage(type: string): string {
  const label = type || "unknown file";
  return `${label} is not supported — use a JPEG, PNG or WebP image${/heic|heif/i.test(type) ? " (HEIC needs a local conversion first)" : ""}.`;
}
