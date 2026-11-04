import { describe, expect, it, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * DECISIONS/0018 P1–P6 — the pins, as assertions.
 *
 * The record is pins only and defers its numbers to this file, so these tests are the source of truth
 * for: the accepted formats (P1), the 90° rotation and its non-clipping geometry (P2), the crop being
 * a real source rectangle (P3), the 3° deskew gate (P4), the ±20% HSV value stretch (P5), and Canvas
 * 2D rather than OffscreenCanvas (P6).
 *
 * Written before the implementation, deliberately: against the stub in `src/lib/capture/` every
 * function that carries a rule throws, so this file fails until the rule exists.
 */

import {
  ACCEPTED_IMAGE_TYPES,
  ACCEPT_ATTRIBUTE,
  isAcceptedImageType,
  unsupportedTypeMessage,
} from "../../src/lib/capture/formats.js";
import {
  DESKEW_THRESHOLD_DEGREES,
  decideDeskew,
  estimateSkew,
} from "../../src/lib/capture/deskew.js";
import {
  CONTRAST_LIMIT_PERCENT,
  clampContrastPercent,
  stretchValue,
  applyContrastToPixels,
  rgbToHsv,
  hsvToRgb,
} from "../../src/lib/capture/contrast.js";
import {
  applyTransformations,
  browserEnvironment,
  effectiveSourceRect,
  rotatedDimensions,
  type Surface,
  type TransformEnvironment,
} from "../../src/lib/capture/transform.js";

const captureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/lib/capture");

const SOURCE_BLOB = (): Blob => new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" });

/** White page with evenly spaced dark lines at `angleDegrees` (null = blank page). */
function inkPixels(
  width: number,
  height: number,
  angleDegrees: number | null,
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  if (angleDegrees === null) return { data, width, height };

  const slope = Math.tan((angleDegrees * Math.PI) / 180);
  for (let baseline = 8; baseline < height - 6; baseline += 14) {
    for (let x = 2; x < width - 2; x += 1) {
      const y = Math.round(baseline + x * slope);
      if (y < 0 || y >= height) continue;
      const i = (y * width + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

interface RecordingSurface extends Surface {
  readonly drawn: number[][];
  readonly pixels: Uint8ClampedArray;
}

/** A surface that records geometry and holds a real pixel buffer, so contrast is observable. */
function recordingEnvironment(
  width: number,
  height: number,
  fill: readonly [number, number, number, number] = [200, 100, 50, 255],
): { env: TransformEnvironment; surfaces: RecordingSurface[] } {
  const surfaces: RecordingSurface[] = [];
  const env: TransformEnvironment = {
    async decode(source) {
      return { image: source, width, height, close: () => {} };
    },
    createSurface(w, h) {
      const pixels = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i += 1) pixels.set(fill, i * 4);
      const drawn: number[][] = [];
      const surface: RecordingSurface = {
        width: w,
        height: h,
        drawn,
        pixels,
        context: {
          drawImage(_image, sx, sy, sw, sh, dx, dy, dw, dh) {
            drawn.push([sx, sy, sw, sh, dx, dy, dw, dh]);
          },
          translate() {},
          rotate() {},
          getImageData(_sx, _sy, sw, sh) {
            return { data: pixels, width: sw, height: sh };
          },
          putImageData(data) {
            pixels.set(data.data);
          },
        },
      };
      surfaces.push(surface);
      return surface;
    },
    async encode() {
      return new Blob([new Uint8Array([1])], { type: "image/jpeg" });
    },
  };
  return { env, surfaces };
}

// ---------------------------------------------------------------------------------------------
// P1 — accepted formats
// ---------------------------------------------------------------------------------------------

describe("P1 — only JPEG, PNG and WebP are accepted without a gate", () => {
  it("accepts exactly those three, case- and parameter-insensitively", () => {
    expect(isAcceptedImageType("image/jpeg")).toBe(true);
    expect(isAcceptedImageType("image/png")).toBe(true);
    expect(isAcceptedImageType("image/webp")).toBe(true);
    expect(isAcceptedImageType("IMAGE/JPEG")).toBe(true);
    expect(isAcceptedImageType("image/jpeg; charset=binary")).toBe(true);
  });

  it("refuses HEIC and anything else — there is no upload fallback", () => {
    expect(isAcceptedImageType("image/heic")).toBe(false);
    expect(isAcceptedImageType("image/heif")).toBe(false);
    expect(isAcceptedImageType("image/gif")).toBe(false);
    expect(isAcceptedImageType("application/pdf")).toBe(false);
    expect(isAcceptedImageType("")).toBe(false);
  });

  it("pins the input's accept attribute to the same three, with HEIC absent", () => {
    expect(ACCEPT_ATTRIBUTE).toBe("image/jpeg,image/png,image/webp");
    expect(ACCEPTED_IMAGE_TYPES).toHaveLength(3);
    expect(ACCEPT_ATTRIBUTE).not.toMatch(/heic|heif/i);
  });

  it("says what to do about a HEIC file rather than just refusing", () => {
    expect(unsupportedTypeMessage("image/heic")).toContain("HEIC");
    expect(unsupportedTypeMessage("image/gif")).toContain("JPEG, PNG or WebP");
  });
});

// ---------------------------------------------------------------------------------------------
// P2 — 90° rotation, full extent preserved
// ---------------------------------------------------------------------------------------------

describe("P2 — rotation is 90° steps and never clips", () => {
  it("swaps the axes at 90° and 270°, keeps them at 180° and 0°", () => {
    expect(rotatedDimensions(40, 20, 0)).toEqual({ width: 40, height: 20 });
    expect(rotatedDimensions(40, 20, 90)).toEqual({ width: 20, height: 40 });
    expect(rotatedDimensions(40, 20, 180)).toEqual({ width: 40, height: 20 });
    expect(rotatedDimensions(40, 20, 270)).toEqual({ width: 20, height: 40 });
  });

  it("sizes the output canvas from the image, not from a layout dimension", async () => {
    for (const degrees of [0, 90, 180, 270]) {
      const { env, surfaces } = recordingEnvironment(40, 272);
      const result = await applyTransformations(
        SOURCE_BLOB(),
        { rotationDegrees: degrees, crop: null, contrastPercent: 0 },
        env,
      );
      const expected = rotatedDimensions(40, 272, degrees);
      expect(result.width).toBe(expected.width);
      expect(result.height).toBe(expected.height);
      expect(surfaces[0]?.width).toBe(expected.width);
      expect(surfaces[0]?.height).toBe(expected.height);
    }
  });

  it("draws the whole source at full extent in every rotation", async () => {
    for (const degrees of [90, 180, 270]) {
      const { env, surfaces } = recordingEnvironment(40, 20);
      const result = await applyTransformations(
        SOURCE_BLOB(),
        { rotationDegrees: degrees, crop: null, contrastPercent: 0 },
        env,
      );
      const [sx, sy, sw, sh, , , dw, dh] = surfaces[0]!.drawn[0]!;
      expect([sx, sy, sw, sh]).toEqual([0, 0, 40, 20]);
      // The rotation is on the context, so drawImage's destination is the source's own extent while
      // the surface is the swapped one — the pair is what makes "never clips" true.
      expect([dw, dh]).toEqual([40, 20]);
      expect([surfaces[0]!.width, surfaces[0]!.height]).toEqual([result.width, result.height]);
      expect(result.sourceRect).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// P3 — crop is the source rectangle, so OCR really receives the cropped region
// ---------------------------------------------------------------------------------------------

describe("P3 — the crop changes the effective OCR input", () => {
  it("defaults to the full image when there is no crop", () => {
    expect(effectiveSourceRect(40, 20, null)).toEqual({ x: 0, y: 0, width: 40, height: 20 });
  });

  it("clamps a crop to the image instead of trusting the UI", () => {
    expect(effectiveSourceRect(40, 20, { x: -5, y: -3, width: 20, height: 10 })).toEqual({
      x: 0,
      y: 0,
      width: 15,
      height: 7,
    });
    expect(effectiveSourceRect(40, 20, { x: 30, y: 15, width: 100, height: 100 })).toEqual({
      x: 30,
      y: 15,
      width: 10,
      height: 5,
    });
  });

  it("feeds the cropped rectangle to drawImage and returns its dimensions", async () => {
    const { env, surfaces } = recordingEnvironment(40, 20);
    const result = await applyTransformations(
      SOURCE_BLOB(),
      { rotationDegrees: 0, crop: { x: 5, y: 4, width: 30, height: 10 }, contrastPercent: 0 },
      env,
    );

    expect(result.width).toBe(30);
    expect(result.height).toBe(10);
    expect(result.sourceRect).toEqual({ x: 5, y: 4, width: 30, height: 10 });
    expect(surfaces[0]!.drawn[0]!.slice(0, 4)).toEqual([5, 4, 30, 10]);
  });

  it("applies crop and rotation together", async () => {
    const { env } = recordingEnvironment(40, 20);
    const result = await applyTransformations(
      SOURCE_BLOB(),
      { rotationDegrees: 90, crop: { x: 5, y: 4, width: 30, height: 10 }, contrastPercent: 0 },
      env,
    );
    expect(result.width).toBe(10);
    expect(result.height).toBe(30);
  });
});

// ---------------------------------------------------------------------------------------------
// P4 — the 3° deskew gate
// ---------------------------------------------------------------------------------------------

describe("P4 — deskew applies at 3° and is refused below it", () => {
  it("pins the threshold at 3°", () => {
    expect(DESKEW_THRESHOLD_DEGREES).toBe(3);
  });

  it("applies at exactly 3° and above, in both directions", () => {
    expect(decideDeskew({ degrees: 3, reliable: true })).toEqual({ applied: true, degrees: 3 });
    expect(decideDeskew({ degrees: -3, reliable: true })).toEqual({ applied: true, degrees: -3 });
    expect(decideDeskew({ degrees: 7.5, reliable: true })).toEqual({ applied: true, degrees: 7.5 });
    expect(decideDeskew({ degrees: -12, reliable: true })).toMatchObject({ applied: true });
  });

  it("refuses below 3° instead of nudging the image", () => {
    expect(decideDeskew({ degrees: 2.9, reliable: true })).toMatchObject({
      applied: false,
      reason: "below-threshold",
    });
    expect(decideDeskew({ degrees: -2.99, reliable: true })).toMatchObject({
      applied: false,
      reason: "below-threshold",
    });
    expect(decideDeskew({ degrees: 0, reliable: true })).toMatchObject({
      applied: false,
      reason: "below-threshold",
    });
  });

  it("treats a missing or distrusted estimate as skipped, not as zero degrees", () => {
    expect(decideDeskew(null)).toMatchObject({ applied: false, reason: "not-estimable" });
    expect(decideDeskew({ degrees: 9, reliable: false })).toMatchObject({
      applied: false,
      reason: "unreliable",
    });
  });

  // ---- the estimator itself: this is where the estimate in the tests above comes from ----

  it("estimates flat text as ~0°", () => {
    const estimate = estimateSkew(inkPixels(140, 100, 0));
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate!)).toBeLessThan(1);
  });

  it("estimates a real skew and reports the correction direction", () => {
    const descends = estimateSkew(inkPixels(140, 100, 5));
    expect(descends).not.toBeNull();
    expect(Math.abs(descends!)).toBeGreaterThanOrEqual(3);
    expect(Math.abs(descends!)).toBeLessThan(8);
    // A +5° skew is straightened by a negative correction.
    expect(descends!).toBeLessThan(0);

    const rises = estimateSkew(inkPixels(140, 100, -4.5));
    expect(rises).not.toBeNull();
    expect(Math.abs(rises!)).toBeGreaterThanOrEqual(3);
    expect(rises!).toBeGreaterThan(0);
  });

  it("feeds decideDeskew so a real skew is corrected, not skipped", () => {
    const estimate = estimateSkew(inkPixels(140, 100, 4));
    expect(estimate).not.toBeNull();
    expect(decideDeskew({ degrees: estimate!, reliable: true }).applied).toBe(true);
  });

  it("returns null when there is no ink to estimate from", () => {
    expect(estimateSkew(inkPixels(140, 100, null))).toBeNull();
    expect(estimateSkew(inkPixels(4, 4, 0))).toBeNull();
  });

  it("never deskews noise: no reliable baseline, so no transform", () => {
    const width = 140;
    const height = 100;
    const pixels = inkPixels(width, height, null);
    let seed = 12345;
    for (let y = 2; y < height - 2; y += 1) {
      for (let x = 2; x < width - 2; x += 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        if (seed / 2147483648 > 0.05) continue;
        const i = (y * width + x) * 4;
        pixels.data[i] = 0;
        pixels.data[i + 1] = 0;
        pixels.data[i + 2] = 0;
      }
    }

    // Scattered ink either has no dominant direction (null) or collapses flat at ~0°; either way it
    // must land under the threshold rather than shear the page on a guess.
    const estimate = estimateSkew(pixels);
    if (estimate !== null) expect(Math.abs(estimate)).toBeLessThan(DESKEW_THRESHOLD_DEGREES);
    expect(decideDeskew(estimate === null ? null : { degrees: estimate, reliable: true }).applied).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// P5 — contrast is a ±20% HSV value stretch, not grayscale
// ---------------------------------------------------------------------------------------------

describe("P5 — contrast stays inside ±20% and moves only the value channel", () => {
  it("pins the range at ±20 and clamps to it", () => {
    expect(CONTRAST_LIMIT_PERCENT).toBe(20);
    expect(clampContrastPercent(0)).toBe(0);
    expect(clampContrastPercent(35)).toBe(20);
    expect(clampContrastPercent(-80)).toBe(-20);
  });

  it("stretches the value and clamps at the byte ceiling", () => {
    expect(stretchValue(100, 0.2)).toBe(120);
    expect(stretchValue(100, -0.2)).toBe(80);
    expect(stretchValue(100, 0)).toBe(100);
    expect(stretchValue(240, 0.2)).toBe(255);
    expect(stretchValue(10, -0.2)).toBe(8);
  });

  it("round-trips HSV without losing the hue", () => {
    const [h, s, v] = rgbToHsv(200, 100, 50);
    expect(v).toBeCloseTo(200 / 255, 5);
    expect(s).toBeCloseTo(0.75, 5);
    expect(h).toBeCloseTo(20, 5);
    expect(hsvToRgb(h, s, v)).toEqual([200, 100, 50]);
  });

  it("keeps a pixel coloured — this is not an RGB grayscale", () => {
    const pixels = new Uint8ClampedArray([200, 100, 50, 255]);
    applyContrastToPixels(pixels, 20);

    const [r, g, b, a] = [...pixels];
    expect(a).toBe(255);
    expect(r).not.toBe(g);
    expect(g).not.toBe(b);
    // V 200 * 1.2 = 240, S and H held → (240, 120, 60) within rounding.
    expect(r).toBeCloseTo(240, 0);
    expect(g).toBeCloseTo(120, 0);
    expect(b).toBeCloseTo(60, 0);
    expect(rgbToHsv(r!, g!, b!)[0]).toBeCloseTo(20, 0);
  });

  it("darkens symmetrically and leaves 0% untouched", () => {
    const dark = new Uint8ClampedArray([200, 100, 50, 255]);
    applyContrastToPixels(dark, -20);
    expect([...dark].slice(0, 3)).toEqual([160, 80, 40]);

    const same = new Uint8ClampedArray([200, 100, 50, 255]);
    applyContrastToPixels(same, 0);
    expect([...same]).toEqual([200, 100, 50, 255]);
  });

  it("is applied by the pipeline to the drawn surface", async () => {
    const { env, surfaces } = recordingEnvironment(4, 4, [200, 100, 50, 255]);
    const result = await applyTransformations(
      SOURCE_BLOB(),
      { rotationDegrees: 0, crop: null, contrastPercent: 20 },
      env,
    );
    expect(result.contrastPercent).toBe(20);
    const pixels = surfaces[0]!.pixels;
    expect(pixels[0]).toBeGreaterThan(200);
    expect(pixels[1]).not.toBe(pixels[2]);
  });
});

// ---------------------------------------------------------------------------------------------
// P6 — Canvas 2D on the main thread, no OffscreenCanvas
// ---------------------------------------------------------------------------------------------

describe("P6 — Canvas 2D, not OffscreenCanvas", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadDocument = "document" in globals;
  const hadOffscreen = "OffscreenCanvas" in globals;

  afterEach(() => {
    if (!hadDocument) delete globals.document;
    if (!hadOffscreen) delete globals.OffscreenCanvas;
  });

  it("names no OffscreenCanvas in the capture modules", () => {
    const files = readdirSync(captureDir).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      // Comments are stripped: transform.ts *says* "never OffscreenCanvas" in prose, and a prose
      // mention must not be mistaken for usage.
      const code = readFileSync(path.join(captureDir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, `${file} uses OffscreenCanvas`).not.toContain("OffscreenCanvas");
    }
  });

  it("builds its surface with document.createElement('canvas') and getContext('2d')", () => {
    const tags: string[] = [];
    const contexts: string[] = [];
    let offscreenConstructed = false;

    globals.document = {
      createElement(tag: string) {
        tags.push(tag);
        return {
          width: 0,
          height: 0,
          getContext(id: string) {
            contexts.push(id);
            return {};
          },
        };
      },
    };
    globals.OffscreenCanvas = class {
      constructor() {
        offscreenConstructed = true;
      }
    };

    const surface = browserEnvironment().createSurface(8, 6);
    expect(tags).toEqual(["canvas"]);
    expect(contexts).toEqual(["2d"]);
    expect(offscreenConstructed).toBe(false);
    expect([surface.width, surface.height]).toEqual([8, 6]);
  });
});
