#!/usr/bin/env node
/**
 * Investigation — does preprocessing help the two real photographs? (DECISIONS/0018 amendment work)
 *
 * Read-only with respect to the product: it drives the built harness page in headless Chromium, applies one
 * candidate image transformation at a time in a canvas **on the same origin** (nothing leaves the browser), runs
 * the shipped `PP-OCRv6 Tiny` provider through `harness/dist/batch.html`, and grades the result two ways:
 *
 *   1. token level, against a ground-truth file (`benchmarks/ocr-preprocess-ground-truth.json`) whose tokens carry
 *      a provenance note each — `printed` (legible on the photograph), `obscured` (partly cut off / faint, so a
 *      variant that invents characters is not rewarded) or `illegible` (the human cannot read it either; a variant
 *      may produce anything and nothing is scored);
 *   2. the **regression gate**: the shipped `parse()` runs over each OCR result in Node, and the parsed fields
 *      (item names, quantities, rates, line totals, grand total) must equal the baseline's, exactly. A variant that
 *      reads a nicer `Coffee` but moves ₹474.00 or drops an item fails.
 *
 * Usage:
 *   node benchmarks/scripts/bench-ocr-preprocess.mjs [--only name,name] [--repeat 1]
 *
 * OCR *settings* variants are driven by writing a manifest with only `detection.preprocessing`/`postprocessing`
 * (or `recognition.preprocessing`) overridden under `assets/models/variants-tmp/`: the asset `url`s stay absolute
 * and unchanged, so every upstream SHA-256 still verifies and the weight files are the shipped ones.
 * `recognition.preprocessing.height` is deliberately absent from the override list — the exported graph's input
 * shape is `[N, 3, 48, W]`, so a different height is a different model, not a setting (DECISIONS/0015 governs
 * that, and it is out of scope here).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { parse } from "@receipt-lens/core";
import { startServer } from "../../harness/serve.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const outDir = path.join(repoRoot, "harness", "out", "preproc");
const variantsRoot = path.join(repoRoot, "assets", "models", "variants-tmp");
const manifestPath = path.join(repoRoot, "assets", "models", "manifest.json");
const gtPath = path.join(repoRoot, "benchmarks", "ocr-preprocess-ground-truth.json");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const only = flag("only", "");
const repeat = Number(flag("repeat", "1"));
/**
 * `--write` records the measurement as a committed artifact (`benchmarks/results/ocr-preprocess.json`), and
 * `--check` re-runs it and fails if the file disagrees. Counts and outcomes only, never receipt text — the same
 * discipline `parser-only-*.json` follows (DECISIONS/0014 M6.3), so the number in `DECISIONS/0018`'s amendment is
 * reproducible from the repository rather than from a session log.
 */
if ((argv.includes("--write") || argv.includes("--check")) && only !== "") {
  throw new Error("--write/--check measure the whole variant set; drop --only so the artifact describes every candidate");
}
const writeArtifact = argv.includes("--write");
const checkArtifact = argv.includes("--check");
const artifactPath = path.join(repoRoot, "benchmarks", "results", "ocr-preprocess.json");

const IMAGES = {
  saravana: "WhatsApp Image 2026-11-06 at 22.48.34.jpeg",
  pineapple: "WhatsApp Image 2026-11-06 at 22.48.35(1).jpeg",
};

// ── variants ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Image transforms, run in the page's own canvas. `spec` is serialised to the page; the code string is the body of
 * a function `(src: ImageBitmap, ctx: CanvasRenderingContext2D, w: number, h: number) => void` that has already
 * been given a canvas of the target size, unless `canvas` says otherwise.
 */
const IMAGE_VARIANTS = [
  {
    name: "baseline",
    note: "the shipped pipeline: source → canvas → JPEG 0.95, no pixel change (DECISIONS/0018 P2/P3/P5 at default 0%)",
    kind: "jpeg",
  },
  { name: "png", note: "the same pixels, lossless PNG instead of JPEG 0.95", kind: "png" },
  {
    name: "gray-contrast-30",
    note: "grayscale, then a ±20%-legal linear value stretch at the top of P5's range (factor 1.2)",
    kind: "jpeg",
    pixels: "grayContrast",
  },
  {
    name: "autocontrast",
    note: "percentile autocontrast (p2..p98) on the value channel only — a stronger P5-style stretch, measured to see whether the pin is costing anything",
    kind: "jpeg",
    pixels: "autocontrast",
  },
  {
    name: "otsu",
    note: "global Otsu binarization (the classic receipt-threshold recipe)",
    kind: "jpeg",
    pixels: "otsu",
  },
  {
    name: "adaptive-15",
    note: "local-mean adaptive threshold, 15px window, C=10",
    kind: "jpeg",
    pixels: "adaptive15",
  },
  {
    name: "unsharp",
    note: "unsharp mask (blur radius 1, amount 0.8) — thermal print edges",
    kind: "jpeg",
    pixels: "unsharp",
  },
  { name: "upscale-2", note: "2× bicubic upscale, no other change", kind: "jpeg", scale: 2 },
  { name: "upscale-3", note: "3× bicubic upscale", kind: "jpeg", scale: 3 },
  {
    name: "gray-upscale-2",
    note: "grayscale + 2× upscale (the combination the two single-factor results would suggest, if either helps)",
    kind: "jpeg",
    scale: 2,
    pixels: "gray",
  },
  {
    name: "receipt-crop-upscale-2",
    note: "trim the dark background to the receipt's own bounds, then 2× upscale (a receipt-region crop)",
    kind: "jpeg",
    scale: 2,
    trim: true,
  },
  {
    name: "receipt-crop-otsu-upscale-2",
    note: "receipt-region crop, then Otsu, then 2× upscale — thresholding only makes sense once the dark backdrop is out of the frame, so this is the fair version of `otsu`",
    kind: "jpeg",
    scale: 2,
    trim: true,
    pixels: "otsu",
  },
  {
    name: "receipt-crop-adaptive-upscale-2",
    note: "receipt-region crop, 3×3 denoise + local-mean threshold, 2× upscale — the fair version of `adaptive-15`",
    kind: "jpeg",
    scale: 2,
    trim: true,
    pixels: "adaptive15",
  },
  {
    name: "upscale-2+det-limit-1920",
    note: "2× upscale **and** detection longest side 960 → 1920: upscaling alone cannot help while detection downsizes the long side back to 960, so the two have to move together",
    kind: "jpeg",
    scale: 2,
    override: { detection: { preprocessing: { limitSideLen: 1920 } } },
  },
  {
    name: "gray-upscale-2+det-limit-1920",
    note: "grayscale, 2× upscale, detection longest side 1920",
    kind: "jpeg",
    scale: 2,
    pixels: "gray",
    override: { detection: { preprocessing: { limitSideLen: 1920 } } },
  },
  {
    name: "receipt-crop-upscale-2+det-limit-1920",
    note: "receipt-region crop, 2× upscale, detection longest side 1920",
    kind: "jpeg",
    scale: 2,
    trim: true,
    override: { detection: { preprocessing: { limitSideLen: 1920 } } },
  },
  {
    name: "deskew-noshrink",
    note: "the same 3° correction drawn at full extent (corners clip, as the shipped transform does) instead of scaled down to fit",
    kind: "jpeg",
    deskew: true,
    noShrink: true,
  },
  {
    name: "deskew",
    note: "rotate by the skew estimated from the horizontal projection profile, then re-crop to the receipt",
    kind: "jpeg",
    deskew: true,
  },
];

/** OCR-settings variants: a manifest override only — the weights and dictionary are the shipped ones. */
const SETTING_VARIANTS = [
  { name: "det-limit-1280", note: "detection longest side 960 → 1280", override: { detection: { preprocessing: { limitSideLen: 1280 } } } },
  { name: "det-limit-1536", note: "detection longest side 960 → 1536", override: { detection: { preprocessing: { limitSideLen: 1536 } } } },
  { name: "det-limit-1920", note: "detection longest side 960 → 1920 with no image change at all", override: { detection: { preprocessing: { limitSideLen: 1920 } } } },
  { name: "det-limit-2560", note: "detection longest side 960 → 2560 (the native height of the larger photograph)", override: { detection: { preprocessing: { limitSideLen: 2560 } } } },
  {
    name: "det-box-0.30",
    note: "detection boxThreshold 0.45 → 0.30 (admit fainter text) with unclipRatio 1.6",
    override: { detection: { postprocessing: { boxThreshold: 0.3, unclipRatio: 1.6 } } },
  },
  {
    name: "det-box-0.60",
    note: "detection boxThreshold 0.45 → 0.60 (reject faint marks)",
    override: { detection: { postprocessing: { boxThreshold: 0.6 } } },
  },
  {
    name: "det-unclip-2.0",
    note: "detection unclipRatio 1.4 → 2.0 (taller crops for the recognizer)",
    override: { detection: { postprocessing: { unclipRatio: 2.0 } } },
  },
  { name: "rec-base-640", note: "recognition baseWidth 320 → 640 (less padding on short crops)", override: { recognition: { preprocessing: { baseWidth: 640 } } } },
  { name: "rec-max-1280", note: "recognition maxWidth 960 → 1280 (long lines not squashed)", override: { recognition: { preprocessing: { maxWidth: 1280 } } } },
  {
    name: "reading-order-0.8",
    note: "line-grouping toleranceRatio 0.5 → 0.8 (joins rows the current grouping splits)",
    override: { readingOrder: { toleranceRatio: 0.8 } },
  },
];

const wanted = (name) => only === "" || only.split(",").map((entry) => entry.trim()).includes(name);

// ── in-page preprocessing ────────────────────────────────────────────────────────────────────────────────

/**
 * Runs entirely in the page. Returns a data URL; the caller hands it to the OCR page, so the bytes never leave
 * the browser and the product's privacy story is unchanged by this measurement.
 */
async function preprocessInPage(page, spec, base64, mime) {
  return await page.evaluate(
    async ({ spec, base64, mime }) => {
      const blob = await (await fetch(`data:${mime};base64,${base64}`)).blob();
      const source = await createImageBitmap(blob);
      const gray = (data) => {
        for (let i = 0; i < data.length; i += 4) {
          const v = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
        }
      };
      const ramp = (data) => {
        const ramp = new Uint8ClampedArray(256);
        for (let i = 0; i < 256; i += 1) ramp[i] = Math.max(0, Math.min(255, (i - 128) * 1.2 + 128));
        for (let i = 0; i < data.length; i += 4) {
          const v = ramp[data[i]];
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
        }
      };
      const autocontrast = (data) => {
        const histogram = new Uint32Array(256);
        for (let i = 0; i < data.length; i += 4) histogram[data[i]] += 1;
        const total = data.length / 4;
        let low = 0;
        let high = 255;
        for (let seen = 0; low < 255 && (seen += histogram[low]) < total * 0.02; low += 1);
        for (let seen = 0; high > 0 && (seen += histogram[high]) < total * 0.02; high -= 1);
        const scale = high === low ? 1 : 255 / (high - low);
        for (let i = 0; i < data.length; i += 4) {
          const v = Math.max(0, Math.min(255, (data[i] - low) * scale));
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
        }
      };
      const otsu = (data) => {
        const histogram = new Uint32Array(256);
        for (let i = 0; i < data.length; i += 4) histogram[data[i]] += 1;
        const total = data.length / 4;
        let sum = 0;
        for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
        let sumB = 0;
        let wB = 0;
        let best = 0;
        let threshold = 0;
        for (let t = 0; t < 256; t += 1) {
          wB += histogram[t];
          if (wB === 0) continue;
          const wF = total - wB;
          if (wF === 0) break;
          sumB += t * histogram[t];
          const mB = sumB / wB;
          const mF = (sum - sumB) / wF;
          const between = wB * wF * (mB - mF) ** 2;
          if (between > best) {
            best = between;
            threshold = t;
          }
        }
        for (let i = 0; i < data.length; i += 4) {
          const v = data[i] > threshold ? 255 : 0;
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
        }
      };
      const adaptive15 = (data, w, h) => {
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            let sum = 0;
            let n = 0;
            for (let dy = -7; dy <= 7; dy += 1) {
              const yy = y + dy;
              if (yy < 0 || yy >= h) continue;
              for (let dx = -7; dx <= 7; dx += 1) {
                const xx = x + dx;
                if (xx < 0 || xx >= w) continue;
                sum += data[(yy * w + xx) * 4];
                n += 1;
              }
            }
            const index = (y * w + x) * 4;
            const v = data[index] > sum / n - 10 ? 255 : 0;
            data[index] = v;
            data[index + 1] = v;
            data[index + 2] = v;
          }
        }
      };
      const unsharp = (data, w, h, radius, amount) => {
        const copy = new Float32Array(w * h);
        for (let i = 0; i < w * h; i += 1) copy[i] = data[i * 4];
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            let sum = 0;
            let n = 0;
            for (let dy = -radius; dy <= radius; dy += 1) {
              const yy = y + dy;
              if (yy < 0 || yy >= h) continue;
              for (let dx = -radius; dx <= radius; dx += 1) {
                const xx = x + dx;
                if (xx < 0 || xx >= w) continue;
                sum += copy[yy * w + xx];
                n += 1;
              }
            }
            const blurred = sum / n;
            const original = copy[y * w + x];
            const value = Math.max(0, Math.min(255, original + amount * (original - blurred)));
            const index = (y * w + x) * 4;
            data[index] = value;
            data[index + 1] = value;
            data[index + 2] = value;
          }
        }
      };

      // A trim box: the receipt is brighter than the dark backdrop, so the row/column ink profile finds it.
      let box = { x: 0, y: 0, width: source.width, height: source.height };
      if (spec.trim || spec.deskew) {
        const probe = new OffscreenCanvas(source.width, source.height);
        const pctx = probe.getContext("2d", { willReadFrequently: true });
        pctx.drawImage(source, 0, 0);
        const pixels = pctx.getImageData(0, 0, source.width, source.height).data;
        const brightness = (x, y) => {
          const i = (y * source.width + x) * 4;
          return (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        };
        const threshold = 110;
        let left = 0;
        let right = source.width - 1;
        let top = 0;
        let bottom = source.height - 1;
        const columnHas = (x) => {
          let n = 0;
          for (let y = 0; y < source.height; y += 2) if (brightness(x, y) > threshold) n += 1;
          return n > source.height / 4;
        };
        const rowHas = (y) => {
          let n = 0;
          for (let x = 0; x < source.width; x += 2) if (brightness(x, y) > threshold) n += 1;
          return n > source.width / 4;
        };
        while (left < right && !columnHas(left)) left += 1;
        while (right > left && !columnHas(right)) right -= 1;
        while (top < bottom && !rowHas(top)) top += 1;
        while (bottom > top && !rowHas(bottom)) bottom -= 1;
        const width = right - left;
        const height = bottom - top;
        // A "trim" that finds almost nothing is a failed estimate, not a crop: keep the full frame and say so.
        box = width > source.width / 3 && height > source.height / 3 ? { x: left, y: top, width, height } : { x: 0, y: 0, width: source.width, height: source.height };
      }

      // Skew: rotate candidates and keep the angle whose row projection is most concentrated (text lines).
      let angle = 0;
      if (spec.deskew) {
        const probe = new OffscreenCanvas(box.width, box.height);
        const pctx = probe.getContext("2d", { willReadFrequently: true });
        pctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
        const data = pctx.getImageData(0, 0, box.width, box.height).data;
        const score = (candidateAngle) => {
          const canvas = new OffscreenCanvas(box.width, box.height);
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.translate(box.width / 2, box.height / 2);
          ctx.rotate((candidateAngle * Math.PI) / 180);
          ctx.drawImage(probe, -box.width / 2, -box.height / 2);
          const pixels = ctx.getImageData(0, 0, box.width, box.height).data;
          const rows = new Float64Array(box.height);
          for (let y = 0; y < box.height; y += 1) {
            let sum = 0;
            for (let x = 0; x < box.width; x += 1) sum += 255 - pixels[(y * box.width + x) * 4];
            rows[y] = sum;
          }
          const mean = rows.reduce((t, v) => t + v, 0) / rows.length;
          return rows.reduce((t, v) => t + (v - mean) ** 2, 0) / rows.length;
        };
        let best = -1;
        for (let candidate = -4; candidate <= 4; candidate += 0.5) {
          const value = score(candidate);
          if (value > best) {
            best = value;
            angle = candidate;
          }
        }
        void data;
      }

      const scale = spec.scale ?? 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(box.width * scale);
      canvas.height = Math.round(box.height * scale);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.translate(canvas.width / 2, canvas.height / 2);
      if (angle !== 0) ctx.rotate((angle * Math.PI) / 180);
      // The shipped pipeline draws at full extent and lets the corners clip (DECISIONS/0018 P2/P4); `noShrink`
      // reproduces that, so a rotation is not penalised by a resolution loss the product does not have.
      const shrink = angle !== 0 && !spec.noShrink ? Math.abs(Math.cos((angle * Math.PI) / 180)) : 1;
      ctx.drawImage(
        source,
        box.x,
        box.y,
        box.width,
        box.height,
        (-box.width * scale * shrink) / 2,
        (-box.height * scale * shrink) / 2,
        box.width * scale * shrink,
        box.height * scale * shrink,
      );

      if (spec.pixels) {
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        gray(image.data);
        if (spec.pixels === "autocontrast") autocontrast(image.data);
        if (spec.pixels === "grayContrast") ramp(image.data);
        if (spec.pixels === "otsu") otsu(image.data);
        if (spec.pixels === "adaptive15") {
          // A 3×3 mean first: thresholding JPEG noise directly produces salt-and-pepper, which would fail the
          // detector for a reason that belongs to the implementation, not to adaptive thresholding.
          const clean = new Uint8ClampedArray(image.data);
          for (let y = 0; y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width; x += 1) {
              let sum = 0;
              let n = 0;
              for (let dy = -1; dy <= 1; dy += 1) {
                const yy = y + dy;
                if (yy < 0 || yy >= canvas.height) continue;
                for (let dx = -1; dx <= 1; dx += 1) {
                  const xx = x + dx;
                  if (xx < 0 || xx >= canvas.width) continue;
                  sum += clean[(yy * canvas.width + xx) * 4];
                  n += 1;
                }
              }
              const index = (y * canvas.width + x) * 4;
              const v = sum / n;
              image.data[index] = v;
              image.data[index + 1] = v;
              image.data[index + 2] = v;
            }
          }
          adaptive15(image.data, canvas.width, canvas.height);
        }
        if (spec.pixels === "unsharp") unsharp(image.data, canvas.width, canvas.height, 1, 0.8);
        ctx.putImageData(image, 0, 0);
      }

      const type = spec.kind === "png" ? "image/png" : "image/jpeg";
      return {
        preview: canvas.toDataURL("image/jpeg", 0.9),
        dataUrl: canvas.toDataURL(type, type === "image/png" ? undefined : 0.95),
        width: canvas.width,
        height: canvas.height,
        angle,
        box,
      };
    },
    { spec, base64, mime },
  );
}

// ── scoring ─────────────────────────────────────────────────────────────────────────────────────────────

const normalize = (token) => token.replace(/[₹,.:;!?'"()]/g, "").toLowerCase();

function tokensOf(ocr) {
  return ocr.lines.flatMap((line) => line.words.map((word) => word.text));
}

/**
 * Token-level score with two verdicts per ground-truth token, because the phenomenon under test is exactly the
 * token that arrives glued to its neighbour (`chapati/,Po8`):
 *
 *   - **exact** — the token stands on its own in the OCR output (case/punctuation-insensitive). This is what a
 *     user editing the review UI would consider a clean read, and what money is always required to do.
 *   - **covered** — the token's characters appear somewhere in the page's text, even inside a merged token. A
 *     variant that recovers the price but glues the description is still a recovery of the price.
 */
function scoreTokens(ocr, truth) {
  const tokens = tokensOf(ocr);
  const pool = new Set(tokens.map(normalize));
  const pageText = tokens.map(normalize).join(" ");
  const covered = (token) => pageText.includes(normalize(token));
  const exact = (token) => pool.has(normalize(token));
  const scored = truth.tokens.filter((entry) => entry.status !== "illegible");
  const money = scored.filter((entry) => entry.money === true);
  return {
    tokens,
    scored: scored.length,
    exact: scored.filter((entry) => exact(entry.text)).length,
    covered: scored.filter((entry) => covered(entry.text)).length,
    missed: scored.filter((entry) => !covered(entry.text)).map((entry) => entry.text),
    glued: scored.filter((entry) => covered(entry.text) && !exact(entry.text)).map((entry) => entry.text),
    moneyScored: money.length,
    moneyExact: money.filter((entry) => exact(entry.text)).length,
    moneyMissed: money.filter((entry) => !exact(entry.text)).map((entry) => entry.text),
    obscured: scored
      .filter((entry) => entry.status === "obscured")
      .map((entry) => ({ text: entry.text, state: exact(entry.text) ? "exact" : covered(entry.text) ? "covered" : "missed" })),
  };
}

function parseSummary(ocr) {
  const result = parse(ocr);
  return {
    items: result.items.map((item) => ({
      name: item.name,
      qty: item.qty,
      quantitySource: item.quantitySource,
      unitPrice: item.unitPrice,
      priceSource: item.priceSource,
      lineTotal: item.lineTotal,
    })),
    grandTotal: result.grandTotal,
    grandTotalSource: result.grandTotalSource,
    unclassified: result.unclassifiedRows.length,
    criticals: result.warnings.filter((warning) => warning.severity === "critical").length,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────

const baseManifest = JSON.parse(await readFile(manifestPath, "utf8"));
const groundTruth = JSON.parse(await readFile(gtPath, "utf8"));

await mkdir(outDir, { recursive: true });
await mkdir(variantsRoot, { recursive: true });

await Promise.all(
  [...SETTING_VARIANTS, ...IMAGE_VARIANTS.filter((variant) => variant.override)].map(async (variant) => {
    const merged = structuredClone(baseManifest);
    const apply = (target, override) => {
      for (const [key, value] of Object.entries(override)) {
        if (value && typeof value === "object" && !Array.isArray(value)) apply(target[key], value);
        else target[key] = value;
      }
    };
    apply(merged, variant.override);
    await mkdir(path.join(variantsRoot, variant.name), { recursive: true });
    await writeFile(
      path.join(variantsRoot, variant.name, "manifest.json"),
      `${JSON.stringify(merged, null, 2)}\n`,
    );
  }),
);

const server = await startServer(0);
const browser = await chromium.launch();
const ocrPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
const prepPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
await prepPage.goto("about:blank");
await ocrPage.goto(`${server.url}dist/batch.html`, { waitUntil: "load" });
await ocrPage.waitForFunction(() => Boolean(window.__receiptLensBatch), undefined, { timeout: 60_000 });

const results = [];
let baselineByImage = {};
const baselineTokens = {};

async function runOne(variant, imageKey) {
  const bytes = await readFile(path.join(repoRoot, "images", IMAGES[imageKey]));
  const base64 = bytes.toString("base64");
  const mime = "image/jpeg";

  if (variant.kind === "settings") {
    const info = await ocrPage.evaluate((options) => window.__receiptLensBatch.init(options), {
      assetBaseUrl: "/assets/models/",
      manifestUrl: `/assets/models/variants-tmp/${variant.name}/manifest.json`,
    });
    const outcome = await ocrPage.evaluate((args) => window.__receiptLensBatch.run(...args), [base64, mime, IMAGES[imageKey]]);
    if (!outcome.ok) throw new Error(`${variant.name}/${imageKey}: ${outcome.error?.code ?? outcome.error?.message}`);
    return { info, ocr: outcome.ocr, inferenceMs: outcome.inferenceMs, pre: null };
  }

  const pre = await preprocessInPage(prepPage, variant, base64, mime);
  const info = await ocrPage.evaluate((options) => window.__receiptLensBatch.init(options), {
    assetBaseUrl: "/assets/models/",
    manifestUrl: variant.override
      ? `/assets/models/variants-tmp/${variant.name}/manifest.json`
      : "/assets/models/manifest.json",
  });
  const outcome = await ocrPage.evaluate((args) => window.__receiptLensBatch.run(...args), [
    pre.dataUrl.split(",")[1],
    pre.dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg",
    IMAGES[imageKey],
  ]);
  if (!outcome.ok) throw new Error(`${variant.name}/${imageKey}: ${outcome.error?.code ?? outcome.error?.message}`);
  return {
    info,
    ocr: outcome.ocr,
    inferenceMs: outcome.inferenceMs,
    pre: { width: pre.width, height: pre.height, angle: pre.angle, preview: pre.preview },
  };
}

const variants = [
  ...IMAGE_VARIANTS.filter((variant) => wanted(variant.name) && variant.kind !== "settings"),
  ...SETTING_VARIANTS.filter((variant) => wanted(variant.name)).map((variant) => ({ ...variant, kind: "settings" })),
];

for (const imageKey of Object.keys(IMAGES)) {
  baselineByImage[imageKey] = null;
  for (const variant of variants) {
    for (let pass = 0; pass < repeat; pass += 1) {
      const { ocr, inferenceMs, pre } = await runOne(variant, imageKey);
      const scored = scoreTokens(ocr, groundTruth[imageKey]);
      const summary = parseSummary(ocr);
      if (pre?.preview) {
        await writeFile(
          path.join(outDir, `preview.${imageKey}.${variant.name}.jpg`),
          Buffer.from(pre.preview.split(",")[1], "base64"),
        );
      }
      const record = {
        variant: variant.name,
        note: variant.note,
        image: imageKey,
        pass,
        inferenceMs,
        pre,
        imageSize: ocr.imageSize,
        tokenScore: `${scored.exact}/${scored.scored}`,
        coveredScore: `${scored.covered}/${scored.scored}`,
        moneyScore: `${scored.moneyExact}/${scored.moneyScored}`,
        moneyMissed: scored.moneyMissed,
        missed: scored.missed,
        glued: scored.glued,
        obscured: scored.obscured,
        items: summary.items,
        grandTotal: summary.grandTotal,
        grandTotalSource: summary.grandTotalSource,
        unclassified: summary.unclassified,
        criticals: summary.criticals,
        tokens: scored.tokens,
      };
      await writeFile(
        path.join(outDir, `${imageKey}.${variant.name}.${pass}.ocr.json`),
        `${JSON.stringify(ocr, null, 2)}\n`,
      );
      if (variant.name === "baseline" && pass === 0) {
        baselineByImage[imageKey] = summary;
        baselineTokens[imageKey] = scored.tokens;
      }
      const baseTokens = baselineTokens[imageKey];
      if (baseTokens) {
        const base = new Set(baseTokens.map(normalize));
        const here = new Set(scored.tokens.map(normalize));
        record.gained = [...here].filter((token) => !base.has(token));
        record.lost = [...base].filter((token) => !here.has(token));
      }
      results.push(record);
      console.log(
        `${imageKey.padEnd(9)} ${variant.name.padEnd(24)} exact ${record.tokenScore.padEnd(6)} covered ${record.coveredScore.padEnd(6)} money ${record.moneyScore.padEnd(6)} ` +
          `items ${String(summary.items.length).padStart(2)} grand ${String(summary.grandTotal).padStart(7)} ` +
          `${pre ? `${pre.width}×${pre.height}${pre.angle ? ` @${pre.angle}°` : ""}` : "native"}`,
      );
    }
  }
}

await writeFile(
  path.join(outDir, "bench.json"),
  `${JSON.stringify({ baseline: baselineByImage, results }, null, 2)}\n`,
);

// ── committed artifact: counts and outcomes, no receipt text ───────────────────────────────────────────────
const byVariant = new Map();
for (const record of results) {
  if (record.pass !== 0) continue;
  if (!byVariant.has(record.variant)) byVariant.set(record.variant, {});
  const baseline = baselineByImage[record.image];
  const differs = [];
  if (baseline) {
    if (record.items.length !== baseline.items.length) differs.push("itemCount");
    const sameNames = record.items.every((item, index) => item.name === baseline.items[index]?.name);
    if (!sameNames) differs.push("itemNames");
    const sameMoney = record.items.every(
      (item, index) =>
        item.qty === baseline.items[index]?.qty &&
        item.unitPrice === baseline.items[index]?.unitPrice &&
        item.lineTotal === baseline.items[index]?.lineTotal,
    );
    if (!sameMoney) differs.push("itemMoney");
    if (record.grandTotal !== baseline.grandTotal) differs.push("grandTotal");
  }
  byVariant.get(record.variant)[record.image] = {
    exact: Number(record.tokenScore.split("/")[0]),
    covered: Number(record.coveredScore.split("/")[0]),
    scored: Number(record.tokenScore.split("/")[1]),
    moneyExact: Number(record.moneyScore.split("/")[0]),
    moneyScored: Number(record.moneyScore.split("/")[1]),
    itemCount: record.items.length,
    grandTotal: record.grandTotal,
    unclassifiedRows: record.unclassified,
    criticalFindings: record.criticals,
    parseDiffersFromBaselineIn: differs,
    gainedTokenCount: record.gained?.length ?? null,
    lostTokenCount: record.lost?.length ?? null,
    inputWidth: record.pre?.width ?? record.imageSize.width,
    inputHeight: record.pre?.height ?? record.imageSize.height,
  };
}

const artifact = {
  _meta: {
    purpose:
      "OCR-preprocessing investigation (DECISIONS/0018 amendment, 2026-11-10). Each entry is one candidate pipeline run over the two local acceptance photographs, scored at token level against benchmarks/ocr-preprocess-ground-truth.json and through the shipped parse() for the regression gate. Counts and outcomes only; no receipt text is recorded here.",
    reproducibleWith: "node benchmarks/scripts/bench-ocr-preprocess.mjs --write (and --check)",
    tier: "PP-OCRv6 Tiny, the shipped asset set (assets/models/manifest.json)",
    dependsOn: "the two acceptance photographs in images/, which are not committed (DECISIONS/0005) — without them the script exits with a clear message",
    groundTruthStatus:
      "provisional: transcribed from the photographs, with the two `obscured` tokens awaiting the owner's confirmation (see the ground-truth file)",
    scoring: "exact = token stands alone; covered = characters appear anywhere on the page; money = exact on every money token. `parseDiffersFromBaselineIn` is the regression gate.",
  },
  variants: [...byVariant.entries()].map(([name, perImage]) => ({
    variant: name,
    note: [...IMAGE_VARIANTS, ...SETTING_VARIANTS].find((variant) => variant.name === name)?.note ?? "",
    perImage,
  })),
};

if (writeArtifact) {
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`wrote ${path.relative(repoRoot, artifactPath)}`);
}
if (checkArtifact) {
  const committed = JSON.parse(await readFile(artifactPath, "utf8"));
  const same = JSON.stringify(committed) === JSON.stringify(artifact);
  if (!same) {
    console.error("ocr-preprocess.json does not match a fresh run");
    process.exitCode = 1;
  } else {
    console.log("benchmarks/results/ocr-preprocess.json matches a fresh run over the two photographs");
  }
}

await browser.close();
server.close?.();
await rm(variantsRoot, { recursive: true, force: true });
